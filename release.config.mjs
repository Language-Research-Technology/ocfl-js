const isPrerelease = process.env.GITHUB_REF === 'refs/heads/beta';

const packages = ['@ocfl/ocfl', '@ocfl/ocfl-fs'];
const filters = packages.map((name) => `--filter ${name}`).join(' ');
// `pnpm publish` rather than @semantic-release/npm, which can't rewrite `workspace:*`
const publish = (name) => `pnpm --filter ${name} publish --tag \${nextRelease.channel || 'latest'} --access public --no-git-checks`;

/**
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: ['main', { name: 'beta', prerelease: true }],
  tagFormat: `v\${version}`,
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'conventionalcommits',
      },
    ],
    [
      '@semantic-release/release-notes-generator',
      {
        preset: 'conventionalcommits',
      },
    ],
    // Prereleases don't commit back, so CI can keep beta fast-forwarded to main
    !isPrerelease && '@semantic-release/changelog',
    [
      '@semantic-release/exec',
      {
        prepareCmd: `pnpm ${filters} version \${nextRelease.version} --no-git-checks`,
        publishCmd: packages.map(publish).join(' && '),
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
