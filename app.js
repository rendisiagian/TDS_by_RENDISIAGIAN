require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').Server(app);
// Mengatur batas buffer menjadi 100MB agar kuat menerima ratusan PDF sekaligus
const io = require('socket.io')(http, { maxHttpBufferSize: 1e8 });
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const fsPromises = require('fs').promises; // Untuk proses penulisan file Bulk/Batch
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    console.error('\x1b[31m[SECURITY ERROR] SESSION_SECRET tidak ditemukan di file .env! Server dihentikan.\x1b[0m');
    process.exit(1);
}
// AUDIT FIX (H-06): Peringatan jika session secret masih default placeholder
if (SESSION_SECRET.includes('CHANGE-THIS') || SESSION_SECRET.length < 32) {
    console.warn('\x1b[33m[SECURITY WARNING] SESSION_SECRET terlalu pendek atau masih default! Segera ganti dengan string acak minimal 32 karakter.\x1b[0m');
}

// ==========================================
// 1. KONFIGURASI STRUKTUR FOLDER
// ==========================================
const modules = [
    { id: 'vatin', path: 'vat_in', archive: 'arsip_vatin' },
    { id: 'vatout', path: 'vat_out', archive: 'arsip_vatout' },
    { id: 'payable', path: 'taxpayable_bppu', archive: 'arsip_payable' },
    { id: 'prepaid', path: 'prepaidtax_bppu', archive: 'arsip_prepaid' }
];

modules.forEach(mod => {
    const modPath = path.join(__dirname, mod.path);
    const archPath = path.join(modPath, mod.archive);
    if (!fs.existsSync(modPath)) fs.mkdirSync(modPath, { recursive: true });
    if (!fs.existsSync(archPath)) fs.mkdirSync(archPath, { recursive: true });
    app.use(`/${mod.archive}`, express.static(archPath));
});

// ==========================================
// SECURITY: Blokir akses langsung ke file database (BUG-01)
// ==========================================
// AUDIT FIX (C-04): Blokir akses ke file sensitif — .db, .env, .js backend, .json config
app.use((req, res, next) => {
    if (req.path.match(/\.db$/i)) {
        return res.status(403).json({ error: 'Akses dilarang.' });
    }
    // AUDIT FIX (C-04): Blokir akses langsung ke file sensitif non-frontend
    const BLOCKED_FILES = ['.env', '/app.js', '/fix_masa_pajak.js', '/test_query.js', '/package.json', '/package-lock.json'];
    if (BLOCKED_FILES.some(f => req.path.toLowerCase() === f.toLowerCase())) {
        return res.status(403).json({ error: 'Akses dilarang.' });
    }
    next();
});


// ==========================================
// 2. INISIALISASI DATABASE & TABEL
// ==========================================
const db = new sqlite3.Database('tax_database.db');

// Wrapper Promise untuk Database (Wajib untuk Bulk Processing yang aman)
const dbGet = (sql, params) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const dbRun = (sql, params) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(helmet({
    contentSecurityPolicy: false, // Dinonaktifkan sementara untuk mencegah bentrok dengan inline script bawaan
    crossOriginEmbedderPolicy: false
}));
const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        // Tidak ada maxAge → menjadi session cookie sejati.
        // Cookie akan otomatis hilang saat browser ditutup.
        httpOnly: true,         // SECURITY: Cegah akses cookie dari JavaScript
        sameSite: 'strict'      // SECURITY: Cegah CSRF
    }
});
app.use(sessionMiddleware);

// SECURITY: Rate Limiting untuk endpoint login (anti brute-force)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 20,                   // Maksimal 20 percobaan login per 15 menit
    message: '<script>window.location.href=\'/login?error=2\';</script>',
    standardHeaders: true,
    legacyHeaders: false,
});

// Bagikan session middleware ke Socket.IO (BUG-06)
io.engine.use(sessionMiddleware);

function bersihkanAngka(t) {
    if (t === null || t === undefined || t === '') return 0;
    return parseFloat(t.toString().replace(/\./g, '').replace(',', '.')) || 0;
}

function formatTanggal(tglStr) {
    if (!tglStr) return "-";
    const bln = { 'januari': '01', 'februari': '02', 'maret': '03', 'april': '04', 'mei': '05', 'juni': '06', 'juli': '07', 'agustus': '08', 'september': '09', 'oktober': '10', 'november': '11', 'desember': '12' };
    let match = tglStr.toLowerCase().match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
    if (match) {
        let hari = match[1].padStart(2, '0');
        let bulan = bln[match[2]] || '01';
        let tahun = match[3];
        return `${tahun}-${bulan}-${hari}`;
    }
    return tglStr;
}

function sanitizeFilename(name) {
    if (!name) return "Unknown";
    return name.replace(/[<>:"/\\|?*]+/g, '').trim();
}

// ========== HELPER FUNCTIONS UNTUK STATUS FAKTUR PAJAK ==========
/**
 * Parse status faktur dari no_faktur
 * Digit 3-4 menentukan status:
 * 00 = Normal, 01 = Pengganti 1, 02 = Pengganti 2, dst
 * Contoh: 04002500002040503 -> digit 3-4 adalah "00" -> Normal
 */
function parseStatusFaktur(noFaktur) {
    if (!noFaktur || noFaktur.length < 4) return 'Normal';
    const statusDigit = noFaktur.substring(2, 4);
    if (statusDigit === '00') return 'Normal';
    const pengganti = parseInt(statusDigit);
    return `Pengganti ${pengganti}`;
}

/**
 * Get nomor faktur normal dari faktur pengganti
 * Jika faktur pengganti, return nomor normal (ubah digit 3-4 menjadi '00')
 * Jika sudah normal, return noFaktur itu sendiri
 */
function getNoFakturNormal(noFaktur) {
    if (!noFaktur || noFaktur.length < 4) return noFaktur;
    const statusDigit = noFaktur.substring(2, 4);
    if (statusDigit === '00') return noFaktur; // Sudah normal
    // Faktur pengganti: ubah digit 3-4 jadi '00'
    return noFaktur.substring(0, 2) + '00' + noFaktur.substring(4);
}

/**
 * Extract masa pajak (bulan) dari tanggal YYYY-MM-DD
 * Return format: "YYYY-MM" untuk grouping
 */
function extractMasaPajak(tanggalFaktur) {
    if (!tanggalFaktur) return null;
    // Jika format YYYY-MM-DD
    if (tanggalFaktur.includes('-')) {
        const parts = tanggalFaktur.split('-');
        if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
    }
    return null;
}

/**
 * Deduplikasi data vatin berdasarkan no_faktur_normal
 * Untuk setiap group (normal + pengganti-nya), pilih yang punya status tertinggi
 * Ranking: Pengganti N > ... > Pengganti 2 > Pengganti 1 > Normal
 */
function deduplicateVatinData(rows) {
    if (!rows || rows.length === 0) return [];
    
    // Group by serial number (mengabaikan 4 digit pertama: kode transaksi & status)
    const groups = {};
    rows.forEach(row => {
        const f = row.no_faktur || '';
        const groupKey = f.length >= 5 ? f.substring(4) : f;
        if (!groups[groupKey]) {
            groups[groupKey] = [];
        }
        groups[groupKey].push(row);
    });

    // Untuk setiap group, pilih record dengan status tertinggi
    const selected = [];
    for (const groupKey in groups) {
        const groupRows = groups[groupKey];
        // Sort by status: Pengganti dengan angka lebih tinggi > lebih rendah > Normal
        const sorted = groupRows.sort((a, b) => {
            const getStatusRank = (status) => {
                if (!status || status === 'Normal') return 1;
                const match = status.match(/Pengganti\s+(\d+)/);
                if (match) return 10 + parseInt(match[1]);
                return 1;
            };
            const rankA = getStatusRank(a.status_faktur);
            const rankB = getStatusRank(b.status_faktur);
            if (rankA !== rankB) return rankB - rankA; // Higher rank first
            // FIX: data_vatin tidak punya kolom 'id' — gunakan waktu_input sebagai tiebreaker
            // Jika waktu_input sama atau tidak ada, gunakan no_faktur (lexicographic, lebih besar = lebih baru)
            if (a.waktu_input && b.waktu_input) return b.waktu_input.localeCompare(a.waktu_input);
            return (b.no_faktur || '').localeCompare(a.no_faktur || '');
        });
        
        let chosen = sorted[0];
        
        // BUG-FIX: Sinkronisasi masa pajak faktur pengganti dengan masa pajak faktur normal
        const normalRow = groupRows.find(r => r.status_faktur === 'Normal');
        if (normalRow && normalRow.masa_pajak && chosen.status_faktur !== 'Normal') {
            chosen.masa_pajak = normalRow.masa_pajak;
        }
        
        selected.push(chosen);
    }

    return selected;
}

function parseItems(teks) {
    let items = [];

    // ============================================================
    // POLA 1: Format MODERN 2025 (Ada Kode Produk 6 Karakter)
    // Contoh: "1 AB1234 Jasa Manpower Rp 1.000.000 x 1 Unit ..."
    // ============================================================
    let itemRegexModern = /(?:^|\s)(\d+)\s+([A-Z0-9]{6})\s+(.*?)\s+Rp\s*([\d\.,]+)\s*x\s*([\d\.,]+)\s*([A-Za-z\s]+?)\s+Potongan Harga\s*=\s*Rp\s*([\d\.,]+)\s+PPnBM[^=]*=\s*Rp\s*([\d\.,]+)\s+([\d\.,]+)/g;
    let match;
    while ((match = itemRegexModern.exec(teks)) !== null) {
        items.push({
            no: match[1], kode: match[2], nama_barang: match[3].trim(),
            harga_satuan: bersihkanAngka(match[4]), qty: bersihkanAngka(match[5]), satuan: match[6].trim(),
            diskon: bersihkanAngka(match[7]), total_harga: bersihkanAngka(match[9])
        });
    }
    if (items.length > 0) return items;

    // ============================================================
    // POLA 2 & 3: Format LEGACY (2022-2024)
    // Teks di-flatten jadi 1 baris oleh pdf.js:
    // "No. ... Nama Barang ... 1 MANPOWER, PER. DECEMBER 2021 43.650.000,00 Rp 43.650.000 x 1 Harga Jual ..."
    //
    // Strategi: Gunakan jangkar ganda:
    //   - DEPAN: nomor item (1, 2, 3, ...)
    //   - BELAKANG: pola "[Total],00 Rp [Harga] x [Qty]"
    // Nama item = teks di antara nomor dan angka total
    // ============================================================

    // Ambil seksi antara judul tabel dan baris ringkasan
    const sectionRe = /(?:Nama Barang Kena Pajak[^\n]*?)((?:\s|.)*?)(?=Harga Jual\s*\/\s*Penggantian|Dikurangi Potongan|$)/i;
    const sectionMatch = teks.match(sectionRe);
    const sect = sectionMatch ? sectionMatch[0] : teks;

    // Pola jangkar: [Total harga],xx Rp [Harga Satuan] x [Qty]
    // Menangkap: total sebelum Rp, harga satuan, qty
    const itemAnchorRe = /\b((?:\d{1,3}\.)*\d{1,3},\d{2})\s+Rp\s*((?:\d{1,3}\.)*\d{1,3})\s*x\s*(\d+)/g;
    let anchors = [];
    while ((match = itemAnchorRe.exec(sect)) !== null) {
        anchors.push({
            idx: match.index,
            fullLen: match[0].length,
            total: match[1],
            harga: match[2],
            qty: match[3]
        });
    }

    anchors.forEach((anchor, i) => {
        // Teks sebelum jangkar ini (sejak akhir jangkar sebelumnya)
        const prevEnd = i === 0 ? 0 : anchors[i - 1].idx + anchors[i - 1].fullLen;
        const block = sect.substring(prevEnd, anchor.idx).trim();

        // Format block: "[Header tabel?] [No] [Nama Item] [TotalAngka]"
        // Total sudah ada di anchor.total — hapus dari ujung block
        const escapedTotal = anchor.total.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const blockBefore = block.replace(new RegExp(escapedTotal + '$'), '').trim();

        // Gunakan match dari AKHIR string: cari nomor item + nama (bukan dari awal,
        // karena block mungkin diawali header tabel 'Nama Barang Kena Pajak...')
        const mItem = blockBefore.match(/(\d+)\s+([\s\S]+)$/);
        if (mItem) {
            const no = mItem[1];
            const nama = mItem[2].trim();
            items.push({
                no: no,
                kode: "-",
                nama_barang: nama || 'Item ' + no,
                harga_satuan: bersihkanAngka(anchor.harga),
                qty: bersihkanAngka(anchor.qty),
                satuan: 'Unit',
                diskon: 0,
                total_harga: bersihkanAngka(anchor.total)
            });
        }
    });

    // ============================================================
    // POLA 3: Fallback — jika anchors tidak ditemukan, coba pola "Rp x" sederhana
    // Digunakan jika format agak menyimpang
    // ============================================================
    if (items.length === 0) {
        const fallbackRe = /Rp\s*([\d\.,]+)\s*x\s*([\d\.,]+)/g;
        let fallbackAnchors = [];
        while ((match = fallbackRe.exec(sect)) !== null) {
            fallbackAnchors.push({ idx: match.index, fullLen: match[0].length, harga: match[1], qty: match[2] });
        }
        fallbackAnchors.forEach((anchor, i) => {
            const prevEnd = i === 0 ? 0 : fallbackAnchors[i - 1].idx + fallbackAnchors[i - 1].fullLen;
            const block = sect.substring(prevEnd, anchor.idx).trim();
            const lines = block.split('\n').map(l => l.trim()).filter(l => l);
            const firstLine = (lines.length > 0 ? lines[0] : block);
            const mItem = firstLine.match(/^(\d+)\s+([\s\S]*)$/);
            if (mItem) {
                let no = mItem[1], sisa = mItem[2];
                let mTotal = sisa.match(/([\d\.,]+)$/);
                let total = mTotal ? mTotal[1] : '0';
                let nama = mTotal ? sisa.replace(total, '').trim() : sisa;
                items.push({
                    no, kode: '-', nama_barang: nama || 'Item ' + no,
                    harga_satuan: bersihkanAngka(anchor.harga), qty: bersihkanAngka(anchor.qty),
                    satuan: 'Unit', diskon: 0, total_harga: bersihkanAngka(total)
                });
            }
        });
    }

    return items;
}

// Helper function untuk update master data dengan logic cerdas
async function updateMasterData(tableName, npwp, nama, alamat, formatTipe, tanggalFaktur) {
    if (!npwp) return;

    // Cek apakah data sudah ada
    const existing = await dbGet(`SELECT format_tipe, tanggal_terakhir FROM ${tableName} WHERE npwp = ?`, [npwp]);

    if (existing) {
        // Jika format berbeda, jangan replace
        if (existing.format_tipe !== formatTipe) return;

        // Jika format sama tapi tanggal faktur tidak lebih baru, jangan replace
        if (tanggalFaktur <= existing.tanggal_terakhir) return;
    }

    // Insert atau replace dengan data baru
    await dbRun(`INSERT OR REPLACE INTO ${tableName} (npwp, nama, alamat, format_tipe, tanggal_terakhir) VALUES (?, ?, ?, ?, ?)`,
        [npwp, nama, alamat, formatTipe, tanggalFaktur]);
}

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, nama_lengkap TEXT, role TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS user_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, jenis_request TEXT, nilai_baru TEXT, status TEXT DEFAULT 'Pending', waktu DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS master_cabang (kode_cabang TEXT PRIMARY KEY, nama_cabang TEXT, entitas TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS master_vendor (npwp TEXT PRIMARY KEY, nama TEXT, alamat TEXT, format_tipe TEXT, tanggal_terakhir DATE)`);
    db.run(`CREATE TABLE IF NOT EXISTS master_client (npwp TEXT PRIMARY KEY, nama TEXT, alamat TEXT, format_tipe TEXT, tanggal_terakhir DATE)`);
    db.run(`CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, action TEXT, module TEXT, details TEXT, waktu DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS master_vo (id INTEGER PRIMARY KEY AUTOINCREMENT, kode_cabang TEXT, nama_vo TEXT, contract_income REAL DEFAULT 0)`);

    const ensureColumn = (table, columnDef) => {
        db.run(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`, () => { });
    };
    ensureColumn('master_vendor', 'format_tipe TEXT');
    ensureColumn('master_vendor', 'tanggal_terakhir DATE');
    ensureColumn('master_client', 'format_tipe TEXT');
    ensureColumn('master_client', 'tanggal_terakhir DATE');
    // Tambahkan kolom untuk project management di master_cabang
    ensureColumn('master_cabang', 'contract_income REAL DEFAULT 0');
    // AUDIT FIX (L-05): Hapus ensureColumn('data_vatout', 'project_id INTEGER') karena kolom tidak dipakai
    ensureColumn('data_vatout', 'kode_vo TEXT');

    global.insertAuditLog = function (user_id, username, action, module, details) {
        db.run(`INSERT INTO audit_logs (user_id, username, action, module, details) VALUES (?, ?, ?, ?, ?)`, [user_id, username, action, module, details], (err) => {
            if (err) console.error("Audit Log Error:", err);
        });
    };

    // TABEL BARU: MODUL AKUNTANSI (CLIENT LEDGER)
    db.run(`CREATE TABLE IF NOT EXISTS data_client_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entitas TEXT,
        nama_client TEXT,
        inv_no TEXT,
        contract_income REAL DEFAULT 0,
        discount REAL DEFAULT 0,
        advance REAL DEFAULT 0,
        retention REAL DEFAULT 0,
        net_certificate REAL DEFAULT 0,
        vat REAL DEFAULT 0,
        gross_certificate REAL DEFAULT 0,
        gross_paym_received REAL DEFAULT 0,
        contract_debtor REAL DEFAULT 0,
        gross_paym_rcpt REAL DEFAULT 0,
        withholding_tax REAL DEFAULT 0,
        bank_charge REAL DEFAULT 0,
        net_receipt REAL DEFAULT 0,
        remarks TEXT,
        diinput_oleh TEXT,
        waktu_input DATETIME DEFAULT CURRENT_TIMESTAMP,
        ref_bppu TEXT,
        is_advance INTEGER DEFAULT 0,
        ref_advance TEXT
    )`);
    // CATATAN: Kolom ref_bppu, is_advance, ref_advance sudah didefinisikan di CREATE TABLE di atas.
    // Baris ALTER TABLE lama dihapus untuk mencegah error duplikat setiap server start. (BUG-02)

    db.get(`SELECT count(*) as count FROM users`, (err, row) => {
        if (row && row.count === 0) {
            // SECURITY: Naikkan salt rounds ke 12 untuk keamanan lebih baik (BUG-08)
            const defaultPass = bcrypt.hashSync('Emergent@2024!', 12);
            db.run(`INSERT INTO users (username, password, nama_lengkap, role) VALUES ('admin', ?, 'Administrator', 'administrator')`, [defaultPass]);
            db.run(`INSERT INTO users (username, password, nama_lengkap, role) VALUES ('rendisiagian', ?, 'Rendi Siagian', 'supervisor')`, [defaultPass]);
            console.log('\x1b[33m[SETUP] User default dibuat. Password default: Emergent@2024! — Segera ganti setelah login pertama!\x1b[0m');
        }
    });

    db.run(`INSERT OR IGNORE INTO master_cabang (kode_cabang, nama_cabang, entitas) VALUES ('PUSAT', 'Kantor Pusat BBS', 'BBS'), ('20305G', 'BBS JO', 'JO'), ('250310', 'BMP JO', 'JO')`);

    // MIGRASI OTOMATIS: Ubah 'Verifikasi Ulang' menjadi 'Perlu Verifikasi' agar sinkron dengan UI baru
    db.run("UPDATE data_vatin SET kode_cabang = 'Perlu Verifikasi' WHERE kode_cabang = 'Verifikasi Ulang'");

    // MIGRASI: Update kolom status_faktur dan masa_pajak untuk data existing di data_vatin
    // Ini dilakukan untuk memastikan data lama memiliki status_faktur dan masa_pajak yang tepat
    db.all("SELECT no_faktur, tanggal_faktur FROM data_vatin WHERE status_faktur IS NULL OR masa_pajak IS NULL", (err, rows) => {
        if (rows && rows.length > 0) {
            rows.forEach(row => {
                const noFaktur = row.no_faktur;
                const tanggalFaktur = row.tanggal_faktur;
                
                // Hitung status_faktur dari digit 3-4
                const statusDigit = noFaktur && noFaktur.length >= 4 ? noFaktur.substring(2, 4) : '00';
                const statusFaktur = statusDigit === '00' ? 'Normal' : `Pengganti ${parseInt(statusDigit)}`;
                
                // Hitung masa_pajak dari tanggal
                const masaPajak = tanggalFaktur && tanggalFaktur.includes('-') 
                    ? tanggalFaktur.split('-').slice(0, 2).join('-')
                    : null;
                
                // Untuk faktur pengganti, cari faktur normal
                let noFakturNormal = null;
                if (statusDigit !== '00') {
                    noFakturNormal = noFaktur.substring(0, 2) + '00' + noFaktur.substring(4);
                }
                
                // Update baris
                db.run(
                    `UPDATE data_vatin SET status_faktur = ?, masa_pajak = ?, no_faktur_normal = ? WHERE no_faktur = ?`,
                    [statusFaktur, masaPajak, noFakturNormal, noFaktur],
                    (updateErr) => {
                        if (updateErr) console.error(`Migration error for ${noFaktur}:`, updateErr);
                    }
                );
            });
        }
    });

    modules.forEach(mod => {
        db.run(`CREATE TABLE IF NOT EXISTS inbox_${mod.id} (id INTEGER PRIMARY KEY AUTOINCREMENT, entitas TEXT, link_pdf_lokal TEXT, status TEXT DEFAULT 'Menunggu Lengkapi', diinput_oleh TEXT, data_ekstraksi TEXT, waktu DATETIME DEFAULT CURRENT_TIMESTAMP)`);

        if (mod.id.startsWith('vat')) {
            db.run(`CREATE TABLE IF NOT EXISTS data_${mod.id} (no_faktur TEXT PRIMARY KEY, entitas TEXT, kode_cabang TEXT, npwp_penjual TEXT, nama_penjual TEXT, alamat_penjual TEXT, npwp_pembeli TEXT, nama_pembeli TEXT, alamat_pembeli TEXT, tanggal_faktur DATE, harga_jual REAL, diskon REAL, uang_muka REAL, dpp REAL, ppn REAL, referensi TEXT, kota_penerbit TEXT, penandatangan TEXT, no_invoice_internal TEXT, tgl_tukar_faktur DATE, diinput_oleh TEXT, link_pdf_lokal TEXT, format_tipe TEXT DEFAULT 'LEGACY', status_faktur TEXT DEFAULT 'Normal', masa_pajak TEXT, no_faktur_normal TEXT, waktu_input DATETIME DEFAULT CURRENT_TIMESTAMP)`);
            const alterCols = ['alamat_penjual TEXT', 'alamat_pembeli TEXT', 'diskon REAL', 'uang_muka REAL', 'kota_penerbit TEXT', 'penandatangan TEXT', 'harga_jual REAL', 'format_tipe TEXT', 'status_faktur TEXT', 'masa_pajak TEXT', 'no_faktur_normal TEXT'];
            alterCols.forEach(col => { db.run(`ALTER TABLE data_${mod.id} ADD COLUMN ${col}`, () => { }); });
            db.run(`CREATE TABLE IF NOT EXISTS item_${mod.id} (id INTEGER PRIMARY KEY AUTOINCREMENT, no_faktur TEXT, nama_barang TEXT, harga_satuan REAL, qty REAL, satuan TEXT, diskon REAL, total_harga REAL)`);
        } else {
            db.run(`CREATE TABLE IF NOT EXISTS data_${mod.id} (no_bppu TEXT PRIMARY KEY, masa_pajak TEXT, entitas TEXT, kode_cabang TEXT, npwp_pemotong TEXT, nama_pemotong TEXT, npwp_dipotong TEXT, nama_dipotong TEXT, dpp REAL, tarif REAL, nilai_pph REAL, tanggal_dokumen DATE, nomor_dokumen TEXT, no_invoice_internal TEXT, diinput_oleh TEXT, link_pdf_lokal TEXT, waktu_input DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        }
    });

    // ------------------------------------------
    // BUG-C1 FIX: Tabel projects wajib dibuat agar CRUD di taxprojectreport tidak crash
    // ------------------------------------------
    db.run(`CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kode TEXT UNIQUE, nama TEXT, deskripsi TEXT, status TEXT,
        progress INTEGER DEFAULT 0, tanggal_mulai DATE, tanggal_selesai DATE,
        pm TEXT, anggaran REAL DEFAULT 0, diinput_oleh TEXT,
        waktu_input DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // ------------------------------------------
    // PERFORMANCE: Tambahkan Database Indexing
    // ------------------------------------------
    db.run(`CREATE INDEX IF NOT EXISTS idx_vatout_entitas_tgl ON data_vatout(entitas, tanggal_faktur)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_vatout_no_internal ON data_vatout(no_invoice_internal)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_prepaid_entitas_tgl ON data_prepaid(entitas, tanggal_dokumen)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_prepaid_no_internal ON data_prepaid(no_invoice_internal)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_client_ledger_entitas ON data_client_ledger(entitas)`);
    // AUDIT FIX (M-06): Missing indexes untuk data_vatin dan data_payable
    db.run(`CREATE INDEX IF NOT EXISTS idx_vatin_entitas_tgl ON data_vatin(entitas, tanggal_faktur)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_vatin_no_faktur_normal ON data_vatin(no_faktur_normal)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_vatin_status_faktur ON data_vatin(status_faktur)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_vatin_entitas_serial ON data_vatin(entitas, status_faktur)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_payable_entitas ON data_payable(entitas)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_payable_no_internal ON data_payable(no_invoice_internal)`);
});

// ==========================================
// 3. ROUTING & API
// ==========================================
const cekAuth = (req, res, next) => { if (req.session.user) return next(); res.redirect('/login'); };
const cekRoleAPI = (roles) => {
    return (req, res, next) => {
        if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
        const role = (req.session.user.role || '').toLowerCase();
        if (roles.includes(role)) return next();
        return res.status(403).json({ error: 'Akses ditolak. Peran tidak mencukupi (RBAC).' });
    };
};
// Favicon — serve SVG icon
app.get('/favicon.ico', (req, res) => res.redirect('/favicon.svg'));

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/sidebar.html', cekAuth, (req, res) => {
    const sidebarPath = path.join(__dirname, 'sidebar.html');
    fs.readFile(sidebarPath, 'utf8', (err, html) => {
        if (err) return res.status(500).send('');
        // Jika user adalah supervisor atau administrator, tampilkan menu administrasi
        const role = (req.session && req.session.user && req.session.user.role) ? req.session.user.role.toLowerCase() : '';
        const isSupervisorOrAbove = ['supervisor', 'administrator', 'superadmin'].includes(role);
        if (isSupervisorOrAbove) {
            html = html.replace(
                'id="group-administrasi" class="sidebar-group" style="display:none;"',
                'id="group-administrasi" class="sidebar-group"'
            );
        }
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    });
});
app.get('/profile', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/manage-users', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'manage_users.html')));
app.get('/master-cabang', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'master_cabang.html')));
app.get('/master-kontak', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'master_kontak.html')));
app.get('/audit-logs', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'audit_logs.html')));
app.get('/tax-project-report', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'taxprojectreport.html')));
app.get('/', (req, res) => req.session.user ? res.redirect('/dashboard-utama') : res.redirect('/login'));
app.get('/dashboard-utama', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'dashboard_utama.html')));
app.get('/client-ledger', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'accounting', 'client_ledger.html')));

