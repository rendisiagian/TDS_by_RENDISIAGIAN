# Product Requirements Document (PRD) - Tax Database System (TDS)

## 1. Executive Summary
Tax Database System (TDS) adalah aplikasi web analitik dan operasional yang berfungsi sebagai *Single Source of Truth* untuk manajemen data perpajakan korporasi. Sistem ini dibangun khusus untuk melayani entitas utama (BBS) dan Joint Operation (JO). Berbeda dengan sistem pencatatan konvensional, TDS mendigitalisasi seluruh rantai proses: mulai dari otomatisasi ekstraksi PDF Faktur Pajak, pemetaan ke struktur organisasi (Cabang/Proyek), manajemen Bukti Potong PPh, hingga penyajian *Dashboard* Profitabilitas Proyek (*Tax View*). 

Sistem ini didesain mengutamakan kecepatan akses data dalam jumlah besar (*Server-side rendering*), kolaborasi *multi-user* yang aman (*RBAC*), dan pelacakan audit secara *real-time*.

---

## 2. Struktur Arsitektur & Teknologi Induk
- **Environment**: Node.js (V8 Engine)
- **Web Framework**: Express.js (REST API & View Serving)
- **Relational Database**: SQLite3 (`tax_database.db`). Sangat ringan, file-based, mampu memproses jutaan baris data secara instan dalam skala operasional internal.
- **Real-time WebSockets**: Socket.io (streaming *batch upload* dan sinkronisasi status/progress UI). Socket menggunakan session yang sama dengan Express (wajib login).
- **Frontend Stack**: Vanilla HTML5, Vanilla JavaScript (ES6+), CSS3 *Native Variables* (Mendukung Dark/Light Mode adaptif).
- **Pustaka Pemrosesan PDF**: PDF.js (Parsing teks dari *vector-based* PDF Faktur Pajak).

---

## 3. Database Schema (Skema Basis Data Utama)
Basis data `tax_database.db` dibangun di atas tabel-tabel terstruktur secara relasional, antara lain:

### 3.1 Manajemen Pengguna & Keamanan
- `users`: (id, username, password, nama_lengkap, role) - Tempat menyimpan kredensial dengan peran admin/supervisor/staff.
- `user_requests`: (id, user_id, username, jenis_request, nilai_baru, status, waktu) - Antrean permintaan penghapusan/edit dari Staff yang butuh *approval* Supervisor.
- `audit_logs`: (id, user_id, username, action, module, details, waktu) - Catatan permanen (*Immutable*) dari seluruh aktivitas mutasi data.

### 3.2 Master Data
- `master_cabang`: (kode_cabang, nama_cabang, entitas, contract_income) - Kamus data referensi proyek/branch internal.
- `master_vendor` & `master_client`: (npwp, nama, alamat, format_tipe, tanggal_terakhir) - Terpopulasi otomatis saat dokumen PDF berhasil diekstrak (VAT IN/VAT OUT).
- `master_vo`: (id, kode_cabang, nama_vo, contract_income) - Referensi Variation Order (VO) untuk modul Project Billing.
- `projects`: (id, kode, nama, deskripsi, status, progress, tanggal_mulai, tanggal_selesai, pm, anggaran, diinput_oleh) - Skema relasional yang menyokong fungsi CRUD untuk pemantauan pada *Tax Project Report*.

### 3.3 Modul Transaksional (Pajak Masukan & Keluaran)
- `data_vatin`: Tabel header Faktur Masukan (VAT IN).
  - *Kolom Kunci*: `no_faktur`, `entitas`, `kode_cabang`, `project_id`, `npwp_penjual`, `nama_penjual`, `alamat_penjual`, `npwp_pembeli`, `nama_pembeli`, `alamat_pembeli`, `tanggal_faktur`, `dpp`, `ppn`, `referensi`, `kota_penerbit`, `penandatangan`, `no_invoice_internal`, `tgl_tukar_faktur`, `status_faktur`, `masa_pajak`, `no_faktur_normal`, `link_pdf_lokal`, `diinput_oleh`, `waktu_input`.
