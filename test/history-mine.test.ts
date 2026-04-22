import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../src/config.ts';
import { mineHistoryEntry, normalizeHistoryMineRequest } from '../src/history-mine.ts';
import type { AppConfig, HistoryMineRequest, SubtitleEventPayload } from '../src/types.ts';

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

function buildBatchRequest(entries: SubtitleEventPayload[], editedText?: string): HistoryMineRequest {
  return editedText == null ? { entries } : { entries, editedText };
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
  assert.equal(
    processCalls[0].args[processCalls[0].args.indexOf('-af') + 1],
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  );
  assert.equal(minedPayload?.audioPath, 'C:\\Temp\\audio.mp3');
  assert.equal(minedPayload?.screenshotPath, 'C:\\Temp\\image.jpg');
  assert.deepEqual(cleanedPaths, ['C:\\Temp\\audio.mp3', 'C:\\Temp\\image.jpg']);
});

test('normalizeHistoryMineRequest combines selected entries chronologically into one payload', () => {
  const normalized = normalizeHistoryMineRequest(
    buildBatchRequest([
      {
        ...buildPayload(),
        text: 'third',
        startMs: 3_000,
        endMs: 3_500,
        playbackTimeMs: 3_250,
      },
      {
        ...buildPayload(),
        text: 'first',
        startMs: 1_000,
        endMs: 1_200,
        playbackTimeMs: 1_100,
      },
      {
        ...buildPayload(),
        text: 'second',
        startMs: 2_000,
        endMs: 2_100,
        playbackTimeMs: 2_050,
      },
    ]),
  );

  assert.equal(normalized.payload.text, 'first second third');
  assert.equal(normalized.payload.startMs, 1_000);
  assert.equal(normalized.payload.endMs, 3_500);
  assert.equal(normalized.payload.playbackTimeMs, 1_100);
  assert.equal(normalized.screenshotCaptureMs, 1_000);
  assert.deepEqual(
    normalized.entries.map((entry) => entry.text),
    ['first', 'second', 'third'],
  );
});

test('normalizeHistoryMineRequest uses edited text while preserving original match candidates', () => {
  const normalized = normalizeHistoryMineRequest(
    buildBatchRequest([
      {
        ...buildPayload(),
        text: 'original first',
        startMs: 1_000,
        endMs: 1_500,
      },
      {
        ...buildPayload(),
        text: 'original second',
        startMs: 2_000,
        endMs: 2_500,
      },
    ], 'edited sentence'),
  );

  assert.equal(normalized.payload.text, 'edited sentence');
  assert.deepEqual(normalized.payload.sentenceMatchCandidates, [
    'edited sentence',
    'original first original second',
    'original first',
    'original second',
  ]);
});

test('mineHistoryEntry captures one combined clip and one screenshot for batch requests', async () => {
  const config = buildConfig();
  const processCalls: Array<{ command: string; args: string[]; description: string }> = [];
  let minedPayload: Record<string, unknown> | null = null;

  const result = await mineHistoryEntry(
    config,
    buildBatchRequest([
      {
        ...buildPayload(),
        text: 'later',
        startMs: 2_500,
        endMs: 3_000,
        playbackTimeMs: 2_700,
      },
      {
        ...buildPayload(),
        text: 'earlier',
        startMs: 1_000,
        endMs: 1_500,
        playbackTimeMs: 1_200,
      },
    ]),
    {
      createTempPath: (_payload, kind, extension, tempDir) => `${tempDir}\\${kind}.${extension}`,
      runProcess: async (command, args, description) => {
        processCalls.push({ command, args, description });
      },
      mineToAnki: async (_ankiConfig, nextPayload) => {
        minedPayload = nextPayload as unknown as Record<string, unknown>;
        return {
          success: true,
          message: 'ok',
        };
      },
    },
  );

  assert.equal(result.success, true);
  assert.equal(processCalls.length, 2);
  assert.deepEqual(processCalls[0].args.slice(0, 8), ['-y', '-ss', '0.750', '-i', 'C:\\Videos\\episode.mkv', '-t', '2.500', '-vn']);
  assert.equal(
    processCalls[0].args[processCalls[0].args.indexOf('-af') + 1],
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  );
  assert.deepEqual(processCalls[1].args.slice(0, 7), ['-y', '-ss', '1.000', '-i', 'C:\\Videos\\episode.mkv', '-frames:v', '1']);
  assert.equal(minedPayload?.text, 'earlier later');
  assert.equal(minedPayload?.startMs, 1_000);
  assert.equal(minedPayload?.endMs, 3_000);
});

