import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  getEditableSettings,
  loadConfig,
  mergeEditableSettingsIntoConfig,
  resolveAppRoot,
  resolveBundledFfmpegPath,
  resolveConfigPath,
  resolveFfmpegPath,
  saveEditableSettings,
} from '../src/config.ts';

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

test('resolveBundledFfmpegPath finds ffmpeg.exe next to the packaged helper', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentenceminer-ffmpeg-'));
  const helperRoot = path.join(tempRoot, 'scripts', 'sentenceminer-helper');
  const ffmpegPath = path.join(helperRoot, 'ffmpeg.exe');

  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.mkdir(helperRoot, { recursive: true });
  await fs.writeFile(ffmpegPath, '');

  assert.equal(resolveBundledFfmpegPath(helperRoot), ffmpegPath);
});

test('resolveFfmpegPath prefers the bundled ffmpeg for packaged helpers', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentenceminer-ffmpeg-path-'));
  const helperRoot = path.join(tempRoot, 'scripts', 'sentenceminer-helper');
  const ffmpegPath = path.join(helperRoot, 'ffmpeg.exe');

  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.mkdir(helperRoot, { recursive: true });
  await fs.writeFile(ffmpegPath, '');

  assert.equal(resolveFfmpegPath('ffmpeg', { appRoot: helperRoot }), ffmpegPath);
  assert.equal(resolveFfmpegPath('ffmpeg.exe', { appRoot: helperRoot }), ffmpegPath);
});

test('resolveFfmpegPath resolves config-relative ffmpeg paths', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentenceminer-ffmpeg-config-'));
  const configRoot = path.join(tempRoot, 'script-opts');
  const helperRoot = path.join(tempRoot, 'scripts', 'sentenceminer-helper');
  const configPath = path.join(configRoot, 'sentenceminer.conf');
  const ffmpegPath = path.join(helperRoot, 'ffmpeg.exe');

  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.mkdir(configRoot, { recursive: true });
  await fs.mkdir(helperRoot, { recursive: true });
  await fs.writeFile(configPath, '');
  await fs.writeFile(ffmpegPath, '');

  assert.equal(
    resolveFfmpegPath('../scripts/sentenceminer-helper/ffmpeg.exe', {
      appRoot: helperRoot,
      configPath,
    }),
    ffmpegPath,
  );
});

test('loadConfig reads helper and runtime settings from sentenceminer.conf', async (t) => {
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
      'enabled=no',
      'server_port=9001',
      'anki_deck=Mining',
      'anki_field_subtitle=Expression',
      'ffmpeg_path=C:\\Tools\\ffmpeg.exe',
      'temp_dir=C:\\Temp\\SentenceMiner',
      'capture_audio=no',
      'capture_image=yes',
      'capture_audio_pre_padding_ms=400',
      'capture_image_include_subtitles=no',
      'subtitle_card_font_family=Atkinson Hyperlegible, sans-serif',
      'subtitle_card_font_size_px=22',
      'overlay_enabled=yes',
      'overlay_exe_path=sentenceminer-overlay/SentenceMinerOverlay.exe',
      'overlay_yomitan_extension_path=C:\\Tools\\Yomitan',
      'overlay_hide_mpv_subtitles=no',
      'overlay_font_family=Yu Gothic UI',
      'overlay_font_size_px=48',
      'overlay_bottom_offset_pct=18',
      'overlay_max_width_pct=80',
    ].join('\n'),
    'utf8',
  );

  process.env.SENTENCEMINER_CONFIG = configPath;

  const config = await loadConfig([]);

  assert.equal(config.runtime.enabled, false);
  assert.equal(config.server.port, 9001);
  assert.equal(config.anki.deck, 'Mining');
  assert.equal(config.anki.fields.subtitle, 'Expression');
  assert.equal(config.runtime.ffmpegPath, 'C:\\Tools\\ffmpeg.exe');
  assert.equal(config.runtime.tempDir, 'C:\\Temp\\SentenceMiner');
  assert.equal(config.runtime.captureAudio, false);
  assert.equal(config.runtime.captureImage, true);
  assert.equal(config.capture.audioPrePaddingMs, 400);
  assert.equal(config.capture.imageIncludeSubtitles, false);
  assert.equal(config.appearance.subtitleCardFontFamily, 'Atkinson Hyperlegible, sans-serif');
  assert.equal(config.appearance.subtitleCardFontSizePx, 22);
  assert.equal(config.overlay.enabled, true);
  assert.equal(config.overlay.exePath, 'sentenceminer-overlay/SentenceMinerOverlay.exe');
  assert.equal(config.overlay.yomitanExtensionPath, 'C:\\Tools\\Yomitan');
  assert.equal(config.overlay.hideMpvSubtitles, false);
  assert.equal(config.overlay.fontFamily, 'Yu Gothic UI');
  assert.equal(config.overlay.fontSizePx, 48);
  assert.equal(config.overlay.bottomOffsetPct, 18);
  assert.equal(config.overlay.maxWidthPct, 80);
  assert.equal(config.server.host, '127.0.0.1');
});

