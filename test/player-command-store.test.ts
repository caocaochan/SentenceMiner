import test from 'node:test';
import assert from 'node:assert/strict';

import { PlayerCommandStore } from '../src/player-command-store.ts';

test('PlayerCommandStore queues, overwrites, and claims seek commands by session', () => {
  const store = new PlayerCommandStore();

  store.queueSeek({
    sessionId: 's1',
    filePath: 'episode.mkv',
    text: 'one',
    startMs: 100,
    endMs: 200,
    playbackTimeMs: 120,
  });
  store.queueSeek({
    sessionId: 's1',
    filePath: 'episode.mkv',
    text: 'two',
    startMs: 300,
    endMs: 400,
    playbackTimeMs: 320,
  });

  assert.deepEqual(store.claim('s1'), {
    type: 'seek',
    startMs: 300,
  });
  assert.equal(store.claim('s1'), null);
});

test('PlayerCommandStore clears commands for one session or all sessions', () => {
  const store = new PlayerCommandStore();

  store.queueSeek({
    sessionId: 's1',
    filePath: 'episode.mkv',
    text: 'one',
    startMs: 100,
    endMs: 200,
    playbackTimeMs: 120,
  });
  store.queueSeek({
    sessionId: 's2',
    filePath: 'episode.mkv',
    text: 'two',
    startMs: 300,
    endMs: 400,
    playbackTimeMs: 320,
  });

  store.clearSession('s1');
  assert.equal(store.claim('s1'), null);
  assert.deepEqual(store.claim('s2'), {
    type: 'seek',
    startMs: 300,
  });

  store.queueSeek({
    sessionId: 's3',
    filePath: 'episode.mkv',
    text: 'three',
    startMs: 500,
    endMs: 600,
    playbackTimeMs: 520,
  });
  store.clearAll();
  assert.equal(store.claim('s3'), null);
});
