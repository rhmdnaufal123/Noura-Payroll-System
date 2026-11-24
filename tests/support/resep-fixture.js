/* File ekspor "Penebusan Resep" SINTETIS (format sama dengan aplikasi kasir) untuk pengujian.
 * Nama pasien fiktif. Beberapa pasien sengaja sama (nama & tanggal) dengan tests/support/pos-fixture.js
 * — dengan penulisan sapaan berbeda — agar pencocokan pasien teruji. */
'use strict';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const pad = (n) => String(n).padStart(2, '0');

/**
 * @returns {{ aoa:any[][], expect:object }}
 * Resep (dokter, pasien, tanggal, service):
 *  - dr. Contoh Dokter: 7 resep → 5 × Rp100.000, 1 × Rp50.000 (di bawah 100rb), 1 × Rp0
 *    3 di antaranya pasien yang sama dengan file kasir (hari 1, 3, 5)
 *  - Puskesmas Contoh: 2 resep (Rp0 & Rp25.000) — dokter luar
 */
function build(opt) {
  opt = opt || {};
  const year = opt.year || 2026;
  const month = opt.month || 10;
  const doctor = opt.doctor || 'dr. Contoh Dokter';
  const d = (day, hh, mm) => pad(day) + '/' + pad(month) + '/' + year + ' ' + pad(hh) + ':' + pad(mm);
  const RX = [
    [d(1, 9, 5), 'NY.PASIEN UJI 1', doctor, 100000, ['PARACETAMOL 500', 'AMOXICILLIN 500']], // sama dg kasir hari 1
    [d(3, 10, 0), 'Ny. Pasien Uji 3', doctor, 100000, ['CETIRIZINE']], // sama dg kasir hari 3
    [d(5, 11, 30), 'ny pasien uji 5', doctor, 50000, ['ANTASIDA']], // sama dg kasir hari 5 + di bawah 100rb
    [d(6, 13, 0), 'Tn. RESEP SATU', doctor, 100000, ['VITAMIN C']],
    [d(7, 14, 0), 'An. RESEP DUA', doctor, 0, ['SIRUP DEMAM']], // Rp0
    [d(9, 15, 0), 'Nn. RESEP TIGA', doctor, 100000, ['SALEP']],
    [d(10, 16, 0), 'By. RESEP EMPAT', doctor, 100000, ['TETES MATA']],
    [d(11, 8, 0), 'Ny. LUAR SATU', 'Puskesmas Contoh', 0, ['OBAT LUAR']],
    [d(12, 8, 30), 'Tn. LUAR DUA', 'Puskesmas Contoh', 25000, ['OBAT LUAR 2']]
  ];
  const aoa = [['Penebusan Resep'], ['-'.repeat(48)], ['Nama Outlet', null, null, ':  Apotek Uji '], ['ID Outlet', null, null, ':  apotekuji'], ['Di-export Pada Tanggal', null, null, ': 25 Nov 2026 pukul 06.16'], ['Filter Aktif '], ['- Status', null, null, ': Semua Resep'], ['- Dokter', null, null, ': Semua Dokter'],
    ['- Dari Tanggal ', null, null, ': 1 ' + MON[month - 1] + ' ' + year + ' pukul 00.00'], ['- Hingga Tanggal ', null, null, ': 28 ' + MON[month - 1] + ' ' + year + ' pukul 23.59'], [],
    ['No.', 'Tanggal Input', 'Nama/Kode Resep', 'Nama Pasien', 'Nama Dokter', 'Petugas', 'Produk', null, null, null, null, 'Racikan', null, null, null, 'Status', 'Embalase', 'Service', 'Harga Total'],
    [null, null, null, null, null, null, 'Nama', 'Kuantitas', 'Satuan', 'Harga Jual', 'Subtotal', 'Nama', 'Kuantitas', 'Satuan', 'Subtotal', null, null, null, null]];
  RX.forEach(([date, patient, doc, service, products], i) => {
    const total = service + 20000 + products.length * 10000;
    products.forEach((p, j) => {
      const row = new Array(19).fill(null);
      Object.assign(row, { 6: p, 7: 1, 8: 'Strip', 9: 10000, 10: 10000 });
      if (j === 0) Object.assign(row, { 0: i + 1, 1: date, 2: 'Resep/RXUJI-' + (i + 1), 3: patient, 4: doc, 5: '-', 15: 'closed', 16: 20000, 17: service, 18: total });
      aoa.push(row);
    });
  });
  return {
    aoa,
    expect: {
      rows: RX.length,
      doctors: { [doctor]: 7, 'Puskesmas Contoh': 2 },
      main: { rows: 7, importable: 6, gross: 550000, low: 2, zero: 1, kasir: 3 }
    }
  };
}

function writeXlsx(XLSX, file, opt) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(build(opt).aoa), 'data');
  require('fs').writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return file;
}

module.exports = { build, writeXlsx };
