import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG, getEditableSettings } from '../src/config.ts';
import { PlayerCommandStore } from '../src/player-command-store.ts';
import { createRequestHandler, listenForAppServer, probeRunningHelper } from '../src/server.ts';
import { TranscriptStore } from '../src/transcript-store.ts';
import { WebSocketHub } from '../src/ws.ts';

test('GET /api/state exposes editable settings', async (t) => {
  const harness = await createServerHarness(t);

  const response = await fetch(`${harness.baseUrl}/api/state`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.config.settings.anki.deck, 'Anime');
  assert.equal(payload.config.settings.anki.noteType, 'Sentence');
  assert.equal(payload.config.settings.capture.imageMaxWidth, 1600);
  assert.equal(payload.config.settings.runtime.captureAudio, true);
  assert.equal(payload.config.settings.appearance.subtitleCardFontFamily, '');
  assert.equal(payload.config.settings.appearance.subtitleCardFontSizePx, 0);
  assert.equal(payload.config.settings.overlay.fontFamily, '');
  assert.equal(payload.config.settings.overlay.fontSizePx, 42);
  assert.equal(payload.config.settings.overlay.bottomOffsetPct, 14);
  assert.equal(payload.config.overlay.enabled, false);
  assert.equal(payload.config.overlay.hideMpvSubtitles, true);
  assert.equal(payload.config.overlay.fontSizePx, 42);
});

test('GET overlay assets serves the browser overlay page and scripts', async (t) => {
  const harness = await createServerHarness(t);

  const html = await fetch(`${harness.baseUrl}/overlay.html`);
  const js = await fetch(`${harness.baseUrl}/overlay.js`);
  const stateJs = await fetch(`${harness.baseUrl}/overlay-state.js`);
  const css = await fetch(`${harness.baseUrl}/overlay.css`);

  assert.equal(html.status, 200);
  assert.match(await html.text(), /SentenceMiner Overlay/);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /text\/javascript/);
  assert.equal(stateJs.status, 200);
  assert.match(await stateJs.text(), /buildOverlaySubtitleView/);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /text\/css/);
});

test('GET /api/settings/options returns live Anki deck and note type options', async (t) => {
  const harness = await createServerHarness(t);

  const response = await fetch(`${harness.baseUrl}/api/settings/options?noteType=Sentence`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.options.decks, ['Anime', 'Mining']);
  assert.deepEqual(payload.options.noteTypes, ['Sentence', 'Vocab']);
  assert.deepEqual(payload.options.noteFields, ['Sentence', 'Audio', 'Picture', 'Source', 'Time', 'Filename']);
  assert.deepEqual(payload.options.fonts, ['Arial', 'Noto Sans JP']);
  assert.equal(payload.options.selectedDeck, 'Anime');
  assert.equal(payload.options.selectedNoteType, 'Sentence');
});

test('GET /api/settings/options falls back to live Anki defaults when configured values are missing', async (t) => {
  const harness = await createServerHarness(t);
  harness.config.anki.deck = 'Missing Deck';
  harness.config.anki.noteType = 'Missing Note Type';

  const response = await fetch(`${harness.baseUrl}/api/settings/options`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.options.decks, ['Anime', 'Mining']);
  assert.deepEqual(payload.options.noteTypes, ['Sentence', 'Vocab']);
  assert.deepEqual(payload.options.noteFields, ['Sentence', 'Audio', 'Picture', 'Source', 'Time', 'Filename']);
  assert.deepEqual(payload.options.fonts, ['Arial', 'Noto Sans JP']);
  assert.equal(payload.options.selectedDeck, 'Anime');
  assert.equal(payload.options.selectedNoteType, 'Sentence');
});

