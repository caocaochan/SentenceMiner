import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const buildRoot = path.join(repoRoot, 'dist', 'build', 'pkuseg');
const workRoot = path.join(buildRoot, 'work');
const specRoot = path.join(buildRoot, 'spec');
const tokenizerSourcePath = path.join(repoRoot, 'scripts', 'pkuseg-tokenizer.py');
const pythonCommand = process.env.PYTHON || 'python';

if (process.platform !== 'win32') {
  throw new Error('Pkuseg tokenizer packaging currently supports Windows builds only.');
}

await fs.rm(buildRoot, { recursive: true, force: true });
await fs.mkdir(buildRoot, { recursive: true });

run(
  pythonCommand,
  [
    '-m',
    'PyInstaller',
    '--noconfirm',
    '--clean',
    '--onedir',
    '--name',
    'PkusegTokenizer',
    '--distpath',
    buildRoot,
    '--workpath',
    workRoot,
    '--specpath',
    specRoot,
    '--collect-data',
    'pkuseg',
    '--collect-binaries',
    'pkuseg',
    '--collect-submodules',
    'pkuseg',
    tokenizerSourcePath,
  ],
  'build the Pkuseg tokenizer executable',
);

console.log(`Built Pkuseg tokenizer at ${path.join(buildRoot, 'PkusegTokenizer')}`);

function run(command, args, step) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: repoRoot,
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(`Failed to ${step}.`);
  }
}
