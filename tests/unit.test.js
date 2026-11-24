/* Uji unit logika murni: format uang, pembagian pendapatan, dan perhitungan gaji.
 * Jalankan: node tests/unit.test.js */
'use strict';
const path = require('path');
const assert = require('assert');
const js = (f) => require(path.join(__dirname, '..', 'js', f));
js('utils.js');
js('constants.js');
js('defaults.js');
js('revenue-sharing.js');
const NP = js('calculator.js');
const { u, rs, calc, defaults } = NP;

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failures.push(name);
    console.log('  ✗ ' + name + '\n    ' + e.message);
  }
}

console.log('Utilitas');
test('format rupiah konsisten', () => {
  assert.strictEqual(u.rp(28000), 'Rp28.000');
  assert.strictEqual(u.rp(1234567), 'Rp1.234.567');
  assert.strictEqual(u.rp(-5000), '-Rp5.000');
  assert.strictEqual(u.rp(0), 'Rp0');
});
test('parse rupiah', () => {
  assert.strictEqual(u.toInt('Rp28.000'), 28000);
  assert.strictEqual(u.toInt('1.250.000'), 1250000);
  assert.strictEqual(u.toInt(''), 0);
});
test('terbilang', () => {
  assert.strictEqual(u.terbilang(1550000), 'Satu juta lima ratus lima puluh ribu rupiah');
  assert.strictEqual(u.terbilang(11000), 'Sebelas ribu rupiah');
});
test('rentang bulan', () => {
  assert.deepStrictEqual(u.monthRange('2026-02'), { start: '2026-02-01', end: '2026-02-28' });
  assert.strictEqual(u.addMonths('2026-01', -1), '2025-12');
});

const emps = {
  B1: { id: 'B1', name: 'Bidan A', position: 'Bidan', unit: 'KLINIK' },
  B2: { id: 'B2', name: 'Bidan B', position: 'Bidan', unit: 'KLINIK' },
  D1: { id: 'D1', name: 'dr. A', position: 'Dokter Umum', unit: 'KLINIK' },
  N1: { id: 'N1', name: 'Ns. A', position: 'Perawat', unit: 'KLINIK' }
};
const gds = {
  id: 'TND-1', name: 'Pemeriksaan Gula Darah', unit: 'APT', price: 28000,
  shares: [
    { type: 'unit', target: 'APT', mode: 'nominal', value: 18000 },
    { type: 'role', target: 'bidan', mode: 'nominal', value: 10000 }
  ]
};