// Static middleware ditempatkan setelah rute HTML agar route kustom dapat tereksekusi.
// SECURITY: Blokir akses langsung ke file .html — semua halaman harus melalui route yang terautentikasi.
app.use((req, res, next) => {
    if (req.path.match(/\.html$/i)) {
        // Izinkan hanya login.html tanpa autentikasi
        if (req.path === '/login.html') return next();
        // Semua .html lainnya: redirect ke login jika belum login
        if (!req.session.user) return res.redirect('/login');
    }
    next();
});
app.use(express.static(__dirname));

// API: MASTER CABANG - Semua data tanpa filter entitas (untuk halaman admin)
app.get('/api/master-cabang-all', cekRoleAPI(['administrator', 'supervisor', 'superadmin']), (req, res) => {
    db.all(`SELECT * FROM master_cabang ORDER BY entitas, kode_cabang`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.get('/api/master-kontak-all', cekRoleAPI(['administrator', 'supervisor', 'superadmin']), (req, res) => {
    db.all(`SELECT * FROM master_client ORDER BY nama`, (err, rowsClient) => {
        db.all(`SELECT * FROM master_vendor ORDER BY nama`, (err, rowsVendor) => {
            res.json({ clients: rowsClient || [], vendors: rowsVendor || [] });
        });
    });
});

app.get('/api/audit-logs', cekRoleAPI(['administrator', 'supervisor', 'superadmin']), (req, res) => {
    db.all(`SELECT *, strftime('%d-%m-%Y %H:%M:%S', waktu, 'localtime') as wkt FROM audit_logs ORDER BY id DESC LIMIT 500`, (err, rows) => res.json(rows || []));
});

// API: MIGRASI DATA VATIN - Update status_faktur, masa_pajak, no_faktur_normal untuk existing data
app.post('/api/migrate-vatin-status', cekRoleAPI(['administrator', 'supervisor', 'superadmin']), async (req, res) => {
    try {
        // Query semua data yang belum memiliki status_faktur atau masa_pajak
        db.all(`SELECT no_faktur, tanggal_faktur FROM data_vatin WHERE status_faktur IS NULL OR status_faktur = '' OR masa_pajak IS NULL`, async (err, rows) => {
            if (err) {
                return res.status(500).json({ error: 'Database error', details: err.message });
            }
            
            if (!rows || rows.length === 0) {
                return res.json({ 
                    success: true, 
                    message: 'Tidak ada data yang perlu di-update',
                    updated: 0,
                    total: 0
                });
            }

            let updatedCount = 0;
            let failedCount = 0;
            const totalCount = rows.length;

            // Update setiap baris
            for (let row of rows) {
                try {
                    const noFaktur = row.no_faktur;
                    const tanggalFaktur = row.tanggal_faktur;
                    
                    // Extract status_faktur dari digit 3-4
                    const statusDigit = noFaktur && noFaktur.length >= 4 ? noFaktur.substring(2, 4) : '00';
                    const statusFaktur = statusDigit === '00' ? 'Normal' : `Pengganti ${parseInt(statusDigit)}`;
                    
                    // Extract masa_pajak dari tanggal (YYYY-MM)
                    const masaPajak = tanggalFaktur && tanggalFaktur.includes('-') 
                        ? tanggalFaktur.split('-').slice(0, 2).join('-')
                        : null;
                    
                    // Get no_faktur_normal untuk faktur pengganti
                    let noFakturNormal = null;
                    if (statusDigit !== '00') {
                        noFakturNormal = noFaktur.substring(0, 2) + '00' + noFaktur.substring(4);
                    }
                    
                    // Update baris
                    await new Promise((resolve, reject) => {
                        db.run(
                            `UPDATE data_vatin SET status_faktur = ?, masa_pajak = ?, no_faktur_normal = ? WHERE no_faktur = ?`,
                            [statusFaktur, masaPajak, noFakturNormal, noFaktur],
                            function(err) {
                                if (err) {
                                    failedCount++;
                                    reject(err);
                                } else {
                                    updatedCount++;
                                    resolve();
                                }
                            }
                        );
                    });
                } catch (itemErr) {
                    failedCount++;
                    console.error(`Migration error for ${row.no_faktur}:`, itemErr);
                }
            }

            // Return hasil
            res.json({
                success: true,
                message: `Migrasi selesai`,
                total: totalCount,
                updated: updatedCount,
                failed: failedCount
            });
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Migration failed', 
            details: error.message 
        });
    }
});

// API: VERIFY MIGRASI VATIN - Check hasil update status_faktur, masa_pajak, no_faktur_normal
app.get('/api/verify-vatin-migration', cekRoleAPI(['administrator', 'supervisor', 'superadmin']), async (req, res) => {
    try {
        // Statistics migrasi
        const statsQuery = `
            SELECT 
                COUNT(*) as total_records,
                SUM(CASE WHEN status_faktur IS NULL OR status_faktur = '' THEN 1 ELSE 0 END) as missing_status,
                SUM(CASE WHEN masa_pajak IS NULL THEN 1 ELSE 0 END) as missing_masa,
                SUM(CASE WHEN status_faktur = 'Normal' THEN 1 ELSE 0 END) as count_normal,
                SUM(CASE WHEN status_faktur LIKE 'Pengganti%' THEN 1 ELSE 0 END) as count_pengganti
            FROM data_vatin
        `;
        
        // Sample data: Normal invoices
        const normalQuery = `
            SELECT no_faktur, status_faktur, masa_pajak, no_faktur_normal, tanggal_faktur
            FROM data_vatin 
            WHERE status_faktur = 'Normal'
            LIMIT 5
        `;
        
        // Sample data: Replacement invoices
        const penggantiQuery = `
            SELECT no_faktur, status_faktur, masa_pajak, no_faktur_normal, tanggal_faktur
            FROM data_vatin 
            WHERE status_faktur LIKE 'Pengganti%'
            LIMIT 5
        `;
        
        // Sample data: Invoices dengan missing data
        const missingQuery = `
            SELECT no_faktur, status_faktur, masa_pajak, no_faktur_normal, tanggal_faktur
            FROM data_vatin 
            WHERE status_faktur IS NULL OR status_faktur = '' OR masa_pajak IS NULL
            LIMIT 5
        `;

        db.get(statsQuery, [], (err, stats) => {
            if (err) {
                return res.status(500).json({ error: 'Query error', details: err.message });
            }

            db.all(normalQuery, [], (err1, normalData) => {
                db.all(penggantiQuery, [], (err2, penggantiData) => {
                    db.all(missingQuery, [], (err3, missingData) => {
                        res.json({
                            success: true,
                            timestamp: new Date().toISOString(),
                            statistics: {
                                total_records: stats.total_records || 0,
                                missing_status: stats.missing_status || 0,
                                missing_masa_pajak: stats.missing_masa || 0,
                                count_normal: stats.count_normal || 0,
                                count_pengganti: stats.count_pengganti || 0,
                                migration_complete: (stats.missing_status === 0 && stats.missing_masa === 0)
                            },
                            samples: {
                                normal_invoices: normalData || [],
                                replacement_invoices: penggantiData || [],
                                missing_data: missingData || []
                            }
                        });
                    });
                });
            });
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Verification failed', 
            details: error.message 
        });
    }
});

// API: PROJECT MANAGEMENT
app.get('/api/projects', cekAuth, (req, res) => {
    const entitas = req.query.entitas || 'BBS';
    db.all(`SELECT kode_cabang as kode, nama_cabang as nama, contract_income, kode_cabang as id FROM master_cabang WHERE entitas = ? ORDER BY CAST(kode_cabang AS REAL) DESC, kode_cabang DESC`, [entitas], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// API: Variation Order (VO)
app.get('/api/vo/:kode_cabang', cekAuth, (req, res) => {
    db.all(`SELECT * FROM master_vo WHERE kode_cabang = ? ORDER BY id ASC`, [req.params.kode_cabang], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// API: PROJECT SUMMARY
app.get('/api/project-summary/:id', cekAuth, (req, res) => {
    const projectId = req.params.id;

    // Query faktur keluaran terkait project (menggunakan kode_cabang yang merepresentasikan branch/project)
    db.all(`SELECT d.tanggal_faktur as tanggal, d.no_faktur as no_faktur, d.nama_pembeli as client, d.dpp, d.ppn, d.kode_vo FROM data_vatout d WHERE d.kode_cabang = ? OR d.project_id = ?`, [projectId, projectId], (err, keluaran) => {
        if (err) {
            console.error('Error querying data_vatout:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        // Query faktur masukan
        db.all(`SELECT d.tanggal_faktur as tanggal, d.no_faktur as no_faktur, d.nama_penjual as supplier, d.dpp, d.ppn FROM data_vatin d WHERE d.kode_cabang = ? OR d.project_id = ?`, [projectId, projectId], (err, masukan) => {
            if (err) {
                console.error('Error querying data_vatin:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            res.json({
                keluaran: keluaran || [],
                masukan: masukan || []
            });
        });
    });
});

app.get('/api/items/:mod/:faktur', cekAuth, (req, res) => {
    db.all(`SELECT * FROM item_${req.params.mod} WHERE no_faktur = ?`, [req.params.faktur], (err, rows) => res.json(rows || []));
});

// API: Cek detail faktur VAT IN / VAT OUT (Digunakan untuk Smart Auto-Fill Faktur Pengganti)
app.get('/api/detail-vatin/:faktur', cekAuth, (req, res) => {
    db.get(`SELECT * FROM data_vatin WHERE no_faktur = ?`, [req.params.faktur], (err, row) => res.json(row || null));
});

app.get('/api/detail-vatout/:faktur', cekAuth, (req, res) => {
    db.get(`SELECT * FROM data_vatout WHERE no_faktur = ?`, [req.params.faktur], (err, row) => res.json(row || null));
});

// API: Compare Prepaid Tax vs VAT OUT (Membaca no_faktur atau no_invoice_internal)
app.get('/api/prepaid-comparison/:noBppu', cekAuth, (req, res) => {
    db.get(`SELECT * FROM data_prepaid WHERE no_bppu = ?`, [req.params.noBppu], (err, prepaid) => {
        if (err || !prepaid) return res.json({ prepaid: null, vatout: null });

        const invoiceRef = (prepaid.no_invoice_internal || '').trim();
        if (!invoiceRef || invoiceRef === '-') return res.json({ prepaid, vatout: null });

        // Pisahkan jika ada banyak invoice (koma)
        const refs = invoiceRef.split(',').map(s => s.trim()).filter(Boolean);
        if (refs.length === 0) return res.json({ prepaid, vatout: null });

        const placeholders = refs.map(() => '?').join(',');
        const sql = `SELECT * FROM data_vatout 
                     WHERE no_invoice_internal IN (${placeholders}) OR no_faktur IN (${placeholders})`;

        // Kita masukkan array refs dua kali untuk mencakup kedua kolom di IN clause
        db.all(sql, [...refs, ...refs], (err2, rows) => {
            if (err2 || !rows || rows.length === 0) {
                return res.json({ prepaid, vatout: null });
            }

            // Agregasi nilai PPN dari semua faktur yang ditemukan
            const aggregated = rows.reduce((acc, r) => {
                acc.ppn += (r.ppn || 0);
                return acc;
            }, { ppn: 0 });

            // Hitung DPP Sesungguhnya (Actual DPP) melalui reverse calculation
            // DPP Sesungguhnya = Total PPN / 11% (0.11)
            const estimatedDpp = Math.round(aggregated.ppn / 0.11);

            // Kirim balik sebagai objek vatout tunggal agar UI tetap kompatibel
            res.json({
                prepaid,
                vatout: {
                    dpp: estimatedDpp,
                    ppn: aggregated.ppn,
                    is_aggregated: rows.length > 1,
                    count: rows.length
                }
            });
        });
    });
});

// API: Summary Prepaid Tax
app.get('/api/summary-prepaid', cekAuth, (req, res) => {
    const entitas = req.query.entitas || 'BBS';
    db.all(`SELECT v.no_faktur, v.tanggal_faktur, strftime('%d-%m-%Y', v.tanggal_faktur) AS tanggal_faktur_format, strftime('%m-%Y', v.tanggal_faktur) AS masa_pajak_faktur, d.masa_pajak AS masa_pajak_bppu, COUNT(*) AS jumlah_bppu, COALESCE(SUM(d.dpp), 0) AS total_dpp, COALESCE(SUM(d.nilai_pph), 0) AS total_pph FROM data_prepaid d LEFT JOIN data_vatout v ON d.no_invoice_internal = v.no_invoice_internal AND d.entitas = v.entitas WHERE d.entitas = ? GROUP BY v.no_faktur, v.tanggal_faktur, d.masa_pajak ORDER BY v.tanggal_faktur DESC, d.masa_pajak`, [entitas], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// API: CLIENT LEDGER
app.get('/api/data-client-ledger', cekAuth, (req, res) => {
    const entitas = req.query.entitas || 'BBS';
    const page = parseInt(req.query.page) || 1;
    const limit = req.query.limit === 'all' ? null : (parseInt(req.query.limit) || 50);

    let baseSql = `FROM data_client_ledger d 
                   LEFT JOIN master_cabang c ON c.kode_cabang = SUBSTR(d.inv_no, INSTR(d.inv_no, '/') + 1, INSTR(SUBSTR(d.inv_no, INSTR(d.inv_no, '/') + 1), '/') - 1) AND c.entitas = d.entitas
                   WHERE d.entitas = ?`;
    let params = [entitas];

    if (req.query.search) {
        try {
            let searchParams = JSON.parse(decodeURIComponent(req.query.search));
            for (let col in searchParams) {
                let val = searchParams[col];
                if (typeof val === 'string') val = val.trim();
                if (!val) continue;

                if (col.endsWith('_start') && /^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+_start$/.test(col)) {
                    let actualCol = col.replace('_start', '');
                    baseSql += ` AND ${actualCol} >= ?`;
                    params.push(val);
                } else if (col.endsWith('_end') && /^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+_end$/.test(col)) {
                    let actualCol = col.replace('_end', '');
                    baseSql += ` AND ${actualCol} <= ?`;
                    params.push(val);
                } else if (/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(col)) {
                    baseSql += ` AND ${col} LIKE ?`;
                    params.push(`%${val}%`);
                }
            }
        } catch (e) { }
    }

    const statsSql = `SELECT SUM(contract_income) as total_income, SUM(net_receipt) as total_receipt, SUM(contract_debtor) as total_debtor ${baseSql}`;
    const statsParams = [...params];

    db.get(`SELECT count(*) as total ${baseSql}`, params, (err, countRow) => {
        const total = countRow ? countRow.total : 0;
        let selectSql = `SELECT d.*, c.nama_cabang, strftime('%d-%m-%Y', d.waktu_input) AS tanggal_format ${baseSql} ORDER BY CAST(SUBSTR(d.inv_no, 1, MAX(1, INSTR(d.inv_no, '/') - 1)) AS INTEGER) ASC, d.id DESC`;
        const queryParams = [...params]; // Salinan bersih untuk query SELECT

        if (limit) {
            selectSql += ` LIMIT ? OFFSET ?`;
            queryParams.push(limit, (page - 1) * limit);
        }

        db.all(selectSql, queryParams, (err2, rows) => {
            db.get(statsSql, statsParams, (err3, statsRow) => {
                // Tambahan: Hitung Sisa Saldo Advance (Outstanding)
                const advSql = `
                    SELECT 
                        (SELECT COALESCE(SUM(net_certificate),0) FROM data_client_ledger WHERE entitas = ? AND is_advance = 1) -
                        (SELECT COALESCE(SUM(advance),0) FROM data_client_ledger WHERE entitas = ? AND ref_advance IS NOT NULL AND ref_advance != '' AND ref_advance != '-')
                    AS sisa_advance
                `;
                db.get(advSql, [entitas, entitas], (err4, advRow) => {
                    res.json({
                        data: rows || [],
                        total,
                        page,
                        limit: limit || total,
                        stats: {
                            income: statsRow && statsRow.total_income ? statsRow.total_income : 0,
                            receipt: statsRow && statsRow.total_receipt ? statsRow.total_receipt : 0,
                            debtor: statsRow && statsRow.total_debtor ? statsRow.total_debtor : 0,
                            outstanding_advance: advRow ? advRow.sisa_advance : 0
                        }
                    });
                });
            });
        });
    });
});

modules.forEach(mod => {
    app.get(`/dashboard-${mod.id}`, cekAuth, (req, res) => res.sendFile(path.join(__dirname, mod.path, `dashboard_${mod.id}.html`)));
    app.get(`/summary-${mod.id}`, cekAuth, (req, res) => res.sendFile(path.join(__dirname, mod.path, `summary_${mod.id}.html`)));
    if (mod.id === 'vatin') {
        app.get('/audit-vatin', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'vat_in', 'audit_vatin.html')));
    }

    
    // Inbox vatin sudah dihapus (Direct-to-Dashboard)
    if (mod.id !== 'vatin') {
        app.get(`/inbox-${mod.id}`, cekAuth, (req, res) => res.sendFile(path.join(__dirname, mod.path, `inbox_${mod.id}.html`)));
    }

    // --- SERVER-SIDE DATATABLES ENGINE ---
    app.get(`/api/data-${mod.id}`, cekAuth, (req, res) => {
        const entitas = req.query.entitas || 'BBS';
        const page = parseInt(req.query.page) || 1;
        const limit = req.query.limit === 'all' ? null : (parseInt(req.query.limit) || 50);

        let baseSql = mod.id.startsWith('vat')
            ? `FROM data_${mod.id} d LEFT JOIN master_cabang c ON d.kode_cabang = c.kode_cabang WHERE d.entitas = ?`
            : mod.id === 'prepaid'
            ? `FROM data_${mod.id} d LEFT JOIN master_cabang c ON d.kode_cabang = c.kode_cabang LEFT JOIN data_vatout v ON d.no_invoice_internal = v.no_invoice_internal AND d.entitas = v.entitas WHERE d.entitas = ?`
            : `FROM data_${mod.id} d LEFT JOIN master_cabang c ON d.kode_cabang = c.kode_cabang WHERE d.entitas = ?`;

        let params = [entitas];

        if (req.query.year && req.query.year !== 'all') {
            const colTgl = mod.id.startsWith('vat') ? 'tanggal_faktur' : 'tanggal_dokumen';
            baseSql += ` AND strftime('%Y', d.${colTgl}) = ?`;
            params.push(req.query.year);
        }

        if (req.query.search) {
            try {
                let searchParams = JSON.parse(decodeURIComponent(req.query.search));
                for (let col in searchParams) {
                    let val = searchParams[col];
                    if (typeof val === 'string') val = val.trim();
                    if (!val) continue;

                    // Support for Date Range (_start and _end)
                    if (col.endsWith('_start') && /^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+_start$/.test(col)) {
                        let actualCol = col.replace('_start', '');
                        if (val === '__IS_NULL__') {
                            baseSql += ` AND (${actualCol} IS NULL OR ${actualCol} = '' OR ${actualCol} = '-')`;
                        } else {
                            baseSql += ` AND ${actualCol} >= ?`;
                            params.push(val);
                        }
                    } else if (col.endsWith('_end') && /^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+_end$/.test(col)) {
                        let actualCol = col.replace('_end', '');
                        if (val === '__IS_NULL__') {
                            // Already handled by _start, but skip adding >= ?
                        } else {
                            baseSql += ` AND ${actualCol} <= ?`;
                            params.push(val);
                        }
                    } else if (/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(col)) {
                        // Prevent SQL Injection by validating col name format
                        if (val === '__IS_NULL__') {
                            baseSql += ` AND (${col} IS NULL OR ${col} = '' OR ${col} = '-')`;
                        } else if (col === 'c.nama_cabang') {
                            // Support searching both branch name and raw branch code (e.g. for "Verifikasi Ulang")
                            baseSql += ` AND (c.nama_cabang LIKE ? OR d.kode_cabang LIKE ?)`;
                            params.push(`%${val}%`, `%${val}%`);
                        } else {
                            baseSql += ` AND ${col} LIKE ?`;
                            params.push(`%${val}%`);
                        }
                    }
                }
            } catch (e) {
                const search = (req.query.search || '').trim();
                if (search) {
                    if (mod.id.startsWith('vat')) {
                        baseSql += ` AND (d.no_faktur LIKE ? OR d.nama_penjual LIKE ? OR d.nama_pembeli LIKE ? OR d.no_invoice_internal LIKE ? OR c.nama_cabang LIKE ?)`;
                        const s = '%' + search + '%';
                        params.push(s, s, s, s, s);
                    } else {
                        baseSql += ` AND (d.no_bppu LIKE ? OR d.nama_pemotong LIKE ? OR d.nama_dipotong LIKE ? OR d.no_invoice_internal LIKE ? OR c.nama_cabang LIKE ?)`;
                        const s = '%' + search + '%';
                        params.push(s, s, s, s, s);
                    }
                }
            }
        }

        db.get(`SELECT count(*) as total ${baseSql}`, params, (err, countRow) => {
            const total = countRow ? countRow.total : 0;

            // Tambahan: Hitung data yang statusnya 'Perlu Verifikasi' (Direct Upload)
            let verifySql = `SELECT COUNT(*) as count ${baseSql} AND d.kode_cabang = 'Perlu Verifikasi'`;
            db.get(verifySql, params, (errV, vRow) => {
                const needsVerify = vRow ? vRow.count : 0;

                const colTax = mod.id.startsWith('vat') ? 'd.ppn' : 'd.nilai_pph';
                const colTgl = mod.id.startsWith('vat') ? 'd.tanggal_faktur' : 'd.tanggal_dokumen';
                const now = new Date();
                const curM = now.getMonth() + 1, curY = now.getFullYear();
                const prevM = curM === 1 ? 12 : curM - 1;
                const prevY = curM === 1 ? curY - 1 : curY;
                const curYM = `${curY}-${String(curM).padStart(2, '0')}`;
                const prevYM = `${prevY}-${String(prevM).padStart(2, '0')}`;

                if (mod.id === 'vatin') {
                    // Query semua data yang match filter (untuk deduplikasi)
                    let deduplicateSelectSql = `SELECT d.*, c.nama_cabang, d.status_faktur, d.masa_pajak, d.no_faktur_normal ${baseSql}`;
                    db.all(deduplicateSelectSql, params, (errDedup, allRows) => {
                        // Deduplikasi
                        const deduplicatedRows = deduplicateVatinData(allRows || []);

                        // Hitung stats dari deduplicated data
                        let total_dpp = 0, total_tax = 0, cur_jml = 0, cur_tax = 0, prev_jml = 0, prev_tax = 0;
                        deduplicatedRows.forEach(row => {
                            total_dpp += (row.dpp || 0);
                            total_tax += (row.ppn || 0);

                            const rowMonth = row.tanggal_faktur ? row.tanggal_faktur.substring(0, 7) : null;
                            if (rowMonth === curYM) {
                                cur_jml += 1;
                                cur_tax += (row.ppn || 0);
                            }
                            if (rowMonth === prevYM) {
                                prev_jml += 1;
                                prev_tax += (row.ppn || 0);
                            }
                        });

                        // Continue dengan query untuk display (paginated, dengan original filter)
                        let selectSql = `SELECT d.*, c.nama_cabang, strftime('%d-%m-%Y', d.tanggal_faktur) AS tanggal_format, strftime('%d-%m-%Y', d.tgl_tukar_faktur) AS tgl_tukar_format, d.status_faktur, d.masa_pajak, d.no_faktur_normal ${baseSql} ORDER BY CAST(SUBSTR(d.no_invoice_internal, 1, MAX(1, INSTR(d.no_invoice_internal, '/') - 1)) AS INTEGER) ASC, d.waktu_input DESC`;

                        const limitParams = [...params];
                        if (limit) {
                            selectSql += ` LIMIT ? OFFSET ?`;
                            limitParams.push(limit, (page - 1) * limit);
                        }

                        db.all(selectSql, limitParams, (err2, rows) => {
                            res.json({
                                data: rows || [], total, page, limit: limit || total,
                                needs_verify: needsVerify,
                                stats: {
                                    total_dpp: total_dpp,
                                    total_tax: total_tax,
                                    cur_jml: cur_jml,
                                    cur_tax: cur_tax,
                                    prev_jml: prev_jml,
                                    prev_tax: prev_tax
                                }
                            });
                        });
                    });
                } else {
                    // Untuk module lain (non-vatin), gunakan query stats biasa
                    const statsSql = `SELECT
                        COALESCE(SUM(d.dpp), 0) as total_dpp,
                        COALESCE(SUM(${colTax}), 0) as total_tax,
                        COALESCE(SUM(CASE WHEN strftime('%Y-%m', ${colTgl}) = ? THEN 1 ELSE 0 END), 0) as cur_jml,
                        COALESCE(SUM(CASE WHEN strftime('%Y-%m', ${colTgl}) = ? THEN ${colTax} ELSE 0 END), 0) as cur_tax,
                        COALESCE(SUM(CASE WHEN strftime('%Y-%m', ${colTgl}) = ? THEN 1 ELSE 0 END), 0) as prev_jml,
                        COALESCE(SUM(CASE WHEN strftime('%Y-%m', ${colTgl}) = ? THEN ${colTax} ELSE 0 END), 0) as prev_tax
                        ${baseSql}`;
                    const statsParams = [curYM, curYM, prevYM, prevYM, ...params];

                    db.get(statsSql, statsParams, (errS, statsRow) => {
                        let selectSql = mod.id.startsWith('vat')
                            ? `SELECT d.*, c.nama_cabang, strftime('%d-%m-%Y', d.tanggal_faktur) AS tanggal_format, strftime('%d-%m-%Y', d.tgl_tukar_faktur) AS tgl_tukar_format, d.status_faktur, d.masa_pajak, d.no_faktur_normal ${baseSql} ORDER BY CAST(SUBSTR(d.no_invoice_internal, 1, MAX(1, INSTR(d.no_invoice_internal, '/') - 1)) AS INTEGER) ASC, d.waktu_input DESC`
                            : mod.id === 'prepaid'
                            ? `SELECT d.*, c.nama_cabang, strftime('%d-%m-%Y', d.tanggal_dokumen) AS tgl_dokumen_format, strftime('%m-%Y', v.tanggal_faktur) AS masa_pajak_faktur ${baseSql} ORDER BY d.waktu_input DESC`
                            : `SELECT d.*, c.nama_cabang, strftime('%d-%m-%Y', d.tanggal_dokumen) AS tgl_dokumen_format ${baseSql} ORDER BY d.waktu_input DESC`;

                        if (limit) {
                            selectSql += ` LIMIT ? OFFSET ?`;
                            params.push(limit, (page - 1) * limit);
                        }

                        db.all(selectSql, params, (err2, rows) => {
                            res.json({
                                data: rows || [], total, page, limit: limit || total,
                                needs_verify: needsVerify,
                                stats: {
                                    total_dpp: statsRow ? statsRow.total_dpp : 0,
                                    total_tax: statsRow ? statsRow.total_tax : 0,
                                    cur_jml: statsRow ? statsRow.cur_jml : 0,
                                    cur_tax: statsRow ? statsRow.cur_tax : 0,
                                    prev_jml: statsRow ? statsRow.prev_jml : 0,
                                    prev_tax: statsRow ? statsRow.prev_tax : 0
                                }
                            });
                        });
                    });
                }
            });
        });
    });

    if (mod.id !== 'vatin') {
        app.get(`/api/inbox-${mod.id}`, cekAuth, (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const limit = req.query.limit === 'all' ? null : (parseInt(req.query.limit) || 50);
        const search = (req.query.search || '').trim();
        const entitas = req.query.entitas;

        let baseSql = `FROM inbox_${mod.id} WHERE 1=1`;
        let params = [];

        if (entitas) {
            baseSql += ` AND entitas = ?`;
            params.push(entitas);
        }

        if (req.query.search) {
            try {
                const searchParams = JSON.parse(decodeURIComponent(req.query.search));
                const ALLOWED_SEARCH_KEYS = ['noFaktur', 'namaPembeli', 'npwpPembeli', 'namaVendor', 'npwpVendor',
                    'tanggalFaktur', 'referensi', 'namaPembeli', 'namaDipotong', 'namaPemotong',
                    'noBppu', 'masaPajak', 'nomorDokumen', 'kotaPenerbit', 'penandatangan'];
                for (let key in searchParams) {
                    const val = searchParams[key];
                    if (!val) continue;

                    if (key === 'diinput_oleh') {
                        baseSql += ` AND diinput_oleh LIKE ?`;
                        params.push(`%${val}%`);
                    } else if (ALLOWED_SEARCH_KEYS.includes(key)) {
                        baseSql += ` AND json_extract(data_ekstraksi, '$.${key}') LIKE ?`;
                        params.push(`%${val}%`);
                    }
                }
            } catch (e) {
                const search = (req.query.search || '').trim();
                if (search) {
                    baseSql += ` AND (data_ekstraksi LIKE ? OR diinput_oleh LIKE ?)`;
                    const s = '%' + search + '%';
                    params.push(s, s);
                }
            }
        }

        db.get(`SELECT count(*) as total ${baseSql}`, params, (err, countRow) => {
            const total = countRow ? countRow.total : 0;
            let selectSql = `SELECT * ${baseSql} ORDER BY id DESC`;

            if (limit) {
                selectSql += ` LIMIT ? OFFSET ?`;
                params.push(limit, (page - 1) * limit);
            }

            db.all(selectSql, params, (err2, rows) => {
                res.json({ data: rows || [], total, page, limit: limit || total });
            });
            });
        });
    }
});

// ==============================================================
// API: Re-Ekstrak Items dari data tersimpan (untuk inbox lama yang itemsnya kosong)
// Dipanggil saat modal Lengkapi dibuka dan parsed.items kosong
// ==============================================================
app.get('/api/reextract-items-vatout/:id', cekAuth, async (req, res) => {
    try {
        const row = await dbGet(`SELECT data_ekstraksi FROM inbox_vatout WHERE id = ?`, [req.params.id]);
        if (!row) return res.json({ items: [] });

        // Jika data_ekstraksi sudah punya items, kembalikan langsung
        let parsed = {};
        try { parsed = JSON.parse(row.data_ekstraksi); } catch(e) {}
        if (parsed.items && parsed.items.length > 0) return res.json({ items: parsed.items });

        // Jika ada teks asli tersimpan (teksPDF field), re-ekstrak sekarang
        if (parsed.teksPDF) {
            const items = parseItems(parsed.teksPDF);
            return res.json({ items });
        }

        // Fallback: tidak ada teks tersimpan, kembalikan kosong
        res.json({ items: [] });
    } catch(e) {
        res.json({ items: [] });
    }
});

// ==============================================================
// API: Ambil daftar tahun yang tersedia untuk VAT OUT (per entitas)
// Digunakan oleh sidebar.js untuk membangun sub-menu dinamis
// ==============================================================
app.get('/api/years-vatout', cekAuth, (req, res) => {
    const entitas = req.query.entitas || 'BBS';
    const sql = `
        SELECT DISTINCT strftime('%Y', tanggal_faktur) AS year
        FROM data_vatout
        WHERE entitas = ? AND tanggal_faktur IS NOT NULL AND tanggal_faktur NOT IN ('', '-')
        UNION
        SELECT DISTINCT substr(json_extract(data_ekstraksi, '$.tanggalFaktur'), 1, 4) AS year
        FROM inbox_vatout
        WHERE entitas = ? AND data_ekstraksi IS NOT NULL
        ORDER BY year DESC
    `;
    db.all(sql, [entitas, entitas], (err, rows) => {
        const years = (rows || [])
            .map(r => (r.year || '').toString().trim())
            .filter(y => /^\d{4}$/.test(y));
        res.json([...new Set(years)]);
    });
});

app.post('/login', loginLimiter, (req, res) => {
    if (!req.body.username || !req.body.password) {
        return res.send(`<script>window.location.href='/login?error=3';</script>`);
    }
    db.get(`SELECT * FROM users WHERE username = ?`, [req.body.username], (err, user) => {
        if (user && bcrypt.compareSync(req.body.password, user.password)) {
            req.session.user = { id: user.id, username: user.username, nama_lengkap: user.nama_lengkap, role: user.role, passwordHash: user.password };
            res.redirect('/dashboard-utama');
        } else {
            // SECURITY: Pesan error generik agar tidak mengungkap apakah username ada atau tidak
            res.send(`<script>window.location.href='/login?error=1';</script>`);
        }
    });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/api/me', cekAuth, (req, res) => {
    // AUDIT FIX (M-03): Beri tahu frontend jika password masih default
    const isDefaultPassword = bcrypt.compareSync('Emergent@2024!', req.session.user.passwordHash || '');
    res.json({
        id: req.session.user.id,
        username: req.session.user.username,
        nama: req.session.user.nama_lengkap,
        role: req.session.user.role,
        isDefaultPassword: isDefaultPassword
    });
});
app.get('/api/branches', cekAuth, (req, res) => db.all(`SELECT * FROM master_cabang WHERE entitas = ?`, [req.query.entitas || 'BBS'], (err, rows) => res.json(rows || [])));
app.get('/api/users', cekAuth, (req, res) => db.all(`SELECT id, username, nama_lengkap, role FROM users`, (err, rows) => res.json(rows || [])));
app.get('/api/my-requests', cekAuth, (req, res) => db.all(`SELECT *, strftime('%d-%m-%Y %H:%M', waktu, 'localtime') AS waktu_format FROM user_requests WHERE user_id = ?`, [req.session.user.id], (err, rows) => res.json(rows || [])));
app.get('/api/pending-requests', cekAuth, (req, res) => db.all(`SELECT *, strftime('%d-%m-%Y %H:%M', waktu, 'localtime') AS waktu_format FROM user_requests WHERE status = 'Pending'`, (err, rows) => res.json(rows || [])));

// ==========================================
// API: DASHBOARD UTAMA SUMMARY
// ==========================================
app.get('/api/dashboard-summary', cekAuth, (req, res) => {
    const ent = req.query.entitas || 'BBS';

    const queries = {
        vatout_total: `SELECT COUNT(*) as jml, COALESCE(SUM(dpp),0) as total_dpp, COALESCE(SUM(ppn),0) as total_ppn FROM data_vatout WHERE entitas = ?`,
        vatout_inbox: `SELECT COUNT(*) as jml FROM inbox_vatout WHERE entitas = ?`,
        vatin_total: `SELECT COUNT(*) as jml, COALESCE(SUM(dpp),0) as total_dpp, COALESCE(SUM(ppn),0) as total_ppn FROM data_vatin WHERE entitas = ?`,
        vatin_inbox: `SELECT COUNT(*) as jml FROM data_vatin WHERE entitas = ? AND kode_cabang = 'Perlu Verifikasi'`,
        payable_total: `SELECT COUNT(*) as jml, COALESCE(SUM(dpp),0) as total_dpp, COALESCE(SUM(nilai_pph),0) as total_pph FROM data_payable WHERE entitas = ?`,
        payable_inbox: `SELECT COUNT(*) as jml FROM inbox_payable WHERE entitas = ?`,
        prepaid_total: `SELECT COUNT(*) as jml, COALESCE(SUM(dpp),0) as total_dpp, COALESCE(SUM(nilai_pph),0) as total_pph FROM data_prepaid WHERE entitas = ?`,
        prepaid_inbox: `SELECT COUNT(*) as jml FROM inbox_prepaid WHERE entitas = ?`,
        ledger_total: `SELECT COUNT(*) as jml, COALESCE(SUM(contract_income),0) as total_income, COALESCE(SUM(net_receipt),0) as total_receipt, COALESCE(SUM(contract_debtor),0) as total_debtor FROM data_client_ledger WHERE entitas = ? AND is_advance = 0`,
        recent_vatout: `SELECT no_faktur, nama_pembeli, dpp, ppn, strftime('%d-%m-%Y', tanggal_faktur) AS tgl FROM data_vatout WHERE entitas = ? ORDER BY waktu_input DESC LIMIT 5`,
        recent_vatin: `SELECT no_faktur, nama_penjual, dpp, ppn, strftime('%d-%m-%Y', tanggal_faktur) AS tgl FROM data_vatin WHERE entitas = ? ORDER BY waktu_input DESC LIMIT 5`,
        pending_req: `SELECT COUNT(*) as jml FROM user_requests WHERE status = 'Pending'`
    };

    const execQuery = (sql, params) => new Promise((resolve) => {
        db.get(sql, params, (err, row) => resolve(err ? null : row));
    });
    const execAll = (sql, params) => new Promise((resolve) => {
        db.all(sql, params, (err, rows) => resolve(err ? [] : (rows || [])));
    });

    Promise.all([
        execQuery(queries.vatout_total, [ent]),
        execQuery(queries.vatout_inbox, [ent]),
        execQuery(queries.vatin_total, [ent]),
        execQuery(queries.vatin_inbox, [ent]),
        execQuery(queries.payable_total, [ent]),
        execQuery(queries.payable_inbox, [ent]),
        execQuery(queries.prepaid_total, [ent]),
        execQuery(queries.prepaid_inbox, [ent]),
        execQuery(queries.ledger_total, [ent]),
        execAll(queries.recent_vatout, [ent]),
        execAll(queries.recent_vatin, [ent]),
        execQuery(queries.pending_req, [])
    ]).then(([vatoutT, vatoutI, vatinT, vatinI, payableT, payableI, prepaidT, prepaidI, ledgerT, recentOut, recentIn, pendingReq]) => {
        res.json({
            vatout: { jml: vatoutT?.jml || 0, dpp: vatoutT?.total_dpp || 0, ppn: vatoutT?.total_ppn || 0, pending: vatoutI?.jml || 0 },
            vatin: { jml: vatinT?.jml || 0, dpp: vatinT?.total_dpp || 0, ppn: vatinT?.total_ppn || 0, pending: vatinI?.jml || 0 },
            payable: { jml: payableT?.jml || 0, dpp: payableT?.total_dpp || 0, pph: payableT?.total_pph || 0, pending: payableI?.jml || 0 },
            prepaid: { jml: prepaidT?.jml || 0, dpp: prepaidT?.total_dpp || 0, pph: prepaidT?.total_pph || 0, pending: prepaidI?.jml || 0 },
            ledger: { jml: ledgerT?.jml || 0, income: ledgerT?.total_income || 0, receipt: ledgerT?.total_receipt || 0, debtor: ledgerT?.total_debtor || 0 },
            recent_vatout: recentOut,
            recent_vatin: recentIn,
            pending_requests: pendingReq?.jml || 0
        });
    }).catch(err => res.status(500).json({ error: err.message }));
});
app.get('/api/summary', cekAuth, (req, res) => {
    const ent = req.query.entitas || 'BBS';

    const sqlAll = `SELECT no_faktur, no_faktur_normal, status_faktur, tgl_tukar_faktur, tanggal_faktur, ppn, waktu_input, masa_pajak FROM data_vatin WHERE entitas = ?`;
    
    db.all(sqlAll, [ent], (err, allRows) => {
        if (err) {
            console.error('Error /api/summary:', err);
            return res.json([]);
        }

        // Deduplikasi data vatin
        const deduplicatedRows = deduplicateVatinData(allRows || []);

        // Kelompokkan by periode dan hitung stats
        const ttfMap = {};
        const fakturMap = {};

        deduplicatedRows.forEach(row => {
            // Berdasarkan tgl_tukar_faktur
            if (row.tgl_tukar_faktur && row.tgl_tukar_faktur !== '' && row.tgl_tukar_faktur !== '-') {
                const periodeTTF = row.tgl_tukar_faktur.substring(5, 7) + '-' + row.tgl_tukar_faktur.substring(0, 4);
                if (!ttfMap[periodeTTF]) {
                    ttfMap[periodeTTF] = { jml: 0, total_ppn: 0 };
                }
                ttfMap[periodeTTF].jml += 1;
                ttfMap[periodeTTF].total_ppn += (row.ppn || 0);
            }

            // Berdasarkan tanggal_faktur, diganti menggunakan masa_pajak agar mengikuti aturan faktur pengganti
            if (row.masa_pajak) {
                const parts = row.masa_pajak.split('-');
                if (parts.length === 2) {
                    const periodeFaktur = parts[1] + '-' + parts[0];
                    if (!fakturMap[periodeFaktur]) {
                        fakturMap[periodeFaktur] = { jml: 0, total_ppn: 0 };
                    }
                    fakturMap[periodeFaktur].jml += 1;
                    fakturMap[periodeFaktur].total_ppn += (row.ppn || 0);
                }
            }
        });

        // Gabungkan periode dan format hasil
        const periodeSet = new Set();
        Object.keys(ttfMap).forEach(p => periodeSet.add(p));
        Object.keys(fakturMap).forEach(p => periodeSet.add(p));

        const result = Array.from(periodeSet).sort().reverse().map(p => ({
            periode: p,
            jml_tukar: ttfMap[p] ? ttfMap[p].jml : 0,
            ppn_tukar: ttfMap[p] ? ttfMap[p].total_ppn : 0,
            jml_faktur: fakturMap[p] ? fakturMap[p].jml : 0,
            ppn_faktur: fakturMap[p] ? fakturMap[p].total_ppn : 0
        }));

        res.json(result);
    });
});

app.get('/api/audit-vatin', cekAuth, (req, res) => {
    const entitas = req.query.entitas || 'BBS';

    const orphanSql = `
        SELECT
            r.no_faktur,
            r.status_faktur,
            r.ppn
        FROM data_vatin r
        WHERE r.entitas = ?
          AND r.status_faktur LIKE 'Pengganti%'
          AND NOT EXISTS (
              SELECT 1
              FROM data_vatin n
              WHERE n.entitas = r.entitas
                AND SUBSTR(n.no_faktur, 5) = SUBSTR(r.no_faktur, 5)
                AND n.status_faktur = 'Normal'
          )
        ORDER BY r.waktu_input DESC
        LIMIT 5000
    `;

    const replacedSql2 = `
        SELECT
            n.no_faktur AS normal_no_faktur,
            n.masa_pajak AS normal_masa_pajak,
            n.ppn AS normal_ppn,
            p.no_faktur AS latest_pengganti_no_faktur,
            p.status_faktur AS latest_pengganti_status_faktur,
            p.ppn AS latest_pengganti_ppn
        FROM data_vatin n
        INNER JOIN data_vatin p
            ON SUBSTR(p.no_faktur, 5) = SUBSTR(n.no_faktur, 5)
           AND p.entitas = n.entitas
           AND p.status_faktur LIKE 'Pengganti%'
        INNER JOIN (
            SELECT SUBSTR(no_faktur, 5) AS serial_faktur, MAX(waktu_input) AS max_waktu
            FROM data_vatin
            WHERE entitas = ?
              AND status_faktur LIKE 'Pengganti%'
            GROUP BY SUBSTR(no_faktur, 5)
        ) mx
          ON mx.serial_faktur = SUBSTR(p.no_faktur, 5)
         AND mx.max_waktu = p.waktu_input
        WHERE n.entitas = ?
          AND n.status_faktur = 'Normal'
        GROUP BY n.no_faktur
        ORDER BY n.waktu_input DESC
        LIMIT 5000
    `;

    const diffMasaSql = `
        SELECT
            n.no_faktur AS normal_no_faktur,
            n.masa_pajak AS normal_masa_pajak,
            p.no_faktur AS pengganti_no_faktur,
            strftime('%Y-%m', p.tanggal_faktur) AS pengganti_masa_pajak
        FROM data_vatin n
        INNER JOIN data_vatin p
            ON SUBSTR(p.no_faktur, 5) = SUBSTR(n.no_faktur, 5)
           AND p.entitas = n.entitas
           AND p.status_faktur LIKE 'Pengganti%'
        WHERE n.entitas = ?
          AND n.status_faktur = 'Normal'
          AND (n.masa_pajak != strftime('%Y-%m', p.tanggal_faktur) OR p.tanggal_faktur IS NULL OR n.masa_pajak IS NULL)
        ORDER BY p.waktu_input DESC
        LIMIT 5000
    `;

    db.all(orphanSql, [entitas], (err1, orphanRows) => {
        if (err1) return res.status(500).json({ error: err1.message, orphan_replacements: [], replaced_normals: [], diff_masa: [] });
        db.all(replacedSql2, [entitas, entitas], (err2, replacedRows) => {
            if (err2) return res.status(500).json({ error: err2.message, orphan_replacements: orphanRows || [], replaced_normals: [], diff_masa: [] });
            db.all(diffMasaSql, [entitas], (err3, diffMasaRows) => {
                if (err3) return res.status(500).json({ error: err3.message, orphan_replacements: orphanRows || [], replaced_normals: replacedRows || [], diff_masa: [] });
                res.json({
                    orphan_replacements: orphanRows || [],
                    replaced_normals: replacedRows || [],
                    diff_masa: diffMasaRows || []
                });
            });
        });
    });
});

app.get('/api/summary-vatout', cekAuth, (req, res) => {
    const ent = req.query.entitas || 'BBS';


    const sqlTrend = `SELECT strftime('%m-%Y', tanggal_faktur) as periode, count(*) as jml, sum(ppn) as total_ppn, sum(dpp) as total_dpp FROM data_vatout WHERE entitas = ? GROUP BY periode`;
    const sqlBranch = `SELECT d.kode_cabang, c.nama_cabang, count(*) as jml, sum(d.ppn) as total_ppn FROM data_vatout d LEFT JOIN master_cabang c ON d.kode_cabang = c.kode_cabang WHERE d.entitas = ? GROUP BY d.kode_cabang`;

    db.all(sqlTrend, [ent], (err1, trendRows) => {
        db.all(sqlBranch, [ent], (err2, branchRows) => {
            const result = (trendRows || []).map(r => ({
                periode: r.periode,
                jml_faktur: r.jml,
                ppn_faktur: r.total_ppn,
                dpp_faktur: r.total_dpp
            }));

            res.json({
                trend: result,
                branch: branchRows || []
            });
        });
    });
});



app.get('/api/available-vatout', cekAuth, (req, res) => {
    const entitas = req.query.entitas || 'BBS';
    const clientName = req.query.client || '';
    const mode = req.query.mode || '';
    const currentDoc = req.query.current_doc || '';

    const sql = `
        SELECT d.no_faktur, d.nama_pembeli, d.harga_jual, d.dpp, d.ppn, d.no_invoice_internal, 
               strftime('%d-%m-%Y', d.tanggal_faktur) AS tanggal_format
        FROM data_vatout d 
        WHERE d.entitas = ?
        ORDER BY d.waktu_input DESC
    `;

    db.all(sql, [entitas], (err, vatoutRows) => {
        if (err) return res.json([]);

        let usedSql = mode === 'ledger'
            ? `SELECT inv_no AS used_ref FROM data_client_ledger WHERE inv_no IS NOT NULL AND inv_no != '' AND inv_no != '-'`
            : `SELECT no_invoice_internal AS used_ref FROM data_prepaid WHERE no_invoice_internal IS NOT NULL AND no_invoice_internal != '' AND no_invoice_internal != '-'`;

        let paramData = [];
        if (mode !== 'ledger' && currentDoc) {
            usedSql += ` AND no_bppu != ?`;
            paramData.push(currentDoc);
        }

        db.all(usedSql, paramData, (err2, usedRows) => {
            const usedInvoices = new Set();
            (usedRows || []).forEach(r => {
                if (r.used_ref) {
                    r.used_ref.split(',').forEach(item => usedInvoices.add(item.trim()));
                }
            });

            const result = vatoutRows.filter(row => {
                // Jangan tampilkan faktur yang sudah dipakai di list
                return !(usedInvoices.has(row.no_faktur) || usedInvoices.has(row.no_invoice_internal));
            }).map(row => ({
                no_faktur: row.no_faktur,
                nama_pembeli: row.nama_pembeli,
                harga_jual: row.harga_jual,
                dpp: row.dpp,
                ppn: row.ppn,
                tanggal_format: row.tanggal_format,
                no_invoice_internal: row.no_invoice_internal,
                sudah_dipakai: false
            }));

            if (clientName) {
                const clientUpper = clientName.toUpperCase();
                const filtered = result.filter(r => {
                    const nama = (r.nama_pembeli || '').toUpperCase();
                    return nama.includes(clientUpper) || clientUpper.includes(nama);
                });
                const others = result.filter(r => {
                    const nama = (r.nama_pembeli || '').toUpperCase();
                    return !(nama.includes(clientUpper) || clientUpper.includes(nama));
                });
                return res.json({ matching: filtered, others: others });
            }
            res.json({ matching: result, others: [] });
        });
    });
});

app.get('/api/search-prepaid-for-ledger', cekAuth, (req, res) => {
    const queryTerm = req.query.inv_no || '';
    if (!queryTerm) return res.json([]);

    // Pecah search term ke array (siapa tahu dari frontend mengirim koma)
    const searchTerms = queryTerm.split(',').map(s => s.trim()).filter(Boolean);

    db.all(`SELECT no_bppu, nama_pemotong, dpp, nilai_pph, tanggal_dokumen, no_invoice_internal FROM data_prepaid`, [], (err, rows) => {
        if (!rows) return res.json([]);
        const matched = rows.filter(r => {
            if (!r.no_invoice_internal) return false;
            let invsInDb = r.no_invoice_internal.split(',').map(i => i.trim());
            // COCOKKAN: Jika ada salah satu searchTerm yang masuk di dalam list invoice di DB
            return searchTerms.some(term => invsInDb.includes(term));
        });
        res.json(matched);
    });
});

// API: SUMMARY SALDO ADVANCE GLOBAL
app.get('/api/client-advance-summary', cekAuth, (req, res) => {
    const entitas = req.query.entitas || 'BBS';

    // Ambil semua transaksi DP (is_advance = 1)
    const sqlMain = `SELECT id, inv_no, nama_client, net_certificate as total_advance, waktu_input FROM data_client_ledger WHERE entitas = ? AND is_advance = 1`;

    db.all(sqlMain, [entitas], (err, advances) => {
        if (err || !advances) return res.json([]);

        // Ambil semua potongan DP yang pernah dilakukan
        const sqlDeductions = `SELECT ref_advance, SUM(advance) as total_terpakai FROM data_client_ledger WHERE entitas = ? AND ref_advance IS NOT NULL AND ref_advance != '' AND ref_advance != '-' GROUP BY ref_advance`;

        db.all(sqlDeductions, [entitas], (err2, deductions) => {
            const dedMap = {};
            (deductions || []).forEach(d => { dedMap[d.ref_advance] = d.total_terpakai; });

            const results = advances.map(adv => {
                const terpakai = dedMap[adv.inv_no] || 0;
                return {
                    ...adv,
                    terpakai: terpakai,
                    sisa_saldo: adv.total_advance - terpakai
                };
            }).filter(adv => adv.sisa_saldo > 0); // Hanya tampilkan yang masih ada sisa

            res.json(results);
        });
    });
});

app.get('/api/search-advance-ledger', cekAuth, (req, res) => {
    const clientUpper = (req.query.client || '').toUpperCase();
    if (!clientUpper) return res.json([]);

    db.all(`SELECT * FROM data_client_ledger WHERE is_advance = 1`, [], (err, advanceRows) => {
        if (!advanceRows) return res.json([]);
        let clientAdvances = advanceRows.filter(r => {
            const nama = (r.nama_client || '').toUpperCase();
            return (nama.includes(clientUpper) || clientUpper.includes(nama));
        });
        if (clientAdvances.length === 0) return res.json([]);

        db.all(`SELECT ref_advance, advance FROM data_client_ledger WHERE ref_advance != '' AND ref_advance IS NOT NULL`, [], (err, childRows) => {
            let relations = childRows || [];
            clientAdvances = clientAdvances.map(adv => {
                let totalDeductions = relations.filter(r => r.ref_advance === adv.inv_no)
                    .reduce((sum, r) => sum + Number(r.advance || 0), 0);

                let balance = Number(adv.net_certificate || 0) - totalDeductions;
                return {
                    id: adv.id,
                    inv_no: adv.inv_no,
                    nama_client: adv.nama_client,
                    total_advance: Number(adv.net_certificate || 0),
                    terpakai: totalDeductions,
                    sisa_saldo: balance
                };
            });
            // Hapus yang saldonya sudah 0 atau negatif (jika terindikasi selesai pelunasan DP)
            res.json(clientAdvances.filter(adv => adv.sisa_saldo > 0));
        });
    });
});

// ==========================================
// 4. LOGIKA SOCKET.IO (BULK / BATCH PROCESSING)
// ==========================================
io.use((socket, next) => {
    const session = socket.request.session;
    if (session && session.user) {
        socket.user = session.user;
        return next();
    }
    next(new Error('Unauthorized: Silakan login terlebih dahulu.'));
});

io.on('connection', (socket) => {

    const getRole = (socket) => (socket.user?.role || '').toLowerCase();
    const isAdministrator = (socket) => ['administrator', 'superadmin'].includes(getRole(socket));
    const isSupervisorOrAbove = (socket) => ['supervisor', 'administrator', 'superadmin'].includes(getRole(socket));
    const isDummy = (socket) => getRole(socket) === 'dummy';

    const checkDuplicateAsync = async (tableFinal, tableInbox, column, value) => {
        let row = await dbGet(`SELECT 1 FROM ${tableFinal} WHERE ${column} = ?`, [value]);
        if (row) return true;
        let rowIn = await dbGet(`SELECT 1 FROM ${tableInbox} WHERE data_ekstraksi LIKE ?`, [`%${value}%`]);
        if (rowIn) return true;
        return false;
    };

    socket.on('request-action-faktur', (d) => {
        if (isDummy(socket)) {
            return socket.emit('request-updated', { message: 'Mode Dummy: Permintaan disimulasi.' });
        }
        const userRole = (socket.user && socket.user.role || '').toLowerCase();
        const isSupervisor = ['supervisor', 'administrator'].includes(userRole);
        const VALID_MODS = ['vatin', 'vatout', 'payable', 'prepaid'];
        if (!VALID_MODS.includes(d.mod)) {
            return socket.emit('error-action', { message: 'Modul tidak valid.' });
        }
        const isBPPU = (d.mod === 'payable' || d.mod === 'prepaid');
        const pkColumn = isBPPU ? 'no_bppu' : 'no_faktur';

        if (d.action === 'DELETE') {
            if (isSupervisor) {
                db.serialize(() => {
                    db.run(`DELETE FROM data_${d.mod} WHERE ${pkColumn} = ?`, [d.faktur]);
                    if (!isBPPU) {
                        db.run(`DELETE FROM item_${d.mod} WHERE no_faktur = ?`, [d.faktur]);
                    }
                    insertAuditLog(socket.user.id, socket.user.username, 'HAPUS', d.mod.toUpperCase(), `Supervisor menghapus data ${d.mod}: ${d.faktur}`);
                    io.emit(`data-baru-${d.mod}`);
                });
            } else {
                db.run(`INSERT INTO user_requests (user_id, username, jenis_request, nilai_baru) VALUES (?, ?, ?, ?)`,
                    [d.id_user, d.username, `HAPUS_${d.mod.toUpperCase()}`, d.faktur], () => io.emit('request-updated'));
            }
        }
        else if (d.action === 'EDIT') {
            if (isSupervisor) {
                if (isBPPU) {
                    db.run(`UPDATE data_${d.mod} SET kode_cabang = ?, no_invoice_internal = ? WHERE no_bppu = ?`,
                        [d.newData.branch, d.newData.invoice, d.faktur], () => { io.emit(`data-baru-${d.mod}`); });
                } else {
                    let sql = `UPDATE data_${d.mod} SET kode_cabang = ?, no_invoice_internal = ?, tgl_tukar_faktur = ?`;
                    let params = [d.newData.branch, d.newData.invoice, d.newData.tanggal];
                    if(d.mod === 'vatout' && d.newData.vo) {
                        sql += `, kode_vo = ?`;
                        params.push(d.newData.vo);
                    }
                    sql += ` WHERE no_faktur = ?`;
                    params.push(d.faktur);
                    db.run(sql, params, () => { io.emit(`data-baru-${d.mod}`); });
                }
            } else {
                db.get(`SELECT kode_cabang, no_invoice_internal${!isBPPU ? ', tgl_tukar_faktur' : ''}${d.mod === 'vatout' ? ', kode_vo' : ''} FROM data_${d.mod} WHERE ${pkColumn} = ?`, [d.faktur], (err, original) => {
                    let requestValue = JSON.stringify({
                        faktur: d.faktur,
                        old: original ? {
                            branch: original.kode_cabang,
                            invoice: original.no_invoice_internal,
                            tanggal: !isBPPU ? original.tgl_tukar_faktur : '-',
                            vo: d.mod === 'vatout' ? original.kode_vo : null
                        } : null,
                        new: {
                            branch: d.newData.branch,
                            invoice: d.newData.invoice,
                            tanggal: d.newData.tanggal,
                            vo: d.newData.vo
                        }
                    });
                    db.run(`INSERT INTO user_requests (user_id, username, jenis_request, nilai_baru) VALUES (?, ?, ?, ?)`,
                        [d.id_user, d.username, `EDIT_${d.mod.toUpperCase()}`, requestValue], () => io.emit('request-updated'));
                });
            }
        }
    });

    socket.on('upload-pdf-vatin-batch', async (d) => {
        if (isDummy(socket)) {
            socket.emit('upload-batch-selesai', { modul: 'VAT IN (DUMMY)', total: d.files?.length || 0, sukses: 0, duplikat: 0, gagal: 0 });
            return;
        }
        let files = d.files || [];
        if (!Array.isArray(files)) return;

        let entitas = d.entitas || 'BBS';
        let username = d.username || 'System';
        let sukses = 0, duplikat = 0, gagal = 0;

        for (let file of files) {
            // AUDIT FIX (M-08): Validasi ukuran dan tipe file
            if (!file.fileBuffer || file.fileBuffer.byteLength > 5 * 1024 * 1024) { gagal++; continue; }
            if (!file.teksPDF || typeof file.teksPDF !== 'string') { gagal++; continue; }
            try {
                const teks = file.teksPDF;
                let mNo = teks.match(/Kode dan Nomor Seri Faktur Pajak:\s*([\d]+)/i);
                if (!mNo) { gagal++; continue; }

                let noFakturAktual = mNo[1];
                let isPengganti = parseStatusFaktur(noFakturAktual) !== 'Normal';
                let noFakturNormal = isPengganti ? getNoFakturNormal(noFakturAktual) : noFakturAktual;

                let isDup = await checkDuplicateAsync('data_vatin', 'inbox_vatin', 'no_faktur', noFakturAktual);
                if (isDup) { duplikat++; continue; }

                const formatTipe = 'MODERN';

                let mVen = teks.match(/Pengusaha Kena Pajak[\s\S]*?Nama\s*:\s*(.*?)Alamat/i);
                let mAlmVen = teks.match(/Pengusaha Kena Pajak[\s\S]*?Alamat\s*:\s*([\s\S]*?)NPWP\s*:/i);
                let mNpwpVen = teks.match(/Pengusaha Kena Pajak[\s\S]*?NPWP\s*:\s*([\d\.\-]+)/i);

                let mPem = teks.match(/Pembeli Barang Kena Pajak[\s\S]*?Nama\s*:\s*(.*?)Alamat/i);
                let mAlmPem = teks.match(/Pembeli Barang Kena Pajak[\s\S]*?Alamat\s*:\s*([\s\S]*?)NPWP\s*:/i);
                let mNpwpPem = teks.match(/Pembeli Barang Kena Pajak[\s\S]*?NPWP\s*:\s*([\d\.\-]+)/i);

                const namaEntitasPembeli = mPem?.[1].trim().toUpperCase() || "";
                const entitasMap = { 'BBS': ['BERCA BUANA SAKTI'], 'JO': ['BERCA JO', 'BBS JO', 'BMP JO'] };
                let validNames = entitasMap[entitas] || [];
                let isValid = validNames.some(name => namaEntitasPembeli.includes(name));

                if (!isValid) { gagal++; continue; }

                let mHargaJual = teks.match(/Harga Jual \/ Penggantian \/ Uang Muka \/ Termin\s+([\d\.,]+)/i);
                let mDPP = teks.match(/Dasar Pengenaan Pajak[^\d]*?((?:\d{1,3}\.)*\d{1,3},\d{2})/i);
                let mPPN = teks.match(/Jumlah PPN[^\d]*?((?:\d{1,3}\.)*\d{1,3},\d{2})/i);
                let mDiskon = teks.match(/Dikurangi Potongan Harga\s+([\d\.,]+)/i);
                let mDP = teks.match(/Dikurangi Uang Muka yang telah diterima\s+([\d\.,]+)/i);
                let mTgl = teks.match(/([A-Za-z\s\.]+),\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
                let mRef = teks.match(/\(Referensi[\s:,]+([^)]+)\)/i);
                let mTTD = teks.match(/Ditandatangani secara elektronik\s*\n(.*?)\s*\n/i);

                let namaVendorSafe = sanitizeFilename(mVen?.[1]);
                let namaFileLokal = `arsip_vatin/Perlu Verifikasi_${noFakturAktual}_${namaVendorSafe}.pdf`;

                let data = {
                    noFaktur: noFakturAktual,
                    isPengganti: isPengganti,
                    noFakturNormal: noFakturNormal,
                    statusFaktur: parseStatusFaktur(noFakturAktual),
                    masaPajak: null,
                    namaVendor: mVen?.[1].trim(), alamatVendor: mAlmVen ? mAlmVen[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : "-", npwpVendor: mNpwpVen?.[1].trim(),
                    namaPembeli: mPem?.[1].trim(), alamatPembeli: mAlmPem ? mAlmPem[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : "-", npwpPembeli: mNpwpPem?.[1].trim(),
                    tanggalFaktur: mTgl ? formatTanggal(mTgl[2]) : "-", kotaPenerbit: mTgl ? mTgl[1].trim() : "-", format_tipe: formatTipe,
                    referensi: mRef ? mRef[1].trim() : "-", penandatangan: mTTD ? mTTD[1].trim() : "-",
                    hargaJual: bersihkanAngka(mHargaJual?.[1]), dpp: bersihkanAngka(mDPP?.[1]), ppn: bersihkanAngka(mPPN?.[1]),
                    diskon: bersihkanAngka(mDiskon?.[1]), uangMuka: bersihkanAngka(mDP?.[1]),
                    items: parseItems(teks), link_pdf_lokal: namaFileLokal, entitas: entitas
                };

                data.masaPajak = extractMasaPajak(data.tanggalFaktur);

                if (data.npwpVendor) {
                    await updateMasterData('master_vendor', data.npwpVendor, data.namaVendor, data.alamatVendor, data.format_tipe, data.tanggalFaktur);
                }

                await fsPromises.writeFile(path.join(__dirname, 'vat_in', namaFileLokal), Buffer.from(file.fileBuffer));

                await dbRun(`INSERT INTO data_vatin (
                    no_faktur, entitas, kode_cabang, npwp_penjual, nama_penjual, alamat_penjual, npwp_pembeli, nama_pembeli, alamat_pembeli, 
                    tanggal_faktur, harga_jual, diskon, uang_muka, referensi, kota_penerbit, penandatangan, dpp, ppn, 
                    no_invoice_internal, tgl_tukar_faktur, diinput_oleh, link_pdf_lokal, format_tipe, status_faktur, masa_pajak, no_faktur_normal
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
                [
                    data.noFaktur, data.entitas, "Perlu Verifikasi", data.npwpVendor, data.namaVendor, data.alamatVendor, 
                    data.npwpPembeli, data.namaPembeli, data.alamatPembeli, data.tanggalFaktur, data.hargaJual, 
                    data.diskon, data.uangMuka, data.referensi, data.kotaPenerbit, data.penandatangan, data.dpp, data.ppn, 
                    data.referensi, null, username, data.link_pdf_lokal, data.format_tipe, data.statusFaktur, data.masaPajak, data.noFakturNormal
                ]);

                if (data.items && data.items.length > 0) {
                    let stmt = db.prepare(`INSERT INTO item_vatin (no_faktur, nama_barang, harga_satuan, qty, satuan, diskon, total_harga) VALUES (?, ?, ?, ?, ?, ?, ?)`);
                    data.items.forEach(it => stmt.run([data.noFaktur, it.nama_barang, it.harga_satuan, it.qty, it.satuan, it.diskon, it.total_harga]));
                    stmt.finalize();
                }

                sukses++;
            } catch (e) { console.error("Direct Upload Error:", e); gagal++; }
        }

        insertAuditLog(socket.user.id, username, 'UPLOAD_BATCH', 'VAT IN', `Upload batch VAT IN selesai. Total: ${files.length}, Sukses: ${sukses}, Gagal: ${gagal}, Duplikat: ${duplikat}`);
        socket.emit('upload-batch-selesai', { modul: 'VAT IN', total: files.length, sukses, duplikat, gagal });
        io.emit('update-tabel-vatin');
    });

    socket.on('simpan-final-vatin', (d) => {
        if (isDummy(socket)) {
            socket.emit('simpan-final-sukses', { message: 'Mode Dummy: Verifikasi disimulasi.' });
            return io.emit('update-tabel-vatin');
        }
        let namaVendorSafe = sanitizeFilename(d.namaVendor);
        let namaFileFinal = `arsip_vatin/${d.branchInput}_${d.noFaktur}_${namaVendorSafe}.pdf`;

        const sourcePath = path.join(__dirname, 'vat_in', d.link_pdf_lokal);
        const destPath = path.join(__dirname, 'vat_in', namaFileFinal);
        const fileExistsAtSource = fs.existsSync(sourcePath);
        const fileExistsAtDest = fs.existsSync(destPath);
        const linkPdfFinal = (fileExistsAtSource || fileExistsAtDest) ? namaFileFinal : d.link_pdf_lokal;

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            if (d.isPengganti && d.noFakturNormal) {
                db.run(`DELETE FROM data_vatin WHERE no_faktur = ?`, [d.noFakturNormal]);
                db.run(`DELETE FROM item_vatin WHERE no_faktur = ?`, [d.noFakturNormal]);
            }

            const statusFaktur = parseStatusFaktur(d.noFaktur);
            const masaPajak = extractMasaPajak(d.tanggalFaktur);
            const noFakturNormal = d.isPengganti ? getNoFakturNormal(d.noFaktur) : null;

            db.run(`INSERT INTO data_vatin (no_faktur, entitas, kode_cabang, npwp_penjual, nama_penjual, alamat_penjual, npwp_pembeli, nama_pembeli, alamat_pembeli, tanggal_faktur, harga_jual, diskon, uang_muka, referensi, kota_penerbit, penandatangan, dpp, ppn, no_invoice_internal, tgl_tukar_faktur, diinput_oleh, link_pdf_lokal, format_tipe, status_faktur, masa_pajak, no_faktur_normal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [d.noFaktur, d.entitas, d.branchInput, d.npwpVendor, d.namaVendor, d.alamatVendor, d.npwpPembeli, d.namaPembeli, d.alamatPembeli, d.tanggalFaktur, d.hargaJual, d.diskon, d.uangMuka, d.referensi, d.kotaPenerbit, d.penandatangan, d.dpp, d.ppn, d.invoiceInput, d.tglTukarInput, d.username, linkPdfFinal, d.format_tipe, statusFaktur, masaPajak, noFakturNormal], function (err) {
                    if (err) { 
                        db.run("ROLLBACK"); 
                        socket.emit('error-simpan', { message: 'Gagal menyimpan data VAT IN: ' + err.message });
                        return; 
                    }

                    let stmt = db.prepare(`INSERT INTO item_vatin (no_faktur, nama_barang, harga_satuan, qty, satuan, diskon, total_harga) VALUES (?, ?, ?, ?, ?, ?, ?)`);
                    if (d.items && d.items.length > 0) d.items.forEach(it => stmt.run([d.noFaktur, it.nama_barang, it.harga_satuan, it.qty, it.satuan, it.diskon, it.total_harga]));
                    stmt.finalize();

                    db.run(`DELETE FROM inbox_vatin WHERE id = ?`, [d.id_link], (err) => {
                        if (err) { db.run("ROLLBACK"); return; }
                        db.run("COMMIT");
                        if (fileExistsAtSource && !fileExistsAtDest) {
                            try { fs.renameSync(sourcePath, destPath); } catch (renameErr) {}
                        }
                        insertAuditLog(socket.user.id, d.username, 'SIMPAN', 'VAT IN', `Menyimpan faktur VAT IN: ${d.noFaktur}`);
                        io.emit('update-tabel-vatin'); io.emit('data-baru-vatin');
                    });
                });
        });
    });

    socket.on('hapus-inbox-vatin', (id) => {
        if (isDummy(socket)) return io.emit('update-tabel-vatin');
        db.get(`SELECT link_pdf_lokal FROM inbox_vatin WHERE id = ?`, [id], (err, row) => {
            if (row) { try { fs.unlinkSync(path.join(__dirname, 'vat_in', row.link_pdf_lokal)); } catch (e) { } }
            db.run(`DELETE FROM inbox_vatin WHERE id = ?`, [id], () => io.emit('update-tabel-vatin'));
        });
    });

    socket.on('upload-pdf-vatout-batch', async (d) => {
        if (isDummy(socket)) {
            socket.emit('upload-batch-selesai', { modul: 'VAT OUT (DUMMY)', total: d.files?.length || 0, sukses: 0, duplikat: 0, gagal: 0 });
            return;
        }
        let files = d.files || [];
        if (!Array.isArray(files)) return;

        let entitas = d.entitas || 'BBS';
        let username = d.username || 'System';
        let sukses = 0, duplikat = 0, gagal = 0;

        for (let file of files) {
            // AUDIT FIX (M-08): Validasi ukuran dan tipe file
            if (!file.fileBuffer || file.fileBuffer.byteLength > 5 * 1024 * 1024) { gagal++; continue; }
            if (!file.teksPDF || typeof file.teksPDF !== 'string') { gagal++; continue; }
            try {
                const teks = file.teksPDF;
                let mNo = teks.match(/Kode dan Nomor Seri Faktur Pajak:\s*([\d\.\-]+)/i) || teks.match(/Kode dan Nomor Seri Faktur Pajak\s*:\s*([\d\.\-]+)/i);
                if (!mNo) { gagal++; continue; }

                let cleanNoFaktur = mNo[1].replace(/[\.\-]/g, '');
                let isDup = await checkDuplicateAsync('data_vatout', 'inbox_vatout', 'no_faktur', cleanNoFaktur);
                if (isDup) { duplikat++; continue; }

                const isLegacy = /^\d{3}\.\d{3}-\d{2}\./.test(mNo[1].trim());
                let mVen, mAlmVen, mNpwpVen, mPem, mAlmPem, mNpwpPem;

                if (isLegacy) {
                    const parts = teks.split(/Kode dan Nomor Seri Faktur Pajak/i);
                    const beforeNo = parts[0] || ""; const afterNo = parts[1] || "";
                    mPem = beforeNo.match(/Nama\s*:\s*(.*?)Alamat/i); mAlmPem = beforeNo.match(/Alamat\s*:\s*([\s\S]*?)NPWP\s*:/i); mNpwpPem = beforeNo.match(/NPWP\s*:\s*([\d\.\-]+)/i);
                    mVen = afterNo.match(/Nama\s*:\s*(.*?)Alamat/i); mAlmVen = afterNo.match(/Alamat\s*:\s*([\s\S]*?)NPWP\s*:/i); mNpwpVen = afterNo.match(/NPWP\s*:\s*([\d\.]+)/i);
                } else {
                    mVen = teks.match(/Pengusaha Kena Pajak[\s\S]*?Nama\s*:\s*(.*?)Alamat/i); mAlmVen = teks.match(/Pengusaha Kena Pajak[\s\S]*?Alamat\s*:\s*([\s\S]*?)NPWP\s*:/i); mNpwpVen = teks.match(/Pengusaha Kena Pajak[\s\S]*?NPWP\s*:\s*([\d\.\-]+)/i);
                    mPem = teks.match(/Pembeli Barang Kena Pajak[\s\S]*?Nama\s*:\s*(.*?)Alamat/i); mAlmPem = teks.match(/Pembeli Barang Kena Pajak[\s\S]*?Alamat\s*:\s*([\s\S]*?)NPWP\s*:/i); mNpwpPem = teks.match(/Pembeli Barang Kena Pajak[\s\S]*?NPWP\s*:\s*([\d\.\-]+)/i);
                }

                let mHargaJual = teks.match(/Harga Jual \/ Penggantian \/ Uang Muka \/ Termin\s+([\d\.,]+)/i) || teks.match(/Harga Jual \/ Penggantian\s+([\d\.,]+)/i);
                let mDPP = teks.match(/Dasar Pengenaan Pajak[^\d]*?((?:\d{1,3}\.)*\d{1,3},\d{2})/i) || teks.match(/Dasar Pengenaan Pajak\s+([\d\.,]+)/i);
                let mPPN = teks.match(/Jumlah PPN[^\d]*?((?:\d{1,3}\.)*\d{1,3},\d{2})/i) || teks.match(/Total PPN\s+([\d\.,]+)/i);
                let mDiskon = teks.match(/Dikurangi Potongan Harga\s+([\d\.,]+)/i);
                let mDP = teks.match(/Dikurangi Uang Muka yang telah diterima\s+([\d\.,]+)/i) || teks.match(/Dikurangi Uang Muka\s+([\d\.,]+)/i);
                let mTgl = teks.match(/([A-Za-z]{3,}(?:\s+[A-Za-z]+){0,2}),\s+(\d{1,2}\s+(?:Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+\d{4})/i);

                let namaClientSafe = sanitizeFilename(mPem?.[1]);
                let namaFileLokal = `arsip_vatout/${cleanNoFaktur}_${namaClientSafe}.pdf`;

                let data = {
                    noFaktur: cleanNoFaktur, namaVendor: mVen?.[1].trim(), alamatVendor: mAlmVen ? mAlmVen[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : "-", npwpVendor: mNpwpVen?.[1].trim(),
                    namaPembeli: mPem?.[1].trim(), alamatPembeli: mAlmPem ? mAlmPem[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : "-", npwpPembeli: mNpwpPem?.[1].trim(),
                    tanggalFaktur: mTgl ? formatTanggal(mTgl[2]) : "-", kotaPenerbit: mTgl ? mTgl[1].trim() : "-", format_tipe: isLegacy ? 'LEGACY' : 'MODERN',
                    referensi: isLegacy ? (teks.match(/(INVOICE\s*NO\.\s*:[\s\S]*?)(?=\s*PEMBERITAHUAN)/i)?.[1].trim().replace(/\s+/g, ' ') || "-") : (teks.match(/\(Referensi[\s:,]+([^)]+)\)/i)?.[1].trim() || "-"),
                    penandatangan: isLegacy ? (teks.match(/\d{4}[\s\n,]+([A-Z][A-Z\s\.]+?)(?=[\s\n]+INVOICE\s*NO\.)/i)?.[1].trim() || "-") : (teks.match(/Ditandatangani secara elektronik[\s\S]*?\n([^\n]+)\s*\n/i)?.[1].trim() || "-"),
                    hargaJual: bersihkanAngka(mHargaJual?.[1]), dpp: bersihkanAngka(mDPP?.[1]), ppn: bersihkanAngka(mPPN?.[1]),
                    diskon: bersihkanAngka(mDiskon?.[1]), uangMuka: bersihkanAngka(mDP?.[1]),
                    items: parseItems(teks), link_pdf_lokal: namaFileLokal, entitas: entitas
                };

                await fsPromises.writeFile(path.join(__dirname, 'vat_out', namaFileLokal), Buffer.from(file.fileBuffer));
                await dbRun(`INSERT INTO inbox_vatout (entitas, link_pdf_lokal, diinput_oleh, data_ekstraksi) VALUES (?, ?, ?, ?)`, [entitas, namaFileLokal, username, JSON.stringify(data)]);
                sukses++;
            } catch (e) { gagal++; }
        }
        insertAuditLog(socket.user.id, username, 'UPLOAD_BATCH', 'VAT OUT', `Upload batch VAT OUT sukses: ${sukses}`);
        socket.emit('upload-batch-selesai', { modul: 'VAT OUT', total: files.length, sukses, duplikat, gagal });
        io.emit('update-tabel-vatout');
    });

    socket.on('simpan-final-vatout', (d) => {
        if (isDummy(socket)) {
            socket.emit('simpan-final-sukses', { message: 'Mode Dummy: Verifikasi disimulasi.' });
            return io.emit('update-tabel-vatout');
        }
        let namaClientSafe = sanitizeFilename(d.namaPembeli);
        let namaFileFinal = `arsip_vatout/${d.branchInput}_${d.noFaktur}_${namaClientSafe}.pdf`;

        // AUDIT FIX (H-03): Simpan path lama & baru, rename SETELAH transaction sukses
        const sourcePath = path.join(__dirname, 'vat_out', d.link_pdf_lokal);
        const destPath = path.join(__dirname, 'vat_out', namaFileFinal);
        const fileExistsAtSource = fs.existsSync(sourcePath);
        const fileExistsAtDest = fs.existsSync(destPath);

        // Tentukan link_pdf_lokal yang akan disimpan di DB
        const linkPdfFinal = (fileExistsAtSource || fileExistsAtDest) ? namaFileFinal : d.link_pdf_lokal;

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run(`INSERT INTO data_vatout (no_faktur, entitas, kode_cabang, kode_vo, npwp_penjual, nama_penjual, alamat_penjual, npwp_pembeli, nama_pembeli, alamat_pembeli, tanggal_faktur, harga_jual, diskon, uang_muka, referensi, kota_penerbit, penandatangan, dpp, ppn, no_invoice_internal, tgl_tukar_faktur, diinput_oleh, link_pdf_lokal, format_tipe) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [d.noFaktur, d.entitas, d.branchInput, d.voInput || null, d.npwpVendor, d.namaVendor, d.alamatVendor, d.npwpPembeli, d.namaPembeli, d.alamatPembeli, d.tanggalFaktur, d.hargaJual, d.diskon, d.uangMuka, d.referensi, d.kotaPenerbit, d.penandatangan, d.dpp, d.ppn, d.invoiceInput, d.tglTukarInput, d.username, linkPdfFinal, d.format_tipe], function (err) {
                    if (err) { 
                        console.error("❌ DB Insert Error (data_vatout):", err.message); 
                        db.run("ROLLBACK"); 
                        // AUDIT FIX (H-02): Notifikasi error ke client
                        socket.emit('error-simpan', { message: 'Gagal menyimpan data VAT OUT: ' + err.message });
                        return; 
                    }

                    let stmt = db.prepare(`INSERT INTO item_vatout (no_faktur, nama_barang, harga_satuan, qty, satuan, diskon, total_harga) VALUES (?, ?, ?, ?, ?, ?, ?)`);
                    if (d.items && d.items.length > 0) d.items.forEach(it => stmt.run([d.noFaktur, it.nama_barang, it.harga_satuan, it.qty, it.satuan, it.diskon, it.total_harga]));
                    stmt.finalize();

                    db.run(`DELETE FROM inbox_vatout WHERE id = ?`, [d.id_link], (err) => {
                        if (err) { 
                            console.error("❌ DB Delete Error (inbox_vatout):", err.message); 
                            db.run("ROLLBACK"); 
                            // AUDIT FIX (H-02): Notifikasi error ke client
                            socket.emit('error-simpan', { message: 'Gagal menghapus inbox VAT OUT: ' + err.message });
                            return; 
                        }
                        db.run("COMMIT");

                        // AUDIT FIX (H-03): Rename file SETELAH transaction sukses
                        if (fileExistsAtSource && !fileExistsAtDest) {
                            try { fs.renameSync(sourcePath, destPath); } catch (renameErr) { console.error("Gagal rename PDF Vatout:", renameErr); }
                        }

                        // AUDIT FIX (H-01): Audit log untuk penyimpanan data VAT OUT
                        insertAuditLog(socket.user.id, d.username, 'SIMPAN', 'VAT OUT', `Menyimpan faktur VAT OUT: ${d.noFaktur} (${d.entitas})`);

                        io.emit('update-tabel-vatout'); io.emit('data-baru-vatout');
                    });
                });
        });
    });

    socket.on('hapus-inbox-vatout', (id) => {
        // BUG-B FIX: Dummy user tidak boleh menghapus file PDF asli
        if (isDummy(socket)) return io.emit('update-tabel-vatout');
        db.get(`SELECT link_pdf_lokal FROM inbox_vatout WHERE id = ?`, [id], (err, row) => {
            if (row) { try { fs.unlinkSync(path.join(__dirname, 'vat_out', row.link_pdf_lokal)); } catch (e) { } }
            db.run(`DELETE FROM inbox_vatout WHERE id = ?`, [id], () => io.emit('update-tabel-vatout'));
        });
    });

    // ==============================================================
    // BATCH UPLOADER: TAX PAYABLE (BPPU)
    // ==============================================================
    socket.on('upload-pdf-payable-batch', async (payload) => {
        if (isDummy(socket)) {
            return socket.emit('upload-batch-selesai', { modul: 'Tax Payable', total: payload.files.length, sukses: payload.files.length, duplikat: 0, gagal: 0 });
        }
        const { entitas, username, files } = payload;
        let sukses = 0, duplikat = 0, gagal = 0;

        for (let file of files) {
            try {
                const teks = file.teksPDF;
                let mNomor = teks.match(/([A-Z0-9]+)\s+(\d{2}-\d{4})\s+(FINAL|TIDAK FINAL)\s+NORMAL/i) || teks.match(/([A-Z0-9]+)\s+(\d{2}-\d{4})/i);
                if (!mNomor) { gagal++; continue; }

                let isDup = await checkDuplicateAsync('data_payable', 'inbox_payable', 'no_bppu', mNomor[1]);
                if (isDup) { duplikat++; continue; }

                let mNamaA = teks.match(/A\.2\s+NAMA\s*:\s*(.*?)A\.3/i);
                let mAngka = teks.match(/([\d\.,]+)\s+([\d\.,]+)\s+([\d\.,]+)\s+B\.8/i);
                let mJenisTgl = teks.match(/Jenis Dokumen\s*:\s*(.*?)\s+Tanggal\s*:\s*(.*?)\s+B\.9/i);
                let mNoDok = teks.match(/B\.9\s+Nomor Dokumen\s*:\s*(.*?)\s+B\.10/i);
                let mNPWP = teks.match(/A\.1\s+NPWP[\s\S]*?:\s*([0-9]+)/i);
                let mKode = teks.match(/([0-9]{2}-[0-9]{3}-[0-9]{2})/i);

                let data = {
                    noBppu: mNomor[1], masaPajak: mNomor[2], namaDipotong: mNamaA?.[1].trim(),
                    npwpLawan: mNPWP ? mNPWP[1] : "-", kodePajak: mKode ? mKode[1] : "-",
                    dpp: bersihkanAngka(mAngka?.[1]), pph: bersihkanAngka(mAngka?.[3]), tarif: parseFloat(mAngka?.[2] || 0),
                    jenisDokumen: mJenisTgl ? mJenisTgl[1].trim() : "-",
                    tanggalDokumen: mJenisTgl ? formatTanggal(mJenisTgl[2].trim()) : "-",
                    nomorDokumen: mNoDok ? mNoDok[1].trim() : "-", link_pdf_lokal: `arsip_payable/PAY_${mNomor[1]}.pdf`, entitas: entitas
                };

                await fsPromises.writeFile(path.join(__dirname, 'taxpayable_bppu', data.link_pdf_lokal), Buffer.from(file.fileBuffer));
                await dbRun(`INSERT INTO inbox_payable (entitas, link_pdf_lokal, diinput_oleh, data_ekstraksi) VALUES (?, ?, ?, ?)`, [entitas, data.link_pdf_lokal, username, JSON.stringify(data)]);
                sukses++;

            } catch (e) { gagal++; }
        }

        socket.emit('upload-batch-selesai', { modul: 'Tax Payable', total: files.length, sukses, duplikat, gagal });
        io.emit('update-tabel-payable');
    });

    socket.on('simpan-final-payable', (d) => {
        if (isDummy(socket)) {
            socket.emit('simpan-final-sukses', { message: 'Mode Dummy: Verifikasi disimulasi.' });
            return io.emit('update-tabel-payable');
        }
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run(`INSERT INTO data_payable (no_bppu, masa_pajak, entitas, kode_cabang, nama_dipotong, dpp, nilai_pph, tarif, tanggal_dokumen, nomor_dokumen, no_invoice_internal, diinput_oleh, link_pdf_lokal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [d.noBppu, d.masaPajak, d.entitas, d.branchInput, d.namaDipotong, d.dpp, d.pph, d.tarif, d.tanggalDokumen, d.nomorDokumen, d.invoiceInput, d.username, d.link_pdf_lokal], (err) => {
                    if (err) { 
                        console.error("❌ DB Insert Error (data_payable):", err.message); 
                        db.run("ROLLBACK"); 
                        // AUDIT FIX (H-02): Notifikasi error ke client
                        socket.emit('error-simpan', { message: 'Gagal menyimpan data Tax Payable: ' + err.message });
                        return; 
                    }
                    db.run(`DELETE FROM inbox_payable WHERE id = ?`, [d.id_link], (err) => {
                        if (err) { 
                            console.error("❌ DB Delete Error (inbox_payable):", err.message); 
                            db.run("ROLLBACK"); 
                            // AUDIT FIX (H-02): Notifikasi error ke client
                            socket.emit('error-simpan', { message: 'Gagal menghapus inbox Tax Payable: ' + err.message });
                            return; 
                        }
                        db.run("COMMIT");
                        // AUDIT FIX (H-01): Audit log untuk penyimpanan data Tax Payable
                        insertAuditLog(socket.user.id, d.username, 'SIMPAN', 'TAX PAYABLE', `Menyimpan BPPU: ${d.noBppu} (${d.entitas})`);
                        io.emit('update-tabel-payable'); io.emit('data-baru-payable');
                    });
                });
        });
    });

    socket.on('hapus-inbox-payable', (id) => {
        // BUG-C3 FIX: Dummy user tidak boleh menghapus file PDF asli
        if (isDummy(socket)) return io.emit('update-tabel-payable');
        db.get(`SELECT link_pdf_lokal FROM inbox_payable WHERE id = ?`, [id], (err, row) => {
            if (row) { try { fs.unlinkSync(path.join(__dirname, 'taxpayable_bppu', row.link_pdf_lokal)); } catch (e) { } }
            db.run(`DELETE FROM inbox_payable WHERE id = ?`, [id], () => io.emit('update-tabel-payable'));
        });
    });

    // ==============================================================
    // BATCH UPLOADER: PREPAID TAX (BPPU)
    // ==============================================================
    socket.on('upload-pdf-prepaid-batch', async (payload) => {
        if (isDummy(socket)) {
            return socket.emit('upload-batch-selesai', { modul: 'Prepaid Tax', total: payload.files.length, sukses: payload.files.length, duplikat: 0, gagal: 0 });
        }
        const { entitas, username, files } = payload;
        let sukses = 0, duplikat = 0, gagal = 0;

        for (let file of files) {
            try {
                const teks = file.teksPDF;
                let mNomor = teks.match(/([A-Z0-9]+)\s+(\d{2}-\d{4})\s+(FINAL|TIDAK FINAL)\s+NORMAL/i) || teks.match(/([A-Z0-9]+)\s+(\d{2}-\d{4})/i);
                if (!mNomor) { gagal++; continue; }

                let isDup = await checkDuplicateAsync('data_prepaid', 'inbox_prepaid', 'no_bppu', mNomor[1]);
                if (isDup) { duplikat++; continue; }

                let mNamaC = teks.match(/C\.3\s+NAMA PEMOTONG[\s\S]*?:\s*(.*?)C\.4/i);
                let mAngka = teks.match(/([\d\.,]+)\s+([\d\.,]+)\s+([\d\.,]+)\s+B\.8/i);
                let mJenisTgl = teks.match(/Jenis Dokumen\s*:\s*(.*?)\s+Tanggal\s*:\s*(.*?)\s+B\.9/i);
                let mNoDok = teks.match(/B\.9\s+Nomor Dokumen\s*:\s*(.*?)\s+B\.10/i);
                let mNPWP = teks.match(/C\.1\s+NPWP[\s\S]*?:\s*([0-9]+)/i);
                let mKode = teks.match(/([0-9]{2}-[0-9]{3}-[0-9]{2})/i);

                let data = {
                    noBppu: mNomor[1], masaPajak: mNomor[2], namaPemotong: mNamaC?.[1].trim(),
                    npwpLawan: mNPWP ? mNPWP[1] : "-", kodePajak: mKode ? mKode[1] : "-",
                    dpp: bersihkanAngka(mAngka?.[1]), pph: bersihkanAngka(mAngka?.[3]), tarif: parseFloat(mAngka?.[2] || 0),
                    jenisDokumen: mJenisTgl ? mJenisTgl[1].trim() : "-",
                    tanggalDokumen: mJenisTgl ? formatTanggal(mJenisTgl[2].trim()) : "-",
                    nomorDokumen: mNoDok ? mNoDok[1].trim() : "-", link_pdf_lokal: `arsip_prepaid/PRE_${mNomor[1]}.pdf`, entitas: entitas
                };

                await fsPromises.writeFile(path.join(__dirname, 'prepaidtax_bppu', data.link_pdf_lokal), Buffer.from(file.fileBuffer));
                await dbRun(`INSERT INTO inbox_prepaid (entitas, link_pdf_lokal, diinput_oleh, data_ekstraksi) VALUES (?, ?, ?, ?)`, [entitas, data.link_pdf_lokal, username, JSON.stringify(data)]);
                sukses++;

            } catch (e) { gagal++; }
        }

        socket.emit('upload-batch-selesai', { modul: 'Prepaid Tax', total: files.length, sukses, duplikat, gagal });
        io.emit('update-tabel-prepaid');
    });

    socket.on('simpan-final-prepaid', (d) => {
        if (isDummy(socket)) {
            socket.emit('simpan-final-sukses', { message: 'Mode Dummy: Verifikasi disimulasi.' });
            return io.emit('update-tabel-prepaid');
        }
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run(`INSERT INTO data_prepaid (no_bppu, masa_pajak, entitas, kode_cabang, nama_pemotong, dpp, nilai_pph, tarif, tanggal_dokumen, nomor_dokumen, no_invoice_internal, diinput_oleh, link_pdf_lokal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [d.noBppu, d.masaPajak, d.entitas, d.branchInput, d.namaPemotong, d.dpp, d.pph, d.tarif, d.tanggalDokumen, d.nomorDokumen, d.invoiceInput, d.username, d.link_pdf_lokal], (err) => {
                    if (err) { 
                        console.error("❌ DB Insert Error (data_prepaid):", err.message); 
                        db.run("ROLLBACK"); 
                        // AUDIT FIX (H-02): Notifikasi error ke client
                        socket.emit('error-simpan', { message: 'Gagal menyimpan data Prepaid Tax: ' + err.message });
                        return; 
                    }
                    db.run(`DELETE FROM inbox_prepaid WHERE id = ?`, [d.id_link], (err) => {
                        if (err) { 
                            console.error("❌ DB Delete Error (inbox_prepaid):", err.message); 
                            db.run("ROLLBACK"); 
                            // AUDIT FIX (H-02): Notifikasi error ke client
                            socket.emit('error-simpan', { message: 'Gagal menghapus inbox Prepaid Tax: ' + err.message });
                            return; 
                        }
                        db.run("COMMIT");
                        // AUDIT FIX (H-01): Audit log untuk penyimpanan data Prepaid Tax
                        insertAuditLog(socket.user.id, d.username, 'SIMPAN', 'PREPAID TAX', `Menyimpan BPPU: ${d.noBppu} (${d.entitas})`);
                        io.emit('update-tabel-prepaid'); io.emit('data-baru-prepaid');
                    });
                });
        });
    });

    socket.on('hapus-inbox-prepaid', (id) => {
        // BUG-C3 FIX: Dummy user tidak boleh menghapus file PDF asli
        if (isDummy(socket)) return io.emit('update-tabel-prepaid');
        db.get(`SELECT link_pdf_lokal FROM inbox_prepaid WHERE id = ?`, [id], (err, row) => {
            if (row) { try { fs.unlinkSync(path.join(__dirname, 'prepaidtax_bppu', row.link_pdf_lokal)); } catch (e) { } }
            db.run(`DELETE FROM inbox_prepaid WHERE id = ?`, [id], () => io.emit('update-tabel-prepaid'));
        });
    });

    // ==============================================================
    // LOGIKA PENYIMPANAN CLIENT LEDGER
    // ==============================================================
    socket.on('simpan-jurnal-ledger', (d) => {
        if (isDummy(socket)) return io.emit('data-baru-ledger');
        db.run(`INSERT INTO data_client_ledger (
            entitas, nama_client, inv_no, contract_income, discount, advance, retention,
            net_certificate, vat, gross_certificate, gross_paym_received, contract_debtor,
            gross_paym_rcpt, withholding_tax, bank_charge, net_receipt, remarks, diinput_oleh, ref_bppu, is_advance, ref_advance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                d.entitas, d.nama_client, d.inv_no, bersihkanAngka(d.contract_income), bersihkanAngka(d.discount),
                bersihkanAngka(d.advance), bersihkanAngka(d.retention), bersihkanAngka(d.net_certificate),
                bersihkanAngka(d.vat), bersihkanAngka(d.gross_certificate), bersihkanAngka(d.gross_paym_received),
                bersihkanAngka(d.contract_debtor), bersihkanAngka(d.gross_paym_rcpt), bersihkanAngka(d.wht),
                bersihkanAngka(d.bank_charge), bersihkanAngka(d.net_receipt), d.remarks, d.diinput_oleh, d.ref_bppu,
                d.is_advance ? 1 : 0, d.ref_advance || ''
            ], () => {
                io.emit('data-baru-ledger');
            });
    });

    socket.on('update-jurnal-ledger', (d) => {
        if (isDummy(socket)) return io.emit('data-baru-ledger');
        db.run(`UPDATE data_client_ledger SET 
            contract_income = ?, advance = ?, ref_advance = ?, 
            gross_paym_received = ?, contract_debtor = ?, gross_paym_rcpt = ?,
            withholding_tax = ?, bank_charge = ?, net_receipt = ?, remarks = ?, ref_bppu = ?
            WHERE id = ?`,
            [
                bersihkanAngka(d.contract_income), bersihkanAngka(d.advance), d.ref_advance || '',
                bersihkanAngka(d.gross_paym_received), bersihkanAngka(d.contract_debtor), bersihkanAngka(d.gross_paym_rcpt),
                bersihkanAngka(d.withholding_tax), bersihkanAngka(d.bank_charge), bersihkanAngka(d.net_receipt), d.remarks, d.ref_bppu,
                d.id
            ], () => {
                io.emit('data-baru-ledger');
            });
    });

    // FIX (C3): Handler untuk menghapus Client Ledger (sebelumnya tidak ada)
    socket.on('hapus-jurnal-ledger', (d) => {
        if (isDummy(socket)) return io.emit('data-baru-ledger');
        // Hanya supervisor/administrator yang boleh menghapus entry ledger
        if (!isSupervisorOrAbove(socket)) {
            return socket.emit('error-action', { message: 'Akses ditolak: Hanya Supervisor atau Administrator yang dapat menghapus jurnal ledger.' });
        }
        if (!d.id) return;
        db.run(`DELETE FROM data_client_ledger WHERE id = ?`, [d.id], function(err) {
            if (err) {
                console.error('Error deleting ledger entry:', err.message);
                return socket.emit('error-action', { message: 'Gagal menghapus data ledger.' });
            }
            if (this.changes === 0) return socket.emit('error-action', { message: 'Data ledger tidak ditemukan.' });
            insertAuditLog(socket.user.id, socket.user.username, 'HAPUS', 'CLIENT LEDGER', `Menghapus jurnal ledger ID: ${d.id}`);
            io.emit('data-baru-ledger');
        });
    });

    // --- MODUL ADMIN & PROSES REQUEST ---
    // SECURITY: Helper functions sudah dipindah ke atas (awal connection handler) pada BUG-C FIX
    // Baris lama dihapus untuk menghindari redeclaration error

    // ==============================================================
    // CRUD MASTER CABANG (Khusus Administrator)
    // ==============================================================
    socket.on('tambah-cabang', (d) => {
        if (isDummy(socket)) return io.emit('data-baru-cabang');
        if (!isAdministrator(socket)) {
            return socket.emit('error-cabang', 'Akses ditolak: Hanya Administrator yang dapat menambah data cabang.');
        }
        const { kode_cabang, nama_cabang, entitas, contract_income, user } = d;
        if (!kode_cabang || !nama_cabang || !entitas) {
            return socket.emit('error-cabang', 'Kode, Nama, dan Entitas wajib diisi.');
        }
        db.run(
            `INSERT INTO master_cabang (kode_cabang, nama_cabang, entitas, contract_income) VALUES (?, ?, ?, ?)`,
            [kode_cabang.trim().toUpperCase(), nama_cabang.trim(), entitas, bersihkanAngka(contract_income || 0)],
            function (err) {
                if (err) {
                    return socket.emit('error-cabang', err.code === 'SQLITE_CONSTRAINT' ? `Kode cabang '${kode_cabang}' sudah terdaftar!` : err.message);
                }
                insertAuditLog(socket.user.id, user, 'TAMBAH', 'MASTER CABANG', `Menambahkan cabang baru: ${kode_cabang} - ${nama_cabang}`);
                io.emit('data-baru-cabang');
            }
        );
    });

    socket.on('edit-cabang', (d) => {
        if (isDummy(socket)) return io.emit('data-baru-cabang');
        if (!isAdministrator(socket)) {
            return socket.emit('error-cabang', 'Akses ditolak: Hanya Administrator yang dapat mengedit data cabang.');
        }
        const { kode_cabang, nama_cabang, entitas, contract_income, user } = d;
        if (!kode_cabang || !nama_cabang || !entitas) {
            return socket.emit('error-cabang', 'Kode, Nama, dan Entitas wajib diisi.');
        }
        db.run(
            `UPDATE master_cabang SET nama_cabang = ?, entitas = ?, contract_income = ? WHERE kode_cabang = ?`,
            [nama_cabang.trim(), entitas, bersihkanAngka(contract_income || 0), kode_cabang],
            function (err) {
                if (err) return socket.emit('error-cabang', err.message);
                if (this.changes === 0) return socket.emit('error-cabang', `Cabang '${kode_cabang}' tidak ditemukan.`);
                insertAuditLog(socket.user.id, user, 'EDIT', 'MASTER CABANG', `Mengubah cabang ${kode_cabang} menjadi ${nama_cabang} (${entitas})`);
                io.emit('data-baru-cabang');
            }
        );
    });

    socket.on('hapus-cabang', (d) => {
        if (isDummy(socket)) return io.emit('data-baru-cabang');
        if (!isAdministrator(socket)) {
            return socket.emit('error-cabang', 'Akses ditolak: Hanya Administrator yang dapat menghapus data cabang.');
        }
        const { kode_cabang, user } = d;
        if (!kode_cabang || kode_cabang === 'PUSAT') {
            return socket.emit('error-cabang', 'Data cabang \'PUSAT\' tidak dapat dihapus (protected).');
        }
        db.run(`DELETE FROM master_cabang WHERE kode_cabang = ?`, [kode_cabang], function (err) {
            if (err) return socket.emit('error-cabang', err.message);
            if (this.changes === 0) return socket.emit('error-cabang', `Cabang '${kode_cabang}' tidak ditemukan.`);
            insertAuditLog(socket.user.id, user, 'HAPUS', 'MASTER CABANG', `Menghapus cabang ${kode_cabang}`);
            io.emit('data-baru-cabang');
        });
    });

    // ==============================================================
    // CRUD MASTER VO (Variation Order)
    // ==============================================================
    socket.on('tambah-vo', (d) => {
        if (isDummy(socket)) return io.emit('data-baru-vo');
        if (!isAdministrator(socket)) return socket.emit('error-vo', 'Akses ditolak.');
        const { kode_cabang, nama_vo, contract_income, user } = d;
        db.run(`INSERT INTO master_vo (kode_cabang, nama_vo, contract_income) VALUES (?, ?, ?)`,
            [kode_cabang, nama_vo.trim(), bersihkanAngka(contract_income || 0)], function (err) {
                if (err) return socket.emit('error-vo', err.message);
                insertAuditLog(socket.user.id, user, 'TAMBAH', 'MASTER VO', `Menambah VO untuk ${kode_cabang}: ${nama_vo}`);
                io.emit('data-baru-vo');
            });
    });

    socket.on('edit-vo', (d) => {
        if (isDummy(socket)) return io.emit('data-baru-vo');
        if (!isAdministrator(socket)) return socket.emit('error-vo', 'Akses ditolak.');
        const { id, nama_vo, contract_income, user } = d;
        db.run(`UPDATE master_vo SET nama_vo = ?, contract_income = ? WHERE id = ?`,
            [nama_vo.trim(), bersihkanAngka(contract_income || 0), id], function (err) {
                if (err) return socket.emit('error-vo', err.message);
                insertAuditLog(socket.user.id, user, 'EDIT', 'MASTER VO', `Mengubah VO ID: ${id}`);
                io.emit('data-baru-vo');
            });
    });

    socket.on('hapus-vo', (d) => {
        if (isDummy(socket)) return io.emit('data-baru-vo');
        if (!isAdministrator(socket)) return socket.emit('error-vo', 'Akses ditolak.');
        const { id, user } = d;
        db.run(`DELETE FROM master_vo WHERE id = ?`, [id], function (err) {
            if (err) return socket.emit('error-vo', err.message);
            insertAuditLog(socket.user.id, user, 'HAPUS', 'MASTER VO', `Menghapus VO ID: ${id}`);
            io.emit('data-baru-vo');
        });
    });

    // ==============================================================
    // CRUD MASTER KONTAK (CLIENT/VENDOR)
    // ==============================================================
    socket.on('tambah-kontak', (d) => {
        if (isDummy(socket)) return io.emit('data-baru-kontak');
        if (!isAdministrator(socket)) return socket.emit('error-kontak', 'Akses ditolak.');
        const t = d.tipe === 'vendor' ? 'master_vendor' : 'master_client';
        db.run(`INSERT INTO ${t} (npwp, nama, alamat) VALUES (?, ?, ?)`, [d.npwp, d.nama, d.alamat], function (err) {
            if (err) return socket.emit('error-kontak', err.message);
            insertAuditLog(socket.user.id, d.user, 'TAMBAH', `MASTER ${d.tipe.toUpperCase()}`, `Menambah ${d.tipe}: ${d.nama} (${d.npwp})`);
            io.emit('data-baru-kontak');
        });
    });

    socket.on('edit-kontak', (d) => {
        if (isDummy(socket)) return io.emit('data-baru-kontak');
        if (!isAdministrator(socket)) return socket.emit('error-kontak', 'Akses ditolak.');
        const t = d.tipe === 'vendor' ? 'master_vendor' : 'master_client';
        // NPWP sebagai primary key tidak diubah, kita ubah nama dan alamat
        db.run(`UPDATE ${t} SET nama = ?, alamat = ? WHERE npwp = ?`, [d.nama, d.alamat, d.npwp], function (err) {
            if (err) return socket.emit('error-kontak', err.message);
            insertAuditLog(socket.user.id, d.user, 'EDIT', `MASTER ${d.tipe.toUpperCase()}`, `Mengubah detail ${d.tipe}: ${d.npwp}`);
            io.emit('data-baru-kontak');
        });
    });

    socket.on('hapus-kontak', (d) => {
        if (isDummy(socket)) return io.emit('data-baru-kontak');
        if (!isAdministrator(socket)) return socket.emit('error-kontak', 'Akses ditolak.');
        const t = d.tipe === 'vendor' ? 'master_vendor' : 'master_client';
        db.run(`DELETE FROM ${t} WHERE npwp = ?`, [d.npwp], function (err) {
            if (err) return socket.emit('error-kontak', err.message);
            insertAuditLog(socket.user.id, d.user, 'HAPUS', `MASTER ${d.tipe.toUpperCase()}`, `Menghapus ${d.tipe} ber-NPWP: ${d.npwp}`);
            io.emit('data-baru-kontak');
        });
    });

    // ==============================================================
    // CRUD PROJECT MANAGEMENT
    // ==============================================================
    socket.on('tambah-proyek', (d) => {
        if (isDummy(socket)) return io.emit('project-updated');
        if (!isAdministrator(socket)) return socket.emit('error-proyek', 'Akses ditolak: Hanya Administrator yang dapat menambah proyek.');

        const { kode, nama, deskripsi, status, progress, tanggal_mulai, tanggal_selesai, pm, anggaran, user } = d;
        if (!kode || !nama) {
            return socket.emit('error-proyek', 'Kode dan Nama proyek wajib diisi.');
        }

        db.run(`INSERT INTO projects (kode, nama, deskripsi, status, progress, tanggal_mulai, tanggal_selesai, pm, anggaran, diinput_oleh) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [kode, nama, deskripsi, status, progress, tanggal_mulai, tanggal_selesai, pm, anggaran, user], function (err) {
                if (err) {
                    return socket.emit('error-proyek', err.code === 'SQLITE_CONSTRAINT' ? `Kode proyek '${kode}' sudah terdaftar!` : err.message);
                }
                insertAuditLog(socket.user.id, user, 'TAMBAH', 'PROJECT MANAGEMENT', `Menambahkan proyek baru: ${kode} - ${nama}`);
                io.emit('project-updated');
            });
    });

    socket.on('edit-proyek', (d) => {
        if (isDummy(socket)) return io.emit('project-updated');
        if (!isAdministrator(socket)) {
            return socket.emit('error-proyek', 'Akses ditolak: Hanya Administrator yang dapat mengedit proyek.');
        }

        const { id, kode, nama, deskripsi, status, progress, tanggal_mulai, tanggal_selesai, pm, anggaran, user } = d;
        if (!kode || !nama) {
            return socket.emit('error-proyek', 'Kode dan Nama proyek wajib diisi.');
        }

        db.run(`UPDATE projects SET kode = ?, nama = ?, deskripsi = ?, status = ?, progress = ?, tanggal_mulai = ?, tanggal_selesai = ?, pm = ?, anggaran = ? WHERE id = ?`,
            [kode, nama, deskripsi, status, progress, tanggal_mulai, tanggal_selesai, pm, anggaran, id], function (err) {
                if (err) return socket.emit('error-proyek', err.message);
                if (this.changes === 0) return socket.emit('error-proyek', `Proyek dengan ID '${id}' tidak ditemukan.`);
                insertAuditLog(socket.user.id, user, 'EDIT', 'PROJECT MANAGEMENT', `Mengubah proyek ${kode} menjadi ${nama}`);
                io.emit('project-updated');
            });
    });

    socket.on('hapus-proyek', (d) => {
        if (isDummy(socket)) return io.emit('project-updated');
        if (!isAdministrator(socket)) {
            return socket.emit('error-proyek', 'Akses ditolak: Hanya Administrator yang dapat menghapus proyek.');
        }

        const { id, user } = d;
        // Get project info for audit log
        db.get(`SELECT kode, nama FROM projects WHERE id = ?`, [id], (err, project) => {
            if (err) return socket.emit('error-proyek', err.message);
            if (!project) return socket.emit('error-proyek', `Proyek dengan ID '${id}' tidak ditemukan.`);

            db.run(`DELETE FROM projects WHERE id = ?`, [id], function (err) {
                if (err) return socket.emit('error-proyek', err.message);
                insertAuditLog(socket.user.id, user, 'HAPUS', 'PROJECT MANAGEMENT', `Menghapus proyek ${project.kode} - ${project.nama}`);
                io.emit('project-updated');
            });
        });
    });

    socket.on('tambah-user', (d) => {
        if (isDummy(socket)) return io.emit('users-updated');
        // SECURITY: Hanya administrator yang boleh tambah user
        if (!isAdministrator(socket)) {
            return socket.emit('error-action', { message: 'Akses ditolak: Hanya Administrator yang dapat menambah pengguna.' });
        }
        db.run(`INSERT INTO users (username, password, nama_lengkap, role) VALUES (?, ?, ?, ?)`, [d.username, bcrypt.hashSync(d.password, 12), d.nama, d.role], () => {
            insertAuditLog(socket.user.id, socket.user.username, 'TAMBAH', 'USER MANAGEMENT', `Menambahkan user baru: ${d.username} (${d.role})`);
            io.emit('users-updated');
        });
    });
    socket.on('reset-password-user', (d) => {
        if (isDummy(socket)) return io.emit('users-updated');
        const isSelf = (d.user_id === socket.user.id);
        const canSelfChange = isSupervisorOrAbove(socket) && isSelf;
        const canResetOther = isAdministrator(socket) && !isSelf;

        if (!canSelfChange && !canResetOther) {
            return socket.emit('error-action', { message: 'Akses ditolak: Hanya Administrator yang dapat mereset password orang lain.' });
        }
        if (!d.new_password || d.new_password.length < 6) {
            return socket.emit('error-action', { message: 'Password baru minimal 6 karakter.' });
        }
        db.run(`UPDATE users SET password = ? WHERE id = ?`, [bcrypt.hashSync(d.new_password, 12), d.user_id], () => {
            const logDetail = isSelf
                ? `${socket.user.role} '${socket.user.username}' mereset password sendiri`
                : `Administrator mereset password untuk user ID: ${d.user_id}`;
            insertAuditLog(socket.user.id, socket.user.username, 'EDIT', 'USER MANAGEMENT', logDetail);
            io.emit('users-updated');
        });
    });

    // UPDATE NAMA SENDIRI: Supervisor & Administrator bisa langsung ubah nama sendiri (tanpa approval)
    socket.on('admin-update-nama', (d) => {
        if (isDummy(socket)) return io.emit('users-updated');
        // Hanya boleh mengubah nama diri sendiri
        if (!isSupervisorOrAbove(socket) || d.user_id !== socket.user.id) {
            return socket.emit('error-action', { message: 'Akses ditolak: Anda hanya dapat mengubah nama Anda sendiri.' });
        }
        if (!d.nilai_baru || d.nilai_baru.trim() === '') {
            return socket.emit('error-action', { message: 'Nama baru tidak boleh kosong.' });
        }
        db.run(`UPDATE users SET nama_lengkap = ? WHERE id = ?`, [d.nilai_baru.trim(), d.user_id], () => {
            insertAuditLog(socket.user.id, socket.user.username, 'EDIT', 'USER MANAGEMENT',
                `${socket.user.role} '${socket.user.username}' mengubah nama sendiri menjadi: ${d.nilai_baru.trim()}`);
            io.emit('users-updated');
        });
    });

    socket.on('ajukan-perubahan', (d) => {
        if (isDummy(socket)) return socket.emit('request-updated', { message: 'Mode Dummy: Pengajuan disimulasi.' });
        // SECURITY: Supervisor & Administrator tidak perlu lewat antrian approval - langsung bisa ubah
        // Event ini hanya untuk role user/input biasa
        if (isSupervisorOrAbove(socket)) {
            return socket.emit('error-action', { message: 'Supervisor/Administrator tidak perlu mengajukan perubahan - gunakan tombol Simpan Perubahan.' });
        }
        if (d.jenis === 'NAMA') {
            db.get(`SELECT nama_lengkap FROM users WHERE id = ?`, [d.id_user], (err, row) => {
                let val = JSON.stringify({ old: row ? row.nama_lengkap : '-', new: d.nilai_baru });
                db.run(`INSERT INTO user_requests (user_id, username, jenis_request, nilai_baru) VALUES (?, ?, ?, ?)`, [d.id_user, d.username, d.jenis, val], () => io.emit('request-updated'));
            });
        } else {
            let val = d.jenis === 'PASSWORD' ? bcrypt.hashSync(d.nilai_baru, 12) : d.nilai_baru;
            db.run(`INSERT INTO user_requests (user_id, username, jenis_request, nilai_baru) VALUES (?, ?, ?, ?)`, [d.id_user, d.username, d.jenis, val], () => io.emit('request-updated'));
        }
    });

    socket.on('proses-request', (d) => {
        if (isDummy(socket)) return io.emit('request-updated');
        // SECURITY: Hanya supervisor/administrator yang dapat memproses request approval
        if (!isSupervisorOrAbove(socket)) {
            return socket.emit('error-action', { message: 'Akses ditolak: Hanya Supervisor atau Administrator yang dapat memproses permintaan.' });
        }
        db.get(`SELECT * FROM user_requests WHERE id = ?`, [d.req_id], (err, req) => {
            if (!req) return;

            if (d.action === 'Setuju') {
                if (req.jenis_request === 'NAMA' || req.jenis_request === 'PASSWORD') {
                    let col = req.jenis_request === 'NAMA' ? 'nama_lengkap' : 'password';
                    let valueToSave = req.nilai_baru;
                    if (req.jenis_request === 'NAMA' && req.nilai_baru.startsWith('{')) {
                        try {
                            const parsed = JSON.parse(req.nilai_baru);
                            valueToSave = parsed.new;
                        } catch(e) {}
                    }
                    db.run(`UPDATE users SET ${col} = ? WHERE id = ?`, [valueToSave, req.user_id], () => {
                        db.run(`UPDATE user_requests SET status = 'Disetujui' WHERE id = ?`, [d.req_id], () => io.emit('request-updated'));
                    });
                }
                else if (req.jenis_request.startsWith('HAPUS_')) {
                    let targetMod = req.jenis_request.split('_')[1].toLowerCase();
                    // SECURITY FIX (C2): Validasi targetMod terhadap whitelist
                    const VALID_MODS = ['vatin', 'vatout', 'payable', 'prepaid'];
                    if (!VALID_MODS.includes(targetMod)) {
                        db.run(`UPDATE user_requests SET status = 'Ditolak' WHERE id = ?`, [d.req_id], () => io.emit('request-updated'));
                        return;
                    }
                    let isBPPU = (targetMod === 'payable' || targetMod === 'prepaid');
                    let colKey = isBPPU ? 'no_bppu' : 'no_faktur';

                    db.run(`DELETE FROM data_${targetMod} WHERE ${colKey} = ?`, [req.nilai_baru], () => {
                        if (!isBPPU) {
                            db.run(`DELETE FROM item_${targetMod} WHERE no_faktur = ?`, [req.nilai_baru], () => {
                                db.run(`UPDATE user_requests SET status = 'Disetujui' WHERE id = ?`, [d.req_id], () => {
                                    io.emit('request-updated'); io.emit(`data-baru-${targetMod}`);
                                });
                            });
                        } else {
                            db.run(`UPDATE user_requests SET status = 'Disetujui' WHERE id = ?`, [d.req_id], () => {
                                io.emit('request-updated'); io.emit(`data-baru-${targetMod}`);
                            });
                        }
                    });
                }
                else if (req.jenis_request.startsWith('EDIT_')) {
                    let targetMod = req.jenis_request.split('_')[1].toLowerCase();
                    // SECURITY FIX (C2): Validasi targetMod terhadap whitelist
                    const VALID_MODS = ['vatin', 'vatout', 'payable', 'prepaid'];
                    if (!VALID_MODS.includes(targetMod)) {
                        db.run(`UPDATE user_requests SET status = 'Ditolak' WHERE id = ?`, [d.req_id], () => io.emit('request-updated'));
                        return;
                    }
                    let isBPPU = (targetMod === 'payable' || targetMod === 'prepaid');
                    let val = JSON.parse(req.nilai_baru);
                    
                    // Handle both old format (flat) and new format (nested old/new)
                    let v = val.new || val;

                    if (isBPPU) {
                        db.run(`UPDATE data_${targetMod} SET kode_cabang = ?, no_invoice_internal = ? WHERE no_bppu = ?`,
                            [v.branch, v.invoice, v.faktur], () => {
                                db.run(`UPDATE user_requests SET status = 'Disetujui' WHERE id = ?`, [d.req_id], () => {
                                    io.emit('request-updated'); io.emit(`data-baru-${targetMod}`);
                                });
                            });
                    } else {
                        let sql = `UPDATE data_${targetMod} SET kode_cabang = ?, no_invoice_internal = ?, tgl_tukar_faktur = ?`;
                        let params = [v.branch, v.invoice, v.tanggal];
                        if(targetMod === 'vatout' && v.vo) {
                            sql += `, kode_vo = ?`;
                            params.push(v.vo);
                        }
                        sql += ` WHERE no_faktur = ?`;
                        params.push(v.faktur);
                        db.run(sql, params, () => {
                            db.run(`UPDATE user_requests SET status = 'Disetujui' WHERE id = ?`, [d.req_id], () => {
                                io.emit('request-updated'); io.emit(`data-baru-${targetMod}`);
                            });
                        });
                    }
                }
            } else {
                db.run(`UPDATE user_requests SET status = 'Ditolak' WHERE id = ?`, [d.req_id], () => io.emit('request-updated'));
            }
        });
    });

});

http.listen(PORT, '0.0.0.0', () => console.log(`Tax Database by Rendi Siagian berjalan di Port ${PORT}`));

// FIX (W8): Graceful shutdown — tutup koneksi database saat proses dihentikan
process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Menutup koneksi database...');
    db.close((err) => {
        if (err) console.error('Error closing database:', err.message);
        else console.log('[SHUTDOWN] Database ditutup dengan aman.');
        process.exit(0);
    });
});
process.on('SIGTERM', () => {
    console.log('[SHUTDOWN] SIGTERM diterima, menutup server...');
    db.close((err) => {
        if (err) console.error('Error closing database:', err.message);
        process.exit(0);
    });
});