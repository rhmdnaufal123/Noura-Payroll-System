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
