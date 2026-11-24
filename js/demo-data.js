/* Noura Payroll — data demonstrasi awal yang realistis (dapat dihapus dari Pengaturan › Data Demo).
 * Seluruh data demo dibuat melalui mesin yang sama dengan data asli (revenue sharing & payroll). */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;

  const EMPLOYEES = [
    ['apt. Nadia Putri, S.Farm.', 'Perempuan', 'APT', 'Apoteker', 'Farmasi', '2021-03-01', 5500000, 'monthly_service', {}, 'BCA', '1234567890', { ptkp: 'K/1', str: '19920315/STRA-UGM/2016/221', sip: '503/SIPA/045/2021', healthStatus: 'Tetap', schedule: 'Senin–Sabtu 08.00–16.00' }],
    ['Rina Marlina, A.Md.Farm.', 'Perempuan', 'APT', 'Tenaga Teknis Kefarmasian (TTK)', 'Farmasi', '2022-01-10', 3500000, 'monthly', {}, 'BRI', '0021019283746', { salesTarget: 60000000, ptkp: 'TK/0', str: 'STRTTK-2021-0081', sip: 'SIPTTK/2022/014' }],
    ['Dimas Pratama', 'Laki-laki', 'APT', 'Asisten Apoteker', 'Farmasi', '2023-02-01', 2800000, 'monthly', {}, 'Mandiri', '1320098765432', { salesTarget: 50000000 }],
    ['Siti Aisyah', 'Perempuan', 'APT', 'Kasir', 'Kasir & Penjualan', '2022-06-15', 2600000, 'monthly', {}, 'BCA', '5430987612', { salesTarget: 80000000 }],
    ['Fajar Nugroho', 'Laki-laki', 'APT', 'Admin Apotek', 'Administrasi', '2021-09-01', 2900000, 'monthly', {}, 'BNI', '0987654321', {}],
    ['Agus Salim', 'Laki-laki', 'APT', 'Staf Operasional', 'Operasional', '2023-08-01', 2400000, 'monthly', {}, 'BRI', '0021077712345', { componentOverrides: { PINJAMAN: { value: 200000 } } }],
    ['Bayu Saputra', 'Laki-laki', 'APT', 'Kurir', 'Pengiriman', '2024-01-08', 2200000, 'monthly', {}, '', '', { payMethod: 'Tunai', bpjsTk: true }],
    ['dr. Ahmad Fauzi', 'Laki-laki', 'KLINIK', 'Dokter Umum', 'Pelayanan Medis', '2020-07-01', 4000000, 'combination', { sessionRate: 150000, patientRate: 0, shiftRate: 0, actionRate: 0 }, 'BCA', '7650012345', { ptkp: 'K/2', str: 'STR-DU-3172-2019-001', sip: 'SIP/DU/2020/112', healthStatus: 'Tetap', schedule: 'Senin–Sabtu 16.00–21.00' }],
    ['dr. Siti Rahmawati', 'Perempuan', 'KLINIK', 'Dokter Umum', 'Pelayanan Medis', '2024-03-01', 0, 'per_session', { sessionRate: 200000 }, 'Mandiri', '1330077788899', { ptkp: 'TK/0', str: 'STR-DU-3273-2022-044', sip: 'SIP/DU/2024/031', healthStatus: 'Mitra / Visiting', schedule: 'Selasa, Kamis, Sabtu 08.00–12.00', bpjsKes: false, bpjsTk: false }],
    ['Bd. Nur Aini, A.Md.Keb.', 'Perempuan', 'KLINIK', 'Bidan', 'Kebidanan', '2021-05-03', 2800000, 'monthly_service', {}, 'BSI', '7112233445', { str: 'STR-BD-2020-1188', sip: 'SIPB/2021/077', healthStatus: 'Tetap', schedule: 'Senin–Sabtu 07.30–15.30' }],
    ['Bd. Dewi Lestari, A.Md.Keb.', 'Perempuan', 'KLINIK', 'Bidan', 'Kebidanan', '2023-04-17', 2000000, 'combination', { shiftRate: 50000, sessionRate: 0, patientRate: 0, actionRate: 0 }, 'BRI', '0021055566677', { str: 'STR-BD-2022-0456', sip: 'SIPB/2023/019', healthStatus: 'Kontrak', schedule: 'Shift sore 14.00–21.00' }],
    ['Ns. Rudi Hartono, S.Kep.', 'Laki-laki', 'KLINIK', 'Perawat', 'Keperawatan', '2022-02-01', 2700000, 'monthly_service', {}, 'BNI', '0456789123', { str: 'STR-NS-2019-7781', sip: 'SIPP/2022/055', healthStatus: 'Tetap', schedule: 'Senin–Sabtu 14.00–21.00' }],
    ['Lia Kartika', 'Perempuan', 'KLINIK', 'Admin Pendaftaran', 'Pendaftaran', '2023-06-01', 2500000, 'monthly', {}, 'BCA', '2345678901', {}],
    ['Hendra Wijaya', 'Laki-laki', 'KLINIK', 'Staf Pendukung', 'Penunjang', '2024-05-02', 2100000, 'monthly', {}, '', '', { payMethod: 'Tunai' }],
    ['Yuni Astuti, S.E.', 'Perempuan', 'LINTAS', 'Petugas Administrasi', 'Administrasi', '2020-11-02', 3400000, 'monthly', {}, 'Mandiri', '1310055544433', { costSplit: { APT: 60 }, primaryUnit: 'APT', ptkp: 'K/0' }]
  ];

  // [nama, kategori, unit, harga, shares, catatan]
  const R = (target, mode, value) => ({ type: 'role', target, mode, value });
  const U = (target, mode, value) => ({ type: 'unit', target, mode, value });
  const O = (target, mode, value) => ({ type: 'other', target, mode, value });
  const SERVICES = [
    ['Pemeriksaan Gula Darah', 'Pemeriksaan laboratorium sederhana', 'APT', 28000, [U('APT', 'nominal', 18000), R('bidan', 'nominal', 10000)], 'GDS dengan glukometer'],
    ['Pemeriksaan Asam Urat', 'Pemeriksaan laboratorium sederhana', 'APT', 30000, [U('APT', 'nominal', 20000), R('bidan', 'nominal', 10000)], ''],
    ['Pemeriksaan Kolesterol', 'Pemeriksaan laboratorium sederhana', 'APT', 50000, [U('APT', 'nominal', 40000), R('bidan', 'nominal', 10000)], ''],
    ['Paket Cek Gula, Asam Urat & Kolesterol', 'Pemeriksaan laboratorium sederhana', 'APT', 95000, [U('APT', 'nominal', 70000), R('bidan', 'nominal', 25000)], 'Paket hemat 3 parameter'],
    ['Pemeriksaan Tekanan Darah', 'Pemeriksaan kesehatan', 'APT', 10000, [U('APT', 'nominal', 5000), R('bidan', 'nominal', 5000)], ''],
    ['Pemeriksaan Kehamilan (ANC)', 'Tindakan kebidanan', 'KLINIK', 75000, [U('APT', 'percent', 50), R('bidan', 'percent', 50)], ''],
    ['Konsultasi Dokter Umum', 'Pemeriksaan dokter', 'KLINIK', 100000, [U('APT', 'percent', 60), R('dokter', 'percent', 40)], 'Termasuk pemeriksaan dasar'],
    ['Pemeriksaan Kesehatan Umum', 'Pemeriksaan dokter', 'KLINIK', 150000, [U('APT', 'percent', 60), R('dokter', 'percent', 40)], 'Medical check-up sederhana'],
    ['Pemeriksaan Fisik', 'Pemeriksaan dokter', 'KLINIK', 75000, [U('APT', 'percent', 60), R('dokter', 'percent', 40)], ''],
    ['Surat Keterangan Dokter', 'Pemeriksaan dokter', 'KLINIK', 50000, [U('APT', 'percent', 50), R('dokter', 'percent', 50)], 'Surat sehat / sakit'],
    ['Perawatan Luka Sederhana', 'Tindakan medis', 'KLINIK', 85000, [R('dokter', 'percent', 30), R('perawat', 'nominal', 15000), U('APT', 'remainder', 0)], ''],
    ['Hecting (Jahit Luka)', 'Tindakan medis', 'KLINIK', 150000, [R('dokter', 'percent', 40), R('perawat', 'percent', 15), U('APT', 'remainder', 0)], ''],
    ['Nebulizer', 'Tindakan keperawatan', 'KLINIK', 60000, [R('perawat', 'nominal', 15000), U('APT', 'remainder', 0)], ''],
    ['Injeksi / Suntik', 'Tindakan keperawatan', 'KLINIK', 25000, [R('perawat', 'nominal', 10000), U('APT', 'remainder', 0)], ''],
    ['Pemasangan Infus', 'Tindakan keperawatan', 'KLINIK', 120000, [R('perawat', 'percent', 25), U('APT', 'remainder', 0)], ''],
    ['Pelayanan KB Suntik', 'Tindakan kebidanan', 'KLINIK', 35000, [R('bidan', 'nominal', 15000), U('APT', 'remainder', 0)], ''],
    ['Pemasangan Implan KB', 'Tindakan kebidanan', 'KLINIK', 250000, [R('bidan', 'percent', 35), U('APT', 'remainder', 0)], ''],
    ['Pertolongan Persalinan Normal', 'Tindakan kebidanan', 'KLINIK', 1500000, [O('Pemasok BMHP Persalinan', 'nominal', 150000), R('bidan', 'percent', 30), R('perawat', 'percent', 10), U('KLINIK', 'remainder', 0)], 'Contoh pembagian kombinasi 4 penerima'],
    ['Swab Antigen', 'Pemeriksaan laboratorium sederhana', 'APT', 85000, [U('APT', 'nominal', 65000), R('perawat', 'nominal', 20000)], ''],
    ['Konseling Obat oleh Apoteker', 'Pelayanan farmasi', 'APT', 25000, [R('farmasi', 'nominal', 10000), U('APT', 'remainder', 0)], ''],
    ['Pengukuran Berat & Tinggi Badan', 'Pelayanan lainnya', 'APT', 5000, [U('APT', 'nominal', 5000)], 'Tanpa jasa petugas'],
    ['Sewa Alat Kursi Roda (harian)', 'Pelayanan lainnya', 'APT', 20000, [U('APT', 'percent', 100)], 'Contoh nonaktif', false]
  ];

  // bobot popularitas tindakan
  const WEIGHTS = [18, 10, 8, 4, 14, 3, 16, 3, 3, 4, 3, 1, 3, 4, 1, 4, 0.6, 0.15, 2, 3, 3, 0];
  const PATIENTS = ['Budi Santoso', 'Sri Wahyuni', 'Andi Firmansyah', 'Maya Sari', 'Joko Susilo', 'Ratna Dewi', 'Hasan Basri', 'Fitri Handayani', 'Eko Prasetyo', 'Indah Permata', 'Wawan Setiawan', 'Lestari Ningsih', 'Rizky Ramadhan', 'Nurhayati', 'Taufik Hidayat', 'Dian Puspita', 'Yusuf Maulana', 'Kartini', 'Bambang Irawan', 'Sulastri', 'Anisa Rahma', 'Gilang Saputra', 'Ayu Wandira', 'Herman Syah', '', '', ''];

  async function seed() {
    const rnd = u.seededRandom(20261124);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const now = Date.now();
    const s = NP.state.settings;

    // ---- Karyawan
    const emps = EMPLOYEES.map((e, i) => {
      const [name, gender, unit, position, department, startDate, baseSalary, payScheme, payConfig, bankName, bankAccount, extra] = e;
      return Object.assign(NP.emp.blank(), {
        id: NP.db.code(s.numbering.employee, i + 1), name, gender, unit, position, department, startDate, baseSalary, payScheme, payConfig,
        bankName, bankAccount, bankHolder: name.replace(/^(apt\.|dr\.|Bd\.|Ns\.)\s*/, '').replace(/,.*$/, ''), phone: '08' + (1200000000 + Math.floor(rnd() * 800000000)),
        email: u.slug(name.replace(/^(apt\.|dr\.|Bd\.|Ns\.)\s*/, '').replace(/,.*$/, '')).replace(/-/g, '.') + '@noura.local',
        address: pick(['Jl. Kenanga No. 3', 'Jl. Mawar Indah No. 21', 'Perum Griya Asri Blok C-7', 'Jl. Anggrek II No. 15', 'Komp. Pesona Blok A-2']) + ', Bandung',
        status: 'aktif', primaryUnit: unit === 'LINTAS' ? 'APT' : unit, costSplit: { APT: unit === 'APT' ? 100 : unit === 'KLINIK' ? 0 : 60 },
        createdAt: now, updatedAt: now, demo: true
      }, extra);
    });
    const empMap = new Map(emps.map((e) => [e.id, e]));
    const byPos = (p) => emps.filter((e) => e.position === p);

    // ---- Tindakan (override: dokter senior mendapat 50% konsultasi)
    const services = SERVICES.map((x, i) => ({
      id: NP.db.code(s.numbering.service, i + 1), code: NP.db.code(s.numbering.service, i + 1), name: x[0], category: x[1], unit: x[2], price: x[3], shares: x[4],
      method: NP.rs.methodOf(x[4]), overrides: [], active: x[6] !== false, notes: x[5], createdAt: now, updatedAt: now, demo: true
    }));
    services[6].overrides = [{ employeeId: emps[7].id, shares: [U('APT', 'percent', 50), R('dokter', 'percent', 50)] }];

    // ---- Transaksi 1 Agustus s.d. hari ini
    const today = u.todayISO();
    const startDate = u.addMonths(today.slice(0, 7), -3) + '-01';
    const staff = { dokter: byPos('Dokter Umum'), bidan: byPos('Bidan'), perawat: byPos('Perawat'), farmasi: emps.filter((e) => ['Apoteker', 'Tenaga Teknis Kefarmasian (TTK)'].includes(e.position)) };
    const totalW = WEIGHTS.reduce((a, b) => a + b, 0);
    const pickSvc = () => {
      let r = rnd() * totalW;
      for (let i = 0; i < WEIGHTS.length; i++) {
        r -= WEIGHTS[i];
        if (r <= 0) return services[i];
      }
      return services[0];
    };
    const trxs = [];
    const counters = new Map();
    const worklogs = [];
    for (let d = startDate; d <= today; d = u.addDays(d, 1)) {
      const dow = u.parseISO(d).getDay();
      const n = dow === 0 ? 2 + Math.floor(rnd() * 3) : 5 + Math.floor(rnd() * 7);
      for (let k = 0; k < n; k++) {
        const items = [];
        const nItems = rnd() < 0.22 ? 2 : 1;
        for (let j = 0; j < nItems; j++) {
          const svc = pickSvc();
          if (items.some((x) => x.serviceId === svc.id)) continue;
          const performers = {};
          for (const role of NP.rs.requiredRoles(svc)) {
            let pool = staff[role] || [];
            if (role === 'dokter' && [2, 4, 6].includes(dow) && rnd() < 0.5) pool = [staff.dokter[1]];
            else if (role === 'dokter') pool = [staff.dokter[0]];
            performers[role] = pick(pool).id;
          }
          const qty = svc.category === 'Pemeriksaan laboratorium sederhana' && rnd() < 0.12 ? 2 + Math.floor(rnd() * 3) : 1;
          items.push(NP.trx.buildItem(svc, { qty, price: svc.price, performers }, empMap));
        }
        const ym = d.slice(0, 7).replace('-', '');
        const no = (counters.get(ym) || 0) + 1;
        counters.set(ym, no);
        const ts = u.parseISO(d).getTime() + (8 + Math.floor(rnd() * 12)) * 3600000 + Math.floor(rnd() * 3600000);
        const patient = pick(PATIENTS);
        trxs.push({
          id: s.numbering.transaction + '-' + ym + '-' + String(no).padStart(4, '0'), date: d, patient, patientCode: patient ? 'RM-' + String(1000 + Math.floor(rnd() * 900)) : '', note: '',
          items, totals: NP.trx.totals(items), status: 'active', adjustments: [], createdAt: ts, createdBy: rnd() < 0.7 ? 'operasional' : 'admin', demo: true
        });
      }
      // catatan shift/sesi
      if (dow !== 0) {
        worklogs.push({ id: 'WL-' + d + '-A', employeeId: emps[7].id, date: d, shifts: 0, sessions: 1, note: 'Praktik sore', demo: true });
        if ([2, 4, 6].includes(dow)) worklogs.push({ id: 'WL-' + d + '-B', employeeId: emps[8].id, date: d, shifts: 0, sessions: 1, note: 'Praktik pagi', demo: true });
        if (rnd() < 0.9) worklogs.push({ id: 'WL-' + d + '-C', employeeId: emps[10].id, date: d, shifts: 1, sessions: 0, note: 'Shift sore', demo: true });
        for (const idx of [1, 2, 3]) if (rnd() < 0.92) worklogs.push({ id: 'WL-' + d + '-S' + idx, employeeId: emps[idx].id, date: d, shifts: 1, sessions: 0, note: '', demo: true });
      }
    }
    // beberapa transaksi dibatalkan
    for (const i of [7, 120, 333, 580]) {
      const t = trxs[i];
      if (!t) continue;
      t.status = 'cancelled';
      t.cancelReason = pick(['Salah input tindakan', 'Pasien batal diperiksa', 'Duplikasi input']);
      t.cancelledAt = t.createdAt + 600000;
      t.cancelledBy = 'admin';
    }

    await NP.db.run(['employees', 'services', 'transactions', 'worklogs', 'counters', 'auditLog'], async (t) => {
      for (const e of emps) await t.put('employees', e);
      for (const x of services) await t.put('services', x);
      for (const x of trxs) await t.put('transactions', x);
      for (const w of worklogs) await t.put('worklogs', w);
      await t.put('counters', { key: 'employee', value: emps.length });
      await t.put('counters', { key: 'service', value: services.length });
      for (const [ym, v] of counters) await t.put('counters', { key: 'trx-' + ym, value: v });
      await t.put('auditLog', NP.audit.entry('demo.seed', 'system', '', 'Data demonstrasi dimuat: ' + emps.length + ' karyawan, ' + services.length + ' tindakan, ' + trxs.length + ' transaksi'));
    });

    // ---- Penggajian 3 bulan terakhir (2 terkunci, 1 disetujui)
    const cur = today.slice(0, 7);
    const periods = [u.addMonths(cur, -3), u.addMonths(cur, -2), u.addMonths(cur, -1)];
    for (const [i, p] of periods.entries()) {
      const r = u.monthRange(p);
      const inputs = {};
      for (const e of emps) {
        const o = {};
        if (rnd() < 0.3) o.lateCount = 1 + Math.floor(rnd() * 3);
        if (rnd() < 0.15) o.absentDays = 1;
        if (e.unit === 'APT' && rnd() < 0.4) o.overtimeHours = 2 + Math.floor(rnd() * 8);
        if (e.salesTarget) o.salesActual = Math.round((e.salesTarget * (0.9 + rnd() * 0.4)) / 1000) * 1000;
        const m = {};
        if (rnd() < 0.2) m.KASBON = 250000;
        if (e.position === 'Apoteker') m.INSENTIF = 300000;
        if (Object.keys(m).length) o.manual = m;
        if (Object.keys(o).length) inputs[e.id] = o;
      }
      const run = { id: '', period: p, start: r.start, end: r.end, payDate: u.addMonths(p, 1) + '-01', unit: 'ALL', employeeIds: emps.map((e) => e.id), inputs, includeEarlier: false, notes: 'Data demonstrasi', demo: true };
      const saved = await NP.payroll.saveDraft(run);
      await NP.payroll.approve(saved.id);
      if (i < 2) await NP.payroll.lock(saved.id);
    }

    await NP.saveSettings({ demoLoaded: true, demoRemoved: false });
  }

  async function remove() {
    const stores = ['employees', 'services', 'transactions', 'payrollRuns', 'worklogs', 'users'];
    await NP.db.run(stores.concat(['settings', 'auditLog', 'counters']), async (t) => {
      let n = 0;
      for (const s of stores) {
        for (const x of await t.all(s)) {
          if (x.demo) {
            await t.del(s, x.id);
            n++;
          }
        }
      }
      // reset nomor urut bila tidak ada data tersisa
      if (!(await t.all('employees')).length) await t.del('counters', 'employee');
      if (!(await t.all('services')).length) await t.del('counters', 'service');
      const left = await t.all('transactions');
      for (const c of await t.all('counters')) {
        if (c.key.startsWith('trx-') && !left.some((x) => x.id.includes('-' + c.key.slice(4) + '-'))) await t.del('counters', c.key);
      }
      const runsLeft = await t.all('payrollRuns');
      for (const c of await t.all('counters')) {
        if ((c.key.startsWith('pay-') || c.key.startsWith('slip-')) && !runsLeft.length) await t.del('counters', c.key);
      }
      const st = await t.get('settings', 'app');
      st.demoLoaded = false;
      st.demoRemoved = true;
      await t.put('settings', st);
      await t.put('auditLog', NP.audit.entry('demo.remove', 'system', '', 'Hapus ' + n + ' data demonstrasi'));
    });
    await NP.loadSettings();
  }

  NP.demo = { seed, remove };
})(typeof globalThis !== 'undefined' ? globalThis : window);