- `data_vatout`: Tabel header Faktur Keluaran (VAT OUT).
  - *Kolom Kunci*: `no_faktur`, `entitas`, `kode_cabang`, `project_id`, `kode_vo`, `npwp_penjual`, `nama_penjual`, `alamat_penjual`, `npwp_pembeli`, `nama_pembeli`, `alamat_pembeli`, `tanggal_faktur`, `dpp`, `ppn`, `referensi`, `kota_penerbit`, `penandatangan`, `no_invoice_internal`, `tgl_tukar_faktur`, `format_tipe`, `link_pdf_lokal`, `diinput_oleh`, `waktu_input`.
- `item_vatin` & `item_vatout`: (id, no_faktur, nama_barang, harga_satuan, qty, satuan, diskon, total_harga) - *one-to-many* detail item per nomor faktur.

### 3.4 Modul Akuntansi & PPh
- `data_client_ledger`: Tabel riwayat penagihan proyek (*Client Ledger*) yang mendukung pelacakan finansial secara menyeluruh.
  - *Kolom Kunci*: `inv_no`, `entitas`, `nama_client`, `contract_income`, `advance`, `retention`, `net_certificate`, `vat`, `gross_certificate`, `gross_paym_received`, `contract_debtor`, `gross_paym_rcpt`, `withholding_tax`, `net_receipt`, `ref_bppu`, `is_advance`, `ref_advance`.
- `data_payable` & `data_prepaid`: (no_bppu, masa_pajak, entitas, kode_cabang, npwp_pemotong, nama_pemotong, dpp, tarif, nilai_pph, tanggal_dokumen, nomor_dokumen, no_invoice_internal, link_pdf_lokal) - Tempat penyimpanan kewajiban dan klaim formulir pemotongan pajak penghasilan pihak ketiga.

Catatan staging/inbox (sesuai implementasi aktual):
- VAT OUT: `inbox_vatout` → diverifikasi → `data_vatout`
- VAT IN: Secara sistem `inbox_vatin` juga dieksekusi, namun *business logic* mendahulukan aliran langsung ke `data_vatin` dengan `kode_cabang = 'Perlu Verifikasi'` agar visibilitasnya seketika tampil di *dashboard*.
- BPPU: `inbox_payable` dan `inbox_prepaid` → diverifikasi → `data_payable` dan `data_prepaid`


---

## 4. Role-Based Access Control (RBAC) & Approval Workflow
Otorisasi dibagi menjadi tiga tingkatan (Role):
1. **Administrator** (superadmin/super admin):
   - Mengendalikan `manage_users.html` (tambah user, reset password, edit nama sendiri).
   - Memproses approval `user_requests` (Setuju/Tolak).
   - Mengelola master data: `master_cabang`, `master_vo`, `master_vendor`, `master_client`.
   - Mengakses halaman `audit_logs.html`.
2. **Supervisor**:
   - Memvalidasi/memproses perubahan yang diajukan oleh Staff melalui `user_requests`.
   - Dapat mengeksekusi update/delete data final pada `data_*`.
3. **Accounting & Tax Staff**:
   - Operator harian yang melakukan upload dan mengajukan perubahan relasi internal.

Kunci keamanan:
- Halaman HTML memakai middleware `cekAuth`.
- API admin memakai `cekRoleAPI([...])`.
- Socket.IO mewajibkan session user valid (koneksi ditolak jika tidak login).


---

## 5. Fitur Fungsional & Alur Kerja (Workflow) Modul

### 5.1 Faktur Pajak Masukan (VAT IN) - *Direct-to-Dashboard*
Alur Kerja (Workflow) Lengkap:
1. **Batch Upload (Socket)**: Staff men-*upload* PDF (batch/chunk) melalui UI; PDF.js mengekstrak teks.
2. **Upload Event**: Client mengirim socket event `upload-pdf-vatin-batch`.
3. **Parsing & Klasifikasi**: Sistem mengekstrak header (No Faktur, Vendor, Pembeli, Tanggal Faktur, DPP/PPN, dll) dan *items*.
4. **Duplication Guard**: Jika `no_faktur` sudah ada (cek juga terhadap staging inbox untuk guard kompatibilitas), baris di-*skip*.
5. **Pending State ("Perlu Verifikasi")**: Semua hasil upload masuk langsung ke `data_vatin` dengan:
   - `kode_cabang = 'Perlu Verifikasi'`
   - field relasi internal (`no_invoice_internal`, `tgl_tukar_faktur`) masih kosong.
   Di UI ditampilkan sebagai status yang membutuhkan penyelarasan.
