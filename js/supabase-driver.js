/* Noura Payroll — driver data Supabase (PostgreSQL terpusat).
 *
 * Aktif otomatis bila js/env.js berisi SUPABASE_URL dan SUPABASE_ANON_KEY. Setelah aktif,
 * TIDAK ADA penyimpanan lokal sebagai cadangan: semua perangkat memakai database yang sama.
 *
 *  - Baca  : tabel relasional dirakit menjadi bentuk dokumen yang dipakai halaman (sama
 *            dengan driver IndexedDB), sehingga dashboard & laporan tidak perlu berubah.
 *  - Tulis : data keuangan hanya lewat fungsi RPC di database (validasi role, transaksi
 *            atomik, anti duplikasi). Tabel master sederhana ditulis langsung (dibatasi RLS).
 *  - Login : Supabase Auth (email + kata sandi). Role & status aktif dari tabel public.users.
 * Kunci yang dipakai hanya anon/publishable key; service role key TIDAK PERNAH ada di frontend.
 */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;

  const cfg = root.NP_CONFIG || {};
  NP.remoteConfigured = function () {
    return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  };

  const SETTING_KEYS = ['company', 'payroll', 'tax', 'bpjs', 'salesBonus', 'slip', 'numbering', 'backup', 'security'];
  const STORES = ['settings', 'users', 'employees', 'components', 'services', 'transactions', 'payrollRuns', 'worklogs', 'auditLog', 'counters'];
  const ORDER = {
    app_settings: 'key', business_units: 'code', positions: 'id', departments: 'id', employees: 'id', employee_bank_accounts: 'employee_id',
    salary_components: 'code', service_master: 'id', service_revenue_rules: 'id', service_transactions: 'id', service_transaction_items: 'id',
    service_transaction_allocations: 'id', payroll_periods: 'id', payroll_records: 'id', payroll_details: 'id', payslips: 'id', worklogs: 'id',
    users: 'id', audit_logs: 'id', doc_counters: 'key'
  };

  function toError(e) {
    if (!e) return new Error('Kesalahan tidak diketahui.');
    let msg = e.message || String(e);
    const err = new Error(msg);
    if (/^LOCKED:/.test(msg)) {
      err.code = 'LOCKED';
      err.message = msg.replace(/^LOCKED:\s*/, '');
    } else if (e.code === '42501' && !/Akses ditolak|LOCKED/.test(msg)) {
      err.message = 'Akses ditolak: akun Anda tidak memiliki hak untuk tindakan ini.';
    } else if (/Failed to fetch|NetworkError|fetch failed/i.test(msg)) {
      err.message = 'Tidak dapat terhubung ke server Supabase. Periksa koneksi internet.';
    }
    err.cause = e;
    return err;
  }
  const num = (v) => (v === null || v === undefined ? 0 : Number(v));
  const ts = (v) => (v ? Date.parse(v) : null);

  function createSupabaseDriver() {
    if (!root.supabase || !root.supabase.createClient) throw new Error('Pustaka Supabase (vendor/supabase.min.js) tidak termuat.');
    const sb = root.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'noura.auth' }
    });
    const cache = new Map();
    const TTL = 15000;
    let lastWrite = 0;
    let settingsSnapshot = {};

    async function q(builder) {
      const { data, error } = await builder;
      if (error) throw toError(error);
      return data;
    }
    async function fetchAll(table, filter) {
      const out = [];
      const size = 1000;
      for (let from = 0; ; from += size) {
        let b = sb.from(table).select('*').order(ORDER[table] || 'id', { ascending: true }).range(from, from + size - 1);
        if (filter) b = filter(b);
        const data = await q(b);
        out.push(...data);
        if (data.length < size) break;
      }
      return out;
    }
    async function rpc(fn, args, client) {
      const { data, error } = await (client || sb).rpc(fn, args || {});
      if (error) throw toError(error);
      lastWrite = Date.now();
      cache.clear();
      return data;
    }
    /** Klien sementara memakai token administrator hasil otorisasi (untuk koreksi data terkunci). */
    function clientWithToken(token) {
      return root.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: 'Bearer ' + token } },
        auth: { persistSession: false, autoRefreshToken: false, storageKey: 'noura.auth.tmp' }
      });
    }

    /* ------------------------- Perakitan dokumen ------------------------- */
    const loaders = {
      async settings() {
        const [rows, units] = await Promise.all([fetchAll('app_settings'), fetchAll('business_units')]);
        const doc = { key: 'app', units: {} };
        for (const r of rows) doc[r.key] = r.value;
        for (const b of units) doc.units[b.code] = { name: b.name, address: b.address, phone: b.phone, email: b.email, logo: b.logo_url, leaderName: b.leader_name, leaderTitle: b.leader_title };
        settingsSnapshot = JSON.parse(JSON.stringify(doc));
        return [doc];
      },
      async users() {
        return (await fetchAll('users')).map((x) => ({ id: x.id, username: x.username, name: x.full_name, email: x.email, role: x.role, active: x.active, mustChange: x.must_change_password, createdAt: ts(x.created_at) }));
      },
      async employees() {
        const [rows, pos, dep, bank] = await Promise.all([fetchAll('employees'), fetchAll('positions'), fetchAll('departments'), fetchAll('employee_bank_accounts')]);
        const P = new Map(pos.map((p) => [p.id, p]));
        const D = new Map(dep.map((d) => [d.id, d]));
        const B = new Map(bank.map((b) => [b.employee_id, b]));
        return rows.map((e) => {
          const b = B.get(e.id) || {};
          return {
            id: e.id, name: e.full_name, photo: e.photo_url, gender: e.gender, address: e.address, phone: e.phone, email: e.email, unit: e.unit,
            primaryUnit: e.primary_unit, costSplit: { APT: num(e.cost_split_apt) }, position: (P.get(e.position_id) || {}).name || '', department: (D.get(e.department_id) || {}).name || '',
            startDate: e.start_date, status: e.status, baseSalary: num(e.base_salary), payScheme: e.pay_scheme, payConfig: e.pay_config || {}, payMethod: e.pay_method,
            bankName: b.bank_name || '', bankAccount: b.account_number || '', bankHolder: b.account_holder || '', notes: e.notes, str: e.str_number, sip: e.sip_number,
            healthStatus: e.health_status, schedule: e.schedule, serviceFeeMethod: e.service_fee_method, bpjsKes: e.bpjs_kes, bpjsTk: e.bpjs_tk, bpjsWage: num(e.bpjs_wage),
            pph21: e.pph21, ptkp: e.ptkp, salesTarget: num(e.sales_target), componentOverrides: e.component_overrides || {}, createdAt: ts(e.created_at), updatedAt: ts(e.updated_at)
          };
        });
      },
      async components() {
        return (await fetchAll('salary_components')).map((c) => ({
          id: c.code, code: c.code, name: c.name, type: c.type, group: c.grp, calc: c.calc, value: num(c.value), positionValues: c.position_values || {},
          units: c.units || [], positions: c.positions || [], active: c.active, fixed: c.is_fixed, taxable: c.taxable, system: c.is_system, order: c.sort_order
        }));
      },
      async services() {
        const [rows, rules] = await Promise.all([fetchAll('service_master'), fetchAll('service_revenue_rules')]);
        const byService = u.groupBy(rules, (r) => r.service_id);
        const share = (r) => ({ type: r.recipient_type, target: r.target, mode: r.mode, value: r.mode === 'percent' ? num(r.value) : num(r.value) });
        return rows.map((s) => {
          const rs = (byService.get(s.id) || []).slice().sort((a, b) => a.sort_order - b.sort_order);
          const ov = new Map();
          for (const r of rules.filter((x) => x.service_id === s.id && x.employee_id).sort((a, b) => a.id - b.id)) {
            if (!ov.has(r.employee_id)) ov.set(r.employee_id, []);
            ov.get(r.employee_id).push(r);
          }
          return {
            id: s.id, code: s.id, name: s.name, category: s.category, unit: s.unit_code, price: num(s.price), method: s.method, active: s.active, notes: s.notes,
            shares: rs.filter((r) => !r.employee_id).map(share),
            overrides: [...ov.entries()].map(([employeeId, list]) => ({ employeeId, shares: list.sort((a, b) => a.sort_order - b.sort_order).map(share) })),
            createdAt: ts(s.created_at), updatedAt: ts(s.updated_at)
          };
        });
      },
      async transactions() {
        const [rows, items, allocs] = await Promise.all([fetchAll('service_transactions'), fetchAll('service_transaction_items'), fetchAll('service_transaction_allocations')]);
        const itemsBy = u.groupBy(items, (i) => i.transaction_id);
        const allocBy = u.groupBy(allocs, (a) => a.item_id || 'adj:' + a.transaction_id);
        const pay = (a) => ({ runId: a.payroll_period_id || null, state: a.payroll_state || null });
        return rows.map((t) => {
          const its = (itemsBy.get(t.id) || []).sort((a, b) => a.line_no - b.line_no).map((i) => ({
            lineId: i.id, serviceId: i.service_id, serviceCode: i.service_code, serviceName: i.service_name, category: i.category, unit: i.unit_code,
            qty: i.qty, price: num(i.unit_price), gross: num(i.gross), performers: i.performers || {}, performerNames: i.performer_names || {}, overrideFor: i.override_employee_id,
            shares: (allocBy.get(i.id) || []).sort((a, b) => a.sort_order - b.sort_order).map((a) => ({
              allocId: a.id, type: a.recipient_type, target: a.target, mode: a.mode, value: num(a.rule_value), recipientId: a.recipient_employee_id || a.recipient_unit || null,
              recipientName: a.recipient_name, category: a.category, role: a.recipient_type === 'role' ? a.target : a.recipient_type === 'employee' ? a.category : null,
              unitAmount: num(a.unit_amount), amount: num(a.amount), implicit: a.is_implicit, payroll: pay(a)
            }))
          }));
          const doc = {
            id: t.id, date: t.trx_date, patient: t.patient_name, patientCode: t.patient_code, note: t.note, status: t.status, cancelReason: t.cancel_reason,
            cancelledAt: ts(t.cancelled_at), cancelledBy: t.cancelled_by_name || '-', items: its, corrections: t.corrections || [],
            adjustments: (allocBy.get('adj:' + t.id) || []).sort((a, b) => ts(a.created_at) - ts(b.created_at)).map((a) => ({
              id: a.id, employeeId: a.recipient_employee_id, amount: num(a.amount), unit: a.recipient_unit, date: a.adj_date, kind: a.adj_kind, note: a.adj_note, by: a.adj_by, payroll: pay(a)
            })),
            createdAt: ts(t.created_at), createdBy: t.created_by_name || '-', updatedAt: ts(t.updated_at)
          };
          doc.totals = NP.trx ? NP.trx.totals(its) : { gross: num(t.gross) };
          return doc;
        });
      },
      async payrollRuns() {
        const [rows, recs, dets, slips] = await Promise.all([fetchAll('payroll_periods'), fetchAll('payroll_records'), fetchAll('payroll_details'), fetchAll('payslips').catch(() => [])]);
        const recBy = u.groupBy(recs, (r) => r.period_id);
        const detBy = u.groupBy(dets, (d) => d.record_id);
        const slipBy = new Map(slips.map((s) => [s.record_id, s]));
        const line = (d) => ({ code: d.code, name: d.name, group: d.grp, amount: num(d.amount), fixed: d.is_fixed, taxable: d.taxable, note: d.note });
        return rows.map((p) => {
          const rr = recBy.get(p.id) || [];
          const inputs = {};
          const out = {
            id: p.id, period: p.period, start: p.start_date, end: p.end_date, payDate: p.pay_date, unit: p.unit_filter, status: p.status, stale: p.stale, staleReason: p.stale_reason,
            includeEarlier: p.include_earlier, notes: p.notes, history: p.history || [], createdAt: ts(p.created_at), createdBy: ((p.history || [])[0] || {}).by || '-',
            approvedAt: ts(p.approved_at), approvedBy: ([...(p.history || [])].reverse().find((h) => h.action === 'approve') || {}).by || '-',
            lockedAt: ts(p.locked_at), lockedBy: ([...(p.history || [])].reverse().find((h) => h.action === 'lock') || {}).by || '-',
            employeeIds: rr.map((r) => r.employee_id), inputs,
            slips: rr.sort((a, b) => String((a.employee_snapshot || {}).name).localeCompare(String((b.employee_snapshot || {}).name), 'id')).map((r) => {
              const ds = (detBy.get(r.id) || []).sort((a, b) => a.sort_order - b.sort_order);
              const inp = r.inputs || {};
              inputs[r.employee_id] = inp.overrides || {};
              const sl = slipBy.get(r.id);
              return {
                recordId: r.id, slipNo: r.slip_no, employeeId: r.employee_id, employee: r.employee_snapshot, earnings: ds.filter((d) => d.line_type === 'earning').map(line),
                deductions: ds.filter((d) => d.line_type === 'deduction').map(line), serviceDetail: r.service_detail || [], serviceCount: r.service_count, serviceQty: r.service_qty,
                totals: Object.assign({}, r.totals, { gross: num(r.gross), deductions: num(r.deductions), net: num(r.net) }), allocation: r.allocation, split: r.split,
                employer: r.employer || { total: 0 }, taxInfo: r.tax_info, inputs: inp.normalized || {}, warnings: r.warnings || [], issuedAt: sl ? ts(sl.issued_at) : null,
                serviceRefs: [], adjRefs: []
              };
            })
          };
          out.totals = Object.assign({ alloc: { APT: { gross: 0, net: 0, deductions: 0 }, KLINIK: { gross: 0, net: 0, deductions: 0 } } }, p.totals || {});
          return out;
        });
      },
      async worklogs() {
        return (await fetchAll('worklogs')).map((w) => ({ id: w.id, employeeId: w.employee_id, date: w.work_date, shifts: num(w.shifts), sessions: num(w.sessions), note: w.note }));
      },
      async auditLog() {
        const data = await q(sb.from('audit_logs').select('id,ts,username,action,entity,entity_id,detail').order('id', { ascending: false }).limit(3000));
        return data.map((l) => ({ id: l.id, ts: ts(l.ts), user: l.username, userName: l.username, action: l.action, entity: l.entity, entityId: l.entity_id, detail: l.detail }));
      },
      async counters() {
        return (await fetchAll('doc_counters')).map((c) => ({ key: c.key, value: num(c.value) }));
      }
    };

    const keyOf = { settings: 'key', counters: 'key' };
    const driver = {
      name: 'Supabase (PostgreSQL terpusat)',
      remote: true,
      multiDevice: true,
      DB_NAME: cfg.SUPABASE_URL,
      STORES,
      client: sb,
      code: (prefix, n, width) => prefix + '-' + String(n).padStart(width || 4, '0'),

      async open() {
        return true;
      },
      async all(store) {
        if (!loaders[store]) throw new Error('Data "' + store + '" tidak tersedia.');
        const hit = cache.get(store);
        if (hit && Date.now() - hit.t < TTL) return u.clone(hit.data);
        const data = await loaders[store]();
        cache.set(store, { t: Date.now(), data });
        return u.clone(data);
      },
      async get(store, key) {
        if (key === undefined || key === null) return undefined;
        const k = keyOf[store] || 'id';
        return (await driver.all(store)).find((x) => String(x[k]) === String(key));
      },
      async put(store, obj) {
        lastWrite = Date.now();
        cache.clear();
        if (store === 'settings') return saveSettings(obj);
        if (store === 'components') return saveComponent(obj);
        if (store === 'worklogs') return driver.saveWorklog(obj);
        if (store === 'auditLog') return driver.log(obj.action, obj.entity, obj.entityId, obj.detail);
        if (store === 'users') return driver.adminUpdateUser(obj);
        throw new Error('Penyimpanan langsung "' + store + '" tidak diizinkan; gunakan proses aplikasi.');
      },
      async putMany(store, arr) {
        for (const o of arr) await driver.put(store, o);
      },
      async del(store, key) {
        lastWrite = Date.now();
        cache.clear();
        if (store === 'components') return q(sb.from('salary_components').delete().eq('code', key));
        if (store === 'worklogs') return driver.deleteWorklog(key);
        if (store === 'users') return driver.adminUsers({ action: 'delete', id: key });
        throw new Error('Penghapusan langsung "' + store + '" tidak diizinkan.');
      },
      async clear() {
        throw new Error('Penghapusan massal tidak tersedia pada database Supabase.');
      },
      async run() {
        throw new Error('Operasi ini harus melalui fungsi server Supabase.');
      },
      async exportAll() {
        const out = {};
        for (const t of Object.keys(ORDER)) {
          try {
            out[t] = await fetchAll(t);
          } catch (e) {
            out[t] = { error: e.message };
          }
        }
        return out;
      },
      async importAll() {
        throw new Error('Restore pada mode Supabase dilakukan oleh administrator database (lihat README › Backup).');
      },
      async estimate() {
        return null;
      },
      invalidate() {
        cache.clear();
      },

      /* ---------------------------- Auth ---------------------------- */
      async signIn(email, password) {
        const { data, error } = await sb.auth.signInWithPassword({ email: String(email || '').trim(), password: password || '' });
        if (error) return { error: /Invalid login/i.test(error.message) ? 'Email atau kata sandi salah.' : toError(error).message };
        const prof = await driver.profile(data.user.id);
        if (!prof) {
          await sb.auth.signOut();
          return { error: 'Profil pengguna belum dibuat. Pastikan migrasi database sudah dijalankan.' };
        }
        if (!prof.active) {
          await sb.auth.signOut();
          return { error: 'Akun belum diaktifkan administrator.' };
        }
        cache.clear();
        return { user: prof };
      },
      async session() {
        const { data } = await sb.auth.getSession();
        if (!data || !data.session) return null;
        const prof = await driver.profile(data.session.user.id).catch(() => null);
        return prof && prof.active ? prof : null;
      },
      async profile(id) {
        const rows = await q(sb.from('users').select('*').eq('id', id));
        const x = rows[0];
        return x ? { id: x.id, username: x.username, name: x.full_name, email: x.email, role: x.role, active: x.active, mustChange: x.must_change_password } : null;
      },
      async signOut() {
        cache.clear();
        await sb.auth.signOut();
      },
      /** Verifikasi kredensial tanpa mengganti sesi aktif. Mengembalikan profil + token. */
      async verifyCredentials(email, password) {
        const tmp = root.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'noura.auth.verify' } });
        const { data, error } = await tmp.auth.signInWithPassword({ email: String(email || '').trim(), password: password || '' });
        if (error || !data.session) return null;
        const rows = await q(clientWithToken(data.session.access_token).from('users').select('*').eq('id', data.user.id));
        const x = rows[0];
        if (!x || !x.active) return null;
        return { id: x.id, username: x.username, name: x.full_name, role: x.role, token: data.session.access_token };
      },
      async changePassword(newPassword) {
        const { error } = await sb.auth.updateUser({ password: newPassword });
        if (error) throw toError(error);
        await rpc('mark_password_changed', {});
      },
      async adminUpdateUser(x) {
        return rpc('admin_update_user', { p_id: x.id, p_role: x.role, p_active: x.active !== false, p_full_name: x.name });
      },
      /** Kelola akun Auth lewat Edge Function (memakai service role di server, bukan di browser). */
      async adminUsers(body) {
        const { data, error } = await sb.functions.invoke('admin-users', { body });
        if (error) {
          let msg = error.message;
          try {
            const j = await error.context.json();
            if (j && j.error) msg = j.error;
          } catch (_) {}
          if (/not found|Failed to send/i.test(msg)) msg = 'Fungsi "admin-users" belum dideploy di Supabase. Kelola pengguna lewat Supabase Dashboard › Authentication, atau deploy supabase/functions/admin-users.';
          throw new Error(msg);
        }
        cache.clear();
        return data;
      },

      /* ---------------------------- Domain ---------------------------- */
      log(action, entity, entityId, detail) {
        return sb.rpc('log_event', { p_action: String(action), p_entity: String(entity || ''), p_entity_id: String(entityId || ''), p_detail: String(detail || '') }).then(() => {}, () => {});
      },
      saveEmployee(e) {
        const p = Object.assign({}, e);
        delete p.createdAt;
        delete p.updatedAt;
        return rpc('save_employee', { p });
      },
      deleteEmployee: (id) => rpc('delete_employee', { p_id: id }),
      saveService: (s) => rpc('save_service', { p: { id: s.id || null, name: s.name, category: s.category, unit: s.unit, price: s.price, active: s.active, notes: s.notes || '', shares: s.shares, overrides: s.overrides || [] } }),
      setServiceActive: (id, active) => rpc('set_service_active', { p_id: id, p_active: active }),
      deleteService: (id) => rpc('delete_service', { p_id: id }),
      async saveTransaction(draft, opt) {
        opt = opt || {};
        const p = { date: draft.date, patient: draft.patient || '', patientCode: draft.patientCode || '', note: draft.note || '', items: draft.items };
        const client = opt.auth && opt.auth.token ? clientWithToken(opt.auth.token) : null;
        const id = opt.editId
          ? await rpc('update_service_transaction', { p_id: opt.editId, p, p_note: opt.auth ? opt.auth.note : null }, client)
          : await rpc('create_service_transaction', { p });
        return driver.get('transactions', id);
      },
      async cancelTransaction(id, reason, opt) {
        opt = opt || {};
        const client = opt.auth && opt.auth.token ? clientWithToken(opt.auth.token) : null;
        await rpc('cancel_service_transaction', { p_id: id, p_reason: reason, p_note: opt.auth ? opt.auth.note : null }, client);
        return driver.get('transactions', id);
      },
      payrollSaveDraft: (p) => rpc('payroll_save_draft', { p }),
      payrollApprove: (id) => rpc('payroll_approve', { p_id: id }),
      payrollLock: (id) => rpc('payroll_lock', { p_id: id }),
      payrollUnlock: (id, auth) => rpc('payroll_unlock', { p_id: id, p_note: auth.note }, auth.token ? clientWithToken(auth.token) : null),
      payrollRevert: (id) => rpc('payroll_revert', { p_id: id }),
      payrollDelete: (id) => rpc('payroll_delete_draft', { p_id: id }),
      async saveWorklog(w) {
        const row = { employee_id: w.employeeId, work_date: w.date, shifts: w.shifts || 0, sessions: w.sessions || 0, note: w.note || '' };
        cache.clear();
        if (w.id && /^[0-9a-f-]{36}$/.test(w.id)) return q(sb.from('worklogs').update(row).eq('id', w.id));
        const data = await q(sb.from('worklogs').insert(row).select('id'));
        w.id = data[0].id;
        return w;
      },
      async deleteWorklog(id) {
        cache.clear();
        return q(sb.from('worklogs').delete().eq('id', id));
      },

      /** Perubahan dari perangkat lain: kosongkan cache & muat ulang tampilan bila aman. */
      subscribe(onChange) {
        try {
          const ch = sb.channel('noura-changes');
          ['service_transactions', 'payroll_periods', 'employees', 'service_master'].forEach((t) =>
            ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => {
              cache.clear();
              if (Date.now() - lastWrite > 4000) onChange(t);
            })
          );
          ch.subscribe();
        } catch (e) {
          console.warn('Realtime tidak aktif', e);
        }
      }
    };

    async function saveSettings(obj) {
      const tasks = [];
      for (const k of SETTING_KEYS) {
        if (obj[k] === undefined) continue;
        if (JSON.stringify(obj[k]) === JSON.stringify(settingsSnapshot[k])) continue;
        tasks.push(q(sb.from('app_settings').upsert({ key: k, value: obj[k], updated_at: new Date().toISOString() })));
      }
      for (const [code, x] of Object.entries(obj.units || {})) {
        const before = (settingsSnapshot.units || {})[code];
        if (before && JSON.stringify(before) === JSON.stringify(x)) continue;
        tasks.push(q(sb.from('business_units').update({ name: x.name, address: x.address || '', phone: x.phone || '', email: x.email || '', logo_url: x.logo || null, leader_name: x.leaderName || '', leader_title: x.leaderTitle || '', updated_at: new Date().toISOString() }).eq('code', code)));
      }
      await Promise.all(tasks);
      settingsSnapshot = JSON.parse(JSON.stringify(obj));
      cache.clear();
    }

    async function saveComponent(c) {
      cache.clear();
      return q(sb.from('salary_components').upsert({
        code: c.code, name: c.name, type: c.type, grp: c.group, calc: c.calc, value: c.value || 0, position_values: c.positionValues || {}, units: c.units || [],
        positions: c.positions || [], active: !!c.active, is_fixed: !!c.fixed, taxable: c.taxable !== false, is_system: !!c.system, sort_order: c.order || 50, updated_at: new Date().toISOString()
      }));
    }

    return driver;
  }

  NP.createSupabaseDriver = createSupabaseDriver;
})(typeof globalThis !== 'undefined' ? globalThis : window);
