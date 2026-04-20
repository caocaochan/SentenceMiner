import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig, EditableSettings } from './types.ts';

export const DEFAULT_CONFIG: AppConfig = {
  server: {
    host: '127.0.0.1',
    port: 8766,
  },
  anki: {
    url: 'http://127.0.0.1:8765',
    apiKey: '',
    deck: 'Anime',
    noteType: 'Sentence',
    extraQuery: '',
    fields: {
      subtitle: 'Sentence',
      audio: 'Audio',
      image: 'Picture',
      source: 'Source',
      time: 'Time',
      filename: 'Filename',
    },
    filenameTemplate: '{basename}-{startMs}-{kind}.{ext}',
  },
  capture: {
    audioPrePaddingMs: 250,
    audioPostPaddingMs: 250,
    audioFormat: 'mp3',
    audioCodec: 'libmp3lame',
    audioBitrate: '128k',
    imageFormat: 'jpg',
    imageQuality: 2,
    imageMaxWidth: 1600,
    imageMaxHeight: 900,
    imageIncludeSubtitles: true,
  },
  runtime: {
    enabled: true,
    ffmpegPath: 'ffmpeg',
    tempDir: '',
    captureAudio: true,
    captureImage: true,
  },
  appearance: {
    subtitleCardFontFamily: '',
    subtitleCardFontSizePx: 0,
  },
};

export async function loadConfig(argv: string[] = process.argv.slice(2)): Promise<AppConfig> {
  const appRoot = resolveAppRoot();
  const configPath = resolveConfigPath(argv, appRoot);
  return loadConfigFromPath(configPath, { appRoot });
}

export async function loadConfigFromPath(
  configPath: string,
  options: {
    appRoot?: string;
  } = {},
): Promise<AppConfig> {
  const appRoot = options.appRoot ?? resolveAppRoot();
  const fileConfig = await readOptionalConfig(configPath);
  const config = mergeConfig(DEFAULT_CONFIG, fileConfig ?? {});

  return {
    ...config,
    runtime: {
      ...config.runtime,
      ffmpegPath: resolveFfmpegPath(config.runtime.ffmpegPath, {
        appRoot,
        configPath,
      }),
    },
  };
}

export function getEditableSettings(config: AppConfig): EditableSettings {
  return {
    anki: {
      deck: config.anki.deck,
      noteType: config.anki.noteType,
      extraQuery: config.anki.extraQuery ?? '',
      fields: {
        subtitle: config.anki.fields.subtitle,
        audio: config.anki.fields.audio,
        image: config.anki.fields.image,
        source: config.anki.fields.source ?? '',
        time: config.anki.fields.time ?? '',
        filename: config.anki.fields.filename ?? '',
      },
      filenameTemplate: config.anki.filenameTemplate,
    },
    capture: {
      ...config.capture,
    },
    runtime: {
      captureAudio: config.runtime.captureAudio,
      captureImage: config.runtime.captureImage,
    },
    appearance: {
      subtitleCardFontFamily: config.appearance.subtitleCardFontFamily,
      subtitleCardFontSizePx: config.appearance.subtitleCardFontSizePx,
    },
  };
}

export function applyEditableSettings(config: AppConfig, settings: EditableSettings): AppConfig {
  return mergeConfig(config, {
    anki: {
      ...config.anki,
      deck: settings.anki.deck,
      noteType: settings.anki.noteType,
      extraQuery: settings.anki.extraQuery,
      fields: {
        ...config.anki.fields,
        ...settings.anki.fields,
      },
      filenameTemplate: settings.anki.filenameTemplate,
    },
    capture: {
      ...settings.capture,
    },
    runtime: {
      ...config.runtime,
      captureAudio: settings.runtime.captureAudio,
      captureImage: settings.runtime.captureImage,
    },
    appearance: {
      ...config.appearance,
      subtitleCardFontFamily: settings.appearance.subtitleCardFontFamily,
      subtitleCardFontSizePx: settings.appearance.subtitleCardFontSizePx,
    },
  });
}

export async function saveEditableSettings(filePath: string, settings: EditableSettings): Promise<void> {
  const existingContent = await readConfigText(filePath);
  const nextContent = mergeEditableSettingsIntoConfig(existingContent, settings);
  await writeConfigAtomically(filePath, nextContent);
}

