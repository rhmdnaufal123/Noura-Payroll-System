// Menghasilkan supabase/seed.sql (data referensi: unit, jabatan, departemen, komponen gaji,
// pengaturan bawaan) dari js/defaults.js & js/constants.js agar satu sumber kebenaran.
// Jalankan: node scripts/generate-seed.mjs
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
require(path.join(root, 'js/utils.js'));
require(path.join(root, 'js/constants.js'));
const NP = require(path.join(root, 'js/defaults.js'));
const { C } = NP;
const D = NP.defaults;
const q = (v) => (v === null || v === undefined ? 'null' : "'" + String(v).replace(/'/g, "''") + "'");
const j = (v) => q(JSON.stringify(v)) + '::jsonb';
const arr = (a) => "array[" + a.map(q).join(', ') + "]::text[]";
const out = [];
out.push('-- Data referensi Noura Payroll (dihasilkan oleh scripts/generate-seed.mjs — jangan diedit manual).');
out.push('-- Aman dijalankan berulang (ON CONFLICT DO NOTHING). Tidak berisi data karyawan/transaksi.');
out.push('begin;');
const S = D.DEFAULT_SETTINGS;
for (const [code, u] of Object.entries(S.units)) {
  out.push(`insert into public.business_units (code, name, address, phone, email, leader_name, leader_title) values (${q(code)}, ${q(u.name)}, '', '', '', '', ${q(u.leaderTitle)}) on conflict (code) do nothing;`);
}
let order = 0;
for (const unit of ['APT', 'KLINIK']) {
  for (const p of C.POSITIONS[unit]) {
    out.push(`insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values (${q(p)}, ${q(unit)}, ${q(C.roleOfPosition(p))}, ${C.ADMIN_POSITIONS.includes(p)}, ${order++}) on conflict (name) do nothing;`);
  }
  for (const d of C.DEPARTMENTS[unit]) {
    out.push(`insert into public.departments (name, unit_code) values (${q(d)}, ${q(unit)}) on conflict on constraint departments_name_unit_key do nothing;`);
  }
}
for (const c of D.DEFAULT_COMPONENTS) {
  out.push(`insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values (${q(c.code)}, ${q(c.name)}, ${q(c.type)}, ${q(c.group)}, ${q(c.calc)}, ${c.value}, ${j(c.positionValues)}, ${arr(c.units)}, ${arr(c.positions)}, ${c.active}, ${!!c.fixed}, ${c.taxable !== false}, ${!!c.system}, ${c.order || 50}) on conflict (code) do nothing;`);
}
for (const key of ['company', 'payroll', 'tax', 'bpjs', 'salesBonus', 'slip', 'numbering', 'backup', 'security']) {
  out.push(`insert into public.app_settings (key, value) values (${q(key)}, ${j(S[key])}) on conflict (key) do nothing;`);
}
out.push('commit;');
writeFileSync(path.join(root, 'supabase/seed.sql'), out.join('\n') + '\n');
console.log('supabase/seed.sql ditulis (' + out.length + ' baris)');
