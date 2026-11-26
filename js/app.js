/* Noura Payroll — inti aplikasi: inisialisasi, tata letak, navigasi (router), sesi pengguna. */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;

  NP.state = { settings: null, components: null };
  NP.pages = NP.pages || {};

  const NAV = [
    { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', perm: 'dashboard.view' },
    { key: 'employees', label: 'Data Karyawan', icon: 'users', perm: 'employees.view' },
    { key: 'schedule', label: 'Jadwal Masuk', icon: 'clock', perm: 'schedule.view' },
    { key: 'services', label: 'Master Tindakan', icon: 'medical', perm: 'services.view' },
    { key: 'input', label: 'Input Tindakan', icon: 'input', perm: 'trx.create' },
    { key: 'bulk', label: 'Input Bulanan', icon: 'calendar', perm: 'trx.create' },
    { key: 'transactions', label: 'Riwayat Transaksi', icon: 'history', perm: 'trx.view' },
    { key: 'analysis', label: 'Analisis Tindakan', icon: 'report', perm: 'analysis.view' },
    { key: 'revenue', label: 'Pembagian Pendapatan', icon: 'pie', perm: 'revenue.view' },
    { key: 'income', label: 'Rekap Jasa Karyawan', icon: 'recap', perm: 'income.view' },
    { key: 'payroll', label: 'Penggajian', icon: 'wallet', perm: 'payroll.run' },
    { key: 'generate', label: 'Generate Payroll', icon: 'play', perm: 'payroll.run' },
    { key: 'payslips', label: 'Slip Gaji', icon: 'slip', perm: 'payslip.view' },
    { key: 'reports', label: 'Laporan Keuangan', icon: 'report', perm: 'reports.view' },
    { key: 'payroll-history', label: 'Riwayat Penggajian', icon: 'archive', perm: 'history.view' },
    { key: 'settings', label: 'Pengaturan', icon: 'settings', perm: 'settings.view' }
  ];
  NP.NAV = NAV;

  /* ---------- Pengaturan ---------- */
  function deepMerge(base, over) {
    if (Array.isArray(base)) return over !== undefined ? over : base;
    if (base && typeof base === 'object') {
      const out = Object.assign({}, base);
      for (const k of Object.keys(over || {})) {
        out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && over[k] && typeof over[k] === 'object' ? deepMerge(base[k], over[k]) : over[k];
      }
      return out;
    }
    return over !== undefined ? over : base;
  }
  NP.deepMerge = deepMerge;

  NP.loadSettings = async function () {
    const s = await NP.db.get('settings', 'app');
    NP.state.settings = deepMerge(u.clone(NP.defaults.DEFAULT_SETTINGS), s || {});
    return NP.state.settings;
  };
  NP.saveSettings = async function (patch, auditDetail) {
    NP.state.settings = deepMerge(NP.state.settings, patch || {});
    await NP.db.put('settings', NP.state.settings);
    if (auditDetail) await NP.audit.log('settings.update', 'settings', 'app', auditDetail);
    applyBranding();
    return NP.state.settings;
  };
  NP.loadComponents = async function () {
    NP.state.components = (await NP.db.all('components')).sort((a, b) => (a.order || 99) - (b.order || 99));
    return NP.state.components;
  };

  NP.unitInfo = function (code) {
    const s = NP.state.settings;
    const x = (s.units && s.units[code]) || {};
    return Object.assign({ code, name: NP.C.UNITS[code] ? NP.C.UNITS[code].name : code }, x, { logo: x.logo || s.company.logo || 'assets/logo.png' });
  };

  /* ---------- Router ----------
   * Lokal: rute di hash URL (#/halaman?param). Versi online (artifact) hanya boleh memakai
   * hash sederhana, sehingga rute disimpan di memori dan tautan "#/..." ditangkap. */
  const memoryRouter = !!(NP.ENV && NP.ENV.artifact);
  let memRoute = '#/dashboard';
  function currentHash() {
    return memoryRouter ? memRoute : location.hash;
  }
  function parseHash() {
    const h = currentHash().replace(/^#\/?/, '');
    const [path, qs] = h.split('?');
    const params = {};
    new URLSearchParams(qs || '').forEach((v, k) => (params[k] = v));
    return { page: path || 'dashboard', params };
  }

  NP.go = function (page, params) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const target = '#/' + page + qs;
    if (memoryRouter) {
      memRoute = target;
      route();
      return;
    }
    if (location.hash === target) route();
    else location.hash = target;
  };
  if (memoryRouter && typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href^="#/"]');
      if (!a) return;
      e.preventDefault();
      memRoute = a.getAttribute('href');
      route();
    });
  }

  let routeSeq = 0;
  async function route() {
    const seq = ++routeSeq;
    const { page, params } = parseHash();
    const nav = NAV.find((n) => n.key === page);
    const def = NP.pages[page];
    const view = ui.$('#view');
    if (!view) return;
    ui.destroyCharts();
    ui.closeAllModals();
    document.body.classList.remove('nav-open');
    ui.$$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
    // Setiap navigasi memakai kontainer baru: listener halaman lama ikut terbuang dan
    // render lama yang masih berjalan tidak menimpa halaman baru.
    const host = document.createElement('div');
    host.className = 'page-host';
    view.textContent = '';
    view.appendChild(host);
    view.className = 'view page-' + page;
    if (!def) {
      host.innerHTML = ui.empty('Halaman tidak ditemukan.', 'warn');
      return;
    }
    ui.$('#page-title').textContent = (nav && nav.label) || def.title || '';
    if (nav && !NP.sec.can(nav.perm)) {
      host.innerHTML = `<div class="card">${ui.empty('Anda tidak memiliki hak akses ke halaman ini.', 'lock')}</div>`;
      return;
    }
    document.title = ((nav && nav.label) || def.title) + ' · Noura Payroll';
    host.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      await def.render(host, params);
    } catch (e) {
      console.error(e);
      if (seq === routeSeq) host.innerHTML = `<div class="card">${ui.empty('Terjadi kesalahan saat memuat halaman: ' + u.esc(e.message), 'warn')}</div>`;
    }
    if (seq === routeSeq) window.scrollTo(0, 0);
  }
  NP.refresh = route;

  /* ---------- Tata letak ---------- */
  function applyBranding() {
    const s = NP.state.settings;
    if (!s) return;
    const logo = s.company.logo || 'assets/logo.png';
    ui.$$('.brand-logo').forEach((i) => (i.src = logo));
    const n = ui.$('.brand-company');
    if (n) n.textContent = s.company.name;
  }

  function renderShell() {
    const usr = NP.sec.user();
    const app = ui.$('#app');
    app.innerHTML = `
      <aside class="sidebar" aria-label="Navigasi utama">
        <div class="brand">
          <img class="brand-logo" src="assets/logo.png" alt="">
          <div><div class="brand-name">NOURA PAYROLL</div><div class="brand-company">-</div></div>
          <button class="icon-btn nav-close" aria-label="Tutup menu">${ui.icon('close')}</button>
        </div>
        <nav class="nav">
          ${NAV.map((n, i) => (NP.sec.can(n.perm) ? `<a class="nav-item" href="#/${n.key}" data-page="${n.key}">${ui.icon(n.icon)}<span>${n.label}</span><small>${i + 1}</small></a>` : '')).join('')}
        </nav>
        <div class="sidebar-foot">
          <div class="storage-note">${ui.icon('lock')}<span>${NP.db.remote ? 'Database pusat Supabase' : 'Penyimpanan lokal perangkat ini'}</span></div>
        </div>
      </aside>
      <div class="nav-scrim"></div>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn nav-toggle" aria-label="Buka menu">${ui.icon('menu')}</button>
          <h1 id="page-title">Dashboard</h1>
          <div class="topbar-right">
            <span class="period-chip" id="period-chip" title="Periode gaji aktif">${ui.icon('calendar')}<span></span></span>
            <button class="icon-btn" id="backup-bell" title="Pengingat backup" hidden>${ui.icon('warn')}</button>
            <button class="icon-btn" id="theme-toggle" title="Tema terang/gelap">${ui.icon('eye')}</button>
            <div class="user-menu">
              <button class="user-btn" id="user-btn"><span class="avatar">${u.esc((usr.name || '?').slice(0, 1).toUpperCase())}</span><span class="user-meta"><b>${u.esc(usr.name)}</b><small>${u.esc(NP.sec.ROLES[usr.role].label)}</small></span></button>
              <div class="user-drop" hidden>
                <button data-act="pw">${ui.icon('lock')}Ubah kata sandi</button>
                <button data-act="lock">${ui.icon('lock')}Kunci layar</button>
                <button data-act="logout">${ui.icon('logout')}Keluar</button>
              </div>
            </div>
          </div>
        </header>
        <div id="banner-area"></div>
        <main id="view" class="view"></main>
      </div>`;
    applyBranding();
    ui.$('#period-chip span').textContent = 'Periode: ' + u.periodLabel(u.todayISO().slice(0, 7));
    ui.$('.nav-toggle').onclick = () => document.body.classList.add('nav-open');
    ui.$('.nav-close').onclick = () => document.body.classList.remove('nav-open');
    ui.$('.nav-scrim').onclick = () => document.body.classList.remove('nav-open');
    const drop = ui.$('.user-drop');
    ui.$('#user-btn').onclick = (e) => {
      e.stopPropagation();
      drop.hidden = !drop.hidden;
    };
    document.addEventListener('click', () => (drop.hidden = true));
    drop.onclick = async (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'logout') NP.sec.logout();
      if (a.dataset.act === 'lock') NP.sec.showLogin({ locked: true });
      if (a.dataset.act === 'pw') changePasswordDialog();
    };
    ui.$('#theme-toggle').onclick = () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', cur);
      try {
        localStorage.setItem('noura.theme', cur);
      } catch (_) {}
      route();
    };
    ui.$('#backup-bell').onclick = () => NP.go('settings', { tab: 'backup' });
  }

  function changePasswordDialog(force) {
    const usr = NP.sec.user();
    ui.modal({
      title: force ? 'Ganti Kata Sandi Bawaan' : 'Ubah Kata Sandi',
      size: 'sm',
      static: !!force,
      body: `${force ? '<div class="alert alert-warning">Akun ini masih memakai kata sandi bawaan. Demi keamanan, segera ganti kata sandi.</div>' : ''}
        <label class="field"><span>Kata sandi saat ini</span><input type="password" name="old" autocomplete="current-password"></label>
        <label class="field"><span>Kata sandi baru (min. 6 karakter)</span><input type="password" name="n1" autocomplete="new-password"></label>
        <label class="field"><span>Ulangi kata sandi baru</span><input type="password" name="n2" autocomplete="new-password"></label>
        <div class="form-error" hidden></div>`,
      actions: [
        { label: force ? 'Nanti saja' : 'Batal', cls: 'btn-ghost', onClick: (m) => m.close() },
        {
          label: 'Simpan', cls: 'btn-primary', onClick: async (m) => {
            const q = (n) => m.el.querySelector(`[name=${n}]`).value;
            const err = m.el.querySelector('.form-error');
            const ok = await NP.sec.verify(NP.db.remote ? usr.email : usr.username, q('old'));
            if (!ok) {
              err.hidden = false;
              err.textContent = 'Kata sandi saat ini salah.';
              return;
            }
            if (q('n1') !== q('n2')) {
              err.hidden = false;
              err.textContent = 'Konfirmasi kata sandi tidak sama.';
              return;
            }
            try {
              await NP.sec.changePassword(usr.id, q('n1'));
            } catch (e) {
              err.hidden = false;
              err.textContent = e.message;
              return;
            }
            m.close();
            ui.toast('Kata sandi berhasil diubah.');
            renderBanners();
          }
        }
      ]
    });
  }
  NP.changePasswordDialog = changePasswordDialog;

  function renderBanners() {
    const area = ui.$('#banner-area');
    if (!area) return;
    const s = NP.state.settings;
    const usr = NP.sec.user();
    const out = [];
    if (NP.db.isMemory) out.push(`<div class="banner banner-warning">${ui.icon('warn')}<span>Browser ini memblokir penyimpanan lokal, jadi data hanya bertahan selama halaman terbuka. Buka di jendela biasa (bukan mode privat) agar data tersimpan.</span></div>`);
    if (usr && usr.mustChange) out.push(`<div class="banner banner-warning">${ui.icon('lock')}<span>Akun <b>${u.esc(usr.username)}</b> masih memakai kata sandi bawaan.</span><button class="btn btn-sm btn-light" data-act="pw">Ganti sekarang</button></div>`);
    const days = u.toNum(s.backup.reminderDays);
    if (NP.sec.can('backup') && days > 0) {
      const last = s.backup.lastBackup;
      const age = last ? (Date.now() - last) / 86400000 : Infinity;
      if (age > days) {
        out.push(`<div class="banner banner-info">${ui.icon('archive')}<span>${last ? 'Backup terakhir ' + Math.floor(age) + ' hari lalu.' : 'Belum pernah melakukan backup.'} Lakukan backup database secara berkala agar data aman.</span><button class="btn btn-sm btn-light" data-act="backup">Backup sekarang</button></div>`);
        ui.$('#backup-bell').hidden = false;
      } else ui.$('#backup-bell').hidden = true;
    }
    area.innerHTML = out.join('');
    area.onclick = (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'pw') changePasswordDialog();
      if (a.dataset.act === 'backup') NP.backup.download().then(renderBanners);
    };
  }
  NP.renderBanners = renderBanners;

  /* ---------- Bootstrap ---------- */
  async function ensureSeed() {
    await NP.loadSettings();
    const existing = await NP.db.get('settings', 'app');
    if (!existing) await NP.db.put('settings', NP.state.settings);
    const comps = await NP.db.all('components');
    if (!comps.length) await NP.db.putMany('components', u.clone(NP.defaults.DEFAULT_COMPONENTS));
    await NP.loadComponents();
    const users = await NP.db.all('users');
    if (!users.length) {
      await NP.db.putMany('users', [
        NP.sec.makeUser('admin', 'Administrator', 'admin', 'admin123', { mustChange: true }),
        NP.sec.makeUser('keuangan', 'Admin Keuangan (Demo)', 'finance', 'keuangan123', { demo: true }),
        NP.sec.makeUser('operasional', 'Admin Operasional (Demo)', 'ops', 'operasional123', { demo: true }),
        NP.sec.makeUser('viewer', 'Viewer (Demo)', 'viewer', 'viewer123', { demo: true })
      ]);
    }
    if (!NP.state.settings.demoLoaded && !NP.state.settings.demoRemoved) {
      const emps = await NP.db.all('employees');
      if (!emps.length) {
        await ui.busy('Menyiapkan data demonstrasi...', () => NP.demo.seed());
      }
    }
  }

  async function boot() {
    try {
      const theme = localStorage.getItem('noura.theme');
      if (theme) document.documentElement.setAttribute('data-theme', theme);
    } catch (_) {}
    if (NP.ENV && NP.ENV.artifact) document.body.classList.add('env-artifact');
    if (NP.remoteConfigured && NP.remoteConfigured() && !(NP.ENV && NP.ENV.artifact)) return bootRemote();
    try {
      await NP.db.open();
    } catch (e) {
      // Penyimpanan browser diblokir (mode privat, pratinjau, dll.): tetap jalan dengan database sementara.
      console.warn('IndexedDB tidak tersedia, memakai database sementara', e);
      NP.useMemoryDb();
    }
    try {
      await ensureSeed();
    } catch (e) {
      console.error(e);
      document.getElementById('app').innerHTML = `<div class="fatal"><h2>Database tidak dapat dibuka</h2><p>${u.esc(e.message)}</p><p>Pastikan browser mengizinkan penyimpanan lokal (IndexedDB) dan tidak dalam mode privat yang membatasinya.</p></div>`;
      return;
    }
    let usr = await NP.sec.restore();
    if (!usr) {
      const users = await NP.db.all('users');
      const defaultAdmin = users.find((x) => x.username === 'admin' && x.mustChange);
      usr = await NP.sec.showLogin({
        hint: defaultAdmin ? 'Akun awal: <b>admin</b> / <b>admin123</b> (segera ganti). Akun demo: keuangan/keuangan123, operasional/operasional123, viewer/viewer123.' : ''
      });
    }
    startApp();
  }

  function fatal(title, html) {
    document.getElementById('app').innerHTML = `<div class="fatal"><h2>${u.esc(title)}</h2>${html}</div>`;
  }

  /** Mode Supabase: database terpusat wajib; tidak ada cadangan penyimpanan lokal. */
  async function bootRemote() {
    try {
      NP.db = NP.createSupabaseDriver();
    } catch (e) {
      return fatal('Supabase tidak dapat dimuat', `<p>${u.esc(e.message)}</p><p>Aplikasi dikonfigurasi memakai Supabase sehingga tidak berjalan tanpa koneksi ke database pusat.</p>`);
    }
    let usr = null;
    try {
      usr = await NP.sec.restore();
    } catch (e) {
      console.warn(e);
    }
    if (!usr) usr = await NP.sec.showLogin({});
    try {
      await NP.loadSettings();
      const s = await NP.db.get('settings', 'app');
      if (!s || !s.numbering) throw new Error('Pengaturan awal belum ada. Jalankan supabase/seed.sql pada proyek Supabase.');
      await NP.loadComponents();
    } catch (e) {
      console.error(e);
      return fatal('Database Supabase belum siap', `<p>${u.esc(e.message)}</p><p>Pastikan seluruh file di <code>supabase/migrations</code> dan <code>supabase/seed.sql</code> sudah dijalankan.</p>`);
    }
    startApp();
    NP.db.subscribe(() => {
      const busy = document.querySelector('.modal-backdrop, .busy-overlay, .page-input, .page-bulk, .page-generate, .sch-dirty');
      if (!busy) NP.refresh();
      else ui.toast('Data diperbarui dari perangkat lain. Muat ulang halaman untuk melihat perubahan terbaru.', 'info');
    });
  }

  function startApp() {
    renderShell();
    renderBanners();
    NP.sec.startAutoLock();
    if (memoryRouter) route();
    else {
      window.addEventListener('hashchange', route);
      if (!location.hash) location.hash = '#/dashboard';
      else route();
    }
    if (!memoryRouter && 'serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
      navigator.serviceWorker.register('service-worker.js').catch((e) => console.warn('SW gagal', e));
    }
  }

  NP.boot = boot;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
