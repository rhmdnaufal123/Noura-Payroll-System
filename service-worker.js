/* Noura Payroll — service worker: cache aset aplikasi agar dapat dibuka offline (PWA).
 * Data tetap di IndexedDB; service worker hanya menyimpan file aplikasi. */
const CACHE = 'noura-payroll-v1.0.0';
const ASSETS = [
  './', './index.html', './manifest.json',
  './css/style.css', './css/dashboard.css', './css/employee.css', './css/transaction.css', './css/payroll.css', './css/report.css', './css/print.css',
  './js/utils.js', './js/constants.js', './js/defaults.js', './js/database.js', './js/security.js', './js/ui.js', './js/revenue-sharing.js',
  './js/calculator.js', './js/export.js', './js/employee.js', './js/service-master.js', './js/transaction.js', './js/service-income.js',
  './js/payroll.js', './js/payslip.js', './js/reports.js', './js/dashboard.js', './js/settings.js', './js/demo-data.js', './js/app.js',
  './vendor/chart.umd.min.js', './vendor/xlsx.full.min.js', './vendor/jspdf.umd.min.js', './vendor/jspdf.plugin.autotable.min.js',
  './vendor/html2canvas.min.js', './vendor/jszip.min.js',
  './assets/logo.png', './assets/icon-192.png', './assets/icon-512.png', './assets/icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Font Google: stale-while-revalidate; aset lokal: network-first lalu cache (agar pembaruan cepat terlihat).
  if (url.origin !== location.origin) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  e.respondWith(
    fetch(req)
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return r;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
