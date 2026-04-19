export interface ParentWatchOptions {
  intervalMs?: number;
  isProcessAlive?: (pid: number) => boolean;
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

export function startParentWatch(
  parentPid: number,
  onParentExit: () => void,
  options: ParentWatchOptions = {},
): () => void {
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    throw new Error(`Expected a positive parent PID, received ${String(parentPid)}.`);
  }

  const intervalMs = Math.max(250, options.intervalMs ?? 1000);
  const checkProcessAlive = options.isProcessAlive ?? isProcessAlive;
  let stopped = false;

  const tick = () => {
    if (stopped) {
      return;
    }

    if (!checkProcessAlive(parentPid)) {
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
