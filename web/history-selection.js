export function buildHistoryEntryKey(entry) {
  if (entry && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string' && entry.id) {
    return entry.id;
  }

  return [entry.sessionId, entry.filePath, entry.startMs ?? 'nil', entry.endMs ?? 'nil', entry.text].join('::');
}

export function reconcileSelectedHistoryKeys(selectedKeys, visibleEntries) {
  const visibleKeys = new Set(visibleEntries.map((entry) => buildHistoryEntryKey(entry)));
  return new Set([...selectedKeys].filter((key) => visibleKeys.has(key)));
}

export function isHistorySelectionToggleAllowed(entries, selectedKeys, entry, checked) {
  const entryIndex = findEntryIndex(entries, entry);
  if (entryIndex === -1) {
    return false;
  }

  if (checked) {
    return true;
  }

  const entryKey = buildHistoryEntryKey(entry);
  if (!selectedKeys.has(entryKey)) {
    return true;
  }

  const range = getSelectedHistoryRange(entries, selectedKeys);
  if (!range || !range.isConsecutive || range.count <= 1) {
    return true;
  }

  return entryIndex === range.startIndex || entryIndex === range.endIndex;
}

export function toggleSelectedHistoryKeys(entries, selectedKeys, entry, checked) {
  const entryKey = buildHistoryEntryKey(entry);
  const entryIndex = findEntryIndex(entries, entry);
  if (entryIndex === -1) {
    return new Set(selectedKeys);
  }

  if (!checked) {
    if (!selectedKeys.has(entryKey) || !isHistorySelectionToggleAllowed(entries, selectedKeys, entry, checked)) {
      return new Set(selectedKeys);
    }

    const next = new Set(selectedKeys);
    next.delete(entryKey);
    return next;
  }

  if (selectedKeys.has(entryKey)) {
    return new Set(selectedKeys);
  }

  const range = getSelectedHistoryRange(entries, selectedKeys);
  if (!range || !range.isConsecutive) {
    return new Set([entryKey]);
  }

  if (entryIndex === range.startIndex - 1 || entryIndex === range.endIndex + 1) {
    const next = new Set(selectedKeys);
    next.add(entryKey);
    return next;
  }

  return new Set([entryKey]);
}

export function buildBatchHistoryMineRequest(entries, selectedKeys) {
  return {
    entries: entries.filter((entry) => selectedKeys.has(buildHistoryEntryKey(entry))),
  };
}

function findEntryIndex(entries, entry) {
  const entryKey = buildHistoryEntryKey(entry);
  return entries.findIndex((candidate) => buildHistoryEntryKey(candidate) === entryKey);
}

function getSelectedHistoryRange(entries, selectedKeys) {
  const selectedIndexes = entries
    .map((entry, index) => (selectedKeys.has(buildHistoryEntryKey(entry)) ? index : -1))
    .filter((index) => index >= 0);
  if (selectedIndexes.length === 0) {
    return null;
  }

  const startIndex = selectedIndexes[0];
  const endIndex = selectedIndexes[selectedIndexes.length - 1];
  const isConsecutive = selectedIndexes.every((index, position) => {
    if (position === 0) {
      return true;
    }

    return index === selectedIndexes[position - 1] + 1;
  });

  return {
    startIndex,
    endIndex,
    count: selectedIndexes.length,
    isConsecutive,
  };
}
