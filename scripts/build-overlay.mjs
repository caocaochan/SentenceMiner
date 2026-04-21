import fs from 'node:fs/promises';
import path from 'node:path';

import * as packagerModule from '@electron/packager';
import { build } from 'esbuild';

const repoRoot = process.cwd();
const buildRoot = path.join(repoRoot, 'dist', 'build', 'overlay');
const appRoot = path.join(buildRoot, 'app');
const appOutputRoot = path.join(buildRoot, 'packaged');

if (process.platform !== 'win32') {
  throw new Error('SentenceMinerOverlay.exe packaging currently supports Windows builds only.');
}

await fs.rm(buildRoot, { recursive: true, force: true });
await fs.mkdir(appRoot, { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(repoRoot, 'src', 'overlay-main.ts')],
    outfile: path.join(appRoot, 'overlay-main.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    sourcemap: false,
    minify: false,
  }),
  build({
    entryPoints: [path.join(repoRoot, 'src', 'overlay-preload.ts')],
    outfile: path.join(appRoot, 'overlay-preload.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    sourcemap: false,
    minify: false,
  }),
]);

await fs.writeFile(
  path.join(appRoot, 'package.json'),
  JSON.stringify(
    {
      name: 'sentenceminer-overlay',
      version: '0.1.0',
      main: 'overlay-main.cjs',
      private: true,
    },
    null,
    2,
  ),
  'utf8',
);

await packager({
  dir: appRoot,
  out: appOutputRoot,
  name: 'SentenceMinerOverlay',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  asar: false,
  prune: true,
  quiet: false,
});

console.log(`Built overlay executable under ${appOutputRoot}`);

function packager(options) {
  const candidate = packagerModule.default ?? packagerModule.packager;
  if (typeof candidate !== 'function') {
    throw new Error('@electron/packager did not expose a callable packager function.');
  }

  return candidate(options);
}
