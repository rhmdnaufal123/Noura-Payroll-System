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
