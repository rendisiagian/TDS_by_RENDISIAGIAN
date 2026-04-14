const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('faktur.db');

// Fungsi pembantu agar database mau menunggu (Synchronous)
const runQuery = (query, params) => new Promise((resolve, reject) => {
    db.run(query, params, function(err) { if (err) reject(err); else resolve(this); });
});
const getQuery = (query, params) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => { if (err) reject(err); else resolve(row); });
});

async function syncData() {
    console.log("⏳ Memulai proses sinkronisasi...");
    
    // 1. Pastikan tabel data_client sudah ada
    await runQuery(`CREATE TABLE IF NOT EXISTS data_client (npwp TEXT PRIMARY KEY, nama TEXT)`, []);

    // 2. Ambil data dari faktur_detail
    db.all(`SELECT npwp_client, nama_client FROM faktur_detail WHERE npwp_client IS NOT NULL AND npwp_client != '' ORDER BY id ASC`, async (err, rows) => {
        if (err) return console.error("❌ Error membaca data:", err);
        
        console.log(`Menemukan ${rows.length} baris. Memproses satu per satu secara berurutan...`);
        
        // 3. Loop yang dipaksa menunggu (Synchronous Loop)
        for (let row of rows) {
            const npwp = row.npwp_client;
            const nama = row.nama_client || '';

            try {
                // Cek apakah NPWP sudah ada di data_client
                const existingClient = await getQuery(`SELECT nama FROM data_client WHERE npwp = ?`, [npwp]);
                
                if (!existingClient) {
                    // Jika belum ada, masukkan data baru
                    await runQuery(`INSERT INTO data_client (npwp, nama) VALUES (?, ?)`, [npwp, nama]);
                    console.log(`➕ Insert Baru: ${npwp} -> ${nama}`);
                } else {
                    // Jika sudah ada, cek apakah namanya lebih panjang
                    if (nama.length > existingClient.nama.length) {
                        await runQuery(`UPDATE data_client SET nama = ? WHERE npwp = ?`, [nama, npwp]);
                        console.log(`🔄 Update Panjang: ${npwp} -> Diperbarui jadi "${nama}"`);
                    } else {
                        console.log(`⏭️ Lewati: ${npwp} -> "${nama}" (Sudah ada versi yang sama/lebih panjang)`);
                    }
                }
            } catch (e) {
                console.error(`❌ Error pada NPWP ${npwp}:`, e.message);
            }
        }
        
        console.log("=========================================");
        console.log("✅ PROSES SINKRONISASI SELESAI SEMPURNA!");
        db.close();
    });
}

syncData();