import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import {
  InvalidAnkiMiningConfigError,
  NO_MATCHING_CARD_MESSAGE,
  NoMatchingCardError,
  mineToAnki,
} from '../src/anki.ts';
import type { AnkiConfig, MinePayload } from '../src/types.ts';
import { applyFilenameTemplate, buildSearchQuery, normalizeSubtitleForMatching } from '../src/utils.ts';

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
    source: 'Source',
    time: 'Time',
    filename: 'Filename',
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

test('mineToAnki only inspects and updates the newest note returned by the deck query', async (t) => {
  const { requests } = installFetchMock(t, {
    deckNames: ['Anime', 'Mining'],
    modelNames: ['Sentence', 'Vocab'],
    modelFieldNames: ['Sentence', 'Audio', 'Picture', 'Source', 'Time', 'Filename'],
    findNotes: [10, 25, 17],
    notesInfo: [note(25, 'hello world')],
    updateNoteFields: null,
  });

  const result = await mineToAnki(config, buildPayload());

  assert.equal(result.success, true);
  assert.equal(result.noteId, 25);
  assert.equal(result.message, 'Anki note updated successfully.');

  const updateRequest = requests.find((request) => request.action === 'updateNoteFields');
  assert.equal(updateRequest?.params.note.id, 25);
  assert.equal(updateRequest?.params.note.fields.Sentence, 'hello world');
  const notesInfoRequest = requests.find((request) => request.action === 'notesInfo');
  assert.deepEqual(notesInfoRequest?.params.notes, [25]);
});

test('mineToAnki does not fall back to an older matching duplicate when the newest note differs', async (t) => {
  const { requests } = installFetchMock(t, {
    deckNames: ['Anime', 'Mining'],
    modelNames: ['Sentence', 'Vocab'],
    modelFieldNames: ['Sentence', 'Audio', 'Picture', 'Source', 'Time', 'Filename'],
    findNotes: [10, 25, 17],
    notesInfo: [note(25, 'different sentence')],
  });

  await assert.rejects(() => mineToAnki(config, buildPayload()), (error: unknown) => {
    assert.ok(error instanceof NoMatchingCardError);
    assert.equal(error.message, NO_MATCHING_CARD_MESSAGE);
    return true;
  });

  assert.equal(requests.some((request) => request.action === 'updateNoteFields'), false);
});

test('mineToAnki throws when no candidate note sentence matches', async (t) => {
  const { requests } = installFetchMock(t, {
    deckNames: ['Anime', 'Mining'],
    modelNames: ['Sentence', 'Vocab'],
    modelFieldNames: ['Sentence', 'Audio', 'Picture', 'Source', 'Time', 'Filename'],
    findNotes: [25],
    notesInfo: [note(25, 'not this one')],
  });

  await assert.rejects(() => mineToAnki(config, buildPayload()), (error: unknown) => {
    assert.ok(error instanceof NoMatchingCardError);
    assert.equal(error.message, NO_MATCHING_CARD_MESSAGE);
    return true;
  });

  assert.equal(requests.some((request) => request.action === 'addNote'), false);
  assert.equal(requests.some((request) => request.action === 'storeMediaFile'), false);
});

test('mineToAnki matches note sentences after HTML and whitespace normalization', async (t) => {
  const { requests } = installFetchMock(t, {
    deckNames: ['Anime', 'Mining'],
    modelNames: ['Sentence', 'Vocab'],
    modelFieldNames: ['Sentence', 'Audio', 'Picture', 'Source', 'Time', 'Filename'],
    findNotes: [25],
    notesInfo: [note(25, '<div>hello<br>   world &amp; friends</div>')],
    updateNoteFields: null,
  });

  const result = await mineToAnki(config, {
    ...buildPayload(),
    text: 'hello world & friends',
  });

  assert.equal(result.noteId, 25);
  assert.equal(result.message, 'Anki note updated successfully.');
  assert.equal(normalizeSubtitleForMatching('<div>hello<br>   world &amp; friends</div>'), 'hello world & friends');

  const updateRequest = requests.find((request) => request.action === 'updateNoteFields');
  assert.equal(updateRequest?.params.note.fields.Sentence, 'hello world &amp; friends');
});

