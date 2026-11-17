# Releasing

`@ocfl/ocfl-fs` is published to npm from the [Publish Packages](.github/workflows/publish.yml)
workflow. Nothing is published unless someone runs it, and it runs only from `main`.

The version is derived from the [Conventional Commits](https://www.conventionalcommits.org/) since
the last stable release, so commit messages matter: `fix:` is a patch, `feat:` a minor, and `!` or a
`BREAKING CHANGE:` footer a major.

| Release    | npm dist-tag | Version        | Git tag         | GitHub release | `CHANGELOG.md` | Docs site |
| ---------- | ------------ | -------------- | --------------- | -------------- | -------------- | --------- |
| Stable     | `latest`     | `1.2.5`        | `v1.2.5`        | Yes            | Yes            | Deployed  |
| Prerelease | `beta`       | `1.2.5-beta.1` | `v1.2.5-beta.1` | No             | No             | Unchanged |

Every run executes the full test suite first. If anything fails, nothing is published. npm only
accepts publishes from this workflow's `npm-publish` environment, through trusted publishing with
provenance, so there is no way to release around it. The environment only allows deployments from
`main`.

## Stable releases

Before the first stable release, remove `@beta` and the note about it from the install commands in `README.md` and `website/src/content/docs/guides/getting-started.mdx`.

1. Go to **Actions → Publish Packages → Run workflow**, leave the branch as `main` (a run from any
   other branch fails without publishing) and choose **stable**.
2. Leave **Dry run** ticked and run it. Check the logs for the version, the release notes and the
   contents of the package's tarball. The dry run also checks that npm accepts this workflow's
   trusted publishing.
3. Run it again with **Dry run** unticked.

semantic-release checks npm access, commits the updated `CHANGELOG.md` and `package.json` back to
`main`, tags the release, publishes `@ocfl/ocfl-fs` under `latest`, creates a GitHub release and
comments on the issues and pull requests it contains.

## Prereleases

Cut a prerelease when consumers need to try a change before it reaches `latest`: for example, a
change to behaviour they depend on, or a fix they want to check against their own data.

1. Go to **Actions → Publish Packages → Run workflow**, leave the branch as `main` and choose
   **prerelease**.
2. Leave **Dry run** ticked and run it. The log shows the version it would publish and the package
   contents. `pnpm publish:prerelease --dry-run` shows the same on an up-to-date local `main`.
3. Run it again with **Dry run** unticked.

The version is the next stable version semantic-release would cut, with `-beta.N` added: `N` is one
more than the highest existing `v<version>-beta.N` tag, or 1 if there is none. The run publishes it
under the `beta` dist-tag, then pushes its git tag, so every prerelease can be traced to its commit.
It creates no GitHub release, changes no files on `main` and doesn't deploy the docs site. If there
are no releasable commits since the last stable release, it fails without publishing.

Consumers install it with `pnpm add @ocfl/ocfl-fs@beta`. `latest` is untouched, and a range like
`^1.2.4` never resolves to a prerelease. semantic-release ignores prerelease tags when it works out
the next stable version, so they don't change it.

If the publish fails, no tag is pushed; fix the cause and run it again. If the publish succeeds but
the tag push fails, a rerun picks the same version and npm refuses it. Push the tag by hand instead:
`git tag v<version> <commit> && git push origin v<version>`, with the commit from the run's log.

## Documentation site

The [documentation site](https://language-research-technology.github.io/ocfl-js/) is deployed to
GitHub Pages by Publish Packages after every stable release, built from the release's tag, and can
also be deployed by hand from `main`. A prerelease, a dry run, or a run with no releasable commits
doesn't deploy.

A `docs:` commit cuts no release, so it doesn't reach the site on its own. To deploy one, go to
**Actions → Deploy Docs → Run workflow** and leave the branch as `main`. A run from any other branch
fails without deploying. The site is then built from `main`, so it also shows any changes not yet
released.

Pages must be switched on once, before the first release that should deploy it:

1. **Settings → Pages → Build and deployment → Source**: choose **GitHub Actions**.
2. **Settings → Environments → github-pages → Deployment branches and tags**: allow `main`.
