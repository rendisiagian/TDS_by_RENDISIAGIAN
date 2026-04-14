# Tax Database System - PRD & Progress

## Problem Statement
User memiliki sistem web Tax Database (Node.js/Express + SQLite + Socket.IO) dengan ~20 file HTML/JS/CSS. Diminta untuk mempercantik tampilan, menambah Dark Mode, dan mengecek hal-hal yang perlu diperbaiki.

## Architecture
- **Backend:** Node.js + Express + Socket.IO + SQLite (`app.js`)
- **Frontend:** Static HTML + CSS served by Express
- **Database:** SQLite (`tax_database.db`)
- **Modules:** VAT IN, VAT OUT, Tax Payable, Prepaid Tax
- **Features:** QR Scanner (mobile), Maker-Checker workflow, User Management, Batch PDF Upload

## What's Been Implemented (14 Jan 2026)
1. **Complete CSS Redesign (`style.css`):**
   - CSS Variables design system for easy theming
   - Modern Professional Blue color scheme
   - Dark Mode support with `[data-theme="dark"]`
   - Smooth animations & transitions
   - Responsive design (mobile, tablet, desktop)
   - Custom scrollbar styling
   - Print-friendly styles
   - Better shadows, gradients, and visual depth
   - Improved table, form, button, card, badge designs

2. **Dark Mode Toggle:**
   - Added to `sidebar.html` (appears on all dashboard pages)
   - Added to `login.html` (standalone)
   - Theme persisted in `localStorage`
   - Flash-free: theme applied before page render via inline script
   - All 14 HTML files updated with `data-theme="light"` and init script

3. **Viewport Meta Tags:**
   - Added `<meta name="viewport">` to all HTML files for mobile responsiveness

## Prioritized Backlog
### P0 (High Priority)
- Export to Excel/CSV functionality
- Print button on dashboards
- Charts/Graphs for Summary page

### P1 (Medium Priority)
- Logo/branding customization
- Loading spinners/skeleton screens
- Toast notifications instead of `alert()`
- Better form validation with inline messages

### P2 (Nice to Have)
- Keyboard shortcuts
- Search across all modules
- Dashboard statistics cards (total faktur, total PPN, etc.)
- Activity log / audit trail page
- PDF preview in modal (instead of new tab)

## User Personas
- **Administrator:** Full access, manage users, approve/reject requests
- **Supervisor:** Checker role, can approve and execute edits/deletes directly
- **Admin (Staff):** Input & extraction, needs approval for edits/deletes

## Next Tasks
- Implement Export Excel/CSV for data tables
- Add Chart.js to Summary page
- Add print button on dashboard headers
- Replace emoji icons with proper SVG/icon library
