# Smart Master Data Update Logic Documentation

## 📋 Overview
Logic cerdas untuk update data master_client dan master_vendor yang mencegah:
- Overwrite data dengan format berbeda (LEGACY vs MODERN)
- Overwrite data dengan tanggal yang lebih lama
- Kehilangan data akibat ekstraksi dokumen dengan format berbeda

## 🏗️ Database Schema Changes

### master_client Table
```sql
CREATE TABLE IF NOT EXISTS master_client (
    npwp TEXT PRIMARY KEY,
    nama TEXT,
    alamat TEXT,
    format_tipe TEXT,           -- 'LEGACY' (2022-2024) atau 'MODERN' (2025+)
    tanggal_terakhir TEXT       -- Tanggal faktur terakhir yang diupdate
);
```

### master_vendor Table
```sql
CREATE TABLE IF NOT EXISTS master_vendor (
    npwp TEXT PRIMARY KEY,
    nama TEXT,
    alamat TEXT,
    format_tipe TEXT,           -- 'LEGACY' atau 'MODERN'
    tanggal_terakhir TEXT       -- Tanggal faktur terakhir yang diupdate
);
```

## 🔧 Core Logic: updateMasterData()

```javascript
async function updateMasterData(tableName, npwp, nama, alamat, formatTipe, tanggalFaktur) {
    if (!npwp) return;

    // 1. Cek apakah data sudah ada
    const existing = await db.get(
        `SELECT format_tipe, tanggal_terakhir FROM ${tableName} WHERE npwp = ?`,
        [npwp]
    );

    if (existing) {
        // 2. Jika format berbeda, jangan replace
        if (existing.format_tipe !== formatTipe) {
            console.log(`SKIP: Format berbeda (${existing.format_tipe} vs ${formatTipe}) untuk NPWP ${npwp}`);
            return;
        }

        // 3. Jika format sama tapi tanggal faktur tidak lebih baru, jangan replace
        if (tanggalFaktur <= existing.tanggal_terakhir) {
            console.log(`SKIP: Tanggal tidak lebih baru (${tanggalFaktur} <= ${existing.tanggal_terakhir}) untuk NPWP ${npwp}`);
            return;
        }
    }

    // 4. Insert atau replace dengan data baru
    await db.run(
        `INSERT OR REPLACE INTO ${tableName} (npwp, nama, alamat, format_tipe, tanggal_terakhir) VALUES (?, ?, ?, ?, ?)`,
        [npwp, nama, alamat, formatTipe, tanggalFaktur]
    );

    console.log(`${existing ? 'UPDATE' : 'INSERT'}: ${tableName} - ${npwp} (${formatTipe}) - ${nama} - ${tanggalFaktur}`);
}
```

## 📊 Decision Flow

```
NPWP tidak ada?
├── YES → INSERT data baru
└── NO → Cek format_tipe
    ├── Format berbeda? → SKIP (jangan update)
    └── Format sama → Cek tanggal
        ├── Tanggal <= tanggal_terakhir? → SKIP (jangan update)
        └── Tanggal > tanggal_terakhir → UPDATE data
```

## 🧪 Test Cases & Expected Behavior

### Test Case 1: Insert Data Baru
```javascript
// Input
updateMasterData('master_client', '1234567890123456', 'PT ABC', 'Jl A No 1', 'LEGACY', '2024-01-15');

// Expected: ✅ INSERT
// Result: Data baru tersimpan
```

### Test Case 2: Update Format Sama, Tanggal Lebih Baru
```javascript
// Existing: LEGACY, 2024-01-15
// Input: LEGACY, 2024-06-10
updateMasterData('master_client', '1234567890123456', 'PT ABC Updated', 'Jl A No 1 Updated', 'LEGACY', '2024-06-10');

// Expected: ✅ UPDATE
// Result: Data terupdate karena tanggal lebih baru
```

### Test Case 3: Skip Format Berbeda
```javascript
// Existing: LEGACY, 2024-06-10
// Input: MODERN, 2025-01-01
updateMasterData('master_client', '1234567890123456', 'PT ABC Modern', 'Jl A No 1 Modern', 'MODERN', '2025-01-01');

// Expected: ❌ SKIP
// Result: Data tidak berubah, tetap LEGACY
```