console.log('Pembagian pendapatan');
test('metode A nominal tetap (Gula darah Rp28.000)', () => {
  const r = rs.compute(gds, { qty: 1, performers: { bidan: 'B1' }, employees: emps });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.gross, 28000);
  assert.strictEqual(r.shares[0].amount, 18000);
  assert.strictEqual(r.shares[1].amount, 10000);
  assert.strictEqual(r.shares[1].recipientId, 'B1');
  assert.strictEqual(r.total, 28000);
});
test('perhitungan kuantitas (5 × Rp28.000)', () => {
  const r = rs.compute(gds, { qty: 5, performers: { bidan: 'B1' }, employees: emps });
  assert.strictEqual(r.gross, 140000);
  assert.strictEqual(r.shares[0].amount, 90000);
  assert.strictEqual(r.shares[1].amount, 50000);
});
test('metode B persentase 60/40', () => {
  const s = { name: 'Konsultasi', unit: 'KLINIK', price: 100000, shares: [{ type: 'unit', target: 'APT', mode: 'percent', value: 60 }, { type: 'role', target: 'dokter', mode: 'percent', value: 40 }] };
  const r = rs.compute(s, { performers: { dokter: 'D1' }, employees: emps });
  assert.strictEqual(r.shares[0].amount, 60000);
  assert.strictEqual(r.shares[1].amount, 40000);
  assert.strictEqual(rs.methodOf(s.shares), 'percent');
});
test('persentase dengan pembulatan tetap menjumlah tepat', () => {
  const s = { name: 'X', unit: 'APT', price: 10001, shares: [{ type: 'unit', target: 'APT', mode: 'percent', value: 33.3333 }, { type: 'role', target: 'dokter', mode: 'percent', value: 33.3333 }, { type: 'role', target: 'bidan', mode: 'percent', value: 33.3334 }] };
  const r = rs.compute(s, { performers: { dokter: 'D1', bidan: 'B1' }, employees: emps });
  assert.strictEqual(r.total, 10001);
  assert.strictEqual(r.unallocated, 0);
});
test('metode C kombinasi nominal + persen + sisa, lebih dari dua penerima', () => {
  const s = {
    name: 'Partus', unit: 'KLINIK', price: 1000000,
    shares: [
      { type: 'other', target: 'Lab Mitra', mode: 'nominal', value: 50000 },
      { type: 'role', target: 'bidan', mode: 'percent', value: 30 },
      { type: 'role', target: 'perawat', mode: 'percent', value: 10 },
      { type: 'unit', target: 'KLINIK', mode: 'remainder', value: 0 }
    ]
  };
  const r = rs.compute(s, { performers: { bidan: 'B2', perawat: 'N1' }, employees: emps });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.shares[0].amount, 50000);
  assert.strictEqual(r.shares[1].amount, 300000);
  assert.strictEqual(r.shares[2].amount, 100000);
  assert.strictEqual(r.shares[3].amount, 550000);
  assert.strictEqual(rs.methodOf(s.shares), 'combo');
  const sum = rs.summarize(r.shares);
  assert.strictEqual(sum.klinik, 550000);
  assert.strictEqual(sum.eksternal, 50000);
  assert.strictEqual(sum.bidan, 300000);
});
test('validasi: total pembagian melebihi harga ditolak', () => {
  const s = { name: 'X', unit: 'APT', price: 20000, shares: [{ type: 'unit', target: 'APT', mode: 'nominal', value: 15000 }, { type: 'role', target: 'bidan', mode: 'nominal', value: 10000 }] };
  const v = rs.validateConfig(s);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /melebihi/.test(e)));
});
test('validasi: persen > 100% ditolak', () => {
  const s = { name: 'X', unit: 'APT', price: 20000, shares: [{ type: 'unit', target: 'APT', mode: 'percent', value: 70 }, { type: 'role', target: 'bidan', mode: 'percent', value: 40 }] };
  assert.strictEqual(rs.validateConfig(s).ok, false);
});
test('peringatan & alokasi sisa bila pembagian kurang dari harga', () => {
  const s = { name: 'X', unit: 'APT', price: 30000, shares: [{ type: 'role', target: 'bidan', mode: 'nominal', value: 10000 }] };
  const r = rs.compute(s, { performers: { bidan: 'B1' }, employees: emps });
  assert.ok(r.warnings.length > 0);
  assert.strictEqual(r.total, 30000);
  assert.ok(r.shares.some((x) => x.implicit && x.amount === 20000 && x.category === 'apotek'));
});
test('petugas wajib dipilih', () => {
  const r = rs.compute(gds, { performers: {}, employees: emps });
  assert.ok(r.errors.some((e) => /Bidan/.test(e)));
});
test('pembagian khusus per petugas (override)', () => {
  const s = Object.assign({}, gds, { overrides: [{ employeeId: 'B2', shares: [{ type: 'unit', target: 'APT', mode: 'nominal', value: 16000 }, { type: 'role', target: 'bidan', mode: 'nominal', value: 12000 }] }] });
  const a = rs.compute(s, { performers: { bidan: 'B1' }, employees: emps });
  const b = rs.compute(s, { performers: { bidan: 'B2' }, employees: emps });
  assert.strictEqual(a.shares[1].amount, 10000);
  assert.strictEqual(b.shares[1].amount, 12000);
  assert.strictEqual(b.overrideFor, 'B2');
});
test('harga jual diubah saat transaksi: persen mengikuti harga baru', () => {
  const s = { name: 'K', unit: 'KLINIK', price: 100000, shares: [{ type: 'unit', target: 'APT', mode: 'percent', value: 60 }, { type: 'role', target: 'dokter', mode: 'percent', value: 40 }] };
  const r = rs.compute(s, { price: 150000, performers: { dokter: 'D1' }, employees: emps });
  assert.strictEqual(r.shares[1].amount, 60000);
});

