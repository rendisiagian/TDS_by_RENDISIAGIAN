---
kind: frontend_style
name: CSS-Only Design System with CSS Variables, Dark Mode & Shared Components
category: frontend_style
scope:
    - '**'
source_files:
    - style.css
    - theme.js
    - sidebar.js
    - toast.js
    - utils.js
---

The Tax Database System uses a pure CSS design system built on CSS custom properties (variables), with no CSS framework or preprocessor. All styling is centralized in a single `style.css` file (~3174 lines) and supplemented by small client-side JavaScript modules for interactivity.

**System & Approach**
- **CSS Custom Properties (Design Tokens)**: The entire theme is defined via `:root` variables covering primary/accent/neutral/semantic color scales (e.g., `--primary-50` through `--primary-900`, `--success-*`, `--warning-*`, `--danger-*`), spacing (`--spacing-xs` to `--spacing-2xl`), border radius (`--radius-sm` to `--radius-xl`), shadows, and transitions. A `[data-theme="dark"]` selector overrides these tokens to produce a full dark mode.
- **No CSS Framework**: There is no Tailwind, Bootstrap, or similar library — all components are hand-written CSS classes.
- **Single-file stylesheet**: `style.css` is the sole source of visual style; it is included directly from each HTML page.
- **Client-side JS helpers**: `theme.js` toggles `data-theme` on `<html>` and persists the choice in `localStorage`; `toast.js` provides global `showToast`, `showConfirm`, loading overlays, and mobile sidebar toggle; `sidebar.js` dynamically injects year-based sub-menu links via `/api/years-vatout`.

**Key Files**
- `style.css` — complete design system, layout, components, responsive rules, print styles, animations, scrollbar styling
- `theme.js` — dark/light mode toggle, user header population, sidebar accordion logic
- `sidebar.js` — dynamic VAT OUT year menu population using MutationObserver
- `toast.js` — toast notifications, confirm dialogs, loading indicators, mobile hamburger
- `utils.js` — shared `bersihkanAngka` and `formatRupiah` utilities attached to `window`
- `package.json` — no frontend build tooling; dependencies are server-side only (Express, Socket.IO, SQLite)

**Architecture & Conventions**
- **Component class naming**: Semantic BEM-like class names (`card`, `btn-verify`, `btn-edit`, `btn-reject`, `.stat-card`, `.modal-box`, `.drop-zone`, `.toolbar-actions`, `.stats-grid`). Each component has a consistent structure (e.g., stat cards use an accent pseudo-element `::before`).
- **Layout primitives**: `.app-wrapper` (flex row), `.sidebar` (fixed-width 280px, sticky), `.main-content` (flex:1), `.container` (padding wrapper). Responsive breakpoints at 1024px and 768px collapse sidebar and stack grids.
- **Table system**: Single source of truth in Section 12 of `style.css` — `.table-responsive`, zebra striping, sticky headers, filter rows with compact inputs, hover highlights.
- **Button taxonomy**: Action buttons follow a gradient scheme tied to semantic colors (`btn-verify` = success, `btn-edit` = warning, `btn-reject` = danger, `btn-simpan` = primary). All buttons share ripple-on-active effect via `::before` pseudo-element.
- **Dark mode**: Applied by setting `data-theme="dark"` on `<html>`; every component has corresponding `[data-theme="dark"]` overrides for backgrounds, borders, text, and interactive states.
- **Print styles**: Dedicated `@media print` block hides navigation, action columns, and reformats tables for paper output.
- **Responsive strategy**: Mobile-first adjustments via media queries; sidebar becomes full-width and collapsible via `__toggleMobileSidebar` in `toast.js`.

**Conventions & Constraints**
- All colors must come from CSS variables — no hardcoded hex values in new code beyond the token definitions.
- Theme switching is always done through `window.__toggleDarkMode()` which sets `data-theme` and persists to `localStorage('theme')`.
- Sidebar interactions go through `window.toggleSidebarGroup` / `window.toggleSubMenu` rather than direct DOM manipulation.
- Toast/notification UI must use `window.showToast` / `window.showConfirm` instead of native `alert`/`confirm`.
- Number formatting uses the shared `window.formatRupiah` and `window.bersihkanAngka` utilities from `utils.js`.
- No CSS-in-JS, SCSS, or build step — changes are made directly in `style.css`.