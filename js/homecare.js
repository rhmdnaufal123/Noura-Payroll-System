/* Noura Payroll — JASA BIDAN HOMECARE PER KUNJUNGAN (logika murni, dipakai tab Input Bulanan).
 *  Aturan: bidan pelaksana mendapat nominal tetap (bawaan Rp100.000) SEKALI per kunjungan —
 *  satu transaksi/struk yang berisi tindakan homecare — berapa pun jumlah tindakannya.
 *  Aturan disimpan di Master Tindakan sebagai bagian "Bidan pelaksana · Nominal · Per kunjungan",
 *  sehingga dihitung oleh mesin pembagian yang sama (lokal & server). Tindakan homecare yang
 *  seluruhnya untuk dokter (mis. Pemeriksaan Dokter Umum HC Rp300.000) tidak diubah.
 */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const C = NP.C;
  const rs = NP.rs;
  const u = NP.u;

  const DEFAULT_NOMINAL = 100000;
  const isHomecare = (s) => !!s && C.serviceGroup(s.category, s.name || s.serviceName) === 'homecare';
  const isBidanVisit = (s, nominal) => s.type === 'role' && s.target === 'bidan' && s.mode === 'nominal' && !!s.perVisit && u.toInt(s.value) === nominal;
  const hasRole = (list, role) => (list || []).some((s) => s.type === 'role' && s.target === role);

  /** Ganti bagian bidan menjadi nominal per kunjungan; bagian lain tetap. */
  function withRule(shares, nominal) {
    const rest = (shares || []).filter((s) => !(s.type === 'role' && s.target === 'bidan'));
    const i = rest.findIndex((s) => s.mode === 'remainder');
    const bidan = { type: 'role', target: 'bidan', mode: 'nominal', value: nominal, perVisit: true };
    if (i < 0) return rest.concat(bidan);
    return rest.slice(0, i).concat(bidan, rest.slice(i)); // sebelum "sisa" agar urutan rapi
  }

  /**
   * Rencana perubahan satu tindakan homecare.
   * status: 'ok' (sudah sesuai) | 'change' (akan diubah) | 'doctor' (khusus dokter, dilewati bawaan)
   *         | 'short' (harga tidak cukup / konfigurasi tidak valid)
   */
  function planService(service, nominal) {
    nominal = u.toInt(nominal);
    const variant = rs.hasDoctorVariant(service);
    // khusus dokter: pembagian hanya untuk dokter, atau tindakan pemeriksaan dokter (mis. "Pemeriksaan Dokter Umum HC")
    const doctorOnly = !hasRole(service.shares, 'bidan') && (hasRole(service.shares, 'dokter') || /\bdokter\b/i.test(service.name || ''));
    const already = (service.shares || []).some((s) => isBidanVisit(s, nominal)) && (!variant || (service.doctorShares || []).some((s) => isBidanVisit(s, nominal)));
    const next = Object.assign({}, service, { shares: withRule(service.shares, nominal), doctorShares: variant ? withRule(service.doctorShares, nominal) : service.doctorShares || [] });
    const v = rs.validateConfig(next);
    let status = already ? 'ok' : doctorOnly ? 'doctor' : v.ok ? 'change' : 'short';
    if (!(nominal > 0)) status = 'short';
    return { service, status, next, errors: nominal > 0 ? v.errors : ['Nominal jasa bidan harus lebih dari 0.'], doctorOnly };
  }

  /** Tindakan homecare dengan aturan bidan per kunjungan (sudah tersimpan di master). */
  const ruled = (service, nominal) => isHomecare(service) && (service.shares || []).some((s) => isBidanVisit(s, nominal));

  /**
   * Kunjungan homecare (transaksi aktif yang berisi tindakan homecare) dalam rentang tanggal.
   * @returns [{ t, hcItems, ruledItems, bidanAmount, bidanId, status }]
   *   status: 'ok' | 'fix' (perlu diterapkan) | 'norule' (tak ada tindakan berjasa bidan)
   */
  function visits(trxs, services, opt) {
    const svcMap = new Map(services.map((s) => [s.id, s]));
    const nominal = u.toInt(opt.nominal);
    const out = [];
    for (const t of trxs) {
      if (t.status !== 'active' || (opt.start && t.date < opt.start) || (opt.end && t.date > opt.end)) continue;
      const hcItems = t.items.filter((i) => isHomecare(svcMap.get(i.serviceId) || i));
      if (!hcItems.length) continue;
      const ruledItems = hcItems.filter((i) => ruled(svcMap.get(i.serviceId), nominal));
      // jasa bidan dari tindakan homecare saja (jasa bidan tindakan lain di struk yang sama tidak dihitung)
      let bidanAmount = 0;
      let bidanId = '';
      let allVisit = true;
      for (const i of hcItems) {
        for (const s of i.shares || []) if (s.role === 'bidan' && s.amount > 0) {
          bidanAmount += s.amount;
          bidanId = bidanId || s.recipientId || '';
          if (!s.perVisit) allVisit = false;
        }
      }
      for (const i of t.items) if (!bidanId && i.performers && i.performers.bidan) bidanId = i.performers.bidan;
      const status = !ruledItems.length ? 'norule' : bidanAmount === nominal && allVisit && bidanId ? 'ok' : 'fix';
      out.push({ t, hcItems, ruledItems, bidanAmount, bidanId, status });
    }
    return out.sort((a, b) => (a.t.date + a.t.id).localeCompare(b.t.date + b.t.id));
  }

  /**
   * Draft simpan ulang satu transaksi: tindakan homecare berjasa bidan dihitung ulang dengan aturan
   * terbaru (tanpa lineId → pembagian baru) dan bidan pelaksana diisi; tindakan lain tidak diubah.
   */
  function draftFor(t, bidanId, services, nominal) {
    const svcMap = new Map(services.map((s) => [s.id, s]));
    return {
      date: t.date, patient: t.patient, patientCode: t.patientCode || '', note: t.note || '',
      items: t.items.map((i) => {
        const base = { serviceId: i.serviceId, qty: i.qty, price: i.price, withDoctor: !!i.withDoctor, performers: Object.assign({}, i.performers) };
        if (!ruled(svcMap.get(i.serviceId), nominal)) return Object.assign(base, { lineId: i.lineId });
        base.performers.bidan = bidanId;
        return base;
      })
    };
  }

  NP.hc = { DEFAULT_NOMINAL, isHomecare, planService, ruled, visits, draftFor, withRule };
  if (typeof module !== 'undefined' && module.exports) module.exports = NP;
})(typeof globalThis !== 'undefined' ? globalThis : window);
