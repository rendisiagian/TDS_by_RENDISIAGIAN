const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('c:\\laragon\\www\\TDS_by_RENDISIAGIAN\\tax_database.db');
db.all("PRAGMA table_info(master_cabang)", (err, rows) => {
    if (err) console.error(err);
    console.log(JSON.stringify(rows, null, 2));
});
