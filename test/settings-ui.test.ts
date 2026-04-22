import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('settings dialog exposes the i+1 tokenizer select', async () => {
  const html = await fs.readFile('web/index.html', 'utf8');

  assert.match(html, /id="settings-tokenizer"/);
  assert.match(html, /<option value="jieba">Jieba<\/option>/);
  assert.match(html, /<option value="lac">Baidu LAC<\/option>/);
  assert.match(html, /<option value="intl">Intl\.Segmenter<\/option>/);
});

test('settings form hydrates and submits the tokenizer value', async () => {
  const app = await fs.readFile('web/app.js', 'utf8');

  assert.match(app, /settingsTokenizer: document\.getElementById\('settings-tokenizer'\)/);
  assert.match(app, /populateTokenizerSelect\(settings\.learning\?\.tokenizer \?\? 'jieba'\)/);
  assert.match(app, /tokenizer: elements\.settingsTokenizer\.value/);
});
