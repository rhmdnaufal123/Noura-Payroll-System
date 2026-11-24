/* Noura Payroll — penggajian: komponen gaji, skema per karyawan, GENERATE PAYROLL massal, RIWAYAT PENGGAJIAN.
 *
 * Siklus penggajian: draft → disetujui (slip terbit) → terkunci.
 * Saat run disimpan, setiap baris jasa yang dipakai "dipesan" (payroll.runId) sehingga tidak
 * mungkin dihitung dua kali oleh run lain. Run terkunci tidak dapat diubah; koreksi transaksi
 * setelahnya masuk sebagai adjustment ke penggajian berikutnya.
 */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;
  const C = NP.C;
  const D = NP.defaults;

  /* ===================== Engine ===================== */
  const pr = {};
  pr.runs = async () => (await NP.db.all('payrollRuns')).sort((a, b) => (b.period + b.id).localeCompare(a.period + a.id));
  pr.get = (id) => NP.db.get('payrollRuns', id);

  pr.loadData = async function () {
    return {
      emps: await NP.emp.map(),
      trxs: await NP.db.all('transactions'),
      logs: await NP.db.all('worklogs'),
      runs: await NP.db.all('payrollRuns'),
      components: await NP.loadComponents(),
      settings: NP.state.settings
    };
  };

  pr.eligibleEmployees = function (data, unit) {
    const sts = data.settings.payroll.includeEmployeeStatuses || ['aktif', 'cuti'];
    return [...data.emps.values()]
      .filter((e) => sts.includes(e.status))
      .filter((e) => !unit || unit === 'ALL' || e.unit === unit || e.unit === 'LINTAS')
      .sort((a, b) => a.name.localeCompare(b.name, 'id'));
  };

  /** Karyawan yang sudah ada di run lain yang periodenya beririsan. */
  pr.conflicts = function (data, run) {
    const m = new Map();
    for (const r of data.runs) {
      if (r.id === run.id || r.status === 'cancelled') continue;
      if (r.end < run.start || r.start > run.end) continue;
      for (const id of r.employeeIds) m.set(id, r.id);
    }
    return m;
  };

  pr.autoInputs = function (emp, data, run) {
    const s = data.settings;
    const wd = u.toNum(s.payroll.workDays) || 26;
    const wl = NP.income.worklogSum(data.logs, emp.id, run.start, run.end);
    const pf = NP.income.performed(data.trxs, emp.id, run.start, run.end);
    return { workDays: wd, presentDays: wd, lateCount: 0, absentDays: 0, overtimeHours: 0, shifts: wl.shifts, sessions: wl.sessions, patients: pf.patients, actions: pf.actions, salesTarget: u.toInt(emp.salesTarget), salesActual: 0, manual: {} };
  };

  pr.inputsFor = function (emp, data, run) {
    const auto = pr.autoInputs(emp, data, run);
    const ov = (run.inputs || {})[emp.id] || {};
    const out = Object.assign({}, auto, ov, { manual: Object.assign({}, auto.manual, ov.manual || {}) });
    // hari hadir otomatis mengikuti absen bila tidak diubah manual
    if (ov.presentDays === undefined && ov.absentDays !== undefined) out.presentDays = Math.max(0, out.workDays - u.toNum(ov.absentDays));
    return out;
  };

  pr.compute = function (run, data) {
    const lines = NP.income.lines(data.trxs, { start: run.start, end: run.end, runId: run.id, includeEarlier: run.includeEarlier, onlyEligible: true });
    const adjs = NP.income.adjustments(data.trxs, { runId: run.id, end: run.end });
    const slips = [];
    for (const id of run.employeeIds) {
      const emp = data.emps.get(id);
      if (!emp) continue;
      const l = lines.get(id) || [];
      const a = adjs.get(id) || [];
      const inputs = pr.inputsFor(emp, data, run);
      const r = NP.calc.computeSlip(emp, { components: data.components, settings: data.settings, inputs, serviceLines: l, adjustments: a });
      slips.push(Object.assign(r, {
        employee: {
          id: emp.id, name: emp.name, position: emp.position, department: emp.department, unit: emp.unit, primaryUnit: NP.emp.primaryUnit(emp),
          payScheme: emp.payScheme, payMethod: emp.payMethod, bankName: emp.bankName, bankAccountMasked: u.maskAccount(emp.bankAccount), bankHolder: emp.bankHolder || emp.name, startDate: emp.startDate
        },
        serviceRefs: l.map((x) => ({ trxId: x.trxId, lineId: x.lineId, si: x.si })),
        adjRefs: a.map((x) => ({ trxId: x.trxId, adjId: x.adjId })),
        earlierCount: l.filter((x) => x.earlier).length
      }));
    }
    return { slips, totals: pr.totals(slips) };
  };

  pr.totals = function (slips) {
    const keys = ['gross', 'deductions', 'net', 'base', 'allowance', 'overtime', 'bonus', 'incentive', 'practice', 'service', 'other', 'fixed', 'variable', 'bpjs', 'tax'];
    const t = {};
    keys.forEach((k) => (t[k] = u.sum(slips, (s) => s.totals[k])));
    t.employerContrib = u.sum(slips, (s) => s.employer.total);
    t.alloc = { APT: { gross: 0, net: 0, deductions: 0 }, KLINIK: { gross: 0, net: 0, deductions: 0 } };
    for (const s of slips) for (const un of ['APT', 'KLINIK']) for (const k of ['gross', 'net', 'deductions']) t.alloc[un][k] += s.allocation[un][k];
    t.count = slips.length;
    return t;
  };

  /** Lepas & pasang reservasi jasa untuk sebuah run dalam transaksi DB yang sama. */
  async function applyReservations(t, run, state) {
    const trxs = await t.all('transactions');
    const refs = new Set();
    const adjRefs = new Set();
    if (state) for (const s of run.slips) {
      s.serviceRefs.forEach((r) => refs.add(r.trxId + '|' + r.lineId + '|' + r.si));
      s.adjRefs.forEach((r) => adjRefs.add(r.trxId + '|' + r.adjId));
    }
    for (const tr of trxs) {
      let changed = false;
      for (const it of tr.items) it.shares.forEach((s, si) => {
        const key = tr.id + '|' + it.lineId + '|' + si;
        const p = s.payroll || {};
        if (refs.has(key)) {
          if (p.runId && p.runId !== run.id) throw new Error('Jasa pada ' + tr.id + ' sudah dipakai penggajian ' + p.runId + '. Muat ulang dan hitung ulang.');
          if (p.runId !== run.id || p.state !== state) {
            s.payroll = { runId: run.id, state };
            changed = true;
          }
        } else if (p.runId === run.id) {
          s.payroll = { runId: null, state: null };
          changed = true;
        }
      });
      for (const a of tr.adjustments || []) {
        const key = tr.id + '|' + a.id;
        const p = a.payroll || {};
        if (adjRefs.has(key)) {
          if (p.runId && p.runId !== run.id) throw new Error('Koreksi pada ' + tr.id + ' sudah dipakai penggajian ' + p.runId + '.');
          if (p.runId !== run.id || p.state !== state) {
            a.payroll = { runId: run.id, state };
            changed = true;
          }
        } else if (p.runId === run.id) {
          a.payroll = { runId: null, state: null };
          changed = true;
        }
      }
      if (changed) await t.put('transactions', tr);
    }
  }

  function hist(run, action, note) {
    const usr = NP.sec.user();
    run.history = (run.history || []).concat([{ ts: Date.now(), by: usr ? usr.username : 'sistem', action, note: note || '' }]);
  }

  /** Hitung & simpan run (draft). */
  pr.saveDraft = async function (run, opt) {
    opt = opt || {};
    if (!run.employeeIds.length) throw new Error('Pilih minimal satu karyawan.');
    if (!run.start || !run.end || run.start > run.end) throw new Error('Rentang periode tidak valid.');
    const data = await pr.loadData();
    const conf = pr.conflicts(data, run);
    const dup = run.employeeIds.filter((id) => conf.has(id));
    if (dup.length) throw new Error('Karyawan berikut sudah memiliki penggajian pada periode yang beririsan: ' + dup.map((id) => (data.emps.get(id) || {}).name + ' (' + conf.get(id) + ')').join(', '));
    const usr = NP.sec.user();
    return NP.db.run(['payrollRuns', 'transactions', 'counters', 'auditLog'], async (t) => {
      const isNew = !run.id;
      if (isNew) {
        const ym = run.period.replace('-', '');
        const n = await t.nextNumber('pay-' + ym);
        run.id = NP.state.settings.numbering.payroll + '-' + ym + '-' + String(n).padStart(2, '0');
        run.createdAt = Date.now();
        run.createdBy = usr ? usr.username : 'sistem';
      } else {
        const cur = await t.get('payrollRuns', run.id);
        if (cur && cur.status !== 'draft') throw new Error('Penggajian ' + run.id + ' sudah ' + cur.status + ' dan tidak dapat diubah.');
      }
      // data transaksi terbaru dari dalam transaksi DB
      data.trxs = await t.all('transactions');
      const prevNo = new Map((run.slips || []).filter((x) => x.slipNo).map((x) => [x.employeeId, x.slipNo]));
      const res = pr.compute(run, data);
      res.slips.forEach((x) => prevNo.has(x.employeeId) && (x.slipNo = prevNo.get(x.employeeId)));
      run.slips = res.slips;
      run.totals = res.totals;
      run.status = 'draft';
      run.stale = false;
      run.staleReason = '';
      run.computedAt = Date.now();
      hist(run, isNew ? 'create' : 'recalc', opt.note);
      await applyReservations(t, run, 'draft');
      await t.put('payrollRuns', run);
      await t.put('auditLog', NP.audit.entry(isNew ? 'payroll.create' : 'payroll.recalc', 'payroll', run.id, (isNew ? 'Buat draft ' : 'Hitung ulang ') + u.periodLabel(run.period) + ': ' + run.employeeIds.length + ' karyawan, gaji bersih ' + u.rp(run.totals.net)));
      return run;
    });
  };

  pr.approve = async function (id, note) {
    const run = await pr.get(id);
    if (!run || run.status !== 'draft') throw new Error('Hanya draft yang dapat disetujui.');
    if (run.stale) throw new Error('Draft perlu dihitung ulang terlebih dahulu (' + (run.staleReason || 'data berubah') + ').');
    const usr = NP.sec.user();
    const data = await pr.loadData();
    return NP.db.run(['payrollRuns', 'transactions', 'counters', 'auditLog'], async (t) => {
      // hitung ulang terakhir di dalam transaksi DB untuk memastikan angka sesuai data terkini
      data.trxs = await t.all('transactions');
      data.runs = await t.all('payrollRuns');
      const res = pr.compute(run, data);
      const prevNo = new Map((run.slips || []).filter((x) => x.slipNo).map((x) => [x.employeeId, x.slipNo]));
      res.slips.forEach((x) => prevNo.has(x.employeeId) && (x.slipNo = prevNo.get(x.employeeId)));
      run.slips = res.slips;
      run.totals = res.totals;
      for (const s of run.slips) {
        if (!s.slipNo) {
          const unit = s.employee.primaryUnit;
          const n = await t.nextNumber('slip-' + run.period);
          s.slipNo = NP.state.settings.numbering.slip + '/' + unit + '/' + run.period.replace('-', '/') + '/' + String(n).padStart(4, '0');
        }
        s.issuedAt = Date.now();
      }
      run.status = 'approved';
      run.approvedAt = Date.now();
      run.approvedBy = usr ? usr.username : 'sistem';
      hist(run, 'approve', note);
      await applyReservations(t, run, 'approved');
      await t.put('payrollRuns', run);
      await t.put('auditLog', NP.audit.entry('payroll.approve', 'payroll', run.id, 'Setujui penggajian ' + u.periodLabel(run.period) + ' — ' + run.slips.length + ' slip, total ' + u.rp(run.totals.net)));
      return run;
    });
  };

  pr.setStatus = async function (id, from, to, action, auth) {
    const usr = NP.sec.user();
    return NP.db.run(['payrollRuns', 'transactions', 'auditLog'], async (t) => {
      const run = await t.get('payrollRuns', id);
      if (!run || run.status !== from) throw new Error('Status penggajian tidak sesuai (' + (run && run.status) + ').');
      run.status = to;
      if (to === 'locked') {
        run.lockedAt = Date.now();
        run.lockedBy = usr ? usr.username : 'sistem';
      }
      if (to === 'draft') {
        run.approvedAt = null;
        run.stale = true;
        run.staleReason = 'Dikembalikan ke draft';
      }
      hist(run, action, auth ? auth.note + ' (otorisasi ' + auth.by + ')' : '');
      await applyReservations(t, run, to);
      await t.put('payrollRuns', run);
      await t.put('auditLog', NP.audit.entry('payroll.' + action, 'payroll', id, action + ' ' + u.periodLabel(run.period) + (auth ? ' | otorisasi ' + auth.by + ': ' + auth.note : '')));
      return run;
    });
  };
  pr.lock = (id) => pr.setStatus(id, 'approved', 'locked', 'lock');
  pr.unlock = (id, auth) => pr.setStatus(id, 'locked', 'approved', 'unlock', auth);
  pr.revert = (id) => pr.setStatus(id, 'approved', 'draft', 'revert');

  pr.remove = async function (id) {
    return NP.db.run(['payrollRuns', 'transactions', 'auditLog'], async (t) => {
      const run = await t.get('payrollRuns', id);
      if (!run) return;
      if (run.status !== 'draft') throw new Error('Hanya draft yang dapat dihapus.');
      await applyReservations(t, Object.assign({}, run, { slips: [] }), null);
      await t.del('payrollRuns', id);
      await t.put('auditLog', NP.audit.entry('payroll.delete', 'payroll', id, 'Hapus draft ' + u.periodLabel(run.period)));
    });
  };

  pr.statusLabel = (s) => ({ draft: 'Draft', approved: 'Disetujui', locked: 'Terkunci' }[s] || s);
  NP.payroll = pr;

  /* ===================== Halaman PENGGAJIAN (komponen & skema) ===================== */
  const ps = { tab: 'components' };
  async function renderPayroll(view) {
    const canCfg = NP.sec.can('payroll.config');
    view.innerHTML = `
      <div class="page-head">
        <div><h2>Penggajian</h2><p class="muted">Komponen pendapatan & potongan, skema gaji setiap karyawan, bonus penjualan apotek, pajak dan BPJS.</p></div>
        <div class="actions"><a class="btn btn-primary" href="#/generate">${ui.icon('play')}<span>Generate Payroll</span></a></div>
      </div>
      ${canCfg ? '' : `<div class="alert alert-info">${ui.icon('info')}<div>Anda dapat melihat konfigurasi; perubahan hanya dapat dilakukan Administrator.</div></div>`}
      <div class="card"><div id="p-tabs"></div><div id="p-body"></div></div>`;
    const body = ui.$('#p-body', view);
    ui.tabs(ui.$('#p-tabs', view), [
      { key: 'components', label: 'Komponen Gaji' },
      { key: 'schemes', label: 'Skema Karyawan' },
      { key: 'sales', label: 'Bonus Penjualan Apotek' },
      { key: 'tax', label: 'Pajak & BPJS' }
    ], ps.tab, (k) => {
      ps.tab = k;
      draw();
    });
    async function draw() {
      if (ps.tab === 'components') return drawComponents(body, canCfg, draw);
      if (ps.tab === 'schemes') return drawSchemes(body);
      if (ps.tab === 'sales') return NP.settingsPanels.salesBonus(body, canCfg);
      if (ps.tab === 'tax') return NP.settingsPanels.taxBpjs(body, canCfg);
    }
    draw();
  }

  async function drawComponents(body, canCfg, redraw) {
    const comps = await NP.loadComponents();
    const scope = (c) => {
      const a = [];
      a.push(c.units && c.units.length ? c.units.map((x) => C.EMP_UNITS[x] || x).join(', ') : 'Semua unit');
      if (c.positions && c.positions.length) a.push(c.positions.length + ' jabatan');
      const pv = Object.keys(c.positionValues || {}).length;
      if (pv) a.push(pv + ' nilai per jabatan');
      return a.join(' · ');
    };
    const valueOf = (c) => (c.calc === 'system' ? '<small class="muted">Otomatis</small>' : c.calc === 'percent' ? u.pct(c.value) : c.calc === 'manual' ? (c.value ? 'Default ' + u.rp(c.value) : '<small class="muted">Input saat gaji</small>') : c.calc === 'per_hour' && !c.value ? '<small>Gaji/173 × 1,5</small>' : c.calc === 'per_absent_day' && !c.value ? '<small>Prorata gaji</small>' : u.rp(c.value));
    const tableFor = (type) => `<div class="table-wrap"><table class="tbl"><thead><tr><th>Kode</th><th>Nama</th><th>Kelompok</th><th>Cara hitung</th><th class="ta-right">Nilai</th><th>Berlaku untuk</th><th>Sifat</th><th>Status</th><th></th></tr></thead><tbody>
      ${comps.filter((c) => c.type === type).map((c) => `<tr class="${c.active ? '' : 'row-cancelled'}"><td><code>${u.esc(c.code)}</code></td><td><b>${u.esc(c.name)}</b></td>
        <td>${u.esc((type === 'earning' ? D.EARNING_GROUPS : D.DEDUCTION_GROUPS)[c.group] || c.group)}</td><td><small>${u.esc(D.CALC_LABELS[c.calc])}</small></td>
        <td class="ta-right">${valueOf(c)}</td><td><small>${u.esc(scope(c))}</small></td>
        <td>${type === 'earning' ? (c.fixed ? ui.badge('Tetap', 'green') : ui.badge('Variabel', 'amber')) + (c.taxable === false ? ' ' + ui.badge('Non-pajak', 'gray') : '') : ''}</td>
        <td>${ui.statusBadge(c.active ? 'active' : 'nonaktif')}</td>
        <td class="ta-right">${canCfg ? `<div class="row-actions"><button class="icon-btn" data-cact="edit" data-id="${c.id}" title="Edit">${ui.icon('edit')}</button><button class="icon-btn" data-cact="toggle" data-id="${c.id}" title="${c.active ? 'Nonaktifkan' : 'Aktifkan'}">${ui.icon(c.active ? 'lock' : 'unlock')}</button>${c.system ? '' : `<button class="icon-btn danger" data-cact="del" data-id="${c.id}" title="Hapus">${ui.icon('trash')}</button>`}</div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
    body.innerHTML = `
      <div class="card-head"><h3>Komponen Pendapatan</h3>${canCfg ? `<button class="btn btn-sm btn-primary" data-cact="add" data-type="earning">${ui.icon('plus')}Tambah komponen pendapatan</button>` : ''}</div>
      ${tableFor('earning')}
      <div class="card-head"><h3>Komponen Potongan</h3>${canCfg ? `<button class="btn btn-sm btn-primary" data-cact="add" data-type="deduction">${ui.icon('plus')}Tambah komponen potongan</button>` : ''}</div>
      ${tableFor('deduction')}
      <p class="muted small">Komponen "Otomatis" dihitung sistem: gaji pokok sesuai skema, jasa pelayanan dari transaksi, honor praktik dari tarif karyawan, bonus target penjualan, BPJS, dan PPh 21. Nilai komponen dapat dibedakan per jabatan dan per unit usaha, serta ditimpa per karyawan di form karyawan.</p>`;
    body.onclick = async (e) => {
      const a = e.target.closest('[data-cact]');
      if (!a) return;
      const c = comps.find((x) => x.id === a.dataset.id);
      if (a.dataset.cact === 'add') componentForm({ type: a.dataset.type }, redraw);
      if (a.dataset.cact === 'edit') componentForm(c, redraw);
      if (a.dataset.cact === 'toggle') {
        c.active = !c.active;
        await NP.db.put('components', c);
        await NP.audit.log('component.' + (c.active ? 'activate' : 'deactivate'), 'component', c.id, c.name);
        ui.toast('Komponen ' + (c.active ? 'diaktifkan' : 'dinonaktifkan') + '.');
        redraw();
      }
      if (a.dataset.cact === 'del') {
        if (!(await ui.confirm({ message: 'Hapus komponen "' + c.name + '"? Slip yang sudah terbit tidak berubah.', danger: true, okLabel: 'Hapus' }))) return;
        await NP.db.del('components', c.id);
        await NP.audit.log('component.delete', 'component', c.id, c.name);
        ui.toast('Komponen dihapus.');
        redraw();
      }
    };
  }

  function componentForm(existing, onSaved) {
    const isNew = !existing.id;
    const c = Object.assign({ code: '', name: '', type: existing.type, group: existing.type === 'earning' ? 'allowance' : 'other', calc: 'fixed', value: 0, positionValues: {}, units: [], positions: [], active: true, fixed: false, taxable: true, system: false, order: 50 }, u.clone(existing));
    const groups = c.type === 'earning' ? D.EARNING_GROUPS : D.DEDUCTION_GROUPS;
    const calcs = Object.entries(D.CALC_LABELS).filter(([k]) => (c.system ? k === 'system' : k !== 'system'));
    const body = document.createElement('form');
    body.noValidate = true;
    body.innerHTML = `
      <div class="grid-2">
        <label class="field"><span>Nama komponen <b class="req">*</b></span><input name="name" value="${u.esc(c.name)}" maxlength="60"></label>
        <label class="field"><span>Kode</span><input name="code" value="${u.esc(c.code)}" ${isNew ? '' : 'readonly'} placeholder="Otomatis dari nama" maxlength="20"></label>
        <label class="field"><span>Kelompok (untuk slip)</span><select name="group">${ui.options(Object.entries(groups), c.group)}</select></label>
        <label class="field"><span>Cara perhitungan</span><select name="calc" ${c.system ? 'disabled' : ''}>${ui.options(calcs, c.calc)}</select></label>
        <label class="field val-field"><span>Nilai default</span><input name="value" ${c.calc === 'percent' ? 'type="number" step="0.01"' : 'data-money inputmode="numeric"'} value="${c.calc === 'percent' ? c.value : ui.moneyVal(c.value)}" ${c.system ? 'disabled' : ''}></label>
        <label class="field"><span>Urutan tampil</span><input name="order" type="number" value="${c.order || 50}"></label>
      </div>
      <div class="grid-3">
        ${c.type === 'earning' ? `<label class="check"><input type="checkbox" name="fixed" ${c.fixed ? 'checked' : ''}><span>Pendapatan tetap (bukan variabel)</span></label><label class="check"><input type="checkbox" name="taxable" ${c.taxable !== false ? 'checked' : ''}><span>Objek PPh 21</span></label>` : ''}
        <label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}><span>Aktif</span></label>
      </div>
      <div class="grid-2">
        <fieldset class="panel"><legend>Berlaku untuk unit usaha</legend><p class="muted small">Kosongkan semua = berlaku semua unit.</p>
          ${Object.entries(C.EMP_UNITS).map(([k, l]) => `<label class="check"><input type="checkbox" name="units" data-multi value="${k}" ${c.units.includes(k) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>
        <fieldset class="panel"><legend>Berlaku untuk jabatan</legend><p class="muted small">Kosongkan semua = berlaku semua jabatan.</p>
          <div class="check-grid">${C.ALL_POSITIONS.map((p) => `<label class="check"><input type="checkbox" name="positions" data-multi value="${u.esc(p)}" ${c.positions.includes(p) ? 'checked' : ''}><span>${u.esc(p)}</span></label>`).join('')}</div></fieldset>
      </div>
      ${c.system ? '' : `<details class="panel" ${Object.keys(c.positionValues || {}).length ? 'open' : ''}><summary><b>Nilai berbeda per jabatan</b> <small class="muted">(opsional)</small></summary>
        <div class="grid-2">${C.ALL_POSITIONS.map((p) => `<label class="field field-row"><span>${u.esc(p)}</span><input data-pv="${u.esc(p)}" ${c.calc === 'percent' ? 'type="number" step="0.01"' : 'data-money inputmode="numeric"'} value="${c.positionValues[p] !== undefined ? (c.calc === 'percent' ? c.positionValues[p] : ui.moneyVal(c.positionValues[p])) : ''}" placeholder="Default"></label>`).join('')}</div></details>`}
      <div class="form-error" hidden></div>`;
    body.querySelector('[name=calc]').onchange = (e) => {
      const pct = e.target.value === 'percent';
      body.querySelectorAll('[name=value],[data-pv]').forEach((i) => {
        i.value = '';
        if (pct) {
          i.removeAttribute('data-money');
          i.type = 'number';
          i.step = '0.01';
        } else {
          i.type = 'text';
          i.setAttribute('data-money', '');
        }
      });
    };
    ui.modal({
      title: isNew ? 'Tambah Komponen ' + (c.type === 'earning' ? 'Pendapatan' : 'Potongan') : 'Edit Komponen — ' + c.name,
      size: 'lg',
      body,
      actions: [
        { label: 'Batal', cls: 'btn-ghost', onClick: (m) => m.close() },
        {
          label: 'Simpan', cls: 'btn-primary', onClick: async (m) => {
            const d = ui.formData(body);
            const err = body.querySelector('.form-error');
            const fail = (msg) => {
              err.hidden = false;
              err.textContent = msg;
            };
            if (!d.name || d.name.length < 3) return fail('Nama komponen wajib diisi.');
            const all = await NP.db.all('components');
            const code = (isNew ? d.code || d.name : c.code).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20);
            if (isNew && all.some((x) => x.code === code)) return fail('Kode komponen sudah digunakan.');
            const calc = c.system ? c.calc : d.calc;
            const val = c.system ? 0 : calc === 'percent' ? u.toNum(d.value) : u.toInt(d.value);
            if (val < 0) return fail('Nilai tidak boleh negatif.');
            if (calc === 'percent' && val > 100) return fail('Persentase maksimal 100%.');
            const pv = {};
            body.querySelectorAll('[data-pv]').forEach((i) => {
              if (i.value.trim() !== '') pv[i.dataset.pv] = calc === 'percent' ? u.toNum(i.value) : u.toInt(i.value);
            });
            Object.assign(c, { id: isNew ? code : c.id, code, name: d.name, group: d.group, calc, value: val, order: u.toNum(d.order) || 50, units: d.units || [], positions: d.positions || [], active: d.active, positionValues: c.system ? c.positionValues : pv });
            if (c.type === 'earning') {
              c.fixed = d.fixed;
              c.taxable = d.taxable;
            }
            await NP.db.put('components', c);
            await NP.audit.log(isNew ? 'component.create' : 'component.update', 'component', c.id, c.name + ' (' + D.CALC_LABELS[c.calc] + ')');
            await NP.loadComponents();
            m.close();
            ui.toast('Komponen disimpan.');
            onSaved && onSaved();
          }
        }
      ]
    });
  }

  async function drawSchemes(body) {
    const emps = await NP.emp.all();
    const canEdit = NP.sec.can('employees.edit');
    body.innerHTML = `<p class="muted">Setiap karyawan memiliki konfigurasi pembayaran masing-masing. Dokter, bidan, dan perawat dapat memakai gaji tetap, honor per sesi/pasien/shift/tindakan, persentase jasa pelayanan, atau kombinasi.</p><div id="sch-table"></div>`;
    ui.table(ui.$('#sch-table', body), {
      columns: [
        { key: 'name', label: 'Karyawan', render: (e) => `<b>${u.esc(e.name)}</b><small class="block muted">${u.esc(e.position)}</small>` },
        { key: 'unit', label: 'Unit', render: (e) => ui.unitBadge(e.unit) },
        { key: 'payScheme', label: 'Skema', render: (e) => u.esc((C.PAY_SCHEMES[e.payScheme] || {}).label) },
        { key: 'baseSalary', label: 'Gaji Pokok', align: 'right', render: (e) => ((C.PAY_SCHEMES[e.payScheme] || {}).useBase ? u.rp(e.baseSalary) : '<small class="muted">—</small>'), value: (e) => e.baseSalary },
        { key: 'rates', label: 'Tarif Honor', render: (e) => ((C.PAY_SCHEMES[e.payScheme] || { fields: [] }).fields.map((f) => `<small class="block">${C.RATE_LABELS[f]}: <b>${u.rp((e.payConfig || {})[f])}</b></small>`).join('') || '<small class="muted">—</small>'), sortable: false },
        { key: 'jasa', label: 'Jasa Pelayanan', render: (e) => (['dokter', 'bidan', 'perawat', 'farmasi'].includes(C.roleOfPosition(e.position)) ? '<small>Otomatis dari transaksi</small>' : '<small class="muted">Bila ada</small>'), sortable: false },
        { key: 'tax', label: 'BPJS / PPh', render: (e) => `<small>${e.bpjsKes ? 'Kes ' : ''}${e.bpjsTk ? 'TK ' : ''}${e.pph21 ? 'PPh(' + u.esc(e.ptkp) + ')' : ''}</small>`, sortable: false },
        { key: 'status', label: 'Status', render: (e) => ui.statusBadge(e.status) },
        { key: 'a', label: '', sortable: false, render: (e) => (canEdit ? `<button class="btn btn-sm btn-ghost" data-edit="${e.id}">${ui.icon('edit')}Atur</button>` : '') }
      ],
      rows: emps,
      sortKey: 'name',
      pageSize: 50
    });
    body.onclick = (ev) => {
      const b = ev.target.closest('[data-edit]');
      if (b) NP.emp.openForm(emps.find((e) => e.id === b.dataset.edit), () => drawSchemes(body));
    };
  }

  /* ===================== GENERATE PAYROLL (wizard) ===================== */
  async function renderGenerate(view, params) {
    const data = await pr.loadData();
    const prevPeriod = u.addMonths(u.todayISO().slice(0, 7), 0);
    let run;
    if (params.run) {
      run = await pr.get(params.run);
      if (!run) return (view.innerHTML = ui.empty('Penggajian tidak ditemukan.'));
      if (run.status !== 'draft') {
        view.innerHTML = `<div class="card">${ui.empty('Penggajian ' + run.id + ' berstatus ' + pr.statusLabel(run.status) + ' dan tidak dapat diubah.', 'lock')}<div class="center"><a class="btn btn-primary" href="#/payroll-history">Lihat Riwayat Penggajian</a></div></div>`;
        return;
      }
      run = u.clone(run);
    } else {
      const r = u.monthRange(prevPeriod);
      run = { id: '', period: prevPeriod, start: r.start, end: r.end, payDate: payDateFor(prevPeriod), unit: 'ALL', employeeIds: [], inputs: {}, includeEarlier: false, notes: '' };
    }
    const W = { step: params.run ? 2 : 1, run, preview: null };

    view.innerHTML = `
      <div class="page-head">
        <div><h2>Generate Payroll ${run.id ? '— ' + u.esc(run.id) : ''}</h2><p class="muted">Penggajian massal: ambil gaji pokok, tunjangan, jasa tindakan, bonus & potongan, lalu terbitkan slip gaji.</p></div>
        <div class="actions"><a class="btn btn-ghost" href="#/payroll-history">${ui.icon('archive')}<span>Riwayat Penggajian</span></a></div>
      </div>
      <ol class="stepper-nav" id="steps">
        <li data-s="1"><b>1</b><span>Periode & Karyawan</span></li>
        <li data-s="2"><b>2</b><span>Data Variabel & Rekonsiliasi</span></li>
        <li data-s="3"><b>3</b><span>Preview & Rekapitulasi</span></li>
        <li data-s="4"><b>4</b><span>Konfirmasi</span></li>
      </ol>
      <div class="card" id="wiz"></div>`;
    const wiz = ui.$('#wiz', view);

    function payDateFor(period) {
      const pd = u.toNum(NP.state.settings.payroll.payDay) || 1;
      const next = u.addMonths(period, 1);
      const last = +u.monthRange(next).end.slice(8);
      return next + '-' + u.pad(Math.min(pd, last));
    }
    function setStep(s) {
      W.step = s;
      ui.$$('#steps li', view).forEach((li) => {
        li.classList.toggle('active', +li.dataset.s === s);
        li.classList.toggle('done', +li.dataset.s < s);
      });
      [null, step1, step2, step3, step4][s]();
      wiz.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    /* ---- Langkah 1 ---- */
    function step1() {
      const r = W.run;
      const elig = pr.eligibleEmployees(data, r.unit);
      const conf = pr.conflicts(data, r);
      if (!r.employeeIds.length && !r.id) r.employeeIds = elig.filter((e) => !conf.has(e.id)).map((e) => e.id);
      wiz.innerHTML = `
        <div class="grid-4">
          <label class="field"><span>Periode penggajian</span><input type="month" name="period" value="${r.period}"></label>
          <label class="field"><span>Tanggal mulai</span><input type="date" name="start" value="${r.start}"></label>
          <label class="field"><span>Tanggal akhir</span><input type="date" name="end" value="${r.end}"></label>
          <label class="field"><span>Tanggal pembayaran</span><input type="date" name="payDate" value="${r.payDate}"></label>
          <label class="field"><span>Unit usaha</span><select name="unit">${ui.options([['ALL', 'Semua unit'], ['APT', 'Apotek Noura (+ lintas unit)'], ['KLINIK', 'Praktek Dokter Umum (+ lintas unit)']], r.unit)}</select></label>
          <label class="field span-3"><span>Catatan</span><input name="notes" value="${u.esc(r.notes || '')}" maxlength="200"></label>
        </div>
        <label class="check"><input type="checkbox" name="includeEarlier" ${r.includeEarlier ? 'checked' : ''}><span>Sertakan jasa dari periode sebelumnya yang belum pernah dibayar</span></label>
        <div class="card-head"><h3>Pilih karyawan <small class="muted" id="sel-count"></small></h3><div><button type="button" class="btn btn-sm btn-ghost" data-sel="all">Pilih semua</button><button type="button" class="btn btn-sm btn-ghost" data-sel="none">Kosongkan</button></div></div>
        <div class="emp-pick">${elig.map((e) => {
          const c = conf.get(e.id);
          return `<label class="pick ${c ? 'disabled' : ''}"><input type="checkbox" value="${e.id}" ${r.employeeIds.includes(e.id) && !c ? 'checked' : ''} ${c ? 'disabled' : ''}><span><b>${u.esc(e.name)}</b><small>${u.esc(e.position)} · ${u.esc((C.PAY_SCHEMES[e.payScheme] || {}).label)}</small>${c ? `<small class="text-warning">Sudah di ${c}</small>` : ''}</span>${ui.unitBadge(e.unit)}</label>`;
        }).join('') || ui.empty('Tidak ada karyawan aktif pada unit ini.')}</div>
        <div class="wiz-foot"><span></span><button class="btn btn-primary" data-next>${ui.icon('play')}<span>Lanjut: Data Variabel</span></button></div>`;
      const q = (n) => wiz.querySelector(`[name=${n}]`);
      const count = () => (wiz.querySelector('#sel-count').textContent = '(' + wiz.querySelectorAll('.emp-pick input:checked').length + ' dipilih)');
      count();
      q('period').onchange = () => {
        const p = q('period').value;
        if (!p) return;
        const rr = u.monthRange(p);
        r.period = p;
        r.start = rr.start;
        r.end = rr.end;
        r.payDate = payDateFor(p);
        if (!r.id) r.employeeIds = [];
        step1();
      };
      q('unit').onchange = () => {
        r.unit = q('unit').value;
        r.employeeIds = [];
        step1();
      };
      wiz.querySelector('.emp-pick').onchange = count;
      wiz.querySelectorAll('[data-sel]').forEach((b) => (b.onclick = () => {
        wiz.querySelectorAll('.emp-pick input:not(:disabled)').forEach((i) => (i.checked = b.dataset.sel === 'all'));
        count();
      }));
      wiz.querySelector('[data-next]').onclick = () => {
        r.start = q('start').value;
        r.end = q('end').value;
        r.payDate = q('payDate').value;
        r.notes = q('notes').value;
        r.includeEarlier = q('includeEarlier').checked;
        r.employeeIds = [...wiz.querySelectorAll('.emp-pick input:checked')].map((i) => i.value);
        if (!r.start || !r.end || r.start > r.end) return ui.toast('Rentang tanggal tidak valid.', 'error');
        if (r.start.slice(0, 7) !== r.period && r.end.slice(0, 7) !== r.period) return ui.toast('Rentang tanggal harus berada pada periode yang dipilih.', 'error');
        if (!r.employeeIds.length) return ui.toast('Pilih minimal satu karyawan.', 'error');
        setStep(2);
      };
    }

    /* ---- Langkah 2 ---- */
    const GRID = [
      ['presentDays', 'Hadir', 'num'], ['absentDays', 'Absen', 'num'], ['lateCount', 'Telat', 'num'], ['overtimeHours', 'Lembur (jam)', 'num'],
      ['shifts', 'Shift', 'num'], ['sessions', 'Sesi', 'num'], ['patients', 'Pasien', 'num'], ['actions', 'Tindakan', 'num'],
      ['salesActual', 'Penjualan', 'money'], ['m:BONUS', 'Bonus', 'money'], ['m:INSENTIF', 'Insentif', 'money'], ['m:KASBON', 'Kasbon', 'money'], ['m:PINJAMAN', 'Pinjaman', 'money']
    ];
    function step2() {
      const r = W.run;
      const lines = NP.income.lines(data.trxs, { start: r.start, end: r.end, runId: r.id, includeEarlier: r.includeEarlier, onlyEligible: true });
      const adjs = NP.income.adjustments(data.trxs, { runId: r.id, end: r.end });
      const allLines = NP.income.lines(data.trxs, { start: r.start, end: r.end });
      const emps = r.employeeIds.map((id) => data.emps.get(id)).filter(Boolean);
      const empComp = (e, code) => NP.calc.componentApplies(data.components.find((c) => c.code === code) || { active: false }, e);
      let eligibleTotal = 0, earlierTotal = 0, takenElsewhere = 0, adjTotal = 0, notSelected = 0;
      for (const [id, ls] of lines) {
        const sel = r.employeeIds.includes(id);
        for (const l of ls) {
          if (!sel) {
            if (!l.earlier) notSelected += l.amount;
            continue;
          }
          eligibleTotal += l.amount;
          if (l.earlier) earlierTotal += l.amount;
        }
      }
      for (const ls of allLines.values()) for (const l of ls) if (l.runId && l.runId !== r.id) takenElsewhere += l.amount;
      for (const [id, a] of adjs) if (r.employeeIds.includes(id)) adjTotal += u.sum(a, (x) => x.amount);
      const cancelled = data.trxs.filter((t) => t.status === 'cancelled' && u.inRange(t.date, r.start, r.end));

      wiz.innerHTML = `
        ${r.stale ? `<div class="alert alert-warning">${ui.icon('warn')}<div>Draft ini perlu dihitung ulang: ${u.esc(r.staleReason || 'data berubah')}.</div></div>` : ''}
        <div class="recon-mini">
          <div>${ui.icon('check')}<span>Jasa tindakan yang akan diproses</span><b>${u.rp(eligibleTotal)}</b>${earlierTotal ? `<small>termasuk ${u.rp(earlierTotal)} dari periode sebelumnya</small>` : ''}</div>
          <div>${ui.icon('lock')}<span>Sudah diproses di penggajian lain (dikecualikan)</span><b>${u.rp(takenElsewhere)}</b></div>
          <div>${ui.icon('x')}<span>Transaksi dibatalkan (tidak dihitung)</span><b>${cancelled.length} transaksi</b></div>
          <div>${ui.icon('refresh')}<span>Koreksi jasa tertunda</span><b>${u.rp(adjTotal)}</b></div>
          ${notSelected ? `<div class="warn">${ui.icon('warn')}<span>Jasa milik karyawan yang tidak dipilih</span><b>${u.rp(notSelected)}</b></div>` : ''}
        </div>
        <p class="muted small">Nilai abu-abu diisi otomatis (hari kerja ${data.settings.payroll.workDays}, shift/sesi dari catatan harian, pasien & tindakan dari transaksi). Ubah sel bila perlu — sel yang diubah ditandai. Klik ${ui.icon('edit')} untuk komponen manual lain.</p>
        <div class="table-wrap grid-input-wrap"><table class="tbl tbl-grid"><thead><tr><th class="sticky-col">Karyawan</th><th class="ta-right">Jasa</th>${GRID.map((g) => `<th class="ta-right">${g[1]}</th>`).join('')}<th></th></tr></thead><tbody>
        ${emps.map((e) => {
          const inp = pr.inputsFor(e, data, r);
          const ov = r.inputs[e.id] || {};
          const svc = u.sum(lines.get(e.id) || [], (l) => l.amount) + u.sum(adjs.get(e.id) || [], (a) => a.amount);
          const sch = C.PAY_SCHEMES[e.payScheme] || { fields: [] };
          const relevant = {
            shifts: sch.fields.includes('shiftRate') || empComp(e, 'T_SHIFT'), sessions: sch.fields.includes('sessionRate'), patients: sch.fields.includes('patientRate'), actions: sch.fields.includes('actionRate'),
            salesActual: !!e.salesTarget && empComp(e, 'BONUS_SALES'), overtimeHours: empComp(e, 'LEMBUR')
          };
          return `<tr data-emp="${e.id}"><td class="sticky-col"><b>${u.esc(e.name)}</b><small class="block muted">${u.esc(e.position)}</small></td><td class="ta-right"><b>${u.rp(svc)}</b><small class="block muted">${(lines.get(e.id) || []).length} baris</small></td>
            ${GRID.map(([k, , type]) => {
              const isM = k.startsWith('m:');
              const key = isM ? k.slice(2) : k;
              const val = isM ? inp.manual[key] : inp[k];
              const edited = isM ? ov.manual && ov.manual[key] !== undefined : ov[k] !== undefined;
              const dim = relevant[k] === false;
              const shown = val === undefined || val === null || val === '' ? (isM ? defaultManual(e, key) : 0) : val;
              return `<td class="${edited ? 'edited' : ''} ${dim ? 'dim' : ''}"><input data-k="${k}" ${type === 'money' ? 'data-money inputmode="numeric"' : 'type="number" min="0" step="' + (k === 'overtimeHours' ? '0.5' : '1') + '"'} value="${type === 'money' ? ui.moneyVal(shown) : shown}" aria-label="${k}">${k === 'salesActual' && e.salesTarget ? `<small class="block muted">target ${ui.rpTick(e.salesTarget)}</small>` : ''}</td>`;
            }).join('')}
            <td><button type="button" class="icon-btn" data-more="${e.id}" title="Komponen lainnya">${ui.icon('edit')}</button><button type="button" class="icon-btn" data-reset="${e.id}" title="Kembalikan otomatis">${ui.icon('refresh')}</button></td></tr>`;
        }).join('')}
        </tbody></table></div>
        <div class="wiz-foot"><button class="btn btn-ghost" data-back>‹ Kembali</button><button class="btn btn-primary" data-next>${ui.icon('play')}<span>Hitung & Preview</span></button></div>`;

      function defaultManual(e, code) {
        const c = data.components.find((x) => x.code === code);
        return c ? NP.calc.componentValue(c, e) : 0;
      }
      wiz.querySelector('tbody').addEventListener('change', (ev) => {
        const inp = ev.target.closest('[data-k]');
        if (!inp) return;
        const id = inp.closest('tr').dataset.emp;
        const k = inp.dataset.k;
        const o = (r.inputs[id] = r.inputs[id] || {});
        const v = inp.hasAttribute('data-money') ? u.toInt(inp.value) : Math.max(0, u.toNum(inp.value));
        if (k.startsWith('m:')) (o.manual = o.manual || {})[k.slice(2)] = v;
        else o[k] = v;
        if (k === 'absentDays' && o.presentDays === undefined) {
          const e = data.emps.get(id);
          const pd = Math.max(0, pr.autoInputs(e, data, r).workDays - v);
          inp.closest('tr').querySelector('[data-k=presentDays]').value = pd;
        }
        inp.closest('td').classList.add('edited');
      });
      wiz.querySelector('tbody').addEventListener('click', (ev) => {
        const m = ev.target.closest('[data-more]');
        if (m) moreInputs(data.emps.get(m.dataset.more));
        const rs_ = ev.target.closest('[data-reset]');
        if (rs_) {
          delete r.inputs[rs_.dataset.reset];
          step2();
        }
      });
      wiz.querySelector('[data-back]').onclick = () => setStep(1);
      wiz.querySelector('[data-next]').onclick = () => {
        W.preview = pr.compute(r, data);
        setStep(3);
      };
    }

    function moreInputs(e) {
      const r = W.run;
      const inp = pr.inputsFor(e, data, r);
      const manuals = data.components.filter((c) => c.calc === 'manual' && NP.calc.componentApplies(c, e));
      const body = `<div class="grid-2">
        <label class="field"><span>Hari kerja periode</span><input type="number" name="workDays" min="0" value="${inp.workDays}"></label>
        <label class="field"><span>Target penjualan</span><input name="salesTarget" data-money value="${ui.moneyVal(inp.salesTarget)}"></label>
        ${data.settings.salesBonus.method === 'manual' ? `<label class="field"><span>Bonus target penjualan (manual)</span><input name="m:BONUS_SALES" data-money value="${ui.moneyVal(inp.manual.BONUS_SALES || 0)}"></label>` : ''}
        ${manuals.map((c) => `<label class="field"><span>${u.esc(c.name)} <small class="muted">(${c.type === 'earning' ? 'pendapatan' : 'potongan'})</small></span><input name="m:${c.code}" data-money value="${ui.moneyVal(inp.manual[c.code] !== undefined ? inp.manual[c.code] : NP.calc.componentValue(c, e))}"></label>`).join('')}
        <label class="field span-2"><span>Catatan untuk slip</span><input name="slipNote" value="${u.esc((r.inputs[e.id] || {}).slipNote || '')}" maxlength="120"></label>
      </div>`;
      ui.modal({
        title: 'Komponen manual — ' + e.name,
        body,
        actions: [
          { label: 'Batal', cls: 'btn-ghost', onClick: (m) => m.close() },
          {
            label: 'Terapkan', cls: 'btn-primary', onClick: (m) => {
              const o = (r.inputs[e.id] = r.inputs[e.id] || {});
              o.manual = o.manual || {};
              m.el.querySelectorAll('[name]').forEach((i) => {
                if (i.name.startsWith('m:')) o.manual[i.name.slice(2)] = u.toInt(i.value);
                else if (i.name === 'slipNote') o.slipNote = i.value.trim();
                else o[i.name] = i.hasAttribute('data-money') ? u.toInt(i.value) : u.toNum(i.value);
              });
              m.close();
              step2();
            }
          }
        ]
      });
    }

    /* ---- Langkah 3 ---- */
    function step3() {
      const { slips, totals } = W.preview;
      const warns = [];
      slips.forEach((s) => s.warnings.forEach((w) => warns.push(s.employee.name + ': ' + w)));
      wiz.innerHTML = `
        <div class="stats-row">
          ${ui.stat('Karyawan', u.num(totals.count), { icon: 'users' })}
          ${ui.stat('Total pendapatan (bruto)', u.rp(totals.gross), { icon: 'wallet', sub: 'Tetap ' + u.rp(totals.fixed) + ' · Variabel ' + u.rp(totals.variable) })}
          ${ui.stat('Total potongan', u.rp(totals.deductions), { icon: 'x' })}
          ${ui.stat('Total gaji bersih', u.rp(totals.net), { icon: 'check', cls: 'stat-green' })}
        </div>
        <div class="grid-2 recap-grid">
          <div class="panel"><h4>Rekapitulasi komponen</h4>
            ${[['Gaji pokok', totals.base], ['Tunjangan', totals.allowance], ['Lembur', totals.overtime], ['Bonus', totals.bonus], ['Insentif', totals.incentive], ['Honor praktik', totals.practice], ['Jasa pelayanan', totals.service], ['Pendapatan lainnya', totals.other]].map(([l, v]) => `<div class="kv"><span>${l}</span><b>${u.rp(v)}</b></div>`).join('')}
            <div class="kv"><span>BPJS (karyawan)</span><b>-${u.rp(totals.bpjs)}</b></div><div class="kv"><span>PPh 21</span><b>-${u.rp(totals.tax)}</b></div>
            <div class="kv"><span>Potongan lain</span><b>-${u.rp(totals.deductions - totals.bpjs - totals.tax)}</b></div>
            <div class="kv"><span>Iuran BPJS pemberi kerja (info)</span><b>${u.rp(totals.employerContrib)}</b></div></div>
          <div class="panel"><h4>Alokasi biaya per unit</h4>
            <div class="kv"><span>Apotek Noura — bruto</span><b>${u.rp(totals.alloc.APT.gross)}</b></div><div class="kv"><span>Apotek Noura — bersih</span><b>${u.rp(totals.alloc.APT.net)}</b></div>
            <div class="kv"><span>Praktek Dokter Umum — bruto</span><b>${u.rp(totals.alloc.KLINIK.gross)}</b></div><div class="kv"><span>Praktek Dokter Umum — bersih</span><b>${u.rp(totals.alloc.KLINIK.net)}</b></div>
            <p class="muted small">Karyawan lintas unit dihitung satu kali; biayanya dibagi sesuai persentase beban unit.</p></div>
        </div>
        ${warns.length ? `<div class="alert alert-warning">${ui.icon('warn')}<div>${warns.map(u.esc).join('<br>')}</div></div>` : ''}
        <div id="prev-table"></div>
        <div class="wiz-foot"><button class="btn btn-ghost" data-back>‹ Ubah data variabel</button><button class="btn btn-primary" data-next>Lanjut: Konfirmasi ›</button></div>`;
      ui.table(ui.$('#prev-table', wiz), {
        columns: [
          { key: 'name', label: 'Karyawan', render: (s) => `<b>${u.esc(s.employee.name)}</b><small class="block muted">${u.esc(s.employee.position)}</small>`, value: (s) => s.employee.name },
          { key: 'base', label: 'Gaji Pokok', align: 'right', render: (s) => u.rp(s.totals.base), value: (s) => s.totals.base },
          { key: 'allow', label: 'Tunjangan', align: 'right', render: (s) => u.rp(s.totals.allowance + s.totals.overtime), value: (s) => s.totals.allowance },
          { key: 'svc', label: 'Jasa & Honor', align: 'right', render: (s) => u.rp(s.totals.service + s.totals.practice), value: (s) => s.totals.service + s.totals.practice },
          { key: 'bonus', label: 'Bonus & Insentif', align: 'right', render: (s) => u.rp(s.totals.bonus + s.totals.incentive + s.totals.other), value: (s) => s.totals.bonus + s.totals.incentive },
          { key: 'gross', label: 'Bruto', align: 'right', render: (s) => u.rp(s.totals.gross), value: (s) => s.totals.gross },
          { key: 'ded', label: 'Potongan', align: 'right', render: (s) => u.rp(s.totals.deductions), value: (s) => s.totals.deductions },
          { key: 'net', label: 'Gaji Bersih', align: 'right', render: (s) => `<b class="${s.totals.net < 0 ? 'text-danger' : ''}">${u.rp(s.totals.net)}</b>`, value: (s) => s.totals.net },
          { key: 'a', label: '', sortable: false, render: (s) => `<button class="btn btn-sm btn-ghost" data-slip="${s.employeeId}">${ui.icon('eye')}Slip</button>` }
        ],
        rows: slips,
        sortKey: 'name',
        noPaging: true,
        footer: () => `<tr><th>Total</th><th class="ta-right">${u.rp(totals.base)}</th><th class="ta-right">${u.rp(totals.allowance + totals.overtime)}</th><th class="ta-right">${u.rp(totals.service + totals.practice)}</th><th class="ta-right">${u.rp(totals.bonus + totals.incentive + totals.other)}</th><th class="ta-right">${u.rp(totals.gross)}</th><th class="ta-right">${u.rp(totals.deductions)}</th><th class="ta-right">${u.rp(totals.net)}</th><th></th></tr>`
      });
      wiz.onclick = (e) => {
        const b = e.target.closest('[data-slip]');
        if (b) NP.slip.previewModal(Object.assign({}, W.run, { slips }), slips.find((s) => s.employeeId === b.dataset.slip), { draft: true });
      };
      wiz.querySelector('[data-back]').onclick = () => setStep(2);
      wiz.querySelector('[data-next]').onclick = () => setStep(4);
    }

    /* ---- Langkah 4 ---- */
    function step4() {
      const r = W.run;
      const t = W.preview.totals;
      const canApprove = NP.sec.can('payroll.approve');
      wiz.innerHTML = `
        <div class="confirm-box">
          <h3>Konfirmasi Penggajian ${u.esc(u.periodLabel(r.period))}</h3>
          <div class="grid-3">
            <div class="kv"><span>Periode</span><b>${u.fmtDate(r.start)} – ${u.fmtDate(r.end)}</b></div>
            <div class="kv"><span>Tanggal pembayaran</span><b>${u.fmtDate(r.payDate, 'long')}</b></div>
            <div class="kv"><span>Unit</span><b>${r.unit === 'ALL' ? 'Semua unit' : C.UNITS[r.unit].name}</b></div>
            <div class="kv"><span>Jumlah karyawan</span><b>${t.count}</b></div>
            <div class="kv"><span>Total bruto</span><b>${u.rp(t.gross)}</b></div>
            <div class="kv"><span>Total gaji bersih</span><b class="text-success">${u.rp(t.net)}</b></div>
          </div>
          <ul class="muted small">
            <li><b>Simpan sebagai draft</b>: angka dapat diubah dan dihitung ulang. Jasa tindakan dipesan untuk penggajian ini sehingga tidak diproses ganda.</li>
            <li><b>Setujui & terbitkan slip</b>: nomor slip diterbitkan; data tidak dapat diubah kecuali dikembalikan ke draft.</li>
            <li>Setelah disetujui, Administrator dapat <b>mengunci</b> penggajian agar tidak berubah secara tidak sengaja.</li>
          </ul>
        </div>
        <div class="wiz-foot">
          <button class="btn btn-ghost" data-back>‹ Kembali ke preview</button>
          <div class="btn-group">
            <button class="btn btn-ghost" data-save>${ui.icon('archive')}<span>Simpan Draft</span></button>
            ${canApprove ? `<button class="btn btn-primary" data-approve>${ui.icon('check')}<span>Setujui & Terbitkan Slip</span></button>` : ''}
          </div>
        </div>`;
      wiz.querySelector('[data-back]').onclick = () => setStep(3);
      wiz.querySelector('[data-save]').onclick = async () => {
        try {
          const saved = await pr.saveDraft(W.run);
          ui.toast('Draft ' + saved.id + ' tersimpan.');
          NP.go('payroll-history', { open: saved.id });
        } catch (e) {
          ui.toast(e.message, 'error');
        }
      };
      const ap = wiz.querySelector('[data-approve]');
      if (ap)
        ap.onclick = async () => {
          if (!(await ui.confirm({ title: 'Setujui penggajian', message: 'Setujui penggajian ' + u.periodLabel(r.period) + ' untuk ' + t.count + ' karyawan dengan total gaji bersih ' + u.rp(t.net) + '? Slip gaji akan diterbitkan.', okLabel: 'Setujui' }))) return;
          try {
            const saved = await pr.saveDraft(W.run, { note: 'disetujui langsung' });
            const ok = await pr.approve(saved.id);
            ui.toast('Penggajian ' + ok.id + ' disetujui. ' + ok.slips.length + ' slip gaji diterbitkan.');
            NP.go('payslips', { run: ok.id });
          } catch (e) {
            ui.toast(e.message, 'error');
          }
        };
    }

    setStep(W.step);
  }

  /* ===================== RIWAYAT PENGGAJIAN ===================== */
  async function renderHistory(view, params) {
    const runs = await pr.runs();
    view.innerHTML = `
      <div class="page-head">
        <div><h2>Riwayat Penggajian</h2><p class="muted">Seluruh periode penggajian beserta status draft, disetujui, dan terkunci.</p></div>
        <div class="actions">${NP.sec.can('payroll.run') ? `<a class="btn btn-primary" href="#/generate">${ui.icon('play')}<span>Generate Payroll</span></a>` : ''}</div>
      </div>
      <div class="card"><div id="run-list"></div></div>`;
    ui.table(ui.$('#run-list', view), {
      columns: [
        { key: 'id', label: 'No. Penggajian', render: (r) => `<b>${u.esc(r.id)}</b>${r.stale ? '<br>' + ui.statusBadge('stale') : ''}` },
        { key: 'period', label: 'Periode', render: (r) => `${u.periodLabel(r.period)}<small class="block muted">${u.fmtDate(r.start)} – ${u.fmtDate(r.end)}</small>` },
        { key: 'unit', label: 'Unit', render: (r) => (r.unit === 'ALL' ? 'Semua' : ui.unitBadge(r.unit)) },
        { key: 'count', label: 'Karyawan', align: 'right', render: (r) => r.slips.length, value: (r) => r.slips.length },
        { key: 'gross', label: 'Bruto', align: 'right', render: (r) => u.rp(r.totals.gross), value: (r) => r.totals.gross },
        { key: 'ded', label: 'Potongan', align: 'right', render: (r) => u.rp(r.totals.deductions), value: (r) => r.totals.deductions },
        { key: 'net', label: 'Gaji Bersih', align: 'right', render: (r) => `<b>${u.rp(r.totals.net)}</b>`, value: (r) => r.totals.net },
        { key: 'status', label: 'Status', render: (r) => ui.statusBadge(r.status) + `<small class="block muted">${r.status === 'locked' ? 'oleh ' + u.esc(r.lockedBy) + ' ' + u.fmtDate(u.todayISO(new Date(r.lockedAt))) : r.status === 'approved' ? 'oleh ' + u.esc(r.approvedBy) : 'dibuat ' + u.esc(r.createdBy)}</small>` },
        { key: 'a', label: '', sortable: false, align: 'right', render: (r) => `<button class="btn btn-sm btn-ghost" data-open="${r.id}">${ui.icon('eye')}Kelola</button>` }
      ],
      rows: runs,
      sortKey: 'period',
      sortDir: 'desc',
      empty: 'Belum ada penggajian. Mulai dengan Generate Payroll.'
    });
    view.addEventListener('click', (e) => {
      const b = e.target.closest('[data-open]');
      if (b) openRun(b.dataset.open);
    });
    if (params.open) openRun(params.open);
  }

  async function openRun(id) {
    const run = await pr.get(id);
    if (!run) return;
    const canLock = NP.sec.can('payroll.lock');
    const canApprove = NP.sec.can('payroll.approve');
    const acts = [];
    const m = ui.modal({
      title: 'Penggajian ' + run.id + ' — ' + u.periodLabel(run.period),
      size: 'xl',
      body: `<div class="run-head">${ui.statusBadge(run.status)} ${run.stale ? ui.statusBadge('stale') : ''}
          <span>Periode ${u.fmtDate(run.start)} – ${u.fmtDate(run.end)}</span><span>Bayar ${u.fmtDate(run.payDate)}</span><span>${run.slips.length} karyawan</span></div>
        <div class="stats-row compact">${ui.stat('Bruto', u.rp(run.totals.gross))}${ui.stat('Potongan', u.rp(run.totals.deductions))}${ui.stat('Gaji bersih', u.rp(run.totals.net), { cls: 'stat-green' })}${ui.stat('Jasa pelayanan', u.rp(run.totals.service))}</div>
        <div class="action-bar">
          ${run.status === 'draft' && NP.sec.can('payroll.run') ? `<a class="btn btn-sm btn-ghost" href="#/generate?run=${run.id}">${ui.icon('edit')}Ubah data</a><button class="btn btn-sm btn-ghost" data-r="recalc">${ui.icon('refresh')}Hitung ulang</button>` : ''}
          ${run.status === 'draft' && canApprove ? `<button class="btn btn-sm btn-primary" data-r="approve">${ui.icon('check')}Setujui & terbitkan slip</button>` : ''}
          ${run.status === 'draft' && NP.sec.can('payroll.run') ? `<button class="btn btn-sm btn-ghost danger" data-r="delete">${ui.icon('trash')}Hapus draft</button>` : ''}
          ${run.status === 'approved' && canLock ? `<button class="btn btn-sm btn-primary" data-r="lock">${ui.icon('lock')}Kunci penggajian</button>` : ''}
          ${run.status === 'approved' && canApprove ? `<button class="btn btn-sm btn-ghost" data-r="revert">${ui.icon('refresh')}Kembalikan ke draft</button>` : ''}
          ${run.status === 'locked' && canLock ? `<button class="btn btn-sm btn-ghost" data-r="unlock">${ui.icon('unlock')}Buka kunci</button>` : ''}
          ${run.status !== 'draft' ? `<button class="btn btn-sm btn-ghost" data-r="slips">${ui.icon('slip')}Slip gaji</button><button class="btn btn-sm btn-ghost" data-r="printall">${ui.icon('print')}Cetak semua slip</button><button class="btn btn-sm btn-ghost" data-r="zip">${ui.icon('zip')}ZIP semua slip</button>` : ''}
          <button class="btn btn-sm btn-ghost" data-r="xls">${ui.icon('excel')}Rekap Excel</button>
          <button class="btn btn-sm btn-ghost" data-r="pdf">${ui.icon('pdf')}Rekap PDF</button>
        </div>
        <div id="run-slips"></div>
        <details class="panel"><summary><b>Riwayat status</b></summary><div class="audit-list">${(run.history || []).slice().reverse().map((h) => `<div class="audit-item"><small>${u.fmtDateTime(h.ts)} · ${u.esc(h.by)}</small><div><b>${u.esc(h.action)}</b> ${u.esc(h.note || '')}</div></div>`).join('')}</div></details>`,
      actions: [{ label: 'Tutup', cls: 'btn-ghost', onClick: (mm) => mm.close() }]
    });
    ui.table(ui.$('#run-slips', m.el), {
      columns: [
        { key: 'no', label: 'No. Slip', render: (s) => u.esc(s.slipNo || '(draft)') },
        { key: 'name', label: 'Karyawan', render: (s) => `<b>${u.esc(s.employee.name)}</b><small class="block muted">${u.esc(s.employee.position)}</small>`, value: (s) => s.employee.name },
        { key: 'gross', label: 'Bruto', align: 'right', render: (s) => u.rp(s.totals.gross), value: (s) => s.totals.gross },
        { key: 'svc', label: 'Jasa', align: 'right', render: (s) => u.rp(s.totals.service), value: (s) => s.totals.service },
        { key: 'ded', label: 'Potongan', align: 'right', render: (s) => u.rp(s.totals.deductions), value: (s) => s.totals.deductions },
        { key: 'net', label: 'Bersih', align: 'right', render: (s) => `<b>${u.rp(s.totals.net)}</b>`, value: (s) => s.totals.net },
        { key: 'a', label: '', sortable: false, render: (s) => `<button class="btn btn-sm btn-ghost" data-pv="${s.employeeId}">${ui.icon('eye')}Slip</button>` }
      ],
      rows: run.slips,
      sortKey: 'name',
      pageSize: 50
    });
    m.el.addEventListener('click', async (e) => {
      const pv = e.target.closest('[data-pv]');
      if (pv) return NP.slip.previewModal(run, run.slips.find((s) => s.employeeId === pv.dataset.pv), { draft: run.status === 'draft' });
      const b = e.target.closest('[data-r]');
      if (!b) return;
      const after = async (msg) => {
        ui.toast(msg);
        m.close(true);
        await NP.refresh();
        if (!/dihapus/.test(msg)) openRun(id);
      };
      try {
        switch (b.dataset.r) {
          case 'recalc':
            await pr.saveDraft(run);
            return after('Draft dihitung ulang dengan data terbaru.');
          case 'approve':
            if (run.stale) await pr.saveDraft(run);
            if (!(await ui.confirm('Setujui penggajian ' + run.id + ' dan terbitkan slip gaji?'))) return;
            await pr.approve(run.id);
            return after('Penggajian disetujui. Slip gaji terbit.');
          case 'delete':
            if (!(await ui.confirm({ message: 'Hapus draft ' + run.id + '? Jasa tindakan yang dipesan akan dilepas kembali.', danger: true, okLabel: 'Hapus' }))) return;
            await pr.remove(run.id);
            return after('Draft dihapus.');
          case 'lock':
            if (!(await ui.confirm('Kunci penggajian ' + run.id + '? Data tidak dapat diubah; koreksi transaksi setelahnya memerlukan otorisasi administrator.'))) return;
            await pr.lock(run.id);
            return after('Penggajian dikunci.');
          case 'revert':
            if (!(await ui.confirm('Kembalikan ' + run.id + ' ke draft? Nomor slip tetap dipertahankan.'))) return;
            await pr.revert(run.id);
            return after('Penggajian dikembalikan ke draft.');
          case 'unlock': {
            const auth = await NP.sec.authorize('Membuka kunci penggajian ' + run.id + '.');
            if (!auth) return;
            await pr.unlock(run.id, auth);
            return after('Kunci penggajian dibuka.');
          }
          case 'slips':
            m.close(true);
            return NP.go('payslips', { run: run.id });
          case 'printall':
            return NP.slip.printAll(run);
          case 'zip':
            return NP.slip.zipAll(run);
          case 'xls':
            return exportRunExcel(run);
          case 'pdf':
            return exportRunPdf(run);
        }
      } catch (err) {
        ui.toast(err.message, 'error');
      }
    });
  }
  pr.openRun = openRun;

  function exportRunExcel(run) {
    const codes = [];
    run.slips.forEach((s) => s.earnings.concat(s.deductions).forEach((l) => {
      const k = (s.earnings.includes(l) ? 'E:' : 'D:') + l.name;
      if (!codes.includes(k)) codes.push(k);
    }));
    const rows = run.slips.map((s) => {
      const r = { 'No. Slip': s.slipNo || '', 'ID Karyawan': s.employee.id, Nama: s.employee.name, Jabatan: s.employee.position, Unit: C.EMP_UNITS[s.employee.unit] };
      codes.filter((c) => c.startsWith('E:')).forEach((c) => (r[c.slice(2)] = u.sum(s.earnings.filter((e) => e.name === c.slice(2)), (e) => e.amount)));
      r['Total Pendapatan'] = s.totals.gross;
      codes.filter((c) => c.startsWith('D:')).forEach((c) => (r['(-) ' + c.slice(2)] = u.sum(s.deductions.filter((e) => e.name === c.slice(2)), (e) => e.amount)));
      r['Total Potongan'] = s.totals.deductions;
      r['Gaji Bersih'] = s.totals.net;
      r['Beban Apotek'] = s.allocation.APT.gross;
      r['Beban Praktek'] = s.allocation.KLINIK.gross;
      r.Bank = s.employee.bankName || '';
      r.Rekening = s.employee.bankAccountMasked;
      return r;
    });
    const jasa = [];
    run.slips.forEach((s) => s.serviceDetail.forEach((d) => jasa.push({ Nama: s.employee.name, Tindakan: d.serviceName, 'Jumlah Transaksi': d.count, 'Jumlah Tindakan': d.qty, 'Jasa per Tindakan': d.unitAmount, Total: d.amount })));
    NP.exp.excel([{ name: 'Rekap Gaji', rows }, { name: 'Rincian Jasa', rows: jasa }], 'rekap-gaji-' + run.id + '.xlsx');
  }

  function exportRunPdf(run) {
    const t = run.totals;
    NP.exp.pdfTable({
      title: 'Rekapitulasi Penggajian ' + u.periodLabel(run.period),
      subtitle: run.id + ' · ' + u.fmtDate(run.start) + ' – ' + u.fmtDate(run.end) + ' · Status: ' + pr.statusLabel(run.status),
      unit: run.unit === 'KLINIK' ? 'KLINIK' : 'APT',
      orientation: 'landscape',
      head: ['No. Slip', 'Nama', 'Jabatan', 'Gaji Pokok', 'Tunjangan', 'Jasa & Honor', 'Bonus/Insentif', 'Bruto', 'Potongan', 'Gaji Bersih'],
      body: run.slips.map((s) => [s.slipNo || '-', s.employee.name, s.employee.position, u.rp(s.totals.base), u.rp(s.totals.allowance + s.totals.overtime), u.rp(s.totals.service + s.totals.practice), u.rp(s.totals.bonus + s.totals.incentive + s.totals.other), u.rp(s.totals.gross), u.rp(s.totals.deductions), u.rp(s.totals.net)]),
      foot: [['TOTAL', '', '', u.rp(t.base), u.rp(t.allowance + t.overtime), u.rp(t.service + t.practice), u.rp(t.bonus + t.incentive + t.other), u.rp(t.gross), u.rp(t.deductions), u.rp(t.net)]],
      numericCols: [3, 4, 5, 6, 7, 8, 9],
      signatures: true,
      filename: 'rekap-gaji-' + run.id + '.pdf'
    });
  }

  NP.pages.payroll = { title: 'Penggajian', render: renderPayroll };
  NP.pages.generate = { title: 'Generate Payroll', render: renderGenerate };
  NP.pages['payroll-history'] = { title: 'Riwayat Penggajian', render: renderHistory };
})(typeof globalThis !== 'undefined' ? globalThis : window);
