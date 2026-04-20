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

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    console.error('\x1b[31m[SECURITY ERROR] SESSION_SECRET tidak ditemukan di file .env! Server dihentikan.\x1b[0m');
    process.exit(1);
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
app.use((req, res, next) => {
    if (req.path.match(/\.db$/i)) {
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 86400000,       // 24 jam
        httpOnly: true,         // SECURITY: Cegah akses cookie dari JavaScript (BUG-09)
        sameSite: 'strict'      // SECURITY: Cegah CSRF
    }
});
app.use(sessionMiddleware);

// SECURITY: Rate Limiting untuk endpoint login (anti brute-force)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 20,                   // Maksimal 20 percobaan login per 15 menit
    message: '<script>alert("Terlalu banyak percobaan login. Coba lagi dalam 15 menit."); window.location.href=\'/login\';</script>',
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

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, nama_lengkap TEXT, role TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS user_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, jenis_request TEXT, nilai_baru TEXT, status TEXT DEFAULT 'Pending', waktu DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS master_cabang (kode_cabang TEXT PRIMARY KEY, nama_cabang TEXT, entitas TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS master_vendor (npwp TEXT PRIMARY KEY, nama TEXT, alamat TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS master_client (npwp TEXT PRIMARY KEY, nama TEXT, alamat TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, action TEXT, module TEXT, details TEXT, waktu DATETIME DEFAULT CURRENT_TIMESTAMP)`);

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

    modules.forEach(mod => {
        db.run(`CREATE TABLE IF NOT EXISTS inbox_${mod.id} (id INTEGER PRIMARY KEY AUTOINCREMENT, entitas TEXT, link_pdf_lokal TEXT, status TEXT DEFAULT 'Menunggu Lengkapi', diinput_oleh TEXT, data_ekstraksi TEXT, waktu DATETIME DEFAULT CURRENT_TIMESTAMP)`);

        if (mod.id.startsWith('vat')) {
            db.run(`CREATE TABLE IF NOT EXISTS data_${mod.id} (no_faktur TEXT PRIMARY KEY, entitas TEXT, kode_cabang TEXT, npwp_penjual TEXT, nama_penjual TEXT, alamat_penjual TEXT, npwp_pembeli TEXT, nama_pembeli TEXT, alamat_pembeli TEXT, tanggal_faktur DATE, harga_jual REAL, diskon REAL, uang_muka REAL, dpp REAL, ppn REAL, referensi TEXT, kota_penerbit TEXT, penandatangan TEXT, no_invoice_internal TEXT, tgl_tukar_faktur DATE, diinput_oleh TEXT, link_pdf_lokal TEXT, waktu_input DATETIME DEFAULT CURRENT_TIMESTAMP)`);
            const alterCols = ['alamat_penjual TEXT', 'alamat_pembeli TEXT', 'diskon REAL', 'uang_muka REAL', 'kota_penerbit TEXT', 'penandatangan TEXT', 'harga_jual REAL'];
            alterCols.forEach(col => { db.run(`ALTER TABLE data_${mod.id} ADD COLUMN ${col}`, () => { }); });
            db.run(`CREATE TABLE IF NOT EXISTS item_${mod.id} (id INTEGER PRIMARY KEY AUTOINCREMENT, no_faktur TEXT, nama_barang TEXT, harga_satuan REAL, qty REAL, satuan TEXT, diskon REAL, total_harga REAL)`);
        } else {
            db.run(`CREATE TABLE IF NOT EXISTS data_${mod.id} (no_bppu TEXT PRIMARY KEY, masa_pajak TEXT, entitas TEXT, kode_cabang TEXT, npwp_pemotong TEXT, nama_pemotong TEXT, npwp_dipotong TEXT, nama_dipotong TEXT, dpp REAL, tarif REAL, nilai_pph REAL, tanggal_dokumen DATE, nomor_dokumen TEXT, no_invoice_internal TEXT, diinput_oleh TEXT, link_pdf_lokal TEXT, waktu_input DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        }
    });
});

