import fs from 'node:fs/promises';
import path from 'node:path';

import type { AnkiConfig, MinePayload, MineResult } from './types.ts';
import {
  applyFilenameTemplate,
  basenameWithoutExtension,
  buildSearchQuery,
  formatTimestampRange,
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

export async function mineToAnki(config: AnkiConfig, payload: MinePayload): Promise<MineResult> {
  validateMinePayload(config, payload);

  const noteId = await findNewestMatchingNote(config);
  const noteInfo = await getNoteInfo(config, noteId);
  validateConfiguredFields(config, noteInfo);

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
      id: noteId,
      fields,
    },
  });

  return {
    success: true,
    message: 'Anki note updated successfully.',
    noteId,
    media,
  };
}

export async function findNewestMatchingNote(config: AnkiConfig): Promise<number> {
  const query = buildSearchQuery(config.deck, config.noteType, config.extraQuery);
  const noteIds = await ankiRequest<number[]>(config, 'findNotes', { query });
  if (!Array.isArray(noteIds) || noteIds.length === 0) {
    throw new Error(`No Anki note matched query: ${query}`);
  }

  return Math.max(...noteIds);
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

async function getNoteInfo(config: AnkiConfig, noteId: number): Promise<NoteInfo> {
  const notes = await ankiRequest<NoteInfo[]>(config, 'notesInfo', { notes: [noteId] });
  if (!Array.isArray(notes) || notes.length === 0) {
    throw new Error(`Unable to load Anki note info for note ${noteId}.`);
  }

  return notes[0];
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
