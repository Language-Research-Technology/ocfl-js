# Releasing

`@ocfl/ocfl-fs` is published to npm by [semantic-release](https://semantic-release.gitbook.io/)
from the [Publish Packages](.github/workflows/publish.yml) workflow. Each release is tagged
`v<version>`.

The version is derived from the [Conventional Commits](https://www.conventionalcommits.org/) since
the last release, so commit messages matter: `fix:` is a patch, `feat:` a minor, and `!` or a
`BREAKING CHANGE:` footer a major.

| Channel | npm dist-tag | Versions       | Published                             |
| ------- | ------------ | -------------- | ------------------------------------- |
| Beta    | `beta`       | `1.0.0-beta.1` | Automatically on every push to `main` |
| Stable  | `latest`     | `1.0.0`        | Manually, from `main`                 |

Every run executes the full test suite first. If anything fails, nothing is published. npm only
accepts publishes from this workflow's `npm-publish` environment, through trusted publishing with
provenance, so there is no way to release around it. The environment only allows deployments from
`main` and `beta`.

## Stable releases

1. Go to **Actions → Publish Packages → Run workflow** and leave the branch as `main` (runs from
   anything other than `main` or `beta` are skipped).
2. Leave **Dry run** ticked and run it. Check the logs for the version, the release notes and the
   contents of each package's tarball.
3. Run it again with **Dry run** unticked.

semantic-release tags the release, publishes `@ocfl/ocfl-fs` under `latest` with `pnpm publish`,
creates a GitHub release and commits the updated `CHANGELOG.md` and the package's `package.json`
back to `main`.

## Prereleases

Every push to `main` that passes the tests publishes a prerelease of `@ocfl/ocfl-fs` under the `beta`
dist-tag, as long as it contains a releasable commit (`fix:`, `feat:` or a breaking change) since
the last release. Consumers install it with `pnpm add @ocfl/ocfl-fs@beta`; `latest` is
untouched.

CI fast-forwards the `beta` branch to the tested commit, then dispatches Publish Packages on `beta`,
which runs the tests again and publishes. It has to run on `beta` itself: semantic-release only cuts
prereleases from a prerelease branch, and npm rejects provenance from a run on a different branch.
Prereleases get a GitHub release marked as a prerelease but aren't added to `CHANGELOG.md`, and
nothing is committed back, which keeps `beta` a fast-forward of `main`.

- **Don't push to `beta`.** CI owns it. If it gains commits that aren't on `main`, the fast-forward
  fails, a publish run on `beta` refuses to release, and no prereleases are published until it's
  reset to `main`.
- Stable releases need no `beta` housekeeping: the next releasable push to `main` starts the next
  prerelease line (e.g. `1.1.0-beta.1` after `1.0.0`).