// ==========================================
// 3. ROUTING & API
// ==========================================
const cekAuth = (req, res, next) => { if (req.session.user) return next(); res.redirect('/login'); };
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/sidebar.html', cekAuth, (req, res) => {
    const sidebarPath = path.join(__dirname, 'sidebar.html');
    fs.readFile(sidebarPath, 'utf8', (err, html) => {
        if (err) return res.status(500).send('');
        // Jika user adalah administrator, tampilkan menu administrasi
        const role = (req.session && req.session.user && req.session.user.role) ? req.session.user.role.toLowerCase() : '';
        const isAdmin = ['administrator', 'superadmin'].includes(role);
        if (isAdmin) {
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
app.get('/summary', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'summary.html')));
app.get('/manage-users', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'manage_users.html')));
app.get('/master-cabang', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'master_cabang.html')));
app.get('/master-kontak', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'master_kontak.html')));
app.get('/audit-logs', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'audit_logs.html')));
app.get('/', (req, res) => req.session.user ? res.redirect('/dashboard-utama') : res.redirect('/login'));
app.get('/dashboard-utama', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'dashboard_utama.html')));
app.get('/client-ledger', cekAuth, (req, res) => res.sendFile(path.join(__dirname, 'accounting', 'client_ledger.html')));

// Static middleware ditempatkan setelah rute HTML agar route kustom (seperti /sidebar.html) dapat tereksekusi
app.use(express.static(__dirname));

