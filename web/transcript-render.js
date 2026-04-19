import { buildHistoryEntryKey, isHistorySelectionToggleAllowed } from './history-selection.js';

export function buildTranscriptStructureSignature(entries) {
  return entries
    .map((entry) =>
      [
        buildHistoryEntryKey(entry),
        entry.orderIndex ?? '',
        entry.text,
        entry.startMs ?? 'nil',
        entry.endMs ?? 'nil',
      ].join('::'),
    )
    .join('|');
}

export function shouldRebuildTranscriptList(previousSignature, entries) {
  return previousSignature !== buildTranscriptStructureSignature(entries);
}

export function computeTranscriptItemUiState(entries, selectedKeys, pendingActions, currentCueId, entry) {
  const entryKey = buildHistoryEntryKey(entry);

  return {
    entryKey,
    active: currentCueId === entry.id,
    selected: selectedKeys.has(entryKey),
    goToDisabled: pendingActions.has(`go-to:${entryKey}`),
    mineDisabled: pendingActions.has(`mine:${entryKey}`),
    checkboxDisabled: !isHistorySelectionToggleAllowed(entries, selectedKeys, entry, selectedKeys.has(entryKey)),
  };
}

export function shouldAutoScrollToCue(previousCueId, nextCueId) {
  return Boolean(nextCueId && previousCueId !== nextCueId);
}
