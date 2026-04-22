import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  TranscriptSessionPersistence,
  buildCuePersistenceKey,
  buildTranscriptPersistenceKey,
  resolveSessionStorePath,
} from '../src/session-persistence.ts';
import type { SubtitleTrackPayload, TranscriptCue } from '../src/types.ts';

test('resolveSessionStorePath uses the Windows AppData SentenceMiner store', () => {
  assert.equal(
    resolveSessionStorePath('win32', { APPDATA: 'C:\\Users\\Test\\AppData\\Roaming' }),
    'C:\\Users\\Test\\AppData\\Roaming\\SentenceMiner\\sessions.json',
  );
});

test('TranscriptSessionPersistence restores cue progress across session ids', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentenceminer-persistence-test-'));
  const store = new TranscriptSessionPersistence(path.join(tempRoot, 'sessions.json'));

  try {
    await store.saveTranscript(buildTrack('session-1'), [
      {
        ...buildCue('session-1', 0, 'hello'),
        bookmarked: true,
        mineStatus: 'mined',
        noteId: 42,
        message: 'Anki note updated successfully.',
        updatedAt: '2026-04-22T10:00:00.000Z',
      },
    ]);

    const hydrated = await store.hydrateTranscript(buildTrack('session-2'), [buildCue('session-2', 0, 'hello')]);

    assert.equal(hydrated[0].bookmarked, true);
    assert.equal(hydrated[0].mineStatus, 'mined');
    assert.equal(hydrated[0].noteId, 42);
    assert.equal(hydrated[0].message, 'Anki note updated successfully.');
    assert.equal(buildTranscriptPersistenceKey(buildTrack('session-1')), buildTranscriptPersistenceKey(buildTrack('session-2')));
    assert.equal(buildCuePersistenceKey(buildCue('session-1', 0, 'hello')), buildCuePersistenceKey(buildCue('session-2', 0, 'hello')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('TranscriptSessionPersistence tolerates corrupt storage and prunes old records', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentenceminer-persistence-test-'));
  const storePath = path.join(tempRoot, 'sessions.json');
  const store = new TranscriptSessionPersistence(storePath, 2);

  try {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, '{not json', 'utf8');
    assert.deepEqual(await store.readStore(), { version: 1, records: [] });

    await store.saveTranscript(buildTrack('s1', 'episode-1.mkv'), [buildCue('s1', 0, 'one')]);
    await store.saveTranscript(buildTrack('s2', 'episode-2.mkv'), [buildCue('s2', 0, 'two')]);
    await store.saveTranscript(buildTrack('s3', 'episode-3.mkv'), [buildCue('s3', 0, 'three')]);

    const stored = await store.readStore();
    assert.equal(stored.records.length, 2);
    assert.deepEqual(
      stored.records.map((record) => record.filePath).sort(),
      ['episode-2.mkv', 'episode-3.mkv'],
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

function buildTrack(sessionId: string, filePath = 'episode.mkv'): SubtitleTrackPayload {
  return {
    sessionId,
    filePath,
    kind: 'external',
    externalFilePath: `${filePath}.srt`,
    trackId: 1,
    ffIndex: null,
    codec: 'subrip',
    title: 'English',
    lang: 'en',
  };
}

function buildCue(sessionId: string, orderIndex: number, text: string): TranscriptCue {
  return {
    id: `${sessionId}:${orderIndex}`,
    orderIndex,
    sessionId,
    filePath: 'episode.mkv',
    text,
    startMs: orderIndex * 1000,
    endMs: (orderIndex * 1000) + 500,
    playbackTimeMs: orderIndex * 1000,
  };
}
