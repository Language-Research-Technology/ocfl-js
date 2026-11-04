// `pnpm publish` rather than @semantic-release/npm, which can't rewrite `workspace:*`
const packages = ['@ocfl/ocfl', '@ocfl/ocfl-fs'];
const filters = packages.map((name) => `--filter ${name}`).join(' ');
const publish = (name) => `pnpm --filter ${name} publish --tag \${nextRelease.channel || 'latest'} --access public --no-git-checks`;

/**
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: ['main'],
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
    '@semantic-release/changelog',
    [
      '@semantic-release/exec',
      {
        prepareCmd: `pnpm ${filters} version \${nextRelease.version} --no-git-checks`,
        publishCmd: packages.map(publish).join(' && '),
      },
    ],
    '@semantic-release/github',
    [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'ocfl/package.json', 'ocfl-fs/package.json'],
      },
    ],
  ],
};
