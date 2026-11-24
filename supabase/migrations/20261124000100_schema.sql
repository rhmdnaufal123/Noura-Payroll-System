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
