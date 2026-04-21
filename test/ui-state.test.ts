import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTranscriptEmptyState,
  resolveThemePreference,
  shouldRefreshSettingsOptions,
  shouldUseFallbackStatePolling,
} from '../web/ui-state.js';

test('resolveThemePreference prefers explicit saved theme over OS preference', () => {
  assert.equal(resolveThemePreference('light', true), 'light');
  assert.equal(resolveThemePreference('dark', false), 'dark');
});

test('resolveThemePreference falls back to OS preference when no saved theme exists', () => {
  assert.equal(resolveThemePreference(null, true), 'dark');
  assert.equal(resolveThemePreference(undefined, false), 'light');
});

test('state polling is only a fallback when the websocket is not live', () => {
  assert.equal(shouldUseFallbackStatePolling('live'), false);
  assert.equal(shouldUseFallbackStatePolling('connecting'), true);
  assert.equal(shouldUseFallbackStatePolling('offline'), true);
});

test('settings options are refreshed lazily when the settings modal is open', () => {
  assert.equal(shouldRefreshSettingsOptions(false, false), false);
  assert.equal(shouldRefreshSettingsOptions(true, true), false);
  assert.equal(shouldRefreshSettingsOptions(true, false), true);
});

test('buildTranscriptEmptyState reflects loading transcript status', () => {
  assert.deepEqual(
    buildTranscriptEmptyState({
      transcriptStatus: 'loading',
      transcriptMessage: '',
    }),
    {
      title: 'Loading transcript',
      message: 'Loading active subtitle track...',
    },
  );
});

test('buildTranscriptEmptyState reflects unavailable transcript status message', () => {
  assert.deepEqual(
    buildTranscriptEmptyState({
      transcriptStatus: 'unavailable',
      transcriptMessage: 'Choose a subtitle track in mpv.',
    }),
    {
      title: 'No transcript available',
      message: 'Choose a subtitle track in mpv.',
    },
  );
});
