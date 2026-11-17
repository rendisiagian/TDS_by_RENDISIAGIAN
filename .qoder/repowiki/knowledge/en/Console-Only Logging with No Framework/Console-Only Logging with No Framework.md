---
kind: logging_system
name: Console-Only Logging with No Framework
category: logging_system
scope:
    - '**'
source_files:
    - app.js
---

## What system/approach is used

The repository has **no logging framework** (no `winston`, `pino`, `morgan`, `bunyan`, or any logger dependency). All output goes directly to the Node.js process via the built-in `console` object (`console.log`, `console.warn`, `console.error`). There is no dedicated `log/` or `logging/` directory, no log-level configuration, no structured-log formatter, and no sink/transport abstraction.

The only persistence of audit activity is a database table `audit_logs` (created at startup in `app.js`) written through an in-process helper `global.insertAuditLog(user_id, username, action, module, details)`; this is application audit data, not a general-purpose logger.

## Key files and packages

- `app.js` — the single-file Express server where every log call lives. It is the sole source of console output.
- `package.json` / `package-lock.json` — no logging library appears as a dependency.
- `tax_database.db` — SQLite file containing the `audit_logs` table (schema: `id, user_id, username, action, module, details, waktu`).
- `audit_logs.html` — UI that reads `/api/audit-logs` to display persisted audit rows.

## Architecture and conventions

All logging is ad-hoc `console.*` calls sprinkled throughout `app.js`. The observed patterns are:

1. **Startup / lifecycle messages** use `console.log` with bracketed tags for readability:
   - `[SETUP] User default dibuat...` (line 420)
   - `Tax Database by Rendi Siagian berjalan di Port ${PORT}` (line 3043)
   - `[SHUTDOWN] Menutup koneksi database...` / `[SHUTDOWN] Database ditutup dengan aman.` / `[SHUTDOWN] SIGTERM diterima, menutup server...` (lines 3047–3055)

2. **Security-related diagnostics** use ANSI color codes (`\x1b[31m` red, `\x1b[33m` yellow) and explicit tag prefixes:
   - `[SECURITY ERROR] SESSION_SECRET tidak ditemukan di file .env! Server dihentikan.` (line 19, followed by `process.exit(1)`)
   - `[SECURITY WARNING] SESSION_SECRET terlalu pendek atau masih default! Segera ganti dengan string acak minimal 32 karakter.` (line 24)

3. **Error paths** consistently use `console.error` with descriptive English/Indonesian labels:
   - `Migration error for ${noFaktur}:` (lines 457, 642, 724)
   - `Error querying data_vatout:` / `Error querying data_vatin:` (lines 862, 869)
   - `❌ DB Insert Error (data_vatout|payable|prepaid):` (lines 2355, 2455, 2543)
   - `❌ DB Delete Error (inbox_vatout|payable|prepaid):` (lines 2368, 2463, 2551)
   - `Direct Upload Error:`, `Gagal rename PDF Vatout:`, `Error deleting ledger entry:`, `Audit Log Error:`

4. **No request/response middleware logging** — there is no Morgan-style HTTP access logger, no per-request correlation ID, and no structured fields like `req.id`, `method`, `url`, `status`, `duration`.

5. **Audit trail vs. operational logs are separate**: operational issues go to `console.error`; user actions are persisted to the `audit_logs` SQLite table via `global.insertAuditLog`, which itself falls back to `console.error("Audit Log Error:", err)` if the write fails.

## Conventions and constraints

- **No logging framework is configured.** The codebase does not import or initialize any third-party logger; all output is unstructured text on stderr/stdout.
- **Log levels are informal**, inferred from the `console` method chosen (`error` for failures, `warn` for security warnings, `log` for informational/lifecycle events); there is no runtime level filter.
- **Messages are mixed-language** (English labels such as `Migration error`, `DB Insert Error`, plus Indonesian prose such as `Menutup koneksi database`, `Gagal rename PDF Vatout`).
- **ANSI escape sequences** are embedded directly in message strings for terminal coloring; this means log consumers must handle raw ANSI codes rather than receiving structured JSON.
- **There is no centralized logger module** to enforce consistent formatting, timestamps, or sinks — each call site decides its own prefix and content.
- **The only enforced invariant** is that audit records are attempted to be written to the `audit_logs` table through `global.insertAuditLog`; failure of that write is surfaced via `console.error("Audit Log Error:", err)`.

In short, the logging system is effectively "built-in `console` + an `audit_logs` SQLite table" with no framework, no structured schema, and no external sink.