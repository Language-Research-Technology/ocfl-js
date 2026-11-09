const isPrerelease = process.env.GITHUB_REF === 'refs/heads/beta';

/**
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: ['main', { name: 'beta', prerelease: true }],
  preset: 'conventionalcommits',
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    // Prereleases don't commit back, so CI can keep beta fast-forwarded to main
    !isPrerelease && '@semantic-release/changelog',
    [
      '@semantic-release/exec',
      {
        // At a git root, pnpm version would otherwise commit and create the tag semantic-release owns
        prepareCmd: `pnpm version \${nextRelease.version} --no-git-checks --no-git-tag-version`,
        publishCmd: `pnpm publish --tag \${nextRelease.channel || 'latest'} --no-git-checks`,
      },
    ],
    '@semantic-release/github',
    !isPrerelease && [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'package.json'],
      },
    ],
  ].filter(Boolean),
};
