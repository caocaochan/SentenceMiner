export function resolveThemePreference(storedTheme, prefersDark = false) {
  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme;
  }

  return prefersDark ? 'dark' : 'light';
}

export function shouldUseFallbackStatePolling(connection) {
  return connection !== 'live';
}

export function shouldRefreshSettingsOptions(settingsModalOpen, settingsOptionsLoading) {
  return Boolean(settingsModalOpen && !settingsOptionsLoading);
}

export function buildTranscriptStatusLabel(transcriptState) {
  const status = transcriptState?.transcriptStatus ?? 'unavailable';
  const message = transcriptState?.transcriptMessage?.trim() ?? '';

  if (status === 'ready') {
    return message;
  }

  if (status === 'loading') {
    return message || 'Loading active subtitle track...';
  }

  if (status === 'error') {
    return message || 'The active subtitle track could not be loaded.';
  }

  return message || 'No active subtitle track is selected.';
}

export function buildTranscriptEmptyState(transcriptState) {
  const status = transcriptState?.transcriptStatus ?? 'unavailable';
  const message = buildTranscriptStatusLabel(transcriptState);

  if (status === 'loading') {
    return {
      title: 'Loading transcript',
      message,
    };
  }

  if (status === 'error') {
    return {
      title: 'Transcript unavailable',
      message,
    };
  }

  if (status === 'ready') {
    return {
      title: 'No subtitle lines yet',
      message: message || 'Subtitle lines will appear here as SentenceMiner follows playback.',
    };
  }

  return {
    title: 'No transcript available',
    message,
  };
}
