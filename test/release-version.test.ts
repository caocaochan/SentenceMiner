import test from 'node:test';
import assert from 'node:assert/strict';

import { getReleaseVersionForCommitCount } from '../scripts/release-version.mjs';

test('release version starts at 0.1 for the baseline commit count', () => {
  assert.equal(getReleaseVersionForCommitCount(126), '0.1');
});

test('release version increments by 0.1 for the next commit', () => {
  assert.equal(getReleaseVersionForCommitCount(127), '0.2');
});

test('release version rolls over to 1.0 after ten tenths', () => {
  assert.equal(getReleaseVersionForCommitCount(135), '1.0');
});
