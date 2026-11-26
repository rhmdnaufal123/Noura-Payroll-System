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

console.log('Impor POS, input bulanan & analisis tindakan');
{
  // modul halaman memakai NP.ui/NP.pages hanya saat dirender; stub minimal agar dapat dimuat di Node
  NP.ui = NP.ui || {};
  NP.pages = NP.pages || {};
  js('pos-import.js');
  js('bulk-input.js');
  js('analysis.js');
  const fx = require('./support/pos-fixture.js');
  const C = NP.C;
  const F = fx.build();
  const parsed = NP.pos.parseSheet(F.aoa);
  // master tindakan: semua produk fixture, sebagian membutuhkan bidan / dokter
  const services = fx.SERVICES.map(([name, cat, price], i) => ({
    id: 'TND-' + String(i + 1).padStart(4, '0'), code: 'TND-' + String(i + 1).padStart(4, '0'), name: name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), price, active: true, unit: 'APT',
    category: cat === 'HOMECARE' ? 'Homecare' : 'Dokter Umum & Bidan',
    shares: /SUNTIK KB/.test(name) ? [{ type: 'unit', target: 'APT', mode: 'nominal', value: 45000 }, { type: 'role', target: 'bidan', mode: 'nominal', value: 20000 }]
      : /^PEMERIKSAAN DOKTER$/.test(name) ? [{ type: 'unit', target: 'APT', mode: 'percent', value: 60 }, { type: 'role', target: 'dokter', mode: 'percent', value: 40 }]
      : [{ type: 'unit', target: 'APT', mode: 'remainder', value: 0 }],
    overrides: []
  }));
  const emps = [{ id: 'KRY-0001', name: 'dr. Contoh Dokter, M.Kes', position: 'Dokter Umum', status: 'aktif' }, { id: 'KRY-0002', name: 'Bd. Bidan Uji', position: 'Bidan', status: 'aktif' }];
  const roles = { dokter: [emps[0]], bidan: [emps[1]] };

  test('format tanggal POS "1 Okt 2026 pukul 08.06" & variasinya', () => {
    assert.strictEqual(NP.pos.parseDate('1 Okt 2026 pukul 08.06'), '2026-10-01');
    assert.strictEqual(NP.pos.parseDate('24 Agu 2026'), '2026-08-24');
    assert.strictEqual(NP.pos.parseDate('2026-12-05'), '2026-12-05');
    assert.strictEqual(NP.pos.parseDate('05/12/2026'), '2026-12-05');
    assert.strictEqual(NP.pos.parseDate(46296), '2026-10-01');
    assert.strictEqual(NP.pos.parseDate('bukan tanggal'), null);
  });
  test('membaca sheet Penjualan: periode, baris lanjutan struk mewarisi kode struk & pasien', () => {
    assert.strictEqual(parsed.kind, 'penjualan');
    assert.deepStrictEqual([parsed.meta.from, parsed.meta.to], ['2026-10-01', '2026-10-28']);
    const cont = parsed.lines.find((l, i) => i > 0 && parsed.lines[i - 1].ref === l.ref);
    assert.ok(cont && cont.ref && cont.date, 'baris lanjutan');
    const cats = NP.pos.categorySummary(parsed.lines);
    const db = cats.find((c) => c.category === 'DOKTER DAN BIDAN');
    const hc = cats.find((c) => c.category === 'HOMECARE');
    assert.deepStrictEqual([db.qty, db.total, hc.qty, hc.total], [47, 4817000, 5, 1510000]);
    assert.ok(db.service && hc.service && !cats.find((c) => c.category === 'ASAM LAMBUNG').service, 'obat tidak dianggap tindakan');
  });
  test('rencana impor: jumlah sama dengan file (52 tindakan, Rp6.327.000), obat diabaikan', () => {
    const P = NP.pos.plan(parsed.lines, services, emps, { defaults: { bidan: 'KRY-0002' }, roles });
    assert.deepStrictEqual(P.unmatched, []);
    assert.deepStrictEqual(P.problems, []);
    assert.strictEqual(P.transactions.length, F.expect.transactions);
    assert.strictEqual(u.sum(P.transactions, (t) => t.qty), 52);
    assert.strictEqual(u.sum(P.transactions, (t) => t.gross), 6327000);
    assert.ok(P.transactions.every((t) => /^POS:SIN-/.test(t.externalRef) && t.items.every((i) => !/KOMIX|PLANTACID/.test(i.serviceName))));
    const kb = P.transactions.find((t) => t.items.some((i) => i.serviceName === 'Suntik Kb'));
    assert.deepStrictEqual(kb.items.find((i) => i.serviceName === 'Suntik Kb').performers, { bidan: 'KRY-0002' });
    const dok = P.transactions.find((t) => t.items.some((i) => i.serviceName === 'Pemeriksaan Dokter'));
    if (dok.doctor) assert.deepStrictEqual(dok.items.find((i) => i.serviceName === 'Pemeriksaan Dokter').performers, { dokter: 'KRY-0001' }, 'kolom Dokter dicocokkan dengan nama karyawan (gelar diabaikan)');
    assert.strictEqual(P.transactions.filter((t) => t.patient).length, F.expect.withPatient);
  });
  test('rencana impor: tindakan tanpa master & pelaksana kosong dilaporkan', () => {
    const P = NP.pos.plan(parsed.lines, services.slice(2), emps, { roles: {} });
    assert.deepStrictEqual(P.unmatched.map((x) => [x.name, x.category, x.price, x.qty]), [['PAKET PEMERIKSAAN', 'Dokter Umum & Bidan', 100000, 5], ['PEMERIKSAAN ASAM URAT', 'Dokter Umum & Bidan', 28000, 4]]);
    assert.ok(P.problems.some((p) => /Bidan pelaksana/.test(p.msg)));
    const hc = NP.pos.plan(parsed.lines, [], emps, {}).unmatched.filter((x) => x.category === 'Homecare');
    assert.strictEqual(u.sum(hc, (x) => x.qty), 5);
  });
  test('kelompok analisis: Homecare, Dokter Umum & Bidan, Farmasi & Lainnya', () => {
    assert.strictEqual(C.serviceGroup('Homecare', 'Apa saja'), 'homecare');
    assert.strictEqual(C.serviceGroup('Tindakan medis', 'Infus Multivitamin HC'), 'homecare');
    assert.strictEqual(C.serviceGroup('Pemeriksaan laboratorium sederhana', 'Asam Urat'), 'dokter_bidan');
    assert.strictEqual(C.serviceGroup('Tindakan kebidanan', 'Suntik KB'), 'dokter_bidan');
    assert.strictEqual(C.serviceGroup('Penjualan produk', 'Masker'), 'lainnya');
    assert.ok(C.SERVICE_CATEGORIES.includes('Dokter Umum & Bidan') && C.SERVICE_CATEGORIES.includes('Homecare'));
  });
  test('homecare dihitung per kunjungan: 1 pasien banyak tindakan homecare = 1', () => {
    const hc = (name, qty) => ({ serviceName: name, category: 'Homecare', qty });
    const rows = [
      { t: { id: 'T1', date: '2026-10-07', patient: 'Ny. ASTRI ANI' }, it: hc('INFUS MULTIVITAMIN HC', 1) },
      { t: { id: 'T1', date: '2026-10-07', patient: 'Ny. ASTRI ANI' }, it: hc('PEMERIKSAAN DOKTER UMUM HC', 1) },
      { t: { id: 'T2', date: '2026-10-07', patient: 'NY.ASTRI ANI' }, it: hc('SUNTIK MULTIVITAMIN HC', 2) }, // struk lain, pasien & hari sama
      { t: { id: 'T3', date: '2026-10-12', patient: '' }, it: hc('INFUS MULTIVITAMIN HC', 1) }, // tanpa nama → per transaksi
      { t: { id: 'T4', date: '2026-10-12', patient: '-' }, it: hc('PAKET PEMERIKSAAN HC', 1) },
      { t: { id: 'T5', date: '2026-10-12', patient: 'Tn. Lain' }, it: { serviceName: 'Suntik KB', category: 'Dokter Umum & Bidan', qty: 3 } }
    ];
    assert.strictEqual(C.serviceCount(rows.slice(0, 3)), 1);
    assert.strictEqual(C.serviceCount(rows), 1 + 2 + 3);
    assert.strictEqual(C.visitKey(rows[0].t), C.visitKey(rows[2].t));
  });
  test('honor per tindakan / per pasien: homecare pasien yang sama pada hari yang sama dihitung 1', () => {
    js('service-income.js');
    const T = (id, date, patient, items) => ({ id, date, patient, status: 'active', items });
    const hc = (n) => ({ serviceName: n, category: 'Homecare', qty: 1, performers: { perawat: 'E1' } });
    const r = NP.income.performed([
      T('A', '2026-10-07', 'Ny. X', [hc('INFUS HC'), hc('PERIKSA HC')]),
      T('B', '2026-10-07', 'ny x', [hc('SUNTIK HC')]),
      T('C', '2026-10-08', '', [{ serviceName: 'Suntik KB', category: 'Tindakan kebidanan', qty: 2, performers: { perawat: 'E1' } }]),
      T('D', '2026-10-08', 'Tn. Y', [hc('INFUS HC')])
    ], 'E1', '2026-10-01', '2026-10-31');
    assert.deepStrictEqual(r, { patients: 3, actions: 4 });
  });
  test('pembagian: pelaksana opsional ke unit & jasa per kunjungan sekali per transaksi', () => {
    const emp = { B: { name: 'Jihan', position: 'Bidan' }, D: { name: 'dr. Uji', position: 'Dokter Umum' } };
    const kons = { unit: 'KLINIK', price: 100000, shares: [{ type: 'unit', target: 'KLINIK', mode: 'remainder', value: 0 }, { type: 'role', target: 'dokter', mode: 'nominal', value: 80000 }, { type: 'role', target: 'bidan', mode: 'nominal', value: 15000, optional: true }] };
    const a = rs.compute(kons, { performers: { dokter: 'D' }, employees: emp });
    assert.deepStrictEqual([a.errors, a.shares.map((x) => x.amount), a.total], [[], [5000, 80000, 0, 15000], 100000]);
    const b = rs.compute(kons, { performers: { dokter: 'D', bidan: 'B' }, employees: emp });
    assert.deepStrictEqual(b.shares.map((x) => x.amount), [5000, 80000, 15000]);
    assert.deepStrictEqual(rs.optionalRoles(kons), ['bidan']);
    const hc = { unit: 'KLINIK', price: 380000, shares: [{ type: 'unit', target: 'KLINIK', mode: 'remainder', value: 0 }, { type: 'role', target: 'bidan', mode: 'nominal', value: 100000, perVisit: true }] };
    const h1 = rs.compute(hc, { qty: 2, performers: { bidan: 'B' }, employees: emp });
    assert.deepStrictEqual([h1.shares[1].amount, h1.total, h1.paid], [100000, 760000, ['role:bidan']], 'jumlah 2 tetap sekali');
    const h2 = rs.compute(hc, { performers: { bidan: 'B' }, employees: emp, paid: h1.paid });
    assert.deepStrictEqual([h2.shares[1].amount, h2.total], [0, 380000], 'tindakan homecare kedua di kunjungan yang sama');
    assert.ok(rs.validateConfig({ unit: 'KLINIK', price: 1000, shares: [{ type: 'unit', target: 'KLINIK', mode: 'remainder', value: 0 }, { type: 'role', target: 'bidan', mode: 'percent', value: 10, perVisit: true }] }).errors.some((e) => /per kunjungan/.test(e)));
  });
  test('laporan jasa per bagian: konsultasi (resep), jasa tindakan, homecare per pelaksana', () => {
    js('service-income.js');
    const sh = (id, name, cat, amount) => ({ type: 'role', recipientId: id, recipientName: name, category: cat, amount });
    const trxs = [
      { id: 'T1', date: '2026-10-01', status: 'active', externalRef: 'RESEP:Resep/RX-1', patient: 'Tn. A', items: [{ serviceName: 'Biaya Pemeriksaan Dokter', category: 'Pemeriksaan dokter', qty: 1, price: 100000, gross: 100000, performerNames: { dokter: 'dr. X' }, shares: [sh('D', 'dr. X', 'dokter', 80000), sh('B', 'Jihan', 'bidan', 15000)] }] },
      { id: 'T2', date: '2026-10-01', status: 'active', externalRef: 'POS:SIN-1', patient: 'Tn. A', items: [{ serviceName: 'SUNTIK ASAM LAMBUNG', category: 'Dokter Umum & Bidan', qty: 1, price: 180000, gross: 180000, withDoctor: true, shares: [sh('D', 'dr. X', 'dokter', 25000), sh('B', 'Jihan', 'bidan', 25000)] }, { serviceName: 'PEMERIKSAAN DOKTER', category: 'Dokter Umum & Bidan', qty: 1, price: 100000, gross: 100000, shares: [] }] },
      { id: 'T3', date: '2026-10-07', status: 'active', externalRef: 'POS:SIN-2', patient: 'Ny. B', items: [{ serviceName: 'INFUS MULTIVITAMIN HC', category: 'Homecare', qty: 1, price: 380000, gross: 380000, shares: [sh('B', 'Jihan', 'bidan', 100000)] }, { serviceName: 'PEMERIKSAAN DOKTER UMUM HC', category: 'Homecare', qty: 1, price: 300000, gross: 300000, shares: [sh('D', 'dr. X', 'dokter', 300000)] }] },
      { id: 'T4', date: '2026-10-08', status: 'cancelled', items: [{ serviceName: 'SUNTIK KB', category: 'Dokter Umum & Bidan', qty: 1, price: 65000, gross: 65000, shares: [sh('B', 'Jihan', 'bidan', 15000)] }] }
    ];
    const R = NP.income.jasaReport(trxs, { start: '2026-10-01', end: '2026-10-31' });
    assert.deepStrictEqual(R.totals, { konsultasi: { D: 80000, B: 15000 }, jasa: { D: 25000, B: 25000 }, homecare: { D: 300000, B: 100000 } });
    assert.deepStrictEqual(R.grand, { D: 405000, B: 140000 });
    assert.deepStrictEqual([R.rows.konsultasi.length, R.rows.jasa.length, R.rows.homecare.length], [2, 1, 2], 'PEMERIKSAAN DOKTER yang dibayar di kasir masuk bagian konsultasi');
  });
  test('tabel bulanan: satu transaksi per tanggal terisi, maks. 50 tindakan per transaksi', () => {
    const svcMap = new Map(services.map((s) => [s.id, s]));
    const empMap = new Map(emps.map((e) => [e.id, e]));
    const rows = [
      { serviceId: services[0].id, price: 100000, performers: {}, q: { 1: 2, 15: 1 } },
      { serviceId: services[7].id, price: 65000, performers: { bidan: 'KRY-0002' }, q: { 1: 1, 3: 4 } }
    ];
    const r = NP.bulk.buildFromGrid('2026-10', rows, svcMap, empMap);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.list.map((t) => [t.date, t.items.map((i) => i.qty)]), [['2026-10-01', [2, 1]], ['2026-10-03', [4]], ['2026-10-15', [1]]]);
    const miss = NP.bulk.buildFromGrid('2026-10', [{ serviceId: services[7].id, price: 65000, performers: {}, q: { 2: 1 } }], svcMap, empMap);
    assert.ok(/Bidan/.test(miss.errors.join(' ')));
    assert.deepStrictEqual(NP.bulk.chunkItems(new Array(120).fill(0)).map((c) => c.length), [50, 50, 20]);
  });
  test('analisis: total per kelompok, per tindakan, per pelaksana & pasien sesuai data', () => {
    const P = NP.pos.plan(parsed.lines, services, emps, { defaults: { bidan: 'KRY-0002', dokter: 'KRY-0001' }, roles });
    const svcMap = new Map(services.map((s) => [s.id, s]));
    const empMap = new Map(emps.map((e) => [e.id, e]));
    const trxs = P.transactions.map((t, i) => ({ id: 'TRX-' + i, date: t.date, patient: t.patient, note: t.note, status: 'active', items: t.items.map((it) => {
      const s = svcMap.get(it.serviceId);
      const res = rs.compute(s, { price: it.price, qty: it.qty, performers: it.performers, employees: empMap });
      const performerNames = {};
      for (const [role, id] of Object.entries(it.performers)) performerNames[role] = empMap.get(id).name;
      return { serviceId: s.id, serviceName: s.name, category: s.category, unit: s.unit, qty: it.qty, price: it.price, gross: res.gross, performers: it.performers, performerNames, shares: res.shares };
    }) }));
    trxs.push({ id: 'TRX-X', date: '2026-10-05', patient: '', status: 'cancelled', items: trxs[0].items });
    const A = NP.analysis.build(trxs, { start: '2026-10-01', end: '2026-10-31', group: 'ALL' });
    assert.deepStrictEqual([A.total.qty, A.total.gross], [52, 6327000]);
    const g = Object.fromEntries(A.byGroup.map((x) => [x.key, [x.qty, x.gross]]));
    assert.deepStrictEqual(g, { dokter_bidan: [47, 4817000], homecare: [5, 1510000] });
    assert.deepStrictEqual([A.byService[0].name, A.byService[0].qty, A.byService[0].gross], ['Suntik Multivitamin', 8, 1760000]);
    const hc = NP.analysis.build(trxs, { start: '2026-10-01', end: '2026-10-31', group: 'homecare' });
    assert.deepStrictEqual([hc.total.qty, hc.total.gross, hc.byService.length], [5, 1510000, 4]);
    // homecare per kunjungan pasien (nama & tanggal, atau per struk bila tanpa nama)
    const visits = new Set();
    for (const t of trxs.filter((x) => x.status === 'active')) if (t.items.some((i) => i.category === 'Homecare')) visits.add(C.visitKey(t));
    const hcg = A.byGroup.find((x) => x.key === 'homecare');
    assert.deepStrictEqual([hcg.qty, hcg.count], [5, visits.size]);
    assert.strictEqual(A.total.count, 47 + visits.size);
    assert.strictEqual(u.sum(A.trend.series.homecare, (x) => x.qty), visits.size);
    const bidan = A.byPerformer.find((p) => p.key === 'KRY-0002');
    assert.deepStrictEqual([bidan.qty, bidan.fee], [2, 40000]);
    assert.strictEqual(A.byPatient.length, F.expect.withPatient);
    const q = NP.analysis.build(trxs, { start: '2026-10-01', end: '2026-10-31', q: 'suntik kb' });
    assert.strictEqual(q.total.qty, 2);
    assert.ok(A.trend.daily && A.trend.buckets.length === 31);

  });
}

