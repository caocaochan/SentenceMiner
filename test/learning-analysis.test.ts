import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeTranscriptLearning,
  normalizeLearningToken,
  setLacSegmenterFactoryForTesting,
  tokenizeText,
} from '../src/learning-analysis.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { TranscriptCue } from '../src/types.ts';

test('tokenizeText normalizes Chinese punctuation, duplicates, whitespace, and ASCII case', () => {
  assert.deepEqual(tokenizeText('我  喜欢，喜欢 JavaScript!'), ['我', '喜欢', 'javascript']);
  assert.equal(normalizeLearningToken('<b>JavaScript!</b>'), 'javascript');
});

test('analyzeTranscriptLearning marks only exactly one unique unknown word as i+1', async (t) => {
  const notes = [
    createAnkiNote(1, '我'),
    createAnkiNote(2, '喜欢'),
    createAnkiNote(3, '学习'),
  ];
  const server = createFakeAnkiServer(notes);
  await listen(server);
  t.after(() => closeServer(server));

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const config = structuredClone(DEFAULT_CONFIG);
  config.anki.url = `http://127.0.0.1:${address.port}`;
  config.learning.knownWordField = 'Word';
  config.learning.tokenizer = 'intl';

  const result = await analyzeTranscriptLearning(config.anki, config.learning, [
    buildCue('known', '我喜欢学习'),
    buildCue('one-unknown', '我喜欢中文'),
    buildCue('two-unknown', '我读中文'),
    buildCue('duplicate-unknown', '我喜欢中文中文'),
  ]);

  assert.equal(result.annotations.get('known')?.iPlusOne, false);
  assert.deepEqual(result.annotations.get('known')?.unknownWords, []);
  assert.equal(result.annotations.get('one-unknown')?.iPlusOne, true);
  assert.deepEqual(result.annotations.get('one-unknown')?.unknownWords, ['中文']);
  assert.deepEqual(result.annotations.get('one-unknown')?.unknownWordRanges, [{ start: 3, end: 5 }]);
  assert.equal(result.annotations.get('two-unknown')?.iPlusOne, false);
  assert.deepEqual(result.annotations.get('two-unknown')?.unknownWords, ['读', '中文']);
  assert.equal(result.annotations.get('duplicate-unknown')?.iPlusOne, true);
  assert.deepEqual(result.annotations.get('duplicate-unknown')?.unknownWords, ['中文']);
});

test('analyzeTranscriptLearning tokenizes sentence values from the known word field', async (t) => {
  const notes = [createAnkiNote(1, '我喜欢学习')];
  const server = createFakeAnkiServer(notes);
  await listen(server);
  t.after(() => closeServer(server));

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const config = structuredClone(DEFAULT_CONFIG);
  config.anki.url = `http://127.0.0.1:${address.port}`;
  config.learning.knownWordField = 'Word';
  config.learning.tokenizer = 'intl';

  const result = await analyzeTranscriptLearning(config.anki, config.learning, [
    buildCue('known', '我喜欢学习'),
    buildCue('one-unknown', '我喜欢中文'),
  ]);

  assert.equal(result.annotations.get('known')?.iPlusOne, false);
  assert.deepEqual(result.annotations.get('known')?.unknownWords, []);
  assert.equal(result.annotations.get('one-unknown')?.iPlusOne, true);
  assert.deepEqual(result.annotations.get('one-unknown')?.unknownWords, ['中文']);
});

test('analyzeTranscriptLearning can use bundled Jieba tokenization', async (t) => {
  const notes = [
    createAnkiNote(1, '我'),
    createAnkiNote(2, '喜欢'),
    createAnkiNote(3, '学习'),
  ];
  const server = createFakeAnkiServer(notes);
  await listen(server);
  t.after(() => closeServer(server));

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const config = structuredClone(DEFAULT_CONFIG);
  config.anki.url = `http://127.0.0.1:${address.port}`;
  config.learning.knownWordField = 'Word';
  config.learning.tokenizer = 'jieba';

  const result = await analyzeTranscriptLearning(config.anki, config.learning, [
    buildCue('known', '我喜欢学习'),
    buildCue('one-unknown', '我喜欢中文'),
    buildCue('two-unknown', '我看中文'),
  ]);

  assert.equal(result.annotations.get('known')?.iPlusOne, false);
  assert.deepEqual(result.annotations.get('known')?.unknownWords, []);
  assert.equal(result.annotations.get('one-unknown')?.iPlusOne, true);
  assert.deepEqual(result.annotations.get('one-unknown')?.unknownWords, ['中文']);
  assert.deepEqual(result.annotations.get('one-unknown')?.unknownWordRanges, [{ start: 3, end: 5 }]);
  assert.equal(result.annotations.get('two-unknown')?.iPlusOne, false);
  assert.deepEqual(result.annotations.get('two-unknown')?.unknownWords, ['看', '中文']);
  assert.deepEqual(result.annotations.get('two-unknown')?.unknownWordRanges, [
    { start: 1, end: 2 },
    { start: 2, end: 4 },
  ]);
});

