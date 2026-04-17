// Test simulasi engine ekstraksi legacy vs modern
// Jalankan dengan: node debug_samples/test_ekstraksi.js

const fs = require('fs');
const path = require('path');

// Helper
function bersihkanAngka(str) {
    if (!str) return 0;
    return parseFloat(str.replace(/\./g, '').replace(',', '.')) || 0;
}
function formatTanggal(tglStr) {
    const bulan = { 'Januari': '01', 'Februari': '02', 'Maret': '03', 'April': '04', 'Mei': '05', 'Juni': '06', 'Juli': '07', 'Agustus': '08', 'September': '09', 'Oktober': '10', 'November': '11', 'Desember': '12' };
    const m = tglStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
    if (!m) return tglStr;
    return `${m[3]}-${bulan[m[2]] || '??'}-${m[1].padStart(2, '0')}`;
}

function ekstrak(namaFile) {
    // Simulasi teks PDF: pdf.js menggabungkan items dengan spasi, tanpa newline
    // Sehingga teks menjadi 1 baris panjang
    const rawFile = fs.readFileSync(path.join(__dirname, namaFile), 'utf8');
    const teks = rawFile.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');
    console.log(`\n${'='.repeat(60)}`);
    console.log(`FILE: ${namaFile}`);
    console.log('='.repeat(60));

    let mNo = teks.match(/Kode dan Nomor Seri Faktur Pajak:\s*([\d\.\-]+)/i) || teks.match(/Kode dan Nomor Seri Faktur Pajak\s*:\s*([\d\.\-]+)/i);
    if (!mNo) { console.log('❌ GAGAL: No faktur tidak ditemukan'); return; }

    const rawNo = mNo[1];
    const isLegacy = /^\d{3}\.\d{3}-\d{2}\./.test(rawNo.trim());
    const cleanNoFaktur = rawNo.replace(/[\.\-]/g, '');

    console.log(`📄 Format    : ${isLegacy ? 'LEGACY (2022-2024)' : 'MODERN (2025+)'}`);
    console.log(`🔢 Raw No    : ${rawNo}`);
    console.log(`🔢 Clean No  : ${cleanNoFaktur}`);

    let mVen, mAlmVen, mNpwpVen, mPem, mAlmPem, mNpwpPem;

    if (isLegacy) {
        const parts = teks.split(/Kode dan Nomor Seri Faktur Pajak/i);
        const beforeNo = parts[0] || "";
        const afterNo = parts[1] || "";

        mPem = beforeNo.match(/Nama\s*:\s*(.*?)Alamat/i);
        mAlmPem = beforeNo.match(/Alamat\s*:\s*([\s\S]*?)NPWP\s*:/i);
        mNpwpPem = beforeNo.match(/NPWP\s*:\s*([\d\.\-]+)/i);

        mVen = afterNo.match(/Nama\s*:\s*(.*?)Alamat/i);
        mAlmVen = afterNo.match(/Alamat\s*:\s*([\s\S]*?)NPWP\s*:/i);
        mNpwpVen = afterNo.match(/NPWP\s*:\s*([\d\.]+)/i);  // Ambil pertama saja (sebelum slash)
    } else {
        mVen = teks.match(/Pengusaha Kena Pajak[\s\S]*?Nama\s*:\s*(.*?)Alamat/i);
        mPem = teks.match(/Pembeli Barang Kena Pajak[\s\S]*?Nama\s*:\s*(.*?)Alamat/i);
        mNpwpVen = teks.match(/Pengusaha Kena Pajak[\s\S]*?NPWP\s*:\s*([\d\.\-]+)/i);
        mNpwpPem = teks.match(/Pembeli Barang Kena Pajak[\s\S]*?NPWP\s*:\s*([\d\.\-]+)/i);
    }

    let mDPP = teks.match(/Dasar Pengenaan Pajak[^\d]*?((?:\d{1,3}\.)*\d{1,3},\d{2})/i);
    let mPPN = teks.match(/Jumlah PPN[^\d]*?((?:\d{1,3}\.)*\d{1,3},\d{2})/i) || teks.match(/Total PPN\s+([\d\.,]+)/i);
    let mTgl = teks.match(/([A-Za-z]{3,}(?:\s+[A-Za-z]+){0,2}),\s+(\d{1,2}\s+(?:Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+\d{4})/i);
    let mHargaJual = teks.match(/Harga Jual \/ Penggantian \/ Uang Muka \/ Termin\s+([\d\.,]+)/i) || teks.match(/Harga Jual \/ Penggantian\s+([\d\.,]+)/i);

    // Referensi
    let mRef = teks.match(/\(Referensi[\s:,]+([^)]+)\)/i);
    let mRefLegacy = teks.match(/(INVOICE\s*NO\.\s*:[\s\S]*?)(?=\s*PEMBERITAHUAN)/i);

    // Penandatangan
    let mTTD = teks.match(/Ditandatangani secara elektronik[\s\S]*?\n([^\n]+)\s*\n/i);
    let mTTDLegacy = isLegacy
        ? teks.match(/\d{4}[\s\n,]+([A-Z][A-Z\s\.]+?)(?=[\s\n]+INVOICE\s*NO\.)/i)
        : null;

    const referensi = isLegacy
        ? (mRefLegacy ? mRefLegacy[1].trim().replace(/\s*\d+\s+dari\s+\d+\s*$/i, '').replace(/\s+/g, ' ') : "-")
        : (mRef ? mRef[1].trim().replace(/\s*\d+\s+dari\s+\d+\s*$/i, '').replace(/\s+/g, ' ') : "-");

    const penandatangan = isLegacy
        ? (mTTDLegacy ? mTTDLegacy[1].trim() : "-")
        : (mTTD ? mTTD[1].trim() : "-");

    console.log(`🏢 Penjual   : ${mVen?.[1]?.trim() || '❌ TIDAK DITEMUKAN'}`);
    console.log(`🏢 NPWP Jual : ${mNpwpVen?.[1]?.trim() || '-'}`);
    console.log(`👤 Pembeli   : ${mPem?.[1]?.trim() || '❌ TIDAK DITEMUKAN'}`);
    console.log(`👤 NPWP Beli : ${mNpwpPem?.[1]?.trim() || '-'}`);
    console.log(`📅 Tanggal   : ${mTgl ? formatTanggal(mTgl[2]) : '-'} (${mTgl?.[1]?.trim()})`);
    console.log(`💰 DPP       : ${bersihkanAngka(mDPP?.[1]).toLocaleString('id-ID')}`);
    console.log(`💰 PPN       : ${bersihkanAngka(mPPN?.[1]).toLocaleString('id-ID')}`);
    console.log(`💰 Harga Jual: ${bersihkanAngka(mHargaJual?.[1]).toLocaleString('id-ID')}`);
    console.log(`📎 Referensi : ${referensi}`);
    console.log(`✍️  TTD       : ${penandatangan}`);
}