6. **Verifikasi Final (Maker-Checker via Socket)**: Staff klik `Edit` pada baris *Perlu Verifikasi* → mengisi **Branch/Cabang** dan **No. Invoice Internal** (+ `tgl_tukar_faktur` opsional sesuai UI) → sistem melakukan `request-action-faktur`.
   - Bila role bukan supervisor: tersimpan di `user_requests` untuk approval.
   - Bila supervisor/admin: update langsung ke `data_vatin`.

Implikasi dokumen: VAT IN **tidak memakai inbox VAT IN** pada implementasi ini.


### 5.2 Logika Faktur Pajak Pengganti (Replacement Invoices)
Ketahanan data dibangun dengan kombinasi:
- `status_faktur` (hasil parse)
- `no_faktur_normal` (mapping faktur pengganti → nomor normal)
- dan proses *deduplication* pada agregasi.

Detail implementasi:
- Status diturunkan dari **digit ke-3 dan ke-4** pada `no_faktur`:
  - `statusDigit === '00'` → `status_faktur = 'Normal'`
  - selain itu → `status_faktur = 'Pengganti {n}'`
- `no_faktur_normal` dihitung dengan mengubah digit status pada `no_faktur` pengganti menjadi `00`.
- Rekapitulasi VAT IN memakai fungsi `deduplicateVatinData(rows)`:
  - Mengelompokkan baris berdasarkan serial faktur (substring pada `no_faktur`).
  - Memilih record dengan **ranking status tertinggi**: `Pengganti N > ... > Pengganti 1 > Normal`.
  - Selain itu, terdapat sinkronisasi `masa_pajak` untuk pengganti agar mengikuti faktur normal yang menjadi induknya.

Catatan: implementasi ini memastikan tidak terjadi double-counting nilai DPP/PPN saat pengganti dipakai.


### 5.3 Optimasi Server-Side Pagination & Debounce Filter
Menangani kendala performa pada puluhan ribu baris data di browser:
- **Pagination Database-Level**: Node.js melayani parameter `page` dan `limit`, mengeksekusi *Query* `LIMIT X OFFSET Y` ke SQLite.
- **Interaktif Filter (Debounce)**: Tersedia kolom pencarian di bawah setiap *header* tabel (Teks, Flatpickr Date-Range, hingga pencarian *"Data Kosong/Null"*). Saat mengetik, *Debounce API* (delay 500ms) dipicu untuk mencegah *Spamming API Request*. Data tabel dan agregasi metrik memuat ulang seketika.

### 5.4 Modul PPh (Prepaid & Payable BPPU)
- Penyimpanan komprehensif formulir pemotongan pajak penghasilan pihak ketiga atas perusahaan, dan kewajiban perusahaan memotong pajak vendor. Tersambung secara hierarki dengan tabel `master_cabang`.

### 5.5 Tax Project Report
Modul *Business Intelligence* untuk analitik profitabilitas berbasis data pajak.

Implementasi (endpoint & relasi):
- UI memanggil:
  - `GET /api/projects?entitas=...` untuk daftar project/branch
  - `GET /api/vo/:kode_cabang` untuk daftar VO (opsional tab)
  - `GET /api/project-summary/:id` untuk mengambil ringkasan lintas modul.
- Backend mengambil:
  - **VAT OUT** dari `data_vatout` dengan kondisi `d.kode_cabang = projectId OR d.project_id = projectId`.
  - **VAT IN** dari `data_vatin` dengan kondisi `d.kode_cabang = projectId OR d.project_id = projectId`.
- UI mengkalkulasi margin dengan rumus:
  - `margin = DPP_OUT - DPP_IN`
  - dan menampilkan indikator progress terhadap `contract_income` (VO atau proyek).

Catatan: pada implementasi saat ini, ringkasan yang ditampilkan berfokus pada DPP VAT OUT vs VAT IN; integrasi PPh/ledger dapat diperluas pada roadmap.


---

