import { execFileSync } from 'node:child_process';

export interface ParentWatchOptions {
  intervalMs?: number;
  identityCheckIntervalMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  getProcessFingerprint?: (pid: number) => string | null;
}

export function parseParentPidArg(argv: string[]): number | null {
  const flagIndex = argv.findIndex((arg) => arg === '--parent-pid');
  if (flagIndex === -1) {
    return null;
  }

  const rawPid = argv[flagIndex + 1];
  if (!rawPid) {
    throw new Error('Expected a PID after --parent-pid.');
  }

  const parentPid = Number.parseInt(rawPid, 10);
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    throw new Error(`Invalid --parent-pid value: ${rawPid}`);
  }

  return parentPid;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function getProcessFingerprint(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    switch (process.platform) {
      case 'win32':
        return readCommandOutput('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue; if ($null -eq $process) { exit 1 }; [Console]::Out.Write($process.CreationDate)`,
        ]);
      case 'darwin':
      case 'linux':
        return readCommandOutput('ps', ['-o', 'lstart=', '-p', String(pid)]);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function startParentWatch(
  parentPid: number,
  onParentExit: () => void,
  options: ParentWatchOptions = {},
): () => void {
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    throw new Error(`Expected a positive parent PID, received ${String(parentPid)}.`);
  }

  const intervalMs = Math.max(250, options.intervalMs ?? 1000);
  const identityCheckIntervalMs = Math.max(
    intervalMs,
    options.identityCheckIntervalMs ?? Math.max(intervalMs * 5, 5000),
  );
  const checkProcessAlive = options.isProcessAlive ?? isProcessAlive;
  const readProcessFingerprint = options.getProcessFingerprint ?? getProcessFingerprint;
  let stopped = false;
  let expectedFingerprint = readProcessFingerprint(parentPid);
  let nextIdentityCheckAt = 0;

  const tick = () => {
    if (stopped) {
      return;
    }

    if (!checkProcessAlive(parentPid)) {
      stopped = true;
      clearInterval(interval);
      onParentExit();
      return;
    }

    const now = Date.now();
    if (now < nextIdentityCheckAt) {
      return;
    }

    nextIdentityCheckAt = now + identityCheckIntervalMs;
    const currentFingerprint = readProcessFingerprint(parentPid);
    if (!expectedFingerprint) {
      expectedFingerprint = currentFingerprint;
      return;
    }

    if (currentFingerprint && currentFingerprint !== expectedFingerprint) {
      stopped = true;
      clearInterval(interval);
      onParentExit();
    }
  };

  const interval = setInterval(tick, intervalMs);
  interval.unref?.();
  tick();

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

function readCommandOutput(command: string, args: string[]): string | null {
  const output = execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();

  return output || null;
}
