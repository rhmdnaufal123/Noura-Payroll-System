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
  // maxOff: libur maks. per bulan · quota: pembagian shift per minggu, mis. { P: 3, S: 3 }
  // fixed: shift tetap per hari, mis. { 1: 'P' } = selalu Pagi setiap Senin
  // backup: kode shift yang diprioritaskan untuk karyawan ini bila ada karyawan lain yang libur
  const DEFAULT_RULE = { shifts: null, offDays: [], maxWeek: 6, maxRun: 6, maxMonth: 0, maxOff: 0, quota: {}, fixed: {}, backup: '', unavailable: [] };

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
    r.maxOff = u.toInt(r.maxOff) || 0;
    const q = {};
    for (const [c, v] of Object.entries(r.quota || {})) if (codes(s).includes(c) && v !== '' && v !== null && v !== undefined && u.toInt(v) >= 0) q[c] = u.toInt(v);
    r.quota = q;
    const fx = {};
    for (const [w, c] of Object.entries(r.fixed || {})) if (+w >= 0 && +w <= 6 && codes(s).includes(c)) fx[+w] = c;
    r.fixed = fx;
    r.backup = codes(s).includes(r.backup) ? r.backup : '';
    if (Array.isArray(r.shifts)) r.shifts = r.shifts.filter((c) => codes(s).includes(c));
    return r;
  }

  /** Kalimat ringkas ketentuan karyawan (untuk ditampilkan). */
  function describeRule(s, r) {
    const name = (c) => (shiftOf(s, c) || {}).name || c;
    const out = [];
    if (Array.isArray(r.shifts)) out.push(r.shifts.length ? 'hanya shift ' + r.shifts.map(name).join(' & ') : 'tidak dijadwalkan otomatis (tanpa shift)');
    const q = Object.entries(r.quota || {});
    if (q.length) out.push('per minggu ' + q.map(([c, n]) => n + '× ' + name(c)).join(' + '));
    const fx = {};
    for (const w of [1, 2, 3, 4, 5, 6, 0]) if (r.fixed[w]) (fx[r.fixed[w]] = fx[r.fixed[w]] || []).push(WEEKDAYS[w]);
    for (const [c, days] of Object.entries(fx)) out.push('selalu ' + name(c) + ' tiap ' + days.join(', '));
    if (r.backup) out.push('prioritas ' + name(r.backup) + ' bila ada yang libur');
    if (r.maxOff) out.push('libur maks. ' + r.maxOff + ' hari/bulan');
    if (r.offDays.length) out.push('libur tiap ' + r.offDays.map((w) => WEEKDAYS[w]).join(', '));
    if (r.maxWeek) out.push('masuk maks. ' + r.maxWeek + ' hari/minggu');
    if (r.maxRun) out.push('maks. ' + r.maxRun + ' hari berturut-turut');
    if (r.maxMonth) out.push('masuk maks. ' + r.maxMonth + ' hari/bulan');
    if (r.unavailable.length) out.push('tidak bisa tgl ' + fmtDays(r.unavailable));
    return out.length ? out.join(' · ') : 'tanpa ketentuan khusus';
  }

  /** Kebutuhan petugas tanggal d: pola mingguan, ditimpa pengaturan per tanggal. */
  function needOf(s, d) {
    const o = (s.config.days || {})[d];
    const base = (s.config.weekly || {})[weekday(s.period, d)] || {};
    const need = {};
    const min = {};
    for (const sh of s.config.shifts) {
      const c = sh.code;
      need[c] = Math.max(0, u.toInt(o && o.need && o.need[c] !== undefined ? o.need[c] : base[c]) || 0);
      // minimal: boleh berkurang sampai jumlah ini bila ada yang libur (kosong = sama dengan kebutuhan)
      const m = sh.min === '' || sh.min === null || sh.min === undefined ? need[c] : Math.max(0, u.toInt(sh.min) || 0);
      min[c] = Math.min(need[c], m);
    }
    return { closed: !!(o && o.closed), need, min, custom: !!o };
  }

  // Senin sebagai awal minggu
  const weekStart = (period, d) => d - ((weekday(period, d) + 6) % 7);
  /** Minggu dalam bulan (Senin–Minggu, terpotong di awal/akhir bulan): [{ no, from, to }] */
  function weeksOf(period) {
    const N = daysIn(period);
    const out = [];
    for (let ws = weekStart(period, 1); ws <= N; ws += 7) out.push({ no: out.length + 1, from: Math.max(1, ws), to: Math.min(N, ws + 6) });
    return out;
  }
  /** Tanggal d adalah awal minggu (Senin) selain tanggal 1 → diberi garis batas minggu. */
  const weekEdge = (period, d) => d > 1 && weekday(period, d) === 1;
  /** Target pembagian shift untuk minggu yang memuat tanggal d (minggu terpotong awal/akhir bulan dihitung proporsional). */
  function quotaFor(s, r, d) {
    const a = Math.max(1, weekStart(s.period, d));
    const b = Math.min(daysIn(s.period), weekStart(s.period, d) + 6);
    const len = b - a + 1;
    const q = {};
    for (const [c, n] of Object.entries(r.quota || {})) q[c] = len >= 7 ? n : Math.round((n * len) / 7);
    return { q, from: a, to: b };
  }

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

  /**
   * Apakah karyawan boleh masuk shift `code` pada tanggal d, mengingat seluruh isian a bulan ini
   * (tanggal sebelum & sesudah d): shift yang boleh, libur tetap, tanggal tidak bisa, maks. per
   * minggu, maks. berturut-turut, maks. per bulan, dan pembagian shift per minggu.
   */
  function allowed(s, r, a, d, code) {
    if (Array.isArray(r.shifts) && !r.shifts.includes(code)) return false;
    if (r.offDays.includes(weekday(s.period, d))) return false;
    if (r.unavailable.includes(d)) return false;
    const N = daysIn(s.period);
    const ws = Math.max(1, weekStart(s.period, d));
    const we = Math.min(N, weekStart(s.period, d) + 6);
    if (r.maxWeek) {
      let n = 0;
      for (let x = ws; x <= we; x++) if (x !== d && isWork(a[x])) n++;
      if (n >= r.maxWeek) return false;
    }
    if (r.maxRun) {
      let n = 1;
      for (let x = d - 1; x >= 1 && isWork(a[x]); x--) n++;
      for (let x = d + 1; x <= N && isWork(a[x]); x++) n++;
      if (n > r.maxRun) return false;
    }
    if (r.maxMonth) {
      let n = 0;
      for (let x = 1; x <= N; x++) if (x !== d && isWork(a[x])) n++;
      if (n >= r.maxMonth) return false;
    }
    const q = quotaFor(s, r, d).q;
    if (code in q) {
      let n = 0;
      for (let x = ws; x <= we; x++) if (x !== d && a[x] === code) n++;
      if (n >= q[code]) return false;
    }
    return true;
  }

  /**
   * Buat jadwal otomatis, dalam beberapa tahap:
   *  0. shift tetap per hari (mis. selalu Pagi setiap Senin) diisi lebih dulu,
   *  1. setiap hari diisi sampai jumlah MINIMAL per shift (agar tidak ada hari yang kosong),
   *  2. lalu ditambah sampai kebutuhan IDEAL bila masih ada yang boleh masuk,
   *  3. pembagian shift per minggu (mis. 3 Pagi + 3 Siang) dilengkapi,
   *  4. karyawan dengan batas libur per bulan dijadwalkan masuk sampai liburnya tidak melebihi batas,
   *  5. pada hari ada yang libur, karyawan bertanda "prioritas" dipindah ke shift prioritasnya.
   * Urutan calon: yang masih kurang hari masuk (batas libur) → kekurangan pembagian shift minggu itu
   * → paling sedikit masuk (mode Merata) → acak. Semua ketentuan karyawan tetap dipatuhi.
   * @param opt { seed, mode: 'fair' | 'random', keepManual (bawaan true),
   *              manualOffWeek (bawaan true): minggu yang sudah berisi libur manual ("L") tidak diberi
   *              libur acak lagi — karyawan dijadwalkan masuk pada hari lain di minggu itu }
   * @returns { assignments, warnings: [{ day, code, missing }] }  — missing = kurang dari MINIMAL
   */
  function generate(s, opt) {
    opt = opt || {};
    const rnd = mulberry32(opt.seed !== undefined ? opt.seed : Date.now());
    const keep = opt.keepManual !== false;
    const emps = s.config.employees.slice();
    const N = daysIn(s.period);
    const rules = new Map(emps.map((e) => [e, ruleOf(s, e)]));
    const asg = {};
    for (const e of emps) {
      asg[e] = {};
      if (keep) for (const d of Object.keys((s.config.manual || {})[e] || {})) {
        const v = ((s.assignments || {})[e] || {})[d];
        if (v && (v === OFF || codes(s).includes(v)) && +d <= N) asg[e][d] = v;
      }
    }
    const day = {};
    for (let d = 1; d <= N; d++) day[d] = needOf(s, d);
    const tie = new Map(emps.map((e) => [e, rnd()]));
    const isManual = (e, d) => keep && !!((s.config.manual || {})[e] || {})[d];
    const unable = (e, d) => {
      const r = rules.get(e);
      return day[d].closed || r.offDays.includes(weekday(s.period, d)) || r.unavailable.includes(d);
    };
    // minggu (Senin–Minggu) yang sudah berisi libur manual karyawan → tanpa libur acak tambahan
    const wkOf = (d) => weekStart(s.period, d);
    const offWeek = new Map(emps.map((e) => [e, new Set()]));
    if (keep && opt.manualOffWeek !== false) for (const e of emps) for (const d of Object.keys(asg[e])) if (asg[e][d] === OFF && isManual(e, d)) offWeek.get(e).add(wkOf(+d));
    const inOffWeek = (e, d) => offWeek.get(e).has(wkOf(d));
    // hari yang sudah pasti ada karyawan libur (libur tetap, tidak bisa, isian manual "L")
    const someoneOff = (d) => !day[d].closed && emps.some((e) => asg[e][d] === OFF || (!asg[e][d] && unable(e, d)));
    // 0. shift tetap per hari (mis. selalu Pagi setiap Senin)
    for (const e of emps) {
      const r = rules.get(e);
      if (!Object.keys(r.fixed).length) continue;
      for (let d = 1; d <= N; d++) {
        const c = r.fixed[weekday(s.period, d)];
        if (c && !asg[e][d] && !day[d].closed && allowed(s, r, asg[e], d, c)) asg[e][d] = c;
      }
    }
    const count = (d, c) => emps.filter((e) => asg[e][d] === c).length;
    const works = (e) => Object.values(asg[e]).filter(isWork).length;
    const shiftN = (e, c) => Object.values(asg[e]).filter((v) => v === c).length;
    const can = (e, d, c) => {
      const fx = rules.get(e).fixed[weekday(s.period, d)];
      return !asg[e][d] && !day[d].closed && (!fx || fx === c) && allowed(s, rules.get(e), asg[e], d, c);
    };
    const quotaLeft = (e, d, c) => {
      const q = quotaFor(s, rules.get(e), d).q;
      if (!(c in q)) return 0;
      let n = 0;
      for (let x = Math.max(1, weekStart(s.period, d)); x <= Math.min(N, weekStart(s.period, d) + 6); x++) if (asg[e][x] === c) n++;
      return q[c] - n;
    };
    const needWork = (e) => {
      const r = rules.get(e);
      return r.maxOff ? N - r.maxOff - works(e) : 0;
    };
    const fair = opt.mode !== 'random';
    const pick = (d, c, list) => {
      const off = someoneOff(d);
      const key = (e) => [off && rules.get(e).backup === c ? 0 : 1, inOffWeek(e, d) ? 0 : 1, -Math.max(0, needWork(e)), -Math.max(0, quotaLeft(e, d, c)), fair ? works(e) : 0, fair ? shiftN(e, c) : 0, tie.get(e) + (fair ? 0 : rnd())];
      const k = new Map(list.map((e) => [e, key(e)]));
      return list.sort((a, b) => {
        const ka = k.get(a);
        const kb = k.get(b);
        for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
        return 0;
      });
    };
    const fill = (target) => {
      for (let d = 1; d <= N; d++) {
        if (day[d].closed) continue;
        for (const sh of s.config.shifts) {
          let have = count(d, sh.code);
          const want = target(d, sh.code);
          if (have >= want) continue;
          for (const e of pick(d, sh.code, emps.filter((e) => can(e, d, sh.code)))) {
            if (have >= want) break;
            if (!can(e, d, sh.code)) continue;
            asg[e][d] = sh.code;
            have++;
          }
        }
      }
    };
    fill((d, c) => day[d].min[c]); // 1. minimal
    fill((d, c) => day[d].need[c]); // 2. ideal
    // hari kosong yang paling membutuhkan tambahan orang untuk shift c (paling jauh di bawah ideal)
    const dt = {};
    for (let d = 1; d <= N; d++) dt[d] = rnd();
    const bestDay = (e, days, c) => days.filter((d) => can(e, d, c)).sort((a, b) => count(a, c) - day[a].need[c] - (count(b, c) - day[b].need[c]) || dt[a] - dt[b])[0];
    // 3. pembagian shift per minggu
    for (const e of emps) {
      const r = rules.get(e);
      if (!Object.keys(r.quota).length) continue;
      for (let ws = 1 - ((weekday(s.period, 1) + 6) % 7); ws <= N; ws += 7) {
        const days = [];
        for (let d = Math.max(1, ws); d <= Math.min(N, ws + 6); d++) days.push(d);
        for (const c of Object.keys(r.quota)) {
          while (quotaLeft(e, days[0], c) > 0) {
            const d = bestDay(e, days, c);
            if (!d) break;
            asg[e][d] = c;
          }
        }
      }
    }
    // 4. batas libur per bulan
    for (const e of emps) {
      const r = rules.get(e);
      if (!r.maxOff) continue;
      const all = [];
      for (let d = 1; d <= N; d++) all.push(d);
      while (N - works(e) > r.maxOff) {
        let best = null;
        for (const sh of s.config.shifts) {
          const d = bestDay(e, all, sh.code);
          if (!d) continue;
          const score = count(d, sh.code) / Math.max(1, day[d].need[sh.code]) - Math.max(0, quotaLeft(e, d, sh.code));
          if (!best || score < best.score) best = { d, c: sh.code, score };
        }
        if (!best) break;
        asg[e][best.d] = best.c;
      }
    }
    // 4b. minggu dengan libur manual: hari lain di minggu itu tetap masuk (shift yang paling dibutuhkan)
    for (const e of emps) {
      for (let d = 1; d <= N; d++) {
        if (asg[e][d] || !inOffWeek(e, d) || unable(e, d)) continue;
        const opts = s.config.shifts.filter((sh) => can(e, d, sh.code));
        if (!opts.length) continue;
        opts.sort((a, b) => Math.max(0, quotaLeft(e, d, b.code)) - Math.max(0, quotaLeft(e, d, a.code)) || count(d, a.code) / Math.max(1, day[d].need[a.code]) - count(d, b.code) / Math.max(1, day[d].need[b.code]) || dt[d] - 0.5);
        asg[e][d] = opts[0].code;
      }
    }
    for (let d = 1; d <= N; d++) for (const e of emps) if (!asg[e][d]) asg[e][d] = OFF;
    // 5. prioritas bila ada yang libur: karyawan bertanda masuk shift prioritasnya (tukar dengan rekan
    //    yang tidak bertanda, atau masuk dari libur bila shift itu masih di bawah ideal)
    const fixedAt = (e, d) => !!rules.get(e).fixed[weekday(s.period, d)];
    for (let d = 1; d <= N; d++) {
      if (day[d].closed || !emps.some((e) => asg[e][d] === OFF)) continue;
      for (const e of emps) {
        const c = rules.get(e).backup;
        const v = asg[e][d];
        if (!c || v === c || isManual(e, d) || fixedAt(e, d)) continue;
        if (v === OFF) {
          if (!unable(e, d) && count(d, c) < day[d].need[c] && allowed(s, rules.get(e), asg[e], d, c)) asg[e][d] = c;
          continue;
        }
        const f = emps.find((x) => x !== e && asg[x][d] === c && rules.get(x).backup !== c && !isManual(x, d) && !fixedAt(x, d) && allowed(s, rules.get(x), asg[x], d, v) && allowed(s, rules.get(e), asg[e], d, c));
        if (f) {
          asg[f][d] = v;
          asg[e][d] = c;
        }
      }
    }
    const warnings = [];
    for (let d = 1; d <= N; d++) {
      if (day[d].closed) continue;
      for (const sh of s.config.shifts) {
        const have = count(d, sh.code);
        if (have < day[d].min[sh.code]) warnings.push({ day: d, code: sh.code, missing: day[d].min[sh.code] - have });
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
    let underTotal = 0;
    let issues = 0;
    for (let d = 1; d <= N; d++) {
      const nd = needOf(s, d);
      const count = {};
      for (const e of emps) {
        const v = ((s.assignments[e] || {})[d]);
        if (isWork(v)) count[v] = (count[v] || 0) + 1;
      }
      const sh = {};
      const under = {};
      if (!nd.closed) for (const c of codes(s)) {
        const n = count[c] || 0;
        if (n < nd.min[c]) {
          sh[c] = nd.min[c] - n;
          short += sh[c];
        } else if (n < nd.need[c]) {
          under[c] = nd.need[c] - n;
          underTotal += under[c];
        }
      }
      byDay[d] = Object.assign(nd, { count, short: sh, under });
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
          if (r.maxOff && x.off === r.maxOff + 1) note(d, 'libur lebih dari ' + r.maxOff + ' hari dalam sebulan');
          continue;
        }
        const shf = shiftOf(s, v);
        x.work++;
        x.hours += shf ? hours(shf) : 0;
        x.perShift[v] = (x.perShift[v] || 0) + 1;
        run++;
        if (Array.isArray(r.shifts) && !r.shifts.includes(v)) note(d, 'shift ' + v + ' tidak diizinkan');
        const fx = r.fixed[weekday(s.period, d)];
        if (fx && fx !== v) note(d, 'seharusnya selalu ' + ((shiftOf(s, fx) || {}).name || fx) + ' setiap ' + WEEKDAYS[weekday(s.period, d)]);
        if (r.offDays.includes(weekday(s.period, d))) note(d, 'masuk pada hari libur tetap (' + WEEKDAYS[weekday(s.period, d)] + ')');
        if (r.unavailable.includes(d)) note(d, 'masuk pada tanggal tidak tersedia');
        if (r.maxRun && run === r.maxRun + 1) note(d, 'lebih dari ' + r.maxRun + ' hari berturut-turut');
        if (r.maxMonth && x.work === r.maxMonth + 1) note(d, 'lebih dari ' + r.maxMonth + ' hari dalam sebulan');
        if (r.maxWeek) {
          let n = 0;
          for (let y = Math.max(1, weekStart(s.period, d)); y <= d; y++) if (isWork(a[y])) n++;
          if (n === r.maxWeek + 1) note(d, 'lebih dari ' + r.maxWeek + ' hari dalam seminggu');
        }
        const qd = quotaFor(s, r, d).q;
        if (v in qd) {
          let n = 0;
          for (let y = Math.max(1, weekStart(s.period, d)); y <= d; y++) if (a[y] === v) n++;
          if (n === qd[v] + 1) note(d, (shf ? shf.name : v) + ' lebih dari ' + qd[v] + ' kali dalam seminggu');
        }
      }
      issues += x.issues.length;
      byEmp[e] = x;
    }
    return { byDay, byEmp, short, under: underTotal, issues };
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
    daysIn, weekday, weeksOf, idOf, hours, parseDays, fmtDays, blank, normalize, ruleOf, describeRule, needOf, quotaFor, generate, check, validate, payload, allowed,

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

    /** PDF A4 landscape: tabel jadwal berwarna per shift, jumlah petugas per hari, keterangan shift. */
    async pdf(s, empMap) {
      const N = daysIn(s.period);
      const C = check(s);
      const rgb = (hex) => [1, 3, 5].map((i) => parseInt(String(hex || '#6b7280').slice(i, i + 2), 16) || 0);
      const tint = (hex, k) => rgb(hex).map((v) => Math.round(v + (255 - v) * k));
      const dayHead = [];
      for (let d = 1; d <= N; d++) dayHead.push(d + '\n' + WD3[weekday(s.period, d)]);
      const sundayCol = (i) => i >= 1 && i <= N && weekday(s.period, i) === 0;
      const colorCells = (data) => {
        const i = data.column.index;
        if (i >= 1 && i <= N && weekEdge(s.period, i)) data.cell.styles.lineWidth = Object.assign({ top: 0.1, right: 0.1, bottom: data.section === 'body' ? 0.35 : 0.1 }, { left: 0.7 });
        else if (data.section === 'body') data.cell.styles.lineWidth = { top: 0.1, right: 0.1, left: 0.1, bottom: 0.35 };
        if (data.section === 'head' && sundayCol(i)) data.cell.styles.textColor = [254, 202, 202];
        if (data.section !== 'body' || i < 1 || i > N) return;
        const v = data.cell.raw;
        const sh = shiftOf(s, v);
        if (sh) {
          data.cell.styles.fillColor = tint(sh.color, 0.78);
          data.cell.styles.textColor = rgb(sh.color).map((x) => Math.round(x * 0.6));
          data.cell.styles.fontStyle = 'bold';
        } else if (v === OFF) data.cell.styles.textColor = [148, 163, 184];
        else if (typeof v === 'string' && v.includes('/') && data.row.raw && data.row.raw.short && data.row.raw.short[i]) data.cell.styles.textColor = [220, 38, 38];
      };
      const base = { styles: { fontSize: 6.4, cellPadding: 0.7, halign: 'center', valign: 'middle', lineColor: [203, 213, 225], lineWidth: 0.1, overflow: 'linebreak' }, headStyles: { fillColor: [0, 107, 42], textColor: 255, fontStyle: 'bold', fontSize: 6.2, halign: 'center' }, alternateRowStyles: { fillColor: [244, 246, 249] }, columnStyles: { 0: { halign: 'left', cellWidth: 36, fontSize: 6.8 } }, margin: { left: 8, right: 8 }, didParseCell: colorCells };
      const body = s.config.employees.map((e) => {
        const emp = empMap.get(e) || { name: e, position: '' };
        const row = [emp.name + (emp.position ? '\n' + emp.position : '')];
        for (let d = 1; d <= N; d++) row.push(((s.assignments[e] || {})[d]) || '');
        row.push(C.byEmp[e].work, C.byEmp[e].off);
        return row;
      });
      const counts = s.config.shifts.map((sh) => {
        const row = [sh.code + ' · ' + sh.name];
        const short = {};
        for (let d = 1; d <= N; d++) {
          const b = C.byDay[d];
          row.push(b.closed ? '–' : (b.count[sh.code] || 0) + '/' + b.need[sh.code]);
          if (!b.closed && b.short[sh.code]) short[d] = true;
        }
        row.push('', '');
        row.short = short;
        return row;
      });
      const set = (NP.state && NP.state.settings) || {};
      return NP.exp.pdfTable({
        orientation: 'landscape',
        unit: s.unit === 'APT' ? 'APT' : 'KLINIK',
        headerName: s.unit === 'ALL' ? (set.company && set.company.name) || undefined : undefined,
        title: 'JADWAL MASUK — ' + u.periodLabel(s.period).toUpperCase(),
        subtitle: UNITS[s.unit] + ' · ' + s.config.employees.length + ' karyawan' + (s.version ? ' · versi ' + s.version : '') + (s.dirty ? ' · BELUM DISIMPAN' : ''),
        sections: [
          {
            body,
            tableOpts: Object.assign({}, base, {
              head: [
                [{ content: 'Karyawan', rowSpan: 2, styles: { valign: 'bottom', halign: 'left' } }].concat(weeksOf(s.period).map((w) => ({ content: (w.to - w.from + 1 <= 2 ? 'Mg ' : 'Minggu ') + w.no, colSpan: w.to - w.from + 1, styles: { fillColor: w.no % 2 ? [0, 107, 42] : [0, 84, 33] } })), [{ content: 'Masuk', rowSpan: 2 }, { content: 'Libur', rowSpan: 2 }]),
                dayHead
              ]
            })
          },
          { title: 'Jumlah petugas per hari (terisi/ideal)', head: ['Shift'].concat(dayHead, ['', '']), body: counts, tableOpts: base },
          { title: 'Keterangan', head: ['Kode', 'Nama shift', 'Jam', 'Lama (jam)', 'Ideal / minimal'], body: s.config.shifts.map((sh) => [sh.code, sh.name, sh.start + '–' + sh.end, hours(sh), sh.min === undefined || sh.min === null ? 'sesuai kebutuhan' : 'minimal ' + sh.min + ' bila ada yang libur']).concat([[OFF, 'Libur', '', '', '']]), tableOpts: { styles: { fontSize: 7.5, cellPadding: 1.2 }, tableWidth: 160, margin: { left: 8 } } }
        ],
        filename: 'jadwal-masuk-' + s.period + '-' + s.unit.toLowerCase() + '.pdf'
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
  const st = { period: null, unit: 'ALL', tab: 'grid', brush: null, mode: 'fair', keepManual: true, manualOffWeek: true };

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
          <button type="button" class="btn btn-ghost" data-act="pdf">${ui.icon('pdf')}<span>PDF</span></button>
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
        r.short ? `<span class="flag flag-zero">Kurang ${r.short} petugas dari minimal</span>` : s.config.employees.length ? `<span class="flag flag-done">${r.under ? 'Minimal terpenuhi' : 'Kebutuhan terpenuhi'}</span>` : '',
        r.under ? `<span class="flag flag-low" title="Shift yang dijaga kurang dari jumlah ideal tetapi masih memenuhi minimal">${r.under} di bawah ideal</span>` : '',
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
        head.push(`<th class="sch-d ${w === 0 ? 'sun' : ''} ${weekEdge(s.period, d) ? 'wk' : ''} ${b.closed ? 'closed' : ''} ${b.custom ? 'custom' : ''}" title="${WEEKDAYS[w]}, ${d}${b.closed ? ' — tutup' : ''}"><span>${d}</span><small>${WD3[w]}</small></th>`);
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
          cells.push(`<td class="sch-c ${v === OFF ? 'off' : ''} ${weekEdge(s.period, d) ? 'wk' : ''} ${closed ? 'closed' : ''} ${bad.has(d) ? 'bad' : ''}"><button type="button" data-e="${u.esc(e)}" data-d="${d}" ${sh ? `style="--sc:${u.esc(sh.color)}"` : ''} class="${sh ? 'on' : ''} ${man ? 'man' : ''}" title="${u.esc(emp.name)} · ${d} ${WD3[weekday(s.period, d)]}${sh ? ' · ' + u.esc(sh.name) + ' ' + sh.start + '–' + sh.end : v === OFF ? ' · Libur' : ''}${man ? ' · diisi manual' : ''}${bad.has(d) ? ' · ' + u.esc(bad.get(d)) : ''}" ${canEdit ? '' : 'disabled'}>${u.esc(v)}</button></td>`);
        }
        const perWeek = weeksOf(s.period).map((w) => {
          const v = [];
          for (let d = w.from; d <= w.to; d++) v.push((s.assignments[e] || {})[d]);
          const sh = s.config.shifts.map((x) => v.filter((c) => c === x.code).length + x.code).join(' ');
          return 'Mg ' + w.no + ': ' + sh + ' ' + v.filter((c) => c === OFF).length + 'L';
        });
        return `<tr><th class="sch-name" scope="row" title="${u.esc(perWeek.join('\n'))}"><b>${u.esc(emp.name)}</b><small>${u.esc(emp.position || '')}</small></th>${cells.join('')}
          <td class="sch-tot"><b>${x.work}</b></td><td class="sch-tot">${x.off}</td><td class="sch-tot">${u.num(Math.round(x.hours))}</td></tr>`;
      });
      const foot = s.config.shifts.map((sh) => {
        const c = [];
        for (let d = 1; d <= N; d++) {
          const b = r.byDay[d];
          const n = b.count[sh.code] || 0;
          c.push(`<td class="sch-f ${weekEdge(s.period, d) ? 'wk' : ''} ${b.closed ? 'closed' : b.short[sh.code] ? 'short' : b.under[sh.code] ? 'under' : ''}" title="${sh.name} tanggal ${d}: ${n} orang · ideal ${b.closed ? 'tutup' : b.need[sh.code]}${!b.closed && b.min[sh.code] < b.need[sh.code] ? ', minimal ' + b.min[sh.code] : ''}">${b.closed ? '–' : n + '/' + b.need[sh.code]}</td>`);
        }
        return `<tr><th class="sch-name" scope="row"><span class="sch-key" style="--sc:${u.esc(sh.color)}">${u.esc(sh.code)}</span> ${u.esc(sh.name)}</th>${c.join('')}<td colspan="3"></td></tr>`;
      });
      const issueList = [];
      for (const e of emps) for (const i of r.byEmp[e].issues) issueList.push(`${u.esc((empMap.get(e) || {}).name || e)}: tanggal ${i.day} — ${u.esc(i.msg)}`);
      const shortList = [];
      for (let d = 1; d <= N; d++) for (const [c, k] of Object.entries(r.byDay[d].short)) shortList.push(`Tanggal ${d} (${WD3[weekday(s.period, d)]}): ${c} kurang ${k} dari minimal`);

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
              <label class="check" title="Bila Anda menandai libur (L) secara manual, karyawan itu tidak diberi libur acak lagi pada minggu yang sama"><input type="checkbox" id="sc-offweek" ${st.manualOffWeek ? 'checked' : ''} ${st.keepManual ? '' : 'disabled'}><span>Libur manual menggantikan libur acak (minggu itu)</span></label>
              <button type="button" class="btn btn-ghost btn-sm" data-act="clear">${ui.icon('trash')}<span>Kosongkan jadwal</span></button>
            </div>
          </div>
          <p class="muted small">Sel bertitik = diisi manual (dipertahankan saat <b>Buat jadwal acak</b> bila dicentang). Sel merah melanggar ketentuan karyawan. Angka bawah = terisi/ideal per shift: <span class="txt-warn">oranye</span> di bawah ideal tetapi masih memenuhi minimal, <span class="txt-danger">merah</span> di bawah minimal.</p>` : ''}
          <div class="sch-wrap"><table class="sch-grid"><thead><tr class="sch-wkrow"><th class="sch-name" rowspan="2">Karyawan</th>${weeksOf(s.period).map((w) => `<th class="sch-wk ${w.no % 2 ? '' : 'alt'} ${w.from > 1 ? 'wk' : ''}" colspan="${w.to - w.from + 1}" title="Minggu ${w.no}: tanggal ${w.from}–${w.to}">${w.to - w.from + 1 <= 2 ? 'Mg ' + w.no : 'Minggu ' + w.no + `<small>${w.from}–${w.to}</small>`}</th>`).join('')}<th class="sch-tot" rowspan="2" title="Hari masuk">Masuk</th><th class="sch-tot" rowspan="2" title="Hari libur">Libur</th><th class="sch-tot" rowspan="2" title="Total jam">Jam</th></tr><tr class="sch-dayrow">${head.join('')}</tr></thead>
            <tbody>${rows.join('')}</tbody><tfoot>${foot.join('')}</tfoot></table></div>
          ${shortList.length || issueList.length ? `<div class="sch-notes">
            ${shortList.length ? `<div class="alert alert-warning">${ui.icon('warn')}<div><b>Di bawah jumlah minimal (${shortList.length})</b><ul>${shortList.slice(0, 8).map((x) => `<li>${x}</li>`).join('')}</ul>${shortList.length > 8 ? `<small>dan ${shortList.length - 8} lainnya</small>` : ''}<small class="block">Tambah karyawan, longgarkan ketentuan, atau kurangi kebutuhan pada tab <b>Shift &amp; kebutuhan per hari</b>.</small></div></div>` : ''}
            ${issueList.length ? `<div class="alert alert-info">${ui.icon('info')}<div><b>Melanggar ketentuan karyawan (${issueList.length})</b><ul>${issueList.slice(0, 8).map((x) => `<li>${x}</li>`).join('')}</ul>${issueList.length > 8 ? `<small>dan ${issueList.length - 8} lainnya</small>` : ''}</div></div>` : ''}
          </div>` : ''}`
          : ui.empty('Belum ada karyawan di jadwal ini. Pilih karyawan pada tab <b>Karyawan &amp; ketentuan</b>.', 'users')}
        </div>`;
    }

    /* ----------------------- Tab Karyawan & ketentuan ----------------------- */
    function drawPeople() {
      const inSet = new Set(s.config.employees);
      const list = pool.concat(s.config.employees.filter((e) => !pool.some((p) => p.id === e)).map((e) => empMap.get(e) || { id: e, name: e + ' (tidak ditemukan)', position: '' }));
      const num = (key, val, max, label) => `<input type="number" min="0" max="${max}" data-rn="${key}" value="${val || ''}" placeholder="—" ${dis} aria-label="${label}">`;
      const dis = !canEdit ? 'disabled' : '';
      /** Peringatan bila ketentuan saling bertabrakan. */
      const hints = (r) => {
        const h = [];
        const qsum = Object.values(r.quota).reduce((a, n) => a + n, 0);
        if (r.maxWeek && qsum > r.maxWeek) h.push(`Pembagian per minggu (${qsum} hari) melebihi batas masuk ${r.maxWeek} hari per minggu.`);
        if (r.maxOff) {
          let fixedOff = 0;
          for (let d = 1; d <= N; d++) if (r.offDays.includes(weekday(s.period, d)) || r.unavailable.includes(d)) fixedOff++;
          let weekOff = 0;
          if (r.maxWeek) for (let ws = 1 - ((weekday(s.period, 1) + 6) % 7); ws <= N; ws += 7) weekOff += Math.max(0, Math.min(N, ws + 6) - Math.max(1, ws) + 1 - r.maxWeek);
          const runOff = r.maxRun ? Math.floor(N / (r.maxRun + 1)) : 0;
          const qOff = qsum ? Math.max(0, N - Math.round((qsum * N) / 7)) : 0;
          const minOff = Math.max(fixedOff, weekOff, runOff, qOff);
          if (minOff > r.maxOff) {
            const why = minOff === fixedOff ? 'libur tetap & tanggal tidak bisa' : minOff === weekOff ? 'batas masuk ' + r.maxWeek + ' hari per minggu' : minOff === runOff ? 'batas ' + r.maxRun + ' hari berturut-turut' : 'pembagian per minggu';
            h.push(`Libur paling banyak ${r.maxOff} hari tidak mungkin terpenuhi: ${why} membuat libur minimal ±${minOff} hari bulan ini. Kosongkan/ubah ketentuan tersebut.`);
          }
        }
        return h;
      };
      const row = (e) => {
        const r = ruleOf(s, e.id);
        const on = inSet.has(e.id);
        const h = on ? hints(r) : [];
        return `<div class="sch-p ${on ? 'in' : 'sch-out'}" data-emp="${u.esc(e.id)}">
          <label class="sch-p-head"><input type="checkbox" data-inc="${u.esc(e.id)}" ${on ? 'checked' : ''} ${dis} aria-label="Masukkan ${u.esc(e.name)} ke jadwal">
            <span><b>${u.esc(e.name)}</b><small>${u.esc(e.position || '')}${e.unit ? ' · ' + u.esc(C.EMP_UNITS[e.unit] || e.unit) : ''}</small></span></label>
          ${on ? `<div class="sch-p-rules">
            <div class="sch-rg">
              <div class="sch-line"><span class="sch-lbl">Boleh masuk shift</span><div class="sch-val chips">${s.config.shifts.map((sh) => `<label class="chip-check"><input type="checkbox" data-rs="${u.esc(sh.code)}" ${!Array.isArray(r.shifts) || r.shifts.includes(sh.code) ? 'checked' : ''} ${dis}><span title="${u.esc(sh.name)}">${u.esc(sh.name)}</span></label>`).join('')}</div></div>
              <div class="sch-line"><span class="sch-lbl">Selalu libur setiap</span><div class="sch-val chips">${[1, 2, 3, 4, 5, 6, 0].map((w) => `<label class="chip-check off"><input type="checkbox" data-ro="${w}" ${r.offDays.includes(w) ? 'checked' : ''} ${dis}><span title="${WEEKDAYS[w]}">${WD3[w]}</span></label>`).join('')}</div></div>
              <div class="sch-line"><span class="sch-lbl">Pembagian per minggu</span><div class="sch-val sch-q">${s.config.shifts.map((sh) => `<label><input type="number" min="0" max="7" data-rq="${u.esc(sh.code)}" value="${sh.code in r.quota ? r.quota[sh.code] : ''}" placeholder="–" ${dis} aria-label="Jumlah ${u.esc(sh.name)} per minggu"><span>× ${u.esc(sh.name)}</span></label>`).join('<span class="muted">+</span>')}<small class="muted">kosong = bebas</small></div></div>
              <div class="sch-line"><span class="sch-lbl">Selalu shift tertentu pada hari</span><div class="sch-val sch-fixed">${[1, 2, 3, 4, 5, 6, 0].map((w) => `<label class="${r.fixed[w] ? 'on' : ''}"><small>${WD3[w]}</small><select data-rf="${w}" ${dis} aria-label="Shift tetap setiap ${WEEKDAYS[w]}" title="${r.fixed[w] ? u.esc((shiftOf(s, r.fixed[w]) || {}).name || '') : 'bebas'}"><option value="">–</option>${s.config.shifts.map((sh) => `<option value="${u.esc(sh.code)}" ${r.fixed[w] === sh.code ? 'selected' : ''}>${u.esc(sh.code)}</option>`).join('')}</select></label>`).join('')}<small class="muted sch-fixed-note">– = bebas · ${s.config.shifts.map((sh) => u.esc(sh.code) + ' = ' + u.esc(sh.name)).join(' · ')}</small></div></div>
              <div class="sch-line"><span class="sch-lbl">Bila ada karyawan lain libur</span><div class="sch-val"><select data-rb ${dis} aria-label="Prioritas bila ada yang libur"><option value="">tidak ada prioritas</option>${s.config.shifts.map((sh) => `<option value="${u.esc(sh.code)}" ${r.backup === sh.code ? 'selected' : ''}>prioritas masuk ${u.esc(sh.name)}</option>`).join('')}</select></div></div>
            </div>
            <div class="sch-rg">
              <label class="sch-line"><span class="sch-lbl">Libur paling banyak</span><span class="sch-val">${num('maxOff', r.maxOff, 31, 'Libur paling banyak per bulan')}<span>hari dalam sebulan</span></span></label>
              <label class="sch-line"><span class="sch-lbl">Masuk paling banyak</span><span class="sch-val">${num('maxWeek', r.maxWeek, 7, 'Masuk paling banyak per minggu')}<span>hari per minggu</span></span></label>
              <label class="sch-line"><span class="sch-lbl">Masuk berturut-turut paling lama</span><span class="sch-val">${num('maxRun', r.maxRun, 31, 'Masuk berturut-turut paling lama')}<span>hari</span></span></label>
              <label class="sch-line"><span class="sch-lbl">Masuk paling banyak</span><span class="sch-val">${num('maxMonth', r.maxMonth, 31, 'Masuk paling banyak per bulan')}<span>hari dalam sebulan</span></span></label>
              <label class="sch-line"><span class="sch-lbl">Tidak bisa masuk tanggal</span><span class="sch-val"><input data-ru value="${u.esc(fmtDays(r.unavailable))}" placeholder="mis. 3, 10-12" ${dis} aria-label="Tanggal tidak bisa masuk"></span></label>
            </div>
            <div class="sch-sum"><span>${ui.icon('info')} <b>Ringkasan:</b> ${u.esc(describeRule(s, r))}</span>${canEdit && s.config.employees.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-copyrule>${ui.icon('copy')}<span>Salin ketentuan ke…</span></button>` : ''}</div>
            ${h.length ? `<div class="sch-hint">${ui.icon('warn')}<div>${h.map(u.esc).join('<br>')}</div></div>` : ''}
          </div>` : ''}
        </div>`;
      };
      const nIn = list.filter((e) => inSet.has(e.id)).length;
      body.innerHTML = `
        <div class="card">
          <div class="card-head"><h3>Karyawan yang dimasukkan ke jadwal <small class="muted">${nIn} dari ${list.length}</small></h3>
            ${canEdit ? `<div class="actions"><button type="button" class="btn btn-ghost btn-sm" data-act="all-in">Pilih semua</button><button type="button" class="btn btn-ghost btn-sm" data-act="all-out">Kosongkan pilihan</button></div>` : ''}</div>
          <p class="muted small">Centang karyawan yang masuk jadwal ${u.esc(UNITS[st.unit].toLowerCase())}, lalu isi ketentuannya. Kotak angka yang kosong berarti <b>tanpa batas</b>. Ketentuan dipakai saat <b>Buat jadwal acak</b>, dan sel yang melanggar ditandai merah di tab Jadwal.</p>
          <details class="sch-help"><summary>${ui.icon('info')} Contoh pengisian</summary>
            <ul>
              <li><b>Libur maksimal 2 hari per bulan</b> → isi <i>Libur paling banyak</i> = 2, lalu kosongkan <i>Masuk paling banyak … per minggu</i> dan <i>Masuk berturut-turut</i> (batas itu memaksa libur lebih sering).</li>
              <li><b>Per minggu 3 kali Pagi dan 3 kali Siang</b> → isi <i>Pembagian per minggu</i>: 3 × Pagi + 3 × Siang (otomatis 1 hari libur per minggu).</li>
              <li><b>Selalu libur hari Minggu</b> → pilih <i>Min</i> pada <i>Selalu libur setiap</i>.</li>
              <li><b>Selalu Pagi setiap Senin</b> (atau Siang/Malam hari tertentu) → pada <i>Selalu shift tertentu pada hari</i>, pilih Pagi di kolom <i>Sen</i>.</li>
              <li><b>Bila ada yang libur, karyawan ini diutamakan masuk Pagi</b> → pilih <i>prioritas masuk Pagi</i> pada <i>Bila ada karyawan lain libur</i>.</li>
              <li><b>Cuti tanggal 10 sampai 12</b> → isi <i>Tidak bisa masuk tanggal</i> = 10-12.</li>
              <li><b>Siang cukup 1 orang bila ada yang libur</b> → di tab <i>Shift &amp; kebutuhan per hari</i>, isi kolom <i>Minimal bila ada yang libur</i> untuk Siang = 1.</li>
            </ul>
            <p class="muted small">Gunakan <b>Salin ketentuan ke…</b> lalu pilih karyawan tujuan agar ketentuan yang sama berlaku untuk mereka (tanggal tidak bisa masuk tidak ikut disalin).</p>
          </details>
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
          <td data-label="Terisi">${nd.closed ? '<span class="muted">—</span>' : s.config.shifts.map((sh) => `<span class="${nd.short[sh.code] ? 'txt-danger' : nd.under[sh.code] ? 'txt-warn' : 'muted'}">${u.esc(sh.code)} ${nd.count[sh.code] || 0}/${nd.need[sh.code]}</span>`).join(' ')}</td>
          <td>${nd.custom && canEdit ? `<button type="button" class="btn btn-ghost btn-sm" data-dreset title="Kembali ke pola mingguan" aria-label="Kembali ke pola mingguan">${ui.icon('refresh')}</button>` : ''}</td>
        </tr>`);
      }
      body.innerHTML = `
        <div class="card">
          <div class="card-head"><h3>Shift</h3>${canEdit ? `<button type="button" class="btn btn-ghost btn-sm" data-act="add-shift" ${s.config.shifts.length >= 12 ? 'disabled' : ''}>${ui.icon('plus')}<span>Tambah shift</span></button>` : ''}</div>
          <p class="muted small">Kode 1–3 huruf/angka (mis. P, S, M, PS). Kode <b>L</b> dipakai untuk libur. Shift yang melewati tengah malam (mis. 21:00–07:00) dihitung benar. <b>Minimal bila ada yang libur</b>: jumlah orang yang masih boleh menjaga shift bila tidak cukup orang (mis. kebutuhan Siang 2, minimal 1 → bila ada yang libur, Siang cukup dijaga 1 orang). Kosong = harus sesuai kebutuhan.</p>
          <div class="table-wrap table-cards"><table class="tbl sch-shifts"><thead><tr><th>Kode</th><th>Nama</th><th>Mulai</th><th>Selesai</th><th>Jam</th><th>Minimal bila ada yang libur</th><th>Warna</th><th></th></tr></thead><tbody>
            ${s.config.shifts.map((sh, i) => `<tr data-si="${i}">
              <td data-label="Kode"><input data-sf="code" value="${u.esc(sh.code)}" maxlength="3" class="sch-code" ${dis} aria-label="Kode shift"></td>
              <td data-label="Nama"><input data-sf="name" value="${u.esc(sh.name)}" maxlength="30" ${dis} aria-label="Nama shift"></td>
              <td data-label="Mulai"><input type="time" data-sf="start" value="${u.esc(sh.start)}" ${dis} aria-label="Jam mulai"></td>
              <td data-label="Selesai"><input type="time" data-sf="end" value="${u.esc(sh.end)}" ${dis} aria-label="Jam selesai"></td>
              <td data-label="Jam">${u.num(hours(sh), 1)}</td>
              <td data-label="Minimal bila ada yang libur"><input type="number" min="0" max="50" data-sf="min" value="${sh.min === undefined || sh.min === null ? '' : sh.min}" placeholder="= kebutuhan" ${dis} aria-label="Minimal ${u.esc(sh.name)} bila ada yang libur" class="sch-min"></td>
              <td data-label="Warna"><input type="color" data-sf="color" value="${u.esc(sh.color)}" ${dis} aria-label="Warna shift"></td>
              <td>${canEdit && s.config.shifts.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-delshift="${i}" title="Hapus shift" aria-label="Hapus shift ${u.esc(sh.code)}">${ui.icon('trash')}</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Kebutuhan petugas per hari (pola mingguan)</h3></div>
          <p class="muted small">Jumlah petugas <b>ideal</b> setiap shift menurut hari. Jadwal acak mengisi sampai jumlah ini; bila tidak cukup orang, cukup sampai <b>minimal</b> yang diatur pada tabel Shift. Isi 0 pada semua shift untuk hari yang tutup.</p>
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
    /** Gambar ulang tab tanpa melompat ke atas: posisi gulir halaman & tabel serta kolom yang
     *  sedang diisi (mis. setelah Tab ke kolom berikutnya) dipertahankan. */
    const focusKey = (el) => {
      if (!el || !body.contains(el) || el === body) return null;
      const box = el.closest('[data-emp],[data-si],[data-day]');
      const attr = ['data-rn', 'data-rq', 'data-rf', 'data-rb', 'data-ru', 'data-rs', 'data-ro', 'data-inc', 'data-sf', 'data-dn', 'data-dc', 'data-wn', 'data-e'].find((x) => el.hasAttribute(x));
      if (!attr) return null;
      const esc = (v) => (root.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));
      const own = '[' + attr + '="' + esc(el.getAttribute(attr)) + '"]' + (attr === 'data-e' ? '[data-d="' + el.dataset.d + '"]' : '');
      if (!box) return own;
      const k = ['data-emp', 'data-si', 'data-day'].find((x) => box.hasAttribute(x));
      return '[' + k + '="' + esc(box.getAttribute(k)) + '"] ' + own;
    };
    let pending = null;
    function rerender(fn) {
      pending = fn;
      setTimeout(() => {
        if (pending !== fn) return;
        pending = null;
        const y = window.scrollY;
        const wrap = body.querySelector('.sch-wrap');
        const sx = wrap ? wrap.scrollLeft : 0;
        const key = focusKey(document.activeElement);
        fn();
        const w2 = body.querySelector('.sch-wrap');
        if (w2) w2.scrollLeft = sx;
        if (key) {
          const el = body.querySelector(key);
          if (el) el.focus({ preventScroll: true });
        }
        window.scrollTo(0, y);
      }, 0);
    }
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
        rerender(drawGrid);
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
          rerender(drawGrid);
        });
        return;
      }
      const all = ev.target.closest('[data-act="all-in"],[data-act="all-out"]');
      if (all) {
        s.config.employees = all.dataset.act === 'all-in' ? [...new Set(s.config.employees.concat(pool.map((e) => e.id)))] : [];
        markDirty();
        rerender(drawPeople);
        return;
      }
      if (ev.target.closest('[data-act="add-shift"]')) {
        const used = new Set(codes(s));
        const code = ['M', 'PS', 'SM', 'X', 'Y', 'Z'].find((c) => !used.has(c)) || 'S' + s.config.shifts.length;
        s.config.shifts.push({ code, name: code === 'M' ? 'Malam' : 'Shift ' + code, start: '21:00', end: '07:00', color: PALETTE[s.config.shifts.length % PALETTE.length] });
        markDirty();
        rerender(drawNeeds);
        return;
      }
      const cp = ev.target.closest('[data-copyrule]');
      if (cp) {
        const src = cp.closest('[data-emp]').dataset.emp;
        const others = s.config.employees.filter((e) => e !== src);
        const nm = (e) => (empMap.get(e) || {}).name || e;
        const m = ui.modal({
          title: 'Salin ketentuan',
          size: 'md',
          body: `<p>Salin ketentuan <b>${u.esc(nm(src))}</b>:</p>
            <p class="sch-sum">${u.esc(describeRule(s, ruleOf(s, src)))}</p>
            <p class="muted small">Pilih karyawan tujuan. Tanggal tidak bisa masuk milik masing-masing karyawan tidak ikut diubah.</p>
            <label class="check"><input type="checkbox" id="cp-all"><span><b>Pilih semua</b></span></label>
            <div class="sch-cplist">${others.map((e) => `<label class="check"><input type="checkbox" data-cpto="${u.esc(e)}"><span>${u.esc(nm(e))}<small class="block muted">${u.esc((empMap.get(e) || {}).position || '')} · ${u.esc(describeRule(s, ruleOf(s, e)))}</small></span></label>`).join('')}</div>
            <div class="form-error" hidden></div>`,
          actions: [
            { label: 'Batal', cls: 'btn-ghost', onClick: (mm) => mm.close() },
            {
              label: 'Salin ketentuan', cls: 'btn-primary', icon: 'copy', onClick: (mm) => {
                const to = [...mm.el.querySelectorAll('[data-cpto]:checked')].map((x) => x.dataset.cpto);
                if (!to.length) {
                  const er = mm.el.querySelector('.form-error');
                  er.hidden = false;
                  er.textContent = 'Pilih minimal satu karyawan tujuan.';
                  return;
                }
                const base = clone(s.config.rules[src] || {});
                delete base.unavailable;
                for (const e of to) s.config.rules[e] = Object.assign(clone(base), { unavailable: ((s.config.rules[e] || {}).unavailable || []).slice() });
                mm.close();
                markDirty();
                rerender(drawPeople);
                ui.toast('Ketentuan ' + nm(src) + ' disalin ke ' + to.length + ' karyawan: ' + to.map(nm).join(', ') + '.');
              }
            }
          ]
        });
        m.el.querySelector('#cp-all').onchange = (x) => m.el.querySelectorAll('[data-cpto]').forEach((c) => (c.checked = x.target.checked));
        m.el.addEventListener('change', (x) => {
          if (!x.target.dataset.cpto) return;
          const all = [...m.el.querySelectorAll('[data-cpto]')];
          m.el.querySelector('#cp-all').checked = all.every((c) => c.checked);
        });
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
          rerender(drawNeeds);
        });
        return;
      }
      const rs = ev.target.closest('[data-dreset]');
      if (rs) {
        delete s.config.days[rs.closest('tr').dataset.day];
        markDirty();
        rerender(drawNeeds);
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
        return rerender(drawPeople);
      }
      const emp = tr && tr.dataset.emp;
      if (emp && t.dataset.rs) {
        const on = [...tr.querySelectorAll('[data-rs]')].filter((x) => x.checked).map((x) => x.dataset.rs);
        setRule(emp, { shifts: on.length === s.config.shifts.length ? null : on });
        if (!on.length) ui.toast('Karyawan tanpa shift yang boleh tidak akan dijadwalkan otomatis.', 'warning');
        return rerender(drawPeople);
      }
      if (emp && t.dataset.ro !== undefined) {
        setRule(emp, { offDays: [...tr.querySelectorAll('[data-ro]')].filter((x) => x.checked).map((x) => +x.dataset.ro) });
        return rerender(drawPeople);
      }
      if (emp && t.dataset.rn) {
        setRule(emp, { [t.dataset.rn]: Math.max(0, u.toInt(t.value) || 0) });
        return rerender(drawPeople);
      }
      if (emp && t.dataset.rf !== undefined) {
        const fx = Object.assign({}, ruleOf(s, emp).fixed);
        if (t.value) fx[t.dataset.rf] = t.value;
        else delete fx[t.dataset.rf];
        setRule(emp, { fixed: fx });
        return rerender(drawPeople);
      }
      if (emp && t.dataset.rb !== undefined) {
        setRule(emp, { backup: t.value });
        return rerender(drawPeople);
      }
      if (emp && t.dataset.rq) {
        const q = Object.assign({}, ruleOf(s, emp).quota);
        if (t.value === '') delete q[t.dataset.rq];
        else q[t.dataset.rq] = Math.max(0, Math.min(7, u.toInt(t.value) || 0));
        setRule(emp, { quota: q });
        return rerender(drawPeople);
      }
      if (emp && t.dataset.ru !== undefined) {
        const list = parseDays(t.value, N);
        setRule(emp, { unavailable: list });
        return rerender(drawPeople);
      }
      if (t.dataset.sf) {
        const i = +tr.dataset.si;
        const sh = s.config.shifts[i];
        let v = t.value.trim();
        if (t.dataset.sf === 'min') {
          if (v === '') delete sh.min;
          else sh.min = Math.max(0, u.toInt(v) || 0);
          markDirty();
          return rerender(drawNeeds);
        }
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
          for (const r of Object.values(s.config.rules)) {
            if (Array.isArray(r.shifts)) r.shifts = r.shifts.map((c) => (c === old ? v : c));
            if (r.quota && old in r.quota) {
              r.quota[v] = r.quota[old];
              delete r.quota[old];
            }
            for (const w of Object.keys(r.fixed || {})) if (r.fixed[w] === old) r.fixed[w] = v;
            if (r.backup === old) r.backup = v;
          }
          if (st.brush === old) st.brush = v;
        }
        sh[t.dataset.sf] = v;
        markDirty();
        return rerender(drawNeeds);
      }
      if (t.dataset.wn) {
        const [w, c] = t.dataset.wn.split('|');
        s.config.weekly[w] = Object.assign({}, s.config.weekly[w] || {}, { [c]: Math.max(0, u.toInt(t.value) || 0) });
        markDirty();
        return rerender(drawNeeds);
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
        return rerender(drawNeeds);
      }
      if (t.id === 'sc-mode') st.mode = t.value;
      if (t.id === 'sc-keep') {
        st.keepManual = t.checked;
        const o = body.querySelector('#sc-offweek');
        if (o) o.disabled = !t.checked;
      }
      if (t.id === 'sc-offweek') st.manualOffWeek = t.checked;
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
      if (a.dataset.act === 'pdf') {
        if (!s.config.employees.length) return ui.toast('Jadwal masih kosong.', 'error');
        ui.busy('Membuat PDF jadwal…', () => sched.pdf(s, empMap)).catch((e) => ui.toast(e.message, 'error'));
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
        const g = generate(s, { mode: st.mode, keepManual: st.keepManual, manualOffWeek: st.manualOffWeek, seed: (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0 });
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
    for (let d = 1; d <= N; d++) head.push(`<th class="${weekday(s.period, d) === 0 ? 'sun' : ''} ${weekEdge(s.period, d) ? 'wk' : ''}">${d}<br><small>${WD3[weekday(s.period, d)]}</small></th>`);
    const rows = s.config.employees.map((e) => {
      const emp = empMap.get(e) || { name: e, position: '' };
      const c = [];
      for (let d = 1; d <= N; d++) {
        const v = (s.assignments[e] || {})[d] || '';
        const sh = shiftOf(s, v);
        c.push(`<td class="${v === OFF ? 'off' : ''} ${weekday(s.period, d) === 0 ? 'sun' : ''} ${weekEdge(s.period, d) ? 'wk' : ''}" ${sh ? `style="background:${u.esc(sh.color)}22"` : ''}>${u.esc(v)}</td>`);
      }
      return `<tr><td class="nm"><b>${u.esc(emp.name)}</b><br><small>${u.esc(emp.position || '')}</small></td>${c.join('')}<td>${r.byEmp[e].work}</td><td>${r.byEmp[e].off}</td></tr>`;
    });
    return `<style>@page{size:A4 landscape;margin:8mm}.sch-print{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:9px}.sch-print h1{font-size:15px;margin:0 0 2px}.sch-print p{margin:0 0 6px;color:#444}.sch-print table{border-collapse:collapse;width:100%}.sch-print th,.sch-print td{border:1px solid #bbb;padding:2px 1px;text-align:center}.sch-print td.nm{text-align:left;white-space:nowrap;padding:2px 4px}.sch-print .off{color:#888}.sch-print .sun{background:#fef2f2}.sch-print .wk{border-left:2px solid #006b2a}.sch-print tbody tr{border-bottom:2px solid #94a3b8}.sch-print tbody tr td{border-bottom:1.5px solid #94a3b8}.sch-print tbody tr:nth-child(even) td.nm{background:#f1f5f9}.sch-print .lg{margin-top:6px}.sch-print .lg span{margin-right:12px}</style>
      <div class="sch-print"><h1>Jadwal Masuk — ${u.esc(company)}</h1><p>${u.esc(UNITS[s.unit])} · ${u.esc(u.periodLabel(s.period))}${s.version ? ' · versi ' + s.version : ''}</p>
      <table><thead><tr><th>Karyawan</th>${head.join('')}<th>Masuk</th><th>Libur</th></tr></thead><tbody>${rows.join('')}</tbody></table>
      <div class="lg">${s.config.shifts.map((sh) => `<span><b>${u.esc(sh.code)}</b> = ${u.esc(sh.name)} (${sh.start}–${sh.end})</span>`).join('')}<span><b>L</b> = Libur</span></div></div>`;
  }

  /** Ada jadwal yang diubah tetapi belum disimpan (dipakai tombol Muat ulang). */
  sched.hasUnsaved = () => [...drafts.values()].some((x) => x.dirty);

  NP.pages = NP.pages || {};
  NP.pages.schedule = { title: 'Jadwal Masuk', render };
  if (typeof module !== 'undefined' && module.exports) module.exports = NP;
})(typeof globalThis !== 'undefined' ? globalThis : window);
