import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { MineResult, MineStatus, SubtitleTrackPayload, TranscriptCue } from './types.ts';

const STORE_VERSION = 1;
const MAX_TRANSCRIPT_RECORDS = 100;

export interface CueProgressPatch {
  bookmarked?: boolean;
  mineStatus?: MineStatus;
  noteId?: number | null;
  message?: string | null;
  updatedAt?: string;
}

interface PersistedCue {
  key: string;
  orderIndex: number;
  startMs: number | null;
  endMs: number | null;
  text: string;
  bookmarked: boolean;
  mineStatus: MineStatus;
  noteId?: number;
  message?: string;
  updatedAt?: string;
}

interface PersistedTranscriptRecord {
  key: string;
  filePath: string;
  subtitleTrack: Omit<SubtitleTrackPayload, 'sessionId'>;
  transcript: PersistedCue[];
  updatedAt: string;
}

interface PersistedSessionFile {
  version: typeof STORE_VERSION;
  records: PersistedTranscriptRecord[];
}

export class TranscriptSessionPersistence {
  readonly filePath: string;
  readonly maxRecords: number;

  constructor(filePath = resolveSessionStorePath(), maxRecords = MAX_TRANSCRIPT_RECORDS) {
    this.filePath = filePath;
    this.maxRecords = maxRecords;
  }

  async hydrateTranscript(track: SubtitleTrackPayload, transcript: TranscriptCue[]): Promise<TranscriptCue[]> {
    const store = await this.readStore();
    const record = findRecord(store, track);
    if (!record) {
      return transcript.map(withDefaultProgress);
    }

    const progressByCueKey = new Map(record.transcript.map((cue) => [cue.key, cue]));
    return transcript.map((cue) => {
      const persisted = progressByCueKey.get(buildCuePersistenceKey(cue));
      return withDefaultProgress({
        ...cue,
        bookmarked: persisted?.bookmarked ?? cue.bookmarked,
        mineStatus: persisted?.mineStatus ?? cue.mineStatus,
        noteId: persisted?.noteId ?? cue.noteId,
        message: persisted?.message ?? cue.message,
        updatedAt: persisted?.updatedAt ?? cue.updatedAt,
      });
    });
  }

  async saveTranscript(track: SubtitleTrackPayload, transcript: TranscriptCue[]): Promise<void> {
    const store = await this.readStore();
    upsertRecord(store, track, transcript.map(withDefaultProgress));
    pruneRecords(store, this.maxRecords);
    await this.writeStore(store);
  }

