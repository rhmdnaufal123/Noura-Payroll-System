/* Noura Payroll — komponen antarmuka: modal, konfirmasi, notifikasi, tabel, input rupiah, tab, grafik. */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;

  const ui = {};
  ui._charts = [];

  ui.$ = (sel, ctx) => (ctx || document).querySelector(sel);
  ui.$$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  ui.html = function (str) {
    const t = document.createElement('template');
    t.innerHTML = String(str).trim();
    return t.content.firstElementChild;
  };

  /* ---------- Ikon (SVG inline, tanpa dependensi) ---------- */
  const ICONS = {
    dashboard: '<path d="M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z"/>',
    users: '<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>',
    medical: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>',
    input: '<path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 14h-3v3h-2v-3H8v-2h3v-3h2v3h3v2zM13 9V3.5L18.5 9H13z"/>',
    history: '<path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>',
    pie: '<path d="M11 2v20c-5.07-.5-9-4.79-9-10s3.93-9.5 9-10zm2.03 0v8.99H22c-.47-4.74-4.24-8.52-8.97-8.99zm0 11.01V22c4.74-.47 8.5-4.25 8.97-8.99h-8.97z"/>',
    recap: '<path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>',
    wallet: '<path d="M21 18v1c0 1.1-.9 2-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14c1.1 0 2 .9 2 2v1h-9a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h9zm-9-2h10V8H12v8zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>',
    play: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>',
    slip: '<path d="M18 17H6v-2h12v2zm0-4H6v-2h12v2zm0-4H6V7h12v2zM3 22l1.5-1.5L6 22l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5L21 22V2l-1.5 1.5L18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2 4.5 3.5 3 2v20z"/>',
    report: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>',
    archive: '<path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/>',
    settings: '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>',
    plus: '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>',
    edit: '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',
    trash: '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
    search: '<path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>',
    download: '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>',
    upload: '<path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/>',
    print: '<path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/>',
    menu: '<path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>',
    close: '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',
    lock: '<path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>',
    unlock: '<path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/>',
    check: '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>',
    x: '<path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/>',
    eye: '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>',
    logout: '<path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>',
    copy: '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>',
    info: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>',
    warn: '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>',
    calendar: '<path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11zM7 11h5v5H7z"/>',
    zip: '<path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-2 6h-2v2h2v2h-2v2h-2v-2h2v-2h-2v-2h2v-2h-2V8h2v2h2v2z"/>',
    image: '<path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>',
    code: '<path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>',
    refresh: '<path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>',
    pdf: '<path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z"/>',
    excel: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2.5 14h-2.2l-2.3-3.5L9.7 17H7.5l3.4-5-3.4-5h2.2l2.3 3.5L14.3 7h2.2l-3.4 5 3.4 5z"/>'
  };
  ui.icon = (name, cls) => `<svg class="ico ico-${name} ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;

  /* ---------- Toast ---------- */
  ui.toast = function (message, type) {
    type = type || 'success';
    let wrap = ui.$('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      wrap.setAttribute('role', 'status');
      wrap.setAttribute('aria-live', 'polite');
      document.body.appendChild(wrap);
    }
    const ic = { success: 'check', error: 'x', warning: 'warn', info: 'info' }[type] || 'info';
    const t = ui.html(`<div class="toast toast-${type}">${ui.icon(ic)}<span>${u.esc(message)}</span></div>`);
    wrap.appendChild(t);
    setTimeout(() => t.classList.add('hide'), type === 'error' ? 6000 : 3500);
    setTimeout(() => t.remove(), type === 'error' ? 6500 : 4000);
  };

  /* ---------- Modal ---------- */
  let modalDepth = 0;
  ui.modal = function (opt) {
    const el = ui.html(`
      <div class="modal-backdrop" role="dialog" aria-modal="true">
        <div class="modal modal-${opt.size || 'md'}">
          <div class="modal-head"><h3>${u.esc(opt.title || '')}</h3><button class="icon-btn" data-close aria-label="Tutup">${ui.icon('close')}</button></div>
          <div class="modal-body"></div>
          <div class="modal-foot"></div>
        </div>
      </div>`);
    const body = el.querySelector('.modal-body');
    if (typeof opt.body === 'string') body.innerHTML = opt.body;
    else if (opt.body) body.appendChild(opt.body);
    const foot = el.querySelector('.modal-foot');
    let closed = false;
    const m = {
      el,
      body,
      close(silent) {
        if (closed) return;
        closed = true;
        el.classList.add('closing');
        document.removeEventListener('keydown', onKey);
        setTimeout(() => {
          el.remove();
          modalDepth--;
          if (modalDepth <= 0) document.body.classList.remove('modal-open');
        }, 150);
        if (!silent && opt.onClose) opt.onClose(m);
      }
    };
    (opt.actions || []).forEach((a) => {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.cls || 'btn-ghost');
      b.type = 'button';
      b.innerHTML = (a.icon ? ui.icon(a.icon) : '') + '<span>' + u.esc(a.label) + '</span>';
      b.onclick = async () => {
        if (b.disabled) return;
        b.disabled = true;
        try {
          await a.onClick(m);
        } catch (e) {
          console.error(e);
          ui.toast(e.message || String(e), 'error');
        } finally {
          b.disabled = false;
        }
      };
      foot.appendChild(b);
    });
    if (!(opt.actions || []).length) foot.remove();
    const onKey = (e) => {
      if (e.key === 'Escape' && el === ui.$$('.modal-backdrop').pop()) m.close();
    };
    document.addEventListener('keydown', onKey);
    el.querySelector('[data-close]').onclick = () => m.close();
    el.addEventListener('mousedown', (e) => {
      if (e.target === el && !opt.static) m.close();
    });
    document.body.appendChild(el);
    document.body.classList.add('modal-open');
    modalDepth++;
    if (opt.onOpen) opt.onOpen(m);
    setTimeout(() => {
      // Jangan merebut fokus bila pengguna sudah mulai mengisi kolom di dalam modal.
      if (el.contains(document.activeElement) && document.activeElement !== document.body) return;
      const f = body.querySelector('input:not([type=hidden]):not([readonly]),select,textarea');
      if (f && opt.autofocus !== false && window.matchMedia('(pointer:fine)').matches) f.focus();
    }, 60);
    return m;
  };

  /** Tutup semua modal (dipakai saat berpindah halaman). */
  ui.closeAllModals = function () {
    ui.$$('.modal-backdrop').forEach((m) => m.parentNode && m.parentNode.removeChild(m));
    modalDepth = 0;
    document.body.classList.remove('modal-open');
  };

  ui.confirm = function (opt) {
    if (typeof opt === 'string') opt = { message: opt };
    return new Promise((resolve) => {
      ui.modal({
        title: opt.title || 'Konfirmasi',
        size: 'sm',
        body: `<div class="confirm-msg ${opt.danger ? 'danger' : ''}">${ui.icon(opt.danger ? 'warn' : 'info')}<div>${opt.html || u.esc(opt.message)}</div></div>`,
        actions: [
          { label: opt.cancelLabel || 'Batal', cls: 'btn-ghost', onClick: (m) => { m.close(true); resolve(false); } },
          { label: opt.okLabel || 'Ya, lanjutkan', cls: opt.danger ? 'btn-danger' : 'btn-primary', onClick: (m) => { m.close(true); resolve(true); } }
        ],
        onClose: () => resolve(false)
      });
    });
  };

  ui.prompt = function (opt) {
    return new Promise((resolve) => {
      ui.modal({
        title: opt.title || 'Masukkan data',
        size: 'sm',
        body: `<label class="field"><span>${u.esc(opt.label || '')}${opt.required ? ' <b class="req">*</b>' : ''}</span>${opt.multiline ? `<textarea name="v" rows="3">${u.esc(opt.value || '')}</textarea>` : `<input name="v" value="${u.esc(opt.value || '')}">`}</label><div class="form-error" hidden></div>`,
        actions: [
          { label: 'Batal', cls: 'btn-ghost', onClick: (m) => { m.close(true); resolve(null); } },
          {
            label: opt.okLabel || 'Simpan', cls: opt.danger ? 'btn-danger' : 'btn-primary', onClick: (m) => {
              const v = m.el.querySelector('[name=v]').value.trim();
              if (opt.required && v.length < (opt.minLength || 1)) {
                const e = m.el.querySelector('.form-error');
                e.hidden = false;
                e.textContent = opt.requiredMsg || 'Wajib diisi.';
                return;
              }
              m.close(true);
              resolve(v);
            }
          }
        ],
        onClose: () => resolve(null)
      });
    });
  };

  /* ---------- Input rupiah otomatis berformat ---------- */
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches('input[data-money]')) return;
    const raw = el.value;
    const neg = el.hasAttribute('data-allow-neg') && /^\s*-/.test(raw);
    const digits = raw.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
    const pos = el.selectionStart;
    const digitsBefore = raw.slice(0, pos).replace(/[^0-9]/g, '').length;
    const out = (neg ? '-' : '') + (digits ? u.groupDigits(parseInt(digits, 10)) : '');
    el.value = out;
    let i = 0;
    let seen = 0;
    while (i < out.length && seen < digitsBefore) {
      if (/\d/.test(out[i])) seen++;
      i++;
    }
    try {
      el.setSelectionRange(i, i);
    } catch (_) {}
  });
  /* Cegah form tanpa handler memuat ulang halaman (mis. menekan Enter di dalam modal). */
  document.addEventListener('submit', (e) => {
    if (!e.defaultPrevented) e.preventDefault();
  });
  ui.moneyVal = (v) => (v || v === 0 ? (v < 0 ? '-' : '') + u.groupDigits(v) : '');

  /** Ambil data form: data-money -> integer, type=number -> number, checkbox -> boolean. */
  ui.formData = function (form) {
    const out = {};
    for (const el of form.querySelectorAll('[name]')) {
      if (el.disabled && !el.hasAttribute('data-include')) continue;
      const n = el.name;
      if (el.type === 'checkbox') {
        if (el.hasAttribute('data-multi')) {
          out[n] = out[n] || [];
          if (el.checked) out[n].push(el.value);
        } else out[n] = el.checked;
      } else if (el.type === 'radio') {
        if (el.checked) out[n] = el.value;
      } else if (el.hasAttribute('data-money')) out[n] = u.toInt(el.value);
      else if (el.type === 'number') out[n] = el.value === '' ? '' : u.toNum(el.value);
      else out[n] = typeof el.value === 'string' ? el.value.trim() : el.value;
    }
    return out;
  };

  ui.options = function (list, selected, placeholder) {
    let h = placeholder !== undefined ? `<option value="">${u.esc(placeholder)}</option>` : '';
    for (const it of list) {
      const [v, l] = Array.isArray(it) ? it : [it, it];
      h += `<option value="${u.esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${u.esc(l)}</option>`;
    }
    return h;
  };

  ui.empty = (text, icon) => `<div class="empty">${ui.icon(icon || 'info')}<p>${text}</p></div>`;

  ui.badge = function (text, kind) {
    return `<span class="badge badge-${kind || 'gray'}">${u.esc(text)}</span>`;
  };

  ui.statusBadge = function (st) {
    const map = {
      aktif: ['Aktif', 'green'], nonaktif: ['Tidak Aktif', 'gray'], cuti: ['Cuti', 'amber'], resign: ['Mengundurkan Diri', 'red'],
      active: ['Aktif', 'green'], cancelled: ['Dibatalkan', 'red'],
      draft: ['Draft', 'amber'], approved: ['Disetujui', 'blue'], locked: ['Terkunci', 'dark'],
      open: ['Belum diproses', 'gray'], partial: ['Sebagian diproses', 'amber'], none: ['Tanpa jasa', 'light'], inrun: ['Dalam proses gaji', 'blue'], paid: ['Terkunci (dibayar)', 'dark'], stale: ['Perlu hitung ulang', 'red']
    };
    const [l, k] = map[st] || [st, 'gray'];
    return ui.badge(l, k);
  };

  ui.unitBadge = function (unit) {
    if (unit === 'APT') return ui.badge('Apotek', 'green');
    if (unit === 'KLINIK') return ui.badge('Praktek Dokter', 'blue');
    if (unit === 'LINTAS') return ui.badge('Lintas Unit', 'purple');
    return ui.badge(unit || '-', 'gray');
  };

  /* ---------- Tabel dengan urutkan & halaman ---------- */
  ui.table = function (container, opt) {
    const state = { page: 1, sortKey: opt.sortKey || null, sortDir: opt.sortDir || 'asc', rows: opt.rows || [] };
    const pageSize = opt.pageSize || 25;
    function sorted() {
      if (!state.sortKey) return state.rows;
      const col = opt.columns.find((c) => c.key === state.sortKey);
      const val = col && col.value ? col.value : (r) => r[state.sortKey];
      const dir = state.sortDir === 'asc' ? 1 : -1;
      return state.rows.slice().sort((a, b) => {
        const x = val(a);
        const y = val(b);
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return String(x === undefined || x === null ? '' : x).localeCompare(String(y === undefined || y === null ? '' : y), 'id', { numeric: true }) * dir;
      });
    }
    function render() {
      const rows = sorted();
      const pages = Math.max(1, Math.ceil(rows.length / pageSize));
      if (state.page > pages) state.page = pages;
      const slice = opt.noPaging ? rows : rows.slice((state.page - 1) * pageSize, state.page * pageSize);
      const th = opt.columns
        .map((c) => {
          const s = c.sortable !== false && opt.sortable !== false;
          const ind = state.sortKey === c.key ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
          return `<th class="${c.align ? 'ta-' + c.align : ''} ${s ? 'sortable' : ''} ${c.cls || ''}" ${s ? `data-sort="${c.key}"` : ''} ${c.width ? `style="width:${c.width}"` : ''}>${c.label}${ind}</th>`;
        })
        .join('');
      const tb = slice.length
        ? slice
            .map((r, i) => `<tr class="${opt.rowClass ? opt.rowClass(r) : ''}" ${opt.rowAttr ? opt.rowAttr(r) : ''}>${opt.columns.map((c) => `<td class="${c.align ? 'ta-' + c.align : ''} ${c.cls || ''}" data-label="${u.esc(c.label.replace(/<[^>]+>/g, ''))}">${c.render ? c.render(r, i) : u.esc(r[c.key])}</td>`).join('')}</tr>`)
            .join('')
        : `<tr><td colspan="${opt.columns.length}" class="empty-cell">${opt.empty || 'Tidak ada data.'}</td></tr>`;
      const foot = opt.footer ? `<tfoot>${opt.footer(rows)}</tfoot>` : '';
      const pager =
        !opt.noPaging && rows.length > pageSize
          ? `<div class="pager"><span>${(state.page - 1) * pageSize + 1}–${Math.min(rows.length, state.page * pageSize)} dari ${u.num(rows.length)}</span>
            <div><button class="btn btn-sm btn-ghost" data-pg="prev" ${state.page <= 1 ? 'disabled' : ''}>‹ Sebelumnya</button>
            <span class="pg-num">${state.page}/${pages}</span>
            <button class="btn btn-sm btn-ghost" data-pg="next" ${state.page >= pages ? 'disabled' : ''}>Berikutnya ›</button></div></div>`
          : rows.length ? `<div class="pager"><span>${u.num(rows.length)} data</span></div>` : '';
      container.innerHTML = `<div class="table-wrap ${opt.cards ? 'table-cards' : ''}"><table class="tbl ${opt.cls || ''}"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody>${foot}</table></div>${pager}`;
    }
    container.addEventListener('click', (e) => {
      const s = e.target.closest('[data-sort]');
      if (s && container.contains(s)) {
        const k = s.getAttribute('data-sort');
        if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else {
          state.sortKey = k;
          state.sortDir = 'asc';
        }
        render();
        return;
      }
      const p = e.target.closest('[data-pg]');
      if (p && container.contains(p)) {
        state.page += p.getAttribute('data-pg') === 'next' ? 1 : -1;
        render();
        container.scrollIntoView({ block: 'nearest' });
      }
    });
    render();
    return {
      update(rows) {
        state.rows = rows;
        state.page = 1;
        render();
      },
      rows: () => sorted()
    };
  };

  /* ---------- Tab ---------- */
  ui.tabs = function (container, tabs, active, onChange) {
    container.innerHTML = `<div class="tabs" role="tablist">${tabs.map((t) => `<button type="button" role="tab" class="tab ${t.key === active ? 'active' : ''}" data-tab="${t.key}">${t.icon ? ui.icon(t.icon) : ''}<span>${u.esc(t.label)}</span></button>`).join('')}</div>`;
    container.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      container.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
      onChange(b.getAttribute('data-tab'));
    });
  };

  /* ---------- Grafik ---------- */
  /* Palet kategorikal tervalidasi (cek CVD & kontras) — terang & gelap, urutan tetap. */
  const PAL_LIGHT = ['#006b2a', '#2563eb', '#d97706', '#7c3aed', '#db2777', '#0891b2'];
  const PAL_DARK = ['#2e9e57', '#3b82f6', '#c98500', '#8b5cf6', '#ec4899', '#0a9fba'];
  ui.isDark = () => document.documentElement.getAttribute('data-theme') === 'dark' || (document.documentElement.getAttribute('data-theme') !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  ui.palette = () => (ui.isDark() ? PAL_DARK : PAL_LIGHT);
  /** Warna mengikuti entitas (bukan urutan): kategori bagian pendapatan. */
  const CAT_SLOT = { apotek: 0, dokter: 1, eksternal: 2, perawat: 3, bidan: 4, klinik: 5, farmasi: 2, petugas: 2, gross: 0, net: 0, ded: 2, staff: 1, business: 0 };
  ui.catColor = (cat) => ui.palette()[CAT_SLOT[cat] !== undefined ? CAT_SLOT[cat] : 2];
  ui.chart = function (canvas, config) {
    if (!root.Chart) {
      canvas.parentElement.innerHTML = '<p class="muted">Pustaka grafik tidak tersedia.</p>';
      return null;
    }
    const dark = ui.isDark();
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = dark ? '#cbd5e1' : '#475569';
    Chart.defaults.borderColor = dark ? 'rgba(148,163,184,.15)' : 'rgba(15,23,42,.08)';
    config.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: { duration: 500 } }, config.options || {});
    const c = new Chart(canvas, config);
    ui._charts.push(c);
    return c;
  };
  ui.destroyCharts = function () {
    ui._charts.forEach((c) => {
      try {
        c.destroy();
      } catch (_) {}
    });
    ui._charts = [];
  };
  ui.rpTick = (v) => {
    const a = Math.abs(v);
    if (a >= 1e9) return 'Rp' + u.num(v / 1e9, 1) + ' M';
    if (a >= 1e6) return 'Rp' + u.num(v / 1e6, 1) + ' jt';
    if (a >= 1e3) return 'Rp' + u.num(v / 1e3, 0) + ' rb';
    return 'Rp' + v;
  };

  /* ---------- Kartu statistik ---------- */
  ui.stat = function (label, value, opt) {
    opt = opt || {};
    return `<div class="stat ${opt.cls || ''}" ${opt.title ? `title="${u.esc(opt.title)}"` : ''}>
      ${opt.icon ? `<div class="stat-ic">${ui.icon(opt.icon)}</div>` : ''}
      <div class="stat-body"><div class="stat-label">${u.esc(label)}</div><div class="stat-value">${value}</div>${opt.sub ? `<div class="stat-sub">${opt.sub}</div>` : ''}</div></div>`;
  };

  /** Baca file sebagai DataURL / ArrayBuffer / teks. */
  ui.readFile = function (file, as) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      if (as === 'dataurl') r.readAsDataURL(file);
      else if (as === 'text') r.readAsText(file);
      else r.readAsArrayBuffer(file);
    });
  };

  ui.pickFile = function (accept) {
    return new Promise((resolve) => {
      const i = document.createElement('input');
      i.type = 'file';
      i.accept = accept || '';
      i.onchange = () => resolve(i.files[0] || null);
      i.click();
    });
  };

  /** Perkecil gambar (logo/foto) agar database tetap ringan. */
  ui.resizeImage = function (dataUrl, max) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, (max || 400) / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s);
        c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL(/png/.test(dataUrl.slice(0, 30)) ? 'image/png' : 'image/jpeg', 0.85));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  };

  ui.busy = async function (msg, fn) {
    const el = ui.html(`<div class="busy-overlay"><div class="busy-box"><div class="spinner"></div><span>${u.esc(msg || 'Memproses...')}</span></div></div>`);
    document.body.appendChild(el);
    await new Promise((r) => setTimeout(r, 30));
    try {
      return await fn((m) => (el.querySelector('span').textContent = m));
    } finally {
      el.remove();
    }
  };

  NP.ui = ui;
})(typeof globalThis !== 'undefined' ? globalThis : window);