console.log('Impor biaya dokter (penebusan resep)');
{
  js('resep-import.js');
  const rf = require('./support/resep-fixture.js');
  const pf = require('./support/pos-fixture.js');
  const RF = rf.build();
  const rx = NP.resep.parseSheet(RF.aoa);
  const kasir = NP.pos.parseSheet(pf.build().aoa).lines;
  const fee = { id: 'TND-0100', name: 'Pemeriksaan Dokter', category: 'Pemeriksaan dokter', unit: 'KLINIK', price: 100000, active: true, overrides: [], shares: [{ type: 'unit', target: 'KLINIK', mode: 'remainder', value: 0 }, { type: 'role', target: 'dokter', mode: 'percent', value: 70 }] };
  const emps = [{ id: 'KRY-0009', name: 'dr. Contoh Dokter, Sp.PD', position: 'Dokter Umum', status: 'aktif' }];
  const base = { doctors: new Set(['dr. Contoh Dokter']), docMap: { 'dr. Contoh Dokter': 'KRY-0009' }, service: fee, employees: emps, kasirLines: kasir, trxs: [] };

  test('membaca file Penebusan Resep: periode, kolom Service, baris produk lanjutan', () => {
    assert.strictEqual(rx.rows.length, RF.expect.rows);
    assert.deepStrictEqual([rx.meta.from, rx.meta.to], ['2026-10-01', '2026-10-28']);
    assert.deepStrictEqual([rx.rows[0].date, rx.rows[0].time, rx.rows[0].service, rx.rows[0].products.length], ['2026-10-01', '09:05', 100000, 2]);
    assert.deepStrictEqual(Object.fromEntries(NP.resep.doctorSummary(rx.rows).map((d) => [d.doctor, d.count])), RF.expect.doctors);
    assert.strictEqual(NP.resep.parseSheet(pf.build().aoa), null, 'file penjualan bukan file resep');
  });
  test('nama pasien dicocokkan tanpa sapaan, tanda baca & huruf besar/kecil', () => {
    const k = NP.resep.patientKey;
    assert.strictEqual(k('NY.PASIEN UJI 1'), k('Ny. PASIEN UJI 1'));
    assert.strictEqual(k('ny pasien uji 5'), k('Ny. PASIEN UJI 5'));
    assert.strictEqual(k('By. M.  MUJTABA'), 'M MUJTABA');
    assert.notStrictEqual(k('Tn. RICO'), k('Tn. RICO A'));
  });
  test('rencana: hanya dokter terpilih; Rp0 dilewati; service < Rp100.000 & pasien sama ditandai', () => {
    const P = NP.resep.plan(rx.rows, base);
    const E = RF.expect.main;
    assert.strictEqual(P.rows.length, E.rows, 'Puskesmas tidak ikut');
    assert.deepStrictEqual([P.stats.low, P.stats.zero, P.stats.kasir], [E.low, E.zero, E.kasir]);
    assert.strictEqual(P.transactions.length, E.importable);
    assert.strictEqual(u.sum(P.transactions, (t) => t.items[0].price), E.gross);
    assert.ok(P.transactions.every((t) => /^RESEP:Resep\/RXUJI-\d+$/.test(t.externalRef) && t.items[0].performers.dokter === 'KRY-0009' && t.items[0].serviceId === fee.id));
    const low = P.rows.find((x) => x.service === 50000);
    assert.ok(low.low && low.kasir.length === 1 && low.kasir[0].services.length > 0, 'struk kasir pasien yang sama memuat tindakan');
    assert.deepStrictEqual(P.blocking, []);
  });
  test('rencana: dokter belum dicocokkan → diblokir; biaya dokter sudah tercatat / sudah diimpor → tidak ikut', () => {
    const P1 = NP.resep.plan(rx.rows, Object.assign({}, base, { docMap: {} }));
    assert.ok(P1.blocking.length > 0 && /Dokter pelaksana belum dipilih/.test(P1.blocking[0].problems.join(' ')));
    const trxs = [
      { id: 'TRX-1', date: '2026-10-03', patient: 'NY. PASIEN UJI 3', status: 'active', items: [{ serviceId: fee.id, serviceName: fee.name, qty: 1 }] },
      { id: 'TRX-2', date: '2026-10-06', patient: 'x', status: 'active', externalRef: 'RESEP:Resep/RXUJI-4', items: [] }
    ];
    const P2 = NP.resep.plan(rx.rows, Object.assign({}, base, { trxs }));
    const p3 = P2.rows.find((x) => x.code === 'Resep/RXUJI-2');
    assert.ok(p3.db.length === 1 && p3.dbDoctorFee && !p3.include, 'biaya dokter pasien yang sama sudah ada → tidak dicentang');
    assert.ok(P2.rows.find((x) => x.code === 'Resep/RXUJI-4').already);
    assert.strictEqual(P2.transactions.length, RF.expect.main.importable - 2);
    const P3 = NP.resep.plan(rx.rows, Object.assign({}, base, { trxs, included: new Set(['Resep/RXUJI-2']) }));
    assert.strictEqual(P3.transactions.length, RF.expect.main.importable - 1, 'centang manual tetap dihormati');
  });
  test('indeks pemeriksaan dokter: database, file resep (service > 0), dan file kasir', () => {
    const idx = NP.resep.examIndex({
      trxs: [{ id: 'TRX-9', date: '2026-10-06', patient: 'TN. RESEP SATU', status: 'active', items: [{ serviceName: 'Pemeriksaan Dokter', category: 'Pemeriksaan dokter' }] }, { id: 'TRX-8', date: '2026-10-06', patient: 'Batal', status: 'cancelled', items: [{ serviceName: 'Pemeriksaan Dokter' }] }],
      resepRows: rx.rows,
      kasirLines: [{ ref: 'SIN-X', date: '2026-10-20', patient: 'Ny. Kasir', product: 'PEMERIKSAAN DOKTER UMUM HC' }, { ref: 'SIN-Y', date: '2026-10-20', patient: 'Ny. Obat', product: 'PARACETAMOL' }]
    });
    const has = (p, d) => (idx.get(NP.resep.patientKey(p) + '|' + d) || []).map((h) => h.src).sort();
    assert.deepStrictEqual(has('Tn. Resep Satu', '2026-10-06'), ['db', 'resep']);
    assert.deepStrictEqual(has('NY PASIEN UJI 1', '2026-10-01'), ['resep']);
    assert.deepStrictEqual(has('An. RESEP DUA', '2026-10-07'), [], 'resep Rp0 bukan pemeriksaan');
    assert.deepStrictEqual(has('Ny. Kasir', '2026-10-20'), ['kasir']);
    assert.deepStrictEqual(has('Ny. Obat', '2026-10-20'), []);
    assert.deepStrictEqual(has('Batal', '2026-10-06'), [], 'transaksi batal diabaikan');
  });
  test('impor POS: pasien yang juga diperiksa dokter → otomatis "dengan dokter", tetap dapat diubah manual', () => {
    const pfx = pf.build();
    const lines = NP.pos.parseSheet(pfx.aoa).lines;
    // semua tindakan memiliki varian dengan/tanpa dokter
    const svcs = pf.SERVICES.map(([name, cat, price], i) => ({
      id: 'V' + i, name, category: cat === 'HOMECARE' ? 'Homecare' : 'Dokter Umum & Bidan', unit: 'KLINIK', price, active: true, overrides: [],
      shares: [{ type: 'unit', target: 'KLINIK', mode: 'remainder', value: 0 }],
      doctorShares: [{ type: 'unit', target: 'KLINIK', mode: 'remainder', value: 0 }, { type: 'role', target: 'dokter', mode: 'percent', value: 10 }]
    }));
    const examIndex = NP.resep.examIndex({ resepRows: rx.rows, docMap: { 'dr. Contoh Dokter': 'KRY-0009' } });
    const opt = { defaults: { dokter: 'KRY-LAIN' }, roles: { dokter: emps }, doctorMode: 'exam', examIndex };
    const P = NP.pos.plan(lines, svcs, emps, opt);
    const byPatient = (n) => P.transactions.find((t) => t.patient === 'Ny. PASIEN UJI ' + n);
    // hari 1, 3, 5: pasien sama dengan resep ber-service → dengan dokter; pasien lain tanpa dokter
    for (const n of [1, 3, 5]) assert.ok(byPatient(n).items.every((i) => i.withDoctor && i.auto && i.examHits.some((h) => h.src === 'resep')), 'pasien ' + n);
    assert.ok(byPatient(7).items.every((i) => !i.withDoctor), 'pasien tanpa pemeriksaan dokter');
    assert.ok(P.transactions.filter((t) => !t.patient).every((t) => t.items.every((i) => !i.withDoctor || /PEMERIKSAAN DOKTER|struk/.test(JSON.stringify(i.examHits)))), 'tanpa nama pasien tidak dicocokkan');
    // dokter pelaksana = dokter yang memeriksa (dari resep), bukan dokter default
    const it = byPatient(1).items[0];
    assert.strictEqual(it.performers.dokter, 'KRY-0009');
    // ubahan manual menang atas otomatis
    const P2 = NP.pos.plan(lines, svcs, emps, Object.assign({}, opt, { wdOverride: new Map([[it.ovKey, false]]) }));
    const it2 = P2.transactions.find((t) => t.patient === 'Ny. PASIEN UJI 1').items[0];
    assert.ok(!it2.withDoctor && it2.manual && !('dokter' in it2.performers));
    // mode lain tetap tersedia
    const never = NP.pos.plan(lines, svcs, emps, Object.assign({}, opt, { doctorMode: 'never' }));
    assert.ok(never.transactions.every((t) => t.items.every((i) => !i.withDoctor)));
  });
  test('rencana resep: tindakan yang juga memberi bagian bidan memakai bidan pelaksana bawaan', () => {
    const feeB = Object.assign({}, fee, { shares: fee.shares.concat([{ type: 'role', target: 'bidan', mode: 'nominal', value: 10000 }]) });
    const P1 = NP.resep.plan(rx.rows, Object.assign({}, base, { service: feeB }));
    assert.ok(P1.blocking.length && /Bidan pelaksana belum dipilih — pilih di bagian 3/.test(P1.blocking[0].problems.join(' ')));
    const P2 = NP.resep.plan(rx.rows, Object.assign({}, base, { service: feeB, defaults: { bidan: 'KRY-0100' } }));
    assert.deepStrictEqual(P2.blocking, []);
    assert.ok(P2.transactions.every((t) => t.items[0].performers.bidan === 'KRY-0100' && t.items[0].performers.dokter === 'KRY-0009'));
  });
  test('saran tindakan: "Pemeriksaan Dokter" dipilih, versi Homecare tidak', () => {
    const list = [{ id: 'A', name: 'Pemeriksaan Dokter Umum HC', category: 'Homecare', price: 300000, active: true }, { id: 'B', name: 'Pemeriksaan Dokter', category: 'Dokter Umum & Bidan', price: 100000, active: true }, { id: 'C', name: 'Suntik KB', category: 'Tindakan kebidanan', price: 65000, active: true }];
    assert.strictEqual(NP.resep.suggestService(list).id, 'B');
    assert.strictEqual(NP.resep.suggestService(list.slice(2)), null);
  });
}

