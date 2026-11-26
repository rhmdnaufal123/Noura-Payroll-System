/* Noura Payroll — ekspor & cetak: Excel (SheetJS), PDF tabel (jsPDF + AutoTable), cetak langsung, unduh berkas. */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;

  const exp = {};

  /** Unduh berkas. Versi online (artifact claude.ai) memakai kapabilitas `downloads`
   * karena sandbox memblokir unduhan biasa. Mengembalikan true bila diserahkan ke browser. */
  exp.download = async function (blob, filename) {
    if (NP.ENV && NP.ENV.artifact) {
      const dl = root.claude && root.claude.use ? await root.claude.use('downloads') : null;
      if (!dl) {
        ui.toast('Unduhan tidak tersedia di tampilan ini. Buka artifact di browser untuk mengunduh.', 'error');
        return false;
      }
      try {
        await dl.save({ filename, data: blob });
        return true;
      } catch (e) {
        const code = e && e.code;
        if (code === 'declined') ui.toast('Unduhan dibatalkan.', 'info');
        else if (code === 'rate_limited') ui.toast('Masih ada unduhan yang menunggu konfirmasi. Coba lagi sebentar.', 'warning');
        else if (code === 'host_unavailable') ui.toast('Aplikasi ini tidak dapat menyimpan file. Buka di browser atau komputer.', 'error');
        else ui.toast('File tidak dapat diunduh' + (e && e.message ? ': ' + e.message : '.'), 'error');
        return false;
      }
    }
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1500);
    return true;
  };

  /** sheets: [{ name, rows: [obj] | aoa: [[...]] }] */
  exp.excel = function (sheets, filename) {
    if (!root.XLSX) return ui.toast('Pustaka Excel (SheetJS) tidak tersedia.', 'error');
    const wb = XLSX.utils.book_new();
    for (const sh of sheets) {
      const ws = sh.aoa ? XLSX.utils.aoa_to_sheet(sh.aoa) : XLSX.utils.json_to_sheet(sh.rows && sh.rows.length ? sh.rows : [{ Info: 'Tidak ada data' }]);
      const rows = sh.aoa || (sh.rows && sh.rows.length ? [Object.keys(sh.rows[0])].concat(sh.rows.map((r) => Object.values(r))) : [['Info']]);
      ws['!cols'] = (rows[0] || []).map((_, i) => ({ wch: Math.min(45, Math.max(8, ...rows.slice(0, 200).map((r) => String(r[i] === undefined ? '' : r[i]).length + 2))) }));
      // format angka rupiah
      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let R = range.s.r + 1; R <= range.e.r; ++R)
        for (let Cc = range.s.c; Cc <= range.e.c; ++Cc) {
          const cell = ws[XLSX.utils.encode_cell({ r: R, c: Cc })];
          if (cell && cell.t === 'n' && Math.abs(cell.v) >= 1000) cell.z = '#,##0';
        }
      XLSX.utils.book_append_sheet(wb, ws, String(sh.name || 'Sheet').slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
    }
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return exp.download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename).then((ok) => {
      if (ok) ui.toast('File Excel diunduh: ' + filename, 'info');
      return ok;
    });
  };

  exp.readExcel = async function (file) {
    if (!root.XLSX) throw new Error('Pustaka Excel (SheetJS) tidak tersedia.');
    const buf = await ui.readFile(file, 'buffer');
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: '' });
  };

  function jsPDFCtor() {
    return root.jspdf && root.jspdf.jsPDF;
  }

  async function imgData(src) {
    if (!src) return null;
    if (src.startsWith('data:')) return src;
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      return await ui.readFile(blob, 'dataurl');
    } catch (_) {
      return null;
    }
  }

  /** PDF laporan tabel dengan kop unit usaha. */
  exp.pdfTable = async function (opt) {
    const J = jsPDFCtor();
    if (!J) return ui.toast('Pustaka PDF (jsPDF) tidak tersedia.', 'error');
    const doc = new J({ orientation: opt.orientation || 'portrait', unit: 'mm', format: 'a4' });
    const unit = NP.unitInfo(opt.unit || 'APT');
    const W = doc.internal.pageSize.getWidth();
    const logo = await imgData(unit.logo);
    let y = 12;
    if (logo) {
      try {
        doc.addImage(logo, 14, y - 2, 14, 14);
      } catch (_) {}
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(opt.headerName || unit.name, 31, y + 3);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text((unit.address || '') + (unit.phone ? ' · Telp. ' + unit.phone : ''), 31, y + 8);
    doc.setDrawColor(0, 107, 42);
    doc.setLineWidth(0.6);
    doc.line(14, y + 13, W - 14, y + 13);
    y += 20;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(opt.title, W / 2, y, { align: 'center' });
    if (opt.subtitle) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(opt.subtitle, W / 2, y + 5, { align: 'center' });
    }
    y += opt.subtitle ? 10 : 6;
    const sections = opt.sections || [{ head: opt.head, body: opt.body, foot: opt.foot, numericCols: opt.numericCols }];
    const footed = new Set();
    for (const sec of sections) {
      if (sec.title) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        if (y > doc.internal.pageSize.getHeight() - 30) {
          doc.addPage();
          y = 15;
        }
        doc.text(sec.title, 14, y + 2);
        y += 5;
      }
      const colStyles = {};
      (sec.numericCols || []).forEach((i) => (colStyles[i] = { halign: 'right' }));
      doc.autoTable(Object.assign({
        startY: y,
        head: sec.head ? [sec.head] : undefined,
        body: sec.body,
        foot: sec.foot,
        theme: 'grid',
        styles: { fontSize: opt.fontSize || 8, cellPadding: 1.6, lineColor: [226, 232, 240], lineWidth: 0.1 },
        headStyles: { fillColor: [0, 107, 42], textColor: 255, fontStyle: 'bold' },
        footStyles: { fillColor: [235, 245, 238], textColor: [0, 61, 24], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: colStyles,
        margin: { left: 14, right: 14 },
        didDrawPage: () => {
          // kaki halaman sekali per halaman (beberapa tabel dapat berada di halaman yang sama)
          const pg = doc.internal.getNumberOfPages();
          if (footed.has(pg)) return;
          footed.add(pg);
          const H = doc.internal.pageSize.getHeight();
          doc.setFontSize(7.5);
          doc.setTextColor(120);
          doc.text('Dicetak ' + u.fmtDateTime(Date.now()) + ' oleh ' + ((NP.sec.user() || {}).name || '-') + ' · Noura Payroll Management', 14, H - 7);
          doc.text('Hal. ' + doc.internal.getNumberOfPages(), W - 14, H - 7, { align: 'right' });
          doc.setTextColor(0);
        }
      }, sec.tableOpts || {})); // tableOpts: gaya/kolom khusus per bagian (mis. warna sel jadwal)
      y = doc.lastAutoTable.finalY + 8;
    }
    if (opt.signatures) {
      const H = doc.internal.pageSize.getHeight();
      if (y > H - 40) {
        doc.addPage();
        y = 20;
      }
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text('Dibuat oleh,', 30, y);
      doc.text('Disetujui oleh,', W - 70, y);
      doc.text('( ' + ((NP.sec.user() || {}).name || '..................') + ' )', 30, y + 22);
      doc.text('( ' + (unit.leaderName || '..................') + ' )', W - 70, y + 22);
    }
    if (await exp.download(doc.output('blob'), opt.filename || 'laporan.pdf')) ui.toast('PDF diunduh: ' + (opt.filename || 'laporan.pdf'), 'info');
  };

  /** Cetak HTML langsung (memakai kontainer #print-root dan css/print.css). */
  exp.printHtml = function (html, title) {
    if (NP.ENV && NP.ENV.artifact) {
      ui.toast('Cetak langsung tidak tersedia di versi online. Unduh PDF lalu cetak dari file tersebut.', 'info');
      return;
    }
    let rootEl = document.getElementById('print-root');
    if (!rootEl) {
      rootEl = document.createElement('div');
      rootEl.id = 'print-root';
      document.body.appendChild(rootEl);
    }
    rootEl.innerHTML = html;
    const old = document.title;
    if (title) document.title = title;
    document.body.classList.add('printing');
    const imgs = [...rootEl.querySelectorAll('img')];
    Promise.all(imgs.map((i) => (i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r))))).then(() => {
      setTimeout(() => {
        window.print();
        setTimeout(() => {
          document.body.classList.remove('printing');
          rootEl.innerHTML = '';
          document.title = old;
        }, 500);
      }, 50);
    });
  };

  /** Render elemen HTML ke canvas (html2canvas) dalam kontainer offscreen dengan lebar A4. */
  exp.toCanvas = async function (html, widthPx) {
    if (!root.html2canvas) throw new Error('Pustaka html2canvas tidak tersedia.');
    const host = document.createElement('div');
    host.className = 'render-host';
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + (widthPx || 794) + 'px;background:#fff;z-index:-1';
    host.innerHTML = html;
    document.body.appendChild(host);
    try {
      const imgs = [...host.querySelectorAll('img')];
      await Promise.all(imgs.map((i) => (i.complete ? 0 : new Promise((r) => (i.onload = i.onerror = r)))));
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      return await html2canvas(host.firstElementChild, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    } finally {
      host.remove();
    }
  };

  /** Canvas -> PDF A4 satu halaman (diperkecil bila perlu agar tidak terpotong). */
  exp.canvasToPdfBlob = function (canvas) {
    const J = jsPDFCtor();
    const doc = new J({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = 210;
    const H = 297;
    const margin = 0;
    let w = W - margin * 2;
    let h = (canvas.height * w) / canvas.width;
    if (h > H - margin * 2) {
      h = H - margin * 2;
      w = (canvas.width * h) / canvas.height;
    }
    doc.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', (W - w) / 2, margin, w, h);
    return doc.output('blob');
  };

  exp.canvasToBlob = (canvas, type) => new Promise((r) => canvas.toBlob(r, type || 'image/png'));

  NP.exp = exp;
})(typeof globalThis !== 'undefined' ? globalThis : window);
