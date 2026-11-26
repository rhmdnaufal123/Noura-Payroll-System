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
  // Uji ini selalu memakai mode lokal (IndexedDB), apa pun isi js/env.js di repository.
  if (req.url.split('?')[0] === '/js/env.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end('window.NP_CONFIG = { SUPABASE_URL: "", SUPABASE_ANON_KEY: "" };');
  }
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
    console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message).split('\n').slice(0, process.env.E2E_VERBOSE ? 30 : 3).join('\n    '));
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
  /** Tunggu toast yang cocok; bila tidak muncul, tampilkan isi toast terakhir agar penyebabnya terlihat. */
  const waitToast = (re) =>
    page.waitForFunction((src) => new RegExp(src).test([...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' ')), re.source, { timeout: 30000 }).catch(async (e) => {
      throw new Error('Toast /' + re.source + '/ tidak muncul. Toast: ' + (await page.locator('.toast').allInnerTexts().catch(() => [])).join(' | '));
    });
  /** Jalankan aksi lalu tunggu toast BARU yang cocok (toast lama yang masih tampil diabaikan). */
  const newToast = async (fn, re) => {
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => (t.dataset.seen = '1')));
    await fn();
    await page.waitForFunction((src) => [...document.querySelectorAll('.toast:not([data-seen])')].some((t) => new RegExp(src).test(t.textContent)), re.source, { timeout: 30000 }).catch(async () => {
      throw new Error('Toast baru /' + re.source + '/ tidak muncul. Toast: ' + (await page.locator('.toast').allInnerTexts().catch(() => [])).join(' | '));
    });
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
  await step('kata sandi yang diketik cepat tidak berpindah ke kolom nama pengguna', async () => {
    const p2 = await ctx.newPage();
    await p2.addInitScript(() => {
      // Meniru pengguna/pengisian otomatis yang langsung fokus ke kolom sandi saat layar login muncul.
      new MutationObserver(() => {
        const pw = document.querySelector('.auth-screen [name=password]');
        if (pw && !window.__f) {
          window.__f = 1;
          pw.focus();
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await p2.goto(BASE);
    await p2.waitForSelector('.auth-screen');
    await p2.waitForTimeout(150);
    await p2.keyboard.type('Rahasia#2026');
    const v = await p2.evaluate(() => ({ user: document.querySelector('[name=username]').value, pw: document.querySelector('[name=password]').value }));
    await p2.close();
    assert.deepStrictEqual(v, { user: '', pw: 'Rahasia#2026' });
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
    assert.strictEqual(await m.locator('[name=price]').inputValue(), '40.000');
    await page.waitForFunction(() => {
      const t = document.querySelector('#share-preview').innerText;
      return /Rp26\.000/.test(t) && /Rp4\.000/.test(t) && /sesuai/.test(t);
    }, null, { timeout: 10000 }).catch(async () => assert.fail('Preview: ' + (await m.locator('#share-preview').innerText())));
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
    await page.waitForFunction(() => /melebihi/.test(document.querySelector('#share-preview').innerText), null, { timeout: 10000 });
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
  const prevMonthEarly = (() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-03';
  })();
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
  await step('master tindakan: pembagian berbeda dengan dokter & tanpa dokter', async () => {
    await go('services');
    await page.click('[data-act=add]');
    const m = page.locator('.svc-form');
    await m.locator('[name=name]').fill('Suntik Vitamin Uji');
    await m.locator('[name=category]').selectOption('Dokter Umum & Bidan');
    await m.locator('[name=unit]').selectOption('KLINIK');
    await m.locator('[name=price]').fill('200000');
    // tanpa dokter: unit sisa + bidan Rp40.000
    const main = m.locator('#share-main .share-row:not(.share-head)');
    await main.nth(0).locator('[data-f=target]').selectOption('KLINIK');
    await main.nth(0).locator('[data-f=mode]').selectOption('remainder');
    await main.nth(1).locator('[data-f=value]').fill('40000');
    assert.ok(await m.locator('.doctor-split').isHidden());
    await m.locator('[data-dm=variant]').click();
    await m.locator('.doctor-split').waitFor();
    assert.ok(/TANPA dokter/.test(await m.locator('#main-title').innerText()));
    // dengan dokter: salinan + baris dokter otomatis; bidan Rp20.000, dokter Rp60.000
    const doc = m.locator('#share-doctor .share-row:not(.share-head)');
    assert.strictEqual(await doc.count(), 3);
    assert.strictEqual(await doc.nth(2).locator('[data-f=target]').inputValue(), 'dokter');
    await doc.nth(1).locator('[data-f=value]').fill('20000');
    await doc.nth(2).locator('[data-f=value]').fill('60000');
    await page.waitForFunction(() => /Rp120\.000/.test(document.querySelector('#share-preview-doctor').innerText) && /Rp160\.000/.test(document.querySelector('#share-preview').innerText), null, { timeout: 10000 })
      .catch(async () => assert.fail('Preview: ' + (await m.locator('#share-preview-doctor').innerText())));
    await modalBtn('Simpan Tindakan').click();
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const s = await ev(async () => (await NP.db.all('services')).find((x) => x.name === 'Suntik Vitamin Uji'));
    assert.deepStrictEqual(s.doctorShares.map((x) => [x.type, x.target, x.value]), [['unit', 'KLINIK', 0], ['role', 'bidan', 20000], ['role', 'dokter', 60000]]);
    assert.ok(/Dengan dokter/.test(await page.locator('#svc-list').innerText()));
  });
  await step('input tindakan: pilih dengan/tanpa dokter → pembagian & pelaksana mengikuti pilihan', async () => {
    await go('input');
    const ids = await ev(async () => {
      const s = await NP.db.all('services');
      const e = await NP.db.all('employees');
      // bidan lain (bukan "Bd. Uji Coba") agar uji slip penggajian di bawah tidak terpengaruh
      const bd = e.find((x) => x.position === 'Bidan' && x.status === 'aktif' && x.name !== 'Bd. Uji Coba');
      return { sv: s.find((x) => x.name === 'Suntik Vitamin Uji').id, dr: e.find((x) => x.name === 'dr. Siti Rahmawati').id, bd: bd.id };
    });
    await page.selectOption('.item-row [data-f=serviceId]', ids.sv);
    await page.waitForSelector('.item-variant [data-wd="0"].active');
    assert.strictEqual(await page.locator('.item-row [data-perf=dokter]').count(), 0, 'tanpa dokter tidak meminta dokter');
    await page.selectOption('.item-row [data-perf=bidan]', ids.bd);
    let sum = await page.locator('#sum-box').innerText();
    assert.ok(/Rp160\.000/.test(sum) && /Rp40\.000/.test(sum), sum);
    await page.fill('.input-form [name=patient]', 'Pasien Tanpa Dokter');
    await clickToast('[data-act=save]', /tersimpan/);
    await page.selectOption('.item-row [data-f=serviceId]', ids.sv);
    await page.click('.item-variant [data-wd="1"]');
    await page.waitForSelector('.item-row [data-perf=dokter]');
    await page.selectOption('.item-row [data-perf=dokter]', ids.dr);
    if (!(await page.inputValue('.item-row [data-perf=bidan]'))) await page.selectOption('.item-row [data-perf=bidan]', ids.bd);
    sum = await page.locator('#sum-box').innerText();
    assert.ok(/Rp120\.000/.test(sum) && /Rp60\.000/.test(sum) && /Rp20\.000/.test(sum), sum);
    await page.fill('.input-form [name=patient]', 'Pasien Dengan Dokter');
    await clickToast('[data-act=save]', /tersimpan/);
    const got = await ev(async () => {
      const ts = await NP.db.all('transactions');
      const f = (p) => ts.find((t) => t.patient === p);
      return [f('Pasien Tanpa Dokter'), f('Pasien Dengan Dokter')].map((t) => ({ wd: t.items[0].withDoctor, roles: Object.keys(t.items[0].performers).sort(), klinik: t.totals.klinik, dokter: t.totals.dokter, bidan: t.totals.bidan }));
    });
    assert.deepStrictEqual(got, [{ wd: false, roles: ['bidan'], klinik: 160000, dokter: 0, bidan: 40000 }, { wd: true, roles: ['bidan', 'dokter'], klinik: 120000, dokter: 60000, bidan: 20000 }]);
    await go('transactions');
    assert.ok(/Suntik Vitamin Uji \(dengan dokter\)/.test(await page.locator('#view').innerText()));
  });
  await step('input tindakan: pasien yang diperiksa dokter → otomatis "dengan dokter", tetap dapat diubah', async () => {
    const ids = await ev(async () => {
      const s = await NP.db.all('services');
      const e = await NP.db.all('employees');
      const bd = e.find((x) => x.position === 'Bidan' && x.status === 'aktif' && x.name !== 'Bd. Uji Coba');
      return { sv: s.find((x) => x.name === 'Suntik Vitamin Uji').id, kons: s.find((x) => x.name === 'Konsultasi Dokter Umum').id, dr: e.find((x) => x.name === 'dr. Siti Rahmawati').id, bd: bd.id };
    });
    // 1) pemeriksaan dokter untuk pasien ini hari ini
    await go('input');
    await page.selectOption('.item-row [data-f=serviceId]', ids.kons);
    await page.selectOption('.item-row [data-perf=dokter]', ids.dr);
    await page.fill('.input-form [name=patient]', 'Ny. Periksa Dokter');
    await clickToast('[data-act=save]', /tersimpan/);
    // 2) tindakan berikutnya untuk pasien yang sama (penulisan berbeda) → otomatis dengan dokter
    await page.selectOption('.item-row [data-f=serviceId]', ids.sv);
    await page.waitForSelector('.item-variant [data-wd="0"].active');
    await page.fill('.input-form [name=patient]', 'NY. PERIKSA DOKTER');
    await page.waitForSelector('.item-variant [data-wd="1"].active');
    assert.ok(/Otomatis dengan dokter: pasien ini diperiksa dokter/.test(await page.locator('.item-variant').innerText()));
    assert.strictEqual(await page.inputValue('.item-row [data-perf=dokter]'), ids.dr, 'dokter pelaksana = dokter yang memeriksa');
    // ubah manual ke tanpa dokter → tidak ditimpa lagi oleh aturan otomatis
    await page.click('.item-variant [data-wd="0"]');
    await page.fill('.input-form [name=patient]', 'Ny. Periksa Dokter ');
    await page.waitForTimeout(400);
    assert.ok(await page.locator('.item-variant [data-wd="0"].active').count(), 'pilihan manual dipertahankan');
    assert.ok(/diubah manual/.test(await page.locator('.item-variant').innerText()));
    assert.ok(/Jadikan dengan dokter/.test(await page.locator('#wd-hint').innerText()), 'saran tetap ditampilkan');
    await page.click('#wd-hint [data-act=wd-all]');
    await page.waitForSelector('.item-row [data-perf=dokter]');
    await page.selectOption('.item-row [data-perf=dokter]', ids.dr);
    if (!(await page.inputValue('.item-row [data-perf=bidan]'))) await page.selectOption('.item-row [data-perf=bidan]', ids.bd);
    await clickToast('[data-act=save]', /tersimpan/);
    const t = await ev(async () => (await NP.db.all('transactions')).filter((x) => /periksa dokter/i.test(x.patient)).map((x) => x.items.map((i) => [i.serviceName, !!i.withDoctor])));
    assert.deepStrictEqual(t.sort(), [[['Konsultasi Dokter Umum', false]], [['Suntik Vitamin Uji', true]]].sort());
    // 3) pemeriksaan dokter dalam transaksi yang sama (tanpa nama pasien pun) → otomatis
    await page.selectOption('.item-row [data-f=serviceId]', ids.kons);
    await page.click('[data-act=add-row]');
    await page.selectOption('.item-row >> nth=1 >> [data-f=serviceId]', ids.sv);
    await page.waitForSelector('.item-row >> nth=1 >> .item-variant [data-wd="1"].active');
    await page.click('[data-act=reset]');
  });
  await step('daftar Input Tindakan: dengan/tanpa dokter satu per satu, saran & otomasi', async () => {
    const ids = await ev(async () => {
      const s = await NP.db.all('services');
      const e = await NP.db.all('employees');
      const bd = e.find((x) => x.position === 'Bidan' && x.status === 'aktif' && x.name !== 'Bd. Uji Coba');
      return { sv: s.find((x) => x.name === 'Suntik Vitamin Uji').id, kons: s.find((x) => x.name === 'Konsultasi Dokter Umum').id, dr: e.find((x) => x.name === 'dr. Siti Rahmawati').id, bd: bd.id };
    });
    const itemOf = (patient) => ev(async (p) => {
      const t = (await NP.db.all('transactions')).find((x) => x.patient === p && x.items.some((i) => i.serviceName === 'Suntik Vitamin Uji'));
      const i = t.items.find((x) => x.serviceName === 'Suntik Vitamin Uji');
      return { id: t.id, wd: !!i.withDoctor, dokter: i.performers.dokter || '', bidan: i.performers.bidan || '' };
    }, patient);
    await go('input');
    // 1) tindakan dulu (tanpa dokter), pemeriksaan dokter kemudian → ditawari mengubah otomatis
    await page.fill('.input-form [name=patient]', 'Tn. Urutan Dua');
    await page.selectOption('.item-row [data-f=serviceId]', ids.sv);
    await page.selectOption('.item-row [data-perf=bidan]', ids.bd);
    await clickToast('[data-act=save]', /tersimpan/);
    assert.strictEqual((await itemOf('Tn. Urutan Dua')).wd, false);
    await page.fill('.input-form [name=patient]', 'Tn. Urutan Dua');
    await page.selectOption('.item-row [data-f=serviceId]', ids.kons);
    await page.selectOption('.item-row [data-perf=dokter]', ids.dr);
    await page.click('[data-act=save]');
    await page.waitForSelector('.modal-head:has-text("Pasien diperiksa dokter")');
    await newToast(() => modalBtn('Ya, ubah').click(), /1 transaksi diubah menjadi dengan dokter/);
    let it = await itemOf('Tn. Urutan Dua');
    assert.deepStrictEqual([it.wd, it.dokter, it.bidan], [true, ids.dr, ids.bd], 'dokter pelaksana = dokter yang memeriksa');
    // 2) daftar: label dapat diklik satu per satu
    const lbl = () => page.locator(`#today-list [data-tl="${it.id}"]`);
    await page.waitForFunction((id) => { const b = document.querySelector('#today-list [data-tl="' + id + '"]'); return b && /dengan dokter/.test(b.textContent); }, it.id);
    await newToast(() => lbl().click(), /→ tanpa dokter/);
    assert.strictEqual((await itemOf('Tn. Urutan Dua')).wd, false);
    // 3) aturan otomatis: tindakan pasien yang diperiksa dokter ditandai & dapat diterapkan sekaligus
    await page.waitForSelector('#tl-auto [data-act=tl-auto]');
    assert.ok(/Terapkan otomatis \(1\)/.test(await page.locator('#tl-auto').innerText()));
    assert.ok(await page.locator('#today-list tr.tl-sugg').count() >= 1);
    await newToast(() => page.click('#tl-auto [data-act=tl-auto]'), /1 transaksi diubah menjadi dengan dokter/);
    it = await itemOf('Tn. Urutan Dua');
    assert.deepStrictEqual([it.wd, it.dokter], [true, ids.dr]);
    await page.waitForFunction(() => !document.querySelector('#tl-auto [data-act=tl-auto]'));
    // 4) dokter belum diketahui → aplikasi menanyakan dokter
    await page.fill('.input-form [name=patient]', 'Ny. Tanpa Periksa');
    await page.selectOption('.item-row [data-f=serviceId]', ids.sv);
    await page.selectOption('.item-row [data-perf=bidan]', ids.bd);
    await clickToast('[data-act=save]', /tersimpan/);
    const t2 = await itemOf('Ny. Tanpa Periksa');
    await page.waitForSelector(`#today-list [data-tl="${t2.id}"]`);
    await page.click(`#today-list [data-tl="${t2.id}"]`);
    await page.waitForSelector('.modal-head:has-text("Dokter pelaksana")');
    await page.selectOption('.modal [name=doc]', ids.dr);
    await newToast(() => modalBtn('Pilih').click(), /→ dengan dokter/);
    assert.deepStrictEqual([(await itemOf('Ny. Tanpa Periksa')).wd, (await itemOf('Ny. Tanpa Periksa')).dokter], [true, ids.dr]);
    // 5) tanggal daftar mengikuti tanggal form
    await page.fill('.input-form [name=date]', prevMonthEarly);
    await page.dispatchEvent('.input-form [name=date]', 'change');
    await page.waitForFunction((d) => document.querySelector('#tl-date').value === d, prevMonthEarly);
    await page.fill('.input-form [name=date]', await ev(() => NP.u.todayISO()));
    await page.dispatchEvent('.input-form [name=date]', 'change');
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
    // cap digital pengesahan ikut di file HTML
    assert.ok(/class="s-stamp" src="data:image\/svg\+xml;base64,/.test(content) && /Kode verifikasi/.test(content), 'cap digital di HTML');
    // dokter menerima SLIP PENGHASILAN; penerima "Dokter"; karyawan lain tetap SLIP GAJI
    const k = await ev(async () => {
      const run = (await NP.payroll.runs()).find((r) => r.status !== 'draft' && r.slips.length);
      const base = run.slips[0];
      const as = (position) => {
        const s = Object.assign({}, base, { employee: Object.assign({}, base.employee, { position }) });
        const el = document.createElement('div');
        el.innerHTML = NP.slip.html(run, s);
        const svg = atob(el.querySelector('.s-stamp').src.split(',')[1]);
        return { title: el.querySelector('.s-title h1').textContent, recv: el.querySelectorAll('.s-sign > div')[1].querySelectorAll('small')[1].textContent, net: el.querySelector('.thp span').textContent, stamp: /PENGESAHAN SLIP [A-Z]+/.exec(svg)[0], file: NP.slip.kind(s).file };
      };
      return { dokter: as('Dokter Umum'), bidan: as('Bidan') };
    });
    assert.deepStrictEqual(k.dokter, { title: 'SLIP PENGHASILAN', recv: 'Dokter', net: 'PENGHASILAN BERSIH / TAKE HOME PAY', stamp: 'PENGESAHAN SLIP PENGHASILAN', file: 'slip-penghasilan' });
    assert.deepStrictEqual(k.bidan, { title: 'SLIP GAJI', recv: 'Karyawan', net: 'GAJI BERSIH / TAKE HOME PAY', stamp: 'PENGESAHAN SLIP GAJI', file: 'slip-gaji' });
  });
  await step('cap digital: tanggal & jam pengesahan, kode verifikasi, ikut di PNG/PDF; draft tanpa cap', async () => {
    await go('payslips');
    await page.waitForSelector('#sl-vp .slip .s-sah');
    const sah = await page.locator('#sl-vp .s-sah').innerText();
    const m = sah.match(/Disahkan secara digital pada (\d{1,2} \w+ \d{4}) pukul (\d{2}\.\d{2}) WIB.*Kode verifikasi ([0-9A-F]{4}-[0-9A-F]{4})/);
    assert.ok(m, sah);
    // isi cap: label, tanggal, jam, kode (SVG di dalam gambar)
    const svg = await ev(() => atob(document.querySelector('#sl-vp .s-stamp').src.split(',')[1]));
    assert.ok(/DISAHKAN/.test(svg) && new RegExp(m[2] + ' WIB').test(svg) && svg.includes(m[3]), 'isi cap');
    // waktu cap = saat penggajian disetujui (WIB)
    const exp = await ev(async () => {
      const run = (await NP.payroll.runs()).find((r) => r.status !== 'draft' && r.slips.length);
      const s = run.slips[0];
      return { code: NP.slip.verifyCode(run, s), info: NP.slip.stampInfo(run, s), approvedAt: run.approvedAt, draft: (await NP.payroll.runs()).find((r) => r.status === 'draft' && r.slips.length) };
    });
    assert.ok(exp.code && /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(exp.code));
    // PNG/PDF (html2canvas): cap benar-benar tergambar → piksel hijau di area tanda tangan bertambah
    const px = await ev(async () => {
      const run = (await NP.payroll.runs()).find((r) => r.status !== 'draft' && r.slips.length);
      const s = run.slips[0];
      const green = async (on) => {
        const old = NP.state.settings.slip.stampEnabled;
        NP.state.settings.slip.stampEnabled = on;
        const c = await NP.exp.toCanvas(NP.slip.html(run, s), 794);
        NP.state.settings.slip.stampEnabled = old;
        const d = c.getContext('2d').getImageData(0, Math.floor(c.height * 0.6), Math.floor(c.width / 2), Math.floor(c.height * 0.4)).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 1] > d[i] + 40 && d[i + 1] > d[i + 2] + 20) n++;
        return n;
      };
      return { on: await green(true), off: await green(false) };
    });
    assert.ok(px.on - px.off > 3000, 'cap tidak tergambar di PNG/PDF: ' + JSON.stringify(px));
    // verifikasi kode di halaman Slip Gaji
    await page.click('[data-act=verify]');
    await page.fill('.modal [name=v]', m[3].toLowerCase());
    await modalBtn('Periksa').click();
    await page.waitForSelector('.modal-head:has-text("Slip sah")');
    await modalBtn('Tampilkan slip').click();
    await page.click('[data-act=verify]');
    await page.fill('.modal [name=v]', '0000-0000');
    await modalBtn('Periksa').click();
    await page.waitForSelector('.modal-head:has-text("Kode tidak dikenal")');
    await modalBtn('Tutup').click();
    // slip draft tidak diberi cap
    const draftHtml = await ev(async () => {
      const run = (await NP.payroll.runs()).find((r) => r.status === 'draft' && r.slips.length);
      return run ? NP.slip.html(run, run.slips[0]) : null;
    });
    if (draftHtml) assert.ok(!/s-stamp/.test(draftHtml) && /DRAFT/.test(draftHtml));
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

  console.log('Input bulanan, impor POS & analisis tindakan');
  const prevMonth = (() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  })();
  await step('input bulanan: tabel per tanggal → satu transaksi per tanggal, isian tersimpan sementara', async () => {
    await go('bulk?month=' + prevMonth);
    assert.strictEqual(await page.inputValue('#bk-month'), prevMonth);
    await page.selectOption('#bk-add', { index: 1 });
    await page.waitForSelector('.bk-table tbody tr');
    for (const sel of await page.locator('.bk-table tbody tr select[data-perf]').all()) await sel.selectOption({ index: 1 });
    await page.fill('.bk-table tbody tr .bk-cell[data-d="1"]', '2');
    await page.fill('.bk-table tbody tr .bk-cell[data-d="2"]', '1');
    assert.ok(/3/.test(await page.locator('#bk-sum').innerText()));
    // berpindah halaman lalu kembali: isian belum hilang
    await go('dashboard');
    await go('bulk?month=' + prevMonth);
    assert.strictEqual(await page.inputValue('.bk-table tbody tr .bk-cell[data-d="1"]'), '2');
    const before = await ev(async () => (await NP.db.all('transactions')).length);
    await page.click('[data-act=save]');
    await modalBtn('Simpan semua').waitFor();
    await modalBtn('Simpan semua').click();
    await waitToast(/transaksi tersimpan/);
    const made = await ev(async () => (await NP.db.all('transactions')).filter((t) => /^Input bulanan/.test(t.note)).map((t) => [t.date.slice(8), 0, t.items.reduce((s, i) => s + i.qty, 0)]));
    assert.strictEqual(await ev(async () => (await NP.db.all('transactions')).length), before + 2);
    assert.deepStrictEqual(made.map((x) => [x[0], x[2]]).sort(), [['01', 2], ['02', 1]]);
    await page.waitForSelector('.bk-table, .empty');
    assert.strictEqual(await page.locator('.bk-table tbody tr').count(), 0, 'tabel dikosongkan setelah disimpan');
  });
  let posFile;
  const fx = require('./support/pos-fixture.js');
  const FX = fx.build({ year: +prevMonth.slice(0, 4), month: +prevMonth.slice(5) });
  const setDefaults = async () => {
    for (let i = 0; i < 4; i++) {
      const s = page.locator('select[data-def]').nth(i);
      if (!(await s.count())) break;
      if (!(await s.inputValue())) {
        await s.selectOption({ index: 1 });
        await page.waitForTimeout(300);
      }
    }
  };
  await step('impor POS: tindakan baru ke master, 52 tindakan Rp6.327.000 diimpor, impor ulang dilewati', async () => {
    const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
    posFile = fx.writeXlsx(XLSX, path.join(require('os').tmpdir(), 'penjualan-pos-uji.xlsx'), { year: +prevMonth.slice(0, 4), month: +prevMonth.slice(5) });
    await go('bulk?tab=pos');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act=pick]')]);
    await fc.setFiles(posFile);
    await page.waitForSelector('.pos-cats');
    await setDefaults();
    // master demo "Pemeriksaan Asam Urat" membagi Rp30.000 padahal harga di file Rp28.000:
    // pratinjau harus menolak SEBELUM ada data tersimpan
    const txt = await page.locator('#pos-body').innerText();
    if (/melebihi harga jual/.test(txt)) {
      assert.ok(await page.locator('[data-act=import]').isDisabled(), 'impor harus dinonaktifkan bila ada masalah');
      await ev(async () => {
        for (const s of await NP.svc.all()) if (/^pemeriksaan asam urat$/i.test(s.name)) await NP.svc.save(Object.assign({}, s, { name: s.name + ' (tarif lama)' }));
      });
      // render ulang pratinjau (lepas lalu centang lagi), menunggu setiap render selesai
      await page.uncheck('.pos-cats input[data-cat="HOMECARE"]');
      await page.waitForFunction(() => { const c = document.querySelector('.pos-cats input[data-cat="HOMECARE"]'); return c && !c.checked; });
      await page.check('.pos-cats input[data-cat="HOMECARE"]');
      await page.waitForFunction(() => { const c = document.querySelector('.pos-cats input[data-cat="HOMECARE"]'); return c && c.checked && !/melebihi harga jual/.test(document.querySelector('#pos-body').innerText); });
    }
    const cats = await page.locator('.pos-cats input:checked').evaluateAll((els) => els.map((e) => e.dataset.cat).sort());
    assert.deepStrictEqual(cats, ['DOKTER DAN BIDAN', 'HOMECARE']);
    if (await page.locator('[data-act=create-master]').count()) {
      await page.click('[data-act=create-master]');
      await waitToast(/ditambahkan ke Master Tindakan/);
      await page.waitForSelector('[data-act=create-master]', { state: 'detached' });
    }
    await setDefaults();
    // halaman pratinjau tetap sama saat pratinjau digambar ulang (mis. klik label dengan/tanpa dokter)
    await page.click('#pos-table [data-pg=next]');
    await page.waitForFunction(() => /^2\//.test(document.querySelector('#pos-table .pg-num').textContent));
    // tunggu sampai pratinjau benar-benar digambar ulang (elemen lama terlepas), bukan hanya kotak centangnya berubah
    const rerendered = async (fn) => {
      const old = await page.$('#pos-table');
      await fn();
      await page.waitForFunction((el) => !el.isConnected && document.querySelector('#pos-table .pg-num'), old);
    };
    await rerendered(() => page.uncheck('.pos-cats input[data-cat="HOMECARE"]'));
    await rerendered(() => page.check('.pos-cats input[data-cat="HOMECARE"]'));
    assert.ok(await page.locator('.pos-cats input[data-cat="HOMECARE"]').isChecked());
    assert.ok(/^2\//.test(await page.locator('#pos-table .pg-num').innerText()), 'halaman pratinjau kembali ke awal');
    const btn = page.locator('[data-act=import]');
    assert.ok(await btn.isEnabled(), await page.locator('#pos-body').innerText());
    assert.ok(new RegExp('Impor ' + FX.expect.transactions + ' transaksi').test(await btn.innerText()));
    await btn.click();
    await modalBtn('Impor sekarang').click();
    await waitToast(/transaksi diimpor/);
    const got = await ev(async () => {
      const ts = (await NP.db.all('transactions')).filter((t) => t.externalRef && t.externalRef.startsWith('POS:'));
      return { n: ts.length, qty: ts.reduce((s, t) => s + t.items.reduce((a, i) => a + i.qty, 0), 0), gross: ts.reduce((s, t) => s + t.totals.gross, 0), patients: ts.filter((t) => t.patient).length };
    });
    assert.deepStrictEqual(got, { n: FX.expect.transactions, qty: 52, gross: 6327000, patients: FX.expect.withPatient });
    await page.waitForSelector('[data-act=import][disabled]');
    assert.ok(/sudah pernah diimpor/.test(await page.locator('#pos-body').innerText()));
  });
  await step('analisis tindakan: kelompok Homecare & Dokter Umum & Bidan, filter, ekspor Excel', async () => {
    await go('analysis?month=' + prevMonth);
    await page.waitForFunction(() => /1\.510\.000/.test(document.querySelector('.an-group[data-group=homecare]').textContent));
    const hc = await page.locator('.an-group[data-group=homecare]').innerText();
    // homecare dihitung per kunjungan pasien (nama & tanggal, atau per transaksi bila tanpa nama)
    const visits = await ev(async (m) => {
      const s = new Set();
      for (const t of await NP.db.all('transactions')) if (t.status === 'active' && t.date.startsWith(m) && t.items.some((i) => NP.C.serviceGroup(i.category, i.serviceName) === 'homecare')) s.add(NP.C.visitKey(t));
      return s.size;
    }, prevMonth);
    assert.ok(new RegExp('^' + visits + ' kunjungan', 'm').test(hc) && (visits === 5 || /5 tindakan/.test(hc)), hc + ' / kunjungan ' + visits);
    const db = await page.locator('.an-group[data-group=dokter_bidan]').innerText();
    assert.ok(/tindakan/.test(db));
    await page.click('.an-group[data-group=homecare]');
    await page.waitForFunction(() => document.querySelectorAll('#an-svc tbody tr').length === 4);
    assert.ok(/Infus Multivitamin Hc|INFUS MULTIVITAMIN HC/i.test(await page.locator('#an-svc').innerText()));
    await page.fill('#an-q', 'INFUS');
    await page.waitForFunction(() => document.querySelectorAll('#an-svc tbody tr').length === 1);
    const x = await download(() => page.click('[data-act=xls]'));
    assert.ok(/^analisis-tindakan-.*\.xlsx$/.test(x.name), x.name);
    await page.fill('#an-q', '');
    await page.click('.seg-btn[data-group=ALL]');
  });
  await step('jasa bidan homecare: aturan Rp100.000 per kunjungan disimpan & diterapkan ke transaksi bulan itu', async () => {
    await go('bulk?tab=homecare&month=' + prevMonth);
    await page.waitForSelector('.hc-svc');
    const st = await page.locator('.hc-svc tbody tr').evaluateAll((trs) => trs.map((tr) => [tr.querySelector('td:nth-child(2) b').textContent.toUpperCase(), tr.querySelector('.flag').textContent]));
    const byName = Object.fromEntries(st);
    assert.ok(/Khusus dokter/.test(byName['PEMERIKSAAN DOKTER UMUM HC']), JSON.stringify(st));
    assert.ok(/Akan diubah/.test(byName['INFUS MULTIVITAMIN HC']) && /Akan diubah/.test(byName['PAKET PEMERIKSAAN HC']), JSON.stringify(st));
    // nominal jasa bidan diatur satu per satu: Paket Pemeriksaan HC Rp80.000
    const paketRow = page.locator('.hc-svc tbody tr', { hasText: /PAKET PEMERIKSAAN HC/i });
    const old = await page.$('.hc-svc');
    await paketRow.locator('input[data-hcamt]').fill('80.000');
    await paketRow.locator('input[data-hcamt]').dispatchEvent('change');
    await page.waitForFunction((el) => !el.isConnected && /menjadi Rp80\.000 per kunjungan/.test(document.querySelector('.hc-svc').innerText), old);
    await newToast(async () => {
      await page.click('[data-hc=save-rule]');
      await modalBtn('Simpan aturan').click();
    }, /per kunjungan disimpan/);
    await page.waitForFunction(() => /Aturan sudah tersimpan/.test(document.querySelector('[data-hc=save-rule]').textContent));
    const rule = await ev(async () => Object.fromEntries((await NP.svc.all()).filter((s) => /^(infus multivitamin|paket pemeriksaan) hc$/i.test(s.name)).map((s) => [s.name.toUpperCase(), s.shares.filter((x) => x.type === 'role')])));
    assert.deepStrictEqual(rule['INFUS MULTIVITAMIN HC'], [{ type: 'role', target: 'bidan', mode: 'nominal', value: 100000, perVisit: true }]);
    assert.deepStrictEqual(rule['PAKET PEMERIKSAAN HC'], [{ type: 'role', target: 'bidan', mode: 'nominal', value: 80000, perVisit: true }]);
    const before = await ev(async (m) => (await NP.db.all('transactions')).filter((t) => t.date.startsWith(m) && t.status === 'active').reduce((a, t) => a + t.totals.gross, 0), prevMonth);
    const bid = await page.locator('#hc-bidan option').nth(1).getAttribute('value');
    await page.selectOption('#hc-bidan', bid);
    await page.waitForFunction(() => { const b = document.querySelector('[data-hc=apply]'); return b && !b.disabled; });
    const n = +(/\((\d+)\)/.exec(await page.locator('[data-hc=apply]').innerText()) || [0, 0])[1];
    assert.ok(n >= 3, 'kunjungan yang diterapkan: ' + n);
    await newToast(async () => {
      await page.click('[data-hc=apply]');
      await modalBtn('Terapkan').click();
    }, /kunjungan homecare diperbarui/);
    const r = await ev(async ([m, bid]) => {
      const ts = (await NP.db.all('transactions')).filter((t) => t.date.startsWith(m) && t.status === 'active');
      const services = await NP.svc.all();
      const V = NP.hc.visits(ts, services, {});
      const ok = V.filter((v) => v.status === 'ok');
      return { gross: ts.reduce((a, t) => a + t.totals.gross, 0), st: V.map((v) => v.status), amt: ok.map((v) => v.bidanAmount), exp: ok.map((v) => v.expected), bid: ok.every((v) => v.bidanId === bid) };
    }, [prevMonth, bid]);
    assert.strictEqual(r.gross, before, 'pendapatan kotor tidak berubah');
    assert.ok(r.st.every((x) => x !== 'fix') && r.amt.length >= n && r.amt.every((a) => a === 100000 || a === 80000) && r.bid, JSON.stringify(r));
    assert.deepStrictEqual(r.amt, r.exp);
    assert.ok(/Perlu diterapkan\s*0/.test(await page.locator('#bk-body .stats-row').innerText()));
  });
  await step('impor biaya dokter dari file resep: pilih dokter, tandai pasien sama & service < Rp100.000', async () => {
    const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
    const rf = require('./support/resep-fixture.js');
    const rxFile = rf.writeXlsx(XLSX, path.join(require('os').tmpdir(), 'penebusan-resep-uji.xlsx'), { year: +prevMonth.slice(0, 4), month: +prevMonth.slice(5), doctor: 'dr. Siti Rahmawati' });
    await go('bulk?tab=resep');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-rx=pick]')]);
    await fc.setFiles(rxFile);
    await page.waitForSelector('#rx-table tbody tr');
    // dokter yang cocok dengan Data Karyawan otomatis dicentang; dokter luar tidak
    assert.ok(await page.locator('[data-doc="dr. Siti Rahmawati"]').isChecked());
    assert.ok(!(await page.locator('[data-doc="Puskesmas Contoh"]').isChecked()));
    const sid = await ev(async () => (await NP.db.all('employees')).find((e) => e.name === 'dr. Siti Rahmawati').id);
    assert.strictEqual(await page.inputValue('[data-docmap="dr. Siti Rahmawati"]'), sid);
    assert.ok(await page.inputValue('[data-rxsvc]'), 'master tindakan pemeriksaan dokter disarankan otomatis');
    assert.strictEqual(await page.locator('#rx-table tbody tr').count(), 7);
    // penanda: 2 di bawah Rp100.000 (satu Rp0), 3 pasien sama dengan file kasir yang dimuat di tab POS
    assert.strictEqual(await page.locator('#rx-table tr.rx-low, #rx-table tr.rx-zero').count(), 2);
    assert.strictEqual(await page.locator('#rx-table tr.rx-zero input[data-inc]').isDisabled(), true);
    assert.strictEqual(await page.locator('#rx-table tr.rx-dup').count(), 3);
    assert.ok(/Kasir SIN-/.test(await page.locator('#rx-table tr.rx-dup').first().innerText()));
    await page.check('[data-rx-only]');
    await page.waitForFunction(() => document.querySelectorAll('#rx-table tbody tr').length === 4);
    await page.uncheck('[data-rx-only]');
    await page.waitForFunction(() => document.querySelectorAll('#rx-table tbody tr').length === 7);
    // dokter luar ikut dicentang → baris bertambah, lalu dilepas lagi
    await page.check('[data-doc="Puskesmas Contoh"]');
    await page.waitForFunction(() => document.querySelectorAll('#rx-table tbody tr').length === 9);
    await page.uncheck('[data-doc="Puskesmas Contoh"]');
    await page.waitForFunction(() => document.querySelectorAll('#rx-table tbody tr').length === 7);
    const n = await page.locator('#rx-table input[data-inc]:checked').count();
    assert.ok(n >= 4, 'resep yang dicentang: ' + n);
    assert.ok(new RegExp('Impor ' + n + ' biaya dokter').test(await page.locator('[data-rx=import]').innerText()));
    await page.click('[data-rx=import]');
    await modalBtn('Impor sekarang').click();
    await waitToast(/biaya dokter diimpor/);
    const got = await ev(async (id) => {
      const ts = (await NP.db.all('transactions')).filter((t) => t.externalRef && t.externalRef.startsWith('RESEP:'));
      return { n: ts.length, docs: [...new Set(ts.map((t) => t.items[0].performers.dokter))], low: ts.filter((t) => t.items[0].price < 100000).length, noteOk: ts.every((t) => /Biaya pemeriksaan dokter/.test(t.note)), id };
    }, sid);
    assert.deepStrictEqual([got.n, got.docs, got.noteOk], [n, [sid], true]);
    assert.strictEqual(got.low, 1, 'Rp50.000 ikut diimpor (ditandai, bukan dilewati)');
    // impor ulang: semua sudah pernah diimpor
    await page.waitForSelector('[data-rx=import][disabled]');
    assert.ok(/Sudah pernah diimpor/.test(await page.locator('#rx-table').innerText()));
  });
  await step('tab resep: tindakan pasien yang diperiksa dokter tapi tercatat tanpa dokter → diubah sekaligus', async () => {
    const day3 = prevMonth + '-03';
    const ids = await ev(async () => {
      const s = await NP.db.all('services');
      const e = await NP.db.all('employees');
      const bd = e.find((x) => x.position === 'Bidan' && x.status === 'aktif' && x.name !== 'Bd. Uji Coba');
      return { sv: s.find((x) => x.name === 'Suntik Vitamin Uji').id, bd: bd.id, dr: e.find((x) => x.name === 'dr. Siti Rahmawati').id };
    });
    const tid = await ev(async ([d, i]) => (await NP.trx.save({ date: d, patient: 'Ny. Pasien Uji 3', note: 'uji tanpa dokter', items: [{ serviceId: i.sv, qty: 1, price: 200000, withDoctor: false, performers: { bidan: i.bd } }] })).id, [day3, ids]);
    await go('dashboard');
    await go('bulk?tab=resep');
    await page.waitForSelector('[data-rx=fix-wd]');
    assert.ok(/1 transaksi tindakan/.test(await page.locator('#rx-body .alert-info').first().innerText()));
    assert.ok(await page.locator('#rx-table a.flag-low', { hasText: 'Tercatat tanpa dokter' }).count());
    await page.click('[data-rx=fix-wd]');
    await modalBtn('Ubah').click();
    await waitToast(/1 transaksi diubah menjadi dengan dokter/);
    const t = await ev(async (id) => (await NP.trx.get(id)).items[0], tid);
    assert.deepStrictEqual([t.withDoctor, t.performers.dokter, t.performers.bidan], [true, ids.dr, ids.bd]);
    await page.waitForSelector('#rx-table');
    assert.strictEqual(await page.locator('[data-rx=fix-wd]').count(), 0, 'tidak ada lagi yang perlu diubah');
  });
  await step('tab resep: tindakan yang memberi bagian bidan menampilkan pilihan bidan pelaksana', async () => {
    const sid = await ev(async () => (await NP.svc.save({ id: '', code: '', name: 'Pemeriksaan Dokter + Bidan Uji', category: 'Pemeriksaan dokter', unit: 'KLINIK', price: 100000, active: true, notes: '', overrides: [], doctorShares: [],
      shares: [{ type: 'unit', target: 'KLINIK', mode: 'remainder', value: 0 }, { type: 'role', target: 'dokter', mode: 'nominal', value: 50000 }, { type: 'role', target: 'bidan', mode: 'nominal', value: 10000 }] })).id);
    await go('dashboard');
    await go('bulk?tab=resep');
    await page.selectOption('[data-rxsvc]', sid);
    await page.waitForSelector('select[data-rxdef=bidan]');
    assert.ok(/juga memberi bagian untuk <?b?>?bidan/i.test(await page.locator('.rx-roles').innerText()) || /bidan/.test(await page.locator('.rx-roles').innerText()));
    const opts = await page.locator('select[data-rxdef=bidan] option').count();
    assert.ok(opts >= 2, 'daftar bidan tersedia');
    await page.selectOption('select[data-rxdef=bidan]', { index: 1 });
    await page.waitForFunction(() => document.querySelector('select[data-rxdef=bidan]') && document.querySelector('select[data-rxdef=bidan]').value);
    assert.ok(!/Bidan pelaksana belum dipilih/.test(await page.locator('#rx-body').innerText()));
    // kembalikan pilihan tindakan semula
    const kons = await ev(async () => (await NP.db.all('services')).find((x) => x.name === 'Konsultasi Dokter Umum').id);
    await page.selectOption('[data-rxsvc]', kons);
    await page.waitForTimeout(300);
  });
  await step('bidan opsional & ubah biaya resep: biaya Rp0 diisi, bidan tidak ikut → bagiannya ke unit; laporan per bagian', async () => {
    // master tindakan lewat form: kolom "Opsi" → Opsional
    await go('services');
    await page.click('[data-act=add]');
    const m = page.locator('.svc-form');
    await m.locator('[name=name]').fill('Konsultasi Bidan Opsional Uji');
    await m.locator('[name=category]').selectOption('Pemeriksaan dokter');
    await m.locator('[name=unit]').selectOption('KLINIK');
    await m.locator('[name=price]').fill('100000');
    const rows = m.locator('#share-main .share-row:not(.share-head)');
    await rows.nth(0).locator('[data-f=target]').selectOption('KLINIK');
    await rows.nth(0).locator('[data-f=mode]').selectOption('remainder');
    await rows.nth(1).locator('[data-f=value]').fill('15000');
    await rows.nth(1).locator('[data-f=flag]').selectOption('optional');
    await m.locator('#share-main [data-add]').click();
    await m.locator('#share-main .share-row:not(.share-head)').nth(2).locator('[data-f=value]').fill('80000');
    await page.waitForFunction(() => /sesuai/.test(document.querySelector('#share-preview').innerText) && /opsional/.test(document.querySelector('#share-preview').innerText));
    await modalBtn('Simpan Tindakan').click();
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const svc = await ev(async () => (await NP.db.all('services')).find((x) => x.name === 'Konsultasi Bidan Opsional Uji'));
    assert.deepStrictEqual(svc.shares.map((x) => [x.target, x.value, !!x.optional]), [['KLINIK', 0, false], ['bidan', 15000, true], ['dokter', 80000, false]]);
    // impor resep: An. RESEP DUA (Rp0 di file) diisi Rp100.000, bidan tidak ikut
    await go('dashboard');
    await go('bulk?tab=resep');
    await page.selectOption('[data-rxsvc]', svc.id);
    await page.waitForSelector('select[data-rxdef=bidan]');
    await page.selectOption('select[data-rxdef=bidan]', { index: 1 });
    await page.waitForSelector('[data-rxamt="Resep/RXUJI-5"]');
    await page.click('[data-rxamt="Resep/RXUJI-5"]');
    await page.fill('.modal [name=v]', '100000');
    await modalBtn('Simpan').click();
    await page.waitForFunction(() => /diubah dari Rp0/.test(document.querySelector('#rx-table').innerText));
    // tunggu tabel digambar ulang (elemen lama terlepas) sebelum mengimpor
    const old = await page.$('#rx-table');
    await page.uncheck('[data-rxrole="Resep/RXUJI-5|bidan"]');
    await page.waitForFunction((el) => !el.isConnected, old);
    await page.waitForFunction(() => { const c = document.querySelector('[data-rxrole="Resep/RXUJI-5|bidan"]'); return c && !c.checked; });
    assert.ok(/Impor 1 biaya dokter/.test(await page.locator('[data-rx=import]').innerText()), await page.locator('[data-rx=import]').innerText());
    await page.click('[data-rx=import]');
    await newToast(() => modalBtn('Impor sekarang').click(), /1 biaya dokter diimpor/);
    const it = await ev(async () => (await NP.db.all('transactions')).find((t) => t.externalRef === 'RESEP:Resep/RXUJI-5').items[0]);
    const by = Object.fromEntries(it.shares.map((x) => [x.category, (x.implicit ? 'sisa ' : '') + x.amount]));
    assert.strictEqual(it.price, 100000);
    assert.deepStrictEqual([by.dokter, by.bidan, it.shares.reduce((a, x) => a + x.amount, 0)], ['80000', '0', 100000]);
    // Rekap Jasa › Laporan Dokter & Bidan
    await go('income');
    await page.fill('#r-period', prevMonth);
    await page.dispatchEvent('#r-period', 'change');
    await page.click('[data-tab=section]');
    await page.waitForSelector('[data-grand]');
    assert.ok(/Konsultasi Dokter/.test(await page.locator('#r-body').innerText()) && /Homecare/.test(await page.locator('#r-body').innerText()));
    const x = await download(() => page.click('[data-act=xls-section]'));
    assert.ok(/^laporan-jasa-dokter-bidan-.*\.xlsx$/.test(x.name), x.name);
  });
  await step('riwayat transaksi: centang beberapa lalu hapus; hapus semua pada filter; yang sudah digaji dilewati', async () => {
    await go('transactions');
    await page.selectOption('#h-preset', 'lastmonth');
    await page.fill('#h-q', 'POS');
    await page.waitForTimeout(400);
    const pick = await ev(async (m) => (await NP.db.all('transactions')).filter((t) => t.date.startsWith(m) && t.externalRef && t.externalRef.startsWith('POS:') && t.status === 'active').map((t) => t.id).sort().slice(0, 2), prevMonth);
    // pencarian "POS" tidak cocok dengan kolom yang dicari → pakai nomor transaksi
    await page.fill('#h-q', '');
    await page.waitForTimeout(300);
    for (const id of pick) {
      await page.fill('#h-q', id);
      await page.waitForTimeout(300);
      await page.check(`#h-list [data-sel="${id}"] >> nth=0`);
    }
    assert.ok(/2 transaksi dicentang/.test(await page.locator('#h-bulk').innerText()));
    await page.click('[data-act=del-sel]');
    await page.waitForSelector('.modal-head:has-text("Hapus 2 transaksi terpilih")');
    await modalBtn('Hapus 2 transaksi').click();
    assert.ok(/Alasan penghapusan wajib/.test(await page.locator('.modal .form-error').innerText()));
    await page.fill('.modal [name=reason]', 'uji hapus terpilih');
    await page.check('.modal [name=sure]');
    await newToast(() => modalBtn('Hapus 2 transaksi').click(), /2 transaksi dihapus/);
    assert.strictEqual(await ev(async (ids) => (await NP.db.all('transactions')).filter((t) => ids.includes(t.id)).length, pick), 0);
    assert.ok(await ev(async () => (await NP.db.all('auditLog')).some((l) => l.action === 'trx.delete' && /uji hapus terpilih/.test(l.detail))));
    // hapus semua pada filter (pasien tertentu bulan lalu); transaksi bulan berjalan yang sudah digaji tidak ikut terhapus
    await page.fill('#h-q', 'PASIEN UJI 7');
    await page.waitForTimeout(400);
    const n = +(await page.getAttribute('[data-act=del-all]', 'data-n'));
    assert.ok(n >= 1, 'jumlah pada filter');
    await page.click('[data-act=del-all]');
    await page.fill('.modal [name=reason]', 'uji hapus semua filter');
    await page.check('.modal [name=sure]');
    await newToast(() => modalBtn('Hapus ' + n + ' transaksi').click(), new RegExp(n + ' transaksi dihapus'));
    // transaksi yang sudah masuk penggajian (terkunci) dilewati
    await page.selectOption('#h-preset', 'month');
    await page.fill('#h-q', 'Pasien Uji');
    await page.waitForTimeout(400);
    await page.check('#h-selall');
    await page.click('[data-act=del-sel]');
    assert.ok(/dilewati karena sudah masuk penggajian/.test(await page.locator('.modal-body').innerText()));
    await modalBtn('Batal').click();
    await page.click('[data-act=sel-clear]');
    await page.fill('#h-q', '');
  });
  await step('jadwal masuk: pilih karyawan & ketentuan, custom per hari, buat acak, isi manual, simpan & muat ulang, Excel', async () => {
    await go('schedule?month=2026-02&unit=KLINIK&tab=people');
    await page.waitForSelector('.sch-plist');
    const ids = await page.locator('.sch-p').evaluateAll((els) => els.slice(0, 4).map((e) => e.dataset.emp));
    assert.strictEqual(ids.length, 4);
    for (const id of ids) {
      const old = await page.$('.sch-plist');
      await page.check(`[data-inc="${id}"]`);
      await page.waitForFunction((el) => !el.isConnected, old);
    }
    // ketentuan: karyawan 1 libur tetap Minggu, karyawan 2 hanya shift Pagi
    await page.locator(`.sch-p[data-emp="${ids[0]}"] label:has([data-ro="0"]) span`).click();
    await page.locator(`.sch-p[data-emp="${ids[1]}"] label:has([data-rs="S"]) span`).click();
    // karyawan 4: pembagian per minggu 3 Pagi + 3 Siang (kalimat ringkasan ikut berubah)
    for (const c of ['P', 'S']) {
      const old = await page.$('.sch-plist');
      await page.fill(`.sch-p[data-emp="${ids[3]}"] [data-rq="${c}"]`, '3');
      await page.dispatchEvent(`.sch-p[data-emp="${ids[3]}"] [data-rq="${c}"]`, 'change');
      await page.waitForFunction((el) => !el.isConnected, old);
    }
    assert.ok(/per minggu 3× Pagi \+ 3× Siang/.test(await page.locator(`.sch-p[data-emp="${ids[3]}"] .sch-sum`).innerText()));
    // custom per hari: tanggal 14 butuh 2 Pagi, tanggal 15 tutup
    await page.click('[data-tab=needs]');
    await page.waitForSelector('.sch-days');
    let old = await page.$('.sch-days');
    await page.fill('.sch-days tr[data-day="14"] [data-dn="P"]', '2');
    await page.dispatchEvent('.sch-days tr[data-day="14"] [data-dn="P"]', 'change');
    await page.waitForFunction((el) => !el.isConnected, old);
    old = await page.$('.sch-days');
    await page.check('.sch-days tr[data-day="15"] [data-dc]');
    await page.waitForFunction((el) => !el.isConnected, old);
    // Siang: minimal 1 orang bila ada yang libur
    old = await page.$('.sch-days');
    await page.fill('.sch-shifts tr[data-si="1"] [data-sf="min"]', '1');
    await page.dispatchEvent('.sch-shifts tr[data-si="1"] [data-sf="min"]', 'change');
    await page.waitForFunction((el) => !el.isConnected, old);
    assert.ok(await page.locator('.sch-days tr[data-day="14"].sch-custom').count());
    await page.click('[data-act=random]');
    await page.waitForSelector('.sch-grid');
    const grid = await ev((ids) => {
      const cell = (e, d) => (document.querySelector(`.sch-c button[data-e="${e}"][data-d="${d}"]`) || {}).textContent;
      const sundays = [1, 8, 15, 22];
      return {
        p14: ids.filter((e) => cell(e, 14) === 'P').length,
        d15: ids.map((e) => cell(e, 15)),
        sun0: sundays.map((d) => cell(ids[0], d)),
        s1: [...Array(28)].map((_, i) => cell(ids[1], i + 1)).filter((v) => v === 'S').length,
        week3: [2, 3, 4, 5, 6, 7, 8].map((d) => cell(ids[3], d)).join(''),
        bad: document.querySelectorAll('.sch-c.bad').length
      };
    }, ids);
    assert.ok(grid.p14 >= 2, 'tanggal 14 minimal 2 Pagi');
    assert.deepStrictEqual([grid.d15, grid.sun0, grid.s1, grid.bad], [['L', 'L', 'L', 'L'], ['L', 'L', 'L', 'L'], 0, 0]);
    assert.deepStrictEqual([grid.week3.split('P').length - 1, grid.week3.split('S').length - 1], [3, 3], 'pembagian minggu 2–8: ' + grid.week3);
    assert.ok(/Belum disimpan/.test(await page.locator('#sc-state').innerText()));
    // isi manual: kuas Libur pada karyawan 3 tanggal 3
    await page.click('[data-brush="L"]');
    await page.click(`.sch-c button[data-e="${ids[2]}"][data-d="3"]`);
    await page.waitForFunction((e) => { const b = document.querySelector(`.sch-c button[data-e="${e}"][data-d="3"]`); return b && b.textContent === 'L' && b.classList.contains('man'); }, ids[2]);
    await newToast(() => page.click('[data-act=save]'), /disimpan \(versi 1\)/);
    // muat ulang dari database
    await go('dashboard');
    await go('schedule?month=2026-02&unit=KLINIK&tab=grid');
    await page.waitForSelector('.sch-grid');
    assert.ok(/Tersimpan · versi 1/.test(await page.locator('#sc-state').innerText()));
    const db = await ev(async () => {
      const s = await NP.sched.get('2026-02', 'KLINIK');
      return { n: s.config.employees.length, off: s.config.rules[s.config.employees[0]].offDays, quota: s.config.rules[s.config.employees[3]].quota, min: s.config.shifts[1].min, day14: s.config.days[14], day15: s.config.days[15], filled: Object.values(s.assignments).reduce((a, c) => a + Object.keys(c).length, 0), man: s.config.manual };
    });
    assert.deepStrictEqual([db.n, db.off, db.quota, db.min, db.day14, db.day15, db.filled], [4, [0], { P: 3, S: 3 }, 1, { need: { P: 2 } }, { need: {}, closed: true }, 4 * 28]);
    assert.deepStrictEqual(db.man, { [ids[2]]: { 3: true } });
    assert.ok(await ev(async () => (await NP.db.all('auditLog')).some((l) => l.action === 'schedule.save')));
    const x = await download(() => page.click('.page-head [data-act=xls]'));
    assert.strictEqual(x.name, 'jadwal-masuk-2026-02-klinik.xlsx');
  });
  await step('Data Karyawan: tombol Tambah Dokter & Tambah Bidan mengisi jabatan, unit & skema', async () => {
    await go('employees');
    await page.click('[data-act=add-dokter]');
    await page.waitForSelector('.modal-head:has-text("Tambah Dokter")');
    await page.click('.emp-form [data-tab=pekerjaan]');
    assert.deepStrictEqual([await page.inputValue('.emp-form [name=unit]'), await page.inputValue('.emp-form [name=position]'), await page.inputValue('.emp-form [name=department]')], ['KLINIK', 'Dokter Umum', 'Pelayanan Medis']);
    assert.ok(await page.locator('.emp-form [data-tab=nakes]').isVisible(), 'tab Tenaga Kesehatan tampil');
    await page.click('.emp-form [data-tab=pribadi]');
    await page.fill('.emp-form [name=name]', 'dr. Uji Tambahan');
    await page.fill('.emp-form [name=phone]', '081277770001');
    await page.click('.emp-form [data-tab=nakes]');
    await page.fill('.emp-form [name=str]', 'STR-UJI-1');
    await page.fill('.emp-form [name=sip]', 'SIP-UJI-1');
    await modalBtn('Simpan').click();
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const d = await ev(async () => (await NP.db.all('employees')).find((x) => x.name === 'dr. Uji Tambahan'));
    assert.deepStrictEqual([d.unit, d.position, d.payScheme, d.str, d.sip], ['KLINIK', 'Dokter Umum', 'service_only', 'STR-UJI-1', 'SIP-UJI-1']);
    // tautan langsung dari halaman impor
    await page.goto(BASE + '#/employees?add=bidan');
    await page.waitForSelector('.modal-head:has-text("Tambah Bidan")');
    await page.fill('.emp-form [name=name]', 'Bd. Uji Tambahan');
    await page.fill('.emp-form [name=phone]', '081277770002');
    assert.ok(/Isi gaji pokok/.test(await page.locator('.emp-form .alert-info').innerText()));
    await page.click('.emp-form [data-tab=gaji]');
    await page.fill('.emp-form [name=baseSalary]', '2100000');
    await modalBtn('Simpan').click();
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const b = await ev(async () => (await NP.db.all('employees')).find((x) => x.name === 'Bd. Uji Tambahan'));
    assert.deepStrictEqual([b.unit, b.position, b.department, b.payScheme], ['KLINIK', 'Bidan', 'Kebidanan', 'monthly_service']);
    // bidan baru langsung bisa dipilih sebagai pelaksana
    await go('input');
    const sid = await ev(async () => (await NP.db.all('services')).find((x) => x.name === 'Pemeriksaan Gula Darah').id);
    await page.selectOption('.item-row [data-f=serviceId]', sid);
    assert.ok(await page.locator('.item-row [data-perf=bidan] option', { hasText: 'Bd. Uji Tambahan' }).count());
  });
  await step('input tindakan di iPad: kolom tanggal tidak menimpa nama pasien', async () => {
    for (const vp of [{ width: 1180, height: 820 }, { width: 820, height: 1180 }, { width: 1366, height: 900 }]) {
      await page.setViewportSize(vp);
      await go('input');
      const r = await ev(() => ['date', 'patient', 'patientCode'].map((n) => document.querySelector('.input-form [name=' + n + ']').getBoundingClientRect()).map((b) => ({ l: b.left, r: b.right, t: b.top, b: b.bottom })));
      const overlap = (a, b) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
      assert.ok(!overlap(r[0], r[1]) && !overlap(r[0], r[2]) && !overlap(r[1], r[2]), JSON.stringify({ vp, r }));
      const svc = await ev(() => document.querySelector('.item-svc select').getBoundingClientRect().width);
      assert.ok(svc >= 200, 'pilihan tindakan terlalu sempit: ' + svc);
      // bilah atas harus buram penuh agar teks yang di-scroll tidak terlihat menimpa judul
      const bg = await ev(() => getComputedStyle(document.querySelector('.topbar')).backgroundColor);
      assert.ok(!/rgba\([^)]*,\s*0?\.\d+\)|color\(.*\/\s*0?\.\d/.test(bg), 'bilah atas transparan: ' + bg);
    }
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
    await page.waitForSelector('.sidebar, .auth-error:not([hidden])', { timeout: 60000 });
    if (await page.locator('.auth-error:not([hidden])').count()) assert.fail('Login viewer ditolak: ' + (await page.locator('.auth-error').innerText()));
    await page.waitForTimeout(400);
    assert.ok(/tidak memiliki hak akses/.test(await page.locator('#view').innerText()));
    const navs = await page.locator('.nav-item').count();
    assert.ok(navs <= 5, navs);
    // jadwal masuk dapat dilihat viewer tetapi tidak dapat diubah
    await go('schedule?month=2026-02&unit=KLINIK');
    await page.waitForSelector('.sch-grid');
    assert.strictEqual(await page.locator('[data-act=save], [data-act=random], [data-brush]').count(), 0);
    assert.ok(await page.locator('.sch-c button').first().isDisabled());
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
    assert.strictEqual(await page.locator('#h-selall, [data-act=del-all]').count(), 0, 'operasional tidak dapat menghapus');
    assert.ok((await ev(() => NP.sec.bankView('1234567890'))).includes('*'));
  });

  console.log('Responsif');
  for (const [name, vp] of [['iPhone', { width: 390, height: 844 }], ['Android', { width: 412, height: 915 }], ['iPad', { width: 820, height: 1180 }], ['Laptop', { width: 1280, height: 800 }]]) {
    await step('tampilan ' + name + ' tanpa scroll horizontal halaman', async () => {
      await page.setViewportSize(vp);
      for (const h of ['dashboard', 'input', 'transactions', 'bulk', 'analysis', 'schedule?month=2026-02&unit=KLINIK&tab=grid', 'schedule?tab=people', 'schedule?tab=needs']) {
        await go(h);
        // grafik menyesuaikan ukuran secara asinkron setelah viewport berubah
        const ok = await page.waitForFunction(() => document.documentElement.scrollWidth - window.innerWidth <= 1, null, { timeout: 5000 }).then(() => true, () => false);
        const over = await ev(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(ok, h + ' overflow ' + over);
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
