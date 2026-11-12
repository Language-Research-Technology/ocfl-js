# Contributing

Bug reports, fixes and new features are welcome. To report a security vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Set up

Clone the Git repo:

```bash
git clone https://github.com/Language-Research-Technology/ocfl-js
```

The package lives at the repository root. Development needs Node.js 22.18 or later and [pnpm](https://pnpm.io/). Install the dependencies:

```bash
cd ocfl-js
pnpm install
```

The documentation site is a separate, private workspace package in `website/`, built with [Starlight](https://starlight.astro.build/). Preview it with `pnpm --dir website dev`. Its code examples live in `website/src/examples` and are type-checked against the package.

Installing also sets up the [Lefthook](https://lefthook.dev/) Git hooks, which run the lint scripts before each commit and check the commit message. If they're missing (for example, after installing with `--ignore-scripts`), run `pnpm exec lefthook install`.

## Checks

CI runs all of these on every pull request to `main`:

| Command              | What it checks                                                      |
| -------------------- | ------------------------------------------------------------------- |
| `pnpm test`          | The test suite                                                      |
| `pnpm coverage`      | The test suite, failing unless it covers all of `src`               |
| `pnpm lint:types`    | Types, in the source and the tests                                  |
| `pnpm lint:biome`    | Formatting and lint rules (`pnpm format` fixes what it can)         |
| `pnpm lint:knip`     | Unused files, exports and dependencies                              |
| `pnpm lint:consumer` | That the packed package passes publint and attw, installs and works |
| `pnpm lint:api`      | That the public API matches the API report                          |
| `pnpm lint:docs`     | That the site's examples type-check and the site builds             |

Run a single test file with `node --test`, for example `node --test test/open-object.spec.ts`. Specs sit at the top of `test/`, named for the behaviour they cover, with `helpers/`, `types/` (compiled, never run) and `fixtures/` beside them. Specs of the public API import only the package entry, `src/index.ts`; unit specs of internals import the module they test.

## The API report

`etc/ocfl-fs.api.md` lists the package's public API, and `pnpm lint:api` fails when the built API differs from it. If you meant to change the API, run `pnpm api:update` and commit the report's diff with the change, so reviewers can see it. If you didn't, fix the code and leave the report alone. [ADR 0002](docs/adr/0002-the-api-report-is-the-public-api-contract.md) explains the rules for the public API.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), and the version of each release is worked out from them:

- `fix:` releases a patch.
- `feat:` releases a minor version.
- `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer releases a major version. Removing or changing anything already in the API report is a breaking change.
- Other types, such as `docs:`, `test:`, `refactor:` and `chore:`, don't release anything.

Until 1.0.0 is released, every release is a `1.0.0-beta` prerelease, and each one only bumps the beta number. Mark breaking changes anyway: they decide the stable versions after 1.0.0 and appear in the release notes.

commitlint checks each message when you commit, and again in CI for every commit in a pull request. [RELEASING.md](RELEASING.md) covers how releases are published.

## Pull requests

Open pull requests against `main`. Include tests for the change and update the README and docs to match. The README's quick start must be identical to `website/src/examples/readme/quick-start.ts`, which `pnpm lint:docs` type-checks and compares. The pull request template has a checklist.

## Layouts and digest algorithms

Storage layouts and digest algorithms are a fixed set built into the library, with no plugin API. To add one, send a pull request to this repository. [ADR 0001](docs/adr/0001-one-filesystem-only-package-with-no-extension-points.md) explains why.

## Coding standards

[CODING_STANDARDS.md](CODING_STANDARDS.md) lists the conventions reviewers check.

## Design decisions

Decisions about the library's design are recorded as ADRs in [docs/adr](docs/adr), and [GLOSSARY.md](GLOSSARY.md) defines the terms the code and docs use. A change that contradicts an ADR needs a new ADR first.
