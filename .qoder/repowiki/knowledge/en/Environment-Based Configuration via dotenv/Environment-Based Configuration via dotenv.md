---
kind: configuration_system
name: Environment-Based Configuration via dotenv
category: configuration_system
scope:
    - '**'
source_files:
    - .env.example
    - package.json
    - app.js
---

The Tax Database System uses a minimal, environment-variable-driven configuration approach powered by the `dotenv` package. All runtime configuration is loaded from a `.env` file at application startup, with no YAML/JSON/TOML config files or centralized config module.

**What system/approach is used**
- `dotenv` (`require('dotenv').config()`) loads key-value pairs from `.env` into `process.env` before any other code runs.
- Configuration values are read directly from `process.env` throughout `app.js` using simple fallback defaults (e.g., `process.env.PORT || 3000`).
- No additional config library, schema validator, or layered config merging is used.

**Key files and packages**
- `.env.example` — template showing the two required variables: `SESSION_SECRET` and `PORT`.
- `package.json` — declares `dotenv` as a dependency and sets `"start": "node app.js"` as the entry point.
- `app.js` — the single source of truth for configuration loading, validation, and usage.

**Architecture and conventions**
- **Single-file bootstrap**: `app.js` calls `dotenv.config()` on line 1, then immediately reads `PORT` and `SESSION_SECRET` from `process.env`.
- **Hard-fail on critical secrets**: If `SESSION_SECRET` is missing, the server logs a red error and exits with code 1, preventing insecure startup.
- **Default fallbacks**: `PORT` falls back to `3000`; all other runtime settings use inline defaults in the code rather than env vars.
- **Security guardrails**: The app warns if `SESSION_SECRET` is still a placeholder or shorter than 32 characters, and explicitly blocks HTTP access to `.env`, `.db`, `app.js`, `package.json`, and other sensitive files.
- **No feature flags or per-module configs**: Module-specific behavior (VAT In/Out, Prepaid, Payable) is controlled through hardcoded arrays and SQL logic inside `app.js`, not through configuration files.

**Conventions and constraints**
- Only two environment variables are expected: `SESSION_SECRET` (required, ≥32 chars recommended) and `PORT` (optional, defaults to 3000).
- There is no `.env` file committed to the repo; developers must create it from `.env.example`.
- Database path (`tax_database.db`), SQLite connection, static file serving paths, and module directory structures are all hard-coded constants in `app.js` — they cannot be overridden via environment variables.
- No configuration validation beyond the SESSION_SECRET presence/length check; malformed or unexpected env vars are silently ignored.