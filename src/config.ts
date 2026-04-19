import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from './types.ts';

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
  transcript: {
    historyLimit: 250,
  },
};

export async function loadConfig(argv: string[] = process.argv.slice(2)): Promise<AppConfig> {
  const configPath = resolveConfigPath(argv);
  const fileConfig = await readOptionalConfig(configPath);
  return mergeConfig(DEFAULT_CONFIG, fileConfig ?? {});
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
    case 'transcript_history_limit':
      config.transcript = {
        ...config.transcript,
        historyLimit: parseNumber(key, value),
      };
      return;
    default:
      return;
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
    transcript: {
      ...base.transcript,
      ...overrides.transcript,
    },
  };
}
