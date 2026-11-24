# Integrasi Supabase & GitHub — Panduan Pemasangan

Dokumen ini menjelaskan cara menjalankan Noura Payroll Management dengan **Supabase (PostgreSQL)** sebagai database utama dan **GitHub** sebagai penyimpanan source code, CI, backup terjadwal, dan (opsional) hosting.

> Setelah Supabase dikonfigurasi, aplikasi **wajib** memakai database pusat. Tidak ada cadangan ke IndexedDB/LocalStorage — bila server tidak dapat dihubungi, aplikasi menampilkan pesan kesalahan, bukan diam-diam menyimpan secara lokal. LocalStorage hanya dipakai untuk preferensi tampilan (tema, tampilan tabel) dan sesi login Supabase.

## Arsitektur

```
Browser (HTML/CSS/JS, PWA)
  ├─ supabase-js  ── Supabase Auth (login email + kata sandi)
  ├─ GET  /rest/v1/<tabel>        → baca data (dibatasi RLS per role)
  ├─ POST /rest/v1/rpc/<fungsi>   → semua perubahan data keuangan (validasi + transaksi atomik)
  └─ POST /functions/v1/admin-users → kelola akun (service role hanya di server)
Supabase PostgreSQL: tabel relasional + constraint + RLS + fungsi PL/pgSQL + audit log
GitHub: source code, CI (uji otomatis), backup terenkripsi terjadwal, deploy GitHub Pages
```

| Kebutuhan | Implementasi |
|---|---|
| Data karyawan, tindakan, transaksi, pembagian pendapatan, penggajian & slip di Supabase | `supabase/migrations/*.sql` |
| Semua perangkat memakai database yang sama | `js/supabase-driver.js` (tanpa penyimpanan lokal) + realtime |
| Login Supabase Auth | `NP.sec` memakai `signInWithPassword`; profil & role di `public.users` |
| RLS setiap tabel | `20261124000400_rls.sql` (RLS aktif di 20 tabel, `anon` tanpa akses) |
| Role administrator, keuangan, operasional, viewer | `users.role` ∈ `admin`, `finance`, `ops`, `viewer` |
| Transaksi database anti duplikasi | fungsi RPC `create_service_transaction`, `payroll_save_draft`, dll. + constraint `EXCLUDE` |
| Audit log perubahan keuangan | `audit_logs` (trigger + fungsi), hanya-tambah, hanya admin yang membaca |
| Tanpa secret/service role di frontend | Hanya anon key; `scripts/build-env.mjs` menolak service role/secret key |
| Backup berkala | Backup harian Supabase + `.github/workflows/db-backup.yml` (dump terenkripsi) |
| Migrasi SQL | `supabase/migrations/` + `supabase/seed.sql` |
| Input bulanan / impor POS tanpa duplikasi | `create_service_transactions_bulk` (satu transaksi database) + `service_transactions.external_ref` unik (nomor struk POS) |
| Konfigurasi non-sensitif di file environment | `.env` → `js/env.js` |
| GitHub bukan database transaksi | GitHub hanya menyimpan kode & backup terenkripsi |

## Struktur database

