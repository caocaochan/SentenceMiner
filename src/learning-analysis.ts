import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import type {
  AnkiConfig,
  LearningConfig,
  TranscriptCue,
  TranscriptCueLearning,
  TranscriptTextRange,
} from './types.ts';
import { resolveAppRoot } from './config.ts';
import { buildSearchQuery, normalizeSubtitleForMatching } from './utils.ts';

interface AnkiResponse<T> {
  result: T;
  error: string | null;
}

interface NoteInfo {
  noteId: number;
  fields: Record<string, { value: string }>;
}

interface LearningTokenizer {
  tokenizeBatch(texts: string[]): Promise<LearningTokenization[]>;
}

interface LearningTokenization {
  tokens: string[];
  ranges: LearningTokenRange[];
}

interface LearningTokenRange extends TranscriptTextRange {
  token: string;
}

interface JiebaConstructor {
  new(): JiebaInstance;
  withDict?: (dict: Uint8Array) => JiebaInstance;
}

interface JiebaInstance {
  cut(text: string, hmm?: boolean): string[];
}

interface JiebaNativeBinding {
  Jieba: JiebaConstructor;
}

export interface LearningAnalysisResult {
  annotations: Map<string, TranscriptCueLearning>;
  iPlusOneCount: number;
  knownWordCount: number;
}

const NOTES_INFO_BATCH_SIZE = 100;
const JIEBA_ASSET_DIR = 'jieba';
const JIEBA_DICT_FILENAME = 'dict.txt';
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
const REQUIRE = createRequire(path.join(process.cwd(), 'sentenceminer-loader.cjs'));

export async function analyzeTranscriptLearning(
  anki: AnkiConfig,
  learning: LearningConfig,
  cues: TranscriptCue[],
): Promise<LearningAnalysisResult> {
  if (!learning.iPlusOneEnabled) {
    return {
      annotations: new Map(),
      iPlusOneCount: 0,
      knownWordCount: 0,
    };
  }

  if (!learning.knownWordField.trim()) {
    throw new Error('Choose a known word field in settings to enable i+1 analysis.');
  }

  const knownWordValues = await loadKnownWordValues(anki, learning.knownWordField);
  const tokenizer = createLearningTokenizer(learning);
  const knownWordTokenizations = await tokenizer.tokenizeBatch(knownWordValues);
  const knownWords = buildKnownWords(knownWordTokenizations);
  if (knownWords.size === 0) {
    throw new Error(`No known words were found in field "${learning.knownWordField}".`);
  }

  const cueTokenizations = await tokenizer.tokenizeBatch(cues.map((cue) => cue.text));
  const annotations = new Map<string, TranscriptCueLearning>();
  let iPlusOneCount = 0;

  for (const [index, cue] of cues.entries()) {
    const tokenization = cueTokenizations[index] ?? { tokens: [], ranges: [] };
    const unknownWords = tokenization.tokens.filter((token) => !knownWords.has(token));
    const unknownWordSet = new Set(unknownWords);
    const learningState = {
      unknownWords,
      unknownWordRanges: tokenization.ranges
        .filter((range) => unknownWordSet.has(range.token))
        .map(({ start, end }) => ({ start, end })),
      iPlusOne: unknownWords.length === 1,
    };
    if (learningState.iPlusOne) {
      iPlusOneCount += 1;
    }
    annotations.set(cue.id, learningState);
  }

  return {
    annotations,
    iPlusOneCount,
    knownWordCount: knownWords.size,
  };
}

export function tokenizeText(text: string): string[] {
  return uniqueIntlTokens(text);
}

