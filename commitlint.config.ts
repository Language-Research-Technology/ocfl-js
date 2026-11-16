import type { UserConfig } from '@commitlint/types';

const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  // Dependabot's bodies quote release notes, which break the line-length rules
  ignores: [(message) => /^Signed-off-by: dependabot\[bot\]/m.test(message)],
};

export default config;
