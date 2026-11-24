# NOURA PAYROLL MANAGEMENT SYSTEM

Aplikasi web untuk **penggajian otomatis, pembagian jasa pelayanan (revenue sharing), dan administrasi karyawan** Apotek Noura dan Praktek Dokter Umum.

Semua fitur berjalan sungguhan di browser: data disimpan di **IndexedDB**, perhitungan uang memakai bilangan bulat rupiah, dan setiap perubahan penting tercatat di audit log.

> **Dua mode penyimpanan.**
> - **Mode Supabase (produksi, multi-perangkat):** bila `js/env.js` berisi `SUPABASE_URL` dan publishable key, seluruh data disimpan di PostgreSQL Supabase dengan login Supabase Auth, Row Level Security, dan fungsi server atomik. Tidak ada cadangan ke penyimpanan lokal. **Panduan lengkap: [docs/SUPABASE.md](docs/SUPABASE.md).**
> - **Mode lokal (demo/satu perangkat):** bila `js/env.js` kosong, data disimpan di IndexedDB browser dengan data demonstrasi. Cocok untuk mencoba aplikasi.

---

## Menjalankan aplikasi

**Cara paling mudah (tanpa instalasi):** buka `index.html` langsung di Chrome, Edge, atau Firefox.

**Agar bisa diinstal sebagai aplikasi (PWA) dan dibuka offline,** jalankan dari server lokal:

```bash
cd Noura-Payroll-System
python3 -m http.server 8080
# buka http://localhost:8080
```

Lalu pilih *Install app* / *Tambahkan ke Layar Utama* di browser (desktop, Android, iPhone/iPad). Semua pustaka disertakan di folder `vendor/`, jadi aplikasi tetap berjalan tanpa internet.

### Versi online (artifact claude.ai)

`artifact.html` adalah halaman yang sama untuk dipublikasikan sebagai artifact claude.ai (memakai `NP_ENV.artifact`). Penyesuaiannya: navigasi disimpan di memori (sandbox hanya mengizinkan hash sederhana), unduhan Excel/PDF/PNG/ZIP/backup memakai kapabilitas `downloads` (pengguna mengonfirmasi tiap unduhan), tombol cetak disembunyikan (unduh PDF lalu cetak), dan bila browser memblokir penyimpanan, aplikasi berjalan dengan database sementara disertai peringatan. Data versi online tetap tersimpan di browser masing-masing pengguna.

### Akun awal

| Nama pengguna | Kata sandi | Hak akses |
|---|---|---|
| `admin` | `admin123` | Administrator — **segera ganti kata sandi** (muncul pengingat) |
| `keuangan` | `keuangan123` | Admin Keuangan (demo) |
| `operasional` | `operasional123` | Admin Operasional (demo) |
| `viewer` | `viewer123` | Viewer (demo) |

Akun demo ikut terhapus saat data demonstrasi dihapus.

### Data demonstrasi

Saat pertama kali dibuka, aplikasi mengisi data contoh yang realistis: 15 karyawan (termasuk 1 karyawan lintas unit), 22 tindakan, ±4 bulan transaksi, catatan shift/sesi, serta penggajian 3 bulan terakhir (2 terkunci, 1 disetujui). Hapus kapan saja lewat **Pengaturan › Data Demo › Hapus seluruh data demonstrasi** (memerlukan otorisasi administrator).

---

## Fitur utama