test('POST /api/settings persists settings and updates in-memory config', async (t) => {
  const harness = await createServerHarness(t);
  const payload = getEditableSettings(harness.config);
  payload.anki.deck = 'Mining';
  payload.anki.noteType = 'Vocab';
  payload.anki.fields.subtitle = 'Expression';
  payload.anki.fields.audio = 'Audio';
  payload.anki.fields.image = '';
  payload.anki.fields.source = '';
  payload.anki.fields.time = '';
  payload.anki.fields.filename = '';
  payload.runtime.captureAudio = false;
  payload.appearance.subtitleCardFontFamily = 'Noto Sans JP';
  payload.appearance.subtitleCardFontSizePx = 20;
  payload.overlay.fontFamily = 'Yu Gothic UI';
  payload.overlay.fontSizePx = 54;
  payload.overlay.bottomOffsetPct = 21;

  const response = await fetch(`${harness.baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.config.settings.anki.deck, 'Mining');
  assert.equal(harness.config.anki.deck, 'Mining');
  assert.equal(harness.config.anki.noteType, 'Vocab');
  assert.equal(harness.config.runtime.captureAudio, false);
  assert.equal(harness.config.appearance.subtitleCardFontFamily, 'Noto Sans JP');
  assert.equal(harness.config.appearance.subtitleCardFontSizePx, 20);
  assert.equal(harness.config.overlay.fontFamily, 'Yu Gothic UI');
  assert.equal(harness.config.overlay.fontSizePx, 54);
  assert.equal(harness.config.overlay.bottomOffsetPct, 21);

  const configFile = await fs.readFile(harness.configPath, 'utf8');
  assert.match(configFile, /anki_deck=Mining/);
  assert.match(configFile, /anki_note_type=Vocab/);
  assert.match(configFile, /capture_audio=no/);
  assert.match(configFile, /subtitle_card_font_family=Noto Sans JP/);
  assert.match(configFile, /subtitle_card_font_size_px=20/);
  assert.match(configFile, /overlay_font_family=Yu Gothic UI/);
  assert.match(configFile, /overlay_font_size_px=54/);
  assert.match(configFile, /overlay_bottom_offset_pct=21/);
});

test('POST /api/settings rejects invalid note field mappings with a 400', async (t) => {
  const harness = await createServerHarness(t);
  const payload = getEditableSettings(harness.config);
  payload.anki.fields.subtitle = 'MissingField';

  const response = await fetch(`${harness.baseUrl}/api/settings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.match(body.message, /does not exist on Anki note type/);
});

test('POST /api/session reloads config from disk before a new playback session starts', async (t) => {
  const harness = await createServerHarness(t);
  harness.config.anki.deck = 'Anime';

  await fs.writeFile(
    harness.configPath,
    ['anki_deck=Mining', 'anki_note_type=Sentence', 'capture_audio=no'].join('\n'),
    'utf8',
  );

  const response = await fetch(`${harness.baseUrl}/api/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      action: 'start',
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      durationMs: 60000,
      playbackTimeMs: 0,
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(harness.config.anki.deck, 'Mining');
  assert.equal(harness.config.runtime.captureAudio, false);
});

test('POST /api/subtitle-track reloads the active transcript for the current session', async (t) => {
  const harness = await createServerHarness(t);
  await fetch(`${harness.baseUrl}/api/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      action: 'start',
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      durationMs: 60000,
      playbackTimeMs: 0,
    }),
  });

  const response = await fetch(`${harness.baseUrl}/api/subtitle-track`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      kind: 'external',
      externalFilePath: 'C:\\Videos\\episode.srt',
      trackId: 1,
      ffIndex: null,
      codec: 'subrip',
      title: 'English',
      lang: 'en',
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.state.transcriptStatus, 'error');
});

test('POST /api/runtime/shutdown requests helper shutdown', async (t) => {
  const harness = await createServerHarness(t);

  const response = await fetch(`${harness.baseUrl}/api/runtime/shutdown`, {
    method: 'POST',
  });
  const payload = await response.json();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.deepEqual(harness.shutdownReasons, ['runtime shutdown request']);
});

