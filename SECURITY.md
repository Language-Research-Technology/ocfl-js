# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability** ([direct link](https://github.com/Language-Research-Technology/ocfl-js/security/advisories/new)). Only you, the maintainers and anyone they invite to the advisory can see it.

Don't open a public issue or pull request for a vulnerability, and don't discuss it publicly until a fix is released.

Include the version of `@ocfl/ocfl-fs` and Node.js you're using, what an attacker can do, and the steps or code to reproduce it.

## Supported versions

Until 1.0.0 is out, fixes are released only as the next `1.0.0-beta` prerelease, under the `beta` dist-tag (`pnpm add @ocfl/ocfl-fs@beta`). The npm `latest` tag still points at 0.4.0, which doesn't get fixes.

| Version       | Gets fixes |
| ------------- | ---------- |
| 1.0.0 betas   | Yes        |
| 0.4 and older | No         |

To upgrade from 0.4, see [Migrating from 0.4](https://language-research-technology.github.io/ocfl-js/guides/migrating-from-0-4/).

## Scope

The library trusts the filesystem it runs on. It follows symbolic links in a storage root, so a process that can write to the storage root can make the library read or write outside it. That's documented behaviour rather than a vulnerability: keep write access to the storage root limited to trusted processes.
