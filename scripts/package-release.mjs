import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

const repoRoot = process.cwd();
const distRoot = path.join(repoRoot, 'dist');
const buildRoot = path.join(distRoot, 'build');
const packageRoot = path.join(distRoot, 'SentenceMiner');
const helperBuildRoot = path.join(buildRoot, 'helper');
const helperSourceRoot = path.join(packageRoot, 'scripts', 'sentenceminer-helper');

if (process.platform !== 'win32') {
  throw new Error('Windows release packaging is required for SentenceMiner-latest.zip.');
}

run(process.execPath, [path.join(repoRoot, 'scripts', 'build-helper.mjs')], 'build the helper executable');
run(process.execPath, [path.join(repoRoot, 'scripts', 'build-pkuseg-tokenizer.mjs')], 'build the Pkuseg tokenizer executable');

await fs.rm(packageRoot, { recursive: true, force: true });
await fs.mkdir(helperSourceRoot, { recursive: true });
await fs.mkdir(path.join(packageRoot, 'script-opts'), { recursive: true });

await copyIntoPackage('packaging/README.md', 'README.md');
await copyIntoPackage('mpv/sentenceminer.lua', 'scripts/sentenceminer.lua');
await copyIntoPackage(
  path.join(helperBuildRoot, 'SentenceMinerHelper.exe'),
  'scripts/sentenceminer-helper/SentenceMinerHelper.exe',
);
await copyBundledFfmpeg();
await copyBundledPkuseg();
await copyIntoPackage('web', 'scripts/sentenceminer-helper/web');
await writePackagedMpvConfig();
await writePackagedHelperEntryPoint();

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

async function writePackagedMpvConfig() {
  const sourcePath = path.join(repoRoot, 'script-opts', 'sentenceminer.conf');
  const destinationPath = path.join(packageRoot, 'script-opts', 'sentenceminer.conf');
  const source = await fs.readFile(sourcePath, 'utf8');

  const packaged = source
    .replace(/^helper_exe_path=.*$/m, 'helper_exe_path=sentenceminer-helper/SentenceMinerHelper.exe')
    .replace(/^ffmpeg_path=.*$/m, 'ffmpeg_path=../scripts/sentenceminer-helper/ffmpeg.exe')
    .replace(/^bind_default_key=.*$/m, 'bind_default_key=yes')
    .replace(/^default_key=.*$/m, 'default_key=Ctrl+m');

  await fs.writeFile(destinationPath, packaged, 'utf8');
}

async function writePackagedHelperEntryPoint() {
  const destinationPath = path.join(packageRoot, 'scripts', 'sentenceminer-helper', 'main.lua');
  const source = "-- Placeholder entry point so mpv treats this helper asset folder as a valid script directory.\n";

  await fs.writeFile(destinationPath, source, 'utf8');
}

async function copyBundledFfmpeg() {
  if (typeof ffmpegStatic !== 'string' || ffmpegStatic === '') {
    throw new Error('ffmpeg-static did not provide a Windows ffmpeg binary path.');
  }

  const ffmpegDirectory = path.dirname(ffmpegStatic);
  await copyIntoPackage(ffmpegStatic, 'scripts/sentenceminer-helper/ffmpeg.exe');
  await copyIntoPackage(path.join(ffmpegDirectory, 'ffmpeg.exe.LICENSE'), 'scripts/sentenceminer-helper/ffmpeg.exe.LICENSE');
  await copyIntoPackage(path.join(ffmpegDirectory, 'ffmpeg.exe.README'), 'scripts/sentenceminer-helper/ffmpeg.exe.README');
}

async function copyBundledPkuseg() {
  const pkusegBuildRoot = path.join(buildRoot, 'pkuseg', 'PkusegTokenizer');
  await copyIntoPackage(pkusegBuildRoot, 'scripts/sentenceminer-helper/pkuseg');
  await writePkusegAttribution();
}

async function writePkusegAttribution() {
  const destinationPath = path.join(packageRoot, 'scripts', 'sentenceminer-helper', 'pkuseg', 'PKUSEG-ATTRIBUTION.txt');
  const source = [
    'Pkuseg tokenizer',
    '',
    'SentenceMiner bundles pkuseg-python for Chinese word segmentation.',
    'Project: https://github.com/lancopku/pkuseg-python',
    'PyPI: https://pypi.org/project/pkuseg/',
    '',
    'The bundled tokenizer executable is built from scripts/pkuseg-tokenizer.py with PyInstaller.',
    'It includes the pkuseg default model and runtime dependencies so end users do not need Python, pip, NumPy, or pkuseg installed.',
    '',
  ].join('\n');

  await fs.writeFile(destinationPath, source, 'utf8');
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