| Menu | Isi |
|---|---|
| **Dashboard** | Statistik karyawan, penggajian, dan pendapatan pelayanan; grafik pendapatan bulanan, pengeluaran gaji, pembagian antarunit, tindakan terbanyak; aktivitas terbaru; status periode gaji aktif. Filter tanggal/bulan/tahun & unit. |
| **Data Karyawan** | Tambah/edit/hapus, cari, filter, tampilan tabel/kartu, foto, data nakes (STR/SIP — tidak tampil di slip), karyawan lintas unit dengan persentase beban, impor/ekspor Excel (dengan template & pratinjau validasi). |
| **Master Tindakan** | Tambah tindakan tanpa mengubah kode; harga, kategori, unit, pembagian **nominal / persentase / kombinasi / sisa harga**, banyak penerima (unit usaha, petugas pelaksana, karyawan tertentu, penerima lain), pembagian khusus per petugas, preview & validasi, aktif/nonaktif, duplikat. |
| **Input Tindakan** | Satu atau beberapa tindakan per transaksi; harga & pembagian terisi otomatis; pilih petugas per peran; preview pembagian real-time; simpan & cetak bukti transaksi internal. |
| **Input Bulanan** | Input tindakan sekaligus satu bulan: tabel tindakan × tanggal (1 tanggal = 1 transaksi, pelaksana per tindakan, isian tersimpan sementara di perangkat, kolom "sudah tercatat" agar tidak dobel) dan **impor file penjualan POS** (sheet *Penjualan*): hanya kategori tindakan (mis. DOKTER DAN BIDAN, HOMECARE) yang diambil, tindakan baru dapat langsung ditambahkan ke master, kolom Dokter dicocokkan dengan karyawan, pratinjau memvalidasi harga & pembagian, struk yang sudah diimpor dilewati. Semua tersimpan dalam satu transaksi database. |
| **Riwayat Transaksi** | Cari & filter (tanggal, petugas, tindakan, unit, status, status gaji), detail + audit trail, edit, batal (wajib alasan), ekspor Excel & PDF. |
| **Analisis Tindakan** | Jumlah & pendapatan tindakan per kelompok **Dokter Umum & Bidan**, **Homecare**, Farmasi & Lainnya; per nama tindakan, kategori, pelaksana (beserta jasa diterima), dan pasien; tren harian/bulanan, perbandingan dengan periode sebelumnya, pencarian nama, ekspor Excel. |
| **Pembagian Pendapatan** | Dashboard pendapatan tindakan: kotor, bagian apotek, jasa dokter/bidan/perawat, tindakan harian/bulanan, tindakan terbanyak, pendapatan per petugas, rincian per tindakan. |
| **Rekap Jasa Karyawan** | Rekap otomatis per karyawan (mis. "Gula darah: 30 transaksi × Rp10.000 = Rp300.000"), status belum diproses/dalam proses/terkunci, **rekonsiliasi**, serta catatan & laporan jumlah shift/sesi/pelayanan. |
| **Penggajian** | Komponen pendapatan & potongan (tambah/edit/hapus/aktif-nonaktif, nominal tetap / % / per hari / per shift / per jam / per kejadian / manual, per jabatan & per unit), skema per karyawan, bonus penjualan apotek, pajak & BPJS. |
| **Generate Payroll** | Wizard 4 langkah: periode & karyawan → data variabel & rekonsiliasi → preview & rekapitulasi → konfirmasi (simpan draft / setujui & terbitkan slip). |
| **Slip Gaji** | Template A4 formal dengan kop unit (logo, alamat), rincian pendapatan/potongan, take home pay + terbilang, tanda tangan; unduh PDF/PNG/HTML, cetak, cetak massal, ZIP seluruh slip. |
| **Laporan Keuangan** | Bulanan/tahunan/rentang: A. Apotek Noura, B. Praktek Dokter Umum, C. per karyawan; tren per bulan; ekspor Excel & PDF. Memisahkan **pendapatan kotor**, **bagian usaha**, dan **hak jasa karyawan**. |
| **Riwayat Penggajian** | Kelola run: hitung ulang, setujui, kunci, buka kunci (otorisasi), kembalikan ke draft, hapus draft, rekap Excel/PDF. |
| **Pengaturan** | Identitas & logo per unit, periode gaji, pajak & BPJS, template slip, penomoran dokumen, pengguna & hak akses, backup/restore + pengingat, data demo, audit log, keamanan (kunci otomatis). |

### Skema gaji yang didukung

