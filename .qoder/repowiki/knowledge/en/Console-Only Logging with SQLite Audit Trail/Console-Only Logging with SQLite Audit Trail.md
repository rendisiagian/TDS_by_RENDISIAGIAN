---
kind: logging_system
name: Console-Only Logging with SQLite Audit Trail
category: logging_system
scope:
    - '**'
source_files:
    - app.js
    - audit_logs.html
    - package.json
---

The Tax Database System does not use a dedicated logging framework. All application-level output is produced through Node.js's built-in `console` methods, and operational/audit events are persisted to an in-process SQLite table called `audit_logs`.

**What system/approach is used**
- **Runtime console logging**: The entire server relies on `console.log`, `console.error`, and `console.warn` for process output. Messages include ANSI color codes (e.g., `[SECURITY ERROR]`, `[SETUP]`, `[SHUTDOWN]`) and are written directly to stdout/stderr. No logger library (winston, pino, bunyan, morgan) is imported or configured.
- **SQLite audit trail**: A persistent `audit_logs` table records user actions with fields `user_id`, `username`, `action`, `module`, `details`, and `waktu`. An in-memory helper `global.insertAuditLog(user_id, username, action, module, details)` wraps the INSERT call and falls back to `console.error('Audit Log Error:', err)` when the write fails.
- **No log levels, no structured format**: Console messages are free-form strings; there is no unified log level strategy, no JSON structure, and no centralized formatter.

**Key files and packages**
- `app.js` — sole source of all console output and the `insertAuditLog` helper; defines the `audit_logs` schema at startup.
- `audit_logs.html` — client-side page that fetches `/api/audit-logs` and renders the last 500 rows ordered by id descending.
- `package.json` — confirms no logging dependencies are declared; only Express, sqlite3, socket.io, bcryptjs, dotenv, helmet, express-session, and express-rate-limit are listed.

**Architecture and conventions**
- Startup and lifecycle events: `console.log` prints port binding (`Tax Database by Rendi Siagian berjalan di Port ${PORT}`), default user creation notices, and SIGTERM shutdown hooks (`[SHUTDOWN] ...`).
- Security warnings: `console.error` and `console.warn` flag missing/weak `SESSION_SECRET` values at boot.
- Migration and DB errors: Every migration step catches and logs failures via `console.error(...)` with context like `Migration error for ${noFaktur}:`.
- Upload/processing paths: Each bulk insert/delete path emits `console.error("❌ DB Insert/Delete Error (...):", err.message)` so failures are visible in the server console.
- Audit persistence: `insertAuditLog` is called from authenticated routes; failures are silently swallowed except for a single `console.error` line.

**Conventions and constraints**
- All runtime output goes to stdout/stderr via `console.*`; there is no file sink, no syslog, and no external log aggregator.
- Audit data is limited to the last 500 rows returned by `/api/audit-logs` (hardcoded `LIMIT 500` in the query).
- Audit entries are written asynchronously without awaiting, so a crashing process can lose recent audit rows.
- No configuration file toggles log verbosity; the only way to change output is editing `app.js`.