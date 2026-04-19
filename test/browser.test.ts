import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAppUrl, buildBrowserLaunchCommand, normalizeBrowserHost } from '../src/browser.ts';

test('normalizeBrowserHost rewrites wildcard listen addresses for browser use', () => {
  assert.equal(normalizeBrowserHost('0.0.0.0'), '127.0.0.1');
  assert.equal(normalizeBrowserHost('::'), '127.0.0.1');
  assert.equal(normalizeBrowserHost(''), '127.0.0.1');
});

test('buildAppUrl uses a browser-safe localhost address', () => {
  assert.equal(
    buildAppUrl({
      host: '0.0.0.0',
      port: 8766,
    }),
    'http://127.0.0.1:8766',
  );
});

test('buildBrowserLaunchCommand uses cmd start on Windows', () => {
  assert.deepEqual(buildBrowserLaunchCommand('http://127.0.0.1:8766', 'win32'), {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/c', 'start', '', 'http://127.0.0.1:8766'],
  });
});

test('buildBrowserLaunchCommand uses open on macOS', () => {
  assert.deepEqual(buildBrowserLaunchCommand('http://127.0.0.1:8766', 'darwin'), {
    command: 'open',
    args: ['http://127.0.0.1:8766'],
  });
});

test('buildBrowserLaunchCommand uses xdg-open on Linux', () => {
  assert.deepEqual(buildBrowserLaunchCommand('http://127.0.0.1:8766', 'linux'), {
    command: 'xdg-open',
    args: ['http://127.0.0.1:8766'],
  });
});

test('buildBrowserLaunchCommand returns null on unsupported platforms', () => {
  assert.equal(buildBrowserLaunchCommand('http://127.0.0.1:8766', 'aix'), null);
});