| Tabel | Isi | Relasi utama |
|---|---|---|
| `business_units` | Apotek Noura (`APT`), Praktek Dokter Umum (`KLINIK`) | — |
| `departments` | Departemen per unit | → `business_units` |
| `positions` | Jabatan + peran pelaksana (dokter/bidan/perawat/farmasi/petugas) | → `business_units` |
| `users` | Profil aplikasi, role, status aktif | 1:1 `auth.users` |
| `employees` | Data karyawan, skema gaji, unit/lintas unit | → `positions`, `departments`, `business_units` |
| `employee_bank_accounts` | Rekening (hanya admin & keuangan) | 1:1 `employees` |
| `salary_components` | Komponen pendapatan & potongan | — |
| `service_master` | Master tindakan & harga | → `business_units` |
| `service_revenue_rules` | Aturan pembagian (nominal/persen/sisa, khusus petugas) | → `service_master`, `employees` |
| `service_transactions` | Header transaksi tindakan | — |
| `service_transaction_items` | Baris tindakan (snapshot harga & petugas) | → `service_transactions`, `service_master` |
| `service_transaction_allocations` | Hasil pembagian per penerima + koreksi (adjustment) + status penggajian | → items, `employees`, `payroll_periods`, `payroll_records` |
| `payroll_periods` | Periode/run penggajian (draft → disetujui → terkunci) | — |
| `payroll_records` | Slip per karyawan per periode (EXCLUDE: tidak boleh beririsan) | → `payroll_periods`, `employees` |
| `payroll_details` | Rincian pendapatan & potongan slip | → `payroll_records` |
| `payslips` | Slip terbit (nomor slip unik) | → `payroll_records` |
| `worklogs` | Catatan shift & sesi praktik | → `employees` |
| `audit_logs` | Jejak audit | — |
| `app_settings`, `doc_counters` | Pengaturan non-sensitif & nomor urut atomik | — |

Semua uang disimpan sebagai `BIGINT` rupiah. Constraint penting: total pembagian = pendapatan item (diverifikasi fungsi), `gross = qty × harga`, `net = gross − potongan`, nomor dokumen unik, satu karyawan satu slip per rentang tanggal (`EXCLUDE USING gist`).

### Integritas penggajian

1. Server menghitung pembagian pendapatan (`compute_allocations`, padanan persis `js/revenue-sharing.js` — diuji pada 300 konfigurasi acak).
2. Slip dihitung aplikasi (`js/calculator.js`), lalu `payroll_save_draft` **dalam satu transaksi**:
   - mengklaim alokasi jasa hanya bila belum dipakai periode lain (`payroll_period_id is null`);
   - menolak bila nilai "Jasa Pelayanan" di slip ≠ jumlah alokasi yang diklaim, atau total slip tidak konsisten;
   - menolak bila masih ada jasa karyawan pada periode itu yang belum ikut dihitung;
   - constraint `EXCLUDE` menolak penggajian ganda, termasuk dua penyimpanan bersamaan.
3. Periode terkunci: koreksi/pembatalan transaksi hanya oleh administrator (diverifikasi ulang dengan email + sandi) dengan catatan; selisihnya menjadi adjustment untuk penggajian berikutnya.

## Langkah pemasangan

### 1. Buat proyek Supabase
Buat proyek di <https://supabase.com>. Catat **Project URL**, **publishable key** (`sb_publishable_…`), **project ref**, dan **password database**. **Secret key** (`sb_secret_…`) tidak dipakai aplikasi web dan tidak boleh disalin ke file aplikasi.

Di **Authentication › Sign In / Providers**: matikan *Allow new users to sign up* (akun dibuat administrator).

### 2. Jalankan migrasi & seed
Pilih salah satu:

- **Supabase CLI** (disarankan):
  ```bash
  supabase link --project-ref <PROJECT_REF>
  supabase db push --include-seed
  supabase functions deploy admin-users
  ```