console.log('Jasa bidan homecare per kunjungan');
{
  js('homecare.js');
  const U = { type: 'unit', target: 'KLINIK', mode: 'remainder', value: 0 };
  const mk = (id, name, price, shares) => ({ id, code: id, name, category: 'Homecare', unit: 'KLINIK', price, active: true, shares, doctorShares: [], overrides: [] });
  const infus = mk('HC1', 'Infus Multivitamin HC', 380000, [U]);
  const paket = mk('HC2', 'Paket Pemeriksaan HC', 150000, [U, { type: 'role', target: 'bidan', mode: 'nominal', value: 30000 }]);
  const dokter = mk('HC3', 'Pemeriksaan Dokter Umum HC', 300000, [{ type: 'role', target: 'dokter', mode: 'nominal', value: 300000 }]);
  const murah = mk('HC4', 'Cek Gula HC', 60000, [U]);
  const kb = { id: 'KB', code: 'KB', name: 'Suntik KB', category: 'Dokter Umum & Bidan', unit: 'KLINIK', price: 65000, active: true, shares: [U, { type: 'role', target: 'bidan', mode: 'nominal', value: 15000 }], doctorShares: [], overrides: [] };
  const emps = new Map([['B1', { id: 'B1', name: 'Bidan Satu', position: 'Bidan' }], ['D1', { id: 'D1', name: 'dr. Satu', position: 'Dokter Umum' }]]);

  test('rencana aturan: tindakan HC diubah, khusus dokter dilewati, harga kurang ditolak', () => {
    const st = [infus, paket, dokter, murah].map((s) => NP.hc.planService(s, 100000).status);
    assert.deepStrictEqual(st, ['change', 'change', 'doctor', 'short']);
    const n = NP.hc.planService(paket, 100000).next;
    assert.deepStrictEqual(n.shares.filter((x) => x.type === 'role'), [{ type: 'role', target: 'bidan', mode: 'nominal', value: 100000, perVisit: true }], 'bagian bidan lama diganti');
    assert.strictEqual(NP.hc.planService(n, 100000).status, 'ok');
    assert.strictEqual(NP.hc.planService(n, 120000).status, 'change', 'nominal berbeda → diubah lagi');
    assert.strictEqual(NP.hc.planService(mk('HC5', 'PEMERIKSAAN DOKTER UMUM HC', 300000, [U]), 100000).status, 'doctor', 'dikenali dari nama');
    assert.ok(!NP.hc.isHomecare(kb) && NP.hc.isHomecare({ name: 'SUNTIK MULTIVITAMIN HC', category: 'Lainnya' }));
  });

  const ruledInfus = NP.hc.planService(infus, 100000).next;
  const ruledPaket = NP.hc.planService(paket, 100000).next;
  const services = [ruledInfus, ruledPaket, dokter, kb];
  const item = (svc, perf, paid, lineId) => {
    const r = rs.compute(svc, { price: svc.price, qty: 1, performers: perf, employees: emps, paid: [...paid] });
    assert.deepStrictEqual(r.errors, []);
    r.paid.forEach((k) => paid.add(k));
    return { lineId, serviceId: svc.id, serviceName: svc.name, category: svc.category, qty: 1, price: svc.price, withDoctor: false, performers: perf, shares: r.shares };
  };
  test('satu kunjungan dengan banyak tindakan HC: bidan dibayar sekali Rp100.000', () => {
    const paid = new Set();
    const items = [item(ruledInfus, { bidan: 'B1' }, paid), item(ruledPaket, { bidan: 'B1' }, paid), item(dokter, { dokter: 'D1' }, paid)];
    const sum = rs.summarize([].concat(...items.map((i) => i.shares)));
    assert.deepStrictEqual([sum.bidan, sum.dokter, sum.klinik], [100000, 300000, 380000 + 150000 - 100000]);
  });
  test('daftar kunjungan & draft terapkan: hanya tindakan HC berjasa bidan dihitung ulang', () => {
    const old = (svc, perf) => ({ lineId: 'L-' + svc.id, serviceId: svc.id, serviceName: svc.name, category: svc.category, qty: 1, price: svc.price, withDoctor: false, performers: perf, shares: rs.compute(svc, { price: svc.price, qty: 1, performers: perf, employees: emps }).shares });
    const tOld = { id: 'TRX-1', status: 'active', date: '2026-10-07', patient: 'Ny. Astri', items: [old(infus, {}), old(kb, { bidan: 'B1' }), old(dokter, { dokter: 'D1' })] };
    const paid = new Set();
    const tOk = { id: 'TRX-2', status: 'active', date: '2026-10-12', patient: 'Tn. Budi', items: [item(ruledInfus, { bidan: 'B1' }, paid, 'a'), item(ruledPaket, { bidan: 'B1' }, paid, 'b')] };
    const tDoc = { id: 'TRX-3', status: 'active', date: '2026-10-13', patient: 'An. C', items: [old(dokter, { dokter: 'D1' })] };
    const tOut = Object.assign({}, tOk, { id: 'TRX-4', date: '2026-11-01' });
    const tKb = { id: 'TRX-5', status: 'active', date: '2026-10-14', patient: 'Ny. D', items: [old(kb, { bidan: 'B1' })] };
    const V = NP.hc.visits([tOld, tOk, tDoc, tOut, tKb], services, { start: '2026-10-01', end: '2026-10-31', nominal: 100000 });
    assert.deepStrictEqual(V.map((v) => [v.t.id, v.status, v.bidanAmount]), [['TRX-1', 'fix', 0], ['TRX-2', 'ok', 100000], ['TRX-3', 'norule', 0]]);
    assert.strictEqual(V[0].bidanId, 'B1', 'bidan diambil dari tindakan lain di struk yang sama');
    const d = NP.hc.draftFor(tOld, 'B1', services, 100000);
    assert.deepStrictEqual(d.items.map((i) => [i.serviceId, i.lineId, i.performers.bidan || null]), [['HC1', undefined, 'B1'], ['KB', 'L-KB', 'B1'], ['HC3', 'L-HC3', null]]);
    // hasil simpan ulang: bidan 100.000 dari infus + 15.000 suntik KB, dokter tetap
    const p2 = new Set();
    const again = d.items.map((i) => (i.lineId ? tOld.items.find((x) => x.lineId === i.lineId) : item(services.find((s) => s.id === i.serviceId), i.performers, p2)));
    const V2 = NP.hc.visits([Object.assign({}, tOld, { items: again })], services, { nominal: 100000 });
    assert.deepStrictEqual([V2[0].status, V2[0].bidanAmount], ['ok', 100000]);
  });
  test('nominal jasa bidan diatur per tindakan: kunjungan memakai nominal tindakan pertama', () => {
    const paket80 = NP.hc.planService(paket, 80000).next;
    assert.deepStrictEqual([NP.hc.ruleValue(paket80), NP.hc.ruleValue(ruledInfus), NP.hc.ruleValue(paket)], [80000, 100000, 0]);
    const svc2 = [ruledInfus, paket80];
    const paid = new Set();
    const t = { id: 'TRX-9', status: 'active', date: '2026-10-20', items: [item(paket80, { bidan: 'B1' }, paid, 'p'), item(ruledInfus, { bidan: 'B1' }, paid, 'i')] };
    const V = NP.hc.visits([t], svc2, {});
    assert.deepStrictEqual([V[0].status, V[0].expected, V[0].bidanAmount], ['ok', 80000, 80000]);
    assert.strictEqual(NP.hc.planService(paket80, 80000).status, 'ok');
    assert.strictEqual(NP.hc.planService(paket80, 100000).status, 'change');
  });
}

