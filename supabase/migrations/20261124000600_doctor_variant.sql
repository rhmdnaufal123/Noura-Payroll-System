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