test('mineHistoryEntry resolves remote media URLs before capture', async () => {
  const config = buildConfig();
  config.runtime.ytDlpPath = 'C:\\Tools\\yt-dlp.exe';
  const payload: SubtitleEventPayload = {
    ...buildPayload(),
    filePath: 'https://www.youtube.com/watch?v=abc123',
  };
  const processCalls: Array<{ command: string; args: string[]; description: string }> = [];
  const ytDlpCalls: Array<{ command: string; args: string[] }> = [];

  const result = await mineHistoryEntry(config, payload, {
    createTempPath: (_payload, kind, extension, tempDir) => `${tempDir}\\${kind}.${extension}`,
    runYtDlp: async (command, args) => {
      ytDlpCalls.push({ command, args });
      return args.includes('bestaudio/best')
        ? 'https://media.example/audio.webm\n'
        : 'https://media.example/video.mp4\n';
    },
    runProcess: async (command, args, description) => {
      processCalls.push({ command, args, description });
    },
    cleanupFile: async () => {},
    mineToAnki: async () => ({
      success: true,
      message: 'ok',
    }),
  });

  assert.equal(result.success, true);
  assert.equal(ytDlpCalls.length, 2);
  assert.equal(ytDlpCalls[0].command, 'C:\\Tools\\yt-dlp.exe');
  assert.deepEqual(ytDlpCalls[0].args.slice(0, 6), ['--no-warnings', '--no-playlist', '-f', 'bestaudio/best', '-g', '--']);
  assert.deepEqual(ytDlpCalls[1].args.slice(0, 6), ['--no-warnings', '--no-playlist', '-f', 'bestvideo/best', '-g', '--']);
  assert.equal(processCalls[0].args[processCalls[0].args.indexOf('-i') + 1], 'https://media.example/audio.webm');
  assert.equal(processCalls[1].args[processCalls[1].args.indexOf('-i') + 1], 'https://media.example/video.mp4');
});

test('mineHistoryEntry reports yt-dlp failures for remote capture', async () => {
  const config = buildConfig();
  const payload: SubtitleEventPayload = {
    ...buildPayload(),
    filePath: 'https://www.youtube.com/watch?v=abc123',
  };

  await assert.rejects(
    () =>
      mineHistoryEntry(config, payload, {
        runYtDlp: async () => {
          throw new Error('yt-dlp failed to resolve remote media URL: spawn ENOENT');
        },
      }),
    /yt-dlp failed to resolve remote media URL/,
  );
});

test('mineHistoryEntry rejects empty batch requests', async () => {
  const config = buildConfig();

  await assert.rejects(() => mineHistoryEntry(config, buildBatchRequest([])), /Select at least one subtitle line/);
});

test('mineHistoryEntry rejects mixed-session and mixed-file selections', async () => {
  const config = buildConfig();

  await assert.rejects(
    () =>
      mineHistoryEntry(
        config,
        buildBatchRequest([
          buildPayload(),
          {
            ...buildPayload(),
            sessionId: 's2',
          },
        ]),
      ),
    /same session/,
  );

  await assert.rejects(
    () =>
      mineHistoryEntry(
        config,
        buildBatchRequest([
          buildPayload(),
          {
            ...buildPayload(),
            filePath: 'C:\\Videos\\episode-2.mkv',
          },
        ]),
      ),
    /same source file/,
  );
});

test('mineHistoryEntry can mine text-only history entries without running ffmpeg', async () => {
  const config = buildConfig();
  config.runtime.captureAudio = false;
  config.runtime.captureImage = false;
  const payload = {
    ...buildPayload(),
    filePath: 'https://www.youtube.com/watch?v=abc123',
  };

  let runProcessCalled = false;
  let runYtDlpCalled = false;
  let minedPayload: Record<string, unknown> | null = null;

  const result = await mineHistoryEntry(config, payload, {
    runProcess: async () => {
      runProcessCalled = true;
    },
    runYtDlp: async () => {
      runYtDlpCalled = true;
      return '';
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
  assert.equal(runYtDlpCalled, false);
  assert.equal(minedPayload?.audioPath, undefined);
  assert.equal(minedPayload?.screenshotPath, undefined);
});
