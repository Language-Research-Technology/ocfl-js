# Releasing

`@ocfl/ocfl` and `@ocfl/ocfl-fs` are published to npm by
[semantic-release](https://semantic-release.gitbook.io/) from the
[Publish Packages](.github/workflows/publish.yml) workflow. Both packages are always released
together at the same version, tagged `v<version>`. `@ocfl/ocfl-tests` is private and never
published.

The version is derived from the [Conventional Commits](https://www.conventionalcommits.org/) since
the last release, so commit messages matter: `fix:` is a patch, `feat:` a minor, and `!` or a
`BREAKING CHANGE:` footer a major.

| Channel | npm dist-tag | Versions | Published             |
| ------- | ------------ | -------- | --------------------- |
| Stable  | `latest`     | `1.0.0`  | Manually, from `main` |

Every run executes the full test suite first. If anything fails, nothing is published. npm only
accepts publishes from this workflow, through trusted publishing with provenance, so there is no
way to release around it.

## Stable releases

1. Go to **Actions → Publish Packages → Run workflow** and leave the branch as `main` (runs from
   anything other than `main` or `beta` are skipped).
2. Leave **Dry run** ticked and run it. Check the logs for the version, the release notes and the
   contents of each package's tarball.
3. Run it again with **Dry run** unticked.

semantic-release tags the release, publishes `@ocfl/ocfl` and then `@ocfl/ocfl-fs` under `latest`
with `pnpm publish` (which replaces `@ocfl/ocfl-fs`'s `workspace:*` dependency with the released
version), creates a GitHub release and commits the updated `CHANGELOG.md` and both packages'
`package.json` back to `main`.