export function resolveAppRoot(execPath: string = process.execPath, cwd: string = process.cwd()): string {
  if (process.env.SENTENCEMINER_ROOT) {
    return path.resolve(process.env.SENTENCEMINER_ROOT);
  }

  const executableName = path.basename(execPath).toLowerCase();
  if (!/^node(?:\.exe)?$/.test(executableName)) {
    return path.dirname(execPath);
  }

  return path.resolve(cwd);
}

export function resolveConfigPath(argv: string[], appRoot: string = resolveAppRoot()): string {
  const explicitArgIndex = argv.findIndex((arg) => arg === '--config');
  if (explicitArgIndex !== -1 && argv[explicitArgIndex + 1]) {
    return path.resolve(argv[explicitArgIndex + 1]);
  }

  if (process.env.SENTENCEMINER_CONFIG) {
    return path.resolve(process.env.SENTENCEMINER_CONFIG);
  }

  const directPath = path.resolve(appRoot, 'script-opts', 'sentenceminer.conf');
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  const packagedPath = path.resolve(appRoot, '..', '..', 'script-opts', 'sentenceminer.conf');
  if (fs.existsSync(packagedPath)) {
    return packagedPath;
  }

  if (path.basename(appRoot).toLowerCase() === 'sentenceminer-helper') {
    return packagedPath;
  }

  return directPath;
}

export function resolveBundledFfmpegPath(appRoot: string = resolveAppRoot()): string | null {
  const candidates = [
    path.resolve(appRoot, 'ffmpeg.exe'),
    path.resolve(appRoot, 'bin', 'ffmpeg.exe'),
    path.resolve(appRoot, 'sentenceminer-helper', 'ffmpeg.exe'),
    path.resolve(appRoot, '..', 'scripts', 'sentenceminer-helper', 'ffmpeg.exe'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveFfmpegPath(
  configuredPath: string,
  options: {
    appRoot?: string;
    configPath?: string;
  } = {},
): string {
  const appRoot = options.appRoot ?? resolveAppRoot();
  const configPath = options.configPath;
  const normalized = configuredPath.trim() || DEFAULT_CONFIG.runtime.ffmpegPath;

  if (isDefaultFfmpegCommand(normalized)) {
    return resolveBundledFfmpegPath(appRoot) ?? normalized;
  }

  if (!isPathLike(normalized)) {
    return normalized;
  }

  const resolutionBases = [
    configPath ? path.dirname(configPath) : null,
    appRoot,
  ].filter((value): value is string => Boolean(value));

  for (const base of resolutionBases) {
    const candidate = path.resolve(base, normalized);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const preferredBase = resolutionBases[0];
  return preferredBase ? path.resolve(preferredBase, normalized) : path.resolve(normalized);
}

async function readOptionalConfig(filePath: string): Promise<Partial<AppConfig> | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return parseConfig(raw);
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }

    throw new Error(`Failed to read config at ${filePath}: ${String(error)}`);
  }
}

function parseConfig(raw: string): Partial<AppConfig> {
  const config: Partial<AppConfig> = {};

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      throw new Error(`Invalid config line ${index + 1}: expected key=value`);
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    applyConfigEntry(config, key, value);
  }

  return config;
}

