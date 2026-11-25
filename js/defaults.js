/* Noura Payroll — pengaturan & komponen gaji bawaan. Semua nilai dapat diubah dari halaman Pengaturan/Penggajian. */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});

  const DEFAULT_SETTINGS = {
    key: 'app',
    schemaVersion: 1,
    company: { name: 'Apotek Noura & Praktek Dokter Umum', logo: null },
    units: {
      APT: { name: 'Apotek Noura', address: 'Jl. Melati Raya No. 12, Kel. Sukamaju, Kota Bandung', phone: '0812-0000-1234', email: 'apotek@noura.local', logo: null, leaderName: 'apt. Nadia Putri, S.Farm.', leaderTitle: 'Pemilik / Apoteker Penanggung Jawab' },
      KLINIK: { name: 'Praktek Dokter Umum Noura', address: 'Jl. Melati Raya No. 12A, Kel. Sukamaju, Kota Bandung', phone: '0812-0000-5678', email: 'praktek@noura.local', logo: null, leaderName: 'dr. Ahmad Fauzi', leaderTitle: 'Dokter Penanggung Jawab' }
    },
    payroll: { workDays: 26, payDay: 1, overtimeDivisor: 173, overtimeMultiplier: 1.5, includeEmployeeStatuses: ['aktif', 'cuti'] },
    tax: {
      method: 'progressive', // progressive | flat | none
      flatRate: 5,
      biayaJabatanRate: 5,
      biayaJabatanMax: 500000,
      includeEmployerBpjs: true,
      ptkp: { 'TK/0': 54000000, 'TK/1': 58500000, 'TK/2': 63000000, 'TK/3': 67500000, 'K/0': 58500000, 'K/1': 63000000, 'K/2': 67500000, 'K/3': 72000000 },
      brackets: [
        { upTo: 60000000, rate: 5 },
        { upTo: 250000000, rate: 15 },
        { upTo: 500000000, rate: 25 },
        { upTo: 5000000000, rate: 30 },
        { upTo: null, rate: 35 }
      ]
    },
    bpjs: {
      wageBase: 'base_fixed', // base | base_fixed
      kes: { employee: 1, employer: 4, cap: 12000000 },
      jht: { employee: 2, employer: 3.7 },
      jp: { employee: 1, employer: 2, cap: 10547400 },
      jkk: { employer: 0.24 },
      jkm: { employer: 0.3 }
    },
    salesBonus: {
      method: 'tiered', // tiered | fixed | percent | manual
      minAchievement: 100,
      fixedAmount: 300000,
      percent: 1,
      tiers: [
        { min: 100, amount: 300000 },
        { min: 110, amount: 500000 },
        { min: 125, amount: 750000 }
      ]
    },
    slip: { showServiceDetail: true, showEmployerContrib: false, showTerbilang: true, showBank: true, footerNote: 'Slip gaji ini diterbitkan oleh sistem dan bersifat rahasia.', issuerName: 'Administrator', stampEnabled: true, stampLabel: 'DISAHKAN', stampColor: '#006b2a' },
    numbering: { employee: 'KRY', service: 'TND', transaction: 'TRX', payroll: 'PAY', slip: 'SLIP' },
    backup: { reminderDays: 7, lastBackup: null },
    security: { autoLockMinutes: 30 },
    demoLoaded: false
  };

  /* calc:
   *  system         : dihitung khusus oleh sistem (gaji pokok, jasa, honor, bonus penjualan, BPJS, PPh 21)
   *  fixed          : nominal tetap per bulan
   *  percent        : persen dari gaji pokok
   *  per_day        : nominal × hari hadir
   *  per_shift      : nominal × jumlah shift
   *  per_hour       : nominal × jam lembur (0 = gaji pokok / pembagi × pengali)
   *  per_occurrence : nominal × jumlah keterlambatan
   *  per_absent_day : nominal × hari tidak hadir (0 = gaji pokok / hari kerja)
   *  attendance     : nominal penuh bila tidak ada absen & keterlambatan
   *  manual         : diinput saat penggajian (nilai default dapat diatur per karyawan)
   */
  function c(code, name, type, group, calc, value, extra) {
    return Object.assign({ id: code, code, name, type, group, calc, value: value || 0, positionValues: {}, units: [], positions: [], active: true, fixed: false, taxable: true, system: false }, extra || {});
  }

  const DEFAULT_COMPONENTS = [
    c('BASE', 'Gaji Pokok', 'earning', 'base', 'system', 0, { fixed: true, system: true, order: 1 }),
    c('T_JABATAN', 'Tunjangan Jabatan', 'earning', 'allowance', 'fixed', 0, {
      fixed: true, order: 2,
      positionValues: { 'Apoteker': 1000000, 'Tenaga Teknis Kefarmasian (TTK)': 400000, 'Dokter Umum': 1500000, 'Bidan': 500000, 'Perawat': 400000, 'Admin Apotek': 250000, 'Petugas Administrasi': 250000 }
    }),
    c('T_TRANSPORT', 'Tunjangan Transportasi', 'earning', 'allowance', 'per_day', 15000, { order: 3 }),
    c('T_MAKAN', 'Tunjangan Makan', 'earning', 'allowance', 'per_day', 15000, { order: 4 }),
    c('T_KOMUNIKASI', 'Tunjangan Komunikasi', 'earning', 'allowance', 'fixed', 100000, { fixed: true, order: 5, positions: ['Apoteker', 'Dokter Umum', 'Bidan', 'Admin Apotek', 'Admin Pendaftaran', 'Petugas Administrasi', 'Kurir'] }),
    c('T_KEHADIRAN', 'Tunjangan Kehadiran', 'earning', 'allowance', 'attendance', 150000, { order: 6 }),
    c('T_SHIFT', 'Tunjangan Shift', 'earning', 'allowance', 'per_shift', 20000, { order: 7, units: ['APT'] }),
    c('LEMBUR', 'Uang Lembur', 'earning', 'overtime', 'per_hour', 0, { order: 8 }),
    c('BONUS_SALES', 'Bonus Target Penjualan', 'earning', 'bonus', 'system', 0, { system: true, order: 9, units: ['APT'] }),
    c('BONUS', 'Bonus', 'earning', 'bonus', 'manual', 0, { order: 10 }),
    c('INSENTIF', 'Insentif', 'earning', 'incentive', 'manual', 0, { order: 11 }),
    c('HONOR_PRAKTIK', 'Honor Praktik', 'earning', 'practice', 'system', 0, { system: true, order: 12 }),
    c('JASA', 'Jasa Pelayanan', 'earning', 'service', 'system', 0, { system: true, order: 13 }),
    c('KOMISI', 'Komisi', 'earning', 'incentive', 'manual', 0, { order: 14 }),
    c('PENDAPATAN_LAIN', 'Pendapatan Lainnya', 'earning', 'other', 'manual', 0, { order: 15 }),

    c('BPJS_KES', 'BPJS Kesehatan', 'deduction', 'bpjs', 'system', 0, { system: true, order: 20 }),
    c('BPJS_TK', 'BPJS Ketenagakerjaan (JHT + JP)', 'deduction', 'bpjs', 'system', 0, { system: true, order: 21 }),
    c('PPH21', 'PPh 21', 'deduction', 'tax', 'system', 0, { system: true, order: 22 }),
    c('POT_TELAT', 'Potongan Keterlambatan', 'deduction', 'late', 'per_occurrence', 25000, { order: 23 }),
    c('POT_ABSEN', 'Potongan Ketidakhadiran', 'deduction', 'absent', 'per_absent_day', 0, { order: 24 }),
    c('KASBON', 'Potongan Kasbon', 'deduction', 'kasbon', 'manual', 0, { order: 25 }),
    c('PINJAMAN', 'Potongan Pinjaman', 'deduction', 'loan', 'manual', 0, { order: 26 }),
    c('POT_LAIN', 'Potongan Lainnya', 'deduction', 'other', 'manual', 0, { order: 27 })
  ];

  const EARNING_GROUPS = { base: 'Gaji Pokok', allowance: 'Tunjangan', overtime: 'Lembur', bonus: 'Bonus', incentive: 'Insentif', practice: 'Honor Praktik', service: 'Jasa Pelayanan', other: 'Pendapatan Lainnya' };
  const DEDUCTION_GROUPS = { bpjs: 'BPJS', tax: 'PPh 21', late: 'Potongan Keterlambatan', absent: 'Potongan Ketidakhadiran', kasbon: 'Kasbon', loan: 'Pinjaman', other: 'Potongan Lainnya' };
  const CALC_LABELS = {
    system: 'Otomatis sistem', fixed: 'Nominal tetap / bulan', percent: '% dari gaji pokok', per_day: 'Nominal × hari hadir', per_shift: 'Nominal × jumlah shift',
    per_hour: 'Nominal × jam lembur', per_occurrence: 'Nominal × jumlah terlambat', per_absent_day: 'Nominal × hari tidak hadir', attendance: 'Penuh bila hadir penuh', manual: 'Input manual saat penggajian'
  };

  NP.defaults = { DEFAULT_SETTINGS, DEFAULT_COMPONENTS, EARNING_GROUPS, DEDUCTION_GROUPS, CALC_LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = NP;
})(typeof globalThis !== 'undefined' ? globalThis : window);
