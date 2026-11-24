// Menggabungkan seluruh migrasi + seed menjadi supabase/setup.sql agar dapat ditempel sekali
// di Supabase Dashboard › SQL Editor (alternatif dari `supabase db push --include-seed`).
// Jalankan: node scripts/build-setup-sql.mjs
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'supabase/migrations');
const parts = ['-- =====================================================================',
  '-- Noura Payroll — SETUP LENGKAP (dihasilkan scripts/build-setup-sql.mjs; jangan diedit manual)',
  '-- Tempel seluruh isi file ini di Supabase Dashboard › SQL Editor lalu klik Run.',
  '-- Hanya untuk database BARU. Untuk pembaruan berikutnya gunakan migrasi baru.',
  '-- ====================================================================='];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  parts.push('', '-- >>> migrations/' + f, readFileSync(path.join(dir, f), 'utf8').trim());
}
parts.push('', '-- >>> seed.sql', readFileSync(path.join(root, 'supabase/seed.sql'), 'utf8').trim(), '');
writeFileSync(path.join(root, 'supabase/setup.sql'), parts.join('\n'));
console.log('supabase/setup.sql ditulis');
