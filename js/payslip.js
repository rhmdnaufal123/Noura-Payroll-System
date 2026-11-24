/* Noura Payroll — template SLIP GAJI profesional (A4) + preview, PDF, PNG, HTML, cetak, cetak massal, ZIP. */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;
  const C = NP.C;

  const E_ORDER = ['base', 'allowance', 'overtime', 'bonus', 'incentive', 'practice', 'service', 'other'];
  const D_ORDER = ['bpjs', 'tax', 'late', 'absent', 'kasbon', 'loan', 'other'];

  /* CSS slip dipakai bersama untuk tampilan, cetak, render PDF/PNG, dan unduhan HTML (satu sumber). */
  const SLIP_CSS = `
.slip{width:794px;min-height:1123px;box-sizing:border-box;padding:46px 52px 40px;background:#fff;color:#1f2937;font-family:'Plus Jakarta Sans','Segoe UI',Roboto,Arial,sans-serif;font-size:12px;line-height:1.45;position:relative;overflow:hidden}
.slip *{box-sizing:border-box}
.slip .s-head{display:flex;align-items:center;gap:16px;padding-bottom:14px;border-bottom:3px solid #006b2a}
.slip .s-head img{width:64px;height:64px;object-fit:contain}
.slip .s-org{flex:1}
.slip .s-org b{display:block;font-size:19px;color:#003d18;letter-spacing:.2px}
.slip .s-org small{display:block;color:#4b5563;font-size:11px}
.slip .s-title{text-align:right}
.slip .s-title h1{margin:0;font-size:22px;letter-spacing:3px;color:#006b2a}
.slip .s-title span{display:block;font-size:11px;color:#4b5563}
.slip .s-info{display:grid;grid-template-columns:1fr 1fr;gap:4px 28px;margin:16px 0 14px;padding:12px 14px;background:#f1f8f3;border:1px solid #d3ebdb;border-radius:8px}
.slip .s-info div{display:flex;gap:8px}
.slip .s-info span{width:120px;color:#4b5563;flex:none}
.slip .s-info b{font-weight:600}
.slip .s-cols{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}
.slip table{width:100%;border-collapse:collapse}
.slip .s-tbl th{background:#006b2a;color:#fff;text-align:left;padding:7px 10px;font-size:11.5px;letter-spacing:.6px}
.slip .s-tbl td{padding:5px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top}
.slip .s-tbl td.r,.slip .s-tbl th.r{text-align:right;white-space:nowrap}
.slip .s-tbl tr.grp td{background:#f9fafb;font-weight:700;color:#003d18;font-size:11px;padding-top:6px}
.slip .s-tbl tr.sub td{padding-left:22px;color:#374151}
.slip .s-tbl td small{display:block;color:#6b7280;font-size:10px}
.slip .s-tbl tr.tot td{font-weight:700;border-top:2px solid #006b2a;border-bottom:none;background:#ebf5ee}
.slip .s-sum{margin-top:16px;border:2px solid #006b2a;border-radius:10px;overflow:hidden}
.slip .s-sum .row{display:flex;justify-content:space-between;padding:7px 16px;border-bottom:1px solid #d3ebdb}
.slip .s-sum .thp{background:#003d18;color:#fff;padding:12px 16px;font-size:16px;border:none}
.slip .s-sum .thp b{font-size:20px}
.slip .s-terbilang{padding:7px 16px;font-style:italic;color:#004d1e;background:#f1f8f3;font-size:11px}
.slip h4{margin:16px 0 6px;font-size:12px;color:#003d18;letter-spacing:.5px;text-transform:uppercase}
.slip .s-detail td,.slip .s-detail th{padding:4px 8px;font-size:11px;border-bottom:1px solid #e5e7eb}
.slip .s-detail th{background:#f3f4f6;text-align:left}
.slip .s-detail .r{text-align:right}
.slip .s-att{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:10px;font-size:10.5px;color:#4b5563}
.slip .s-note{margin-top:8px;font-size:10.5px;color:#4b5563}
.slip .s-sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:26px;text-align:center}
.slip .s-sign .line{margin-top:62px;border-top:1px solid #374151;padding-top:4px;font-weight:600}
.slip .s-sign small{display:block;color:#6b7280}
.slip .s-foot{margin-top:22px;padding-top:8px;border-top:1px dashed #d1d5db;display:flex;justify-content:space-between;font-size:10px;color:#6b7280}
.slip .s-wm{position:absolute;top:42%;left:0;right:0;text-align:center;font-size:120px;font-weight:800;color:rgba(239,68,68,.10);transform:rotate(-24deg);pointer-events:none;letter-spacing:12px}
`;

  function injectCss() {
    if (typeof document === 'undefined' || document.getElementById('slip-style')) return;
    const st = document.createElement('style');
    st.id = 'slip-style';
    st.textContent = SLIP_CSS;
    document.head.appendChild(st);
  }

  function linesHtml(lines, order, groups, showDetail, serviceDetail) {
    let h = '';
    for (const g of order) {
      const ls = lines.filter((l) => l.group === g);
      if (!ls.length) continue;
      if (ls.length === 1 && (g === 'base' || ls[0].name === groups[g] || g === 'tax')) {
        h += `<tr><td>${u.esc(ls[0].name)}${ls[0].note ? `<small>${u.esc(ls[0].note)}</small>` : ''}</td><td class="r">${u.rp(ls[0].amount)}</td></tr>`;
      } else {
        h += `<tr class="grp"><td colspan="2">${u.esc(groups[g])}</td></tr>`;
        for (const l of ls) h += `<tr class="sub"><td>${u.esc(l.name)}${l.note ? `<small>${u.esc(l.note)}</small>` : ''}</td><td class="r">${u.rp(l.amount)}</td></tr>`;
      }
      if (g === 'service' && showDetail && serviceDetail && serviceDetail.length && serviceDetail.length <= 6) {
        for (const d of serviceDetail) h += `<tr class="sub"><td><small>· ${u.esc(d.serviceName)}: ${u.num(d.qty)} × ${u.rp(d.unitAmount)}</small></td><td class="r"><small>${u.rp(d.amount)}</small></td></tr>`;
      }
    }
    return h || '<tr><td colspan="2"><small>Tidak ada</small></td></tr>';
  }

  /** HTML slip gaji. */
  function slipHtml(run, s, opts) {
    opts = opts || {};
    const set = NP.state.settings;
    const cfg = set.slip || {};
    const unit = NP.unitInfo(s.employee.primaryUnit || 'APT');
    const t = s.totals;
    const inp = s.inputs || {};
    const D = NP.defaults;
    const showDetail = cfg.showServiceDetail !== false;
    return `<div class="slip">
      ${opts.draft || run.status === 'draft' ? '<div class="s-wm">DRAFT</div>' : ''}
      <div class="s-head">
        <img src="${unit.logo}" alt="Logo">
        <div class="s-org"><b>${u.esc(unit.name)}</b><small>${u.esc(unit.address || '')}</small><small>Telp. ${u.esc(unit.phone || '-')}${unit.email ? ' · ' + u.esc(unit.email) : ''}</small></div>
        <div class="s-title"><h1>SLIP GAJI</h1><span>Periode ${u.esc(u.periodLabel(run.period))}</span><span>No. ${u.esc(s.slipNo || '(draft)')}</span></div>
      </div>
      <div class="s-info">
        <div><span>Nama lengkap</span><b>: ${u.esc(s.employee.name)}</b></div>
        <div><span>Periode penggajian</span><b>: ${u.fmtDate(run.start, 'long')} – ${u.fmtDate(run.end, 'long')}</b></div>
        <div><span>ID karyawan</span><b>: ${u.esc(s.employee.id)}</b></div>
        <div><span>Tanggal pembayaran</span><b>: ${u.fmtDate(run.payDate, 'long')}</b></div>
        <div><span>Jabatan</span><b>: ${u.esc(s.employee.position)}</b></div>
        <div><span>Departemen</span><b>: ${u.esc(s.employee.department || '-')}</b></div>
        <div><span>Unit usaha</span><b>: ${u.esc(C.EMP_UNITS[s.employee.unit] || s.employee.unit)}</b></div>
        <div><span>Pembayaran</span><b>: ${u.esc(s.employee.payMethod || 'Transfer Bank')}${cfg.showBank !== false && s.employee.bankName ? ' · ' + u.esc(s.employee.bankName) + ' ' + u.esc(s.employee.bankAccountMasked) : ''}</b></div>
      </div>
      <div class="s-cols">
        <table class="s-tbl"><thead><tr><th>PENDAPATAN</th><th class="r">JUMLAH</th></tr></thead><tbody>
          ${linesHtml(s.earnings, E_ORDER, D.EARNING_GROUPS, showDetail, s.serviceDetail)}
          <tr class="tot"><td>Total Pendapatan</td><td class="r">${u.rp(t.gross)}</td></tr></tbody></table>
        <table class="s-tbl"><thead><tr><th>POTONGAN</th><th class="r">JUMLAH</th></tr></thead><tbody>
          ${linesHtml(s.deductions, D_ORDER, D.DEDUCTION_GROUPS)}
          <tr class="tot"><td>Total Potongan</td><td class="r">${u.rp(t.deductions)}</td></tr></tbody></table>
      </div>
      <div class="s-sum">
        <div class="row"><span>Total Pendapatan</span><b>${u.rp(t.gross)}</b></div>
        <div class="row"><span>Total Potongan</span><b>${u.rp(t.deductions)}</b></div>
        <div class="row thp"><span>GAJI BERSIH / TAKE HOME PAY</span><b>${u.rp(t.net)}</b></div>
        ${cfg.showTerbilang !== false ? `<div class="s-terbilang">Terbilang: ${u.esc(u.terbilang(t.net))}</div>` : ''}
      </div>
      ${showDetail && s.serviceDetail && s.serviceDetail.length > 6 ? `<h4>Rincian Jasa Pelayanan</h4><table class="s-detail"><thead><tr><th>Tindakan</th><th class="r">Jumlah</th><th class="r">Jasa / tindakan</th><th class="r">Total</th></tr></thead><tbody>
        ${s.serviceDetail.map((d) => `<tr><td>${u.esc(d.serviceName)}</td><td class="r">${u.num(d.qty)}</td><td class="r">${u.rp(d.unitAmount)}</td><td class="r">${u.rp(d.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
      <div class="s-att"><span>Hari kerja: <b>${u.num(inp.workDays)}</b></span><span>Hadir: <b>${u.num(inp.presentDays)}</b></span><span>Tidak hadir: <b>${u.num(inp.absentDays)}</b></span><span>Terlambat: <b>${u.num(inp.lateCount)}×</b></span>${inp.overtimeHours ? `<span>Lembur: <b>${u.num(inp.overtimeHours, 1)} jam</b></span>` : ''}${inp.shifts ? `<span>Shift: <b>${u.num(inp.shifts)}</b></span>` : ''}${inp.sessions ? `<span>Sesi praktik: <b>${u.num(inp.sessions)}</b></span>` : ''}${s.serviceQty ? `<span>Tindakan: <b>${u.num(s.serviceQty)}</b></span>` : ''}</div>
      ${cfg.showEmployerContrib && s.employer && s.employer.total ? `<div class="s-note">Iuran BPJS ditanggung pemberi kerja (tidak mengurangi gaji): ${u.rp(s.employer.total)}</div>` : ''}
      ${inp.slipNote ? `<div class="s-note">Catatan: ${u.esc(inp.slipNote)}</div>` : ''}
      <div class="s-sign">
        <div><small>Mengetahui,</small><small>${u.esc(unit.leaderTitle || 'Pimpinan')}</small><div class="line">${u.esc(unit.leaderName || '(.............................)')}</div></div>
        <div><small>Diterima oleh,</small><small>Karyawan</small><div class="line">${u.esc(s.employee.name)}</div></div>
      </div>
      <div class="s-foot"><span>Diterbitkan: ${u.fmtDate(u.todayISO(new Date(s.issuedAt || run.approvedAt || Date.now())), 'long')} · Dibuat oleh: ${u.esc(cfg.issuerName || 'Administrator')}</span><span>${u.esc(cfg.footerNote || '')}</span></div>
    </div>`;
  }

  function fileBase(run, s) {
    return 'slip-gaji-' + run.period + '-' + s.employee.id + '-' + u.slug(s.employee.name);
  }

  async function toCanvas(run, s, opts) {
    injectCss();
    return NP.exp.toCanvas(slipHtml(run, s, opts), 794);
  }

  const slip = {
    css: SLIP_CSS,
    html: slipHtml,
    async pdfBlob(run, s, opts) {
      return NP.exp.canvasToPdfBlob(await toCanvas(run, s, opts));
    },
    async pdf(run, s, opts) {
      await ui.busy('Membuat PDF slip gaji...', async () => {
        NP.exp.download(await slip.pdfBlob(run, s, opts), fileBase(run, s) + '.pdf');
      });
      NP.audit.log('payslip.pdf', 'payroll', run.id, 'Unduh PDF slip ' + s.employee.name);
    },
    async png(run, s, opts) {
      await ui.busy('Membuat gambar slip gaji...', async () => {
        NP.exp.download(await NP.exp.canvasToBlob(await toCanvas(run, s, opts)), fileBase(run, s) + '.png');
      });
    },
    async htmlFile(run, s, opts) {
      let body = slipHtml(run, s, opts);
      // sematkan logo agar file HTML berdiri sendiri
      const m = body.match(/<img src="([^"]+)"/);
      if (m && !m[1].startsWith('data:')) {
        try {
          const blob = await (await fetch(m[1])).blob();
          body = body.replace(m[1], await ui.readFile(blob, 'dataurl'));
        } catch (_) {}
      }
      const doc = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Slip Gaji ${u.esc(s.employee.name)} ${u.esc(u.periodLabel(run.period))}</title><style>body{margin:0;background:#e5e7eb;display:flex;justify-content:center;padding:20px}@page{size:A4;margin:0}@media print{body{background:#fff;padding:0}}${SLIP_CSS}</style></head><body>${body}</body></html>`;
      NP.exp.download(new Blob([doc], { type: 'text/html;charset=utf-8' }), fileBase(run, s) + '.html');
    },
    print(run, s, opts) {
      injectCss();
      NP.exp.printHtml(`<div class="print-page">${slipHtml(run, s, opts)}</div>`, 'Slip ' + s.employee.name);
    },
    printAll(run) {
      injectCss();
      if (!run.slips.length) return ui.toast('Tidak ada slip.', 'warning');
      NP.exp.printHtml(run.slips.map((s) => `<div class="print-page">${slipHtml(run, s)}</div>`).join(''), 'Slip Gaji ' + u.periodLabel(run.period));
      NP.audit.log('payslip.printall', 'payroll', run.id, 'Cetak massal ' + run.slips.length + ' slip');
    },
    async zipAll(run) {
      if (!root.JSZip) return ui.toast('Pustaka JSZip tidak tersedia.', 'error');
      if (!run.slips.length) return ui.toast('Tidak ada slip.', 'warning');
      await ui.busy('Menyiapkan ZIP slip gaji...', async (progress) => {
        const zip = new JSZip();
        const folder = zip.folder('slip-gaji-' + run.period);
        let i = 0;
        for (const s of run.slips) {
          progress('Membuat slip ' + ++i + ' dari ' + run.slips.length + ' — ' + s.employee.name);
          folder.file(fileBase(run, s) + '.pdf', await slip.pdfBlob(run, s));
        }
        progress('Mengompres ZIP...');
        const blob = await zip.generateAsync({ type: 'blob' });
        NP.exp.download(blob, 'slip-gaji-' + run.id + '.zip');
      });
      NP.audit.log('payslip.zip', 'payroll', run.id, 'Unduh ZIP ' + run.slips.length + ' slip');
      ui.toast('ZIP berisi ' + run.slips.length + ' slip gaji diunduh.');
    },
    previewModal(run, s, opts) {
      injectCss();
      const m = ui.modal({
        title: 'Slip Gaji — ' + s.employee.name,
        size: 'xl',
        body: `<div class="slip-viewport"><div class="slip-scale">${slipHtml(run, s, opts)}</div></div>`,
        actions: [
          { label: 'Tutup', cls: 'btn-ghost', onClick: (mm) => mm.close() },
          { label: 'PNG', icon: 'image', cls: 'btn-ghost', onClick: () => slip.png(run, s, opts) },
          { label: 'HTML', icon: 'code', cls: 'btn-ghost', onClick: () => slip.htmlFile(run, s, opts) },
          { label: 'Cetak', icon: 'print', cls: 'btn-ghost', onClick: () => slip.print(run, s, opts) },
          { label: 'Download PDF', icon: 'pdf', cls: 'btn-primary', onClick: () => slip.pdf(run, s, opts) }
        ]
      });
      fitSlip(m.el.querySelector('.slip-viewport'));
      return m;
    }
  };

  function fitSlip(vp) {
    if (!vp) return;
    const sc = vp.querySelector('.slip-scale');
    const apply = () => {
      const w = vp.clientWidth;
      const k = Math.min(1, w / 794);
      sc.style.transform = 'scale(' + k + ')';
      vp.style.height = Math.ceil(sc.firstElementChild.offsetHeight * k) + 'px';
    };
    apply();
    setTimeout(apply, 100);
    window.addEventListener('resize', apply, { passive: true });
  }

  /* ===================== Halaman SLIP GAJI ===================== */
  async function render(view, params) {
    injectCss();
    const runs = (await NP.payroll.runs()).filter((r) => r.slips.length);
    view.innerHTML = `
      <div class="page-head">
        <div><h2>Slip Gaji</h2><p class="muted">Preview, unduh (PDF/PNG/HTML), cetak, cetak massal, dan unduh semua slip dalam ZIP.</p></div>
      </div>
      ${runs.length ? '' : `<div class="card">${ui.empty('Belum ada slip gaji. Jalankan Generate Payroll terlebih dahulu.', 'slip')}<div class="center"><a class="btn btn-primary" href="#/generate">Generate Payroll</a></div></div>`}`;
    if (!runs.length) return;
    let run = runs.find((r) => r.id === params.run) || runs.find((r) => r.status !== 'draft') || runs[0];
    let current = params.emp || null;
    view.insertAdjacentHTML('beforeend', `
      <div class="card">
        <div class="filters">
          <label class="field-inline"><span>Penggajian</span><select id="sl-run">${ui.options(runs.map((r) => [r.id, r.id + ' · ' + u.periodLabel(r.period) + ' · ' + NP.payroll.statusLabel(r.status)]), run.id)}</select></label>
          <label class="search">${ui.icon('search')}<input type="search" id="sl-q" placeholder="Cari karyawan..."></label>
          <div class="btn-group">
            <button class="btn btn-ghost" data-act="printall">${ui.icon('print')}<span>Cetak semua</span></button>
            <button class="btn btn-ghost" data-act="zip">${ui.icon('zip')}<span>Download ZIP</span></button>
          </div>
        </div>
        <div class="slip-layout">
          <div class="slip-list" id="sl-list"></div>
          <div class="slip-preview">
            <div class="slip-actions" id="sl-actions"></div>
            <div class="slip-viewport" id="sl-vp"><div class="slip-scale"></div></div>
          </div>
        </div>
      </div>`);
    const listEl = ui.$('#sl-list', view);
    function drawList() {
      const q = (ui.$('#sl-q', view).value || '').toLowerCase();
      const slips = run.slips.filter((s) => !q || (s.employee.name + ' ' + s.employee.id + ' ' + s.employee.position).toLowerCase().includes(q)).sort((a, b) => a.employee.name.localeCompare(b.employee.name));
      if (!current || !run.slips.some((s) => s.employeeId === current)) current = slips[0] && slips[0].employeeId;
      listEl.innerHTML = slips.map((s) => `<button class="slip-item ${s.employeeId === current ? 'active' : ''}" data-emp="${s.employeeId}"><b>${u.esc(s.employee.name)}</b><small>${u.esc(s.employee.position)}</small><span>${u.rp(s.totals.net)}</span></button>`).join('') || ui.empty('Tidak ditemukan.');
      drawPreview();
    }
    function drawPreview() {
      const s = run.slips.find((x) => x.employeeId === current);
      const vp = ui.$('#sl-vp', view);
      if (!s) {
        vp.querySelector('.slip-scale').innerHTML = '';
        return;
      }
      ui.$('#sl-actions', view).innerHTML = `${run.status === 'draft' ? ui.badge('Draft — belum disetujui', 'amber') : ui.badge(s.slipNo, 'green')}
        <div class="btn-group"><button class="btn btn-sm btn-primary" data-act="pdf">${ui.icon('pdf')}PDF</button><button class="btn btn-sm btn-ghost" data-act="png">${ui.icon('image')}PNG</button><button class="btn btn-sm btn-ghost" data-act="html">${ui.icon('code')}HTML</button><button class="btn btn-sm btn-ghost" data-act="print">${ui.icon('print')}Cetak</button></div>`;
      vp.querySelector('.slip-scale').innerHTML = slipHtml(run, s);
      fitSlip(vp);
    }
    drawList();
    ui.$('#sl-run', view).onchange = (e) => {
      run = runs.find((r) => r.id === e.target.value);
      current = null;
      drawList();
    };
    ui.$('#sl-q', view).oninput = u.debounce(drawList, 150);
    view.addEventListener('click', (e) => {
      const it = e.target.closest('[data-emp]');
      if (it) {
        current = it.dataset.emp;
        ui.$$('.slip-item', view).forEach((b) => b.classList.toggle('active', b === it));
        drawPreview();
        if (window.innerWidth < 900) ui.$('#sl-actions', view).scrollIntoView({ behavior: 'smooth' });
        return;
      }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const s = run.slips.find((x) => x.employeeId === current);
      if (a.dataset.act === 'pdf') slip.pdf(run, s);
      if (a.dataset.act === 'png') slip.png(run, s);
      if (a.dataset.act === 'html') slip.htmlFile(run, s);
      if (a.dataset.act === 'print') slip.print(run, s);
      if (a.dataset.act === 'printall') slip.printAll(run);
      if (a.dataset.act === 'zip') slip.zipAll(run);
    });
  }

  NP.slip = slip;
  NP.pages.payslips = { title: 'Slip Gaji', render };
})(typeof globalThis !== 'undefined' ? globalThis : window);
