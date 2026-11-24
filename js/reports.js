/* Noura Payroll — LAPORAN KEUANGAN penggajian & jasa (bulanan, tahunan, rentang tanggal).
 * Membedakan dengan tegas: pendapatan kotor pelayanan, bagian usaha, dan hak jasa karyawan. */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;
  const C = NP.C;

  const rep = {};

  /** Alokasikan nilai kelompok slip ke unit (jasa per unit tindakan, lainnya sesuai persentase beban). */
  rep.slipUnitGroups = function (s) {
    const split = s.split || (s.employee.unit === 'KLINIK' ? { APT: 0, KLINIK: 1 } : s.employee.unit === 'LINTAS' ? { APT: 0.5, KLINIK: 0.5 } : { APT: 1, KLINIK: 0 });
    const out = { APT: {}, KLINIK: {} };
    const add = (unit, g, v) => (out[unit][g] = (out[unit][g] || 0) + v);
    const svcDet = s.serviceDetail || [];
    const svcTotalDet = u.sum(svcDet, (d) => d.amount);
    for (const e of s.earnings) {
      if (e.code === 'JASA' && svcTotalDet === e.amount) {
        svcDet.forEach((d) => add(d.unit === 'KLINIK' ? 'KLINIK' : 'APT', 'service', d.amount));
      } else {
        const a = Math.round(e.amount * split.APT);
        add('APT', e.group, a);
        add('KLINIK', e.group, e.amount - a);
      }
    }
    const ded = s.totals.deductions;
    const dA = s.totals.gross ? Math.round((ded * u.sum(Object.values(out.APT))) / s.totals.gross) : Math.round(ded * split.APT);
    out.APT.deductions = dA;
    out.KLINIK.deductions = ded - dA;
    for (const un of ['APT', 'KLINIK']) {
      const o = out[un];
      o.gross = u.sum(['base', 'allowance', 'overtime', 'bonus', 'incentive', 'practice', 'service', 'other'].map((g) => o[g] || 0));
      o.net = o.gross - o.deductions;
    }
    return out;
  };

  rep.build = async function (f) {
    const trxs = (await NP.db.all('transactions')).filter((t) => t.status === 'active' && u.inRange(t.date, f.start, f.end));
    const runs = (await NP.db.all('payrollRuns')).filter((r) => (f.includeDraft || r.status !== 'draft') && r.period >= f.start.slice(0, 7) && r.period <= f.end.slice(0, 7));
    const emps = await NP.emp.map();

    // Pendapatan pelayanan
    const svc = { APT: { gross: 0, qty: 0, count: 0 }, KLINIK: { gross: 0, qty: 0, count: 0 } };
    const shares = { apotek: 0, klinik: 0, dokter: 0, bidan: 0, perawat: 0, farmasi: 0, petugas: 0, eksternal: 0 };
    const sharesByUnit = { APT: { ...shares }, KLINIK: { ...shares } };
    const perEmpSvc = new Map();
    for (const t of trxs) for (const it of t.items) {
      svc[it.unit].gross += it.gross;
      svc[it.unit].qty += it.qty;
      svc[it.unit].count += 1;
      for (const s of it.shares) {
        shares[s.category] += s.amount;
        sharesByUnit[it.unit][s.category] += s.amount;
        if (s.recipientId && (s.type === 'role' || s.type === 'employee')) {
          const x = perEmpSvc.get(s.recipientId) || { qty: 0, amount: 0 };
          x.qty += it.qty;
          x.amount += s.amount;
          perEmpSvc.set(s.recipientId, x);
        }
      }
    }

    // Penggajian
    const pay = { APT: {}, KLINIK: {} };
    const adminPay = { APT: 0, KLINIK: 0 };
    const perEmp = new Map();
    for (const r of runs) for (const s of r.slips) {
      if (f.employee && s.employeeId !== f.employee) continue;
      const g = rep.slipUnitGroups(s);
      for (const un of ['APT', 'KLINIK']) for (const [k, v] of Object.entries(g[un])) pay[un][k] = (pay[un][k] || 0) + v;
      if (C.ADMIN_POSITIONS.includes(s.employee.position)) for (const un of ['APT', 'KLINIK']) adminPay[un] += g[un].gross;
      const x = perEmp.get(s.employeeId) || { emp: s.employee, base: 0, allowance: 0, overtime: 0, service: 0, practice: 0, bonus: 0, incentive: 0, other: 0, gross: 0, deductions: 0, net: 0, serviceQty: 0, months: [] };
      for (const k of ['base', 'allowance', 'overtime', 'service', 'practice', 'bonus', 'incentive', 'other', 'gross', 'deductions', 'net']) x[k] += s.totals[k];
      x.serviceQty += s.serviceQty || 0;
      x.months.push({ period: r.period, runId: r.id, status: r.status, ...s.totals, serviceQty: s.serviceQty || 0 });
      perEmp.set(s.employeeId, x);
    }
    const z = (o, k) => o[k] || 0;

    // Tren bulanan
    const months = [];
    for (let p = f.start.slice(0, 7); p <= f.end.slice(0, 7); p = u.addMonths(p, 1)) months.push(p);
    const trend = months.map((p) => {
      const tm = trxs.filter((t) => t.date.slice(0, 7) === p);
      const sh = NP.rs.summarize([].concat(...tm.map((t) => [].concat(...t.items.map((i) => i.shares)))));
      const rr = runs.filter((r) => r.period === p);
      return { period: p, gross: u.sum(tm, (t) => t.totals.gross), business: sh.business, staff: sh.staff, payGross: u.sum(rr, (r) => r.totals.gross), payNet: u.sum(rr, (r) => r.totals.net) };
    });

    return { f, trxs, runs, emps, svc, shares, sharesByUnit, pay, adminPay, perEmp, perEmpSvc, trend, z };
  };

  /* ===================== Halaman ===================== */
  const st = { mode: 'monthly', month: u.todayISO().slice(0, 7), year: new Date().getFullYear(), start: '', end: '', unit: 'ALL', employee: '', includeDraft: false };

  function rangeOf() {
    if (st.mode === 'monthly') return u.monthRange(st.month);
    if (st.mode === 'yearly') return { start: st.year + '-01-01', end: st.year + '-12-31' };
    return { start: st.start || u.presetRange('month').start, end: st.end || u.presetRange('month').end };
  }
  function label() {
    const r = rangeOf();
    if (st.mode === 'monthly') return 'Periode ' + u.periodLabel(st.month);
    if (st.mode === 'yearly') return 'Tahun ' + st.year;
    return u.fmtDate(r.start, 'long') + ' s.d. ' + u.fmtDate(r.end, 'long');
  }

  async function render(view) {
    const emps = await NP.emp.all();
    const years = [];
    for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 5; y--) years.push(y);
    view.innerHTML = `
      <div class="page-head"><div><h2>Laporan Keuangan</h2><p class="muted">Laporan penggajian dan jasa pelayanan per unit usaha dan per karyawan.</p></div>
        <div class="actions"><button class="btn btn-ghost" data-act="xls">${ui.icon('excel')}<span>Ekspor Excel</span></button><button class="btn btn-ghost" data-act="pdf">${ui.icon('pdf')}<span>Ekspor PDF</span></button></div></div>
      <div class="card">
        <div class="filters">
          <select id="rp-mode">${ui.options([['monthly', 'Bulanan'], ['yearly', 'Tahunan'], ['range', 'Rentang tanggal']], st.mode)}</select>
          <input type="month" id="rp-month" value="${st.month}" ${st.mode === 'monthly' ? '' : 'hidden'}>
          <select id="rp-year" ${st.mode === 'yearly' ? '' : 'hidden'}>${ui.options(years, st.year)}</select>
          <input type="date" id="rp-start" value="${rangeOf().start}" ${st.mode === 'range' ? '' : 'hidden'}><input type="date" id="rp-end" value="${rangeOf().end}" ${st.mode === 'range' ? '' : 'hidden'}>
          <select id="rp-unit">${ui.options([['ALL', 'Semua unit'], ['APT', 'Apotek Noura'], ['KLINIK', 'Praktek Dokter Umum']], st.unit)}</select>
          <select id="rp-emp"><option value="">Semua karyawan</option>${ui.options(emps.map((e) => [e.id, e.name]), st.employee)}</select>
          <label class="check"><input type="checkbox" id="rp-draft" ${st.includeDraft ? 'checked' : ''}><span>Sertakan draft</span></label>
        </div>
      </div>
      <div id="rp-body"></div>`;
    const body = ui.$('#rp-body', view);
    let R;
    async function draw() {
      body.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      R = await rep.build(Object.assign({}, rangeOf(), { employee: st.employee, includeDraft: st.includeDraft }));
      const { svc, shares, pay, adminPay, z, sharesByUnit } = R;
      const showA = st.unit !== 'KLINIK';
      const showB = st.unit !== 'APT';
      const grossAll = (showA ? svc.APT.gross : 0) + (showB ? svc.KLINIK.gross : 0);
      const unitShares = st.unit === 'ALL' ? shares : sharesByUnit[st.unit];
      body.innerHTML = `
        <div class="card report-flow">
          <h3>Alur pendapatan pelayanan — ${u.esc(label())}${st.unit !== 'ALL' ? ' · tindakan ' + C.UNITS[st.unit].name : ''}</h3>
          <div class="recon-flow big">
            <div><span>Pendapatan kotor pelayanan</span><b>${u.rp(grossAll)}</b></div><i>=</i>
            <div class="c-apotek"><span>Bagian Apotek Noura</span><b>${u.rp(unitShares.apotek)}</b></div><i>+</i>
            <div class="c-klinik"><span>Bagian Praktek Dokter</span><b>${u.rp(unitShares.klinik)}</b></div><i>+</i>
            <div class="c-staff"><span>Hak jasa karyawan</span><b>${u.rp(unitShares.dokter + unitShares.bidan + unitShares.perawat + unitShares.farmasi + unitShares.petugas)}</b></div><i>+</i>
            <div><span>Penerima lain</span><b>${u.rp(unitShares.eksternal)}</b></div>
          </div>
          <p class="muted small">${ui.icon('info')} Pendapatan kotor <b>bukan</b> keuntungan apotek. Hak jasa karyawan adalah milik tenaga kesehatan/petugas dan dibayarkan melalui penggajian.</p>
        </div>
        <div class="grid-2">
          ${showA ? `<div class="card"><h3>A. Laporan Apotek Noura</h3>
            ${kv([
              ['Pendapatan kotor tindakan unit Apotek', svc.APT.gross, u.num(svc.APT.qty) + ' tindakan'],
              ['Total pendapatan bagian apotek', shares.apotek, 'dari seluruh tindakan', 'strong'],
              ['Total gaji karyawan (beban bruto)', z(pay.APT, 'gross'), null, 'strong'],
              ['— Gaji pokok', z(pay.APT, 'base')],
              ['— Total tunjangan', z(pay.APT, 'allowance') + z(pay.APT, 'overtime')],
              ['— Total bonus & insentif', z(pay.APT, 'bonus') + z(pay.APT, 'incentive')],
              ['— Jasa pelayanan & honor', z(pay.APT, 'service') + z(pay.APT, 'practice')],
              ['— Pendapatan lainnya', z(pay.APT, 'other')],
              ['Total potongan', z(pay.APT, 'deductions')],
              ['Total gaji bersih dibayarkan', z(pay.APT, 'net'), null, 'strong'],
              ['Indikasi selisih: bagian apotek − beban gaji di luar jasa', shares.apotek - (z(pay.APT, 'gross') - z(pay.APT, 'service')), 'indikatif, belum termasuk HPP obat & biaya operasional', 'muted']
            ])}</div>` : ''}
          ${showB ? `<div class="card"><h3>B. Laporan Praktek Dokter Umum</h3>
            ${kv([
              ['Total pendapatan pelayanan (unit Praktek)', svc.KLINIK.gross, u.num(svc.KLINIK.qty) + ' tindakan', 'strong'],
              ['Bagian usaha Praktek Dokter', shares.klinik],
              ['Total jasa dokter', shares.dokter, 'seluruh tindakan'],
              ['Total jasa bidan', shares.bidan, 'seluruh tindakan'],
              ['Total jasa perawat', shares.perawat, 'seluruh tindakan'],
              ['Total gaji administrasi', adminPay.KLINIK],
              ['Total gaji karyawan (beban bruto)', z(pay.KLINIK, 'gross'), null, 'strong'],
              ['— Total tunjangan', z(pay.KLINIK, 'allowance') + z(pay.KLINIK, 'overtime')],
              ['— Jasa pelayanan & honor', z(pay.KLINIK, 'service') + z(pay.KLINIK, 'practice')],
              ['Total potongan', z(pay.KLINIK, 'deductions')],
              ['Total gaji bersih dibayarkan', z(pay.KLINIK, 'net'), null, 'strong']
            ])}</div>` : ''}
        </div>
        ${R.trend.length > 1 ? `<div class="card"><h3>Ringkasan per bulan</h3><div id="rp-trend"></div></div>` : ''}
        <div class="card"><div class="card-head"><h3>C. Laporan per Karyawan</h3><small class="muted">${R.runs.length} periode penggajian (${R.runs.map((r) => r.id).join(', ') || 'tidak ada'})</small></div><div id="rp-emp"></div></div>`;
      if (R.trend.length > 1)
        ui.table(ui.$('#rp-trend', body), {
          columns: [
            { key: 'period', label: 'Bulan', render: (t) => u.periodLabel(t.period) },
            { key: 'gross', label: 'Pendapatan Kotor', align: 'right', render: (t) => u.rp(t.gross) },
            { key: 'business', label: 'Bagian Usaha', align: 'right', render: (t) => u.rp(t.business) },
            { key: 'staff', label: 'Hak Jasa Karyawan', align: 'right', render: (t) => u.rp(t.staff) },
            { key: 'payGross', label: 'Beban Gaji Bruto', align: 'right', render: (t) => u.rp(t.payGross) },
            { key: 'payNet', label: 'Gaji Bersih', align: 'right', render: (t) => u.rp(t.payNet) }
          ],
          rows: R.trend,
          noPaging: true,
          sortable: false,
          footer: (rows) => `<tr><th>Total</th>${['gross', 'business', 'staff', 'payGross', 'payNet'].map((k) => `<th class="ta-right">${u.rp(u.sum(rows, (r) => r[k]))}</th>`).join('')}</tr>`
        });
      const empRows = empRowsOf();
      ui.table(ui.$('#rp-emp', body), {
        columns: [
          { key: 'name', label: 'Karyawan', render: (r) => `<b>${u.esc(r.emp.name)}</b><small class="block muted">${u.esc(r.emp.position)}</small>`, value: (r) => r.emp.name },
          { key: 'base', label: 'Gaji Pokok', align: 'right', render: (r) => u.rp(r.base) },
          { key: 'qty', label: 'Jml Tindakan', align: 'right', render: (r) => u.num(r.svcQty), value: (r) => r.svcQty },
          { key: 'svc', label: 'Honor Tindakan', align: 'right', render: (r) => u.rp(r.service + r.practice), value: (r) => r.service + r.practice },
          { key: 'allow', label: 'Tunjangan', align: 'right', render: (r) => u.rp(r.allowance + r.overtime), value: (r) => r.allowance },
          { key: 'bonus', label: 'Bonus', align: 'right', render: (r) => u.rp(r.bonus + r.incentive + r.other), value: (r) => r.bonus },
          { key: 'ded', label: 'Potongan', align: 'right', render: (r) => u.rp(r.deductions), value: (r) => r.deductions },
          { key: 'net', label: 'Gaji Bersih', align: 'right', render: (r) => `<b>${u.rp(r.net)}</b>`, value: (r) => r.net }
        ],
        rows: empRows,
        sortKey: 'name',
        noPaging: true,
        empty: 'Belum ada penggajian disetujui pada periode ini.' + (st.includeDraft ? '' : ' Centang "Sertakan draft" untuk melihat draft.'),
        footer: (rows) => `<tr><th>Total</th><th class="ta-right">${u.rp(u.sum(rows, (r) => r.base))}</th><th class="ta-right">${u.num(u.sum(rows, (r) => r.svcQty))}</th><th class="ta-right">${u.rp(u.sum(rows, (r) => r.service + r.practice))}</th><th class="ta-right">${u.rp(u.sum(rows, (r) => r.allowance + r.overtime))}</th><th class="ta-right">${u.rp(u.sum(rows, (r) => r.bonus + r.incentive + r.other))}</th><th class="ta-right">${u.rp(u.sum(rows, (r) => r.deductions))}</th><th class="ta-right">${u.rp(u.sum(rows, (r) => r.net))}</th></tr>`
      });
    }
    function empRowsOf() {
      return [...R.perEmp.values()]
        .filter((r) => st.unit === 'ALL' || r.emp.unit === st.unit || r.emp.unit === 'LINTAS')
        .map((r) => Object.assign({}, r, { svcQty: r.serviceQty }));
    }
    function kv(rows) {
      return `<div class="kv-list">${rows.map(([l, v, sub, cls]) => `<div class="kv ${cls || ''}"><span>${l}${sub ? `<small>${u.esc(sub)}</small>` : ''}</span><b>${u.rp(v)}</b></div>`).join('')}</div>`;
    }
    await draw();

    const $ = (id) => ui.$(id, view);
    $('#rp-mode').onchange = (e) => {
      st.mode = e.target.value;
      $('#rp-month').hidden = st.mode !== 'monthly';
      $('#rp-year').hidden = st.mode !== 'yearly';
      $('#rp-start').hidden = $('#rp-end').hidden = st.mode !== 'range';
      draw();
    };
    $('#rp-month').onchange = (e) => {
      st.month = e.target.value || st.month;
      draw();
    };
    $('#rp-year').onchange = (e) => {
      st.year = +e.target.value;
      draw();
    };
    $('#rp-start').onchange = (e) => {
      st.start = e.target.value;
      draw();
    };
    $('#rp-end').onchange = (e) => {
      st.end = e.target.value;
      draw();
    };
    $('#rp-unit').onchange = (e) => {
      st.unit = e.target.value;
      draw();
    };
    $('#rp-emp').onchange = (e) => {
      st.employee = e.target.value;
      draw();
    };
    $('#rp-draft').onchange = (e) => {
      st.includeDraft = e.target.checked;
      draw();
    };

    view.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (!a || !NP.sec.can('export')) return;
      const { svc, shares, pay, adminPay, z } = R;
      const fn = 'laporan-keuangan-' + u.slug(label());
      const secA = [['Pendapatan kotor tindakan unit Apotek', svc.APT.gross], ['Total pendapatan bagian apotek', shares.apotek], ['Total gaji karyawan (bruto)', z(pay.APT, 'gross')], ['Gaji pokok', z(pay.APT, 'base')], ['Total tunjangan', z(pay.APT, 'allowance') + z(pay.APT, 'overtime')], ['Total bonus & insentif', z(pay.APT, 'bonus') + z(pay.APT, 'incentive')], ['Jasa pelayanan & honor', z(pay.APT, 'service') + z(pay.APT, 'practice')], ['Total potongan', z(pay.APT, 'deductions')], ['Total gaji bersih', z(pay.APT, 'net')]];
      const secB = [['Total pendapatan pelayanan (unit Praktek)', svc.KLINIK.gross], ['Bagian usaha Praktek Dokter', shares.klinik], ['Total jasa dokter', shares.dokter], ['Total jasa bidan', shares.bidan], ['Total jasa perawat', shares.perawat], ['Total gaji administrasi', adminPay.KLINIK], ['Total gaji karyawan (bruto)', z(pay.KLINIK, 'gross')], ['Total tunjangan', z(pay.KLINIK, 'allowance') + z(pay.KLINIK, 'overtime')], ['Total potongan', z(pay.KLINIK, 'deductions')], ['Total gaji bersih', z(pay.KLINIK, 'net')]];
      const emp = empRowsOf();
      if (a.dataset.act === 'xls') {
        NP.exp.excel([
          { name: 'Ringkasan', aoa: [['LAPORAN KEUANGAN PENGGAJIAN & JASA'], [label()], [], ['Pendapatan kotor pelayanan', svc.APT.gross + svc.KLINIK.gross], ['Bagian Apotek Noura', shares.apotek], ['Bagian Praktek Dokter', shares.klinik], ['Hak jasa karyawan', shares.dokter + shares.bidan + shares.perawat + shares.farmasi + shares.petugas], ['Penerima lain', shares.eksternal]] },
          { name: 'A. Apotek Noura', aoa: [['Uraian', 'Jumlah']].concat(secA) },
          { name: 'B. Praktek Dokter', aoa: [['Uraian', 'Jumlah']].concat(secB) },
          { name: 'C. Per Karyawan', rows: emp.map((r) => ({ 'ID Karyawan': r.emp.id, Nama: r.emp.name, Jabatan: r.emp.position, 'Gaji Pokok': r.base, 'Jumlah Tindakan': r.svcQty, 'Honor Tindakan': r.service + r.practice, Tunjangan: r.allowance + r.overtime, Bonus: r.bonus + r.incentive + r.other, Potongan: r.deductions, 'Gaji Bersih': r.net })) },
          { name: 'Per Bulan', rows: R.trend.map((t) => ({ Bulan: u.periodLabel(t.period), 'Pendapatan Kotor': t.gross, 'Bagian Usaha': t.business, 'Hak Jasa Karyawan': t.staff, 'Beban Gaji Bruto': t.payGross, 'Gaji Bersih': t.payNet })) }
        ], fn + '.xlsx');
      }
      if (a.dataset.act === 'pdf') {
        const sections = [];
        if (st.unit !== 'KLINIK') sections.push({ title: 'A. Laporan Apotek Noura', head: ['Uraian', 'Jumlah'], body: secA.map(([l, v]) => [l, u.rp(v)]), numericCols: [1] });
        if (st.unit !== 'APT') sections.push({ title: 'B. Laporan Praktek Dokter Umum', head: ['Uraian', 'Jumlah'], body: secB.map(([l, v]) => [l, u.rp(v)]), numericCols: [1] });
        sections.push({
          title: 'C. Laporan per Karyawan', head: ['Nama', 'Jabatan', 'Gaji Pokok', 'Jml Tindakan', 'Honor Tindakan', 'Tunjangan', 'Bonus', 'Potongan', 'Gaji Bersih'],
          body: emp.map((r) => [r.emp.name, r.emp.position, u.rp(r.base), u.num(r.svcQty), u.rp(r.service + r.practice), u.rp(r.allowance + r.overtime), u.rp(r.bonus + r.incentive + r.other), u.rp(r.deductions), u.rp(r.net)]),
          foot: [['TOTAL', '', u.rp(u.sum(emp, (r) => r.base)), u.num(u.sum(emp, (r) => r.svcQty)), u.rp(u.sum(emp, (r) => r.service + r.practice)), u.rp(u.sum(emp, (r) => r.allowance + r.overtime)), u.rp(u.sum(emp, (r) => r.bonus + r.incentive + r.other)), u.rp(u.sum(emp, (r) => r.deductions)), u.rp(u.sum(emp, (r) => r.net))]],
          numericCols: [2, 3, 4, 5, 6, 7, 8]
        });
        NP.exp.pdfTable({ title: 'Laporan Keuangan Penggajian & Jasa Pelayanan', subtitle: label() + ' · Pendapatan kotor ' + u.rp(svc.APT.gross + svc.KLINIK.gross) + ' = bagian usaha ' + u.rp(shares.apotek + shares.klinik) + ' + jasa karyawan ' + u.rp(shares.dokter + shares.bidan + shares.perawat + shares.farmasi + shares.petugas) + ' + penerima lain ' + u.rp(shares.eksternal), unit: st.unit === 'KLINIK' ? 'KLINIK' : 'APT', headerName: st.unit === 'ALL' ? NP.state.settings.company.name : null, sections, signatures: true, filename: fn + '.pdf' });
      }
    });
  }

  NP.reports = rep;
  NP.pages.reports = { title: 'Laporan Keuangan', render };
})(typeof globalThis !== 'undefined' ? globalThis : window);
