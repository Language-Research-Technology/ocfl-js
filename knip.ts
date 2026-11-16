import type { KnipConfig } from 'knip';

// Mirrors release.config.mjs, which drops these plugins on beta.
const unusedOnBeta = process.env.GITHUB_REF === 'refs/heads/beta' ? ['@semantic-release/changelog', '@semantic-release/git'] : [];

export default {
  // Treat anything tagged @lintignore as intentional.
  tags: ['-lintignore'],
  workspaces: {
    '.': {
      // test/types: type-checked only, by test/tsconfig.json. package-smoke.js: run by smoke-package.sh.
      entry: ['test/types/*.ts', 'scripts/package-smoke.js'],
      // Loaded by semantic-release from the `preset` option, and the tools check-package.sh runs.
      ignoreDependencies: ['conventional-changelog-conventionalcommits', 'publint', 'esbuild', ...unusedOnBeta],
      // A system tool the tests run to make a named pipe.
      ignoreBinaries: ['mkfifo'],
    },
    website: {
      // Type-checked only, by src/examples/tsconfig.json.
      entry: ['src/examples/**/*.ts'],
    },
  },
} satisfies KnipConfig;
