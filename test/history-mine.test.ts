import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../src/config.ts';
import { mineHistoryEntry } from '../src/history-mine.ts';
import type { AppConfig, SubtitleEventPayload } from '../src/types.ts';

function buildConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    capture: {
      ...DEFAULT_CONFIG.capture,
    },
    runtime: {
      ...DEFAULT_CONFIG.runtime,
      ffmpegPath: 'ffmpeg',
      tempDir: 'C:\\Temp',
      captureAudio: true,
      captureImage: true,
    },
  };
}

function buildPayload(): SubtitleEventPayload {
  return {
    sessionId: 's1',
    filePath: 'C:\\Videos\\episode.mkv',
    text: 'hello world',
    startMs: 1_000,
    endMs: 2_000,
    playbackTimeMs: 1_500,
  };
}

test('mineHistoryEntry captures media, mines the entry, and cleans up temp files', async () => {
  const config = buildConfig();
  const payload = buildPayload();
  const processCalls: Array<{ command: string; args: string[]; description: string }> = [];
  const cleanedPaths: string[] = [];
  let minedPayload: Record<string, unknown> | null = null;

  const result = await mineHistoryEntry(config, payload, {
    createTempPath: (_payload, kind, extension, tempDir) => `${tempDir}\\${kind}.${extension}`,
    runProcess: async (command, args, description) => {
      processCalls.push({ command, args, description });
    },
    cleanupFile: async (filePath) => {
      cleanedPaths.push(filePath);
    },
    mineToAnki: async (_ankiConfig, minePayload) => {
      minedPayload = minePayload as unknown as Record<string, unknown>;
      return {
        success: true,
        message: 'ok',
        noteId: 42,
      };
    },
  });

  assert.equal(result.success, true);
  assert.equal(processCalls.length, 2);
  assert.equal(processCalls[0].description, 'audio extraction');
  assert.equal(processCalls[1].description, 'image capture');
  assert.equal(minedPayload?.audioPath, 'C:\\Temp\\audio.mp3');
  assert.equal(minedPayload?.screenshotPath, 'C:\\Temp\\image.jpg');
  assert.deepEqual(cleanedPaths, ['C:\\Temp\\audio.mp3', 'C:\\Temp\\image.jpg']);
});

test('mineHistoryEntry rejects remote media when helper-side capture is enabled', async () => {
  const config = buildConfig();
  const payload = {
    ...buildPayload(),
    filePath: 'https://example.com/episode.mkv',
  };

  await assert.rejects(() => mineHistoryEntry(config, payload), /local media file/);
});

test('mineHistoryEntry can mine text-only history entries without running ffmpeg', async () => {
  const config = buildConfig();
  config.runtime.captureAudio = false;
  config.runtime.captureImage = false;

  let runProcessCalled = false;
  let minedPayload: Record<string, unknown> | null = null;

  const result = await mineHistoryEntry(config, buildPayload(), {
    runProcess: async () => {
      runProcessCalled = true;
    },
    mineToAnki: async (_ankiConfig, minePayload) => {
      minedPayload = minePayload as unknown as Record<string, unknown>;
      return {
        success: true,
        message: 'ok',
      };
    },
  });

  assert.equal(result.success, true);
  assert.equal(runProcessCalled, false);
  assert.equal(minedPayload?.audioPath, undefined);
  assert.equal(minedPayload?.screenshotPath, undefined);
});
