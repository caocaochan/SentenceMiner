import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAppRoot, resolveConfigPath } from '../src/config.ts';

test('resolveAppRoot falls back to the current working directory in development', (t) => {
  const originalRoot = process.env.SENTENCEMINER_ROOT;
  delete process.env.SENTENCEMINER_ROOT;
  t.after(() => {
    if (originalRoot === undefined) {
      delete process.env.SENTENCEMINER_ROOT;
      return;
    }

    process.env.SENTENCEMINER_ROOT = originalRoot;
  });

  const root = resolveAppRoot('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\CaoCao\\Downloads\\SentenceMiner');
  assert.equal(root, 'C:\\Users\\CaoCao\\Downloads\\SentenceMiner');
});

test('resolveAppRoot uses the executable directory for packaged helpers', (t) => {
  const originalRoot = process.env.SENTENCEMINER_ROOT;
  delete process.env.SENTENCEMINER_ROOT;
  t.after(() => {
    if (originalRoot === undefined) {
      delete process.env.SENTENCEMINER_ROOT;
      return;
    }

    process.env.SENTENCEMINER_ROOT = originalRoot;
  });

  const root = resolveAppRoot('C:\\mpv\\scripts\\sentenceminer-helper\\SentenceMinerHelper.exe', 'C:\\Videos');
  assert.equal(root, 'C:\\mpv\\scripts\\sentenceminer-helper');
});

test('resolveConfigPath defaults next to the packaged helper', (t) => {
  const originalConfig = process.env.SENTENCEMINER_CONFIG;
  delete process.env.SENTENCEMINER_CONFIG;
  t.after(() => {
    if (originalConfig === undefined) {
      delete process.env.SENTENCEMINER_CONFIG;
      return;
    }

    process.env.SENTENCEMINER_CONFIG = originalConfig;
  });

  const configPath = resolveConfigPath([], 'C:\\mpv\\scripts\\sentenceminer-helper');
  assert.equal(configPath, 'C:\\mpv\\scripts\\sentenceminer-helper\\sentenceminer.config.json');
});
