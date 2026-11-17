import { execFileSync } from 'node:child_process';
import semanticRelease from 'semantic-release';
import { nextPrereleaseVersion } from './prerelease-version.ts';

const dryRun = process.argv.includes('--dry-run');

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'inherit' });
}

function read(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8' });
}

// Only the analyzer, so the dry run checks neither npm nor GitHub access.
// origin, not package.json's https URL, so a local dry run can use ssh.
const result = await semanticRelease({
  dryRun: true,
  plugins: ['@semantic-release/commit-analyzer'],
  repositoryUrl: read('git', ['remote', 'get-url', 'origin']).trim(),
});
if (!result) {
  console.error('semantic-release made no release; its log above says why. Nothing was published.');
  process.exit(1);
}

const version = nextPrereleaseVersion(result.nextRelease.version, read('git', ['tag', '--list']).split('\n'));
const tag = `v${version}`;

if (dryRun) {
  console.log(`Would publish ${version} to the beta dist-tag and tag it ${tag}`);
  run('pnpm', ['pack', '--dry-run']);
} else {
  run('pnpm', ['version', version, '--no-git-checks', '--no-git-tag-version']);
  run('pnpm', ['publish', '--tag', 'beta', '--no-git-checks']);
  // After the publish, so a failed publish leaves no tag
  run('git', ['tag', tag]);
  run('git', ['push', 'origin', tag]);
  console.log(`Published ${version} to the beta dist-tag and tagged it ${tag}`);
}
