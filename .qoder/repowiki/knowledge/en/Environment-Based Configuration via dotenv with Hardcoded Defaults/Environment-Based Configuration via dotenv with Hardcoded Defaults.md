---
kind: configuration_system
name: Environment-Based Configuration via dotenv with Hardcoded Defaults
category: configuration_system
scope:
    - '**'
source_files:
    - .env
    - .env.example
    - app.js
---

## Approach

The Tax Database System uses a minimal, single-file configuration approach built on the `dotenv` npm package. There is no dedicated config module, no YAML/JSON/TOML files, and no runtime config API — all settings are read directly from `process.env` at startup in `app.js`, with sensible defaults defined inline.

## Key Files

- `.env` — live secrets and overrides (SESSION_SECRET, PORT)
- `.env.example` — template shipped to developers showing required keys
- `app.js` — only file that loads and validates configuration

## How It Works

1. **Loading**: Line 1 of `app.js` calls `require('dotenv').config()`, which reads `.env` into `process.env` before any other code runs.
2. **Reading values**:
   - `PORT = process.env.PORT || 3000` (line 16) — falls back to 3000 if unset.
   - `SESSION_SECRET = process.env.SESSION_SECRET` (line 17) — used by `express-session` (line 78).
3. **Validation & enforcement**:
   - If `SESSION_SECRET` is missing, the app prints a red error (`[SECURITY ERROR] SESSION_SECRET tidak ditemukan di file .env! Server dihentikan.`) and calls `process.exit(1)` (lines 18–21). This is the only hard failure path for configuration.
   - A warning is emitted if the secret still contains `CHANGE-THIS` or is shorter than 32 characters (lines 23–25).
4. **Non-secret runtime constants** are not loaded from env; they are hardcoded in `app.js`:
   - Socket.IO buffer: `maxHttpBufferSize: 1e8` (line 6)
   - JSON/body-parser limits: `limit: '5mb'` (lines 71–72)
   - Rate limiter: 15-minute window, max 20 login attempts (lines 91–97)
   - Helmet CSP disabled (`contentSecurityPolicy: false`) (line 74)
   - Default admin password `'Emergent@2024!'` seeded into SQLite on first run (line 417)

## Architecture & Conventions

- **Single source of truth**: All configuration lives as environment variables plus inline defaults in `app.js`. There is no config loader abstraction.
- **No layered config**: No distinction between development/staging/production config files; environment variables override everything.
- **Secrets vs. defaults**: Only `SESSION_SECRET` and `PORT` are treated as externalized. Everything else (limits, paths, feature toggles) is embedded in source.
- **Module discovery via array**: The four business modules (`vatin`, `vatout`, `payable`, `prepaid`) are declared as a plain JS array of objects in `app.js` (lines 30–35); this acts as an internal "feature flag" list that drives table creation, static serving, and archive directory setup.
- **Database path is hardcoded**: `new sqlite3.Database('tax_database.db')` (line 65) — the DB filename cannot be changed without editing source.
- **Static asset directories** are created on demand per module (lines 37–43), ensuring `arsip_vatin`, `arsip_vatout`, `arsip_payable`, `arsip_prepaid` exist.

## Constraints & Rules

- **`SESSION_SECRET` is mandatory**: The server refuses to start without it (`process.exit(1)`). Source: `app.js` lines 18–21.
- **`SESSION_SECRET` must be ≥ 32 characters and not the placeholder**: A console warning is issued if violated. Source: `app.js` lines 23–25.
- **`.env` is blocked from HTTP access**: A middleware rejects requests matching `.db`, `.env`, `/app.js`, `/fix_masa_pajak.js`, `/test_query.js`, `/package.json`, `/package-lock.json` with 403. Source: `app.js` lines 49–58.
- **Only two env vars are documented as required**: `.env.example` lists `SESSION_SECRET` and `PORT`; adding more requires updating both `.env` and `.env.example` manually.
- **No schema validation**: Values are read as strings; e.g., `PORT` is passed to `http.createServer` as-is (Express coerces it). There is no type coercion or validation beyond the presence check for `SESSION_SECRET`.
- **No feature-flag system**: Business module enablement is controlled by the hardcoded `modules` array in `app.js`, not by environment variables.