// ============================================================
// FUNGSI parseItems (salinan dari app.js untuk testing)
// ============================================================
function parseItems(teks) {
    let items = [];

    // POLA 1: Modern (kode produk 6 char)
    let itemRegexModern = /(?:^|\s)(\d+)\s+([A-Z0-9]{6})\s+(.*?)\s+Rp\s*([\d\.,]+)\s*x\s*([\d\.,]+)\s*([A-Za-z\s]+?)\s+Potongan Harga\s*=\s*Rp\s*([\d\.,]+)\s+PPnBM[^=]*=\s*Rp\s*([\d\.,]+)\s+([\d\.,]+)/g;
    let match;
    while ((match = itemRegexModern.exec(teks)) !== null) {
        items.push({ no: match[1], kode: match[2], nama_barang: match[3].trim(), harga_satuan: bersihkanAngka(match[4]), qty: bersihkanAngka(match[5]), satuan: match[6].trim(), total_harga: bersihkanAngka(match[9]) });
    }
    if (items.length > 0) return items;

    // POLA 2: Legacy flat — Jangkar ganda [Total],xx Rp [Harga] x [Qty]
    const sectionRe = /(?:Nama Barang Kena Pajak[^\n]*?)((?:\s|.)*?)(?=Harga Jual\s*\/\s*Penggantian|Dikurangi Potongan|$)/i;
    const sectionMatch = teks.match(sectionRe);
    const sect = sectionMatch ? sectionMatch[0] : teks;

    const itemAnchorRe = /\b((?:\d{1,3}\.)*\d{1,3},\d{2})\s+Rp\s*((?:\d{1,3}\.)*\d{1,3})\s*x\s*(\d+)/g;
    let anchors = [];
    while ((match = itemAnchorRe.exec(sect)) !== null) {
        anchors.push({ idx: match.index, fullLen: match[0].length, total: match[1], harga: match[2], qty: match[3] });
    }

    anchors.forEach((anchor, i) => {
        const prevEnd = i === 0 ? 0 : anchors[i-1].idx + anchors[i-1].fullLen;
        const block = sect.substring(prevEnd, anchor.idx).trim();
        const escapedTotal = anchor.total.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const blockBefore = block.replace(new RegExp(escapedTotal + '$'), '').trim();
        const mItem = blockBefore.match(/(\d+)\s+([\s\S]+)$/);
        if (mItem) {
            items.push({ no: mItem[1], kode: '-', nama_barang: mItem[2].trim() || 'Item ' + mItem[1], harga_satuan: bersihkanAngka(anchor.harga), qty: bersihkanAngka(anchor.qty), satuan: 'Unit', total_harga: bersihkanAngka(anchor.total) });
        }
    });

    // POLA 3: Fallback sederhana
    if (items.length === 0) {
        const fallbackRe = /Rp\s*([\d\.,]+)\s*x\s*([\d\.,]+)/g;
        let fallbackAnchors = [];
        while ((match = fallbackRe.exec(sect)) !== null) {
            fallbackAnchors.push({ idx: match.index, fullLen: match[0].length, harga: match[1], qty: match[2] });
        }
        fallbackAnchors.forEach((anchor, i) => {
            const prevEnd = i === 0 ? 0 : fallbackAnchors[i-1].idx + fallbackAnchors[i-1].fullLen;
            const block = sect.substring(prevEnd, anchor.idx).trim();
            const firstLine = block.split('\n')[0] || block;
            const mItem = firstLine.match(/^(\d+)\s+([\s\S]*)$/);
            if (mItem) {
                let sisa = mItem[2]; let mTotal = sisa.match(/([\d\.,]+)$/);
                let total = mTotal ? mTotal[1] : '0'; let nama = mTotal ? sisa.replace(total,'').trim() : sisa;
                items.push({ no: mItem[1], kode: '-', nama_barang: nama || 'Item '+mItem[1], harga_satuan: bersihkanAngka(anchor.harga), qty: bersihkanAngka(anchor.qty), satuan: 'Unit', total_harga: bersihkanAngka(total) });
            }
        });
    }
    return items;
}

// Test semua contoh
['Contoh 2022.txt', 'Contoh 2023.txt', 'Contoh 2024.txt'].forEach(f => {
    ekstrak(f);
    const rawFile = require('fs').readFileSync(require('path').join(__dirname, f), 'utf8');
    const teks = rawFile.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');
    const items = parseItems(teks);
    console.log(`📦 ITEMS (${items.length}):`);
    items.forEach(it => console.log(`   [${it.no}] ${it.nama_barang} | Harga: ${Number(it.harga_satuan).toLocaleString('id-ID')} x ${it.qty} = ${Number(it.total_harga).toLocaleString('id-ID')}`));
});
