/**
 * Stable releases only; scripts/publish-prerelease.ts publishes prereleases.
 *
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: ['main'],
  preset: 'conventionalcommits',
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    '@semantic-release/changelog',
    // Checks npm access (trusted publishing) before the tag is pushed, unlike a shell publish
    '@semantic-release/npm',
    // Before github, whose success step (issue comments) can fail the run
    [
      '@semantic-release/exec',
      {
        // Tells publish.yml which tag to build the site from; GITHUB_OUTPUT is unset outside Actions
        successCmd: `if [ -n "$GITHUB_OUTPUT" ]; then echo "tag=\${nextRelease.gitTag}" >> "$GITHUB_OUTPUT"; fi`,
      },
    ],
    '@semantic-release/github',
    [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'package.json'],
      },
    ],
  ],
};
