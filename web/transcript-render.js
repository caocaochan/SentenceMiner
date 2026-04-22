import { buildHistoryEntryKey, isHistorySelectionToggleAllowed } from './history-selection.js';

const DEFAULT_TRANSCRIPT_SCROLL_TOP_PADDING_PX = 16;
const DEFAULT_TRANSCRIPT_SCROLL_BOTTOM_PADDING_MIN_PX = 120;
const DEFAULT_TRANSCRIPT_SCROLL_BOTTOM_PADDING_MAX_PX = 240;
const WORD_SEGMENTER = typeof Intl?.Segmenter === 'function'
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null;

export function buildTranscriptStructureSignature(entries) {
  return entries
    .map((entry) =>
      [
        buildHistoryEntryKey(entry),
        entry.orderIndex ?? '',
        entry.text,
        entry.startMs ?? 'nil',
        entry.endMs ?? 'nil',
        entry.learning?.iPlusOne ? 'i+1' : '',
        (entry.learning?.unknownWords ?? []).join(','),
      ].join('::'),
    )
    .join('|');
}

export function shouldRebuildTranscriptList(previousSignature, entries) {
  return previousSignature !== buildTranscriptStructureSignature(entries);
}

export function buildTranscriptBookmarkKey(entry) {
  return [
    entry.filePath ?? '',
    entry.orderIndex ?? '',
    entry.startMs ?? 'nil',
    entry.endMs ?? 'nil',
    normalizeBookmarkText(entry.text),
  ].join('::');
}

export function filterTranscriptEntriesForBookmarkView(entries, bookmarkedKeys, showBookmarkedOnly) {
  if (!showBookmarkedOnly) {
    return entries;
  }

  return entries.filter((entry) => bookmarkedKeys.has(buildTranscriptBookmarkKey(entry)));
}

export function shouldHandleTranscriptBookmarkShortcut({
  key,
  ctrlKey = false,
  altKey = false,
  metaKey = false,
  isComposing = false,
  settingsModalOpen = false,
  targetTagName = '',
  targetIsContentEditable = false,
}) {
  if (settingsModalOpen || isComposing || ctrlKey || altKey || metaKey || key?.toLowerCase() !== 'b') {
    return false;
  }

  const tagName = targetTagName.toUpperCase();
  return !targetIsContentEditable && !['INPUT', 'SELECT', 'TEXTAREA'].includes(tagName);
}

export function buildHighlightedTranscriptParts(text, unknownWords = []) {
  const unknownWordSet = new Set(unknownWords.map(normalizeLearningToken).filter(Boolean));
  if (unknownWordSet.size === 0 || !WORD_SEGMENTER) {
    return [{ text: String(text ?? ''), unknown: false }];
  }

  const parts = [];
  for (const segment of WORD_SEGMENTER.segment(String(text ?? ''))) {
    const normalized = segment.isWordLike ? normalizeLearningToken(segment.segment) : '';
    parts.push({
      text: segment.segment,
      unknown: Boolean(normalized && unknownWordSet.has(normalized)),
    });
  }

  return mergeAdjacentTranscriptParts(parts);
}

export function computeTranscriptItemUiState(
  entries,
  selectedKeys,
  pendingActions,
  currentCueId,
  entry,
  bookmarkedKeys = new Set(),
  actionsEnabled = true,
) {
  const entryKey = buildHistoryEntryKey(entry);
  const bookmarkKey = buildTranscriptBookmarkKey(entry);

  return {
    entryKey,
    bookmarkKey,
    active: currentCueId === entry.id,
    selected: selectedKeys.has(entryKey),
    bookmarked: bookmarkedKeys.has(bookmarkKey),
    goToDisabled: !actionsEnabled || pendingActions.has(`go-to:${entryKey}`),
    mineDisabled: !actionsEnabled || pendingActions.has(`mine:${entryKey}`),
    checkboxDisabled:
      !actionsEnabled || !isHistorySelectionToggleAllowed(entries, selectedKeys, entry, !selectedKeys.has(entryKey)),
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

function normalizeBookmarkText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function mergeAdjacentTranscriptParts(parts) {
  const merged = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    if (previous && previous.unknown === part.unknown) {
      previous.text += part.text;
      continue;
    }

    merged.push({ ...part });
  }

  return merged;
}

function normalizeLearningToken(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
