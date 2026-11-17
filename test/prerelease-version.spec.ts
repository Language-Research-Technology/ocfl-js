import assert from 'node:assert';
import { describe, it } from 'node:test';
import { nextPrereleaseVersion } from '../scripts/prerelease-version.ts';

describe('nextPrereleaseVersion', () => {
  it('starts at beta.1 when the version has no prerelease tag', () => {
    assert.strictEqual(nextPrereleaseVersion('1.2.5', []), '1.2.5-beta.1');
  });

  it('follows the highest number, compared as a number', () => {
    const tags = ['v1.2.5-beta.1', 'v1.2.5-beta.10', 'v1.2.5-beta.2'];
    assert.strictEqual(nextPrereleaseVersion('1.2.5', tags), '1.2.5-beta.11');
  });

  it('ignores tags that are not a beta of the same version', () => {
    const tags = ['v1.2.4-beta.7', 'v1.2.50-beta.3', 'v1.2.5', 'v1.2.5-beta.4.1', 'v1.2.5-beta.2'];
    assert.strictEqual(nextPrereleaseVersion('1.2.5', tags), '1.2.5-beta.3');
  });
});