// API: MASTER CABANG - Semua data tanpa filter entitas (untuk halaman admin)
app.get('/api/master-cabang-all', cekAuth, (req, res) => {
    db.all(`SELECT * FROM master_cabang ORDER BY entitas, kode_cabang`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.get('/api/master-kontak-all', cekAuth, (req, res) => {
    db.all(`SELECT * FROM master_client ORDER BY nama`, (err, rowsClient) => {
        db.all(`SELECT * FROM master_vendor ORDER BY nama`, (err, rowsVendor) => {
            res.json({ clients: rowsClient || [], vendors: rowsVendor || [] });
        });
    });
});

app.get('/api/audit-logs', cekAuth, (req, res) => {
    db.all(`SELECT *, strftime('%d-%m-%Y %H:%M:%S', waktu, 'localtime') as wkt FROM audit_logs ORDER BY id DESC LIMIT 500`, (err, rows) => res.json(rows || []));
});

app.get('/api/items/:mod/:faktur', cekAuth, (req, res) => {
    db.all(`SELECT * FROM item_${req.params.mod} WHERE no_faktur = ?`, [req.params.faktur], (err, rows) => res.json(rows || []));
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

            // Agregasi nilai Harga Jual dan PPN dari semua faktur yang ditemukan
            const aggregated = rows.reduce((acc, r) => {
                acc.dpp += (r.harga_jual || 0); // Menggunakan harga_jual sebagai pembanding DPP
                acc.ppn += (r.ppn || 0);
                return acc;
            }, { dpp: 0, ppn: 0 });

            // Kirim balik sebagai objek vatout tunggal agar UI tetap kompatibel
            res.json({
                prepaid,
                vatout: {
                    dpp: aggregated.dpp,
                    ppn: aggregated.ppn,
                    is_aggregated: rows.length > 1,
                    count: rows.length
                }
            });
        });
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
                // Prevent SQL Injection by ensuring col only contains word characters and dots
                if (/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(col) && searchParams[col] && searchParams[col].trim() !== '') {
                    baseSql += ` AND ${col} LIKE ?`;
                    params.push(`%${searchParams[col].trim()}%`);
                }
            }
        } catch (e) { }
    }

    const statsSql = `SELECT SUM(contract_income) as total_income, SUM(net_receipt) as total_receipt, SUM(contract_debtor) as total_debtor ${baseSql}`;
    // BUG-03 FIX: Simpan salinan params SEBELUM push LIMIT/OFFSET agar statsSql tidak terkontaminasi
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
    app.get(`/inbox-${mod.id}`, cekAuth, (req, res) => res.sendFile(path.join(__dirname, mod.path, `inbox_${mod.id}.html`)));

    // --- SERVER-SIDE DATATABLES ENGINE ---
    app.get(`/api/data-${mod.id}`, cekAuth, (req, res) => {
        const entitas = req.query.entitas || 'BBS';
        const page = parseInt(req.query.page) || 1;
        const limit = req.query.limit === 'all' ? null : (parseInt(req.query.limit) || 50);

        let baseSql = mod.id.startsWith('vat')
            ? `FROM data_${mod.id} d LEFT JOIN master_cabang c ON d.kode_cabang = c.kode_cabang WHERE d.entitas = ?`
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
                    // Prevent SQL Injection by validating col name format
                    if (/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(col) && searchParams[col] && searchParams[col].trim() !== '') {
                        baseSql += ` AND ${col} LIKE ?`;
                        params.push(`%${searchParams[col].trim()}%`);
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

            let selectSql = mod.id.startsWith('vat')
                ? `SELECT d.*, c.nama_cabang, strftime('%d-%m-%Y', d.tanggal_faktur) AS tanggal_format, strftime('%d-%m-%Y', d.tgl_tukar_faktur) AS tgl_tukar_format ${baseSql} ORDER BY CAST(SUBSTR(d.no_invoice_internal, 1, MAX(1, INSTR(d.no_invoice_internal, '/') - 1)) AS INTEGER) ASC, d.waktu_input DESC`
                : `SELECT d.*, c.nama_cabang, strftime('%d-%m-%Y', d.tanggal_dokumen) AS tgl_dokumen_format ${baseSql} ORDER BY d.waktu_input DESC`;

            if (limit) {
                selectSql += ` LIMIT ? OFFSET ?`;
                params.push(limit, (page - 1) * limit);
            }

            db.all(selectSql, params, (err2, rows) => {
                res.json({ data: rows || [], total, page, limit: limit || total });
            });
        });
    });

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

        if (search) {
            baseSql += ` AND (data_ekstraksi LIKE ? OR diinput_oleh LIKE ?)`;
            const s = '%' + search + '%';
            params.push(s, s);
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
        return res.send(`<script>alert('Username dan password wajib diisi!'); window.location.href='/login';</script>`);
    }
    db.get(`SELECT * FROM users WHERE username = ?`, [req.body.username], (err, user) => {
        if (user && bcrypt.compareSync(req.body.password, user.password)) {
            req.session.user = { id: user.id, username: user.username, nama: user.nama_lengkap, role: user.role };
            res.redirect('/dashboard-utama');
        } else {
            // SECURITY: Pesan error generik agar tidak mengungkap apakah username ada atau tidak
            res.send(`<script>alert('Username atau password salah!'); window.location.href='/login';</script>`);
        }
    });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/api/me', cekAuth, (req, res) => res.json(req.session.user));
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
        vatin_inbox: `SELECT COUNT(*) as jml FROM inbox_vatin WHERE entitas = ?`,
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

    const sqlTTF = `SELECT strftime('%m-%Y', tgl_tukar_faktur) as periode, count(*) as jml, sum(ppn) as total_ppn FROM data_vatin WHERE entitas = ? AND tgl_tukar_faktur IS NOT NULL AND tgl_tukar_faktur != '' AND tgl_tukar_faktur != '-' GROUP BY periode`;
    const sqlFaktur = `SELECT strftime('%m-%Y', tanggal_faktur) as periode, count(*) as jml, sum(ppn) as total_ppn FROM data_vatin WHERE entitas = ? GROUP BY periode`;

    db.all(sqlTTF, [ent], (err1, ttfRows) => {
        db.all(sqlFaktur, [ent], (err2, fakturRows) => {
            const periodeSet = new Set();
            const ttfMap = {};
            const fakturMap = {};

            (ttfRows || []).forEach(r => { periodeSet.add(r.periode); ttfMap[r.periode] = r; });
            (fakturRows || []).forEach(r => { periodeSet.add(r.periode); fakturMap[r.periode] = r; });

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
                    waktu_input: adv.waktu_input,
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
// ==========================================
// SECURITY: Middleware autentikasi Socket.IO (BUG-06)
// Semua koneksi Socket.IO wajib memiliki session user yang valid
// ==========================================
io.use((socket, next) => {
    const session = socket.request.session;
    if (session && session.user) {
        socket.user = session.user; // Attach user info ke socket untuk digunakan di event handlers
        return next();
    }
    next(new Error('Unauthorized: Silakan login terlebih dahulu.'));
});

io.on('connection', (socket) => {

    // SECURITY: Helper functions didefinisikan di ATAS agar tidak terjadi ReferenceError
    // 'const' tidak di-hoist, jadi harus didefinisikan sebelum digunakan (BUG-C FIX)
    const isAdministrator = (socket) => ['administrator', 'superadmin'].includes((socket.user && socket.user.role || '').toLowerCase());
    const isSupervisorOrAbove = (socket) => ['supervisor', 'administrator', 'superadmin'].includes((socket.user && socket.user.role || '').toLowerCase());
    const isDummy = (socket) => (socket.user && socket.user.role || '').toLowerCase() === 'dummy';

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
        const isSupervisor = ['supervisor', 'administrator'].includes(d.role.toLowerCase());
        const isBPPU = (d.mod === 'payable' || d.mod === 'prepaid');
        const pkColumn = isBPPU ? 'no_bppu' : 'no_faktur';

        if (d.action === 'DELETE') {
            if (isSupervisor) {
                db.serialize(() => {
                    db.run(`DELETE FROM data_${d.mod} WHERE ${pkColumn} = ?`, [d.faktur]);
                    if (!isBPPU) {
                        db.run(`DELETE FROM item_${d.mod} WHERE no_faktur = ?`, [d.faktur]);
                    }
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
                    db.run(`UPDATE data_${d.mod} SET kode_cabang = ?, no_invoice_internal = ?, tgl_tukar_faktur = ? WHERE no_faktur = ?`,
                        [d.newData.branch, d.newData.invoice, d.newData.tanggal, d.faktur], () => { io.emit(`data-baru-${d.mod}`); });
                }
            } else {
                let requestValue = JSON.stringify({ faktur: d.faktur, branch: d.newData.branch, invoice: d.newData.invoice, tanggal: d.newData.tanggal });
                db.run(`INSERT INTO user_requests (user_id, username, jenis_request, nilai_baru) VALUES (?, ?, ?, ?)`,
                    [d.id_user, d.username, `EDIT_${d.mod.toUpperCase()}`, requestValue], () => io.emit('request-updated'));
            }
        }
    });

    socket.on('upload-pdf-vatin-batch', async (payload) => {
        if (isDummy(socket)) {
            return socket.emit('upload-batch-selesai', { modul: 'VAT IN', total: payload.files.length, sukses: payload.files.length, duplikat: 0, gagal: 0 });
        }
        const { entitas, username, files } = payload;
        let sukses = 0, duplikat = 0, gagal = 0;

        for (let file of files) {
            try {
                const teks = file.teksPDF;
                let mNo = teks.match(/Kode dan Nomor Seri Faktur Pajak:\s*([\d]+)/i);
                if (!mNo) { gagal++; continue; }

                let isDup = await checkDuplicateAsync('data_vatin', 'inbox_vatin', 'no_faktur', mNo[1]);
                if (isDup) { duplikat++; continue; }

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
                let namaFileLokal = `arsip_vatin/${mNo[1]}_${namaVendorSafe}.pdf`;

                let data = {
                    noFaktur: mNo[1],
                    namaVendor: mVen?.[1].trim(), alamatVendor: mAlmVen ? mAlmVen[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : "-", npwpVendor: mNpwpVen?.[1].trim(),
                    namaPembeli: mPem?.[1].trim(), alamatPembeli: mAlmPem ? mAlmPem[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : "-", npwpPembeli: mNpwpPem?.[1].trim(),
                    tanggalFaktur: mTgl ? formatTanggal(mTgl[2]) : "-", kotaPenerbit: mTgl ? mTgl[1].trim() : "-",
                    referensi: mRef ? mRef[1].trim() : "-", penandatangan: mTTD ? mTTD[1].trim() : "-",
                    hargaJual: bersihkanAngka(mHargaJual?.[1]), dpp: bersihkanAngka(mDPP?.[1]), ppn: bersihkanAngka(mPPN?.[1]),
                    diskon: bersihkanAngka(mDiskon?.[1]), uangMuka: bersihkanAngka(mDP?.[1]),
                    items: parseItems(teks), link_pdf_lokal: namaFileLokal, entitas: entitas
                };

                if (data.npwpVendor) {
                    await dbRun(`INSERT OR REPLACE INTO master_vendor (npwp, nama, alamat) VALUES (?, ?, ?)`, [data.npwpVendor, data.namaVendor, data.alamatVendor]);
                }

                await fsPromises.writeFile(path.join(__dirname, 'vat_in', namaFileLokal), Buffer.from(file.fileBuffer));
                await dbRun(`INSERT INTO inbox_vatin (entitas, link_pdf_lokal, diinput_oleh, data_ekstraksi) VALUES (?, ?, ?, ?)`, [entitas, namaFileLokal, username, JSON.stringify(data)]);
                sukses++;

            } catch (e) { gagal++; }
        }

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

        try {
            fs.renameSync(path.join(__dirname, 'vat_in', d.link_pdf_lokal), path.join(__dirname, 'vat_in', namaFileFinal));
            d.link_pdf_lokal = namaFileFinal;
        } catch (err) { console.error("Gagal rename PDF Vatin:", err); }

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run(`INSERT INTO data_vatin (no_faktur, entitas, kode_cabang, npwp_penjual, nama_penjual, alamat_penjual, npwp_pembeli, nama_pembeli, alamat_pembeli, tanggal_faktur, harga_jual, diskon, uang_muka, referensi, kota_penerbit, penandatangan, dpp, ppn, no_invoice_internal, tgl_tukar_faktur, diinput_oleh, link_pdf_lokal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [d.noFaktur, d.entitas, d.branchInput, d.npwpVendor, d.namaVendor, d.alamatVendor, d.npwpPembeli, d.namaPembeli, d.alamatPembeli, d.tanggalFaktur, d.hargaJual, d.diskon, d.uangMuka, d.referensi, d.kotaPenerbit, d.penandatangan, d.dpp, d.ppn, d.invoiceInput, d.tglTukarInput, d.username, d.link_pdf_lokal], function (err) {
                    if (err) { db.run("ROLLBACK"); return; }

                    let stmt = db.prepare(`INSERT INTO item_vatin (no_faktur, nama_barang, harga_satuan, qty, satuan, diskon, total_harga) VALUES (?, ?, ?, ?, ?, ?, ?)`);
                    if (d.items && d.items.length > 0) d.items.forEach(it => stmt.run([d.noFaktur, it.nama_barang, it.harga_satuan, it.qty, it.satuan, it.diskon, it.total_harga]));
                    stmt.finalize();

                    db.run(`DELETE FROM inbox_vatin WHERE id = ?`, [d.id_link], (err) => {
                        if (err) { db.run("ROLLBACK"); return; }
                        db.run("COMMIT"); io.emit('update-tabel-vatin'); io.emit('data-baru-vatin');
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

    // ==============================================================
    // BATCH UPLOADER: VAT OUT
    // ==============================================================
    socket.on('upload-pdf-vatout-batch', async (payload) => {
        if (isDummy(socket)) {
            return socket.emit('upload-batch-selesai', { modul: 'VAT OUT', total: payload.files.length, sukses: payload.files.length, duplikat: 0, gagal: 0 });
        }
        const { entitas, username, files } = payload;
        let sukses = 0, duplikat = 0, gagal = 0;

        for (let file of files) {
            try {
                const teks = file.teksPDF;
                let mNo = teks.match(/Kode dan Nomor Seri Faktur Pajak:\s*([\d\.\-]+)/i) || teks.match(/Kode dan Nomor Seri Faktur Pajak\s*:\s*([\d\.\-]+)/i);
                if (!mNo) { gagal++; continue; }

                // Sanitasi no faktur: Ambil hanya angka jika mengandung pemisah legacy
                let cleanNoFaktur = mNo[1].replace(/[\.\-]/g, '');

                let isDup = await checkDuplicateAsync('data_vatout', 'inbox_vatout', 'no_faktur', cleanNoFaktur);
                if (isDup) { duplikat++; continue; }

                // --- SMART DETECTION: LEGACY vs MODERN ---
                // Format lama (2022-2024) punya nomor seri berformat: 010.002-22.72796803 (ada titik & strip)
                // Format baru (2025+): 0100022272796803 (angka murni tanpa pemisah)
                const isLegacy = /^\d{3}\.\d{3}-\d{2}\./.test(mNo[1].trim());

                let mVen, mAlmVen, mNpwpVen, mPem, mAlmPem, mNpwpPem;

                if (isLegacy) {
                    // LEGACY: Nama Pembeli muncul di atas Nomor Faktur, Penjual (BBS) muncul di bawah Nomor Faktur
                    const parts = teks.split(/Kode dan Nomor Seri Faktur Pajak/i);
                    const beforeNo = parts[0] || "";
                    const afterNo = parts[1] || "";

                    mPem = beforeNo.match(/Nama\s*:\s*(.*?)Alamat/i);
                    mAlmPem = beforeNo.match(/Alamat\s*:\s*([\s\S]*?)NPWP\s*:/i);
                    mNpwpPem = beforeNo.match(/NPWP\s*:\s*([\d\.\-]+)/i);

                    mVen = afterNo.match(/Nama\s*:\s*(.*?)Alamat/i);
                    mAlmVen = afterNo.match(/Alamat\s*:\s*([\s\S]*?)NPWP\s*:/i);
                    // NPWP legacy bisa berformat "010002210059000 / 0010002210059000" — ambil bagian pertama saja
                    mNpwpVen = afterNo.match(/NPWP\s*:\s*([\d\.]+)/i);
                } else {
                    // MODERN: Penjual (BBS) di atas, Pembeli di bawah
                    mVen = teks.match(/Pengusaha Kena Pajak[\s\S]*?Nama\s*:\s*(.*?)Alamat/i);
                    mAlmVen = teks.match(/Pengusaha Kena Pajak[\s\S]*?Alamat\s*:\s*([\s\S]*?)NPWP\s*:/i);
                    mNpwpVen = teks.match(/Pengusaha Kena Pajak[\s\S]*?NPWP\s*:\s*([\d\.\-]+)/i);
                    mPem = teks.match(/Pembeli Barang Kena Pajak[\s\S]*?Nama\s*:\s*(.*?)Alamat/i);
                    mAlmPem = teks.match(/Pembeli Barang Kena Pajak[\s\S]*?Alamat\s*:\s*([\s\S]*?)NPWP\s*:/i);
                    mNpwpPem = teks.match(/Pembeli Barang Kena Pajak[\s\S]*?NPWP\s*:\s*([\d\.\-]+)/i);
                }

                const namaEntitasPenjual = mVen?.[1].trim().toUpperCase() || "";
                const entitasMapOut = { 'BBS': ['BERCA BUANA SAKTI'], 'JO': ['BERCA JO', 'BBS JO', 'BMP JO'] };
                let validNamesOut = entitasMapOut[entitas] || [];
                let isValidOut = validNamesOut.some(name => namaEntitasPenjual.includes(name));

                // Jika Nama Penjual tidak cocok, coba cari BBS di NPWP (sebagai fallback terakhir)
                if (!isValidOut) {
                    const npwpVen = mNpwpVen?.[1].replace(/[\.\-]/g, '') || "";
                    if (npwpVen.includes("010002210059")) isValidOut = true;
                }

                if (!isValidOut) { gagal++; continue; }

                let mHargaJual = teks.match(/Harga Jual \/ Penggantian \/ Uang Muka \/ Termin\s+([\d\.,]+)/i) || teks.match(/Harga Jual \/ Penggantian\s+([\d\.,]+)/i);
                let mDPP = teks.match(/Dasar Pengenaan Pajak[^\d]*?((?:\d{1,3}\.)*\d{1,3},\d{2})/i) || teks.match(/Dasar Pengenaan Pajak\s+([\d\.,]+)/i);
                let mPPN = teks.match(/Jumlah PPN[^\d]*?((?:\d{1,3}\.)*\d{1,3},\d{2})/i) || teks.match(/Total PPN\s+([\d\.,]+)/i);
                let mDiskon = teks.match(/Dikurangi Potongan Harga\s+([\d\.,]+)/i);
                let mDP = teks.match(/Dikurangi Uang Muka yang telah diterima\s+([\d\.,]+)/i) || teks.match(/Dikurangi Uang Muka\s+([\d\.,]+)/i);
                // Tanggal: pola "[KOTA], DD BULAN YYYY" — batasi kota max 3 kata agar tidak cocok kalimat panjang
                let mTgl = teks.match(/([A-Za-z]{3,}(?:\s+[A-Za-z]+){0,2}),\s+(\d{1,2}\s+(?:Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+\d{4})/i);

                // Ekstraksi Referensi:
                // - MODERN: ambil isi dalam (Referensi: ...) saja → mRef[1]
                // - LEGACY: ambil FULL teks mulai dari "INVOICE NO. : ..." sampai sebelum PEMBERITAHUAN
                //   sehingga label "INVOICE NO. :" ikut tercantum sebagai bagian referensi
                let mRef = teks.match(/\(Referensi[\s:,]+([^)]+)\)/i);
                let mRefLegacy = teks.match(/(INVOICE\s*NO\.\s*:[\s\S]*?)(?=\s*PEMBERITAHUAN)/i);

                // Ekstraksi Penandatangan:
                // - MODERN: nama muncul setelah "Ditandatangani secara elektronik\n"
                // - LEGACY: nama muncul tepat setelah tanggal (sebelum INVOICE NO.)
                let mTTD = teks.match(/Ditandatangani secara elektronik[\s\S]*?\n([^\n]+)\s*\n/i);
                let mTTDLegacy = isLegacy
                    ? teks.match(/\d{4}[\s\n,]+([A-Z][A-Z\s\.]+?)(?=[\s\n]+INVOICE\s*NO\.)/i)
                    : null;

                let namaClientSafe = sanitizeFilename(mPem?.[1]);
                let namaFileLokal = `arsip_vatout/${cleanNoFaktur}_${namaClientSafe}.pdf`;

                let data = {
                    noFaktur: cleanNoFaktur,
                    namaVendor: mVen?.[1].trim(), alamatVendor: mAlmVen ? mAlmVen[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : "-", npwpVendor: mNpwpVen?.[1].trim(),
                    namaPembeli: mPem?.[1].trim(), alamatPembeli: mAlmPem ? mAlmPem[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : "-", npwpPembeli: mNpwpPem?.[1].trim(),
                    tanggalFaktur: mTgl ? formatTanggal(mTgl[2]) : "-", kotaPenerbit: mTgl ? mTgl[1].trim() : "-",
                    // Referensi: legacy ambil full teks sejak label "INVOICE NO. :", modern ambil isi grup tangkap saja
                    referensi: isLegacy
                        ? (mRefLegacy ? mRefLegacy[1].trim().replace(/\s*\d+\s+dari\s+\d+\s*$/i, '').replace(/\s+/g, ' ') : "-")
                        : (mRef ? mRef[1].trim().replace(/\s*\d+\s+dari\s+\d+\s*$/i, '').replace(/\s+/g, ' ') : "-"),
                    // Penandatangan: legacy dari nama setelah tanggal, modern setelah tanda elektronik
                    penandatangan: isLegacy
                        ? (mTTDLegacy ? mTTDLegacy[1].trim() : "-")
                        : (mTTD ? mTTD[1].trim() : "-"),
                    hargaJual: bersihkanAngka(mHargaJual?.[1]), dpp: bersihkanAngka(mDPP?.[1]), ppn: bersihkanAngka(mPPN?.[1]),
                    diskon: bersihkanAngka(mDiskon?.[1]), uangMuka: bersihkanAngka(mDP?.[1]),
                    items: parseItems(teks), link_pdf_lokal: namaFileLokal, entitas: entitas
                };

                if (data.npwpPembeli) {
                    await dbRun(`INSERT OR REPLACE INTO master_client (npwp, nama, alamat) VALUES (?, ?, ?)`, [data.npwpPembeli, data.namaPembeli, data.alamatPembeli]);
                }

                await fsPromises.writeFile(path.join(__dirname, 'vat_out', namaFileLokal), Buffer.from(file.fileBuffer));
                await dbRun(`INSERT INTO inbox_vatout (entitas, link_pdf_lokal, diinput_oleh, data_ekstraksi) VALUES (?, ?, ?, ?)`, [entitas, namaFileLokal, username, JSON.stringify(data)]);
                sukses++;

            } catch (e) { gagal++; }
        }

        socket.emit('upload-batch-selesai', { modul: 'VAT OUT', total: files.length, sukses, duplikat, gagal });
        io.emit('update-tabel-vatout');
    });

    socket.on('simpan-final-vatout', (d) => {
        // BUG-A FIX: Dummy user tidak boleh menyimpan data nyata ke database
        if (isDummy(socket)) {
            socket.emit('simpan-final-sukses', { message: 'Mode Dummy: Verifikasi disimulasi.' });
            return io.emit('update-tabel-vatout');
        }
        let namaClientSafe = sanitizeFilename(d.namaPembeli);
        let namaFileFinal = `arsip_vatout/${d.branchInput}_${d.noFaktur}_${namaClientSafe}.pdf`;

        try {
            fs.renameSync(path.join(__dirname, 'vat_out', d.link_pdf_lokal), path.join(__dirname, 'vat_out', namaFileFinal));
            d.link_pdf_lokal = namaFileFinal;
        } catch (err) { }

        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            db.run(`INSERT INTO data_vatout (no_faktur, entitas, kode_cabang, npwp_penjual, nama_penjual, alamat_penjual, npwp_pembeli, nama_pembeli, alamat_pembeli, tanggal_faktur, harga_jual, diskon, uang_muka, referensi, kota_penerbit, penandatangan, dpp, ppn, no_invoice_internal, tgl_tukar_faktur, diinput_oleh, link_pdf_lokal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [d.noFaktur, d.entitas, d.branchInput, d.npwpVendor, d.namaVendor, d.alamatVendor, d.npwpPembeli, d.namaPembeli, d.alamatPembeli, d.tanggalFaktur, d.hargaJual, d.diskon, d.uangMuka, d.referensi, d.kotaPenerbit, d.penandatangan, d.dpp, d.ppn, d.invoiceInput, d.tglTukarInput, d.username, d.link_pdf_lokal], function (err) {
                    if (err) { db.run("ROLLBACK"); return; }

                    let stmt = db.prepare(`INSERT INTO item_vatout (no_faktur, nama_barang, harga_satuan, qty, satuan, diskon, total_harga) VALUES (?, ?, ?, ?, ?, ?, ?)`);
                    if (d.items && d.items.length > 0) d.items.forEach(it => stmt.run([d.noFaktur, it.nama_barang, it.harga_satuan, it.qty, it.satuan, it.diskon, it.total_harga]));
                    stmt.finalize();

                    db.run(`DELETE FROM inbox_vatout WHERE id = ?`, [d.id_link], (err) => {
                        if (err) { db.run("ROLLBACK"); return; }
                        db.run("COMMIT"); io.emit('update-tabel-vatout'); io.emit('data-baru-vatout');
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
                    if (err) { db.run("ROLLBACK"); return; }
                    db.run(`DELETE FROM inbox_payable WHERE id = ?`, [d.id_link], (err) => {
                        if (err) { db.run("ROLLBACK"); return; }
                        db.run("COMMIT"); io.emit('update-tabel-payable'); io.emit('data-baru-payable');
                    });
                });
        });
    });

    socket.on('hapus-inbox-payable', (id) => {
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
                    if (err) { db.run("ROLLBACK"); return; }
                    db.run(`DELETE FROM inbox_prepaid WHERE id = ?`, [d.id_link], (err) => {
                        if (err) { db.run("ROLLBACK"); return; }
                        db.run("COMMIT"); io.emit('update-tabel-prepaid'); io.emit('data-baru-prepaid');
                    });
                });
        });
    });

    socket.on('hapus-inbox-prepaid', (id) => {
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
        const { kode_cabang, nama_cabang, entitas, user } = d;
        if (!kode_cabang || !nama_cabang || !entitas) {
            return socket.emit('error-cabang', 'Kode, Nama, dan Entitas wajib diisi.');
        }
        db.run(
            `INSERT INTO master_cabang (kode_cabang, nama_cabang, entitas) VALUES (?, ?, ?)`,
            [kode_cabang.trim().toUpperCase(), nama_cabang.trim(), entitas],
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
        const { kode_cabang, nama_cabang, entitas, user } = d;
        if (!kode_cabang || !nama_cabang || !entitas) {
            return socket.emit('error-cabang', 'Kode, Nama, dan Entitas wajib diisi.');
        }
        db.run(
            `UPDATE master_cabang SET nama_cabang = ?, entitas = ? WHERE kode_cabang = ?`,
            [nama_cabang.trim(), entitas, kode_cabang],
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
        let val = d.jenis === 'PASSWORD' ? bcrypt.hashSync(d.nilai_baru, 12) : d.nilai_baru;
        db.run(`INSERT INTO user_requests (user_id, username, jenis_request, nilai_baru) VALUES (?, ?, ?, ?)`, [d.id_user, d.username, d.jenis, val], () => io.emit('request-updated'));
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
                    db.run(`UPDATE users SET ${col} = ? WHERE id = ?`, [req.nilai_baru, req.user_id], () => {
                        db.run(`UPDATE user_requests SET status = 'Disetujui' WHERE id = ?`, [d.req_id], () => io.emit('request-updated'));
                    });
                }
                else if (req.jenis_request.startsWith('HAPUS_')) {
                    let targetMod = req.jenis_request.split('_')[1].toLowerCase();
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
                    let isBPPU = (targetMod === 'payable' || targetMod === 'prepaid');
                    let val = JSON.parse(req.nilai_baru);

                    if (isBPPU) {
                        db.run(`UPDATE data_${targetMod} SET kode_cabang = ?, no_invoice_internal = ? WHERE no_bppu = ?`,
                            [val.branch, val.invoice, val.faktur], () => {
                                db.run(`UPDATE user_requests SET status = 'Disetujui' WHERE id = ?`, [d.req_id], () => {
                                    io.emit('request-updated'); io.emit(`data-baru-${targetMod}`);
                                });
                            });
                    } else {
                        db.run(`UPDATE data_${targetMod} SET kode_cabang = ?, no_invoice_internal = ?, tgl_tukar_faktur = ? WHERE no_faktur = ?`,
                            [val.branch, val.invoice, val.tanggal, val.faktur], () => {
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