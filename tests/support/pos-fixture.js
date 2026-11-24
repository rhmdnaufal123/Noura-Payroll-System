/* File ekspor penjualan POS SINTETIS (format sama dengan ekspor aplikasi kasir apotek) untuk pengujian.
 * Nama pasien & nomor telepon fiktif. Jumlah tindakan meniru rekap Oktober 2026:
 * 16 tindakan, 52 kali, Rp6.327.000 — Dokter & Bidan 47 (Rp4.817.000), Homecare 5 (Rp1.510.000). */
'use strict';

const SERVICES = [
  ['PAKET PEMERIKSAAN', 'DOKTER DAN BIDAN', 100000, 5],
  ['PEMERIKSAAN ASAM URAT', 'DOKTER DAN BIDAN', 28000, 4],
  ['PEMERIKSAAN DOKTER', 'DOKTER DAN BIDAN', 100000, 1],
  ['PEMERIKSAAN GULA DARAH', 'DOKTER DAN BIDAN', 28000, 5],
  ['PEMERIKSAAN KOLESTROL', 'DOKTER DAN BIDAN', 50000, 1],
  ['SUNTIK ASAM LAMBUNG', 'DOKTER DAN BIDAN', 180000, 5],
  ['SUNTIK CEFTRIAXONE', 'DOKTER DAN BIDAN', 185000, 3],
  ['SUNTIK KB', 'DOKTER DAN BIDAN', 65000, 2],
  ['SUNTIK KELOID', 'DOKTER DAN BIDAN', 65000, 2],
  ['SUNTIK MULTIVITAMIN', 'DOKTER DAN BIDAN', 220000, 8],
  ['SURAT KETERANGAN SAKIT', 'DOKTER DAN BIDAN', 40000, 7],
  ['SURAT KETERANGAN SEHAT', 'DOKTER DAN BIDAN', 40000, 4],
  ['INFUS MULTIVITAMIN HC', 'HOMECARE', 380000, 2],
  ['PAKET PEMERIKSAAN HC', 'HOMECARE', 150000, 1],
  ['PEMERIKSAAN DOKTER UMUM HC', 'HOMECARE', 300000, 1],
  ['SUNTIK MULTIVITAMIN HC', 'HOMECARE', 300000, 1]
];
const DRUGS = [['KOMIX JERUK NIPIS', '', 3000, 'Sachet'], ['TEMPRA SYR 30ML', 'DEMAM ANAK (2 TAHUN+)', 33000, 'Botol'], ['PLANTACID FORTE TAB', 'ASAM LAMBUNG', 15000, 'Strip']];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const HEAD = ['No', 'Kode Struk', 'Kode Struk External', 'Tanggal', 'Nama Produk', 'Kategori Produk', 'Kode Shift/Sesi', 'Jumlah', 'Satuan', 'Harga Jual', 'Label Opsi Harga', 'Diskon', 'Sub-total', 'Diskon Faktur', 'Biaya Service', 'Biaya Embalase', 'Ongkos Kirim', 'Biaya Lainnya', 'Pembulatan', 'Total', 'Keuntungan', 'Metode Pembayaran', 'Kembalian', 'Kasir', 'Pelanggan', 'Kode Pelanggan', 'No. HP Pelanggan', 'Alamat Pelanggan', 'Kategori Pelanggan', 'Dokter', 'Salesperson/Pelayan', 'Kanal Penjualan', 'Catatan'];

/**
 * @param {object} opt { year, month (1-12), doctor: nama dokter pada struk berpasien }
 * @returns {{ aoa: any[][], expect: object }}
 */