  async readStore(): Promise<PersistedSessionFile> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedSessionFile>;
      if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.records)) {
        return buildEmptyStore();
      }

      return {
        version: STORE_VERSION,
        records: parsed.records.filter(isPersistedTranscriptRecord),
      };
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError) {
        return buildEmptyStore();
      }

      throw error;
    }
  }

  private async writeStore(store: PersistedSessionFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const content = `${JSON.stringify(store, null, 2)}\n`;

    try {
      await fs.writeFile(tempPath, content, 'utf8');
      await fs.rename(tempPath, this.filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

export function resolveSessionStorePath(platform = process.platform, env = process.env): string {
  if (platform === 'win32') {
    const root = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(root, 'SentenceMiner', 'sessions.json');
  }

  const root = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(root, 'SentenceMiner', 'sessions.json');
}

export function buildTranscriptPersistenceKey(track: SubtitleTrackPayload): string {
  return [
    normalizePathForKey(track.filePath),
    track.kind,
    normalizePathForKey(track.externalFilePath ?? ''),
    track.trackId ?? '',
    track.ffIndex ?? '',
    normalizeKeyText(track.codec ?? ''),
    normalizeKeyText(track.title ?? ''),
    normalizeKeyText(track.lang ?? ''),
  ].join('::');
}

export function buildCuePersistenceKey(cue: Pick<TranscriptCue, 'orderIndex' | 'startMs' | 'endMs' | 'text'>): string {
  return [
    cue.orderIndex,
    cue.startMs ?? 'nil',
    cue.endMs ?? 'nil',
    normalizeKeyText(cue.text),
  ].join('::');
}

export function withDefaultProgress(cue: TranscriptCue): TranscriptCue {
  return {
    ...cue,
    bookmarked: cue.bookmarked ?? false,
    mineStatus: cue.mineStatus ?? 'unmined',
    noteId: cue.noteId,
    message: cue.message,
    updatedAt: cue.updatedAt,
  };
}

export function applyProgressToCues(
  cues: TranscriptCue[],
  cueIds: Set<string>,
  patch: CueProgressPatch,
): TranscriptCue[] {
  const updatedAt = patch.updatedAt ?? new Date().toISOString();
  return cues.map((cue) => {
    if (!cueIds.has(cue.id)) {
      return withDefaultProgress(cue);
    }

    return withDefaultProgress({
      ...cue,
      bookmarked: patch.bookmarked ?? cue.bookmarked,
      mineStatus: patch.mineStatus ?? cue.mineStatus,
      noteId: patch.noteId === null ? undefined : (patch.noteId ?? cue.noteId),
      message: patch.message === null ? undefined : (patch.message ?? cue.message),
      updatedAt,
    });
  });
}

export function buildMineSuccessProgress(result: MineResult): CueProgressPatch {
  return {
    mineStatus: 'mined',
    noteId: result.noteId ?? null,
    message: result.message,
  };
}

function buildEmptyStore(): PersistedSessionFile {
  return {
    version: STORE_VERSION,
    records: [],
  };
}

function findRecord(store: PersistedSessionFile, track: SubtitleTrackPayload): PersistedTranscriptRecord | null {
  const key = buildTranscriptPersistenceKey(track);
  return store.records.find((record) => record.key === key) ?? null;
}

function upsertRecord(store: PersistedSessionFile, track: SubtitleTrackPayload, transcript: TranscriptCue[]): void {
  const key = buildTranscriptPersistenceKey(track);
  const updatedAt = new Date().toISOString();
  const record: PersistedTranscriptRecord = {
    key,
    filePath: track.filePath,
    subtitleTrack: {
      filePath: track.filePath,
      kind: track.kind,
      externalFilePath: track.externalFilePath ?? null,
      trackId: track.trackId ?? null,
      ffIndex: track.ffIndex ?? null,
      codec: track.codec ?? null,
      title: track.title ?? null,
      lang: track.lang ?? null,
    },
    transcript: transcript.map(toPersistedCue),
    updatedAt,
  };

  const existingIndex = store.records.findIndex((candidate) => candidate.key === key);
  if (existingIndex === -1) {
    store.records.push(record);
  } else {
    store.records.splice(existingIndex, 1, record);
  }
}

function pruneRecords(store: PersistedSessionFile, maxRecords: number): void {
  store.records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (store.records.length > maxRecords) {
    store.records.splice(maxRecords);
  }
}

function toPersistedCue(cue: TranscriptCue): PersistedCue {
  const progressCue = withDefaultProgress(cue);
  return {
    key: buildCuePersistenceKey(progressCue),
    orderIndex: progressCue.orderIndex,
    startMs: progressCue.startMs,
    endMs: progressCue.endMs,
    text: progressCue.text,
    bookmarked: Boolean(progressCue.bookmarked),
    mineStatus: progressCue.mineStatus ?? 'unmined',
    noteId: progressCue.noteId,
    message: progressCue.message,
    updatedAt: progressCue.updatedAt,
  };
}

function isPersistedTranscriptRecord(value: unknown): value is PersistedTranscriptRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<PersistedTranscriptRecord>;
  return typeof record.key === 'string' && Array.isArray(record.transcript);
}

function normalizePathForKey(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function normalizeKeyText(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