- **Dokter:** gaji tetap, honor per sesi, honor per pasien, persentase jasa pelayanan, gaji tetap + jasa, kombinasi.
- **Bidan:** gaji tetap, honor per shift, per sesi, per tindakan, berdasarkan jumlah pelayanan (jasa), gaji tetap + insentif, gaji tetap + jasa, kombinasi.
- **Perawat:** gaji tetap, honor per shift, per tindakan, jasa pelayanan, gaji tetap + jasa, kombinasi.
- **Apotek:** gaji bulanan + tunjangan jabatan/shift/kehadiran/transport/makan, lembur, **bonus target penjualan** (bertingkat, nominal tetap, persentase penjualan, atau manual), insentif. Pendapatan tetap dan variabel dibedakan.

Jasa pelayanan dari transaksi **selalu** masuk ke slip penerimanya secara otomatis.

---

## Aturan integritas data

1. **Snapshot transaksi** — setiap transaksi menyimpan harga dan pembagian saat transaksi dibuat; perubahan tarif di master tidak mengubah transaksi lama.
2. **Status penggajian per bagian jasa** — setiap bagian milik karyawan bertanda *belum diproses / draft / disetujui / terkunci* beserta nomor run-nya. Run lain tidak dapat memakai jasa yang sudah dipesan → **tidak ada penghitungan ganda**. Satu karyawan juga tidak dapat masuk dua run dengan periode beririsan.
3. **Transaksi batal tidak masuk penggajian.** Membatalkan atau mengubah transaksi yang ada di draft akan melepas pesanan jasa dan menandai draft "perlu dihitung ulang".
4. **Periode terkunci** — transaksi di periode gaji terkunci hanya bisa dikoreksi/dibatalkan dengan **otorisasi administrator + catatan**. Selisihnya dicatat sebagai *koreksi jasa (adjustment)* yang otomatis masuk ke penggajian berikutnya; slip terkunci tidak berubah.
5. **Rekonsiliasi** — menu Rekap Jasa › Rekonsiliasi memeriksa: pendapatan kotor = bagian usaha + jasa karyawan + penerima lain; jasa = belum diproses + dalam proses + terkunci; transaksi batal; jasa periode lalu yang belum dibayar; penerima tidak aktif; koreksi tertunda; draft basi; penggajian ganda.
6. **Karyawan lintas unit** dihitung sekali dalam satu slip; biaya dialokasikan ke unit sesuai persentase beban (jasa dialokasikan ke unit asal tindakan).
7. Seluruh penyimpanan multi-tabel memakai **transaksi IndexedDB atomik** (semua berhasil atau semua dibatalkan); nomor dokumen dibuat dari penghitung atomik sehingga unik.

### Pajak & BPJS

Nilai bawaan (dapat diubah di Pengaturan › Pajak & BPJS):

- **PPh 21** metode progresif disetahunkan (bruto − biaya jabatan 5% maks Rp500.000/bulan − iuran JHT/JP karyawan, ×12 − PTKP, tarif Pasal 17: 5/15/25/30/35%), atau tarif tetap, atau tidak dipotong. Status PTKP diatur per karyawan.
- **BPJS Kesehatan** 1% karyawan / 4% pemberi kerja (batas upah Rp12 juta); **JHT** 2%/3,7%; **JP** 1%/2% (batas upah dapat diatur); **JKK** 0,24%; **JKM** 0,3%.

Peraturan perpajakan dan BPJS dapat berubah (termasuk skema TER PPh 21 bulanan). Sesuaikan tarif di pengaturan dan konsultasikan dengan konsultan pajak; aplikasi tidak menggantikan nasihat profesional.

### Hak akses

| Peran | Akses |
|---|---|
| Administrator | Seluruh fitur, termasuk pengaturan, pengguna, backup/restore, kunci/buka kunci, otorisasi koreksi. |
| Admin Keuangan | Karyawan, transaksi (termasuk batal), rekap jasa, penggajian (buat/setujui), slip, laporan. |
| Admin Operasional | Input transaksi, lihat riwayat, ubah transaksi miliknya yang belum terkunci, lihat master tindakan. |
| Viewer | Dashboard, pembagian pendapatan, dan laporan. |

Kata sandi disimpan sebagai hash SHA-256 bergaram; nomor rekening hanya terlihat oleh Administrator & Admin Keuangan dan selalu tersamar di slip; sesi terkunci otomatis setelah tidak aktif (default 30 menit).

