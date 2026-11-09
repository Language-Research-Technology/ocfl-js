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
        prepareCmd: `pnpm --filter @ocfl/ocfl-fs version \${nextRelease.version} --no-git-checks`,
        publishCmd: `pnpm --filter @ocfl/ocfl-fs publish --tag \${nextRelease.channel || 'latest'} --no-git-checks`,
      },
    ],
    '@semantic-release/github',
    !isPrerelease && [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'ocfl-fs/package.json'],
      },
    ],
  ].filter(Boolean),
};
