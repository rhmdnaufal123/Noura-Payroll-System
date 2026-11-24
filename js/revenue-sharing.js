/* Noura Payroll — mesin pembagian pendapatan (revenue sharing).
 * Murni (tanpa DOM/IndexedDB) sehingga dapat diuji otomatis.
 *
 * Konfigurasi bagian (share) pada master tindakan:
 *   { type: 'unit'|'role'|'employee'|'other', target, mode: 'nominal'|'percent'|'remainder', value }
 *   - unit     : target 'APT' | 'KLINIK'  -> bagian usaha
 *   - role     : target 'dokter'|'bidan'|'perawat'|'farmasi'|'petugas' -> petugas pelaksana transaksi
 *   - employee : target = ID karyawan tertentu
 *   - other    : target = nama penerima lain (non-karyawan, mis. laboratorium mitra)
 * Varian dokter (opsional): service.doctorShares = konfigurasi khusus bila tindakan dilakukan
 * DENGAN dokter; service.shares dipakai bila TANPA dokter. Pembagian khusus per petugas
 * (overrides) tetap diutamakan pada kedua varian.
 * Mode:
 *   - nominal   : rupiah tetap per 1 tindakan
 *   - percent   : persen dari harga jual per tindakan
 *   - remainder : sisa harga setelah bagian nominal & persen (dibagi rata bila lebih dari satu)
 */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const C = NP.C;
  const u = NP.u;

  const MODE_LABELS = { nominal: 'Nominal tetap', percent: 'Persentase', remainder: 'Sisa harga' };
  const TYPE_LABELS = { unit: 'Unit usaha', role: 'Petugas pelaksana', employee: 'Karyawan tertentu', other: 'Penerima lainnya' };

  function methodOf(shares) {
    const modes = new Set((shares || []).map((s) => (s.mode === 'remainder' ? 'x' : s.mode)));
    modes.delete('x');
    if (modes.size === 0) return 'nominal';
    if (modes.size === 1) return [...modes][0];
    return 'combo';
  }

  function methodLabel(m) {
    return { nominal: 'Nominal tetap', percent: 'Persentase', combo: 'Kombinasi' }[m] || m;
  }

  function targetLabel(share, employees) {
    switch (share.type) {
      case 'unit':
        return (C.UNITS[share.target] || {}).name || share.target;
      case 'role':
        return (C.ROLES[share.target] || {}).label + ' pelaksana';
      case 'employee': {
        const e = employees && (employees.get ? employees.get(share.target) : employees[share.target]);
        return e ? e.name : 'Karyawan ' + share.target;
      }
      case 'other':
        return share.target || 'Penerima lain';
      default:
        return '-';
    }
  }

  /** Apakah tindakan memiliki pembagian berbeda untuk "dengan dokter" dan "tanpa dokter". */
  function hasDoctorVariant(service) {
    return !!(service && service.doctorShares && service.doctorShares.length);
  }
  /** Varian yang benar-benar dipakai: dengan dokter hanya bila tindakan memilikinya. */
  function effectiveWithDoctor(service, withDoctor) {
    return !!withDoctor && hasDoctorVariant(service);
  }
  function baseShares(service, withDoctor) {
    return effectiveWithDoctor(service, withDoctor) ? service.doctorShares : (service && service.shares) || [];
  }

  /** Peran-peran pelaksana yang dibutuhkan oleh suatu tindakan (pada varian dengan/tanpa dokter). */
  function requiredRoles(service, withDoctor) {
    const roles = new Set();
    for (const s of baseShares(service, withDoctor)) if (s.type === 'role') roles.add(s.target);
    for (const o of (service && service.overrides) || []) for (const s of o.shares || []) if (s.type === 'role') roles.add(s.target);
    return [...roles];
  }

  /** Pilih konfigurasi bagian: override khusus petugas bila ada, selain itu konfigurasi standar. */
  function pickConfig(service, performers, withDoctor) {
    const ids = Object.values(performers || {}).filter(Boolean);
    for (const o of (service && service.overrides) || []) {
      if (ids.includes(o.employeeId) && o.shares && o.shares.length) return { shares: o.shares, overrideFor: o.employeeId };
    }
    return { shares: baseShares(service, withDoctor), overrideFor: null };
  }

  /** Bagi `total` sesuai bobot (float) menjadi bilangan bulat dengan metode sisa terbesar. */
  function apportion(rawAmounts, total) {
    const floors = rawAmounts.map((x) => Math.floor(x + 1e-9));
    let rest = total - floors.reduce((a, b) => a + b, 0);
    const order = rawAmounts
      .map((x, i) => ({ i, frac: x - Math.floor(x + 1e-9) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    let k = 0;
    while (rest > 0 && order.length) {
      floors[order[k % order.length].i] += 1;
      rest--;
      k++;
    }
    return floors;
  }

  /**
   * Hitung pembagian untuk satu baris tindakan.
   * @param {object} service  master tindakan
   * @param {object} opt { price, qty, performers:{role:empId}, employees: Map|obj, preview:boolean, withDoctor:boolean }
   * @returns {{shares:Array, gross:number, unitPrice:number, qty:number, total:number, unallocated:number, errors:string[], warnings:string[], overrideFor:string|null}}
   */
  function compute(service, opt) {
    opt = opt || {};
    const errors = [];
    const warnings = [];
    const price = u.toInt(opt.price !== undefined && opt.price !== null && opt.price !== '' ? opt.price : service.price);
    const qty = Math.max(0, Math.floor(u.toNum(opt.qty === undefined ? 1 : opt.qty)));
    const performers = opt.performers || {};
    const employees = opt.employees || {};
    const getEmp = (id) => (employees.get ? employees.get(id) : employees[id]);

    if (price < 0) errors.push('Harga jual tidak boleh negatif.');
    if (qty < 1) errors.push('Jumlah tindakan minimal 1.');

    const withDoctor = effectiveWithDoctor(service, opt.withDoctor);
    const picked = pickConfig(service, performers, withDoctor);
    const cfg = picked.shares.map((s) => Object.assign({}, s));
    if (!cfg.length) warnings.push('Tindakan belum memiliki konfigurasi pembagian; seluruh pendapatan menjadi bagian unit usaha.');

    // 1. Nominal
    const unit = new Array(cfg.length).fill(0);
    let fixed = 0;
    cfg.forEach((s, i) => {
      if (s.mode === 'nominal') {
        const v = u.toInt(s.value);
        if (v < 0) errors.push('Nominal pembagian tidak boleh negatif.');
        unit[i] = v;
        fixed += v;
      }
    });
    // 2. Persentase (dibulatkan dengan metode sisa terbesar agar total tepat)
    const pIdx = [];
    let pSum = 0;
    cfg.forEach((s, i) => {
      if (s.mode === 'percent') {
        const v = u.toNum(s.value);
        if (v < 0) errors.push('Persentase pembagian tidak boleh negatif.');
        pIdx.push(i);
        pSum += v;
      }
    });
    if (pSum > 100 + 1e-9) errors.push('Total persentase ' + u.pct(pSum) + ' melebihi 100%.');
    if (pIdx.length) {
      const raw = pIdx.map((i) => (price * u.toNum(cfg[i].value)) / 100);
      const target = Math.round((price * pSum) / 100);
      const ints = apportion(raw, target);
      pIdx.forEach((i, k) => {
        unit[i] = ints[k];
        fixed += ints[k];
      });
    }
    if (fixed > price) errors.push('Total pembagian ' + u.rp(fixed) + ' melebihi harga jual ' + u.rp(price) + '.');

    // 3. Sisa
    const rIdx = [];
    cfg.forEach((s, i) => {
      if (s.mode === 'remainder') rIdx.push(i);
    });
    let rest = Math.max(0, price - fixed);
    if (rIdx.length) {
      const each = Math.floor(rest / rIdx.length);
      let residue = rest - each * rIdx.length;
      rIdx.forEach((i) => {
        unit[i] = each + (residue > 0 ? 1 : 0);
        if (residue > 0) residue--;
      });
      rest = 0;
    }

    // 4. Resolusi penerima
    const shares = cfg.map((s, i) => {
      const out = {
        type: s.type,
        target: s.target,
        mode: s.mode,
        value: s.mode === 'percent' ? u.toNum(s.value) : u.toInt(s.value),
        recipientId: null,
        recipientName: '',
        category: 'eksternal',
        role: null,
        unitAmount: unit[i],
        amount: unit[i] * qty,
        implicit: false
      };
      if (s.type === 'unit') {
        out.recipientId = s.target;
        out.recipientName = (C.UNITS[s.target] || {}).name || s.target;
        out.category = s.target === 'APT' ? 'apotek' : 'klinik';
      } else if (s.type === 'role') {
        const id = performers[s.target];
        out.role = s.target;
        out.category = s.target;
        if (id) {
          const e = getEmp(id);
          out.recipientId = id;
          out.recipientName = e ? e.name : id;
        } else {
          out.recipientName = '(' + ((C.ROLES[s.target] || {}).label || s.target) + ' pelaksana)';
          if (!opt.preview) errors.push('Petugas ' + ((C.ROLES[s.target] || {}).label || s.target) + ' belum dipilih.');
        }
      } else if (s.type === 'employee') {
        const e = getEmp(s.target);
        out.recipientId = s.target;
        out.recipientName = e ? e.name : s.target;
        out.role = e ? C.roleOfPosition(e.position) : 'petugas';
        out.category = out.role;
        if (!e && !opt.preview) errors.push('Karyawan penerima (' + s.target + ') tidak ditemukan.');
      } else {
        out.recipientName = s.target || 'Penerima lain';
        out.category = 'eksternal';
      }
      return out;
    });

    if (rest > 0) {
      warnings.push('Pembagian belum mencapai harga jual. Sisa ' + u.rp(rest) + ' per tindakan dialokasikan ke ' + C.UNITS[service.unit || 'APT'].name + '.');
      const uc = service.unit || 'APT';
      shares.push({
        type: 'unit', target: uc, mode: 'remainder', value: 0, recipientId: uc, recipientName: C.UNITS[uc].name,
        category: uc === 'APT' ? 'apotek' : 'klinik', role: null, unitAmount: rest, amount: rest * qty, implicit: true
      });
    }

    const gross = price * qty;
    const total = shares.reduce((a, s) => a + s.amount, 0);
    return { shares, gross, unitPrice: price, qty, total, unallocated: errors.length ? 0 : gross - total, errors, warnings, overrideFor: picked.overrideFor, withDoctor };
  }

  /** Validasi konfigurasi bagian pada form master tindakan (tanpa petugas). */
  function validateConfig(service) {
    const r = compute(service, { price: service.price, qty: 1, preview: true });
    const errs = r.errors.slice();
    for (const s of service.shares || []) {
      if (!s.type) errs.push('Jenis penerima wajib dipilih.');
      if (s.type !== 'other' && !s.target) errs.push('Penerima pendapatan wajib dipilih.');
      if (s.type === 'other' && !String(s.target || '').trim()) errs.push('Nama penerima lainnya wajib diisi.');
    }
    if (hasDoctorVariant(service)) {
      const rd = compute(service, { price: service.price, qty: 1, preview: true, withDoctor: true });
      rd.errors.forEach((e) => errs.push('Dengan dokter: ' + e));
      for (const sh of service.doctorShares) if (sh.type !== 'other' && !sh.target) errs.push('Dengan dokter: penerima pendapatan wajib dipilih.');
    }
    for (const o of service.overrides || []) {
      if (!o.employeeId) errs.push('Pembagian khusus petugas: karyawan wajib dipilih.');
      const ro = compute(Object.assign({}, service, { shares: o.shares, overrides: [] }), { price: service.price, qty: 1, preview: true });
      ro.errors.forEach((e) => errs.push('Pembagian khusus: ' + e));
    }
    return { ok: errs.length === 0, errors: [...new Set(errs)], warnings: r.warnings, preview: r };
  }

  /** Ringkasan per kategori dari kumpulan bagian. */
  function summarize(shares) {
    const t = { apotek: 0, klinik: 0, dokter: 0, bidan: 0, perawat: 0, farmasi: 0, petugas: 0, eksternal: 0 };
    for (const s of shares || []) t[s.category] = (t[s.category] || 0) + (s.amount || 0);
    t.business = t.apotek + t.klinik;
    t.staff = t.dokter + t.bidan + t.perawat + t.farmasi + t.petugas;
    return t;
  }

  /** Ringkasan untuk satu transaksi (semua item). */
  function summarizeTrx(trx) {
    const all = [];
    for (const it of trx.items || []) for (const s of it.shares || []) all.push(s);
    const t = summarize(all);
    t.gross = u.sum(trx.items, (i) => i.gross);
    return t;
  }

  NP.rs = { compute, validateConfig, summarize, summarizeTrx, requiredRoles, pickConfig, hasDoctorVariant, effectiveWithDoctor, methodOf, methodLabel, targetLabel, apportion, MODE_LABELS, TYPE_LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = NP;
})(typeof globalThis !== 'undefined' ? globalThis : window);
