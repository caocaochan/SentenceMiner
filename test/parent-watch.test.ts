import test from 'node:test';
import assert from 'node:assert/strict';

import { isProcessAlive, parseParentPidArg, startParentWatch } from '../src/parent-watch.ts';

test('parseParentPidArg returns null when no parent PID is configured', () => {
  assert.equal(parseParentPidArg([]), null);
});

test('parseParentPidArg reads a positive --parent-pid value', () => {
  assert.equal(parseParentPidArg(['--parent-pid', '4242']), 4242);
});

test('parseParentPidArg rejects invalid parent PID values', () => {
  assert.throws(() => parseParentPidArg(['--parent-pid', '0']), /Invalid --parent-pid value/);
  assert.throws(() => parseParentPidArg(['--parent-pid']), /Expected a PID after --parent-pid/);
});

test('isProcessAlive reports the current process as alive', () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test('startParentWatch invokes the callback once the watched process disappears', async () => {
  await new Promise<void>((resolve) => {
    let checks = 0;

    startParentWatch(
      31337,
      () => {
        assert.equal(checks >= 2, true);
        resolve();
      },
      {
        intervalMs: 250,
        isProcessAlive: () => {
          checks += 1;
          return checks < 2;
        },
      },
    );
  });
});

test('startParentWatch treats a reused PID as parent exit', async () => {
  await new Promise<void>((resolve) => {
    let fingerprintReads = 0;

    startParentWatch(
      31337,
      () => {
        assert.equal(fingerprintReads >= 2, true);
        resolve();
      },
      {
        intervalMs: 250,
        identityCheckIntervalMs: 250,
        isProcessAlive: () => true,
        getProcessFingerprint: () => {
          fingerprintReads += 1;
          return fingerprintReads < 2 ? 'original-process' : 'reused-process';
        },
      },
    );
  });
});
