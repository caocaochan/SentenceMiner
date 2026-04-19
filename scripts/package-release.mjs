import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const distRoot = path.join(repoRoot, 'dist');
const packageRoot = path.join(distRoot, 'SentenceMiner');

const includedEntries = [
  'README.md',
  'package.json',
  'sentenceminer.config.example.json',
  'start-helper.cmd',
  'start-helper.sh',
  'mpv',
  'script-opts',
  'src',
  'web',
];

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(packageRoot, { recursive: true });

for (const entry of includedEntries) {
  const sourcePath = path.join(repoRoot, entry);
  const destinationPath = path.join(packageRoot, entry);
  await fs.cp(sourcePath, destinationPath, {
    recursive: true,
    force: true,
  });
}

console.log(`Packaged release files into ${packageRoot}`);