function applyConfigEntry(config: Partial<AppConfig>, key: string, value: string): void {
  switch (key) {
    case 'server_host':
      config.server = {
        ...config.server,
        host: value,
      };
      return;
    case 'server_port':
      config.server = {
        ...config.server,
        port: parseNumber(key, value),
      };
      return;
    case 'anki_url':
      config.anki = {
        ...config.anki,
        url: value,
      };
      return;
    case 'anki_api_key':
      config.anki = {
        ...config.anki,
        apiKey: value,
      };
      return;
    case 'anki_deck':
      config.anki = {
        ...config.anki,
        deck: value,
      };
      return;
    case 'anki_note_type':
      config.anki = {
        ...config.anki,
        noteType: value,
      };
      return;
    case 'anki_extra_query':
      config.anki = {
        ...config.anki,
        extraQuery: value,
      };
      return;
    case 'anki_field_subtitle':
      config.anki = {
        ...config.anki,
        fields: {
          ...config.anki?.fields,
          subtitle: value,
        },
      };
      return;
    case 'anki_field_audio':
      config.anki = {
        ...config.anki,
        fields: {
          ...config.anki?.fields,
          audio: value,
        },
      };
      return;
    case 'anki_field_image':
      config.anki = {
        ...config.anki,
        fields: {
          ...config.anki?.fields,
          image: value,
        },
      };
      return;
    case 'anki_field_source':
      config.anki = {
        ...config.anki,
        fields: {
          ...config.anki?.fields,
          source: value,
        },
      };
      return;
    case 'anki_field_time':
      config.anki = {
        ...config.anki,
        fields: {
          ...config.anki?.fields,
          time: value,
        },
      };
      return;
    case 'anki_field_filename':
      config.anki = {
        ...config.anki,
        fields: {
          ...config.anki?.fields,
          filename: value,
        },
      };
      return;
    case 'anki_filename_template':
      config.anki = {
        ...config.anki,
        filenameTemplate: value,
      };
      return;
    case 'capture_audio_pre_padding_ms':
      config.capture = {
        ...config.capture,
        audioPrePaddingMs: parseNumber(key, value),
      };
      return;
    case 'capture_audio_post_padding_ms':
      config.capture = {
        ...config.capture,
        audioPostPaddingMs: parseNumber(key, value),
      };
      return;
    case 'capture_audio_format':
      config.capture = {
        ...config.capture,
        audioFormat: value,
      };
      return;
    case 'capture_audio_codec':
      config.capture = {
        ...config.capture,
        audioCodec: value,
      };
      return;
    case 'capture_audio_bitrate':
      config.capture = {
        ...config.capture,
        audioBitrate: value,
      };
      return;
    case 'capture_image_format':
      config.capture = {
        ...config.capture,
        imageFormat: value,
      };
      return;
    case 'capture_image_quality':
      config.capture = {
        ...config.capture,
        imageQuality: parseNumber(key, value),
      };
      return;
    case 'capture_image_max_width':
      config.capture = {
        ...config.capture,
        imageMaxWidth: parseNumber(key, value),
      };
      return;
    case 'capture_image_max_height':
      config.capture = {
        ...config.capture,
        imageMaxHeight: parseNumber(key, value),
      };
      return;
    case 'capture_image_include_subtitles':
      config.capture = {
        ...config.capture,
        imageIncludeSubtitles: parseBoolean(key, value),
      };
      return;
    case 'subtitle_card_font_family':
      config.appearance = {
        ...config.appearance,
        subtitleCardFontFamily: value,
      };
      return;
    case 'subtitle_card_font_size_px':
      config.appearance = {
        ...config.appearance,
        subtitleCardFontSizePx: parseNumber(key, value),
      };
      return;
    case 'ffmpeg_path':
      config.runtime = {
        ...config.runtime,
        ffmpegPath: value,
      };
      return;
    case 'enabled':
      config.runtime = {
        ...config.runtime,
        enabled: parseBoolean(key, value),
      };
      return;
    case 'temp_dir':
      config.runtime = {
        ...config.runtime,
        tempDir: value,
      };
      return;
    case 'capture_audio':
      config.runtime = {
        ...config.runtime,
        captureAudio: parseBoolean(key, value),
      };
      return;
    case 'capture_image':
      config.runtime = {
        ...config.runtime,
        captureImage: parseBoolean(key, value),
      };
      return;
    default:
      return;
  }
}

async function readConfigText(filePath: string): Promise<string> {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return '';
    }

    throw new Error(`Failed to read config at ${filePath}: ${String(error)}`);
  }
}

function parseNumber(key: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${key}: ${value}`);
  }

  return parsed;
}

function parseBoolean(key: string, value: string): boolean {
  const normalized = value.toLowerCase();
  if (['yes', 'true', '1', 'on'].includes(normalized)) {
    return true;
  }

  if (['no', 'false', '0', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value for ${key}: ${value}`);
}

function isDefaultFfmpegCommand(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'ffmpeg' || normalized === 'ffmpeg.exe';
}

