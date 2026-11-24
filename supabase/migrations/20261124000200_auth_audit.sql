-- =====================================================================
-- Migrasi 2: hak akses (role), profil pengguna dari Supabase Auth, audit log.
-- =====================================================================

-- Role aktif pengguna yang sedang login (NULL bila tidak login / nonaktif).
create or replace function public.app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select u.role from public.users u where u.id = auth.uid() and u.active;
$$;

create or replace function public.has_role(variadic p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.app_role() = any (p_roles), false);
$$;

create or replace function public.require_role(variadic p_roles text[])
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_role(variadic p_roles) then
    raise exception 'Akses ditolak: tindakan ini memerlukan hak akses %.', array_to_string(p_roles, '/')
      using errcode = '42501';
  end if;
end;
$$;

create or replace function public.current_username()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select u.username from public.users u where u.id = auth.uid()), 'sistem');
$$;

-- ---------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------
create or replace function public.write_audit(p_action text, p_entity text, p_entity_id text, p_detail text, p_old jsonb default null, p_new jsonb default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_logs (user_id, username, action, entity, entity_id, detail, old_data, new_data)
  values (auth.uid(), public.current_username(), p_action, p_entity, coalesce(p_entity_id, ''), left(coalesce(p_detail, ''), 4000), p_old, p_new);
$$;

-- Dipanggil aplikasi untuk peristiwa non-data (login, ekspor, backup, cetak).
create or replace function public.log_event(p_action text, p_entity text, p_entity_id text default '', p_detail text default '')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.app_role() is null then
    raise exception 'Pengguna tidak aktif.' using errcode = '42501';
  end if;
  if p_action !~ '^[a-z][a-z0-9_.]{1,60}$' then
    raise exception 'Nama aksi audit tidak valid.';
  end if;
  perform public.write_audit('app.' || p_action, left(p_entity, 40), left(p_entity_id, 80), p_detail);
end;
$$;

-- Trigger audit generik untuk tabel master & keuangan.
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_id  text := coalesce(v_row ->> 'id', v_row ->> 'code', v_row ->> 'key', v_row ->> 'employee_id', '');
begin
  if tg_op = 'UPDATE' and v_old = v_new then
    return new;
  end if;
  -- Nomor rekening tidak disalin ke audit log (cukup dicatat bahwa ada perubahan).
  if tg_table_name = 'employee_bank_accounts' then
    v_old := v_old - 'account_number';
    v_new := v_new - 'account_number';
  end if;
  perform public.write_audit(lower(tg_op), tg_table_name, v_id, tg_table_name || ' ' || lower(tg_op), v_old, v_new);
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------
-- Profil pengguna dibuat otomatis saat akun Supabase Auth dibuat.
-- Pengguna pertama menjadi Administrator aktif; pengguna berikutnya
-- berstatus nonaktif (viewer) sampai diaktifkan administrator.
-- Role TIDAK pernah diambil dari metadata pendaftaran (mencegah eskalasi).
-- ---------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first    boolean;
  v_base     text;
  v_username text;
  v_n        int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('noura_users_bootstrap'));
  v_first := not exists (select 1 from public.users);
  v_base := lower(regexp_replace(coalesce(nullif(new.raw_user_meta_data ->> 'username', ''), split_part(new.email, '@', 1)), '[^a-zA-Z0-9._-]', '', 'g'));
  if length(v_base) < 3 then
    v_base := v_base || 'user';
  end if;
  v_base := left(v_base, 36);
  v_username := v_base;
  while exists (select 1 from public.users where username = v_username) loop
    v_n := v_n + 1;
    v_username := v_base || v_n;
  end loop;
  insert into public.users (id, email, username, full_name, role, active)
  values (new.id, new.email, v_username,
          coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), v_username),
          case when v_first then 'admin' else 'viewer' end,
          v_first);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Administrator mengubah role / status / nama pengguna.
create or replace function public.admin_update_user(p_id uuid, p_role text, p_active boolean, p_full_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.users;
begin
  perform public.require_role('admin');
  select * into v_old from public.users where id = p_id for update;
  if not found then
    raise exception 'Pengguna tidak ditemukan.';
  end if;
  if p_role not in ('admin', 'finance', 'ops', 'viewer') then
    raise exception 'Role tidak valid.';
  end if;
  if v_old.role = 'admin' and v_old.active and (p_role <> 'admin' or not p_active)
     and not exists (select 1 from public.users where id <> p_id and role = 'admin' and active) then
    raise exception 'Minimal harus ada satu administrator aktif.';
  end if;
  update public.users
     set role = p_role, active = p_active, full_name = coalesce(nullif(trim(p_full_name), ''), full_name), updated_at = now()
   where id = p_id;
end;
$$;

-- Pengguna menandai bahwa kata sandi sudah diganti.
create or replace function public.mark_password_changed()
returns void
language sql
security definer
set search_path = public
as $$
  update public.users set must_change_password = false, updated_at = now() where id = auth.uid();
$$;
