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
    const groups = document.querySelectorAll('.sidebar-group');
    groups.forEach(group => {
        if (group.id === groupId) {
            group.classList.toggle('expanded');
        } else {
            // Tutup group lain agar rapi
            group.classList.remove('expanded');
        }
    });
};

// Pastikan modul yang aktif otomatis terbuka saat halaman dimuat
document.addEventListener('DOMContentLoaded', () => {
    // Gunakan interval singkat karena sidebar dimuat secara asinkron (fetch)
    const checkSidebar = setInterval(() => {
        let currentPath = window.location.pathname;
        
        // --- LOGIKA PINTAR UNTUK INBOX ---
        // Jika sedang di halaman inbox, arahkan penanda aktif ke tombol dashboard-nya
        if (currentPath.startsWith('/inbox-')) {
            currentPath = currentPath.replace('/inbox-', '/dashboard-');
        }

        const activeLink = document.querySelector(`.sidebar-link[href="${currentPath}"]`);
        
        if (activeLink) {
            activeLink.classList.add('active');
            const parentGroup = activeLink.closest('.sidebar-group');
            if (parentGroup) {
                parentGroup.classList.add('expanded');
            }
            clearInterval(checkSidebar); // Hentikan pengecekan jika sudah ketemu
        }
    }, 100);
    
    // Berhenti cek setelah 3 detik jika tidak ketemu
    setTimeout(() => clearInterval(checkSidebar), 3000);
});
