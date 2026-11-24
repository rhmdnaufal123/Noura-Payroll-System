// Supabase Edge Function: admin-users
// Mengelola akun Supabase Auth (buat, atur ulang kata sandi, hapus) atas permintaan ADMINISTRATOR.
// Service role key hanya tersedia di lingkungan server Supabase (variabel bawaan fungsi),
// TIDAK pernah dikirim ke browser.
//
// Deploy: supabase functions deploy admin-users
// Dipanggil aplikasi: supabase.functions.invoke('admin-users', { body: { action, ... } })
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const ROLES = ['admin', 'finance', 'ops', 'viewer'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Metode tidak didukung.' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // 1. Pastikan pemanggil adalah administrator aktif (memakai token pemanggil, tunduk RLS).
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false } });
  const { data: who } = await caller.auth.getUser();
  if (!who?.user) return json(401, { error: 'Sesi tidak valid. Silakan login ulang.' });
  const { data: me } = await caller.from('users').select('id, username, role, active').eq('id', who.user.id).maybeSingle();
  if (!me || me.role !== 'admin' || !me.active) return json(403, { error: 'Hanya administrator aktif yang dapat mengelola pengguna.' });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const audit = (action: string, id: string, detail: string) =>
    admin.from('audit_logs').insert({ user_id: me.id, username: me.username, action, entity: 'users', entity_id: id, detail });

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Body tidak valid.' });
  }

  try {
    if (body.action === 'create') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const fullName = String(body.full_name ?? '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'Email tidak valid.' });
      if (String(body.password ?? '').length < 8) return json(400, { error: 'Kata sandi minimal 8 karakter.' });
      if (!ROLES.includes(body.role)) return json(400, { error: 'Role tidak valid.' });
      if (fullName.length < 2) return json(400, { error: 'Nama lengkap wajib diisi.' });
      const { data, error } = await admin.auth.admin.createUser({ email, password: body.password, email_confirm: true, user_metadata: { full_name: fullName } });
      if (error) return json(400, { error: error.message });
      // Profil dibuat trigger database (nonaktif); aktifkan dengan role yang dipilih administrator.
      const { error: e2 } = await admin.from('users').update({ role: body.role, active: true, full_name: fullName, must_change_password: true }).eq('id', data.user.id);
      if (e2) return json(400, { error: e2.message });
      await audit('user.create', data.user.id, `Tambah pengguna ${email} (${body.role})`);
      return json(200, { id: data.user.id });
    }

    if (body.action === 'reset_password') {
      if (String(body.password ?? '').length < 8) return json(400, { error: 'Kata sandi minimal 8 karakter.' });
      const { error } = await admin.auth.admin.updateUserById(body.id, { password: body.password });
      if (error) return json(400, { error: error.message });
      await admin.from('users').update({ must_change_password: true }).eq('id', body.id);
      await audit('user.reset_password', body.id, 'Atur ulang kata sandi pengguna');
      return json(200, { ok: true });
    }

    if (body.action === 'delete') {
      if (body.id === me.id) return json(400, { error: 'Tidak dapat menghapus akun sendiri.' });
      const { data: target } = await admin.from('users').select('role, active, email').eq('id', body.id).maybeSingle();
      if (!target) return json(404, { error: 'Pengguna tidak ditemukan.' });
      if (target.role === 'admin' && target.active) {
        const { count } = await admin.from('users').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('active', true);
        if ((count ?? 0) <= 1) return json(400, { error: 'Minimal harus ada satu administrator aktif.' });
      }
      const { error } = await admin.auth.admin.deleteUser(body.id);
      if (error) return json(400, { error: error.message });
      await audit('user.delete', body.id, `Hapus pengguna ${target.email}`);
      return json(200, { ok: true });
    }

    return json(400, { error: 'Aksi tidak dikenal.' });
  } catch (e) {
    return json(500, { error: (e as Error).message });
  }
});
