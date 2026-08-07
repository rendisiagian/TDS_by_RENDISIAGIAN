# REST API Endpoints

<cite>
**Referenced Files in This Document**
- [app.js](file://app.js)
- [TDS_Sequence_Diagram.md](file://TDS_Sequence_Diagram.md)
</cite>

## Update Summary
**Changes Made**
- Added new `/api/porsi-vatout/:faktur` endpoint for retrieving internal portion records supporting edit and view operations
- Enhanced `/api/project-summary/:id` endpoint to include `porsi_anggota` field for JO member perspective display
- Added `/api/prepaid-comparison-bulk` endpoint for bulk comparison functionality replacing inefficient per-item queries

## Table of Contents
1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)

## Introduction
This document provides comprehensive REST API documentation for the TDS system. It covers HTTP endpoints for master data, audit logs, migrations, project management, items, details, and auxiliary APIs including new bulk comparison and internal portion management features. For each endpoint, we specify method, URL pattern, authentication and authorization requirements, parameters, request/response formats, and practical usage notes. The backend is implemented using Express.js with SQLite storage and session-based authentication.

## Project Structure
The API surface is primarily defined in the server entry file. Key areas:
- Authentication and session middleware
- Role-based access control (RBAC) enforcement
- Static routing for HTML pages
- API routes grouped by functional domains (master data, audit logs, migrations, projects, items, details, exports, and auxiliary endpoints)

```mermaid
graph TB
Client["Browser/UI"] --> Auth["Authentication Middleware<br/>cekAuth"]
Auth --> RBAC["Role-Based Access Control<br/>cekRoleAPI"]
RBAC --> Routes["Express Routes"]
Routes --> DB["SQLite Database"]
Routes --> Export["Export Utilities"]
Routes --> Audit["Audit Logging"]
```

**Diagram sources**
- [app.js:504-512](file://app.js#L504-L512)
- [app.js:546-554](file://app.js#L546-L554)
- [app.js:557-575](file://app.js#L557-L575)

**Section sources**
- [app.js:504-512](file://app.js#L504-L512)
- [app.js:546-554](file://app.js#L546-L554)
- [app.js:557-575](file://app.js#L557-L575)

## Core Components
- Authentication middleware ensures only logged-in users can access protected routes.
- RBAC middleware enforces role-based permissions for sensitive endpoints.
- Database helpers wrap SQLite operations for queries and transactions.
- Export endpoints support filtered reporting across modules.
- New bulk comparison and internal portion management capabilities enhance performance and functionality.

Key implementation references:
- Authentication and RBAC: [app.js:504-512](file://app.js#L504-L512)
- Static protection for HTML routes: [app.js:546-554](file://app.js#L546-L554)
- Database initialization and helpers: [app.js:65-69](file://app.js#L65-L69), [app.js:351-499](file://app.js#L351-L499)

**Section sources**
- [app.js:504-512](file://app.js#L504-L512)
- [app.js:546-554](file://app.js#L546-L554)
- [app.js:65-69](file://app.js#L65-L69)
- [app.js:351-499](file://app.js#L351-L499)

## Architecture Overview
The API follows a layered architecture:
- Presentation: HTML pages served via Express static routing
- Application: Route handlers implementing REST endpoints
- Persistence: SQLite tables for master data, audit logs, and module-specific data
- Security: Session cookies, CSRF protection, and rate limiting for login

```mermaid
sequenceDiagram
participant Client as "Client"
participant Auth as "cekAuth"
participant RBAC as "cekRoleAPI"
participant API as "Route Handler"
participant DB as "SQLite"
Client->>Auth : "HTTP Request"
Auth-->>Client : "Redirect to login if not authenticated"
Auth->>RBAC : "Proceed if authenticated"
RBAC-->>Client : "403 Forbidden if role insufficient"
RBAC->>API : "Authorized"
API->>DB : "Execute SQL"
DB-->>API : "Rows or Error"
API-->>Client : "JSON Response"
```

**Diagram sources**
- [app.js:504-512](file://app.js#L504-L512)
- [app.js:546-554](file://app.js#L546-L554)
- [app.js:557-575](file://app.js#L557-L575)

## Detailed Component Analysis

### Authentication and Authorization
- Endpoint: GET /api/me
  - Method: GET
  - URL: /api/me
  - Auth: cekAuth (session required)
  - Response: JSON user object { id, username, nama, role }
  - Notes: Returns current session user; useful for UI hydration

- Endpoint: POST /login
  - Method: POST
  - URL: /login
  - Auth: None (login form submission)
  - Request: Form fields username, password
  - Response: Redirect to dashboard or login with error message
  - Security: Rate-limited to prevent brute force

- Endpoint: GET /logout
  - Method: GET
  - URL: /logout
  - Auth: None
  - Behavior: Destroys session and redirects to login

**Section sources**
- [app.js:1434-1444](file://app.js#L1434-L1444)
- [app.js:1419-1433](file://app.js#L1419-L1433)
- [app.js:504-512](file://app.js#L504-L512)

### Master Data APIs
- Endpoint: GET /api/master-cabang-all
  - Method: GET
  - URL: /api/master-cabang-all
  - Auth: cekRoleAPI(['administrator', 'supervisor', 'superadmin'])
  - Response: Array of branch records ordered by entity and branch code
  - Notes: Full list for administrative views

- Endpoint: GET /api/master-kontak-all
  - Method: GET
  - URL: /api/master-kontak-all
  - Auth: cekRoleAPI(['administrator', 'supervisor', 'superadmin'])
  - Response: Array of contact records
  - Notes: Administrative contact listing

- Endpoint: GET /api/branches
  - Method: GET
  - URL: /api/branches
  - Auth: cekAuth
  - Query: entitas (optional; defaults to 'BBS')
  - Response: Array of branches filtered by entity

- Endpoint: GET /api/users
  - Method: GET
  - URL: /api/users
  - Auth: cekAuth
  - Response: Array of users with id, username, nama_lengkap, role

**Section sources**
- [app.js:557-563](file://app.js#L557-L563)
- [app.js:565-571](file://app.js#L565-L571)
- [app.js:1445-1446](file://app.js#L1445-L1446)
- [app.js:1446-1447](file://app.js#L1446-L1447)

### Audit Logs API
- Endpoint: GET /api/audit-logs
  - Method: GET
  - URL: /api/audit-logs
  - Auth: cekRoleAPI(['administrator', 'supervisor', 'superadmin'])
  - Response: Array of audit log entries
  - Notes: Administrative audit trail

**Section sources**
- [app.js:573-575](file://app.js#L573-L575)

### Migration APIs
- Endpoint: POST /api/migrate-vatin-status
  - Method: POST
  - URL: /api/migrate-vatin-status
  - Auth: cekRoleAPI(['administrator', 'supervisor', 'superadmin'])
  - Request: JSON payload (schema not defined in code; consult UI or migration scripts)
  - Response: Operation result (success/failure)
  - Notes: Used to migrate VATIN statuses

- Endpoint: GET /api/verify-vatin-migration
  - Method: GET
  - URL: /api/verify-vatin-migration
  - Auth: cekRoleAPI(['administrator', 'supervisor', 'superadmin'])
  - Response: Verification result
  - Notes: Validates migration outcomes

**Section sources**
- [app.js:577-657](file://app.js#L577-L657)
- [app.js:741-814](file://app.js#L741-L814)

### Project Management APIs
- Endpoint: GET /api/projects
  - Method: GET
  - URL: /api/projects
  - Auth: cekAuth
  - Response: List of projects derived from master branch data
  - Notes: Used by project profitability report

- Endpoint: GET /api/vo/:kode_cabang
  - Method: GET
  - URL: /api/vo/:kode_cabang
  - Auth: cekAuth
  - Path: kode_cabang (required)
  - Response: VO details for the given branch code

- Endpoint: GET /api/project-summary/:id
  - Method: GET
  - URL: /api/project-summary/:id
  - Auth: cekAuth
  - Path: id (required)
  - Response: Aggregated financial summary across related modules
  - **Updated**: Now includes `porsi_anggota` field for JO member perspective display when dealing with JO projects
  - Notes: Cross-module aggregation for reporting with enhanced JO project support

**Section sources**
- [app.js:817-823](file://app.js#L817-L823)
- [app.js:825-831](file://app.js#L825-L831)
- [app.js:833-874](file://app.js#L833-L874)

### Internal Portion Management APIs
- Endpoint: GET /api/porsi-vatout/:faktur
  - Method: GET
  - URL: /api/porsi-vatout/:faktur
  - Auth: cekAuth
  - Path: faktur (required)
  - Response: Array of internal portion records { anggota, dpp_porsi, ppn_porsi }
  - Notes: Retrieves internal portion allocation records for JO member perspective display and editing

**Section sources**
- [app.js:892-898](file://app.js#L892-L898)

### Item APIs
- Endpoint: GET /api/items/:mod/:faktur
  - Method: GET
  - URL: /api/items/:mod/:faktur
  - Auth: cekAuth
  - Path: mod (module id), faktur (invoice number)
  - Response: Items associated with the invoice in the specified module
  - Notes: Supports module-specific item retrieval

**Section sources**
- [app.js:900-902](file://app.js#L900-L902)

### Detail APIs
- Endpoint: GET /api/detail-vatin/:faktur
  - Method: GET
  - URL: /api/detail-vatin/:faktur
  - Auth: cekAuth
  - Path: faktur (required)
  - Response: VATIN record details
  - Notes: Retrieves detailed invoice data for VATIN

- Endpoint: GET /api/detail-vatout/:faktur
  - Method: GET
  - URL: /api/detail-vatout/:faktur
  - Auth: cekAuth
  - Path: faktur (required)
  - Response: VATOUT record details
  - Notes: Retrieves detailed invoice data for VATOUT

**Section sources**
- [app.js:904-907](file://app.js#L904-L907)
- [app.js:909-911](file://app.js#L909-L911)

### Prepaid Comparison APIs
- Endpoint: GET /api/prepaid-comparison/:noBppu
  - Method: GET
  - URL: /api/prepaid-comparison/:noBppu
  - Auth: cekAuth
  - Path: noBppu (required)
  - Response: Comparison data for prepaid entries
  - Notes: Supports reconciliation workflows

- Endpoint: GET /api/prepaid-comparison-bulk
  - Method: GET
  - URL: /api/prepaid-comparison-bulk
  - Auth: cekAuth
  - Query: entitas (optional; defaults to 'BBS')
  - Response: Bulk comparison results mapping BPPU numbers to aggregated VATOUT data
  - **New**: Replaces inefficient per-item queries with single bulk operation for improved performance
  - Notes: Provides comprehensive comparison data for all prepaid entries within an entity in one request

**Section sources**
- [app.js:913-964](file://app.js#L913-L964)
- [app.js:966-1013](file://app.js#L966-L1013)

### Additional Reporting and Utility APIs
- Endpoint: GET /api/summary-prepaid
  - Method: GET
  - URL: /api/summary-prepaid
  - Auth: cekAuth
  - Response: Summary statistics for prepaid module
  - Notes: Aggregated metrics for prepaid taxes

- Endpoint: GET /api/data-client-ledger
  - Method: GET
  - URL: /api/data-client-ledger
  - Auth: cekAuth
  - Response: Client ledger records
  - Notes: Accounting/ledger integration

- Endpoint: GET /api/years-vatout
  - Method: GET
  - URL: /api/years-vatout
  - Auth: cekAuth
  - Response: Distinct years extracted from VATOUT data
  - Notes: Used for filtering and reporting

- Endpoint: GET /api/dashboard-summary
  - Method: GET
  - URL: /api/dashboard-summary
  - Auth: cekAuth
  - Query: entitas (optional)
  - Response: Dashboard metrics aggregated by entity
  - Notes: High-level overview for dashboards

- Endpoint: GET /api/summary
  - Method: GET
  - URL: /api/summary
  - Auth: cekAuth
  - Response: General system summary
  - Notes: Multi-module overview

**Section sources**
- [app.js:1015-1022](file://app.js#L1015-L1022)
- [app.js:1024-1098](file://app.js#L1024-L1098)
- [app.js:1399-1417](file://app.js#L1399-L1417)
- [app.js:1453-1503](file://app.js#L1453-L1503)
- [app.js:1504-1562](file://app.js#L1504-L1562)

### Requests and Approvals
- Endpoint: GET /api/my-requests
  - Method: GET
  - URL: /api/my-requests
  - Auth: cekAuth
  - Response: User's pending/approved requests
  - Notes: Self-service request history

- Endpoint: GET /api/pending-requests
  - Method: GET
  - URL: /api/pending-requests
  - Auth: cekAuth
  - Response: Pending approval requests for supervisors
  - Notes: Supervisor dashboard for approvals

**Section sources**
- [app.js:1447-1448](file://app.js#L1447-L1448)
- [app.js:1448-1449](file://app.js#L1448-L1449)

### Export APIs
- Endpoint: GET /api/export/vatout
  - Method: GET
  - URL: /api/export/vatout
  - Auth: cekAuth
  - Query: date range, entity, branch filters
  - Response: CSV/Excel stream
  - Notes: Batch export for VATOUT

- Endpoint: GET /api/export/payable
  - Method: GET
  - URL: /api/export/payable
  - Auth: cekAuth
  - Query: date range, entity, branch filters
  - Response: CSV/Excel stream
  - Notes: Batch export for payable taxes

- Endpoint: GET /api/export/prepaid
  - Method: GET
  - URL: /api/export/prepaid
  - Auth: cekAuth
  - Query: date range, entity, branch filters
  - Response: CSV/Excel stream
  - Notes: Batch export for prepaid taxes

- Endpoint: GET /api/export/client-ledger
  - Method: GET
  - URL: /api/export/client-ledger
  - Auth: cekAuth
  - Query: date range, entity, filters
  - Response: CSV/Excel stream
  - Notes: Export client ledger data

**Section sources**
- [app.js:917-930](file://app.js#L917-L930)
- [app.js:1103-1115](file://app.js#L1103-L1115)
- [app.js:1164-1176](file://app.js#L1164-L1176)
- [app.js:1191-1210](file://app.js#L1191-L1210)

## Dependency Analysis
- Authentication and RBAC are enforced at route level via middleware.
- Database operations are centralized with helper wrappers for queries and runs.
- Export endpoints depend on filtered queries and workbook generation utilities.
- Audit logging is integrated into mutation workflows.
- New bulk comparison endpoints reduce database load by consolidating multiple queries.

```mermaid
graph LR
Auth["cekAuth"] --> RBAC["cekRoleAPI"]
RBAC --> Routes["Route Handlers"]
Routes --> DB["SQLite"]
Routes --> Audit["audit_logs"]
Routes --> Export["Export Utils"]
```

**Diagram sources**
- [app.js:504-512](file://app.js#L504-L512)
- [app.js:557-575](file://app.js#L557-L575)
- [app.js:375-379](file://app.js#L375-L379)

**Section sources**
- [app.js:504-512](file://app.js#L504-L512)
- [app.js:557-575](file://app.js#L557-L575)
- [app.js:375-379](file://app.js#L375-L379)

## Performance Considerations
- Pagination and debounced SQL logic are used for data-vatin listings to reduce load.
- Indexes are created on frequently queried columns to improve query performance.
- Rate limiting is applied to login attempts to mitigate brute-force attacks.
- **Updated**: New bulk comparison endpoint (`/api/prepaid-comparison-bulk`) replaces N+1 query patterns for improved performance.
- **Updated**: Internal portion management reduces redundant database calls for JO member calculations.

Practical tips:
- Prefer filtered queries with appropriate LIMIT/OFFSET for large datasets.
- Use entity and branch filters to minimize result sets.
- Leverage export endpoints for bulk operations instead of repeated GET calls.
- Use bulk comparison endpoints for better performance when processing multiple prepaid items.

**Section sources**
- [TDS_Sequence_Diagram.md:107-108](file://TDS_Sequence_Diagram.md#L107-L108)
- [app.js:485-499](file://app.js#L485-L499)
- [app.js:91-97](file://app.js#L91-L97)
- [app.js:966-1013](file://app.js#L966-L1013)

## Troubleshooting Guide
Common errors and resolutions:
- 401 Unauthorized: Occurs when accessing protected endpoints without a valid session. Ensure the user is logged in and the session cookie is present.
- 403 Forbidden: Occurs when the user's role lacks permission for the endpoint. Verify the user role and required roles for the endpoint.
- 500 Internal Server Error: Indicates database or server-side issues. Check server logs and ensure database connectivity and table integrity.

Operational checks:
- Confirm authentication middleware is invoked before RBAC for all protected endpoints.
- Validate that static HTML protection prevents direct access to .html files.
- Review audit logs for mutation events and approval trails.
- Monitor bulk comparison endpoints for performance improvements over individual queries.

**Section sources**
- [app.js:504-512](file://app.js#L504-L512)
- [app.js:546-554](file://app.js#L546-L554)
- [app.js:375-379](file://app.js#L375-L379)

## Conclusion
The TDS REST API provides comprehensive coverage for master data, audit logs, migrations, project management, items, details, and auxiliary APIs, along with robust authentication and export capabilities. Recent enhancements include improved performance through bulk comparison operations and enhanced JO project support with internal portion management. Adhering to the documented authentication and authorization requirements ensures secure and reliable access to system resources. For production usage, follow the parameter specifications and response formats outlined above, and leverage the optimized endpoints for efficient reporting workflows.