/* Noura Payroll — lapisan database.
 *
 * Saat ini memakai IndexedDB (data tersimpan di perangkat/browser ini saja).
 * Seluruh modul lain hanya berbicara dengan API `NP.db` di bawah, sehingga untuk
 * pengembangan multi-perangkat cukup membuat driver baru (mis. RestDriver yang
 * memanggil API backend dengan autentikasi) dengan method yang sama:
 *   get(store, key) · all(store) · put(store, obj) · putMany(store, arr) · del(store, key)
 *   clear(store) · run(stores, fn)  (transaksi atomik) · exportAll() · importAll(data)
 * Lihat README.md bagian "Arsitektur & Pengembangan Backend".
 */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});

  const DB_NAME = 'noura-payroll';
  const DB_VERSION = 1;
  const STORES = {
    settings: { keyPath: 'key' },
    users: { keyPath: 'id' },
    employees: { keyPath: 'id' },
    components: { keyPath: 'id' },
    services: { keyPath: 'id' },
    transactions: { keyPath: 'id', indexes: [['date', 'date'], ['status', 'status']] },
    payrollRuns: { keyPath: 'id', indexes: [['period', 'period']] },
    worklogs: { keyPath: 'id', indexes: [['date', 'date'], ['employeeId', 'employeeId']] },
    auditLog: { keyPath: 'id', indexes: [['ts', 'ts'], ['entityId', 'entityId']] },
    counters: { keyPath: 'key' }
  };
  const STORE_NAMES = Object.keys(STORES);

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const IndexedDBDriver = {
    name: 'IndexedDB (lokal di perangkat ini)',
    multiDevice: false,
    _db: null,

    open() {
      if (this._db) return Promise.resolve(this._db);
      if (!root.indexedDB) return Promise.reject(new Error('Browser tidak mendukung IndexedDB.'));
      return new Promise((resolve, reject) => {
        const req = root.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const [name, cfg] of Object.entries(STORES)) {
            if (!db.objectStoreNames.contains(name)) {
              const os = db.createObjectStore(name, { keyPath: cfg.keyPath });
              for (const [iname, path] of cfg.indexes || []) os.createIndex(iname, path, { unique: false });
            }
          }
        };
        req.onsuccess = () => {
          this._db = req.result;
          this._db.onversionchange = () => this._db.close();
          resolve(this._db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('Database sedang dipakai tab lain. Tutup tab lain lalu muat ulang.'));
      });
    },

    _wrap(tx) {
      return {
        get: (s, k) => promisify(tx.objectStore(s).get(k)),
        all: (s) => promisify(tx.objectStore(s).getAll()),
        put: (s, o) => promisify(tx.objectStore(s).put(o)),
        del: (s, k) => promisify(tx.objectStore(s).delete(k)),
        clear: (s) => promisify(tx.objectStore(s).clear()),
        /** Nomor urut atomik, mis. nextNumber('TRX-202611') -> 1, 2, 3 ... */
        nextNumber: async (key) => {
          const os = tx.objectStore('counters');
          const cur = (await promisify(os.get(key))) || { key, value: 0 };
          cur.value += 1;
          await promisify(os.put(cur));
          return cur.value;
        }
      };
    },

    /** Jalankan fn dalam satu transaksi database atomik (semua berhasil atau semua batal). */
    async run(stores, fn, mode) {
      const db = await this.open();
      const names = (Array.isArray(stores) ? stores : [stores]).filter((s, i, a) => a.indexOf(s) === i);
      return new Promise((resolve, reject) => {
        let result;
        let failed = null;
        const tx = db.transaction(names, mode || 'readwrite');
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(failed || tx.error);
        tx.onabort = () => reject(failed || tx.error || new Error('Transaksi database dibatalkan.'));
        Promise.resolve()
          .then(() => fn(this._wrap(tx)))
          .then((r) => {
            result = r;
          })
          .catch((e) => {
            failed = e;
            try {
              tx.abort();
            } catch (_) {
              reject(e);
            }
          });
      });
    },

    async get(store, key) {
      if (key === undefined || key === null) return undefined;
      return this.run([store], (t) => t.get(store, key), 'readonly');
    },
    async all(store) {
      return this.run([store], (t) => t.all(store), 'readonly');
    },
    async put(store, obj) {
      return this.run([store], (t) => t.put(store, obj));
    },
    async putMany(store, arr) {
      return this.run([store], async (t) => {
        for (const o of arr) await t.put(store, o);
      });
    },
    async del(store, key) {
      return this.run([store], (t) => t.del(store, key));
    },
    async clear(store) {
      return this.run([store], (t) => t.clear(store));
    },

    async exportAll() {
      const out = {};
      await this.run(STORE_NAMES, async (t) => {
        for (const s of STORE_NAMES) out[s] = await t.all(s);
      }, 'readonly');
      return out;
    },

    /** Ganti seluruh isi database secara atomik. */
    async importAll(data) {
      return this.run(STORE_NAMES, async (t) => {
        for (const s of STORE_NAMES) {
          await t.clear(s);
          for (const o of data[s] || []) await t.put(s, o);
        }
      });
    },

    async estimate() {
      if (root.navigator && navigator.storage && navigator.storage.estimate) {
        try {
          return await navigator.storage.estimate();
        } catch (_) {
          return null;
        }
      }
      return null;
    }
  };

  NP.db = IndexedDBDriver;
  NP.db.STORES = STORE_NAMES;
  NP.db.DB_NAME = DB_NAME;

  /** Format nomor dokumen, mis. code('TRX', 12, 4) -> TRX-0012 */
  function code(prefix, n, width) {
    return prefix + '-' + String(n).padStart(width || 4, '0');
  }
  NP.db.code = code;

  /* Driver cadangan di memori — dipakai bila browser memblokir IndexedDB (mode privat,
   * pratinjau). API sama persis; data hilang saat halaman ditutup. Transaksi tetap atomik:
   * bila fn gagal, seluruh perubahan dikembalikan dari salinan. */
  const MemoryDriver = {
    name: 'Memori sementara (data hilang saat halaman ditutup)',
    multiDevice: false,
    isMemory: true,
    _data: null,
    open() {
      if (!this._data) {
        this._data = {};
        for (const s of STORE_NAMES) this._data[s] = new Map();
      }
      return Promise.resolve(this._data);
    },
    _key(s, o) {
      return o[STORES[s].keyPath];
    },
    async run(stores, fn) {
      await this.open();
      const names = (Array.isArray(stores) ? stores : [stores]).filter((s, i, a) => a.indexOf(s) === i);
      const snap = {};
      for (const s of names) snap[s] = new Map([...this._data[s]].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
      const d = this._data;
      const cp = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
      const t = {
        get: async (s, k) => cp(d[s].get(k)),
        all: async (s) => [...d[s].values()].map(cp),
        put: async (s, o) => {
          d[s].set(this._key(s, o), cp(o));
          return this._key(s, o);
        },
        del: async (s, k) => {
          d[s].delete(k);
        },
        clear: async (s) => d[s].clear(),
        nextNumber: async (key) => {
          const cur = d.counters.get(key) || { key, value: 0 };
          cur.value += 1;
          d.counters.set(key, cp(cur));
          return cur.value;
        }
      };
      try {
        return await fn(t);
      } catch (e) {
        for (const s of names) d[s] = snap[s];
        throw e;
      }
    }
  };
  for (const m of ['get', 'all', 'put', 'putMany', 'del', 'clear', 'exportAll', 'importAll', 'estimate']) MemoryDriver[m] = IndexedDBDriver[m];
  MemoryDriver.estimate = async () => null;

  /** Ganti driver ke memori (dipanggil saat IndexedDB tidak dapat dibuka). */
  NP.useMemoryDb = function () {
    MemoryDriver.STORES = STORE_NAMES;
    MemoryDriver.DB_NAME = DB_NAME + ' (memori)';
    MemoryDriver.code = code;
    NP.db = MemoryDriver;
    return MemoryDriver;
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
