import type { AnkiConfig, LearningConfig, TranscriptCue, TranscriptCueLearning } from './types.ts';
import { buildSearchQuery, normalizeSubtitleForMatching } from './utils.ts';

interface AnkiResponse<T> {
  result: T;
  error: string | null;
}

interface NoteInfo {
  noteId: number;
  fields: Record<string, { value: string }>;
}

export interface LearningAnalysisResult {
  annotations: Map<string, TranscriptCueLearning>;
  iPlusOneCount: number;
  knownWordCount: number;
}

const NOTES_INFO_BATCH_SIZE = 100;
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

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

  const knownWords = await loadKnownWords(anki, learning.knownWordField);
  if (knownWords.size === 0) {
    throw new Error(`No known words were found in field "${learning.knownWordField}".`);
  }

  const annotations = new Map<string, TranscriptCueLearning>();
  let iPlusOneCount = 0;

  for (const cue of cues) {
    const unknownWords = uniqueTokens(cue.text).filter((token) => !knownWords.has(token));
    const learningState = {
      unknownWords,
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
  return uniqueTokens(text);
}

export function normalizeLearningToken(value: string): string {
  return normalizeSubtitleForMatching(value)
    .normalize('NFKC')
    .trim()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

async function loadKnownWords(anki: AnkiConfig, knownWordField: string): Promise<Set<string>> {
  const query = buildSearchQuery(anki.deck, anki.noteType, anki.extraQuery);
  const noteIds = await ankiRequest<number[]>(anki, 'findNotes', { query });
  if (!Array.isArray(noteIds) || noteIds.length === 0) {
    return new Set();
  }

  const knownWords = new Set<string>();
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

      addKnownWordValue(knownWords, value);
    }
  }

  return knownWords;
}

function addKnownWordValue(knownWords: Set<string>, value: string): void {
  const normalizedValue = normalizeLearningToken(value);
  if (normalizedValue) {
    knownWords.add(normalizedValue);
  }

  for (const token of uniqueTokens(value)) {
    knownWords.add(token);
  }
}

function uniqueTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const segment of SEGMENTER.segment(text)) {
    if (!segment.isWordLike) {
      continue;
    }

    const normalized = normalizeLearningToken(segment.segment);
    if (normalized) {
      tokens.add(normalized);
    }
  }

  return [...tokens];
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
