// Membuat js/env.js dari file .env atau variabel lingkungan (mis. GitHub Actions vars).
// Hanya konfigurasi TIDAK SENSITIF yang ditulis. Kunci rahasia (service role / secret) ditolak.
// Pemakaian: node scripts/build-env.mjs            (membaca .env bila ada)
//            SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/build-env.mjs
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
const envFile = path.join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'APP_ENV']) if (process.env[k]) env[k] = process.env[k];

const url = (env.SUPABASE_URL || '').trim();
const key = (env.SUPABASE_ANON_KEY || '').trim();
function fail(msg) {
  console.error('build-env: ' + msg);
  process.exit(1);
}
if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url.replace(/\/$/, ''))) fail('SUPABASE_URL tidak valid: ' + url);
if (key.startsWith('sb_secret_')) fail('SUPABASE_ANON_KEY berisi SECRET key. Gunakan anon/publishable key.');
if (key.split('.').length === 3) {
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    if (payload.role && payload.role !== 'anon') fail('Kunci ber-role "' + payload.role + '" ditolak. Hanya anon key yang boleh dipakai di frontend.');
  } catch (e) {
    if (e && e.message && e.message.startsWith('build-env')) throw e;
  }
}
if (!!url !== !!key) fail('SUPABASE_URL dan SUPABASE_ANON_KEY harus diisi keduanya (atau dikosongkan keduanya untuk mode lokal).');

const conf = { SUPABASE_URL: url.replace(/\/$/, ''), SUPABASE_ANON_KEY: key, APP_ENV: env.APP_ENV || (url ? 'production' : 'local') };
const out = `/* Dihasilkan oleh scripts/build-env.mjs — konfigurasi TIDAK SENSITIF.
 * Kosong = mode lokal (IndexedDB, satu perangkat). Terisi = mode Supabase (database pusat). */
window.NP_CONFIG = ${JSON.stringify(conf, null, 2)};
`;
writeFileSync(path.join(root, 'js/env.js'), out);
console.log('js/env.js ditulis: ' + (url ? 'mode Supabase (' + url + ')' : 'mode lokal'));
