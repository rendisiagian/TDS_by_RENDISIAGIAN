// Debug: lihat apa yang ada sebelum anchor
const fs = require('fs');
const path = require('path');

const bersihkanAngka = (str) => str ? parseFloat(str.replace(/\./g,'').replace(',','.')) || 0 : 0;

['Contoh 2022.txt'].forEach(f => {
    const raw = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const teks = raw.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');
    
    // Test sectionRe
    const sectionRe = /(?:Nama Barang Kena Pajak[^\n]*?)((?:\s|.)*?)(?=Harga Jual\s*\/\s*Penggantian|Dikurangi Potongan|$)/i;
    const sectionMatch = teks.match(sectionRe);
    const sect = sectionMatch ? sectionMatch[0] : teks;
    console.log('sect length:', sect.length);
    console.log('sect (first 200):', JSON.stringify(sect.substring(0, 200)));
    
    // Test anchor di sect
    const itemAnchorRe = /\b((?:\d{1,3}\.)*\d{1,3},\d{2})\s+Rp\s*((?:\d{1,3}\.)*\d{1,3})\s*x\s*(\d+)/g;
    let match, anchors = [];
    while ((match = itemAnchorRe.exec(sect)) !== null) {
        anchors.push({ idx: match.index, fullLen: match[0].length, total: match[1], harga: match[2], qty: match[3] });
        console.log('Anchor found:', JSON.stringify(match[0]), 'at idx', match.index);
    }
    console.log('anchors count:', anchors.length);
    
    if (anchors.length > 0) {
        const anchor = anchors[0];
        const block = sect.substring(0, anchor.idx).trim();
        console.log('block before anchor:', JSON.stringify(block));
        
        const escapedTotal = anchor.total.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const blockBefore = block.replace(new RegExp(escapedTotal + '$'), '').trim();
        console.log('blockBefore (after removing total from end):', JSON.stringify(blockBefore));
        
        const mItem = blockBefore.match(/^(\d+)\s+([\s\S]+)/);
        console.log('mItem match:', mItem ? [mItem[1], mItem[2].trim()] : 'NULL');
        
        // Try matching at end of blockBefore
        const mItemEnd = blockBefore.match(/(\d+)\s+([\s\S]+)$/);
        console.log('mItemEnd match:', mItemEnd ? [mItemEnd[1], mItemEnd[2].trim()] : 'NULL');
    }
});
