import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { parseSubtitleTranscript } from './subtitle-parser.ts';
import type { AppConfig, SubtitleTrackPayload, TranscriptCue, TranscriptStatus } from './types.ts';

const execFile = promisify(execFileCallback);
const BITMAP_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

export interface SubtitleTranscriptResult {
  transcript: TranscriptCue[];
  status: TranscriptStatus;
  message: string | null;
}

export interface SubtitleTranscriptDependencies {
  readFile?: (filePath: string) => Promise<string>;
  fetchText?: (url: string) => Promise<string>;
  makeTempDir?: () => Promise<string>;
  removeDir?: (dirPath: string) => Promise<void>;
  runFfmpeg?: (ffmpegPath: string, args: string[]) => Promise<void>;
}

export class SubtitleTranscriptUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubtitleTranscriptUnavailableError';
  }
}

export async function loadSubtitleTranscript(
  config: AppConfig,
  track: SubtitleTrackPayload,
  dependencies: SubtitleTranscriptDependencies = {},
): Promise<SubtitleTranscriptResult> {
  try {
    if (track.kind === 'none') {
      throw new SubtitleTranscriptUnavailableError('No active subtitle track is selected.');
    }

    const transcript =
      track.kind === 'external'
        ? await loadExternalSubtitleTranscript(track, dependencies)
        : await loadEmbeddedSubtitleTranscript(config, track, dependencies);

    if (transcript.length === 0) {
      throw new SubtitleTranscriptUnavailableError('No subtitle lines were found in the active subtitle track.');
    }

    return {
      transcript,
      status: 'ready',
      message: null,
    };
  } catch (error) {
    if (error instanceof SubtitleTranscriptUnavailableError) {
      return {
        transcript: [],
        status: 'unavailable',
        message: error.message,
      };
    }

    return {
      transcript: [],
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadExternalSubtitleTranscript(
  track: SubtitleTrackPayload,
  dependencies: SubtitleTranscriptDependencies,
): Promise<TranscriptCue[]> {
  const externalFilePath = track.externalFilePath?.trim();
  if (!externalFilePath) {
    throw new SubtitleTranscriptUnavailableError('The active external subtitle file path is unavailable.');
  }

  const readFile = dependencies.readFile ?? defaultReadFile;
  const raw = await readExternalSubtitleText(externalFilePath, readFile, dependencies.fetchText ?? defaultFetchText);
  const transcript = parseSubtitleTranscript(raw, {
    sessionId: track.sessionId,
    filePath: track.filePath,
    sourcePath: externalFilePath,
  });

  if (transcript.length === 0) {
    throw new SubtitleTranscriptUnavailableError('The active external subtitle file did not contain parseable text cues.');
  }

  return transcript;
}

async function readExternalSubtitleText(
  sourcePath: string,
  readFile: (filePath: string) => Promise<string>,
  fetchText: (url: string) => Promise<string>,
): Promise<string> {
  if (isRemoteResourcePath(sourcePath)) {
    return fetchRemoteSubtitleText(sourcePath, fetchText);
  }

  if (isEdlPath(sourcePath)) {
    const remoteUrl = extractRemoteUrlFromEdl(sourcePath);
    if (!remoteUrl) {
      throw new SubtitleTranscriptUnavailableError('The active remote subtitle source did not contain a fetchable URL.');
    }

    return fetchRemoteSubtitleText(remoteUrl, fetchText);
  }

  return readFile(sourcePath);
}

async function loadEmbeddedSubtitleTranscript(
  config: AppConfig,
  track: SubtitleTrackPayload,
  dependencies: SubtitleTranscriptDependencies,
): Promise<TranscriptCue[]> {
  if (!isLocalMediaPath(track.filePath)) {
    throw new SubtitleTranscriptUnavailableError('Embedded subtitle extraction requires a local media file.');
  }

  if (track.ffIndex == null) {
    throw new SubtitleTranscriptUnavailableError('The active embedded subtitle track is missing an FFmpeg stream index.');
  }

  const codec = track.codec?.trim().toLowerCase() ?? '';
  if (codec && BITMAP_SUBTITLE_CODECS.has(codec)) {
    throw new SubtitleTranscriptUnavailableError(`The active subtitle codec "${codec}" is image-based and cannot be preloaded as text.`);
  }

  const makeTempDir = dependencies.makeTempDir ?? defaultMakeTempDir;
  const removeDir = dependencies.removeDir ?? defaultRemoveDir;
  const runFfmpeg = dependencies.runFfmpeg ?? defaultRunFfmpeg;
  const readFile = dependencies.readFile ?? defaultReadFile;
  const tempDir = await makeTempDir();
  const outputPath = path.join(tempDir, 'active-track.srt');

  try {
    await runFfmpeg(config.runtime.ffmpegPath, [
      '-y',
      '-i',
      track.filePath,
      '-map',
      `0:${track.ffIndex}`,
      '-f',
      'srt',
      outputPath,
    ]);

    const raw = await readFile(outputPath);
    const transcript = parseSubtitleTranscript(raw, {
      sessionId: track.sessionId,
      filePath: track.filePath,
      sourcePath: outputPath,
    });

    if (transcript.length === 0) {
      throw new SubtitleTranscriptUnavailableError('The active embedded subtitle track did not contain parseable text cues.');
    }

    return transcript;
  } finally {
    await removeDir(tempDir);
  }
}

function isLocalMediaPath(filePath: string): boolean {
  return !/^[a-z][\w+.-]*:\/\//i.test(filePath);
}

function isRemoteResourcePath(filePath: string): boolean {
  return /^https?:\/\//i.test(filePath);
}

function isEdlPath(filePath: string): boolean {
  return /^edl:(?:\/\/|[\\/])?/i.test(filePath);
}

function extractRemoteUrlFromEdl(edlPath: string): string | null {
  const edl = edlPath.replace(/^edl:(?:\/\/|[\\/])?/i, '');
  for (let index = 0; index < edl.length; index += 1) {
    if (edl[index] !== '%') {
      continue;
    }

    const lengthEnd = edl.indexOf('%', index + 1);
    if (lengthEnd === -1) {
      continue;
    }

    const byteLength = Number.parseInt(edl.slice(index + 1, lengthEnd), 10);
    if (!Number.isFinite(byteLength) || byteLength < 0) {
      continue;
    }

    const valueStart = lengthEnd + 1;
    const value = sliceUtf8ByteLength(edl, valueStart, byteLength);
    if (value && isRemoteResourcePath(value)) {
      return value;
    }

    index = valueStart + Math.max(value.length - 1, 0);
  }

  const fallback = edl.match(/https?:\/\/[^;\n]+/i);
  return fallback?.[0] ?? null;
}

function sliceUtf8ByteLength(value: string, startIndex: number, byteLength: number): string {
  let bytesSeen = 0;
  let endIndex = startIndex;

  while (endIndex < value.length && bytesSeen < byteLength) {
    const codePoint = value.codePointAt(endIndex);
    if (codePoint == null) {
      break;
    }

    bytesSeen += Buffer.byteLength(String.fromCodePoint(codePoint), 'utf8');
    endIndex += codePoint > 0xffff ? 2 : 1;
  }

  return value.slice(startIndex, endIndex);
}

async function fetchRemoteSubtitleText(url: string, fetchText: (url: string) => Promise<string>): Promise<string> {
  try {
    return await fetchText(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Remote subtitle source could not be loaded: ${message}`);
  }
}

async function defaultReadFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }

  return response.text();
}

async function defaultMakeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sentenceminer-subtitle-'));
}

async function defaultRemoveDir(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
}

async function defaultRunFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  try {
    await execFile(ffmpegPath, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 8,
    });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '';
    const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`Embedded subtitle extraction failed: ${message}`);
  }
}
