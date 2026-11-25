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
    const bidan = A.byPerformer.find((p) => p.key === 'KRY-0002');
    assert.deepStrictEqual([bidan.qty, bidan.fee], [2, 40000]);
    assert.strictEqual(A.byPatient.length, F.expect.withPatient);
    const q = NP.analysis.build(trxs, { start: '2026-10-01', end: '2026-10-31', q: 'suntik kb' });
    assert.strictEqual(q.total.qty, 2);
    assert.ok(A.trend.daily && A.trend.buckets.length === 31);
    assert.strictEqual(u.sum(A.trend.series.homecare, (x) => x.qty), 5);
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
  test('saran tindakan: "Pemeriksaan Dokter" dipilih, versi Homecare tidak', () => {
    const list = [{ id: 'A', name: 'Pemeriksaan Dokter Umum HC', category: 'Homecare', price: 300000, active: true }, { id: 'B', name: 'Pemeriksaan Dokter', category: 'Dokter Umum & Bidan', price: 100000, active: true }, { id: 'C', name: 'Suntik KB', category: 'Tindakan kebidanan', price: 65000, active: true }];
    assert.strictEqual(NP.resep.suggestService(list).id, 'B');
    assert.strictEqual(NP.resep.suggestService(list.slice(2)), null);
  });
}

console.log('\n' + passed + ' lulus, ' + failures.length + ' gagal');
if (failures.length) process.exit(1);