- **GitHub Actions**: isi secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` dan variable `SUPABASE_PROJECT_REF`, lalu jalankan workflow **Migrasi Supabase**.
- **SQL Editor (paling mudah)**: buka Supabase Dashboard › SQL Editor › New query, tempel **seluruh isi `supabase/setup.sql`** (gabungan semua migrasi + seed), lalu klik **Run**. Untuk database baru saja.
  Edge Function `admin-users` dapat dibuat lewat Dashboard › Edge Functions (salin `supabase/functions/admin-users/index.ts`, matikan *Verify JWT*) atau `supabase functions deploy admin-users --no-verify-jwt`.

### 3. Buat administrator pertama
Di **Authentication › Users › Add user** buat akun (centang *Auto Confirm*). **Pengguna pertama otomatis menjadi Administrator aktif.** Pengguna berikutnya dibuat dari aplikasi (Pengaturan › Pengguna & Akses, memakai Edge Function `admin-users`) atau dari Dashboard lalu diaktifkan administrator.

### 4. Konfigurasi aplikasi
```bash
cp .env.example .env        # isi SUPABASE_URL dan SUPABASE_PUBLISHABLE_KEY
node scripts/build-env.mjs  # menulis js/env.js
```
`js/env.js` hanya berisi URL dan **publishable key** — keduanya memang publik; keamanan data dijamin RLS. Skrip menolak secret/service role key dan mengabaikan `SUPABASE_SECRET_KEY` bila ada di `.env`.

> Tentang `@supabase/server`: paket itu untuk backend Node/Deno. Aplikasi ini tidak memiliki server Node — backend-nya adalah fungsi PostgreSQL (RPC) dan satu Edge Function yang sudah memverifikasi pemanggil dengan `auth.getUser()`, sehingga paket tersebut tidak diperlukan.

### 5. Hosting
- **GitHub Pages**: aktifkan Pages (Source: GitHub Actions). `js/env.js` di repository sudah berisi konfigurasi proyek; repository variables `SUPABASE_URL` dan `SUPABASE_PUBLISHABLE_KEY` (opsional) akan menimpanya saat deploy. Aktifkan Pages (Source: GitHub Actions). Workflow **Deploy GitHub Pages** membangun `js/env.js` dan mempublikasikan situs saat ada push ke `main`.
- Atau hosting statis lain (Netlify, Vercel, server sendiri) — jalankan `node scripts/build-env.mjs` saat build.

Tambahkan URL situs ke **Authentication › URL Configuration** (Site URL / Redirect URLs).

### 6. Backup
- Supabase menyimpan backup harian (paket berbayar menyediakan Point-in-Time Recovery).
- Workflow **Backup database** (harian 02:17 WIB) membuat `pg_dump` data, **mengenkripsinya dengan AES-256**, dan menyimpannya sebagai artifact GitHub 30 hari. Isi secrets `SUPABASE_DB_URL` dan `BACKUP_PASSPHRASE`. Simpan passphrase di tempat aman terpisah.
- Pemulihan: buat proyek baru → jalankan migrasi → `gpg -d noura-backup-….tar.gz.gpg | tar xz` → `pg_restore --data-only --disable-triggers -d "$DB_URL" backup/public-….dump` (dan `auth-….dump` bila perlu).
- Admin juga dapat mengunduh ekspor JSON dari Pengaturan › Backup & Restore.

## Keamanan
- **Jangan** menaruh service role key / secret key di frontend, `js/env.js`, atau repository. Service role hanya dipakai Edge Function (variabel bawaan Supabase).
- Role pengguna hanya dapat diubah administrator (`admin_update_user`); metadata pendaftaran tidak pernah dipakai untuk menentukan role.
- Tabel keuangan tidak memiliki kebijakan tulis langsung — perubahan hanya lewat fungsi yang memeriksa role.
- Nomor rekening dipisah ke `employee_bank_accounts` (RLS admin & keuangan) dan tidak disalin ke audit log.
- Audit log tidak dapat diubah atau dihapus oleh pengguna mana pun lewat API.

## Pengujian
```bash
npm install
npm test                    # uji unit
npm run test:db             # migrasi + RLS + RPC di PostgreSQL lokal (butuh psql & hak superuser)
npm run test:e2e            # browser, mode lokal
npm run test:e2e:supabase   # browser, mode Supabase (supabase-js asli + PostgreSQL berisi migrasi)
```
`tests/db/supabase_shim.sql` meniru objek bawaan Supabase (`auth.users`, `auth.uid()`, role `anon/authenticated`) agar migrasi dapat diuji di PostgreSQL biasa. `tests/support/mock-supabase.js` meniru sebagian API REST/Auth Supabase untuk pengujian saja.
