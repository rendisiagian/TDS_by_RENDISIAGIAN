const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('c:/laragon/www/TDS_by_RENDISIAGIAN/tax_database.db');

console.log("Memulai proses sinkronisasi masa_pajak faktur pengganti...");
db.run(`
    UPDATE data_vatin
    SET masa_pajak = (
        SELECT n.masa_pajak 
        FROM data_vatin n 
        WHERE n.entitas = data_vatin.entitas 
          AND n.status_faktur = 'Normal' 
          AND SUBSTR(n.no_faktur, 5) = SUBSTR(data_vatin.no_faktur, 5)
    )
    WHERE status_faktur != 'Normal'
      AND EXISTS (
          SELECT 1 
          FROM data_vatin n 
          WHERE n.entitas = data_vatin.entitas 
            AND n.status_faktur = 'Normal' 
            AND SUBSTR(n.no_faktur, 5) = SUBSTR(data_vatin.no_faktur, 5)
      )
`, function(err) {
    if (err) console.error("Error:", err.message);
    else console.log(`Sukses! Telah memperbaiki masa_pajak pada ${this.changes} faktur pengganti di database secara permanen.`);
    db.close();
});
