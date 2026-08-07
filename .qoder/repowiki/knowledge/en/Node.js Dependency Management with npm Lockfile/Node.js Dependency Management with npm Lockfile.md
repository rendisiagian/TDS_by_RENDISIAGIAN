---
kind: dependency_management
name: Node.js Dependency Management with npm Lockfile
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - .gitignore
    - .env.example
---

This repository uses the standard Node.js dependency management approach via npm, with a single `package.json` at the repository root declaring all runtime dependencies and a corresponding `package-lock.json` for deterministic installs.

**System and tools used**
- Package manager: npm (lockfileVersion 3)
- Manifest file: `package.json` at the repository root
- Deterministic lockfile: `package-lock.json` committed alongside the manifest
- No vendoring of third-party code; dependencies are installed into `node_modules/`
- No private registry or proxy configuration is present in the checked-in files

**Key files**
- `package.json` — declares 9 direct runtime dependencies (`bcryptjs`, `dotenv`, `express`, `express-rate-limit`, `express-session`, `helmet`, `socket.io`, `sqlite3`) and a single `start` script that runs `node app.js`.
- `package-lock.json` — full dependency tree with resolved versions, integrity hashes, and engine constraints from the public npm registry.
- `.gitignore` — ensures `node_modules/` is not tracked, so only manifests and lockfile are versioned.
- `.env.example` — environment variable template consumed by `dotenv`; no secrets are committed.

**Architecture and conventions**
- Single-root monorepo: all server-side dependencies are declared centrally in one `package.json`; there are no per-module `package.json` files.
- Version pinning style: caret ranges (`^x.y.z`) are used for all dependencies, allowing minor/patch updates within the major version while keeping the lockfile as the source of truth for exact versions.
- Runtime-only dependencies: no `devDependencies` section exists, meaning development tooling is not managed through npm in this repository.
- Deterministic builds: the committed `package-lock.json` pins every transitive dependency to an exact version and integrity hash, ensuring reproducible installs across environments.
- Environment configuration: `dotenv` is used to load variables from `.env` (with `.env.example` as the template), keeping secrets out of version control.

**Constraints and observed rules**
- Dependencies must be declared in `package.json` under `dependencies`; no `devDependencies` are used.
- The `node_modules/` directory is ignored by Git, so local installs are expected to be regenerated from the lockfile.
- The project specifies a `start` script (`node app.js`) as the canonical entry point for running the application.
- Engine requirements are enforced transitively through the lockfile's `engines` fields on individual packages (e.g., `@npmcli/*` packages require Node `^20.17.0 || >=22.9.0`).
- No custom npmrc, private registry, or scoped package configuration is present in the repository.