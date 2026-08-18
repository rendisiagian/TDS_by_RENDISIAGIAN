# Real-time Processing & Socket.io Integration

<cite>
**Referenced Files in This Document**
- [app.js](file://app.js)
- [utils.js](file://utils.js)
- [pagination.js](file://pagination.js)
- [vat_in/dashboard_vatin.html](file://vat_in/dashboard_vatin.html)
- [vat_out/dashboard_vatout.html](file://vat_out/dashboard_vatout.html)
- [audit_logs.html](file://audit_logs.html)
</cite>

## Update Summary
**Changes Made**
- Updated Socket.IO implementation with streamlined role-based access control and enhanced validation
- **NEW**: Enhanced PDF archive cleanup system ensuring proper removal of physical PDF files when records are deleted
- **ENHANCED**: Improved Socket.io handlers now support BATAL (cancel) and AKTIFKAN (activate) events with role-based access controls and audit logging for invoice cancellation workflows
- **IMPROVED**: Enhanced supervisor approval workflow integration for cancellation requests with better real-time status updates
- **ENHANCED**: Better real-time synchronization across all connected clients for cancellation status changes
- Consolidated helper functions for improved security and maintainability
- Enhanced security measures including session validation and role-based authorization
- Streamlined batch upload workflows while maintaining real-time update capabilities
- Improved error handling and audit logging throughout the system

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
10. [Appendices](#appendices)

## Introduction
This document explains the real-time processing system built on Socket.io, focusing on batch PDF upload workflows, live data updates, and real-time synchronization between clients and the server. The system has been streamlined with improved role-based access control, enhanced security measures, and consolidated helper functions while maintaining robust real-time update capabilities for document processing workflows across multiple tax modules (VAT IN, VAT OUT, Prepaid Tax, Tax Payable). **The system now includes comprehensive PDF archive cleanup functionality to prevent orphaned files when records are deleted and enhanced invoice cancellation workflows with BATAL (cancel) and AKTIFKAN (activate) event support, featuring improved supervisor approval integration and better real-time updates across all connected clients.**

## Project Structure
The real-time features are implemented primarily in the server-side application with module-specific client pages:
- Server: Socket.io server initialization and event handlers in [app.js](file://app.js)
- Utilities: Shared utility functions in [utils.js](file://utils.js), pagination logic in [pagination.js](file://pagination.js)
- Clients: Module-specific HTML pages with Socket.io clients for batch uploads and live updates
- Documentation: Functional workflow and roadmap in project documentation

```mermaid
graph TB
subgraph "Server"
APP["app.js<br/>Socket.io server + event handlers"]
UTILS["utils.js<br/>Shared helper functions"]
end
subgraph "Clients"
Vatin["vat_in/dashboard_vatin.html<br/>VAT IN Batch Upload & Cancellation"]
Vatout["vat_out/dashboard_vatout.html<br/>VAT OUT Live Updates & Cancellation"]
Prepaid["prepaidtax_bppu/dashboard_prepaid.html<br/>Prepaid Batch Upload"]
Payable["taxpayable_bppu/dashboard_payable.html<br/>Payable Batch Upload"]
Audit["audit_logs.html<br/>Audit Log Monitoring"]
end
Vatin --> APP
Vatout --> APP
Prepaid --> APP
Payable --> APP
Audit --> APP
APP --> UTILS
```

**Diagram sources**
- [app.js](file://app.js)
- [utils.js](file://utils.js)
- [vat_in/dashboard_vatin.html](file://vat_in/dashboard_vatin.html)
- [vat_out/dashboard_vatout.html](file://vat_out/dashboard_vatout.html)
- [audit_logs.html](file://audit_logs.html)

**Section sources**
- [app.js](file://app.js)
- [utils.js](file://utils.js)

## Core Components
- Socket.io server initialization with enhanced buffer sizing for large PDF payloads
- **Enhanced PDF archive cleanup system** that systematically removes physical PDF files when database records are deleted
- **Enhanced invoice cancellation workflow** supporting BATAL (cancel) and AKTIFKAN (activate) events with role-based access controls and improved supervisor approval integration
- Streamlined batch upload handlers for all tax modules with improved validation
- Real-time notifications for upload completion and module-wide data changes
- Action request pipeline with enhanced supervisor checks and comprehensive audit logging
- Security controls: dummy mode simulation, role-based access control, and module whitelisting
- Consolidated helper functions for number formatting and data processing

Key implementation anchors:
- Server initialization and enhanced buffer size: [app.js](file://app.js)
- **PDF archive cleanup function**: [hapusArsipFisik:1905-1910](file://app.js#L1905-L1910)
- **BATAL/AKTIFKAN event handlers**: [request-action-faktur:2016-2035](file://app.js#L2016-L2035)
- **Enhanced approval workflow for cancellations**: [proses-request handler:2962-2982](file://app.js#L2962-L2982)
- Streamlined batch upload events and completion notifications: [app.js](file://app.js)
- Client-side batch upload triggers and progress handling: [vat_in/dashboard_vatin.html](file://vat_in/dashboard_vatin.html)
- Action request handling and real-time emits: [app.js](file://app.js)
- Shared utility functions: [utils.js](file://utils.js)

**Section sources**
- [app.js](file://app.js)
- [utils.js](file://utils.js)

## Architecture Overview
The real-time architecture centers on Socket.io for bidirectional communication with enhanced security and validation. Clients emit batch upload requests and action commands; the server validates, processes, persists data, broadcasts live updates, and **ensures proper cleanup of associated PDF archives**. Security and audit are enforced server-side with improved role-based access control. **The system now supports comprehensive invoice cancellation workflows with BATAL (cancel) and AKTIFKAN (activate) events, featuring enhanced supervisor approval integration, role-based permissions, complete audit trails, and better real-time updates across all connected clients.**

```mermaid
sequenceDiagram
participant Client as "Client Page"
participant Socket as "Socket.io Server"
participant DB as "SQLite Database"
participant FS as "File System"
Client->>Socket : "upload-pdf-vatin-batch"<br/>payload : { files[], entitas, username }
Socket->>Socket : "Validate payload and module"
Socket->>DB : "Insert parsed records (pending)"
DB-->>Socket : "OK"
Socket-->>Client : "upload-batch-selesai"<br/>result stats
Client->>Socket : "request-action-faktur"<br/>{ mod, action : 'BATAL', faktur, newData }
Socket->>Socket : "Authorize and validate"
alt Supervisor/BATAL
Socket->>DB : "UPDATE tgl_batal for faktur"
DB-->>Socket : "OK"
Socket->>DB : "INSERT audit_logs (BATAL)"
DB-->>Socket : "OK"
else Non-supervisor/BATAL
Socket->>DB : "INSERT user_requests (Pending)"
DB-->>Socket : "OK"
end
Socket-->>Client : "data-baru-{mod}"
```

**Diagram sources**
- [app.js](file://app.js)

## Detailed Component Analysis

### Socket.io Server Initialization and Connection Management
- Initializes Socket.io on the HTTP server with enhanced buffer sizing to support large PDF uploads
- Maintains per-connection user context (role) for authorization decisions with improved validation
- Emits real-time events to connected clients upon data changes with enhanced error handling

Operational highlights:
- Enhanced buffer sizing for large payloads: [app.js](file://app.js)
- Per-connection user context and dummy mode simulation: [app.js](file://app.js)
- Real-time emits after DB operations with improved error handling: [app.js](file://app.js)

**Section sources**
- [app.js](file://app.js)

### Enhanced Invoice Cancellation Workflow (BATAL & AKTIFKAN)
**Updated** The system now supports comprehensive invoice cancellation workflows with BATAL (cancel) and AKTIFKAN (activate) events, featuring enhanced supervisor approval integration and better real-time updates across all connected clients.

The cancellation workflow works as follows:
- **Role-based Access Control**: Only supervisors and administrators can directly cancel invoices; regular users must submit requests for approval through the enhanced approval panel
- **Validation Requirements**: BATAL actions require a valid cancellation date; AKTIFKAN actions clear the cancellation date
- **Module Restriction**: Cancellation is only supported for VAT IN and VAT OUT modules (not applicable to BPPU modules)
- **Enhanced Approval Process**: Non-supervisor requests are automatically routed to the supervisor approval panel with detailed request information
- **Audit Trail**: All cancellation activities are logged with user information, timestamps, and detailed descriptions
- **Real-time Updates**: Changes are immediately broadcast to all connected clients via `data-baru-{mod}` events with improved synchronization

```mermaid
sequenceDiagram
participant UI as "User Interface"
participant Sock as "Socket.io Server"
participant DB as "Database"
UI->>Sock : "request-action-faktur<br/>{action : 'BATAL', faktur, tanggalBatal}"
Sock->>Sock : "Validate role and module"
alt Supervisor/Admin
Sock->>DB : "UPDATE data_{mod} SET tgl_batal = ?"
DB-->>Sock : "OK"
Sock->>DB : "INSERT audit_logs (BATAL)"
DB-->>Sock : "OK"
Sock-->>UI : "data-baru-{mod}<br/>(broadcast to all clients)"
else Regular User
Sock->>DB : "INSERT user_requests (Pending)<br/>jenis_request : 'BATAL_VATIN'"
DB-->>Sock : "OK"
Sock-->>UI : "request-updated<br/>(approval panel notification)"
end
```

**Diagram sources**
- [app.js](file://app.js)

**Section sources**
- [app.js](file://app.js)

### Enhanced PDF Archive Cleanup System
**Updated** The system now includes comprehensive PDF archive cleanup functionality to prevent orphaned files when database records are deleted.

The cleanup process works as follows:
- Before deleting any database record, the system retrieves the associated PDF file path from the `link_pdf_lokal` column
- The `hapusArsipFisik()` function safely removes the physical PDF file from storage using secure path construction
- File deletion uses `path.basename()` to prevent path traversal attacks
- Cleanup occurs both for direct supervisor deletions and approved deletion requests

```mermaid
sequenceDiagram
participant UI as "User Interface"
participant Sock as "Socket.io Server"
participant DB as "Database"
participant FS as "File System"
UI->>Sock : "DELETE action (supervisor)"
Sock->>DB : "SELECT link_pdf_lokal FROM data_{mod} WHERE id = ?"
DB-->>Sock : "{ link_pdf_lokal : 'arsip_xxx.pdf' }"
Sock->>DB : "DELETE FROM data_{mod} WHERE id = ?"
DB-->>Sock : "Record deleted"
Sock->>FS : "hapusArsipFisik(mod, 'arsip_xxx.pdf')"
FS-->>Sock : "File removed successfully"
Sock-->>UI : "data-baru-{mod} (with cleanup confirmation)"
```

**Diagram sources**
- [app.js](file://app.js)

**Section sources**
- [app.js](file://app.js)

### Streamlined Batch PDF Upload Workflow
End-to-end flow with enhanced validation:
- Client extracts text from PDFs using PDF.js and chunks files for upload
- Client emits a batch upload event with extracted text and buffers
- Server validates module, performs enhanced duplicate checking, inserts pending records, and reports completion statistics

```mermaid
sequenceDiagram
participant UI as "Module Inbox UI"
participant Sock as "Socket.io Server"
participant DB as "SQLite"
UI->>UI : "Extract PDF text (PDF.js)"
UI->>Sock : "upload-pdf-{mod}-batch"<br/>{ files[], entitas, username }
Sock->>Sock : "Validate module and dummy mode"
Sock->>DB : "Check duplicates and persist pending records"
DB-->>Sock : "OK"
Sock-->>UI : "upload-batch-selesai"<br/>{ total, sukses, duplikat, gagal }
```

**Diagram sources**
- [app.js](file://app.js)
- [vat_in/dashboard_vatin.html](file://vat_in/dashboard_vatin.html)

**Section sources**
- [app.js](file://app.js)
- [vat_in/dashboard_vatin.html](file://vat_in/dashboard_vatin.html)

### Enhanced Real-time Data Updates and Synchronization
- After successful edits/deletes or bulk actions, the server emits module-specific real-time events to synchronize client views
- **With integrated PDF archive cleanup**, deletions now ensure both database records and physical files are removed
- **Enhanced cancellation workflow updates** trigger immediate UI refreshes across all connected clients with improved synchronization
- **Better real-time status propagation** ensures all clients see cancellation status changes instantly
- Clients listen for these events and refresh their UI accordingly with improved error handling

```mermaid
sequenceDiagram
participant Client as "Any Module UI"
participant Sock as "Socket.io Server"
participant DB as "SQLite"
participant FS as "File System"
Sock->>DB : "Apply change (edit/delete/cancel)"
DB-->>Sock : "OK"
alt Delete operation
Sock->>FS : "Cleanup associated PDF files"
FS-->>Sock : "Files removed"
end
alt Cancel/Activate operation
Sock->>DB : "Update tgl_batal field"
DB-->>Sock : "OK"
end
Sock-->>Client : "data-baru-{mod}<br/>(broadcast to all connected clients)"
Client->>Client : "Reload filtered data and metrics"
```

**Diagram sources**
- [app.js](file://app.js)

**Section sources**
- [app.js](file://app.js)

### Improved Action Request Pipeline (Maker-Checker)
- Clients can request edits/deletes via a dedicated action event with enhanced validation
- Supervisor/admin roles bypass direct changes; others trigger approval workflows
- **Deletion requests now include automatic PDF archive cleanup** after approval
- **Enhanced cancellation requests follow the same approval pattern** with BATAL_ and AKTIFKAN_ prefixes and improved request tracking
- **Better approval panel integration** provides supervisors with detailed cancellation request information
- Audit logs are inserted for transparency with comprehensive tracking

```mermaid
flowchart TD
Start(["Action Request Received"]) --> Validate["Validate module and parameters"]
Validate --> IsSupervisor{"Is Supervisor/Admin?"}
IsSupervisor --> |Yes| GetPdfPath["Get PDF path before delete"]
IsSupervisor --> |No| InsertRequest["Insert user_requests for approval<br/>jenis_request: 'BATAL_VATIN' or 'AKTIFKAN_VATIN'"]
GetPdfPath --> ApplyChange["Apply change to DB"]
ApplyChange --> CleanupFiles["hapusArsipFisik() - Remove PDF"]
CleanupFiles --> EmitUpdate["Emit data-baru-{mod}"]
InsertRequest --> EmitUpdated["Emit request-updated<br/>(approval panel notification)"]
EmitUpdate --> End(["Done"])
EmitUpdated --> End
```

**Diagram sources**
- [app.js](file://app.js)

**Section sources**
- [app.js](file://app.js)

### Consolidated Helper Functions
- Centralized utility functions for number formatting and data processing
- **Enhanced with PDF archive cleanup utilities** for safe file deletion
- Improved consistency across frontend and backend operations
- Enhanced error handling and validation

**Section sources**
- [utils.js](file://utils.js)

### Enhanced Real-time Data Validation and Deduplication
- During batch uploads, the server performs comprehensive duplicate checking against existing records and staging areas
- Pending state ensures manual reconciliation before finalization with improved validation

**Section sources**
- [app.js](file://app.js)

## Dependency Analysis
The real-time system relies on:
- Socket.io for bidirectional messaging with enhanced security
- SQLite for persistence with improved indexing
- **Node.js fs module for PDF archive management and cleanup**
- PDF.js on the client for text extraction
- Shared UI components and navigation logic with consolidated utilities

```mermaid
graph LR
PDFJS["PDF.js (Client)"] --> Inbox["Module Dashboard Pages"]
Inbox --> SocketIO["Socket.io Client"]
SocketIO --> Server["app.js"]
Server --> SQLite["SQLite Database"]
Server --> FS["Node.js fs<br/>PDF Archive Management"]
Server --> Utils["utils.js"]
Utils --> Frontend["Frontend Applications"]
```

**Diagram sources**
- [app.js](file://app.js)
- [utils.js](file://utils.js)
- [vat_in/dashboard_vatin.html](file://vat_in/dashboard_vatin.html)

**Section sources**
- [app.js](file://app.js)
- [utils.js](file://utils.js)

## Performance Considerations
- Large payload handling: Server buffer sizing accommodates substantial PDFs with improved memory management
- **Efficient PDF cleanup**: File deletion is performed asynchronously to avoid blocking database operations
- **Optimized cancellation workflow**: Direct supervisor actions bypass approval queue for better performance
- **Enhanced approval processing**: Improved request handling reduces latency in the approval workflow
- Chunked uploads: Client splits files into manageable chunks to reduce memory pressure and improve reliability
- Debounced filtering and server-side pagination minimize UI lag and database load
- Real-time emits are scoped to module-specific channels to avoid unnecessary broadcasts
- **Better real-time synchronization**: Optimized broadcasting ensures efficient updates across all connected clients
- Consolidated helper functions reduce code duplication and improve performance

Recommendations:
- Monitor upload throughput and adjust chunk sizes dynamically
- Use server-side pagination parameters (page, limit) to cap result sets
- Implement rate limiting for repeated action requests
- Leverage consolidated utility functions for consistent performance
- **Monitor file system operations for cleanup efficiency**
- **Track cancellation request approval times for workflow optimization**
- **Monitor real-time connection performance for optimal user experience**

**Section sources**
- [app.js](file://app.js)
- [pagination.js](file://pagination.js)
- [utils.js](file://utils.js)

## Troubleshooting Guide
Common issues and resolutions:
- Upload fails silently
  - Verify client emits the correct event and payload shape
  - Check server logs for validation errors and dummy mode behavior
  - Confirm module whitelist and role-based access
  - References: [app.js](file://app.js)

- No real-time updates
  - Ensure the server emits the correct channel (e.g., data-baru-{mod})
  - Confirm clients listen for the appropriate event
  - Check connection authentication and session validation
  - References: [app.js](file://app.js), [vat_in/dashboard_vatin.html](file://vat_in/dashboard_vatin.html)

- **Invoice cancellation not working**
  - Verify the action type is correctly set to 'BATAL' or 'AKTIFKAN'
  - Check that the module is VAT IN or VAT OUT (not BPPU modules)
  - For BATAL actions, ensure a valid cancellation date is provided
  - Verify user has appropriate role permissions (supervisor/administrator for direct action)
  - Check that non-supervisor requests are properly routed to the approval panel
  - References: [app.js](file://app.js)

- **Orphaned PDF files after deletion**
  - Verify the `hapusArsipFisik()` function is being called after database deletions
  - Check that `link_pdf_lokal` values are properly retrieved before deletion
  - Ensure file paths are correctly constructed using `path.join()` and `path.basename()`
  - References: [app.js](file://app.js)

- Duplicate uploads or missing deduplication
  - Review server-side duplicate guards and staging checks
  - Verify enhanced validation logic is working correctly
  - References: [app.js](file://app.js)

- Slow UI or lag
  - Enable server-side pagination and debounce filters
  - Check consolidated utility function usage
  - References: [pagination.js](file://pagination.js), [utils.js](file://utils.js)

- **Cancellation requests stuck in pending status**
  - Check the approval panel for pending requests
  - Verify supervisor/administrator is reviewing and approving/rejecting requests
  - Monitor audit logs for cancellation-related entries
  - Ensure proper request format with jenis_request containing 'BATAL_' or 'AKTIFKAN_' prefix
  - References: [audit_logs.html](file://audit_logs.html), [app.js](file://app.js)

- **Real-time synchronization issues**
  - Verify that data-baru-{mod} events are being emitted after cancellation operations
  - Check that all connected clients are properly listening for module-specific events
  - Ensure network connectivity between clients and server
  - References: [app.js](file://app.js)

**Section sources**
- [app.js](file://app.js)
- [pagination.js](file://pagination.js)
- [utils.js](file://utils.js)
- [vat_in/dashboard_vatin.html](file://vat_in/dashboard_vatin.html)
- [audit_logs.html](file://audit_logs.html)

## Conclusion
The real-time processing system leverages Socket.io to deliver responsive batch PDF ingestion, live synchronization, and secure action workflows across tax modules. **The enhanced invoice cancellation workflow with BATAL (cancel) and AKTIFKAN (activate) events provides comprehensive control over invoice status management with improved supervisor approval integration, role-based permissions, complete audit trails, and better real-time updates across all connected clients.** The enhanced PDF archive cleanup system ensures data integrity by preventing orphaned files when records are deleted. The streamlined implementation with improved role-based access control, enhanced security measures, and consolidated helper functions ensures maintainability. With proper monitoring and scaling strategies, the system can handle increased loads while maintaining responsiveness and security.

## Appendices

### Event Types and Message Protocols
- Client to Server
  - upload-pdf-vatin-batch: { files[], entitas, username }
  - upload-pdf-vatout-batch: { files[], entitas, username }
  - upload-pdf-prepaid-batch: { files[], entitas, username }
  - upload-pdf-payable-batch: { files[], entitas, username }
  - request-action-faktur: { mod, action, faktur, newData?, id_user?, username? }
    - **Enhanced**: action can be 'BATAL' or 'AKTIFKAN' for invoice cancellation workflows
    - **Enhanced**: newData.tanggalBatal required for BATAL actions
    - **Enhanced**: Proper role validation and approval routing for non-supervisor users
  - tambah-cabang, edit-cabang, hapus-cabang, tambah-kontak, edit-kontak, hapus-kontak (admin-only)

- Server to Client
  - upload-batch-selesai: { modul, total, sukses, duplikat, gagal }
  - data-baru-{mod}: broadcast for UI refresh with enhanced synchronization
  - request-updated: feedback for non-supervisor requests with improved approval panel integration
  - error-action, error-cabang, error-kontak: error responses

Security and validation:
- Dummy mode simulation for safe testing
- Role-based access checks with enhanced validation
- Module whitelist enforcement
- **Enhanced invoice cancellation workflow with role-based permissions and improved approval integration**
- **Automatic PDF archive cleanup on record deletion**
- **Comprehensive audit logging for all cancellation activities**
- Session validation and authentication
- **Better real-time synchronization across all connected clients**

**Section sources**
- [app.js](file://app.js)

### Scalability and Load Balancing Considerations
- Stateless Socket.io deployments: Use sticky sessions or external state stores if scaling horizontally
- Broadcast scope: Limit emits to module-specific channels to reduce overhead
- Database contention: Use transactions and batch writes for uploads; consider read replicas for reporting
- **File system scalability**: Consider distributed file storage solutions for large-scale PDF archive management
- **Enhanced cancellation workflow scalability**: Improved approval queues should be monitored and optimized for high-volume environments
- **Real-time performance optimization**: Better event broadcasting ensures efficient updates across scaled client connections
- Horizontal scaling: Distribute clients across nodes and route Socket.io connections via a load balancer supporting WebSocket passthrough
- Consolidated utilities: Reduce code duplication and improve maintainability across scaled instances

[No sources needed since this section provides general guidance]