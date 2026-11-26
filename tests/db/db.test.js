/* Uji database Supabase (migrasi SQL, RLS, fungsi RPC) di PostgreSQL sungguhan.
 * Persiapan: PGDATABASE=noura_test tests/db/reset.sh
 * Jalankan : PGDATABASE=noura_test node tests/db/db.test.js   (butuh paket `pg`)
 * Setiap skenario berjalan sebagai role `authenticated` dengan klaim JWT, sama seperti
 * permintaan dari aplikasi melalui Supabase (PostgREST), sehingga RLS benar-benar diuji. */
'use strict';
const assert = require('assert');
const path = require('path');
const { Pool } = require('pg');
const js = (f) => require(path.join(__dirname, '..', '..', 'js', f));
js('utils.js');
js('constants.js');
const NP = js('revenue-sharing.js');

const pool = new Pool({ database: process.env.PGDATABASE || 'noura_test', user: process.env.PGUSER || require('os').userInfo().username, host: process.env.PGHOST || '/var/run/postgresql', max: 6 });
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failures.push(name);
    console.log('  ✗ ' + name + '\n    ' + (e.message || e));
  }
}

/** Jalankan fn sebagai pengguna (uid) atau anon (uid=null) dalam satu transaksi. */
async function as(uid, fn, opt) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(uid ? 'set local role authenticated' : 'set local role anon');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(uid ? { sub: uid, role: 'authenticated' } : { role: 'anon' })]);
    const r = await fn(c);
    await c.query(opt && opt.rollback ? 'rollback' : 'commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
const rpc = (c, fn, ...args) => c.query(`select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(', ')}) as r`, args).then((r) => r.rows[0].r);
async function rejects(p, re) {
  try {
    await p;
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error('Pesan error tidak sesuai: ' + e.message);
    return e;
  }
  throw new Error('Seharusnya ditolak');
}
const su = (sql, args) => pool.query(sql, args);
async function authUser(email, name) {
  const r = await su('insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id', [email, { full_name: name, role: 'admin' }]);
  return r.rows[0].id;
}
const today = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

(async () => {
  const U = {};
  console.log('Pengguna & hak akses');
  await test('pengguna pertama otomatis Administrator aktif; berikutnya viewer nonaktif (role metadata diabaikan)', async () => {
    U.admin = await authUser('admin@noura.test', 'Admin Utama');
    U.fin = await authUser('keuangan@noura.test', 'Admin Keuangan');
    U.ops = await authUser('operasional@noura.test', 'Admin Operasional');
    U.ops2 = await authUser('ops2@noura.test', 'Ops Dua');
    U.view = await authUser('viewer@noura.test', 'Viewer');
    const r = (await su('select email, role, active from public.users order by created_at, email')).rows;
    assert.deepStrictEqual(r.find((x) => x.email === 'admin@noura.test'), { email: 'admin@noura.test', role: 'admin', active: true });
    assert.deepStrictEqual(r.find((x) => x.email === 'keuangan@noura.test'), { email: 'keuangan@noura.test', role: 'viewer', active: false });
  });
  await test('pengguna nonaktif tidak dapat membaca data; anon ditolak', async () => {
    const n = await as(U.fin, (c) => c.query('select count(*)::int n from public.positions').then((r) => r.rows[0].n));
    assert.strictEqual(n, 0);
    await rejects(as(null, (c) => c.query('select * from public.positions')), /permission denied/);
  });
  await test('hanya admin dapat mengatur role pengguna', async () => {
    await rejects(as(U.fin, (c) => rpc(c, 'admin_update_user', U.fin, 'admin', true, 'X')), /Akses ditolak/);
    await as(U.admin, async (c) => {
      await rpc(c, 'admin_update_user', U.fin, 'finance', true, 'Admin Keuangan');
      await rpc(c, 'admin_update_user', U.ops, 'ops', true, 'Admin Operasional');
      await rpc(c, 'admin_update_user', U.ops2, 'ops', true, 'Ops Dua');
      await rpc(c, 'admin_update_user', U.view, 'viewer', true, 'Viewer');
    });
    await rejects(as(U.admin, (c) => rpc(c, 'admin_update_user', U.admin, 'viewer', true, 'X')), /administrator aktif/);
    await rejects(as(U.fin, (c) => c.query("update public.users set role = 'admin' where id = $1", [U.fin])), /permission denied/);
  });
  await test('data referensi seed terbaca pengguna aktif', async () => {
    const r = await as(U.view, (c) => c.query('select (select count(*) from public.positions)::int p, (select count(*) from public.salary_components)::int k, (select count(*) from public.business_units)::int u').then((x) => x.rows[0]));
    assert.deepStrictEqual(r, { p: 14, k: 23, u: 2 });
  });

  console.log('Karyawan');
  const E = {};
  const emp = (o) => Object.assign({ phone: '081200000000', startDate: '2024-01-01', status: 'aktif', payScheme: 'monthly', baseSalary: 2500000, bankName: 'BCA', bankAccount: '1234567890' }, o);
  await test('Admin Keuangan menambah karyawan lewat save_employee; viewer & ops ditolak', async () => {
    await as(U.fin, async (c) => {
      E.bidan = await rpc(c, 'save_employee', emp({ name: 'Bd. Uji Satu', unit: 'KLINIK', position: 'Bidan', department: 'Kebidanan', payScheme: 'monthly_service' }));
      E.bidan2 = await rpc(c, 'save_employee', emp({ name: 'Bd. Uji Dua', unit: 'KLINIK', position: 'Bidan', department: 'Kebidanan' }));
      E.dokter = await rpc(c, 'save_employee', emp({ name: 'dr. Uji', unit: 'KLINIK', position: 'Dokter Umum', department: 'Pelayanan Medis', payScheme: 'combination', payConfig: { sessionRate: 150000 } }));
      E.perawat = await rpc(c, 'save_employee', emp({ name: 'Ns. Uji', unit: 'KLINIK', position: 'Perawat', department: 'Keperawatan' }));
      E.kasir = await rpc(c, 'save_employee', emp({ name: 'Kasir Uji', unit: 'APT', position: 'Kasir', department: 'Kasir & Penjualan' }));
      E.lintas = await rpc(c, 'save_employee', emp({ name: 'Admin Lintas', unit: 'LINTAS', position: 'Petugas Administrasi', department: 'Administrasi', costSplit: { APT: 60 } }));
    });
    assert.ok(/^KRY-\d{4}$/.test(E.bidan), E.bidan);
    const l = (await su('select unit, primary_unit, cost_split_apt::int s from public.employees where id = $1', [E.lintas])).rows[0];
    assert.deepStrictEqual(l, { unit: 'LINTAS', primary_unit: 'APT', s: 60 });
    await rejects(as(U.view, (c) => rpc(c, 'save_employee', emp({ name: 'Tidak Boleh', unit: 'APT', position: 'Kasir', department: 'Kasir & Penjualan' }))), /Akses ditolak/);
    await rejects(as(U.ops, (c) => rpc(c, 'save_employee', emp({ name: 'Tidak Boleh', unit: 'APT', position: 'Kasir', department: 'Kasir & Penjualan' }))), /Akses ditolak/);
  });
  await test('constraint menolak data tidak valid (telepon, rekening)', async () => {
    await rejects(as(U.fin, (c) => rpc(c, 'save_employee', emp({ name: 'Salah Telp', unit: 'APT', position: 'Kasir', department: 'Kasir & Penjualan', phone: 'abc' }))), /employees_phone_check/);
    await rejects(as(U.fin, (c) => rpc(c, 'save_employee', emp({ name: 'Salah Rek', unit: 'APT', position: 'Kasir', department: 'Kasir & Penjualan', bankAccount: 'ABC' }))), /account_number/);
  });
  await test('rekening hanya terlihat admin & keuangan; tulis langsung ke tabel karyawan ditolak', async () => {
    const ops = await as(U.ops, (c) => c.query('select count(*)::int n from public.employee_bank_accounts').then((r) => r.rows[0].n));
    const fin = await as(U.fin, (c) => c.query('select count(*)::int n from public.employee_bank_accounts').then((r) => r.rows[0].n));
    assert.strictEqual(ops, 0);
    assert.ok(fin >= 6);
    await rejects(as(U.admin, (c) => c.query("update public.employees set base_salary = 1 where id = $1", [E.kasir])), /permission denied/);
  });
  await test('audit log tidak menyimpan nomor rekening', async () => {
    const r = (await su("select count(*)::int n from public.audit_logs where entity = 'employee_bank_accounts' and (coalesce(old_data,'{}') ? 'account_number' or coalesce(new_data,'{}') ? 'account_number')")).rows[0].n;
    assert.strictEqual(r, 0);
  });

  console.log('Master tindakan & pembagian pendapatan');
  const S = {};
  const R = (target, mode, value) => ({ type: 'role', target, mode, value });
  const Un = (target, mode, value) => ({ type: 'unit', target, mode, value });
  await test('save_service: hanya admin; validasi melebihi harga & persen > 100%', async () => {
    await as(U.admin, async (c) => {
      S.gula = await rpc(c, 'save_service', { name: 'Pemeriksaan Gula Darah', category: 'Pemeriksaan laboratorium sederhana', unit: 'APT', price: 28000, shares: [Un('APT', 'nominal', 18000), R('bidan', 'nominal', 10000)] });
      S.kons = await rpc(c, 'save_service', { name: 'Konsultasi Dokter Umum', category: 'Pemeriksaan dokter', unit: 'KLINIK', price: 100000, shares: [Un('APT', 'percent', 60), R('dokter', 'percent', 40)], overrides: [{ employeeId: E.dokter, shares: [Un('APT', 'percent', 50), R('dokter', 'percent', 50)] }] });
      S.partus = await rpc(c, 'save_service', { name: 'Persalinan Uji', category: 'Tindakan kebidanan', unit: 'KLINIK', price: 1000000, shares: [{ type: 'other', target: 'Lab Mitra', mode: 'nominal', value: 50000 }, R('bidan', 'percent', 30), R('perawat', 'percent', 10), Un('KLINIK', 'remainder', 0)] });
    });
    assert.ok(/^TND-\d{4}$/.test(S.gula));
    await rejects(as(U.fin, (c) => rpc(c, 'save_service', { name: 'X', category: 'Pelayanan lainnya', unit: 'APT', price: 1000, shares: [Un('APT', 'nominal', 1000)] })), /Akses ditolak/);
    await rejects(as(U.admin, (c) => rpc(c, 'save_service', { name: 'Melebihi', category: 'Pelayanan lainnya', unit: 'APT', price: 20000, shares: [Un('APT', 'nominal', 15000), R('bidan', 'nominal', 10000)] })), /melebihi harga jual/);
    await rejects(as(U.admin, (c) => rpc(c, 'save_service', { name: 'Persen', category: 'Pelayanan lainnya', unit: 'APT', price: 20000, shares: [Un('APT', 'percent', 70), R('bidan', 'percent', 40)] })), /melebihi 100%/);
    const n = (await su("select count(*)::int n from public.service_master where name in ('Melebihi','Persen')")).rows[0].n;
    assert.strictEqual(n, 0, 'penyimpanan gagal harus dibatalkan seluruhnya');
  });
  await test('hasil pembagian SQL identik dengan mesin JavaScript (300 konfigurasi acak)', async () => {
    const rnd = (() => {
      let s = 12345;
      return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    })();
    const c = await pool.connect();
    try {
      await c.query('begin');
      const emps = { [E.bidan]: { id: E.bidan, name: 'Bd. Uji Satu', position: 'Bidan' }, [E.dokter]: { id: E.dokter, name: 'dr. Uji', position: 'Dokter Umum' }, [E.perawat]: { id: E.perawat, name: 'Ns. Uji', position: 'Perawat' } };
      for (let n = 0; n < 300; n++) {
        const price = 1000 + Math.floor(rnd() * 2000000);
        const qty = 1 + Math.floor(rnd() * 5);
        const k = 1 + Math.floor(rnd() * 4);
        const roles = ['dokter', 'bidan', 'perawat'];
        const shares = [];
        let left = price;
        let pleft = 100;
        for (let i = 0; i < k; i++) {
          const kind = rnd();
          const tgt = i === 0 ? { type: 'unit', target: 'APT' } : { type: 'role', target: roles[i % 3] };
          if (kind < 0.35 && left > 0) {
            const v = Math.floor(rnd() * left * 0.6);
            left -= v;
            shares.push(Object.assign(tgt, { mode: 'nominal', value: v }));
          } else if (kind < 0.8 && pleft > 0) {
            const v = Math.round(rnd() * pleft * 0.7 * 10000) / 10000;
            pleft -= v;
            shares.push(Object.assign(tgt, { mode: 'percent', value: v }));
          } else shares.push(Object.assign(tgt, { mode: 'remainder', value: 0 }));
        }
        const svc = { name: 'P' + n, unit: n % 2 ? 'APT' : 'KLINIK', price, shares };
        const perf = { dokter: E.dokter, bidan: E.bidan, perawat: E.perawat };
        const jsr = NP.rs.compute(svc, { price, qty, performers: perf, employees: emps });
        await c.query('savepoint s');
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.admin })]);
        let sql;
        try {
          const id = (await c.query('select public.save_service($1) r', [{ name: 'Paritas ' + n, category: 'Pelayanan lainnya', unit: svc.unit, price, shares }])).rows[0].r;
          sql = (await c.query('select * from public.compute_allocations($1, $2, $3, $4)', [id, price, qty, perf])).rows;
        } catch (e) {
          sql = { error: e.message };
        }
        await c.query('rollback to savepoint s');
        if (jsr.errors.length) {
          assert.ok(sql.error, 'JS error tapi SQL sukses: ' + JSON.stringify(svc) + ' ' + jsr.errors);
          continue;
        }
        assert.ok(!sql.error, 'SQL error: ' + (sql.error || '') + ' ' + JSON.stringify(svc));
        assert.deepStrictEqual(sql.map((r) => [r.recipient_type, r.category, Number(r.unit_amount), Number(r.amount), r.is_implicit]), jsr.shares.map((s) => [s.type, s.category, s.unitAmount, s.amount, s.implicit]), JSON.stringify(svc));
      }
      await c.query('rollback');
    } finally {
      c.release();
    }
  });

  console.log('Transaksi tindakan');
  const T = {};
  await test('Admin Operasional input Gula Darah ×5 → Rp140.000 = Apotek Rp90.000 + Bidan Rp50.000', async () => {
    T.gula = await as(U.ops, (c) => rpc(c, 'create_service_transaction', { date: today(), patient: 'Pasien A', items: [{ serviceId: S.gula, qty: 5, price: 28000, performers: { bidan: E.bidan, dokter: E.dokter } }] }));
    assert.ok(/^TRX-\d{6}-\d{4}$/.test(T.gula));
    const a = (await su("select category, amount::int, recipient_employee_id from public.service_transaction_allocations where transaction_id = $1 order by sort_order", [T.gula])).rows;
    assert.deepStrictEqual(a, [{ category: 'apotek', amount: 90000, recipient_employee_id: null }, { category: 'bidan', amount: 50000, recipient_employee_id: E.bidan }]);
    const it = (await su('select performers, gross::int from public.service_transaction_items where transaction_id = $1', [T.gula])).rows[0];
    assert.deepStrictEqual(it.performers, { bidan: E.bidan }, 'peran yang tidak dipakai aturan tidak disimpan');
    assert.strictEqual(it.gross, 140000);
  });
  await test('pembagian khusus dokter & kombinasi 4 penerima', async () => {
    T.multi = await as(U.ops, (c) => rpc(c, 'create_service_transaction', { date: today(), items: [
      { serviceId: S.kons, qty: 1, price: 100000, performers: { dokter: E.dokter } },
      { serviceId: S.partus, qty: 1, price: 1000000, performers: { bidan: E.bidan2, perawat: E.perawat } }] }));
    const a = (await su("select i.line_no, a.category, a.amount::int from public.service_transaction_allocations a join public.service_transaction_items i on i.id = a.item_id where a.transaction_id = $1 order by i.line_no, a.sort_order", [T.multi])).rows;
    assert.deepStrictEqual(a.map((x) => x.amount), [50000, 50000, 50000, 300000, 100000, 550000]);
    const g = (await su('select gross::int from public.service_transactions where id = $1', [T.multi])).rows[0].gross;
    assert.strictEqual(g, 1100000);
  });
  await test('validasi: petugas wajib, tanggal masa depan, viewer tidak boleh input', async () => {
    await rejects(as(U.ops, (c) => rpc(c, 'create_service_transaction', { date: today(), items: [{ serviceId: S.gula, qty: 1, price: 28000, performers: {} }] })), /Bidan belum dipilih/);
    await rejects(as(U.ops, (c) => rpc(c, 'create_service_transaction', { date: '2999-01-01', items: [{ serviceId: S.gula, qty: 1, price: 28000, performers: { bidan: E.bidan } }] })), /melebihi hari ini/);
    await rejects(as(U.view, (c) => rpc(c, 'create_service_transaction', { date: today(), items: [{ serviceId: S.gula, qty: 1, price: 28000, performers: { bidan: E.bidan } }] })), /Akses ditolak/);
    await rejects(as(U.ops, (c) => c.query("insert into public.service_transactions (id, trx_date) values ('X', current_date)")), /permission denied/);
  });
  await test('ubah tarif master tidak mengubah item yang tidak diedit (snapshot historis)', async () => {
    await as(U.admin, (c) => rpc(c, 'save_service', { id: S.gula, name: 'Pemeriksaan Gula Darah', category: 'Pemeriksaan laboratorium sederhana', unit: 'APT', price: 35000, shares: [Un('APT', 'nominal', 23000), R('bidan', 'nominal', 12000)] }));
    const item = (await su('select id from public.service_transaction_items where transaction_id = $1', [T.gula])).rows[0].id;
    await as(U.ops, (c) => rpc(c, 'update_service_transaction', T.gula, { date: today(), patient: 'Pasien A (ubah nama)', items: [{ lineId: item, serviceId: S.gula, qty: 5, price: 28000, performers: { bidan: E.bidan } }] }, null));
    const r = (await su('select i.unit_price::int, (select sum(amount)::int from public.service_transaction_allocations where item_id = i.id and category = $2) bidan from public.service_transaction_items i where i.transaction_id = $1', [T.gula, 'bidan'])).rows[0];
    assert.deepStrictEqual(r, { unit_price: 28000, bidan: 50000 });
  });
  await test('Admin Operasional tidak dapat mengubah transaksi milik pengguna lain', async () => {
    await rejects(as(U.ops2, (c) => rpc(c, 'update_service_transaction', T.gula, { date: today(), items: [{ serviceId: S.gula, qty: 1, price: 35000, performers: { bidan: E.bidan } }] }, null)), /hanya dapat mengubah transaksi yang diinputnya/);
  });

  console.log('Penggajian');
  const P = {};
  const period = today().slice(0, 7);
  const range = { start: period + '-01', end: today() };
  async function shareRefs(empId) {
    return (await su("select a.id, a.amount::int from public.service_transaction_allocations a join public.service_transactions t on t.id = a.transaction_id where a.kind = 'share' and a.recipient_employee_id = $1 and t.status = 'active' and a.payroll_period_id is null", [empId])).rows;
  }
  function slip(empId, refs, extra) {
    const jasa = refs.reduce((s, r) => s + r.amount, 0);
    const earnings = [{ code: 'BASE', name: 'Gaji Pokok', group: 'base', amount: 2500000, fixed: true }].concat(jasa ? [{ code: 'JASA', name: 'Jasa Pelayanan', group: 'service', amount: jasa }] : []).concat((extra && extra.earnings) || []);
    const deductions = (extra && extra.deductions) || [{ code: 'BPJS_KES', name: 'BPJS Kesehatan', group: 'bpjs', amount: 25000 }];
    const gross = earnings.reduce((s, e) => s + e.amount, 0);
    const ded = deductions.reduce((s, e) => s + e.amount, 0);
    return { employeeId: empId, earnings, deductions, totals: { gross, deductions: ded, net: gross - ded }, serviceRefs: refs.map((r) => r.id), adjRefs: (extra && extra.adjRefs) || [] };
  }
  await test('draft: jasa terklaim atomik, slip bidan memuat jasa Rp50.000', async () => {
    const refs = await shareRefs(E.bidan);
    P.draft = await as(U.fin, (c) => rpc(c, 'payroll_save_draft', Object.assign({ period, payDate: range.end, slips: [slip(E.bidan, refs), slip(E.kasir, [])] }, range)));
    const st = (await su("select count(*)::int n from public.service_transaction_allocations where payroll_period_id = $1 and payroll_state = 'draft'", [P.draft])).rows[0].n;
    assert.strictEqual(st, refs.length);
    assert.ok(/^PAY-\d{6}-\d{2}$/.test(P.draft));
  });
  await test('slip dengan nilai jasa dimanipulasi ditolak & seluruh perubahan dibatalkan', async () => {
    const refs = await shareRefs(E.bidan2);
    const s = slip(E.bidan2, refs);
    s.earnings.find((e) => e.code === 'JASA').amount += 1000000;
    s.totals.gross += 1000000;
    s.totals.net += 1000000;
    await rejects(as(U.fin, (c) => rpc(c, 'payroll_save_draft', Object.assign({ period, slips: [s] }, range))), /tidak sama dengan jasa tercatat/);
    assert.strictEqual((await shareRefs(E.bidan2)).length, refs.length, 'klaim harus dibatalkan');
    assert.strictEqual((await su("select count(*)::int n from public.payroll_periods where id <> $1", [P.draft])).rows[0].n, 0);
  });
  await test('slip yang melewatkan jasa milik karyawan ditolak (tidak boleh ada jasa tertinggal)', async () => {
    await rejects(as(U.fin, (c) => rpc(c, 'payroll_save_draft', Object.assign({ period, slips: [slip(E.bidan2, [])] }, range))), /Ada jasa\/koreksi baru/);
  });
  await test('karyawan tidak dapat digaji dua kali pada periode beririsan; jasa tidak dapat diklaim ganda', async () => {
    await rejects(as(U.fin, (c) => rpc(c, 'payroll_save_draft', Object.assign({ period, slips: [slip(E.kasir, [])] }, range))), /periode yang beririsan/);
    const claimed = (await su("select id, amount::int from public.service_transaction_allocations where payroll_period_id = $1", [P.draft])).rows;
    await rejects(as(U.fin, (c) => rpc(c, 'payroll_save_draft', Object.assign({ period, slips: [slip(E.perawat, claimed.slice(0, 1))] }, range))), /berubah atau sudah diproses/);
  });
  await test('dua penyimpanan draft bersamaan untuk karyawan yang sama: hanya satu berhasil', async () => {
    const body = Object.assign({ period, slips: [slip(E.lintas, [])] }, range);
    const res = await Promise.allSettled([as(U.fin, (c) => rpc(c, 'payroll_save_draft', body)), as(U.admin, (c) => rpc(c, 'payroll_save_draft', body))]);
    assert.strictEqual(res.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(res.map((r) => r.status + (r.reason ? r.reason.message : ''))));
    const ok = res.find((r) => r.status === 'fulfilled').value;
    await as(U.fin, (c) => rpc(c, 'payroll_delete_draft', ok));
  });
  await test('Admin Operasional tidak dapat menggaji; viewer membaca rekap tapi tidak slip', async () => {
    await rejects(as(U.ops, (c) => rpc(c, 'payroll_approve', P.draft)), /Akses ditolak/);
    const ops = await as(U.ops, (c) => c.query('select count(*)::int n from public.payroll_records').then((r) => r.rows[0].n));
    assert.strictEqual(ops, 0);
    const v = await as(U.view, (c) => c.query('select count(*)::int n from public.payroll_records').then((r) => r.rows[0].n));
    assert.strictEqual(v, 2);
  });
  await test('ubah transaksi dalam draft → draft basi & tidak dapat disetujui sebelum dihitung ulang', async () => {
    await as(U.fin, (c) => rpc(c, 'update_service_transaction', T.gula, { date: today(), patient: 'Pasien A', items: [{ serviceId: S.gula, qty: 3, price: 35000, performers: { bidan: E.bidan } }] }, null));
    await rejects(as(U.fin, (c) => rpc(c, 'payroll_approve', P.draft)), /perlu dihitung ulang/);
    const refs = await shareRefs(E.bidan);
    assert.ok(refs.some((r) => r.amount === 36000), 'tarif baru Rp12.000 × 3 karena item diubah');
    await as(U.fin, (c) => rpc(c, 'payroll_save_draft', Object.assign({ id: P.draft, period, slips: [slip(E.bidan, refs), slip(E.kasir, [])] }, range)));
  });
  await test('setujui → nomor slip & payslips terbit; viewer tidak dapat membaca payslips', async () => {
    await as(U.fin, (c) => rpc(c, 'payroll_approve', P.draft));
    const r = (await su('select slip_no from public.payslips where period_id = $1 order by slip_no', [P.draft])).rows;
    assert.strictEqual(r.length, 2);
    assert.ok(r.every((x) => /^SLIP\/(APT|KLINIK)\/\d{4}\/\d{2}\/\d{4}$/.test(x.slip_no)), JSON.stringify(r));
    const v = await as(U.view, (c) => c.query('select count(*)::int n from public.payslips').then((x) => x.rows[0].n));
    assert.strictEqual(v, 0);
  });
  await test('transaksi dalam penggajian disetujui tidak dapat diubah', async () => {
    await rejects(as(U.fin, (c) => rpc(c, 'update_service_transaction', T.gula, { date: today(), items: [{ serviceId: S.gula, qty: 1, price: 35000, performers: { bidan: E.bidan } }] }, null)), /DISETUJUI/);
  });
  await test('kunci hanya oleh admin', async () => {
    await rejects(as(U.fin, (c) => rpc(c, 'payroll_lock', P.draft)), /Akses ditolak/);
    await as(U.admin, (c) => rpc(c, 'payroll_lock', P.draft));
    const st = (await su("select distinct payroll_state from public.service_transaction_allocations where payroll_period_id = $1", [P.draft])).rows.map((x) => x.payroll_state);
    assert.deepStrictEqual(st, ['locked']);
  });
  await test('koreksi transaksi terkunci: keuangan ditolak, admin wajib catatan, selisih jadi adjustment', async () => {
    const body = { date: today(), patient: 'Pasien A', items: [{ serviceId: S.gula, qty: 4, price: 35000, performers: { bidan: E.bidan } }] };
    await rejects(as(U.fin, (c) => rpc(c, 'update_service_transaction', T.gula, body, 'Koreksi jumlah')), /LOCKED/);
    await rejects(as(U.admin, (c) => rpc(c, 'update_service_transaction', T.gula, body, '')), /Catatan perubahan wajib/);
    await as(U.admin, (c) => rpc(c, 'update_service_transaction', T.gula, body, 'Koreksi jumlah pemeriksaan'));
    const adj = (await su("select amount::int, adj_kind, payroll_state from public.service_transaction_allocations where transaction_id = $1 and kind = 'adjustment'", [T.gula])).rows;
    assert.deepStrictEqual(adj, [{ amount: 12000, adj_kind: 'koreksi', payroll_state: null }]);
    const shares = (await su("select distinct payroll_state from public.service_transaction_allocations where transaction_id = $1 and kind = 'share' and recipient_employee_id is not null", [T.gula])).rows;
    assert.deepStrictEqual(shares, [{ payroll_state: 'locked' }]);
  });
  await test('pembatalan transaksi terkunci → adjustment negatif sebesar yang sudah dibayar', async () => {
    await as(U.admin, (c) => rpc(c, 'cancel_service_transaction', T.gula, 'Pasien batal', 'Otorisasi pembatalan'));
    const adj = (await su("select amount::int from public.service_transaction_allocations where transaction_id = $1 and kind = 'adjustment' order by created_at", [T.gula])).rows.map((x) => x.amount);
    assert.deepStrictEqual(adj, [12000, -48000]);
  });
  await test('penggajian berikutnya wajib memasukkan koreksi tertunda (−Rp36.000 bersih)', async () => {
    const adj = (await su("select id, amount::int from public.service_transaction_allocations where kind = 'adjustment' and recipient_employee_id = $1 and payroll_period_id is null", [E.bidan])).rows;
    const nextStart = new Date(new Date(range.end).getTime() + 86400000).toISOString().slice(0, 10);
    const s = slip(E.bidan, [], { earnings: [{ code: 'JASA_KOREKSI', name: 'Koreksi Jasa Pelayanan', group: 'service', amount: -36000 }], adjRefs: adj.map((a) => a.id) });
    await rejects(as(U.fin, (c) => rpc(c, 'payroll_save_draft', { period, start: nextStart, end: nextStart, slips: [slip(E.bidan, [])] })), /Ada jasa\/koreksi baru/);
    const id = await as(U.fin, (c) => rpc(c, 'payroll_save_draft', { period, start: nextStart, end: nextStart, slips: [s] }));
    await as(U.fin, (c) => rpc(c, 'payroll_delete_draft', id));
    assert.strictEqual((await su('select count(*)::int n from public.service_transaction_allocations where payroll_period_id = $1', [id])).rows[0].n, 0);
  });
  await test('catatan shift pada tanggal terkunci ditolak; buka kunci wajib catatan', async () => {
    await rejects(as(U.fin, (c) => c.query('insert into public.worklogs (employee_id, work_date, shifts) values ($1, $2, 1)', [E.bidan, range.start])), /penggajian terkunci/);
    await rejects(as(U.admin, (c) => rpc(c, 'payroll_unlock', P.draft, '')), /Catatan otorisasi/);
    await as(U.admin, (c) => rpc(c, 'payroll_unlock', P.draft, 'Perbaikan data'));
    await as(U.fin, (c) => rpc(c, 'payroll_revert', P.draft));
    assert.strictEqual((await su('select count(*)::int n from public.payslips where period_id = $1', [P.draft])).rows[0].n, 0);
    const keep = (await su('select count(*)::int n from public.payroll_records where period_id = $1 and slip_no is not null', [P.draft])).rows[0].n;
    assert.strictEqual(keep, 2, 'nomor slip dipertahankan saat kembali ke draft');
  });

  console.log('Audit log');
  await test('audit log tercatat, hanya admin yang dapat membaca, tidak dapat diubah/dihapus', async () => {
    const n = (await su("select count(*)::int n from public.audit_logs where action in ('trx.create','trx.correction','trx.cancel','payroll.approve','payroll.lock','payroll.unlock')")).rows[0].n;
    assert.ok(n >= 6, n);
    assert.strictEqual(await as(U.fin, (c) => c.query('select count(*)::int n from public.audit_logs').then((r) => r.rows[0].n)), 0);
    assert.ok((await as(U.admin, (c) => c.query('select count(*)::int n from public.audit_logs').then((r) => r.rows[0].n))) > 0);
    await rejects(as(U.admin, (c) => c.query('delete from public.audit_logs')), /permission denied/);
    await rejects(as(U.admin, (c) => c.query("update public.audit_logs set detail = 'x'")), /permission denied/);
    await as(U.ops, (c) => rpc(c, 'log_event', 'export.excel', 'report', 'R1', 'Ekspor laporan'));
    const ev = (await su("select username from public.audit_logs where action = 'app.export.excel'")).rows[0];
    assert.strictEqual(ev.username, 'operasional');
  });
  await test('fungsi internal tidak dapat dipanggil langsung oleh pengguna', async () => {
    await rejects(as(U.admin, (c) => c.query("select public._add_item('X', 1, '{}')")), /permission denied/);
    await rejects(as(U.admin, (c) => c.query("select public.next_counter('employee')")), /permission denied/);
  });

  console.log('Input bulanan & impor POS');
  await test('kategori Dokter Umum & Bidan dan Homecare diterima; kategori asing ditolak', async () => {
    await as(U.admin, async (c) => {
      S.suntik = await rpc(c, 'save_service', { name: 'Suntik Multivitamin', category: 'Dokter Umum & Bidan', unit: 'APT', price: 220000, shares: [Un('APT', 'nominal', 170000), R('bidan', 'nominal', 50000)] });
      S.infusHc = await rpc(c, 'save_service', { name: 'Infus Multivitamin HC', category: 'Homecare', unit: 'APT', price: 380000, shares: [Un('APT', 'remainder', 0)] });
    });
    await rejects(as(U.admin, (c) => rpc(c, 'save_service', { name: 'Asing', category: 'Kategori Asing', unit: 'APT', price: 1000, shares: [Un('APT', 'nominal', 1000)] })), /category_check|check constraint/);
  });
  const bulk = (refs, extra) => ({
    source: 'uji impor',
    transactions: refs.map((ref, i) => Object.assign({ date: '2025-01-' + String(i + 2).padStart(2, '0'), patient: 'Pasien ' + ref, externalRef: ref, note: 'Impor POS ' + ref,
      items: [{ serviceId: S.suntik, qty: 1, price: 220000, performers: { bidan: E.bidan } }, { serviceId: S.infusHc, qty: 2, price: 380000, performers: {} }] }, extra && extra[i]))
  });
  await test('impor massal: satu transaksi database; struk yang sama dilewati saat diimpor ulang', async () => {
    const r1 = await as(U.ops, (c) => rpc(c, 'create_service_transactions_bulk', bulk(['SIN-1', 'SIN-2', 'SIN-3'])));
    assert.strictEqual(r1.created.length, 3);
    assert.deepStrictEqual(r1.skipped, []);
    assert.strictEqual(Number(r1.gross), 3 * (220000 + 760000));
    const r2 = await as(U.ops, (c) => rpc(c, 'create_service_transactions_bulk', bulk(['SIN-2', 'SIN-3', 'SIN-4'])));
    assert.deepStrictEqual(r2.skipped, ['SIN-2', 'SIN-3']);
    assert.strictEqual(r2.created.length, 1);
    const n = (await su("select count(*)::int n from public.service_transactions where external_ref like 'SIN-%'")).rows[0].n;
    assert.strictEqual(n, 4);
    const hc = (await su("select sum(i.qty)::int q, sum(i.gross)::int g from public.service_transaction_items i join public.service_transactions t on t.id = i.transaction_id where t.external_ref like 'SIN-%' and i.category = 'Homecare'")).rows[0];
    assert.deepStrictEqual(hc, { q: 8, g: 3040000 }, 'kategori item tersimpan sebagai snapshot');
    const audit = (await su("select count(*)::int n from public.audit_logs where action = 'trx.bulk'")).rows[0].n;
    assert.strictEqual(audit, 2);
  });
  await test('impor massal gagal di tengah → tidak ada yang tersimpan (atomik); viewer ditolak', async () => {
    const before = (await su('select count(*)::int n from public.service_transactions')).rows[0].n;
    await rejects(as(U.ops, (c) => rpc(c, 'create_service_transactions_bulk', bulk(['SIN-5', 'SIN-6'], [null, { items: [{ serviceId: S.suntik, qty: 1, price: 220000, performers: {} }] }]))), /Data ke-2 \(SIN-6\).*Bidan belum dipilih/);
    await rejects(as(U.ops, (c) => rpc(c, 'create_service_transactions_bulk', bulk(['SIN-7'], [{ date: '2999-01-01' }]))), /melebihi hari ini/);
    await rejects(as(U.view, (c) => rpc(c, 'create_service_transactions_bulk', bulk(['SIN-8']))), /Akses ditolak/);
    assert.strictEqual((await su('select count(*)::int n from public.service_transactions')).rows[0].n, before);
  });
  await test('struk yang sama tidak dapat disimpan dua kali lewat input tunggal; boleh lagi setelah dibatalkan', async () => {
    const one = bulk(['SIN-1']).transactions[0];
    await rejects(as(U.ops, (c) => rpc(c, 'create_service_transaction', one)), /SIN-1 sudah pernah disimpan/);
    const id = (await su("select id from public.service_transactions where external_ref = 'SIN-1'")).rows[0].id;
    await as(U.fin, (c) => rpc(c, 'cancel_service_transaction', id, 'salah impor', null));
    const r = await as(U.ops, (c) => rpc(c, 'create_service_transactions_bulk', bulk(['SIN-1'])));
    assert.strictEqual(r.created.length, 1);
  });

  console.log('Pembagian dengan / tanpa dokter');
  await test('paritas SQL = JavaScript untuk varian dengan/tanpa dokter (200 konfigurasi acak)', async () => {
    const rnd = (() => {
      let s = 777;
      return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    })();
    const randShares = (price, roles) => {
      const out = [{ type: 'unit', target: 'APT', mode: rnd() < 0.5 ? 'remainder' : 'percent', value: 0 }];
      if (out[0].mode === 'percent') out[0].value = Math.round(rnd() * 40 * 100) / 100;
      let left = price;
      for (const r of roles) {
        if (rnd() < 0.5) {
          const v = Math.floor(rnd() * left * 0.4);
          left -= v;
          out.push({ type: 'role', target: r, mode: 'nominal', value: v });
        } else out.push({ type: 'role', target: r, mode: 'percent', value: Math.round(rnd() * 25 * 100) / 100 });
      }
      return out;
    };
    const c = await pool.connect();
    try {
      await c.query('begin');
      const emps = { [E.bidan]: { id: E.bidan, name: 'Bd. Uji Satu', position: 'Bidan' }, [E.dokter]: { id: E.dokter, name: 'dr. Uji', position: 'Dokter Umum' }, [E.perawat]: { id: E.perawat, name: 'Ns. Uji', position: 'Perawat' } };
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.admin })]);
      let compared = 0;
      for (let n = 0; n < 200; n++) {
        const price = 10000 + Math.floor(rnd() * 900000);
        const qty = 1 + Math.floor(rnd() * 4);
        const shares = randShares(price, rnd() < 0.5 ? ['bidan'] : ['bidan', 'perawat']);
        const doctorShares = rnd() < 0.8 ? randShares(price, ['dokter', 'bidan']) : [];
        const overrides = rnd() < 0.2 ? [{ employeeId: E.bidan, shares: randShares(price, ['bidan']) }] : [];
        const svc = { unit: 'KLINIK', price, shares, doctorShares, overrides };
        const wd = rnd() < 0.6;
        const perf = { dokter: E.dokter, bidan: E.bidan, perawat: E.perawat };
        const jsr = NP.rs.compute(svc, { price, qty, performers: perf, employees: emps, withDoctor: wd });
        await c.query('savepoint s');
        let sql;
        try {
          const id = (await c.query('select public.save_service($1) r', [{ name: 'Varian ' + n, category: 'Dokter Umum & Bidan', unit: 'KLINIK', price, shares, doctorShares, overrides }])).rows[0].r;
          sql = (await c.query('select * from public.compute_allocations($1, $2, $3, $4, false, $5)', [id, price, qty, perf, wd])).rows;
        } catch (e) {
          sql = { error: e.message };
        }
        await c.query('rollback to savepoint s');
        if (NP.rs.validateConfig(svc).errors.length || jsr.errors.length) {
          assert.ok(sql.error, 'JS error tapi SQL sukses: ' + JSON.stringify(svc));
          continue;
        }
        assert.ok(!sql.error, 'SQL error: ' + (sql.error || '') + ' ' + JSON.stringify(svc));
        assert.deepStrictEqual(sql.map((r) => [r.recipient_type, r.target, r.category, Number(r.unit_amount), Number(r.amount), r.override_employee_id]), jsr.shares.map((s) => [s.type, s.target, s.category, s.unitAmount, s.amount, jsr.overrideFor]), JSON.stringify({ svc, wd }));
        compared++;
      }
      assert.ok(compared > 120, 'konfigurasi valid yang dibandingkan: ' + compared);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });
  await test('transaksi dengan dokter vs tanpa dokter memakai pembagian berbeda; pelaksana mengikuti varian', async () => {
    S.injeksi = await as(U.admin, (c) => rpc(c, 'save_service', {
      name: 'Injeksi Vitamin', category: 'Dokter Umum & Bidan', unit: 'KLINIK', price: 200000,
      shares: [Un('KLINIK', 'remainder', 0), R('bidan', 'nominal', 40000)],
      doctorShares: [Un('KLINIK', 'remainder', 0), R('dokter', 'nominal', 60000), R('bidan', 'nominal', 20000)]
    }));
    const rules = (await su('select variant, count(*)::int n from public.service_revenue_rules where service_id = $1 group by variant order by variant', [S.injeksi])).rows;
    assert.deepStrictEqual(rules, [{ variant: 'doctor', n: 3 }, { variant: 'standard', n: 2 }]);
    const mk = (wd, perf) => as(U.ops, (c) => rpc(c, 'create_service_transaction', { date: '2025-02-03', items: [{ serviceId: S.injeksi, qty: 2, price: 200000, withDoctor: wd, performers: perf }] }));
    const t1 = await mk(false, { bidan: E.bidan, dokter: E.dokter });
    const t2 = await mk(true, { bidan: E.bidan, dokter: E.dokter });
    const alloc = async (id) => (await su('select a.category, a.amount::int from public.service_transaction_allocations a where a.transaction_id = $1 order by a.sort_order', [id])).rows;
    assert.deepStrictEqual(await alloc(t1), [{ category: 'klinik', amount: 320000 }, { category: 'bidan', amount: 80000 }]);
    assert.deepStrictEqual(await alloc(t2), [{ category: 'klinik', amount: 240000 }, { category: 'dokter', amount: 120000 }, { category: 'bidan', amount: 40000 }]);
    const items = (await su('select transaction_id, with_doctor, performers from public.service_transaction_items where transaction_id in ($1, $2) order by transaction_id', [t1, t2])).rows;
    assert.deepStrictEqual(items.map((i) => [i.with_doctor, Object.keys(i.performers).sort()]), [[false, ['bidan']], [true, ['bidan', 'dokter']]]);
    await rejects(mk(true, { bidan: E.bidan }), /Dokter belum dipilih/);
    // tindakan tanpa varian dokter: withDoctor diabaikan
    const t3 = await as(U.ops, (c) => rpc(c, 'create_service_transaction', { date: '2025-02-03', items: [{ serviceId: S.suntik, qty: 1, price: 220000, withDoctor: true, performers: { bidan: E.bidan } }] }));
    assert.strictEqual((await su('select with_doctor from public.service_transaction_items where transaction_id = $1', [t3])).rows[0].with_doctor, false);
    // ubah transaksi: ganti ke tanpa dokter → snapshot baru; tetap dengan dokter → snapshot lama dipertahankan
    const line = (await su('select id from public.service_transaction_items where transaction_id = $1', [t2])).rows[0].id;
    await as(U.ops, (c) => rpc(c, 'update_service_transaction', t2, { date: '2025-02-03', items: [{ lineId: line, serviceId: S.injeksi, qty: 2, price: 200000, withDoctor: true, performers: { bidan: E.bidan, dokter: E.dokter } }] }, null));
    assert.strictEqual((await su('select id from public.service_transaction_items where transaction_id = $1', [t2])).rows[0].id, line, 'item yang tidak berubah dipertahankan');
    await as(U.ops, (c) => rpc(c, 'update_service_transaction', t2, { date: '2025-02-03', items: [{ lineId: line, serviceId: S.injeksi, qty: 2, price: 200000, withDoctor: false, performers: { bidan: E.bidan, dokter: E.dokter } }] }, null));
    assert.deepStrictEqual(await alloc(t2), [{ category: 'klinik', amount: 320000 }, { category: 'bidan', amount: 80000 }]);
    await rejects(as(U.admin, (c) => c.query("select * from public.compute_allocations('X', 1, 1, '{}')")), /permission denied/);
  });

  console.log('Bagian opsional & per kunjungan');
  await test('paritas SQL = JavaScript: pelaksana opsional & bagian per kunjungan (150 konfigurasi acak)', async () => {
    const rnd = (() => {
      let s = 4242;
      return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    })();
    const c = await pool.connect();
    try {
      await c.query('begin');
      const emps = { [E.bidan]: { id: E.bidan, name: 'Bd. Uji Satu', position: 'Bidan' }, [E.dokter]: { id: E.dokter, name: 'dr. Uji', position: 'Dokter Umum' } };
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.admin })]);
      let compared = 0;
      for (let n = 0; n < 150; n++) {
        const price = 50000 + Math.floor(rnd() * 500000);
        const qty = 1 + Math.floor(rnd() * 3);
        const shares = [{ type: 'unit', target: 'KLINIK', mode: rnd() < 0.5 ? 'remainder' : 'nominal', value: 0 },
          { type: 'role', target: 'dokter', mode: 'nominal', value: Math.floor(rnd() * price * 0.4), optional: rnd() < 0.3, perVisit: rnd() < 0.4 },
          { type: 'role', target: 'bidan', mode: 'nominal', value: Math.floor(rnd() * price * 0.3), optional: rnd() < 0.5, perVisit: rnd() < 0.5 }];
        const perf = {};
        if (rnd() < 0.7) perf.dokter = E.dokter;
        if (rnd() < 0.6) perf.bidan = E.bidan;
        const paid = [];
        if (rnd() < 0.3) paid.push('role:bidan');
        if (rnd() < 0.2) paid.push('role:dokter');
        const svc = { unit: 'KLINIK', price, shares };
        const jsr = NP.rs.compute(svc, { price, qty, performers: perf, employees: emps, paid });
        await c.query('savepoint s');
        let sql;
        try {
          const id = (await c.query('select public.save_service($1) r', [{ name: 'Opsional ' + n, category: 'Dokter Umum & Bidan', unit: 'KLINIK', price, shares }])).rows[0].r;
          sql = (await c.query('select * from public.compute_allocations($1, $2, $3, $4, false, false, $5)', [id, price, qty, perf, paid])).rows;
        } catch (e) {
          sql = { error: e.message };
        }
        await c.query('rollback to savepoint s');
        if (jsr.errors.length) {
          assert.ok(sql.error, 'JS error tapi SQL sukses: ' + JSON.stringify({ svc, perf, paid }));
          continue;
        }
        assert.ok(!sql.error, 'SQL error: ' + (sql.error || '') + ' ' + JSON.stringify({ svc, perf, paid }));
        assert.deepStrictEqual(sql.map((r) => [r.recipient_type, r.target, Number(r.unit_amount), Number(r.amount), r.is_implicit, r.per_visit]), jsr.shares.map((s) => [s.type, s.target, s.unitAmount, s.amount, s.implicit, !!s.perVisit && s.amount + s.unitAmount > 0 || (!!s.perVisit && paid.includes(NP.rs.visitKeyOf(s)) && s.type === 'role' && !!perf[s.target])]), JSON.stringify({ svc, perf, paid, qty }));
        assert.strictEqual(sql.reduce((a, r) => a + Number(r.amount), 0), price * qty);
        compared++;
      }
      assert.ok(compared > 100, 'dibandingkan: ' + compared);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });
  await test('homecare: jasa bidan Rp100.000 sekali per kunjungan (transaksi), bidan opsional ke unit', async () => {
    const ids = await as(U.admin, async (c) => ({
      infus: await rpc(c, 'save_service', { name: 'Infus HC Uji', category: 'Homecare', unit: 'KLINIK', price: 380000, shares: [Un('KLINIK', 'remainder', 0), Object.assign(R('bidan', 'nominal', 100000), { perVisit: true })] }),
      suntik: await rpc(c, 'save_service', { name: 'Suntik HC Uji', category: 'Homecare', unit: 'KLINIK', price: 300000, shares: [Un('KLINIK', 'remainder', 0), Object.assign(R('bidan', 'nominal', 100000), { perVisit: true })] }),
      dok: await rpc(c, 'save_service', { name: 'Periksa Dokter HC Uji', category: 'Homecare', unit: 'KLINIK', price: 300000, shares: [R('dokter', 'nominal', 300000)] }),
      kons: await rpc(c, 'save_service', { name: 'Konsultasi Resep Uji', category: 'Pemeriksaan dokter', unit: 'KLINIK', price: 100000, shares: [Un('KLINIK', 'remainder', 0), R('dokter', 'nominal', 80000), Object.assign(R('bidan', 'nominal', 15000), { optional: true })] })
    }));
    const t1 = await as(U.ops, (c) => rpc(c, 'create_service_transaction', { date: '2025-03-04', patient: 'Ny. HC', items: [
      { serviceId: ids.infus, qty: 1, price: 380000, performers: { bidan: E.bidan } },
      { serviceId: ids.suntik, qty: 2, price: 300000, performers: { bidan: E.bidan } },
      { serviceId: ids.dok, qty: 1, price: 300000, performers: { dokter: E.dokter } }] }));
    const by = async (id) => (await su('select category, sum(amount)::int a from public.service_transaction_allocations where transaction_id = $1 group by category having sum(amount) > 0 order by category', [id])).rows;
    assert.deepStrictEqual(await by(t1), [{ category: 'bidan', a: 100000 }, { category: 'dokter', a: 300000 }, { category: 'klinik', a: 380000 + 600000 + 300000 - 100000 - 300000 }].sort((a, b) => a.category.localeCompare(b.category)));
    const t2 = await as(U.ops, (c) => rpc(c, 'create_service_transaction', { date: '2025-03-04', items: [{ serviceId: ids.kons, qty: 1, price: 100000, performers: { dokter: E.dokter } }] }));
    assert.deepStrictEqual(await by(t2), [{ category: 'dokter', a: 80000 }, { category: 'klinik', a: 20000 }]);
    const t3 = await as(U.ops, (c) => rpc(c, 'create_service_transaction', { date: '2025-03-04', items: [{ serviceId: ids.kons, qty: 1, price: 100000, performers: { dokter: E.dokter, bidan: E.bidan } }] }));
    assert.deepStrictEqual(await by(t3), [{ category: 'bidan', a: 15000 }, { category: 'dokter', a: 80000 }, { category: 'klinik', a: 5000 }]);
    await rejects(as(U.admin, (c) => rpc(c, 'save_service', { name: 'Salah', category: 'Homecare', unit: 'KLINIK', price: 1000, shares: [Un('KLINIK', 'remainder', 0), Object.assign(R('bidan', 'percent', 10), { perVisit: true })] })), /rules_flags_chk|check constraint/);
  });

  console.log('Hapus transaksi');
  await test('hapus beberapa transaksi: hanya admin, wajib alasan, yang sudah masuk penggajian dilewati, audit menyimpan salinan', async () => {
    const ids = (await su("select id from public.service_transactions where external_ref like 'SIN-%' and status = 'active' order by id")).rows.map((r) => r.id);
    assert.ok(ids.length >= 2);
    await rejects(as(U.fin, (c) => rpc(c, 'delete_service_transactions', JSON.stringify(ids), 'uji')), /Akses ditolak/);
    await rejects(as(U.admin, (c) => rpc(c, 'delete_service_transactions', JSON.stringify(ids), '')), /Alasan penghapusan wajib/);
    const res = await as(U.admin, (c) => rpc(c, 'delete_service_transactions', JSON.stringify(ids.concat([T.gula, 'TRX-TIDAK-ADA'])), 'salah impor bulan Januari'));
    assert.deepStrictEqual(res.deleted.sort(), ids.slice().sort());
    assert.deepStrictEqual(res.skipped.map((x) => x.id).sort(), ['TRX-TIDAK-ADA', T.gula].sort());
    assert.ok(/penggajian/.test(res.skipped.find((x) => x.id === T.gula).reason));
    const left = (await su('select count(*)::int n from public.service_transactions where id = any($1)', [ids])).rows[0].n;
    const leftItems = (await su('select count(*)::int n from public.service_transaction_items where transaction_id = any($1)', [ids])).rows[0].n;
    const leftAlloc = (await su('select count(*)::int n from public.service_transaction_allocations where transaction_id = any($1)', [ids])).rows[0].n;
    assert.deepStrictEqual([left, leftItems, leftAlloc], [0, 0, 0], 'item & alokasi ikut terhapus');
    assert.strictEqual((await su('select count(*)::int n from public.service_transactions where id = $1', [T.gula])).rows[0].n, 1, 'transaksi dalam penggajian tetap ada');
    const a = (await su("select detail, old_data from public.audit_logs where action = 'trx.delete' and entity_id = $1", [ids[0]])).rows[0];
    assert.ok(/salah impor/.test(a.detail) && a.old_data.items.length >= 1 && a.old_data.id === ids[0], 'salinan transaksi di audit log');
    // nomor struk yang dihapus dapat diimpor ulang
    const r = await as(U.ops, (c) => rpc(c, 'create_service_transactions_bulk', bulk(['SIN-2'])));
    assert.strictEqual(r.created.length, 1);
  });

  console.log('Jadwal masuk');
  await test('jadwal: simpan oleh ops/keuangan/admin, viewer ditolak, validasi kode & tanggal, kunci versi, audit', async () => {
    const SH = [{ code: 'P', name: 'Pagi', start: '07:00', end: '14:00' }, { code: 'S', name: 'Siang', start: '14:00', end: '21:00' }];
    const sched = (asg, extra) => JSON.stringify(Object.assign({ period: '2026-02', unit: 'KLINIK', title: 'Jadwal Februari', config: { shifts: SH, employees: [E.bidan, E.bidan2], weekly: {}, days: {}, rules: {} }, assignments: asg }, extra || {}));
    await rejects(as(U.view, (c) => rpc(c, 'save_work_schedule', sched({}))), /Akses ditolak/);
    const r1 = await as(U.ops, (c) => rpc(c, 'save_work_schedule', sched({ [E.bidan]: { 1: 'P', 2: 'L' }, [E.bidan2]: { 1: 'S' } })));
    assert.deepStrictEqual([r1.id, r1.version], ['JDW-202602-KLINIK', 1]);
    // kode shift tidak terdaftar, tanggal di luar bulan (Februari 28 hari), karyawan di luar jadwal
    await rejects(as(U.ops, (c) => rpc(c, 'save_work_schedule', sched({ [E.bidan]: { 3: 'M' } }))), /bukan shift yang terdaftar/);
    await rejects(as(U.ops, (c) => rpc(c, 'save_work_schedule', sched({ [E.bidan]: { 29: 'P' } }))), /di luar bulan/);
    await rejects(as(U.ops, (c) => rpc(c, 'save_work_schedule', sched({ [E.kasir]: { 1: 'P' } }))), /tidak termasuk/);
    await rejects(as(U.ops, (c) => rpc(c, 'save_work_schedule', JSON.stringify({ period: '2026-02', unit: 'KLINIK', config: { shifts: [{ code: 'L', start: '07:00', end: '14:00' }] } }))), /Kode shift/);
    // kunci versi: penyimpanan dengan versi lama ditolak
    const r2 = await as(U.fin, (c) => rpc(c, 'save_work_schedule', sched({ [E.bidan]: { 1: 'S' } }, { version: 1 })));
    assert.strictEqual(r2.version, 2);
    await rejects(as(U.admin, (c) => rpc(c, 'save_work_schedule', sched({ [E.bidan]: { 1: 'P' } }, { version: 1 }))), /diubah oleh pengguna lain/);
    // semua pengguna aktif dapat membaca; tulis langsung ke tabel ditolak
    const rows = await as(U.view, (c) => c.query('select id, version, assignments from public.work_schedules').then((r) => r.rows));
    assert.deepStrictEqual(rows, [{ id: 'JDW-202602-KLINIK', version: 2, assignments: { [E.bidan]: { 1: 'S' } } }]);
    await rejects(as(U.admin, (c) => c.query("update public.work_schedules set title = 'x'")), /permission denied/);
    const a = (await su("select count(*)::int n from public.audit_logs where action = 'schedule.save' and entity_id = 'JDW-202602-KLINIK'")).rows[0].n;
    assert.strictEqual(a, 2);
    await rejects(as(U.view, (c) => rpc(c, 'delete_work_schedule', 'JDW-202602-KLINIK')), /Akses ditolak/);
    await as(U.ops, (c) => rpc(c, 'delete_work_schedule', 'JDW-202602-KLINIK'));
    assert.strictEqual((await su('select count(*)::int n from public.work_schedules')).rows[0].n, 0);
  });

  await pool.end();
  console.log('\n' + passed + ' lulus, ' + failures.length + ' gagal');
  process.exit(failures.length ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
