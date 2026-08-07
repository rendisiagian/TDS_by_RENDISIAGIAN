---
kind: error_handling
name: Error Handling in Tax Database System
category: error_handling
scope:
    - '**'
source_files:
    - app.js
    - utils.js
    - package.json
---

The Tax Database System uses a pragmatic, inline error-handling approach centered around Express.js routes and Socket.IO handlers, with no centralized error middleware or custom error types.

**System/Approach**
- Errors are handled through ad-hoc `try/catch` blocks, callback-style error propagation from sqlite3, and direct `res.status(...).json({ error: ... })` responses. There is no unified error class hierarchy, sentinel errors, or global error handler middleware.
- Configuration/validation failures at startup cause an immediate `process.exit(1)` (e.g., missing `SESSION_SECRET`).
- HTTP endpoints return JSON objects with an `error` field; Socket.IO events emit typed error messages via dedicated channels like `error-simpan`, `error-action`, `error-cabang`, `error-vo`, `error-kontak`, `error-proyek`.

**Key Files and Packages**
- `app.js` — the single entry point containing all routing, database wrappers (`dbGet`, `dbRun`), migration endpoints, and Socket.IO handlers where every error path lives.
- `utils.js` — client-side numeric formatting helpers; no server-side error utilities exist.
- `package.json` — dependencies include `express-rate-limit` (used for login brute-force protection) and `helmet` (security headers); no dedicated error-handling packages.

**Architecture and Conventions**
- **Database layer**: sqlite3 callbacks propagate errors to the caller; wrapper functions `dbGet`/`dbRun` convert callbacks to Promises that reject on error, which callers then catch locally.
- **Route handlers**: Each GET/POST route wraps DB calls in try/catch or checks callback `err` parameters, returning `res.status(500).json({ error: err.message })` or similar. Some endpoints swallow errors silently (e.g., `catch(e) {}` in search parsing).
- **Socket.IO handlers**: Use per-event error channels (`error-simpan`, `error-action`, etc.) rather than a generic error channel. File operations use try/catch with silent failure or increment counters (`gagal++`).
- **Migration endpoints**: Return structured `{ success, message, total, updated, failed }` objects even when individual rows fail, logging errors via `console.error`.
- **Security-related errors**: Login failures redirect with query params (`?error=1`, `?error=2`, `?error=3`); rate limiting returns HTML redirect script; RBAC violations return 401/403 JSON.

**Conventions and Constraints**
- Error responses consistently use `{ error: <string> }` shape for REST endpoints.
- Socket.IO errors are event-specific: `error-simpan` for save failures, `error-action` for permission/action errors, module-scoped `error-*` events for admin CRUD.
- Silent error swallowing is common in non-critical paths (file deletion, JSON parsing fallbacks, duplicate detection).
- No `throw new CustomError()` pattern exists; errors are always strings or sqlite3 error objects.
- Audit logs capture operational errors via `insertAuditLog` but do not form part of the error flow itself.