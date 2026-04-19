import test from 'node:test';
import assert from 'node:assert/strict';

import { TranscriptStore } from '../src/transcript-store.ts';

test('TranscriptStore keeps current subtitle and bounded history', () => {
  const store = new TranscriptStore(2);
  store.startSession({ action: 'start', sessionId: 's1', filePath: 'episode.mkv' });

  store.pushSubtitle({
    sessionId: 's1',
    filePath: 'episode.mkv',
    text: 'one',
    startMs: 100,
    endMs: 200,
    playbackTimeMs: 150,
  });
  store.pushSubtitle({
    sessionId: 's1',
    filePath: 'episode.mkv',
    text: 'two',
    startMs: 300,
    endMs: 400,
    playbackTimeMs: 350,
  });
  store.pushSubtitle({
    sessionId: 's1',
    filePath: 'episode.mkv',
    text: 'three',
    startMs: 500,
    endMs: 600,
    playbackTimeMs: 550,
  });

  const state = store.getState();
  assert.equal(state.currentSubtitle?.text, 'three');
  assert.deepEqual(
    state.history.map((entry) => entry.text),
    ['two', 'three'],
  );
});

test('TranscriptStore keeps the last non-empty subtitle on empty text without dropping history', () => {
  const store = new TranscriptStore(10);
  store.startSession({ action: 'start', sessionId: 's1', filePath: 'episode.mkv' });
  store.pushSubtitle({
    sessionId: 's1',
    filePath: 'episode.mkv',
    text: 'hello',
    startMs: 100,
    endMs: 200,
    playbackTimeMs: 150,
  });
  store.pushSubtitle({
    sessionId: 's1',
    filePath: 'episode.mkv',
    text: '',
    startMs: null,
    endMs: null,
    playbackTimeMs: 210,
  });

  const state = store.getState();
  assert.equal(state.currentSubtitle?.text, 'hello');
  assert.equal(state.history.length, 1);
});

test('TranscriptStore session reset clears current subtitle and history', () => {
  const store = new TranscriptStore(10);
  store.startSession({ action: 'start', sessionId: 's1', filePath: 'episode-1.mkv' });
  store.pushSubtitle({
    sessionId: 's1',
    filePath: 'episode-1.mkv',
    text: 'hello',
    startMs: 100,
    endMs: 200,
    playbackTimeMs: 150,
  });

  store.startSession({ action: 'start', sessionId: 's2', filePath: 'episode-2.mkv' });

  const state = store.getState();
  assert.equal(state.currentSubtitle, null);
  assert.deepEqual(state.history, []);
  assert.equal(state.session?.sessionId, 's2');
});
