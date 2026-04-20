// Dark Mode & Theme Management
(function() {
    var t = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', t);
})();

window.__toggleDarkMode = function() {
    var html = document.documentElement;
    var current = html.getAttribute('data-theme') || 'light';
    var next = (current === 'dark') ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    var iconEl = document.getElementById('dm-icon');
    var textEl = document.getElementById('dm-text');
    if (iconEl && textEl) {
        iconEl.textContent = (next === 'dark') ? '\u2600\ufe0f' : '\ud83c\udf19';
        textEl.textContent = (next === 'dark') ? 'Light Mode' : 'Dark Mode';
    }
};

// Load user info and display in header
document.addEventListener('DOMContentLoaded', function() {
    fetch('/api/me').then(function(r) { return r.json(); }).then(function(user) {
        var el = document.getElementById('header-user-name');
        if (el && user && user.nama) {
            el.textContent = user.nama;
        }
        // Also update manage_users page
        var el2 = document.getElementById('user-name-display');
        if (el2 && user && user.nama) {
            el2.textContent = user.nama;
        }
    }).catch(function() {});
});

// Fungsi Global untuk Sidebar Accordion
window.toggleSidebarGroup = function(groupId) {
    const target = document.getElementById(groupId);
    if (!target) return;
    const isExpanded = target.classList.contains('expanded');
    // Tutup semua group lain
    document.querySelectorAll('.sidebar-group').forEach(g => g.classList.remove('expanded'));
    // Toggle target
    if (!isExpanded) target.classList.add('expanded');
};

window.toggleSubMenu = function(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const parent = menu.closest('.sidebar-item-nested');
    if (!parent) return;
    // Toggle class 'open' — animasi dikontrol CSS via max-height
    const isOpen = parent.classList.contains('open');
    parent.classList.toggle('open', !isOpen);
    // Refresh tahun jika sub-vatout dibuka
    if (!isOpen && menuId === 'sub-vatout' && typeof window.refreshSidebarYears === 'function') {
        window.refreshSidebarYears();
    }
};

// Pastikan modul yang aktif otomatis terbuka saat halaman dimuat
document.addEventListener('DOMContentLoaded', () => {
    // Gunakan interval singkat karena sidebar dimuat secara asinkron (fetch)
    // dan karena sidebar.js mungkin masih mengisi link tahun secara dinamis
    const checkSidebar = setInterval(() => {
        const rawPath   = window.location.pathname;
        const rawSearch = window.location.search; // e.g. "?year=2026"

        // Buat daftar kandidat path yang akan dicoba, urut prioritas:
        // 1. Path asli + query (misal /dashboard-vatout?year=2026)
        // 2. Path asli saja  (misal /inbox-vatout)
        // 3. Jika ini halaman inbox → coba ekuivalennya di dashboard
        const candidates = [
            rawPath + rawSearch,
            rawPath,
        ];
        if (rawPath.startsWith('/inbox-')) {
            const dashPath = rawPath.replace('/inbox-', '/dashboard-');
            candidates.push(dashPath + rawSearch, dashPath);
        }

        // Coba satu per satu sampai ada yang ketemu
        let activeLink = null;
        for (const p of candidates) {
            activeLink = document.querySelector(`.sidebar-link[href="${p}"]`);
            if (activeLink) break;
        }

        if (activeLink) {
            activeLink.classList.add('active');

            // Buka parent sidebar-group (MODUL PAJAK, AKUNTANSI, dll)
            const parentGroup = activeLink.closest('.sidebar-group');
            if (parentGroup) parentGroup.classList.add('expanded');

            // Buka parent sub-menu nested (Faktur Keluaran, dst)
            const parentNested = activeLink.closest('.sidebar-item-nested');
            if (parentNested) parentNested.classList.add('open');

            clearInterval(checkSidebar);
        }
    }, 100);

    // Berhenti cek setelah 4 detik (lebih lama karena sidebar.js fetch API tahun)
    setTimeout(() => clearInterval(checkSidebar), 4000);
});
