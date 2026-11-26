-- =====================================================================
-- Migrasi 9: jadwal masuk karyawan (pembuat jadwal bulanan).
--  * Satu jadwal per bulan per unit (ALL / APT / KLINIK).
--  * config      : shift, kebutuhan per hari (mingguan + per tanggal), karyawan yang
--                  dimasukkan, ketentuan tiap karyawan, isian manual.
--  * assignments : { "<id karyawan>": { "<tanggal 1..31>": "<kode shift>" | "L" } }
--  * Ditulis HANYA lewat fungsi save_work_schedule / delete_work_schedule
--    (Administrator, Admin Keuangan, Admin Operasional) dengan validasi & audit log.
--  * Kunci versi: penyimpanan dari perangkat lain yang memakai versi lama ditolak
--    agar jadwal tidak saling menimpa.
-- =====================================================================

create table if not exists public.work_schedules (
  id          text primary key,
  period      text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  unit        text not null default 'ALL' check (unit in ('ALL', 'APT', 'KLINIK')),
  title       text not null default '',
  config      jsonb not null default '{}'::jsonb,
  assignments jsonb not null default '{}'::jsonb,
  version     integer not null default 1 check (version >= 1),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  constraint work_schedules_period_unit_key unique (period, unit),
  constraint work_schedules_json_chk check (jsonb_typeof(config) = 'object' and jsonb_typeof(assignments) = 'object')
);

alter table public.work_schedules enable row level security;
revoke all on public.work_schedules from anon, public;
revoke all on public.work_schedules from authenticated;
grant select on public.work_schedules to authenticated;
drop policy if exists read_active_users on public.work_schedules;
create policy read_active_users on public.work_schedules for select to authenticated using (public.app_role() is not null);

