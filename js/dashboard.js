/* Noura Payroll — DASHBOARD utama & DASHBOARD PENDAPATAN TINDAKAN (Pembagian Pendapatan). */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;
  const C = NP.C;
  const rs = NP.rs;

  /* ---------- Opsi grafik bersama ---------- */
  function rpAxis(stacked) {
    return {
      x: { stacked: !!stacked, grid: { display: false } },
      y: { stacked: !!stacked, beginAtZero: true, ticks: { callback: (v) => ui.rpTick(v), maxTicksLimit: 6 }, border: { display: false } }
    };
  }
  const tipRp = { callbacks: { label: (c) => ' ' + c.dataset.label + ': ' + u.rp(c.parsed.y !== undefined && c.chart.options.indexAxis !== 'y' ? c.parsed.y : c.parsed.x) } };
  const barStyle = (color) => ({ backgroundColor: color, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 34, borderColor: getComputedStyle(document.body).getPropertyValue('--surface').trim() || '#fff', borderWidth: { top: 2 } });

  function filterBar(st, opts) {
    return `<div class="filters dash-filters">
      <select data-f="preset">${ui.options([['today', 'Hari ini'], ['week', 'Minggu ini'], ['month', 'Bulan ini'], ['lastmonth', 'Bulan lalu'], ['year', 'Tahun ini'], ['custom', 'Rentang tanggal']], st.preset)}</select>
      <input type="date" data-f="start" value="${st.start}" ${st.preset === 'custom' ? '' : 'hidden'}><input type="date" data-f="end" value="${st.end}" ${st.preset === 'custom' ? '' : 'hidden'}>
      <select data-f="unit">${ui.options([['', 'Semua unit'], ['APT', 'Apotek Noura'], ['KLINIK', 'Praktek Dokter Umum']], st.unit)}</select>
      ${opts && opts.extra ? opts.extra : ''}
      <span class="range-label">${u.fmtDate(st.start)} – ${u.fmtDate(st.end)}</span>
    </div>`;
  }
  function bindFilters(view, st, redraw) {
    view.querySelector('.dash-filters').addEventListener('change', (e) => {
      const f = e.target.dataset.f;
      if (!f) return;
      st[f] = e.target.value;
      if (f === 'preset' && st.preset !== 'custom') Object.assign(st, u.presetRange(st.preset));
      redraw();
    });
  }

  /* ===================== DASHBOARD UTAMA ===================== */
  const ds = Object.assign({ preset: 'month', unit: '' }, u.presetRange('month'));

  async function render(view) {
    const showPay = NP.sec.can('dashboard.payroll');
    const [emps, trxsAll, runs] = await Promise.all([NP.db.all('employees'), NP.db.all('transactions'), NP.db.all('payrollRuns')]);
    const draw = () => {
      ui.destroyCharts();
      const unitOk = (un) => !ds.unit || un === ds.unit;
      const trxs = trxsAll.filter((t) => t.status === 'active');
      const items = [];
      for (const t of trxs) if (u.inRange(t.date, ds.start, ds.end)) for (const it of t.items) if (unitOk(it.unit)) items.push({ t, it });
      const sh = rs.summarize([].concat(...items.map((x) => x.it.shares)));
      const gross = u.sum(items, (x) => x.it.gross);
      const trxCount = new Set(items.map((x) => x.t.id)).size;

      const empF = emps.filter((e) => e.status === 'aktif' && (!ds.unit || e.unit === ds.unit || e.unit === 'LINTAS'));
      const countPos = (pos) => empF.filter((e) => pos.includes(e.position)).length;

      // penggajian dalam rentang (berdasarkan periode)
      const p0 = ds.start.slice(0, 7);
      const p1 = ds.end.slice(0, 7);
      const prun = runs.filter((r) => r.period >= p0 && r.period <= p1);
      const pay = { gross: 0, base: 0, allowance: 0, service: 0, bonus: 0, deductions: 0, net: 0 };
      for (const r of prun) for (const s of r.slips) {
        if (!ds.unit) {
          pay.gross += s.totals.gross;
          pay.base += s.totals.base;
          pay.allowance += s.totals.allowance + s.totals.overtime;
          pay.service += s.totals.service + s.totals.practice;
          pay.bonus += s.totals.bonus + s.totals.incentive + s.totals.other;
          pay.deductions += s.totals.deductions;
          pay.net += s.totals.net;
        } else {
          const g = NP.reports.slipUnitGroups(s)[ds.unit];
          pay.gross += g.gross;
          pay.base += g.base || 0;
          pay.allowance += (g.allowance || 0) + (g.overtime || 0);
          pay.service += (g.service || 0) + (g.practice || 0);
          pay.bonus += (g.bonus || 0) + (g.incentive || 0) + (g.other || 0);
          pay.deductions += g.deductions;
          pay.net += g.net;
        }
      }
      const draftNote = prun.some((r) => r.status === 'draft') ? ' (termasuk draft)' : '';
      const activePeriod = u.todayISO().slice(0, 7);
      const activeRuns = runs.filter((r) => r.period === activePeriod);
      const prevRuns = runs.filter((r) => r.period === u.addMonths(activePeriod, -1));

      view.innerHTML = `
        <div class="page-head"><div><h2>Selamat datang, ${u.esc(NP.sec.user().name)}</h2><p class="muted">${u.esc(NP.state.settings.company.name)} · ringkasan operasional penggajian & jasa pelayanan</p></div>
          <div class="actions">${NP.sec.can('trx.create') ? `<a class="btn btn-primary" href="#/input">${ui.icon('plus')}<span>Input Tindakan</span></a>` : ''}${NP.sec.can('payroll.run') ? `<a class="btn btn-ghost" href="#/generate">${ui.icon('play')}<span>Generate Payroll</span></a>` : ''}</div></div>
        ${filterBar(ds)}
        <div class="period-card">
          <div>${ui.icon('calendar')}<div><small>Periode gaji aktif</small><b>${u.periodLabel(activePeriod)}</b></div></div>
          <div><small>Status</small><b>${activeRuns.length ? activeRuns.map((r) => ui.statusBadge(r.status) + ' ' + r.id).join(' ') : ui.badge('Belum diproses', 'gray')}</b></div>
          <div><small>Periode sebelumnya (${u.periodLabel(u.addMonths(activePeriod, -1))})</small><b>${prevRuns.length ? prevRuns.map((r) => ui.statusBadge(r.status)).join(' ') : ui.badge('Belum diproses', 'amber')}</b></div>
          <div><small>Jasa belum diproses</small><b>${u.rp(openFees(trxsAll))}</b></div>
        </div>

        <h3 class="dash-sec">Statistik Karyawan</h3>
        <div class="stats-row">
          ${ui.stat('Total karyawan aktif', u.num(empF.length), { icon: 'users' })}
          ${ui.stat('Apotek Noura', u.num(empF.filter((e) => e.unit === 'APT' || e.unit === 'LINTAS').length), { icon: 'medical', sub: empF.filter((e) => e.unit === 'LINTAS').length + ' lintas unit' })}
          ${ui.stat('Praktek Dokter Umum', u.num(empF.filter((e) => e.unit === 'KLINIK' || e.unit === 'LINTAS').length), { icon: 'medical' })}
          ${ui.stat('Dokter', u.num(countPos(['Dokter Umum'])))}
          ${ui.stat('Bidan', u.num(countPos(['Bidan'])))}
          ${ui.stat('Perawat', u.num(countPos(['Perawat'])))}
          ${ui.stat('Staf administrasi', u.num(countPos(C.ADMIN_POSITIONS)))}
        </div>

        ${showPay ? `<h3 class="dash-sec">Statistik Penggajian <small class="muted">${prun.length ? prun.length + ' periode' + draftNote : 'belum ada penggajian di rentang ini' + (ds.preset !== 'lastmonth' ? ' · <a href="#" data-dash-last>lihat bulan lalu</a>' : '')}</small></h3>
        <div class="stats-row">
          ${ui.stat('Total pengeluaran gaji', u.rp(pay.gross), { icon: 'wallet', cls: 'stat-hero' })}
          ${ui.stat('Total gaji pokok', u.rp(pay.base))}
          ${ui.stat('Total tunjangan', u.rp(pay.allowance))}
          ${ui.stat('Total jasa pelayanan', u.rp(pay.service))}
          ${ui.stat('Bonus & insentif', u.rp(pay.bonus))}
          ${ui.stat('Total potongan', u.rp(pay.deductions))}
          ${ui.stat('Total gaji bersih', u.rp(pay.net), { cls: 'stat-green' })}
        </div>` : ''}

        <h3 class="dash-sec">Statistik Pendapatan Pelayanan</h3>
        <div class="stats-row">
          ${ui.stat('Total transaksi tindakan', u.num(trxCount), { icon: 'history', sub: u.num(u.sum(items, (x) => x.it.qty)) + ' tindakan' })}
          ${ui.stat('Pendapatan kotor tindakan', u.rp(gross), { icon: 'report', cls: 'stat-hero' })}
          ${ui.stat('Pendapatan Apotek Noura', u.rp(sh.apotek), { sub: sh.klinik ? 'Praktek: ' + u.rp(sh.klinik) : '' })}
          ${ui.stat('Total jasa dokter', u.rp(sh.dokter))}
          ${ui.stat('Total jasa bidan', u.rp(sh.bidan))}
          ${ui.stat('Total jasa perawat', u.rp(sh.perawat))}
        </div>

        <div class="chart-grid">
          <div class="card chart-card"><div class="card-head"><h3>Pendapatan bulanan</h3><small class="muted">12 bulan · bagian usaha + jasa karyawan + penerima lain = pendapatan kotor</small></div><div class="chart-box"><canvas id="c-rev"></canvas></div></div>
          ${showPay ? `<div class="card chart-card"><div class="card-head"><h3>Pengeluaran gaji</h3><small class="muted">12 bulan · gaji bersih + potongan = bruto</small></div><div class="chart-box"><canvas id="c-pay"></canvas></div></div>` : ''}
          <div class="card chart-card"><div class="card-head"><h3>Pembagian pendapatan antarunit</h3><small class="muted">${u.fmtDate(ds.start)} – ${u.fmtDate(ds.end)}</small></div><div class="chart-box"><canvas id="c-share"></canvas></div></div>
          <div class="card chart-card"><div class="card-head"><h3>Tindakan paling banyak dilakukan</h3><small class="muted">jumlah tindakan</small></div><div class="chart-box"><canvas id="c-top"></canvas></div></div>
        </div>

        <div class="grid-2">
          <div class="card"><div class="card-head"><h3>Aktivitas transaksi terbaru</h3>${NP.sec.can('trx.view') ? '<a class="link" href="#/transactions">Semua</a>' : ''}</div>
            <div class="activity">${trxsAll.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8).map((t) => `<div class="act-item"><div class="act-ic ${t.status}">${ui.icon(t.status === 'cancelled' ? 'x' : 'medical')}</div><div><b>${u.esc(t.items.map((i) => i.serviceName + (i.qty > 1 ? ' ×' + i.qty : '')).join(', '))}</b><small>${u.esc(t.id)} · ${u.fmtDate(t.date)} · ${u.esc([...new Set([].concat(...t.items.map((i) => Object.values(i.performerNames || {}))))].join(', ') || '-')}</small></div><span class="${t.status === 'cancelled' ? 'strike muted' : ''}">${u.rp(t.totals.gross)}</span></div>`).join('') || ui.empty('Belum ada transaksi.')}</div></div>
          ${showPay ? `<div class="card"><div class="card-head"><h3>Riwayat penggajian</h3>${NP.sec.can('history.view') ? '<a class="link" href="#/payroll-history">Semua</a>' : ''}</div>
            <div class="activity">${runs.slice().sort((a, b) => b.period.localeCompare(a.period)).slice(0, 6).map((r) => `<div class="act-item"><div class="act-ic">${ui.icon('wallet')}</div><div><b>${u.periodLabel(r.period)}</b><small>${u.esc(r.id)} · ${r.slips.length} karyawan · ${ui.statusBadge(r.status)}</small></div><span>${u.rp(r.totals.net)}</span></div>`).join('') || ui.empty('Belum ada penggajian.')}</div></div>` : ''}
        </div>`;
      bindFilters(view, ds, draw);
      const last = view.querySelector('[data-dash-last]');
      if (last)
        last.onclick = (e) => {
          e.preventDefault();
          ds.preset = 'lastmonth';
          Object.assign(ds, u.presetRange('lastmonth'));
          draw();
        };

      // 12 bulan berakhir di akhir rentang
      const months = [];
      for (let i = 11; i >= 0; i--) months.push(u.addMonths(p1, -i));
      const byMonth = months.map((m) => {
        const its = [];
        for (const t of trxs) if (t.date.slice(0, 7) === m) for (const it of t.items) if (unitOk(it.unit)) its.push(it);
        return rs.summarize([].concat(...its.map((i) => i.shares)));
      });
      const pal = ui.palette();
      ui.chart(ui.$('#c-rev', view), {
        type: 'bar',
        data: {
          labels: months.map((m) => u.MONTHS_SHORT[+m.slice(5) - 1] + ' ' + m.slice(2, 4)),
          datasets: [
            Object.assign({ label: 'Bagian usaha', data: byMonth.map((x) => x.business) }, barStyle(ui.catColor('apotek'))),
            Object.assign({ label: 'Jasa karyawan', data: byMonth.map((x) => x.staff) }, barStyle(ui.catColor('dokter'))),
            Object.assign({ label: 'Penerima lain', data: byMonth.map((x) => x.eksternal) }, barStyle(ui.catColor('eksternal')))
          ]
        },
        options: { scales: rpAxis(true), plugins: { tooltip: Object.assign({ mode: 'index', intersect: false, callbacks: { label: tipRp.callbacks.label, footer: (it) => 'Pendapatan kotor: ' + u.rp(u.sum(it, (x) => x.parsed.y)) } }), legend: { position: 'bottom', labels: { boxWidth: 12 } } }, interaction: { mode: 'index', intersect: false } }
      });
      if (showPay) {
        const payBy = months.map((m) => {
          let net = 0, ded = 0;
          for (const r of runs.filter((x) => x.period === m)) for (const s of r.slips) {
            if (!ds.unit) {
              net += s.totals.net;
              ded += s.totals.deductions;
            } else {
              const g = NP.reports.slipUnitGroups(s)[ds.unit];
              net += g.net;
              ded += g.deductions;
            }
          }
          return { net, ded };
        });
        ui.chart(ui.$('#c-pay', view), {
          type: 'bar',
          data: {
            labels: months.map((m) => u.MONTHS_SHORT[+m.slice(5) - 1] + ' ' + m.slice(2, 4)),
            datasets: [Object.assign({ label: 'Gaji bersih', data: payBy.map((x) => x.net) }, barStyle(pal[0])), Object.assign({ label: 'Potongan', data: payBy.map((x) => x.ded) }, barStyle(pal[2]))]
          },
          options: { scales: rpAxis(true), plugins: { tooltip: { mode: 'index', intersect: false, callbacks: { label: tipRp.callbacks.label, footer: (it) => 'Bruto: ' + u.rp(u.sum(it, (x) => x.parsed.y)) } }, legend: { position: 'bottom', labels: { boxWidth: 12 } } }, interaction: { mode: 'index', intersect: false } }
        });
      }
      const cats = [['apotek', 'Apotek Noura'], ['klinik', 'Praktek Dokter'], ['dokter', 'Jasa dokter'], ['bidan', 'Jasa bidan'], ['perawat', 'Jasa perawat'], ['petugas', 'Jasa lainnya'], ['eksternal', 'Penerima lain']]
        .map(([k, l]) => ({ k, l, v: k === 'petugas' ? sh.petugas + sh.farmasi : sh[k] }))
        .filter((x) => x.v > 0);
      ui.chart(ui.$('#c-share', view), {
        type: 'bar',
        data: { labels: cats.map((c) => c.l + ' · ' + u.pct(gross ? (c.v / gross) * 100 : 0)), datasets: [Object.assign({ label: 'Nilai', data: cats.map((c) => c.v) }, barStyle(cats.map((c) => ui.catColor(c.k))), { borderSkipped: 'start', borderWidth: 0 })] },
        options: { indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { callback: (v) => ui.rpTick(v), maxTicksLimit: 5 }, border: { display: false } }, y: { grid: { display: false } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + u.rp(c.parsed.x) } } } }
      });
      const topMap = new Map();
      for (const x of items) topMap.set(x.it.serviceName, (topMap.get(x.it.serviceName) || 0) + x.it.qty);
      const top = [...topMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      ui.chart(ui.$('#c-top', view), {
        type: 'bar',
        data: { labels: top.map((t) => t[0]), datasets: [Object.assign({ label: 'Jumlah tindakan', data: top.map((t) => t[1]) }, barStyle(pal[1]), { borderWidth: 0 })] },
        options: { indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { precision: 0 }, border: { display: false } }, y: { grid: { display: false } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + u.num(c.parsed.x) + ' tindakan' } } } }
      });
    };
    draw();
  }

  function openFees(trxs) {
    let s = 0;
    for (const t of trxs) {
      if (t.status !== 'active') continue;
      for (const { share } of NP.trx.empShares(t)) if (!share.payroll || !share.payroll.state) s += share.amount;
    }
    return s;
  }

  /* ===================== DASHBOARD PENDAPATAN TINDAKAN ===================== */
  const rv = Object.assign({ preset: 'month', unit: '', svc: '', emp: '' }, u.presetRange('month'));

  async function renderRevenue(view) {
    const [trxsAll, services, emps] = await Promise.all([NP.db.all('transactions'), NP.svc.all(), NP.emp.all()]);
    const empMap = new Map(emps.map((e) => [e.id, e]));
    const draw = () => {
      ui.destroyCharts();
      const extra = `<select data-f="svc"><option value="">Semua jenis tindakan</option>${ui.options(services.map((s) => [s.id, s.name]), rv.svc)}</select>
        <select data-f="emp"><option value="">Semua petugas</option>${ui.options(emps.filter((e) => NP.emp.isHealth(e) || C.roleOfPosition(e.position) === 'farmasi').map((e) => [e.id, e.name]), rv.emp)}</select>`;
      const items = [];
      for (const t of trxsAll) {
        if (t.status !== 'active' || !u.inRange(t.date, rv.start, rv.end)) continue;
        for (const it of t.items) {
          if (rv.unit && it.unit !== rv.unit) continue;
          if (rv.svc && it.serviceId !== rv.svc) continue;
          if (rv.emp && !Object.values(it.performers || {}).includes(rv.emp)) continue;
          items.push({ t, it });
        }
      }
      const sh = rs.summarize([].concat(...items.map((x) => x.it.shares)));
      const gross = u.sum(items, (x) => x.it.gross);
      const qty = u.sum(items, (x) => x.it.qty);
      const days = Math.max(1, Math.round((u.parseISO(rv.end > u.todayISO() ? u.todayISO() : rv.end) - u.parseISO(rv.start)) / 86400000) + 1);
      const today = u.sum(items.filter((x) => x.t.date === u.todayISO()), (x) => x.it.qty);
      const thisMonth = u.sum(trxsAll.filter((t) => t.status === 'active' && t.date.slice(0, 7) === u.todayISO().slice(0, 7)).flatMap((t) => t.items.filter((it) => (!rv.unit || it.unit === rv.unit) && (!rv.svc || it.serviceId === rv.svc))), (it) => it.qty);

      // per petugas
      const perStaff = new Map();
      for (const x of items) for (const s of x.it.shares) {
        if (!s.recipientId || !(s.type === 'role' || s.type === 'employee')) continue;
        if (rv.emp && s.recipientId !== rv.emp) continue;
        const r = perStaff.get(s.recipientId) || { id: s.recipientId, name: s.recipientName, cat: s.category, trx: new Set(), qty: 0, amount: 0, gross: 0 };
        r.trx.add(x.t.id);
        r.qty += x.it.qty;
        r.amount += s.amount;
        r.gross += x.it.gross;
        perStaff.set(s.recipientId, r);
      }
      // per tindakan
      const perSvc = new Map();
      for (const x of items) {
        const r = perSvc.get(x.it.serviceId) || { name: x.it.serviceName, unit: x.it.unit, qty: 0, gross: 0, sh: { apotek: 0, klinik: 0, dokter: 0, bidan: 0, perawat: 0, farmasi: 0, petugas: 0, eksternal: 0 } };
        r.qty += x.it.qty;
        r.gross += x.it.gross;
        for (const s of x.it.shares) r.sh[s.category] += s.amount;
        perSvc.set(x.it.serviceId, r);
      }

      view.innerHTML = `
        <div class="page-head"><div><h2>Pembagian Pendapatan</h2><p class="muted">Dashboard pendapatan tindakan: pendapatan kotor, bagian usaha, dan jasa setiap petugas.</p></div>
          <div class="actions"><button class="btn btn-ghost" data-act="xls">${ui.icon('excel')}<span>Ekspor Excel</span></button>${NP.sec.can('services.view') ? `<a class="btn btn-ghost" href="#/services">${ui.icon('medical')}<span>Atur pembagian</span></a>` : ''}</div></div>
        ${filterBar(rv, { extra })}
        <div class="stats-row">
          ${ui.stat('Total transaksi', u.num(new Set(items.map((x) => x.t.id)).size), { icon: 'history' })}
          ${ui.stat('Pendapatan kotor', u.rp(gross), { icon: 'report', cls: 'stat-hero' })}
          ${ui.stat('Bagian Apotek Noura', u.rp(sh.apotek), { sub: sh.klinik ? 'Praktek Dokter: ' + u.rp(sh.klinik) : '' })}
          ${ui.stat('Total jasa dokter', u.rp(sh.dokter))}
          ${ui.stat('Total jasa bidan', u.rp(sh.bidan))}
          ${ui.stat('Total jasa perawat', u.rp(sh.perawat))}
          ${ui.stat('Tindakan hari ini', u.num(today), { sub: 'rata-rata ' + u.num(qty / days, 1) + '/hari di rentang' })}
          ${ui.stat('Tindakan bulan ini', u.num(thisMonth), { sub: u.num(qty) + ' di rentang terpilih' })}
        </div>
        <div class="chart-grid">
          <div class="card chart-card wide"><div class="card-head"><h3>Jumlah tindakan ${days > 62 ? 'bulanan' : 'harian'}</h3></div><div class="chart-box"><canvas id="rv-daily"></canvas></div></div>
          <div class="card chart-card"><div class="card-head"><h3>Tindakan paling sering</h3></div><div class="chart-box"><canvas id="rv-top"></canvas></div></div>
          <div class="card chart-card"><div class="card-head"><h3>Pendapatan setiap petugas</h3><small class="muted">hak jasa</small></div><div class="chart-box"><canvas id="rv-staff"></canvas></div></div>
        </div>
        <div class="card"><div class="card-head"><h3>Pendapatan setiap petugas</h3></div><div id="rv-staff-t"></div></div>
        <div class="card"><div class="card-head"><h3>Pembagian per jenis tindakan</h3></div><div id="rv-svc-t"></div></div>`;
      bindFilters(view, rv, draw);

      // grafik harian / bulanan
      const buckets = [];
      if (days > 62) {
        for (let p = rv.start.slice(0, 7); p <= rv.end.slice(0, 7); p = u.addMonths(p, 1)) buckets.push({ key: p, label: u.MONTHS_SHORT[+p.slice(5) - 1] + ' ' + p.slice(2, 4) });
      } else {
        for (let d = rv.start; d <= rv.end; d = u.addDays(d, 1)) buckets.push({ key: d, label: d.slice(8) + '/' + d.slice(5, 7) });
      }
      const cnt = new Map();
      for (const x of items) {
        const k = days > 62 ? x.t.date.slice(0, 7) : x.t.date;
        cnt.set(k, (cnt.get(k) || 0) + x.it.qty);
      }
      ui.chart(ui.$('#rv-daily', view), {
        type: 'bar',
        data: { labels: buckets.map((b) => b.label), datasets: [Object.assign({ label: 'Jumlah tindakan', data: buckets.map((b) => cnt.get(b.key) || 0) }, barStyle(ui.palette()[0]), { borderWidth: 0 })] },
        options: { scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 16 } }, y: { beginAtZero: true, ticks: { precision: 0 }, border: { display: false } } }, plugins: { legend: { display: false } } }
      });
      const top = [...perSvc.values()].sort((a, b) => b.qty - a.qty).slice(0, 8);
      ui.chart(ui.$('#rv-top', view), {
        type: 'bar',
        data: { labels: top.map((t) => t.name), datasets: [Object.assign({ label: 'Jumlah', data: top.map((t) => t.qty) }, barStyle(ui.palette()[1]), { borderWidth: 0 })] },
        options: { indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { precision: 0 }, border: { display: false } }, y: { grid: { display: false } } }, plugins: { legend: { display: false } } }
      });
      const staff = [...perStaff.values()].sort((a, b) => b.amount - a.amount);
      ui.chart(ui.$('#rv-staff', view), {
        type: 'bar',
        data: { labels: staff.slice(0, 10).map((s) => s.name), datasets: [Object.assign({ label: 'Jasa', data: staff.slice(0, 10).map((s) => s.amount) }, barStyle(staff.slice(0, 10).map((s) => ui.catColor(s.cat))), { borderWidth: 0 })] },
        options: { indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { callback: (v) => ui.rpTick(v), maxTicksLimit: 5 }, border: { display: false } }, y: { grid: { display: false } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + u.rp(c.parsed.x) } } } }
      });
      ui.table(ui.$('#rv-staff-t', view), {
        columns: [
          { key: 'name', label: 'Petugas', render: (r) => `<b>${u.esc(r.name)}</b><small class="block muted">${u.esc((empMap.get(r.id) || {}).position || '')}</small>` },
          { key: 'cat', label: 'Kategori', render: (r) => `<span class="share-chip share-${r.cat}">${u.esc(C.SHARE_CATS[r.cat])}</span>` },
          { key: 'trx', label: 'Transaksi', align: 'right', render: (r) => u.num(r.trx.size), value: (r) => r.trx.size },
          { key: 'qty', label: 'Jml tindakan', align: 'right', render: (r) => u.num(r.qty) },
          { key: 'gross', label: 'Pendapatan kotor dilayani', align: 'right', render: (r) => u.rp(r.gross) },
          { key: 'amount', label: 'Hak jasa', align: 'right', render: (r) => `<b>${u.rp(r.amount)}</b>` }
        ],
        rows: staff,
        sortKey: 'amount',
        sortDir: 'desc',
        noPaging: true,
        empty: 'Tidak ada data.',
        footer: (rows) => `<tr><th colspan="3">Total</th><th class="ta-right">${u.num(u.sum(rows, (r) => r.qty))}</th><th></th><th class="ta-right">${u.rp(u.sum(rows, (r) => r.amount))}</th></tr>`
      });
      const svcRows = [...perSvc.values()];
      ui.table(ui.$('#rv-svc-t', view), {
        columns: [
          { key: 'name', label: 'Tindakan', render: (r) => `<b>${u.esc(r.name)}</b>` },
          { key: 'unit', label: 'Unit', render: (r) => ui.unitBadge(r.unit) },
          { key: 'qty', label: 'Jml', align: 'right', render: (r) => u.num(r.qty) },
          { key: 'gross', label: 'Pendapatan kotor', align: 'right', render: (r) => u.rp(r.gross) },
          { key: 'apt', label: 'Apotek', align: 'right', render: (r) => u.rp(r.sh.apotek), value: (r) => r.sh.apotek },
          { key: 'kl', label: 'Praktek', align: 'right', render: (r) => u.rp(r.sh.klinik), value: (r) => r.sh.klinik },
          { key: 'dr', label: 'Dokter', align: 'right', render: (r) => u.rp(r.sh.dokter), value: (r) => r.sh.dokter },
          { key: 'bd', label: 'Bidan', align: 'right', render: (r) => u.rp(r.sh.bidan), value: (r) => r.sh.bidan },
          { key: 'pr', label: 'Perawat', align: 'right', render: (r) => u.rp(r.sh.perawat), value: (r) => r.sh.perawat },
          { key: 'ot', label: 'Lainnya', align: 'right', render: (r) => u.rp(r.sh.farmasi + r.sh.petugas + r.sh.eksternal), value: (r) => r.sh.eksternal }
        ],
        rows: svcRows,
        sortKey: 'gross',
        sortDir: 'desc',
        noPaging: true,
        empty: 'Tidak ada data.',
        footer: (rows) => `<tr><th colspan="2">Total</th><th class="ta-right">${u.num(u.sum(rows, (r) => r.qty))}</th><th class="ta-right">${u.rp(u.sum(rows, (r) => r.gross))}</th>${['apotek', 'klinik', 'dokter', 'bidan', 'perawat'].map((k) => `<th class="ta-right">${u.rp(u.sum(rows, (r) => r.sh[k]))}</th>`).join('')}<th class="ta-right">${u.rp(u.sum(rows, (r) => r.sh.farmasi + r.sh.petugas + r.sh.eksternal))}</th></tr>`
      });
      view.querySelector('[data-act=xls]').onclick = () =>
        NP.exp.excel([
          { name: 'Per Petugas', rows: staff.map((r) => ({ Petugas: r.name, Kategori: C.SHARE_CATS[r.cat], Transaksi: r.trx.size, 'Jumlah Tindakan': r.qty, 'Pendapatan Kotor Dilayani': r.gross, 'Hak Jasa': r.amount })) },
          { name: 'Per Tindakan', rows: svcRows.map((r) => ({ Tindakan: r.name, Unit: C.UNITS[r.unit].name, Jumlah: r.qty, 'Pendapatan Kotor': r.gross, Apotek: r.sh.apotek, Praktek: r.sh.klinik, Dokter: r.sh.dokter, Bidan: r.sh.bidan, Perawat: r.sh.perawat, Lainnya: r.sh.farmasi + r.sh.petugas + r.sh.eksternal })) }
        ], 'pembagian-pendapatan-' + rv.start + '_' + rv.end + '.xlsx');
    };
    draw();
  }

  NP.pages.dashboard = { title: 'Dashboard', render };
  NP.pages.revenue = { title: 'Pembagian Pendapatan', render: renderRevenue };
})(typeof globalThis !== 'undefined' ? globalThis : window);
