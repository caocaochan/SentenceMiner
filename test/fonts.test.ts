import test from 'node:test';
import assert from 'node:assert/strict';

import { listInstalledFonts } from '../src/fonts.ts';

test('listInstalledFonts parses, dedupes, and sorts installed font names on Windows', async () => {
  const fonts = await listInstalledFonts({
    platform: 'win32',
    execFileImpl: async () => ({
      stdout: ['zeta', 'Alpha', '  ', 'alpha', 'Beta'].join('\n'),
      stderr: '',
    }),
  });

  assert.deepEqual(fonts, ['Alpha', 'Beta', 'zeta']);
});

test('listInstalledFonts returns an empty list when font discovery fails', async () => {
  const fonts = await listInstalledFonts({
    platform: 'win32',
    execFileImpl: async () => {
      throw new Error('boom');
    },
  });

  assert.deepEqual(fonts, []);
});

test('listInstalledFonts returns an empty list on non-Windows platforms', async () => {
  const fonts = await listInstalledFonts({
    platform: 'linux',
    execFileImpl: async () => {
      throw new Error('should not run');
    },
  });

  assert.deepEqual(fonts, []);
});
