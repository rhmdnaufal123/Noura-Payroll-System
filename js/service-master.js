/* Noura Payroll — MASTER TINDAKAN & PELAYANAN.
 * Admin dapat menambah tindakan baru beserta harga dan pembagian pendapatan tanpa mengubah kode. */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;
  const C = NP.C;
  const rs = NP.rs;

  /* ===================== Data ===================== */
  const svc = {};
  svc.all = async () => (await NP.db.all('services')).sort((a, b) => a.code.localeCompare(b.code));
  svc.active = async () => (await svc.all()).filter((s) => s.active);

  svc.blank = () => ({
    id: '', code: '', name: '', category: C.SERVICE_CATEGORIES[0], unit: 'APT', price: 0, method: 'nominal',
    shares: [{ type: 'unit', target: 'APT', mode: 'nominal', value: 0 }, { type: 'role', target: 'bidan', mode: 'nominal', value: 0 }],
    doctorShares: [], overrides: [], active: true, notes: ''
  });

  svc.validate = function (s, list) {
    const errs = [];
    if (!s.name || s.name.trim().length < 3) errs.push('Nama tindakan wajib diisi (min. 3 karakter).');
    if (!C.SERVICE_CATEGORIES.includes(s.category)) errs.push('Kategori tindakan wajib dipilih.');
    if (!C.UNITS[s.unit]) errs.push('Unit usaha wajib dipilih.');
    if (!(u.toInt(s.price) > 0)) errs.push('Harga jual harus lebih dari 0.');
    if (!s.shares || !s.shares.length) errs.push('Minimal satu penerima pendapatan.');
    if (list && list.some((x) => x.id !== s.id && x.name.trim().toLowerCase() === s.name.trim().toLowerCase() && x.unit === s.unit)) errs.push('Nama tindakan sudah ada pada unit yang sama.');
    const v = rs.validateConfig(s);
    return { errors: errs.concat(v.errors), warnings: v.warnings };
  };

  svc.save = async function (s) {
    const list = await NP.db.all('services');
    const v = svc.validate(s, list);
    if (v.errors.length) throw new Error(v.errors.join('\n'));
    s.method = rs.methodOf(s.shares);
    if (NP.db.remote) {
      s.id = s.code = await NP.db.saveService(s);
      return s;
    }
    const isNew = !s.id;
    const before = list.find((x) => x.id === s.id);
    await NP.db.run(['services', 'counters', 'auditLog'], async (t) => {
      if (isNew) {
        const n = await t.nextNumber('service');
        s.id = s.code = NP.db.code(NP.state.settings.numbering.service, n);
        s.createdAt = Date.now();
      }
      s.updatedAt = Date.now();
      await t.put('services', s);
      let detail = (isNew ? 'Tambah tindakan ' : 'Ubah tindakan ') + s.name + ' (' + u.rp(s.price) + ')';
      if (before && before.price !== s.price) detail += '; harga ' + u.rp(before.price) + ' → ' + u.rp(s.price);
      if (before && JSON.stringify(before.shares) !== JSON.stringify(s.shares)) detail += '; pembagian diubah';
      await t.put('auditLog', NP.audit.entry(isNew ? 'service.create' : 'service.update', 'service', s.id, detail));
    });
    return s;
  };

  svc.usage = async function () {
    const m = new Map();
    for (const t of await NP.db.all('transactions')) for (const it of t.items) m.set(it.serviceId, (m.get(it.serviceId) || 0) + 1);
    return m;
  };

  svc.setActive = async function (id, active) {
    if (NP.db.remote) return NP.db.setServiceActive(id, active);
    const s = await NP.db.get('services', id);
    s.active = active;
    s.updatedAt = Date.now();
    await NP.db.run(['services', 'auditLog'], async (t) => {
      await t.put('services', s);
      await t.put('auditLog', NP.audit.entry('service.' + (active ? 'activate' : 'deactivate'), 'service', id, (active ? 'Aktifkan ' : 'Nonaktifkan ') + s.name));
    });
  };

  svc.remove = async function (id) {
    if (NP.db.remote) return NP.db.deleteService(id);
    const used = (await svc.usage()).get(id) || 0;
    if (used) throw new Error('Tindakan sudah dipakai pada ' + used + ' transaksi. Nonaktifkan saja agar riwayat tetap utuh.');
    const s = await NP.db.get('services', id);
    await NP.db.run(['services', 'auditLog'], async (t) => {
      await t.del('services', id);
      await t.put('auditLog', NP.audit.entry('service.delete', 'service', id, 'Hapus tindakan ' + (s && s.name)));
    });
  };

  svc.shareSummary = function (s, employees, list) {
    return (list || s.shares || [])
      .map((x) => {
        const v = x.mode === 'percent' ? u.pct(x.value) : x.mode === 'remainder' ? 'sisa' : u.rp(x.value);
        return '<span class="share-chip share-' + (x.type === 'unit' ? (x.target === 'APT' ? 'apotek' : 'klinik') : x.type === 'role' ? x.target : x.type) + '">' + u.esc(rs.targetLabel(x, employees).replace(' pelaksana', '')) + ' ' + v + '</span>';
      })
      .join(' ');
  };

  NP.svc = svc;

  /* ===================== Editor pembagian (dipakai ulang untuk override) ===================== */
  function shareEditor(host, shares, opt) {
    const state = { shares: u.clone(shares || []), method: opt.method || rs.methodOf(shares || []) };
    const employees = opt.employees;
    const empOpts = employees.filter((e) => e.status === 'aktif').map((e) => [e.id, e.name + ' — ' + e.position]);

    function modesAllowed() {
      if (state.method === 'nominal') return [['nominal', 'Nominal (Rp)'], ['remainder', 'Sisa harga']];
      if (state.method === 'percent') return [['percent', 'Persen (%)'], ['remainder', 'Sisa harga']];
      return [['nominal', 'Nominal (Rp)'], ['percent', 'Persen (%)'], ['remainder', 'Sisa harga']];
    }
    function targetCtl(s, i) {
      if (s.type === 'unit') return `<select data-f="target" data-i="${i}">${ui.options([['APT', 'Apotek Noura'], ['KLINIK', 'Praktek Dokter Umum']], s.target)}</select>`;
      if (s.type === 'role') return `<select data-f="target" data-i="${i}">${ui.options(Object.values(C.ROLES).map((r) => [r.key, r.label + ' pelaksana']), s.target)}</select>`;
      if (s.type === 'employee') return `<select data-f="target" data-i="${i}">${ui.options(empOpts, s.target, '— pilih karyawan —')}</select>`;
      return `<input data-f="target" data-i="${i}" value="${u.esc(s.target || '')}" placeholder="mis. Laboratorium mitra">`;
    }
    function draw() {
      const allowed = modesAllowed().map((x) => x[0]);
      state.shares.forEach((s) => {
        if (!allowed.includes(s.mode)) s.mode = allowed[0];
      });
      host.innerHTML = `
        <div class="share-rows">
          <div class="share-row share-head"><span>Jenis penerima</span><span>Penerima</span><span>Cara</span><span>Nilai</span><span></span></div>
          ${state.shares
            .map(
              (s, i) => `<div class="share-row">
              <select data-f="type" data-i="${i}" aria-label="Jenis penerima">${ui.options(Object.entries(rs.TYPE_LABELS), s.type)}</select>
              ${targetCtl(s, i)}
              <select data-f="mode" data-i="${i}" aria-label="Cara pembagian">${ui.options(modesAllowed(), s.mode)}</select>
              ${s.mode === 'remainder' ? '<input value="Otomatis" disabled>' : s.mode === 'percent' ? `<div class="input-suffix"><input data-f="value" data-i="${i}" type="number" min="0" max="100" step="0.01" value="${u.esc(s.value)}"><span>%</span></div>` : `<div class="input-prefix"><span>Rp</span><input data-f="value" data-i="${i}" data-money inputmode="numeric" value="${ui.moneyVal(s.value)}"></div>`}
              <button type="button" class="icon-btn danger" data-del="${i}" title="Hapus penerima">${ui.icon('trash')}</button>
            </div>`
            )
            .join('')}
        </div>
        <button type="button" class="btn btn-sm btn-ghost" data-add>${ui.icon('plus')}Tambah penerima pendapatan</button>`;
      opt.onChange && opt.onChange();
    }
    host.addEventListener('change', (e) => {
      const f = e.target.dataset.f;
      if (!f) return;
      const s = state.shares[+e.target.dataset.i];
      if (f === 'type') {
        s.type = e.target.value;
        s.target = s.type === 'unit' ? 'APT' : s.type === 'role' ? 'dokter' : '';
        draw();
      } else if (f === 'mode') {
        s.mode = e.target.value;
        s.value = 0;
        draw();
      } else if (f === 'target') {
        s.target = e.target.value;
        opt.onChange && opt.onChange();
      }
    });
    host.addEventListener('input', (e) => {
      const f = e.target.dataset.f;
      if (f === 'value') {
        const s = state.shares[+e.target.dataset.i];
        s.value = e.target.hasAttribute('data-money') ? u.toInt(e.target.value) : u.toNum(e.target.value);
        opt.onChange && opt.onChange();
      } else if (f === 'target') {
        state.shares[+e.target.dataset.i].target = e.target.value;
        opt.onChange && opt.onChange();
      }
    });
    host.addEventListener('click', (e) => {
      const d = e.target.closest('[data-del]');
      if (d) {
        state.shares.splice(+d.dataset.del, 1);
        draw();
      }
      if (e.target.closest('[data-add]')) {
        state.shares.push({ type: 'role', target: 'dokter', mode: modesAllowed()[0][0], value: 0 });
        draw();
      }
    });
    draw();
    return {
      get: () => state.shares.map((s) => ({ type: s.type, target: s.target, mode: s.mode, value: s.mode === 'remainder' ? 0 : s.value })),
      setMethod(m) {
        state.method = m;
        draw();
      }
    };
  }

  function previewHtml(service, qty, employees, withDoctor) {
    const all = rs.validateConfig(service);
    const isDoc = (e) => e.indexOf('Dengan dokter: ') === 0;
    const r = rs.compute(service, { qty: qty || 1, preview: true, employees: new Map(employees.map((e) => [e.id, e])), withDoctor: !!withDoctor });
    const v = { errors: all.errors.filter((e) => (withDoctor ? isDoc(e) : !isDoc(e))).map((e) => e.replace('Dengan dokter: ', '')), warnings: withDoctor ? r.warnings : all.warnings };
    const rows = r.shares
      .map((s) => `<tr><td>${u.esc(s.recipientName)}${s.implicit ? ' <small class="muted">(sisa otomatis)</small>' : ''}<small class="block muted">${u.esc(C.SHARE_CATS[s.category] || '')}</small></td><td class="ta-right">${s.mode === 'percent' ? u.pct(s.value) : s.mode === 'remainder' ? 'Sisa' : 'Nominal'}</td><td class="ta-right">${u.rp(s.unitAmount)}</td><td class="ta-right"><b>${u.rp(s.amount)}</b></td></tr>`)
      .join('');
    const status = v.errors.length
      ? `<div class="alert alert-danger">${ui.icon('x')}<div>${v.errors.map(u.esc).join('<br>')}</div></div>`
      : v.warnings.length
        ? `<div class="alert alert-warning">${ui.icon('warn')}<div>${v.warnings.map(u.esc).join('<br>')}</div></div>`
        : `<div class="alert alert-success">${ui.icon('check')}<div>Total pembagian sesuai dengan harga jual.</div></div>`;
    return `${status}
      <div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Penerima</th><th class="ta-right">Cara</th><th class="ta-right">Per tindakan</th><th class="ta-right">× ${qty || 1}</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="empty-cell">Belum ada penerima.</td></tr>'}</tbody>
      <tfoot><tr><th>Total</th><th></th><th class="ta-right">${u.rp(r.unitPrice)}</th><th class="ta-right">${u.rp(v.errors.length ? r.shares.reduce((a, s) => a + s.amount, 0) : r.total)}</th></tr></tfoot></table></div>`;
  }

  /* ===================== Form ===================== */
  async function openForm(existing, onSaved, opts) {
    opts = opts || {};
    const s = existing ? u.clone(existing) : svc.blank();
    s.overrides = s.overrides || [];
    if (opts.duplicate) {
      s.id = s.code = '';
      s.name = s.name + ' (salinan)';
    }
    const employees = await NP.emp.all();
    const used = existing && !opts.duplicate ? (await svc.usage()).get(existing.id) || 0 : 0;

    const body = document.createElement('form');
    body.className = 'svc-form';
    body.noValidate = true;
    body.innerHTML = `
      ${used ? `<div class="alert alert-info">${ui.icon('info')}<div>Tindakan ini sudah dipakai pada <b>${used}</b> transaksi. Perubahan harga/pembagian hanya berlaku untuk transaksi baru — transaksi lama tetap memakai konfigurasi saat transaksi dibuat.</div></div>` : ''}
      <div class="grid-2">
        <label class="field"><span>Kode tindakan</span><input value="${u.esc(s.code || 'Otomatis')}" readonly></label>
        <label class="field"><span>Nama tindakan <b class="req">*</b></span><input name="name" value="${u.esc(s.name)}" maxlength="80" placeholder="mis. Pemeriksaan Gula Darah"></label>
        <label class="field"><span>Kategori <b class="req">*</b></span><select name="category">${ui.options(C.SERVICE_CATEGORIES, s.category)}</select></label>
        <label class="field"><span>Unit usaha <b class="req">*</b></span><select name="unit">${ui.options([['APT', 'Apotek Noura'], ['KLINIK', 'Praktek Dokter Umum']], s.unit)}</select></label>
        <label class="field"><span>Harga jual kepada pasien <b class="req">*</b></span><div class="input-prefix"><span>Rp</span><input name="price" data-money inputmode="numeric" value="${ui.moneyVal(s.price)}"></div></label>
        <label class="field"><span>Metode pembagian</span><select name="method">${ui.options([['nominal', 'A. Nominal tetap'], ['percent', 'B. Persentase'], ['combo', 'C. Kombinasi nominal & persentase']], rs.methodOf(s.shares))}</select></label>
      </div>
      <div class="field doctor-mode">
        <span>Pelaksanaan tindakan</span>
        <div class="seg" role="radiogroup" aria-label="Pelaksanaan tindakan">
          <button type="button" class="seg-btn ${rs.hasDoctorVariant(s) ? '' : 'active'}" data-dm="single" role="radio" aria-checked="${!rs.hasDoctorVariant(s)}">Satu pembagian</button>
          <button type="button" class="seg-btn ${rs.hasDoctorVariant(s) ? 'active' : ''}" data-dm="variant" role="radio" aria-checked="${rs.hasDoctorVariant(s)}">Dengan dokter &amp; tanpa dokter (pembagian berbeda)</button>
        </div>
        <small class="muted">Pilih "Dengan dokter &amp; tanpa dokter" bila tindakan bisa dikerjakan bidan/perawat sendiri atau bersama dokter, dengan pembagian jasa yang berbeda. Saat input transaksi dipilih salah satunya.</small>
      </div>
      <div class="grid-split">
        <div>
          <h4 class="sec-title" id="main-title">${rs.hasDoctorVariant(s) ? 'Pembagian TANPA dokter (per 1 tindakan)' : 'Pembagian pendapatan (per 1 tindakan)'}</h4>
          <p class="muted small">Penerima dapat berupa unit usaha, <b>petugas pelaksana</b> (dipilih saat input transaksi), karyawan tertentu, atau penerima lain. Gunakan "Sisa harga" untuk mengalokasikan sisa secara otomatis.</p>
          <div id="share-main"></div>
        </div>
        <div>
          <h4 class="sec-title">Preview pembagian <label class="inline-qty">Simulasi jumlah <input type="number" id="sim-qty" min="1" value="1"></label></h4>
          <div id="share-preview"></div>
        </div>
      </div>
      <div class="grid-split doctor-split" ${rs.hasDoctorVariant(s) ? '' : 'hidden'}>
        <div>
          <h4 class="sec-title">Pembagian DENGAN dokter (per 1 tindakan)</h4>
          <p class="muted small">Dipakai bila saat input transaksi dipilih <b>Dengan dokter</b>. Biasanya memuat bagian untuk <b>Dokter pelaksana</b>.</p>
          <div id="share-doctor"></div>
        </div>
        <div>
          <h4 class="sec-title">Preview — dengan dokter</h4>
          <div id="share-preview-doctor"></div>
        </div>
      </div>
      <details class="panel" ${s.overrides.length ? 'open' : ''}>
        <summary><b>Pembagian khusus per petugas</b> <small class="muted">(opsional — mis. dokter senior mendapat persentase berbeda)</small></summary>
        <div id="overrides"></div>
        <button type="button" class="btn btn-sm btn-ghost" data-act="add-ov">${ui.icon('plus')}Tambah pembagian khusus</button>
      </details>
      <div class="grid-2">
        <label class="field"><span>Status</span><select name="active">${ui.options([['1', 'Aktif'], ['0', 'Nonaktif']], s.active ? '1' : '0')}</select></label>
        <label class="field"><span>Keterangan</span><input name="notes" value="${u.esc(s.notes || '')}"></label>
      </div>
      <div class="form-error" hidden></div>`;

    const q = (n) => body.querySelector(`[name="${n}"]`);
    const ovEditors = [];
    let mainEd;
    let docEd = null;
    let variant = rs.hasDoctorVariant(s);
    const current = () => {
      const d = ui.formData(body);
      return Object.assign({}, s, {
        name: d.name, category: d.category, unit: d.unit, price: d.price, active: d.active === '1', notes: d.notes, shares: mainEd ? mainEd.get() : s.shares,
        doctorShares: variant && docEd ? docEd.get() : [], overrides: ovEditors.map((o) => ({ employeeId: o.sel.value, shares: o.ed.get() }))
      });
    };
    const refresh = u.debounce(() => {
      const cur = current();
      const qty = u.toNum(body.querySelector('#sim-qty').value) || 1;
      body.querySelector('#share-preview').innerHTML = previewHtml(cur, qty, employees, false);
      if (variant) body.querySelector('#share-preview-doctor').innerHTML = previewHtml(cur, qty, employees, true);
    }, 120);
    mainEd = shareEditor(body.querySelector('#share-main'), s.shares, { employees, onChange: refresh });
    function ensureDocEditor() {
      if (docEd) return;
      let init = s.doctorShares && s.doctorShares.length ? s.doctorShares : u.clone(mainEd.get());
      if (!init.some((x) => x.type === 'role' && x.target === 'dokter')) init = init.concat([{ type: 'role', target: 'dokter', mode: q('method').value === 'percent' ? 'percent' : 'nominal', value: 0 }]);
      docEd = shareEditor(body.querySelector('#share-doctor'), init, { employees, method: q('method').value, onChange: refresh });
    }
    if (variant) ensureDocEditor();
    body.querySelector('.doctor-mode').addEventListener('click', (e) => {
      const b = e.target.closest('[data-dm]');
      if (!b) return;
      variant = b.dataset.dm === 'variant';
      body.querySelectorAll('[data-dm]').forEach((x) => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
      body.querySelector('.doctor-split').hidden = !variant;
      body.querySelector('#main-title').textContent = variant ? 'Pembagian TANPA dokter (per 1 tindakan)' : 'Pembagian pendapatan (per 1 tindakan)';
      if (variant) ensureDocEditor();
      refresh();
    });
    q('method').onchange = () => {
      mainEd.setMethod(q('method').value);
      if (docEd) docEd.setMethod(q('method').value);
      ovEditors.forEach((o) => o.ed.setMethod(q('method').value));
    };
    q('price').addEventListener('input', refresh);
    body.querySelector('#sim-qty').oninput = refresh;

    function addOverride(ov) {
      const wrap = document.createElement('div');
      wrap.className = 'override-box';
      wrap.innerHTML = `<div class="override-head"><label class="field"><span>Petugas</span><select>${ui.options(employees.filter((e) => e.status === 'aktif').map((e) => [e.id, e.name + ' — ' + e.position]), ov.employeeId, '— pilih petugas —')}</select></label><button type="button" class="btn btn-sm btn-ghost danger" data-rm>${ui.icon('trash')}Hapus</button></div><div class="ov-ed"></div>`;
      body.querySelector('#overrides').appendChild(wrap);
      const rec = { sel: wrap.querySelector('select'), ed: null, wrap };
      rec.ed = shareEditor(wrap.querySelector('.ov-ed'), ov.shares && ov.shares.length ? ov.shares : u.clone(mainEd.get()), { employees, method: q('method').value, onChange: refresh });
      rec.sel.onchange = refresh;
      wrap.querySelector('[data-rm]').onclick = () => {
        ovEditors.splice(ovEditors.indexOf(rec), 1);
        wrap.remove();
        refresh();
      };
      ovEditors.push(rec);
    }
    s.overrides.forEach(addOverride);
    body.querySelector('[data-act=add-ov]').onclick = () => {
      addOverride({ employeeId: '', shares: [] });
      refresh();
    };
    refresh();

    ui.modal({
      title: opts.duplicate ? 'Duplikat Tindakan' : existing ? 'Edit Tindakan — ' + existing.code : 'Tambah Tindakan',
      size: 'xl',
      body,
      static: true,
      actions: [
        { label: 'Batal', cls: 'btn-ghost', onClick: (m) => m.close() },
        {
          label: 'Simpan Tindakan', cls: 'btn-primary', icon: 'check', onClick: async (m) => {
            const out = current();
            try {
              await svc.save(out);
            } catch (err) {
              const fe = body.querySelector('.form-error');
              fe.hidden = false;
              fe.innerHTML = err.message.split('\n').map(u.esc).join('<br>');
              fe.scrollIntoView({ block: 'nearest' });
              return;
            }
            m.close();
            ui.toast('Tindakan ' + out.code + ' disimpan dan langsung tersedia di Input Tindakan.');
            onSaved && onSaved(out);
          }
        }
      ]
    });
  }
  svc.openForm = openForm;

  /* ===================== Halaman ===================== */
  const st = { q: '', cat: '', unit: '', status: 'active', role: '' };
  async function render(view) {
    const canEdit = NP.sec.can('services.edit');
    view.innerHTML = `
      <div class="page-head">
        <div><h2>Master Tindakan & Pelayanan</h2><p class="muted">Atur harga jual dan pembagian pendapatan setiap tindakan. Tindakan baru langsung tersedia di halaman Input Tindakan.</p></div>
        <div class="actions">
          <button class="btn btn-ghost" data-act="export">${ui.icon('excel')}<span>Ekspor Excel</span></button>
          ${canEdit ? `<button class="btn btn-primary" data-act="add">${ui.icon('plus')}<span>TAMBAH TINDAKAN</span></button>` : ''}
        </div>
      </div>
      <div class="chips" id="role-chips">
        ${[['', 'Semua tindakan'], ['dokter', 'Tindakan Dokter'], ['bidan', 'Tindakan Bidan'], ['perawat', 'Tindakan Perawat'], ['farmasi', 'Pelayanan Farmasi']].map(([k, l]) => `<button class="chip ${st.role === k ? 'active' : ''}" data-role="${k}">${l}</button>`).join('')}
      </div>
      <div class="card">
        <div class="filters">
          <label class="search">${ui.icon('search')}<input type="search" id="s-q" placeholder="Cari kode atau nama tindakan..." value="${u.esc(st.q)}"></label>
          <select id="s-cat"><option value="">Semua kategori</option>${ui.options(C.SERVICE_CATEGORIES, st.cat)}</select>
          <select id="s-unit"><option value="">Semua unit</option>${ui.options([['APT', 'Apotek Noura'], ['KLINIK', 'Praktek Dokter Umum']], st.unit)}</select>
          <select id="s-status">${ui.options([['', 'Semua status'], ['active', 'Aktif'], ['inactive', 'Nonaktif']], st.status)}</select>
        </div>
        <div id="svc-list"></div>
      </div>`;
    let list = await svc.all();
    const employees = await NP.emp.all();
    const empMap = new Map(employees.map((e) => [e.id, e]));
    let usage = await svc.usage();
    let table;
    const filtered = () => {
      const q = st.q.toLowerCase();
      return list.filter((s) =>
        (!q || (s.code + ' ' + s.name + ' ' + (s.notes || '')).toLowerCase().includes(q)) &&
        (!st.cat || s.category === st.cat) && (!st.unit || s.unit === st.unit) &&
        (!st.status || (st.status === 'active' ? s.active : !s.active)) &&
        (!st.role || rs.requiredRoles(s).includes(st.role) || rs.requiredRoles(s, true).includes(st.role) || (s.shares || []).some((x) => x.type === 'employee' && empMap.get(x.target) && C.roleOfPosition(empMap.get(x.target).position) === st.role))
      );
    };
    const cols = [
      { key: 'code', label: 'Kode', width: '90px' },
      { key: 'name', label: 'Nama Tindakan', render: (s) => `<b>${u.esc(s.name)}</b><small class="block muted">${u.esc(s.category)}</small>` },
      { key: 'unit', label: 'Unit', render: (s) => ui.unitBadge(s.unit) },
      { key: 'price', label: 'Harga Jual', align: 'right', render: (s) => `<b>${u.rp(s.price)}</b>`, value: (s) => s.price },
      { key: 'method', label: 'Pembagian', render: (s) => `<small class="muted">${rs.methodLabel(rs.methodOf(s.shares))}${(s.overrides || []).length ? ' · ' + s.overrides.length + ' khusus' : ''}</small>${rs.hasDoctorVariant(s) ? `<div class="variant-line"><small class="variant-tag">Tanpa dokter</small><div class="share-chips">${svc.shareSummary(s, empMap)}</div></div><div class="variant-line"><small class="variant-tag doc">Dengan dokter</small><div class="share-chips">${svc.shareSummary(s, empMap, s.doctorShares)}</div></div>` : `<div class="share-chips">${svc.shareSummary(s, empMap)}</div>`}`, sortable: false },
      { key: 'used', label: 'Dipakai', align: 'right', render: (s) => u.num(usage.get(s.id) || 0) + '×', value: (s) => usage.get(s.id) || 0 },
      { key: 'active', label: 'Status', render: (s) => ui.statusBadge(s.active ? 'active' : 'nonaktif'), value: (s) => (s.active ? 1 : 0) },
      {
        key: 'act', label: '', sortable: false, align: 'right',
        render: (s) => canEdit ? `<div class="row-actions">
          <button class="icon-btn" title="Edit" data-act="edit" data-id="${s.id}">${ui.icon('edit')}</button>
          <button class="icon-btn" title="Duplikat" data-act="dup" data-id="${s.id}">${ui.icon('copy')}</button>
          <button class="icon-btn" title="${s.active ? 'Nonaktifkan' : 'Aktifkan'}" data-act="toggle" data-id="${s.id}">${ui.icon(s.active ? 'lock' : 'unlock')}</button>
          <button class="icon-btn danger" title="Hapus" data-act="del" data-id="${s.id}">${ui.icon('trash')}</button></div>` : ''
      }
    ];
    table = ui.table(ui.$('#svc-list', view), { columns: cols, rows: filtered(), sortKey: 'code', empty: 'Belum ada tindakan.' });
    const reload = async () => {
      list = await svc.all();
      usage = await svc.usage();
      table.update(filtered());
    };
    ui.$('#s-q', view).oninput = u.debounce((e) => { st.q = e.target.value; table.update(filtered()); }, 200);
    ui.$('#s-cat', view).onchange = (e) => { st.cat = e.target.value; table.update(filtered()); };
    ui.$('#s-unit', view).onchange = (e) => { st.unit = e.target.value; table.update(filtered()); };
    ui.$('#s-status', view).onchange = (e) => { st.status = e.target.value; table.update(filtered()); };
    ui.$('#role-chips', view).onclick = (e) => {
      const c = e.target.closest('[data-role]');
      if (!c) return;
      st.role = c.dataset.role;
      ui.$$('#role-chips .chip', view).forEach((x) => x.classList.toggle('active', x === c));
      table.update(filtered());
    };
    view.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-act]');
      if (!a || !view.contains(a)) return;
      const s = list.find((x) => x.id === a.dataset.id);
      switch (a.dataset.act) {
        case 'add':
          openForm(null, reload);
          break;
        case 'edit':
          openForm(s, reload);
          break;
        case 'dup':
          openForm(s, reload, { duplicate: true });
          break;
        case 'toggle':
          if (s.active && !(await ui.confirm(`Nonaktifkan "${s.name}"? Tindakan tidak akan muncul di Input Tindakan, namun riwayat transaksi tetap tersimpan.`))) return;
          await svc.setActive(s.id, !s.active);
          ui.toast(s.active ? 'Tindakan dinonaktifkan.' : 'Tindakan diaktifkan.');
          reload();
          break;
        case 'del':
          if (!(await ui.confirm({ message: `Hapus tindakan "${s.name}"?`, danger: true, okLabel: 'Hapus' }))) return;
          try {
            await svc.remove(s.id);
            ui.toast('Tindakan dihapus.');
            reload();
          } catch (err) {
            ui.toast(err.message, 'error');
          }
          break;
        case 'export':
          NP.exp.excel([{
            name: 'Master Tindakan',
            rows: filtered().map((s) => ({
              Kode: s.code, 'Nama Tindakan': s.name, Kategori: s.category, Unit: C.UNITS[s.unit].name, 'Harga Jual': s.price,
              'Metode Pembagian': rs.methodLabel(rs.methodOf(s.shares)),
              Pembagian: (s.shares || []).map((x) => rs.targetLabel(x, empMap) + ': ' + (x.mode === 'percent' ? x.value + '%' : x.mode === 'remainder' ? 'sisa' : x.value)).join('; '),
              'Pembagian Dengan Dokter': (s.doctorShares || []).map((x) => rs.targetLabel(x, empMap) + ': ' + (x.mode === 'percent' ? x.value + '%' : x.mode === 'remainder' ? 'sisa' : x.value)).join('; '),
              Status: s.active ? 'Aktif' : 'Nonaktif', Keterangan: s.notes || ''
            }))
          }], 'master-tindakan-' + u.todayISO() + '.xlsx');
          break;
      }
    });
  }

  NP.pages.services = { title: 'Master Tindakan', render };
})(typeof globalThis !== 'undefined' ? globalThis : window);
