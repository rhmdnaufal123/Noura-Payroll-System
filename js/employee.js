/* Noura Payroll — manajemen data karyawan (CRUD, filter, impor/ekspor Excel, konfigurasi penggajian per karyawan). */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;
  const C = NP.C;

  /* ===================== Data ===================== */
  const emp = {};

  emp.all = async () => (await NP.db.all('employees')).sort((a, b) => a.name.localeCompare(b.name, 'id'));
  emp.map = async () => new Map((await NP.db.all('employees')).map((e) => [e.id, e]));
  emp.role = (e) => C.roleOfPosition(e.position);
  emp.unitsOf = (e) => (e.unit === 'LINTAS' ? ['APT', 'KLINIK'] : [e.unit]);
  emp.isActive = (e) => e.status === 'aktif';
  emp.isHealth = (e) => ['dokter', 'bidan', 'perawat'].includes(emp.role(e));
  emp.primaryUnit = (e) => (e.unit === 'LINTAS' ? e.primaryUnit || 'APT' : e.unit);
  emp.positionsFor = (unit) => (unit === 'LINTAS' ? C.ALL_POSITIONS : C.POSITIONS[unit] || C.ALL_POSITIONS);

  emp.blank = function () {
    return {
      id: '', name: '', photo: null, gender: '', address: '', phone: '', email: '', unit: 'APT', primaryUnit: 'APT', costSplit: { APT: 50 },
      position: 'Kasir', department: '', startDate: u.todayISO(), status: 'aktif', baseSalary: 0, payScheme: 'monthly', payConfig: {},
      payMethod: 'Transfer Bank', bankName: '', bankAccount: '', bankHolder: '', notes: '', str: '', sip: '', healthStatus: '', schedule: '',
      serviceFeeMethod: 'Digabung dalam slip gaji', bpjsKes: true, bpjsTk: true, bpjsWage: 0, pph21: true, ptkp: 'TK/0', salesTarget: 0, componentOverrides: {}
    };
  };

  emp.validate = function (e, list) {
    const errs = [];
    if (!e.name || e.name.trim().length < 3) errs.push('Nama lengkap wajib diisi (min. 3 karakter).');
    if (!C.EMP_UNITS[e.unit]) errs.push('Unit usaha tidak valid.');
    if (!e.position) errs.push('Jabatan wajib dipilih.');
    if (!e.department) errs.push('Departemen wajib diisi.');
    if (!e.startDate) errs.push('Tanggal mulai bekerja wajib diisi.');
    if (!C.EMP_STATUS[e.status]) errs.push('Status karyawan tidak valid.');
    if (!e.phone) errs.push('Nomor telepon wajib diisi.');
    else if (!/^[0-9+\-\s()]{8,20}$/.test(e.phone)) errs.push('Format nomor telepon tidak valid.');
    if (e.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.email)) errs.push('Format email tidak valid.');
    if (u.toInt(e.baseSalary) < 0) errs.push('Gaji pokok tidak boleh negatif.');
    const sch = C.PAY_SCHEMES[e.payScheme];
    if (!sch) errs.push('Skema penggajian tidak valid.');
    else if (sch.useBase && !(u.toInt(e.baseSalary) > 0)) errs.push('Skema "' + sch.label + '" memerlukan gaji pokok lebih dari 0.');
    for (const f of (sch && sch.fields) || []) if (u.toInt((e.payConfig || {})[f]) < 0) errs.push(C.RATE_LABELS[f] + ' tidak boleh negatif.');
    if (e.unit === 'LINTAS') {
      const a = u.toNum(e.costSplit && e.costSplit.APT);
      if (a < 0 || a > 100) errs.push('Pembagian biaya lintas unit harus 0–100%.');
    }
    if (e.bankAccount && !/^[0-9\-\s]{5,30}$/.test(e.bankAccount)) errs.push('Nomor rekening hanya boleh angka.');
    if (list && list.some((x) => x.id !== e.id && x.name.trim().toLowerCase() === e.name.trim().toLowerCase() && x.unit === e.unit && x.position === e.position))
      errs.push('Karyawan dengan nama, unit, dan jabatan yang sama sudah ada.');
    return errs;
  };

  emp.save = async function (e) {
    const list = await NP.db.all('employees');
    const errs = emp.validate(e, list);
    if (errs.length) throw new Error(errs.join('\n'));
    if (NP.db.remote) {
      e.id = await NP.db.saveEmployee(e);
      return e;
    }
    const isNew = !e.id;
    const before = isNew ? null : list.find((x) => x.id === e.id);
    await NP.db.run(['employees', 'counters', 'auditLog'], async (t) => {
      if (isNew) {
        const n = await t.nextNumber('employee');
        e.id = NP.db.code(NP.state.settings.numbering.employee, n);
        e.createdAt = Date.now();
      }
      e.updatedAt = Date.now();
      if (e.unit !== 'LINTAS') e.primaryUnit = e.unit;
      await t.put('employees', e);
      const changes = before ? diffFields(before, e) : '';
      await t.put('auditLog', NP.audit.entry(isNew ? 'employee.create' : 'employee.update', 'employee', e.id, (isNew ? 'Tambah karyawan ' : 'Ubah karyawan ') + e.name + (changes ? ' — ' + changes : '')));
    });
    return e;
  };

  function diffFields(a, b) {
    const keys = ['name', 'unit', 'position', 'department', 'status', 'baseSalary', 'payScheme', 'bankName', 'bankAccount'];
    return keys
      .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .map((k) => (k === 'bankAccount' ? 'rekening diubah' : k + ': ' + (k === 'baseSalary' ? u.rp(a[k]) + ' → ' + u.rp(b[k]) : a[k] + ' → ' + b[k])))
      .join('; ');
  }

  /** Cek keterkaitan data sebelum menghapus. */
  emp.references = async function (id) {
    const trx = await NP.db.all('transactions');
    const runs = await NP.db.all('payrollRuns');
    const services = await NP.db.all('services');
    return {
      trx: trx.filter((t) => t.items.some((i) => i.shares.some((s) => s.recipientId === id) || Object.values(i.performers || {}).includes(id))).length,
      runs: runs.filter((r) => r.employeeIds.includes(id)).length,
      services: services.filter((s) => (s.shares || []).some((x) => x.type === 'employee' && x.target === id) || (s.overrides || []).some((o) => o.employeeId === id)).length
    };
  };

  emp.remove = async function (id) {
    if (NP.db.remote) return NP.db.deleteEmployee(id);
    const refs = await emp.references(id);
    if (refs.trx || refs.runs || refs.services) {
      throw new Error('Karyawan sudah memiliki ' + [refs.trx && refs.trx + ' transaksi', refs.runs && refs.runs + ' periode gaji', refs.services && refs.services + ' konfigurasi tindakan'].filter(Boolean).join(', ') + '. Ubah status menjadi "Tidak Aktif" atau "Mengundurkan Diri" agar riwayat tetap utuh.');
    }
    const e = await NP.db.get('employees', id);
    await NP.db.run(['employees', 'auditLog'], async (t) => {
      await t.del('employees', id);
      await t.put('auditLog', NP.audit.entry('employee.delete', 'employee', id, 'Hapus karyawan ' + (e ? e.name : id)));
    });
  };

  NP.emp = emp;

  /* ===================== Halaman ===================== */
  const state = { q: '', unit: '', position: '', status: '', view: 'table' };

  async function render(view) {
    const canEdit = NP.sec.can('employees.edit');
    try {
      state.view = localStorage.getItem('noura.empView') || 'table';
    } catch (_) {}
    view.innerHTML = `
      <div class="page-head">
        <div><h2>Data Karyawan</h2><p class="muted">Kelola karyawan Apotek Noura dan Praktek Dokter Umum, termasuk karyawan lintas unit.</p></div>
        <div class="actions">
          ${canEdit ? `<button class="btn btn-ghost" data-act="template">${ui.icon('download')}<span>Template Impor</span></button>
          <button class="btn btn-ghost" data-act="import">${ui.icon('upload')}<span>Impor Excel</span></button>` : ''}
          <button class="btn btn-ghost" data-act="export">${ui.icon('excel')}<span>Ekspor Excel</span></button>
          ${canEdit ? `<button class="btn btn-primary" data-act="add">${ui.icon('plus')}<span>Tambah Karyawan</span></button>` : ''}
        </div>
      </div>
      <div class="stats-row" id="emp-stats"></div>
      <div class="card">
        <div class="filters">
          <label class="search">${ui.icon('search')}<input type="search" placeholder="Cari nama, ID, jabatan, telepon..." id="f-q" value="${u.esc(state.q)}"></label>
          <select id="f-unit"><option value="">Semua unit</option>${ui.options(Object.entries(C.EMP_UNITS), state.unit)}</select>
          <select id="f-pos"><option value="">Semua jabatan</option>${ui.options(C.ALL_POSITIONS, state.position)}</select>
          <select id="f-status"><option value="">Semua status</option>${ui.options(Object.entries(C.EMP_STATUS), state.status)}</select>
          <div class="seg" role="group"><button class="seg-btn ${state.view === 'table' ? 'active' : ''}" data-view="table">Tabel</button><button class="seg-btn ${state.view === 'cards' ? 'active' : ''}" data-view="cards">Kartu</button></div>
        </div>
        <div id="emp-list"></div>
      </div>`;

    let list = await emp.all();
    const listEl = ui.$('#emp-list', view);
    let table = null;

    function filtered() {
      const q = state.q.toLowerCase();
      return list.filter((e) =>
        (!state.unit || e.unit === state.unit || (state.unit !== 'LINTAS' && e.unit === 'LINTAS')) &&
        (!state.position || e.position === state.position) &&
        (!state.status || e.status === state.status) &&
        (!q || [e.id, e.name, e.position, e.department, e.phone, e.email].join(' ').toLowerCase().includes(q))
      );
    }

    function stats() {
      const act = list.filter((e) => e.status === 'aktif');
      ui.$('#emp-stats', view).innerHTML = [
        ui.stat('Total karyawan', u.num(list.length), { icon: 'users', sub: act.length + ' aktif' }),
        ui.stat('Apotek Noura', u.num(list.filter((e) => e.unit === 'APT').length), { icon: 'medical', sub: '+ ' + list.filter((e) => e.unit === 'LINTAS').length + ' lintas unit' }),
        ui.stat('Praktek Dokter', u.num(list.filter((e) => e.unit === 'KLINIK').length), { icon: 'medical', sub: '+ ' + list.filter((e) => e.unit === 'LINTAS').length + ' lintas unit' }),
        ui.stat('Tenaga kesehatan', u.num(list.filter(emp.isHealth).length), { icon: 'medical', sub: 'Dokter, bidan, perawat' })
      ].join('');
    }

    function avatar(e, size) {
      return e.photo ? `<img class="avatar-img ${size || ''}" src="${e.photo}" alt="">` : `<span class="avatar ${size || ''}">${u.esc(e.name.slice(0, 1).toUpperCase())}</span>`;
    }

    function draw() {
      const rows = filtered();
      if (state.view === 'cards') {
        table = null;
        listEl.innerHTML = rows.length
          ? `<div class="emp-grid">${rows
              .map(
                (e) => `<div class="emp-card">
              <div class="emp-card-top">${avatar(e, 'lg')}<div><b>${u.esc(e.name)}</b><small>${u.esc(e.id)}</small></div></div>
              <div class="emp-card-meta"><span>${u.esc(e.position)}</span>${ui.unitBadge(e.unit)} ${ui.statusBadge(e.status)}</div>
              <div class="emp-card-row"><span>Skema</span><b>${u.esc((C.PAY_SCHEMES[e.payScheme] || {}).label || '-')}</b></div>
              <div class="emp-card-row"><span>Gaji pokok</span><b>${u.rp(e.baseSalary)}</b></div>
              <div class="emp-card-row"><span>Telepon</span><b>${u.esc(e.phone || '-')}</b></div>
              <div class="emp-card-actions"><button class="btn btn-sm btn-ghost" data-act="view" data-id="${e.id}">${ui.icon('eye')}Detail</button>${canEdit ? `<button class="btn btn-sm btn-ghost" data-act="edit" data-id="${e.id}">${ui.icon('edit')}Edit</button>` : ''}</div>
            </div>`
              )
              .join('')}</div>`
          : ui.empty('Tidak ada karyawan sesuai filter.');
        return;
      }
      const cols = [
        { key: 'id', label: 'ID', width: '90px' },
        { key: 'name', label: 'Nama', render: (e) => `<div class="cell-person">${avatar(e)}<div><b>${u.esc(e.name)}</b><small>${u.esc(e.email || e.phone || '')}</small></div></div>` },
        { key: 'unit', label: 'Unit', render: (e) => ui.unitBadge(e.unit) + (e.unit === 'LINTAS' ? `<small class="block muted">APT ${u.num(e.costSplit.APT)}% · Praktek ${u.num(100 - e.costSplit.APT)}%</small>` : '') },
        { key: 'position', label: 'Jabatan', render: (e) => `${u.esc(e.position)}<small class="block muted">${u.esc(e.department)}</small>` },
        { key: 'payScheme', label: 'Skema Gaji', render: (e) => `<small>${u.esc((C.PAY_SCHEMES[e.payScheme] || {}).label || '-')}</small>` },
        { key: 'baseSalary', label: 'Gaji Pokok', align: 'right', render: (e) => u.rp(e.baseSalary), value: (e) => e.baseSalary },
        { key: 'status', label: 'Status', render: (e) => ui.statusBadge(e.status) },
        { key: 'act', label: '', sortable: false, align: 'right', render: (e) => `<div class="row-actions"><button class="icon-btn" title="Detail" data-act="view" data-id="${e.id}">${ui.icon('eye')}</button>${canEdit ? `<button class="icon-btn" title="Edit" data-act="edit" data-id="${e.id}">${ui.icon('edit')}</button><button class="icon-btn danger" title="Hapus" data-act="del" data-id="${e.id}">${ui.icon('trash')}</button>` : ''}</div>` }
      ];
      if (table) table.update(rows);
      else table = ui.table(listEl, { columns: cols, rows, sortKey: 'id', empty: 'Tidak ada karyawan sesuai filter.' });
    }

    async function reload() {
      list = await emp.all();
      stats();
      table = null;
      draw();
    }

    stats();
    draw();

    ui.$('#f-q', view).oninput = u.debounce((e) => {
      state.q = e.target.value;
      draw();
    }, 200);
    ui.$('#f-unit', view).onchange = (e) => {
      state.unit = e.target.value;
      draw();
    };
    ui.$('#f-pos', view).onchange = (e) => {
      state.position = e.target.value;
      draw();
    };
    ui.$('#f-status', view).onchange = (e) => {
      state.status = e.target.value;
      draw();
    };

    view.addEventListener('click', async (ev) => {
      const v = ev.target.closest('[data-view]');
      if (v) {
        state.view = v.dataset.view;
        try {
          localStorage.setItem('noura.empView', state.view);
        } catch (_) {}
        ui.$$('.seg-btn', view).forEach((b) => b.classList.toggle('active', b === v));
        table = null;
        draw();
        return;
      }
      const a = ev.target.closest('[data-act]');
      if (!a || !view.contains(a)) return;
      const id = a.dataset.id;
      switch (a.dataset.act) {
        case 'add':
          openForm(null, reload);
          break;
        case 'edit':
          openForm(list.find((x) => x.id === id), reload);
          break;
        case 'view':
          openDetail(list.find((x) => x.id === id));
          break;
        case 'del': {
          const e = list.find((x) => x.id === id);
          if (!(await ui.confirm({ title: 'Hapus karyawan', message: `Hapus ${e.name} (${e.id})? Tindakan ini tidak dapat dibatalkan.`, danger: true, okLabel: 'Hapus' }))) return;
          try {
            await emp.remove(id);
            ui.toast('Karyawan dihapus.');
            reload();
          } catch (err) {
            ui.toast(err.message, 'error');
          }
          break;
        }
        case 'export':
          exportExcel(filtered());
          break;
        case 'template':
          NP.exp.excel([{ name: 'Karyawan', rows: [importTemplateRow()] }], 'template-impor-karyawan.xlsx');
          break;
        case 'import':
          importExcel(reload);
          break;
      }
    });
  }

  /* ---------- Detail ---------- */
  function openDetail(e) {
    const sch = C.PAY_SCHEMES[e.payScheme] || {};
    const rates = (sch.fields || []).map((f) => `<div class="kv"><span>${C.RATE_LABELS[f]}</span><b>${u.rp((e.payConfig || {})[f])}</b></div>`).join('');
    ui.modal({
      title: 'Detail Karyawan',
      size: 'lg',
      body: `<div class="emp-detail">
        <div class="emp-detail-head">${e.photo ? `<img class="avatar-img xl" src="${e.photo}" alt="">` : `<span class="avatar xl">${u.esc(e.name[0])}</span>`}
          <div><h3>${u.esc(e.name)}</h3><p>${u.esc(e.id)} · ${u.esc(e.position)} · ${u.esc(e.department)}</p><p>${ui.unitBadge(e.unit)} ${ui.statusBadge(e.status)}</p></div></div>
        <div class="grid-2">
          <div class="panel"><h4>Data pribadi</h4>
            <div class="kv"><span>Jenis kelamin</span><b>${u.esc(e.gender || '-')}</b></div>
            <div class="kv"><span>Telepon</span><b>${u.esc(e.phone || '-')}</b></div>
            <div class="kv"><span>Email</span><b>${u.esc(e.email || '-')}</b></div>
            <div class="kv"><span>Alamat</span><b>${u.esc(e.address || '-')}</b></div>
            <div class="kv"><span>Mulai bekerja</span><b>${u.fmtDate(e.startDate, 'long')}</b></div>
          </div>
          <div class="panel"><h4>Penggajian</h4>
            <div class="kv"><span>Skema</span><b>${u.esc(sch.label || '-')}</b></div>
            <div class="kv"><span>Gaji pokok</span><b>${u.rp(e.baseSalary)}</b></div>${rates}
            ${e.unit === 'LINTAS' ? `<div class="kv"><span>Pembagian biaya</span><b>Apotek ${e.costSplit.APT}% · Praktek ${100 - e.costSplit.APT}%</b></div><div class="kv"><span>Unit utama slip</span><b>${C.UNITS[e.primaryUnit || 'APT'].name}</b></div>` : ''}
            <div class="kv"><span>BPJS Kes / TK</span><b>${e.bpjsKes ? 'Ya' : 'Tidak'} / ${e.bpjsTk ? 'Ya' : 'Tidak'}</b></div>
            <div class="kv"><span>PPh 21</span><b>${e.pph21 ? 'Ya (' + u.esc(e.ptkp) + ')' : 'Tidak'}</b></div>
            <div class="kv"><span>Cara pembayaran</span><b>${u.esc(e.payMethod || '-')}</b></div>
            <div class="kv"><span>Bank</span><b>${u.esc(e.bankName || '-')} ${u.esc(NP.sec.bankView(e.bankAccount))}</b></div>
          </div>
          ${emp.isHealth(e) ? `<div class="panel"><h4>Tenaga kesehatan (administrasi)</h4>
            <div class="kv"><span>No. STR</span><b>${u.esc(e.str || '-')}</b></div>
            <div class="kv"><span>No. SIP</span><b>${u.esc(e.sip || '-')}</b></div>
            <div class="kv"><span>Status nakes</span><b>${u.esc(e.healthStatus || '-')}</b></div>
            <div class="kv"><span>Jadwal praktik</span><b>${u.esc(e.schedule || '-')}</b></div>
            <div class="kv"><span>Metode pembayaran jasa</span><b>${u.esc(e.serviceFeeMethod || '-')}</b></div>
            <p class="muted small">STR & SIP hanya untuk administrasi dan tidak ditampilkan pada slip gaji.</p></div>` : ''}
          <div class="panel"><h4>Catatan</h4><p>${u.esc(e.notes || '-')}</p></div>
        </div></div>`,
      actions: [{ label: 'Tutup', cls: 'btn-ghost', onClick: (m) => m.close() }]
    });
  }

  /* ---------- Form tambah/edit ---------- */
  async function openForm(existing, onSaved) {
    const e = existing ? u.clone(existing) : emp.blank();
    e.payConfig = e.payConfig || {};
    e.costSplit = e.costSplit || { APT: 50 };
    e.componentOverrides = e.componentOverrides || {};
    const comps = NP.state.components;

    const body = document.createElement('form');
    body.className = 'emp-form';
    body.noValidate = true;
    body.innerHTML = `
      <div class="tabs-host"></div>
      <section data-pane="pribadi">
        <div class="photo-row">
          <div class="photo-box">${e.photo ? `<img src="${e.photo}" alt="">` : `<span>${ui.icon('users')}</span>`}</div>
          <div><button type="button" class="btn btn-sm btn-ghost" data-act="photo">${ui.icon('image')}Pilih foto</button> <button type="button" class="btn btn-sm btn-ghost" data-act="nophoto">Hapus foto</button><p class="muted small">Opsional. Foto diperkecil otomatis.</p></div>
        </div>
        <div class="grid-2">
          <label class="field"><span>ID Karyawan</span><input value="${u.esc(e.id || 'Otomatis')}" readonly></label>
          <label class="field"><span>Nama lengkap <b class="req">*</b></span><input name="name" value="${u.esc(e.name)}" required maxlength="80"></label>
          <label class="field"><span>Jenis kelamin</span><select name="gender">${ui.options([['', '-'], 'Laki-laki', 'Perempuan'], e.gender)}</select></label>
          <label class="field"><span>Nomor telepon <b class="req">*</b></span><input name="phone" value="${u.esc(e.phone)}" inputmode="tel"></label>
          <label class="field"><span>Email</span><input name="email" type="email" value="${u.esc(e.email)}"></label>
          <label class="field"><span>Tanggal mulai bekerja <b class="req">*</b></span><input name="startDate" type="date" value="${u.esc(e.startDate)}"></label>
          <label class="field span-2"><span>Alamat</span><textarea name="address" rows="2">${u.esc(e.address)}</textarea></label>
        </div>
      </section>
      <section data-pane="pekerjaan" hidden>
        <div class="grid-2">
          <label class="field"><span>Unit usaha <b class="req">*</b></span><select name="unit">${ui.options(Object.entries(C.EMP_UNITS), e.unit)}</select></label>
          <label class="field"><span>Jabatan <b class="req">*</b></span><select name="position"></select></label>
          <label class="field"><span>Departemen <b class="req">*</b></span><input name="department" list="dept-list" value="${u.esc(e.department)}"><datalist id="dept-list"></datalist></label>
          <label class="field"><span>Status karyawan</span><select name="status">${ui.options(Object.entries(C.EMP_STATUS), e.status)}</select></label>
        </div>
        <div class="lintas-box panel" ${e.unit === 'LINTAS' ? '' : 'hidden'}>
          <h4>Pengaturan karyawan lintas unit</h4>
          <p class="muted small">Gaji dihitung <b>satu kali</b> pada satu slip, lalu biayanya dialokasikan ke masing-masing unit sesuai persentase berikut (jasa tindakan dialokasikan ke unit asal tindakan).</p>
          <div class="grid-3">
            <label class="field"><span>Beban Apotek Noura (%)</span><input name="splitAPT" type="number" min="0" max="100" step="1" value="${u.esc(e.costSplit.APT)}"></label>
            <label class="field"><span>Beban Praktek Dokter (%)</span><input id="splitKLINIK" type="number" value="${100 - u.toNum(e.costSplit.APT)}" readonly></label>
            <label class="field"><span>Unit utama (kop slip)</span><select name="primaryUnit">${ui.options([['APT', 'Apotek Noura'], ['KLINIK', 'Praktek Dokter Umum']], e.primaryUnit)}</select></label>
          </div>
        </div>
        <label class="field"><span>Catatan</span><textarea name="notes" rows="2">${u.esc(e.notes)}</textarea></label>
      </section>
      <section data-pane="nakes" hidden>
        <p class="muted small">Data STR dan SIP hanya digunakan untuk administrasi dan <b>tidak</b> ditampilkan pada slip gaji.</p>
        <div class="grid-2">
          <label class="field"><span>Nomor STR</span><input name="str" value="${u.esc(e.str)}"></label>
          <label class="field"><span>Nomor SIP</span><input name="sip" value="${u.esc(e.sip)}"></label>
          <label class="field"><span>Status tenaga kesehatan</span><select name="healthStatus">${ui.options([['', '-'], 'Tetap', 'Mitra / Visiting', 'Kontrak', 'Paruh waktu'], e.healthStatus)}</select></label>
          <label class="field"><span>Metode pembayaran jasa</span><select name="serviceFeeMethod">${ui.options(['Digabung dalam slip gaji', 'Dibayar terpisah (tunai)', 'Transfer terpisah'], e.serviceFeeMethod)}</select></label>
          <label class="field span-2"><span>Jadwal praktik</span><input name="schedule" value="${u.esc(e.schedule)}" placeholder="mis. Senin–Jumat 16.00–21.00"></label>
        </div>
      </section>
      <section data-pane="gaji" hidden>
        <div class="grid-2">
          <label class="field"><span>Skema penggajian</span><select name="payScheme"></select></label>
          <label class="field base-field"><span>Gaji pokok / bulan</span><input name="baseSalary" data-money inputmode="numeric" value="${ui.moneyVal(e.baseSalary)}"></label>
        </div>
        <div class="grid-2 rate-fields"></div>
        <div class="grid-3">
          <label class="check"><input type="checkbox" name="bpjsKes" ${e.bpjsKes ? 'checked' : ''}><span>Ikut BPJS Kesehatan</span></label>
          <label class="check"><input type="checkbox" name="bpjsTk" ${e.bpjsTk ? 'checked' : ''}><span>Ikut BPJS Ketenagakerjaan</span></label>
          <label class="check"><input type="checkbox" name="pph21" ${e.pph21 ? 'checked' : ''}><span>Dipotong PPh 21</span></label>
        </div>
        <div class="grid-3">
          <label class="field"><span>Status PTKP</span><select name="ptkp">${ui.options(C.PTKP_LIST, e.ptkp)}</select></label>
          <label class="field"><span>Upah dilaporkan BPJS (opsional)</span><input name="bpjsWage" data-money inputmode="numeric" value="${ui.moneyVal(e.bpjsWage)}" placeholder="Otomatis"></label>
          <label class="field sales-field"><span>Target penjualan / bulan</span><input name="salesTarget" data-money inputmode="numeric" value="${ui.moneyVal(e.salesTarget)}"></label>
        </div>
        <details class="panel"><summary><b>Komponen khusus karyawan ini</b> <small class="muted">(opsional — menimpa pengaturan umum)</small></summary>
          <div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Komponen</th><th>Aturan umum</th><th>Pengaturan</th><th>Nilai khusus</th></tr></thead><tbody>
          ${comps
            .filter((c) => c.calc !== 'system' || ['BONUS_SALES'].includes(c.code))
            .map((c) => {
              const ov = e.componentOverrides[c.code] || {};
              const mode = ov.enabled === false ? 'off' : ov.enabled === true ? 'on' : 'default';
              return `<tr><td>${u.esc(c.name)}<small class="block muted">${c.type === 'earning' ? 'Pendapatan' : 'Potongan'}</small></td>
                <td><small>${u.esc(NP.defaults.CALC_LABELS[c.calc])}</small></td>
                <td><select data-ov-mode="${c.code}">${ui.options([['default', 'Ikuti umum'], ['on', 'Selalu berlaku'], ['off', 'Tidak berlaku']], mode)}</select></td>
                <td><input data-ov-val="${c.code}" ${c.calc === 'percent' ? 'type="number" step="0.01"' : 'data-money inputmode="numeric"'} value="${ov.value !== undefined && ov.value !== null && ov.value !== '' ? (c.calc === 'percent' ? ov.value : ui.moneyVal(ov.value)) : ''}" placeholder="${c.calc === 'percent' ? '%' : 'Default'}"></td></tr>`;
            })
            .join('')}
          </tbody></table></div>
          <p class="muted small">Contoh: isi nilai default "Potongan Pinjaman" untuk cicilan bulanan karyawan, atau nonaktifkan tunjangan tertentu.</p>
        </details>
      </section>
      <section data-pane="bank" hidden>
        <div class="grid-2">
          <label class="field"><span>Cara pembayaran gaji</span><select name="payMethod">${ui.options(['Transfer Bank', 'Tunai'], e.payMethod)}</select></label>
          <label class="field"><span>Nama bank</span><input name="bankName" list="bank-list" value="${u.esc(e.bankName)}"><datalist id="bank-list">${['BCA', 'BRI', 'BNI', 'Mandiri', 'BSI', 'BTN', 'CIMB Niaga', 'Bank Jago', 'SeaBank'].map((b) => `<option value="${b}">`).join('')}</datalist></label>
          <label class="field"><span>Nomor rekening</span><input name="bankAccount" inputmode="numeric" value="${u.esc(NP.sec.can('bank.view') ? e.bankAccount : '')}" placeholder="${NP.sec.can('bank.view') ? '' : 'Tersembunyi — isi untuk mengganti'}"></label>
          <label class="field"><span>Atas nama</span><input name="bankHolder" value="${u.esc(e.bankHolder || '')}"></label>
        </div>
        <p class="muted small">${ui.icon('lock')} Nomor rekening hanya terlihat oleh Administrator & Admin Keuangan dan ditampilkan tersamar pada slip.</p>
      </section>
      <div class="form-error" hidden></div>`;

    const q = (n) => body.querySelector(`[name="${n}"]`);
    const tabsHost = body.querySelector('.tabs-host');
    const tabs = [
      { key: 'pribadi', label: 'Data Pribadi' },
      { key: 'pekerjaan', label: 'Pekerjaan & Unit' },
      { key: 'nakes', label: 'Tenaga Kesehatan' },
      { key: 'gaji', label: 'Penggajian' },
      { key: 'bank', label: 'Rekening' }
    ];
    ui.tabs(tabsHost, tabs, 'pribadi', (k) => body.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== k)));

    function fillPositions() {
      const unit = q('unit').value;
      const ps = emp.positionsFor(unit);
      const cur = q('position').value || e.position;
      q('position').innerHTML = ui.options(ps, ps.includes(cur) ? cur : ps[0]);
      const deps = unit === 'LINTAS' ? [...new Set(C.DEPARTMENTS.APT.concat(C.DEPARTMENTS.KLINIK))] : C.DEPARTMENTS[unit];
      body.querySelector('#dept-list').innerHTML = deps.map((d) => `<option value="${d}">`).join('');
      body.querySelector('.lintas-box').hidden = unit !== 'LINTAS';
      body.querySelector('.sales-field').hidden = unit === 'KLINIK';
    }
    function fillSchemes() {
      const role = C.roleOfPosition(q('position').value);
      const allowed = C.SCHEMES_BY_ROLE[role].slice();
      const cur = q('payScheme').value || e.payScheme;
      if (cur && C.PAY_SCHEMES[cur] && !allowed.includes(cur)) allowed.push(cur);
      q('payScheme').innerHTML = ui.options(allowed.map((k) => [k, C.PAY_SCHEMES[k].label]), allowed.includes(cur) ? cur : allowed[0]);
      const isHealth = ['dokter', 'bidan', 'perawat'].includes(role);
      tabsHost.querySelector('[data-tab=nakes]').style.display = isHealth || HEALTH_EXTRA(q('position').value) ? '' : 'none';
      fillRates();
    }
    const HEALTH_EXTRA = (p) => NP.C.HEALTH_POSITIONS.includes(p);
    function fillRates() {
      const sch = C.PAY_SCHEMES[q('payScheme').value];
      body.querySelector('.base-field').style.opacity = sch.useBase ? 1 : 0.5;
      body.querySelector('.base-field span').textContent = sch.useBase ? 'Gaji pokok / bulan *' : 'Gaji pokok / bulan (tidak dipakai pada skema ini)';
      body.querySelector('.rate-fields').innerHTML = sch.fields
        .map((f) => `<label class="field"><span>${C.RATE_LABELS[f]}</span><input data-rate="${f}" data-money inputmode="numeric" value="${ui.moneyVal(e.payConfig[f] || 0)}"></label>`)
        .join('') + (sch.fields.length ? '' : '');
    }
    fillPositions();
    q('position').value = emp.positionsFor(q('unit').value).includes(e.position) ? e.position : q('position').value;
    fillSchemes();
    q('unit').onchange = () => {
      fillPositions();
      fillSchemes();
    };
    q('position').onchange = fillSchemes;
    q('payScheme').onchange = () => {
      body.querySelectorAll('[data-rate]').forEach((i) => (e.payConfig[i.dataset.rate] = u.toInt(i.value)));
      fillRates();
    };
    q('splitAPT').oninput = () => (body.querySelector('#splitKLINIK').value = 100 - u.toNum(q('splitAPT').value));

    body.addEventListener('click', async (ev) => {
      const a = ev.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'photo') {
        const f = await ui.pickFile('image/*');
        if (!f) return;
        if (f.size > 5 * 1024 * 1024) return ui.toast('Ukuran foto maksimal 5 MB.', 'error');
        e.photo = await ui.resizeImage(await ui.readFile(f, 'dataurl'), 240);
        body.querySelector('.photo-box').innerHTML = `<img src="${e.photo}" alt="">`;
      }
      if (a.dataset.act === 'nophoto') {
        e.photo = null;
        body.querySelector('.photo-box').innerHTML = `<span>${ui.icon('users')}</span>`;
      }
    });

    ui.modal({
      title: existing ? 'Edit Karyawan — ' + existing.name : 'Tambah Karyawan',
      size: 'lg',
      body,
      static: true,
      actions: [
        { label: 'Batal', cls: 'btn-ghost', onClick: (m) => m.close() },
        {
          label: 'Simpan', cls: 'btn-primary', icon: 'check', onClick: async (m) => {
            const d = ui.formData(body);
            const out = Object.assign(e, {
              name: d.name, gender: d.gender, phone: d.phone, email: d.email, startDate: d.startDate, address: d.address,
              unit: d.unit, position: d.position, department: d.department, status: d.status, notes: d.notes,
              str: d.str, sip: d.sip, healthStatus: d.healthStatus, serviceFeeMethod: d.serviceFeeMethod, schedule: d.schedule,
              payScheme: d.payScheme, baseSalary: d.baseSalary, bpjsKes: d.bpjsKes, bpjsTk: d.bpjsTk, pph21: d.pph21, ptkp: d.ptkp,
              bpjsWage: d.bpjsWage, salesTarget: d.unit === 'KLINIK' ? 0 : d.salesTarget, payMethod: d.payMethod, bankName: d.bankName, bankHolder: d.bankHolder,
              primaryUnit: d.unit === 'LINTAS' ? d.primaryUnit : d.unit,
              costSplit: { APT: d.unit === 'LINTAS' ? u.toNum(d.splitAPT) : d.unit === 'APT' ? 100 : 0 }
            });
            if (NP.sec.can('bank.view') || d.bankAccount) out.bankAccount = d.bankAccount.replace(/\s/g, '');
            const sch = C.PAY_SCHEMES[out.payScheme];
            const pc = {};
            body.querySelectorAll('[data-rate]').forEach((i) => (pc[i.dataset.rate] = u.toInt(i.value)));
            sch.fields.forEach((f) => (pc[f] = pc[f] || 0));
            out.payConfig = pc;
            const ovs = {};
            body.querySelectorAll('[data-ov-mode]').forEach((sel) => {
              const code = sel.dataset.ovMode;
              const inp = body.querySelector(`[data-ov-val="${code}"]`);
              const raw = inp.value.trim();
              const val = raw === '' ? null : inp.hasAttribute('data-money') ? u.toInt(raw) : u.toNum(raw);
              if (sel.value !== 'default' || val !== null) ovs[code] = { enabled: sel.value === 'on' ? true : sel.value === 'off' ? false : undefined, value: val };
            });
            out.componentOverrides = ovs;
            try {
              await emp.save(out);
            } catch (err) {
              const fe = body.querySelector('.form-error');
              fe.hidden = false;
              fe.innerHTML = err.message.split('\n').map(u.esc).join('<br>');
              fe.scrollIntoView({ block: 'nearest' });
              return;
            }
            m.close();
            ui.toast(existing ? 'Data karyawan diperbarui.' : 'Karyawan ' + out.id + ' ditambahkan.');
            onSaved && onSaved();
          }
        }
      ]
    });
  }
  emp.openForm = openForm;

  /* ---------- Impor / ekspor ---------- */
  const COLS = [
    ['ID', 'id'], ['Nama Lengkap', 'name'], ['Jenis Kelamin', 'gender'], ['Alamat', 'address'], ['Telepon', 'phone'], ['Email', 'email'],
    ['Unit (APT/KLINIK/LINTAS)', 'unit'], ['Jabatan', 'position'], ['Departemen', 'department'], ['Tanggal Mulai (YYYY-MM-DD)', 'startDate'],
    ['Status (aktif/nonaktif/cuti/resign)', 'status'], ['Gaji Pokok', 'baseSalary'], ['Skema Gaji', 'payScheme'], ['Cara Pembayaran', 'payMethod'],
    ['Nama Bank', 'bankName'], ['No Rekening', 'bankAccount'], ['Beban Apotek % (lintas)', 'splitAPT'], ['No STR', 'str'], ['No SIP', 'sip'],
    ['Jadwal Praktik', 'schedule'], ['PTKP', 'ptkp'], ['Catatan', 'notes']
  ];
  function toRow(e) {
    const r = {};
    for (const [h, k] of COLS) {
      if (k === 'splitAPT') r[h] = e.unit === 'LINTAS' ? e.costSplit.APT : '';
      else if (k === 'bankAccount') r[h] = NP.sec.can('bank.view') ? e.bankAccount : u.maskAccount(e.bankAccount);
      else r[h] = e[k] === undefined ? '' : e[k];
    }
    return r;
  }
  function importTemplateRow() {
    return toRow(Object.assign(emp.blank(), { id: '(kosongkan untuk baru)', name: 'Contoh Nama', phone: '081234567890', department: 'Kasir & Penjualan', baseSalary: 2500000 }));
  }
  function exportExcel(list) {
    NP.exp.excel([{ name: 'Karyawan', rows: list.map(toRow) }], 'data-karyawan-' + u.todayISO() + '.xlsx');
    NP.audit.log('employee.export', 'employee', '', 'Ekspor ' + list.length + ' karyawan');
  }
  async function importExcel(onDone) {
    const f = await ui.pickFile('.xlsx,.xls,.csv');
    if (!f) return;
    let rows;
    try {
      rows = await NP.exp.readExcel(f);
    } catch (e) {
      return ui.toast('File tidak dapat dibaca: ' + e.message, 'error');
    }
    const existing = await NP.db.all('employees');
    const results = [];
    for (const [i, r] of rows.entries()) {
      const get = (k) => {
        const h = COLS.find((c) => c[1] === k)[0];
        return r[h] !== undefined ? r[h] : r[k] !== undefined ? r[k] : '';
      };
      const id = String(get('id') || '').trim();
      const base = existing.find((x) => x.id === id) || emp.blank();
      const e = Object.assign(u.clone(base), {
        name: String(get('name')).trim(), gender: get('gender'), address: get('address'), phone: String(get('phone')).trim(), email: String(get('email')).trim(),
        unit: String(get('unit') || 'APT').trim().toUpperCase(), position: String(get('position')).trim(), department: String(get('department')).trim(),
        startDate: normalizeDate(get('startDate')) || u.todayISO(), status: String(get('status') || 'aktif').trim().toLowerCase(), baseSalary: u.toInt(get('baseSalary')),
        payScheme: String(get('payScheme') || 'monthly').trim(), payMethod: get('payMethod') || 'Transfer Bank', bankName: get('bankName'),
        str: get('str'), sip: get('sip'), schedule: get('schedule'), ptkp: get('ptkp') || 'TK/0', notes: get('notes')
      });
      const acc = String(get('bankAccount') || '').trim();
      if (acc && !acc.includes('*')) e.bankAccount = acc.replace(/\s/g, '');
      if (e.unit === 'LINTAS') e.costSplit = { APT: u.toNum(get('splitAPT') || 50) };
      if (!C.PAY_SCHEMES[e.payScheme]) {
        const found = Object.entries(C.PAY_SCHEMES).find(([, v]) => v.label.toLowerCase() === e.payScheme.toLowerCase());
        e.payScheme = found ? found[0] : 'monthly';
      }
      if (!id || !existing.find((x) => x.id === id)) e.id = '';
      const errs = emp.validate(e, existing.concat(results.filter((x) => x.ok).map((x) => x.e)));
      results.push({ row: i + 2, e, ok: !errs.length, errs });
    }
    const ok = results.filter((x) => x.ok);
    ui.modal({
      title: 'Pratinjau Impor Karyawan',
      size: 'lg',
      body: `<p>${ok.length} baris valid, ${results.length - ok.length} baris bermasalah.</p>
        <div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Baris</th><th>Nama</th><th>Unit</th><th>Jabatan</th><th>Status</th></tr></thead><tbody>
        ${results.map((x) => `<tr><td>${x.row}</td><td>${u.esc(x.e.name)}${x.e.id ? ' <small>(update ' + x.e.id + ')</small>' : ''}</td><td>${u.esc(x.e.unit)}</td><td>${u.esc(x.e.position)}</td><td>${x.ok ? ui.badge('Valid', 'green') : '<span class="text-danger small">' + x.errs.map(u.esc).join('<br>') + '</span>'}</td></tr>`).join('')}
        </tbody></table></div>`,
      actions: [
        { label: 'Batal', cls: 'btn-ghost', onClick: (m) => m.close() },
        {
          label: 'Impor ' + ok.length + ' karyawan', cls: 'btn-primary', onClick: async (m) => {
            if (!ok.length) return ui.toast('Tidak ada baris valid untuk diimpor.', 'warning');
            let n = 0;
            for (const x of ok) {
              try {
                await emp.save(x.e);
                n++;
              } catch (err) {
                ui.toast('Baris ' + x.row + ': ' + err.message, 'error');
              }
            }
            m.close();
            ui.toast(n + ' karyawan berhasil diimpor.');
            onDone && onDone();
          }
        }
      ]
    });
  }
  function normalizeDate(v) {
    if (!v) return '';
    if (v instanceof Date) return u.todayISO(v);
    if (typeof v === 'number') {
      const d = new Date(Math.round((v - 25569) * 86400000));
      return u.todayISO(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (m) return m[3] + '-' + u.pad(m[2]) + '-' + u.pad(m[1]);
    return '';
  }

  NP.pages.employees = { title: 'Data Karyawan', render };
})(typeof globalThis !== 'undefined' ? globalThis : window);
