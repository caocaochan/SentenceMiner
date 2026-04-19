export function buildHistoryEntryKey(entry) {
  return [entry.sessionId, entry.filePath, entry.startMs ?? 'nil', entry.endMs ?? 'nil', entry.text].join('::');
}

export function reconcileSelectedHistoryKeys(selectedKeys, visibleEntries) {
  const visibleKeys = new Set(visibleEntries.map((entry) => buildHistoryEntryKey(entry)));
  return new Set([...selectedKeys].filter((key) => visibleKeys.has(key)));
}

export function buildBatchHistoryMineRequest(entries, selectedKeys) {
  return {
    entries: entries.filter((entry) => selectedKeys.has(buildHistoryEntryKey(entry))),
  };
}