---

## Struktur proyek

```
├── index.html               # kerangka aplikasi
├── manifest.json            # PWA
├── service-worker.js        # cache offline aset aplikasi
├── css/                     # style, dashboard, employee, transaction, payroll, report, print
├── js/
│   ├── utils.js             # format rupiah, tanggal, terbilang (murni)
│   ├── constants.js         # unit, jabatan, peran, kategori, skema gaji
│   ├── defaults.js          # pengaturan & komponen gaji bawaan
│   ├── database.js          # lapisan data (driver IndexedDB, transaksi atomik)
│   ├── security.js          # login, hak akses, hash, otorisasi, audit log
│   ├── ui.js                # modal, tabel, toast, input rupiah, grafik
│   ├── revenue-sharing.js   # mesin pembagian pendapatan (murni)
│   ├── calculator.js        # mesin perhitungan gaji (murni)
│   ├── employee.js          # data karyawan
│   ├── service-master.js    # master tindakan & editor pembagian
│   ├── transaction.js       # input tindakan, riwayat, koreksi, pembatalan
│   ├── service-income.js    # rekap jasa, rekonsiliasi, shift & sesi
│   ├── payroll.js           # komponen, generate payroll, riwayat penggajian
│   ├── payslip.js           # template & ekspor slip gaji
│   ├── reports.js           # laporan keuangan
│   ├── dashboard.js         # dashboard utama & pembagian pendapatan
│   ├── export.js            # Excel, PDF, cetak, unduh
│   ├── settings.js          # pengaturan, backup/restore
│   ├── demo-data.js         # data demonstrasi
│   └── app.js               # inisialisasi, navigasi, sesi
├── vendor/                  # Chart.js, SheetJS, jsPDF + AutoTable, html2canvas, JSZip
├── assets/                  # logo & ikon PWA
└── tests/                   # uji unit & end-to-end
```

## Pengujian

```bash
npm install
npm test                    # 28 uji unit: format uang, revenue sharing, perhitungan gaji
npm run test:db             # 31 uji database: migrasi, RLS per role, RPC, anti duplikasi, audit
npm run test:e2e            # 40 uji browser mode lokal
npm run test:e2e:supabase   # 18 uji browser mode Supabase (2 perangkat, database yang sama)
```
GitHub Actions (`.github/workflows/ci.yml`) menjalankan seluruh uji pada setiap push.

Uji end-to-end menjalankan server lokal sendiri dan menguji: login & hak akses, CRUD karyawan, impor/ekspor Excel, tambah tindakan kombinasi 3 penerima, validasi pembagian, snapshot harga historis, input tindakan (contoh Gula Darah ×5 = Rp140.000 → Apotek Rp90.000 + Bidan Rp50.000), multi-tindakan, edit & batal transaksi, generate payroll lewat wizard, anti penghitungan ganda, rekonsiliasi, setujui/kunci, koreksi terkunci dengan otorisasi & adjustment, buka kunci, slip PDF/PNG/HTML, ZIP, laporan, backup/restore, serta tampilan iPhone/Android/iPad/laptop tanpa scroll horizontal.

## Arsitektur

Semua modul mengakses data melalui `NP.db`:

- `js/database.js` — driver IndexedDB (mode lokal) dan driver memori cadangan untuk versi artifact.
- `js/supabase-driver.js` — driver Supabase: membaca tabel relasional dan merakitnya menjadi dokumen yang dipakai halaman; semua perubahan data keuangan lewat fungsi RPC PostgreSQL (`supabase/migrations`).

Logika inti dipakai bersama: `js/revenue-sharing.js` (padanannya di server: `compute_allocations`) dan `js/calculator.js` (hasilnya diverifikasi server saat menyimpan penggajian). Detail skema, RLS, role, migrasi, backup, dan deploy ada di [docs/SUPABASE.md](docs/SUPABASE.md).

## Lisensi pustaka pihak ketiga

Chart.js (MIT), SheetJS Community Edition (Apache-2.0), jsPDF (MIT), jsPDF-AutoTable (MIT), html2canvas (MIT), JSZip (MIT/GPLv3).