### Test Case 4: Skip Tanggal Lama
```javascript
// Existing: LEGACY, 2024-06-10
// Input: LEGACY, 2024-03-01 (lebih lama)
updateMasterData('master_client', '1234567890123456', 'PT ABC Old', 'Jl A No 1 Old', 'LEGACY', '2024-03-01');

// Expected: ❌ SKIP
// Result: Data tidak berubah
```

## 🎯 Benefits

### 1. Format Separation
- **LEGACY** (2022-2024): Data tetap terpisah dari MODERN
- **MODERN** (2025+): Data tetap terpisah dari LEGACY
- Tidak ada mixing data antar format

### 2. Data Integrity Protection
- Data baru tidak akan tertimpa data lama
- Hanya update jika tanggal faktur lebih baru
- Mencegah kehilangan informasi penting

### 3. Backward Compatibility
- Logic bekerja untuk data existing tanpa format_tipe
- Data lama akan dianggap LEGACY jika belum ada format_tipe
- Tidak merusak data yang sudah ada

## 📁 Implementation Files

### Modified Files:
- `app.js`: Menambahkan kolom `format_tipe` dan `tanggal_terakhir`
- `app.js`: Menambahkan function `updateMasterData()`
- `app.js`: Update logic ekstraksi VAT OUT dan VAT IN

### Test Files:
- `debug_samples/test_smart_master.js`: Script test lengkap

## 🚀 Usage in VAT Extraction

### VAT OUT (Sales Invoice)
```javascript
// Dalam function ekstraksi VAT OUT
const formatTipe = detectFormatType(pdfText); // 'LEGACY' atau 'MODERN'
const tanggalFaktur = extractTanggalFaktur(pdfText);

await updateMasterData('master_client',
    npwpPembeli, namaPembeli, alamatPembeli,
    formatTipe, tanggalFaktur
);
```

### VAT IN (Purchase Invoice)
```javascript
// Dalam function ekstraksi VAT IN
const formatTipe = detectFormatType(pdfText); // 'LEGACY' atau 'MODERN'
const tanggalFaktur = extractTanggalFaktur(pdfText);

await updateMasterData('master_vendor',
    npwpPenjual, namaPenjual, alamatPenjual,
    formatTipe, tanggalFaktur
);
```

## 🔍 Monitoring & Debugging

### Console Logs
Logic akan memberikan feedback melalui console:
```
✅ INSERT: master_client - 1234567890123456 (LEGACY) - PT ABC - 2024-01-15
✅ UPDATE: master_client - 1234567890123456 (LEGACY) - PT ABC Updated - 2024-06-10
❌ SKIP: Format berbeda (LEGACY vs MODERN) untuk NPWP 1234567890123456
❌ SKIP: Tanggal tidak lebih baru (2024-03-01 <= 2024-06-10) untuk NPWP 1234567890123456
```

### Database Queries untuk Monitoring
```sql
-- Cek distribusi format
SELECT format_tipe, COUNT(*) as jumlah
FROM master_client
GROUP BY format_tipe;

-- Cek data terbaru per NPWP
SELECT npwp, nama, format_tipe, tanggal_terakhir
FROM master_client
ORDER BY tanggal_terakhir DESC;
```

## ⚠️ Important Notes

1. **Format Detection**: Pastikan function `detectFormatType()` akurat mendeteksi LEGACY vs MODERN
2. **Date Format**: Gunakan format konsisten (YYYY-MM-DD) untuk tanggal
3. **NPWP Validation**: Pastikan NPWP valid sebelum update
4. **Backup**: Selalu backup database sebelum implementasi besar
5. **Testing**: Jalankan test script sebelum deploy ke production

## 📈 Future Enhancements

- [ ] Add audit trail untuk tracking perubahan data
- [ ] Add validation untuk format tanggal
- [ ] Add batch update untuk migrasi data existing
- [ ] Add UI untuk manual override logic (admin only)
- [ ] Add metrics dashboard untuk monitoring update patterns