create or replace function public.save_work_schedule(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period  text := p ->> 'period';
  v_unit    text := coalesce(nullif(p ->> 'unit', ''), 'ALL');
  v_id      text;
  v_cfg     jsonb := coalesce(p -> 'config', '{}'::jsonb);
  v_asg     jsonb := coalesce(p -> 'assignments', '{}'::jsonb);
  v_old     public.work_schedules;
  v_new     public.work_schedules;
  v_days    int;
  v_codes   text[] := '{}';
  v_emps    text[];
  v_sh      jsonb;
  v_code    text;
  v_emp     text;
  v_cells   jsonb;
  v_day     text;
  v_val     text;
  v_n       int := 0;
begin
  perform public.require_role('admin', 'finance', 'ops');
  if v_period is null or v_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Periode jadwal tidak valid (format YYYY-MM).';
  end if;
  if v_unit not in ('ALL', 'APT', 'KLINIK') then
    raise exception 'Unit jadwal tidak valid.';
  end if;
  if jsonb_typeof(v_cfg) <> 'object' or jsonb_typeof(v_asg) <> 'object' then
    raise exception 'Format jadwal tidak valid.';
  end if;
  if pg_column_size(v_cfg) + pg_column_size(v_asg) > 1000000 then
    raise exception 'Data jadwal terlalu besar.';
  end if;
  v_id := 'JDW-' || replace(v_period, '-', '') || '-' || v_unit;
  v_days := extract(day from (to_date(v_period || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day'))::int;

  -- shift
  if jsonb_typeof(v_cfg -> 'shifts') <> 'array' or jsonb_array_length(v_cfg -> 'shifts') = 0 then
    raise exception 'Minimal satu shift harus ditentukan.';
  end if;
  if jsonb_array_length(v_cfg -> 'shifts') > 12 then
    raise exception 'Maksimal 12 shift.';
  end if;
  for v_sh in select * from jsonb_array_elements(v_cfg -> 'shifts') loop
    v_code := v_sh ->> 'code';
    if v_code is null or v_code !~ '^[A-Z0-9]{1,3}$' or v_code = 'L' then
      raise exception 'Kode shift "%" tidak valid (1–3 huruf/angka kapital, selain L).', coalesce(v_code, '');
    end if;
    if v_code = any (v_codes) then
      raise exception 'Kode shift "%" dipakai lebih dari sekali.', v_code;
    end if;
    if coalesce(v_sh ->> 'start', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' or coalesce(v_sh ->> 'end', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
      raise exception 'Jam shift % tidak valid (HH:MM).', v_code;
    end if;
    v_codes := v_codes || v_code;
  end loop;

  -- karyawan yang dimasukkan
  select coalesce(array_agg(distinct x), '{}') into v_emps from jsonb_array_elements_text(coalesce(v_cfg -> 'employees', '[]'::jsonb)) x;
  if coalesce(array_length(v_emps, 1), 0) > 200 then
    raise exception 'Maksimal 200 karyawan per jadwal.';
  end if;
  if exists (select 1 from unnest(v_emps) e where not exists (select 1 from public.employees m where m.id = e)) then
    raise exception 'Ada karyawan pada jadwal yang tidak ditemukan.';
  end if;

  -- isian jadwal
  for v_emp, v_cells in select * from jsonb_each(v_asg) loop
    if not (v_emp = any (v_emps)) then
      raise exception 'Karyawan % tidak termasuk dalam jadwal ini.', v_emp;
    end if;
    if jsonb_typeof(v_cells) <> 'object' then
      raise exception 'Format jadwal karyawan % tidak valid.', v_emp;
    end if;
    for v_day, v_val in select * from jsonb_each_text(v_cells) loop
      if v_day !~ '^\d{1,2}$' or v_day::int < 1 or v_day::int > v_days then
        raise exception 'Tanggal % di luar bulan %.', v_day, v_period;
      end if;
      if not (v_val = 'L' or v_val = any (v_codes)) then
        raise exception 'Kode "%" pada tanggal % bukan shift yang terdaftar.', v_val, v_day;
      end if;
      v_n := v_n + 1;
    end loop;
  end loop;

  select * into v_old from public.work_schedules where id = v_id for update;
  if found and p ? 'version' and (p ->> 'version') is not null and (p ->> 'version')::int <> v_old.version then
    raise exception 'Jadwal % telah diubah oleh pengguna lain (versi %). Muat ulang halaman lalu ulangi perubahan.', v_period, v_old.version
      using errcode = '40001';
  end if;

  insert into public.work_schedules as w (id, period, unit, title, config, assignments, version, created_by, updated_by)
  values (v_id, v_period, v_unit, left(coalesce(p ->> 'title', ''), 120), v_cfg, v_asg, 1, auth.uid(), auth.uid())
  on conflict (id) do update
    set title = excluded.title, config = excluded.config, assignments = excluded.assignments,
        version = w.version + 1, updated_by = auth.uid(), updated_at = now()
  returning * into v_new;

  perform public.write_audit('schedule.save', 'work_schedules', v_id,
    'Simpan jadwal ' || v_period || ' (' || v_unit || '): ' || coalesce(array_length(v_emps, 1), 0) || ' karyawan, ' || v_n || ' isian, versi ' || v_new.version,
    case when v_old.id is null then null else to_jsonb(v_old) end, to_jsonb(v_new));
  return jsonb_build_object('id', v_new.id, 'version', v_new.version, 'updatedAt', v_new.updated_at);
end;
$$;

create or replace function public.delete_work_schedule(p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.work_schedules;
begin
  perform public.require_role('admin', 'finance', 'ops');
  delete from public.work_schedules where id = p_id returning * into v_old;
  if v_old.id is null then
    raise exception 'Jadwal tidak ditemukan.';
  end if;
  perform public.write_audit('schedule.delete', 'work_schedules', p_id, 'Hapus jadwal ' || v_old.period || ' (' || v_old.unit || ')', to_jsonb(v_old), null);
end;
$$;

revoke execute on function public.save_work_schedule(jsonb) from public, anon;
revoke execute on function public.delete_work_schedule(text) from public, anon;
grant execute on function public.save_work_schedule(jsonb) to authenticated;
grant execute on function public.delete_work_schedule(text) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'work_schedules') then
    alter publication supabase_realtime add table public.work_schedules;
  end if;
end;
$$;
