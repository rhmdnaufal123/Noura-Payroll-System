-- =====================================================================
-- Noura Payroll — SETUP LENGKAP (dihasilkan scripts/build-setup-sql.mjs; jangan diedit manual)
-- Tempel seluruh isi file ini di Supabase Dashboard › SQL Editor lalu klik Run.
-- Hanya untuk database BARU. Untuk pembaruan berikutnya gunakan migrasi baru.
-- =====================================================================

-- >>> migrations/20261124000100_schema.sql
-- =====================================================================
-- Noura Payroll Management — skema relasional (PostgreSQL / Supabase)
-- Migrasi 1: ekstensi, tabel, relasi, constraint, indeks.
-- Semua nilai uang disimpan sebagai BIGINT rupiah (tanpa pecahan).
-- =====================================================================

-- gen_random_uuid() sudah bawaan PostgreSQL 13+. btree_gist dipakai constraint EXCLUDE
-- (anti penggajian ganda) dan dipasang di skema "extensions" sesuai praktik Supabase.
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------
-- Penomoran dokumen atomik (dipakai default kolom & fungsi RPC)
-- ---------------------------------------------------------------------
create table public.doc_counters (
  key   text primary key,
  value bigint not null default 0 check (value >= 0)
);

create table public.app_settings (
  key        text primary key check (key ~ '^[a-zA-Z_]{2,40}$'),
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create or replace function public.next_counter(p_key text)
returns bigint
language sql
security definer
set search_path = public
as $$
  insert into public.doc_counters as c (key, value) values (p_key, 1)
  on conflict (key) do update set value = c.value + 1
  returning value;
$$;

create or replace function public.doc_prefix(p_kind text, p_default text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif((select value ->> p_kind from public.app_settings where key = 'numbering'), ''), p_default);
$$;

create or replace function public.next_code(p_kind text, p_default_prefix text, p_width int default 4)
returns text
language sql
security definer
set search_path = public
as $$
  select public.doc_prefix(p_kind, p_default_prefix) || '-' || lpad(public.next_counter(p_kind)::text, p_width, '0');
$$;

-- ---------------------------------------------------------------------
-- Master organisasi
-- ---------------------------------------------------------------------
create table public.business_units (
  code         text primary key check (code in ('APT', 'KLINIK')),
  name         text not null check (length(trim(name)) >= 3),
  address      text not null default '',
  phone        text not null default '',
  email        text not null default '',
  logo_url     text,
  leader_name  text not null default '',
  leader_title text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.departments (
  id        bigint generated always as identity primary key,
  name      text not null check (length(trim(name)) >= 2),
  unit_code text references public.business_units (code),
  constraint departments_name_unit_key unique nulls not distinct (name, unit_code)
);

create table public.positions (
  id             bigint generated always as identity primary key,
  name           text not null unique,
  unit_code      text not null references public.business_units (code),
  role_key       text not null check (role_key in ('dokter', 'bidan', 'perawat', 'farmasi', 'petugas')),
  is_admin_staff boolean not null default false,
  sort_order     int not null default 0
);

-- ---------------------------------------------------------------------
-- Pengguna aplikasi (profil & hak akses; kredensial ada di auth.users)
-- ---------------------------------------------------------------------
create table public.users (
  id                   uuid primary key references auth.users (id) on delete cascade,
  email                text not null,
  username             text not null unique check (username ~ '^[a-zA-Z0-9._-]{3,40}$'),
  full_name            text not null check (length(trim(full_name)) >= 2),
  role                 text not null default 'viewer' check (role in ('admin', 'finance', 'ops', 'viewer')),
  active               boolean not null default false,
  must_change_password boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Karyawan
-- ---------------------------------------------------------------------
create table public.employees (
  id                 text primary key default public.next_code('employee', 'KRY', 4),
  full_name          text not null check (length(trim(full_name)) >= 3),
  photo_url          text,
  gender             text not null default '' check (gender in ('', 'Laki-laki', 'Perempuan')),
  address            text not null default '',
  phone              text not null check (phone ~ '^[0-9+() -]{8,20}$'),
  email              text not null default '' check (email = '' or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  unit               text not null check (unit in ('APT', 'KLINIK', 'LINTAS')),
  primary_unit       text not null references public.business_units (code),
  cost_split_apt     numeric(5, 2) not null default 100 check (cost_split_apt between 0 and 100),
  position_id        bigint not null references public.positions (id),
  department_id      bigint not null references public.departments (id),
  start_date         date not null,
  status             text not null default 'aktif' check (status in ('aktif', 'nonaktif', 'cuti', 'resign')),
  base_salary        bigint not null default 0 check (base_salary >= 0),
  pay_scheme         text not null default 'monthly' check (pay_scheme in ('monthly', 'per_session', 'per_patient', 'per_shift', 'per_action', 'service_only', 'monthly_service', 'monthly_incentive', 'combination')),
  pay_config         jsonb not null default '{}'::jsonb check (jsonb_typeof(pay_config) = 'object'),
  pay_method         text not null default 'Transfer Bank' check (pay_method in ('Transfer Bank', 'Tunai')),
  str_number         text not null default '',
  sip_number         text not null default '',
  health_status      text not null default '',
  schedule           text not null default '',
  service_fee_method text not null default 'Digabung dalam slip gaji',
  bpjs_kes           boolean not null default true,
  bpjs_tk            boolean not null default true,
  bpjs_wage          bigint not null default 0 check (bpjs_wage >= 0),
  pph21              boolean not null default true,
  ptkp               text not null default 'TK/0' check (ptkp in ('TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3')),
  sales_target       bigint not null default 0 check (sales_target >= 0),
  component_overrides jsonb not null default '{}'::jsonb check (jsonb_typeof(component_overrides) = 'object'),
  notes              text not null default '',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid,
  constraint employees_primary_unit_chk check (unit = 'LINTAS' or primary_unit = unit),
  constraint employees_split_chk check (unit = 'LINTAS' or cost_split_apt = case unit when 'APT' then 100 else 0 end)
);
create index employees_position_idx on public.employees (position_id);
create index employees_status_idx on public.employees (status);

-- Data rekening dipisah agar dapat dibatasi khusus admin & keuangan (RLS).
create table public.employee_bank_accounts (
  employee_id    text primary key references public.employees (id) on delete cascade,
  bank_name      text not null default '',
  account_number text not null default '' check (account_number = '' or account_number ~ '^[0-9-]{5,30}$'),
  account_holder text not null default '',
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Komponen gaji
-- ---------------------------------------------------------------------
create table public.salary_components (
  code            text primary key check (code ~ '^[A-Z0-9_]{2,20}$'),
  name            text not null check (length(trim(name)) >= 3),
  type            text not null check (type in ('earning', 'deduction')),
  grp             text not null,
  calc            text not null check (calc in ('system', 'fixed', 'percent', 'per_day', 'per_shift', 'per_hour', 'per_occurrence', 'per_absent_day', 'attendance', 'manual')),
  value           numeric(16, 2) not null default 0 check (value >= 0),
  position_values jsonb not null default '{}'::jsonb check (jsonb_typeof(position_values) = 'object'),
  units           text[] not null default '{}',
  positions       text[] not null default '{}',
  active          boolean not null default true,
  is_fixed        boolean not null default false,
  taxable         boolean not null default true,
  is_system       boolean not null default false,
  sort_order      int not null default 50,
  updated_at      timestamptz not null default now(),
  constraint salary_components_grp_chk check (
    (type = 'earning' and grp in ('base', 'allowance', 'overtime', 'bonus', 'incentive', 'practice', 'service', 'other')) or
    (type = 'deduction' and grp in ('bpjs', 'tax', 'late', 'absent', 'kasbon', 'loan', 'other'))),
  constraint salary_components_pct_chk check (calc <> 'percent' or value <= 100),
  constraint salary_components_units_chk check (units <@ array['APT', 'KLINIK', 'LINTAS']::text[])
);

-- ---------------------------------------------------------------------
-- Master tindakan & aturan pembagian pendapatan
-- ---------------------------------------------------------------------
create table public.service_master (
  id         text primary key default public.next_code('service', 'TND', 4),
  name       text not null check (length(trim(name)) >= 3),
  category   text not null check (category in ('Pemeriksaan laboratorium sederhana', 'Pemeriksaan kesehatan', 'Pemeriksaan dokter', 'Tindakan medis', 'Tindakan kebidanan', 'Tindakan keperawatan', 'Pelayanan farmasi', 'Penjualan produk', 'Pelayanan lainnya')),
  unit_code  text not null references public.business_units (code),
  price      bigint not null check (price > 0),
  method     text not null default 'nominal' check (method in ('nominal', 'percent', 'combo')),
  active     boolean not null default true,
  notes      text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index service_master_name_unit_key on public.service_master (lower(name), unit_code);

-- employee_id NULL = aturan standar; terisi = pembagian khusus bila petugas tsb. melaksanakan.
create table public.service_revenue_rules (
  id                 bigint generated always as identity primary key,
  service_id         text not null references public.service_master (id) on delete cascade,
  employee_id        text references public.employees (id),
  sort_order         int not null check (sort_order >= 0),
  recipient_type     text not null check (recipient_type in ('unit', 'role', 'employee', 'other')),
  target             text not null check (length(trim(target)) >= 1),
  target_employee_id text references public.employees (id),
  mode               text not null check (mode in ('nominal', 'percent', 'remainder')),
  value              numeric(16, 4) not null default 0 check (value >= 0),
  constraint rules_pct_chk check (mode <> 'percent' or value <= 100),
  constraint rules_unit_chk check (recipient_type <> 'unit' or target in ('APT', 'KLINIK')),
  constraint rules_role_chk check (recipient_type <> 'role' or target in ('dokter', 'bidan', 'perawat', 'farmasi', 'petugas')),
  constraint rules_emp_chk check ((recipient_type = 'employee') = (target_employee_id is not null) and (recipient_type <> 'employee' or target = target_employee_id))
);
create unique index service_revenue_rules_order_key on public.service_revenue_rules (service_id, coalesce(employee_id, ''), sort_order);

-- ---------------------------------------------------------------------
-- Penggajian (dibuat sebelum alokasi karena direferensikan)
-- ---------------------------------------------------------------------
create table public.payroll_periods (
  id              text primary key,
  period          text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  start_date      date not null,
  end_date        date not null,
  pay_date        date not null,
  unit_filter     text not null default 'ALL' check (unit_filter in ('ALL', 'APT', 'KLINIK')),
  status          text not null default 'draft' check (status in ('draft', 'approved', 'locked')),
  stale           boolean not null default false,
  stale_reason    text not null default '',
  include_earlier boolean not null default false,
  notes           text not null default '',
  totals          jsonb not null default '{}'::jsonb,
  history         jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  approved_at     timestamptz,
  approved_by     uuid,
  locked_at       timestamptz,
  locked_by       uuid,
  constraint payroll_periods_range_chk check (end_date >= start_date),
  constraint payroll_periods_locked_chk check (status <> 'locked' or locked_at is not null)
);
create index payroll_periods_period_idx on public.payroll_periods (period);

create table public.payroll_records (
  id                uuid primary key default gen_random_uuid(),
  period_id         text not null references public.payroll_periods (id) on delete cascade,
  employee_id       text not null references public.employees (id),
  start_date        date not null,
  end_date          date not null,
  slip_no           text unique,
  employee_snapshot jsonb not null,
  inputs            jsonb not null default '{}'::jsonb,
  gross             bigint not null,
  deductions        bigint not null check (deductions >= 0),
  net               bigint not null,
  totals            jsonb not null default '{}'::jsonb,
  allocation        jsonb not null default '{}'::jsonb,
  split             jsonb not null default '{}'::jsonb,
  employer          jsonb not null default '{}'::jsonb,
  tax_info          jsonb,
  warnings          jsonb not null default '[]'::jsonb,
  service_detail    jsonb not null default '[]'::jsonb,
  service_count     int not null default 0,
  service_qty       int not null default 0,
  created_at        timestamptz not null default now(),
  constraint payroll_records_net_chk check (net = gross - deductions),
  constraint payroll_records_emp_period_key unique (period_id, employee_id),
  -- Satu karyawan tidak boleh digaji dua kali pada rentang tanggal yang beririsan.
  constraint payroll_records_no_overlap exclude using gist (employee_id with =, daterange(start_date, end_date, '[]') with &&)
);

create table public.payroll_details (
  id         bigint generated always as identity primary key,
  record_id  uuid not null references public.payroll_records (id) on delete cascade,
  line_type  text not null check (line_type in ('earning', 'deduction')),
  code       text not null,
  name       text not null,
  grp        text not null,
  amount     bigint not null,
  is_fixed   boolean not null default false,
  taxable    boolean not null default true,
  note       text not null default '',
  sort_order int not null default 0
);
create index payroll_details_record_idx on public.payroll_details (record_id);

create table public.payslips (
  id          uuid primary key default gen_random_uuid(),
  record_id   uuid not null unique references public.payroll_records (id) on delete cascade,
  period_id   text not null references public.payroll_periods (id) on delete cascade,
  employee_id text not null references public.employees (id),
  slip_no     text not null unique,
  issued_at   timestamptz not null default now(),
  issued_by   uuid
);

-- ---------------------------------------------------------------------
-- Transaksi tindakan, item, dan alokasi pendapatan
-- ---------------------------------------------------------------------
create table public.service_transactions (
  id              text primary key,
  trx_date        date not null,
  patient_name    text not null default '',
  patient_code    text not null default '',
  note            text not null default '',
  status          text not null default 'active' check (status in ('active', 'cancelled')),
  cancel_reason   text,
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  cancelled_by_name text,
  gross           bigint not null default 0 check (gross >= 0),
  corrections     jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  created_by_name text not null default '',
  updated_at      timestamptz,
  updated_by      uuid,
  constraint service_transactions_cancel_chk check (status = 'active' or (cancel_reason is not null and cancelled_at is not null))
);
create index service_transactions_date_idx on public.service_transactions (trx_date);

create table public.service_transaction_items (
  id                   uuid primary key default gen_random_uuid(),
  transaction_id       text not null references public.service_transactions (id) on delete cascade,
  line_no              int not null check (line_no >= 1),
  service_id           text not null references public.service_master (id),
  service_code         text not null,
  service_name         text not null,
  category             text not null,
  unit_code            text not null references public.business_units (code),
  qty                  int not null check (qty >= 1),
  unit_price           bigint not null check (unit_price > 0),
  gross                bigint not null,
  performers           jsonb not null default '{}'::jsonb,
  performer_names      jsonb not null default '{}'::jsonb,
  override_employee_id text references public.employees (id),
  constraint items_gross_chk check (gross = qty * unit_price),
  constraint items_line_key unique (transaction_id, line_no)
);
create index service_transaction_items_trx_idx on public.service_transaction_items (transaction_id);

create table public.service_transaction_allocations (
  id                    uuid primary key default gen_random_uuid(),
  transaction_id        text not null references public.service_transactions (id) on delete cascade,
  item_id               uuid references public.service_transaction_items (id) on delete cascade,
  kind                  text not null check (kind in ('share', 'adjustment')),
  sort_order            int not null default 0,
  recipient_type        text not null check (recipient_type in ('unit', 'role', 'employee', 'other')),
  target                text not null default '',
  recipient_employee_id text references public.employees (id),
  recipient_unit        text references public.business_units (code),
  recipient_name        text not null,
  category              text not null check (category in ('apotek', 'klinik', 'dokter', 'bidan', 'perawat', 'farmasi', 'petugas', 'eksternal')),
  mode                  text check (mode in ('nominal', 'percent', 'remainder')),
  rule_value            numeric(16, 4) not null default 0,
  unit_amount           bigint not null default 0,
  amount                bigint not null,
  is_implicit           boolean not null default false,
  adj_date              date,
  adj_kind              text check (adj_kind in ('koreksi', 'pembatalan')),
  adj_note              text,
  adj_by                text,
  payroll_period_id     text references public.payroll_periods (id),
  payroll_record_id     uuid references public.payroll_records (id) on delete set null,
  payroll_state         text check (payroll_state in ('draft', 'approved', 'locked')),
  created_at            timestamptz not null default now(),
  constraint alloc_payroll_pair_chk check ((payroll_period_id is null) = (payroll_state is null)),
  constraint alloc_payroll_emp_chk check (payroll_period_id is null or recipient_employee_id is not null),
  constraint alloc_kind_chk check (
    (kind = 'share' and item_id is not null and amount >= 0 and unit_amount >= 0) or
    (kind = 'adjustment' and item_id is null and recipient_employee_id is not null and adj_date is not null and adj_kind is not null)),
  constraint alloc_recipient_chk check (
    (recipient_type = 'unit' and recipient_unit is not null) or
    (recipient_type in ('role', 'employee') and (recipient_employee_id is not null or kind = 'share')) or
    (recipient_type = 'other'))
);
create index allocations_trx_idx on public.service_transaction_allocations (transaction_id);
create index allocations_item_idx on public.service_transaction_allocations (item_id);
create index allocations_emp_idx on public.service_transaction_allocations (recipient_employee_id) where recipient_employee_id is not null;
create index allocations_period_idx on public.service_transaction_allocations (payroll_period_id) where payroll_period_id is not null;

-- ---------------------------------------------------------------------
-- Catatan shift & sesi praktik
-- ---------------------------------------------------------------------
create table public.worklogs (
  id          uuid primary key default gen_random_uuid(),
  employee_id text not null references public.employees (id),
  work_date   date not null,
  shifts      numeric(6, 2) not null default 0 check (shifts >= 0),
  sessions    numeric(6, 2) not null default 0 check (sessions >= 0),
  note        text not null default '',
  created_at  timestamptz not null default now(),
  created_by  uuid,
  constraint worklogs_nonzero_chk check (shifts > 0 or sessions > 0)
);
create index worklogs_emp_date_idx on public.worklogs (employee_id, work_date);

-- ---------------------------------------------------------------------
-- Audit log (hanya tambah; tidak dapat diubah/dihapus oleh pengguna)
-- ---------------------------------------------------------------------
create table public.audit_logs (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  user_id   uuid,
  username  text not null default 'sistem',
  action    text not null,
  entity    text not null,
  entity_id text not null default '',
  detail    text not null default '',
  old_data  jsonb,
  new_data  jsonb
);
create index audit_logs_ts_idx on public.audit_logs (ts desc);
create index audit_logs_entity_idx on public.audit_logs (entity, entity_id);

-- >>> migrations/20261124000200_auth_audit.sql
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

-- >>> migrations/20261124000300_business_functions.sql
-- =====================================================================
-- Migrasi 3: logika bisnis di server (PL/pgSQL).
-- Setiap fungsi RPC berjalan dalam SATU transaksi database: bila ada
-- langkah yang gagal, seluruh perubahan dibatalkan. Fungsi bertipe
-- SECURITY DEFINER dan memeriksa role pemanggil secara eksplisit.
-- =====================================================================

create or replace function public.jakarta_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Jakarta')::date;
$$;

create or replace function public.role_label(p_role text)
returns text
language sql
immutable
as $$
  select case p_role when 'dokter' then 'Dokter' when 'bidan' then 'Bidan' when 'perawat' then 'Perawat'
                     when 'farmasi' then 'Tenaga Farmasi' else 'Petugas Lain' end;
$$;

create or replace function public.mask_account(p text)
returns text
language sql
immutable
as $$
  select case when coalesce(p, '') = '' then '-'
              when length(p) <= 4 then '****'
              else repeat('*', greatest(4, length(p) - 4)) || right(p, 4) end;
$$;

-- =====================================================================
-- MESIN PEMBAGIAN PENDAPATAN (padanan js/revenue-sharing.js)
-- nominal  : rupiah tetap per tindakan
-- percent  : persen harga, dibulatkan dengan metode sisa terbesar
-- remainder: sisa harga dibagi rata
-- Sisa yang tidak teralokasi otomatis menjadi bagian unit tindakan.
-- =====================================================================
create or replace function public.compute_allocations(p_service_id text, p_price bigint, p_qty int, p_performers jsonb, p_preview boolean default false)
returns table (
  sort_order int, recipient_type text, target text, recipient_employee_id text, recipient_unit text, recipient_name text,
  category text, mode text, rule_value numeric, unit_amount bigint, amount bigint, is_implicit boolean, override_employee_id text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_svc      public.service_master;
  v_perf     jsonb := coalesce(p_performers, '{}'::jsonb);
  v_override text;
  v_rules    public.service_revenue_rules[];
  r          public.service_revenue_rules;
  n          int;
  i          int;
  k          int;
  v_unit     bigint[];
  v_fixed    bigint := 0;
  v_psum     numeric := 0;
  v_pidx     int[] := '{}';
  v_raw      numeric[] := '{}';
  v_floor    bigint[] := '{}';
  v_order    int[];
  v_target   bigint;
  v_rest     bigint;
  v_ridx     int[] := '{}';
  v_each     bigint;
  v_res      bigint;
begin
  select * into v_svc from public.service_master s where s.id = p_service_id;
  if not found then
    raise exception 'Tindakan % tidak ditemukan.', p_service_id;
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'Harga jual tidak boleh negatif.';
  end if;
  if p_qty is null or p_qty < 1 then
    raise exception 'Jumlah tindakan minimal 1.';
  end if;

  -- Pembagian khusus petugas: override pertama yang petugasnya ikut melaksanakan.
  select g.employee_id into v_override
    from (select rr.employee_id, min(rr.id) as first_id
            from public.service_revenue_rules rr
           where rr.service_id = p_service_id and rr.employee_id is not null
           group by rr.employee_id) g
   where g.employee_id in (select je.value from jsonb_each_text(v_perf) je)
   order by g.first_id
   limit 1;

  select coalesce(array_agg(rr order by rr.sort_order), '{}') into v_rules
    from public.service_revenue_rules rr
   where rr.service_id = p_service_id and rr.employee_id is not distinct from v_override;
  n := coalesce(array_length(v_rules, 1), 0);
  v_unit := array_fill(0::bigint, array[greatest(n, 1)]);

  -- 1. nominal & kumpulkan persen
  for i in 1..n loop
    r := v_rules[i];
    if r.mode = 'nominal' then
      v_unit[i] := round(r.value)::bigint;
      v_fixed := v_fixed + v_unit[i];
    elsif r.mode = 'percent' then
      v_pidx := v_pidx || i;
      v_psum := v_psum + r.value;
    end if;
  end loop;
  if v_psum > 100.0000001 then
    raise exception '%', 'Total persentase ' || round(v_psum, 2) || '% melebihi 100%.';
  end if;

  -- 2. persen dengan pembulatan sisa terbesar
  if array_length(v_pidx, 1) > 0 then
    v_target := round(p_price * v_psum / 100.0)::bigint;
    foreach i in array v_pidx loop
      v_raw := v_raw || (p_price * v_rules[i].value / 100.0);
      v_floor := v_floor || floor(p_price * v_rules[i].value / 100.0 + 0.000000001)::bigint;
    end loop;
    v_rest := v_target - (select coalesce(sum(x), 0) from unnest(v_floor) x);
    select array_agg(o.ord order by o.frac desc, o.ord) into v_order
      from (select g.ord, v_raw[g.ord] - floor(v_raw[g.ord] + 0.000000001) as frac
              from generate_subscripts(v_raw, 1) as g(ord)) o;
    k := 0;
    while v_rest > 0 loop
      v_floor[v_order[(k % array_length(v_order, 1)) + 1]] := v_floor[v_order[(k % array_length(v_order, 1)) + 1]] + 1;
      v_rest := v_rest - 1;
      k := k + 1;
    end loop;
    for k in 1..array_length(v_pidx, 1) loop
      v_unit[v_pidx[k]] := v_floor[k];
      v_fixed := v_fixed + v_floor[k];
    end loop;
  end if;

  if v_fixed > p_price then
    raise exception 'Total pembagian Rp% melebihi harga jual Rp%.', v_fixed, p_price;
  end if;

  -- 3. sisa harga
  for i in 1..n loop
    if v_rules[i].mode = 'remainder' then
      v_ridx := v_ridx || i;
    end if;
  end loop;
  v_rest := greatest(0, p_price - v_fixed);
  if array_length(v_ridx, 1) > 0 then
    v_each := v_rest / array_length(v_ridx, 1);
    v_res := v_rest - v_each * array_length(v_ridx, 1);
    foreach i in array v_ridx loop
      v_unit[i] := v_each + case when v_res > 0 then 1 else 0 end;
      if v_res > 0 then
        v_res := v_res - 1;
      end if;
    end loop;
    v_rest := 0;
  end if;

  -- 4. penerima
  for i in 1..n loop
    r := v_rules[i];
    sort_order := r.sort_order;
    recipient_type := r.recipient_type;
    target := r.target;
    recipient_employee_id := null;
    recipient_unit := null;
    mode := r.mode;
    rule_value := r.value;
    unit_amount := v_unit[i];
    amount := v_unit[i] * p_qty;
    is_implicit := false;
    override_employee_id := v_override;
    if r.recipient_type = 'unit' then
      recipient_unit := r.target;
      select bu.name into recipient_name from public.business_units bu where bu.code = r.target;
      category := case r.target when 'APT' then 'apotek' else 'klinik' end;
    elsif r.recipient_type = 'role' then
      category := r.target;
      recipient_employee_id := nullif(v_perf ->> r.target, '');
      if recipient_employee_id is null then
        if not p_preview then
          raise exception 'Petugas % belum dipilih.', public.role_label(r.target);
        end if;
        recipient_name := '(' || public.role_label(r.target) || ' pelaksana)';
      else
        select e.full_name into recipient_name from public.employees e where e.id = recipient_employee_id;
        if not found then
          raise exception 'Petugas % tidak ditemukan.', recipient_employee_id;
        end if;
      end if;
    elsif r.recipient_type = 'employee' then
      recipient_employee_id := r.target_employee_id;
      select e.full_name, p.role_key into recipient_name, category
        from public.employees e join public.positions p on p.id = e.position_id
       where e.id = r.target_employee_id;
    else
      recipient_name := r.target;
      category := 'eksternal';
    end if;
    return next;
  end loop;

  if v_rest > 0 then
    sort_order := n;
    recipient_type := 'unit';
    target := v_svc.unit_code;
    recipient_employee_id := null;
    recipient_unit := v_svc.unit_code;
    select bu.name into recipient_name from public.business_units bu where bu.code = v_svc.unit_code;
    category := case v_svc.unit_code when 'APT' then 'apotek' else 'klinik' end;
    mode := 'remainder';
    rule_value := 0;
    unit_amount := v_rest;
    amount := v_rest * p_qty;
    is_implicit := true;
    override_employee_id := v_override;
    return next;
  end if;
end;
$$;

-- =====================================================================
-- MASTER TINDAKAN
-- p: { id?, name, category, unit, price, active, notes, shares:[{type,target,mode,value}], overrides:[{employeeId, shares}] }
-- =====================================================================
create or replace function public._insert_rules(p_service_id text, p_employee_id text, p_shares jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s   jsonb;
  v_ord bigint;
begin
  if jsonb_typeof(coalesce(p_shares, '[]'::jsonb)) <> 'array' then
    raise exception 'Format pembagian tidak valid.';
  end if;
  for v_s, v_ord in select e.value, e.ordinality from jsonb_array_elements(coalesce(p_shares, '[]'::jsonb)) with ordinality e loop
    insert into public.service_revenue_rules (service_id, employee_id, sort_order, recipient_type, target, target_employee_id, mode, value)
    values (p_service_id, p_employee_id, v_ord - 1, v_s ->> 'type', trim(coalesce(v_s ->> 'target', '')),
            case when v_s ->> 'type' = 'employee' then v_s ->> 'target' end,
            v_s ->> 'mode', case when v_s ->> 'mode' = 'remainder' then 0 else coalesce((v_s ->> 'value')::numeric, 0) end);
  end loop;
end;
$$;

create or replace function public.save_service(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     text := nullif(p ->> 'id', '');
  v_old    public.service_master;
  v_modes  text[];
  v_method text;
  v_ov     jsonb;
  v_emps   text[] := '{}';
begin
  perform public.require_role('admin');
  if coalesce(jsonb_array_length(p -> 'shares'), 0) = 0 then
    raise exception 'Minimal satu penerima pendapatan.';
  end if;
  select array_agg(distinct s ->> 'mode') into v_modes
    from jsonb_array_elements(p -> 'shares') s where s ->> 'mode' <> 'remainder';
  v_method := case when coalesce(array_length(v_modes, 1), 0) = 0 then 'nominal'
                   when array_length(v_modes, 1) = 1 then v_modes[1] else 'combo' end;
  begin
    if v_id is null then
      insert into public.service_master (name, category, unit_code, price, method, active, notes)
      values (trim(p ->> 'name'), p ->> 'category', p ->> 'unit', (p ->> 'price')::bigint, v_method,
              coalesce((p ->> 'active')::boolean, true), coalesce(p ->> 'notes', ''))
      returning id into v_id;
    else
      select * into v_old from public.service_master where id = v_id for update;
      if not found then
        raise exception 'Tindakan % tidak ditemukan.', v_id;
      end if;
      update public.service_master
         set name = trim(p ->> 'name'), category = p ->> 'category', unit_code = p ->> 'unit', price = (p ->> 'price')::bigint,
             method = v_method, active = coalesce((p ->> 'active')::boolean, true), notes = coalesce(p ->> 'notes', ''), updated_at = now()
       where id = v_id;
    end if;
  exception when unique_violation then
    raise exception 'Nama tindakan sudah ada pada unit yang sama.';
  end;

  delete from public.service_revenue_rules where service_id = v_id;
  perform public._insert_rules(v_id, null, p -> 'shares');
  for v_ov in select e.value from jsonb_array_elements(coalesce(p -> 'overrides', '[]'::jsonb)) e loop
    if coalesce(v_ov ->> 'employeeId', '') = '' then
      raise exception 'Pembagian khusus petugas: karyawan wajib dipilih.';
    end if;
    if (v_ov ->> 'employeeId') = any (v_emps) then
      raise exception 'Pembagian khusus untuk karyawan yang sama tidak boleh ganda.';
    end if;
    v_emps := v_emps || (v_ov ->> 'employeeId');
    perform public._insert_rules(v_id, v_ov ->> 'employeeId', v_ov -> 'shares');
  end loop;

  -- Validasi konfigurasi (melempar error -> seluruh penyimpanan dibatalkan)
  perform 1 from public.compute_allocations(v_id, (p ->> 'price')::bigint, 1, '{}'::jsonb, true);
  perform 1 from unnest(v_emps) emp, lateral public.compute_allocations(v_id, (p ->> 'price')::bigint, 1, jsonb_build_object('x', emp), true);

  perform public.write_audit(case when v_old.id is null then 'service.save_new' else 'service.save' end, 'service_master', v_id,
    'Simpan tindakan ' || trim(p ->> 'name') || ' (Rp' || (p ->> 'price') || ')' ||
    case when v_old.id is not null and v_old.price <> (p ->> 'price')::bigint then '; harga Rp' || v_old.price || ' -> Rp' || (p ->> 'price') else '' end,
    to_jsonb(v_old), p);
  return v_id;
end;
$$;

create or replace function public.set_service_active(p_id text, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_role('admin');
  update public.service_master set active = p_active, updated_at = now() where id = p_id;
  if not found then
    raise exception 'Tindakan tidak ditemukan.';
  end if;
end;
$$;

create or replace function public.delete_service(p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
begin
  perform public.require_role('admin');
  select count(*) into v_used from public.service_transaction_items where service_id = p_id;
  if v_used > 0 then
    raise exception 'Tindakan sudah dipakai pada % transaksi. Nonaktifkan saja agar riwayat tetap utuh.', v_used;
  end if;
  delete from public.service_master where id = p_id;
end;
$$;

-- =====================================================================
-- KARYAWAN
-- =====================================================================
create or replace function public.save_employee(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    text := nullif(p ->> 'id', '');
  v_pos   public.positions;
  v_dept  bigint;
  v_unit  text := p ->> 'unit';
  v_prim  text;
  v_split numeric;
  v_new   boolean := false;
begin
  perform public.require_role('admin', 'finance');
  select * into v_pos from public.positions where name = p ->> 'position';
  if not found then
    raise exception 'Jabatan "%" tidak dikenal.', p ->> 'position';
  end if;
  if trim(coalesce(p ->> 'department', '')) = '' then
    raise exception 'Departemen wajib diisi.';
  end if;
  select d.id into v_dept from public.departments d
   where lower(d.name) = lower(trim(p ->> 'department'))
   order by (d.unit_code is not distinct from case when v_unit = 'LINTAS' then null else v_unit end) desc
   limit 1;
  if v_dept is null then
    insert into public.departments (name, unit_code) values (trim(p ->> 'department'), case when v_unit = 'LINTAS' then null else v_unit end)
    returning id into v_dept;
  end if;
  v_prim := case when v_unit = 'LINTAS' then coalesce(nullif(p ->> 'primaryUnit', ''), 'APT') else v_unit end;
  v_split := case v_unit when 'APT' then 100 when 'KLINIK' then 0 else coalesce((p -> 'costSplit' ->> 'APT')::numeric, 50) end;

  if v_id is null or not exists (select 1 from public.employees where id = v_id) then
    v_new := true;
    insert into public.employees (full_name, created_by, unit, primary_unit, cost_split_apt, position_id, department_id, phone, start_date)
    values (trim(p ->> 'name'), auth.uid(), v_unit, v_prim, v_split, v_pos.id, v_dept, coalesce(p ->> 'phone', ''), coalesce((p ->> 'startDate')::date, public.jakarta_today()))
    returning id into v_id;
  end if;

  update public.employees set
    full_name = trim(p ->> 'name'), photo_url = nullif(p ->> 'photo', ''), gender = coalesce(p ->> 'gender', ''),
    address = coalesce(p ->> 'address', ''), phone = coalesce(p ->> 'phone', ''), email = coalesce(p ->> 'email', ''),
    unit = v_unit, primary_unit = v_prim, cost_split_apt = v_split, position_id = v_pos.id, department_id = v_dept,
    start_date = (p ->> 'startDate')::date, status = coalesce(p ->> 'status', 'aktif'), base_salary = coalesce((p ->> 'baseSalary')::bigint, 0),
    pay_scheme = coalesce(p ->> 'payScheme', 'monthly'), pay_config = coalesce(p -> 'payConfig', '{}'::jsonb), pay_method = coalesce(p ->> 'payMethod', 'Transfer Bank'),
    str_number = coalesce(p ->> 'str', ''), sip_number = coalesce(p ->> 'sip', ''), health_status = coalesce(p ->> 'healthStatus', ''),
    schedule = coalesce(p ->> 'schedule', ''), service_fee_method = coalesce(p ->> 'serviceFeeMethod', 'Digabung dalam slip gaji'),
    bpjs_kes = coalesce((p ->> 'bpjsKes')::boolean, true), bpjs_tk = coalesce((p ->> 'bpjsTk')::boolean, true),
    bpjs_wage = coalesce((p ->> 'bpjsWage')::bigint, 0), pph21 = coalesce((p ->> 'pph21')::boolean, true), ptkp = coalesce(p ->> 'ptkp', 'TK/0'),
    sales_target = coalesce((p ->> 'salesTarget')::bigint, 0), component_overrides = coalesce(p -> 'componentOverrides', '{}'::jsonb),
    notes = coalesce(p ->> 'notes', ''), updated_at = now()
  where id = v_id;

  if p ? 'bankAccount' or p ? 'bankName' then
    insert into public.employee_bank_accounts (employee_id, bank_name, account_number, account_holder)
    values (v_id, coalesce(p ->> 'bankName', ''), regexp_replace(coalesce(p ->> 'bankAccount', ''), '\s', '', 'g'), coalesce(p ->> 'bankHolder', ''))
    on conflict (employee_id) do update
      set bank_name = excluded.bank_name,
          account_number = case when p ? 'bankAccount' then excluded.account_number else public.employee_bank_accounts.account_number end,
          account_holder = excluded.account_holder, updated_at = now();
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_employee(p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trx  int;
  v_runs int;
  v_svc  int;
begin
  perform public.require_role('admin', 'finance');
  select count(distinct transaction_id) into v_trx from public.service_transaction_allocations where recipient_employee_id = p_id;
  select count(*) into v_runs from public.payroll_records where employee_id = p_id;
  select count(*) into v_svc from public.service_revenue_rules where employee_id = p_id or target_employee_id = p_id;
  if v_trx + v_runs + v_svc > 0 then
    raise exception 'Karyawan sudah memiliki % transaksi, % slip gaji, % konfigurasi tindakan. Ubah status menjadi "Tidak Aktif" atau "Mengundurkan Diri" agar riwayat tetap utuh.', v_trx, v_runs, v_svc;
  end if;
  delete from public.worklogs where employee_id = p_id;
  delete from public.employees where id = p_id;
end;
$$;

-- =====================================================================
-- TRANSAKSI TINDAKAN
-- item: { lineId?, serviceId, qty, price, performers:{role:empId} }
-- =====================================================================
create or replace function public._add_item(p_trx_id text, p_line_no int, p_item jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_svc   public.service_master;
  v_qty   int := (p_item ->> 'qty')::int;
  v_price bigint := (p_item ->> 'price')::bigint;
  v_perf  jsonb := '{}'::jsonb;
  v_names jsonb := '{}'::jsonb;
  v_role  text;
  v_emp   public.employees;
  v_item  uuid;
  v_sum   bigint;
  v_over  text;
begin
  select * into v_svc from public.service_master where id = p_item ->> 'serviceId';
  if not found then
    raise exception 'Baris %: tindakan tidak ditemukan.', p_line_no;
  end if;
  if not v_svc.active then
    raise exception 'Baris %: tindakan "%" sudah nonaktif.', p_line_no, v_svc.name;
  end if;
  if v_qty is null or v_qty < 1 then
    raise exception 'Baris %: jumlah minimal 1.', p_line_no;
  end if;
  if v_price is null or v_price <= 0 then
    raise exception 'Baris %: harga jual harus lebih dari 0.', p_line_no;
  end if;
  -- Hanya peran yang dipakai aturan pembagian yang disimpan sebagai pelaksana.
  for v_role in select distinct rr.target from public.service_revenue_rules rr where rr.service_id = v_svc.id and rr.recipient_type = 'role' loop
    if coalesce(p_item -> 'performers' ->> v_role, '') <> '' then
      select * into v_emp from public.employees where id = p_item -> 'performers' ->> v_role;
      if not found then
        raise exception 'Baris %: petugas tidak ditemukan.', p_line_no;
      end if;
      if v_emp.status not in ('aktif', 'cuti') then
        raise exception 'Baris %: petugas % tidak aktif.', p_line_no, v_emp.full_name;
      end if;
      v_perf := v_perf || jsonb_build_object(v_role, v_emp.id);
      v_names := v_names || jsonb_build_object(v_role, v_emp.full_name);
    end if;
  end loop;

  insert into public.service_transaction_items (transaction_id, line_no, service_id, service_code, service_name, category, unit_code, qty, unit_price, gross, performers, performer_names)
  values (p_trx_id, p_line_no, v_svc.id, v_svc.id, v_svc.name, v_svc.category, v_svc.unit_code, v_qty, v_price, v_qty * v_price, v_perf, v_names)
  returning id into v_item;

  insert into public.service_transaction_allocations (transaction_id, item_id, kind, sort_order, recipient_type, target, recipient_employee_id, recipient_unit,
                                                      recipient_name, category, mode, rule_value, unit_amount, amount, is_implicit)
  select p_trx_id, v_item, 'share', c.sort_order, c.recipient_type, c.target, c.recipient_employee_id, c.recipient_unit,
         c.recipient_name, c.category, c.mode, c.rule_value, c.unit_amount, c.amount, c.is_implicit
    from public.compute_allocations(v_svc.id, v_price, v_qty, v_perf, false) c;

  select max(c.override_employee_id) into v_over from public.compute_allocations(v_svc.id, v_price, 1, v_perf, false) c;
  update public.service_transaction_items set override_employee_id = v_over where id = v_item;

  select coalesce(sum(amount), 0) into v_sum from public.service_transaction_allocations where item_id = v_item;
  if v_sum <> v_qty * v_price then
    raise exception 'Baris %: total pembagian (Rp%) tidak sama dengan pendapatan (Rp%).', p_line_no, v_sum, v_qty * v_price;
  end if;
  return v_qty * v_price;
end;
$$;

create or replace function public.create_service_transaction(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date  date := (p ->> 'date')::date;
  v_ym    text;
  v_id    text;
  v_item  jsonb;
  v_ord   bigint;
  v_gross bigint := 0;
begin
  perform public.require_role('admin', 'finance', 'ops');
  if v_date is null then
    raise exception 'Tanggal transaksi wajib diisi.';
  end if;
  if v_date > public.jakarta_today() then
    raise exception 'Tanggal transaksi tidak boleh melebihi hari ini.';
  end if;
  if coalesce(jsonb_array_length(p -> 'items'), 0) = 0 then
    raise exception 'Minimal satu tindakan.';
  end if;
  if jsonb_array_length(p -> 'items') > 50 then
    raise exception 'Maksimal 50 tindakan per transaksi.';
  end if;
  v_ym := to_char(v_date, 'YYYYMM');
  v_id := public.doc_prefix('transaction', 'TRX') || '-' || v_ym || '-' || lpad(public.next_counter('trx-' || v_ym)::text, 4, '0');
  insert into public.service_transactions (id, trx_date, patient_name, patient_code, note, created_by, created_by_name)
  values (v_id, v_date, left(coalesce(p ->> 'patient', ''), 80), left(coalesce(p ->> 'patientCode', ''), 30), left(coalesce(p ->> 'note', ''), 200), auth.uid(), public.current_username());
  for v_item, v_ord in select e.value, e.ordinality from jsonb_array_elements(p -> 'items') with ordinality e loop
    v_gross := v_gross + public._add_item(v_id, v_ord::int, v_item);
  end loop;
  update public.service_transactions set gross = v_gross where id = v_id;
  perform public.write_audit('trx.create', 'service_transactions', v_id, 'Transaksi baru ' || jsonb_array_length(p -> 'items') || ' tindakan, total Rp' || v_gross, null, p);
  return v_id;
end;
$$;

-- Jumlah yang sudah dibayar/terjadwal per karyawan untuk transaksi terkunci.
-- Invarian: setelah setiap koreksi, (bagian awal yang dibayar periode terkunci + seluruh
-- adjustment) = jumlah bagian terkunci saat ini. Karena itu cukup menjumlahkan bagian
-- terkunci; menambahkan adjustment lagi akan menghitung koreksi dua kali.
create or replace function public._settled_by_employee(p_trx_id text)
returns table (employee_id text, settled bigint)
language sql
stable
security definer
set search_path = public
as $$
  select a.recipient_employee_id, sum(a.amount)::bigint
    from public.service_transaction_allocations a
   where a.transaction_id = p_trx_id and a.recipient_employee_id is not null
     and a.kind = 'share' and a.payroll_state = 'locked'
   group by a.recipient_employee_id;
$$;

create or replace function public._insert_adjustments(p_trx_id text, p_settled jsonb, p_kind text, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp   text;
  v_now   bigint;
  v_old   bigint;
  v_unit  text;
  v_name  text;
  v_cat   text;
begin
  for v_emp in
    select x.k from (select jsonb_object_keys(coalesce(p_settled, '{}'::jsonb)) k
                     union
                     select distinct a.recipient_employee_id from public.service_transaction_allocations a
                      where a.transaction_id = p_trx_id and a.kind = 'share' and a.recipient_employee_id is not null and p_kind = 'koreksi') x
  loop
    v_old := coalesce((p_settled ->> v_emp)::bigint, 0);
    if p_kind = 'koreksi' then
      select coalesce(sum(a.amount), 0) into v_now from public.service_transaction_allocations a
       where a.transaction_id = p_trx_id and a.kind = 'share' and a.recipient_employee_id = v_emp;
    else
      v_now := 0;
    end if;
    if v_now - v_old <> 0 then
      select i.unit_code into v_unit from public.service_transaction_items i
        join public.service_transaction_allocations a on a.item_id = i.id
       where i.transaction_id = p_trx_id and a.recipient_employee_id = v_emp limit 1;
      select e.full_name, p.role_key into v_name, v_cat from public.employees e join public.positions p on p.id = e.position_id where e.id = v_emp;
      insert into public.service_transaction_allocations (transaction_id, item_id, kind, recipient_type, target, recipient_employee_id, recipient_unit,
                                                          recipient_name, category, amount, adj_date, adj_kind, adj_note, adj_by)
      values (p_trx_id, null, 'adjustment', 'employee', v_emp, v_emp, coalesce(v_unit, 'APT'), coalesce(v_name, v_emp), coalesce(v_cat, 'petugas'),
              v_now - v_old, public.jakarta_today(), p_kind, p_note, public.current_username());
    end if;
  end loop;
end;
$$;

create or replace function public.update_service_transaction(p_id text, p jsonb, p_note text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trx      public.service_transactions;
  v_locked   text;
  v_settled  jsonb;
  v_keep     uuid[] := '{}';
  v_item     jsonb;
  v_ord      bigint;
  v_old_item public.service_transaction_items;
  v_perf     jsonb;
  v_before   text;
  v_after    text;
  v_gross    bigint;
  v_role     text := public.app_role();
begin
  perform public.require_role('admin', 'finance', 'ops');
  select * into v_trx from public.service_transactions where id = p_id for update;
  if not found then
    raise exception 'Transaksi tidak ditemukan.';
  end if;
  if v_role = 'ops' and v_trx.created_by is distinct from auth.uid() then
    raise exception 'Admin Operasional hanya dapat mengubah transaksi yang diinputnya sendiri.' using errcode = '42501';
  end if;
  if v_trx.status = 'cancelled' then
    raise exception 'Transaksi sudah dibatalkan dan tidak dapat diubah.';
  end if;
  if exists (select 1 from public.service_transaction_allocations where transaction_id = p_id and payroll_state = 'approved') then
    raise exception 'Transaksi sudah masuk penggajian yang telah DISETUJUI. Kembalikan penggajian tersebut ke draft terlebih dahulu.';
  end if;
  if (p ->> 'date')::date > public.jakarta_today() then
    raise exception 'Tanggal transaksi tidak boleh melebihi hari ini.';
  end if;
  if coalesce(jsonb_array_length(p -> 'items'), 0) = 0 then
    raise exception 'Minimal satu tindakan.';
  end if;
  select payroll_period_id into v_locked from public.service_transaction_allocations
   where transaction_id = p_id and kind = 'share' and payroll_state = 'locked' limit 1;
  if v_locked is not null then
    if v_role <> 'admin' then
      raise exception 'LOCKED: Transaksi sudah masuk periode gaji terkunci. Diperlukan otorisasi administrator.' using errcode = '42501';
    end if;
    if length(trim(coalesce(p_note, ''))) < 5 then
      raise exception 'Catatan perubahan wajib diisi (min. 5 karakter).';
    end if;
  end if;

  select jsonb_object_agg(s.employee_id, s.settled) into v_settled from public._settled_by_employee(p_id) s;
  select string_agg(i.service_name || ' x' || i.qty, ', ' order by i.line_no) || ' = Rp' || v_trx.gross || ' (' || v_trx.trx_date || ')'
    into v_before from public.service_transaction_items i where i.transaction_id = p_id;

  -- Draft penggajian yang memakai transaksi ini harus dihitung ulang.
  update public.payroll_periods set stale = true, stale_reason = 'Transaksi ' || p_id || ' diubah'
   where status = 'draft' and id in (select payroll_period_id from public.service_transaction_allocations where transaction_id = p_id and payroll_state = 'draft');

  -- Item yang tidak berubah tetap memakai snapshot lama (tarif historis tidak berubah).
  for v_item in select e.value from jsonb_array_elements(p -> 'items') e loop
    if coalesce(v_item ->> 'lineId', '') ~ '^[0-9a-f-]{36}$' then
      select * into v_old_item from public.service_transaction_items where id = (v_item ->> 'lineId')::uuid and transaction_id = p_id;
      if found then
        select coalesce(jsonb_object_agg(k, v_item -> 'performers' ->> k), '{}'::jsonb) into v_perf
          from jsonb_object_keys(v_old_item.performers) k where coalesce(v_item -> 'performers' ->> k, '') <> '';
        if v_old_item.service_id = v_item ->> 'serviceId' and v_old_item.qty = (v_item ->> 'qty')::int
           and v_old_item.unit_price = (v_item ->> 'price')::bigint and v_old_item.performers = v_perf then
          v_keep := v_keep || v_old_item.id;
        end if;
      end if;
    end if;
  end loop;
  delete from public.service_transaction_items where transaction_id = p_id and id <> all (v_keep);
  update public.service_transaction_items set line_no = line_no + 1000 where transaction_id = p_id;
  if v_locked is null then
    update public.service_transaction_allocations set payroll_period_id = null, payroll_record_id = null, payroll_state = null
     where transaction_id = p_id and kind = 'share' and payroll_state = 'draft';
  end if;

  for v_item, v_ord in select e.value, e.ordinality from jsonb_array_elements(p -> 'items') with ordinality e loop
    if coalesce(v_item ->> 'lineId', '') ~ '^[0-9a-f-]{36}$' and (v_item ->> 'lineId')::uuid = any (v_keep) then
      update public.service_transaction_items set line_no = v_ord where id = (v_item ->> 'lineId')::uuid;
    else
      perform public._add_item(p_id, v_ord::int, v_item);
    end if;
  end loop;

  select coalesce(sum(gross), 0) into v_gross from public.service_transaction_items where transaction_id = p_id;
  update public.service_transactions
     set trx_date = (p ->> 'date')::date, patient_name = left(coalesce(p ->> 'patient', ''), 80), patient_code = left(coalesce(p ->> 'patientCode', ''), 30),
         note = left(coalesce(p ->> 'note', ''), 200), gross = v_gross, updated_at = now(), updated_by = auth.uid(),
         corrections = case when v_locked is null then corrections
                            else corrections || jsonb_build_array(jsonb_build_object('ts', now(), 'by', public.current_username(), 'note', p_note, 'before', v_before)) end
   where id = p_id;

  if v_locked is not null then
    -- Bagian baru dianggap milik periode terkunci; selisih dibayar lewat adjustment.
    update public.service_transaction_allocations a
       set payroll_period_id = v_locked, payroll_state = 'locked',
           payroll_record_id = (select r.id from public.payroll_records r where r.period_id = v_locked and r.employee_id = a.recipient_employee_id)
     where a.transaction_id = p_id and a.kind = 'share' and a.recipient_employee_id is not null and a.payroll_state is null;
    perform public._insert_adjustments(p_id, v_settled, 'koreksi', p_note);
  end if;

  select string_agg(i.service_name || ' x' || i.qty, ', ' order by i.line_no) || ' = Rp' || v_gross || ' (' || (p ->> 'date') || ')'
    into v_after from public.service_transaction_items i where i.transaction_id = p_id;
  perform public.write_audit(case when v_locked is null then 'trx.update' else 'trx.correction' end, 'service_transactions', p_id,
    case when v_locked is null then 'Ubah transaksi | ' else 'KOREKSI TERKUNCI (otorisasi ' || public.current_username() || '): ' || p_note || ' | ' end
      || 'Sebelum: ' || coalesce(v_before, '-') || ' -> Sesudah: ' || coalesce(v_after, '-'), null, p);
  return p_id;
end;
$$;

create or replace function public.cancel_service_transaction(p_id text, p_reason text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trx     public.service_transactions;
  v_locked  boolean;
  v_settled jsonb;
begin
  perform public.require_role('admin', 'finance');
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Alasan pembatalan wajib diisi.';
  end if;
  select * into v_trx from public.service_transactions where id = p_id for update;
  if not found then
    raise exception 'Transaksi tidak ditemukan.';
  end if;
  if v_trx.status = 'cancelled' then
    raise exception 'Transaksi sudah dibatalkan.';
  end if;
  if exists (select 1 from public.service_transaction_allocations where transaction_id = p_id and payroll_state = 'approved') then
    raise exception 'Transaksi sudah masuk penggajian yang telah DISETUJUI. Kembalikan penggajian tersebut ke draft terlebih dahulu.';
  end if;
  v_locked := exists (select 1 from public.service_transaction_allocations where transaction_id = p_id and kind = 'share' and payroll_state = 'locked');
  if v_locked then
    if not public.has_role('admin') then
      raise exception 'LOCKED: Transaksi sudah masuk periode gaji terkunci. Diperlukan otorisasi administrator.' using errcode = '42501';
    end if;
    if length(trim(coalesce(p_note, ''))) < 5 then
      raise exception 'Catatan otorisasi wajib diisi (min. 5 karakter).';
    end if;
    select jsonb_object_agg(s.employee_id, s.settled) into v_settled from public._settled_by_employee(p_id) s;
    perform public._insert_adjustments(p_id, v_settled, 'pembatalan', p_note);
  else
    update public.payroll_periods set stale = true, stale_reason = 'Transaksi ' || p_id || ' dibatalkan'
     where status = 'draft' and id in (select payroll_period_id from public.service_transaction_allocations where transaction_id = p_id and payroll_state = 'draft');
    update public.service_transaction_allocations set payroll_period_id = null, payroll_record_id = null, payroll_state = null
     where transaction_id = p_id and payroll_state = 'draft';
  end if;
  update public.service_transactions
     set status = 'cancelled', cancel_reason = trim(p_reason), cancelled_at = now(), cancelled_by = auth.uid(), cancelled_by_name = public.current_username()
   where id = p_id;
  perform public.write_audit('trx.cancel', 'service_transactions', p_id,
    'Batalkan transaksi (Rp' || v_trx.gross || '): ' || trim(p_reason) || case when v_locked then ' | otorisasi ' || public.current_username() || ': ' || p_note else '' end);
  return p_id;
end;
$$;

-- =====================================================================
-- PENGGAJIAN
-- Perhitungan rinci slip dilakukan aplikasi (js/calculator.js), lalu server
-- memverifikasi & mengunci jasa dalam satu transaksi:
--  * jasa/adjustment diklaim hanya bila belum dipakai periode lain,
--  * nilai "Jasa Pelayanan" di slip harus sama dengan jumlah alokasi yang diklaim,
--  * total bruto/potongan/bersih harus konsisten,
--  * constraint EXCLUDE mencegah karyawan digaji ganda pada tanggal beririsan.
-- =====================================================================
create or replace function public._payroll_check_unclaimed(p_period public.payroll_periods)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select coalesce(r.employee_snapshot ->> 'name', r.employee_id) into v_name
    from public.payroll_records r
    join public.service_transaction_allocations a on a.recipient_employee_id = r.employee_id and a.payroll_period_id is null
    left join public.service_transactions t on t.id = a.transaction_id
   where r.period_id = p_period.id
     and ((a.kind = 'share' and t.status = 'active'
            and (t.trx_date between p_period.start_date and p_period.end_date or (p_period.include_earlier and t.trx_date < p_period.start_date)))
          or (a.kind = 'adjustment' and a.adj_date <= p_period.end_date))
   limit 1;
  if v_name is not null then
    raise exception 'Ada jasa/koreksi baru untuk % yang belum masuk perhitungan. Hitung ulang penggajian.', v_name;
  end if;
end;
$$;

create or replace function public.payroll_save_draft(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      text := nullif(p ->> 'id', '');
  v_per     public.payroll_periods;
  v_start   date := (p ->> 'start')::date;
  v_end     date := (p ->> 'end')::date;
  v_slip    jsonb;
  v_emp     public.employees;
  v_rec     uuid;
  v_refs    uuid[];
  v_cnt     int;
  v_sum     bigint;
  v_gross   bigint;
  v_ded     bigint;
  v_jasa    bigint;
  v_kor     bigint;
  v_line    jsonb;
  v_ord     bigint;
  v_slipnos jsonb;
  v_sts     text[];
  v_ym      text;
  v_snap    jsonb;
begin
  perform public.require_role('admin', 'finance');
  if v_start is null or v_end is null or v_end < v_start then
    raise exception 'Rentang periode tidak valid.';
  end if;
  if coalesce(jsonb_array_length(p -> 'slips'), 0) = 0 then
    raise exception 'Pilih minimal satu karyawan.';
  end if;
  select coalesce(array_agg(x), array['aktif', 'cuti']) into v_sts
    from jsonb_array_elements_text((select value -> 'includeEmployeeStatuses' from public.app_settings where key = 'payroll')) x;

  if v_id is null then
    v_ym := replace(p ->> 'period', '-', '');
    v_id := public.doc_prefix('payroll', 'PAY') || '-' || v_ym || '-' || lpad(public.next_counter('pay-' || v_ym)::text, 2, '0');
    insert into public.payroll_periods (id, period, start_date, end_date, pay_date, unit_filter, include_earlier, notes, created_by, history)
    values (v_id, p ->> 'period', v_start, v_end, coalesce((p ->> 'payDate')::date, v_end), coalesce(p ->> 'unit', 'ALL'),
            coalesce((p ->> 'includeEarlier')::boolean, false), coalesce(p ->> 'notes', ''), auth.uid(),
            jsonb_build_array(jsonb_build_object('ts', now(), 'by', public.current_username(), 'action', 'create', 'note', coalesce(p ->> 'note', ''))));
  else
    select * into v_per from public.payroll_periods where id = v_id for update;
    if not found then
      raise exception 'Penggajian % tidak ditemukan.', v_id;
    end if;
    if v_per.status <> 'draft' then
      raise exception 'Penggajian % sudah % dan tidak dapat diubah.', v_id, v_per.status;
    end if;
    update public.payroll_periods
       set period = p ->> 'period', start_date = v_start, end_date = v_end, pay_date = coalesce((p ->> 'payDate')::date, v_end),
           unit_filter = coalesce(p ->> 'unit', 'ALL'), include_earlier = coalesce((p ->> 'includeEarlier')::boolean, false),
           notes = coalesce(p ->> 'notes', ''),
           history = history || jsonb_build_array(jsonb_build_object('ts', now(), 'by', public.current_username(), 'action', 'recalc', 'note', coalesce(p ->> 'note', '')))
     where id = v_id;
  end if;
  select * into v_per from public.payroll_periods where id = v_id;

  -- Lepas pesanan lama & hapus slip draft lama (nomor slip dipertahankan).
  select coalesce(jsonb_object_agg(employee_id, slip_no), '{}'::jsonb) into v_slipnos from public.payroll_records where period_id = v_id and slip_no is not null;
  update public.service_transaction_allocations set payroll_period_id = null, payroll_record_id = null, payroll_state = null where payroll_period_id = v_id;
  delete from public.payroll_records where period_id = v_id;

  for v_slip in select e.value from jsonb_array_elements(p -> 'slips') e loop
    select * into v_emp from public.employees where id = v_slip ->> 'employeeId';
    if not found then
      raise exception 'Karyawan % tidak ditemukan.', v_slip ->> 'employeeId';
    end if;
    if not (v_emp.status = any (v_sts)) then
      raise exception 'Karyawan % berstatus % dan tidak diikutkan penggajian.', v_emp.full_name, v_emp.status;
    end if;
    select coalesce(sum((l ->> 'amount')::bigint), 0) into v_gross from jsonb_array_elements(v_slip -> 'earnings') l;
    select coalesce(sum((l ->> 'amount')::bigint), 0) into v_ded from jsonb_array_elements(v_slip -> 'deductions') l;
    if v_gross <> (v_slip -> 'totals' ->> 'gross')::bigint or v_ded <> (v_slip -> 'totals' ->> 'deductions')::bigint
       or (v_slip -> 'totals' ->> 'net')::bigint <> v_gross - v_ded then
      raise exception 'Total slip % tidak konsisten dengan rinciannya.', v_emp.full_name;
    end if;
    if exists (select 1 from jsonb_array_elements(v_slip -> 'deductions') l where (l ->> 'amount')::bigint < 0) then
      raise exception 'Potongan slip % tidak boleh negatif.', v_emp.full_name;
    end if;

    select jsonb_build_object(
             'id', v_emp.id, 'name', v_emp.full_name, 'position', p2.name, 'department', d.name, 'unit', v_emp.unit, 'primaryUnit', v_emp.primary_unit,
             'payScheme', v_emp.pay_scheme, 'payMethod', v_emp.pay_method, 'bankName', coalesce(b.bank_name, ''),
             'bankAccountMasked', public.mask_account(b.account_number), 'bankHolder', coalesce(nullif(b.account_holder, ''), v_emp.full_name),
             'startDate', v_emp.start_date)
      into v_snap
      from public.positions p2, public.departments d
      left join public.employee_bank_accounts b on b.employee_id = v_emp.id
     where p2.id = v_emp.position_id and d.id = v_emp.department_id;

    begin
      insert into public.payroll_records (period_id, employee_id, start_date, end_date, slip_no, employee_snapshot, inputs, gross, deductions, net,
                                          totals, allocation, split, employer, tax_info, warnings, service_detail, service_count, service_qty)
      values (v_id, v_emp.id, v_start, v_end, v_slipnos ->> v_emp.id, v_snap, coalesce(v_slip -> 'inputs', '{}'::jsonb), v_gross, v_ded, v_gross - v_ded,
              coalesce(v_slip -> 'totals', '{}'::jsonb), coalesce(v_slip -> 'allocation', '{}'::jsonb), coalesce(v_slip -> 'split', '{}'::jsonb),
              coalesce(v_slip -> 'employer', '{}'::jsonb), v_slip -> 'taxInfo', coalesce(v_slip -> 'warnings', '[]'::jsonb),
              coalesce(v_slip -> 'serviceDetail', '[]'::jsonb), coalesce((v_slip ->> 'serviceCount')::int, 0), coalesce((v_slip ->> 'serviceQty')::int, 0))
      returning id into v_rec;
    exception
      when exclusion_violation or unique_violation then
        raise exception 'Karyawan % sudah memiliki penggajian pada periode yang beririsan.', v_emp.full_name;
    end;

    for v_line, v_ord in select e.value, e.ordinality from jsonb_array_elements(v_slip -> 'earnings') with ordinality e loop
      insert into public.payroll_details (record_id, line_type, code, name, grp, amount, is_fixed, taxable, note, sort_order)
      values (v_rec, 'earning', v_line ->> 'code', v_line ->> 'name', v_line ->> 'group', (v_line ->> 'amount')::bigint,
              coalesce((v_line ->> 'fixed')::boolean, false), coalesce((v_line ->> 'taxable')::boolean, true), coalesce(v_line ->> 'note', ''), v_ord);
    end loop;
    for v_line, v_ord in select e.value, e.ordinality from jsonb_array_elements(v_slip -> 'deductions') with ordinality e loop
      insert into public.payroll_details (record_id, line_type, code, name, grp, amount, note, sort_order)
      values (v_rec, 'deduction', v_line ->> 'code', v_line ->> 'name', v_line ->> 'group', (v_line ->> 'amount')::bigint, coalesce(v_line ->> 'note', ''), v_ord);
    end loop;

    -- Klaim jasa tindakan
    v_refs := array(select x::uuid from jsonb_array_elements_text(coalesce(v_slip -> 'serviceRefs', '[]'::jsonb)) x);
    with c as (
      update public.service_transaction_allocations a
         set payroll_period_id = v_id, payroll_record_id = v_rec, payroll_state = 'draft'
        from public.service_transactions t
       where a.id = any (v_refs) and a.kind = 'share' and a.recipient_employee_id = v_emp.id and a.payroll_period_id is null
         and t.id = a.transaction_id and t.status = 'active'
         and (t.trx_date between v_start and v_end or (v_per.include_earlier and t.trx_date < v_start))
      returning a.amount)
    select count(*), coalesce(sum(amount), 0) into v_cnt, v_sum from c;
    if v_cnt <> coalesce(array_length(v_refs, 1), 0) then
      raise exception 'Data jasa % berubah atau sudah diproses penggajian lain. Muat ulang lalu hitung ulang.', v_emp.full_name;
    end if;
    select coalesce(sum((l ->> 'amount')::bigint), 0) into v_jasa from jsonb_array_elements(v_slip -> 'earnings') l where l ->> 'code' = 'JASA';
    if v_jasa <> v_sum then
      raise exception 'Jasa pelayanan slip % (Rp%) tidak sama dengan jasa tercatat (Rp%).', v_emp.full_name, v_jasa, v_sum;
    end if;

    -- Klaim koreksi (adjustment)
    v_refs := array(select x::uuid from jsonb_array_elements_text(coalesce(v_slip -> 'adjRefs', '[]'::jsonb)) x);
    with c as (
      update public.service_transaction_allocations a
         set payroll_period_id = v_id, payroll_record_id = v_rec, payroll_state = 'draft'
       where a.id = any (v_refs) and a.kind = 'adjustment' and a.recipient_employee_id = v_emp.id and a.payroll_period_id is null and a.adj_date <= v_end
      returning a.amount)
    select count(*), coalesce(sum(amount), 0) into v_cnt, v_sum from c;
    if v_cnt <> coalesce(array_length(v_refs, 1), 0) then
      raise exception 'Koreksi jasa % berubah atau sudah diproses. Muat ulang lalu hitung ulang.', v_emp.full_name;
    end if;
    select coalesce(sum((l ->> 'amount')::bigint), 0) into v_kor from jsonb_array_elements(v_slip -> 'earnings') l where l ->> 'code' = 'JASA_KOREKSI';
    if v_kor <> v_sum then
      raise exception 'Koreksi jasa slip % (Rp%) tidak sama dengan koreksi tercatat (Rp%).', v_emp.full_name, v_kor, v_sum;
    end if;
  end loop;

  perform public._payroll_check_unclaimed(v_per);

  update public.payroll_periods
     set stale = false, stale_reason = '',
         totals = coalesce(p -> 'totals', '{}'::jsonb) || (select jsonb_build_object('gross', sum(gross), 'deductions', sum(deductions), 'net', sum(net), 'count', count(*))
                                                             from public.payroll_records where period_id = v_id)
   where id = v_id;
  perform public.write_audit('payroll.save_draft', 'payroll_periods', v_id,
    'Simpan draft ' || (p ->> 'period') || ': ' || jsonb_array_length(p -> 'slips') || ' karyawan, gaji bersih Rp' ||
    (select coalesce(sum(net), 0) from public.payroll_records where period_id = v_id));
  return v_id;
end;
$$;

create or replace function public._payroll_history(p_id text, p_action text, p_note text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.payroll_periods
     set history = history || jsonb_build_array(jsonb_build_object('ts', now(), 'by', public.current_username(), 'action', p_action, 'note', coalesce(p_note, '')))
   where id = p_id;
$$;

create or replace function public.payroll_approve(p_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_per public.payroll_periods;
  v_rec record;
  v_no  text;
begin
  perform public.require_role('admin', 'finance');
  select * into v_per from public.payroll_periods where id = p_id for update;
  if not found or v_per.status <> 'draft' then
    raise exception 'Hanya draft yang dapat disetujui.';
  end if;
  if v_per.stale then
    raise exception 'Draft perlu dihitung ulang terlebih dahulu (%).', coalesce(nullif(v_per.stale_reason, ''), 'data berubah');
  end if;
  if not exists (select 1 from public.payroll_records where period_id = p_id) then
    raise exception 'Penggajian tidak memiliki slip.';
  end if;
  perform public._payroll_check_unclaimed(v_per);
  for v_rec in select r.id, r.employee_id, r.slip_no, r.employee_snapshot from public.payroll_records r
                where r.period_id = p_id order by r.employee_snapshot ->> 'name', r.employee_id loop
    v_no := v_rec.slip_no;
    if v_no is null then
      v_no := public.doc_prefix('slip', 'SLIP') || '/' || coalesce(v_rec.employee_snapshot ->> 'primaryUnit', 'APT') || '/' || replace(v_per.period, '-', '/')
              || '/' || lpad(public.next_counter('slip-' || v_per.period)::text, 4, '0');
      update public.payroll_records set slip_no = v_no where id = v_rec.id;
    end if;
    insert into public.payslips (record_id, period_id, employee_id, slip_no, issued_by)
    values (v_rec.id, p_id, v_rec.employee_id, v_no, auth.uid())
    on conflict (record_id) do update set issued_at = now(), issued_by = auth.uid();
  end loop;
  update public.service_transaction_allocations set payroll_state = 'approved' where payroll_period_id = p_id;
  update public.payroll_periods set status = 'approved', approved_at = now(), approved_by = auth.uid() where id = p_id;
  perform public._payroll_history(p_id, 'approve', null);
  perform public.write_audit('payroll.approve', 'payroll_periods', p_id, 'Setujui penggajian ' || v_per.period || ', gaji bersih Rp' || (v_per.totals ->> 'net'));
  return p_id;
end;
$$;

create or replace function public.payroll_lock(p_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_role('admin');
  update public.payroll_periods set status = 'locked', locked_at = now(), locked_by = auth.uid() where id = p_id and status = 'approved';
  if not found then
    raise exception 'Hanya penggajian berstatus disetujui yang dapat dikunci.';
  end if;
  update public.service_transaction_allocations set payroll_state = 'locked' where payroll_period_id = p_id;
  perform public._payroll_history(p_id, 'lock', null);
  perform public.write_audit('payroll.lock', 'payroll_periods', p_id, 'Kunci penggajian');
  return p_id;
end;
$$;

create or replace function public.payroll_unlock(p_id text, p_note text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_role('admin');
  if length(trim(coalesce(p_note, ''))) < 5 then
    raise exception 'Catatan otorisasi wajib diisi (min. 5 karakter).';
  end if;
  update public.payroll_periods set status = 'approved', locked_at = null, locked_by = null where id = p_id and status = 'locked';
  if not found then
    raise exception 'Penggajian tidak dalam status terkunci.';
  end if;
  update public.service_transaction_allocations set payroll_state = 'approved' where payroll_period_id = p_id;
  perform public._payroll_history(p_id, 'unlock', p_note || ' (otorisasi ' || public.current_username() || ')');
  perform public.write_audit('payroll.unlock', 'payroll_periods', p_id, 'Buka kunci: ' || p_note);
  return p_id;
end;
$$;

create or replace function public.payroll_revert(p_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_role('admin', 'finance');
  update public.payroll_periods set status = 'draft', approved_at = null, approved_by = null, stale = true, stale_reason = 'Dikembalikan ke draft'
   where id = p_id and status = 'approved';
  if not found then
    raise exception 'Hanya penggajian berstatus disetujui yang dapat dikembalikan ke draft.';
  end if;
  delete from public.payslips where period_id = p_id;
  update public.service_transaction_allocations set payroll_state = 'draft' where payroll_period_id = p_id;
  perform public._payroll_history(p_id, 'revert', null);
  perform public.write_audit('payroll.revert', 'payroll_periods', p_id, 'Kembalikan ke draft');
  return p_id;
end;
$$;

create or replace function public.payroll_delete_draft(p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_per public.payroll_periods;
begin
  perform public.require_role('admin', 'finance');
  select * into v_per from public.payroll_periods where id = p_id for update;
  if not found then
    return;
  end if;
  if v_per.status <> 'draft' then
    raise exception 'Hanya draft yang dapat dihapus.';
  end if;
  update public.service_transaction_allocations set payroll_period_id = null, payroll_record_id = null, payroll_state = null where payroll_period_id = p_id;
  delete from public.payroll_periods where id = p_id;
  perform public.write_audit('payroll.delete', 'payroll_periods', p_id, 'Hapus draft ' || v_per.period, to_jsonb(v_per), null);
end;
$$;

-- Catatan shift/sesi tidak boleh diubah bila tanggalnya sudah masuk penggajian terkunci.
create or replace function public.worklog_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.worklogs := coalesce(new, old);
begin
  if exists (select 1 from public.payroll_records r join public.payroll_periods p on p.id = r.period_id
              where p.status = 'locked' and r.employee_id = v_row.employee_id and v_row.work_date between r.start_date and r.end_date)
     or (tg_op = 'UPDATE' and exists (select 1 from public.payroll_records r join public.payroll_periods p on p.id = r.period_id
              where p.status = 'locked' and r.employee_id = old.employee_id and old.work_date between r.start_date and r.end_date)) then
    raise exception 'Tanggal tersebut sudah termasuk penggajian terkunci.';
  end if;
  if tg_op = 'INSERT' and new.work_date > public.jakarta_today() then
    raise exception 'Tanggal tidak boleh melebihi hari ini.';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger worklogs_guard before insert or update or delete on public.worklogs
  for each row execute function public.worklog_guard();

-- Pemicu audit pada tabel master & keuangan
create trigger audit_business_units after insert or update or delete on public.business_units for each row execute function public.audit_row_change();
create trigger audit_employees after insert or update or delete on public.employees for each row execute function public.audit_row_change();
create trigger audit_employee_bank after insert or update or delete on public.employee_bank_accounts for each row execute function public.audit_row_change();
create trigger audit_salary_components after insert or update or delete on public.salary_components for each row execute function public.audit_row_change();
create trigger audit_service_rules after insert or update or delete on public.service_revenue_rules for each row execute function public.audit_row_change();
create trigger audit_service_master after update or delete on public.service_master for each row execute function public.audit_row_change();
create trigger audit_app_settings after insert or update or delete on public.app_settings for each row execute function public.audit_row_change();
create trigger audit_users after insert or update or delete on public.users for each row execute function public.audit_row_change();
create trigger audit_payroll_periods after update of status, stale on public.payroll_periods for each row execute function public.audit_row_change();
create trigger audit_worklogs after insert or update or delete on public.worklogs for each row execute function public.audit_row_change();

-- >>> migrations/20261124000400_rls.sql
-- =====================================================================
-- Migrasi 4: Row Level Security, hak akses tabel & fungsi, realtime.
-- Prinsip:
--  * anon (belum login) tidak dapat membaca/menulis apa pun.
--  * Data keuangan (transaksi, alokasi, penggajian) HANYA dapat diubah
--    melalui fungsi RPC yang memvalidasi role & menjaga konsistensi.
--  * Rekening karyawan hanya untuk Administrator & Admin Keuangan.
--  * Audit log hanya dapat dibaca Administrator; tidak dapat diubah/dihapus.
-- Role aplikasi: admin, finance (Admin Keuangan), ops (Admin Operasional), viewer.
-- =====================================================================

do $$
declare
  t text;
begin
  foreach t in array array['doc_counters', 'app_settings', 'business_units', 'departments', 'positions', 'users', 'employees',
                           'employee_bank_accounts', 'salary_components', 'service_master', 'service_revenue_rules', 'payroll_periods',
                           'payroll_records', 'payroll_details', 'payslips', 'service_transactions', 'service_transaction_items',
                           'service_transaction_allocations', 'worklogs', 'audit_logs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, public', t);
    execute format('revoke all on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end;
$$;

-- Tabel yang boleh ditulis langsung (tetap dibatasi kebijakan di bawah).
grant insert, update on public.app_settings to authenticated;
grant insert, update on public.business_units to authenticated;
grant insert, update, delete on public.departments to authenticated;
grant insert, update, delete on public.positions to authenticated;
grant insert, update, delete on public.salary_components to authenticated;
grant insert, update, delete on public.worklogs to authenticated;

-- ---------------------------------------------------------------------
-- Kebijakan baca
-- ---------------------------------------------------------------------
create policy read_active_users on public.business_units for select to authenticated using (public.app_role() is not null);
create policy read_active_users on public.departments for select to authenticated using (public.app_role() is not null);
create policy read_active_users on public.positions for select to authenticated using (public.app_role() is not null);
create policy read_active_users on public.salary_components for select to authenticated using (public.app_role() is not null);
create policy read_active_users on public.app_settings for select to authenticated using (public.app_role() is not null);
create policy read_active_users on public.employees for select to authenticated using (public.app_role() is not null);
create policy read_active_users on public.service_master for select to authenticated using (public.app_role() is not null);
create policy read_active_users on public.service_revenue_rules for select to authenticated using (public.app_role() is not null);
create policy read_active_users on public.service_transactions for select to authenticated using (public.app_role() is not null);
create policy read_active_users on public.service_transaction_items for select to authenticated using (public.app_role() is not null);
create policy read_active_users on public.service_transaction_allocations for select to authenticated using (public.app_role() is not null);

create policy read_finance on public.employee_bank_accounts for select to authenticated using (public.has_role('admin', 'finance'));
create policy read_finance on public.worklogs for select to authenticated using (public.has_role('admin', 'finance'));
create policy read_finance on public.payslips for select to authenticated using (public.has_role('admin', 'finance'));
create policy read_reports on public.payroll_periods for select to authenticated using (public.has_role('admin', 'finance', 'viewer'));
create policy read_reports on public.payroll_records for select to authenticated using (public.has_role('admin', 'finance', 'viewer'));
create policy read_reports on public.payroll_details for select to authenticated using (public.has_role('admin', 'finance', 'viewer'));
create policy read_admin on public.audit_logs for select to authenticated using (public.has_role('admin'));
create policy read_admin on public.doc_counters for select to authenticated using (public.has_role('admin'));
-- Profil sendiri boleh dibaca walau belum diaktifkan (agar aplikasi dapat menampilkan statusnya).
create policy read_self_or_admin on public.users for select to authenticated using (id = auth.uid() or public.has_role('admin'));

-- ---------------------------------------------------------------------
-- Kebijakan tulis langsung
-- ---------------------------------------------------------------------
create policy admin_insert on public.app_settings for insert to authenticated with check (public.has_role('admin'));
create policy admin_update on public.app_settings for update to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));
create policy admin_insert on public.business_units for insert to authenticated with check (public.has_role('admin'));
create policy admin_update on public.business_units for update to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));
create policy finance_insert on public.departments for insert to authenticated with check (public.has_role('admin', 'finance'));
create policy admin_update on public.departments for update to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));
create policy admin_delete on public.departments for delete to authenticated using (public.has_role('admin'));
create policy admin_insert on public.positions for insert to authenticated with check (public.has_role('admin'));
create policy admin_update on public.positions for update to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));
create policy admin_delete on public.positions for delete to authenticated using (public.has_role('admin'));
create policy admin_insert on public.salary_components for insert to authenticated with check (public.has_role('admin'));
create policy admin_update on public.salary_components for update to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));
create policy admin_delete on public.salary_components for delete to authenticated using (public.has_role('admin') and not is_system);
create policy finance_insert on public.worklogs for insert to authenticated with check (public.has_role('admin', 'finance'));
create policy finance_update on public.worklogs for update to authenticated using (public.has_role('admin', 'finance')) with check (public.has_role('admin', 'finance'));
create policy finance_delete on public.worklogs for delete to authenticated using (public.has_role('admin', 'finance'));
-- Tabel lain sengaja TIDAK memiliki kebijakan tulis: perubahan hanya lewat fungsi RPC.

-- ---------------------------------------------------------------------
-- Hak eksekusi fungsi
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.app_role() to authenticated;
grant execute on function public.has_role(text[]) to authenticated;
grant execute on function public.log_event(text, text, text, text) to authenticated;
grant execute on function public.admin_update_user(uuid, text, boolean, text) to authenticated;
grant execute on function public.mark_password_changed() to authenticated;
grant execute on function public.save_service(jsonb) to authenticated;
grant execute on function public.set_service_active(text, boolean) to authenticated;
grant execute on function public.delete_service(text) to authenticated;
grant execute on function public.save_employee(jsonb) to authenticated;
grant execute on function public.delete_employee(text) to authenticated;
grant execute on function public.create_service_transaction(jsonb) to authenticated;
grant execute on function public.update_service_transaction(text, jsonb, text) to authenticated;
grant execute on function public.cancel_service_transaction(text, text, text) to authenticated;
grant execute on function public.payroll_save_draft(jsonb) to authenticated;
grant execute on function public.payroll_approve(text) to authenticated;
grant execute on function public.payroll_lock(text) to authenticated;
grant execute on function public.payroll_unlock(text, text) to authenticated;
grant execute on function public.payroll_revert(text) to authenticated;
grant execute on function public.payroll_delete_draft(text) to authenticated;

-- Fungsi baru di masa depan tidak otomatis dapat dieksekusi publik.
alter default privileges in schema public revoke execute on functions from public, anon;

-- ---------------------------------------------------------------------
-- Realtime: perangkat lain langsung tahu bila data berubah.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.service_transactions, public.payroll_periods, public.employees, public.service_master;
  end if;
end;
$$;

-- >>> migrations/20261124000500_bulk_import.sql
-- =====================================================================
-- Migrasi 5: kategori tindakan "Dokter Umum & Bidan" dan "Homecare",
-- penanda sumber impor (nomor struk POS) dan input/impor tindakan massal.
--  * external_ref unik di antara transaksi aktif → struk yang sama tidak
--    dapat diimpor dua kali, termasuk bila dua orang mengimpor bersamaan.
--  * create_service_transactions_bulk menyimpan banyak transaksi dalam SATU
--    transaksi database: semuanya tersimpan, atau tidak sama sekali.
-- =====================================================================

alter table public.service_master drop constraint if exists service_master_category_check;
alter table public.service_master add constraint service_master_category_check
  check (category in ('Dokter Umum & Bidan', 'Homecare', 'Pemeriksaan laboratorium sederhana', 'Pemeriksaan kesehatan',
                      'Pemeriksaan dokter', 'Tindakan medis', 'Tindakan kebidanan', 'Tindakan keperawatan',
                      'Pelayanan farmasi', 'Penjualan produk', 'Pelayanan lainnya'));

alter table public.service_transactions add column if not exists external_ref text;
alter table public.service_transactions drop constraint if exists service_transactions_external_ref_chk;
alter table public.service_transactions add constraint service_transactions_external_ref_chk
  check (external_ref is null or length(external_ref) between 1 and 80);
create unique index if not exists service_transactions_external_ref_uidx
  on public.service_transactions (external_ref) where external_ref is not null and status = 'active';

-- Sama seperti versi sebelumnya, ditambah p.externalRef (opsional).
create or replace function public.create_service_transaction(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date  date := (p ->> 'date')::date;
  v_ref   text := nullif(trim(coalesce(p ->> 'externalRef', '')), '');
  v_ym    text;
  v_id    text;
  v_item  jsonb;
  v_ord   bigint;
  v_gross bigint := 0;
begin
  perform public.require_role('admin', 'finance', 'ops');
  if v_date is null then
    raise exception 'Tanggal transaksi wajib diisi.';
  end if;
  if v_date > public.jakarta_today() then
    raise exception 'Tanggal transaksi tidak boleh melebihi hari ini.';
  end if;
  if coalesce(jsonb_array_length(p -> 'items'), 0) = 0 then
    raise exception 'Minimal satu tindakan.';
  end if;
  if jsonb_array_length(p -> 'items') > 50 then
    raise exception 'Maksimal 50 tindakan per transaksi.';
  end if;
  if v_ref is not null and exists (select 1 from public.service_transactions where external_ref = v_ref and status = 'active') then
    raise exception 'Data % sudah pernah disimpan.', v_ref;
  end if;
  v_ym := to_char(v_date, 'YYYYMM');
  v_id := public.doc_prefix('transaction', 'TRX') || '-' || v_ym || '-' || lpad(public.next_counter('trx-' || v_ym)::text, 4, '0');
  insert into public.service_transactions (id, trx_date, patient_name, patient_code, note, external_ref, created_by, created_by_name)
  values (v_id, v_date, left(coalesce(p ->> 'patient', ''), 80), left(coalesce(p ->> 'patientCode', ''), 30), left(coalesce(p ->> 'note', ''), 200),
          v_ref, auth.uid(), public.current_username());
  for v_item, v_ord in select e.value, e.ordinality from jsonb_array_elements(p -> 'items') with ordinality e loop
    v_gross := v_gross + public._add_item(v_id, v_ord::int, v_item);
  end loop;
  update public.service_transactions set gross = v_gross where id = v_id;
  perform public.write_audit('trx.create', 'service_transactions', v_id, 'Transaksi baru ' || jsonb_array_length(p -> 'items') || ' tindakan, total Rp' || v_gross, null, p);
  return v_id;
end;
$$;

-- p: { source: text, transactions: [ {date, patient, patientCode, note, externalRef?, items:[...]} ] }
-- Transaksi yang externalRef-nya sudah ada (aktif) dilewati, bukan digandakan.
-- Hasil: { created: [id...], skipped: [externalRef...], gross: total }
create or replace function public.create_service_transactions_bulk(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trx     jsonb;
  v_ord     bigint;
  v_ref     text;
  v_id      text;
  v_created text[] := '{}';
  v_skipped text[] := '{}';
  v_gross   bigint := 0;
  v_n       int := coalesce(jsonb_array_length(p -> 'transactions'), 0);
begin
  perform public.require_role('admin', 'finance', 'ops');
  if v_n = 0 then
    raise exception 'Tidak ada transaksi untuk disimpan.';
  end if;
  if v_n > 1000 then
    raise exception 'Maksimal 1000 transaksi per sekali simpan.';
  end if;
  for v_trx, v_ord in select e.value, e.ordinality from jsonb_array_elements(p -> 'transactions') with ordinality e loop
    v_ref := nullif(trim(coalesce(v_trx ->> 'externalRef', '')), '');
    if v_ref is not null then
      -- kunci per nomor referensi: dua impor bersamaan tidak dapat menyimpan struk yang sama
      perform pg_advisory_xact_lock(hashtext('trx-ref:' || v_ref));
      if exists (select 1 from public.service_transactions where external_ref = v_ref and status = 'active') then
        v_skipped := v_skipped || v_ref;
        continue;
      end if;
    end if;
    begin
      v_id := public.create_service_transaction(v_trx);
    exception when others then
      raise exception 'Data ke-% (%): %', v_ord, coalesce(v_ref, v_trx ->> 'date'), sqlerrm;
    end;
    v_created := v_created || v_id;
    select v_gross + gross into v_gross from public.service_transactions where id = v_id;
  end loop;
  perform public.write_audit('trx.bulk', 'service_transactions', coalesce(v_created[1], ''),
    'Input massal (' || left(coalesce(p ->> 'source', 'input bulanan'), 120) || '): ' || coalesce(array_length(v_created, 1), 0)
      || ' transaksi tersimpan, ' || coalesce(array_length(v_skipped, 1), 0) || ' dilewati (sudah ada), total Rp' || v_gross,
    null, jsonb_build_object('created', to_jsonb(v_created), 'skipped', to_jsonb(v_skipped)));
  return jsonb_build_object('created', to_jsonb(v_created), 'skipped', to_jsonb(v_skipped), 'gross', v_gross);
end;
$$;

revoke execute on function public.create_service_transactions_bulk(jsonb) from public, anon;
grant execute on function public.create_service_transactions_bulk(jsonb) to authenticated;
revoke execute on function public.create_service_transaction(jsonb) from public, anon;
grant execute on function public.create_service_transaction(jsonb) to authenticated;

-- >>> migrations/20261124000600_doctor_variant.sql
-- =====================================================================
-- Migrasi 6: pembagian pendapatan berbeda untuk tindakan DENGAN dokter
-- dan TANPA dokter.
--  * service_revenue_rules.variant: 'standard' (tanpa dokter / satu-satunya
--    pembagian) atau 'doctor' (dipakai bila transaksi menandai "dengan dokter").
--  * service_transaction_items.with_doctor: varian yang dipakai (snapshot).
--  * Pembagian khusus per petugas tetap diutamakan pada kedua varian.
-- Padanan persis js/revenue-sharing.js (pickConfig / requiredRoles).
-- =====================================================================

alter table public.service_revenue_rules add column if not exists variant text not null default 'standard';
alter table public.service_revenue_rules drop constraint if exists rules_variant_chk;
alter table public.service_revenue_rules add constraint rules_variant_chk
  check (variant in ('standard', 'doctor') and (variant = 'standard' or employee_id is null));
drop index if exists public.service_revenue_rules_order_key;
create unique index service_revenue_rules_order_key on public.service_revenue_rules (service_id, coalesce(employee_id, ''), variant, sort_order);

alter table public.service_transaction_items add column if not exists with_doctor boolean not null default false;

-- Tanda tangan fungsi berubah (parameter baru) → versi lama dihapus agar tidak ambigu.
drop function if exists public.compute_allocations(text, bigint, int, jsonb, boolean);
drop function if exists public._insert_rules(text, text, jsonb);

create or replace function public.compute_allocations(p_service_id text, p_price bigint, p_qty int, p_performers jsonb, p_preview boolean default false, p_with_doctor boolean default false)
returns table (
  sort_order int, recipient_type text, target text, recipient_employee_id text, recipient_unit text, recipient_name text,
  category text, mode text, rule_value numeric, unit_amount bigint, amount bigint, is_implicit boolean, override_employee_id text)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_svc      public.service_master;
  v_perf     jsonb := coalesce(p_performers, '{}'::jsonb);
  v_override text;
  v_variant  text := 'standard';
  v_rules    public.service_revenue_rules[];
  r          public.service_revenue_rules;
  n          int;
  i          int;
  k          int;
  v_unit     bigint[];
  v_fixed    bigint := 0;
  v_psum     numeric := 0;
  v_pidx     int[] := '{}';
  v_raw      numeric[] := '{}';
  v_floor    bigint[] := '{}';
  v_order    int[];
  v_target   bigint;
  v_rest     bigint;
  v_ridx     int[] := '{}';
  v_each     bigint;
  v_res      bigint;
begin
  select * into v_svc from public.service_master s where s.id = p_service_id;
  if not found then
    raise exception 'Tindakan % tidak ditemukan.', p_service_id;
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'Harga jual tidak boleh negatif.';
  end if;
  if p_qty is null or p_qty < 1 then
    raise exception 'Jumlah tindakan minimal 1.';
  end if;

  -- Pembagian khusus petugas: override pertama yang petugasnya ikut melaksanakan.
  select g.employee_id into v_override
    from (select rr.employee_id, min(rr.id) as first_id
            from public.service_revenue_rules rr
           where rr.service_id = p_service_id and rr.employee_id is not null
           group by rr.employee_id) g
   where g.employee_id in (select je.value from jsonb_each_text(v_perf) je)
   order by g.first_id
   limit 1;

  -- Varian "dengan dokter" hanya bila diminta, tidak ada pembagian khusus petugas, dan tindakan memilikinya.
  if v_override is null and coalesce(p_with_doctor, false)
     and exists (select 1 from public.service_revenue_rules rr where rr.service_id = p_service_id and rr.employee_id is null and rr.variant = 'doctor') then
    v_variant := 'doctor';
  end if;

  select coalesce(array_agg(rr order by rr.sort_order), '{}') into v_rules
    from public.service_revenue_rules rr
   where rr.service_id = p_service_id and rr.employee_id is not distinct from v_override
     and (v_override is not null or rr.variant = v_variant);
  n := coalesce(array_length(v_rules, 1), 0);
  v_unit := array_fill(0::bigint, array[greatest(n, 1)]);

  -- 1. nominal & kumpulkan persen
  for i in 1..n loop
    r := v_rules[i];
    if r.mode = 'nominal' then
      v_unit[i] := round(r.value)::bigint;
      v_fixed := v_fixed + v_unit[i];
    elsif r.mode = 'percent' then
      v_pidx := v_pidx || i;
      v_psum := v_psum + r.value;
    end if;
  end loop;
  if v_psum > 100.0000001 then
    raise exception '%', 'Total persentase ' || round(v_psum, 2) || '% melebihi 100%.';
  end if;

  -- 2. persen dengan pembulatan sisa terbesar
  if array_length(v_pidx, 1) > 0 then
    v_target := round(p_price * v_psum / 100.0)::bigint;
    foreach i in array v_pidx loop
      v_raw := v_raw || (p_price * v_rules[i].value / 100.0);
      v_floor := v_floor || floor(p_price * v_rules[i].value / 100.0 + 0.000000001)::bigint;
    end loop;
    v_rest := v_target - (select coalesce(sum(x), 0) from unnest(v_floor) x);
    select array_agg(o.ord order by o.frac desc, o.ord) into v_order
      from (select g.ord, v_raw[g.ord] - floor(v_raw[g.ord] + 0.000000001) as frac
              from generate_subscripts(v_raw, 1) as g(ord)) o;
    k := 0;
    while v_rest > 0 loop
      v_floor[v_order[(k % array_length(v_order, 1)) + 1]] := v_floor[v_order[(k % array_length(v_order, 1)) + 1]] + 1;
      v_rest := v_rest - 1;
      k := k + 1;
    end loop;
    for k in 1..array_length(v_pidx, 1) loop
      v_unit[v_pidx[k]] := v_floor[k];
      v_fixed := v_fixed + v_floor[k];
    end loop;
  end if;

  if v_fixed > p_price then
    raise exception 'Total pembagian Rp% melebihi harga jual Rp%.', v_fixed, p_price;
  end if;

  -- 3. sisa harga
  for i in 1..n loop
    if v_rules[i].mode = 'remainder' then
      v_ridx := v_ridx || i;
    end if;
  end loop;
  v_rest := greatest(0, p_price - v_fixed);
  if array_length(v_ridx, 1) > 0 then
    v_each := v_rest / array_length(v_ridx, 1);
    v_res := v_rest - v_each * array_length(v_ridx, 1);
    foreach i in array v_ridx loop
      v_unit[i] := v_each + case when v_res > 0 then 1 else 0 end;
      if v_res > 0 then
        v_res := v_res - 1;
      end if;
    end loop;
    v_rest := 0;
  end if;

  -- 4. penerima
  for i in 1..n loop
    r := v_rules[i];
    sort_order := r.sort_order;
    recipient_type := r.recipient_type;
    target := r.target;
    recipient_employee_id := null;
    recipient_unit := null;
    mode := r.mode;
    rule_value := r.value;
    unit_amount := v_unit[i];
    amount := v_unit[i] * p_qty;
    is_implicit := false;
    override_employee_id := v_override;
    if r.recipient_type = 'unit' then
      recipient_unit := r.target;
      select bu.name into recipient_name from public.business_units bu where bu.code = r.target;
      category := case r.target when 'APT' then 'apotek' else 'klinik' end;
    elsif r.recipient_type = 'role' then
      category := r.target;
      recipient_employee_id := nullif(v_perf ->> r.target, '');
      if recipient_employee_id is null then
        if not p_preview then
          raise exception 'Petugas % belum dipilih.', public.role_label(r.target);
        end if;
        recipient_name := '(' || public.role_label(r.target) || ' pelaksana)';
      else
        select e.full_name into recipient_name from public.employees e where e.id = recipient_employee_id;
        if not found then
          raise exception 'Petugas % tidak ditemukan.', recipient_employee_id;
        end if;
      end if;
    elsif r.recipient_type = 'employee' then
      recipient_employee_id := r.target_employee_id;
      select e.full_name, p.role_key into recipient_name, category
        from public.employees e join public.positions p on p.id = e.position_id
       where e.id = r.target_employee_id;
    else
      recipient_name := r.target;
      category := 'eksternal';
    end if;
    return next;
  end loop;

  if v_rest > 0 then
    sort_order := n;
    recipient_type := 'unit';
    target := v_svc.unit_code;
    recipient_employee_id := null;
    recipient_unit := v_svc.unit_code;
    select bu.name into recipient_name from public.business_units bu where bu.code = v_svc.unit_code;
    category := case v_svc.unit_code when 'APT' then 'apotek' else 'klinik' end;
    mode := 'remainder';
    rule_value := 0;
    unit_amount := v_rest;
    amount := v_rest * p_qty;
    is_implicit := true;
    override_employee_id := v_override;
    return next;
  end if;
end;
$$;

create or replace function public._insert_rules(p_service_id text, p_employee_id text, p_shares jsonb, p_variant text default 'standard')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s   jsonb;
  v_ord bigint;
begin
  if jsonb_typeof(coalesce(p_shares, '[]'::jsonb)) <> 'array' then
    raise exception 'Format pembagian tidak valid.';
  end if;
  for v_s, v_ord in select e.value, e.ordinality from jsonb_array_elements(coalesce(p_shares, '[]'::jsonb)) with ordinality e loop
    insert into public.service_revenue_rules (service_id, employee_id, variant, sort_order, recipient_type, target, target_employee_id, mode, value)
    values (p_service_id, p_employee_id, coalesce(p_variant, 'standard'), v_ord - 1, v_s ->> 'type', trim(coalesce(v_s ->> 'target', '')),
            case when v_s ->> 'type' = 'employee' then v_s ->> 'target' end,
            v_s ->> 'mode', case when v_s ->> 'mode' = 'remainder' then 0 else coalesce((v_s ->> 'value')::numeric, 0) end);
  end loop;
end;
$$;

create or replace function public.save_service(p jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     text := nullif(p ->> 'id', '');
  v_old    public.service_master;
  v_modes  text[];
  v_method text;
  v_ov     jsonb;
  v_emps   text[] := '{}';
begin
  perform public.require_role('admin');
  if coalesce(jsonb_array_length(p -> 'shares'), 0) = 0 then
    raise exception 'Minimal satu penerima pendapatan.';
  end if;
  select array_agg(distinct s ->> 'mode') into v_modes
    from jsonb_array_elements(p -> 'shares') s where s ->> 'mode' <> 'remainder';
  v_method := case when coalesce(array_length(v_modes, 1), 0) = 0 then 'nominal'
                   when array_length(v_modes, 1) = 1 then v_modes[1] else 'combo' end;
  begin
    if v_id is null then
      insert into public.service_master (name, category, unit_code, price, method, active, notes)
      values (trim(p ->> 'name'), p ->> 'category', p ->> 'unit', (p ->> 'price')::bigint, v_method,
              coalesce((p ->> 'active')::boolean, true), coalesce(p ->> 'notes', ''))
      returning id into v_id;
    else
      select * into v_old from public.service_master where id = v_id for update;
      if not found then
        raise exception 'Tindakan % tidak ditemukan.', v_id;
      end if;
      update public.service_master
         set name = trim(p ->> 'name'), category = p ->> 'category', unit_code = p ->> 'unit', price = (p ->> 'price')::bigint,
             method = v_method, active = coalesce((p ->> 'active')::boolean, true), notes = coalesce(p ->> 'notes', ''), updated_at = now()
       where id = v_id;
    end if;
  exception when unique_violation then
    raise exception 'Nama tindakan sudah ada pada unit yang sama.';
  end;

  delete from public.service_revenue_rules where service_id = v_id;
  perform public._insert_rules(v_id, null, p -> 'shares');
  for v_ov in select e.value from jsonb_array_elements(coalesce(p -> 'overrides', '[]'::jsonb)) e loop
    if coalesce(v_ov ->> 'employeeId', '') = '' then
      raise exception 'Pembagian khusus petugas: karyawan wajib dipilih.';
    end if;
    if (v_ov ->> 'employeeId') = any (v_emps) then
      raise exception 'Pembagian khusus untuk karyawan yang sama tidak boleh ganda.';
    end if;
    v_emps := v_emps || (v_ov ->> 'employeeId');
    perform public._insert_rules(v_id, v_ov ->> 'employeeId', v_ov -> 'shares');
  end loop;
  -- Pembagian khusus bila tindakan dilakukan DENGAN dokter (opsional).
  if jsonb_typeof(p -> 'doctorShares') = 'array' and jsonb_array_length(p -> 'doctorShares') > 0 then
    perform public._insert_rules(v_id, null, p -> 'doctorShares', 'doctor');
  end if;

  -- Validasi konfigurasi (melempar error -> seluruh penyimpanan dibatalkan)
  perform 1 from public.compute_allocations(v_id, (p ->> 'price')::bigint, 1, '{}'::jsonb, true);
  perform 1 from public.compute_allocations(v_id, (p ->> 'price')::bigint, 1, '{}'::jsonb, true, true);
  perform 1 from unnest(v_emps) emp, lateral public.compute_allocations(v_id, (p ->> 'price')::bigint, 1, jsonb_build_object('x', emp), true);

  perform public.write_audit(case when v_old.id is null then 'service.save_new' else 'service.save' end, 'service_master', v_id,
    'Simpan tindakan ' || trim(p ->> 'name') || ' (Rp' || (p ->> 'price') || ')' ||
    case when coalesce(jsonb_array_length(p -> 'doctorShares'), 0) > 0 then '; pembagian dengan/tanpa dokter' else '' end ||
    case when v_old.id is not null and v_old.price <> (p ->> 'price')::bigint then '; harga Rp' || v_old.price || ' -> Rp' || (p ->> 'price') else '' end,
    to_jsonb(v_old), p);
  return v_id;
end;
$$;

create or replace function public._add_item(p_trx_id text, p_line_no int, p_item jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_svc   public.service_master;
  v_qty   int := (p_item ->> 'qty')::int;
  v_price bigint := (p_item ->> 'price')::bigint;
  v_perf  jsonb := '{}'::jsonb;
  v_names jsonb := '{}'::jsonb;
  v_role  text;
  v_emp   public.employees;
  v_item  uuid;
  v_sum   bigint;
  v_over  text;
  v_wd    boolean;
begin
  select * into v_svc from public.service_master where id = p_item ->> 'serviceId';
  if not found then
    raise exception 'Baris %: tindakan tidak ditemukan.', p_line_no;
  end if;
  if not v_svc.active then
    raise exception 'Baris %: tindakan "%" sudah nonaktif.', p_line_no, v_svc.name;
  end if;
  if v_qty is null or v_qty < 1 then
    raise exception 'Baris %: jumlah minimal 1.', p_line_no;
  end if;
  if v_price is null or v_price <= 0 then
    raise exception 'Baris %: harga jual harus lebih dari 0.', p_line_no;
  end if;
  v_wd := coalesce((p_item ->> 'withDoctor')::boolean, false)
          and exists (select 1 from public.service_revenue_rules rr where rr.service_id = v_svc.id and rr.employee_id is null and rr.variant = 'doctor');
  -- Hanya peran yang dipakai aturan pembagian (varian terpilih + pembagian khusus) yang disimpan sebagai pelaksana.
  for v_role in select distinct rr.target from public.service_revenue_rules rr
                 where rr.service_id = v_svc.id and rr.recipient_type = 'role'
                   and (rr.employee_id is not null or rr.variant = case when v_wd then 'doctor' else 'standard' end) loop
    if coalesce(p_item -> 'performers' ->> v_role, '') <> '' then
      select * into v_emp from public.employees where id = p_item -> 'performers' ->> v_role;
      if not found then
        raise exception 'Baris %: petugas tidak ditemukan.', p_line_no;
      end if;
      if v_emp.status not in ('aktif', 'cuti') then
        raise exception 'Baris %: petugas % tidak aktif.', p_line_no, v_emp.full_name;
      end if;
      v_perf := v_perf || jsonb_build_object(v_role, v_emp.id);
      v_names := v_names || jsonb_build_object(v_role, v_emp.full_name);
    end if;
  end loop;

  insert into public.service_transaction_items (transaction_id, line_no, service_id, service_code, service_name, category, unit_code, qty, unit_price, gross, performers, performer_names, with_doctor)
  values (p_trx_id, p_line_no, v_svc.id, v_svc.id, v_svc.name, v_svc.category, v_svc.unit_code, v_qty, v_price, v_qty * v_price, v_perf, v_names, v_wd)
  returning id into v_item;

  insert into public.service_transaction_allocations (transaction_id, item_id, kind, sort_order, recipient_type, target, recipient_employee_id, recipient_unit,
                                                      recipient_name, category, mode, rule_value, unit_amount, amount, is_implicit)
  select p_trx_id, v_item, 'share', c.sort_order, c.recipient_type, c.target, c.recipient_employee_id, c.recipient_unit,
         c.recipient_name, c.category, c.mode, c.rule_value, c.unit_amount, c.amount, c.is_implicit
    from public.compute_allocations(v_svc.id, v_price, v_qty, v_perf, false, v_wd) c;

  select max(c.override_employee_id) into v_over from public.compute_allocations(v_svc.id, v_price, 1, v_perf, false, v_wd) c;
  update public.service_transaction_items set override_employee_id = v_over where id = v_item;

  select coalesce(sum(amount), 0) into v_sum from public.service_transaction_allocations where item_id = v_item;
  if v_sum <> v_qty * v_price then
    raise exception 'Baris %: total pembagian (Rp%) tidak sama dengan pendapatan (Rp%).', p_line_no, v_sum, v_qty * v_price;
  end if;
  return v_qty * v_price;
end;
$$;

create or replace function public.update_service_transaction(p_id text, p jsonb, p_note text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trx      public.service_transactions;
  v_locked   text;
  v_settled  jsonb;
  v_keep     uuid[] := '{}';
  v_item     jsonb;
  v_ord      bigint;
  v_old_item public.service_transaction_items;
  v_perf     jsonb;
  v_before   text;
  v_after    text;
  v_gross    bigint;
  v_role     text := public.app_role();
begin
  perform public.require_role('admin', 'finance', 'ops');
  select * into v_trx from public.service_transactions where id = p_id for update;
  if not found then
    raise exception 'Transaksi tidak ditemukan.';
  end if;
  if v_role = 'ops' and v_trx.created_by is distinct from auth.uid() then
    raise exception 'Admin Operasional hanya dapat mengubah transaksi yang diinputnya sendiri.' using errcode = '42501';
  end if;
  if v_trx.status = 'cancelled' then
    raise exception 'Transaksi sudah dibatalkan dan tidak dapat diubah.';
  end if;
  if exists (select 1 from public.service_transaction_allocations where transaction_id = p_id and payroll_state = 'approved') then
    raise exception 'Transaksi sudah masuk penggajian yang telah DISETUJUI. Kembalikan penggajian tersebut ke draft terlebih dahulu.';
  end if;
  if (p ->> 'date')::date > public.jakarta_today() then
    raise exception 'Tanggal transaksi tidak boleh melebihi hari ini.';
  end if;
  if coalesce(jsonb_array_length(p -> 'items'), 0) = 0 then
    raise exception 'Minimal satu tindakan.';
  end if;
  select payroll_period_id into v_locked from public.service_transaction_allocations
   where transaction_id = p_id and kind = 'share' and payroll_state = 'locked' limit 1;
  if v_locked is not null then
    if v_role <> 'admin' then
      raise exception 'LOCKED: Transaksi sudah masuk periode gaji terkunci. Diperlukan otorisasi administrator.' using errcode = '42501';
    end if;
    if length(trim(coalesce(p_note, ''))) < 5 then
      raise exception 'Catatan perubahan wajib diisi (min. 5 karakter).';
    end if;
  end if;

  select jsonb_object_agg(s.employee_id, s.settled) into v_settled from public._settled_by_employee(p_id) s;
  select string_agg(i.service_name || ' x' || i.qty, ', ' order by i.line_no) || ' = Rp' || v_trx.gross || ' (' || v_trx.trx_date || ')'
    into v_before from public.service_transaction_items i where i.transaction_id = p_id;

  -- Draft penggajian yang memakai transaksi ini harus dihitung ulang.
  update public.payroll_periods set stale = true, stale_reason = 'Transaksi ' || p_id || ' diubah'
   where status = 'draft' and id in (select payroll_period_id from public.service_transaction_allocations where transaction_id = p_id and payroll_state = 'draft');

  -- Item yang tidak berubah tetap memakai snapshot lama (tarif historis tidak berubah).
  for v_item in select e.value from jsonb_array_elements(p -> 'items') e loop
    if coalesce(v_item ->> 'lineId', '') ~ '^[0-9a-f-]{36}$' then
      select * into v_old_item from public.service_transaction_items where id = (v_item ->> 'lineId')::uuid and transaction_id = p_id;
      if found then
        select coalesce(jsonb_object_agg(k, v_item -> 'performers' ->> k), '{}'::jsonb) into v_perf
          from jsonb_object_keys(v_old_item.performers) k where coalesce(v_item -> 'performers' ->> k, '') <> '';
        if v_old_item.service_id = v_item ->> 'serviceId' and v_old_item.qty = (v_item ->> 'qty')::int
           and v_old_item.unit_price = (v_item ->> 'price')::bigint and v_old_item.performers = v_perf
           and v_old_item.with_doctor = coalesce((v_item ->> 'withDoctor')::boolean, false) then
          v_keep := v_keep || v_old_item.id;
        end if;
      end if;
    end if;
  end loop;
  delete from public.service_transaction_items where transaction_id = p_id and id <> all (v_keep);
  update public.service_transaction_items set line_no = line_no + 1000 where transaction_id = p_id;
  if v_locked is null then
    update public.service_transaction_allocations set payroll_period_id = null, payroll_record_id = null, payroll_state = null
     where transaction_id = p_id and kind = 'share' and payroll_state = 'draft';
  end if;

  for v_item, v_ord in select e.value, e.ordinality from jsonb_array_elements(p -> 'items') with ordinality e loop
    if coalesce(v_item ->> 'lineId', '') ~ '^[0-9a-f-]{36}$' and (v_item ->> 'lineId')::uuid = any (v_keep) then
      update public.service_transaction_items set line_no = v_ord where id = (v_item ->> 'lineId')::uuid;
    else
      perform public._add_item(p_id, v_ord::int, v_item);
    end if;
  end loop;

  select coalesce(sum(gross), 0) into v_gross from public.service_transaction_items where transaction_id = p_id;
  update public.service_transactions
     set trx_date = (p ->> 'date')::date, patient_name = left(coalesce(p ->> 'patient', ''), 80), patient_code = left(coalesce(p ->> 'patientCode', ''), 30),
         note = left(coalesce(p ->> 'note', ''), 200), gross = v_gross, updated_at = now(), updated_by = auth.uid(),
         corrections = case when v_locked is null then corrections
                            else corrections || jsonb_build_array(jsonb_build_object('ts', now(), 'by', public.current_username(), 'note', p_note, 'before', v_before)) end
   where id = p_id;

  if v_locked is not null then
    -- Bagian baru dianggap milik periode terkunci; selisih dibayar lewat adjustment.
    update public.service_transaction_allocations a
       set payroll_period_id = v_locked, payroll_state = 'locked',
           payroll_record_id = (select r.id from public.payroll_records r where r.period_id = v_locked and r.employee_id = a.recipient_employee_id)
     where a.transaction_id = p_id and a.kind = 'share' and a.recipient_employee_id is not null and a.payroll_state is null;
    perform public._insert_adjustments(p_id, v_settled, 'koreksi', p_note);
  end if;

  select string_agg(i.service_name || ' x' || i.qty, ', ' order by i.line_no) || ' = Rp' || v_gross || ' (' || (p ->> 'date') || ')'
    into v_after from public.service_transaction_items i where i.transaction_id = p_id;
  perform public.write_audit(case when v_locked is null then 'trx.update' else 'trx.correction' end, 'service_transactions', p_id,
    case when v_locked is null then 'Ubah transaksi | ' else 'KOREKSI TERKUNCI (otorisasi ' || public.current_username() || '): ' || p_note || ' | ' end
      || 'Sebelum: ' || coalesce(v_before, '-') || ' -> Sesudah: ' || coalesce(v_after, '-'), null, p);
  return p_id;
end;
$$;

-- Fungsi internal: tidak dapat dipanggil langsung oleh pengguna.
revoke execute on function public.compute_allocations(text, bigint, int, jsonb, boolean, boolean) from public, anon, authenticated;
revoke execute on function public._insert_rules(text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public._add_item(text, int, jsonb) from public, anon, authenticated;

-- >>> migrations/20261124000700_delete_transactions.sql
-- =====================================================================
-- Migrasi 7: hapus transaksi tindakan (satu, beberapa, atau sebulan).
--  * Hanya Administrator, wajib alasan.
--  * Transaksi yang sudah masuk penggajian (draft/disetujui/terkunci) atau
--    memiliki koreksi (adjustment) TIDAK dihapus — dilewati beserta alasannya
--    agar jasa yang sudah dihitung/dibayar tetap utuh. Gunakan pembatalan.
--  * Seluruh penghapusan dalam satu transaksi database; salinan lengkap
--    (transaksi + item) disimpan di audit log.
--  * Nomor struk POS/resep yang dihapus dapat diimpor ulang.
-- =====================================================================

create or replace function public.delete_service_transactions(p_ids jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      text;
  v_trx     public.service_transactions;
  v_snap    jsonb;
  v_deleted text[] := '{}';
  v_skipped jsonb := '[]'::jsonb;
  v_gross   bigint := 0;
  v_list    text[];
begin
  perform public.require_role('admin');
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Alasan penghapusan wajib diisi (min. 3 karakter).';
  end if;
  if jsonb_typeof(p_ids) <> 'array' then
    raise exception 'Format daftar transaksi tidak valid.';
  end if;
  select coalesce(array_agg(distinct x), '{}') into v_list from jsonb_array_elements_text(p_ids) x;
  if coalesce(array_length(v_list, 1), 0) = 0 then
    raise exception 'Tidak ada transaksi yang dipilih.';
  end if;
  if array_length(v_list, 1) > 5000 then
    raise exception 'Maksimal 5000 transaksi per sekali hapus.';
  end if;
  foreach v_id in array v_list loop
    select * into v_trx from public.service_transactions where id = v_id for update;
    if not found then
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'tidak ditemukan');
      continue;
    end if;
    if exists (select 1 from public.service_transaction_allocations a
                where a.transaction_id = v_id
                  and (a.payroll_state is not null or a.payroll_period_id is not null or a.kind <> 'share')) then
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'sudah masuk penggajian atau memiliki koreksi');
      continue;
    end if;
    select to_jsonb(v_trx) || jsonb_build_object('items', coalesce((select jsonb_agg(to_jsonb(i) order by i.line_no)
                                                                       from public.service_transaction_items i where i.transaction_id = v_id), '[]'::jsonb))
      into v_snap;
    delete from public.service_transactions where id = v_id; -- item & alokasi ikut terhapus (on delete cascade)
    v_deleted := v_deleted || v_id;
    v_gross := v_gross + v_trx.gross;
    perform public.write_audit('trx.delete', 'service_transactions', v_id,
      'Hapus transaksi ' || v_id || ' (' || v_trx.trx_date || ', Rp' || v_trx.gross || '): ' || left(trim(p_reason), 300), v_snap, null);
  end loop;
  return jsonb_build_object('deleted', to_jsonb(v_deleted), 'skipped', v_skipped, 'gross', v_gross);
end;
$$;

revoke execute on function public.delete_service_transactions(jsonb, text) from public, anon;
grant execute on function public.delete_service_transactions(jsonb, text) to authenticated;

-- >>> migrations/20261124000800_optional_per_visit.sql
-- =====================================================================
-- Migrasi 8: bagian penerima OPSIONAL dan PER KUNJUNGAN.
--  * optional  (petugas pelaksana): bila pelaksana tidak dipilih, bagiannya
--    kembali ke unit tindakan — mis. bidan yang tidak selalu ikut konsultasi.
--  * per_visit (petugas/karyawan, nominal): dibayar SEKALI per transaksi
--    (kunjungan), bukan × jumlah, dan tidak lagi bila sudah dibayar tindakan
--    lain di transaksi yang sama — mis. jasa bidan homecare Rp100.000 per
--    kunjungan meskipun pasien mendapat beberapa tindakan homecare.
--  Selisihnya masuk ke baris "sisa otomatis" unit. Padanan persis
--  js/revenue-sharing.js (compute, opt.paid).
-- =====================================================================

alter table public.service_revenue_rules add column if not exists optional boolean not null default false;
alter table public.service_revenue_rules add column if not exists per_visit boolean not null default false;
alter table public.service_revenue_rules drop constraint if exists rules_flags_chk;
alter table public.service_revenue_rules add constraint rules_flags_chk
  check ((not optional or recipient_type = 'role') and (not per_visit or (recipient_type in ('role', 'employee') and mode = 'nominal')));
alter table public.service_transaction_allocations add column if not exists per_visit boolean not null default false;

drop function if exists public.compute_allocations(text, bigint, int, jsonb, boolean, boolean);

create or replace function public.compute_allocations(p_service_id text, p_price bigint, p_qty int, p_performers jsonb, p_preview boolean default false, p_with_doctor boolean default false, p_paid text[] default '{}')
returns table (
  sort_order int, recipient_type text, target text, recipient_employee_id text, recipient_unit text, recipient_name text,
  category text, mode text, rule_value numeric, unit_amount bigint, amount bigint, is_implicit boolean, override_employee_id text, per_visit boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_svc      public.service_master;
  v_perf     jsonb := coalesce(p_performers, '{}'::jsonb);
  v_override text;
  v_variant  text := 'standard';
  v_rules    public.service_revenue_rules[];
  r          public.service_revenue_rules;
  n          int;
  i          int;
  k          int;
  v_unit     bigint[];
  v_fixed    bigint := 0;
  v_psum     numeric := 0;
  v_pidx     int[] := '{}';
  v_raw      numeric[] := '{}';
  v_floor    bigint[] := '{}';
  v_order    int[];
  v_target   bigint;
  v_rest     bigint;
  v_ridx     int[] := '{}';
  v_each     bigint;
  v_res      bigint;
  v_extra    bigint := 0;      -- nominal opsional / per kunjungan yang tidak dibayar → ke unit
  v_paid     text[] := coalesce(p_paid, '{}');
  v_key      text;
begin
  select * into v_svc from public.service_master s where s.id = p_service_id;
  if not found then
    raise exception 'Tindakan % tidak ditemukan.', p_service_id;
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'Harga jual tidak boleh negatif.';
  end if;
  if p_qty is null or p_qty < 1 then
    raise exception 'Jumlah tindakan minimal 1.';
  end if;

  -- Pembagian khusus petugas: override pertama yang petugasnya ikut melaksanakan.
  select g.employee_id into v_override
    from (select rr.employee_id, min(rr.id) as first_id
            from public.service_revenue_rules rr
           where rr.service_id = p_service_id and rr.employee_id is not null
           group by rr.employee_id) g
   where g.employee_id in (select je.value from jsonb_each_text(v_perf) je)
   order by g.first_id
   limit 1;

  -- Varian "dengan dokter" hanya bila diminta, tidak ada pembagian khusus petugas, dan tindakan memilikinya.
  if v_override is null and coalesce(p_with_doctor, false)
     and exists (select 1 from public.service_revenue_rules rr where rr.service_id = p_service_id and rr.employee_id is null and rr.variant = 'doctor') then
    v_variant := 'doctor';
  end if;

  select coalesce(array_agg(rr order by rr.sort_order), '{}') into v_rules
    from public.service_revenue_rules rr
   where rr.service_id = p_service_id and rr.employee_id is not distinct from v_override
     and (v_override is not null or rr.variant = v_variant);
  n := coalesce(array_length(v_rules, 1), 0);
  v_unit := array_fill(0::bigint, array[greatest(n, 1)]);

  -- 1. nominal & kumpulkan persen
  for i in 1..n loop
    r := v_rules[i];
    if r.mode = 'nominal' then
      v_unit[i] := round(r.value)::bigint;
      v_fixed := v_fixed + v_unit[i];
    elsif r.mode = 'percent' then
      v_pidx := v_pidx || i;
      v_psum := v_psum + r.value;
    end if;
  end loop;
  if v_psum > 100.0000001 then
    raise exception '%', 'Total persentase ' || round(v_psum, 2) || '% melebihi 100%.';
  end if;

  -- 2. persen dengan pembulatan sisa terbesar
  if array_length(v_pidx, 1) > 0 then
    v_target := round(p_price * v_psum / 100.0)::bigint;
    foreach i in array v_pidx loop
      v_raw := v_raw || (p_price * v_rules[i].value / 100.0);
      v_floor := v_floor || floor(p_price * v_rules[i].value / 100.0 + 0.000000001)::bigint;
    end loop;
    v_rest := v_target - (select coalesce(sum(x), 0) from unnest(v_floor) x);
    select array_agg(o.ord order by o.frac desc, o.ord) into v_order
      from (select g.ord, v_raw[g.ord] - floor(v_raw[g.ord] + 0.000000001) as frac
              from generate_subscripts(v_raw, 1) as g(ord)) o;
    k := 0;
    while v_rest > 0 loop
      v_floor[v_order[(k % array_length(v_order, 1)) + 1]] := v_floor[v_order[(k % array_length(v_order, 1)) + 1]] + 1;
      v_rest := v_rest - 1;
      k := k + 1;
    end loop;
    for k in 1..array_length(v_pidx, 1) loop
      v_unit[v_pidx[k]] := v_floor[k];
      v_fixed := v_fixed + v_floor[k];
    end loop;
  end if;

  if v_fixed > p_price then
    raise exception 'Total pembagian Rp% melebihi harga jual Rp%.', v_fixed, p_price;
  end if;

  -- 3. sisa harga
  for i in 1..n loop
    if v_rules[i].mode = 'remainder' then
      v_ridx := v_ridx || i;
    end if;
  end loop;
  v_rest := greatest(0, p_price - v_fixed);
  if array_length(v_ridx, 1) > 0 then
    v_each := v_rest / array_length(v_ridx, 1);
    v_res := v_rest - v_each * array_length(v_ridx, 1);
    foreach i in array v_ridx loop
      v_unit[i] := v_each + case when v_res > 0 then 1 else 0 end;
      if v_res > 0 then
        v_res := v_res - 1;
      end if;
    end loop;
    v_rest := 0;
  end if;

  -- 4. penerima
  for i in 1..n loop
    r := v_rules[i];
    sort_order := r.sort_order;
    recipient_type := r.recipient_type;
    target := r.target;
    recipient_employee_id := null;
    recipient_unit := null;
    mode := r.mode;
    rule_value := r.value;
    unit_amount := v_unit[i];
    amount := v_unit[i] * p_qty;
    is_implicit := false;
    override_employee_id := v_override;
    per_visit := false;
    if r.recipient_type = 'unit' then
      recipient_unit := r.target;
      select bu.name into recipient_name from public.business_units bu where bu.code = r.target;
      category := case r.target when 'APT' then 'apotek' else 'klinik' end;
    elsif r.recipient_type = 'role' then
      category := r.target;
      recipient_employee_id := nullif(v_perf ->> r.target, '');
      if recipient_employee_id is null and r.optional then
        -- pelaksana opsional tidak ikut → bagiannya kembali ke unit
        recipient_name := '(tanpa ' || lower(public.role_label(r.target)) || ')';
        v_extra := v_extra + amount;
        unit_amount := 0;
        amount := 0;
      elsif recipient_employee_id is null then
        if not p_preview then
          raise exception 'Petugas % belum dipilih.', public.role_label(r.target);
        end if;
        recipient_name := '(' || public.role_label(r.target) || ' pelaksana)';
      else
        select e.full_name into recipient_name from public.employees e where e.id = recipient_employee_id;
        if not found then
          raise exception 'Petugas % tidak ditemukan.', recipient_employee_id;
        end if;
      end if;
    elsif r.recipient_type = 'employee' then
      recipient_employee_id := r.target_employee_id;
      select e.full_name, p.role_key into recipient_name, category
        from public.employees e join public.positions p on p.id = e.position_id
       where e.id = r.target_employee_id;
    else
      recipient_name := r.target;
      category := 'eksternal';
    end if;
    -- bagian per kunjungan: sekali per transaksi, tidak lagi bila sudah dibayar tindakan lain
    if r.per_visit and r.recipient_type in ('role', 'employee') and amount > 0 then
      per_visit := true;
      v_key := case r.recipient_type when 'role' then 'role:' else 'emp:' end || r.target;
      if v_key = any (v_paid) then
        v_extra := v_extra + amount;
        unit_amount := 0;
        amount := 0;
      else
        v_extra := v_extra + amount - v_unit[i];
        amount := v_unit[i];
        v_paid := v_paid || v_key;
      end if;
    end if;
    return next;
  end loop;

  if v_rest > 0 or v_extra > 0 then
    sort_order := n;
    recipient_type := 'unit';
    target := v_svc.unit_code;
    recipient_employee_id := null;
    recipient_unit := v_svc.unit_code;
    select bu.name into recipient_name from public.business_units bu where bu.code = v_svc.unit_code;
    category := case v_svc.unit_code when 'APT' then 'apotek' else 'klinik' end;
    mode := 'remainder';
    rule_value := 0;
    unit_amount := v_rest;
    amount := v_rest * p_qty + v_extra;
    is_implicit := true;
    override_employee_id := v_override;
    per_visit := false;
    return next;
  end if;
end;
$$;

create or replace function public._insert_rules(p_service_id text, p_employee_id text, p_shares jsonb, p_variant text default 'standard')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s   jsonb;
  v_ord bigint;
begin
  if jsonb_typeof(coalesce(p_shares, '[]'::jsonb)) <> 'array' then
    raise exception 'Format pembagian tidak valid.';
  end if;
  for v_s, v_ord in select e.value, e.ordinality from jsonb_array_elements(coalesce(p_shares, '[]'::jsonb)) with ordinality e loop
    insert into public.service_revenue_rules (service_id, employee_id, variant, sort_order, recipient_type, target, target_employee_id, mode, value, optional, per_visit)
    values (p_service_id, p_employee_id, coalesce(p_variant, 'standard'), v_ord - 1, v_s ->> 'type', trim(coalesce(v_s ->> 'target', '')),
            case when v_s ->> 'type' = 'employee' then v_s ->> 'target' end,
            v_s ->> 'mode', case when v_s ->> 'mode' = 'remainder' then 0 else coalesce((v_s ->> 'value')::numeric, 0) end,
            coalesce((v_s ->> 'optional')::boolean, false), coalesce((v_s ->> 'perVisit')::boolean, false));
  end loop;
end;
$$;

create or replace function public._add_item(p_trx_id text, p_line_no int, p_item jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_svc   public.service_master;
  v_qty   int := (p_item ->> 'qty')::int;
  v_price bigint := (p_item ->> 'price')::bigint;
  v_perf  jsonb := '{}'::jsonb;
  v_names jsonb := '{}'::jsonb;
  v_role  text;
  v_emp   public.employees;
  v_item  uuid;
  v_sum   bigint;
  v_over  text;
  v_wd    boolean;
  v_paid  text[];
begin
  select * into v_svc from public.service_master where id = p_item ->> 'serviceId';
  if not found then
    raise exception 'Baris %: tindakan tidak ditemukan.', p_line_no;
  end if;
  if not v_svc.active then
    raise exception 'Baris %: tindakan "%" sudah nonaktif.', p_line_no, v_svc.name;
  end if;
  if v_qty is null or v_qty < 1 then
    raise exception 'Baris %: jumlah minimal 1.', p_line_no;
  end if;
  if v_price is null or v_price <= 0 then
    raise exception 'Baris %: harga jual harus lebih dari 0.', p_line_no;
  end if;
  v_wd := coalesce((p_item ->> 'withDoctor')::boolean, false)
          and exists (select 1 from public.service_revenue_rules rr where rr.service_id = v_svc.id and rr.employee_id is null and rr.variant = 'doctor');
  -- Hanya peran yang dipakai aturan pembagian (varian terpilih + pembagian khusus) yang disimpan sebagai pelaksana.
  for v_role in select distinct rr.target from public.service_revenue_rules rr
                 where rr.service_id = v_svc.id and rr.recipient_type = 'role'
                   and (rr.employee_id is not null or rr.variant = case when v_wd then 'doctor' else 'standard' end) loop
    if coalesce(p_item -> 'performers' ->> v_role, '') <> '' then
      select * into v_emp from public.employees where id = p_item -> 'performers' ->> v_role;
      if not found then
        raise exception 'Baris %: petugas tidak ditemukan.', p_line_no;
      end if;
      if v_emp.status not in ('aktif', 'cuti') then
        raise exception 'Baris %: petugas % tidak aktif.', p_line_no, v_emp.full_name;
      end if;
      v_perf := v_perf || jsonb_build_object(v_role, v_emp.id);
      v_names := v_names || jsonb_build_object(v_role, v_emp.full_name);
    end if;
  end loop;

  -- bagian per kunjungan yang sudah dibayar oleh item lain di transaksi ini
  select coalesce(array_agg(distinct case when a.recipient_type = 'role' then 'role:' || a.target else 'emp:' || a.target end), '{}')
    into v_paid
    from public.service_transaction_allocations a
   where a.transaction_id = p_trx_id and a.kind = 'share' and a.per_visit and a.amount > 0;

  insert into public.service_transaction_items (transaction_id, line_no, service_id, service_code, service_name, category, unit_code, qty, unit_price, gross, performers, performer_names, with_doctor)
  values (p_trx_id, p_line_no, v_svc.id, v_svc.id, v_svc.name, v_svc.category, v_svc.unit_code, v_qty, v_price, v_qty * v_price, v_perf, v_names, v_wd)
  returning id into v_item;

  insert into public.service_transaction_allocations (transaction_id, item_id, kind, sort_order, recipient_type, target, recipient_employee_id, recipient_unit,
                                                      recipient_name, category, mode, rule_value, unit_amount, amount, is_implicit, per_visit)
  select p_trx_id, v_item, 'share', c.sort_order, c.recipient_type, c.target, c.recipient_employee_id, c.recipient_unit,
         c.recipient_name, c.category, c.mode, c.rule_value, c.unit_amount, c.amount, c.is_implicit, c.per_visit
    from public.compute_allocations(v_svc.id, v_price, v_qty, v_perf, false, v_wd, v_paid) c;

  select max(c.override_employee_id) into v_over from public.compute_allocations(v_svc.id, v_price, 1, v_perf, false, v_wd, v_paid) c;
  update public.service_transaction_items set override_employee_id = v_over where id = v_item;

  select coalesce(sum(amount), 0) into v_sum from public.service_transaction_allocations where item_id = v_item;
  if v_sum <> v_qty * v_price then
    raise exception 'Baris %: total pembagian (Rp%) tidak sama dengan pendapatan (Rp%).', p_line_no, v_sum, v_qty * v_price;
  end if;
  return v_qty * v_price;
end;
$$;

revoke execute on function public.compute_allocations(text, bigint, int, jsonb, boolean, boolean, text[]) from public, anon, authenticated;
revoke execute on function public._insert_rules(text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public._add_item(text, int, jsonb) from public, anon, authenticated;

-- >>> seed.sql
-- Data referensi Noura Payroll (dihasilkan oleh scripts/generate-seed.mjs — jangan diedit manual).
-- Aman dijalankan berulang (ON CONFLICT DO NOTHING). Tidak berisi data karyawan/transaksi.
begin;
insert into public.business_units (code, name, address, phone, email, leader_name, leader_title) values ('APT', 'Apotek Noura', '', '', '', '', 'Pemilik / Apoteker Penanggung Jawab') on conflict (code) do nothing;
insert into public.business_units (code, name, address, phone, email, leader_name, leader_title) values ('KLINIK', 'Praktek Dokter Umum Noura', '', '', '', '', 'Dokter Penanggung Jawab') on conflict (code) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Apoteker', 'APT', 'farmasi', false, 0) on conflict (name) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Tenaga Teknis Kefarmasian (TTK)', 'APT', 'farmasi', false, 1) on conflict (name) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Asisten Apoteker', 'APT', 'farmasi', false, 2) on conflict (name) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Kasir', 'APT', 'petugas', false, 3) on conflict (name) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Admin Apotek', 'APT', 'petugas', true, 4) on conflict (name) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Staf Operasional', 'APT', 'petugas', false, 5) on conflict (name) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Kurir', 'APT', 'petugas', false, 6) on conflict (name) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Karyawan Lainnya', 'APT', 'petugas', false, 7) on conflict (name) do nothing;
insert into public.departments (name, unit_code) values ('Farmasi', 'APT') on conflict on constraint departments_name_unit_key do nothing;
insert into public.departments (name, unit_code) values ('Kasir & Penjualan', 'APT') on conflict on constraint departments_name_unit_key do nothing;
insert into public.departments (name, unit_code) values ('Administrasi', 'APT') on conflict on constraint departments_name_unit_key do nothing;
insert into public.departments (name, unit_code) values ('Operasional', 'APT') on conflict on constraint departments_name_unit_key do nothing;
insert into public.departments (name, unit_code) values ('Pengiriman', 'APT') on conflict on constraint departments_name_unit_key do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Dokter Umum', 'KLINIK', 'dokter', false, 8) on conflict (name) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Bidan', 'KLINIK', 'bidan', false, 9) on conflict (name) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Perawat', 'KLINIK', 'perawat', false, 10) on conflict (name) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Admin Pendaftaran', 'KLINIK', 'petugas', true, 11) on conflict (name) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Petugas Administrasi', 'KLINIK', 'petugas', true, 12) on conflict (name) do nothing;
insert into public.positions (name, unit_code, role_key, is_admin_staff, sort_order) values ('Staf Pendukung', 'KLINIK', 'petugas', false, 13) on conflict (name) do nothing;
insert into public.departments (name, unit_code) values ('Pelayanan Medis', 'KLINIK') on conflict on constraint departments_name_unit_key do nothing;
insert into public.departments (name, unit_code) values ('Kebidanan', 'KLINIK') on conflict on constraint departments_name_unit_key do nothing;
insert into public.departments (name, unit_code) values ('Keperawatan', 'KLINIK') on conflict on constraint departments_name_unit_key do nothing;
insert into public.departments (name, unit_code) values ('Pendaftaran', 'KLINIK') on conflict on constraint departments_name_unit_key do nothing;
insert into public.departments (name, unit_code) values ('Administrasi', 'KLINIK') on conflict on constraint departments_name_unit_key do nothing;
insert into public.departments (name, unit_code) values ('Penunjang', 'KLINIK') on conflict on constraint departments_name_unit_key do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('BASE', 'Gaji Pokok', 'earning', 'base', 'system', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, true, true, true, 1) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('T_JABATAN', 'Tunjangan Jabatan', 'earning', 'allowance', 'fixed', 0, '{"Apoteker":1000000,"Tenaga Teknis Kefarmasian (TTK)":400000,"Dokter Umum":1500000,"Bidan":500000,"Perawat":400000,"Admin Apotek":250000,"Petugas Administrasi":250000}'::jsonb, array[]::text[], array[]::text[], true, true, true, false, 2) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('T_TRANSPORT', 'Tunjangan Transportasi', 'earning', 'allowance', 'per_day', 15000, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 3) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('T_MAKAN', 'Tunjangan Makan', 'earning', 'allowance', 'per_day', 15000, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 4) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('T_KOMUNIKASI', 'Tunjangan Komunikasi', 'earning', 'allowance', 'fixed', 100000, '{}'::jsonb, array[]::text[], array['Apoteker', 'Dokter Umum', 'Bidan', 'Admin Apotek', 'Admin Pendaftaran', 'Petugas Administrasi', 'Kurir']::text[], true, true, true, false, 5) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('T_KEHADIRAN', 'Tunjangan Kehadiran', 'earning', 'allowance', 'attendance', 150000, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 6) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('T_SHIFT', 'Tunjangan Shift', 'earning', 'allowance', 'per_shift', 20000, '{}'::jsonb, array['APT']::text[], array[]::text[], true, false, true, false, 7) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('LEMBUR', 'Uang Lembur', 'earning', 'overtime', 'per_hour', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 8) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('BONUS_SALES', 'Bonus Target Penjualan', 'earning', 'bonus', 'system', 0, '{}'::jsonb, array['APT']::text[], array[]::text[], true, false, true, true, 9) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('BONUS', 'Bonus', 'earning', 'bonus', 'manual', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 10) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('INSENTIF', 'Insentif', 'earning', 'incentive', 'manual', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 11) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('HONOR_PRAKTIK', 'Honor Praktik', 'earning', 'practice', 'system', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, true, 12) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('JASA', 'Jasa Pelayanan', 'earning', 'service', 'system', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, true, 13) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('KOMISI', 'Komisi', 'earning', 'incentive', 'manual', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 14) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('PENDAPATAN_LAIN', 'Pendapatan Lainnya', 'earning', 'other', 'manual', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 15) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('BPJS_KES', 'BPJS Kesehatan', 'deduction', 'bpjs', 'system', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, true, 20) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('BPJS_TK', 'BPJS Ketenagakerjaan (JHT + JP)', 'deduction', 'bpjs', 'system', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, true, 21) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('PPH21', 'PPh 21', 'deduction', 'tax', 'system', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, true, 22) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('POT_TELAT', 'Potongan Keterlambatan', 'deduction', 'late', 'per_occurrence', 25000, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 23) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('POT_ABSEN', 'Potongan Ketidakhadiran', 'deduction', 'absent', 'per_absent_day', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 24) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('KASBON', 'Potongan Kasbon', 'deduction', 'kasbon', 'manual', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 25) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('PINJAMAN', 'Potongan Pinjaman', 'deduction', 'loan', 'manual', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 26) on conflict (code) do nothing;
insert into public.salary_components (code, name, type, grp, calc, value, position_values, units, positions, active, is_fixed, taxable, is_system, sort_order) values ('POT_LAIN', 'Potongan Lainnya', 'deduction', 'other', 'manual', 0, '{}'::jsonb, array[]::text[], array[]::text[], true, false, true, false, 27) on conflict (code) do nothing;
insert into public.app_settings (key, value) values ('company', '{"name":"Apotek Noura & Praktek Dokter Umum","logo":null}'::jsonb) on conflict (key) do nothing;
insert into public.app_settings (key, value) values ('payroll', '{"workDays":26,"payDay":1,"overtimeDivisor":173,"overtimeMultiplier":1.5,"includeEmployeeStatuses":["aktif","cuti"]}'::jsonb) on conflict (key) do nothing;
insert into public.app_settings (key, value) values ('tax', '{"method":"progressive","flatRate":5,"biayaJabatanRate":5,"biayaJabatanMax":500000,"includeEmployerBpjs":true,"ptkp":{"TK/0":54000000,"TK/1":58500000,"TK/2":63000000,"TK/3":67500000,"K/0":58500000,"K/1":63000000,"K/2":67500000,"K/3":72000000},"brackets":[{"upTo":60000000,"rate":5},{"upTo":250000000,"rate":15},{"upTo":500000000,"rate":25},{"upTo":5000000000,"rate":30},{"upTo":null,"rate":35}]}'::jsonb) on conflict (key) do nothing;
insert into public.app_settings (key, value) values ('bpjs', '{"wageBase":"base_fixed","kes":{"employee":1,"employer":4,"cap":12000000},"jht":{"employee":2,"employer":3.7},"jp":{"employee":1,"employer":2,"cap":10547400},"jkk":{"employer":0.24},"jkm":{"employer":0.3}}'::jsonb) on conflict (key) do nothing;
insert into public.app_settings (key, value) values ('salesBonus', '{"method":"tiered","minAchievement":100,"fixedAmount":300000,"percent":1,"tiers":[{"min":100,"amount":300000},{"min":110,"amount":500000},{"min":125,"amount":750000}]}'::jsonb) on conflict (key) do nothing;
insert into public.app_settings (key, value) values ('slip', '{"showServiceDetail":true,"showEmployerContrib":false,"showTerbilang":true,"showBank":true,"footerNote":"Slip gaji ini diterbitkan oleh sistem dan bersifat rahasia.","issuerName":"Administrator","stampEnabled":true,"stampLabel":"DISAHKAN","stampColor":"#006b2a"}'::jsonb) on conflict (key) do nothing;
insert into public.app_settings (key, value) values ('numbering', '{"employee":"KRY","service":"TND","transaction":"TRX","payroll":"PAY","slip":"SLIP"}'::jsonb) on conflict (key) do nothing;
insert into public.app_settings (key, value) values ('backup', '{"reminderDays":7,"lastBackup":null}'::jsonb) on conflict (key) do nothing;
insert into public.app_settings (key, value) values ('security', '{"autoLockMinutes":30}'::jsonb) on conflict (key) do nothing;
commit;
