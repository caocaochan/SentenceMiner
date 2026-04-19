import fs from 'node:fs/promises';
import path from 'node:path';

import type { AnkiConfig, MinePayload, MineResult } from './types.ts';
import {
  applyFilenameTemplate,
  basenameWithoutExtension,
  buildSearchQuery,
  formatTimestampRange,
  normalizeSubtitleForMatching,
  renderSubtitleHtml,
} from './utils.ts';

interface AnkiResponse<T> {
  result: T;
  error: string | null;
}

interface NoteInfo {
  noteId: number;
  fields: Record<string, { value: string }>;
}

interface SentenceCandidate {
  normalized: string;
}

export const NO_MATCHING_CARD_MESSAGE = 'No matching card exists.';

export class NoMatchingCardError extends Error {
  constructor() {
    super(NO_MATCHING_CARD_MESSAGE);
    this.name = 'NoMatchingCardError';
  }
}

export async function mineToAnki(config: AnkiConfig, payload: MinePayload): Promise<MineResult> {
  validateMinePayload(config, payload);

  const matchingNote = await findMatchingNote(config, payload);
  if (!matchingNote) {
    throw new NoMatchingCardError();
  }

  validateConfiguredFields(config, matchingNote);

  const media: MineResult['media'] = {};
  if (payload.audioPath) {
    media.audio = await uploadMedia(config, payload, payload.audioPath, 'audio');
  }
  if (payload.screenshotPath) {
    media.image = await uploadMedia(config, payload, payload.screenshotPath, 'image');
  }

  const fields = buildFieldPayload(config, payload, media);
  await ankiRequest(config, 'updateNoteFields', {
    note: {
      id: matchingNote.noteId,
      fields,
    },
  });

  return {
    success: true,
    message: 'Anki note updated successfully.',
    noteId: matchingNote.noteId,
    media,
  };
}

async function findMatchingNote(config: AnkiConfig, payload: MinePayload): Promise<NoteInfo | null> {
  const sentenceCandidates = buildSentenceCandidates(payload);
  if (sentenceCandidates.length === 0) {
    return null;
  }

  const newestNote = await findNewestCandidateNote(config);
  if (!newestNote) {
    return null;
  }

  const hasMatchingSentence = sentenceCandidates.some((candidate) =>
    noteMatchesSentence(config, newestNote, candidate.normalized),
  );
  return hasMatchingSentence ? newestNote : null;
}

async function findNewestCandidateNote(config: AnkiConfig): Promise<NoteInfo | null> {
  const query = buildSearchQuery(config.deck, config.noteType, config.extraQuery);
  const noteIds = await ankiRequest<number[]>(config, 'findNotes', { query });
  if (!Array.isArray(noteIds) || noteIds.length === 0) {
    return null;
  }

  const newestNoteId = Math.max(...noteIds);
  const notes = await getNotesInfo(config, [newestNoteId]);
  return notes[0] ?? null;
}

export async function listDeckNames(config: AnkiConfig): Promise<string[]> {
  return ankiRequest<string[]>(config, 'deckNames');
}

export async function listModelNames(config: AnkiConfig): Promise<string[]> {
  return ankiRequest<string[]>(config, 'modelNames');
}

export async function listModelFieldNames(config: AnkiConfig, modelName: string): Promise<string[]> {
  return ankiRequest<string[]>(config, 'modelFieldNames', { modelName });
}

async function getNotesInfo(config: AnkiConfig, noteIds: number[]): Promise<NoteInfo[]> {
  const notes = await ankiRequest<NoteInfo[]>(config, 'notesInfo', { notes: noteIds });
  if (!Array.isArray(notes)) {
    throw new Error('Unable to load Anki note info.');
  }

  return notes;
}

async function uploadMedia(
  config: AnkiConfig,
  payload: MinePayload,
  mediaPath: string,
  kind: 'audio' | 'image',
): Promise<string> {
  const extension = path.extname(mediaPath).replace(/^\./, '') || (kind === 'audio' ? 'mp3' : 'jpg');
  const filename = applyFilenameTemplate(config.filenameTemplate, payload, kind, extension);
  const base64Data = await fs.readFile(mediaPath, { encoding: 'base64' });

  await ankiRequest(config, 'storeMediaFile', {
    filename,
    data: base64Data,
  });

  return filename;
}

function buildFieldPayload(
  config: AnkiConfig,
  payload: MinePayload,
  media: { audio?: string; image?: string } | undefined,
): Record<string, string> {
  const subtitleField = config.fields.subtitle;
  const fieldValues: Record<string, string> = {
    [subtitleField]: renderSubtitleHtml(payload.text),
  };

  if (config.fields.audio) {
    fieldValues[config.fields.audio] = media?.audio ? `[sound:${media.audio}]` : '';
  }

  if (config.fields.image) {
    fieldValues[config.fields.image] = media?.image ? `<img src="${media.image}" alt="SentenceMiner screenshot">` : '';
  }

  if (config.fields.source) {
    fieldValues[config.fields.source] = renderSubtitleHtml(basenameWithoutExtension(payload.filePath));
  }

  if (config.fields.time) {
    fieldValues[config.fields.time] = formatTimestampRange(payload.startMs, payload.endMs);
  }

  if (config.fields.filename) {
    fieldValues[config.fields.filename] = renderSubtitleHtml(path.basename(payload.filePath));
  }

  return fieldValues;
}

function validateMinePayload(config: AnkiConfig, payload: MinePayload): void {
  if (!payload.text.trim()) {
    throw new Error('Cannot mine without subtitle text.');
  }

  if (!payload.filePath.trim()) {
    throw new Error('Cannot mine without a source media path.');
  }

  if (!config.fields.subtitle) {
    throw new Error('A subtitle field must be configured.');
  }
}

function validateConfiguredFields(config: AnkiConfig, note: NoteInfo): void {
  const expectedFields = Object.values(config.fields).filter(Boolean);
  const noteFieldNames = new Set(Object.keys(note.fields));

  for (const fieldName of expectedFields) {
    if (!noteFieldNames.has(fieldName)) {
      throw new Error(`Configured field "${fieldName}" does not exist on note ${note.noteId}.`);
    }
  }
}

function buildSentenceCandidates(payload: MinePayload): SentenceCandidate[] {
  const seen = new Set<string>();
  const candidates = [payload.text, ...(payload.sentenceMatchCandidates ?? [])];

  return candidates
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => ({
      normalized: normalizeSubtitleForMatching(candidate),
    }))
    .filter((candidate) => {
      if (!candidate.normalized || seen.has(candidate.normalized)) {
        return false;
      }

      seen.add(candidate.normalized);
      return true;
    });
}

function noteMatchesSentence(config: AnkiConfig, note: NoteInfo, normalizedSentence: string): boolean {
  const subtitleValue = note.fields[config.fields.subtitle]?.value;
  if (typeof subtitleValue !== 'string') {
    return false;
  }

  return normalizeSubtitleForMatching(subtitleValue) === normalizedSentence;
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