test('analyzeTranscriptLearning can use Baidu LAC tokenization', async (t) => {
  const notes = [
    createAnkiNote(1, '我'),
    createAnkiNote(2, '喜欢'),
    createAnkiNote(3, '学习'),
  ];
  const server = createFakeAnkiServer(notes);
  await listen(server);
  t.after(() => {
    setLacSegmenterFactoryForTesting(null);
    return closeServer(server);
  });

  setLacSegmenterFactoryForTesting(() => ({
    async segmentBatch(texts: string[]) {
      return texts.map((text) => {
        if (text === '我喜欢学习') {
          return ['我', '喜欢', '学习'];
        }
        if (text === '我喜欢中文') {
          return ['我', '喜欢', '中文'];
        }
        if (text === '我看中文') {
          return ['我', '看', '中文'];
        }

        return [text];
      });
    },
    dispose() {},
  }));

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const config = structuredClone(DEFAULT_CONFIG);
  config.anki.url = `http://127.0.0.1:${address.port}`;
  config.learning.knownWordField = 'Word';
  config.learning.tokenizer = 'lac';

  const result = await analyzeTranscriptLearning(config.anki, config.learning, [
    buildCue('known', '我喜欢学习'),
    buildCue('one-unknown', '我喜欢中文'),
    buildCue('two-unknown', '我看中文'),
  ]);

  assert.equal(result.annotations.get('known')?.iPlusOne, false);
  assert.deepEqual(result.annotations.get('known')?.unknownWords, []);
  assert.equal(result.annotations.get('one-unknown')?.iPlusOne, true);
  assert.deepEqual(result.annotations.get('one-unknown')?.unknownWords, ['中文']);
  assert.deepEqual(result.annotations.get('one-unknown')?.unknownWordRanges, [{ start: 3, end: 5 }]);
  assert.equal(result.annotations.get('two-unknown')?.iPlusOne, false);
  assert.deepEqual(result.annotations.get('two-unknown')?.unknownWords, ['看', '中文']);
  assert.deepEqual(result.annotations.get('two-unknown')?.unknownWordRanges, [
    { start: 1, end: 2 },
    { start: 2, end: 4 },
  ]);
});

test('analyzeTranscriptLearning reports missing Baidu LAC Python setup', async (t) => {
  const notes = [createAnkiNote(1, '我')];
  const server = createFakeAnkiServer(notes);
  await listen(server);
  const originalPython = process.env.SENTENCEMINER_LAC_PYTHON;

  t.after(async () => {
    await closeServer(server);
    if (originalPython === undefined) {
      delete process.env.SENTENCEMINER_LAC_PYTHON;
    } else {
      process.env.SENTENCEMINER_LAC_PYTHON = originalPython;
    }
  });

  process.env.SENTENCEMINER_LAC_PYTHON = 'sentenceminer-missing-python-for-lac-tests';

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const config = structuredClone(DEFAULT_CONFIG);
  config.anki.url = `http://127.0.0.1:${address.port}`;
  config.learning.knownWordField = 'Word';
  config.learning.tokenizer = 'lac';

  await assert.rejects(
    () => analyzeTranscriptLearning(config.anki, config.learning, [buildCue('one-unknown', '我喜欢中文')]),
    /Unable to start Baidu LAC tokenizer|Baidu LAC tokenizer process exited/,
  );
});

test('analyzeTranscriptLearning reports missing explicit Jieba assets', async (t) => {
  const notes = [createAnkiNote(1, '我')];
  const server = createFakeAnkiServer(notes);
  await listen(server);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentenceminer-jieba-missing-'));
  const originalRoot = process.env.SENTENCEMINER_JIEBA_ROOT;

  t.after(async () => {
    await closeServer(server);
    await fs.rm(tempRoot, { recursive: true, force: true });
    if (originalRoot === undefined) {
      delete process.env.SENTENCEMINER_JIEBA_ROOT;
    } else {
      process.env.SENTENCEMINER_JIEBA_ROOT = originalRoot;
    }
  });

  process.env.SENTENCEMINER_JIEBA_ROOT = tempRoot;

  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const config = structuredClone(DEFAULT_CONFIG);
  config.anki.url = `http://127.0.0.1:${address.port}`;
  config.learning.knownWordField = 'Word';
  config.learning.tokenizer = 'jieba';

  await assert.rejects(
    () => analyzeTranscriptLearning(config.anki, config.learning, [buildCue('one-unknown', '我喜欢中文')]),
    /Unable to find Jieba tokenizer dictionary/,
  );
});

function buildCue(id: string, text: string): TranscriptCue {
  return {
    id,
    orderIndex: 0,
    sessionId: 'session-1',
    filePath: 'episode.mkv',
    text,
    startMs: 0,
    endMs: 1000,
    playbackTimeMs: 0,
  };
}

function createAnkiNote(noteId: number, word: string) {
  return {
    noteId,
    fields: {
      Word: { value: word },
    },
  };
}

function createFakeAnkiServer(notes: ReturnType<typeof createAnkiNote>[]): http.Server {
  return http.createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const payload = body ? JSON.parse(body) : {};
    const result =
      payload.action === 'findNotes'
        ? notes.map((note) => note.noteId)
        : payload.action === 'notesInfo'
          ? notes.filter((note) => payload.params?.notes?.includes(note.noteId))
          : null;

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result, error: null }));
  });
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}
