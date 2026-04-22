import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { promisify } from 'node:util';

import { mineToAnki } from './anki.ts';
import type { AppConfig, HistoryMineRequest, MineResult, SubtitleEventPayload } from './types.ts';
import { basenameWithoutExtension, sanitizeFilename } from './utils.ts';

const execFileAsync = promisify(execFile);
const REMOTE_MEDIA_RE = /^[a-z][\w+.-]*:\/\//i;
const AUDIO_NORMALIZATION_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11';

export interface HistoryMineDependencies {
  mineToAnki?: typeof mineToAnki;
  createTempPath?: (payload: SubtitleEventPayload, kind: 'audio' | 'image', extension: string, tempDir: string) => string;
  runProcess?: (command: string, args: string[], description: string) => Promise<void>;
  runYtDlp?: (command: string, args: string[]) => Promise<string>;
  cleanupFile?: (filePath: string) => Promise<void>;
}

export interface NormalizedHistoryMineRequest {
  payload: SubtitleEventPayload;
  entries: SubtitleEventPayload[];
  screenshotCaptureMs: number | null;
}

export async function mineHistoryEntry(
  config: AppConfig,
  request: HistoryMineRequest,
  dependencies: HistoryMineDependencies = {},
): Promise<MineResult> {
  const normalized = normalizeHistoryMineRequest(request);
  validateHistoryMinePayload(config, normalized);
  const payload = normalized.payload;

  const captureAudio = config.runtime.captureAudio;
  const captureImage = config.runtime.captureImage;
  const mineToAnkiImpl = dependencies.mineToAnki ?? mineToAnki;
  const createTempPath = dependencies.createTempPath ?? defaultCreateTempPath;
  const runProcess = dependencies.runProcess ?? defaultRunProcess;
  const runYtDlp = dependencies.runYtDlp ?? defaultRunYtDlp;
  const cleanupFile = dependencies.cleanupFile ?? defaultCleanupFile;
  const tempDir = resolveTempDir(config.runtime.tempDir);
  const isRemoteMedia = !isLocalMediaPath(payload.filePath);

  let audioPath: string | undefined;
  let screenshotPath: string | undefined;

  try {
    if (captureAudio) {
      audioPath = createAudioCapturePath(payload, config, tempDir, createTempPath);
      const audioInputPath = isRemoteMedia
        ? await resolveRemoteMediaUrl(config.runtime.ytDlpPath, payload.filePath, 'bestaudio/best', runYtDlp)
        : payload.filePath;
      await runProcess(
        config.runtime.ffmpegPath,
        buildAudioCaptureArgs(payload, config, audioPath, audioInputPath),
        'audio extraction',
      );
    }

    if (captureImage) {
      screenshotPath = createImageCapturePath(payload, config, tempDir, createTempPath);
      const imageInputPath = isRemoteMedia
        ? await resolveRemoteMediaUrl(config.runtime.ytDlpPath, payload.filePath, 'bestvideo/best', runYtDlp)
        : payload.filePath;
      await runProcess(
        config.runtime.ffmpegPath,
        buildImageCaptureArgs(imageInputPath, normalized.screenshotCaptureMs, config, screenshotPath),
        'image capture',
      );
    }

    return await mineToAnkiImpl(config.anki, {
      ...payload,
      audioPath,
      screenshotPath,
    });
  } finally {
    await Promise.allSettled(
      [audioPath, screenshotPath]
        .filter((filePath): filePath is string => Boolean(filePath))
        .map((filePath) => cleanupFile(filePath)),
    );
  }
}

