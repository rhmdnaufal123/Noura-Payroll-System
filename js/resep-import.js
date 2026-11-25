/* Noura Payroll — impor BIAYA PEMERIKSAAN DOKTER dari file ekspor "Penebusan Resep" aplikasi kasir.
 *
 * Format: judul (Nama Outlet, Filter Aktif: Dari/Hingga Tanggal), lalu kepala kolom dua baris:
 *   No. | Tanggal Input | Nama/Kode Resep | Nama Pasien | Nama Dokter | Petugas | Produk(...) | Racikan(...) | Status | Embalase | Service | Harga Total
 * Satu resep = satu baris utama (kolom No. terisi) diikuti baris lanjutan berisi produk lain.
 * Kolom "Service" adalah biaya pemeriksaan dokter; setiap resep yang diimpor menjadi satu transaksi
 * tindakan bernomor referensi RESEP:<kode resep> sehingga impor ulang tidak menggandakan data.
 *
 * Penanda:
 *  - low   : biaya service di bawah batas (default Rp100.000); zero = Rp0 (tidak dapat diimpor)
 *  - kasir : pasien yang sama (nama & tanggal) ada di file penjualan kasir
 *  - db    : pasien yang sama (nama & tanggal) sudah memiliki transaksi tindakan di database
 */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const key = (s) => norm(s).toUpperCase();
  const num = (v) => (typeof v === 'number' ? v : u.toNum(String(v == null ? '' : v).replace(/[^\d,.-]/g, '')));

  const patientKey = (x) => NP.C.patientKey(x);

  /** Baca sheet "Penebusan Resep" (array of arrays) → { meta, rows } atau null bila bukan format resep. */
  function parseSheet(aoa) {
    const meta = {};
    let h = -1;
    for (let i = 0; i < Math.min(aoa.length, 40); i++) {
      const r = (aoa[i] || []).map(key);
      const label = (r[0] || '').replace(/^-\s*/, '');
      const val = norm((aoa[i] || []).slice(1).find((x) => norm(x)) || '').replace(/^:\s*/, '');
      if (/^NAMA OUTLET/.test(label)) meta.outlet = val;
      if (/^DARI TANGGAL/.test(label)) meta.from = NP.pos.parseDate(val);
      if (/^(HINGGA|SAMPAI) TANGGAL/.test(label)) meta.to = NP.pos.parseDate(val);
      if (/^DOKTER/.test(label)) meta.doctorFilter = val;
      if (r.includes('NAMA/KODE RESEP') && r.includes('NAMA PASIEN')) {
        h = i;
        break;
      }
    }
    if (h < 0) return null;
    const head = aoa[h].map(key);
    const sub = (aoa[h + 1] || []).map(key);
    const col = (n) => head.indexOf(n);
    const c = { no: col('NO.') >= 0 ? col('NO.') : col('NO'), date: col('TANGGAL INPUT'), code: col('NAMA/KODE RESEP'), patient: col('NAMA PASIEN'), doctor: col('NAMA DOKTER'), staff: col('PETUGAS'), status: col('STATUS'), emb: col('EMBALASE'), service: col('SERVICE'), total: col('HARGA TOTAL') };
    const prodName = col('PRODUK') >= 0 ? col('PRODUK') : sub.indexOf('NAMA');
    if (c.code < 0 || c.patient < 0 || c.service < 0) return null;
    const rows = [];
    let cur = null;
    for (let i = h + 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const no = norm(r[c.no]);
      const code = norm(r[c.code]);
      if (no && code) {
        cur = {
          no: +no || rows.length + 1, code, date: NP.pos.parseDate(r[c.date]), time: (norm(r[c.date]).match(/(\d{1,2})[.:](\d{2})\s*$/) || []).slice(1).join(':'),
          patient: norm(r[c.patient]).replace(/^-$/, ''), doctor: norm(r[c.doctor]).replace(/^-$/, ''), staff: c.staff >= 0 ? norm(r[c.staff]).replace(/^-$/, '') : '',
          status: c.status >= 0 ? norm(r[c.status]) : '', embalase: c.emb >= 0 ? num(r[c.emb]) : 0, service: num(r[c.service]), total: c.total >= 0 ? num(r[c.total]) : 0,
          products: [], row: i + 1
        };
        rows.push(cur);
      }
      if (cur && prodName >= 0 && norm(r[prodName])) cur.products.push(norm(r[prodName]));
    }
    return { meta, rows };
  }

  function parseWorkbook(wb, XLSX) {
    for (const name of wb.SheetNames) {
      const r = parseSheet(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true }));
      if (r) return Object.assign(r, { sheet: name });
    }
    throw new Error('Format file tidak dikenali. Gunakan file ekspor "Penebusan Resep" (kolom Nama/Kode Resep, Nama Pasien, Nama Dokter, Service).');
  }

  /** Ringkasan per dokter di file. */
  function doctorSummary(rows) {
    const m = new Map();
    for (const r of rows) {
      const k = r.doctor || '(tanpa dokter)';
      const x = m.get(k) || { doctor: k, count: 0, service: 0, low: 0 };
      x.count++;
      x.service += r.service;
      if (r.service < 100000) x.low++;
      m.set(k, x);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }

  /** Indeks struk kasir (hasil NP.pos.parseSheet().lines) per pasien+tanggal. */
  function kasirIndex(lines) {
    const m = new Map();
    for (const l of lines || []) {
      if (!l.patient || !l.date) continue;
      const k = patientKey(l.patient) + '|' + l.date;
      let x = m.get(k);
      if (!x) m.set(k, (x = new Map()));
      const s = x.get(l.ref) || { ref: l.ref, time: l.time, items: [], services: [], resepTotal: 0, total: 0 };
      s.items.push(l.product);
      s.total += l.subtotal;
      if (/^RESEP$/i.test(l.product)) s.resepTotal += l.subtotal;
      else if (NP.pos.isServiceCategory(l.posCategory)) s.services.push(l.product + (l.qty > 1 ? ' ×' + l.qty : ''));
      x.set(l.ref, s);
    }
    return m;
  }
  /** Indeks transaksi aktif di database per pasien+tanggal. */
  function dbIndex(trxs) {
    const m = new Map();
    for (const t of trxs || []) {
      if (t.status !== 'active' || !t.patient) continue;
      const k = patientKey(t.patient) + '|' + t.date;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    }
    return m;
  }

  const DOCTOR_FEE_RE = /PEMERIKSAAN DOKTER|KONSULTASI DOKTER|JASA DOKTER|BIAYA DOKTER|PERIKSA DOKTER/i;
  /** Tindakan/produk yang menandakan pasien diperiksa dokter. */
  function isDoctorExam(name, category) {
    return DOCTOR_FEE_RE.test(String(name || '')) || category === 'Pemeriksaan dokter';
  }

  /**
   * Indeks "pasien diperiksa dokter" per pasien+tanggal dari tiga sumber:
   *  - db    : transaksi aktif yang memuat tindakan pemeriksaan dokter
   *  - resep : file penebusan resep dengan biaya service > 0
   *  - kasir : baris file penjualan kasir berupa pemeriksaan dokter
   * Setiap hit membawa doctorId (dokter yang memeriksa) bila diketahui.
   * @returns Map<'KUNCI PASIEN|yyyy-mm-dd', [{src, ref, text}]>
   */
  function examIndex(opt) {
    opt = opt || {};
    const m = new Map();
    const add = (patient, date, hit) => {
      if (!patient || !date) return;
      const k = patientKey(patient) + '|' + date;
      if (!k.split('|')[0]) return;
      if (!m.has(k)) m.set(k, []);
      if (!m.get(k).some((h) => h.src === hit.src && h.ref === hit.ref)) m.get(k).push(hit);
    };
    for (const t of opt.trxs || []) {
      if (t.status !== 'active') continue;
      const it = t.items.find((i) => isDoctorExam(i.serviceName, i.category));
      if (it) add(t.patient, t.date, { src: 'db', ref: t.id, text: it.serviceName, doctorId: (it.performers && it.performers.dokter) || '' });
    }
    for (const r of opt.resepRows || []) if (r.service > 0) add(r.patient, r.date, { src: 'resep', ref: r.code, text: 'Resep ' + (r.doctor || ''), doctorId: (opt.docMap && opt.docMap[r.doctor]) || '' });
    for (const l of opt.kasirLines || []) if (isDoctorExam(l.product, '')) add(l.patient, l.date, { src: 'kasir', ref: l.ref, text: l.product });
    return m;
  }
  const examLabel = (h) => (h.src === 'db' ? 'pemeriksaan dokter ' + h.ref : h.src === 'resep' ? 'resep dokter ' + String(h.ref).replace(/^Resep\//i, '') : 'kasir ' + h.ref + ' (' + h.text + ')');

  /**
   * Susun rencana impor.
   * @param rows      hasil parseSheet().rows
   * @param opt { doctors:Set nama dokter yang diimpor, docMap:{namaDokter:empId}, service (master tindakan), employees,
   *              kasirLines, trxs, threshold (default 100000), excluded:Set kode, included:Set kode (paksa ikut) }
   */
  function plan(rows, opt) {
    opt = opt || {};
    const threshold = opt.threshold || 100000;
    const kasir = kasirIndex(opt.kasirLines);
    const db = dbIndex(opt.trxs);
    const existingRefs = new Set((opt.trxs || []).filter((t) => t.status === 'active' && t.externalRef).map((t) => t.externalRef));
    const empMap = new Map((opt.employees || []).map((e) => [e.id, e]));
    const s = opt.service || null;
    const svcById = new Map((opt.services || []).map((x) => [x.id, x]));
    const out = [];
    for (const r of rows) {
      const doctor = r.doctor || '(tanpa dokter)';
      if (opt.doctors && !opt.doctors.has(doctor)) continue;
      const k = patientKey(r.patient) + '|' + r.date;
      const ks = r.patient && r.date ? [...(kasir.get(k) || new Map()).values()] : [];
      const ds = r.patient && r.date ? db.get(k) || [] : [];
      const x = {
        code: r.code, externalRef: 'RESEP:' + r.code, date: r.date, time: r.time, patient: r.patient, doctor, service: r.service, total: r.total, embalase: r.embalase, products: r.products,
        empId: (opt.docMap || {})[doctor] || '',
        low: r.service < threshold, zero: !(r.service > 0),
        kasir: ks,
        db: ds.map((t) => {
          const noDoc = t.items.filter((i) => !i.withDoctor && svcById.has(i.serviceId) && NP.rs.hasDoctorVariant(svcById.get(i.serviceId)));
          return { id: t.id, externalRef: t.externalRef, items: t.items.map((i) => (NP.trx && NP.trx.itemLabel ? NP.trx.itemLabel(i) : i.serviceName) + (i.qty > 1 ? ' ×' + i.qty : '')), noDoctor: noDoc.map((i) => i.serviceName) };
        }),
        already: existingRefs.has('RESEP:' + r.code),
        kasirDoctorFee: ks.some((st) => st.items.some((n) => DOCTOR_FEE_RE.test(n))),
        dbDoctorFee: !!(s && ds.some((t) => t.items.some((i) => i.serviceId === s.id))),
        problems: []
      };
      if (!r.date) x.problems.push('Tanggal tidak terbaca.');
      if (x.zero) x.problems.push('Biaya service Rp0 — tidak ada yang diimpor.');
      if (s) {
        const wd = NP.rs.effectiveWithDoctor(s, true);
        const roles = NP.rs.requiredRoles(s, wd);
        const performers = {};
        for (const role of roles) {
          if (role === 'dokter' && x.empId) performers.dokter = x.empId;
          else if (opt.defaults && opt.defaults[role]) performers[role] = opt.defaults[role];
          else x.problems.push((NP.C.ROLES[role] || {}).label + ' pelaksana belum dipilih' + (role === 'dokter' ? ' (cocokkan dokter dengan Data Karyawan).' : ' — pilih di bagian 3 (Tindakan untuk biaya pemeriksaan).'));
        }
        if (!x.zero && roles.every((role) => performers[role])) {
          const chk = NP.rs.compute(s, { price: r.service, qty: 1, performers, employees: empMap, withDoctor: wd });
          chk.errors.forEach((e) => x.problems.push(e));
        }
        x.item = { serviceId: s.id, qty: 1, price: r.service, withDoctor: wd, performers };
      }
      // bawaan: ikut diimpor kecuali biaya 0, sudah pernah diimpor, atau pemeriksaan dokter sudah tercatat (kasir/database)
      x.defaultInclude = !x.zero && !x.already && !x.kasirDoctorFee && !x.dbDoctorFee;
      x.include = !x.zero && !x.already && (opt.included && opt.included.has(r.code) ? true : opt.excluded && opt.excluded.has(r.code) ? false : x.defaultInclude);
      out.push(x);
    }
    out.sort((a, b) => (a.date + a.time + a.code).localeCompare(b.date + b.time + b.code));
    const chosen = out.filter((x) => x.include);
    const blocking = chosen.filter((x) => x.problems.length);
    const transactions = chosen
      .filter((x) => !x.problems.length && x.item)
      .map((x) => ({ date: x.date, patient: x.patient.slice(0, 80), patientCode: '', externalRef: x.externalRef, note: ('Biaya pemeriksaan dokter · ' + x.code + ' · ' + x.doctor).slice(0, 200), items: [x.item] }));
    return {
      rows: out, transactions, blocking,
      stats: {
        rows: out.length, chosen: chosen.length, gross: u.sum(chosen, (x) => x.service), low: out.filter((x) => x.low).length, zero: out.filter((x) => x.zero).length,
        kasir: out.filter((x) => x.kasir.length).length, kasirTindakan: out.filter((x) => x.kasir.some((st) => st.services.length)).length, db: out.filter((x) => x.db.length).length, already: out.filter((x) => x.already).length
      }
    };
  }

  /** Master tindakan yang paling cocok untuk biaya pemeriksaan dokter. */
  function suggestService(services) {
    const act = services.filter((s) => s.active);
    const score = (s) => (DOCTOR_FEE_RE.test(s.name) ? 10 : 0) + (/HC|HOME/i.test(s.name) || s.category === 'Homecare' ? -8 : 0) + (s.category === 'Pemeriksaan dokter' ? 3 : 0) + (s.price === 100000 ? 2 : 0);
    const best = act.map((s) => [score(s), s]).sort((a, b) => b[0] - a[0])[0];
    return best && best[0] >= 10 ? best[1] : null;
  }

  NP.resep = { parseSheet, parseWorkbook, doctorSummary, plan, patientKey, suggestService, kasirIndex, isDoctorExam, examIndex, examLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = NP;
})(typeof globalThis !== 'undefined' ? globalThis : window);
