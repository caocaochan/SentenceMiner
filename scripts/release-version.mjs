import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BASELINE_COMMIT_COUNT = 126;
export const BASELINE_VERSION_TENTHS = 1;

export function getReleaseVersionForCommitCount(commitCount) {
  if (!Number.isInteger(commitCount) || commitCount < BASELINE_COMMIT_COUNT) {
    throw new Error(`Commit count must be an integer greater than or equal to ${BASELINE_COMMIT_COUNT}.`);
  }

  return formatVersionTenths(BASELINE_VERSION_TENTHS + commitCount - BASELINE_COMMIT_COUNT);
}

export function readCurrentCommitCount(cwd = process.cwd()) {
  const result = spawnSync('git', ['rev-list', '--count', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(`Failed to read commit count: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  const count = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isInteger(count)) {
    throw new Error(`Git returned an invalid commit count: ${result.stdout.trim()}`);
  }

  return count;
}

function formatVersionTenths(versionTenths) {
  return `${Math.floor(versionTenths / 10)}.${versionTenths % 10}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const commitCount = process.argv[2] === undefined ? readCurrentCommitCount() : Number.parseInt(process.argv[2], 10);
  console.log(getReleaseVersionForCommitCount(commitCount));
}
