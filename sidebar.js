/**
 * sidebar.js — Dynamic Sidebar Initialization
 * Mengisi sub-menu Faktur Keluaran dengan tahun yang tersedia di database
 * Bekerja dengan MutationObserver sehingga otomatis aktif di semua halaman
 */
(function () {
    /**
     * Sinkronisasi dropdown entitas dengan localStorage
     * Dipanggil otomatis setelah sidebar dimuat ke DOM
     */
    function syncEntityDropdown() {
        const select = document.getElementById('global-entity-select');
        if (!select) return;
        const saved = localStorage.getItem('lastEntitas');
        if (saved && select.value !== saved) {
            select.value = saved;
        }
    }

    /**
     * Ambil tahun yang tersedia dari server, lalu inject link ke sub-menu
     */
    function populateVatoutYears() {
        const container = document.getElementById('sub-vatout');
        if (!container) return;

        const entitas = localStorage.getItem('lastEntitas') || 'BBS';

        fetch('/api/years-vatout?entitas=' + entitas)
            .then(r => r.json())
            .then(years => {
                // Hapus link dashboard yang lama (dengan tahun hardcoded)
                container.querySelectorAll('a[href*="dashboard-vatout"]').forEach(a => a.remove());

                // Inbox link (selalu ada dan dipertahankan di bawah)
                const inboxLink = container.querySelector('a[href="/inbox-vatout"]');

                // Fallback: jika tidak ada data di DB, tampilkan minimal tahun berjalan
                // agar link dashboard tidak menghilang sama sekali
                if (years.length === 0) {
                    const tahunSekarang = new Date().getFullYear().toString();
                    years = [tahunSekarang];
                }

                // Insert year links sebelum inbox link (urutan terbaru di atas)
                years.forEach(y => {
                    const a = document.createElement('a');
                    a.href = '/dashboard-vatout?year=' + y;
                    a.className = 'sidebar-link sub-link';
                    a.textContent = '📊 Dashboard ' + y;
                    // Tandai aktif jika URL saat ini sudah cocok
                    if (window.location.href.includes('year=' + y)) {
                        a.classList.add('active');
                    }
                    container.insertBefore(a, inboxLink || null);
                });

                // Highlight Laporan Rekapitulasi if active
                const summaryLink = container.querySelector('a[href="/summary-vatout"]');
                if (summaryLink && window.location.pathname === '/summary-vatout') {
                    summaryLink.classList.add('active');
                }

                // Jika ada link yang aktif, buka parent sub-menu dan grup sidebar
                const activeYearLink = container.querySelector('.sidebar-link.active');
                if (activeYearLink) {
                    const nestedItem = activeYearLink.closest('.sidebar-item-nested');
                    if (nestedItem) nestedItem.classList.add('open');
                    const sidebarGroup = activeYearLink.closest('.sidebar-group');
                    if (sidebarGroup) sidebarGroup.classList.add('expanded');
                }
            })
            .catch(() => {
                // Gagal fetch (misalnya server error) → inject fallback tahun berjalan
                const container2 = document.getElementById('sub-vatout');
                if (!container2) return;
                container2.querySelectorAll('a[href*="dashboard-vatout"]').forEach(a => a.remove());
                const inboxLink2 = container2.querySelector('a[href="/inbox-vatout"]');
                const tahunSekarang = new Date().getFullYear().toString();
                const a = document.createElement('a');
                a.href = '/dashboard-vatout?year=' + tahunSekarang;
                a.className = 'sidebar-link sub-link';
                a.textContent = '📊 Dashboard ' + tahunSekarang;
                container2.insertBefore(a, inboxLink2 || null);
            });
    }

    // Ekspos agar bisa dipanggil manual saat entitas berubah
    window.refreshSidebarYears = populateVatoutYears;

    // MutationObserver: panggil inisialisasi segera setelah
    // sidebar-container terisi (sidebar dimuat secara async via fetch)
    const observer = new MutationObserver(function (mutations) {
        const select = document.getElementById('global-entity-select');
        if (select) {
            observer.disconnect();
            // 1. Sinkronisasi dropdown entitas dari localStorage
            syncEntityDropdown();
            // 2. Populate sub-menu tahun VAT OUT
            populateVatoutYears();
        }
    });

    // Mulai observasi segera setelah body tersedia
    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }
})();

