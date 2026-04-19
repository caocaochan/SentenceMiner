import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTranscriptStructureSignature,
  computeTranscriptItemUiState,
  shouldAutoScrollToCue,
  shouldRebuildTranscriptList,
} from '../web/transcript-render.js';
import { buildHistoryEntryKey } from '../web/history-selection.js';

function buildCue(id: string, text: string, startMs: number) {
  return {
    id,
    orderIndex: startMs / 100,
    sessionId: 'session-1',
    filePath: 'episode.mkv',
    text,
    startMs,
    endMs: startMs + 80,
    playbackTimeMs: startMs,
  };
}

test('identical transcript snapshots do not rebuild the transcript list', () => {
  const entries = [buildCue('cue-1', 'one', 100), buildCue('cue-2', 'two', 200)];
  const signature = buildTranscriptStructureSignature(entries);

  assert.equal(shouldRebuildTranscriptList(signature, structuredClone(entries)), false);
});

test('active cue changes request auto-scroll without rebuilding the transcript list', () => {
  const entries = [buildCue('cue-1', 'one', 100), buildCue('cue-2', 'two', 200)];
  const signature = buildTranscriptStructureSignature(entries);

  assert.equal(shouldRebuildTranscriptList(signature, entries), false);
  assert.equal(shouldAutoScrollToCue('cue-1', 'cue-2'), true);
});

test('pending actions only disable the relevant transcript buttons', () => {
  const first = buildCue('cue-1', 'one', 100);
  const second = buildCue('cue-2', 'two', 200);
  const selectedKeys = new Set([buildHistoryEntryKey(second)]);
  const pendingActions = new Set([`go-to:${buildHistoryEntryKey(first)}`]);

  const firstUi = computeTranscriptItemUiState([first, second], selectedKeys, pendingActions, 'cue-1', first);
  const secondUi = computeTranscriptItemUiState([first, second], selectedKeys, pendingActions, 'cue-1', second);

  assert.equal(firstUi.goToDisabled, true);
  assert.equal(firstUi.active, true);
  assert.equal(secondUi.goToDisabled, false);
  assert.equal(secondUi.selected, true);
});
