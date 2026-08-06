const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'tax_database.db');
const db = new sqlite3.Database(dbPath);

console.log("Starting VAT OUT migration...");

db.all(`SELECT no_faktur, tanggal_faktur FROM data_vatout WHERE status_faktur IS NULL OR status_faktur = '' OR masa_pajak IS NULL OR status_faktur = 'Normal'`, async (err, rows) => {
    if (err) {
        console.error("Database error:", err.message);
        process.exit(1);
    }
    
    if (!rows || rows.length === 0) {
        console.log("Tidak ada data yang perlu di-update");
        process.exit(0);
    }

    let updatedCount = 0;
    let failedCount = 0;

    for (let row of rows) {
        try {
            const noFaktur = row.no_faktur;
            const tanggalFaktur = row.tanggal_faktur;
            
            const statusDigit = noFaktur && noFaktur.length >= 4 ? noFaktur.substring(2, 4) : '00';
            const statusFaktur = statusDigit === '00' ? 'Normal' : `Pengganti ${parseInt(statusDigit)}`;
            
            const masaPajak = tanggalFaktur && tanggalFaktur.includes('-') 
                ? tanggalFaktur.split('-').slice(0, 2).join('-')
                : null;
            
            let noFakturNormal = null;
            if (statusDigit !== '00') {
                noFakturNormal = noFaktur.substring(0, 2) + '00' + noFaktur.substring(4);
            }
            
            await new Promise((resolve, reject) => {
                db.run(
                    `UPDATE data_vatout SET status_faktur = ?, masa_pajak = ?, no_faktur_normal = ? WHERE no_faktur = ?`,
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

    console.log(`Migrasi selesai. Total: ${rows.length}, Updated: ${updatedCount}, Failed: ${failedCount}`);
    process.exit(0);
});
