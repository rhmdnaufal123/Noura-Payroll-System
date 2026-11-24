/* Noura Payroll — pembaca file ekspor penjualan POS apotek (sheet "Penjualan" / "Stok Terjual").
 *
 * Format yang didukung: baris judul (Nama Outlet, Dari/Sampai Tanggal, ...) lalu baris kepala kolom
 * yang memuat "Kode Struk" dan "Nama Produk". Pada sheet "Penjualan", satu struk dengan beberapa
 * produk ditulis sebagai satu baris lengkap diikuti baris lanjutan (kolom No/Kode Struk kosong).
 *
 * Hanya produk berkategori tindakan (default: kategori yang memuat DOKTER, BIDAN, atau HOMECARE)
 * yang diambil; penjualan obat diabaikan. Setiap struk menjadi satu transaksi tindakan dengan
 * nomor referensi "POS:<kode struk>" sehingga impor ulang file yang sama tidak menggandakan data.
 */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, agu: 8, agt: 8, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12 };
  const pad = (n) => String(n).padStart(2, '0');
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const key = (s) => norm(s).toUpperCase();

  /** "1 Okt 2026 pukul 08.06" | "2026-10-01" | Date | nomor seri Excel → "2026-10-01" */
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      const d = new Date(Math.round((v - 25569) * 86400000));
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }
    const s = norm(v);
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return m[3] + '-' + pad(MONTHS[m[2].slice(0, 3).toLowerCase()]) + '-' + pad(m[1]);
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
    if (m) return m[3] + '-' + pad(m[2]) + '-' + pad(m[1]);
    return null;
  }
  function parseTime(v) {
    const m = norm(v).match(/(\d{1,2})[.:](\d{2})\s*$/);
    return m ? pad(m[1]) + ':' + m[2] : '';
  }
  const toNum = (v) => (typeof v === 'number' ? v : u.toNum(String(v == null ? '' : v).replace(/[^\d,.-]/g, '')));

  /** Kategori POS yang dianggap tindakan/pelayanan. */
  function isServiceCategory(cat) {
    return /DOKTER|BIDAN|HOMECARE|HOME CARE|TINDAKAN|PELAYANAN|JASA/i.test(String(cat || ''));
  }
  /** Kategori master tindakan yang disarankan untuk kategori POS. */
  function suggestCategory(posCat, name) {
    if (/HOME\s?CARE/i.test(posCat || '') || /(^|\s)HC$/i.test(norm(name))) return 'Homecare';
    return 'Dokter Umum & Bidan';
  }

  /**
   * Baca satu sheet (array of arrays) → { meta, lines, sheetKind }.
   * lines: { ref, date, time, product, posCategory, qty, unitPrice, subtotal, patient, phone, doctor, row }
   */
  function parseSheet(aoa) {
    const meta = {};
    let h = -1;
    for (let i = 0; i < Math.min(aoa.length, 40); i++) {
      const r = (aoa[i] || []).map(key);
      const label = r[0] || '';
      const val = norm((aoa[i] || []).slice(1).find((x) => norm(x)) || '').replace(/^:\s*/, '');
      if (/^NAMA OUTLET/.test(label)) meta.outlet = val;
      if (/^DARI TANGGAL/.test(label)) meta.from = parseDate(val);
      if (/^SAMPAI TANGGAL/.test(label)) meta.to = parseDate(val);
      if (r.includes('KODE STRUK') && r.includes('NAMA PRODUK')) {
        h = i;
        break;
      }
    }
    if (h < 0) return null;
    const head = aoa[h].map(key);
    const col = (...names) => {
      for (const n of names) {
        const i = head.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    const c = {
      no: col('NO'), ref: col('KODE STRUK'), date: col('TANGGAL', 'TANGGAL TRANSAKSI'), product: col('NAMA PRODUK'), cat: col('KATEGORI PRODUK', 'KATEGORI 1', 'KATEGORI'),
      qty: col('JUMLAH'), price: col('HARGA JUAL'), disc: col('DISKON'), sub: col('SUB-TOTAL', 'SUBTOTAL'), patient: col('PELANGGAN'), phone: col('NO. HP PELANGGAN'), doctor: col('DOKTER')
    };
    if (c.product < 0 || c.qty < 0) return null;
    const kind = head.includes('SUB-TOTAL') ? 'penjualan' : 'stok';
    const lines = [];
    let cur = null;
    for (let i = h + 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const product = norm(r[c.product]);
      if (!product) continue;
      const ref = norm(r[c.ref]);
      if (ref) cur = { ref, date: parseDate(r[c.date]), time: parseTime(r[c.date]), patient: c.patient >= 0 ? norm(r[c.patient]) : '', phone: c.phone >= 0 ? norm(r[c.phone]) : '', doctor: c.doctor >= 0 ? norm(r[c.doctor]) : '' };
      if (!cur) continue;
      const qty = toNum(r[c.qty]);
      const unitPrice = toNum(r[c.price]);
      const subtotal = c.sub >= 0 && norm(r[c.sub]) !== '' ? toNum(r[c.sub]) : qty * unitPrice - (c.disc >= 0 ? toNum(r[c.disc]) : 0);
      const clean = (s) => (s === '-' ? '' : s);
      lines.push({ ref: cur.ref, date: cur.date, time: cur.time, product, posCategory: c.cat >= 0 ? norm(r[c.cat]) : '', qty, unitPrice, subtotal, patient: clean(cur.patient), phone: clean(cur.phone), doctor: clean(cur.doctor), row: i + 1 });
    }
    return { meta, lines, kind };
  }

  /** Pilih sheet terbaik dari workbook SheetJS: "Penjualan" (memuat pasien & dokter) lebih diutamakan. */
  function parseWorkbook(wb, XLSX) {
    const results = [];
    for (const name of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true });
      const r = parseSheet(aoa);
      if (r) results.push(Object.assign(r, { sheet: name }));
    }
    if (!results.length) throw new Error('Format file tidak dikenali. Gunakan file ekspor penjualan POS (sheet "Penjualan" dengan kolom Kode Struk, Tanggal, Nama Produk, Kategori Produk, Jumlah, Harga Jual).');
    return results.find((r) => r.kind === 'penjualan') || results[0];
  }

  /** Nama karyawan cocok dengan nama dokter POS (abaikan gelar & tanda baca). */
  function nameKey(s) {
    return key(s).replace(/\b(DR|DRG|DRS|DOKTER|BIDAN|BD|AMD|KEB|SPA|SP|S|KED|M|STR|NS)\b\.?/g, ' ').replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function matchEmployee(name, candidates) {
    const k = nameKey(name);
    if (!k) return null;
    return candidates.find((e) => nameKey(e.name) === k) || candidates.find((e) => { const ek = nameKey(e.name); return ek && (ek.includes(k) || k.includes(ek)); }) || null;
  }

  /**
   * Susun rencana impor.
   * @param lines      hasil parseSheet().lines
   * @param services   master tindakan (aktif & nonaktif)
   * @param employees  karyawan
   * @param opt        { categories:Set<string> kategori POS yang diambil, defaults:{role:empId}, roles:{dokter:[emp...],...} }
   */
  function plan(lines, services, employees, opt) {
    opt = opt || {};
    const cats = opt.categories;
    const svcByName = new Map();
    for (const s of services) if (!svcByName.has(key(s.name)) || s.active) svcByName.set(key(s.name), s);
    const picked = lines.filter((l) => (cats ? cats.has(l.posCategory || '(tanpa kategori)') : isServiceCategory(l.posCategory)) || (!l.posCategory && svcByName.has(key(l.product))));
    const unmatched = new Map();
    const problems = [];
    const groups = new Map();
    for (const l of picked) {
      const s = svcByName.get(key(l.product));
      if (!s) {
        const x = unmatched.get(key(l.product)) || { name: l.product, posCategory: l.posCategory, qty: 0, total: 0, prices: new Map(), category: suggestCategory(l.posCategory, l.product) };
        x.qty += l.qty;
        x.total += l.subtotal;
        x.prices.set(l.unitPrice, (x.prices.get(l.unitPrice) || 0) + 1);
        unmatched.set(key(l.product), x);
        continue;
      }
      if (!groups.has(l.ref)) groups.set(l.ref, []);
      groups.get(l.ref).push(Object.assign({ service: s }, l));
    }
    const transactions = [];
    const roleStaff = opt.roles || {};
    const empMap = new Map((employees || []).map((e) => [e.id, e]));
    for (const [ref, ls] of groups) {
      const first = ls[0];
      if (!first.date) {
        problems.push({ ref, msg: 'Tanggal tidak terbaca.' });
        continue;
      }
      const items = [];
      for (const l of ls) {
        const s = l.service;
        if (!s.active) problems.push({ ref, msg: '"' + s.name + '" nonaktif di Master Tindakan.' });
        if (!(l.qty >= 1) || Math.floor(l.qty) !== l.qty) problems.push({ ref, msg: '"' + l.product + '": jumlah ' + l.qty + ' tidak valid.' });
        const price = l.qty > 0 && l.subtotal > 0 && Number.isInteger(l.subtotal / l.qty) ? l.subtotal / l.qty : Math.round(l.unitPrice);
        if (!(price > 0)) problems.push({ ref, msg: '"' + l.product + '": harga 0.' });
        const performers = {};
        for (const role of NP.rs.requiredRoles(s)) {
          let id = null;
          if (role === 'dokter' && l.doctor) {
            const m = matchEmployee(l.doctor, roleStaff.dokter || []);
            if (m) id = m.id;
          }
          id = id || (opt.defaults && opt.defaults[role]) || null;
          if (id) performers[role] = id;
          else problems.push({ ref, msg: '"' + s.name + '" membutuhkan ' + ((NP.C.ROLES[role] || {}).label || role) + ' pelaksana — pilih pelaksana default.', role });
        }
        // validasi pembagian dengan harga file (mis. harga POS lebih rendah dari total bagian nominal)
        if (price > 0 && l.qty >= 1 && NP.rs.requiredRoles(s).every((r) => performers[r])) {
          const chk = NP.rs.compute(s, { price, qty: l.qty, performers, employees: empMap });
          for (const err of chk.errors) problems.push({ ref, msg: '"' + s.name + '" (harga ' + u.rp(price) + '): ' + err });
        }
        items.push({ serviceId: s.id, serviceName: s.name, category: s.category, qty: l.qty, price, performers, lineId: u.uid('ln') });
      }
      const noteParts = ['Impor POS ' + ref];
      if (first.doctor) noteParts.push(first.doctor);
      transactions.push({
        externalRef: 'POS:' + ref, date: first.date, time: first.time, patient: (first.patient || '').slice(0, 80), patientCode: '', note: noteParts.join(' · ').slice(0, 200), doctor: first.doctor, items,
        gross: u.sum(items, (i) => i.qty * i.price), qty: u.sum(items, (i) => i.qty)
      });
    }
    transactions.sort((a, b) => (a.date + a.time + a.externalRef).localeCompare(b.date + b.time + b.externalRef));
    const unm = [...unmatched.values()].map((x) => {
      const price = [...x.prices.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { name: x.name, posCategory: x.posCategory, qty: x.qty, total: x.total, price: Math.round(price), category: x.category };
    });
    return { picked, transactions, unmatched: unm, problems };
  }

  /** Ringkasan per kategori POS (untuk memilih kategori yang diimpor). */
  function categorySummary(lines) {
    const m = new Map();
    for (const l of lines) {
      const k = l.posCategory || '(tanpa kategori)';
      const x = m.get(k) || { category: k, lines: 0, qty: 0, total: 0, products: new Set(), service: isServiceCategory(l.posCategory) };
      x.lines++;
      x.qty += l.qty;
      x.total += l.subtotal;
      x.products.add(key(l.product));
      m.set(k, x);
    }
    return [...m.values()].map((x) => Object.assign(x, { products: x.products.size })).sort((a, b) => b.service - a.service || b.total - a.total);
  }

  NP.pos = { parseDate, parseSheet, parseWorkbook, plan, categorySummary, isServiceCategory, suggestCategory, matchEmployee, nameKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = NP;
})(typeof globalThis !== 'undefined' ? globalThis : window);
