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
});

test('GET /api/settings/options returns live Anki deck and note type options', async (t) => {
  const harness = await createServerHarness(t);

  const response = await fetch(`${harness.baseUrl}/api/settings/options?noteType=Sentence`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.options.decks, ['Anime', 'Mining']);
  assert.deepEqual(payload.options.noteTypes, ['Sentence', 'Vocab']);
  assert.deepEqual(payload.options.noteFields, ['Sentence', 'Audio', 'Picture', 'Source', 'Time', 'Filename']);
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

  const configFile = await fs.readFile(harness.configPath, 'utf8');
  assert.match(configFile, /anki_deck=Mining/);
  assert.match(configFile, /anki_note_type=Vocab/);
  assert.match(configFile, /capture_audio=no/);
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

  const ankiServer = http.createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const payload = body ? JSON.parse(body) : {};
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
  const shutdownReasons: string[] = [];

  const appServer = http.createServer(
    createRequestHandler({
      config,
      configPath,
      transcriptStore: new TranscriptStore(config.transcript.historyLimit),
      playerCommandStore: new PlayerCommandStore(),
      sockets: new WebSocketHub(),
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
    baseUrl: `http://127.0.0.1:${appAddress.port}`,
    config,
    configPath,
    shutdownReasons,
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