export function normalizeHistoryMineRequest(request: HistoryMineRequest): NormalizedHistoryMineRequest {
  const entries = extractHistoryMineEntries(request);
  if (entries.length === 0) {
    throw new Error('Select at least one subtitle line to mine.');
  }

  const sortedEntries = entries
    .map((entry, index) => ({ entry, index }))
    .sort(compareHistoryMineEntries)
    .map(({ entry }) => entry);

  const [firstEntry] = sortedEntries;
  if (!firstEntry) {
    throw new Error('Select at least one subtitle line to mine.');
  }

  for (const entry of sortedEntries) {
    if (entry.sessionId !== firstEntry.sessionId) {
      throw new Error('Selected subtitle lines must belong to the same session.');
    }

    if (entry.filePath !== firstEntry.filePath) {
      throw new Error('Selected subtitle lines must belong to the same source file.');
    }
  }

  const text = sortedEntries
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  const editedText = 'entries' in request && typeof request.editedText === 'string'
    ? request.editedText.trim()
    : '';
  const finalText = editedText || text;
  const startMsValues = sortedEntries
    .map((entry) => entry.startMs)
    .filter((value): value is number => value != null);
  const endMsValues = sortedEntries
    .map((entry) => entry.endMs)
    .filter((value): value is number => value != null);

  return {
    payload: {
      ...firstEntry,
      text: finalText,
      sentenceMatchCandidates: buildSentenceMatchCandidates(finalText, text, sortedEntries),
      startMs: startMsValues.length > 0 ? Math.min(...startMsValues) : null,
      endMs: endMsValues.length > 0 ? Math.max(...endMsValues) : null,
      playbackTimeMs: firstEntry.playbackTimeMs ?? null,
    },
    entries: sortedEntries,
    screenshotCaptureMs: firstEntry.startMs ?? null,
  };
}

export function validateHistoryMinePayload(config: AppConfig, normalized: NormalizedHistoryMineRequest): void {
  const payload = normalized.payload;
  if (!payload.text.trim()) {
    throw new Error('Cannot mine without subtitle text.');
  }

  if (!payload.filePath.trim()) {
    throw new Error('Cannot mine without a source media path.');
  }

  if (
    config.runtime.captureAudio &&
    normalized.entries.some((entry) => entry.startMs == null || entry.endMs == null)
  ) {
    throw new Error('Audio capture requires subtitle timing for every selected subtitle line.');
  }

  if (config.runtime.captureImage && normalized.screenshotCaptureMs == null) {
    throw new Error('Image capture requires a subtitle start time.');
  }
}

function resolveTempDir(configuredTempDir: string): string {
  return configuredTempDir.trim() || os.tmpdir();
}

function defaultCreateTempPath(
  payload: SubtitleEventPayload,
  kind: 'audio' | 'image',
  extension: string,
  tempDir: string,
): string {
  const mediaName = sanitizeFilename(basenameWithoutExtension(payload.filePath));
  const filename = `sentenceminer-${mediaName}-${kind}-${randomInt(100000, 999999)}.${extension.replace(/^\./, '')}`;
  return path.join(tempDir, filename);
}

function createAudioCapturePath(
  payload: SubtitleEventPayload,
  config: AppConfig,
  tempDir: string,
  createTempPath: NonNullable<HistoryMineDependencies['createTempPath']>,
): string {
  return createTempPath(payload, 'audio', config.capture.audioFormat, tempDir);
}

function createImageCapturePath(
  payload: SubtitleEventPayload,
  config: AppConfig,
  tempDir: string,
  createTempPath: NonNullable<HistoryMineDependencies['createTempPath']>,
): string {
  return createTempPath(payload, 'image', config.capture.imageFormat, tempDir);
}

