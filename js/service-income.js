/* Noura Payroll — integrasi transaksi ke penggajian: rekap jasa karyawan, rekonsiliasi, catatan shift & sesi. */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;
  const C = NP.C;

  const inc = {};

  /** Baris jasa per karyawan dari transaksi.
   * opt: { start, end, runId, includeEarlier, onlyEligible } */
  inc.lines = function (trxs, opt) {
    opt = opt || {};
    const out = new Map();
    for (const t of trxs) {
      if (t.status !== 'active') continue;
      const inPeriod = u.inRange(t.date, opt.start, opt.end);
      const earlier = opt.includeEarlier && t.date < opt.start;
      if (!inPeriod && !earlier) continue;
      t.items.forEach((it) => {
        it.shares.forEach((s, si) => {
          if (!(s.type === 'role' || s.type === 'employee') || !s.recipientId) return;
          const p = s.payroll || {};
          if (opt.onlyEligible && p.runId && p.runId !== opt.runId) return;
          if (!out.has(s.recipientId)) out.set(s.recipientId, []);
          out.get(s.recipientId).push({
            trxId: t.id, lineId: it.lineId, si, date: t.date, serviceId: it.serviceId, serviceName: it.serviceName, unit: it.unit,
            qty: it.qty, unitAmount: s.unitAmount, amount: s.amount, category: s.category, state: p.state || null, runId: p.runId || null, earlier: !inPeriod, allocId: s.allocId
          });
        });
      });
    }
    return out;
  };

  /** Koreksi (adjustment) yang belum dibayar per karyawan. */
  inc.adjustments = function (trxs, opt) {
    opt = opt || {};
    const out = new Map();
    for (const t of trxs) {
      for (const a of t.adjustments || []) {
        const p = a.payroll || {};
        if (p.runId && p.runId !== opt.runId) continue;
        if (opt.end && a.date > opt.end) continue;
        if (!out.has(a.employeeId)) out.set(a.employeeId, []);
        out.get(a.employeeId).push({ trxId: t.id, adjId: a.id, amount: a.amount, unit: a.unit, date: a.date, note: a.note, kind: a.kind });
      }
    }
    return out;
  };

  /** Jumlah pasien (transaksi unik) & tindakan yang dilayani karyawan sebagai pelaksana. */
  /** Jumlah pasien & tindakan yang dikerjakan karyawan (untuk honor per pasien / per tindakan).
   *  Homecare dihitung per kunjungan: 1 pasien dengan banyak tindakan homecare = 1 pasien & 1 tindakan. */
  inc.performed = function (trxs, empId, start, end) {
    const ids = new Set();
    const hcVisits = new Set();
    let qty = 0;
    for (const t of trxs) {
      if (t.status !== 'active' || !u.inRange(t.date, start, end)) continue;
      for (const it of t.items) {
        if (!Object.values(it.performers || {}).includes(empId)) continue;
        if (NP.C.serviceGroup(it.category, it.serviceName) === 'homecare') {
          const k = NP.C.visitKey(t);
          hcVisits.add(k);
          ids.add(k);
        } else {
          ids.add('T:' + t.id);
          qty += it.qty;
        }
      }
    }
    return { patients: ids.size, actions: qty + hcVisits.size };
  };

  /* ---------- Laporan jasa per bagian (Konsultasi / Jasa tindakan / Homecare) ---------- */
  const EXAM_RE = /PEMERIKSAAN DOKTER|KONSULTASI DOKTER|JASA DOKTER|BIAYA DOKTER|PERIKSA DOKTER/i;
  inc.SECTIONS = { konsultasi: 'Konsultasi Dokter', jasa: 'Jasa Tindakan', homecare: 'Homecare' };
  /** Bagian laporan untuk satu item: homecare, konsultasi (biaya pemeriksaan / resep), atau jasa tindakan. */
  inc.sectionOf = function (t, it) {
    if (NP.C.serviceGroup(it.category, it.serviceName) === 'homecare') return 'homecare';
    // biaya pemeriksaan dokter: dari resep, input manual, atau "Pemeriksaan Dokter" yang dibayar di kasir
    if ((t.externalRef && /^RESEP:/.test(t.externalRef)) || EXAM_RE.test(it.serviceName)) return 'konsultasi';
    return 'jasa';
  };
  /**
   * Laporan jasa per pelaksana per bagian (meniru laporan "Dokter dan Bidan").
   * @returns { emps:[{id,name}], rows:{konsultasi:[],jasa:[],homecare:[]}, totals:{section:{empId:amount}}, grand:{empId:amount} }
   */
  inc.jasaReport = function (trxs, opt) {
    opt = opt || {};
    const rows = { konsultasi: [], jasa: [], homecare: [] };
    const empNames = new Map();
    for (const t of trxs) {
      if (t.status !== 'active' || !u.inRange(t.date, opt.start, opt.end)) continue;
      for (const it of t.items) {
        const amounts = {};
        for (const sh of it.shares || []) {
          if (!sh.recipientId || !(sh.type === 'role' || sh.type === 'employee') || !sh.amount) continue;
          amounts[sh.recipientId] = (amounts[sh.recipientId] || 0) + sh.amount;
          empNames.set(sh.recipientId, sh.recipientName);
        }
        const sec = inc.sectionOf(t, it);
        rows[sec].push({
          date: t.date, trxId: t.id, ref: (t.externalRef || '').replace(/^(POS|RESEP):/, ''), patient: t.patient || '', doctor: (it.performerNames || {}).dokter || '',
          product: it.qty + ' Jasa x ' + it.serviceName + (it.withDoctor ? ' (dengan dokter)' : ''), qty: it.qty, price: it.price, gross: it.gross, amounts
        });
      }
    }
    const want = opt.employees ? new Set(opt.employees) : null;
    const emps = [...empNames.entries()].filter(([id]) => !want || want.has(id)).map(([id, name]) => ({ id, name: (opt.empMap && opt.empMap.get(id) && opt.empMap.get(id).name) || name }));
    const totals = {};
    const grand = {};
    for (const sec of Object.keys(rows)) {
      rows[sec].sort((a, b) => (a.date + a.trxId).localeCompare(b.date + b.trxId));
      totals[sec] = {};
      for (const e of emps) {
        totals[sec][e.id] = u.sum(rows[sec], (r) => r.amounts[e.id] || 0);
        grand[e.id] = (grand[e.id] || 0) + totals[sec][e.id];
      }
    }
    emps.sort((a, b) => (grand[b.id] || 0) - (grand[a.id] || 0));
    return { emps, rows, totals, grand };
  };
  inc.jasaReportExcel = function (rep, label) {
    const head = (extra) => extra.concat(rep.emps.map((e) => e.name));
    const sheet = (sec, cols, rowFn) => ({
      name: inc.SECTIONS[sec].toUpperCase().slice(0, 30),
      aoa: [head(cols)].concat(rep.rows[sec].map((r, i) => rowFn(r, i).concat(rep.emps.map((e) => r.amounts[e.id] || 0))), [cols.map((c, i) => (i === 0 ? 'TOTAL' : '')).concat(rep.emps.map((e) => rep.totals[sec][e.id]))])
    });
    NP.exp.excel([
      { name: 'Ringkasan', aoa: [['LAPORAN JASA DOKTER & BIDAN'], [label], [], ['Bagian'].concat(rep.emps.map((e) => e.name))].concat(Object.keys(inc.SECTIONS).map((sec) => [inc.SECTIONS[sec]].concat(rep.emps.map((e) => rep.totals[sec][e.id]))), [['TOTAL'].concat(rep.emps.map((e) => rep.grand[e.id]))]) },
      sheet('konsultasi', ['No.', 'Tanggal', 'Kode Resep / Transaksi', 'Nama Pasien', 'Dokter', 'Service'], (r, i) => [i + 1, r.date, r.ref || r.trxId, r.patient, r.doctor, r.gross]),
      sheet('jasa', ['No.', 'Tanggal', 'Struk / Transaksi', 'Pelanggan', 'Produk'], (r, i) => [i + 1, r.date, r.ref || r.trxId, r.patient || '-', r.product]),
      sheet('homecare', ['No.', 'Tanggal', 'Struk / Transaksi', 'Pelanggan', 'Produk'], (r, i) => [i + 1, r.date, r.ref || r.trxId, r.patient || '-', r.product])
    ], 'laporan-jasa-dokter-bidan-' + u.slug(label) + '.xlsx');
  };

  /* ---------- Catatan shift & sesi praktik ---------- */
  inc.worklogs = async () => (await NP.db.all('worklogs')).sort((a, b) => b.date.localeCompare(a.date));
  inc.worklogSum = function (logs, empId, start, end) {
    const l = logs.filter((x) => x.employeeId === empId && u.inRange(x.date, start, end));
    return { shifts: u.sum(l, (x) => x.shifts), sessions: u.sum(l, (x) => x.sessions), days: new Set(l.map((x) => x.date)).size };
  };
  inc.saveWorklog = async function (w) {
    if (!w.employeeId) throw new Error('Karyawan wajib dipilih.');
    if (!w.date) throw new Error('Tanggal wajib diisi.');
    if (w.date > u.todayISO()) throw new Error('Tanggal tidak boleh melebihi hari ini.');
    w.shifts = Math.max(0, u.toNum(w.shifts));
    w.sessions = Math.max(0, u.toNum(w.sessions));
    if (!w.shifts && !w.sessions) throw new Error('Isi jumlah shift atau sesi praktik.');
    const runs = await NP.db.all('payrollRuns');
    const locked = runs.find((r) => r.status === 'locked' && r.employeeIds.includes(w.employeeId) && u.inRange(w.date, r.start, r.end));
    if (locked) throw new Error('Tanggal tersebut sudah termasuk penggajian terkunci ' + locked.id + '.');
    if (NP.db.remote) return NP.db.saveWorklog(w);
    const isNew = !w.id;
    if (isNew) w.id = u.uid('WL');
    w.updatedAt = Date.now();
    await NP.db.run(['worklogs', 'auditLog'], async (t) => {
      await t.put('worklogs', w);
      await t.put('auditLog', NP.audit.entry(isNew ? 'worklog.create' : 'worklog.update', 'worklog', w.id, w.employeeId + ' ' + w.date + ': ' + w.shifts + ' shift, ' + w.sessions + ' sesi'));
    });
    return w;
  };

  inc.deleteWorklog = async function (w) {
    if (NP.db.remote) return NP.db.deleteWorklog(w.id);
    await NP.db.run(['worklogs', 'auditLog'], async (t) => {
      await t.del('worklogs', w.id);
      await t.put('auditLog', NP.audit.entry('worklog.delete', 'worklog', w.id, w.employeeId + ' ' + w.date));
    });
  };

  NP.income = inc;

  /* ===================== Halaman REKAP JASA KARYAWAN ===================== */
  const st = { period: u.todayISO().slice(0, 7), unit: '', role: '', tab: 'recap' };

  async function render(view) {
    view.innerHTML = `
      <div class="page-head">
        <div><h2>Rekap Jasa Karyawan</h2><p class="muted">Seluruh hak jasa dari transaksi tindakan otomatis terekap per karyawan dan masuk ke penggajian tanpa penghitungan ganda.</p></div>
        <div class="actions"><button class="btn btn-ghost" data-act="xls">${ui.icon('excel')}<span>Ekspor Excel</span></button></div>
      </div>
      <div class="card">
        <div class="filters">
          <label class="field-inline"><span>Periode</span><input type="month" id="r-period" value="${st.period}"></label>
          <select id="r-unit"><option value="">Semua unit</option>${ui.options(Object.entries(C.EMP_UNITS), st.unit)}</select>
          <select id="r-role"><option value="">Semua peran</option>${ui.options(Object.values(C.ROLES).map((r) => [r.key, r.label]), st.role)}</select>
        </div>
        <div id="r-tabs"></div>
        <div id="r-body"></div>
      </div>`;
    const tabsHost = ui.$('#r-tabs', view);
    ui.tabs(tabsHost, [
      { key: 'recap', label: 'Rekap per Karyawan', icon: 'recap' },
      { key: 'section', label: 'Laporan Dokter & Bidan', icon: 'report' },
      { key: 'recon', label: 'Rekonsiliasi', icon: 'check' },
      { key: 'work', label: 'Shift & Sesi Praktik', icon: 'calendar' }
    ], st.tab, (k) => {
      st.tab = k;
      if (data) draw(); // data belum selesai dimuat → digambar setelah load()
    });
    const body = ui.$('#r-body', view);
    let data;
    async function load() {
      data = {
        trxs: await NP.db.all('transactions'),
        emps: await NP.emp.all(),
        runs: await NP.db.all('payrollRuns'),
        logs: await inc.worklogs()
      };
    }
    function range() {
      return u.monthRange(st.period);
    }
    function empFilter(e) {
      return (!st.unit || e.unit === st.unit) && (!st.role || C.roleOfPosition(e.position) === st.role);
    }

    function recapRows() {
      const { start, end } = range();
      const lines = inc.lines(data.trxs, { start, end });
      const adj = inc.adjustments(data.trxs, {});
      return data.emps
        .filter(empFilter)
        .map((e) => {
          const l = lines.get(e.id) || [];
          const a = (adj.get(e.id) || []).filter((x) => x.date <= end);
          const perf = inc.performed(data.trxs, e.id, start, end);
          const wl = inc.worklogSum(data.logs, e.id, start, end);
          return {
            e, lines: l, adj: a,
            count: l.length, qty: u.sum(l, (x) => x.qty), total: u.sum(l, (x) => x.amount),
            open: u.sum(l.filter((x) => !x.state), (x) => x.amount), inrun: u.sum(l.filter((x) => x.state === 'draft' || x.state === 'approved'), (x) => x.amount),
            locked: u.sum(l.filter((x) => x.state === 'locked'), (x) => x.amount), adjTotal: u.sum(a, (x) => x.amount), patients: perf.patients, actions: perf.actions, shifts: wl.shifts, sessions: wl.sessions
          };
        })
        .filter((r) => r.count || r.adj.length || r.shifts || r.sessions || NP.emp.isHealth(r.e));
    }

    function drawRecap() {
      const rows = recapRows();
      body.innerHTML = `<div class="stats-row compact">
          ${ui.stat('Total jasa periode ini', u.rp(u.sum(rows, (r) => r.total)))}
          ${ui.stat('Belum diproses', u.rp(u.sum(rows, (r) => r.open)), { cls: 'stat-amber' })}
          ${ui.stat('Dalam proses gaji', u.rp(u.sum(rows, (r) => r.inrun)), { cls: 'stat-blue' })}
          ${ui.stat('Terkunci / dibayar', u.rp(u.sum(rows, (r) => r.locked)), { cls: 'stat-dark' })}
        </div><div id="recap-table"></div>`;
      ui.table(ui.$('#recap-table', body), {
        columns: [
          { key: 'name', label: 'Karyawan', render: (r) => `<b>${u.esc(r.e.name)}</b><small class="block muted">${u.esc(r.e.position)} · ${u.esc(r.e.id)}</small>`, value: (r) => r.e.name },
          { key: 'count', label: 'Transaksi', align: 'right', render: (r) => u.num(r.count), value: (r) => r.count },
          { key: 'qty', label: 'Jml Tindakan', align: 'right', render: (r) => u.num(r.qty), value: (r) => r.qty },
          { key: 'total', label: 'Total Jasa', align: 'right', render: (r) => `<b>${u.rp(r.total)}</b>`, value: (r) => r.total },
          { key: 'open', label: 'Belum Diproses', align: 'right', render: (r) => u.rp(r.open), value: (r) => r.open },
          { key: 'inrun', label: 'Dalam Proses', align: 'right', render: (r) => u.rp(r.inrun), value: (r) => r.inrun },
          { key: 'locked', label: 'Terkunci', align: 'right', render: (r) => u.rp(r.locked), value: (r) => r.locked },
          { key: 'adj', label: 'Koreksi Tertunda', align: 'right', render: (r) => (r.adjTotal ? `<span class="text-warning">${u.rp(r.adjTotal)}</span>` : '-'), value: (r) => r.adjTotal },
          { key: 'a', label: '', sortable: false, render: (r) => `<button class="btn btn-sm btn-ghost" data-act="detail" data-id="${r.e.id}">${ui.icon('eye')}Rincian</button>` }
        ],
        rows,
        sortKey: 'total',
        sortDir: 'desc',
        empty: 'Tidak ada data jasa pada periode ini.',
        footer: (rr) => `<tr><th>Total</th><th class="ta-right">${u.num(u.sum(rr, (r) => r.count))}</th><th class="ta-right">${u.num(u.sum(rr, (r) => r.qty))}</th><th class="ta-right">${u.rp(u.sum(rr, (r) => r.total))}</th><th class="ta-right">${u.rp(u.sum(rr, (r) => r.open))}</th><th class="ta-right">${u.rp(u.sum(rr, (r) => r.inrun))}</th><th class="ta-right">${u.rp(u.sum(rr, (r) => r.locked))}</th><th class="ta-right">${u.rp(u.sum(rr, (r) => r.adjTotal))}</th><th></th></tr>`
      });
    }

    function showDetail(empId) {
      const r = recapRows().find((x) => x.e.id === empId);
      if (!r) return;
      const sum = NP.calc.summarizeService(r.lines);
      ui.modal({
        title: 'Rekap Jasa — ' + r.e.name + ' (' + u.periodLabel(st.period) + ')',
        size: 'lg',
        body: `<div class="recap-lines">${sum.map((s) => `<div class="recap-line"><span>${u.esc(s.serviceName)}</span><span>${u.num(s.count)} transaksi${s.qty !== s.count ? ' (' + u.num(s.qty) + ' tindakan)' : ''} × ${u.rp(s.unitAmount)}${s.qty !== s.count ? '/tindakan' : ''}</span><b>= ${u.rp(s.amount)}</b></div>`).join('') || '<p class="muted">Belum ada jasa.</p>'}
          <div class="recap-line total"><span>Total jasa pelayanan</span><span></span><b>${u.rp(r.total)}</b></div>
          ${r.adjTotal ? `<div class="recap-line"><span>Koreksi jasa tertunda</span><span>${r.adj.map((a) => a.trxId).join(', ')}</span><b>${u.rp(r.adjTotal)}</b></div>` : ''}</div>
          <div class="grid-4 mini-stats"><div><span>Pasien dilayani</span><b>${u.num(r.patients)}</b></div><div><span>Tindakan</span><b>${u.num(r.actions)}</b></div><div><span>Shift</span><b>${u.num(r.shifts)}</b></div><div><span>Sesi praktik</span><b>${u.num(r.sessions)}</b></div></div>
          <h4 class="sec-title">Rincian transaksi</h4>
          <div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Tanggal</th><th>No. Transaksi</th><th>Tindakan</th><th class="ta-right">Jml</th><th class="ta-right">Jasa</th><th>Status</th></tr></thead><tbody>
          ${r.lines.sort((a, b) => a.date.localeCompare(b.date)).map((l) => `<tr><td>${u.fmtDate(l.date)}</td><td>${u.esc(l.trxId)}</td><td>${u.esc(l.serviceName)}</td><td class="ta-right">${l.qty}</td><td class="ta-right">${u.rp(l.amount)}</td><td>${l.state ? ui.badge({ draft: 'Draft', approved: 'Disetujui', locked: 'Terkunci' }[l.state] + ' ' + l.runId, l.state === 'locked' ? 'dark' : 'blue') : ui.badge('Belum diproses', 'gray')}</td></tr>`).join('')}
          </tbody></table></div>`,
        actions: [{ label: 'Tutup', cls: 'btn-ghost', onClick: (m) => m.close() }]
      });
    }

    function reconChecks() {
      const { start, end } = range();
      const checks = [];
      const bad = data.trxs.filter((t) => t.status === 'active' && t.items.some((it) => u.sum(it.shares, (s) => s.amount) !== it.gross));
      checks.push({ ok: !bad.length, title: 'Integritas pembagian transaksi', desc: 'Total pembagian setiap item harus sama dengan pendapatan kotor.', detail: bad.map((t) => t.id).join(', ') || 'Semua transaksi seimbang.' });
      const cancelledReserved = data.trxs.filter((t) => t.status === 'cancelled' && NP.trx.empShares(t).some((x) => x.share.payroll && (x.share.payroll.state === 'draft' || x.share.payroll.state === 'approved')));
      checks.push({ ok: !cancelledReserved.length, title: 'Transaksi batal tidak masuk penggajian', desc: 'Transaksi yang dibatalkan tidak boleh tercatat di penggajian draft/disetujui.', detail: cancelledReserved.map((t) => t.id).join(', ') || 'Tidak ada.' });
      const earlier = inc.lines(data.trxs, { start, end, includeEarlier: true });
      let prevOpen = 0;
      const prevList = [];
      for (const [id, ls] of earlier) for (const l of ls) if (l.earlier && !l.state) {
        prevOpen += l.amount;
        prevList.push(l.trxId);
      }
      checks.push({ ok: !prevOpen, warn: true, title: 'Jasa periode sebelumnya yang belum dibayar', desc: 'Jasa dari tanggal sebelum periode ini yang belum masuk penggajian mana pun.', detail: prevOpen ? u.rp(prevOpen) + ' dari ' + new Set(prevList).size + ' transaksi. Aktifkan opsi "Sertakan jasa periode sebelumnya" saat Generate Payroll.' : 'Tidak ada.' });
      const empMap = new Map(data.emps.map((e) => [e.id, e]));
      const cur = inc.lines(data.trxs, { start, end });
      const inactive = [];
      for (const [id, ls] of cur) {
        const e = empMap.get(id);
        const open = u.sum(ls.filter((l) => !l.state), (l) => l.amount);
        if (open && (!e || !['aktif', 'cuti'].includes(e.status))) inactive.push((e ? e.name : id) + ' (' + u.rp(open) + ')');
      }
      checks.push({ ok: !inactive.length, warn: true, title: 'Penerima jasa tidak aktif', desc: 'Jasa milik karyawan berstatus tidak aktif/mengundurkan diri perlu diputuskan pembayarannya.', detail: inactive.join(', ') || 'Tidak ada.' });
      const adj = inc.adjustments(data.trxs, {});
      const adjList = [];
      for (const [id, a] of adj) adjList.push(((empMap.get(id) || {}).name || id) + ': ' + u.rp(u.sum(a, (x) => x.amount)));
      checks.push({ ok: !adjList.length, warn: true, title: 'Koreksi jasa tertunda', desc: 'Selisih akibat koreksi/pembatalan transaksi terkunci yang akan diproses pada penggajian berikutnya.', detail: adjList.join(', ') || 'Tidak ada.' });
      const stale = data.runs.filter((r) => r.status === 'draft' && r.stale);
      checks.push({ ok: !stale.length, title: 'Draft penggajian perlu dihitung ulang', desc: 'Draft yang transaksinya berubah setelah dihitung.', detail: stale.map((r) => r.id).join(', ') || 'Tidak ada.' });
      const dup = new Map();
      for (const t of data.trxs) for (const { share } of NP.trx.empShares(t)) if (share.payroll && share.payroll.runId) {
        const k = t.id;
        dup.set(k, (dup.get(k) || new Set()).add(share.payroll.runId));
      }
      const runsInPeriod = data.runs.filter((r) => r.period === st.period && r.status !== 'cancelled');
      const dupEmp = [];
      const seen = new Map();
      for (const r of runsInPeriod) for (const id of r.employeeIds) {
        if (seen.has(id)) dupEmp.push(((empMap.get(id) || {}).name || id) + ' (' + seen.get(id) + ' & ' + r.id + ')');
        else seen.set(id, r.id);
      }
      checks.push({ ok: !dupEmp.length, title: 'Tidak ada penggajian ganda', desc: 'Satu karyawan hanya boleh memiliki satu slip per periode.', detail: dupEmp.join(', ') || 'Tidak ada duplikasi.' });
      return checks;
    }

    function drawRecon() {
      const checks = reconChecks();
      const { start, end } = range();
      const cur = inc.lines(data.trxs, { start, end });
      let open = 0, inrun = 0, locked = 0;
      for (const ls of cur.values()) for (const l of ls) {
        if (!l.state) open += l.amount;
        else if (l.state === 'locked') locked += l.amount;
        else inrun += l.amount;
      }
      const gross = u.sum(data.trxs.filter((t) => t.status === 'active' && u.inRange(t.date, start, end)), (t) => t.totals.gross);
      const tot = NP.rs.summarize([].concat(...data.trxs.filter((t) => t.status === 'active' && u.inRange(t.date, start, end)).map((t) => [].concat(...t.items.map((i) => i.shares)))));
      body.innerHTML = `
        <div class="recon-summary">
          <div class="recon-flow">
            <div><span>Pendapatan kotor</span><b>${u.rp(gross)}</b></div><i>=</i>
            <div><span>Bagian usaha</span><b>${u.rp(tot.business)}</b></div><i>+</i>
            <div><span>Hak jasa karyawan</span><b>${u.rp(tot.staff)}</b></div><i>+</i>
            <div><span>Penerima lain</span><b>${u.rp(tot.eksternal)}</b></div>
          </div>
          <div class="recon-flow">
            <div><span>Hak jasa karyawan</span><b>${u.rp(tot.staff)}</b></div><i>=</i>
            <div><span>Belum diproses</span><b>${u.rp(open)}</b></div><i>+</i>
            <div><span>Dalam proses gaji</span><b>${u.rp(inrun)}</b></div><i>+</i>
            <div><span>Terkunci</span><b>${u.rp(locked)}</b></div>
          </div>
          ${gross === tot.business + tot.staff + tot.eksternal && tot.staff === open + inrun + locked ? `<div class="alert alert-success">${ui.icon('check')}<div>Angka seimbang — tidak ada jasa yang hilang maupun terhitung ganda.</div></div>` : `<div class="alert alert-danger">${ui.icon('warn')}<div>Terdapat selisih. Periksa daftar pengecekan di bawah.</div></div>`}
        </div>
        <div class="checklist">${checks.map((c) => `<div class="check-item ${c.ok ? 'ok' : c.warn ? 'warn' : 'bad'}">${ui.icon(c.ok ? 'check' : 'warn')}<div><b>${u.esc(c.title)}</b><p class="muted small">${u.esc(c.desc)}</p><p class="small">${u.esc(c.detail)}</p></div></div>`).join('')}</div>`;
    }

    function drawWork() {
      const { start, end } = range();
      const emps = data.emps.filter(empFilter);
      const canEdit = NP.sec.can('worklog.edit');
      const logs = data.logs.filter((l) => u.inRange(l.date, start, end) && emps.some((e) => e.id === l.employeeId));
      const empMap = new Map(data.emps.map((e) => [e.id, e]));
      const summary = emps
        .map((e) => {
          const w = inc.worklogSum(data.logs, e.id, start, end);
          const p = inc.performed(data.trxs, e.id, start, end);
          return { e, ...w, patients: p.patients, actions: p.actions };
        })
        .filter((r) => r.shifts || r.sessions || r.actions || ['bidan', 'perawat', 'dokter'].includes(C.roleOfPosition(r.e.position)));
      body.innerHTML = `
        ${canEdit ? `<form class="worklog-form panel" novalidate>
          <h4>Catat shift / sesi praktik</h4>
          <div class="grid-5">
            <label class="field"><span>Karyawan</span><select name="employeeId">${ui.options(data.emps.filter((e) => e.status === 'aktif').map((e) => [e.id, e.name + ' — ' + e.position]), '', '— pilih —')}</select></label>
            <label class="field"><span>Tanggal</span><input type="date" name="date" value="${u.todayISO() < end ? u.todayISO() : end}" max="${u.todayISO()}"></label>
            <label class="field"><span>Jumlah shift</span><input type="number" name="shifts" min="0" step="1" value="1"></label>
            <label class="field"><span>Sesi praktik</span><input type="number" name="sessions" min="0" step="1" value="0"></label>
            <label class="field"><span>Catatan</span><input name="note" maxlength="80"></label>
          </div>
          <button class="btn btn-primary" type="submit">${ui.icon('plus')}<span>Simpan catatan</span></button>
        </form>` : ''}
        <h4 class="sec-title">Laporan jumlah shift & pelayanan — ${u.periodLabel(st.period)}</h4>
        <div id="wl-sum"></div>
        <h4 class="sec-title">Catatan harian</h4>
        <div id="wl-list"></div>`;
      ui.table(ui.$('#wl-sum', body), {
        columns: [
          { key: 'name', label: 'Karyawan', render: (r) => `<b>${u.esc(r.e.name)}</b><small class="block muted">${u.esc(r.e.position)}</small>`, value: (r) => r.e.name },
          { key: 'days', label: 'Hari tercatat', align: 'right', render: (r) => u.num(r.days) },
          { key: 'shifts', label: 'Jumlah shift', align: 'right', render: (r) => u.num(r.shifts) },
          { key: 'sessions', label: 'Sesi praktik', align: 'right', render: (r) => u.num(r.sessions) },
          { key: 'patients', label: 'Pasien dilayani', align: 'right', render: (r) => u.num(r.patients) },
          { key: 'actions', label: 'Jumlah pelayanan', align: 'right', render: (r) => u.num(r.actions) }
        ],
        rows: summary,
        sortKey: 'name',
        noPaging: true,
        empty: 'Belum ada data.'
      });
      ui.table(ui.$('#wl-list', body), {
        columns: [
          { key: 'date', label: 'Tanggal', render: (l) => u.fmtDate(l.date) },
          { key: 'emp', label: 'Karyawan', render: (l) => u.esc((empMap.get(l.employeeId) || {}).name || l.employeeId), value: (l) => (empMap.get(l.employeeId) || {}).name },
          { key: 'shifts', label: 'Shift', align: 'right' },
          { key: 'sessions', label: 'Sesi', align: 'right' },
          { key: 'note', label: 'Catatan' },
          { key: 'a', label: '', sortable: false, render: (l) => (canEdit ? `<button class="icon-btn danger" data-act="del-wl" data-id="${l.id}" title="Hapus">${ui.icon('trash')}</button>` : '') }
        ],
        rows: logs,
        sortKey: 'date',
        sortDir: 'desc',
        pageSize: 15,
        empty: 'Belum ada catatan pada periode ini.'
      });
      const f = ui.$('.worklog-form', body);
      if (f)
        f.onsubmit = async (e) => {
          e.preventDefault();
          try {
            await inc.saveWorklog(ui.formData(f));
            ui.toast('Catatan shift/sesi tersimpan.');
            await load();
            drawWork();
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        };
    }

    function sectionReport() {
      const { start, end } = range();
      const empMap = new Map(data.emps.map((e) => [e.id, e]));
      const ids = data.emps.filter((e) => empFilter(e) && (st.role || ['dokter', 'bidan', 'perawat'].includes(C.roleOfPosition(e.position)))).map((e) => e.id);
      return inc.jasaReport(data.trxs, { start, end, employees: ids, empMap });
    }
    function drawSection() {
      const R = sectionReport();
      body.innerHTML = R.emps.length
        ? `<p class="muted small">Jasa per pelaksana dibagi menjadi <b>Konsultasi Dokter</b> (biaya pemeriksaan / resep), <b>Jasa Tindakan</b>, dan <b>Homecare</b> — sama dengan susunan laporan dokter & bidan. Periode ${u.esc(u.periodLabel(st.period))}.</p>
          <div class="table-wrap"><table class="tbl"><thead><tr><th>Bagian</th>${R.emps.map((e) => `<th class="ta-right">${u.esc(e.name)}</th>`).join('')}</tr></thead>
          <tbody>${Object.keys(inc.SECTIONS).map((sec) => `<tr><td>${inc.SECTIONS[sec]} <small class="muted">(${u.num(R.rows[sec].length)} baris)</small></td>${R.emps.map((e) => `<td class="ta-right" data-sec="${sec}" data-emp="${u.esc(e.id)}">${u.rp(R.totals[sec][e.id])}</td>`).join('')}</tr>`).join('')}</tbody>
          <tfoot><tr><th>TOTAL</th>${R.emps.map((e) => `<th class="ta-right" data-grand="${u.esc(e.id)}">${u.rp(R.grand[e.id])}</th>`).join('')}</tr></tfoot></table></div>
          <div class="form-actions"><button type="button" class="btn btn-primary" data-act="xls-section">${ui.icon('excel')}<span>Unduh laporan Excel (per bagian)</span></button></div>`
        : ui.empty('Belum ada jasa dokter/bidan pada periode ini.');
    }
    function draw() {
      if (st.tab === 'recap') drawRecap();
      else if (st.tab === 'section') drawSection();
      else if (st.tab === 'recon') drawRecon();
      else drawWork();
    }

    await load();
    draw();
    ui.$('#r-period', view).onchange = (e) => {
      st.period = e.target.value || st.period;
      draw();
    };
    ui.$('#r-unit', view).onchange = (e) => {
      st.unit = e.target.value;
      draw();
    };
    ui.$('#r-role', view).onchange = (e) => {
      st.role = e.target.value;
      draw();
    };
    view.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-act]');
      if (!a || !view.contains(a)) return;
      if (a.dataset.act === 'detail') showDetail(a.dataset.id);
      if (a.dataset.act === 'xls-section') inc.jasaReportExcel(sectionReport(), u.periodLabel(st.period));
      if (a.dataset.act === 'del-wl') {
        const runs = data.runs;
        const w = data.logs.find((x) => x.id === a.dataset.id);
        if (runs.some((r) => r.status === 'locked' && r.employeeIds.includes(w.employeeId) && u.inRange(w.date, r.start, r.end))) return ui.toast('Catatan sudah termasuk penggajian terkunci.', 'error');
        if (!(await ui.confirm({ message: 'Hapus catatan ini?', danger: true, okLabel: 'Hapus' }))) return;
        try {
          await inc.deleteWorklog(w);
        } catch (err) {
          return ui.toast(err.message, 'error');
        }
        await load();
        drawWork();
      }
      if (a.dataset.act === 'xls') {
        const rows = recapRows();
        const detail = [];
        rows.forEach((r) => NP.calc.summarizeService(r.lines).forEach((s) => detail.push({ 'ID Karyawan': r.e.id, Nama: r.e.name, Jabatan: r.e.position, Tindakan: s.serviceName, 'Jumlah Transaksi': s.count, 'Jumlah Tindakan': s.qty, 'Jasa per Tindakan': s.unitAmount, 'Total Jasa': s.amount })));
        NP.exp.excel([
          { name: 'Rekap Jasa', rows: rows.map((r) => ({ 'ID Karyawan': r.e.id, Nama: r.e.name, Jabatan: r.e.position, Transaksi: r.count, 'Jumlah Tindakan': r.qty, 'Total Jasa': r.total, 'Belum Diproses': r.open, 'Dalam Proses': r.inrun, Terkunci: r.locked, 'Koreksi Tertunda': r.adjTotal, Shift: r.shifts, 'Sesi Praktik': r.sessions })) },
          { name: 'Rincian per Tindakan', rows: detail }
        ], 'rekap-jasa-' + st.period + '.xlsx');
      }
    });
  }

  NP.pages.income = { title: 'Rekap Jasa Karyawan', render };
})(typeof globalThis !== 'undefined' ? globalThis : window);