function build(opt) {
  opt = opt || {};
  const year = opt.year || 2026;
  const month = opt.month || 10;
  const doctor = opt.doctor || 'dr. Contoh Dokter';
  const aoa = [['PENJUALAN'], ['-'.repeat(48)], ['Nama Outlet', null, null, ':  Apotek Uji '], ['ID Outlet', null, null, ':  apotekuji'],
    ['Dari Tanggal', null, null, ': 1 ' + MON[month - 1] + ' ' + year], ['Sampai Tanggal', null, null, ': 28 ' + MON[month - 1] + ' ' + year], ['Di-export Pada Tanggal', null, null, ': 24 Nov 2026 pukul 22.01'], ['-'.repeat(48)], [], HEAD];
  // daftar tindakan satu per satu, lalu dikelompokkan menjadi struk (sebagian struk berisi 2 tindakan)
  const units = [];
  for (const [name, cat, price, qty] of SERVICES) for (let i = 0; i < qty; i++) units.push({ name, cat, price });
  const receipts = [];
  let k = 0;
  while (k < units.length) {
    const take = k % 7 === 3 && k + 1 < units.length ? 2 : 1; // beberapa struk memuat dua tindakan
    receipts.push({ lines: units.slice(k, k + take).map((x) => Object.assign({ qty: 1 }, x)) });
    k += take;
  }
  // satu struk: tindakan dengan jumlah 2 (digabung dari dua baris yang sama)
  receipts.push({ lines: [], drugOnly: true });
  let no = 0;
  const struks = [];
  receipts.forEach((r, i) => {
    const day = (i % 28) + 1;
    const hh = 8 + (i % 12);
    const ref = 'SIN-' + String(year).slice(2) + String(month).padStart(2, '0') + String(day).padStart(2, '0') + '-' + String(100 + i);
    const withPatient = i % 2 === 0;
    const lines = r.drugOnly ? [{ name: DRUGS[0][0], cat: DRUGS[0][1], price: DRUGS[0][2], qty: 2, unit: DRUGS[0][3] }] : r.lines.slice();
    if (i % 5 === 1) lines.unshift({ name: DRUGS[2][0], cat: DRUGS[2][1], price: DRUGS[2][2], qty: 1, unit: DRUGS[2][3] }); // obat di baris utama, tindakan di baris lanjutan
    const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
    lines.forEach((l, j) => {
      const row = new Array(HEAD.length).fill(null);
      if (j === 0) {
        no++;
        Object.assign(row, { 0: no, 1: ref, 3: day + ' ' + MON[month - 1] + ' ' + year + ' pukul ' + String(hh).padStart(2, '0') + '.' + String((i * 7) % 60).padStart(2, '0'), 6: 'B-1', 13: 0, 14: 0, 15: 0, 16: 0, 17: 0, 18: 0, 19: total, 20: 0, 21: 'Uang Tunai (' + total + ')', 22: 0, 23: 'Apotek Uji', 24: withPatient ? 'Ny. PASIEN UJI ' + (i + 1) : '-', 26: withPatient ? '6281200000' + String(i).padStart(3, '0') : null, 29: withPatient ? doctor : '-', 30: '-', 31: 'Offline' });
      }
      Object.assign(row, { 4: l.name, 5: l.cat || null, 7: l.qty, 8: l.unit || 'Kali', 9: l.price, 12: l.qty * l.price });
      aoa.push(row);
    });
    struks.push({ ref, day, lines, withPatient });
  });
  const svcStruks = struks.filter((s) => s.lines.some((l) => SERVICES.some((x) => x[0] === l.name)));
  return {
    aoa,
    expect: {
      services: SERVICES.length,
      qty: 52, gross: 6327000,
      dokterBidan: { qty: 47, gross: 4817000 }, homecare: { qty: 5, gross: 1510000 },
      transactions: svcStruks.length,
      withPatient: svcStruks.filter((s) => s.withPatient).length
    },
    SERVICES
  };
}

/** Tulis fixture sebagai file .xlsx (butuh SheetJS). */
function writeXlsx(XLSX, file, opt) {
  const { aoa } = build(opt);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Penjualan');
  require('fs').writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return file;
}

module.exports = { build, writeXlsx, SERVICES };
