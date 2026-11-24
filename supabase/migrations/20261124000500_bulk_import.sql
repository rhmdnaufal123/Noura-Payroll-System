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