## 6. Pengembangan Masa Depan (Roadmap Eksekutif)
1. **Modernisasi UI VAT OUT & PPh**: Menerapkan fondasi *Server-side Pagination*, antarmuka pencarian *Debounce*, serta infrastruktur *Socket Upload* dari modul VAT IN ke sisa modul agar pengalaman pengguna konsisten.
2. **Optical Character Recognition (OCR)**: Melangkah lebih jauh dari PDF.js menuju pengenalan teks berbasis *Machine Learning* untuk mengekstrak Faktur/Bukti Potong berbasis *image-scan*.
3. **Automasi Pembuatan Jurnal (Export-to-ERP)**: Modul untuk mengubah rekapitulasi hutang/piutang pajak menjadi format *template Excel/CSV* yang baku dan siap di-*import* (di-bridge) ke sistem ERP induk perusahaan.
4. **Integrasi Single Sign-On (SSO)**: Menghubungkan autentikasi dengan Active Directory perusahaan untuk manajemen akses terpusat.
5. **Sistem Notifikasi Real-time**: Mengirimkan notifikasi email/Telegram otomatis kepada Supervisor bila ada antrean `user_requests` yang membutuhkan *approval*.

---

## 7. Kebutuhan Non-Fungsional (Non-Functional Requirements / NFR)

1. **Performa & Skalabilitas**: 
   - Waktu muat (load time) untuk tabel data bervolume tinggi tidak boleh lebih dari 2 detik (dicapai melalui optimalisasi algoritma *server-side pagination* dan *indexing* database).
   - Ekstraksi PDF client-side harus sanggup memproses *batch* ratusan file secara asinkron (menggunakan Web Workers/Chunks) tanpa membuat antarmuka browser *freeze*.
2. **Keamanan (Security)**:
   - Enkripsi *password* menggunakan *hashing* yang tangguh (seperti Bcrypt).
   - Proteksi mutlak terhadap *Cross-Site Scripting* (XSS) pada tampilan form dan pencegahan *SQL Injection* menggunakan *Prepared Statements* (Query Parameterization).
   - Manajemen *Session* yang ketat, otomatis memutus sesi (*timeout*) apabila pengguna dalam keadaan *idle* melebihi batas waktu yang ditetapkan.
3. **Ketersediaan (Availability) & Ketahanan Data**:
   - Sistem dikonfigurasi untuk lingkungan jaringan internal (*Intranet*) dengan garansi *uptime* operasional yang tinggi.
   - Rutinitas pencadangan (Backup) berkala untuk file `tax_database.db` via *Cron Job* harian sebagai langkah antisipasi *Disaster Recovery*.
4. **Kompatibilitas**:
   - Aplikasi berbasis peramban (Web-Based) ini sepenuhnya kompatibel dengan *browser* modern standar (Google Chrome, Microsoft Edge, Mozilla Firefox, Safari).
   - Pendekatan desain antarmuka *Adaptive/Responsive UI* guna memaksimalkan visibilitas fungsionalitas di berbagai resolusi layar desktop.

---

## 8. Metrik Keberhasilan (Success Metrics)

1. **Efisiensi Waktu (Time-Saving)**: Memangkas drastis *SLA* (Service Level Agreement) proses perekaman faktur dan bukti potong; bertransformasi dari input manual berjam-jam menjadi intervensi beberapa menit (*auto-upload* & otomatisasi ekstraksi).
2. **Integritas & Akurasi Data (Zero-Error)**: Mengeliminasi potensi kelalaian pengetikan (human error) pada nominal DPP, PPN, NPWP, dan atribut pajak lainnya, menjadikan TDS sebagai pilar *Single Source of Truth*.
3. **Kepatuhan Regulasi (Tax Compliance)**: Menghindari denda maupun kelebihan/kekurangan bayar berkat penanganan adaptif terhadap Dokumen Faktur Pengganti (konsolidasi agregat berdasarkan *serial* ter-update).
4. **Kecepatan Pengambilan Keputusan Manajerial**: Visibilitas analitik lintas modul dan monitoring profitabilitas setiap proyek di *Dashboard* tersedia secara *real-time*, mendobrak hambatan proses rekapitulasi data Excel di akhir bulan.
