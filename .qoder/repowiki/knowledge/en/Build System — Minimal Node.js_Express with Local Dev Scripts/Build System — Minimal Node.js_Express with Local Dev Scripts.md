---
kind: build_system
name: Build System — Minimal Node.js/Express with Local Dev Scripts
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - start.bat
    - .env.example
---

This repository does not implement a formal build system. It is a single-server Node.js/Express application that runs directly from source without compilation, bundling, or packaging steps.

**What system/approach is used**
- Runtime: Node.js (v22 as referenced by the Windows launcher script) with Express 5 and SQLite3.
- Dependency management: npm (`package.json` + `package-lock.json`). No vendoring, no lockfile overrides beyond standard npm behavior.
- Development entry point: `app.js` is the sole server process; there are no separate build targets.
- Local launch helpers:
  - `start.bat` — Windows batch script that sets PATH to a local Laragon Node installation, prints network info, and runs `node app.js`.
  - `npm start` — defined in `package.json` scripts as `node app.js`.

**Key files and packages**
- `package.json` — declares runtime dependencies (`express`, `sqlite3`, `socket.io`, `bcryptjs`, `dotenv`, `express-session`, `helmet`, `express-rate-limit`) and the single `start` script.
- `start.bat` — Windows convenience launcher for local development.
- `database.sqlite` — the persistent SQLite database file shipped alongside the code.
- `.env.example` — template for environment variables consumed via `dotenv`.
- Migration/utility scripts (`export.js`, `migrate_vatout.js`) run ad-hoc against the SQLite DB rather than through a migration framework.

**Architecture and conventions**
- Zero-build architecture: all client-side pages are plain HTML/CSS/JS served directly by Express; there is no asset pipeline, transpiler, or bundler.
- Single-process deployment model: one Node process serves both API routes and static pages.
- Data layer is file-based SQLite; schema changes are applied via standalone Node scripts rather than a versioned migration tool.
- Configuration is driven by environment variables loaded at startup via `dotenv`.

**Conventions and constraints**
- There is no CI/CD pipeline, Dockerfile, Makefile, or release automation present in the repository.
- The project is intended to be run locally on a developer machine (Windows via `start.bat`, or any platform via `npm start`).
- Versioning is a flat `1.0.0` in `package.json` with no changelog or tagging convention visible in the repo.
- No cross-compilation or multi-platform build targets exist; the only platform-specific artifact is the Windows `start.bat` launcher.