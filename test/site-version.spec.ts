import assert from 'node:assert';
import { describe, it } from 'node:test';
import { siteVersion } from '../website/site-version.ts';

describe('siteVersion', () => {
  it('shows the release tag the site was built from', () => {
    assert.strictEqual(siteVersion('v1.2.5'), 'v1.2.5');
  });

  it('shows main for a build with no tag', () => {
    assert.strictEqual(siteVersion(undefined), 'main');
  });

  it('shows main when a manual deploy passes an empty ref', () => {
    assert.strictEqual(siteVersion(''), 'main');
  });
});
