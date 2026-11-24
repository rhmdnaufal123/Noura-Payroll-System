/* Server UJI yang meniru sebagian kecil API Supabase di atas PostgreSQL sungguhan:
 *   /auth/v1/*       → login email+sandi, sesi, ganti sandi, logout (JWT HS256)
 *   /rest/v1/<tabel> → GET/POST(upsert)/PATCH/DELETE dengan filter eq, order, limit/offset
 *   /rest/v1/rpc/<f> → memanggil fungsi PostgreSQL
 *   /functions/v1/admin-users → padanan Edge Function admin-users
 * Setiap permintaan dijalankan sebagai role JWT (anon/authenticated) dengan klaim yang sama
 * seperti PostgREST, sehingga RLS & hak akses fungsi benar-benar berlaku.
 * Juga menyajikan file aplikasi; js/env.js diganti agar menunjuk ke server ini.
 * HANYA untuk pengujian otomatis — bukan pengganti Supabase. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const SECRET = 'uji-rahasia-jwt-noura-' + crypto.randomBytes(8).toString('hex');
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function sign(payload) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(payload);
  return h + '.' + p + '.' + crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url');
}
function verify(token) {
  const [h, p, s] = String(token || '').split('.');
  if (!s || crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url') !== s) return null;
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload;
}
const ANON_KEY = sign({ role: 'anon', iss: 'mock' });
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const IDENT = /^[a-z_][a-z0-9_]*$/;

function start(opt) {
  const root = opt.root;
  const pool = new Pool({ database: opt.database, user: process.env.PGUSER || require('os').userInfo().username, host: process.env.PGHOST || '/var/run/postgresql', max: 8 });
  const refresh = new Map();
  let meta = null;

  async function loadMeta() {
    const pk = await pool.query(`select c.relname t, a.attname col from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey) where i.indisprimary and n.nspname = 'public'`);
    const fns = await pool.query(`select p.proname, p.proargnames, array(select format_type(t, null) from unnest(p.proargtypes) t) types, p.proretset, format_type(p.prorettype, null) ret
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
    meta = { pk: Object.fromEntries(pk.rows.map((r) => [r.t, r.col])), fn: Object.fromEntries(fns.rows.map((r) => [r.proname, r])) };
  }

  async function asRole(claims, fn) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(claims.role === 'authenticated' ? 'set local role authenticated' : 'set local role anon');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      const r = await fn(c);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  function send(res, status, body, headers) {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, headers || {}));
    res.end(body === undefined ? '' : JSON.stringify(body));
  }
  function pgError(res, e) {
    const status = e.code === '42501' ? 403 : e.code === 'P0002' ? 404 : 400;
    send(res, status, { code: e.code || 'XX000', message: e.message, details: e.detail || null, hint: e.hint || null });
  }
  const readBody = (req) => new Promise((ok) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const s = Buffer.concat(parts).toString();
      try {
        ok(s ? JSON.parse(s) : {});
      } catch (_) {
        ok({});
      }
    });
  });
  function claimsOf(req) {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const p = verify(auth) || verify(req.headers.apikey);
    return p || { role: 'anon' };
  }
  function session(user) {
    const now = Math.floor(Date.now() / 1000);
    const access = sign({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp: now + 3600, iat: now });
    const rt = crypto.randomBytes(16).toString('hex');
    refresh.set(rt, user);
    return {
      access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: rt,
      user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() }
    };
  }
  function whereOf(url, params, start) {
    const conds = [];
    let i = start;
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue;
      if (!IDENT.test(k)) throw Object.assign(new Error('kolom tidak valid'), { code: '42703' });
      const m = v.match(/^eq\.(.*)$/s);
      if (!m) throw Object.assign(new Error('operator tidak didukung: ' + v), { code: 'PGRST' });
      params.push(m[1]);
      conds.push(`"${k}"::text = $${++i}`);
    }
    return conds.length ? ' where ' + conds.join(' and ') : '';
  }

  async function handleRest(req, res, url) {
    const claims = claimsOf(req);
    const name = url.pathname.replace(/^\/rest\/v1\//, '');
    if (name.startsWith('rpc/')) {
      const fn = name.slice(4);
      const f = meta.fn[fn];
      if (!f || !IDENT.test(fn)) return send(res, 404, { code: 'PGRST202', message: 'Fungsi tidak ditemukan: ' + fn });
      const body = await readBody(req);
      const args = [];
      const vals = [];
      (f.proargnames || []).forEach((an, i) => {
        if (body[an] === undefined) return;
        const t = f.types[i];
        vals.push(t === 'jsonb' || t === 'json' ? JSON.stringify(body[an]) : body[an] === null ? null : String(body[an]));
        args.push(`${an} => $${vals.length}::${t}`);
      });
      try {
        const call = `public.${fn}(${args.join(', ')})`;
        const r = await asRole(claims, (c) => c.query(f.ret === 'void' ? `select ${call}, null::jsonb as r` : `select to_jsonb(${call}) as r`, vals));
        return send(res, 200, r.rows[0].r);
      } catch (e) {
        return pgError(res, e);
      }
    }
    if (!IDENT.test(name)) return send(res, 404, { message: 'tabel tidak valid' });
    const params = [];
    try {
      if (req.method === 'GET') {
        const sel = url.searchParams.get('select') || '*';
        const cols = sel === '*' ? '*' : sel.split(',').map((c) => {
          if (!IDENT.test(c)) throw Object.assign(new Error('kolom tidak valid'), { code: '42703' });
          return '"' + c + '"';
        }).join(', ');
        let sql = `select ${cols} from public."${name}"` + whereOf(url, params, 0);
        const ord = url.searchParams.get('order');
        if (ord) {
          const [col, dir] = ord.split('.');
          if (!IDENT.test(col)) throw new Error('order tidak valid');
          sql += ` order by "${col}" ${dir === 'desc' ? 'desc' : 'asc'}`;
        }
        if (url.searchParams.get('limit')) sql += ' limit ' + parseInt(url.searchParams.get('limit'), 10);
        if (url.searchParams.get('offset')) sql += ' offset ' + parseInt(url.searchParams.get('offset'), 10);
        const r = await asRole(claims, (c) => c.query(`select coalesce(json_agg(t), '[]'::json) j from (${sql}) t`, params));
        return send(res, 200, r.rows[0].j);
      }
      if (req.method === 'POST' || req.method === 'PATCH') {
        let body = await readBody(req);
        const rows = Array.isArray(body) ? body : [body];
        const cols = Object.keys(rows[0] || {}).filter((c) => IDENT.test(c));
        const prefer = req.headers.prefer || '';
        let sql;
        if (req.method === 'POST') {
          params.push(JSON.stringify(rows));
          sql = `insert into public."${name}" (${cols.map((c) => '"' + c + '"').join(', ')}) select ${cols.map((c) => '"' + c + '"').join(', ')} from json_populate_recordset(null::public."${name}", $1)`;
          if (/merge-duplicates/.test(prefer)) {
            const pk = meta.pk[name];
            sql += ` on conflict ("${pk}") do update set ` + cols.filter((c) => c !== pk).map((c) => `"${c}" = excluded."${c}"`).join(', ');
          }
        } else {
          params.push(JSON.stringify(rows[0]));
          sql = `update public."${name}" t set ` + cols.map((c) => `"${c}" = r."${c}"`).join(', ') + ` from json_populate_record(null::public."${name}", $1) r` + whereOf(url, params, 1).replace(/"([a-z_]+)"::text/g, 't."$1"::text');
        }
        sql += ' returning ' + (url.searchParams.get('select') || '*').split(',').map((c) => (c === '*' ? '*' : '"' + c + '"')).join(', ');
        const r = await asRole(claims, (c) => c.query(`with w as (${sql}) select coalesce(json_agg(w), '[]'::json) j from w`, params));
        return /return=representation/.test(prefer) ? send(res, 201, r.rows[0].j) : send(res, req.method === 'POST' ? 201 : 204);
      }
      if (req.method === 'DELETE') {
        const sql = `delete from public."${name}"` + whereOf(url, params, 0);
        await asRole(claims, (c) => c.query(sql, params));
        return send(res, 204);
      }
    } catch (e) {
      return pgError(res, e);
    }
    return send(res, 405, { message: 'metode tidak didukung' });
  }

  async function handleAuth(req, res, url) {
    const ep = url.pathname.replace(/^\/auth\/v1\//, '');
    const body = req.method === 'GET' ? {} : await readBody(req);
    if (ep === 'token' && url.searchParams.get('grant_type') === 'password') {
      const r = await pool.query('select id, email from auth.users where lower(email) = lower($1) and encrypted_password = crypt($2, encrypted_password)', [body.email || '', body.password || '']);
      if (!r.rows.length) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return send(res, 200, session(r.rows[0]));
    }
    if (ep === 'token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const usr = refresh.get(body.refresh_token);
      if (!usr) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
      refresh.delete(body.refresh_token);
      return send(res, 200, session(usr));
    }
    const claims = claimsOf(req);
    if (ep === 'user' && claims.sub) {
      if (req.method === 'PUT' && body.password) await pool.query("update auth.users set encrypted_password = crypt($2, gen_salt('bf', 4)) where id = $1", [claims.sub, body.password]);
      const r = await pool.query('select id, email from auth.users where id = $1', [claims.sub]);
      return send(res, 200, { id: r.rows[0].id, aud: 'authenticated', role: 'authenticated', email: r.rows[0].email, app_metadata: {}, user_metadata: {} });
    }
    if (ep === 'logout') return send(res, 204);
    return send(res, 401, { message: 'unauthorized' });
  }

  // Padanan supabase/functions/admin-users (memakai hak superuser hanya di server uji).
  async function handleAdminUsers(req, res) {
    const claims = claimsOf(req);
    const body = await readBody(req);
    const me = claims.sub ? (await pool.query('select role, active from public.users where id = $1', [claims.sub])).rows[0] : null;
    if (!me || me.role !== 'admin' || !me.active) return send(res, 403, { error: 'Hanya administrator aktif.' });
    try {
      if (body.action === 'create') {
        const u = (await pool.query("insert into auth.users (email, encrypted_password, raw_user_meta_data) values ($1, crypt($2, gen_salt('bf', 4)), $3) returning id", [body.email, body.password, { full_name: body.full_name }])).rows[0];
        await pool.query('update public.users set role = $2, active = true, full_name = $3 where id = $1', [u.id, body.role, body.full_name]);
        return send(res, 200, { id: u.id });
      }
      if (body.action === 'reset_password') {
        await pool.query("update auth.users set encrypted_password = crypt($2, gen_salt('bf', 4)) where id = $1", [body.id, body.password]);
        await pool.query('update public.users set must_change_password = true where id = $1', [body.id]);
        return send(res, 200, { ok: true });
      }
      if (body.action === 'delete') {
        if (body.id === claims.sub) return send(res, 400, { error: 'Tidak dapat menghapus akun sendiri.' });
        await pool.query('delete from auth.users where id = $1', [body.id]);
        return send(res, 200, { ok: true });
      }
      return send(res, 400, { error: 'Aksi tidak dikenal.' });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS' });
      return res.end();
    }
    try {
      if (url.pathname.startsWith('/rest/v1/')) return await handleRest(req, res, url);
      if (url.pathname.startsWith('/auth/v1/')) return await handleAuth(req, res, url);
      if (url.pathname === '/functions/v1/admin-users') return await handleAdminUsers(req, res);
      if (url.pathname.startsWith('/realtime/')) return send(res, 404, {});
      if (url.pathname === '/js/env.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        return res.end(`window.NP_CONFIG = ${JSON.stringify({ SUPABASE_URL: 'http://localhost:' + server.address().port, SUPABASE_ANON_KEY: ANON_KEY, APP_ENV: 'test' })};`);
      }
      const p = path.join(root, decodeURIComponent(url.pathname).replace(/^\/$/, '/index.html'));
      if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    } catch (e) {
      send(res, 500, { message: e.message });
    }
  });

  return loadMeta().then(() => new Promise((ok) => server.listen(opt.port || 0, () => ok({ server, pool, url: 'http://localhost:' + server.address().port, anonKey: ANON_KEY }))));
}

module.exports = { start };
