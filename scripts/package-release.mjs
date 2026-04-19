import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const distRoot = path.join(repoRoot, 'dist');
const buildRoot = path.join(distRoot, 'build');
const packageRoot = path.join(distRoot, 'SentenceMiner');
const helperBuildRoot = path.join(buildRoot, 'helper');
const helperSourceRoot = path.join(packageRoot, 'mpv', 'scripts', 'sentenceminer-helper');

if (process.platform !== 'win32') {
  throw new Error('Windows release packaging is required for SentenceMiner-latest.zip.');
}

run(process.execPath, [path.join(repoRoot, 'scripts', 'build-helper.mjs')], 'build the helper executable');

await fs.rm(packageRoot, { recursive: true, force: true });
await fs.mkdir(helperSourceRoot, { recursive: true });
await fs.mkdir(path.join(packageRoot, 'mpv', 'script-opts'), { recursive: true });

await copyIntoPackage('README.md', 'README.md');
await copyIntoPackage('mpv/sentenceminer.lua', 'mpv/scripts/sentenceminer.lua');
await copyIntoPackage('script-opts/sentenceminer.conf.example', 'mpv/script-opts/sentenceminer.conf.example');
await copyIntoPackage(
  path.join(helperBuildRoot, 'SentenceMinerHelper.exe'),
  'mpv/scripts/sentenceminer-helper/SentenceMinerHelper.exe',
);
await copyIntoPackage('web', 'mpv/scripts/sentenceminer-helper/web');
await copyIntoPackage(
  'sentenceminer.config.example.json',
  'mpv/scripts/sentenceminer-helper/sentenceminer.config.example.json',
);

console.log(`Packaged release files into ${packageRoot}`);

async function copyIntoPackage(sourceRelativePath, destinationRelativePath) {
  const sourcePath = path.isAbsolute(sourceRelativePath)
    ? sourceRelativePath
    : path.join(repoRoot, sourceRelativePath);
  const destinationPath = path.join(packageRoot, destinationRelativePath);

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.cp(sourcePath, destinationPath, {
    recursive: true,
    force: true,
  });
}

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
