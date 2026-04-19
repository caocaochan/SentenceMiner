import fs from 'node:fs/promises';
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
  const fileConfig = await readOptionalJson<AppConfig>(configPath);
  return mergeConfig(DEFAULT_CONFIG, fileConfig ?? {});
}

function resolveConfigPath(argv: string[]): string {
  const explicitArgIndex = argv.findIndex((arg) => arg === '--config');
  if (explicitArgIndex !== -1 && argv[explicitArgIndex + 1]) {
    return path.resolve(argv[explicitArgIndex + 1]);
  }

  if (process.env.SENTENCEMINER_CONFIG) {
    return path.resolve(process.env.SENTENCEMINER_CONFIG);
  }

  return path.resolve(process.cwd(), 'sentenceminer.config.json');
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }

    throw new Error(`Failed to read config at ${filePath}: ${String(error)}`);
  }
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
