import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBatchHistoryMineRequest,
  buildHistoryEntryKey,
  reconcileSelectedHistoryKeys,
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
