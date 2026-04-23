const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('tax_database.db'); // Pastikan path benar jika dijalankan di root project

db.serialize(() => {
    console.log("Memulai proses pembersihan tabel master_cabang...");
    
    db.all("PRAGMA table_info(master_cabang)", (err, cols) => {
        if (err) {
            console.error("Gagal membaca struktur tabel:", err);
            return;
        }
        
        const existingCols = cols.map(c => c.name);
        console.log("Kolom yang ada saat ini:\n -", existingCols.join('\n - '));
        
        // Kolom yang akan dipertahankan
        const keepCols = ['kode_cabang', 'nama_cabang', 'entitas'];
        if (existingCols.includes('contract_income')) {
            keepCols.push('contract_income');
        }

        const keepColsStr = keepCols.join(', ');
        
        console.log("\nMembuat tabel sementara (hanya dengan kolom inti)...");
        db.run(`CREATE TABLE master_cabang_new (kode_cabang TEXT PRIMARY KEY, nama_cabang TEXT, entitas TEXT, contract_income REAL DEFAULT 0)`, (err) => {
            if (err) return console.error("Gagal membuat tabel sementara:", err);
            
            console.log("Memindahkan data ke tabel sementara...");
            db.run(`INSERT INTO master_cabang_new (${keepColsStr}) SELECT ${keepColsStr} FROM master_cabang`, (err) => {
                if (err) return console.error("Gagal memindahkan data:", err);
                
                console.log("Menghapus tabel lama...");
                db.run(`DROP TABLE master_cabang`, (err) => {
                    if (err) return console.error("Gagal menghapus tabel lama:", err);
                    
                    console.log("Mengubah nama tabel sementara menjadi master_cabang...");
                    db.run(`ALTER TABLE master_cabang_new RENAME TO master_cabang`, (err) => {
                        if (err) return console.error("Gagal mengubah nama tabel:", err);
                        
                        console.log("\n✅ SUKSES! Tabel master_cabang telah dibersihkan.");
                        console.log("Kolom yang tersisa hanya: " + keepColsStr);
                        console.log("Silakan jalankan kembali 'node app.js' untuk menyalakan server.");
                    });
                });
            });
        });
    });
});
