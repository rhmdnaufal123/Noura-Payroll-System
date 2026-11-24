/* Noura Payroll — INPUT BULANAN: input tindakan sekaligus untuk satu bulan.
 *  1. Tabel bulanan: baris = tindakan, kolom = tanggal 1..31. Setiap tanggal yang terisi menjadi
 *     satu transaksi (berisi semua tindakan pada tanggal itu). Pembagian pendapatan dihitung sama
 *     persis seperti Input Tindakan harian.
 *  2. Impor file POS: file ekspor penjualan apotek (sheet "Penjualan"). Setiap struk berisi tindakan
 *     menjadi satu transaksi bernomor referensi POS:<kode struk>; struk yang sudah pernah diimpor dilewati.
 * Semua transaksi disimpan sekaligus dalam satu transaksi database (Supabase).
 */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;
  const C = NP.C;
  const rs = NP.rs;

  const WD = ['M', 'S', 'S', 'R', 'K', 'J', 'S']; // Minggu..Sabtu
  const MAX_ITEMS = 50;
  const st = { tab: 'grid', period: u.todayISO().slice(0, 7) };

  const staffFor = (employees, role) => employees.filter((e) => (e.status === 'aktif' || e.status === 'cuti') && (role === 'petugas' || (C.ROLES[role] && C.ROLES[role].positions.includes(e.position))));

  function draftKey(p) {
    return 'noura.bulkDraft.' + p;
  }
  function loadDraft(p) {
    try {
      const d = JSON.parse(localStorage.getItem(draftKey(p)) || 'null');
      return d && Array.isArray(d.rows) ? d.rows : [];
    } catch (_) {
      return [];
    }
  }
  function saveDraft(p, rows) {
    try {
      if (rows.some((r) => Object.keys(r.q).length)) localStorage.setItem(draftKey(p), JSON.stringify({ rows, ts: Date.now() }));
      else localStorage.removeItem(draftKey(p));
    } catch (_) {}
  }

  /** Pecah item per transaksi (maks. 50 tindakan per transaksi). */
  function chunkItems(items) {
    const out = [];
    for (let i = 0; i < items.length; i += MAX_ITEMS) out.push(items.slice(i, i + MAX_ITEMS));
    return out;
  }

  const rowName = (s, r) => s.name + (rs.effectiveWithDoctor(s, r.withDoctor) ? ' (dengan dokter)' : rs.hasDoctorVariant(s) ? ' (tanpa dokter)' : '');
  const rowKey = (id, wd) => id + '|' + (wd ? 1 : 0);

  /** Susun transaksi dari tabel bulanan. */
  function buildFromGrid(period, rows, svcMap, empMap) {
    const errors = [];
    const days = new Date(+period.slice(0, 4), +period.slice(5, 7), 0).getDate();
    for (const r of rows) {
      const s = svcMap.get(r.serviceId);
      if (!s) continue;
      if (!Object.values(r.q).some((v) => v > 0)) continue;
      const res = rs.compute(s, { price: r.price, qty: 1, performers: r.performers, employees: empMap, withDoctor: r.withDoctor });
      if (res.errors.length) errors.push(rowName(s, r) + ': ' + res.errors.join(' '));
      if (!(r.price > 0)) errors.push(s.name + ': harga harus lebih dari 0.');
    }
    const list = [];
    for (let d = 1; d <= days; d++) {
      const items = rows
        .filter((r) => svcMap.get(r.serviceId) && r.q[d] > 0)
        .map((r) => {
          const s = svcMap.get(r.serviceId);
          const wd = rs.effectiveWithDoctor(s, r.withDoctor);
          const performers = {};
          for (const role of rs.requiredRoles(s, wd)) if (r.performers[role]) performers[role] = r.performers[role];
          return { serviceId: r.serviceId, qty: r.q[d], price: r.price, withDoctor: wd, performers };
        });
      if (!items.length) continue;
      const date = period + '-' + String(d).padStart(2, '0');
      for (const part of chunkItems(items)) list.push({ date, patient: '', patientCode: '', note: 'Input bulanan ' + u.periodLabel(period), items: part });
    }
    return { list, errors };
  }

  async function render(view, params) {
    if (params.tab) st.tab = params.tab;
    if (/^\d{4}-\d{2}$/.test(params.month || '')) st.period = params.month;
    view.innerHTML = `
      <div class="page-head">
        <div><h2>Input Bulanan</h2><p class="muted">Masukkan tindakan sekaligus untuk satu bulan — lewat tabel per tanggal atau impor file penjualan POS.</p></div>
        <div class="actions"><a class="btn btn-ghost" href="#/analysis">${ui.icon('pie')}<span>Analisis Tindakan</span></a></div>
      </div>
      <div id="bk-tabs"></div>
      <div id="bk-body"></div>`;
    const body = ui.$('#bk-body', view);
    ui.tabs(ui.$('#bk-tabs', view), [{ key: 'grid', label: 'Tabel bulanan', icon: 'calendar' }, { key: 'pos', label: 'Impor file POS', icon: 'upload' }], st.tab, (k) => {
      st.tab = k;
      draw();
    });
    async function draw() {
      body.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      if (st.tab === 'pos') await renderPos(body);
      else await renderGrid(body);
    }
    await draw();
  }

  /* ===================== Tabel bulanan ===================== */
  // Setiap render memakai kontainer baru agar listener lama tidak menumpuk (mis. simpan dua kali).
  function freshHost(outer) {
    const host = document.createElement('div');
    outer.textContent = '';
    outer.appendChild(host);
    return host;
  }

  async function renderGrid(outer) {
    const [services, employees, trxs] = await Promise.all([NP.svc.all(), NP.emp.all(), NP.trx.all()]);
    const host = freshHost(outer);
    const svcMap = new Map(services.map((s) => [s.id, s]));
    const empMap = new Map(employees.map((e) => [e.id, e]));
    const today = u.todayISO();
    const maxPeriod = today.slice(0, 7);
    if (st.period > maxPeriod) st.period = maxPeriod;
    const period = st.period;
    const days = new Date(+period.slice(0, 4), +period.slice(5, 7), 0).getDate();
    const dayList = Array.from({ length: days }, (_, i) => i + 1);
    const isFuture = (d) => period + '-' + String(d).padStart(2, '0') > today;
    const rows = loadDraft(period).filter((r) => svcMap.has(r.serviceId));
    for (const r of rows) r.withDoctor = rs.effectiveWithDoctor(svcMap.get(r.serviceId), r.withDoctor);

    // yang sudah tercatat pada bulan ini (agar tidak terinput dua kali)
    const monthTrx = trxs.filter((t) => t.status === 'active' && t.date.slice(0, 7) === period);
    const recorded = new Map();
    for (const t of monthTrx) for (const it of t.items) recorded.set(rowKey(it.serviceId, it.withDoctor), (recorded.get(rowKey(it.serviceId, it.withDoctor)) || 0) + it.qty);
    const recordedQty = u.sum([...recorded.values()], (v) => v);

    const activeSvc = services.filter((s) => s.active);
    const byCat = u.groupBy(activeSvc, (s) => s.category);
    const addOptions = () =>
      '<option value="">+ Tambah tindakan…</option>' +
      C.SERVICE_CATEGORIES.filter((c) => byCat.has(c))
        .map((c) => `<optgroup label="${u.esc(c)}">${[].concat(...byCat.get(c).map((s) => (rs.hasDoctorVariant(s) ? [[s, false], [s, true]] : [[s, false]])))
          .filter(([s, wd]) => !rows.some((r) => r.serviceId === s.id && !!r.withDoctor === wd))
          .map(([s, wd]) => `<option value="${rowKey(s.id, wd)}">${u.esc(s.name)}${rs.hasDoctorVariant(s) ? (wd ? ' — dengan dokter' : ' — tanpa dokter') : ''} — ${u.rp(s.price)}</option>`).join('')}</optgroup>`)
        .join('');

    host.innerHTML = `
      <div class="card">
        <div class="filters">
          <label class="field-inline">Bulan <input type="month" id="bk-month" value="${period}" max="${maxPeriod}"></label>
          <select id="bk-add" class="bk-add">${addOptions()}</select>
          <button type="button" class="btn btn-ghost" data-act="add-all">${ui.icon('plus')}<span>Semua tindakan aktif</span></button>
          <button type="button" class="btn btn-ghost" data-act="clear">${ui.icon('refresh')}<span>Kosongkan</span></button>
        </div>
        ${monthTrx.length ? `<div class="alert alert-info">${ui.icon('info')}<div>Pada ${u.esc(u.periodLabel(period))} sudah tercatat <b>${u.num(monthTrx.length)} transaksi</b> (${u.num(recordedQty)} tindakan). Kolom <b>Sudah tercatat</b> membantu agar tindakan tidak terinput dua kali.</div></div>` : ''}
        <p class="muted small">Isi jumlah tindakan pada tanggalnya. Setiap tanggal yang terisi disimpan sebagai satu transaksi; pembagian pendapatan mengikuti Master Tindakan. Isian tersimpan otomatis di perangkat ini sampai disimpan.</p>
        <div id="bk-grid"></div>
      </div>
      <div class="card bk-savebar">
        <div id="bk-sum" class="bk-sum"></div>
        <button type="button" class="btn btn-primary" data-act="save">${ui.icon('check')}<span>Simpan semua</span></button>
      </div>`;

    const gridEl = ui.$('#bk-grid', host);
    function rowTotals(r) {
      const qty = u.sum(dayList, (d) => r.q[d] || 0);
      return { qty, gross: qty * (r.price || 0) };
    }
    function drawGrid() {
      if (!rows.length) {
        gridEl.innerHTML = ui.empty('Pilih tindakan dengan <b>+ Tambah tindakan</b> atau tombol <b>Semua tindakan aktif</b>.', 'calendar');
        drawSum();
        return;
      }
      const dayHead = dayList
        .map((d) => {
          const dt = new Date(+period.slice(0, 4), +period.slice(5, 7) - 1, d);
          return `<th class="bk-day ${dt.getDay() === 0 ? 'bk-sun' : ''} ${isFuture(d) ? 'bk-future' : ''}"><span>${d}</span><small>${WD[dt.getDay()]}</small></th>`;
        })
        .join('');
      gridEl.innerHTML = `<div class="bk-wrap"><table class="bk-table">
        <thead><tr><th class="bk-name">Tindakan</th>${dayHead}<th class="bk-tot">Jumlah</th><th class="bk-tot">Total</th><th class="bk-tot">Sudah tercatat</th></tr></thead>
        <tbody>${rows
          .map((r, i) => {
            const s = svcMap.get(r.serviceId);
            const roles = rs.requiredRoles(s, r.withDoctor);
            const tot = rowTotals(r);
            return `<tr data-i="${i}">
              <th class="bk-name">
                <div class="bk-title"><b>${u.esc(s.name)}</b><button type="button" class="icon-btn danger" data-del="${i}" title="Hapus baris" aria-label="Hapus baris ${u.esc(s.name)}">${ui.icon('trash')}</button></div>
                <small class="muted">${u.esc(s.category)}</small>
                ${rs.hasDoctorVariant(s) ? `<span class="bk-variant ${r.withDoctor ? 'doc' : ''}">${r.withDoctor ? 'Dengan dokter' : 'Tanpa dokter'}</span>` : ''}
                <div class="input-prefix bk-price"><span>Rp</span><input data-f="price" data-money inputmode="numeric" value="${ui.moneyVal(r.price)}" aria-label="Harga ${u.esc(s.name)}"></div>
                ${roles.map((role) => `<select data-perf="${role}" aria-label="${C.ROLES[role].label} pelaksana">${ui.options(staffFor(employees, role).map((e) => [e.id, e.name]), r.performers[role], '— ' + C.ROLES[role].label.toLowerCase() + ' pelaksana —')}</select>`).join('')}
              </th>
              ${dayList.map((d) => `<td class="${isFuture(d) ? 'bk-future' : ''}"><input class="bk-cell ${r.q[d] ? 'has' : ''}" data-d="${d}" inputmode="numeric" pattern="[0-9]*" maxlength="3" value="${r.q[d] || ''}" ${isFuture(d) ? 'disabled' : ''} aria-label="${u.esc(s.name)} tanggal ${d}"></td>`).join('')}
              <td class="bk-tot" data-tq>${u.num(tot.qty)}</td><td class="bk-tot" data-tg>${u.rp(tot.gross)}</td><td class="bk-tot muted">${u.num(recorded.get(rowKey(r.serviceId, r.withDoctor)) || 0)}</td>
            </tr>`;
          })
          .join('')}</tbody>
        <tfoot><tr><th class="bk-name">Total per tanggal</th>${dayList.map((d) => `<td data-fd="${d}">${dayTotal(d) || ''}</td>`).join('')}<td class="bk-tot" data-fq></td><td class="bk-tot" data-fg></td><td class="bk-tot"></td></tr></tfoot>
      </table></div>`;
      drawSum();
    }
    const dayTotal = (d) => u.sum(rows, (r) => r.q[d] || 0);
    function drawSum() {
      const qty = u.sum(rows, (r) => rowTotals(r).qty);
      const gross = u.sum(rows, (r) => rowTotals(r).gross);
      const nDays = dayList.filter((d) => dayTotal(d) > 0).length;
      const fq = gridEl.querySelector('[data-fq]');
      if (fq) fq.textContent = u.num(qty);
      const fg = gridEl.querySelector('[data-fg]');
      if (fg) fg.textContent = u.rp(gross);
      ui.$('#bk-sum', host).innerHTML = `<div><span>Tindakan</span><b>${u.num(qty)}</b></div><div><span>Pendapatan kotor</span><b>${u.rp(gross)}</b></div><div><span>Transaksi (tanggal terisi)</span><b>${u.num(nDays)}</b></div>`;
    }
    function persist() {
      saveDraft(period, rows);
    }
    function addService(id, withDoctor) {
      const s = svcMap.get(id);
      const wd = rs.effectiveWithDoctor(s, withDoctor);
      if (!s || rows.some((r) => r.serviceId === id && !!r.withDoctor === wd)) return;
      const perf = {};
      for (const role of rs.requiredRoles(s, wd)) {
        const prev = rows.find((r) => r.performers[role]);
        if (prev) perf[role] = prev.performers[role];
        else {
          const staff = staffFor(employees, role);
          if (staff.length === 1) perf[role] = staff[0].id;
        }
      }
      rows.push({ serviceId: id, withDoctor: wd, price: s.price, performers: perf, q: {} });
    }

    gridEl.addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const r = rows[+tr.dataset.i];
      if (e.target.classList.contains('bk-cell')) {
        const clean = e.target.value.replace(/[^0-9]/g, '').slice(0, 3);
        if (clean !== e.target.value) e.target.value = clean;
        const v = parseInt(clean, 10) || 0;
        const d = +e.target.dataset.d;
        if (v > 0) r.q[d] = v;
        else delete r.q[d];
        e.target.classList.toggle('has', v > 0);
        const fd = gridEl.querySelector(`[data-fd="${d}"]`);
        if (fd) fd.textContent = dayTotal(d) || '';
      } else if (e.target.dataset.f === 'price') {
        r.price = u.toInt(e.target.value);
      } else return;
      const tot = rowTotals(r);
      tr.querySelector('[data-tq]').textContent = u.num(tot.qty);
      tr.querySelector('[data-tg]').textContent = u.rp(tot.gross);
      drawSum();
      persist();
    });
    gridEl.addEventListener('change', (e) => {
      if (!e.target.dataset.perf) return;
      const r = rows[+e.target.closest('tr[data-i]').dataset.i];
      if (e.target.value) r.performers[e.target.dataset.perf] = e.target.value;
      else delete r.performers[e.target.dataset.perf];
      persist();
    });
    gridEl.addEventListener('keydown', (e) => {
      if (!e.target.classList.contains('bk-cell')) return;
      const td = e.target.closest('td');
      const tr = td.parentElement;
      const col = [...tr.children].indexOf(td);
      let target = null;
      if (e.key === 'ArrowDown' || e.key === 'Enter') target = tr.nextElementSibling && tr.nextElementSibling.children[col];
      else if (e.key === 'ArrowUp') target = tr.previousElementSibling && tr.previousElementSibling.children[col];
      else if (e.key === 'ArrowRight' && e.target.selectionStart === e.target.value.length) target = td.nextElementSibling;
      else if (e.key === 'ArrowLeft' && e.target.selectionStart === 0) target = td.previousElementSibling;
      const inp = target && target.querySelector && target.querySelector('.bk-cell:not([disabled])');
      if (inp) {
        e.preventDefault();
        inp.focus();
        inp.select();
      }
    });
    gridEl.addEventListener('click', (e) => {
      const d = e.target.closest('[data-del]');
      if (!d) return;
      rows.splice(+d.dataset.del, 1);
      persist();
      redraw();
    });
    function redraw() {
      ui.$('#bk-add', host).innerHTML = addOptions();
      drawGrid();
    }
    ui.$('#bk-add', host).onchange = (e) => {
      if (!e.target.value) return;
      const [sid, wd] = e.target.value.split('|');
      addService(sid, wd === '1');
      persist();
      redraw();
      const last = gridEl.querySelector('tbody tr:last-child .bk-cell:not([disabled])');
      last && last.scrollIntoView({ block: 'nearest' });
    };
    ui.$('#bk-month', host).onchange = (e) => {
      if (!e.target.value) return;
      st.period = e.target.value > maxPeriod ? maxPeriod : e.target.value;
      renderGrid(outer);
    };
    host.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'add-all') {
        activeSvc.forEach((s) => {
          addService(s.id, false);
          if (rs.hasDoctorVariant(s)) addService(s.id, true);
        });
        persist();
        redraw();
      }
      if (a.dataset.act === 'clear') {
        if (rows.some((r) => Object.keys(r.q).length) && !(await ui.confirm({ title: 'Kosongkan tabel', message: 'Semua isian pada tabel bulan ini akan dihapus. Lanjutkan?', danger: true, okLabel: 'Kosongkan' }))) return;
        rows.splice(0);
        persist();
        redraw();
      }
      if (a.dataset.act === 'save') save();
    });

    async function save() {
      const { list, errors } = buildFromGrid(period, rows, svcMap, empMap);
      if (errors.length) return ui.toast(errors.join(' '), 'error');
      if (!list.length) return ui.toast('Belum ada jumlah tindakan yang diisi.', 'error');
      const qty = u.sum(list, (t) => u.sum(t.items, (i) => i.qty));
      const gross = u.sum(list, (t) => u.sum(t.items, (i) => i.qty * i.price));
      const ok = await ui.confirm({
        title: 'Simpan input bulanan',
        html: `Simpan <b>${u.num(list.length)} transaksi</b> (${u.num(qty)} tindakan, ${u.rp(gross)}) untuk <b>${u.esc(u.periodLabel(period))}</b>?${monthTrx.length ? `<br><small>Bulan ini sudah memiliki ${u.num(monthTrx.length)} transaksi. Pastikan isian ini belum pernah dicatat.</small>` : ''}`,
        okLabel: 'Simpan semua'
      });
      if (!ok) return;
      try {
        const res = await ui.busy('Menyimpan ' + list.length + ' transaksi…', (msg) => NP.trx.bulkSave(list, 'Input bulanan ' + u.periodLabel(period), (i, n) => msg('Menyimpan ' + i + '/' + n + ' transaksi…')));
        rows.splice(0);
        persist();
        ui.toast(u.num(res.created.length) + ' transaksi tersimpan (' + u.num(qty) + ' tindakan, ' + u.rp(res.gross) + ').');
        renderGrid(outer);
      } catch (e) {
        ui.toast(e.message, 'error');
        if (e.partial) renderGrid(outer);
      }
    }
    drawGrid();
  }

  /* ===================== Impor file POS ===================== */
  const pos = { file: null, parsed: null, cats: null, defaults: {}, doctorMode: 'column' };

  async function renderPos(outer) {
    const [services, employees, trxs] = await Promise.all([NP.svc.all(), NP.emp.all(), NP.trx.all()]);
    const host = freshHost(outer);
    const canMaster = NP.sec.can('services.edit');
    host.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>1. Pilih file ekspor penjualan POS</h3></div>
        <p class="muted small">Gunakan file Excel ekspor penjualan dari aplikasi kasir (sheet <b>Penjualan</b>: Kode Struk, Tanggal, Nama Produk, Kategori Produk, Jumlah, Harga Jual, Pelanggan, Dokter). Hanya produk berkategori tindakan yang diambil — penjualan obat diabaikan. Struk yang sudah pernah diimpor otomatis dilewati.</p>
        <div class="filters">
          <button type="button" class="btn btn-primary" data-act="pick">${ui.icon('upload')}<span>${pos.parsed ? 'Ganti file' : 'Pilih file Excel'}</span></button>
          ${pos.parsed ? `<span class="pos-file">${ui.icon('excel')}<b>${u.esc(pos.file)}</b> · ${u.esc(pos.parsed.meta.outlet || '')} · ${pos.parsed.meta.from ? u.fmtDate(pos.parsed.meta.from) + ' – ' + u.fmtDate(pos.parsed.meta.to) : ''} · sheet ${u.esc(pos.parsed.sheet)} · ${u.num(pos.parsed.lines.length)} baris</span>` : ''}
        </div>
      </div>
      <div id="pos-body"></div>`;
    host.querySelector('[data-act="pick"]').onclick = async () => {
      const f = await ui.pickFile('.xlsx,.xls,.csv');
      if (!f) return;
      try {
        if (!root.XLSX) throw new Error('Pustaka Excel (SheetJS) tidak tersedia.');
        const buf = await ui.readFile(f, 'buffer');
        const parsed = NP.pos.parseWorkbook(XLSX.read(buf, { type: 'array' }), XLSX);
        pos.file = f.name;
        pos.parsed = parsed;
        pos.cats = new Set(NP.pos.categorySummary(parsed.lines).filter((c) => c.service).map((c) => c.category));
        renderPos(outer);
      } catch (e) {
        ui.toast(e.message, 'error');
      }
    };
    if (!pos.parsed) return;

    const bodyEl = ui.$('#pos-body', host);
    const roles = {};
    for (const k of Object.keys(C.ROLES)) roles[k] = staffFor(employees, k);
    const existingRefs = new Set(trxs.filter((t) => t.status === 'active' && t.externalRef).map((t) => t.externalRef));
    const catSum = NP.pos.categorySummary(pos.parsed.lines);
    const P = NP.pos.plan(pos.parsed.lines, services, employees, { categories: pos.cats, defaults: pos.defaults, roles, doctorMode: pos.doctorMode });
    const variantUsed = P.transactions.some((t) => t.items.some((i) => rs.hasDoctorVariant(services.find((s) => s.id === i.serviceId))));
    const fresh = P.transactions.filter((t) => !existingRefs.has(t.externalRef));
    const already = P.transactions.length - fresh.length;
    const neededRoles = [];
    for (const t of P.transactions) for (const i of t.items) for (const role of rs.requiredRoles(services.find((s) => s.id === i.serviceId), i.withDoctor)) if (!neededRoles.includes(role)) neededRoles.push(role);
    const problems = P.problems.filter((p) => !existingRefs.has('POS:' + p.ref));
    const groupTot = {};
    for (const t of P.transactions) for (const i of t.items) {
      const g = C.serviceGroup(i.category, i.serviceName);
      const x = groupTot[g] || (groupTot[g] = { qty: 0, gross: 0 });
      x.qty += i.qty;
      x.gross += i.qty * i.price;
    }
    for (const x of P.unmatched) {
      const g = C.serviceGroup(x.category, x.name);
      const y = groupTot[g] || (groupTot[g] = { qty: 0, gross: 0 });
      y.unmatched = (y.unmatched || 0) + x.qty;
    }

    bodyEl.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>2. Kategori produk yang diimpor</h3></div>
        <div class="pos-cats">${catSum
          .map((c) => `<label class="check pos-cat ${c.service ? 'is-svc' : ''}"><input type="checkbox" data-cat="${u.esc(c.category)}" ${pos.cats.has(c.category) ? 'checked' : ''}><span><b>${u.esc(c.category)}</b><small>${u.num(c.qty)} item · ${u.rp(c.total)} · ${u.num(c.products)} produk</small></span></label>`)
          .join('')}</div>
      </div>
      ${P.unmatched.length ? `<div class="card">
        <div class="card-head"><h3>3. Tindakan belum ada di Master Tindakan (${P.unmatched.length})</h3></div>
        <p class="muted small">Nama produk POS dicocokkan dengan nama di Master Tindakan. ${canMaster ? 'Centang lalu tambahkan ke Master Tindakan. Seluruh pendapatannya masuk ke unit yang dipilih — <b>atur pembagian jasa dokter/bidan di Master Tindakan sebelum mengimpor transaksi</b>, karena pembagian disimpan saat transaksi dibuat.' : 'Minta Administrator menambahkannya di Master Tindakan dengan nama yang sama.'}</p>
        <div class="table-wrap"><table class="tbl pos-unm"><thead><tr>${canMaster ? '<th><input type="checkbox" id="unm-all" checked aria-label="Pilih semua"></th>' : ''}<th>Nama produk POS</th><th>Kategori tindakan</th><th>Unit</th><th class="ta-right">Harga</th><th class="ta-right">Jumlah</th><th class="ta-right">Total</th></tr></thead>
        <tbody>${P.unmatched
          .map((x, i) => `<tr data-u="${i}">${canMaster ? `<td><input type="checkbox" data-unm checked aria-label="Pilih ${u.esc(x.name)}"></td>` : ''}<td><b>${u.esc(x.name)}</b><small class="block muted">${u.esc(x.posCategory || '-')}</small></td>
            <td><select data-ucat>${ui.options(C.SERVICE_CATEGORIES, x.category)}</select></td>
            <td><select data-uunit>${ui.options(Object.values(C.UNITS).map((un) => [un.code, un.short]), 'APT')}</select></td>
            <td class="ta-right"><div class="input-prefix"><span>Rp</span><input data-uprice data-money inputmode="numeric" value="${ui.moneyVal(x.price)}"></div></td>
            <td class="ta-right">${u.num(x.qty)}</td><td class="ta-right">${u.rp(x.total)}</td></tr>`)
          .join('')}</tbody></table></div>
        ${canMaster ? `<div class="form-actions"><button type="button" class="btn btn-primary" data-act="create-master">${ui.icon('plus')}<span>Tambahkan ke Master Tindakan</span></button></div>` : ''}
      </div>` : ''}
      ${variantUsed ? `<div class="card">
        <div class="card-head"><h3>Tindakan dengan / tanpa dokter</h3></div>
        <p class="muted small">Beberapa tindakan memiliki pembagian berbeda bila dilakukan dengan dokter. Tentukan cara membacanya dari file.</p>
        <div class="seg pos-doc" role="radiogroup" aria-label="Penentuan dengan dokter">${[['column', 'Dengan dokter bila kolom Dokter terisi'], ['always', 'Selalu dengan dokter'], ['never', 'Selalu tanpa dokter']].map(([k, l]) => `<button type="button" class="seg-btn ${pos.doctorMode === k ? 'active' : ''}" data-dmode="${k}" role="radio" aria-checked="${pos.doctorMode === k}">${l}</button>`).join('')}</div>
      </div>` : ''}
      ${neededRoles.length ? `<div class="card">
        <div class="card-head"><h3>${P.unmatched.length ? '4' : '3'}. Pelaksana default</h3></div>
        <p class="muted small">Dipakai untuk tindakan yang pembagiannya membutuhkan pelaksana. Kolom <b>Dokter</b> di file dicocokkan otomatis dengan nama dokter di Data Karyawan.</p>
        <div class="grid-3">${neededRoles.map((role) => `<label class="field"><span>${C.ROLES[role].label} pelaksana default</span><select data-def="${role}">${ui.options(roles[role].map((e) => [e.id, e.name]), pos.defaults[role], '— pilih ' + C.ROLES[role].label.toLowerCase() + ' —')}</select></label>`).join('')}</div>
      </div>` : ''}
      <div class="card">
        <div class="card-head"><h3>Pratinjau impor</h3><small class="muted">${u.esc(pos.file)}</small></div>
        <div class="stats-row">
          ${ui.stat('Transaksi baru', u.num(fresh.length), { icon: 'input', sub: already ? u.num(already) + ' struk sudah pernah diimpor (dilewati)' : 'struk berisi tindakan' })}
          ${ui.stat('Tindakan', u.num(u.sum(fresh, (t) => t.qty)), { icon: 'medical', sub: P.unmatched.length ? u.num(u.sum(P.unmatched, (x) => x.qty)) + ' belum ada di master' : 'semua cocok dengan master' })}
          ${ui.stat('Pendapatan kotor', u.rp(u.sum(fresh, (t) => t.gross)), { icon: 'wallet' })}
          ${Object.keys(C.SERVICE_GROUPS).filter((g) => groupTot[g]).map((g) => ui.stat(C.SERVICE_GROUPS[g], u.num(groupTot[g].qty) + ' tindakan', { icon: g === 'homecare' ? 'users' : 'medical', sub: u.rp(groupTot[g].gross) + (groupTot[g].unmatched ? ' · +' + groupTot[g].unmatched + ' belum di master' : '') })).join('')}
        </div>
        ${problems.length ? `<div class="alert alert-warning">${ui.icon('warn')}<div><b>Perlu diperbaiki sebelum impor:</b><ul>${[...new Set(problems.map((p) => p.msg))].slice(0, 8).map((m) => `<li>${u.esc(m)}</li>`).join('')}</ul></div></div>` : ''}
        <div id="pos-table"></div>
        <div class="form-actions">
          <button type="button" class="btn btn-primary" data-act="import" ${!fresh.length || P.unmatched.length || problems.length ? 'disabled' : ''}>${ui.icon('check')}<span>Impor ${u.num(fresh.length)} transaksi</span></button>
        </div>
        ${P.unmatched.length ? `<p class="muted small ta-right">Tambahkan dulu ${P.unmatched.length} tindakan yang belum ada di Master Tindakan, atau hapus centang kategorinya.</p>` : ''}
      </div>`;

    ui.table(ui.$('#pos-table', bodyEl), {
      columns: [
        { key: 'date', label: 'Tanggal', render: (t) => u.fmtDate(t.date) + (t.time ? `<small class="block muted">${t.time}</small>` : '') },
        { key: 'externalRef', label: 'Struk', render: (t) => `${u.esc(t.externalRef.replace(/^POS:/, ''))}${existingRefs.has(t.externalRef) ? ' ' + ui.badge('sudah diimpor', 'gray') : ''}` },
        { key: 'patient', label: 'Pasien', render: (t) => u.esc(t.patient || '-') + (t.doctor ? `<small class="block muted">${u.esc(t.doctor)}</small>` : '') },
        { key: 'items', label: 'Tindakan', sortable: false, render: (t) => t.items.map((i) => `${u.esc(i.serviceName)}${i.withDoctor ? ' <span class="bk-variant doc">dengan dokter</span>' : ''}${i.qty > 1 ? ' ×' + i.qty : ''}`).join('<br>') },
        { key: 'gross', label: 'Total', align: 'right', render: (t) => u.rp(t.gross) }
      ],
      rows: P.transactions,
      sortKey: 'date',
      pageSize: 15,
      cards: true,
      empty: 'Tidak ada tindakan pada kategori yang dipilih.'
    });

    bodyEl.addEventListener('change', (e) => {
      if (e.target.dataset.cat !== undefined) {
        if (e.target.checked) pos.cats.add(e.target.dataset.cat);
        else pos.cats.delete(e.target.dataset.cat);
        renderPos(outer);
      } else if (e.target.dataset.def) {
        if (e.target.value) pos.defaults[e.target.dataset.def] = e.target.value;
        else delete pos.defaults[e.target.dataset.def];
        renderPos(outer);
      } else if (e.target.id === 'unm-all') {
        bodyEl.querySelectorAll('[data-unm]').forEach((c) => (c.checked = e.target.checked));
      }
    });
    bodyEl.addEventListener('click', async (e) => {
      const dm = e.target.closest('[data-dmode]');
      if (dm) {
        pos.doctorMode = dm.dataset.dmode;
        renderPos(outer);
        return;
      }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'create-master') {
        const picks = [...bodyEl.querySelectorAll('tr[data-u]')].filter((tr) => tr.querySelector('[data-unm]').checked);
        if (!picks.length) return ui.toast('Pilih minimal satu tindakan.', 'error');
        try {
          await ui.busy('Menambahkan ' + picks.length + ' tindakan…', async (msg) => {
            for (const [n, tr] of picks.entries()) {
              const x = P.unmatched[+tr.dataset.u];
              const unit = tr.querySelector('[data-uunit]').value;
              msg('Menambahkan ' + (n + 1) + '/' + picks.length + ': ' + x.name);
              await NP.svc.save({
                id: '', code: '', name: x.name, category: tr.querySelector('[data-ucat]').value, unit, price: u.toInt(tr.querySelector('[data-uprice]').value),
                shares: [{ type: 'unit', target: unit, mode: 'remainder', value: 0 }], overrides: [], active: true, notes: 'Dibuat dari impor POS ' + pos.file
              });
            }
          });
          ui.toast(picks.length + ' tindakan ditambahkan ke Master Tindakan. Atur pembagian jasa di Master Tindakan bila diperlukan.');
        } catch (err) {
          ui.toast(err.message, 'error');
        }
        renderPos(outer);
      }
      if (a.dataset.act === 'import') {
        const qty = u.sum(fresh, (t) => t.qty);
        const gross = u.sum(fresh, (t) => t.gross);
        const ok = await ui.confirm({ title: 'Impor transaksi POS', html: `Impor <b>${u.num(fresh.length)} transaksi</b> (${u.num(qty)} tindakan, ${u.rp(gross)}) dari <b>${u.esc(pos.file)}</b>?${already ? `<br><small>${u.num(already)} struk yang sudah pernah diimpor dilewati.</small>` : ''}`, okLabel: 'Impor sekarang' });
        if (!ok) return;
        try {
          const list = fresh.map((t) => ({ date: t.date, patient: t.patient, patientCode: '', note: t.note, externalRef: t.externalRef, items: t.items.map((i) => ({ serviceId: i.serviceId, qty: i.qty, price: i.price, withDoctor: i.withDoctor, performers: i.performers })) }));
          const res = await ui.busy('Mengimpor ' + list.length + ' transaksi…', (msg) => NP.trx.bulkSave(list, 'Impor POS ' + pos.file, (i, n) => msg('Mengimpor ' + i + '/' + n + ' transaksi…')));
          ui.toast(u.num(res.created.length) + ' transaksi diimpor (' + u.rp(res.gross) + ')' + (res.skipped.length ? ', ' + res.skipped.length + ' dilewati karena sudah ada' : '') + '.');
        } catch (err) {
          ui.toast(err.message, 'error');
        }
        renderPos(outer);
      }
    });
  }

  NP.bulk = { buildFromGrid, chunkItems };
  NP.pages.bulk = { title: 'Input Bulanan', render };
})(typeof globalThis !== 'undefined' ? globalThis : window);