function buildAudioCaptureArgs(
  payload: SubtitleEventPayload,
  config: AppConfig,
  outputPath: string,
  inputPath: string = payload.filePath,
): string[] {
  const prePaddingMs = config.capture.audioPrePaddingMs;
  const postPaddingMs = config.capture.audioPostPaddingMs;
  const clipStartMs = Math.max(0, (payload.startMs ?? 0) - prePaddingMs);
  const durationMs = (payload.endMs ?? 0) - (payload.startMs ?? 0) + prePaddingMs + postPaddingMs;

  if (durationMs <= 0) {
    throw new Error('Audio duration was not positive.');
  }

  return [
    '-y',
    '-ss',
    formatSeconds(clipStartMs),
    '-i',
    inputPath,
    '-t',
    formatSeconds(durationMs),
    '-vn',
    '-af',
    AUDIO_NORMALIZATION_FILTER,
    '-acodec',
    config.capture.audioCodec,
    '-b:a',
    config.capture.audioBitrate,
    outputPath,
  ];
}

function buildImageCaptureArgs(
  filePath: string,
  captureMs: number | null,
  config: AppConfig,
  outputPath: string,
): string[] {
  const args = [
    '-y',
    '-ss',
    formatSeconds(captureMs ?? 0),
    '-i',
    filePath,
    '-frames:v',
    '1',
  ];

  const maxWidth = config.capture.imageMaxWidth;
  const maxHeight = config.capture.imageMaxHeight;
  if (maxWidth > 0 && maxHeight > 0) {
    args.push('-vf', `scale=${maxWidth}:${maxHeight}:force_original_aspect_ratio=decrease`);
  }

  const formatName = config.capture.imageFormat.toLowerCase();
  if (formatName === 'jpg' || formatName === 'jpeg' || formatName === 'webp') {
    args.push('-q:v', String(config.capture.imageQuality));
  }

  args.push(outputPath);
  return args;
}

function formatSeconds(milliseconds: number): string {
  return (Math.max(0, milliseconds) / 1000).toFixed(3);
}

async function defaultRunProcess(command: string, args: string[], description: string): Promise<void> {
  try {
    await execFileAsync(command, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
    });
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : '';
    const message = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`${description} failed: ${message}`);
  }
}

async function resolveRemoteMediaUrl(
  ytDlpPath: string,
  sourceUrl: string,
  format: string,
  runYtDlp: NonNullable<HistoryMineDependencies['runYtDlp']>,
): Promise<string> {
  const output = await runYtDlp(ytDlpPath, [
    '--no-warnings',
    '--no-playlist',
    '-f',
    format,
    '-g',
    '--',
    sourceUrl,
  ]);
  const [resolvedUrl] = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!resolvedUrl) {
    throw new Error(`yt-dlp did not return a media URL for ${sourceUrl}.`);
  }

  return resolvedUrl;
}

async function defaultRunYtDlp(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
    });
    return stdout;
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : '';
    const message = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`yt-dlp failed to resolve remote media URL: ${message}`);
  }
}

async function defaultCleanupFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

function isLocalMediaPath(filePath: string): boolean {
  return !REMOTE_MEDIA_RE.test(filePath);
}

function extractHistoryMineEntries(request: HistoryMineRequest): SubtitleEventPayload[] {
  if ('entries' in request) {
    return request.entries;
  }

  return [request];
}

function compareHistoryMineEntries(
  a: { entry: SubtitleEventPayload; index: number },
  b: { entry: SubtitleEventPayload; index: number },
): number {
  if (a.entry.startMs == null && b.entry.startMs == null) {
    return a.index - b.index;
  }

  if (a.entry.startMs == null) {
    return 1;
  }

  if (b.entry.startMs == null) {
    return -1;
  }

  if (a.entry.startMs !== b.entry.startMs) {
    return a.entry.startMs - b.entry.startMs;
  }

  return a.index - b.index;
}

function buildSentenceMatchCandidates(text: string, combinedOriginalText: string, entries: SubtitleEventPayload[]): string[] {
  const seen = new Set<string>();
  const candidates = [text, combinedOriginalText, ...entries.map((entry) => entry.text)];

  return candidates
    .map((candidate) => candidate.trim())
    .filter((candidate) => {
      if (!candidate || seen.has(candidate)) {
        return false;
      }

      seen.add(candidate);
      return true;
    });
}
