/* Uji end-to-end MODE SUPABASE: aplikasi di browser sungguhan + supabase-js sungguhan,
 * terhubung ke PostgreSQL berisi migrasi asli melalui server uji (tests/support/mock-supabase.js).
 * Dua konteks browser = dua perangkat berbeda yang memakai database yang sama.
 * Jalankan: PGDATABASE=noura_e2e node tests/e2e-supabase.test.js   (butuh playwright, pg, PostgreSQL)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const mock = require('./support/mock-supabase');

const ROOT = path.join(__dirname, '..');
const DB = process.env.PGDATABASE || 'noura_e2e';
let passed = 0;
const failures = [];
const pages = [];
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failures.push(name);
    console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    '));
    if (process.env.E2E_SHOTS) for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(process.env.E2E_SHOTS, 'sb-fail-' + failures.length + '-' + i + '.png') }).catch(() => {});
    for (const p of pages) await p.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach((m) => m.parentNode.removeChild(m))).catch(() => {});
  }
}

(async () => {
  const reset = spawnSync('bash', [path.join(ROOT, 'tests/db/reset.sh')], { env: Object.assign({}, process.env, { PGDATABASE: DB }), encoding: 'utf8' });
  if (reset.status !== 0) throw new Error('Reset database gagal: ' + reset.stderr);
  const srv = await mock.start({ root: ROOT, database: DB });
  const sql = (q, a) => srv.pool.query(q, a).then((r) => r.rows);
  const mkUser = (email, pw, name) => sql("insert into auth.users (email, encrypted_password, raw_user_meta_data) values ($1, crypt($2, gen_salt('bf', 4)), $3) returning id", [email, pw, { full_name: name }]).then((r) => r[0].id);
  const ID = {};
  ID.admin = await mkUser('admin@noura.test', 'Admin#2026', 'Admin Utama');
  ID.fin = await mkUser('keuangan@noura.test', 'Keuangan#2026', 'Admin Keuangan');
  ID.ops = await mkUser('operasional@noura.test', 'Operasional#2026', 'Admin Operasional');
  ID.view = await mkUser('viewer@noura.test', 'Viewer#2026', 'Viewer');
  ID.off = await mkUser('nonaktif@noura.test', 'Nonaktif#2026', 'Belum Aktif');
  await sql("update public.users set role = 'finance', active = true where id = $1", [ID.fin]);
  await sql("update public.users set role = 'ops', active = true where id = $1", [ID.ops]);
  await sql("update public.users set role = 'viewer', active = true where id = $1", [ID.view]);

  const browser = await chromium.launch();
  const errors = [];
  async function device() {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => m.type() === 'error' && !/favicon|fonts\.g|realtime|websocket|ERR_CONNECTION|status of 40[034]/i.test(m.text()) && errors.push(m.text()));
    pages.push(p);
    return p;
  }
  const A = await device();
  const B = await device();
  const go = async (p, hash) => {
    await p.goto(srv.url + '/index.html#/' + hash);
    const name = hash.split('?')[0];
    await p.waitForFunction((n) => document.querySelector('#view.page-' + n + ' .page-host') && !document.querySelector('#view .loading'), name, { timeout: 30000 });
    await p.waitForTimeout(300);
  };
  const login = async (p, email, pw) => {
    await p.goto(srv.url + '/index.html');
    await p.waitForSelector('.auth-screen');
    await p.fill('[name=username]', email);
    await p.fill('[name=password]', pw);
    await p.click('.auth-card button[type=submit]');
  };
  const logout = async (p) => {
    await p.evaluate(() => NP.db.signOut());
    await p.evaluate(() => localStorage.clear());
  };
  const modalBtn = (p, label) => p.locator('.modal-backdrop').last().locator('.modal-foot button', { hasText: label });
  const toastAfter = async (p, fn, re) => {
    const n = await p.locator('.toast').count();
    await fn();
    await p.waitForFunction(([n0, src]) => {
      const t = [...document.querySelectorAll('.toast')];
      return t.length > n0 && new RegExp(src).test(t[t.length - 1].textContent);
    }, [n, re.source], { timeout: 20000 });
  };

  console.log('Login Supabase Auth');
  await step('form login meminta email; sandi salah & akun nonaktif ditolak', async () => {
    await login(A, 'admin@noura.test', 'salah');
    await A.waitForSelector('.auth-error:not([hidden])');
    assert.ok(/Email atau kata sandi salah/.test(await A.locator('.auth-error').innerText()));
    assert.ok(/Email/.test(await A.locator('.auth-card .field span').first().innerText()));
    await A.fill('[name=username]', 'nonaktif@noura.test');
    await A.fill('[name=password]', 'Nonaktif#2026');
    await A.click('.auth-card button[type=submit]');
    await A.waitForFunction(() => /belum diaktifkan/.test(document.querySelector('.auth-error').textContent));
  });
  await step('admin masuk; aplikasi memakai database pusat, tanpa database lokal', async () => {
    await A.fill('[name=username]', 'admin@noura.test');
    await A.fill('[name=password]', 'Admin#2026');
    await A.click('.auth-card button[type=submit]');
    await A.waitForSelector('.sidebar');
    assert.ok(/Database pusat Supabase/.test(await A.locator('.storage-note').innerText()));
    const dbs = await A.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : []));
    assert.ok(!dbs.includes('noura-payroll'), 'IndexedDB tidak boleh dipakai: ' + dbs);
    assert.strictEqual(await A.evaluate(() => NP.db.remote), true);
  });
  await step('sesi bertahan setelah muat ulang halaman', async () => {
    await A.reload();
    await A.waitForSelector('.sidebar');
  });

  console.log('Master data dari perangkat A (admin)');
  await step('tambah karyawan lewat form → tersimpan di PostgreSQL', async () => {
    await go(A, 'employees');
    await A.click('[data-act=add]');
    await A.fill('.emp-form [name=name]', 'Bd. Pusat Satu');
    await A.fill('.emp-form [name=phone]', '081299990001');
    await A.click('.emp-form [data-tab=pekerjaan]');
    await A.selectOption('.emp-form [name=unit]', 'KLINIK');
    await A.selectOption('.emp-form [name=position]', 'Bidan');
    await A.fill('.emp-form [name=department]', 'Kebidanan');
    await A.click('.emp-form [data-tab=gaji]');
    await A.selectOption('.emp-form [name=payScheme]', 'monthly_service');
    await A.fill('.emp-form [name=baseSalary]', '2000000');
    await A.click('.emp-form [data-tab=bank]');
    await A.fill('.emp-form [name=bankName]', 'BRI');
    await A.fill('.emp-form [name=bankAccount]', '002101234567');
    await modalBtn(A, 'Simpan').click();
    await A.waitForSelector('.modal-backdrop', { state: 'detached' });
    const r = await sql("select e.id, e.base_salary::int, b.account_number from public.employees e join public.employee_bank_accounts b on b.employee_id = e.id where e.full_name = 'Bd. Pusat Satu'");
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].base_salary, 2000000);
    assert.strictEqual(r[0].account_number, '002101234567');
    ID.bidan = r[0].id;
    ID.kasir = await A.evaluate(() => NP.emp.save(Object.assign(NP.emp.blank(), { name: 'Kasir Pusat', phone: '081299990002', unit: 'APT', position: 'Kasir', department: 'Kasir & Penjualan', baseSalary: 2600000, bpjsKes: true, bpjsTk: true, pph21: false })).then((e) => e.id));
  });
  await step('tambah tindakan (Gula Darah Rp28.000: Apotek 18.000 + Bidan 10.000) lewat form', async () => {
    await go(A, 'services');
    await A.click('[data-act=add]');
    const m = A.locator('.svc-form');
    await m.locator('[name=name]').fill('Pemeriksaan Gula Darah');
    await m.locator('[name=category]').selectOption('Pemeriksaan laboratorium sederhana');
    await m.locator('[name=unit]').selectOption('APT');
    await m.locator('[name=price]').fill('28000');
    const rows = m.locator('#share-main .share-row:not(.share-head)');
    await rows.nth(0).locator('[data-f=value]').fill('18000');
    await rows.nth(1).locator('[data-f=value]').fill('10000');
    await modalBtn(A, 'Simpan Tindakan').click();
    await A.waitForSelector('.modal-backdrop', { state: 'detached' });
    const r = await sql("select s.id, s.method, count(r.id)::int n from public.service_master s join public.service_revenue_rules r on r.service_id = s.id where s.name = 'Pemeriksaan Gula Darah' group by s.id");
    assert.deepStrictEqual([r[0].method, r[0].n], ['nominal', 2]);
    ID.gula = r[0].id;
  });

  console.log('Perangkat B (Admin Operasional) memakai database yang sama');
  await step('operasional login di perangkat lain dan melihat tindakan buatan admin', async () => {
    await login(B, 'operasional@noura.test', 'Operasional#2026');
    await B.waitForSelector('.sidebar');
    await go(B, 'input');
    assert.ok((await B.locator(`.item-row [data-f=serviceId] option[value="${ID.gula}"]`).count()) === 1);
  });
  await step('input Gula Darah ×5 → server membagi Rp90.000 / Rp50.000', async () => {
    await B.selectOption('.item-row [data-f=serviceId]', ID.gula);
    await B.selectOption('.item-row [data-perf=bidan]', ID.bidan);
    for (let i = 0; i < 4; i++) await B.click('.item-row [data-step="1"]');
    await B.fill('.input-form [name=patient]', 'Pasien Pusat');
    await toastAfter(B, () => B.click('[data-act=save]'), /tersimpan/);
    const r = await sql("select a.category, a.amount::int from public.service_transaction_allocations a join public.service_transactions t on t.id = a.transaction_id where t.patient_name = 'Pasien Pusat' order by a.sort_order");
    assert.deepStrictEqual(r, [{ category: 'apotek', amount: 90000 }, { category: 'bidan', amount: 50000 }]);
    ID.trx = (await sql("select id from public.service_transactions where patient_name = 'Pasien Pusat'"))[0].id;
  });
  await step('operasional tidak dapat membuka Data Karyawan & tidak melihat rekening', async () => {
    await go(B, 'employees');
    assert.ok(/tidak memiliki hak akses/.test(await B.locator('#view').innerText()));
    const acc = await B.evaluate(async () => (await NP.db.all('employees')).map((e) => e.bankAccount).join(''));
    assert.strictEqual(acc, '', 'RLS harus menyembunyikan rekening');
  });
  await step('perangkat A melihat transaksi dari perangkat B di Riwayat Transaksi', async () => {
    await A.reload();
    await A.waitForSelector('.sidebar');
    await go(A, 'transactions');
    await A.fill('#h-q', 'Pasien Pusat');
    await A.waitForTimeout(300);
    assert.strictEqual(await A.locator('#h-list tbody tr').count(), 1);
    assert.ok(/operasional/.test(await A.evaluate((id) => NP.trx.get(id).then((t) => t.createdBy), ID.trx)));
  });

  console.log('Penggajian (Admin Keuangan) di perangkat B');
  await step('generate payroll lewat wizard → draft tersimpan di server & jasa terkunci untuk periode ini', async () => {
    await logout(B);
    await login(B, 'keuangan@noura.test', 'Keuangan#2026');
    await B.waitForSelector('.sidebar');
    await go(B, 'generate');
    await B.click('#wiz [data-next]');
    await B.waitForSelector('.tbl-grid');
    await B.click('#wiz [data-next]');
    await B.waitForSelector('#prev-table');
    await B.click('#wiz [data-next]');
    await B.waitForSelector('.confirm-box');
    await B.click('#wiz [data-save]');
    await B.waitForFunction(() => document.querySelector('#view.page-payroll-history'), null, { timeout: 30000 });
    const p = await sql("select id, status from public.payroll_periods");
    assert.strictEqual(p.length, 1);
    ID.run = p[0].id;
    const jasa = await sql("select d.amount::int from public.payroll_details d join public.payroll_records r on r.id = d.record_id where r.employee_id = $1 and d.code = 'JASA'", [ID.bidan]);
    assert.deepStrictEqual(jasa, [{ amount: 50000 }]);
    const claimed = await sql("select count(*)::int n from public.service_transaction_allocations where payroll_period_id = $1", [ID.run]);
    assert.strictEqual(claimed[0].n, 1);
  });
  await step('setujui dari Riwayat Penggajian → nomor slip terbit di server', async () => {
    await B.waitForSelector('.modal [data-r=approve]');
    B.once('dialog', (d) => d.dismiss());
    await B.locator('.modal [data-r=approve]').click();
    await modalBtn(B, 'Ya, lanjutkan').click();
    await B.waitForFunction(() => /Disetujui/.test(document.querySelector('.modal .run-head') ? document.querySelector('.modal .run-head').textContent : ''), null, { timeout: 30000 });
    const s = await sql('select slip_no from public.payslips where period_id = $1', [ID.run]);
    assert.strictEqual(s.length, 2);
  });
  await step('slip gaji tampil dari data server & PDF dapat diunduh', async () => {
    await go(B, 'payslips');
    await B.waitForSelector('.slip .s-head');
    const [d] = await Promise.all([B.waitForEvent('download', { timeout: 60000 }), B.click('#sl-actions [data-act=pdf]')]);
    assert.ok(fs.statSync(await d.path()).size > 20000);
  });

  console.log('Penguncian & koreksi dengan otorisasi administrator');
  await step('admin mengunci penggajian di perangkat A', async () => {
    await go(A, 'payroll-history?open=' + ID.run);
    await A.locator('.modal [data-r=lock]').click();
    await modalBtn(A, 'Ya, lanjutkan').click();
    await A.waitForFunction(() => /Terkunci/.test((document.querySelector('.modal .run-head') || {}).textContent || ''), null, { timeout: 30000 });
    assert.strictEqual((await sql('select status from public.payroll_periods where id = $1', [ID.run]))[0].status, 'locked');
  });
  await step('keuangan mengoreksi transaksi terkunci → otorisasi email+sandi admin → adjustment di server', async () => {
    await go(B, 'input?edit=' + ID.trx);
    await B.click('.item-row [data-step="1"]');
    await B.click('[data-act=save]');
    await B.waitForSelector('.modal [name=ap]');
    await B.fill('.modal [name=au]', 'admin@noura.test');
    await B.fill('.modal [name=ap]', 'Admin#2026');
    await B.fill('.modal [name=an]', 'Koreksi jumlah pemeriksaan');
    await modalBtn(B, 'Otorisasi').click();
    await B.waitForFunction(() => document.querySelector('#view.page-transactions .page-host'), null, { timeout: 30000 });
    const adj = await sql("select amount::int, adj_by from public.service_transaction_allocations where transaction_id = $1 and kind = 'adjustment'", [ID.trx]);
    assert.deepStrictEqual(adj, [{ amount: 10000, adj_by: 'admin' }]);
    const log = await sql("select count(*)::int n from public.audit_logs where action = 'trx.correction' and entity_id = $1", [ID.trx]);
    assert.strictEqual(log[0].n, 1);
  });

  console.log('Pengaturan, pengguna & hak akses');
  await step('admin mengubah alamat unit → tersimpan di business_units & tercatat audit', async () => {
    await go(A, 'settings');
    await A.fill('[name="APT.address"]', 'Jl. Pusat No. 1, Bandung');
    await toastAfter(A, () => A.click('.settings-form button[type=submit]'), /Identitas disimpan/);
    assert.strictEqual((await sql("select address from public.business_units where code = 'APT'"))[0].address, 'Jl. Pusat No. 1, Bandung');
    assert.ok((await sql("select count(*)::int n from public.audit_logs where entity = 'business_units'"))[0].n >= 1);
  });
  await step('admin membuat pengguna baru (fungsi server admin-users) yang langsung dapat login', async () => {
    await go(A, 'settings?tab=users');
    await A.click('[data-u=add]');
    await A.fill('.modal [name=email]', 'staf.baru@noura.test');
    await A.fill('.modal [name=name]', 'Staf Baru');
    await A.selectOption('.modal [name=role]', 'ops');
    await A.fill('.modal [name=password]', 'StafBaru#2026');
    await modalBtn(A, 'Simpan').click();
    await A.waitForSelector('.modal-backdrop', { state: 'detached' });
    const u = await sql("select role, active from public.users where email = 'staf.baru@noura.test'");
    assert.deepStrictEqual(u, [{ role: 'ops', active: true }]);
  });
  await step('viewer hanya melihat laporan; tidak dapat membaca slip/penggajian rinci', async () => {
    await logout(B);
    await login(B, 'viewer@noura.test', 'Viewer#2026');
    await B.waitForSelector('.sidebar');
    await go(B, 'reports');
    await B.waitForSelector('.report-flow');
    await go(B, 'payslips');
    assert.ok(/tidak memiliki hak akses/.test(await B.locator('#view').innerText()));
  });

  await step('tidak ada error JavaScript', async () => {
    assert.deepStrictEqual(errors, []);
  });

  await browser.close();
  await srv.pool.end();
  srv.server.close();
  console.log('\n' + passed + ' lulus, ' + failures.length + ' gagal');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
