import test from 'node:test';
import assert from 'node:assert/strict';

import { findNewestMatchingNote } from '../src/anki.ts';
import type { AnkiConfig } from '../src/types.ts';
import { applyFilenameTemplate, buildSearchQuery } from '../src/utils.ts';

const config: AnkiConfig = {
  url: 'http://127.0.0.1:8765',
  apiKey: '',
  deck: 'Anime',
  noteType: 'Sentence',
  extraQuery: 'tag:mining-target',
  fields: {
    subtitle: 'Sentence',
    audio: 'Audio',
    image: 'Picture',
  },
  filenameTemplate: '{basename}-{startMs}-{kind}.{ext}',
};

test('buildSearchQuery includes deck, note type, and extra query', () => {
  assert.equal(
    buildSearchQuery('Anime Mining', 'Sentence Note', 'tag:mining-target'),
    'deck:"Anime Mining" note:"Sentence Note" tag:mining-target',
  );
});

test('applyFilenameTemplate sanitizes file names and keeps extension', () => {
  const result = applyFilenameTemplate(
    '{basename}-{startMs}-{kind}.{ext}',
    {
      sessionId: 'abc',
      filePath: 'C:\\Shows\\My Show 01.mkv',
      text: '字幕',
      startMs: 1234,
      endMs: 2345,
      playbackTimeMs: 1234,
    },
    'audio',
    'mp3',
  );

  assert.equal(result, 'My-Show-01-1234-audio.mp3');
});

test('findNewestMatchingNote picks the highest note id', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ result: [10, 25, 17], error: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const newest = await findNewestMatchingNote(config);
  assert.equal(newest, 25);
});
