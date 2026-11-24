/* Noura Payroll — utilitas umum (format uang, tanggal, escape HTML, dll).
 * Modul ini murni (tanpa DOM) sehingga dapat diuji di Node. */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  NP.pages = NP.pages || {};
  /** Lingkungan: { artifact: true } pada versi online (claude.ai artifact). */
  NP.ENV = Object.assign({ artifact: false }, root.NP_ENV || {});

  const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  /** Semua nilai uang disimpan sebagai bilangan bulat rupiah. */
  function toInt(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : 0;
    const s = String(v).trim();
    const neg = /^-/.test(s) || /^\(.*\)$/.test(s);
    const digits = s.replace(/[^0-9]/g, '');
    if (!digits) return 0;
    const n = parseInt(digits, 10);
    return neg ? -n : n;
  }

  function toNum(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const n = parseFloat(String(v).replace(',', '.').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function groupDigits(n) {
    const s = String(Math.abs(Math.round(n)));
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  /** Format rupiah konsisten: Rp28.000 / -Rp5.000 */
  function rp(n) {
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? '-Rp' : 'Rp') + groupDigits(v);
  }

  function num(n, dec) {
    const v = Number(n) || 0;
    if (dec) return v.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: dec });
    return groupDigits(v);
  }

  function pct(n) {
    return (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('id-ID') + '%';
  }

  function pad(n, w) {
    return String(n).padStart(w || 2, '0');
  }

  function todayISO(d) {
    const x = d || new Date();
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
  }

  function parseISO(s) {
    if (!s) return null;
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  function fmtDate(s, opt) {
    const d = s instanceof Date ? s : parseISO(s);
    if (!d || isNaN(d)) return '-';
    if (opt === 'short') return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
    return d.getDate() + ' ' + (opt === 'long' ? MONTHS[d.getMonth()] : MONTHS_SHORT[d.getMonth()]) + ' ' + d.getFullYear();
  }

  function fmtDateTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return fmtDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function periodOf(dateISO) {
    return String(dateISO).slice(0, 7);
  }

  function periodLabel(p) {
    if (!p) return '-';
    const [y, m] = p.split('-').map(Number);
    return MONTHS[m - 1] + ' ' + y;
  }

  function monthRange(period) {
    const [y, m] = period.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return { start: period + '-01', end: period + '-' + pad(last) };
  }

  function addMonths(period, n) {
    const [y, m] = period.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  function addDays(iso, n) {
    const d = parseISO(iso);
    d.setDate(d.getDate() + n);
    return todayISO(d);
  }

  /** Rentang tanggal untuk preset filter. */
  function presetRange(preset, ref) {
    const t = ref ? parseISO(ref) : new Date();
    const iso = todayISO(t);
    switch (preset) {
      case 'today':
        return { start: iso, end: iso };
      case 'week': {
        const dow = (t.getDay() + 6) % 7; // Senin = 0
        const s = addDays(iso, -dow);
        return { start: s, end: addDays(s, 6) };
      }
      case 'month':
        return monthRange(iso.slice(0, 7));
      case 'lastmonth':
        return monthRange(addMonths(iso.slice(0, 7), -1));
      case 'year':
        return { start: t.getFullYear() + '-01-01', end: t.getFullYear() + '-12-31' };
      case 'all':
        return { start: '1900-01-01', end: '2999-12-31' };
      default:
        return monthRange(iso.slice(0, 7));
    }
  }

  function inRange(iso, start, end) {
    if (!iso) return false;
    const d = String(iso).slice(0, 10);
    return (!start || d >= start) && (!end || d <= end);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uid(prefix) {
    const r = Math.random().toString(36).slice(2, 8);
    return (prefix || 'id') + '_' + Date.now().toString(36) + r;
  }

  function clone(o) {
    return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
  }

  function sum(arr, fn) {
    let t = 0;
    for (const x of arr || []) t += fn ? Number(fn(x)) || 0 : Number(x) || 0;
    return t;
  }

  function groupBy(arr, fn) {
    const m = new Map();
    for (const x of arr || []) {
      const k = fn(x);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return m;
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      const a = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), ms || 250);
    };
  }

  function maskAccount(acc) {
    if (!acc) return '-';
    const s = String(acc).replace(/\s/g, '');
    if (s.length <= 4) return '****';
    return '*'.repeat(Math.max(4, s.length - 4)) + s.slice(-4);
  }

  /** Terbilang (angka ke kata) bahasa Indonesia. */
  function terbilang(n) {
    const a = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
    n = Math.floor(Math.abs(Number(n) || 0));
    function t(x) {
      if (x < 12) return a[x];
      if (x < 20) return t(x - 10) + ' belas';
      if (x < 100) return t(Math.floor(x / 10)) + ' puluh' + (x % 10 ? ' ' + t(x % 10) : '');
      if (x < 200) return 'seratus' + (x - 100 ? ' ' + t(x - 100) : '');
      if (x < 1000) return t(Math.floor(x / 100)) + ' ratus' + (x % 100 ? ' ' + t(x % 100) : '');
      if (x < 2000) return 'seribu' + (x - 1000 ? ' ' + t(x - 1000) : '');
      if (x < 1e6) return t(Math.floor(x / 1000)) + ' ribu' + (x % 1000 ? ' ' + t(x % 1000) : '');
      if (x < 1e9) return t(Math.floor(x / 1e6)) + ' juta' + (x % 1e6 ? ' ' + t(x % 1e6) : '');
      if (x < 1e12) return t(Math.floor(x / 1e9)) + ' miliar' + (x % 1e9 ? ' ' + t(x % 1e9) : '');
      return t(Math.floor(x / 1e12)) + ' triliun' + (x % 1e12 ? ' ' + t(x % 1e12) : '');
    }
    if (n === 0) return 'nol rupiah';
    const s = t(n).replace(/\s+/g, ' ').trim() + ' rupiah';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** PRNG deterministik untuk data demo. */
  function seededRandom(seed) {
    let s = seed >>> 0;
    return function () {
      s += 0x6d2b79f5;
      let r = Math.imul(s ^ (s >>> 15), 1 | s);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function slug(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  NP.u = {
    MONTHS, MONTHS_SHORT, toInt, toNum, rp, num, pct, pad, todayISO, parseISO, fmtDate, fmtDateTime,
    periodOf, periodLabel, monthRange, addMonths, addDays, presetRange, inRange, esc, uid, clone, sum,
    groupBy, debounce, maskAccount, terbilang, seededRandom, slug, groupDigits
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = NP;
})(typeof globalThis !== 'undefined' ? globalThis : window);
