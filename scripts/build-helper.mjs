import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';

const repoRoot = process.cwd();
const buildRoot = path.join(repoRoot, 'dist', 'build', 'helper');
const bundlePath = path.join(buildRoot, 'SentenceMinerHelper.cjs');
const seaConfigPath = path.join(buildRoot, 'sea-config.json');
const seaBlobPath = path.join(buildRoot, 'sea-prep.blob');
const helperExePath = path.join(buildRoot, 'SentenceMinerHelper.exe');
const postjectBinary = path.join(repoRoot, 'node_modules', '.bin', 'postject.cmd');

if (process.platform !== 'win32') {
  throw new Error('SentenceMinerHelper.exe packaging currently supports Windows builds only.');
}

await fs.rm(buildRoot, { recursive: true, force: true });
await fs.mkdir(buildRoot, { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, 'src', 'server.ts')],
  outfile: bundlePath,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  minify: false,
});

await fs.writeFile(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: seaBlobPath,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

run(process.execPath, ['--experimental-sea-config', seaConfigPath], 'generate SEA blob');
await fs.copyFile(process.execPath, helperExePath);
run(
  postjectBinary,
  [
    helperExePath,
    'NODE_SEA_BLOB',
    seaBlobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  'inject SEA blob',
  { shell: true },
);

console.log(`Built helper executable at ${helperExePath}`);

function run(command, args, step, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: repoRoot,
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`Failed to ${step}.`);
  }
}
