/**
 * Shared utility functions for TDS Frontend
 */

// AUDIT FIX (H-05): Konsolidasi bersihkanAngka dari backend
function bersihkanAngka(t) {
    if (t === null || t === undefined || t === '') return 0;
    return parseFloat(t.toString().replace(/\./g, '').replace(',', '.')) || 0;
}

// AUDIT FIX (H-04): Konsolidasi formatRupiah untuk mencegah duplikasi masif
function formatRupiah(n) {
    if (n === null || n === undefined || isNaN(n)) return "Rp 0";
    return "Rp " + Number(bersihkanAngka(n)).toLocaleString('id-ID');
}

// Attach to window so they are globally available
window.bersihkanAngka = bersihkanAngka;
window.formatRupiah = formatRupiah;
