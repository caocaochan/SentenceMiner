import { buildHistoryEntryKey, isHistorySelectionToggleAllowed } from './history-selection.js';

const DEFAULT_TRANSCRIPT_SCROLL_TOP_PADDING_PX = 16;
const DEFAULT_TRANSCRIPT_SCROLL_BOTTOM_PADDING_MIN_PX = 120;
const DEFAULT_TRANSCRIPT_SCROLL_BOTTOM_PADDING_MAX_PX = 240;

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

export function computeTranscriptFollowScrollTarget({
  itemTop,
  itemBottom,
  viewportHeight,
  currentScrollTop,
  documentHeight,
  stickyHeaderHeight = 0,
  stickyTopGap = 0,
  topPadding = DEFAULT_TRANSCRIPT_SCROLL_TOP_PADDING_PX,
  bottomPadding = clamp(viewportHeight * 0.22, DEFAULT_TRANSCRIPT_SCROLL_BOTTOM_PADDING_MIN_PX, DEFAULT_TRANSCRIPT_SCROLL_BOTTOM_PADDING_MAX_PX),
}) {
  const maxScrollTop = Math.max(0, documentHeight - viewportHeight);
  const topBoundary = Math.max(0, stickyHeaderHeight + stickyTopGap + topPadding);
  const bottomBoundary = Math.max(topBoundary + 1, viewportHeight - bottomPadding);

  let scrollDelta = 0;
  if (itemTop < topBoundary) {
    scrollDelta = itemTop - topBoundary;
  } else if (itemBottom > bottomBoundary) {
    scrollDelta = itemBottom - bottomBoundary;
  }

  if (Math.abs(scrollDelta) < 2) {
    return null;
  }

  return clamp(currentScrollTop + scrollDelta, 0, maxScrollTop);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