test('mineToAnki updates the sentence to the combined batch text when one selected subtitle line matches', async (t) => {
  const { requests } = installFetchMock(t, {
    deckNames: ['Anime', 'Mining'],
    modelNames: ['Sentence', 'Vocab'],
    modelFieldNames: ['Sentence', 'Audio', 'Picture', 'Source', 'Time', 'Filename'],
    findNotes: [25],
    notesInfo: [note(25, 'earlier')],
    updateNoteFields: null,
  });

  const result = await mineToAnki(config, {
    ...buildPayload(),
    text: 'earlier later',
    sentenceMatchCandidates: ['earlier later', 'earlier', 'later'],
  });

  assert.equal(result.noteId, 25);

  const updateRequest = requests.find((request) => request.action === 'updateNoteFields');
  assert.equal(updateRequest?.params.note.fields.Sentence, 'earlier later');
  assert.equal(updateRequest?.params.note.fields.Source, 'episode');
});

test('mineToAnki keeps the combined sentence when the full batch text matches', async (t) => {
  const { requests } = installFetchMock(t, {
    deckNames: ['Anime', 'Mining'],
    modelNames: ['Sentence', 'Vocab'],
    modelFieldNames: ['Sentence', 'Audio', 'Picture', 'Source', 'Time', 'Filename'],
    findNotes: [25],
    notesInfo: [note(25, 'earlier later')],
    updateNoteFields: null,
  });

  const result = await mineToAnki(config, {
    ...buildPayload(),
    text: 'earlier later',
    sentenceMatchCandidates: ['earlier later', 'earlier', 'later'],
  });

  assert.equal(result.noteId, 25);

  const updateRequest = requests.find((request) => request.action === 'updateNoteFields');
  assert.equal(updateRequest?.params.note.fields.Sentence, 'earlier later');
  assert.equal(updateRequest?.params.note.fields.Source, 'episode');
});

test('mineToAnki rejects mining when the configured deck does not exist', async (t) => {
  const { requests } = installFetchMock(t, {
    deckNames: ['Mining'],
    modelNames: ['Sentence', 'Vocab'],
    modelFieldNames: ['Sentence', 'Audio', 'Picture', 'Source', 'Time', 'Filename'],
  });

  await assert.rejects(() => mineToAnki(config, buildPayload()), (error: unknown) => {
    assert.ok(error instanceof InvalidAnkiMiningConfigError);
    assert.equal(error.message, 'Configured deck "Anime" does not exist in Anki.');
    return true;
  });

  assert.equal(requests.some((request) => request.action === 'findNotes'), false);
  assert.equal(requests.some((request) => request.action === 'storeMediaFile'), false);
});

test('mineToAnki rejects mining when a configured field does not exist on the note type', async (t) => {
  const { requests } = installFetchMock(t, {
    deckNames: ['Anime', 'Mining'],
    modelNames: ['Sentence', 'Vocab'],
    modelFieldNames: ['Sentence', 'Audio', 'Source', 'Time', 'Filename'],
  });

  await assert.rejects(() => mineToAnki(config, buildPayload()), (error: unknown) => {
    assert.ok(error instanceof InvalidAnkiMiningConfigError);
    assert.equal(error.message, 'Configured image field "Picture" does not exist on Anki note type "Sentence".');
    return true;
  });

  assert.equal(requests.some((request) => request.action === 'findNotes'), false);
  assert.equal(requests.some((request) => request.action === 'storeMediaFile'), false);
});

function buildPayload(): MinePayload {
  return {
    sessionId: 'session-1',
    filePath: 'C:\\Videos\\episode.mkv',
    text: 'hello world',
    startMs: 1000,
    endMs: 1500,
    playbackTimeMs: 1200,
  };
}

function note(noteId: number, sentence: string) {
  return {
    noteId,
    fields: {
      Sentence: { value: sentence },
      Audio: { value: '' },
      Picture: { value: '' },
      Source: { value: '' },
      Time: { value: '' },
      Filename: { value: '' },
    },
  };
}

function installFetchMock(
  t: TestContext,
  responses: Record<string, unknown>,
) {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, any>> = [];

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
    requests.push(payload);
    return new Response(JSON.stringify({ result: responses[payload.action] ?? null, error: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { requests };
}
