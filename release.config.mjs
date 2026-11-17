/**
 * Stable releases only; scripts/publish-prerelease.ts publishes prereleases.
 * Nothing is committed back to main: the release notes live on the GitHub release, and the npm plugin
 * sets package.json's version only in the published package.
 *
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: ['main'],
  preset: 'conventionalcommits',
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
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
  ],
};
