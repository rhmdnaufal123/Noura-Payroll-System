/* Noura Payroll — ANALISIS TINDAKAN.
 * Jumlah & pendapatan tindakan per kelompok (Dokter Umum & Bidan, Homecare, Farmasi & Lainnya),
 * per nama tindakan, per kategori, per pelaksana (dokter/bidan/perawat), dan per pasien.
 * Sumber: transaksi aktif (snapshot nama, kategori, harga saat transaksi dibuat). */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;
  const C = NP.C;

  const GROUP_SLOT = { dokter_bidan: 0, homecare: 1, lainnya: 2 };
  const groupColor = (g) => ui.palette()[GROUP_SLOT[g]];
  const normName = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();

  /** Ratakan transaksi menjadi baris tindakan + agregasi. Murni (dapat diuji tanpa browser). */
  function build(trxs, f) {
    const q = normName(f.q);
    const rows = [];
    for (const t of trxs) {
      if (t.status !== 'active' || !u.inRange(t.date, f.start, f.end)) continue;
      for (const it of t.items) {
        const group = C.serviceGroup(it.category, it.serviceName);
        if (f.group && f.group !== 'ALL' && group !== f.group) continue;
        if (f.unit && f.unit !== 'ALL' && it.unit !== f.unit) continue;
        const performers = Object.entries(it.performerNames || {}).map(([role, name]) => ({ role, name, id: (it.performers || {})[role] }));
        if (q && ![it.serviceName, t.patient, t.note, ...performers.map((p) => p.name)].some((x) => normName(x).includes(q))) continue;
        rows.push({ t, it, group, performers });
      }
    }
    const agg = (keyFn, init) => {
      const m = new Map();
      for (const r of rows) {
        const k = keyFn(r);
        if (k == null) continue;
        let x = m.get(k);
        if (!x) m.set(k, (x = Object.assign({ key: k, qty: 0, gross: 0, trx: new Set() }, init(r))));
        x.qty += r.it.qty;
        x.gross += r.it.gross;
        x.trx.add(r.t.id);
      }
      return [...m.values()].map((x) => Object.assign(x, { trx: x.trx.size }));
    };
    const total = { qty: u.sum(rows, (r) => r.it.qty), gross: u.sum(rows, (r) => r.it.gross), trx: new Set(rows.map((r) => r.t.id)).size, patients: new Set(rows.map((r) => normName(r.t.patient)).filter(Boolean)).size };
    const byGroup = agg((r) => r.group, (r) => ({ label: C.SERVICE_GROUPS[r.group] })).sort((a, b) => GROUP_SLOT[a.key] - GROUP_SLOT[b.key]);
    const byCategory = agg((r) => r.it.category, (r) => ({ label: r.it.category, group: r.group })).sort((a, b) => GROUP_SLOT[a.group] - GROUP_SLOT[b.group] || b.qty - a.qty);
    const byService = agg((r) => normName(r.it.serviceName), (r) => ({ name: r.it.serviceName, category: r.it.category, group: r.group })).sort((a, b) => b.qty - a.qty || b.gross - a.gross);
    for (const s of byService) {
      s.avg = s.qty ? Math.round(s.gross / s.qty) : 0;
      s.wdQty = u.sum(rows.filter((r) => r.it.withDoctor && normName(r.it.serviceName) === s.key), (r) => r.it.qty);
    }
    const withDoctorQty = u.sum(rows.filter((r) => r.it.withDoctor), (r) => r.it.qty);
    const byPatient = agg((r) => normName(r.t.patient) || null, (r) => ({ name: r.t.patient.trim(), last: r.t.date, services: new Map() }));
    for (const r of rows) {
      const p = byPatient.find((x) => x.key === normName(r.t.patient));
      if (!p) continue;
      if (r.t.date > p.last) p.last = r.t.date;
      p.services.set(r.it.serviceName, (p.services.get(r.it.serviceName) || 0) + r.it.qty);
    }
    byPatient.sort((a, b) => b.trx - a.trx || b.gross - a.gross);
    // pelaksana: jumlah tindakan yang dikerjakan + jasa yang diterima dari tindakan tersebut
    const perf = new Map();
    for (const r of rows) for (const p of r.performers) {
      const k = p.id || p.name;
      const x = perf.get(k) || { key: k, name: p.name, roles: new Set(), qty: 0, gross: 0, fee: 0, trx: new Set(), groups: {} };
      x.roles.add(p.role);
      x.qty += r.it.qty;
      x.gross += r.it.gross;
      x.trx.add(r.t.id);
      x.groups[r.group] = (x.groups[r.group] || 0) + r.it.qty;
      x.fee += u.sum((r.it.shares || []).filter((s) => s.recipientId && s.recipientId === p.id), (s) => s.amount);
      perf.set(k, x);
    }
    const byPerformer = [...perf.values()].map((x) => Object.assign(x, { roles: [...x.roles], trx: x.trx.size })).sort((a, b) => b.qty - a.qty);
    // tren: harian bila ≤ 62 hari, selain itu bulanan
    const daysSpan = Math.round((u.parseISO(f.end) - u.parseISO(f.start)) / 86400000) + 1;
    const daily = daysSpan <= 62;
    const buckets = [];
    if (daily) for (let d = f.start; d <= f.end; d = u.addDays(d, 1)) buckets.push(d);
    else for (let p = f.start.slice(0, 7); p <= f.end.slice(0, 7); p = u.addMonths(p, 1)) buckets.push(p);
    const idx = new Map(buckets.map((b, i) => [b, i]));
    const trend = {};
    for (const g of Object.keys(C.SERVICE_GROUPS)) trend[g] = buckets.map(() => ({ qty: 0, gross: 0 }));
    for (const r of rows) {
      const i = idx.get(daily ? r.t.date : r.t.date.slice(0, 7));
      if (i === undefined) continue;
      trend[r.group][i].qty += r.it.qty;
      trend[r.group][i].gross += r.it.gross;
    }
    return { rows, total, withDoctorQty, byGroup, byCategory, byService, byPatient, byPerformer, trend: { daily, buckets, series: trend } };
  }

  /* ===================== Halaman ===================== */
  const st = { mode: 'monthly', month: u.todayISO().slice(0, 7), year: new Date().getFullYear(), start: '', end: '', group: 'ALL', unit: 'ALL', q: '' };
  function rangeOf() {
    if (st.mode === 'monthly') return u.monthRange(st.month);
    if (st.mode === 'yearly') return { start: st.year + '-01-01', end: st.year + '-12-31' };
    return { start: st.start || u.presetRange('month').start, end: st.end || u.presetRange('month').end };
  }
  function prevRange() {
    if (st.mode === 'monthly') return u.monthRange(u.addMonths(st.month, -1));
    if (st.mode === 'yearly') return { start: st.year - 1 + '-01-01', end: st.year - 1 + '-12-31' };
    const r = rangeOf();
    const n = Math.round((u.parseISO(r.end) - u.parseISO(r.start)) / 86400000) + 1;
    return { start: u.addDays(r.start, -n), end: u.addDays(r.start, -1) };
  }
  function label() {
    const r = rangeOf();
    if (st.mode === 'monthly') return u.periodLabel(st.month);
    if (st.mode === 'yearly') return 'Tahun ' + st.year;
    return u.fmtDate(r.start, 'long') + ' s.d. ' + u.fmtDate(r.end, 'long');
  }
  function delta(cur, prev, money) {
    if (!prev && !cur) return '';
    if (!prev) return '<span class="delta up">baru</span>';
    const d = ((cur - prev) / prev) * 100;
    const cls = d > 0.05 ? 'up' : d < -0.05 ? 'down' : 'flat';
    return `<span class="delta ${cls}">${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${u.num(Math.abs(d), 1)}%</span> <small class="muted">vs ${money ? u.rp(prev) : u.num(prev)}</small>`;
  }

  async function render(view, params) {
    if (params.group) st.group = params.group;
    if (/^\d{4}-\d{2}$/.test(params.month || '')) {
      st.mode = 'monthly';
      st.month = params.month;
    }
    const years = [];
    for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 5; y--) years.push(y);
    view.innerHTML = `
      <div class="page-head"><div><h2>Analisis Tindakan</h2><p class="muted">Jumlah dan pendapatan tindakan per kelompok Dokter Umum &amp; Bidan dan Homecare, per nama tindakan, pelaksana, dan pasien.</p></div>
        <div class="actions">${NP.sec.can('export') || NP.sec.can('trx.view') ? `<button class="btn btn-ghost" data-act="xls">${ui.icon('excel')}<span>Ekspor Excel</span></button>` : ''}</div></div>
      <div class="card an-filters">
        <div class="filters">
          <select id="an-mode" aria-label="Periode">${ui.options([['monthly', 'Bulanan'], ['yearly', 'Tahunan'], ['range', 'Rentang tanggal']], st.mode)}</select>
          <input type="month" id="an-month" value="${st.month}" aria-label="Bulan" ${st.mode === 'monthly' ? '' : 'hidden'}>
          <select id="an-year" aria-label="Tahun" ${st.mode === 'yearly' ? '' : 'hidden'}>${ui.options(years, st.year)}</select>
          <input type="date" id="an-start" aria-label="Dari tanggal" value="${rangeOf().start}" ${st.mode === 'range' ? '' : 'hidden'}><input type="date" id="an-end" aria-label="Sampai tanggal" value="${rangeOf().end}" ${st.mode === 'range' ? '' : 'hidden'}>
          <select id="an-unit" aria-label="Unit">${ui.options([['ALL', 'Semua unit'], ['APT', 'Apotek Noura'], ['KLINIK', 'Praktek Dokter Umum']], st.unit)}</select>
          <div class="search-box"><input id="an-q" type="search" placeholder="Cari nama tindakan, pasien, atau pelaksana…" value="${u.esc(st.q)}" aria-label="Cari"></div>
        </div>
        <div class="seg" role="tablist" aria-label="Kelompok tindakan">${[['ALL', 'Semua kelompok']].concat(Object.entries(C.SERVICE_GROUPS)).map(([k, l]) => `<button type="button" class="seg-btn ${st.group === k ? 'active' : ''}" data-group="${k}">${k !== 'ALL' ? `<i class="dot" style="background:${groupColor(k)}"></i>` : ''}${u.esc(l)}</button>`).join('')}</div>
      </div>
      <div id="an-body"></div>`;
    const body = ui.$('#an-body', view);
    const trxs = await NP.trx.all();
    let A;
    let seq = 0;
    async function draw() {
      const my = ++seq;
      ui.destroyCharts();
      const r = rangeOf();
      A = build(trxs, Object.assign({}, r, { group: st.group, unit: st.unit, q: st.q }));
      const P = build(trxs, Object.assign({}, prevRange(), { group: st.group, unit: st.unit, q: st.q }));
      if (my !== seq) return;
      const T = A.total;
      const groupsShown = A.byGroup.length ? A.byGroup : [];
      body.innerHTML = `
        <div class="stats-row">
          ${ui.stat('Jumlah tindakan', u.num(T.qty), { icon: 'medical', sub: delta(T.qty, P.total.qty) })}
          ${ui.stat('Pendapatan kotor', u.rp(T.gross), { icon: 'wallet', sub: delta(T.gross, P.total.gross, true) })}
          ${ui.stat('Transaksi', u.num(T.trx), { icon: 'input', sub: T.trx ? 'rata-rata ' + u.rp(Math.round(T.gross / T.trx)) + ' / transaksi' : '' })}
          ${ui.stat('Pasien bernama', u.num(T.patients), { icon: 'users', sub: 'nama pasien yang tercatat' })}
        </div>
        <div class="an-groups">${Object.keys(C.SERVICE_GROUPS)
          .filter((g) => st.group === 'ALL' || st.group === g)
          .map((g) => {
            const x = groupsShown.find((y) => y.key === g) || { qty: 0, gross: 0, trx: 0 };
            const pr = P.byGroup.find((y) => y.key === g) || { qty: 0, gross: 0 };
            return `<button type="button" class="card an-group ${st.group === g ? 'active' : ''}" data-group="${g}" style="--gc:${groupColor(g)}">
              <span class="an-group-name"><i class="dot" style="background:${groupColor(g)}"></i>${u.esc(C.SERVICE_GROUPS[g])}</span>
              <b>${u.num(x.qty)} <small>tindakan</small></b>
              <span>${u.rp(x.gross)} · ${T.qty ? u.pct((x.qty / T.qty) * 100) : '0%'} dari jumlah</span>
              <small>${delta(x.qty, pr.qty)}</small>
            </button>`;
          })
          .join('')}</div>
        <div class="chart-grid">
          <div class="card chart-card"><div class="card-head"><h3>Tren jumlah tindakan ${A.trend.daily ? 'per hari' : 'per bulan'}</h3><small class="muted">${u.esc(label())}</small></div><div class="chart-box"><canvas id="an-trend" role="img" aria-label="Tren jumlah tindakan"></canvas></div></div>
          <div class="card chart-card"><div class="card-head"><h3>Tindakan terbanyak</h3><small class="muted">10 teratas menurut jumlah</small></div><div class="chart-box"><canvas id="an-top" role="img" aria-label="Tindakan terbanyak"></canvas></div></div>
        </div>
        <div class="card"><div class="card-head"><h3>Per nama tindakan</h3><small class="muted">${u.num(A.byService.length)} tindakan · ${u.esc(label())}</small></div><div id="an-svc"></div></div>
        <div class="grid-2 an-two">
          <div class="card"><div class="card-head"><h3>Per kategori</h3></div><div id="an-cat"></div></div>
          <div class="card"><div class="card-head"><h3>Per pelaksana</h3><small class="muted">dokter, bidan, perawat yang dipilih pada transaksi</small></div><div id="an-perf"></div></div>
        </div>
        <div class="card"><div class="card-head"><h3>Per pasien</h3><small class="muted">transaksi tanpa nama pasien tidak ditampilkan</small></div><div id="an-pat"></div></div>`;

      const pct = (v, of) => (of ? u.pct((v / of) * 100) : '0%');
      const grpBadge = (g) => `<span class="grp-tag" style="--gc:${groupColor(g)}"><i class="dot" style="background:${groupColor(g)}"></i>${u.esc(C.SERVICE_GROUPS[g])}</span>`;
      ui.table(ui.$('#an-svc', body), {
        columns: [
          { key: 'name', label: 'Nama tindakan', render: (s) => `<b>${u.esc(s.name)}</b><small class="block muted">${u.esc(s.category)}</small>` },
          { key: 'group', label: 'Kelompok', render: (s) => grpBadge(s.group), value: (s) => GROUP_SLOT[s.group] },
          { key: 'qty', label: 'Jumlah', align: 'right', render: (s) => `<b>${u.num(s.qty)}</b>` },
          { key: 'share', label: '% jumlah', align: 'right', render: (s) => `<span class="an-bar" style="--w:${T.qty ? (s.qty / T.qty) * 100 : 0}%;--gc:${groupColor(s.group)}">${pct(s.qty, T.qty)}</span>`, value: (s) => s.qty },
          { key: 'trx', label: 'Transaksi', align: 'right', render: (s) => u.num(s.trx) },
          ...(A.withDoctorQty ? [{ key: 'wdQty', label: 'Dengan dokter', align: 'right', render: (s) => (s.wdQty ? u.num(s.wdQty) + `<small class="block muted">tanpa: ${u.num(s.qty - s.wdQty)}</small>` : '-') }] : []),
          { key: 'avg', label: 'Harga rata-rata', align: 'right', render: (s) => u.rp(s.avg) },
          { key: 'gross', label: 'Pendapatan', align: 'right', render: (s) => u.rp(s.gross) }
        ],
        rows: A.byService,
        sortKey: 'qty',
        sortDir: 'desc',
        pageSize: 30,
        cards: true,
        empty: 'Belum ada tindakan pada periode & filter ini.',
        footer: (rows) => rows.length ? `<tr><th colspan="2">Total</th><th class="ta-right">${u.num(u.sum(rows, (s) => s.qty))}</th><th class="ta-right">100%</th><th></th>${A.withDoctorQty ? `<th class="ta-right">${u.num(A.withDoctorQty)}</th>` : ''}<th></th><th class="ta-right">${u.rp(u.sum(rows, (s) => s.gross))}</th></tr>` : ''
      });
      ui.table(ui.$('#an-cat', body), {
        columns: [
          { key: 'label', label: 'Kategori', render: (c) => `<b>${u.esc(c.label)}</b><small class="block">${grpBadge(c.group)}</small>` },
          { key: 'qty', label: 'Jumlah', align: 'right', render: (c) => u.num(c.qty) + `<small class="block muted">${pct(c.qty, T.qty)}</small>` },
          { key: 'gross', label: 'Pendapatan', align: 'right', render: (c) => u.rp(c.gross) }
        ],
        rows: A.byCategory,
        noPaging: true,
        sortable: false,
        empty: 'Tidak ada data.'
      });
      ui.table(ui.$('#an-perf', body), {
        columns: [
          { key: 'name', label: 'Pelaksana', render: (p) => `<b>${u.esc(p.name)}</b><small class="block muted">${p.roles.map((r) => (C.ROLES[r] || {}).label || r).join(', ')}</small>` },
          { key: 'qty', label: 'Tindakan', align: 'right', render: (p) => u.num(p.qty) + `<small class="block muted">${Object.entries(p.groups).map(([g, n]) => u.esc(C.SERVICE_GROUPS[g]) + ' ' + n).join(' · ')}</small>` },
          { key: 'gross', label: 'Pendapatan', align: 'right', render: (p) => u.rp(p.gross) },
          { key: 'fee', label: 'Jasa diterima', align: 'right', render: (p) => u.rp(p.fee) }
        ],
        rows: A.byPerformer,
        sortKey: 'qty',
        sortDir: 'desc',
        noPaging: true,
        empty: 'Belum ada tindakan yang mencatat pelaksana (tindakan tanpa pembagian jasa tidak memerlukan pelaksana).'
      });
      ui.table(ui.$('#an-pat', body), {
        columns: [
          { key: 'name', label: 'Pasien', render: (p) => `<b>${u.esc(p.name)}</b>` },
          { key: 'trx', label: 'Kunjungan', align: 'right', render: (p) => u.num(p.trx) },
          { key: 'services', label: 'Tindakan', sortable: false, render: (p) => [...p.services.entries()].map(([n, q]) => u.esc(n) + (q > 1 ? ' ×' + q : '')).join(', ') },
          { key: 'gross', label: 'Total', align: 'right', render: (p) => u.rp(p.gross) },
          { key: 'last', label: 'Terakhir', render: (p) => u.fmtDate(p.last) }
        ],
        rows: A.byPatient,
        sortKey: 'trx',
        sortDir: 'desc',
        pageSize: 15,
        cards: true,
        empty: 'Belum ada transaksi dengan nama pasien.'
      });

      const surface = getComputedStyle(document.body).getPropertyValue('--surface').trim() || '#fff';
      const bar = (color) => ({ backgroundColor: color, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, borderColor: surface, borderWidth: { top: 2 } });
      const groups = Object.keys(C.SERVICE_GROUPS).filter((g) => (st.group === 'ALL' || st.group === g) && A.trend.series[g].some((x) => x.qty));
      const labels = A.trend.buckets.map((b) => (A.trend.daily ? String(+b.slice(8)) + (A.trend.buckets.length > 31 ? '/' + +b.slice(5, 7) : '') : u.MONTHS_SHORT[+b.slice(5) - 1] + ' ' + b.slice(2, 4)));
      ui.chart(ui.$('#an-trend', body), {
        type: 'bar',
        data: { labels, datasets: groups.map((g) => Object.assign({ label: C.SERVICE_GROUPS[g], data: A.trend.series[g].map((x) => x.qty), gross: A.trend.series[g].map((x) => x.gross) }, bar(groupColor(g)))) },
        options: {
          scales: { x: { stacked: true, grid: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0, maxTicksLimit: 6 }, border: { display: false } } },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: groups.length > 1, position: 'bottom', labels: { boxWidth: 12 } },
            tooltip: {
              mode: 'index', intersect: false, filter: (c) => c.parsed.y > 0,
              callbacks: {
                title: (it) => (A.trend.daily ? u.fmtDate(A.trend.buckets[it[0].dataIndex], 'long') : u.periodLabel(A.trend.buckets[it[0].dataIndex])),
                label: (c) => ' ' + c.dataset.label + ': ' + u.num(c.parsed.y) + ' tindakan · ' + u.rp(c.dataset.gross[c.dataIndex]),
                footer: (it) => (it.length > 1 ? 'Total: ' + u.num(u.sum(it, (x) => x.parsed.y)) + ' tindakan' : '')
              }
            }
          }
        }
      });
      const top = A.byService.slice(0, 10);
      ui.chart(ui.$('#an-top', body), {
        type: 'bar',
        data: { labels: top.map((s) => s.name), datasets: [Object.assign({ label: 'Jumlah tindakan', data: top.map((s) => s.qty) }, bar(top.map((s) => groupColor(s.group))), { borderWidth: 0 })] },
        options: {
          indexAxis: 'y',
          scales: { x: { beginAtZero: true, ticks: { precision: 0, maxTicksLimit: 5 }, border: { display: false } }, y: { grid: { display: false }, ticks: { callback: function (v) { const l = this.getLabelForValue(v); return l.length > 26 ? l.slice(0, 25) + '…' : l; } } } },
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + u.num(c.parsed.x) + ' tindakan · ' + u.rp(top[c.dataIndex].gross) + ' · ' + C.SERVICE_GROUPS[top[c.dataIndex].group] } } }
        }
      });
    }
    await draw();

    const $ = (id) => ui.$(id, view);
    const set = (k, v) => {
      st[k] = v;
      draw();
    };
    $('#an-mode').onchange = (e) => {
      st.mode = e.target.value;
      $('#an-month').hidden = st.mode !== 'monthly';
      $('#an-year').hidden = st.mode !== 'yearly';
      $('#an-start').hidden = $('#an-end').hidden = st.mode !== 'range';
      draw();
    };
    $('#an-month').onchange = (e) => e.target.value && set('month', e.target.value);
    $('#an-year').onchange = (e) => set('year', +e.target.value);
    $('#an-start').onchange = (e) => set('start', e.target.value);
    $('#an-end').onchange = (e) => set('end', e.target.value);
    $('#an-unit').onchange = (e) => set('unit', e.target.value);
    $('#an-q').oninput = u.debounce((e) => set('q', e.target.value), 250);
    view.addEventListener('click', (e) => {
      const g = e.target.closest('[data-group]');
      if (g && view.contains(g)) {
        st.group = st.group === g.dataset.group && g.dataset.group !== 'ALL' ? 'ALL' : g.dataset.group;
        view.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.group === st.group));
        draw();
        return;
      }
      const a = e.target.closest('[data-act="xls"]');
      if (!a) return;
      const grp = st.group === 'ALL' ? 'semua' : C.SERVICE_GROUPS[st.group];
      NP.exp.excel([
        { name: 'Ringkasan', aoa: [['ANALISIS TINDAKAN'], [label() + ' · kelompok ' + grp + (st.unit !== 'ALL' ? ' · ' + C.UNITS[st.unit].name : '') + (st.q ? ' · cari "' + st.q + '"' : '')], [], ['Kelompok', 'Jumlah tindakan', 'Transaksi', 'Pendapatan kotor']].concat(A.byGroup.map((g) => [g.label, g.qty, g.trx, g.gross]), [['TOTAL', A.total.qty, A.total.trx, A.total.gross]]) },
        { name: 'Per Tindakan', rows: A.byService.map((s) => ({ 'Nama Tindakan': s.name, Kelompok: C.SERVICE_GROUPS[s.group], Kategori: s.category, Jumlah: s.qty, 'Dengan Dokter': s.wdQty, 'Tanpa Dokter': s.qty - s.wdQty, Transaksi: s.trx, 'Harga Rata-rata': s.avg, Pendapatan: s.gross })) },
        { name: 'Per Kategori', rows: A.byCategory.map((c) => ({ Kategori: c.label, Kelompok: C.SERVICE_GROUPS[c.group], Jumlah: c.qty, Transaksi: c.trx, Pendapatan: c.gross })) },
        { name: 'Per Pelaksana', rows: A.byPerformer.map((p) => ({ Pelaksana: p.name, Peran: p.roles.map((r) => (C.ROLES[r] || {}).label || r).join(', '), Tindakan: p.qty, Transaksi: p.trx, Pendapatan: p.gross, 'Jasa Diterima': p.fee })) },
        { name: 'Per Pasien', rows: A.byPatient.map((p) => ({ Pasien: p.name, Kunjungan: p.trx, Tindakan: [...p.services.entries()].map(([n, q]) => n + (q > 1 ? ' x' + q : '')).join(', '), Jumlah: p.qty, Total: p.gross, Terakhir: p.last })) },
        { name: 'Tren', rows: A.trend.buckets.map((b, i) => Object.assign({ [A.trend.daily ? 'Tanggal' : 'Bulan']: b }, ...Object.keys(C.SERVICE_GROUPS).map((g) => ({ [C.SERVICE_GROUPS[g] + ' (jumlah)']: A.trend.series[g][i].qty, [C.SERVICE_GROUPS[g] + ' (Rp)']: A.trend.series[g][i].gross })))) },
        { name: 'Detail', rows: A.rows.map((r) => ({ Tanggal: r.t.date, 'No. Transaksi': r.t.id, Pasien: r.t.patient, Tindakan: r.it.serviceName, 'Dengan Dokter': r.it.withDoctor ? 'Ya' : 'Tidak', Kelompok: C.SERVICE_GROUPS[r.group], Kategori: r.it.category, Unit: (C.UNITS[r.it.unit] || {}).name || r.it.unit, Jumlah: r.it.qty, Harga: r.it.price, Subtotal: r.it.gross, Pelaksana: r.performers.map((p) => p.name).join(', '), Catatan: r.t.note })) }
      ], 'analisis-tindakan-' + u.slug(label() + '-' + grp) + '.xlsx');
    });
  }

  NP.analysis = { build };
  NP.pages.analysis = { title: 'Analisis Tindakan', render };
})(typeof globalThis !== 'undefined' ? globalThis : window);
