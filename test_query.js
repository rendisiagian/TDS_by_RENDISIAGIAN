const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('c:/laragon/www/TDS_by_RENDISIAGIAN/tax_database.db');

let baseSql = "FROM data_vatin d LEFT JOIN master_cabang c ON d.kode_cabang = c.kode_cabang WHERE d.entitas = ?";
let selectSql = `SELECT d.*, c.nama_cabang, strftime('%d-%m-%Y', d.tanggal_faktur) AS tanggal_format, strftime('%d-%m-%Y', d.tgl_tukar_faktur) AS tgl_tukar_format, d.status_faktur, COALESCE((SELECT masa_pajak FROM data_vatin n WHERE n.entitas = d.entitas AND n.status_faktur = 'Normal' AND SUBSTR(n.no_faktur, 5) = SUBSTR(d.no_faktur, 5)), d.masa_pajak) AS masa_pajak, d.no_faktur_normal ${baseSql} ORDER BY CAST(SUBSTR(d.no_invoice_internal, 1, MAX(1, INSTR(d.no_invoice_internal, '/') - 1)) AS INTEGER) ASC, d.waktu_input DESC LIMIT 10`;

db.all(selectSql, ['BBS'], (err, rows) => {
    if (err) console.error("Error SQL 1:", err.message);
    else console.log("OK 1, rows:", rows.length);
    
    const sqlAll = `SELECT no_faktur, no_faktur_normal, status_faktur, tgl_tukar_faktur, tanggal_faktur, ppn, waktu_input, COALESCE((SELECT masa_pajak FROM data_vatin n WHERE n.entitas = data_vatin.entitas AND n.status_faktur = 'Normal' AND SUBSTR(n.no_faktur, 5) = SUBSTR(data_vatin.no_faktur, 5)), masa_pajak) AS masa_pajak FROM data_vatin WHERE entitas = ?`;

    db.all(sqlAll, ['BBS'], (err, rows) => {
        if (err) console.error("Error SQL 2:", err.message);
        else console.log("OK 2, rows:", rows.length);
        db.close();
    });
});
