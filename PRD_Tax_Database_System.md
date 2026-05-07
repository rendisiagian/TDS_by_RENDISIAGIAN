# [PRD] Tax Database System (TDS)

## 1. Gambaran Umum Proyek
Tax Database System (TDS) adalah aplikasi berbasis web yang berfungsi sebagai repositori pusat untuk data perpajakan perusahaan (BBS & JO). Sistem ini mengotomatiskan ekstraksi data dari Faktur Pajak PDF dan menyediakan dashboard analitik untuk pemantauan posisi pajak secara real-time.

## 2. Pengguna Target
- **Accounting & Tax Staff**: Mengunggah dokumen, melakukan verifikasi cabang, dan menginput data invoice internal.
- **Supervisor/Manager**: Menyetujui penghapusan data, memantau total kewajiban pajak, dan melihat laporan profitabilitas proyek.
- **Administrator**: Mengelola user, memantau audit logs, dan mengelola master data cabang/kontak.

## 3. Fitur Utama

### 3.1 Faktur Masukan (VAT IN) - *Modernized*
- **Direct PDF Upload**: Pengguna mengunggah PDF langsung dari dashboard utama.
- **Auto-Extraction**: Menggunakan PDF.js untuk membaca data faktur tanpa input manual.
- **Status "Perlu Verifikasi"**: Data baru ditandai sebagai antrean yang butuh relasi Cabang dan No. Invoice Internal.
- **Validasi Entitas**: Memastikan PDF yang diunggah sesuai dengan entitas aktif (BBS atau JO).

### 3.2 Faktur Keluaran (VAT OUT)
- Manajemen data PPN Keluaran.
- Filter berdasarkan Masa Pajak dan Branch.
- Support Faktur Pengganti.

### 3.3 Dashboard Utama
- Ringkasan visual PPN dan DPP per modul.
- Indikator **"Perlu Verifikasi"** untuk memantau dokumen yang belum diproses.
- Perbandingan bulan-ke-bulan (MoM) untuk melihat tren perpajakan.

### 3.4 Pelaporan (Tax Project Report)
- Laporan profitabilitas pajak per proyek.
- Laporan rekonsiliasi PPN dan PPh.

## 4. Spesifikasi Teknis
- **Backend**: Node.js & Express.js.
- **Database**: SQLite3 (Single-file database).
- **Frontend**: Vanilla HTML5, CSS3, dan JavaScript.
- **Komunikasi**: Socket.io untuk proses batch upload real-time.
- **Keamanan**: Role-Based Access Control (RBAC) dan Audit Logging.

## 5. Rencana Pengembangan Selanjutnya
- Modernisasi VAT OUT menggunakan alur *Direct Upload* yang sama dengan VAT IN.
- Integrasi OCR untuk dokumen hasil scan/gambar.
- Penambahan grafik tren pajak tahunan.
