import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

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

export interface LearningAnalysisResult {
  annotations: Map<string, TranscriptCueLearning>;
  iPlusOneCount: number;
  knownWordCount: number;
}

const NOTES_INFO_BATCH_SIZE = 100;
const PKUSEG_ASSET_DIR = 'pkuseg';
const PKUSEG_TOKENIZER_FILENAME = 'PkusegTokenizer.exe';
const PKUSEG_SOURCE_TOKENIZER_PATH = path.join(process.cwd(), 'scripts', 'pkuseg-tokenizer.py');
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

let pkusegClient: PkusegProcessClient | null = null;

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

  return new PkusegLearningTokenizer();
}

class IntlLearningTokenizer implements LearningTokenizer {
  async tokenizeBatch(texts: string[]): Promise<LearningTokenization[]> {
    return texts.map(tokenizeIntlText);
  }
}

class PkusegLearningTokenizer implements LearningTokenizer {
  readonly #client = getPkusegClient();

  async tokenizeBatch(texts: string[]): Promise<LearningTokenization[]> {
    const tokenizations = await this.#client.tokenizeBatch(texts);
    return texts.map((text, index) => tokenizeSegmentedText(text, tokenizations[index] ?? []));
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

function batchNoteIds(noteIds: number[], batchSize: number): number[][] {
  const batches: number[][] = [];
  for (let index = 0; index < noteIds.length; index += batchSize) {
    batches.push(noteIds.slice(index, index + batchSize));
  }

  return batches;
}

interface PkusegTokenizerCommand {
  command: string;
  args: string[];
}

interface PkusegTokenizerResponse {
  tokenizations?: Array<{
    segments?: unknown;
  }>;
  error?: unknown;
}

function getPkusegClient(): PkusegProcessClient {
  if (!pkusegClient) {
    pkusegClient = new PkusegProcessClient(resolvePkusegTokenizerCommand());
  }

  return pkusegClient;
}

export function resetLearningTokenizerForTests(): void {
  pkusegClient?.close();
  pkusegClient = null;
}

class PkusegProcessClient {
  readonly #command: PkusegTokenizerCommand;
  #child: ChildProcessWithoutNullStreams | null = null;
  #stderr = '';
  #pending: {
    resolve: (segments: string[][]) => void;
    reject: (error: Error) => void;
  } | null = null;
  #requestChain: Promise<void> = Promise.resolve();

  constructor(command: PkusegTokenizerCommand) {
    this.#command = command;
  }

  async tokenizeBatch(texts: string[]): Promise<string[][]> {
    const request = this.#requestChain
      .catch(() => {})
      .then(() => this.#send(texts));
    this.#requestChain = request.then(
      () => undefined,
      () => undefined,
    );

    return request;
  }

  close(): void {
    this.#pending?.reject(new Error('Pkuseg tokenizer process was closed.'));
    this.#pending = null;
    this.#child?.kill();
    this.#child = null;
    this.#stderr = '';
  }

  #send(texts: string[]): Promise<string[][]> {
    this.#ensureStarted();
    const child = this.#child;
    if (!child || !child.stdin.writable) {
      throw new Error('Pkuseg tokenizer process is not writable.');
    }

    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      child.stdin.write(`${JSON.stringify({ texts })}\n`, (error) => {
        if (error && this.#pending?.reject === reject) {
          this.#pending = null;
          reject(new Error(`Failed to send text to Pkuseg tokenizer: ${error.message}`));
        }
      });
    });
  }

  #ensureStarted(): void {
    if (this.#child) {
      return;
    }

    const child = spawn(this.#command.command, this.#command.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    this.#stderr = '';

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.#handleLine(line));
    child.stderr.on('data', (chunk) => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-4000);
    });
    child.once('error', (error) => this.#failPending(new Error(`Failed to start Pkuseg tokenizer: ${error.message}`)));
    child.once('exit', (code, signal) => {
      this.#child = null;
      const detail = this.#stderr.trim();
      const suffix = detail ? ` ${detail}` : '';
      this.#failPending(new Error(`Pkuseg tokenizer exited with code ${code ?? 'null'} signal ${signal ?? 'null'}.${suffix}`));
    });
  }

  #handleLine(line: string): void {
    const pending = this.#pending;
    if (!pending) {
      return;
    }

    this.#pending = null;
    try {
      const payload = JSON.parse(line) as PkusegTokenizerResponse;
      if (payload.error) {
        pending.reject(new Error(`Pkuseg tokenizer error: ${String(payload.error)}`));
        return;
      }

      if (!Array.isArray(payload.tokenizations)) {
        pending.reject(new Error('Pkuseg tokenizer returned an invalid response.'));
        return;
      }

      pending.resolve(payload.tokenizations.map((tokenization) => {
        if (!Array.isArray(tokenization.segments)) {
          return [];
        }

        return tokenization.segments.filter((segment): segment is string => typeof segment === 'string');
      }));
    } catch (error) {
      pending.reject(new Error(`Pkuseg tokenizer returned invalid JSON: ${String(error)}`));
    }
  }

  #failPending(error: Error): void {
    if (!this.#pending) {
      return;
    }

    const pending = this.#pending;
    this.#pending = null;
    pending.reject(error);
  }
}

function resolvePkusegTokenizerCommand(): PkusegTokenizerCommand {
  const explicitTokenizer = process.env.SENTENCEMINER_PKUSEG_TOKENIZER?.trim();
  if (explicitTokenizer) {
    assertPkusegTokenizerPath(explicitTokenizer);
    return commandForTokenizerPath(explicitTokenizer);
  }

  const packagedTokenizer = path.join(resolveAppRoot(), PKUSEG_ASSET_DIR, PKUSEG_TOKENIZER_FILENAME);
  if (fs.existsSync(packagedTokenizer)) {
    return commandForTokenizerPath(packagedTokenizer);
  }

  const builtTokenizer = path.join(process.cwd(), 'dist', 'build', PKUSEG_ASSET_DIR, 'PkusegTokenizer', PKUSEG_TOKENIZER_FILENAME);
  if (fs.existsSync(builtTokenizer)) {
    return commandForTokenizerPath(builtTokenizer);
  }

  if (fs.existsSync(PKUSEG_SOURCE_TOKENIZER_PATH)) {
    return {
      command: process.env.PYTHON || 'python',
      args: [PKUSEG_SOURCE_TOKENIZER_PATH],
    };
  }

  throw new Error(`Unable to find bundled Pkuseg tokenizer executable ${PKUSEG_TOKENIZER_FILENAME}.`);
}

function assertPkusegTokenizerPath(tokenizerPath: string): void {
  if (!fs.existsSync(tokenizerPath)) {
    throw new Error(`Unable to find Pkuseg tokenizer at ${tokenizerPath}.`);
  }
}

function commandForTokenizerPath(tokenizerPath: string): PkusegTokenizerCommand {
  const extension = path.extname(tokenizerPath).toLowerCase();
  if (extension === '.py') {
    return {
      command: process.env.PYTHON || 'python',
      args: [tokenizerPath],
    };
  }

  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return {
      command: process.execPath,
      args: [tokenizerPath],
    };
  }

  return {
    command: tokenizerPath,
    args: [],
  };
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
