// Export utility - CSV and Excel
function exportTableData(tableId, filename, format, ignoreCols) {
    var table = document.getElementById(tableId);
    if (!table) return alert('Tabel tidak ditemukan.');
    
    // Default ignore parameter for backward compatibility
    if (typeof ignoreCols === 'undefined') {
        ignoreCols = [0, 1, 2]; // Legacy Dashboard: No (0), Aksi (1), Arsip PDF (2)
    }
    
    // Collect visible rows, skip filter row
    var rows = table.querySelectorAll('tr:not(.filter-row)');
    var data = [];
    
    rows.forEach(function(row) {
        if (row.style.display === 'none') return;
        var cols = row.querySelectorAll('th, td');
        var rowData = [];
        cols.forEach(function(col, i) {
            // Skip specified columns
            if (ignoreCols && ignoreCols.includes(i)) return;
            var text = col.innerText.replace(/\n/g, ' ').trim();
            rowData.push(text);
        });
        if (rowData.length > 0) data.push(rowData);
    });
    
    if (data.length === 0) return alert('Tidak ada data untuk diekspor.');
    
    if (format === 'csv') {
        var csv = data.map(function(row) {
            return row.map(function(cell) {
                return '"' + cell.replace(/"/g, '""') + '"';
            }).join(',');
        }).join('\n');
        
        var blob = new Blob(['\uFEFF' + csv], {type: 'text/csv;charset=utf-8;'});
        downloadBlob(blob, filename + '.csv');
    } else if (format === 'excel') {
        exportExcel(data, filename);
    }
}

function exportExcel(data, filename) {
    var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">';
    html += '<head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Data</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>';
    html += '<body><table border="1">';
    
    data.forEach(function(row, rowIdx) {
        html += '<tr>';
        row.forEach(function(cell) {
            var tag = rowIdx === 0 ? 'th' : 'td';
            var style = rowIdx === 0 ? 'background:#1e40af; color:white; font-weight:bold;' : '';
            // Force long numbers (>12 digits) as text to prevent Excel precision loss
            var isLongNumber = /^\d{12,}$/.test(cell.trim());
            if (isLongNumber && rowIdx > 0) {
                style += "mso-number-format:'\\@';";
            }
            html += '<' + tag + ' style="' + style + '">' + (isLongNumber && rowIdx > 0 ? "'" + cell : cell) + '</' + tag + '>';
        });
        html += '</tr>';
    });
    
    html += '</table></body></html>';
    
    var blob = new Blob([html], {type: 'application/vnd.ms-excel;charset=utf-8;'});
    downloadBlob(blob, filename + '.xls');
}

function downloadBlob(blob, filename) {
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}

// Show export menu dropdown
function showExportMenu(event, tableId, filenameBase, ignoreCols) {
    event.stopPropagation();
    
    // Remove existing menu
    var existing = document.getElementById('export-menu-dropdown');
    if (existing) existing.remove();
    
    var btn = event.currentTarget;
    var rect = btn.getBoundingClientRect();
    
    var menu = document.createElement('div');
    menu.id = 'export-menu-dropdown';
    menu.style.cssText = 'position:fixed; top:' + (rect.bottom + 4) + 'px; left:' + rect.left + 'px; background:var(--bg-primary); border:1px solid var(--border-color); border-radius:6px; box-shadow:0 8px 24px rgba(0,0,0,0.15); z-index:1000; min-width:160px; overflow:hidden;';
    
    var ignoreStr = (typeof ignoreCols !== 'undefined') ? JSON.stringify(ignoreCols) : 'undefined';

    menu.innerHTML = '<div style="padding:0.5rem; font-size:0.7rem; font-weight:700; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:0.5px;">Pilih Format</div>' +
        '<div onclick="exportTableData(\'' + tableId + '\', \'' + filenameBase + '\', \'csv\', ' + ignoreStr + ')" style="padding:0.625rem 0.75rem; cursor:pointer; font-size:0.85rem; font-weight:600; display:flex; align-items:center; gap:0.5rem; transition:background 0.15s;" onmouseover="this.style.background=\'var(--primary-50)\'" onmouseout="this.style.background=\'transparent\'"><span style="color:var(--success-600);">CSV</span> <span style="color:var(--text-tertiary); font-size:0.75rem;">(.csv)</span></div>' +
        '<div onclick="exportTableData(\'' + tableId + '\', \'' + filenameBase + '\', \'excel\', ' + ignoreStr + ')" style="padding:0.625rem 0.75rem; cursor:pointer; font-size:0.85rem; font-weight:600; display:flex; align-items:center; gap:0.5rem; transition:background 0.15s;" onmouseover="this.style.background=\'var(--primary-50)\'" onmouseout="this.style.background=\'transparent\'"><span style="color:var(--success-600);">Excel</span> <span style="color:var(--text-tertiary); font-size:0.75rem;">(.xls)</span></div>';
    
    document.body.appendChild(menu);
    
    // Close on click outside
    setTimeout(function() {
        document.addEventListener('click', function closeMenu() {
            var m = document.getElementById('export-menu-dropdown');
            if (m) m.remove();
            document.removeEventListener('click', closeMenu);
        });
    }, 10);
}