console.log('Perhitungan gaji');
const settings = u.clone(defaults.DEFAULT_SETTINGS);
const comps = u.clone(defaults.DEFAULT_COMPONENTS);
function line(name, unitAmount, qty, unit) {
  return { serviceName: name, unitAmount, qty: qty || 1, amount: unitAmount * (qty || 1), unit: unit || 'APT' };
}
test('gaji tetap + tunjangan + potongan', () => {
  const emp = { id: 'K1', name: 'Kasir', position: 'Kasir', unit: 'APT', payScheme: 'monthly', baseSalary: 2500000, bpjsKes: true, bpjsTk: true, pph21: false };
  const r = calc.computeSlip(emp, { components: comps, settings, inputs: { workDays: 26, presentDays: 26, lateCount: 2, shifts: 10 } });
  const get = (code) => (r.earnings.find((e) => e.code === code) || r.deductions.find((d) => d.code === code) || {}).amount || 0;
  assert.strictEqual(get('BASE'), 2500000);
  assert.strictEqual(get('T_TRANSPORT'), 390000);
  assert.strictEqual(get('T_MAKAN'), 390000);
  assert.strictEqual(get('T_KEHADIRAN'), 0, 'terlambat => tunjangan kehadiran hangus');
  assert.strictEqual(get('T_SHIFT'), 200000);
  assert.strictEqual(get('POT_TELAT'), 50000);
  assert.strictEqual(get('BPJS_KES'), 25000);
  assert.strictEqual(get('BPJS_TK'), 75000);
  assert.strictEqual(r.totals.gross, 2500000 + 390000 + 390000 + 200000);
  assert.strictEqual(r.totals.net, r.totals.gross - 50000 - 25000 - 75000);
  assert.strictEqual(r.totals.fixed, 2500000);
});
test('bidan: gaji + honor tindakan otomatis Rp550.000', () => {
  const emp = { id: 'B1', name: 'Bidan A', position: 'Bidan', unit: 'KLINIK', payScheme: 'monthly_service', baseSalary: 2000000 };
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(line('Pemeriksaan gula darah', 10000));
  for (let i = 0; i < 15; i++) lines.push(line('Pemeriksaan asam urat', 10000));
  for (let i = 0; i < 10; i++) lines.push(line('Pemeriksaan kolesterol', 10000));
  const r = calc.computeSlip(emp, { components: comps, settings, inputs: {}, serviceLines: lines });
  const jasa = r.earnings.find((e) => e.code === 'JASA');
  assert.strictEqual(jasa.amount, 550000);
  assert.strictEqual(r.serviceDetail.length, 3);
  assert.strictEqual(r.serviceDetail[0].count, 30);
  assert.strictEqual(r.serviceDetail[0].amount, 300000);
  assert.strictEqual(r.totals.service, 550000);
});
test('dokter honor per sesi & per pasien', () => {
  const emp = { id: 'D1', name: 'dr', position: 'Dokter Umum', unit: 'KLINIK', payScheme: 'combination', baseSalary: 3000000, payConfig: { sessionRate: 150000, patientRate: 10000 } };
  const r = calc.computeSlip(emp, { components: comps, settings, inputs: { sessions: 20, patients: 120 } });
  assert.strictEqual(r.totals.practice, 20 * 150000 + 120 * 10000);
  assert.ok(r.earnings.find((e) => e.code === 'BASE'));
});
test('dokter honor per sesi tanpa gaji tetap', () => {
  const emp = { id: 'D2', name: 'dr', position: 'Dokter Umum', unit: 'KLINIK', payScheme: 'per_session', baseSalary: 5000000, payConfig: { sessionRate: 200000, patientRate: 99999 } };
  const r = calc.computeSlip(emp, { components: comps, settings, inputs: { sessions: 10, patients: 50 } });
  assert.strictEqual(r.totals.base, 0);
  assert.strictEqual(r.totals.practice, 2000000, 'tarif per pasien diabaikan pada skema per sesi');
});
test('perawat honor per shift', () => {
  const emp = { id: 'N1', name: 'Ns', position: 'Perawat', unit: 'KLINIK', payScheme: 'per_shift', payConfig: { shiftRate: 100000 } };
  const r = calc.computeSlip(emp, { components: comps, settings, inputs: { shifts: 22 } });
  assert.strictEqual(r.totals.practice, 2200000);
});
test('lembur otomatis base/173 × 1,5', () => {
  const emp = { id: 'X', position: 'Kasir', unit: 'APT', payScheme: 'monthly', baseSalary: 1730000 };
  const r = calc.computeSlip(emp, { components: comps, settings, inputs: { overtimeHours: 10 } });
  assert.strictEqual(r.totals.overtime, 150000);
});
test('bonus target penjualan bertingkat', () => {
  const emp = { id: 'X', position: 'Kasir', unit: 'APT', payScheme: 'monthly', baseSalary: 2000000 };
  const r = calc.computeSlip(emp, { components: comps, settings, inputs: { salesTarget: 100000000, salesActual: 112000000 } });
  assert.strictEqual(r.earnings.find((e) => e.code === 'BONUS_SALES').amount, 500000);
  const r2 = calc.computeSlip(emp, { components: comps, settings, inputs: { salesTarget: 100000000, salesActual: 90000000 } });
  assert.ok(!r2.earnings.find((e) => e.code === 'BONUS_SALES'));
});
test('bonus & potongan manual (kasbon)', () => {
  const emp = { id: 'X', position: 'Kasir', unit: 'APT', payScheme: 'monthly', baseSalary: 2000000 };
  const r = calc.computeSlip(emp, { components: comps, settings, inputs: { manual: { BONUS: 250000, KASBON: 300000, INSENTIF: 100000 } } });
  assert.strictEqual(r.totals.bonus, 250000);
  assert.strictEqual(r.totals.incentive, 100000);
  assert.strictEqual(r.deductions.find((d) => d.code === 'KASBON').amount, 300000);
});
test('potongan ketidakhadiran prorata', () => {
  const emp = { id: 'X', position: 'Kasir', unit: 'APT', payScheme: 'monthly', baseSalary: 2600000 };
  const r = calc.computeSlip(emp, { components: comps, settings, inputs: { workDays: 26, presentDays: 24, absentDays: 2 } });
  assert.strictEqual(r.deductions.find((d) => d.code === 'POT_ABSEN').amount, 200000);
});
test('PPh 21 progresif disetahunkan', () => {
  const emp = { id: 'X', position: 'Apoteker', unit: 'APT', payScheme: 'monthly', baseSalary: 10000000, pph21: true, ptkp: 'TK/0', componentOverrides: { T_JABATAN: { enabled: false }, T_KOMUNIKASI: { enabled: false }, T_TRANSPORT: { enabled: false }, T_MAKAN: { enabled: false }, T_KEHADIRAN: { enabled: false } } };
  const s2 = u.clone(settings);
  s2.tax.includeEmployerBpjs = false;
  const r = calc.computeSlip(emp, { components: comps, settings: s2, inputs: {} });
  // bruto 10jt, biaya jabatan 500rb, neto 9,5jt ×12 = 114jt − PTKP 54jt = 60jt -> 5% × 60jt = 3jt/th -> 250rb/bln
  assert.strictEqual(r.deductions.find((d) => d.code === 'PPH21').amount, 250000);
});
test('karyawan lintas unit: alokasi biaya tanpa penghitungan ganda', () => {
  const emp = { id: 'L', position: 'Petugas Administrasi', unit: 'LINTAS', costSplit: { APT: 60 }, payScheme: 'monthly', baseSalary: 3000000, componentOverrides: { T_TRANSPORT: { enabled: false }, T_MAKAN: { enabled: false }, T_KEHADIRAN: { enabled: false }, T_JABATAN: { enabled: false }, T_KOMUNIKASI: { enabled: false } } };
  const r = calc.computeSlip(emp, { components: comps, settings, inputs: {} });
  assert.strictEqual(r.totals.gross, 3000000);
  assert.strictEqual(r.allocation.APT.gross, 1800000);
  assert.strictEqual(r.allocation.KLINIK.gross, 1200000);
  assert.strictEqual(r.allocation.APT.gross + r.allocation.KLINIK.gross, r.totals.gross);
});
test('jasa dialokasikan ke unit sumber tindakan', () => {
  const emp = { id: 'L', position: 'Bidan', unit: 'KLINIK', payScheme: 'service_only' };
  const r = calc.computeSlip(emp, { components: comps.filter((c) => c.code === 'JASA'), settings, inputs: { presentDays: 0 }, serviceLines: [line('A', 10000, 1, 'APT'), line('B', 20000, 1, 'KLINIK')], adjustments: [{ trxId: 'T1', amount: -5000, unit: 'KLINIK' }] });
  assert.strictEqual(r.allocation.APT.gross, 10000);
  assert.strictEqual(r.allocation.KLINIK.gross, 15000);
  assert.strictEqual(r.totals.service, 25000);
});
test('komponen dinonaktifkan tidak dihitung', () => {
  const c2 = u.clone(comps);
  c2.find((c) => c.code === 'T_MAKAN').active = false;
  const emp = { id: 'X', position: 'Kasir', unit: 'APT', payScheme: 'monthly', baseSalary: 2000000 };
  const r = calc.computeSlip(emp, { components: c2, settings, inputs: {} });
  assert.ok(!r.earnings.find((e) => e.code === 'T_MAKAN'));
});

console.log('\n' + passed + ' lulus, ' + failures.length + ' gagal');
if (failures.length) process.exit(1);
