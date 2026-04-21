import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTranscriptStructureSignature,
  computeTranscriptFollowScrollTarget,
  computeTranscriptItemUiState,
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

test('active cue changes do not rebuild the transcript list', () => {
  const entries = [buildCue('cue-1', 'one', 100), buildCue('cue-2', 'two', 200)];
  const signature = buildTranscriptStructureSignature(entries);

  assert.equal(shouldRebuildTranscriptList(signature, entries), false);
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

test('selected middle transcript lines cannot be toggled out of a consecutive block', () => {
  const first = buildCue('cue-1', 'one', 100);
  const second = buildCue('cue-2', 'two', 200);
  const third = buildCue('cue-3', 'three', 300);
  const selectedKeys = new Set([
    buildHistoryEntryKey(first),
    buildHistoryEntryKey(second),
    buildHistoryEntryKey(third),
  ]);

  const firstUi = computeTranscriptItemUiState([first, second, third], selectedKeys, new Set(), 'cue-1', first);
  const secondUi = computeTranscriptItemUiState([first, second, third], selectedKeys, new Set(), 'cue-1', second);
  const thirdUi = computeTranscriptItemUiState([first, second, third], selectedKeys, new Set(), 'cue-1', third);

  assert.equal(firstUi.checkboxDisabled, false);
  assert.equal(secondUi.checkboxDisabled, true);
  assert.equal(thirdUi.checkboxDisabled, false);
});

test('computeTranscriptFollowScrollTarget keeps the viewport still when the cue is already in the comfort band', () => {
  const target = computeTranscriptFollowScrollTarget({
    itemTop: 180,
    itemBottom: 260,
    viewportHeight: 900,
    currentScrollTop: 400,
    documentHeight: 2400,
    stickyHeaderHeight: 120,
    stickyTopGap: 0,
  });

  assert.equal(target, null);
});

test('computeTranscriptFollowScrollTarget scrolls up only enough to clear the sticky header area', () => {
  const target = computeTranscriptFollowScrollTarget({
    itemTop: 90,
    itemBottom: 170,
    viewportHeight: 900,
    currentScrollTop: 400,
    documentHeight: 2400,
    stickyHeaderHeight: 120,
    stickyTopGap: 0,
  });

  assert.equal(target, 354);
});

test('computeTranscriptFollowScrollTarget scrolls down only enough to keep the cue above the lower comfort edge', () => {
  const target = computeTranscriptFollowScrollTarget({
    itemTop: 650,
    itemBottom: 760,
    viewportHeight: 900,
    currentScrollTop: 400,
    documentHeight: 2400,
    stickyHeaderHeight: 120,
    stickyTopGap: 0,
  });

  assert.equal(target, 458);
});

test('computeTranscriptFollowScrollTarget clamps scrolling to the document bounds', () => {
  const topTarget = computeTranscriptFollowScrollTarget({
    itemTop: 40,
    itemBottom: 120,
    viewportHeight: 900,
    currentScrollTop: 20,
    documentHeight: 2400,
    stickyHeaderHeight: 120,
    stickyTopGap: 0,
  });
  const bottomTarget = computeTranscriptFollowScrollTarget({
    itemTop: 840,
    itemBottom: 980,
    viewportHeight: 900,
    currentScrollTop: 1480,
    documentHeight: 2400,
    stickyHeaderHeight: 120,
    stickyTopGap: 0,
  });

  assert.equal(topTarget, 0);
  assert.equal(bottomTarget, 1500);
});
