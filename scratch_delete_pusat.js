const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('tax_database.db');

db.run(`DELETE FROM master_cabang WHERE kode_cabang = 'PUSAT'`, function(err) {
    if (err) return console.error("Gagal menghapus:", err.message);
    if (this.changes === 0) return console.log("Data PUSAT tidak ditemukan (mungkin sudah dihapus).");
    console.log("✅ Berhasil! Data 'PUSAT' (Kantor Pusat BBS) telah dihapus dari database.");
    db.close();
});
