import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTranscriptEmptyState, resolveThemePreference } from '../web/ui-state.js';

test('resolveThemePreference prefers explicit saved theme over OS preference', () => {
  assert.equal(resolveThemePreference('light', true), 'light');
  assert.equal(resolveThemePreference('dark', false), 'dark');
});

test('resolveThemePreference falls back to OS preference when no saved theme exists', () => {
  assert.equal(resolveThemePreference(null, true), 'dark');
  assert.equal(resolveThemePreference(undefined, false), 'light');
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