export function normalizeLearningToken(value: string): string {
  return normalizeSubtitleForMatching(value)
    .normalize('NFKC')
    .trim()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

async function loadKnownWordValues(anki: AnkiConfig, knownWordField: string): Promise<string[]> {
  const query = buildSearchQuery(anki.deck, anki.noteType, anki.extraQuery);
  const noteIds = await ankiRequest<number[]>(anki, 'findNotes', { query });
  if (!Array.isArray(noteIds) || noteIds.length === 0) {
    return [];
  }

  const values: string[] = [];
  for (const batch of batchNoteIds(noteIds, NOTES_INFO_BATCH_SIZE)) {
    const notes = await ankiRequest<NoteInfo[]>(anki, 'notesInfo', { notes: batch });
    if (!Array.isArray(notes)) {
      throw new Error('Unable to load Anki note info for i+1 analysis.');
    }

    for (const note of notes) {
      const value = note.fields[knownWordField]?.value;
      if (typeof value !== 'string') {
        continue;
      }

      values.push(value);
    }
  }

  return values;
}

function buildKnownWords(tokenizations: LearningTokenization[]): Set<string> {
  const knownWords = new Set<string>();
  for (const tokenization of tokenizations) {
    for (const token of tokenization.tokens) {
      knownWords.add(token);
    }
  }

  return knownWords;
}

function createLearningTokenizer(learning: LearningConfig): LearningTokenizer {
  if (learning.tokenizer === 'intl') {
    return new IntlLearningTokenizer();
  }

  return new JiebaLearningTokenizer();
}

class IntlLearningTokenizer implements LearningTokenizer {
  async tokenizeBatch(texts: string[]): Promise<LearningTokenization[]> {
    return texts.map(tokenizeIntlText);
  }
}

class JiebaLearningTokenizer implements LearningTokenizer {
  readonly #jieba = loadJieba();

  async tokenizeBatch(texts: string[]): Promise<LearningTokenization[]> {
    return texts.map((text) => tokenizeJiebaText(text, this.#jieba.cut(text, true)));
  }
}

function uniqueIntlTokens(text: string): string[] {
  return tokenizeIntlText(text).tokens;
}

function tokenizeIntlText(text: string): LearningTokenization {
  const tokens = new Set<string>();
  const ranges: LearningTokenRange[] = [];
  for (const segment of SEGMENTER.segment(text)) {
    if (!segment.isWordLike) {
      continue;
    }

    const token = normalizeLearningToken(segment.segment);
    if (!token) {
      continue;
    }

    tokens.add(token);
    ranges.push({
      token,
      start: segment.index,
      end: segment.index + segment.segment.length,
    });
  }

  return {
    tokens: [...tokens],
    ranges,
  };
}

function tokenizeJiebaText(text: string, segments: string[]): LearningTokenization {
  const tokens = new Set<string>();
  const ranges: LearningTokenRange[] = [];
  let cursor = 0;

  for (const segment of segments) {
    const index = segment ? text.indexOf(segment, cursor) : -1;
    if (index !== -1) {
      cursor = index + segment.length;
    }

    const token = normalizeLearningToken(segment);
    if (!token) {
      continue;
    }

    tokens.add(token);
    if (index !== -1 && segment.length > 0) {
      ranges.push({
        token,
        start: index,
        end: index + segment.length,
      });
    }
  }

  return {
    tokens: [...tokens],
    ranges,
  };
}

function loadJieba(): JiebaInstance {
  const assetRoot = resolveJiebaAssetRoot();
  const dictPath = path.join(assetRoot, JIEBA_DICT_FILENAME);
  const bindingPath = resolveJiebaNativeBindingPath(assetRoot);
  const dict = fs.readFileSync(dictPath);
  const binding = REQUIRE(bindingPath) as JiebaNativeBinding;

  if (!binding.Jieba) {
    throw new Error(`Jieba native binding at ${bindingPath} did not export Jieba.`);
  }

  return typeof binding.Jieba.withDict === 'function'
    ? binding.Jieba.withDict(dict)
    : new binding.Jieba();
}

function resolveJiebaAssetRoot(): string {
  if (process.env.SENTENCEMINER_JIEBA_ROOT) {
    const explicitRoot = process.env.SENTENCEMINER_JIEBA_ROOT;
    assertJiebaAssetRoot(explicitRoot);
    return explicitRoot;
  }

  const candidates = [
    path.join(resolveAppRoot(), JIEBA_ASSET_DIR),
    path.join(process.cwd(), 'node_modules', '@node-rs', 'jieba'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, JIEBA_DICT_FILENAME))) {
      return candidate;
    }
  }

  throw new Error(`Unable to find Jieba tokenizer dictionary ${JIEBA_DICT_FILENAME}.`);
}

function assertJiebaAssetRoot(assetRoot: string): void {
  const dictPath = path.join(assetRoot, JIEBA_DICT_FILENAME);
  const bindingPath = path.join(assetRoot, getJiebaNativeBindingFilename());
  if (!fs.existsSync(dictPath)) {
    throw new Error(`Unable to find Jieba tokenizer dictionary at ${dictPath}.`);
  }

  if (!fs.existsSync(bindingPath)) {
    throw new Error(`Unable to find Jieba native binding at ${bindingPath}.`);
  }
}

function resolveJiebaNativeBindingPath(assetRoot: string): string {
  const localBindingPath = path.join(assetRoot, getJiebaNativeBindingFilename());
  if (fs.existsSync(localBindingPath)) {
    return localBindingPath;
  }

  const packageName = getJiebaNativePackageName();
  if (packageName) {
    return REQUIRE.resolve(packageName);
  }

  throw new Error(`Unsupported Jieba tokenizer platform: ${process.platform} ${process.arch}.`);
}

function getJiebaNativeBindingFilename(): string {
  const platformSuffix = getJiebaPlatformSuffix();
  if (!platformSuffix) {
    throw new Error(`Unsupported Jieba tokenizer platform: ${process.platform} ${process.arch}.`);
  }

  return `jieba.${platformSuffix}.node`;
}

function getJiebaNativePackageName(): string | null {
  const platformSuffix = getJiebaPlatformSuffix();
  return platformSuffix ? `@node-rs/jieba-${platformSuffix}` : null;
}

function getJiebaPlatformSuffix(): string | null {
  if (process.platform === 'win32') {
    if (process.arch === 'x64') {
      return 'win32-x64-msvc';
    }
    if (process.arch === 'ia32') {
      return 'win32-ia32-msvc';
    }
    if (process.arch === 'arm64') {
      return 'win32-arm64-msvc';
    }
  }

  return null;
}

function batchNoteIds(noteIds: number[], batchSize: number): number[][] {
  const batches: number[][] = [];
  for (let index = 0; index < noteIds.length; index += batchSize) {
    batches.push(noteIds.slice(index, index + batchSize));
  }

  return batches;
}

async function ankiRequest<T>(config: AnkiConfig, action: string, params?: Record<string, unknown>): Promise<T> {
  const body = {
    action,
    version: 6,
    params,
    key: config.apiKey || undefined,
  };

  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`AnkiConnect request failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as AnkiResponse<T>;
  if (payload.error) {
    throw new Error(`AnkiConnect error for ${action}: ${payload.error}`);
  }

  return payload.result;
}
