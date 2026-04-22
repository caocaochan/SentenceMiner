import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
  dispose?(): void;
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

interface LacSegmenter {
  segmentBatch(texts: string[]): Promise<string[][]>;
  dispose(): void;
}

type LacSegmenterFactory = () => LacSegmenter;

export interface LearningAnalysisResult {
  annotations: Map<string, TranscriptCueLearning>;
  iPlusOneCount: number;
  knownWordCount: number;
}

const NOTES_INFO_BATCH_SIZE = 100;
const JIEBA_ASSET_DIR = 'jieba';
const JIEBA_DICT_FILENAME = 'dict.txt';
const LAC_WORKER_FILENAME = 'lac-worker.py';
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
const REQUIRE = createRequire(path.join(process.cwd(), 'sentenceminer-loader.cjs'));
let lacSegmenterFactoryForTesting: LacSegmenterFactory | null = null;

export function setLacSegmenterFactoryForTesting(factory: LacSegmenterFactory | null): void {
  lacSegmenterFactoryForTesting = factory;
}

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
  try {
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
  } finally {
    tokenizer.dispose?.();
  }
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

  if (learning.tokenizer === 'lac') {
    return new LacLearningTokenizer(lacSegmenterFactoryForTesting?.() ?? new LacWorkerSegmenter());
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
    return texts.map((text) => tokenizeSegmentedText(text, this.#jieba.cut(text, true)));
  }
}

class LacLearningTokenizer implements LearningTokenizer {
  readonly #segmenter: LacSegmenter;

  constructor(segmenter: LacSegmenter) {
    this.#segmenter = segmenter;
  }

  async tokenizeBatch(texts: string[]): Promise<LearningTokenization[]> {
    const segmentBatches = await this.#segmenter.segmentBatch(texts);
    return texts.map((text, index) => tokenizeSegmentedText(text, segmentBatches[index] ?? []));
  }

  dispose(): void {
    this.#segmenter.dispose();
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

function tokenizeSegmentedText(text: string, segments: string[]): LearningTokenization {
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

class LacWorkerSegmenter implements LacSegmenter {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, {
    resolve: (value: string[][]) => void;
    reject: (error: Error) => void;
  }>();
  #nextRequestId = 1;
  #stdoutBuffer = '';
  #stderrBuffer = '';
  #closed = false;

  constructor(
    pythonCommand = process.env.SENTENCEMINER_LAC_PYTHON?.trim() || 'python',
    workerPath = resolveLacWorkerPath(),
  ) {
    this.#process = spawn(pythonCommand, [workerPath], {
      stdio: 'pipe',
      windowsHide: true,
    });
    this.#process.stdout.setEncoding('utf8');
    this.#process.stderr.setEncoding('utf8');
    this.#process.stdout.on('data', (chunk) => this.#handleStdout(String(chunk)));
    this.#process.stderr.on('data', (chunk) => {
      this.#stderrBuffer = `${this.#stderrBuffer}${String(chunk)}`.slice(-4000);
    });
    this.#process.on('error', (error) => {
      this.#rejectAll(new Error(
        `Unable to start Baidu LAC tokenizer with "${pythonCommand}". Set SENTENCEMINER_LAC_PYTHON to a Python executable with LAC installed. ${error.message}`,
      ));
    });
    this.#process.on('close', (code) => {
      this.#closed = true;
      if (this.#pending.size > 0) {
        this.#rejectAll(new Error(this.#formatExitMessage(code)));
      }
    });
  }

  segmentBatch(texts: string[]): Promise<string[][]> {
    if (texts.length === 0) {
      return Promise.resolve([]);
    }

    if (this.#closed) {
      return Promise.reject(new Error(this.#formatExitMessage(null)));
    }

    const id = this.#nextRequestId++;
    const line = `${JSON.stringify({ id, texts })}\n`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#process.stdin.write(line, 'utf8', (error) => {
        if (!error) {
          return;
        }

        this.#pending.delete(id);
        reject(new Error(`Unable to write to Baidu LAC tokenizer process. ${error.message}`));
      });
    });
  }

  dispose(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#process.kill();
  }

  #handleStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    let newlineIndex = this.#stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.#stdoutBuffer.slice(0, newlineIndex).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.#handleMessageLine(line);
      }
      newlineIndex = this.#stdoutBuffer.indexOf('\n');
    }
  }

  #handleMessageLine(line: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      this.#rejectAll(new Error(`Baidu LAC tokenizer returned invalid JSON: ${line}`));
      return;
    }

    if (!payload || typeof payload !== 'object') {
      this.#rejectAll(new Error('Baidu LAC tokenizer returned an invalid response.'));
      return;
    }

    const response = payload as Record<string, unknown>;
    const id = response.id;
    if (id === 0 && typeof response.error === 'string' && response.error) {
      this.#rejectAll(new Error(`Baidu LAC tokenizer failed: ${response.error}`));
      return;
    }

    if (!Number.isInteger(id)) {
      this.#rejectAll(new Error('Baidu LAC tokenizer response was missing a request id.'));
      return;
    }

    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }

    this.#pending.delete(id);
    if (typeof response.error === 'string' && response.error) {
      pending.reject(new Error(`Baidu LAC tokenizer failed: ${response.error}`));
      return;
    }

    if (!isSegmentBatch(response.segments)) {
      pending.reject(new Error('Baidu LAC tokenizer returned malformed segments.'));
      return;
    }

    pending.resolve(response.segments);
  }

  #rejectAll(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      request.reject(error);
    }
  }

  #formatExitMessage(code: number | null): string {
    const detail = this.#stderrBuffer.trim();
    const suffix = detail ? ` ${detail}` : '';
    return `Baidu LAC tokenizer process exited${code == null ? '' : ` with code ${code}`}.${suffix}`;
  }
}

function resolveLacWorkerPath(): string {
  const candidates = [
    path.join(resolveAppRoot(), LAC_WORKER_FILENAME),
    path.join(process.cwd(), 'scripts', LAC_WORKER_FILENAME),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to find Baidu LAC tokenizer worker ${LAC_WORKER_FILENAME}.`);
}

function isSegmentBatch(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every((segments) =>
    Array.isArray(segments) && segments.every((segment) => typeof segment === 'string')
  );
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
