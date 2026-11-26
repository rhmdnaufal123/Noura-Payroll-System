/* Noura Payroll — JADWAL MASUK (pembuat jadwal kerja bulanan).
 *  - Shift dapat diatur (kode, nama, jam). "L" = libur.
 *  - Kebutuhan petugas per shift: pola mingguan (Min–Sab) dan dapat diubah per tanggal
 *    (custom per hari, termasuk menutup hari tertentu).
 *  - Ketentuan tiap karyawan: shift yang boleh, hari libur tetap, maks. hari kerja per minggu,
 *    maks. hari berturut-turut, maks. hari per bulan, tanggal tidak bisa masuk.
 *  - Karyawan yang dimasukkan ke jadwal dipilih sendiri.
 *  - "Buat jadwal acak": mode Merata (yang paling sedikit masuk didahulukan, urutan seri diacak)
 *    atau Acak penuh — keduanya tetap mematuhi ketentuan. Isian manual dapat dipertahankan.
 *  - Disimpan di database (Supabase: tabel work_schedules lewat fungsi save_work_schedule;
 *    lokal: store "schedules"), dengan kunci versi agar tidak saling menimpa.
 */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;

  const OFF = 'L';
  const WEEKDAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const WD3 = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const UNITS = { ALL: 'Semua unit', APT: 'Apotek Noura', KLINIK: 'Praktek Dokter Umum' };
  const PALETTE = ['#2563eb', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#16a34a', '#b45309', '#4f46e5'];
  const DEFAULT_SHIFTS = [
    { code: 'P', name: 'Pagi', start: '07:00', end: '14:00', color: '#2563eb' },
    { code: 'S', name: 'Siang', start: '14:00', end: '21:00', color: '#d97706' }
  ];
  const DEFAULT_RULE = { shifts: null, offDays: [], maxWeek: 6, maxRun: 6, maxMonth: 0, unavailable: [] };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const daysIn = (period) => new Date(+period.slice(0, 4), +period.slice(5, 7), 0).getDate();
  const weekday = (period, d) => new Date(+period.slice(0, 4), +period.slice(5, 7) - 1, d).getDay();
  const idOf = (period, unit) => 'JDW-' + period.replace('-', '') + '-' + (unit || 'ALL');
  const codes = (s) => s.config.shifts.map((x) => x.code);
  const shiftOf = (s, code) => s.config.shifts.find((x) => x.code === code);

  function minutes(t) {
    const m = /^(\d{2}):(\d{2})$/.exec(t || '');
    return m ? +m[1] * 60 + +m[2] : null;
  }
  /** Lama shift dalam jam (shift malam melewati tengah malam dihitung benar). */
  function hours(sh) {
    const a = minutes(sh.start);
    const b = minutes(sh.end);
    if (a === null || b === null) return 0;
    return ((b - a + 1440) % 1440 || 1440) / 60;
  }

  /** "3, 10-12" → [3, 10, 11, 12] (dibatasi 1..max). */
  function parseDays(text, max) {
    const out = new Set();
    for (const part of String(text || '').split(/[,;\s]+/)) {
      const m = /^(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?$/.exec(part.trim());
      if (!m) continue;
      const a = +m[1];
      const b = m[2] ? +m[2] : a;
      for (let d = Math.min(a, b); d <= Math.max(a, b); d++) if (d >= 1 && d <= (max || 31)) out.add(d);
    }
    return [...out].sort((x, y) => x - y);
  }
  /** [3, 10, 11, 12] → "3, 10–12" */
  function fmtDays(list) {
    const a = (list || []).slice().sort((x, y) => x - y);
    const out = [];
    for (let i = 0; i < a.length; i++) {
      let j = i;
      while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
      out.push(j > i + 1 ? a[i] + '–' + a[j] : j === i + 1 ? a[i] + ', ' + a[j] : String(a[i]));
      i = j;
    }
    return out.join(', ');
  }

  /** Jadwal kosong untuk satu bulan & unit. */
  function blank(period, unit) {
    const weekly = {};
    for (let w = 0; w < 7; w++) weekly[w] = { P: 1, S: 1 };
    return {
      id: idOf(period, unit), period, unit: unit || 'ALL', title: '', version: null,
      config: { shifts: clone(DEFAULT_SHIFTS), weekly, days: {}, employees: [], rules: {}, manual: {} },
      assignments: {}
    };
  }

  /** Lengkapi struktur jadwal (data lama / dari server). */
  function normalize(s) {
    const b = blank(s.period, s.unit);
    const out = Object.assign(b, clone(s));
    out.config = Object.assign(b.config, clone(s.config || {}));
    for (const k of ['weekly', 'days', 'rules', 'manual']) if (!out.config[k] || typeof out.config[k] !== 'object') out.config[k] = {};
    if (!Array.isArray(out.config.employees)) out.config.employees = [];
    if (!Array.isArray(out.config.shifts) || !out.config.shifts.length) out.config.shifts = clone(DEFAULT_SHIFTS);
    out.config.shifts.forEach((sh, i) => (sh.color = sh.color || PALETTE[i % PALETTE.length]));
    if (!out.assignments || typeof out.assignments !== 'object') out.assignments = {};
    return out;
  }

  function ruleOf(s, emp) {
    const r = Object.assign({}, DEFAULT_RULE, (s.config.rules || {})[emp] || {});
    r.offDays = (r.offDays || []).map(Number);
    r.unavailable = (r.unavailable || []).map(Number);
    r.maxWeek = u.toInt(r.maxWeek) || 0;
    r.maxRun = u.toInt(r.maxRun) || 0;
    r.maxMonth = u.toInt(r.maxMonth) || 0;
    if (Array.isArray(r.shifts)) r.shifts = r.shifts.filter((c) => codes(s).includes(c));
    return r;
  }

  /** Kebutuhan petugas tanggal d: pola mingguan, ditimpa pengaturan per tanggal. */
  function needOf(s, d) {
    const o = (s.config.days || {})[d];
    const base = (s.config.weekly || {})[weekday(s.period, d)] || {};
    const need = {};
    for (const c of codes(s)) need[c] = Math.max(0, u.toInt(o && o.need && o.need[c] !== undefined ? o.need[c] : base[c]) || 0);
    return { closed: !!(o && o.closed), need, custom: !!o };
  }

  // Senin sebagai awal minggu
  const weekStart = (period, d) => d - ((weekday(period, d) + 6) % 7);

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const isWork = (v) => !!v && v !== OFF;

  /** Apakah karyawan boleh masuk shift `code` pada tanggal d, dengan isian a (tanggal < d sudah terisi). */
  function allowed(s, r, a, d, code) {
    if (Array.isArray(r.shifts) && !r.shifts.includes(code)) return false;
    if (r.offDays.includes(weekday(s.period, d))) return false;
    if (r.unavailable.includes(d)) return false;
    if (r.maxWeek) {
      let n = 0;
      for (let x = Math.max(1, weekStart(s.period, d)); x < d; x++) if (isWork(a[x])) n++;
      if (n >= r.maxWeek) return false;
    }
    if (r.maxRun) {
      let n = 0;
      for (let x = d - 1; x >= 1 && isWork(a[x]); x--) n++;
      if (n >= r.maxRun) return false;
    }
    if (r.maxMonth) {
      let n = 0;
      for (let x = 1; x < d; x++) if (isWork(a[x])) n++;
      if (n >= r.maxMonth) return false;
    }
    return true;
  }

  /**
   * Buat jadwal otomatis.
   * @param opt { seed, mode: 'fair' | 'random', keepManual (bawaan true) }
   * @returns { assignments, warnings: [{ day, code, missing }] }
   */
  function generate(s, opt) {
    opt = opt || {};
    const rnd = mulberry32(opt.seed !== undefined ? opt.seed : Date.now());
    const keep = opt.keepManual !== false;
    const emps = s.config.employees.slice();
    const N = daysIn(s.period);
    const rules = new Map(emps.map((e) => [e, ruleOf(s, e)]));
    const asg = {};
    const work = {};
    const perShift = {};
    for (const e of emps) {
      asg[e] = {};
      work[e] = 0;
      perShift[e] = {};
      if (keep) for (const d of Object.keys((s.config.manual || {})[e] || {})) {
        const v = ((s.assignments || {})[e] || {})[d];
        if (v && (v === OFF || codes(s).includes(v)) && +d <= N) asg[e][d] = v;
      }
    }
    const warnings = [];
    for (let d = 1; d <= N; d++) {
      const { closed, need } = needOf(s, d);
      const today = {};
      for (const e of emps) if (asg[e][d]) today[e] = asg[e][d];
      if (!closed) {
        for (const sh of s.config.shifts) {
          const want = need[sh.code] || 0;
          let have = Object.values(today).filter((v) => v === sh.code).length;
          if (have >= want) continue;
          const tie = new Map(emps.map((e) => [e, rnd()]));
          let cand = emps.filter((e) => !today[e] && allowed(s, rules.get(e), asg[e], d, sh.code));
          if (opt.mode === 'random') cand.sort((a, b) => tie.get(a) - tie.get(b));
          else cand.sort((a, b) => work[a] - work[b] || (perShift[a][sh.code] || 0) - (perShift[b][sh.code] || 0) || tie.get(a) - tie.get(b));
          for (const e of cand.slice(0, want - have)) {
            today[e] = sh.code;
            have++;
          }
          if (have < want) warnings.push({ day: d, code: sh.code, missing: want - have });
        }
      }
      for (const e of emps) {
        const v = today[e] || OFF;
        asg[e][d] = v;
        if (isWork(v)) {
          work[e]++;
          perShift[e][v] = (perShift[e][v] || 0) + 1;
        }
      }
    }
    return { assignments: asg, warnings };
  }

  /** Analisis jadwal: kekurangan per hari & pelanggaran ketentuan per karyawan. */
  function check(s) {
    const N = daysIn(s.period);
    const emps = s.config.employees;
    const byDay = {};
    const byEmp = {};
    let short = 0;
    let issues = 0;
    for (let d = 1; d <= N; d++) {
      const nd = needOf(s, d);
      const count = {};
      for (const e of emps) {
        const v = ((s.assignments[e] || {})[d]);
        if (isWork(v)) count[v] = (count[v] || 0) + 1;
      }
      const sh = {};
      if (!nd.closed) for (const c of codes(s)) if ((count[c] || 0) < nd.need[c]) {
        sh[c] = nd.need[c] - (count[c] || 0);
        short += sh[c];
      }
      byDay[d] = Object.assign(nd, { count, short: sh });
    }
    for (const e of emps) {
      const r = ruleOf(s, e);
      const a = s.assignments[e] || {};
      const x = { work: 0, off: 0, empty: 0, hours: 0, perShift: {}, issues: [] };
      const note = (d, msg) => x.issues.push({ day: d, msg });
      let run = 0;
      for (let d = 1; d <= N; d++) {
        const v = a[d];
        if (!v) {
          x.empty++;
          run = 0;
          continue;
        }
        if (v === OFF) {
          x.off++;
          run = 0;
          continue;
        }
        const shf = shiftOf(s, v);
        x.work++;
        x.hours += shf ? hours(shf) : 0;
        x.perShift[v] = (x.perShift[v] || 0) + 1;
        run++;
        if (Array.isArray(r.shifts) && !r.shifts.includes(v)) note(d, 'shift ' + v + ' tidak diizinkan');
        if (r.offDays.includes(weekday(s.period, d))) note(d, 'masuk pada hari libur tetap (' + WEEKDAYS[weekday(s.period, d)] + ')');
        if (r.unavailable.includes(d)) note(d, 'masuk pada tanggal tidak tersedia');
        if (r.maxRun && run === r.maxRun + 1) note(d, 'lebih dari ' + r.maxRun + ' hari berturut-turut');
        if (r.maxMonth && x.work === r.maxMonth + 1) note(d, 'lebih dari ' + r.maxMonth + ' hari dalam sebulan');
        if (r.maxWeek) {
          let n = 0;
          for (let y = Math.max(1, weekStart(s.period, d)); y <= d; y++) if (isWork(a[y])) n++;
          if (n === r.maxWeek + 1) note(d, 'lebih dari ' + r.maxWeek + ' hari dalam seminggu');
        }
      }
      issues += x.issues.length;
      byEmp[e] = x;
    }
    return { byDay, byEmp, short, issues };
  }

  /** Validasi struktur sebelum disimpan (sama dengan fungsi save_work_schedule di server). */
  function validate(s) {
    const errs = [];
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s.period || '')) errs.push('Periode jadwal tidak valid.');
    if (!UNITS[s.unit]) errs.push('Unit jadwal tidak valid.');
    const sh = s.config.shifts || [];
    if (!sh.length) errs.push('Minimal satu shift harus ditentukan.');
    if (sh.length > 12) errs.push('Maksimal 12 shift.');
    const seen = new Set();
    for (const x of sh) {
      if (!/^[A-Z0-9]{1,3}$/.test(x.code || '') || x.code === OFF) errs.push('Kode shift "' + (x.code || '') + '" tidak valid (1–3 huruf/angka kapital, selain L).');
      else if (seen.has(x.code)) errs.push('Kode shift "' + x.code + '" dipakai lebih dari sekali.');
      seen.add(x.code);
      if (minutes(x.start) === null || minutes(x.end) === null) errs.push('Jam shift ' + x.code + ' tidak valid (HH:MM).');
    }
    const N = daysIn(s.period || '2000-01');
    const emps = new Set(s.config.employees || []);
    for (const [e, cells] of Object.entries(s.assignments || {})) {
      if (!emps.has(e)) {
        errs.push('Karyawan ' + e + ' tidak termasuk dalam jadwal ini.');
        continue;
      }
      for (const [d, v] of Object.entries(cells || {})) {
        if (!(+d >= 1 && +d <= N)) errs.push('Tanggal ' + d + ' di luar bulan ' + s.period + '.');
        else if (v !== OFF && !seen.has(v)) errs.push('Kode "' + v + '" pada tanggal ' + d + ' bukan shift yang terdaftar.');
      }
    }
    return [...new Set(errs)];
  }

  /** Bentuk data yang disimpan: isian hanya untuk karyawan terpilih, tanpa sel kosong. */
  function payload(s) {
    const emps = new Set(s.config.employees);
    const assignments = {};
    for (const [e, cells] of Object.entries(s.assignments || {})) {
      if (!emps.has(e)) continue;
      const c = {};
      for (const [d, v] of Object.entries(cells || {})) if (v) c[d] = v;
      if (Object.keys(c).length) assignments[e] = c;
    }
    const config = clone(s.config);
    for (const k of ['rules', 'manual']) for (const e of Object.keys(config[k] || {})) if (!emps.has(e)) delete config[k][e];
    return { id: idOf(s.period, s.unit), period: s.period, unit: s.unit, title: s.title || '', config, assignments, version: s.version };
  }

  /* ---------------------------- Penyimpanan ---------------------------- */
  const sched = {
    OFF, WEEKDAYS, WD3, UNITS, DEFAULT_SHIFTS, DEFAULT_RULE, PALETTE,
    daysIn, weekday, idOf, hours, parseDays, fmtDays, blank, normalize, ruleOf, needOf, generate, check, validate, payload, allowed,

    async get(period, unit) {
      const rec = await NP.db.get('schedules', idOf(period, unit));
      return rec ? normalize(rec) : null;
    },
    async all() {
      return (await NP.db.all('schedules')).map(normalize);
    },
    /** Simpan; menolak bila jadwal sudah diubah perangkat/pengguna lain (versi berbeda). */
    async save(s) {
      const errs = validate(s);
      if (errs.length) throw new Error(errs.slice(0, 3).join(' '));
      const p = payload(s);
      if (NP.db.remote) {
        const r = await NP.db.saveSchedule(p);
        return Object.assign(normalize(p), { version: r.version, updatedAt: Date.parse(r.updatedAt) || Date.now() });
      }
      const usr = NP.sec && NP.sec.user ? NP.sec.user() : null;
      return NP.db.run(['schedules', 'auditLog'], async (t) => {
        const cur = await t.get('schedules', p.id);
        if (cur && p.version != null && cur.version !== p.version) {
          throw new Error('Jadwal ' + p.period + ' telah diubah oleh pengguna lain (versi ' + cur.version + '). Muat ulang halaman lalu ulangi perubahan.');
        }
        const rec = Object.assign({}, p, { version: (cur ? cur.version : 0) + 1, createdAt: cur ? cur.createdAt : Date.now(), updatedAt: Date.now(), updatedBy: usr ? usr.username : 'sistem' });
        await t.put('schedules', rec);
        const n = Object.values(p.assignments).reduce((a, c) => a + Object.keys(c).length, 0);
        await t.put('auditLog', NP.audit.entry('schedule.save', 'schedules', p.id, 'Simpan jadwal ' + p.period + ' (' + p.unit + '): ' + p.config.employees.length + ' karyawan, ' + n + ' isian, versi ' + rec.version));
        return normalize(rec);
      });
    },
    async remove(id) {
      if (NP.db.remote) return NP.db.deleteSchedule(id);
      return NP.db.run(['schedules', 'auditLog'], async (t) => {
        await t.del('schedules', id);
        await t.put('auditLog', NP.audit.entry('schedule.delete', 'schedules', id, 'Hapus jadwal ' + id));
      });
    },

    /** Tabel Excel: baris karyawan, kolom tanggal. */
    toSheets(s, empMap) {
      const N = daysIn(s.period);
      const C = check(s);
      const head = ['Nama', 'Jabatan'];
      for (let d = 1; d <= N; d++) head.push(d + ' ' + WD3[weekday(s.period, d)]);
      head.push('Masuk', 'Libur', 'Jam');
      for (const sh of s.config.shifts) head.push(sh.code);
      const aoa = [head];
      for (const e of s.config.employees) {
        const emp = empMap.get(e) || { name: e, position: '' };
        const row = [emp.name, emp.position || ''];
        for (let d = 1; d <= N; d++) row.push(((s.assignments[e] || {})[d]) || '');
        const x = C.byEmp[e];
        row.push(x.work, x.off, Math.round(x.hours * 10) / 10);
        for (const sh of s.config.shifts) row.push(x.perShift[sh.code] || 0);
        aoa.push(row);
      }
      aoa.push([]);
      for (const sh of s.config.shifts) {
        const row = ['Jumlah ' + sh.code, 'butuh / terisi'];
        for (let d = 1; d <= N; d++) {
          const b = C.byDay[d];
          row.push(b.closed ? 'tutup' : (b.count[sh.code] || 0) + '/' + b.need[sh.code]);
        }
        aoa.push(row);
      }
      const legend = [['Kode', 'Nama shift', 'Mulai', 'Selesai', 'Jam']].concat(s.config.shifts.map((sh) => [sh.code, sh.name, sh.start, sh.end, hours(sh)]), [[OFF, 'Libur', '', '', 0]]);
      return [{ name: 'Jadwal ' + s.period, aoa }, { name: 'Keterangan', aoa: legend }];
    }
  };
  NP.sched = sched;

  /* =============================== Halaman =============================== */
  // Isian yang belum disimpan tetap ada selama aplikasi terbuka (per bulan & unit).
  const drafts = new Map();
  const st = { period: null, unit: 'ALL', tab: 'grid', brush: null, mode: 'fair', keepManual: true };

  async function render(view, params) {
    const ui = NP.ui;
    const C = NP.C;
    if (/^\d{4}-\d{2}$/.test(params.month || '')) st.period = params.month;
    if (UNITS[params.unit]) st.unit = params.unit;
    if (params.tab) st.tab = params.tab;
    st.period = st.period || u.todayISO().slice(0, 7);
    const canEdit = NP.sec.can('schedule.edit');
    const key = idOf(st.period, st.unit);
    const employees = (await NP.emp.all()).filter((e) => e.status === 'aktif' || e.status === 'cuti');
    const allEmp = await NP.emp.all();
    const empMap = new Map(allEmp.map((e) => [e.id, e]));
    let s = drafts.get(key);
    // tanpa perubahan lokal → selalu ambil versi terbaru dari database (mis. disimpan perangkat lain)
    if (!s || !s.dirty) {
      s = (await sched.get(st.period, st.unit)) || blank(st.period, st.unit);
      s.dirty = false;
      drafts.set(key, s);
    }
    const N = daysIn(s.period);
    const pool = employees.filter((e) => st.unit === 'ALL' || e.unit === st.unit || e.unit === 'LINTAS');

    view.innerHTML = `
      <div class="page-head">
        <div><h2>Jadwal Masuk</h2><p class="muted">Susun jadwal kerja bulanan: atur shift dan kebutuhan petugas per hari, pilih karyawan beserta ketentuannya, lalu buat jadwal otomatis (merata atau acak) dan sesuaikan per sel.</p></div>
        <div class="actions">
          <button type="button" class="btn btn-ghost" data-act="xls">${ui.icon('excel')}<span>Excel</span></button>
          <button type="button" class="btn btn-ghost" data-act="print">${ui.icon('print')}<span>Cetak</span></button>
        </div>
      </div>
      <div class="card sch-bar">
        <label class="field-inline">Bulan <input type="month" id="sc-month" value="${st.period}"></label>
        <label class="field-inline">Unit <select id="sc-unit">${ui.options(Object.entries(UNITS), st.unit)}</select></label>
        <span class="sch-state" id="sc-state"></span>
        <div class="sch-bar-actions">
          ${canEdit ? `<button type="button" class="btn btn-ghost" data-act="random">${ui.icon('refresh')}<span>Buat jadwal acak</span></button>
          <button type="button" class="btn btn-primary" data-act="save">${ui.icon('check')}<span>Simpan jadwal</span></button>` : ''}
        </div>
      </div>
      <div id="sc-tabs"></div>
      <div id="sc-body"></div>`;
    view.classList.toggle('sch-readonly', !canEdit);
    const body = ui.$('#sc-body', view);
    const markDirty = () => {
      s.dirty = true;
      view.classList.add('sch-dirty');
      drawState();
    };
    function drawState() {
      const el = ui.$('#sc-state', view);
      if (!el) return;
      const r = check(s);
      el.innerHTML = [
        s.dirty ? '<span class="flag flag-low">Belum disimpan</span>' : s.version ? `<span class="flag flag-done">Tersimpan · versi ${s.version}</span>` : '<span class="flag flag-dup">Jadwal baru</span>',
        `<span class="muted small">${s.config.employees.length} karyawan</span>`,
        r.short ? `<span class="flag flag-zero">Kurang ${r.short} petugas</span>` : s.config.employees.length ? '<span class="flag flag-done">Kebutuhan terpenuhi</span>' : '',
        r.issues ? `<span class="flag flag-low">${r.issues} pelanggaran ketentuan</span>` : ''
      ].join(' ');
      view.classList.toggle('sch-dirty', !!s.dirty);
    }

    ui.tabs(ui.$('#sc-tabs', view), [
      { key: 'grid', label: 'Jadwal', icon: 'calendar' },
      { key: 'people', label: 'Karyawan & ketentuan', icon: 'users' },
      { key: 'needs', label: 'Shift & kebutuhan per hari', icon: 'settings' }
    ], st.tab, (k) => {
      st.tab = k;
      draw();
    });

    function draw() {
      drawState();
      if (st.tab === 'people') drawPeople();
      else if (st.tab === 'needs') drawNeeds();
      else drawGrid();
    }

    /* ----------------------------- Tab Jadwal ----------------------------- */
    function drawGrid() {
      const r = check(s);
      const emps = s.config.employees;
      if (!st.brush || (st.brush !== OFF && st.brush !== '-' && !codes(s).includes(st.brush))) st.brush = s.config.shifts[0].code;
      const head = [];
      for (let d = 1; d <= N; d++) {
        const w = weekday(s.period, d);
        const b = r.byDay[d];
        head.push(`<th class="sch-d ${w === 0 ? 'sun' : ''} ${b.closed ? 'closed' : ''} ${b.custom ? 'custom' : ''}" title="${WEEKDAYS[w]}, ${d}${b.closed ? ' — tutup' : ''}"><span>${d}</span><small>${WD3[w]}</small></th>`);
      }
      const rows = emps.map((e) => {
        const emp = empMap.get(e) || { name: e + ' (tidak ditemukan)', position: '' };
        const x = r.byEmp[e];
        const bad = new Map(x.issues.map((i) => [i.day, i.msg]));
        const cells = [];
        for (let d = 1; d <= N; d++) {
          const v = (s.assignments[e] || {})[d] || '';
          const sh = shiftOf(s, v);
          const man = !!((s.config.manual[e] || {})[d]);
          const closed = r.byDay[d].closed;
          cells.push(`<td class="sch-c ${v === OFF ? 'off' : ''} ${closed ? 'closed' : ''} ${bad.has(d) ? 'bad' : ''}"><button type="button" data-e="${u.esc(e)}" data-d="${d}" ${sh ? `style="--sc:${u.esc(sh.color)}"` : ''} class="${sh ? 'on' : ''} ${man ? 'man' : ''}" title="${u.esc(emp.name)} · ${d} ${WD3[weekday(s.period, d)]}${sh ? ' · ' + u.esc(sh.name) + ' ' + sh.start + '–' + sh.end : v === OFF ? ' · Libur' : ''}${man ? ' · diisi manual' : ''}${bad.has(d) ? ' · ' + u.esc(bad.get(d)) : ''}" ${canEdit ? '' : 'disabled'}>${u.esc(v)}</button></td>`);
        }
        return `<tr><th class="sch-name" scope="row"><b>${u.esc(emp.name)}</b><small>${u.esc(emp.position || '')}</small></th>${cells.join('')}
          <td class="sch-tot"><b>${x.work}</b></td><td class="sch-tot">${x.off}</td><td class="sch-tot">${u.num(Math.round(x.hours))}</td></tr>`;
      });
      const foot = s.config.shifts.map((sh) => {
        const c = [];
        for (let d = 1; d <= N; d++) {
          const b = r.byDay[d];
          const n = b.count[sh.code] || 0;
          c.push(`<td class="sch-f ${b.closed ? 'closed' : b.short[sh.code] ? 'short' : ''}" title="${sh.name} tanggal ${d}: ${n} dari ${b.closed ? 'tutup' : b.need[sh.code]}">${b.closed ? '–' : n + '/' + b.need[sh.code]}</td>`);
        }
        return `<tr><th class="sch-name" scope="row"><span class="sch-key" style="--sc:${u.esc(sh.color)}">${u.esc(sh.code)}</span> ${u.esc(sh.name)}</th>${c.join('')}<td colspan="3"></td></tr>`;
      });
      const issueList = [];
      for (const e of emps) for (const i of r.byEmp[e].issues) issueList.push(`${u.esc((empMap.get(e) || {}).name || e)}: tanggal ${i.day} — ${u.esc(i.msg)}`);
      const shortList = [];
      for (let d = 1; d <= N; d++) for (const [c, k] of Object.entries(r.byDay[d].short)) shortList.push(`Tanggal ${d} (${WD3[weekday(s.period, d)]}): ${c} kurang ${k}`);

      body.innerHTML = `
        <div class="card">
          ${emps.length ? `
          ${canEdit ? `<div class="sch-tools">
            <div class="sch-brush" role="radiogroup" aria-label="Isi sel dengan">
              <span class="muted small">Ketuk sel untuk mengisi:</span>
              ${s.config.shifts.map((sh) => `<button type="button" role="radio" aria-checked="${st.brush === sh.code}" class="brush ${st.brush === sh.code ? 'active' : ''}" data-brush="${u.esc(sh.code)}" style="--sc:${u.esc(sh.color)}"><b>${u.esc(sh.code)}</b> ${u.esc(sh.name)}</button>`).join('')}
              <button type="button" role="radio" aria-checked="${st.brush === OFF}" class="brush off ${st.brush === OFF ? 'active' : ''}" data-brush="${OFF}"><b>L</b> Libur</button>
              <button type="button" role="radio" aria-checked="${st.brush === '-'}" class="brush erase ${st.brush === '-' ? 'active' : ''}" data-brush="-">${ui.icon('x')} Kosongkan</button>
            </div>
            <div class="sch-gen">
              <label class="field-inline">Cara <select id="sc-mode">${ui.options([['fair', 'Merata (adil)'], ['random', 'Acak penuh']], st.mode)}</select></label>
              <label class="check"><input type="checkbox" id="sc-keep" ${st.keepManual ? 'checked' : ''}><span>Pertahankan isian manual</span></label>
              <button type="button" class="btn btn-ghost btn-sm" data-act="clear">${ui.icon('trash')}<span>Kosongkan jadwal</span></button>
            </div>
          </div>
          <p class="muted small">Sel bertitik = diisi manual (dipertahankan saat <b>Buat jadwal acak</b> bila dicentang). Sel merah melanggar ketentuan karyawan; angka bawah = terisi/kebutuhan per shift.</p>` : ''}
          <div class="sch-wrap"><table class="sch-grid"><thead><tr><th class="sch-name">Karyawan</th>${head.join('')}<th class="sch-tot" title="Hari masuk">Masuk</th><th class="sch-tot" title="Hari libur">Libur</th><th class="sch-tot" title="Total jam">Jam</th></tr></thead>
            <tbody>${rows.join('')}</tbody><tfoot>${foot.join('')}</tfoot></table></div>
          ${shortList.length || issueList.length ? `<div class="sch-notes">
            ${shortList.length ? `<div class="alert alert-warning">${ui.icon('warn')}<div><b>Kebutuhan belum terpenuhi (${shortList.length})</b><ul>${shortList.slice(0, 8).map((x) => `<li>${x}</li>`).join('')}</ul>${shortList.length > 8 ? `<small>dan ${shortList.length - 8} lainnya</small>` : ''}<small class="block">Tambah karyawan, longgarkan ketentuan, atau kurangi kebutuhan pada tab <b>Shift &amp; kebutuhan per hari</b>.</small></div></div>` : ''}
            ${issueList.length ? `<div class="alert alert-info">${ui.icon('info')}<div><b>Melanggar ketentuan karyawan (${issueList.length})</b><ul>${issueList.slice(0, 8).map((x) => `<li>${x}</li>`).join('')}</ul>${issueList.length > 8 ? `<small>dan ${issueList.length - 8} lainnya</small>` : ''}</div></div>` : ''}
          </div>` : ''}`
          : ui.empty('Belum ada karyawan di jadwal ini. Pilih karyawan pada tab <b>Karyawan &amp; ketentuan</b>.', 'users')}
        </div>`;
    }

    /* ----------------------- Tab Karyawan & ketentuan ----------------------- */
    function drawPeople() {
      const inSet = new Set(s.config.employees);
      const list = pool.concat(s.config.employees.filter((e) => !pool.some((p) => p.id === e)).map((e) => empMap.get(e) || { id: e, name: e + ' (tidak ditemukan)', position: '' }));
      const row = (e) => {
        const r = ruleOf(s, e.id);
        const on = inSet.has(e.id);
        const dis = !canEdit ? 'disabled' : '';
        return `<div class="sch-p ${on ? 'in' : 'sch-out'}" data-emp="${u.esc(e.id)}">
          <label class="sch-p-head"><input type="checkbox" data-inc="${u.esc(e.id)}" ${on ? 'checked' : ''} ${dis} aria-label="Masukkan ${u.esc(e.name)} ke jadwal">
            <span><b>${u.esc(e.name)}</b><small>${u.esc(e.position || '')}${e.unit ? ' · ' + u.esc(C.EMP_UNITS[e.unit] || e.unit) : ''}</small></span></label>
          ${on ? `<div class="sch-p-rules">
            <div class="sch-r"><span>Shift yang boleh</span><div class="chips">${s.config.shifts.map((sh) => `<label class="chip-check"><input type="checkbox" data-rs="${u.esc(sh.code)}" ${!Array.isArray(r.shifts) || r.shifts.includes(sh.code) ? 'checked' : ''} ${dis}><span title="${u.esc(sh.name)}">${u.esc(sh.code)}</span></label>`).join('')}</div></div>
            <div class="sch-r"><span>Libur tetap</span><div class="chips nowrap">${[1, 2, 3, 4, 5, 6, 0].map((w) => `<label class="chip-check off"><input type="checkbox" data-ro="${w}" ${r.offDays.includes(w) ? 'checked' : ''} ${dis}><span title="${WEEKDAYS[w]}">${WD3[w]}</span></label>`).join('')}</div></div>
            <label class="sch-r"><span>Maks/minggu</span><input type="number" min="0" max="7" data-rn="maxWeek" value="${r.maxWeek || ''}" placeholder="—" ${dis}></label>
            <label class="sch-r"><span>Maks berturut</span><input type="number" min="0" max="31" data-rn="maxRun" value="${r.maxRun || ''}" placeholder="—" ${dis}></label>
            <label class="sch-r"><span>Maks/bulan</span><input type="number" min="0" max="31" data-rn="maxMonth" value="${r.maxMonth || ''}" placeholder="—" ${dis}></label>
            <label class="sch-r wide"><span>Tidak bisa tanggal</span><input data-ru value="${u.esc(fmtDays(r.unavailable))}" placeholder="mis. 3, 10-12" ${dis}></label>
          </div>` : ''}
        </div>`;
      };
      const nIn = list.filter((e) => inSet.has(e.id)).length;
      body.innerHTML = `
        <div class="card">
          <div class="card-head"><h3>Karyawan yang dimasukkan ke jadwal <small class="muted">${nIn} dari ${list.length}</small></h3>
            ${canEdit ? `<div class="actions"><button type="button" class="btn btn-ghost btn-sm" data-act="all-in">Pilih semua</button><button type="button" class="btn btn-ghost btn-sm" data-act="all-out">Kosongkan pilihan</button></div>` : ''}</div>
          <p class="muted small">Centang karyawan yang masuk jadwal ${u.esc(UNITS[st.unit].toLowerCase())}, lalu atur ketentuannya. Ketentuan dipakai saat <b>Buat jadwal acak</b> dan untuk menandai pelanggaran: <b>shift yang boleh</b>, <b>libur tetap</b> (hari dalam seminggu), <b>maks. hari kerja per minggu</b> (Senin–Minggu), <b>maks. hari berturut-turut</b>, <b>maks. hari per bulan</b>, dan <b>tanggal tidak bisa masuk</b> (mis. cuti). Kosongkan angka untuk tanpa batas.</p>
          ${list.length ? `<div class="sch-plist">${list.map(row).join('')}</div>` : ui.empty('Tidak ada karyawan aktif pada unit ini.', 'users')}
        </div>`;
    }

    /* ------------------- Tab Shift & kebutuhan per hari ------------------- */
    function drawNeeds() {
      const dis = canEdit ? '' : 'disabled';
      const r = check(s);
      const dayRows = [];
      for (let d = 1; d <= N; d++) {
        const w = weekday(s.period, d);
        const nd = r.byDay[d];
        const o = s.config.days[d];
        dayRows.push(`<tr class="${nd.custom ? 'sch-custom' : ''} ${nd.closed ? 'sch-closed' : ''} ${w === 0 ? 'sun' : ''}" data-day="${d}">
          <td data-label="Tanggal"><b>${d}</b> <span class="muted">${WEEKDAYS[w]}</span></td>
          ${s.config.shifts.map((sh) => `<td data-label="${u.esc(sh.code + ' ' + sh.name)}"><input type="number" min="0" max="50" data-dn="${u.esc(sh.code)}" value="${o && o.need && o.need[sh.code] !== undefined ? o.need[sh.code] : ''}" placeholder="${nd.need[sh.code]}" ${nd.closed ? 'disabled' : dis} aria-label="Kebutuhan ${u.esc(sh.name)} tanggal ${d}"></td>`).join('')}
          <td data-label="Tutup"><label class="check"><input type="checkbox" data-dc ${nd.closed ? 'checked' : ''} ${dis}><span>Tutup</span></label></td>
          <td data-label="Terisi">${nd.closed ? '<span class="muted">—</span>' : s.config.shifts.map((sh) => `<span class="${nd.short[sh.code] ? 'txt-danger' : 'muted'}">${u.esc(sh.code)} ${nd.count[sh.code] || 0}/${nd.need[sh.code]}</span>`).join(' ')}</td>
          <td>${nd.custom && canEdit ? `<button type="button" class="btn btn-ghost btn-sm" data-dreset title="Kembali ke pola mingguan" aria-label="Kembali ke pola mingguan">${ui.icon('refresh')}</button>` : ''}</td>
        </tr>`);
      }
      body.innerHTML = `
        <div class="card">
          <div class="card-head"><h3>Shift</h3>${canEdit ? `<button type="button" class="btn btn-ghost btn-sm" data-act="add-shift" ${s.config.shifts.length >= 12 ? 'disabled' : ''}>${ui.icon('plus')}<span>Tambah shift</span></button>` : ''}</div>
          <p class="muted small">Kode 1–3 huruf/angka (mis. P, S, M, PS). Kode <b>L</b> dipakai untuk libur. Shift yang melewati tengah malam (mis. 21:00–07:00) dihitung benar.</p>
          <div class="table-wrap table-cards"><table class="tbl sch-shifts"><thead><tr><th>Kode</th><th>Nama</th><th>Mulai</th><th>Selesai</th><th>Jam</th><th>Warna</th><th></th></tr></thead><tbody>
            ${s.config.shifts.map((sh, i) => `<tr data-si="${i}">
              <td data-label="Kode"><input data-sf="code" value="${u.esc(sh.code)}" maxlength="3" class="sch-code" ${dis} aria-label="Kode shift"></td>
              <td data-label="Nama"><input data-sf="name" value="${u.esc(sh.name)}" maxlength="30" ${dis} aria-label="Nama shift"></td>
              <td data-label="Mulai"><input type="time" data-sf="start" value="${u.esc(sh.start)}" ${dis} aria-label="Jam mulai"></td>
              <td data-label="Selesai"><input type="time" data-sf="end" value="${u.esc(sh.end)}" ${dis} aria-label="Jam selesai"></td>
              <td data-label="Jam">${u.num(hours(sh), 1)}</td>
              <td data-label="Warna"><input type="color" data-sf="color" value="${u.esc(sh.color)}" ${dis} aria-label="Warna shift"></td>
              <td>${canEdit && s.config.shifts.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-delshift="${i}" title="Hapus shift" aria-label="Hapus shift ${u.esc(sh.code)}">${ui.icon('trash')}</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Kebutuhan petugas per hari (pola mingguan)</h3></div>
          <p class="muted small">Jumlah petugas yang dibutuhkan setiap shift menurut hari. Isi 0 pada semua shift untuk hari yang tutup.</p>
          <div class="table-wrap"><table class="tbl sch-weekly"><thead><tr><th>Shift</th>${[1, 2, 3, 4, 5, 6, 0].map((w) => `<th class="ta-center ${w === 0 ? 'sun' : ''}">${WD3[w]}</th>`).join('')}</tr></thead><tbody>
            ${s.config.shifts.map((sh) => `<tr><th scope="row"><span class="sch-key" style="--sc:${u.esc(sh.color)}">${u.esc(sh.code)}</span> ${u.esc(sh.name)}</th>${[1, 2, 3, 4, 5, 6, 0].map((w) => `<td class="ta-center"><input type="number" min="0" max="50" data-wn="${w}|${u.esc(sh.code)}" value="${u.toInt((s.config.weekly[w] || {})[sh.code]) || 0}" ${dis} aria-label="${u.esc(sh.name)} ${WEEKDAYS[w]}"></td>`).join('')}</tr>`).join('')}
          </tbody></table></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Custom per tanggal — ${u.esc(u.periodLabel(s.period))}</h3></div>
          <p class="muted small">Ubah kebutuhan tanggal tertentu (mis. hari ramai, tanggal merah) atau tandai <b>Tutup</b>. Kolom kosong mengikuti pola mingguan (angka abu-abu). Baris yang diubah ditandai.</p>
          <div class="table-wrap table-cards"><table class="tbl sch-days"><thead><tr><th>Tanggal</th>${s.config.shifts.map((sh) => `<th>${u.esc(sh.code)} <small class="muted">${u.esc(sh.name)}</small></th>`).join('')}<th>Tutup</th><th>Terisi</th><th></th></tr></thead>
            <tbody>${dayRows.join('')}</tbody></table></div>
        </div>`;
    }

    /* ------------------------------ Interaksi ------------------------------ */
    const setRule = (e, patch) => {
      s.config.rules[e] = Object.assign({}, s.config.rules[e] || {}, patch);
      markDirty();
    };
    body.addEventListener('click', (ev) => {
      if (!canEdit) return;
      const cell = ev.target.closest('.sch-c button[data-e]');
      if (cell) {
        const e = cell.dataset.e;
        const d = cell.dataset.d;
        s.assignments[e] = s.assignments[e] || {};
        s.config.manual[e] = s.config.manual[e] || {};
        if (st.brush === '-') {
          delete s.assignments[e][d];
          delete s.config.manual[e][d];
        } else {
          s.assignments[e][d] = st.brush;
          s.config.manual[e][d] = true;
        }
        markDirty();
        const y = body.querySelector('.sch-wrap');
        const sx = y ? y.scrollLeft : 0;
        drawGrid();
        const y2 = body.querySelector('.sch-wrap');
        if (y2) y2.scrollLeft = sx;
        return;
      }
      const br = ev.target.closest('[data-brush]');
      if (br) {
        st.brush = br.dataset.brush;
        body.querySelectorAll('[data-brush]').forEach((b) => {
          b.classList.toggle('active', b === br);
          b.setAttribute('aria-checked', b === br);
        });
        return;
      }
      if (ev.target.closest('[data-act="clear"]')) {
        ui.confirm({ title: 'Kosongkan jadwal', message: 'Hapus seluruh isian jadwal ' + u.periodLabel(s.period) + ' (termasuk isian manual)? Perubahan baru tersimpan setelah Anda menekan Simpan.', danger: true, okLabel: 'Kosongkan' }).then((ok) => {
          if (!ok) return;
          s.assignments = {};
          s.config.manual = {};
          markDirty();
          drawGrid();
        });
        return;
      }
      const all = ev.target.closest('[data-act="all-in"],[data-act="all-out"]');
      if (all) {
        s.config.employees = all.dataset.act === 'all-in' ? [...new Set(s.config.employees.concat(pool.map((e) => e.id)))] : [];
        markDirty();
        drawPeople();
        return;
      }
      if (ev.target.closest('[data-act="add-shift"]')) {
        const used = new Set(codes(s));
        const code = ['M', 'PS', 'SM', 'X', 'Y', 'Z'].find((c) => !used.has(c)) || 'S' + s.config.shifts.length;
        s.config.shifts.push({ code, name: code === 'M' ? 'Malam' : 'Shift ' + code, start: '21:00', end: '07:00', color: PALETTE[s.config.shifts.length % PALETTE.length] });
        markDirty();
        drawNeeds();
        return;
      }
      const ds = ev.target.closest('[data-delshift]');
      if (ds) {
        const sh = s.config.shifts[+ds.dataset.delshift];
        const used = Object.values(s.assignments).some((c) => Object.values(c).includes(sh.code));
        ui.confirm({ title: 'Hapus shift', message: 'Hapus shift ' + sh.code + ' (' + sh.name + ')?' + (used ? ' Isian jadwal dengan shift ini ikut dikosongkan.' : ''), danger: true, okLabel: 'Hapus' }).then((ok) => {
          if (!ok) return;
          s.config.shifts.splice(+ds.dataset.delshift, 1);
          for (const [e, c] of Object.entries(s.assignments)) for (const d of Object.keys(c)) if (c[d] === sh.code) {
            delete c[d];
            if (s.config.manual[e]) delete s.config.manual[e][d];
          }
          markDirty();
          drawNeeds();
        });
        return;
      }
      const rs = ev.target.closest('[data-dreset]');
      if (rs) {
        delete s.config.days[rs.closest('tr').dataset.day];
        markDirty();
        drawNeeds();
      }
    });
    body.addEventListener('change', (ev) => {
      if (!canEdit) return;
      const t = ev.target;
      const tr = t.closest('[data-emp],[data-si],[data-day]');
      if (t.dataset.inc) {
        const id = t.dataset.inc;
        s.config.employees = t.checked ? s.config.employees.concat(id) : s.config.employees.filter((x) => x !== id);
        markDirty();
        return drawPeople();
      }
      const emp = tr && tr.dataset.emp;
      if (emp && t.dataset.rs) {
        const on = [...tr.querySelectorAll('[data-rs]')].filter((x) => x.checked).map((x) => x.dataset.rs);
        setRule(emp, { shifts: on.length === s.config.shifts.length ? null : on });
        if (!on.length) ui.toast('Karyawan tanpa shift yang boleh tidak akan dijadwalkan otomatis.', 'warning');
        return;
      }
      if (emp && t.dataset.ro !== undefined) return setRule(emp, { offDays: [...tr.querySelectorAll('[data-ro]')].filter((x) => x.checked).map((x) => +x.dataset.ro) });
      if (emp && t.dataset.rn) return setRule(emp, { [t.dataset.rn]: Math.max(0, u.toInt(t.value) || 0) });
      if (emp && t.dataset.ru !== undefined) {
        const list = parseDays(t.value, N);
        t.value = fmtDays(list);
        return setRule(emp, { unavailable: list });
      }
      if (t.dataset.sf) {
        const i = +tr.dataset.si;
        const sh = s.config.shifts[i];
        let v = t.value.trim();
        if (t.dataset.sf === 'code') {
          v = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
          if (!v || v === OFF || codes(s).some((c, j) => c === v && j !== i)) {
            ui.toast(!v || v === OFF ? 'Kode shift tidak boleh kosong atau "L" (libur).' : 'Kode shift "' + v + '" sudah dipakai.', 'error');
            t.value = sh.code;
            return;
          }
          // ganti kode di seluruh jadwal, kebutuhan & ketentuan
          const old = sh.code;
          for (const c of Object.values(s.assignments)) for (const d of Object.keys(c)) if (c[d] === old) c[d] = v;
          for (const w of Object.values(s.config.weekly)) if (old in w) {
            w[v] = w[old];
            delete w[old];
          }
          for (const o of Object.values(s.config.days)) if (o.need && old in o.need) {
            o.need[v] = o.need[old];
            delete o.need[old];
          }
          for (const r of Object.values(s.config.rules)) if (Array.isArray(r.shifts)) r.shifts = r.shifts.map((c) => (c === old ? v : c));
          if (st.brush === old) st.brush = v;
        }
        sh[t.dataset.sf] = v;
        markDirty();
        return drawNeeds();
      }
      if (t.dataset.wn) {
        const [w, c] = t.dataset.wn.split('|');
        s.config.weekly[w] = Object.assign({}, s.config.weekly[w] || {}, { [c]: Math.max(0, u.toInt(t.value) || 0) });
        markDirty();
        return drawNeeds();
      }
      if (t.dataset.dn !== undefined || t.dataset.dc !== undefined) {
        const d = tr.dataset.day;
        const o = Object.assign({ need: {} }, s.config.days[d] || {});
        o.need = Object.assign({}, o.need);
        if (t.dataset.dc !== undefined) o.closed = t.checked;
        else if (t.value === '') delete o.need[t.dataset.dn];
        else o.need[t.dataset.dn] = Math.max(0, u.toInt(t.value) || 0);
        if (!o.closed) delete o.closed;
        if (!o.closed && !Object.keys(o.need).length) delete s.config.days[d];
        else s.config.days[d] = o;
        markDirty();
        return drawNeeds();
      }
      if (t.id === 'sc-mode') st.mode = t.value;
      if (t.id === 'sc-keep') st.keepManual = t.checked;
    });

    /* ----------------------------- Toolbar ----------------------------- */
    // pindah bulan/unit: isian yang belum disimpan tetap tersimpan sementara di memori
    ui.$('#sc-month', view).onchange = async (ev) => {
      if (!/^\d{4}-\d{2}$/.test(ev.target.value)) return;
      st.period = ev.target.value;
      render(view, {});
    };
    ui.$('#sc-unit', view).onchange = async (ev) => {
      st.unit = ev.target.value;
      render(view, {});
    };
    view.querySelector('.page-head').addEventListener('click', (ev) => {
      const a = ev.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'xls') {
        if (!s.config.employees.length) return ui.toast('Jadwal masih kosong.', 'error');
        NP.exp.excel(sched.toSheets(s, empMap), 'jadwal-masuk-' + s.period + '-' + s.unit.toLowerCase() + '.xlsx');
      }
      if (a.dataset.act === 'print') {
        if (!s.config.employees.length) return ui.toast('Jadwal masih kosong.', 'error');
        NP.exp.printHtml(printHtml(s, empMap), 'Jadwal Masuk ' + u.periodLabel(s.period));
      }
    });
    view.querySelector('.sch-bar').addEventListener('click', async (ev) => {
      const a = ev.target.closest('[data-act]');
      if (!a || a.disabled) return;
      if (a.dataset.act === 'random') {
        if (!s.config.employees.length) {
          st.tab = 'people';
          ui.toast('Pilih dulu karyawan yang dimasukkan ke jadwal.', 'error');
          return render(view, {});
        }
        const hasFill = Object.values(s.assignments).some((c) => Object.keys(c).length);
        if (hasFill && !(await ui.confirm({ title: 'Buat jadwal acak', message: 'Isian jadwal ' + u.periodLabel(s.period) + ' akan diganti' + (st.keepManual ? ' (isian manual dipertahankan)' : ' seluruhnya') + '. Lanjutkan?', okLabel: 'Buat jadwal' }))) return;
        const g = generate(s, { mode: st.mode, keepManual: st.keepManual, seed: (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0 });
        s.assignments = g.assignments;
        if (!st.keepManual) s.config.manual = {};
        markDirty();
        st.tab = 'grid';
        ui.toast(g.warnings.length ? 'Jadwal dibuat; ' + g.warnings.reduce((x, w) => x + w.missing, 0) + ' kebutuhan petugas belum terpenuhi.' : 'Jadwal dibuat — semua kebutuhan terpenuhi.', g.warnings.length ? 'warning' : undefined);
        return render(view, {});
      }
      if (a.dataset.act === 'save') {
        a.disabled = true;
        try {
          const saved = await ui.busy('Menyimpan jadwal…', () => sched.save(s));
          saved.dirty = false;
          drafts.set(key, saved);
          ui.toast('Jadwal ' + u.periodLabel(saved.period) + ' disimpan (versi ' + saved.version + ').');
          return render(view, {});
        } catch (e) {
          ui.toast(e.message, 'error');
        } finally {
          a.disabled = false;
        }
      }
    });
    draw();
  }

  /** HTML cetak (A4 landscape). */
  function printHtml(s, empMap) {
    const N = daysIn(s.period);
    const r = check(s);
    const set = (NP.state && NP.state.settings) || {};
    const company = (set.company && set.company.name) || 'Noura';
    const head = [];
    for (let d = 1; d <= N; d++) head.push(`<th class="${weekday(s.period, d) === 0 ? 'sun' : ''}">${d}<br><small>${WD3[weekday(s.period, d)]}</small></th>`);
    const rows = s.config.employees.map((e) => {
      const emp = empMap.get(e) || { name: e, position: '' };
      const c = [];
      for (let d = 1; d <= N; d++) {
        const v = (s.assignments[e] || {})[d] || '';
        const sh = shiftOf(s, v);
        c.push(`<td class="${v === OFF ? 'off' : ''} ${weekday(s.period, d) === 0 ? 'sun' : ''}" ${sh ? `style="background:${u.esc(sh.color)}22"` : ''}>${u.esc(v)}</td>`);
      }
      return `<tr><td class="nm"><b>${u.esc(emp.name)}</b><br><small>${u.esc(emp.position || '')}</small></td>${c.join('')}<td>${r.byEmp[e].work}</td><td>${r.byEmp[e].off}</td></tr>`;
    });
    return `<style>@page{size:A4 landscape;margin:8mm}.sch-print{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:9px}.sch-print h1{font-size:15px;margin:0 0 2px}.sch-print p{margin:0 0 6px;color:#444}.sch-print table{border-collapse:collapse;width:100%}.sch-print th,.sch-print td{border:1px solid #bbb;padding:2px 1px;text-align:center}.sch-print td.nm{text-align:left;white-space:nowrap;padding:2px 4px}.sch-print .off{color:#888}.sch-print .sun{background:#fef2f2}.sch-print .lg{margin-top:6px}.sch-print .lg span{margin-right:12px}</style>
      <div class="sch-print"><h1>Jadwal Masuk — ${u.esc(company)}</h1><p>${u.esc(UNITS[s.unit])} · ${u.esc(u.periodLabel(s.period))}${s.version ? ' · versi ' + s.version : ''}</p>
      <table><thead><tr><th>Karyawan</th>${head.join('')}<th>Masuk</th><th>Libur</th></tr></thead><tbody>${rows.join('')}</tbody></table>
      <div class="lg">${s.config.shifts.map((sh) => `<span><b>${u.esc(sh.code)}</b> = ${u.esc(sh.name)} (${sh.start}–${sh.end})</span>`).join('')}<span><b>L</b> = Libur</span></div></div>`;
  }

  NP.pages = NP.pages || {};
  NP.pages.schedule = { title: 'Jadwal Masuk', render };
  if (typeof module !== 'undefined' && module.exports) module.exports = NP;
})(typeof globalThis !== 'undefined' ? globalThis : window);
