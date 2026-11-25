/* Noura Payroll — keamanan: hash kata sandi, sesi login, hak akses (role), kunci otomatis,
 * otorisasi administrator untuk tindakan sensitif, dan perlindungan data rekening. */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;

  /* ---------- SHA-256 (implementasi murni JS agar juga berfungsi di file://) ---------- */
  function sha256(ascii) {
    function rr(v, a) {
      return (v >>> a) | (v << (32 - a));
    }
    const bytes = unescape(encodeURIComponent(ascii));
    const K = [];
    const H = [];
    let isComposite = {};
    for (let c = 2, n = 0; n < 64; c++) {
      if (!isComposite[c]) {
        for (let i = 0; i < 313; i += c) isComposite[i] = c;
        if (n < 8) H[n] = (Math.pow(c, 0.5) * 4294967296) | 0;
        K[n++] = (Math.pow(c, 1 / 3) * 4294967296) | 0;
      }
    }
    isComposite = null;
    const words = [];
    const bitLen = bytes.length * 8;
    let s = bytes + '\x80';
    while ((s.length % 64) - 56) s += '\x00';
    for (let i = 0; i < s.length; i++) words[i >> 2] |= s.charCodeAt(i) << (((3 - i) % 4) * 8);
    words[words.length] = (bitLen / 4294967296) | 0;
    words[words.length] = bitLen;
    let hash = H.slice(0);
    for (let j = 0; j < words.length; ) {
      const w = words.slice(j, (j += 16));
      const old = hash;
      hash = hash.slice(0, 8);
      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15];
        const w2 = w[i - 2];
        const a = hash[0];
        const e = hash[4];
        const t1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + K[i] +
          (w[i] = i < 16 ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        const t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(t1 + t2) | 0].concat(hash);
        hash[4] = (hash[4] + t1) | 0;
        hash.length = 8;
      }
      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + old[i]) | 0;
    }
    let out = '';
    for (let i = 0; i < 8; i++) for (let j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255;
      out += (b < 16 ? '0' : '') + b.toString(16);
    }
    return out;
  }

  function hashPassword(password, salt) {
    let h = salt + ':' + password;
    for (let i = 0; i < 500; i++) h = sha256(h + salt);
    return h;
  }

  function makeUser(username, name, role, password, extra) {
    const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return Object.assign({ id: 'USR-' + username, username, name, role, salt, hash: hashPassword(password, salt), active: true, createdAt: Date.now() }, extra || {});
  }

  /* ---------- Hak akses ---------- */
  const ROLES = {
    admin: { label: 'Administrator', desc: 'Akses seluruh fitur.' },
    finance: { label: 'Admin Keuangan', desc: 'Mengelola transaksi, penggajian, dan laporan keuangan.' },
    ops: { label: 'Admin Operasional', desc: 'Menginput transaksi dan melihat riwayat transaksi.' },
    viewer: { label: 'Viewer', desc: 'Hanya melihat dashboard dan laporan yang diizinkan.' }
  };
  const A = ['admin'];
  const AF = ['admin', 'finance'];
  const AFO = ['admin', 'finance', 'ops'];
  const AFV = ['admin', 'finance', 'viewer'];
  const ALL = ['admin', 'finance', 'ops', 'viewer'];
  const PERMS = {
    'dashboard.view': ALL,
    'dashboard.payroll': AFV,
    'employees.view': AF,
    'employees.edit': AF,
    'services.view': AFO,
    'services.edit': A,
    'trx.create': AFO,
    'trx.view': AFO,
    'trx.editAny': AF,
    'trx.editOwn': AFO,
    'trx.cancel': AF,
    'trx.delete': A,
    'revenue.view': AFV,
    'analysis.view': ALL,
    'income.view': AF,
    'worklog.edit': AF,
    'payroll.config': A,
    'payroll.run': AF,
    'payroll.approve': AF,
    'payroll.lock': A,
    'payslip.view': AF,
    'reports.view': AFV,
    'history.view': AF,
    'export': AFV,
    'bank.view': AF,
    'settings.view': A,
    'users.manage': A,
    'backup': A,
    'audit.view': A
  };

  const SESSION_KEY = 'noura.session';
  let current = null;
  let lastActivity = Date.now();
  let lockTimer = null;

  function can(perm) {
    if (!current) return false;
    if (current.role === 'admin') return true;
    return (PERMS[perm] || []).includes(current.role);
  }

  function user() {
    return current;
  }

  async function users() {
    return (await NP.db.all('users')).sort((a, b) => a.username.localeCompare(b.username));
  }

  let lastLoginError = '';
  const isRemote = () => !!(NP.db && NP.db.remote);
  const profileToCurrent = (p) => ({ id: p.id, username: p.username, name: p.name, email: p.email, role: p.role, mustChange: !!p.mustChange });

  async function login(username, password) {
    lastLoginError = '';
    if (isRemote()) {
      const r = await NP.db.signIn(username, password);
      if (r.error) {
        lastLoginError = r.error;
        return null;
      }
      current = profileToCurrent(r.user);
      lastActivity = Date.now();
      await NP.audit.log('login', 'user', current.id, 'Login berhasil');
      return current;
    }
    const list = await NP.db.all('users');
    const usr = list.find((x) => x.username.toLowerCase() === String(username || '').trim().toLowerCase() && x.active !== false);
    if (!usr || usr.hash !== hashPassword(password || '', usr.salt)) {
      await NP.audit.log('login.failed', 'user', String(username || ''), 'Percobaan login gagal');
      return null;
    }
    current = { id: usr.id, username: usr.username, name: usr.name, role: usr.role, mustChange: !!usr.mustChange };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: usr.id, ts: Date.now() }));
    } catch (_) {}
    lastActivity = Date.now();
    await NP.audit.log('login', 'user', usr.id, 'Login berhasil');
    return current;
  }

  async function restore() {
    if (isRemote()) {
      const p = await NP.db.session();
      current = p ? profileToCurrent(p) : null;
      return current;
    }
    let s = null;
    try {
      s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    } catch (_) {}
    if (!s) return null;
    const usr = await NP.db.get('users', s.id);
    if (!usr || usr.active === false) return null;
    current = { id: usr.id, username: usr.username, name: usr.name, role: usr.role, mustChange: !!usr.mustChange };
    return current;
  }

  async function logout() {
    if (current) await NP.audit.log('logout', 'user', current.id, 'Logout');
    current = null;
    if (isRemote()) await NP.db.signOut();
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch (_) {}
    if (!(NP.ENV && NP.ENV.artifact)) location.hash = '#/dashboard';
    location.reload();
  }

  async function verify(username, password, requireRole) {
    if (isRemote()) {
      const v = await NP.db.verifyCredentials(username, password);
      if (!v || (requireRole && !requireRole.includes(v.role))) return null;
      return v;
    }
    const list = await NP.db.all('users');
    const usr = list.find((x) => x.username.toLowerCase() === String(username || '').trim().toLowerCase() && x.active !== false);
    if (!usr || usr.hash !== hashPassword(password || '', usr.salt)) return null;
    if (requireRole && !requireRole.includes(usr.role)) return null;
    return usr;
  }

  async function changePassword(userId, newPassword) {
    if (!newPassword || newPassword.length < 6) throw new Error('Kata sandi minimal 6 karakter.');
    if (isRemote()) {
      if (current && current.id === userId) {
        await NP.db.changePassword(newPassword);
        current.mustChange = false;
      } else await NP.db.adminUsers({ action: 'reset_password', id: userId, password: newPassword });
      return;
    }
    const usr = await NP.db.get('users', userId);
    usr.salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
    usr.hash = hashPassword(newPassword, usr.salt);
    usr.mustChange = false;
    await NP.db.put('users', usr);
    if (current && current.id === userId) current.mustChange = false;
    await NP.audit.log('user.password', 'user', userId, 'Kata sandi diubah');
  }

  /* ---------- Layar login & kunci ---------- */
  function showLogin(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const s = NP.state && NP.state.settings;
      const el = document.createElement('div');
      el.className = 'auth-screen';
      el.innerHTML = `
        <form class="auth-card" autocomplete="on">
          ${s && s.company.logo
            ? `<div class="auth-brand"><img src="${s.company.logo}" alt="" class="auth-logo"><div><div class="auth-title">NOURA PAYROLL</div><div class="auth-sub">Management System</div></div></div>`
            : `<div class="auth-brand auth-brand-full"><img src="assets/logo-full.png" alt="Apotek Noura" class="auth-wordmark"><div class="auth-sub">PAYROLL MANAGEMENT SYSTEM</div></div>`}
          <h2>${opts.locked ? 'Sesi Terkunci' : 'Masuk ke Aplikasi'}</h2>
          <p class="muted">${opts.locked ? 'Aplikasi dikunci otomatis karena tidak ada aktivitas. Masukkan kata sandi untuk melanjutkan.' : 'Gunakan akun yang diberikan administrator.'}</p>
          <label class="field"><span>${isRemote() ? 'Email' : 'Nama pengguna'}</span><input name="username" ${isRemote() ? 'type="email" autocomplete="email"' : 'autocomplete="username"'} required value="${opts.locked && current ? u.esc(isRemote() ? current.email || '' : current.username) : ''}" ${opts.locked ? 'readonly' : ''}></label>
          <label class="field"><span>Kata sandi</span><input name="password" type="password" autocomplete="current-password" required></label>
          <div class="auth-error" hidden></div>
          <button class="btn btn-primary btn-block" type="submit">${opts.locked ? 'Buka Kunci' : 'Masuk'}</button>
          ${opts.locked ? '<button type="button" class="btn btn-ghost btn-block" data-act="switch">Masuk dengan akun lain</button>' : ''}
          ${opts.hint ? `<div class="auth-hint">${opts.hint}</div>` : ''}
          <div class="auth-foot">${isRemote() ? 'Terhubung ke database pusat (Supabase). Semua perangkat memakai data yang sama.' : 'Data tersimpan lokal di perangkat ini (IndexedDB).'}</div>
        </form>`;
      document.body.appendChild(el);
      const form = el.querySelector('form');
      const err = el.querySelector('.auth-error');
      // Fokus awal langsung (tanpa timer) dan tidak pernah merebut fokus dari kolom yang sedang diisi:
      // timer fokus dapat memindahkan ketikan kata sandi ke kolom email sehingga sandi terlihat.
      const first = form.querySelector(opts.locked ? '[name=password]' : '[name=username]');
      if (!form.contains(document.activeElement)) first.focus();
      const sw = el.querySelector('[data-act=switch]');
      if (sw) sw.onclick = () => logout();
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const fd = new FormData(form);
        const r = await login(fd.get('username'), fd.get('password'));
        if (!r) {
          err.hidden = false;
          err.textContent = lastLoginError || 'Nama pengguna atau kata sandi salah.';
          form.password.value = '';
          form.password.focus();
          return;
        }
        el.remove();
        resolve(r);
      };
    });
  }

  function startAutoLock() {
    const touch = () => (lastActivity = Date.now());
    ['click', 'keydown', 'touchstart', 'mousemove', 'scroll'].forEach((ev) => document.addEventListener(ev, touch, { passive: true }));
    clearInterval(lockTimer);
    lockTimer = setInterval(async () => {
      const mins = u.toNum(NP.state.settings.security && NP.state.settings.security.autoLockMinutes);
      if (!mins || !current || document.querySelector('.auth-screen')) return;
      if (Date.now() - lastActivity > mins * 60000) {
        await NP.audit.log('autolock', 'user', current.id, 'Sesi dikunci otomatis');
        await showLogin({ locked: true });
      }
    }, 15000);
  }

  /** Minta otorisasi administrator + catatan perubahan (untuk koreksi data terkunci, buka kunci payroll, dll). */
  function authorize(reason, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const m = NP.ui.modal({
        title: 'Otorisasi Administrator',
        size: 'sm',
        body: `<p class="muted">${u.esc(reason)}</p>
          <label class="field"><span>${isRemote() ? 'Email administrator' : 'Nama pengguna administrator'}</span><input name="au" autocomplete="off" value="${current && current.role === 'admin' ? u.esc(isRemote() ? current.email || '' : current.username) : ''}"></label>
          <label class="field"><span>Kata sandi</span><input name="ap" type="password" autocomplete="off"></label>
          ${opts.noNote ? '' : '<label class="field"><span>Catatan / alasan perubahan <b class="req">*</b></span><textarea name="an" rows="3" placeholder="Wajib diisi untuk audit"></textarea></label>'}
          <div class="form-error" hidden></div>`,
        actions: [
          { label: 'Batal', cls: 'btn-ghost', onClick: (mm) => { mm.close(true); resolve(null); } },
          {
            label: 'Otorisasi', cls: 'btn-primary', onClick: async (mm) => {
              const q = (n) => mm.el.querySelector(`[name=${n}]`);
              const e = mm.el.querySelector('.form-error');
              const note = opts.noNote ? '' : q('an').value.trim();
              if (!opts.noNote && note.length < 5) {
                e.hidden = false;
                e.textContent = 'Catatan perubahan wajib diisi (min. 5 karakter).';
                return;
              }
              const usr = await verify(q('au').value, q('ap').value, ['admin']);
              if (!usr) {
                e.hidden = false;
                e.textContent = 'Otorisasi gagal: akun bukan administrator atau kata sandi salah.';
                await NP.audit.log('authorize.failed', 'user', q('au').value, reason);
                return;
              }
              mm.close(true);
              resolve({ by: usr.username, byName: usr.name, note, token: usr.token || null });
            }
          }
        ],
        onClose: () => resolve(null)
      });
    });
  }

  function bankView(acc) {
    return can('bank.view') ? acc || '-' : u.maskAccount(acc);
  }

  NP.sec = { sha256, hashPassword, makeUser, ROLES, PERMS, can, user, users, login, restore, logout, verify, changePassword, showLogin, startAutoLock, authorize, bankView };

  /* ---------- Audit log ---------- */
  NP.audit = {
    entry(action, entity, entityId, detail, extra) {
      return Object.assign({
        id: 'LOG-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        ts: Date.now(),
        user: current ? current.username : 'sistem',
        userName: current ? current.name : 'Sistem',
        action, entity, entityId: entityId || '', detail: detail || ''
      }, extra || {});
    },
    async log(action, entity, entityId, detail, extra) {
      if (NP.db && NP.db.remote) return NP.db.log(action, entity, entityId, detail);
      try {
        await NP.db.put('auditLog', this.entry(action, entity, entityId, detail, extra));
      } catch (e) {
        console.warn('Audit log gagal', e);
      }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
