import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBatchHistoryMineRequest,
  buildHistoryEntryKey,
  isHistorySelectionToggleAllowed,
  reconcileSelectedHistoryKeys,
  toggleSelectedHistoryKeys,
} from '../web/history-selection.js';

function buildEntry(text: string, startMs: number, sessionId = 's1') {
  return {
    sessionId,
    filePath: 'C:\\Videos\\episode.mkv',
    text,
    startMs,
    endMs: startMs + 100,
    playbackTimeMs: startMs + 50,
  };
}

test('buildBatchHistoryMineRequest keeps transcript order instead of click order', () => {
  const first = buildEntry('first', 100);
  const second = buildEntry('second', 200);
  const third = buildEntry('third', 300);
  const selectedKeys = new Set([buildHistoryEntryKey(third), buildHistoryEntryKey(first)]);

  const request = buildBatchHistoryMineRequest([first, second, third], selectedKeys);

  assert.deepEqual(
    request.entries.map((entry) => entry.text),
    ['first', 'third'],
  );
});

test('reconcileSelectedHistoryKeys drops selections that are no longer visible', () => {
  const first = buildEntry('first', 100);
  const second = buildEntry('second', 200);
  const stale = buildEntry('stale', 300, 's2');

  const next = reconcileSelectedHistoryKeys(
    new Set([buildHistoryEntryKey(first), buildHistoryEntryKey(stale)]),
    [first, second],
  );

  assert.deepEqual([...next], [buildHistoryEntryKey(first)]);
});

test('toggleSelectedHistoryKeys extends a consecutive block one line at a time', () => {
  const first = buildEntry('first', 100);
  const second = buildEntry('second', 200);
  const third = buildEntry('third', 300);

  let selectedKeys = toggleSelectedHistoryKeys([first, second, third], new Set(), second, true);
  selectedKeys = toggleSelectedHistoryKeys([first, second, third], selectedKeys, third, true);

  assert.deepEqual(
    [...selectedKeys],
    [buildHistoryEntryKey(second), buildHistoryEntryKey(third)],
  );
});

test('toggleSelectedHistoryKeys starts a new block when a non-adjacent line is selected', () => {
  const first = buildEntry('first', 100);
  const second = buildEntry('second', 200);
  const third = buildEntry('third', 300);
  const fourth = buildEntry('fourth', 400);

  const selectedKeys = toggleSelectedHistoryKeys(
    [first, second, third, fourth],
    new Set([buildHistoryEntryKey(first), buildHistoryEntryKey(second)]),
    fourth,
    true,
  );

  assert.deepEqual([...selectedKeys], [buildHistoryEntryKey(fourth)]);
});

test('isHistorySelectionToggleAllowed only allows deselecting the edges of a multi-line block', () => {
  const first = buildEntry('first', 100);
  const second = buildEntry('second', 200);
  const third = buildEntry('third', 300);
  const selectedKeys = new Set([
    buildHistoryEntryKey(first),
    buildHistoryEntryKey(second),
    buildHistoryEntryKey(third),
  ]);

  assert.equal(isHistorySelectionToggleAllowed([first, second, third], selectedKeys, first, false), true);
  assert.equal(isHistorySelectionToggleAllowed([first, second, third], selectedKeys, second, false), false);
  assert.equal(isHistorySelectionToggleAllowed([first, second, third], selectedKeys, third, false), true);
});
