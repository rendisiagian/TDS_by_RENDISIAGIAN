// Test Script: Smart Master Data Update Logic
// Jalankan dengan: node debug_samples/test_smart_master.js

const fs = require('fs');
const path = require('path');

// Mock database functions untuk testing
let mockDB = {
    master_client: [],
    master_vendor: []
};

function mockDbGet(query, params) {
    const table = query.match(/FROM (\w+)/)[1];
    const npwp = params[0];
    return Promise.resolve(mockDB[table].find(row => row.npwp === npwp));
}

function mockDbRun(query, params) {
    const table = query.match(/INTO (\w+)/)[1];
    const [npwp, nama, alamat, format_tipe, tanggal_terakhir] = params;

    const existingIndex = mockDB[table].findIndex(row => row.npwp === npwp);
    if (existingIndex >= 0) {
        mockDB[table][existingIndex] = { npwp, nama, alamat, format_tipe, tanggal_terakhir };
    } else {
        mockDB[table].push({ npwp, nama, alamat, format_tipe, tanggal_terakhir });
    }
    return Promise.resolve();
}

// Helper function untuk update master data dengan logic cerdas (salinan dari app.js)
async function updateMasterData(tableName, npwp, nama, alamat, formatTipe, tanggalFaktur) {
    if (!npwp) return;

    // Cek apakah data sudah ada
    const existing = await mockDbGet(`SELECT format_tipe, tanggal_terakhir FROM ${tableName} WHERE npwp = ?`, [npwp]);

    if (existing) {
        // Jika format berbeda, jangan replace
        if (existing.format_tipe !== formatTipe) {
            console.log(`❌ SKIP: Format berbeda (${existing.format_tipe} vs ${formatTipe}) untuk NPWP ${npwp}`);
            return;
        }

        // Jika format sama tapi tanggal faktur tidak lebih baru, jangan replace
        if (tanggalFaktur <= existing.tanggal_terakhir) {
            console.log(`❌ SKIP: Tanggal tidak lebih baru (${tanggalFaktur} <= ${existing.tanggal_terakhir}) untuk NPWP ${npwp}`);
            return;
        }
    }

    // Insert atau replace dengan data baru
    await mockDbRun(`INSERT OR REPLACE INTO ${tableName} (npwp, nama, alamat, format_tipe, tanggal_terakhir) VALUES (?, ?, ?, ?, ?)`,
        [npwp, nama, alamat, formatTipe, tanggalFaktur]);

    console.log(`✅ ${existing ? 'UPDATE' : 'INSERT'}: ${tableName} - ${npwp} (${formatTipe}) - ${nama} - ${tanggalFaktur}`);
}

// Test Cases
async function runTests() {
    console.log('='.repeat(80));
    console.log('🧪 TEST SMART MASTER DATA UPDATE LOGIC');
    console.log('='.repeat(80));

    // Test Case 1: Insert baru
    console.log('\n📝 Test Case 1: Insert Data Baru');
    await updateMasterData('master_client', '1234567890123456', 'PT ABC LEGACY', 'Jl A No 1', 'LEGACY', '2024-01-15');
    await updateMasterData('master_client', '9876543210987654', 'PT XYZ MODERN', 'Jl B No 2', 'MODERN', '2025-03-20');

    // Test Case 2: Update dengan format sama, tanggal lebih baru
    console.log('\n📝 Test Case 2: Update Format Sama, Tanggal Lebih Baru');
    await updateMasterData('master_client', '1234567890123456', 'PT ABC LEGACY UPDATED', 'Jl A No 1 Updated', 'LEGACY', '2024-06-10');

    // Test Case 3: Skip update format berbeda
    console.log('\n📝 Test Case 3: Skip Update Format Berbeda');
    await updateMasterData('master_client', '1234567890123456', 'PT ABC MODERN ATTEMPT', 'Jl A No 1 Modern', 'MODERN', '2025-01-01');

    // Test Case 4: Skip update tanggal sama atau lebih lama
    console.log('\n📝 Test Case 4: Skip Update Tanggal Sama/Lama');
    await updateMasterData('master_client', '1234567890123456', 'PT ABC OLD ATTEMPT', 'Jl A No 1 Old', 'LEGACY', '2024-03-01');
    await updateMasterData('master_client', '1234567890123456', 'PT ABC SAME DATE', 'Jl A No 1 Same', 'LEGACY', '2024-06-10');

    // Test Case 5: Update dengan tanggal lebih baru
    console.log('\n📝 Test Case 5: Update dengan Tanggal Lebih Baru');
    await updateMasterData('master_client', '1234567890123456', 'PT ABC NEWEST', 'Jl A No 1 Newest', 'LEGACY', '2024-12-01');

    // Test Case 6: Test dengan master_vendor
    console.log('\n📝 Test Case 6: Test dengan Master Vendor');
    await updateMasterData('master_vendor', '1111111111111111', 'PT VENDOR MODERN', 'Jl Vendor No 1', 'MODERN', '2025-01-15');
    await updateMasterData('master_vendor', '1111111111111111', 'PT VENDOR UPDATED', 'Jl Vendor No 1 Updated', 'MODERN', '2025-06-20');

    console.log('\n📊 FINAL STATE:');
    console.log('Master Client:', JSON.stringify(mockDB.master_client, null, 2));
    console.log('Master Vendor:', JSON.stringify(mockDB.master_vendor, null, 2));

    console.log('\n✅ Test selesai! Periksa output di atas untuk memverifikasi logic.');
}

// Jalankan test
runTests().catch(console.error);