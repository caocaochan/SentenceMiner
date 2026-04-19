import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, resolveAppRoot, resolveConfigPath } from '../src/config.ts';

test('resolveAppRoot falls back to the current working directory in development', (t) => {
  const originalRoot = process.env.SENTENCEMINER_ROOT;
  delete process.env.SENTENCEMINER_ROOT;
  t.after(() => {
    if (originalRoot === undefined) {
      delete process.env.SENTENCEMINER_ROOT;
      return;
    }

    process.env.SENTENCEMINER_ROOT = originalRoot;
  });

  const root = resolveAppRoot('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\CaoCao\\Downloads\\SentenceMiner');
  assert.equal(root, 'C:\\Users\\CaoCao\\Downloads\\SentenceMiner');
});

test('resolveAppRoot uses the executable directory for packaged helpers', (t) => {
  const originalRoot = process.env.SENTENCEMINER_ROOT;
  delete process.env.SENTENCEMINER_ROOT;
  t.after(() => {
    if (originalRoot === undefined) {
      delete process.env.SENTENCEMINER_ROOT;
      return;
    }

    process.env.SENTENCEMINER_ROOT = originalRoot;
  });

  const root = resolveAppRoot('C:\\mpv\\scripts\\sentenceminer-helper\\SentenceMinerHelper.exe', 'C:\\Videos');
  assert.equal(root, 'C:\\mpv\\scripts\\sentenceminer-helper');
});

test('resolveConfigPath defaults next to the packaged helper', (t) => {
  const originalConfig = process.env.SENTENCEMINER_CONFIG;
  delete process.env.SENTENCEMINER_CONFIG;
  t.after(() => {
    if (originalConfig === undefined) {
      delete process.env.SENTENCEMINER_CONFIG;
      return;
    }

    process.env.SENTENCEMINER_CONFIG = originalConfig;
  });

  const configPath = resolveConfigPath([], 'C:\\mpv\\scripts\\sentenceminer-helper');
  assert.equal(configPath, 'C:\\mpv\\script-opts\\sentenceminer.conf');
});

test('loadConfig reads helper settings from sentenceminer.conf and ignores mpv-only keys', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentenceminer-config-'));
  const configPath = path.join(tempRoot, 'sentenceminer.conf');
  const originalConfig = process.env.SENTENCEMINER_CONFIG;

  t.after(async () => {
    if (originalConfig === undefined) {
      delete process.env.SENTENCEMINER_CONFIG;
    } else {
      process.env.SENTENCEMINER_CONFIG = originalConfig;
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.writeFile(
    configPath,
    [
      'helper_url=http://127.0.0.1:9999',
      'server_port=9001',
      'anki_deck=Mining',
      'anki_field_subtitle=Expression',
      'capture_audio_pre_padding_ms=400',
      'capture_image_include_subtitles=no',
      'transcript_history_limit=40',
    ].join('\n'),
    'utf8',
  );

  process.env.SENTENCEMINER_CONFIG = configPath;

  const config = await loadConfig([]);

  assert.equal(config.server.port, 9001);
  assert.equal(config.anki.deck, 'Mining');
  assert.equal(config.anki.fields.subtitle, 'Expression');
  assert.equal(config.capture.audioPrePaddingMs, 400);
  assert.equal(config.capture.imageIncludeSubtitles, false);
  assert.equal(config.transcript.historyLimit, 40);
  assert.equal(config.server.host, '127.0.0.1');
});