console.log('Jadwal masuk');
{
  js('schedule.js');
  const S = NP.sched;
  const mk = (rules, extra) => {
    const s = S.blank('2026-02', 'KLINIK');
    s.config.employees = ['A', 'B', 'C', 'D', 'E'];
    s.config.rules = rules || {};
    return Object.assign(s, extra || {});
  };
  const dayCount = (asg, d, code) => Object.values(asg).filter((c) => c[d] === code).length;
  test('tanggal: "3, 10-12" ↔ [3,10,11,12]; jam shift malam melewati tengah malam', () => {
    assert.deepStrictEqual(S.parseDays('3, 10-12, 40, x', 28), [3, 10, 11, 12]);
    assert.strictEqual(S.fmtDays([3, 10, 11, 12, 20, 21]), '3, 10–12, 20, 21');
    assert.strictEqual(S.hours({ start: '21:00', end: '07:00' }), 10);
    assert.strictEqual(S.hours({ start: '07:00', end: '14:00' }), 7);
  });
  test('buat jadwal merata: kebutuhan P1+S1 terpenuhi setiap hari, beban kerja merata, ketentuan dipatuhi', () => {
    const s = mk({ A: { offDays: [0] }, B: { shifts: ['P'] }, C: { unavailable: [10, 11, 12] }, D: { maxRun: 3 }, E: { maxWeek: 3 } });
    const g = S.generate(s, { seed: 42 });
    assert.deepStrictEqual(g.warnings, []);
    for (let d = 1; d <= 28; d++) assert.deepStrictEqual([dayCount(g.assignments, d, 'P'), dayCount(g.assignments, d, 'S')], [1, 1], 'tanggal ' + d);
    s.assignments = g.assignments;
    const c = S.check(s);
    assert.strictEqual(c.short, 0);
    assert.strictEqual(c.issues, 0, JSON.stringify(Object.values(c.byEmp).map((x) => x.issues)));
    const works = s.config.employees.map((e) => c.byEmp[e].work);
    assert.ok(Math.max(...works) - Math.min(...works) <= 3, 'merata: ' + works);
    for (let d = 1; d <= 28; d++) if (S.weekday('2026-02', d) === 0) assert.strictEqual(g.assignments.A[d], 'L', 'A libur tiap Minggu');
    assert.ok(!Object.values(g.assignments.B).includes('S'), 'B hanya shift Pagi');
    assert.deepStrictEqual([10, 11, 12].map((d) => g.assignments.C[d]), ['L', 'L', 'L']);
  });
  test('acak: seed sama → hasil sama, seed berbeda → berbeda; mode acak penuh tetap mematuhi ketentuan', () => {
    const s = mk({ A: { offDays: [6, 0] } });
    assert.deepStrictEqual(S.generate(s, { seed: 7 }).assignments, S.generate(s, { seed: 7 }).assignments);
    assert.notDeepStrictEqual(S.generate(s, { seed: 7 }).assignments, S.generate(s, { seed: 8 }).assignments);
    const g = S.generate(s, { seed: 9, mode: 'random' });
    s.assignments = g.assignments;
    assert.strictEqual(S.check(s).issues, 0);
    assert.strictEqual(S.check(s).short, 0);
  });
  test('custom per hari: tanggal 14 butuh 3 Pagi, tanggal 15 tutup; isian manual dipertahankan', () => {
    const s = mk({}, {});
    s.config.days = { 14: { need: { P: 3 } }, 15: { closed: true } };
    s.assignments = { A: { 1: 'S' } };
    s.config.manual = { A: { 1: true } };
    const g = S.generate(s, { seed: 3 });
    assert.strictEqual(dayCount(g.assignments, 14, 'P'), 3);
    assert.strictEqual(dayCount(g.assignments, 14, 'S'), 1);
    assert.ok(Object.values(g.assignments).every((c) => c[15] === 'L'), 'tanggal tutup');
    assert.strictEqual(g.assignments.A[1], 'S', 'isian manual');
    assert.notStrictEqual(S.generate(s, { seed: 3, keepManual: false }).assignments.A[1], undefined);
  });
  test('kekurangan petugas dilaporkan; pelanggaran isian manual ditandai', () => {
    const s = mk({ A: { shifts: ['P'] }, B: { shifts: ['P'] }, C: { shifts: ['P'] }, D: { shifts: ['P'] }, E: { shifts: ['P'] } });
    const g = S.generate(s, { seed: 1 });
    assert.strictEqual(g.warnings.length, 28, 'tidak ada yang boleh shift Siang');
    assert.ok(g.warnings.every((w) => w.code === 'S' && w.missing === 1));
    s.assignments = g.assignments;
    const off = Object.keys(g.assignments).find((e) => g.assignments[e][2] === 'L');
    s.assignments[off][2] = 'S';
    const c = S.check(s);
    assert.ok(c.byEmp[off].issues.some((i) => i.day === 2 && /tidak diizinkan/.test(i.msg)));
    assert.strictEqual(c.short, 27);
  });
  test('minimal saat ada yang libur: Siang ideal 2 boleh 1 orang → tidak dianggap kurang', () => {
    const s = mk({ A: { offDays: [1] } });
    s.config.employees = ['A', 'B', 'C'];
    for (let w = 0; w < 7; w++) s.config.weekly[w] = { P: 1, S: 2 };
    const strict = S.generate(s, { seed: 5 });
    assert.ok(strict.warnings.length > 0, 'tanpa minimal: Senin kurang Siang');
    s.config.shifts[1].min = 1;
    const g = S.generate(s, { seed: 5 });
    assert.deepStrictEqual(g.warnings, []);
    s.assignments = g.assignments;
    const c = S.check(s);
    assert.strictEqual(c.short, 0);
    assert.ok(c.under > 0, 'Siang di bawah ideal tercatat sebagai "kurang dari ideal"');
    const mon = [2, 9, 16, 23];
    for (const d of mon) assert.deepStrictEqual([dayCount(g.assignments, d, 'P'), dayCount(g.assignments, d, 'S')], [1, 1], 'Senin ' + d);
  });
  test('pembagian per minggu 3 Pagi + 3 Siang dan libur maks. 2 hari per bulan', () => {
    const s = mk({ A: { quota: { P: 3, S: 3 } }, B: { maxOff: 2, maxWeek: 0, maxRun: 0 } });
    s.config.employees = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    for (let w = 0; w < 7; w++) s.config.weekly[w] = { P: 2, S: 2 };
    const g = S.generate(s, { seed: 11 });
    // minggu penuh di Februari 2026: 2–8, 9–15, 16–22
    for (const [a, b] of [[2, 8], [9, 15], [16, 22]]) {
      const w = [];
      for (let d = a; d <= b; d++) w.push(g.assignments.A[d]);
      assert.deepStrictEqual([w.filter((v) => v === 'P').length, w.filter((v) => v === 'S').length], [3, 3], 'minggu ' + a + '–' + b + ': ' + w.join(''));
    }
    const offB = Object.values(g.assignments.B).filter((v) => v === 'L').length;
    assert.ok(offB <= 2, 'B libur ' + offB + ' hari');
    s.assignments = g.assignments;
    const c = S.check(s);
    assert.deepStrictEqual([c.byEmp.A.issues, c.byEmp.B.issues], [[], []]);
    assert.strictEqual(c.short, 0);
    // pelanggaran ditandai bila diubah manual
    s.assignments.B = Object.assign({}, s.assignments.B, { 1: 'L', 2: 'L', 3: 'L' });
    s.assignments.A = Object.assign({}, s.assignments.A);
    for (let d = 2; d <= 5; d++) s.assignments.A[d] = 'P';
    const c2 = S.check(s);
    assert.ok(c2.byEmp.B.issues.some((i) => /libur lebih dari 2 hari/.test(i.msg)));
    assert.ok(c2.byEmp.A.issues.some((i) => /Pagi lebih dari 3 kali/.test(i.msg)));
    assert.ok(/per minggu 3× Pagi \+ 3× Siang/.test(S.describeRule(s, S.ruleOf(s, 'A'))));
    assert.ok(/libur maks\. 2 hari\/bulan/.test(S.describeRule(s, S.ruleOf(s, 'B'))));
  });
  test('validasi sebelum simpan: kode shift, tanggal di luar bulan, karyawan di luar jadwal', () => {
    const s = mk();
    assert.deepStrictEqual(S.validate(s), []);
    s.assignments = { A: { 29: 'P', 3: 'M' }, Z: { 1: 'P' } };
    s.config.shifts.push({ code: 'L', name: 'x', start: '07:00', end: '08:00' });
    const e = S.validate(s).join(' | ');
    assert.ok(/Kode shift "L"/.test(e) && /Tanggal 29/.test(e) && /Kode "M"/.test(e) && /Karyawan Z/.test(e), e);
    const p = S.payload(Object.assign(mk(), { assignments: { A: { 1: 'P', 2: '' }, Z: { 1: 'P' } } }));
    assert.deepStrictEqual(p.assignments, { A: { 1: 'P' } });
    assert.strictEqual(p.id, 'JDW-202602-KLINIK');
  });
}

console.log('\n' + passed + ' lulus, ' + failures.length + ' gagal');
if (failures.length) process.exit(1);
