/* Uji end-to-end (browser sungguhan via Playwright) atas alur utama aplikasi.
 * Jalankan: node tests/e2e.test.js   (membutuhkan paket `playwright` + Chromium)
 * Server statis kecil dijalankan otomatis dari folder proyek. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

let passed = 0;
const failures = [];
let shotPage = null;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failures.push(name);
    if (process.env.E2E_SHOTS && shotPage) await shotPage.screenshot({ path: path.join(process.env.E2E_SHOTS, 'fail-' + failures.length + '.png') }).catch(() => {});
    // tutup modal yang tertinggal agar langkah berikutnya tidak terhalang
    if (shotPage) await shotPage.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove())).catch(() => {});
    console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n    '));
  }
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const BASE = 'http://localhost:' + server.address().port + '/index.html';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  shotPage = page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|fonts\.g/.test(m.text()) && errors.push(m.text()));
  page.on('dialog', (d) => d.dismiss());

  const go = async (hash) => {
    await page.goto(BASE + '#/' + hash);
    const name = hash.split('?')[0];
    await page.waitForFunction((n) => document.querySelector('#view.page-' + n + ' .page-host') && !document.querySelector('#view .loading'), name);
    await page.waitForTimeout(250);
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const toastText = async () => (await page.locator('.toast').last().innerText().catch(() => ''));
  /** Klik lalu tunggu toast BARU yang cocok dengan pola. */
  const clickToast = async (sel, re) => {
    const n = await page.evaluate(() => (window.__toasts = window.__toasts || 0));
    await page.evaluate(() => {
      if (window.__toastObs) return;
      window.__toastObs = new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((x) => x.classList && x.classList.contains('toast') && (window.__toasts++, (window.__lastToast = x.textContent)))));
      window.__toastObs.observe(document.body, { childList: true, subtree: true });
    });
    await page.click(sel);
    await page.waitForFunction(([n0, src]) => window.__toasts > n0 && new RegExp(src).test(window.__lastToast || ''), [n, re.source]);
  };
  const modalBtn = (label) => page.locator('.modal-backdrop').last().locator('.modal-foot button', { hasText: label });
  const download = async (fn) => {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), fn()]);
    const p = await d.path();
    return { name: d.suggestedFilename(), size: fs.statSync(p).size, path: p };
  };

  console.log('Login & data demo');
  await step('aplikasi memuat data demo & menampilkan login', async () => {
    await page.goto(BASE);
    await page.waitForSelector('.auth-screen', { timeout: 60000 });
  });
  await step('login salah ditolak', async () => {
    await page.fill('[name=username]', 'admin');
    await page.fill('[name=password]', 'salah');
    await page.click('.auth-card button[type=submit]');
    await page.waitForSelector('.auth-error:not([hidden])');
  });
  await step('login administrator', async () => {
    await page.fill('[name=password]', 'admin123');
    await page.click('.auth-card button[type=submit]');
    await page.waitForSelector('.sidebar');
    const n = await ev(async () => ({ e: (await NP.db.all('employees')).length, s: (await NP.db.all('services')).length, t: (await NP.db.all('transactions')).length, r: (await NP.db.all('payrollRuns')).length }));
    assert.ok(n.e >= 10 && n.s >= 15 && n.t > 100 && n.r === 3, JSON.stringify(n));
  });

  console.log('Data karyawan');
  await step('tambah karyawan lewat form (validasi wajib isi)', async () => {
    await go('employees');
    await page.click('[data-act=add]');
    await modalBtn('Simpan').click();
    await page.waitForSelector('.modal .form-error:not([hidden])');
    await page.fill('.emp-form [name=name]', 'Bd. Uji Coba');
    await page.fill('.emp-form [name=phone]', '081299990000');
    await page.click('.emp-form [data-tab=pekerjaan]');
    await page.selectOption('.emp-form [name=unit]', 'KLINIK');
    await page.selectOption('.emp-form [name=position]', 'Bidan');
    await page.fill('.emp-form [name=department]', 'Kebidanan');
    await page.click('.emp-form [data-tab=gaji]');
    await page.selectOption('.emp-form [name=payScheme]', 'monthly_service');
    await page.fill('.emp-form [name=baseSalary]', '2000000');
    await page.uncheck('.emp-form [name=bpjsKes]');
    await page.uncheck('.emp-form [name=bpjsTk]');
    await page.uncheck('.emp-form [name=pph21]');
    await modalBtn('Simpan').click();
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const e = await ev(async () => (await NP.db.all('employees')).find((x) => x.name === 'Bd. Uji Coba'));
    assert.ok(e && /^KRY-\d{4}$/.test(e.id) && e.baseSalary === 2000000 && e.position === 'Bidan');
  });
  await step('edit karyawan & pencarian', async () => {
    await page.fill('#f-q', 'Uji Coba');
    await page.waitForTimeout(300);
    assert.strictEqual(await page.locator('#emp-list tbody tr').count(), 1);
    await page.click('#emp-list [data-act=edit]');
    await page.fill('.emp-form [name=email]', 'uji@noura.local');
    await modalBtn('Simpan').click();
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const e = await ev(async () => (await NP.db.all('employees')).find((x) => x.name === 'Bd. Uji Coba'));
    assert.strictEqual(e.email, 'uji@noura.local');
  });
  await step('karyawan lintas unit memiliki pembagian beban', async () => {
    const e = await ev(async () => (await NP.db.all('employees')).find((x) => x.unit === 'LINTAS'));
    assert.strictEqual(e.costSplit.APT, 60);
  });
  await step('hapus karyawan tanpa riwayat & tolak yang memiliki transaksi', async () => {
    const id = await ev(async () => (await NP.emp.save(Object.assign(NP.emp.blank(), { name: 'Hapus Saya', phone: '0811111111', department: 'Operasional', position: 'Kurir', baseSalary: 1000000 }))).id);
    await ev((i) => NP.emp.remove(i), id);
    const gone = await ev(async (i) => !(await NP.db.get('employees', i)), id);
    assert.ok(gone);
    const err = await ev(() => NP.emp.remove('KRY-0010').then(() => 'ok', (e) => e.message));
    assert.ok(/Tidak Aktif/.test(err), err);
  });
  await step('ekspor Excel karyawan', async () => {
    await page.fill('#f-q', '');
    const d = await download(() => page.click('[data-act=export]'));
    assert.ok(d.name.endsWith('.xlsx') && d.size > 3000);
  });

  await step('impor Excel karyawan (dengan pratinjau & validasi)', async () => {
    const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
    const rows = [
      { 'Nama Lengkap': 'Impor Satu', Telepon: '081300000001', 'Unit (APT/KLINIK/LINTAS)': 'APT', Jabatan: 'Kasir', Departemen: 'Kasir & Penjualan', 'Gaji Pokok': 2500000, 'Skema Gaji': 'monthly', 'Tanggal Mulai (YYYY-MM-DD)': '2026-01-05' },
      { 'Nama Lengkap': 'X', Telepon: '', 'Unit (APT/KLINIK/LINTAS)': 'APT', Jabatan: 'Kasir', Departemen: '' }
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Karyawan');
    const file = path.join(require('os').tmpdir(), 'impor-karyawan-uji.xlsx');
    fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act=import]')]);
    await fc.setFiles(file);
    await page.waitForSelector('.modal .tbl');
    assert.ok(/1 baris valid, 1 baris bermasalah/.test(await page.locator('.modal-body').innerText()));
    await modalBtn('Impor 1 karyawan').click();
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const e = await ev(async () => (await NP.db.all('employees')).find((x) => x.name === 'Impor Satu'));
    assert.ok(e && e.baseSalary === 2500000 && e.startDate === '2026-01-05');
  });

  console.log('Master tindakan & revenue sharing');
  await step('tambah tindakan baru (kombinasi, 3 penerima) dengan preview', async () => {
    await go('services');
    await page.click('[data-act=add]');
    const m = page.locator('.svc-form');
    await m.locator('[name=name]').fill('Tes Hemoglobin');
    await m.locator('[name=category]').selectOption('Pemeriksaan laboratorium sederhana');
    await m.locator('[name=unit]').selectOption('APT');
    await m.locator('[name=price]').fill('40000');
    await m.locator('[name=method]').selectOption('combo');
    const rows = m.locator('#share-main .share-row:not(.share-head)');
    // baris 1: unit APT sisa, baris 2: bidan nominal 10.000, tambah baris 3: penerima lain 10%
    await rows.nth(0).locator('[data-f=mode]').selectOption('remainder');
    await rows.nth(1).locator('[data-f=value]').fill('10000');
    await m.locator('#share-main [data-add]').click();
    const r3 = m.locator('#share-main .share-row:not(.share-head)').nth(2);
    await r3.locator('[data-f=type]').selectOption('other');
    await m.locator('#share-main .share-row:not(.share-head)').nth(2).locator('[data-f=target]').fill('Lab Mitra');
    await m.locator('#share-main .share-row:not(.share-head)').nth(2).locator('[data-f=mode]').selectOption('percent');
    await m.locator('#share-main .share-row:not(.share-head)').nth(2).locator('[data-f=value]').fill('10');
    await page.waitForTimeout(300);
    const prev = await m.locator('#share-preview').innerText();
    assert.ok(/Rp26\.000/.test(prev) && /Rp4\.000/.test(prev) && /sesuai/.test(prev), prev);
    await modalBtn('Simpan Tindakan').click();
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const s = await ev(async () => (await NP.db.all('services')).find((x) => x.name === 'Tes Hemoglobin'));
    assert.ok(s && s.method === 'combo' && s.shares.length === 3);
  });
  await step('validasi: pembagian melebihi harga ditolak', async () => {
    await page.click('[data-act=add]');
    const m = page.locator('.svc-form');
    await m.locator('[name=name]').fill('Tindakan Salah');
    await m.locator('[name=price]').fill('20000');
    const rows = m.locator('#share-main .share-row:not(.share-head)');
    await rows.nth(0).locator('[data-f=value]').fill('15000');
    await rows.nth(1).locator('[data-f=value]').fill('10000');
    await page.waitForTimeout(250);
    assert.ok(/melebihi/.test(await m.locator('#share-preview').innerText()));
    await modalBtn('Simpan Tindakan').click();
    await page.waitForSelector('.svc-form .form-error:not([hidden])');
    await modalBtn('Batal').click();
  });
  await step('edit harga tindakan tidak mengubah transaksi historis', async () => {
    const r = await ev(async () => {
      const s = (await NP.db.all('services')).find((x) => x.name === 'Pemeriksaan Gula Darah');
      const t = (await NP.db.all('transactions')).find((x) => x.items.some((i) => i.serviceId === s.id));
      const before = t.items.find((i) => i.serviceId === s.id).price;
      s.price = 35000;
      s.shares = [{ type: 'unit', target: 'APT', mode: 'nominal', value: 23000 }, { type: 'role', target: 'bidan', mode: 'nominal', value: 12000 }];
      await NP.svc.save(s);
      const after = (await NP.trx.get(t.id)).items.find((i) => i.serviceId === s.id).price;
      // kembalikan
      s.price = 28000;
      s.shares = [{ type: 'unit', target: 'APT', mode: 'nominal', value: 18000 }, { type: 'role', target: 'bidan', mode: 'nominal', value: 10000 }];
      await NP.svc.save(s);
      return { before, after };
    });
    assert.strictEqual(r.before, 28000);
    assert.strictEqual(r.after, 28000);
  });
  await step('nonaktifkan tindakan → hilang dari input transaksi', async () => {
    const id = await ev(async () => (await NP.db.all('services')).find((x) => x.name === 'Tes Hemoglobin').id);
    await ev((i) => NP.svc.setActive(i, false), id);
    await go('input');
    assert.strictEqual(await page.locator(`.item-row [data-f=serviceId] option[value="${id}"]`).count(), 0);
    await ev((i) => NP.svc.setActive(i, true), id);
  });

  console.log('Input tindakan');
  let trxGula;
  await step('input Gula Darah × 5 oleh bidan baru: Rp140.000 / Rp90.000 / Rp50.000', async () => {
    await go('input');
    const gid = await ev(async () => (await NP.db.all('services')).find((x) => x.name === 'Pemeriksaan Gula Darah').id);
    const bid = await ev(async () => (await NP.db.all('employees')).find((x) => x.name === 'Bd. Uji Coba').id);
    await page.selectOption('.item-row [data-f=serviceId]', gid);
    assert.strictEqual(await page.inputValue('.item-row [data-f=price]'), '28.000');
    await page.selectOption('.item-row [data-perf=bidan]', bid);
    for (let i = 0; i < 4; i++) await page.click('.item-row [data-step="1"]');
    await page.fill('.input-form [name=patient]', 'Pasien Uji');
    const sum = await page.locator('#sum-box').innerText();
    assert.ok(/Rp140\.000/.test(sum) && /Rp90\.000/.test(sum) && /Rp50\.000/.test(sum), sum);
    await clickToast('[data-act=save]', /tersimpan/);
    trxGula = await ev(async () => (await NP.db.all('transactions')).find((t) => t.patient === 'Pasien Uji'));
    assert.strictEqual(trxGula.totals.gross, 140000);
    assert.strictEqual(trxGula.totals.apotek, 90000);
    assert.strictEqual(trxGula.totals.bidan, 50000);
    assert.ok(/^TRX-\d{6}-\d{4}$/.test(trxGula.id));
  });
  await step('input beberapa tindakan dalam satu transaksi (dokter + bidan)', async () => {
    await go('input');
    const ids = await ev(async () => {
      const s = await NP.db.all('services');
      const e = await NP.db.all('employees');
      return { kons: s.find((x) => x.name === 'Konsultasi Dokter Umum').id, au: s.find((x) => x.name === 'Pemeriksaan Asam Urat').id, dr: e.find((x) => x.name === 'dr. Siti Rahmawati').id, bd: e.find((x) => x.name === 'Bd. Uji Coba').id };
    });
    await page.selectOption('.item-row [data-f=serviceId]', ids.kons);
    await page.selectOption('.item-row [data-perf=dokter]', ids.dr);
    await page.click('[data-act=add-row]');
    await page.selectOption('.item-row >> nth=1 >> [data-f=serviceId]', ids.au);
    await page.selectOption('.item-row >> nth=1 >> [data-perf=bidan]', ids.bd);
    await page.fill('.input-form [name=patient]', 'Pasien Multi');
    const sum = await page.locator('#sum-box').innerText();
    assert.ok(/Rp130\.000/.test(sum), sum);
    await clickToast('[data-act=save]', /tersimpan/);
    const t = await ev(async () => (await NP.db.all('transactions')).find((x) => x.patient === 'Pasien Multi'));
    assert.strictEqual(t.items.length, 2);
    assert.strictEqual(t.totals.dokter, 40000);
    assert.strictEqual(t.totals.bidan, 10000);
    assert.strictEqual(t.totals.apotek, 80000);
  });
  await step('tanpa memilih petugas → tidak bisa disimpan', async () => {
    await go('input');
    const gid = await ev(async () => (await NP.db.all('services')).find((x) => x.name === 'Konsultasi Dokter Umum').id);
    await page.selectOption('.item-row [data-f=serviceId]', gid);
    if (await page.locator('.item-row [data-perf=dokter]').inputValue()) await page.selectOption('.item-row [data-perf=dokter]', '');
    await page.click('[data-act=save]');
    await page.waitForTimeout(300);
    assert.ok(/belum dipilih/.test(await toastText()));
  });
  await step('edit transaksi (jumlah 5 → 3) tercatat di audit log', async () => {
    await go('input?edit=' + trxGula.id);
    await page.click('.item-row [data-step="-1"]');
    await page.click('.item-row [data-step="-1"]');
    await page.click('[data-act=save]');
    await page.waitForURL(/#\/transactions/);
    const t = await ev((id) => NP.trx.get(id), trxGula.id);
    assert.strictEqual(t.totals.gross, 84000);
    assert.strictEqual(t.totals.bidan, 30000);
    const logs = await ev(async (id) => (await NP.db.all('auditLog')).filter((l) => l.entityId === id && l.action === 'trx.update').length, trxGula.id);
    assert.ok(logs >= 1);
  });
  await step('riwayat transaksi: filter, ekspor Excel & PDF', async () => {
    await go('transactions');
    await page.fill('#h-q', 'Pasien Uji');
    await page.waitForTimeout(300);
    assert.strictEqual(await page.locator('#h-list tbody tr').count(), 1);
    const x = await download(() => page.click('[data-act=xls]'));
    assert.ok(x.name.endsWith('.xlsx'));
    const p = await download(() => page.click('[data-act=pdf]'));
    assert.ok(p.name.endsWith('.pdf') && p.size > 2000);
  });
  await step('batalkan transaksi (wajib alasan) → tidak masuk penggajian', async () => {
    await page.fill('#h-q', 'Pasien Multi');
    await page.waitForTimeout(300);
    await page.locator('#h-list [data-act=cancel]').first().click();
    await modalBtn('Batalkan Transaksi').click();
    await page.waitForSelector('.modal .form-error:not([hidden])');
    await page.fill('.modal [name=v]', 'Salah input pasien');
    await modalBtn('Batalkan Transaksi').click();
    await page.waitForTimeout(400);
    const t = await ev(async () => (await NP.db.all('transactions')).find((x) => x.patient === 'Pasien Multi'));
    assert.strictEqual(t.status, 'cancelled');
    const lines = await ev(async () => {
      const m = NP.income.lines(await NP.db.all('transactions'), NP.u.monthRange(NP.u.todayISO().slice(0, 7)));
      const e = (await NP.db.all('employees')).find((x) => x.name === 'Bd. Uji Coba');
      return (m.get(e.id) || []).map((l) => l.trxId);
    });
    assert.ok(!lines.includes(t.id));
  });

  console.log('Penggajian');
  let runId;
  await step('generate payroll bulan berjalan via wizard (4 langkah)', async () => {
    await go('generate');
    await page.click('#wiz [data-next]');
    await page.waitForSelector('.tbl-grid');
    // isi bonus untuk bidan uji
    const bid = await ev(async () => (await NP.db.all('employees')).find((x) => x.name === 'Bd. Uji Coba').id);
    const row = page.locator(`.tbl-grid tr[data-emp="${bid}"]`);
    await row.locator('[data-k="m:BONUS"]').fill('100000');
    await row.locator('[data-k="m:BONUS"]').dispatchEvent('change');
    await page.click('#wiz [data-next]');
    await page.waitForSelector('#prev-table');
    await page.click('#wiz [data-next]');
    await page.waitForSelector('.confirm-box');
    await page.click('#wiz [data-save]');
    await page.waitForURL(/payroll-history/);
    runId = await ev(async () => (await NP.db.all('payrollRuns')).find((r) => r.period === NP.u.todayISO().slice(0, 7)).id);
    assert.ok(runId);
  });
  await step('slip bidan uji: gaji pokok + jasa otomatis Rp30.000 + bonus', async () => {
    const s = await ev(async (id) => {
      const run = await NP.payroll.get(id);
      return run.slips.find((x) => x.employee.name === 'Bd. Uji Coba');
    }, runId);
    const get = (c) => (s.earnings.find((e) => e.code === c) || {}).amount;
    assert.strictEqual(get('BASE'), 2000000);
    assert.strictEqual(get('JASA'), 30000);
    assert.strictEqual(get('BONUS'), 100000);
    assert.strictEqual(s.serviceDetail[0].qty, 3);
  });
  await step('jasa terpesan oleh draft & tidak bisa dipakai run lain (anti ganda)', async () => {
    const r = await ev(async (id) => {
      const t = (await NP.db.all('transactions')).find((x) => x.patient === 'Pasien Uji');
      const st = t.items[0].shares.find((s) => s.type === 'role').payroll;
      const run = await NP.payroll.get(id);
      const dup = await NP.payroll.saveDraft({ id: '', period: run.period, start: run.start, end: run.end, payDate: run.payDate, unit: 'ALL', employeeIds: [run.employeeIds[0]], inputs: {}, includeEarlier: false }).then(() => 'saved', (e) => e.message);
      return { st, dup };
    }, runId);
    assert.strictEqual(r.st.runId, runId);
    assert.strictEqual(r.st.state, 'draft');
    assert.ok(/beririsan/.test(r.dup), r.dup);
  });
  await step('rekonsiliasi: angka seimbang', async () => {
    await go('income');
    await page.click('[data-tab=recon]');
    await page.waitForSelector('.recon-summary');
    assert.ok(/seimbang/.test(await page.locator('.recon-summary').innerText()));
  });
  await step('setujui → slip terbit bernomor, lalu kunci', async () => {
    await ev((id) => NP.payroll.approve(id), runId);
    await ev((id) => NP.payroll.lock(id), runId);
    const run = await ev((id) => NP.payroll.get(id), runId);
    assert.strictEqual(run.status, 'locked');
    assert.ok(run.slips.every((s) => /^SLIP\/(APT|KLINIK)\/\d{4}\/\d{2}\/\d{4}$/.test(s.slipNo)));
    const st = await ev(async () => (await NP.db.all('transactions')).find((x) => x.patient === 'Pasien Uji').items[0].shares.find((s) => s.type === 'role').payroll.state);
    assert.strictEqual(st, 'locked');
  });
  await step('koreksi transaksi terkunci wajib otorisasi admin → adjustment', async () => {
    const tid = trxGula.id;
    const err = await ev((id) => NP.trx.get(id).then((t) => NP.trx.save({ date: t.date, patient: t.patient, items: t.items.map((i) => ({ lineId: i.lineId, serviceId: i.serviceId, qty: 4, price: i.price, performers: i.performers })) }, { editId: id })).then(() => 'ok', (e) => e.code), tid);
    assert.strictEqual(err, 'LOCKED');
    await go('input?edit=' + tid);
    await page.click('.item-row [data-step="1"]');
    await page.click('[data-act=save]');
    await page.waitForSelector('.modal [name=ap]');
    await page.fill('.modal [name=ap]', 'admin123');
    await page.fill('.modal [name=an]', 'Koreksi jumlah pemeriksaan');
    await modalBtn('Otorisasi').click();
    await page.waitForURL(/#\/transactions/);
    const t = await ev((id) => NP.trx.get(id), tid);
    assert.strictEqual(t.totals.gross, 112000);
    assert.strictEqual(t.adjustments.length, 1);
    assert.strictEqual(t.adjustments[0].amount, 10000);
    assert.ok(t.corrections && t.corrections[0].note === 'Koreksi jumlah pemeriksaan');
  });
  await step('koreksi tertunda masuk penggajian berikutnya tanpa ganda', async () => {
    const r = await ev(async (id) => {
      const cur = await NP.payroll.get(id);
      const next = NP.u.addMonths(cur.period, 1);
      const rg = NP.u.monthRange(next);
      const e = (await NP.db.all('employees')).find((x) => x.name === 'Bd. Uji Coba');
      const run = await NP.payroll.saveDraft({ id: '', period: next, start: rg.start, end: rg.end, payDate: rg.end, unit: 'ALL', employeeIds: [e.id], inputs: {}, includeEarlier: false });
      const s = run.slips[0];
      const out = { koreksi: (s.earnings.find((x) => x.code === 'JASA_KOREKSI') || {}).amount, jasa: (s.earnings.find((x) => x.code === 'JASA') || {}).amount };
      await NP.payroll.remove(run.id);
      return out;
    }, runId);
    assert.strictEqual(r.koreksi, 10000);
    assert.strictEqual(r.jasa, undefined);
  });
  await step('batal setelah koreksi: total koreksi = −jasa awal (tidak dihitung dua kali)', async () => {
    const adj = await ev(async (id) => {
      const t = await NP.trx.get(id);
      await NP.trx.cancel(id, 'Pasien batal', { auth: { by: 'admin', note: 'Uji pembatalan setelah koreksi' } });
      return (await NP.trx.get(id)).adjustments.map((a) => a.amount);
    }, trxGula.id);
    // jasa awal terkunci Rp30.000 → koreksi +Rp10.000 → batal −Rp40.000; bersih −Rp30.000
    assert.deepStrictEqual(adj, [10000, -40000]);
  });
  await step('buka kunci wajib otorisasi; kembali ke draft & hapus', async () => {
    await go('payroll-history?open=' + runId);
    await page.locator('.modal [data-r=unlock]').click();
    await page.fill('.modal-backdrop >> nth=1 >> [name=ap]', 'admin123');
    await page.fill('.modal-backdrop >> nth=1 >> [name=an]', 'Uji buka kunci');
    await modalBtn('Otorisasi').click();
    await page.waitForTimeout(800);
    assert.strictEqual((await ev((id) => NP.payroll.get(id), runId)).status, 'approved');
    await ev((id) => NP.payroll.revert(id), runId);
    await ev((id) => NP.payroll.remove(id), runId);
    const freed = await ev(async () => (await NP.db.all('transactions')).find((x) => x.patient === 'Pasien Multi'));
    assert.ok(freed);
    const st = await ev(async (id) => (await NP.db.all('transactions')).filter((t) => t.items.some((i) => i.shares.some((s) => s.payroll && s.payroll.runId === id))).length, runId);
    assert.strictEqual(st, 0);
  });

  console.log('Dokumen');
  await step('slip gaji: PDF, PNG, HTML', async () => {
    await go('payslips');
    await page.waitForSelector('.slip .s-head');
    const pdf = await download(() => page.click('#sl-actions [data-act=pdf]'));
    assert.ok(pdf.name.endsWith('.pdf') && pdf.size > 20000, pdf.size);
    const png = await download(() => page.click('#sl-actions [data-act=png]'));
    assert.ok(png.name.endsWith('.png') && png.size > 20000);
    const html = await download(() => page.click('#sl-actions [data-act=html]'));
    const content = fs.readFileSync(html.path, 'utf8');
    assert.ok(/SLIP GAJI/.test(content) && /TAKE HOME PAY/.test(content) && !/STR-/.test(content));
  });
  await step('unduh seluruh slip dalam ZIP', async () => {
    const z = await download(() => page.click('[data-act=zip]'));
    assert.ok(z.name.endsWith('.zip') && z.size > 100000);
    const JSZip = require(path.join(ROOT, 'vendor', 'jszip.min.js'));
    const zip = await JSZip.loadAsync(fs.readFileSync(z.path));
    const files = Object.keys(zip.files).filter((f) => f.endsWith('.pdf'));
    assert.ok(files.length >= 15, files.length);
  });
  await step('laporan keuangan: ekspor Excel & PDF', async () => {
    await go('reports');
    await page.selectOption('#rp-mode', 'yearly');
    await page.waitForSelector('#rp-emp tbody tr');
    assert.ok(/Pendapatan kotor/.test(await page.locator('.report-flow').innerText()));
    const x = await download(() => page.click('[data-act=xls]'));
    assert.ok(x.name.endsWith('.xlsx'));
    const p = await download(() => page.click('[data-act=pdf]'));
    assert.ok(p.name.endsWith('.pdf'));
  });

  console.log('Backup & hak akses');
  let backupPath;
  await step('backup JSON', async () => {
    await go('settings?tab=backup');
    const b = await download(() => page.click('[data-b=dl]'));
    backupPath = b.path;
    const j = JSON.parse(fs.readFileSync(b.path, 'utf8'));
    assert.strictEqual(j.app, 'noura-payroll');
    assert.ok(j.data.transactions.length > 100);
  });
  await step('restore JSON memulihkan data', async () => {
    await ev(async () => {
      const e = (await NP.db.all('employees')).find((x) => x.name === 'Bd. Uji Coba');
      e.name = 'Nama Berubah';
      await NP.db.put('employees', e);
    });
    await page.uncheck('#bk-safety');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-b=restore]')]);
    await fc.setFiles(backupPath);
    await modalBtn('Ganti seluruh data').click();
    await page.waitForEvent('load', { timeout: 20000 });
    await page.waitForSelector('.sidebar');
    const n = await ev(async () => (await NP.db.all('employees')).some((x) => x.name === 'Bd. Uji Coba'));
    assert.ok(n);
  });
  await step('peran Viewer tidak bisa membuka Data Karyawan & menu tersaring', async () => {
    await ev(() => sessionStorage.clear());
    await page.goto(BASE + '#/employees');
    await page.reload();
    await page.waitForSelector('.auth-screen');
    await page.fill('[name=username]', 'viewer');
    await page.fill('[name=password]', 'viewer123');
    await page.click('.auth-card button[type=submit]');
    await page.waitForSelector('.sidebar');
    await page.waitForTimeout(400);
    assert.ok(/tidak memiliki hak akses/.test(await page.locator('#view').innerText()));
    const navs = await page.locator('.nav-item').count();
    assert.ok(navs <= 4, navs);
  });
  await step('peran Operasional: rekening tersamar & tidak bisa membatalkan transaksi', async () => {
    await ev(() => sessionStorage.clear());
    await page.goto(BASE + '#/transactions');
    await page.reload();
    await page.waitForSelector('.auth-screen');
    await page.fill('[name=username]', 'operasional');
    await page.fill('[name=password]', 'operasional123');
    await page.click('.auth-card button[type=submit]');
    await page.waitForSelector('#h-list');
    assert.strictEqual(await page.locator('#h-list [data-act=cancel]').count(), 0);
    assert.ok((await ev(() => NP.sec.bankView('1234567890'))).includes('*'));
  });

  console.log('Responsif');
  for (const [name, vp] of [['iPhone', { width: 390, height: 844 }], ['Android', { width: 412, height: 915 }], ['iPad', { width: 820, height: 1180 }], ['Laptop', { width: 1280, height: 800 }]]) {
    await step('tampilan ' + name + ' tanpa scroll horizontal halaman', async () => {
      await page.setViewportSize(vp);
      for (const h of ['dashboard', 'input', 'transactions']) {
        await go(h);
        const over = await ev(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(over <= 1, h + ' overflow ' + over);
      }
    });
  }

  await step('tidak ada error JavaScript selama pengujian', async () => {
    assert.deepStrictEqual(errors, []);
  });

  await browser.close();
  server.close();
  console.log('\n' + passed + ' lulus, ' + failures.length + ' gagal');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
