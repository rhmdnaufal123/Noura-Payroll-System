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
