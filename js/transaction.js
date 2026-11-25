/* Noura Payroll — transaksi tindakan: INPUT TINDAKAN harian, RIWAYAT TRANSAKSI, koreksi & pembatalan, audit.
 *
 * Aturan integritas:
 *  - Setiap transaksi menyimpan salinan (snapshot) harga & pembagian saat transaksi dibuat,
 *    sehingga perubahan tarif di master tindakan tidak mengubah transaksi historis.
 *  - Setiap bagian (share) milik karyawan memiliki status penggajian: payroll {runId, state}
 *    state: null (belum diproses) | 'draft' | 'approved' | 'locked'.
 *  - Transaksi yang sudah masuk periode gaji TERKUNCI hanya dapat dikoreksi/dibatalkan dengan
 *    otorisasi administrator; selisihnya dicatat sebagai "adjustment" yang diproses pada penggajian berikutnya.
 */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;
  const C = NP.C;
  const rs = NP.rs;

  /* ===================== Data ===================== */
  const trx = {};
  trx.all = async () => (await NP.db.all('transactions')).sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  trx.get = (id) => NP.db.get('transactions', id);

  trx.empShares = function (t) {
    const out = [];
    t.items.forEach((it) => it.shares.forEach((s, si) => {
      if ((s.type === 'role' || s.type === 'employee') && s.recipientId) out.push({ item: it, share: s, si });
    }));
    return out;
  };

  /** Status penggajian transaksi: none | open | inrun | paid | partial */
  trx.payrollStatus = function (t) {
    const sh = trx.empShares(t);
    if (!sh.length) return 'none';
    const st = sh.map((x) => (x.share.payroll && x.share.payroll.state) || null);
    if (st.every((s) => s === 'locked')) return 'paid';
    if (st.every((s) => s === null)) return 'open';
    if (st.every((s) => s !== null)) return 'inrun';
    return 'partial';
  };
  trx.pendingAdjustments = (t) => (t.adjustments || []).filter((a) => !a.payroll || !a.payroll.runId);

  /** Bangun satu item transaksi dari master tindakan (snapshot). */
  /** Kunci bagian "per kunjungan" yang sudah dibayar oleh suatu item. */
  trx.paidKeys = (item) => (item.shares || []).filter((x) => x.perVisit && x.amount > 0).map((x) => rs.visitKeyOf(x));

  trx.buildItem = function (service, input, empMap, paid) {
    const wd = rs.effectiveWithDoctor(service, input.withDoctor);
    const r = rs.compute(service, { price: input.price, qty: input.qty, performers: input.performers, employees: empMap, withDoctor: wd, paid: paid ? [...paid] : [] });
    if (r.errors.length) {
      const e = new Error(service.name + ': ' + r.errors.join(' '));
      e.errors = r.errors;
      throw e;
    }
    const performers = {};
    for (const role of rs.requiredRoles(service, wd)) if (input.performers && input.performers[role]) performers[role] = input.performers[role];
    const performerNames = {};
    for (const [role, id] of Object.entries(performers)) performerNames[role] = (empMap.get(id) || {}).name || id;
    return {
      lineId: input.lineId || u.uid('ln'),
      serviceId: service.id, serviceCode: service.code, serviceName: service.name, category: service.category, unit: service.unit,
      qty: r.qty, price: r.unitPrice, gross: r.gross, withDoctor: wd, performers, performerNames, overrideFor: r.overrideFor,
      shares: r.shares.map((s) => Object.assign(s, { payroll: { runId: null, state: null } }))
    };
  };

  /** Nama tindakan beserta varian (untuk tampilan & ekspor). */
  trx.itemLabel = (i) => i.serviceName + (i.withDoctor ? ' (dengan dokter)' : '');

  trx.totals = function (items) {
    const t = rs.summarize([].concat(...items.map((i) => i.shares)));
    t.gross = u.sum(items, (i) => i.gross);
    t.qty = u.sum(items, (i) => i.qty);
    return t;
  };

  /** Jumlah yang sudah dibayar/terjadwal per karyawan untuk transaksi terkunci.
   * Invarian: setelah setiap koreksi, bagian awal yang dibayar + seluruh adjustment = bagian
   * terkunci saat ini, sehingga cukup menjumlahkan bagian terkunci (adjustment tidak ditambah lagi). */
  function settledByEmployee(t) {
    const m = new Map();
    for (const { share } of trx.empShares(t)) if (share.payroll && share.payroll.state === 'locked') m.set(share.recipientId, (m.get(share.recipientId) || 0) + share.amount);
    return m;
  }

  function lockedRunOf(t) {
    for (const { share } of trx.empShares(t)) if (share.payroll && share.payroll.state === 'locked') return share.payroll.runId;
    return null;
  }

  function checkEditable(t) {
    if (t.status === 'cancelled') throw new Error('Transaksi sudah dibatalkan dan tidak dapat diubah.');
    const appr = trx.empShares(t).find((x) => x.share.payroll && x.share.payroll.state === 'approved');
    if (appr) throw new Error('Transaksi sudah masuk penggajian ' + appr.share.payroll.runId + ' yang telah DISETUJUI. Kembalikan penggajian tersebut ke draft terlebih dahulu (menu Riwayat Penggajian).');
    return { locked: !!lockedRunOf(t), draftRuns: [...new Set(trx.empShares(t).filter((x) => x.share.payroll && x.share.payroll.state === 'draft').map((x) => x.share.payroll.runId))] };
  }
  trx.checkEditable = checkEditable;

  async function markRunsStale(t, runIds, reason) {
    for (const id of runIds) {
      const run = await t.get('payrollRuns', id);
      if (run && run.status === 'draft') {
        run.stale = true;
        run.staleReason = reason;
        await t.put('payrollRuns', run);
      }
    }
  }

  /** Buat adjustment selisih (untuk koreksi transaksi terkunci). */
  function buildAdjustments(oldT, newItems, auth, kind) {
    const settled = settledByEmployee(oldT);
    const now = new Map();
    for (const it of newItems || []) for (const s of it.shares) if ((s.type === 'role' || s.type === 'employee') && s.recipientId) now.set(s.recipientId, (now.get(s.recipientId) || 0) + s.amount);
    const ids = new Set([...settled.keys(), ...now.keys()]);
    const unitOf = (empId) => {
      for (const it of (newItems || []).concat(oldT.items)) for (const s of it.shares) if (s.recipientId === empId) return it.unit;
      return 'APT';
    };
    const adj = [];
    for (const id of ids) {
      const delta = (now.get(id) || 0) - (settled.get(id) || 0);
      if (delta) adj.push({ id: u.uid('adj'), employeeId: id, amount: delta, unit: unitOf(id), date: u.todayISO(), kind, note: auth.note, by: auth.by, ts: Date.now(), payroll: { runId: null, state: null } });
    }
    return adj;
  }

  /**
   * Simpan transaksi baru atau perubahan.
   * @param {object} draft { date, patient, patientCode, note, items:[{serviceId, qty, price, performers, lineId}] }
   * @param {object} opt   { editId, auth }
   */
  trx.save = async function (draft, opt) {
    opt = opt || {};
    if (!draft.date) throw new Error('Tanggal transaksi wajib diisi.');
    if (draft.date > u.todayISO()) throw new Error('Tanggal transaksi tidak boleh melebihi hari ini.');
    if (!draft.items || !draft.items.length) throw new Error('Minimal satu tindakan.');
    if (NP.db.remote) return NP.db.saveTransaction(draft, opt);
    const services = new Map((await NP.db.all('services')).map((s) => [s.id, s]));
    const empMap = await NP.emp.map();
    const old = opt.editId ? await trx.get(opt.editId) : null;
    const paid = new Set(); // bagian per kunjungan yang sudah dibayar item sebelumnya
    const keep = (it) => {
      trx.paidKeys(it).forEach((k) => paid.add(k));
      return it;
    };
    const items = draft.items.map((inp, idx) => {
      // Untuk edit: item lama yang tidak diubah (tindakan, harga, jumlah, petugas sama) tetap memakai snapshot lama.
      const prev = old && old.items.find((x) => x.lineId === inp.lineId);
      if (prev && prev.serviceId === inp.serviceId && prev.qty === u.toInt(inp.qty) && prev.price === u.toInt(inp.price) && !!prev.withDoctor === !!inp.withDoctor && JSON.stringify(prev.performers) === JSON.stringify(cleanPerf(inp.performers, prev))) {
        return keep(u.clone(prev));
      }
      const svc = services.get(inp.serviceId);
      if (!svc) throw new Error('Baris ' + (idx + 1) + ': tindakan tidak ditemukan.');
      if (!svc.active && !(prev && prev.serviceId === svc.id)) throw new Error('Baris ' + (idx + 1) + ': tindakan "' + svc.name + '" sudah nonaktif.');
      for (const id of Object.values(inp.performers || {})) {
        const e = empMap.get(id);
        if (id && (!e || (e.status !== 'aktif' && e.status !== 'cuti') && !(prev && Object.values(prev.performers).includes(id)))) throw new Error('Baris ' + (idx + 1) + ': petugas tidak aktif.');
      }
      if (!(u.toInt(inp.price) > 0)) throw new Error('Baris ' + (idx + 1) + ': harga jual harus lebih dari 0.');
      if (!(u.toInt(inp.qty) >= 1)) throw new Error('Baris ' + (idx + 1) + ': jumlah minimal 1.');
      return keep(trx.buildItem(svc, inp, empMap, paid));
    });
    function cleanPerf(p, prev) {
      const o = {};
      for (const k of Object.keys(prev.performers || {})) if (p && p[k]) o[k] = p[k];
      return o;
    }

    const usr = NP.sec.user();
    return NP.db.run(['transactions', 'counters', 'auditLog', 'payrollRuns'], async (t) => {
      let rec;
      if (!old) {
        const ym = draft.date.slice(0, 7).replace('-', '');
        const n = await t.nextNumber('trx-' + ym);
        rec = {
          id: NP.state.settings.numbering.transaction + '-' + ym + '-' + String(n).padStart(4, '0'),
          date: draft.date, patient: draft.patient || '', patientCode: draft.patientCode || '', note: draft.note || '', externalRef: draft.externalRef || null,
          items, status: 'active', adjustments: [], createdAt: Date.now(), createdBy: usr ? usr.username : 'sistem'
        };
        if (rec.externalRef && (await t.all('transactions')).some((x) => x.externalRef === rec.externalRef && x.status === 'active')) throw new Error('Data ' + rec.externalRef + ' sudah pernah disimpan.');
        rec.totals = trx.totals(items);
        await t.put('transactions', rec);
        await t.put('auditLog', NP.audit.entry('trx.create', 'transaction', rec.id, 'Transaksi baru ' + items.length + ' tindakan, total ' + u.rp(rec.totals.gross)));
        return rec;
      }
      const cur = await t.get('transactions', old.id);
      const chk = checkEditable(cur);
      if (chk.locked && !opt.auth) {
        const e = new Error('Transaksi sudah masuk periode gaji terkunci. Diperlukan otorisasi administrator.');
        e.code = 'LOCKED';
        throw e;
      }
      rec = u.clone(cur);
      const before = { date: cur.date, total: cur.totals.gross, items: cur.items.map((i) => i.serviceName + ' ×' + i.qty).join(', ') };
      Object.assign(rec, { date: draft.date, patient: draft.patient || '', patientCode: draft.patientCode || '', note: draft.note || '', items });
      if (chk.locked) {
        const runId = lockedRunOf(cur);
        const adj = buildAdjustments(cur, items, opt.auth, 'koreksi');
        rec.adjustments = (rec.adjustments || []).concat(adj);
        for (const { share } of trx.empShares(rec)) share.payroll = { runId, state: 'locked' };
        rec.corrections = (rec.corrections || []).concat([{ ts: Date.now(), by: opt.auth.by, note: opt.auth.note, before }]);
      } else {
        // Bagian yang dalam draft penggajian dilepas; draft ditandai perlu dihitung ulang.
        for (const { share } of trx.empShares(rec)) if (share.payroll && share.payroll.state === 'draft') share.payroll = { runId: null, state: null };
        await markRunsStale(t, chk.draftRuns, 'Transaksi ' + rec.id + ' diubah');
      }
      rec.totals = trx.totals(items);
      rec.updatedAt = Date.now();
      rec.updatedBy = usr ? usr.username : 'sistem';
      await t.put('transactions', rec);
      const after = { date: rec.date, total: rec.totals.gross, items: rec.items.map((i) => i.serviceName + ' ×' + i.qty).join(', ') };
      await t.put('auditLog', NP.audit.entry(chk.locked ? 'trx.correction' : 'trx.update', 'transaction', rec.id,
        (chk.locked ? 'KOREKSI TERKUNCI (otorisasi ' + opt.auth.by + '): ' + opt.auth.note + ' | ' : 'Ubah transaksi | ') + 'Sebelum: ' + before.items + ' = ' + u.rp(before.total) + ' (' + before.date + ') → Sesudah: ' + after.items + ' = ' + u.rp(after.total) + ' (' + after.date + ')'));
      return rec;
    });
  };

  /**
   * Simpan banyak transaksi sekaligus (input bulanan / impor POS).
   * Supabase: satu transaksi database (semua tersimpan atau tidak sama sekali).
   * Transaksi ber-externalRef yang sudah ada dilewati agar impor ulang tidak menggandakan data.
   * @returns {{created:string[], skipped:string[], gross:number}}
   */
  trx.bulkSave = async function (list, source, onProgress) {
    if (!list || !list.length) throw new Error('Tidak ada transaksi untuk disimpan.');
    for (const d of list) {
      if (!d.date) throw new Error('Tanggal transaksi wajib diisi.');
      if (d.date > u.todayISO()) throw new Error('Tanggal ' + u.fmtDate(d.date) + ' melebihi hari ini.');
      if (!d.items || !d.items.length) throw new Error('Transaksi ' + (d.externalRef || u.fmtDate(d.date)) + ' tidak memiliki tindakan.');
    }
    if (NP.db.remote) {
      const out = [];
      const res = { created: [], skipped: [], gross: 0 };
      // dipecah per 200 transaksi agar permintaan tidak terlalu besar
      for (let i = 0; i < list.length; i += 200) out.push(list.slice(i, i + 200));
      for (const [n, chunk] of out.entries()) {
        onProgress && onProgress(n * 200, list.length);
        const r = await NP.db.bulkSaveTransactions(chunk, source);
        res.created.push(...(r.created || []));
        res.skipped.push(...(r.skipped || []));
        res.gross += Number(r.gross) || 0;
      }
      return res;
    }
    const existing = new Set((await NP.db.all('transactions')).filter((t) => t.status === 'active' && t.externalRef).map((t) => t.externalRef));
    const res = { created: [], skipped: [], gross: 0 };
    for (const [i, d] of list.entries()) {
      onProgress && onProgress(i, list.length);
      if (d.externalRef && existing.has(d.externalRef)) {
        res.skipped.push(d.externalRef);
        continue;
      }
      try {
        const rec = await trx.save(d);
        res.created.push(rec.id);
        res.gross += rec.totals.gross;
        if (d.externalRef) existing.add(d.externalRef);
      } catch (e) {
        e.message = 'Data ke-' + (i + 1) + ' (' + (d.externalRef || u.fmtDate(d.date)) + '): ' + e.message + (res.created.length ? ' — ' + res.created.length + ' transaksi sebelumnya sudah tersimpan.' : '');
        e.partial = res;
        throw e;
      }
    }
    if (res.created.length) await NP.audit.log('trx.bulk', 'transaction', res.created[0], 'Input massal (' + (source || 'input bulanan') + '): ' + res.created.length + ' transaksi tersimpan, ' + res.skipped.length + ' dilewati, total ' + u.rp(res.gross));
    return res;
  };

  /** Hak & status ubah: { ok, reason } — dipakai tombol dengan/tanpa dokter di daftar. */
  trx.canQuickEdit = function (t) {
    const usr = NP.sec.user();
    if (t.status !== 'active') return { ok: false, reason: 'Transaksi dibatalkan' };
    if (!NP.sec.can('trx.editAny') && !(NP.sec.can('trx.editOwn') && usr && t.createdBy === usr.username)) return { ok: false, reason: 'Hanya transaksi yang Anda input sendiri' };
    try {
      if (checkEditable(t).locked) return { ok: false, reason: 'Periode gaji terkunci — ubah lewat Riwayat Transaksi (otorisasi admin)' };
    } catch (e) {
      return { ok: false, reason: 'Penggajian sudah disetujui' };
    }
    return { ok: true };
  };

  /**
   * Ubah pilihan dengan/tanpa dokter pada item tertentu suatu transaksi.
   * @param changes { lineId: true|false }
   * @param opt { doctorId } dokter pelaksana bila item menjadi "dengan dokter" dan belum ada dokternya
   * Error.code 'NEED_ROLE' (e.role) bila pelaksana yang dibutuhkan belum ada.
   */
  trx.setVariant = async function (id, changes, opt) {
    opt = opt || {};
    const t = await trx.get(id);
    if (!t) throw new Error('Transaksi tidak ditemukan.');
    const q = trx.canQuickEdit(t);
    if (!q.ok) throw new Error(t.id + ': ' + q.reason + '.');
    const services = new Map((await NP.db.all('services')).map((x) => [x.id, x]));
    let changed = 0;
    const items = t.items.map((i) => {
      const sv = services.get(i.serviceId);
      const want = Object.prototype.hasOwnProperty.call(changes, i.lineId) && sv && rs.hasDoctorVariant(sv) ? !!changes[i.lineId] : !!i.withDoctor;
      const performers = Object.assign({}, i.performers);
      if (want !== !!i.withDoctor) {
        changed++;
        if (want && !performers.dokter && opt.doctorId) performers.dokter = opt.doctorId;
        const miss = rs.requiredRoles(sv, want).filter((role) => !performers[role]);
        if (miss.length) {
          const e = new Error(i.serviceName + ': ' + ((C.ROLES[miss[0]] || {}).label || miss[0]) + ' pelaksana belum dipilih.');
          e.code = 'NEED_ROLE';
          e.role = miss[0];
          throw e;
        }
      }
      return { lineId: i.lineId, serviceId: i.serviceId, qty: i.qty, price: i.price, withDoctor: want, performers };
    });
    if (!changed) return t;
    return trx.save({ date: t.date, patient: t.patient, patientCode: t.patientCode, note: t.note, items }, { editId: t.id });
  };

  /** Item bervarian yang menurut aturan seharusnya "dengan dokter" (pasien diperiksa dokter / transaksi memuat pemeriksaan). */
  trx.doctorSuggestions = function (t, examIdx, services) {
    if (t.status !== 'active' || !NP.resep) return [];
    const hits = t.patient ? (examIdx.get(NP.resep.patientKey(t.patient) + '|' + t.date) || []).filter((h) => !(h.src === 'db' && h.ref === t.id)) : [];
    const inTrx = t.items.find((i) => NP.resep.isDoctorExam(i.serviceName, i.category));
    if (!hits.length && !inTrx) return [];
    const reason = hits.length ? 'pasien diperiksa dokter (' + hits.map(NP.resep.examLabel).join(', ') + ')' : 'transaksi memuat ' + inTrx.serviceName;
    const doctorId = (hits.find((h) => h.doctorId) || {}).doctorId || (inTrx && inTrx.performers && inTrx.performers.dokter) || '';
    return t.items
      .filter((i) => !i.withDoctor && services.get(i.serviceId) && rs.hasDoctorVariant(services.get(i.serviceId)))
      .map((i) => ({ lineId: i.lineId, serviceName: i.serviceName, reason, doctorId }));
  };

  /** Dapat dihapus permanen? Tidak bila sudah masuk penggajian atau memiliki koreksi. */
  trx.deletable = (t) => !trx.empShares(t).some((x) => x.share.payroll && (x.share.payroll.state || x.share.payroll.runId)) && !(t.adjustments || []).length;

  /**
   * Hapus permanen beberapa transaksi (Administrator). Transaksi yang sudah masuk penggajian /
   * memiliki koreksi dilewati. @returns {{deleted:string[], skipped:[{id, reason}], gross:number}}
   */
  trx.removeMany = async function (ids, reason) {
    if (!NP.sec.can('trx.delete')) throw new Error('Hanya Administrator yang dapat menghapus transaksi.');
    if (!reason || reason.trim().length < 3) throw new Error('Alasan penghapusan wajib diisi (min. 3 karakter).');
    if (!ids || !ids.length) throw new Error('Tidak ada transaksi yang dipilih.');
    if (NP.db.remote) {
      const r = await NP.db.deleteTransactions(ids, reason.trim());
      return { deleted: r.deleted || [], skipped: r.skipped || [], gross: Number(r.gross) || 0 };
    }
    return NP.db.run(['transactions', 'auditLog'], async (t) => {
      const res = { deleted: [], skipped: [], gross: 0 };
      for (const id of ids) {
        const cur = await t.get('transactions', id);
        if (!cur) {
          res.skipped.push({ id, reason: 'tidak ditemukan' });
          continue;
        }
        if (!trx.deletable(cur)) {
          res.skipped.push({ id, reason: 'sudah masuk penggajian atau memiliki koreksi' });
          continue;
        }
        await t.del('transactions', id);
        res.deleted.push(id);
        res.gross += cur.totals.gross;
        await t.put('auditLog', NP.audit.entry('trx.delete', 'transaction', id, 'Hapus transaksi ' + id + ' (' + cur.date + ', ' + u.rp(cur.totals.gross) + '): ' + reason.trim(), { before: cur }));
      }
      return res;
    });
  };

  /** Batalkan transaksi. Transaksi terkunci memerlukan otorisasi (opt.auth) dan menghasilkan adjustment negatif. */
  trx.cancel = async function (id, reason, opt) {
    opt = opt || {};
    if (!reason || reason.trim().length < 3) throw new Error('Alasan pembatalan wajib diisi.');
    if (NP.db.remote) return NP.db.cancelTransaction(id, reason, opt);
    const usr = NP.sec.user();
    return NP.db.run(['transactions', 'auditLog', 'payrollRuns'], async (t) => {
      const cur = await t.get('transactions', id);
      if (!cur) throw new Error('Transaksi tidak ditemukan.');
      const chk = checkEditable(cur);
      if (chk.locked && !opt.auth) {
        const e = new Error('Transaksi sudah masuk periode gaji terkunci. Diperlukan otorisasi administrator.');
        e.code = 'LOCKED';
        throw e;
      }
      const rec = u.clone(cur);
      if (chk.locked) {
        rec.adjustments = (rec.adjustments || []).concat(buildAdjustments(cur, [], opt.auth, 'pembatalan'));
      } else {
        for (const { share } of trx.empShares(rec)) if (share.payroll && share.payroll.state === 'draft') share.payroll = { runId: null, state: null };
        await markRunsStale(t, chk.draftRuns, 'Transaksi ' + rec.id + ' dibatalkan');
      }
      rec.status = 'cancelled';
      rec.cancelReason = reason;
      rec.cancelledAt = Date.now();
      rec.cancelledBy = usr ? usr.username : 'sistem';
      await t.put('transactions', rec);
      await t.put('auditLog', NP.audit.entry('trx.cancel', 'transaction', id, 'Batalkan transaksi (' + u.rp(cur.totals.gross) + '): ' + reason + (opt.auth ? ' | otorisasi ' + opt.auth.by + ': ' + opt.auth.note : '')));
      return rec;
    });
  };

  /** Alur UI pembatalan (termasuk otorisasi bila terkunci). */
  trx.cancelFlow = async function (t, onDone) {
    if (!NP.sec.can('trx.cancel')) return ui.toast('Anda tidak memiliki hak membatalkan transaksi.', 'error');
    let chk;
    try {
      chk = checkEditable(t);
    } catch (e) {
      return ui.toast(e.message, 'error');
    }
    const reason = await ui.prompt({ title: 'Batalkan Transaksi ' + t.id, label: 'Alasan pembatalan', required: true, minLength: 3, multiline: true, okLabel: 'Batalkan Transaksi', danger: true, requiredMsg: 'Alasan pembatalan wajib diisi.' });
    if (!reason) return;
    let auth = null;
    if (chk.locked) {
      auth = await NP.sec.authorize('Transaksi ' + t.id + ' sudah masuk periode gaji terkunci. Pembatalan akan membuat koreksi (pengurang) jasa pada penggajian berikutnya.');
      if (!auth) return;
    }
    try {
      await trx.cancel(t.id, reason, { auth });
      ui.toast('Transaksi ' + t.id + ' dibatalkan.' + (chk.locked ? ' Koreksi jasa dicatat untuk penggajian berikutnya.' : ''));
      onDone && onDone();
    } catch (e) {
      ui.toast(e.message, 'error');
    }
  };

  /* ---------- Bukti transaksi internal ---------- */
  trx.receiptHtml = function (t) {
    const unit = NP.unitInfo(t.items[0] ? t.items[0].unit : 'APT');
    const tot = t.totals;
    return `<div class="receipt">
      <div class="rc-head"><img src="${unit.logo}" alt=""><div><b>${u.esc(unit.name)}</b><small>${u.esc(unit.address)}</small><small>Telp. ${u.esc(unit.phone)}</small></div></div>
      <h3>BUKTI TRANSAKSI INTERNAL</h3>
      <table class="rc-meta"><tr><td>No. Transaksi</td><td>: <b>${u.esc(t.id)}</b></td></tr><tr><td>Tanggal</td><td>: ${u.fmtDate(t.date, 'long')}</td></tr>
      <tr><td>Pasien</td><td>: ${u.esc(t.patient || '-')}${t.patientCode ? ' (' + u.esc(t.patientCode) + ')' : ''}</td></tr>
      <tr><td>Status</td><td>: ${t.status === 'cancelled' ? 'DIBATALKAN — ' + u.esc(t.cancelReason || '') : 'Aktif'}</td></tr></table>
      <table class="rc-items"><thead><tr><th>Tindakan</th><th>Petugas</th><th class="r">Jml</th><th class="r">Harga</th><th class="r">Subtotal</th></tr></thead><tbody>
      ${t.items.map((i) => `<tr><td>${u.esc(trx.itemLabel(i))}<small>${u.esc(i.serviceCode)}</small></td><td>${u.esc(Object.values(i.performerNames || {}).join(', ') || '-')}</td><td class="r">${i.qty}</td><td class="r">${u.rp(i.price)}</td><td class="r">${u.rp(i.gross)}</td></tr>`).join('')}
      </tbody><tfoot><tr><th colspan="4">TOTAL</th><th class="r">${u.rp(tot.gross)}</th></tr></tfoot></table>
      <h4>Rincian pembagian pendapatan (internal)</h4>
      <table class="rc-items"><tbody>
      ${t.items.map((i) => i.shares.map((s) => `<tr><td>${u.esc(trx.itemLabel(i))}</td><td>${u.esc(s.recipientName)}</td><td class="r">${u.rp(s.unitAmount)} × ${i.qty}</td><td class="r">${u.rp(s.amount)}</td></tr>`).join('')).join('')}
      </tbody></table>
      <div class="rc-sum"><span>Bagian Apotek Noura: <b>${u.rp(tot.apotek)}</b></span>${tot.klinik ? `<span>Bagian Praktek Dokter: <b>${u.rp(tot.klinik)}</b></span>` : ''}<span>Jasa tenaga kesehatan/petugas: <b>${u.rp(tot.staff)}</b></span>${tot.eksternal ? `<span>Penerima lain: <b>${u.rp(tot.eksternal)}</b></span>` : ''}</div>
      <div class="rc-foot"><span>Dicatat oleh: ${u.esc(t.createdBy)} · ${u.fmtDateTime(t.createdAt)}</span><span>Dicetak: ${u.fmtDateTime(Date.now())}</span></div>
    </div>`;
  };
  trx.printReceipt = (t) => NP.exp.printHtml(trx.receiptHtml(t), 'Bukti ' + t.id);

  NP.trx = trx;

  /* ===================== Halaman INPUT TINDAKAN ===================== */
  async function renderInput(view, params) {
    const services = (await NP.svc.all());
    const employees = await NP.emp.all();
    const empMap = new Map(employees.map((e) => [e.id, e]));
    const svcMap = new Map(services.map((s) => [s.id, s]));
    let editing = null;
    let editState = null;
    if (params.edit) {
      editing = await trx.get(params.edit);
      if (!editing) {
        view.innerHTML = ui.empty('Transaksi tidak ditemukan.');
        return;
      }
      const usr = NP.sec.user();
      if (!NP.sec.can('trx.editAny') && !(NP.sec.can('trx.editOwn') && editing.createdBy === usr.username)) {
        view.innerHTML = `<div class="card">${ui.empty('Anda hanya dapat mengubah transaksi yang Anda input sendiri.', 'lock')}</div>`;
        return;
      }
      try {
        editState = checkEditable(editing);
      } catch (e) {
        view.innerHTML = `<div class="card">${ui.empty(u.esc(e.message), 'lock')}<div class="center"><a class="btn btn-ghost" href="#/transactions">Kembali ke Riwayat</a></div></div>`;
        return;
      }
    }

    let lastPerf = {};
    try {
      lastPerf = JSON.parse(localStorage.getItem('noura.lastPerformers') || '{}');
    } catch (_) {}

    const rows = editing
      ? editing.items.map((i) => ({ lineId: i.lineId, serviceId: i.serviceId, qty: i.qty, price: i.price, withDoctor: !!i.withDoctor, wdManual: true, performers: Object.assign({}, i.performers) }))
      : [{ lineId: u.uid('ln'), serviceId: '', qty: 1, price: 0, performers: {} }];
    // Pasien yang juga diperiksa dokter (nama & tanggal sama) → tindakan bervarian otomatis "dengan dokter".
    let examIdx = NP.resep ? NP.resep.examIndex({ trxs: (await trx.all()).filter((t) => !editing || t.id !== editing.id) }) : new Map();

    view.innerHTML = `
      <div class="page-head">
        <div><h2>${editing ? 'Edit Transaksi ' + u.esc(editing.id) : 'Input Tindakan'}</h2><p class="muted">${editing ? 'Ubah data transaksi. Seluruh perubahan dicatat dalam audit log.' : 'Pilih tindakan — harga dan pembagian pendapatan terisi otomatis dari Master Tindakan.'}</p></div>
        <div class="actions">${editing ? `<a class="btn btn-ghost" href="#/transactions">Batal</a>` : `<a class="btn btn-ghost" href="#/transactions">${ui.icon('history')}<span>Riwayat</span></a>`}</div>
      </div>
      ${editState && editState.locked ? `<div class="alert alert-warning">${ui.icon('lock')}<div>Transaksi ini sudah masuk <b>periode gaji terkunci</b>. Penyimpanan memerlukan otorisasi administrator beserta catatan perubahan; selisih jasa akan dicatat sebagai koreksi pada penggajian berikutnya.</div></div>` : ''}
      ${editState && editState.draftRuns.length ? `<div class="alert alert-info">${ui.icon('info')}<div>Transaksi ini termasuk dalam draft penggajian ${editState.draftRuns.join(', ')}. Setelah diubah, draft tersebut perlu dihitung ulang.</div></div>` : ''}
      <div class="input-layout">
        <form class="card input-form" novalidate>
          <div class="grid-3 trx-head">
            <label class="field f-date"><span>Tanggal transaksi <b class="req">*</b></span><input type="date" name="date" max="${u.todayISO()}" value="${editing ? editing.date : u.todayISO()}"></label>
            <label class="field f-name"><span>Nama pasien (opsional)</span><input name="patient" value="${u.esc(editing ? editing.patient : '')}" maxlength="80"></label>
            <label class="field f-rm"><span>No. RM / kode pasien (opsional)</span><input name="patientCode" value="${u.esc(editing ? editing.patientCode : '')}" maxlength="30"></label>
          </div>
          <h4 class="sec-title">Daftar tindakan</h4>
          <div id="wd-hint"></div>
          <div id="item-rows"></div>
          <button type="button" class="btn btn-ghost" data-act="add-row">${ui.icon('plus')}<span>Tambah tindakan lain</span></button>
          <label class="field"><span>Catatan</span><input name="note" value="${u.esc(editing ? editing.note : '')}" maxlength="200"></label>
        </form>
        <aside class="card input-summary">
          <h3>Preview Pembagian</h3>
          <div id="sum-box"></div>
          <div class="sum-actions">
            <button class="btn btn-primary btn-block" data-act="save">${ui.icon('check')}<span>${editing ? 'Simpan Perubahan' : 'Simpan Transaksi'}</span></button>
            <button class="btn btn-ghost btn-block" data-act="save-print">${ui.icon('print')}<span>Simpan & Cetak Bukti</span></button>
            ${editing ? '' : `<button class="btn btn-ghost btn-block" data-act="reset">${ui.icon('refresh')}<span>Kosongkan</span></button>`}
          </div>
        </aside>
      </div>
      ${editing ? '' : `<div class="card"><div class="card-head"><h3>Transaksi tanggal <input type="date" id="tl-date" class="tl-date" value="${u.todayISO()}" max="${u.todayISO()}" aria-label="Tanggal daftar transaksi"></h3><a href="#/transactions" class="link">Lihat semua</a></div>
        <p class="muted small">Klik label <b>dengan dokter / tanpa dokter</b> untuk mengubah pembagian tiap tindakan satu per satu. Tindakan pasien yang diperiksa dokter ditandai <b>disarankan</b>.</p>
        <div id="tl-auto"></div><div id="today-list"></div></div>`}`;

    const form = ui.$('.input-form', view);
    const rowsEl = ui.$('#item-rows', view);
    const activeServices = services.filter((s) => s.active || (editing && editing.items.some((i) => i.serviceId === s.id)));
    const byCat = u.groupBy(activeServices, (s) => s.category);
    const svcOptions = (sel) =>
      '<option value="">— pilih tindakan —</option>' +
      C.SERVICE_CATEGORIES.filter((c) => byCat.has(c))
        .map((c) => `<optgroup label="${u.esc(c)}">${byCat.get(c).map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${u.esc(s.name)} — ${u.rp(s.price)}${s.active ? '' : ' (nonaktif)'}</option>`).join('')}</optgroup>`)
        .join('');
    const staffFor = (role) => employees.filter((e) => (e.status === 'aktif' || e.status === 'cuti') && (role === 'petugas' || C.ROLES[role].positions.includes(e.position)));

    function computeRow(r) {
      const s = svcMap.get(r.serviceId);
      if (!s) return null;
      // bagian "per kunjungan" yang sudah dibayar baris sebelumnya pada transaksi ini
      const paid = new Set();
      for (const x of rows) {
        if (x === r) break;
        const sx = svcMap.get(x.serviceId);
        if (!sx) continue;
        (rs.compute(sx, { price: x.price, qty: x.qty, performers: x.performers, employees: empMap, withDoctor: x.withDoctor, paid: [...paid] }).paid || []).forEach((k) => paid.add(k));
      }
      return rs.compute(s, { price: r.price, qty: r.qty, performers: r.performers, employees: empMap, withDoctor: r.withDoctor, paid: [...paid] });
    }
    function fillPerformers(r, s) {
      for (const role of rs.requiredRoles(s, r.withDoctor)) if (!r.performers[role] && !(r.skipPerf && r.skipPerf[role]) && lastPerf[role] && staffFor(role).some((x) => x.id === lastPerf[role])) r.performers[role] = lastPerf[role];
    }

    function examHitsNow() {
      const patient = (form.patient.value || '').trim();
      return patient && NP.resep ? examIdx.get(NP.resep.patientKey(patient) + '|' + form.date.value) || [] : [];
    }
    /** Alasan otomatis "dengan dokter" untuk transaksi ini (null bila tidak ada). */
    function examReason() {
      const hits = examHitsNow();
      if (hits.length) return 'pasien ini diperiksa dokter pada tanggal yang sama (' + hits.map(NP.resep.examLabel).join(', ') + ')';
      const exam = rows.map((r) => svcMap.get(r.serviceId)).find((x) => x && NP.resep && NP.resep.isDoctorExam(x.name, x.category));
      return exam ? 'transaksi ini memuat ' + exam.name : null;
    }
    function applyAuto() {
      const on = !!examReason();
      for (const r of rows) {
        const sv = svcMap.get(r.serviceId);
        if (!sv || !rs.hasDoctorVariant(sv) || r.wdManual || !!r.withDoctor === on) continue;
        r.withDoctor = on;
        // dokter pelaksana = dokter yang memeriksa pasien (bila diketahui)
        const doc = examHitsNow().find((h) => h.doctorId && staffFor('dokter').some((x) => x.id === h.doctorId));
        if (on && doc && !r.performers.dokter && rs.requiredRoles(sv, true).includes('dokter')) r.performers.dokter = doc.doctorId;
        fillPerformers(r, sv);
      }
    }

    function drawRows() {
      applyAuto();
      const reason = examReason();
      const pending = reason && rows.filter((r) => svcMap.get(r.serviceId) && rs.hasDoctorVariant(svcMap.get(r.serviceId)) && !r.withDoctor);
      ui.$('#wd-hint', view).innerHTML = pending && pending.length
        ? `<div class="alert alert-info">${ui.icon('info')}<div>Pembagian <b>dengan dokter</b> disarankan: ${u.esc(reason)}. ${pending.length} tindakan masih <b>tanpa dokter</b>.</div><button type="button" class="btn btn-sm btn-primary" data-act="wd-all">Jadikan dengan dokter</button></div>`
        : '';
      rowsEl.innerHTML = rows
        .map((r, i) => {
          const s = svcMap.get(r.serviceId);
          const roles = s ? rs.requiredRoles(s, r.withDoctor) : [];
          const variant = s && rs.hasDoctorVariant(s);
          const autoNote = variant ? (r.wdManual ? '<small class="muted">diubah manual</small>' : r.withDoctor && reason ? `<small class="wd-auto">Otomatis dengan dokter: ${u.esc(reason)}</small>` : '') : '';
          const res = computeRow(r);
          return `<div class="item-row" data-i="${i}">
            <div class="item-main">
              <label class="field item-svc"><span>Tindakan ${rows.length > 1 ? '#' + (i + 1) : ''}</span><select data-f="serviceId">${svcOptions(r.serviceId)}</select></label>
              <label class="field item-qty"><span>Jumlah</span><div class="stepper"><button type="button" data-step="-1" aria-label="Kurangi">−</button><input type="number" min="1" step="1" data-f="qty" value="${r.qty}" inputmode="numeric"><button type="button" data-step="1" aria-label="Tambah">+</button></div></label>
              <label class="field item-price"><span>Harga jual</span><div class="input-prefix"><span>Rp</span><input data-f="price" data-money inputmode="numeric" value="${ui.moneyVal(r.price)}"></div></label>
              ${rows.length > 1 ? `<button type="button" class="icon-btn danger item-del" data-del="${i}" title="Hapus baris">${ui.icon('trash')}</button>` : ''}
            </div>
            ${variant ? `<div class="item-variant"><span>Pelaksanaan</span><div class="seg" role="group" aria-label="Dengan atau tanpa dokter"><button type="button" class="seg-btn ${r.withDoctor ? '' : 'active'}" data-wd="0" aria-pressed="${!r.withDoctor}">Tanpa dokter</button><button type="button" class="seg-btn ${r.withDoctor ? 'active' : ''}" data-wd="1" aria-pressed="${!!r.withDoctor}">Dengan dokter</button></div>${autoNote}</div>` : ''}
            ${roles.length ? `<div class="item-perf">${roles.map((role) => {
              const opt = rs.optionalRoles(s, r.withDoctor).includes(role);
              return `<label class="field"><span>${C.ROLES[role].label} pelaksana ${opt ? '<small class="muted">(opsional)</small>' : '<b class="req">*</b>'}</span><select data-perf="${role}">${ui.options(staffFor(role).map((e) => [e.id, e.name + (e.status === 'cuti' ? ' (cuti)' : '')]), r.performers[role], opt ? '— tanpa ' + C.ROLES[role].label.toLowerCase() + ' (bagian ke unit) —' : '— pilih ' + C.ROLES[role].label.toLowerCase() + ' —')}</select></label>`;
            }).join('')}</div>` : ''}
            ${res ? `<div class="item-preview">${res.errors.length ? `<span class="text-danger small">${res.errors.map(u.esc).join(' ')}</span>` : res.shares.map((x) => `<span class="share-chip share-${x.category}">${u.esc(x.recipientName)}: <b>${u.rp(x.amount)}</b></span>`).join('')}${res.overrideFor ? ' <small class="muted">(pembagian khusus petugas)</small>' : ''}${res.warnings.length ? `<small class="block text-warning">${res.warnings.map(u.esc).join(' ')}</small>` : ''}</div>` : ''}
          </div>`;
        })
        .join('');
      drawSummary();
    }

    function drawSummary() {
      const results = rows.map(computeRow).filter(Boolean);
      const shares = [].concat(...results.filter((r) => !r.errors.length).map((r) => r.shares));
      const gross = u.sum(results, (r) => r.gross);
      const t = rs.summarize(shares);
      const byRecipient = new Map();
      for (const s of shares) {
        const k = s.recipientName + '|' + s.category;
        byRecipient.set(k, (byRecipient.get(k) || 0) + s.amount);
      }
      const errs = results.some((r) => r.errors.length);
      ui.$('#sum-box', view).innerHTML = `
        <div class="sum-gross"><span>Pendapatan kotor</span><b>${u.rp(gross)}</b><small>${u.num(u.sum(rows, (r) => (r.serviceId ? u.toInt(r.qty) : 0)))} tindakan</small></div>
        <div class="sum-lines">
          ${[...byRecipient.entries()].map(([k, v]) => {
            const [name, cat] = k.split('|');
            return `<div class="sum-line"><span><i class="dot dot-${cat}"></i>${u.esc(cat === 'apotek' || cat === 'klinik' ? 'Bagian ' + name : cat === 'eksternal' ? name : 'Jasa ' + name)}</span><b>${u.rp(v)}</b></div>`;
          }).join('') || '<p class="muted small">Pilih tindakan untuk melihat pembagian.</p>'}
        </div>
        ${shares.length ? `<div class="sum-cats"><div><span>Bagian usaha</span><b>${u.rp(t.business)}</b></div><div><span>Jasa tenaga kesehatan/petugas</span><b>${u.rp(t.staff)}</b></div>${t.eksternal ? `<div><span>Penerima lain</span><b>${u.rp(t.eksternal)}</b></div>` : ''}</div>` : ''}
        ${errs ? `<div class="alert alert-danger small">${ui.icon('warn')}<div>Lengkapi data yang ditandai sebelum menyimpan.</div></div>` : ''}`;
    }

    // nama pasien / tanggal berubah → cek ulang apakah pasien diperiksa dokter
    const recheck = u.debounce(() => drawRows(), 250);
    form.patient.addEventListener('input', recheck);
    form.date.addEventListener('change', recheck);
    rowsEl.addEventListener('change', (e) => {
      const row = e.target.closest('.item-row');
      if (!row) return;
      const r = rows[+row.dataset.i];
      if (e.target.dataset.f === 'serviceId') {
        r.serviceId = e.target.value;
        const s = svcMap.get(r.serviceId);
        r.price = s ? s.price : 0;
        r.performers = {};
        r.withDoctor = false;
        r.wdManual = false;
        if (s) fillPerformers(r, s);
        drawRows();
      } else if (e.target.dataset.perf) {
        r.performers[e.target.dataset.perf] = e.target.value;
        // pilihan "tanpa …" pada pelaksana opsional tidak diisi ulang otomatis
        r.skipPerf = Object.assign({}, r.skipPerf, { [e.target.dataset.perf]: !e.target.value });
        if (e.target.value) lastPerf[e.target.dataset.perf] = e.target.value;
        drawRows();
      } else if (e.target.dataset.f === 'qty') {
        r.qty = Math.max(1, Math.floor(u.toNum(e.target.value)) || 1);
        drawRows();
      }
    });
    rowsEl.addEventListener('input', u.debounce((e) => {
      const row = e.target.closest('.item-row');
      if (!row) return;
      const r = rows[+row.dataset.i];
      if (e.target.dataset.f === 'price') r.price = u.toInt(e.target.value);
      else if (e.target.dataset.f === 'qty') r.qty = Math.max(1, Math.floor(u.toNum(e.target.value)) || 1);
      else return;
      // perbarui preview tanpa merender ulang input yang sedang diketik
      const res = computeRow(r);
      const pv = row.querySelector('.item-preview');
      if (pv && res) pv.innerHTML = res.errors.length ? `<span class="text-danger small">${res.errors.map(u.esc).join(' ')}</span>` : res.shares.map((x) => `<span class="share-chip share-${x.category}">${u.esc(x.recipientName)}: <b>${u.rp(x.amount)}</b></span>`).join('');
      drawSummary();
    }, 150));
    rowsEl.addEventListener('click', (e) => {
      const wdBtn = e.target.closest('[data-wd]');
      if (wdBtn) {
        const r = rows[+wdBtn.closest('.item-row').dataset.i];
        r.withDoctor = wdBtn.dataset.wd === '1';
        r.wdManual = true;
        fillPerformers(r, svcMap.get(r.serviceId));
        drawRows();
        return;
      }
      const st = e.target.closest('[data-step]');
      if (st) {
        const r = rows[+st.closest('.item-row').dataset.i];
        r.qty = Math.max(1, u.toInt(r.qty) + +st.dataset.step);
        drawRows();
      }
      const d = e.target.closest('[data-del]');
      if (d) {
        rows.splice(+d.dataset.del, 1);
        drawRows();
      }
    });

    async function doSave(print) {
      const d = ui.formData(form);
      if (rows.some((r) => !r.serviceId)) return ui.toast('Pilih tindakan pada setiap baris atau hapus baris kosong.', 'error');
      const bad = rows.map(computeRow).find((r) => r && r.errors.length);
      if (bad) return ui.toast(bad.errors.join(' '), 'error');
      const draft = { date: d.date, patient: d.patient, patientCode: d.patientCode, note: d.note, items: rows.map((r) => ({ lineId: r.lineId, serviceId: r.serviceId, qty: u.toInt(r.qty), price: u.toInt(r.price), withDoctor: rs.effectiveWithDoctor(svcMap.get(r.serviceId), r.withDoctor), performers: Object.fromEntries(rs.requiredRoles(svcMap.get(r.serviceId), r.withDoctor).filter((k) => r.performers[k]).map((k) => [k, r.performers[k]])) })) };
      let auth = null;
      if (editState && editState.locked) {
        auth = await NP.sec.authorize('Koreksi transaksi ' + editing.id + ' yang sudah masuk periode gaji terkunci.');
        if (!auth) return;
      }
      try {
        const saved = await trx.save(draft, { editId: editing && editing.id, auth });
        // transaksi yang baru disimpan ikut dihitung untuk aturan "dengan dokter" berikutnya
        if (!editing && NP.resep) examIdx = NP.resep.examIndex({ trxs: await trx.all() });
        try {
          localStorage.setItem('noura.lastPerformers', JSON.stringify(lastPerf));
        } catch (_) {}
        ui.toast((editing ? 'Perubahan transaksi ' : 'Transaksi ') + saved.id + ' tersimpan. Total ' + u.rp(saved.totals.gross) + '.');
        if (print) trx.printReceipt(saved);
        if (editing) NP.go('transactions');
        else {
          rows.splice(0, rows.length, { lineId: u.uid('ln'), serviceId: '', qty: 1, price: 0, performers: {} });
          form.patient.value = '';
          form.patientCode.value = '';
          form.note.value = '';
          drawRows();
          await offerAutoAfterExam(saved);
          drawToday();
        }
      } catch (e) {
        ui.toast(e.message, 'error');
      }
    }

    view.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (!a || !view.contains(a)) return;
      if (a.dataset.act === 'add-row') {
        rows.push({ lineId: u.uid('ln'), serviceId: '', qty: 1, price: 0, performers: {} });
        drawRows();
        const last = rowsEl.lastElementChild;
        last && last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      if (a.dataset.act === 'save') doSave(false);
      if (a.dataset.act === 'save-print') doSave(true);
      if (a.dataset.act === 'wd-all') {
        for (const r of rows) {
          const sv = svcMap.get(r.serviceId);
          if (!sv || !rs.hasDoctorVariant(sv)) continue;
          r.withDoctor = true;
          r.wdManual = true;
          fillPerformers(r, sv);
        }
        drawRows();
      }
      if (a.dataset.act === 'reset') {
        rows.splice(0, rows.length, { lineId: u.uid('ln'), serviceId: '', qty: 1, price: 0, performers: {} });
        drawRows();
      }
      if (a.dataset.act === 'print-trx') trx.get(a.dataset.id).then(trx.printReceipt);
    });

    /** Pilih dokter pelaksana (dipakai bila dokter yang memeriksa tidak diketahui). */
    function pickDoctor(title) {
      const staff = staffFor('dokter');
      if (!staff.length) {
        ui.toast('Belum ada dokter di Data Karyawan.', 'error');
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        ui.modal({
          title: title || 'Pilih dokter pelaksana',
          size: 'sm',
          body: `<label class="field"><span>Dokter pelaksana <b class="req">*</b></span><select name="doc">${ui.options(staff.map((e) => [e.id, e.name]), lastPerf.dokter)}</select></label>`,
          actions: [
            { label: 'Batal', cls: 'btn-ghost', onClick: (m) => { m.close(true); resolve(null); } },
            { label: 'Pilih', cls: 'btn-primary', onClick: (m) => { const v = m.el.querySelector('[name=doc]').value; m.close(true); resolve(v || null); } }
          ],
          onClose: () => resolve(null)
        });
      });
    }
    /** Terapkan perubahan varian; tanyakan dokter bila perlu. */
    async function applyVariant(tid, changes, doctorId) {
      try {
        return await trx.setVariant(tid, changes, { doctorId });
      } catch (e) {
        if (e.code !== 'NEED_ROLE' || e.role !== 'dokter') throw e;
        const d = await pickDoctor('Dokter pelaksana untuk ' + tid);
        if (!d) return null;
        lastPerf.dokter = d;
        return trx.setVariant(tid, changes, { doctorId: d });
      }
    }
    async function refreshExam() {
      if (NP.resep) examIdx = NP.resep.examIndex({ trxs: await trx.all() });
    }

    async function drawToday() {
      const el = ui.$('#today-list', view);
      if (!el) return;
      const dateEl = ui.$('#tl-date', view);
      const day = (dateEl && dateEl.value) || u.todayISO();
      const services = new Map((await NP.svc.all()).map((x) => [x.id, x]));
      const all = await trx.all();
      const allIdx = NP.resep ? NP.resep.examIndex({ trxs: all }) : new Map();
      const list = all.filter((t) => t.date === day);
      const sugg = new Map(list.map((t) => [t.id, trx.doctorSuggestions(t, allIdx, services)]));
      const editableSugg = list.filter((t) => sugg.get(t.id).length && trx.canQuickEdit(t).ok);
      const nSugg = u.sum(editableSugg, (t) => sugg.get(t.id).length);
      ui.$('#tl-auto', view).innerHTML = nSugg
        ? `<div class="alert alert-info">${ui.icon('info')}<div><b>${u.num(nSugg)} tindakan</b> pada ${u.num(editableSugg.length)} transaksi disarankan <b>dengan dokter</b> karena pasiennya diperiksa dokter.</div><button type="button" class="btn btn-sm btn-primary" data-act="tl-auto">Terapkan otomatis (${u.num(nSugg)})</button></div>`
        : '';
      const itemHtml = (t, i) => {
        const sv = services.get(i.serviceId);
        const base = u.esc(i.serviceName) + ' ×' + i.qty;
        if (!sv || !rs.hasDoctorVariant(sv)) return base;
        const q = trx.canQuickEdit(t);
        const sg = sugg.get(t.id).find((x) => x.lineId === i.lineId);
        return `${base} <button type="button" class="wd-toggle ${i.withDoctor ? 'on' : ''}" data-tl="${u.esc(t.id)}" data-line="${u.esc(i.lineId)}" data-wdv="${i.withDoctor ? 1 : 0}" ${q.ok ? '' : 'disabled'} title="${u.esc(q.ok ? 'Klik untuk mengganti' : q.reason)}">${i.withDoctor ? 'dengan dokter' : 'tanpa dokter'}</button>${sg ? ` <span class="flag flag-low" title="${u.esc(sg.reason)}">disarankan dengan dokter</span>` : ''}`;
      };
      ui.table(el, {
        columns: [
          { key: 'id', label: 'No. Transaksi', render: (t) => `${u.esc(t.id)}${t.patient ? `<small class="block muted">${u.esc(t.patient)}</small>` : ''}` },
          { key: 'items', label: 'Tindakan', render: (t) => t.items.map((i) => itemHtml(t, i)).join('<br>'), sortable: false },
          { key: 'perf', label: 'Petugas', render: (t) => u.esc([...new Set([].concat(...t.items.map((i) => Object.values(i.performerNames || {}))))].join(', ') || '-'), sortable: false },
          { key: 'gross', label: 'Total', align: 'right', render: (t) => u.rp(t.totals.gross), value: (t) => t.totals.gross },
          { key: 'status', label: 'Status', render: (t) => ui.statusBadge(t.status) },
          { key: 'a', label: '', sortable: false, render: (t) => `<button class="icon-btn" data-act="print-trx" data-id="${t.id}" title="Cetak bukti">${ui.icon('print')}</button>` }
        ],
        rows: list,
        pageSize: 10,
        cards: true,
        rowClass: (t) => (sugg.get(t.id).length ? 'tl-sugg' : ''),
        empty: day === u.todayISO() ? 'Belum ada transaksi hari ini.' : 'Tidak ada transaksi pada tanggal ini.'
      });
    }
    // klik label dengan/tanpa dokter di daftar (satu per satu)
    view.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-tl]');
      if (b && view.contains(b) && !b.disabled) {
        const on = b.dataset.wdv !== '1';
        b.disabled = true;
        try {
          const t = await trx.get(b.dataset.tl);
          const sg = on && NP.resep ? trx.doctorSuggestions(t, NP.resep.examIndex({ trxs: await trx.all() }), new Map((await NP.svc.all()).map((x) => [x.id, x]))).find((x) => x.lineId === b.dataset.line) : null;
          const saved = await applyVariant(t.id, { [b.dataset.line]: on }, (sg && sg.doctorId) || '');
          if (saved) ui.toast(t.id + ': ' + (t.items.find((i) => i.lineId === b.dataset.line) || {}).serviceName + ' → ' + (on ? 'dengan dokter' : 'tanpa dokter') + '.');
        } catch (err) {
          ui.toast(err.message, 'error');
        }
        await refreshExam();
        drawToday();
        return;
      }
      if (e.target.closest('[data-act="tl-auto"]')) {
        const res = await ui.busy('Menerapkan pembagian dengan dokter…', () => autoApply((ui.$('#tl-date', view) || {}).value || u.todayISO()));
        ui.toast(u.num(res.done) + ' transaksi diubah menjadi dengan dokter' + (res.skipped.length ? '; ' + res.skipped.length + ' dilewati: ' + res.skipped.join('; ') : '') + '.', res.skipped.length ? 'warning' : undefined);
        await refreshExam();
        drawToday();
      }
    });
    /** Setelah menyimpan pemeriksaan dokter: tawarkan ubah tindakan pasien yang sama pada tanggal itu. */
    async function offerAutoAfterExam(saved) {
      if (!NP.resep || !saved.patient || !saved.items.some((i) => NP.resep.isDoctorExam(i.serviceName, i.category))) return;
      const key = NP.resep.patientKey(saved.patient);
      const services = new Map((await NP.svc.all()).map((x) => [x.id, x]));
      const all = await trx.all();
      const idx = NP.resep.examIndex({ trxs: all });
      const cand = all.filter((t) => t.id !== saved.id && t.date === saved.date && NP.resep.patientKey(t.patient) === key && trx.canQuickEdit(t).ok && trx.doctorSuggestions(t, idx, services).length);
      if (!cand.length) return;
      const ok = await ui.confirm({
        title: 'Pasien diperiksa dokter',
        html: `<b>${u.esc(saved.patient)}</b> juga memiliki ${u.num(cand.length)} transaksi tindakan pada tanggal ini yang tercatat <b>tanpa dokter</b> (${cand.map((t) => u.esc(t.id)).join(', ')}). Ubah menjadi <b>dengan dokter</b>?`,
        okLabel: 'Ya, ubah'
      });
      if (!ok) return;
      const res = await autoApply(saved.date, key);
      ui.toast(u.num(res.done) + ' transaksi diubah menjadi dengan dokter' + (res.skipped.length ? '; ' + res.skipped.length + ' dilewati' : '') + '.');
      await refreshExam();
    }
    /** Terapkan aturan "dengan dokter" ke transaksi pada tanggal tertentu (opsional: hanya satu pasien). */
    async function autoApply(day, patientKey) {
      const services = new Map((await NP.svc.all()).map((x) => [x.id, x]));
      const all = await trx.all();
      const idx = NP.resep.examIndex({ trxs: all });
      const res = { done: 0, skipped: [] };
      for (const t of all.filter((x) => x.date === day && (!patientKey || NP.resep.patientKey(x.patient) === patientKey))) {
        const sg = trx.doctorSuggestions(t, idx, services);
        if (!sg.length || !trx.canQuickEdit(t).ok) continue;
        try {
          const saved = await applyVariant(t.id, Object.fromEntries(sg.map((x) => [x.lineId, true])), sg[0].doctorId || lastPerf.dokter || '');
          if (saved) res.done++;
          else res.skipped.push(t.id + ' (dokter tidak dipilih)');
        } catch (err) {
          res.skipped.push(t.id + ' (' + err.message + ')');
        }
      }
      return res;
    }
    const tlDate = ui.$('#tl-date', view);
    if (tlDate) tlDate.onchange = () => drawToday();
    // tanggal transaksi di form berubah → daftar ikut tanggal tersebut
    form.date.addEventListener('change', () => {
      if (tlDate && form.date.value) {
        tlDate.value = form.date.value;
        drawToday();
      }
    });
    drawRows();
    drawToday();
  }

  /* ===================== Halaman RIWAYAT TRANSAKSI ===================== */
  const hs = { q: '', preset: 'month', start: '', end: '', emp: '', svc: '', unit: '', status: '', pay: '' };
  async function renderHistory(view) {
    if (!hs.start) Object.assign(hs, u.presetRange('month'));
    const employees = await NP.emp.all();
    const services = await NP.svc.all();
    view.innerHTML = `
      <div class="page-head">
        <div><h2>Riwayat Transaksi</h2><p class="muted">Seluruh transaksi tindakan beserta status transaksi dan status penggajian.</p></div>
        <div class="actions">
          <button class="btn btn-ghost" data-act="xls">${ui.icon('excel')}<span>Ekspor Excel</span></button>
          <button class="btn btn-ghost" data-act="pdf">${ui.icon('pdf')}<span>Cetak PDF</span></button>
          ${NP.sec.can('trx.create') ? `<a class="btn btn-primary" href="#/input">${ui.icon('plus')}<span>Input Tindakan</span></a>` : ''}
        </div>
      </div>
      <div class="card">
        <div class="filters">
          <label class="search">${ui.icon('search')}<input type="search" id="h-q" placeholder="No. transaksi, pasien, tindakan..." value="${u.esc(hs.q)}"></label>
          <select id="h-preset">${ui.options([['today', 'Hari ini'], ['week', 'Minggu ini'], ['month', 'Bulan ini'], ['lastmonth', 'Bulan lalu'], ['year', 'Tahun ini'], ['all', 'Semua'], ['custom', 'Rentang tanggal']], hs.preset)}</select>
          <input type="date" id="h-start" value="${hs.start}" ${hs.preset === 'custom' ? '' : 'hidden'}><input type="date" id="h-end" value="${hs.end}" ${hs.preset === 'custom' ? '' : 'hidden'}>
          <select id="h-emp"><option value="">Semua petugas</option>${ui.options(employees.filter((e) => NP.emp.isHealth(e) || e.position !== '').map((e) => [e.id, e.name]), hs.emp)}</select>
          <select id="h-svc"><option value="">Semua tindakan</option>${ui.options(services.map((s) => [s.id, s.name]), hs.svc)}</select>
          <select id="h-unit"><option value="">Semua unit</option>${ui.options([['APT', 'Apotek Noura'], ['KLINIK', 'Praktek Dokter Umum']], hs.unit)}</select>
          <select id="h-status">${ui.options([['', 'Semua status'], ['active', 'Aktif'], ['cancelled', 'Dibatalkan']], hs.status)}</select>
          <select id="h-pay">${ui.options([['', 'Semua status gaji'], ['open', 'Belum diproses'], ['inrun', 'Dalam proses gaji'], ['paid', 'Terkunci'], ['partial', 'Sebagian'], ['none', 'Tanpa jasa']], hs.pay)}</select>
        </div>
        <div class="stats-row compact" id="h-stats"></div>
        <div id="h-bulk"></div>
        <div id="h-list"></div>
      </div>`;
    let all = await trx.all();
    let table;
    const canEditAny = NP.sec.can('trx.editAny');
    const canDelete = NP.sec.can('trx.delete');
    const usr = NP.sec.user();
    const sel = new Set(); // transaksi yang dicentang

    function rowsOf() {
      const q = hs.q.toLowerCase();
      const out = [];
      for (const t of all) {
        if (!u.inRange(t.date, hs.start, hs.end)) continue;
        if (hs.status && t.status !== hs.status) continue;
        const ps = trx.payrollStatus(t);
        if (hs.pay && ps !== hs.pay) continue;
        t.items.forEach((it, idx) => {
          if (hs.svc && it.serviceId !== hs.svc) return;
          if (hs.unit && it.unit !== hs.unit) return;
          if (hs.emp && !Object.values(it.performers || {}).includes(hs.emp) && !it.shares.some((s) => s.recipientId === hs.emp)) return;
          if (q && !(t.id + ' ' + t.patient + ' ' + t.patientCode + ' ' + it.serviceName + ' ' + Object.values(it.performerNames || {}).join(' ')).toLowerCase().includes(q)) return;
          const sm = rs.summarize(it.shares);
          out.push({ t, it, idx, ps, sm, key: t.id + '#' + idx });
        });
      }
      return out;
    }
    function stats(rows) {
      const act = rows.filter((r) => r.t.status === 'active');
      ui.$('#h-stats', view).innerHTML = [
        ui.stat('Transaksi', u.num(new Set(act.map((r) => r.t.id)).size), { sub: u.num(u.sum(act, (r) => r.it.qty)) + ' tindakan' }),
        ui.stat('Pendapatan kotor', u.rp(u.sum(act, (r) => r.it.gross))),
        ui.stat('Bagian Apotek Noura', u.rp(u.sum(act, (r) => r.sm.apotek))),
        ui.stat('Bagian tenaga kesehatan', u.rp(u.sum(act, (r) => r.sm.staff))),
        ui.stat('Dibatalkan', u.num(new Set(rows.filter((r) => r.t.status === 'cancelled').map((r) => r.t.id)).size))
      ].join('');
    }
    const cols = [
      ...(canDelete
        ? [{ key: 'sel', label: '<input type="checkbox" id="h-selall" aria-label="Pilih semua transaksi pada filter">', sortable: false, render: (r) => `<input type="checkbox" data-sel="${u.esc(r.t.id)}" ${sel.has(r.t.id) ? 'checked' : ''} aria-label="Pilih ${u.esc(r.t.id)}">` }]
        : []),
      { key: 'id', label: 'No. Transaksi', render: (r) => `<b>${u.esc(r.t.id)}</b>${r.t.items.length > 1 ? `<small class="block muted">item ${r.idx + 1}/${r.t.items.length}</small>` : ''}`, value: (r) => r.key },
      { key: 'date', label: 'Tanggal', render: (r) => u.fmtDate(r.t.date), value: (r) => r.t.date },
      { key: 'svc', label: 'Tindakan', render: (r) => `${u.esc(trx.itemLabel(r.it))}<small class="block muted">${u.esc(r.it.serviceCode)}</small>`, value: (r) => r.it.serviceName },
      { key: 'patient', label: 'Pasien', render: (r) => u.esc(r.t.patient || r.t.patientCode || '-'), value: (r) => r.t.patient },
      { key: 'perf', label: 'Petugas', render: (r) => u.esc(Object.values(r.it.performerNames || {}).join(', ') || '-'), value: (r) => Object.values(r.it.performerNames || {}).join() },
      { key: 'qty', label: 'Jml', align: 'right', render: (r) => r.it.qty, value: (r) => r.it.qty },
      { key: 'price', label: 'Harga', align: 'right', render: (r) => u.rp(r.it.price), value: (r) => r.it.price },
      { key: 'gross', label: 'Total', align: 'right', render: (r) => `<b>${u.rp(r.it.gross)}</b>`, value: (r) => r.it.gross },
      { key: 'apt', label: 'Bag. Apotek', align: 'right', render: (r) => u.rp(r.sm.apotek + r.sm.klinik), value: (r) => r.sm.business },
      { key: 'staff', label: 'Bag. Nakes', align: 'right', render: (r) => u.rp(r.sm.staff + r.sm.eksternal), value: (r) => r.sm.staff },
      { key: 'status', label: 'Status', render: (r) => ui.statusBadge(r.t.status) + (r.t.corrections && r.t.corrections.length ? ' ' + ui.badge('Dikoreksi', 'amber') : ''), value: (r) => r.t.status },
      { key: 'pay', label: 'Status Gaji', render: (r) => (r.t.status === 'cancelled' ? (trx.pendingAdjustments(r.t).length ? ui.badge('Koreksi tertunda', 'amber') : '—') : ui.statusBadge(r.ps) + (trx.pendingAdjustments(r.t).length ? ' ' + ui.badge('Koreksi tertunda', 'amber') : '')), value: (r) => r.ps },
      {
        key: 'a', label: '', sortable: false, align: 'right',
        render: (r) => {
          const own = r.t.createdBy === usr.username;
          const canEdit = r.t.status === 'active' && (canEditAny || (NP.sec.can('trx.editOwn') && own && r.ps !== 'paid'));
          return `<div class="row-actions"><button class="icon-btn" data-act="detail" data-id="${r.t.id}" title="Detail & audit">${ui.icon('eye')}</button>
            <button class="icon-btn" data-act="print" data-id="${r.t.id}" title="Cetak bukti">${ui.icon('print')}</button>
            ${canEdit ? `<button class="icon-btn" data-act="edit" data-id="${r.t.id}" title="Edit">${ui.icon('edit')}</button>` : ''}
            ${r.t.status === 'active' && NP.sec.can('trx.cancel') ? `<button class="icon-btn danger" data-act="cancel" data-id="${r.t.id}" title="Batalkan">${ui.icon('x')}</button>` : ''}</div>`;
        }
      }
    ];
    function drawBulk(rows) {
      const el = ui.$('#h-bulk', view);
      if (!canDelete) return;
      const ids = [...new Set(rows.map((r) => r.t.id))];
      for (const id of [...sel]) if (!all.some((t) => t.id === id)) sel.delete(id);
      const periodLbl = hs.preset === 'custom' ? u.fmtDate(hs.start) + ' – ' + u.fmtDate(hs.end) : (ui.$('#h-preset', view).selectedOptions[0] || {}).textContent || '';
      el.innerHTML = ids.length || sel.size
        ? `<div class="h-bulk">
            <span>${sel.size ? `<b>${u.num(sel.size)}</b> transaksi dicentang` : 'Centang transaksi untuk menghapus beberapa sekaligus.'}</span>
            ${sel.size ? `<button type="button" class="btn btn-sm btn-ghost" data-act="sel-clear">Batal pilih</button><button type="button" class="btn btn-sm btn-danger" data-act="del-sel">${ui.icon('trash')}<span>Hapus terpilih (${u.num(sel.size)})</span></button>` : ''}
            ${ids.length ? `<button type="button" class="btn btn-sm btn-ghost danger" data-act="del-all" data-n="${ids.length}">${ui.icon('trash')}<span>Hapus semua pada filter ini (${u.num(ids.length)} transaksi${periodLbl ? ' · ' + u.esc(periodLbl) : ''})</span></button>` : ''}
          </div>`
        : '';
      const sa = ui.$('#h-selall', view);
      if (sa) {
        sa.checked = ids.length > 0 && ids.every((id) => sel.has(id));
        sa.indeterminate = !sa.checked && ids.some((id) => sel.has(id));
      }
    }
    /** Hapus permanen dengan konfirmasi + alasan. */
    async function deleteFlow(ids, title) {
      const list = all.filter((t) => ids.includes(t.id));
      const ok = list.filter((t) => trx.deletable(t));
      const blocked = list.length - ok.length;
      const reason = await new Promise((resolve) => {
        ui.modal({
          title,
          size: 'md',
          body: `<div class="confirm-msg danger">${ui.icon('warn')}<div>
              <b>${u.num(ok.length)} transaksi</b> (${u.rp(u.sum(ok, (t) => t.totals.gross))}) akan <b>dihapus permanen</b> beserta pembagian pendapatannya. Salinannya tetap tersimpan di audit log.
              ${blocked ? `<br><b>${u.num(blocked)} transaksi</b> dilewati karena sudah masuk penggajian atau memiliki koreksi — gunakan <b>Batalkan</b> untuk transaksi tersebut.` : ''}
              <br><small>Nomor struk POS/resep yang dihapus dapat diimpor ulang.</small></div></div>
            <label class="field"><span>Alasan penghapusan <b class="req">*</b></span><input name="reason" maxlength="200" placeholder="mis. salah impor, data dobel"></label>
            <label class="check"><input type="checkbox" name="sure"><span>Saya mengerti transaksi dihapus permanen</span></label>
            <div class="form-error" hidden></div>`,
          actions: [
            { label: 'Batal', cls: 'btn-ghost', onClick: (m) => { m.close(true); resolve(null); } },
            {
              label: 'Hapus ' + u.num(ok.length) + ' transaksi', cls: 'btn-danger', onClick: (m) => {
                const r = m.el.querySelector('[name=reason]').value.trim();
                const fe = m.el.querySelector('.form-error');
                if (!ok.length) return (fe.hidden = false), (fe.textContent = 'Tidak ada transaksi yang dapat dihapus.');
                if (r.length < 3) return (fe.hidden = false), (fe.textContent = 'Alasan penghapusan wajib diisi (min. 3 karakter).');
                if (!m.el.querySelector('[name=sure]').checked) return (fe.hidden = false), (fe.textContent = 'Centang konfirmasi terlebih dahulu.');
                m.close(true);
                resolve(r);
              }
            }
          ],
          onClose: () => resolve(null)
        });
      });
      if (!reason) return;
      try {
        const res = await ui.busy('Menghapus ' + ok.length + ' transaksi…', () => trx.removeMany(ok.map((t) => t.id), reason));
        ui.toast(u.num(res.deleted.length) + ' transaksi dihapus (' + u.rp(res.gross) + ')' + (res.skipped.length + blocked ? '; ' + u.num(res.skipped.length + blocked) + ' dilewati' : '') + '.', res.skipped.length ? 'warning' : undefined);
        res.deleted.forEach((id) => sel.delete(id));
      } catch (e) {
        ui.toast(e.message, 'error');
      }
      await reload();
    }
    view.addEventListener('change', (e) => {
      const c = e.target;
      if (c.dataset && c.dataset.sel !== undefined) {
        if (c.checked) sel.add(c.dataset.sel);
        else sel.delete(c.dataset.sel);
        view.querySelectorAll(`[data-sel="${CSS.escape(c.dataset.sel)}"]`).forEach((x) => (x.checked = c.checked));
        drawBulk(rowsOf());
      } else if (c.id === 'h-selall') {
        for (const id of new Set(rowsOf().map((r) => r.t.id))) c.checked ? sel.add(id) : sel.delete(id);
        view.querySelectorAll('[data-sel]').forEach((x) => (x.checked = sel.has(x.dataset.sel)));
        drawBulk(rowsOf());
      }
    });

    function draw() {
      const rows = rowsOf();
      stats(rows);
      if (table) table.update(rows);
      else
        table = ui.table(ui.$('#h-list', view), {
          columns: cols, rows, sortKey: 'date', sortDir: 'desc', cls: 'tbl-dense', rowClass: (r) => (r.t.status === 'cancelled' ? 'row-cancelled' : ''),
          footer: (rs_) => {
            const act = rs_.filter((r) => r.t.status === 'active');
            return `<tr><th colspan="${canDelete ? 6 : 5}">Total (transaksi aktif)</th><th class="ta-right">${u.num(u.sum(act, (r) => r.it.qty))}</th><th></th><th class="ta-right">${u.rp(u.sum(act, (r) => r.it.gross))}</th><th class="ta-right">${u.rp(u.sum(act, (r) => r.sm.business))}</th><th class="ta-right">${u.rp(u.sum(act, (r) => r.sm.staff + r.sm.eksternal))}</th><th colspan="3"></th></tr>`;
          }
        });
    }
    // centang tetap terlihat setelah tabel dirender ulang (urut/halaman)
    ui.$('#h-list', view).addEventListener('click', (e) => {
      if (e.target.closest('[data-sort],[data-pg]')) setTimeout(() => drawBulk(rowsOf()), 0);
    });
    const _draw = draw;
    draw = function () {
      _draw();
      drawBulk(rowsOf());
    };
    draw();
    const reload = async () => {
      all = await trx.all();
      draw();
    };
    const bind = (id, key, fn) => (ui.$(id, view).onchange = (e) => {
      hs[key] = e.target.value;
      fn && fn();
      draw();
    });
    ui.$('#h-q', view).oninput = u.debounce((e) => {
      hs.q = e.target.value;
      draw();
    }, 200);
    bind('#h-preset', 'preset', () => {
      const custom = hs.preset === 'custom';
      ui.$('#h-start', view).hidden = ui.$('#h-end', view).hidden = !custom;
      if (!custom) Object.assign(hs, u.presetRange(hs.preset));
      ui.$('#h-start', view).value = hs.start;
      ui.$('#h-end', view).value = hs.end;
    });
    bind('#h-start', 'start');
    bind('#h-end', 'end');
    bind('#h-emp', 'emp');
    bind('#h-svc', 'svc');
    bind('#h-unit', 'unit');
    bind('#h-status', 'status');
    bind('#h-pay', 'pay');

    view.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-act]');
      if (!a || !view.contains(a)) return;
      const t = all.find((x) => x.id === a.dataset.id);
      switch (a.dataset.act) {
        case 'sel-clear':
          sel.clear();
          draw();
          break;
        case 'del-sel':
          deleteFlow([...sel], 'Hapus ' + sel.size + ' transaksi terpilih');
          break;
        case 'del-all':
          deleteFlow([...new Set(rowsOf().map((r) => r.t.id))], 'Hapus semua transaksi pada filter ini');
          break;
        case 'detail':
          openDetail(t, reload);
          break;
        case 'print':
          trx.printReceipt(t);
          break;
        case 'edit':
          NP.go('input', { edit: t.id });
          break;
        case 'cancel':
          trx.cancelFlow(t, reload);
          break;
        case 'xls': {
          const rows = table.rows();
          NP.exp.excel([{
            name: 'Riwayat Transaksi',
            rows: rows.map((r) => ({
              'No. Transaksi': r.t.id, Tanggal: r.t.date, Tindakan: trx.itemLabel(r.it), Kategori: r.it.category, Unit: C.UNITS[r.it.unit].name,
              Pasien: r.t.patient, 'Kode Pasien': r.t.patientCode, Petugas: Object.values(r.it.performerNames || {}).join(', '), Jumlah: r.it.qty,
              'Harga Jual': r.it.price, 'Total Pendapatan': r.it.gross, 'Bagian Apotek Noura': r.sm.apotek, 'Bagian Praktek Dokter': r.sm.klinik,
              'Jasa Dokter': r.sm.dokter, 'Jasa Bidan': r.sm.bidan, 'Jasa Perawat': r.sm.perawat, 'Jasa Lainnya': r.sm.farmasi + r.sm.petugas, 'Penerima Lain': r.sm.eksternal,
              'Status Transaksi': r.t.status === 'active' ? 'Aktif' : 'Dibatalkan', 'Status Penggajian': { none: 'Tanpa jasa', open: 'Belum diproses', inrun: 'Dalam proses', paid: 'Terkunci', partial: 'Sebagian' }[r.ps]
            }))
          }], 'riwayat-transaksi-' + hs.start + '_' + hs.end + '.xlsx');
          break;
        }
        case 'pdf': {
          const rows = table.rows();
          const act = rows.filter((r) => r.t.status === 'active');
          NP.exp.pdfTable({
            title: 'Laporan Riwayat Transaksi Tindakan',
            subtitle: 'Periode ' + u.fmtDate(hs.start, 'long') + ' s.d. ' + u.fmtDate(hs.end, 'long'),
            unit: 'APT',
            orientation: 'landscape',
            head: ['No. Transaksi', 'Tanggal', 'Tindakan', 'Pasien', 'Petugas', 'Jml', 'Harga', 'Total', 'Bag. Apotek', 'Bag. Nakes', 'Status', 'Status Gaji'],
            body: rows.map((r) => [r.t.id, u.fmtDate(r.t.date, 'short'), trx.itemLabel(r.it), r.t.patient || '-', Object.values(r.it.performerNames || {}).join(', '), r.it.qty, u.rp(r.it.price), u.rp(r.it.gross), u.rp(r.sm.business), u.rp(r.sm.staff + r.sm.eksternal), r.t.status === 'active' ? 'Aktif' : 'Batal', { none: '-', open: 'Belum', inrun: 'Proses', paid: 'Terkunci', partial: 'Sebagian' }[r.ps]]),
            foot: [['TOTAL (aktif)', '', '', '', '', u.num(u.sum(act, (r) => r.it.qty)), '', u.rp(u.sum(act, (r) => r.it.gross)), u.rp(u.sum(act, (r) => r.sm.business)), u.rp(u.sum(act, (r) => r.sm.staff + r.sm.eksternal)), '', '']],
            numericCols: [5, 6, 7, 8, 9],
            filename: 'riwayat-transaksi-' + hs.start + '_' + hs.end + '.pdf'
          });
          break;
        }
      }
    });
  }

  async function openDetail(t, onChange) {
    const logs = (await NP.db.all('auditLog')).filter((l) => l.entityId === t.id).sort((a, b) => b.ts - a.ts);
    const runs = new Map((await NP.db.all('payrollRuns')).map((r) => [r.id, r]));
    const payLabel = (p) => (!p || !p.state ? ui.badge('Belum diproses', 'gray') : ui.badge({ draft: 'Draft', approved: 'Disetujui', locked: 'Terkunci' }[p.state] + ' · ' + p.runId + (runs.get(p.runId) ? ' (' + u.periodLabel(runs.get(p.runId).period) + ')' : ''), p.state === 'locked' ? 'dark' : p.state === 'approved' ? 'blue' : 'amber'));
    ui.modal({
      title: 'Detail Transaksi ' + t.id,
      size: 'lg',
      body: `<div class="grid-3">
          <div class="kv"><span>Tanggal</span><b>${u.fmtDate(t.date, 'long')}</b></div>
          <div class="kv"><span>Pasien</span><b>${u.esc(t.patient || '-')} ${t.patientCode ? '(' + u.esc(t.patientCode) + ')' : ''}</b></div>
          <div class="kv"><span>Status</span><b>${ui.statusBadge(t.status)} ${ui.statusBadge(trx.payrollStatus(t))}</b></div>
        </div>
        ${t.status === 'cancelled' ? `<div class="alert alert-danger">${ui.icon('x')}<div>Dibatalkan oleh ${u.esc(t.cancelledBy)} pada ${u.fmtDateTime(t.cancelledAt)}: ${u.esc(t.cancelReason)}</div></div>` : ''}
        ${t.items.map((it) => `<div class="panel"><div class="panel-head"><b>${u.esc(trx.itemLabel(it))}</b> <small class="muted">${u.esc(it.serviceCode)} · ${u.esc(it.category)}</small><span class="right">${it.qty} × ${u.rp(it.price)} = <b>${u.rp(it.gross)}</b></span></div>
          <div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Penerima</th><th>Kategori</th><th class="ta-right">Per tindakan</th><th class="ta-right">Jumlah</th><th>Status penggajian</th></tr></thead><tbody>
          ${it.shares.map((s) => `<tr><td>${u.esc(s.recipientName)}${s.implicit ? ' <small class="muted">(sisa)</small>' : ''}</td><td>${u.esc(C.SHARE_CATS[s.category] || '')}</td><td class="ta-right">${u.rp(s.unitAmount)}</td><td class="ta-right">${u.rp(s.amount)}</td><td>${s.recipientId && (s.type === 'role' || s.type === 'employee') ? payLabel(s.payroll) : '<small class="muted">Bagian usaha/eksternal</small>'}</td></tr>`).join('')}
          </tbody></table></div></div>`).join('')}
        ${(t.adjustments || []).length ? `<h4 class="sec-title">Koreksi jasa (adjustment)</h4><div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Tanggal</th><th>Karyawan</th><th>Jenis</th><th class="ta-right">Selisih</th><th>Catatan</th><th>Status</th></tr></thead><tbody>
          ${t.adjustments.map((a) => `<tr><td>${u.fmtDate(a.date)}</td><td>${u.esc(a.employeeId)}</td><td>${u.esc(a.kind)}</td><td class="ta-right">${u.rp(a.amount)}</td><td>${u.esc(a.note)} <small class="muted">(${u.esc(a.by)})</small></td><td>${payLabel(a.payroll)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <h4 class="sec-title">Audit log</h4>
        <div class="audit-list">${logs.map((l) => `<div class="audit-item"><small>${u.fmtDateTime(l.ts)} · ${u.esc(l.userName || l.user)}</small><div><b>${u.esc(l.action)}</b> — ${u.esc(l.detail)}</div></div>`).join('') || '<p class="muted">Belum ada catatan.</p>'}</div>`,
      actions: [
        { label: 'Tutup', cls: 'btn-ghost', onClick: (m) => m.close() },
        { label: 'Cetak Bukti', cls: 'btn-ghost', icon: 'print', onClick: () => trx.printReceipt(t) }
      ]
    });
  }
  trx.openDetail = openDetail;

  NP.pages.input = { title: 'Input Tindakan', render: renderInput };
  NP.pages.transactions = { title: 'Riwayat Transaksi', render: renderHistory };
})(typeof globalThis !== 'undefined' ? globalThis : window);
