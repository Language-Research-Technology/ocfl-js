const isPrerelease = process.env.GITHUB_REF === 'refs/heads/beta';

const filters = ['@ocfl/ocfl', '@ocfl/ocfl-fs'].map((name) => `--filter ${name}`).join(' ');

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
      // `pnpm publish` rather than @semantic-release/npm, which can't rewrite `workspace:` ranges
      '@semantic-release/exec',
      {
        prepareCmd: `pnpm ${filters} version \${nextRelease.version} --no-git-checks`,
        publishCmd: `pnpm ${filters} publish --tag \${nextRelease.channel || 'latest'} --no-git-checks`,
      },
    ],
    '@semantic-release/github',
    !isPrerelease && [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'ocfl/package.json', 'ocfl-fs/package.json'],
      },
    ],
  ].filter(Boolean),
};