test('POST /api/overlay/yomitan-settings accepts settings open requests', async (t) => {
  const harness = await createServerHarness(t);

  const response = await fetch(`${harness.baseUrl}/api/overlay/yomitan-settings`, {
    method: 'POST',
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.match(payload.message, /Yomitan settings/);
});

test('POST /api/history/mine accepts batch selections and updates Anki once', async (t) => {
  const harness = await createServerHarness(t);
  harness.config.runtime.captureAudio = false;
  harness.config.runtime.captureImage = false;
  harness.ankiNotes[0].fields.Sentence.value = 'earlier later';
  harness.transcriptStore.startSession({ action: 'start', sessionId: 'session-1', filePath: 'C:\\Videos\\episode.mkv' });
  seedTranscriptHistory(harness.transcriptStore, [
    {
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'earlier',
      startMs: 1000,
      endMs: 1400,
      playbackTimeMs: 1200,
    },
    {
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'later',
      startMs: 2000,
      endMs: 2400,
      playbackTimeMs: 2200,
    },
  ]);

  const response = await fetch(`${harness.baseUrl}/api/history/mine`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      entries: [
        {
          sessionId: 'session-1',
          filePath: 'C:\\Videos\\episode.mkv',
          text: 'later',
          startMs: 2000,
          endMs: 2400,
          playbackTimeMs: 2200,
        },
        {
          sessionId: 'session-1',
          filePath: 'C:\\Videos\\episode.mkv',
          text: 'earlier',
          startMs: 1000,
          endMs: 1400,
          playbackTimeMs: 1200,
        },
      ],
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.message, 'Anki note updated successfully.');

  const updateRequest = harness.ankiRequests.find((request) => request.action === 'updateNoteFields');
  assert.ok(updateRequest);
  assert.equal(updateRequest?.params.note.fields.Sentence, 'earlier later');
  assert.equal(updateRequest?.params.note.fields.Time, '00:01.000 - 00:02.400');
});

test('POST /api/history/mine updates the sentence to the combined batch text when one selected subtitle line matches', async (t) => {
  const harness = await createServerHarness(t);
  harness.config.runtime.captureAudio = false;
  harness.config.runtime.captureImage = false;
  harness.ankiNotes[0].fields.Sentence.value = 'earlier';
  harness.transcriptStore.startSession({ action: 'start', sessionId: 'session-1', filePath: 'C:\\Videos\\episode.mkv' });
  seedTranscriptHistory(harness.transcriptStore, [
    {
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'earlier',
      startMs: 1000,
      endMs: 1400,
      playbackTimeMs: 1200,
    },
    {
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'later',
      startMs: 2000,
      endMs: 2400,
      playbackTimeMs: 2200,
    },
  ]);

  const response = await fetch(`${harness.baseUrl}/api/history/mine`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      entries: [
        {
          sessionId: 'session-1',
          filePath: 'C:\\Videos\\episode.mkv',
          text: 'later',
          startMs: 2000,
          endMs: 2400,
          playbackTimeMs: 2200,
        },
        {
          sessionId: 'session-1',
          filePath: 'C:\\Videos\\episode.mkv',
          text: 'earlier',
          startMs: 1000,
          endMs: 1400,
          playbackTimeMs: 1200,
        },
      ],
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.message, 'Anki note updated successfully.');

  const updateRequest = harness.ankiRequests.find((request) => request.action === 'updateNoteFields');
  assert.ok(updateRequest);
  assert.equal(updateRequest?.params.note.fields.Sentence, 'earlier later');
  assert.equal(updateRequest?.params.note.fields.Time, '00:01.000 - 00:02.400');
});

test('POST /api/history/mine returns 404 when no selected subtitle sentence matches', async (t) => {
  const harness = await createServerHarness(t);
  harness.config.runtime.captureAudio = false;
  harness.config.runtime.captureImage = false;
  harness.ankiNotes[0].fields.Sentence.value = 'something else';
  harness.transcriptStore.startSession({ action: 'start', sessionId: 'session-1', filePath: 'C:\\Videos\\episode.mkv' });
  seedTranscriptHistory(harness.transcriptStore, [
    {
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'earlier',
      startMs: 1000,
      endMs: 1400,
      playbackTimeMs: 1200,
    },
    {
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'later',
      startMs: 2000,
      endMs: 2400,
      playbackTimeMs: 2200,
    },
  ]);

  const response = await fetch(`${harness.baseUrl}/api/history/mine`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      entries: [
        {
          sessionId: 'session-1',
          filePath: 'C:\\Videos\\episode.mkv',
          text: 'later',
          startMs: 2000,
          endMs: 2400,
          playbackTimeMs: 2200,
        },
        {
          sessionId: 'session-1',
          filePath: 'C:\\Videos\\episode.mkv',
          text: 'earlier',
          startMs: 1000,
          endMs: 1400,
          playbackTimeMs: 1200,
        },
      ],
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.equal(payload.success, false);
  assert.equal(payload.message, 'No matching card exists.');

  const addRequest = harness.ankiRequests.find((request) => request.action === 'addNote');
  assert.equal(addRequest, undefined);
});

test('POST /api/history/mine only checks the newest note and rejects older matching duplicates', async (t) => {
  const harness = await createServerHarness(t);
  harness.config.runtime.captureAudio = false;
  harness.config.runtime.captureImage = false;
  harness.ankiNotes[0].fields.Sentence.value = 'earlier later';
  harness.ankiNotes.push(createAnkiNote(30, 'something else'));
  harness.transcriptStore.startSession({ action: 'start', sessionId: 'session-1', filePath: 'C:\\Videos\\episode.mkv' });
  seedTranscriptHistory(harness.transcriptStore, [
    {
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'earlier',
      startMs: 1000,
      endMs: 1400,
      playbackTimeMs: 1200,
    },
    {
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'later',
      startMs: 2000,
      endMs: 2400,
      playbackTimeMs: 2200,
    },
  ]);

  const response = await fetch(`${harness.baseUrl}/api/history/mine`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      entries: [
        {
          sessionId: 'session-1',
          filePath: 'C:\\Videos\\episode.mkv',
          text: 'later',
          startMs: 2000,
          endMs: 2400,
          playbackTimeMs: 2200,
        },
        {
          sessionId: 'session-1',
          filePath: 'C:\\Videos\\episode.mkv',
          text: 'earlier',
          startMs: 1000,
          endMs: 1400,
          playbackTimeMs: 1200,
        },
      ],
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.equal(payload.success, false);
  assert.equal(payload.message, 'No matching card exists.');

  const updateRequest = harness.ankiRequests.find((request) => request.action === 'updateNoteFields');
  assert.equal(updateRequest, undefined);
});

test('POST /api/mine returns 404 when no card matches the subtitle sentence', async (t) => {
  const harness = await createServerHarness(t);
  harness.config.runtime.captureAudio = false;
  harness.config.runtime.captureImage = false;
  harness.ankiNotes[0].fields.Sentence.value = 'something else';
  harness.transcriptStore.startSession({ action: 'start', sessionId: 'session-1', filePath: 'C:\\Videos\\episode.mkv' });

  const response = await fetch(`${harness.baseUrl}/api/mine`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'single line',
      startMs: 1000,
      endMs: 1200,
      playbackTimeMs: 1100,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.equal(payload.success, false);
  assert.equal(payload.message, 'No matching card exists.');

  const addRequest = harness.ankiRequests.find((request) => request.action === 'addNote');
  assert.equal(addRequest, undefined);
});

test('POST /api/history/mine still accepts single-entry payloads', async (t) => {
  const harness = await createServerHarness(t);
  harness.config.runtime.captureAudio = false;
  harness.config.runtime.captureImage = false;
  harness.ankiNotes[0].fields.Sentence.value = 'single line';
  harness.transcriptStore.startSession({ action: 'start', sessionId: 'session-1', filePath: 'C:\\Videos\\episode.mkv' });

  const response = await fetch(`${harness.baseUrl}/api/history/mine`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'single line',
      startMs: 1000,
      endMs: 1200,
      playbackTimeMs: 1100,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
});

test('POST /api/history/mine rejects empty batch payloads', async (t) => {
  const harness = await createServerHarness(t);
  harness.transcriptStore.startSession({ action: 'start', sessionId: 'session-1', filePath: 'C:\\Videos\\episode.mkv' });

  const response = await fetch(`${harness.baseUrl}/api/history/mine`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      entries: [],
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.success, false);
  assert.match(payload.message, /Select at least one subtitle line/);
});

test('POST /api/history/mine rejects non-consecutive batch payloads', async (t) => {
  const harness = await createServerHarness(t);
  harness.config.runtime.captureAudio = false;
  harness.config.runtime.captureImage = false;
  harness.transcriptStore.startSession({ action: 'start', sessionId: 'session-1', filePath: 'C:\\Videos\\episode.mkv' });
  seedTranscriptHistory(harness.transcriptStore, [
    {
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'first',
      startMs: 1000,
      endMs: 1400,
      playbackTimeMs: 1200,
    },
    {
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'second',
      startMs: 2000,
      endMs: 2400,
      playbackTimeMs: 2200,
    },
    {
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'third',
      startMs: 3000,
      endMs: 3400,
      playbackTimeMs: 3200,
    },
  ]);

  const response = await fetch(`${harness.baseUrl}/api/history/mine`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      entries: [
        {
          sessionId: 'session-1',
          filePath: 'C:\\Videos\\episode.mkv',
          text: 'first',
          startMs: 1000,
          endMs: 1400,
          playbackTimeMs: 1200,
        },
        {
          sessionId: 'session-1',
          filePath: 'C:\\Videos\\episode.mkv',
          text: 'third',
          startMs: 3000,
          endMs: 3400,
          playbackTimeMs: 3200,
        },
      ],
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.success, false);
  assert.match(payload.message, /must be consecutive/);
});

test('POST /api/mine returns 400 when the configured deck does not exist in Anki', async (t) => {
  const harness = await createServerHarness(t);
  harness.config.runtime.captureAudio = false;
  harness.config.runtime.captureImage = false;
  harness.config.anki.deck = 'Missing Deck';
  harness.transcriptStore.startSession({ action: 'start', sessionId: 'session-1', filePath: 'C:\\Videos\\episode.mkv' });

  const response = await fetch(`${harness.baseUrl}/api/mine`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'single line',
      startMs: 1000,
      endMs: 1200,
      playbackTimeMs: 1100,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.success, false);
  assert.equal(payload.message, 'Configured deck "Missing Deck" does not exist in Anki.');

  const findNotesRequest = harness.ankiRequests.find((request) => request.action === 'findNotes');
  assert.equal(findNotesRequest, undefined);
});

test('POST /api/history/mine returns 400 when a configured field does not exist on the note type', async (t) => {
  const harness = await createServerHarness(t);
  harness.config.runtime.captureAudio = false;
  harness.config.runtime.captureImage = false;
  harness.config.anki.fields.image = 'MissingField';
  harness.ankiNotes[0].fields.Sentence.value = 'single line';
  harness.transcriptStore.startSession({ action: 'start', sessionId: 'session-1', filePath: 'C:\\Videos\\episode.mkv' });

  const response = await fetch(`${harness.baseUrl}/api/history/mine`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: 'session-1',
      filePath: 'C:\\Videos\\episode.mkv',
      text: 'single line',
      startMs: 1000,
      endMs: 1200,
      playbackTimeMs: 1100,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.success, false);
  assert.equal(payload.message, 'Configured image field "MissingField" does not exist on Anki note type "Sentence".');

  const findNotesRequest = harness.ankiRequests.find((request) => request.action === 'findNotes');
  assert.equal(findNotesRequest, undefined);
});

test('probeRunningHelper returns true for a live SentenceMiner instance', async (t) => {
  const harness = await createServerHarness(t);
  const address = new URL(harness.baseUrl);

  const running = await probeRunningHelper({
    host: address.hostname,
    port: Number(address.port),
  });

  assert.equal(running, true);
});

test('listenForAppServer treats a healthy existing helper as already running', async (t) => {
  const harness = await createServerHarness(t);
  const address = new URL(harness.baseUrl);
  const duplicateServer = http.createServer((_request, response) => {
    response.writeHead(200);
    response.end('unexpected duplicate listener');
  });

  t.after(() => closeServer(duplicateServer).catch(() => {}));

  const result = await listenForAppServer(duplicateServer, {
    host: address.hostname,
    port: Number(address.port),
  });

  assert.equal(result, 'already-running');
});

test('listenForAppServer still rejects port conflicts from non-SentenceMiner services', async (t) => {
  const busyServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('hello');
  });

  await listen(busyServer);
  const busyAddress = busyServer.address();
  if (!busyAddress || typeof busyAddress === 'string') {
    throw new Error('Expected a TCP address for the busy server.');
  }

  const duplicateServer = http.createServer((_request, response) => {
    response.writeHead(200);
    response.end('unexpected duplicate listener');
  });

  t.after(async () => {
    await Promise.all([closeServer(duplicateServer).catch(() => {}), closeServer(busyServer)]);
  });

  await assert.rejects(
    listenForAppServer(duplicateServer, {
      host: '127.0.0.1',
      port: busyAddress.port,
    }),
    (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE',
  );
});

async function createServerHarness(t: TestContext) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentenceminer-server-test-'));
  const configPath = path.join(tempRoot, 'sentenceminer.conf');
  await fs.writeFile(configPath, 'anki_deck=Anime\nanki_note_type=Sentence\ncapture_audio=yes\n', 'utf8');

  const ankiRequests: Array<Record<string, any>> = [];
  const ankiNotes = [createAnkiNote(25, '')];
  const ankiServer = http.createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const payload = body ? JSON.parse(body) : {};
    ankiRequests.push(payload);
    const action = payload.action;
    let result;

    if (action === 'deckNames') {
      result = ['Anime', 'Mining'];
    } else if (action === 'modelNames') {
      result = ['Sentence', 'Vocab'];
    } else if (action === 'modelFieldNames') {
      result =
        payload.params?.modelName === 'Vocab'
          ? ['Expression', 'Meaning', 'Audio']
          : ['Sentence', 'Audio', 'Picture', 'Source', 'Time', 'Filename'];
    } else if (action === 'findNotes') {
      result = ankiNotes.map((note) => note.noteId);
    } else if (action === 'notesInfo') {
      const requestedIds = Array.isArray(payload.params?.notes)
        ? payload.params.notes.filter((value: unknown) => Number.isInteger(value))
        : ankiNotes.map((note) => note.noteId);
      result = requestedIds
        .map((noteId: number) => ankiNotes.find((note) => note.noteId === noteId))
        .filter(Boolean);
    } else if (action === 'storeMediaFile') {
      result = payload.params?.filename ?? null;
    } else if (action === 'updateNoteFields') {
      const targetNote = ankiNotes.find((note) => note.noteId === payload.params?.note?.id);
      if (targetNote && payload.params?.note?.fields && typeof payload.params.note.fields === 'object') {
        for (const [fieldName, fieldValue] of Object.entries(payload.params.note.fields)) {
          targetNote.fields[fieldName] = {
            value: String(fieldValue ?? ''),
          };
        }
      }
      result = null;
    } else {
      result = null;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result, error: null }));
  });

  await listen(ankiServer);
  const ankiAddress = ankiServer.address();
  if (!ankiAddress || typeof ankiAddress === 'string') {
    throw new Error('Expected a TCP address for the fake Anki server.');
  }

  const config = structuredClone(DEFAULT_CONFIG);
  config.anki.url = `http://127.0.0.1:${ankiAddress.port}`;
  const installedFonts = ['Arial', 'Noto Sans JP'];
  const shutdownReasons: string[] = [];
  const transcriptStore = new TranscriptStore();

  const appServer = http.createServer(
    createRequestHandler({
      config,
      configPath,
      transcriptStore,
      playerCommandStore: new PlayerCommandStore(),
      sockets: new WebSocketHub(),
      listInstalledFonts: async () => installedFonts,
      requestShutdown: (reason) => {
        shutdownReasons.push(reason);
      },
    }),
  );

  await listen(appServer);
  const appAddress = appServer.address();
  if (!appAddress || typeof appAddress === 'string') {
    throw new Error('Expected a TCP address for the app server.');
  }

  t.after(async () => {
    await Promise.all([
      closeServer(appServer),
      closeServer(ankiServer),
      fs.rm(tempRoot, { recursive: true, force: true }),
    ]);
  });

  return {
    ankiRequests,
    ankiNotes,
    baseUrl: `http://127.0.0.1:${appAddress.port}`,
    config,
    configPath,
    shutdownReasons,
    transcriptStore,
  };
}

function createAnkiNote(noteId: number, sentence: string) {
  return {
    noteId,
    fields: {
      Sentence: { value: sentence },
      Audio: { value: '' },
      Picture: { value: '' },
      Source: { value: '' },
      Time: { value: '' },
      Filename: { value: '' },
    },
  };
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function seedTranscriptHistory(transcriptStore: TranscriptStore, entries: Array<{
  sessionId: string;
  filePath: string;
  text: string;
  startMs: number;
  endMs: number;
  playbackTimeMs: number;
}>): void {
  const [first] = entries;
  if (!first) {
    return;
  }

  transcriptStore.setTranscript(
    {
      sessionId: first.sessionId,
      filePath: first.filePath,
      kind: 'external',
      externalFilePath: `${first.filePath}.srt`,
      trackId: 1,
      ffIndex: null,
      codec: 'subrip',
      title: 'English',
      lang: 'en',
    },
    entries.map((entry, index) => ({
      id: `${entry.sessionId}:${index}:${entry.startMs}`,
      orderIndex: index,
      ...entry,
    })),
  );
}