test('mergeEditableSettingsIntoConfig preserves unrelated lines and updates managed keys', () => {
  const merged = mergeEditableSettingsIntoConfig(
    [
      '# mpv script options',
      'helper_url=http://127.0.0.1:8766',
      'anki_deck=Anime',
      'anki_note_type=Sentence',
      '; keep me',
      'capture_audio=yes',
      'overlay_font_size_px=42',
      'overlay_bottom_offset_pct=14',
    ].join('\n'),
    {
      ...getEditableSettings(DEFAULT_CONFIG),
      anki: {
        ...getEditableSettings(DEFAULT_CONFIG).anki,
        deck: 'Mining',
        noteType: 'Target',
      },
      runtime: {
        captureAudio: false,
        captureImage: true,
      },
      overlay: {
        ...getEditableSettings(DEFAULT_CONFIG).overlay,
        fontSizePx: 52,
        bottomOffsetPct: 22,
      },
    },
  );

  assert.match(merged, /helper_url=http:\/\/127\.0\.0\.1:8766/);
  assert.match(merged, /anki_deck=Mining/);
  assert.match(merged, /anki_note_type=Target/);
  assert.match(merged, /; keep me/);
  assert.match(merged, /capture_audio=no/);
  assert.match(merged, /overlay_font_size_px=52/);
  assert.match(merged, /overlay_bottom_offset_pct=22/);
});

test('mergeEditableSettingsIntoConfig appends missing managed keys using stable config formats', () => {
  const merged = mergeEditableSettingsIntoConfig(
    'helper_url=http://127.0.0.1:8766',
    getEditableSettings(DEFAULT_CONFIG),
  );

  assert.match(merged, /anki_deck=Anime/);
  assert.match(merged, /capture_audio=yes/);
  assert.match(merged, /capture_image=yes/);
  assert.match(merged, /capture_image_include_subtitles=yes/);
  assert.match(merged, /subtitle_card_font_family=/);
  assert.match(merged, /subtitle_card_font_size_px=0/);
  assert.match(merged, /overlay_font_family=/);
  assert.match(merged, /overlay_font_size_px=42/);
  assert.match(merged, /overlay_bottom_offset_pct=14/);
  assert.match(merged, /capture_image_max_width=1600/);
});

test('saveEditableSettings writes updated settings to sentenceminer.conf', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentenceminer-save-config-'));
  const configPath = path.join(tempRoot, 'sentenceminer.conf');

  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.writeFile(
    configPath,
    ['helper_url=http://127.0.0.1:8766', 'anki_deck=Anime', 'capture_audio=yes'].join('\n'),
    'utf8',
  );

  const settings = getEditableSettings(DEFAULT_CONFIG);
  settings.anki.deck = 'Refreshed Deck';
  settings.runtime.captureAudio = false;
  settings.capture.imageIncludeSubtitles = false;
  settings.appearance.subtitleCardFontFamily = 'Noto Sans';
  settings.appearance.subtitleCardFontSizePx = 18;
  settings.overlay.fontFamily = 'Yu Gothic UI';
  settings.overlay.fontSizePx = 50;
  settings.overlay.bottomOffsetPct = 20;

  await saveEditableSettings(configPath, settings);

  const written = await fs.readFile(configPath, 'utf8');
  assert.match(written, /anki_deck=Refreshed Deck/);
  assert.match(written, /capture_audio=no/);
  assert.match(written, /capture_image_include_subtitles=no/);
  assert.match(written, /subtitle_card_font_family=Noto Sans/);
  assert.match(written, /subtitle_card_font_size_px=18/);
  assert.match(written, /overlay_font_family=Yu Gothic UI/);
  assert.match(written, /overlay_font_size_px=50/);
  assert.match(written, /overlay_bottom_offset_pct=20/);
});
