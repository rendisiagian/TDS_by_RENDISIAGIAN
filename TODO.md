# TODO

## Phase 1 — Audit VAT IN (integrity warning)
- [ ] Tambahkan endpoint API baru: `/api/audit-vatin?entitas=...` untuk mendeteksi:
  - [ ] Normal yang digantikan (Normal ada + ada Pengganti)
  - [ ] Pengganti orphan (Pengganti ada + Normal induk tidak ada)

- [ ] Endpoint mengembalikan data ringkas untuk ditampilkan di UI:
  - [ ] count orphaned replacement
  - [ ] daftar sampel/atau semuanya (top N) untuk detail
- [ ] Buat halaman detail audit: `/audit-vatin.html` (atau route `/audit-vatin`) menampilkan:
  - [ ] tabel orphaned replacement (Pengganti tanpa Normal induk)
  - [ ] tabel normal yang digantikan (Normal ada tapi ada Pengganti)
- [ ] Update `sidebar.html` untuk menu “Audit VAT IN” menuju halaman detail.
- [ ] Update `vat_in/dashboard_vatin.html`:
  - [ ] tambah alert card/badge berdasarkan hasil `/api/audit-vatin`
  - [ ] tombol “Lihat Detail” ke halaman audit.


## Phase 2 — Data consistency / testing
- [ ] Jalankan syntax check node
- [ ] Uji manual:
  - [ ] Dashboard: muncul warning sesuai kondisi data
  - [ ] Summary: memastikan angka tetap deduplikasi seperti sebelumnya

