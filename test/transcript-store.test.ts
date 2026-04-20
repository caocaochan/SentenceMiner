import test from 'node:test';
import assert from 'node:assert/strict';

import { TranscriptStore } from '../src/transcript-store.ts';

function buildTrack(sessionId = 's1', filePath = 'episode.mkv') {
  return {
    sessionId,
    filePath,
    kind: 'external' as const,
    externalFilePath: `${filePath}.srt`,
    trackId: 1,
    ffIndex: null,
    codec: 'subrip',
    title: 'English',
    lang: 'en',
  };
}

function buildCue(text: string, startMs: number, sessionId = 's1', filePath = 'episode.mkv') {
  return {
    id: `${sessionId}:${startMs}`,
    orderIndex: startMs / 100,
    sessionId,
    filePath,
    text,
    startMs,
    endMs: startMs + 80,
    playbackTimeMs: startMs,
  };
}

test('TranscriptStore replaces the active transcript and keeps chronological order', () => {
  const store = new TranscriptStore();
  store.startSession({
    action: 'start',
    sessionId: 's1',
    filePath: 'episode.mkv',
    subtitleTrack: buildTrack(),
  });

  store.setTranscript(buildTrack(), [buildCue('one', 100), buildCue('two', 200), buildCue('three', 300)]);

  const state = store.getState();
  assert.deepEqual(
    state.transcript.map((entry) => entry.text),
    ['one', 'two', 'three'],
  );
  assert.equal(state.transcriptStatus, 'ready');
  assert.equal(state.history.length, 3);
});

test('TranscriptStore matches the current cue from live subtitle timings', () => {
  const store = new TranscriptStore();
  store.startSession({
    action: 'start',
    sessionId: 's1',
    filePath: 'episode.mkv',
    subtitleTrack: buildTrack(),
  });
  store.setTranscript(buildTrack(), [buildCue('one', 100), buildCue('two', 200), buildCue('three', 300)]);

  store.pushSubtitle({
    sessionId: 's1',
    filePath: 'episode.mkv',
    text: 'two',
    startMs: 200,
    endMs: 280,
    playbackTimeMs: 240,
  });

  const state = store.getState();
  assert.equal(state.currentSubtitle?.text, 'two');
  assert.equal(state.currentCueId, 's1:200');
});

test('TranscriptStore keeps the previous cue active after playback leaves subtitles', () => {
  const store = new TranscriptStore();
  store.startSession({
    action: 'start',
    sessionId: 's1',
    filePath: 'episode.mkv',
    subtitleTrack: buildTrack(),
  });
  store.setTranscript(buildTrack(), [buildCue('one', 100), buildCue('two', 200)]);

  store.pushSubtitle({
    sessionId: 's1',
    filePath: 'episode.mkv',
    text: '',
    startMs: null,
    endMs: null,
    playbackTimeMs: 500,
  });

  const state = store.getState();
  assert.equal(state.currentSubtitle, null);
  assert.equal(state.currentCueId, 's1:200');
});

test('TranscriptStore keeps the previous cue active while playback is between cues', () => {
  const store = new TranscriptStore();
  store.startSession({
    action: 'start',
    sessionId: 's1',
    filePath: 'episode.mkv',
    subtitleTrack: buildTrack(),
  });
  store.setTranscript(buildTrack(), [buildCue('one', 100), buildCue('two', 300)]);

  store.pushSubtitle({
    sessionId: 's1',
    filePath: 'episode.mkv',
    text: '',
    startMs: null,
    endMs: null,
    playbackTimeMs: 250,
  });

  const state = store.getState();
  assert.equal(state.currentSubtitle, null);
  assert.equal(state.currentCueId, 's1:100');
});

test('TranscriptStore keeps the current cue empty before the first subtitle is reached', () => {
  const store = new TranscriptStore();
  store.startSession({
    action: 'start',
    sessionId: 's1',
    filePath: 'episode.mkv',
    subtitleTrack: buildTrack(),
  });
  store.setTranscript(buildTrack(), [buildCue('one', 100), buildCue('two', 300)]);

  const state = store.updatePlaybackTime(50);
  assert.equal(state.currentCueId, null);
});

test('TranscriptStore stores unavailable fallback state when transcript loading fails', () => {
  const store = new TranscriptStore();
  const track = buildTrack();
  store.startSession({
    action: 'start',
    sessionId: 's1',
    filePath: 'episode.mkv',
    subtitleTrack: track,
  });

  store.setTranscriptUnavailable(track, 'No active subtitle track is selected.');

  const state = store.getState();
  assert.equal(state.transcriptStatus, 'unavailable');
  assert.equal(state.transcriptMessage, 'No active subtitle track is selected.');
  assert.deepEqual(state.transcript, []);
});

test('TranscriptStore session reset clears transcript state', () => {
  const store = new TranscriptStore();
  store.startSession({
    action: 'start',
    sessionId: 's1',
    filePath: 'episode-1.mkv',
    subtitleTrack: buildTrack('s1', 'episode-1.mkv'),
  });
  store.setTranscript(buildTrack('s1', 'episode-1.mkv'), [buildCue('hello', 100, 's1', 'episode-1.mkv')]);

  store.startSession({
    action: 'start',
    sessionId: 's2',
    filePath: 'episode-2.mkv',
    subtitleTrack: buildTrack('s2', 'episode-2.mkv'),
  });

  const state = store.getState();
  assert.equal(state.currentSubtitle, null);
  assert.deepEqual(state.transcript, []);
  assert.equal(state.session?.sessionId, 's2');
  assert.equal(state.transcriptStatus, 'loading');
});
