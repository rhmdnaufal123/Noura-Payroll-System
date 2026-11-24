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
