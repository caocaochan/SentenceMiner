import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSubtitleTranscript } from '../src/subtitle-parser.ts';
import { loadSubtitleTranscript } from '../src/subtitle-transcript.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const BASE_TRACK = {
  sessionId: 'session-1',
  filePath: 'C:\\Videos\\episode.mkv',
  kind: 'external' as const,
  externalFilePath: 'C:\\Videos\\episode.srt',
  trackId: 1,
  ffIndex: null,
  codec: 'subrip',
  title: 'English',
  lang: 'en',
};

test('parseSubtitleTranscript parses srt cues', () => {
  const transcript = parseSubtitleTranscript(
    `1
00:00:01,000 --> 00:00:02,000
first line

2
00:00:03,000 --> 00:00:04,000
second line`,
    {
      sessionId: 'session-1',
      filePath: 'episode.mkv',
      sourcePath: 'episode.srt',
    },
  );

  assert.deepEqual(
    transcript.map((cue) => cue.text),
    ['first line', 'second line'],
  );
});

test('parseSubtitleTranscript parses webvtt cues', () => {
  const transcript = parseSubtitleTranscript(
    `WEBVTT

00:00:01.000 --> 00:00:02.000
<c.yellow>first</c>

00:00:03.000 --> 00:00:04.000
second`,
    {
      sessionId: 'session-1',
      filePath: 'episode.mkv',
      sourcePath: 'episode.vtt',
    },
  );

  assert.deepEqual(
    transcript.map((cue) => cue.text),
    ['first', 'second'],
  );
});

test('parseSubtitleTranscript parses ass and strips styling', () => {
  const transcript = parseSubtitleTranscript(
    `[Script Info]
Title: Example

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}first\\Nline
Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,second`,
    {
      sessionId: 'session-1',
      filePath: 'episode.mkv',
      sourcePath: 'episode.ass',
    },
  );

  assert.deepEqual(
    transcript.map((cue) => cue.text),
    ['first\nline', 'second'],
  );
});

test('parseSubtitleTranscript parses ssa cues', () => {
  const transcript = parseSubtitleTranscript(
    `[Script Info]
[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,NTP,0000,0000,0000,,first
Dialogue: Marked=0,0:00:03.00,0:00:04.00,Default,NTP,0000,0000,0000,,second`,
    {
      sessionId: 'session-1',
      filePath: 'episode.mkv',
      sourcePath: 'episode.ssa',
    },
  );

  assert.deepEqual(
    transcript.map((cue) => cue.text),
    ['first', 'second'],
  );
});

test('loadSubtitleTranscript reads the active external subtitle file', async () => {
  const result = await loadSubtitleTranscript(DEFAULT_CONFIG, BASE_TRACK, {
    readFile: async () => `1
00:00:01,000 --> 00:00:02,000
hello`,
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.transcript[0]?.text, 'hello');
});

test('loadSubtitleTranscript fetches remote external subtitle files', async () => {
  const requestedUrls: string[] = [];
  const result = await loadSubtitleTranscript(
    DEFAULT_CONFIG,
    {
      ...BASE_TRACK,
      externalFilePath: 'https://example.com/subtitles/episode.vtt',
    },
    {
      fetchText: async (url) => {
        requestedUrls.push(url);
        return `WEBVTT

00:00:01.000 --> 00:00:02.000
remote line`;
      },
    },
  );

  assert.equal(result.status, 'ready');
  assert.deepEqual(requestedUrls, ['https://example.com/subtitles/episode.vtt']);
  assert.equal(result.transcript[0]?.text, 'remote line');
});

test('loadSubtitleTranscript decodes mpv EDL remote subtitle sources', async () => {
  const remoteUrl = 'https://www.youtube.com/api/timedtext?v=abc123&lang=zh&fmt=srt';
  const result = await loadSubtitleTranscript(
    DEFAULT_CONFIG,
    {
      ...BASE_TRACK,
      externalFilePath: `edl://!no_clip;!delay_open,media_type=sub,codec=webvtt;%${remoteUrl.length}%${remoteUrl}`,
    },
    {
      fetchText: async (url) => {
        assert.equal(url, remoteUrl);
        return `1
00:00:01,000 --> 00:00:02,000
youtube caption`;
      },
    },
  );

  assert.equal(result.status, 'ready');
  assert.equal(result.transcript[0]?.text, 'youtube caption');
});

test('loadSubtitleTranscript reports malformed EDL subtitle sources as unavailable', async () => {
  const result = await loadSubtitleTranscript(DEFAULT_CONFIG, {
    ...BASE_TRACK,
    externalFilePath: 'edl://!no_clip;!delay_open,media_type=sub',
  });

  assert.equal(result.status, 'unavailable');
  assert.match(result.message ?? '', /fetchable URL/);
});

test('loadSubtitleTranscript reports remote subtitle fetch failures clearly', async () => {
  const result = await loadSubtitleTranscript(
    DEFAULT_CONFIG,
    {
      ...BASE_TRACK,
      externalFilePath: 'https://example.com/missing.srt',
    },
    {
      fetchText: async () => {
        throw new Error('HTTP 404 Not Found');
      },
    },
  );

  assert.equal(result.status, 'error');
  assert.match(result.message ?? '', /Remote subtitle source could not be loaded: HTTP 404 Not Found/);
});

test('loadSubtitleTranscript extracts the active embedded subtitle stream', async () => {
  const result = await loadSubtitleTranscript(
    DEFAULT_CONFIG,
    {
      ...BASE_TRACK,
      kind: 'embedded',
      externalFilePath: null,
      ffIndex: 4,
      codec: 'ass',
    },
    {
      makeTempDir: async () => 'C:\\Temp\\subtitle-track',
      removeDir: async () => {},
      runFfmpeg: async () => {},
      readFile: async () => `1
00:00:01,000 --> 00:00:02,000
embedded line`,
    },
  );

  assert.equal(result.status, 'ready');
  assert.equal(result.transcript[0]?.text, 'embedded line');
});

test('loadSubtitleTranscript reports bitmap subtitle tracks as unavailable', async () => {
  const result = await loadSubtitleTranscript(DEFAULT_CONFIG, {
    ...BASE_TRACK,
    kind: 'embedded',
    externalFilePath: null,
    ffIndex: 4,
    codec: 'hdmv_pgs_subtitle',
  });

  assert.equal(result.status, 'unavailable');
  assert.match(result.message ?? '', /image-based/);
});
