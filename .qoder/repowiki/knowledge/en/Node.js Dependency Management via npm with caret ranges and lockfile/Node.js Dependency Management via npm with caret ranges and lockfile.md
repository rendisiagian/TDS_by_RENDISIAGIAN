---
kind: dependency_management
name: Node.js Dependency Management via npm with caret ranges and lockfile
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - .gitignore
---

## System / Approach

The project is a single-file Node/Express application. Third-party dependencies are declared and resolved through **npm** (the default Node package manager). There is no vendoring, no private registry configuration, and no monorepo tooling — all packages are installed into the root `node_modules/` directory.

## Key Files

- `package.json` — declares runtime dependencies and the `start` script.
- `package-lock.json` — generated lockfile pinning exact transitive dependency versions.
- `.gitignore` — ignores only PDF archive directories; `node_modules/` is not listed here, so it is committed to the repository alongside the lockfile.

## Dependencies Declared

Runtime-only dependencies in `package.json`:

| Package | Version range | Purpose |
|---|---:|---|
| `bcryptjs` | `^3.0.3` | Password hashing |
| `dotenv` | `^17.4.2` | `.env` loading |
| `express` | `^5.2.1` | HTTP server |
| `express-rate-limit` | `^8.3.2` | Request rate limiting |
| `express-session` | `1.19.0` | Session management |
| `helmet` | `^8.0.0` | Security headers |
| `socket.io` | `^4.8.3` | Real-time communication |
| `sqlite3` | `^6.0.1` | SQLite database driver |

There are no `devDependencies`, `peerDependencies`, or `optionalDependencies` entries.

## Versioning Convention

All versions use **caret (`^`) ranges**, which allow patch and minor updates while blocking major-version bumps. The sole exception is `express-session@1.19.0`, pinned without a caret. This means `npm install` can resolve newer compatible versions of most packages at install time, but the lockfile constrains what actually gets installed.

## Lockfile Strategy

`package-lock.json` is present in the repository root. It pins every transitive dependency to an exact version, providing deterministic installs across environments. Because `node_modules/` is not gitignored, both the lockfile and the checked-in `node_modules/` tree ship together — this is unusual for npm projects and suggests the intent is to make the repo self-contained (installable without network access) rather than relying on a fresh `npm install`.

## Scripts

Only one script is defined:

```json
"scripts": {
  "start": "node app.js"
}
```

No build, test, lint, or update scripts exist. The companion `start.bat` at the repo root launches the process directly via `node app.js` as well.

## Private Registries & Auth

No `.npmrc` file exists in the repository, and there is no `GOPRIVATE` equivalent (this is not a Go project). No custom registry URL, auth token, or scoped-package configuration is present. All packages are sourced from the public npm registry.

## Constraints Observed

- Only runtime dependencies are declared; no development tooling (linters, formatters, test runners) appears in `package.json`.
- Versions are expressed as caret ranges, allowing automatic minor/patch upgrades.
- `package-lock.json` is committed, and `node_modules/` is also committed (not gitignored), making the dependency tree part of the repository snapshot.
- No CI step, Makefile, or Dockerfile enforces dependency updates or audits — keeping dependencies current is manual.