function isPathLike(value: string): boolean {
  return /^[.~]/.test(value) || /[\\/]/.test(value) || /^[a-z]:/i.test(value);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function mergeConfig(base: AppConfig, overrides: Partial<AppConfig>): AppConfig {
  return {
    server: {
      ...base.server,
      ...overrides.server,
    },
    anki: {
      ...base.anki,
      ...overrides.anki,
      fields: {
        ...base.anki.fields,
        ...overrides.anki?.fields,
      },
    },
    capture: {
      ...base.capture,
      ...overrides.capture,
    },
    runtime: {
      ...base.runtime,
      ...overrides.runtime,
    },
    appearance: {
      ...base.appearance,
      ...overrides.appearance,
    },
  };
}

interface EditableConfigEntry {
  key: string;
  value: (settings: EditableSettings) => string;
}

const EDITABLE_CONFIG_ENTRIES: EditableConfigEntry[] = [
  { key: 'anki_deck', value: (settings) => settings.anki.deck },
  { key: 'anki_note_type', value: (settings) => settings.anki.noteType },
  { key: 'anki_extra_query', value: (settings) => settings.anki.extraQuery },
  { key: 'anki_field_subtitle', value: (settings) => settings.anki.fields.subtitle },
  { key: 'anki_field_audio', value: (settings) => settings.anki.fields.audio },
  { key: 'anki_field_image', value: (settings) => settings.anki.fields.image },
  { key: 'anki_field_source', value: (settings) => settings.anki.fields.source ?? '' },
  { key: 'anki_field_time', value: (settings) => settings.anki.fields.time ?? '' },
  { key: 'anki_field_filename', value: (settings) => settings.anki.fields.filename ?? '' },
  { key: 'anki_filename_template', value: (settings) => settings.anki.filenameTemplate },
  { key: 'capture_audio', value: (settings) => serializeBoolean(settings.runtime.captureAudio) },
  { key: 'capture_image', value: (settings) => serializeBoolean(settings.runtime.captureImage) },
  { key: 'capture_audio_pre_padding_ms', value: (settings) => String(settings.capture.audioPrePaddingMs) },
  { key: 'capture_audio_post_padding_ms', value: (settings) => String(settings.capture.audioPostPaddingMs) },
  { key: 'capture_audio_format', value: (settings) => settings.capture.audioFormat },
  { key: 'capture_audio_codec', value: (settings) => settings.capture.audioCodec },
  { key: 'capture_audio_bitrate', value: (settings) => settings.capture.audioBitrate },
  { key: 'capture_image_format', value: (settings) => settings.capture.imageFormat },
  { key: 'capture_image_quality', value: (settings) => String(settings.capture.imageQuality) },
  { key: 'capture_image_max_width', value: (settings) => String(settings.capture.imageMaxWidth) },
  { key: 'capture_image_max_height', value: (settings) => String(settings.capture.imageMaxHeight) },
  { key: 'capture_image_include_subtitles', value: (settings) => serializeBoolean(settings.capture.imageIncludeSubtitles) },
  { key: 'subtitle_card_font_family', value: (settings) => settings.appearance.subtitleCardFontFamily },
  { key: 'subtitle_card_font_size_px', value: (settings) => String(settings.appearance.subtitleCardFontSizePx) },
];

export function mergeEditableSettingsIntoConfig(existingContent: string, settings: EditableSettings): string {
  const newline = existingContent.includes('\r\n') ? '\r\n' : '\n';
  const lines = existingContent === '' ? [] : existingContent.split(/\r?\n/);
  const remainingKeys = new Set(EDITABLE_CONFIG_ENTRIES.map((entry) => entry.key));

  const updatedLines = lines.map((line) => {
    const trimmedStart = line.trimStart();
    if (trimmedStart.startsWith('#') || trimmedStart.startsWith(';')) {
      return line;
    }

    for (const entry of EDITABLE_CONFIG_ENTRIES) {
      const keyPattern = new RegExp(`^\\s*${escapeRegExp(entry.key)}\\s*=`);
      if (keyPattern.test(line)) {
        remainingKeys.delete(entry.key);
        return `${entry.key}=${entry.value(settings)}`;
      }
    }

    return line;
  });

  if (remainingKeys.size > 0) {
    if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== '') {
      updatedLines.push('');
    }

    for (const entry of EDITABLE_CONFIG_ENTRIES) {
      if (remainingKeys.has(entry.key)) {
        updatedLines.push(`${entry.key}=${entry.value(settings)}`);
      }
    }
  }

  return updatedLines.join(newline);
}

function serializeBoolean(value: boolean): string {
  return value ? 'yes' : 'no';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function writeConfigAtomically(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tempPath, content, 'utf8');
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw new Error(`Failed to write config at ${filePath}: ${String(error)}`);
  }
}
