/* Noura Payroll — konstanta domain: unit usaha, jabatan, kategori tindakan, peran tenaga kesehatan. */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});

  const UNITS = {
    APT: { code: 'APT', name: 'Apotek Noura', short: 'Apotek' },
    KLINIK: { code: 'KLINIK', name: 'Praktek Dokter Umum', short: 'Praktek Dokter' }
  };
  /** Nilai unit pada data karyawan: APT, KLINIK, atau LINTAS (kedua unit). */
  const EMP_UNITS = {
    APT: 'Apotek Noura',
    KLINIK: 'Praktek Dokter Umum',
    LINTAS: 'Lintas Unit (Apotek & Praktek)'
  };

  const POSITIONS = {
    APT: ['Apoteker', 'Tenaga Teknis Kefarmasian (TTK)', 'Asisten Apoteker', 'Kasir', 'Admin Apotek', 'Staf Operasional', 'Kurir', 'Karyawan Lainnya'],
    KLINIK: ['Dokter Umum', 'Bidan', 'Perawat', 'Admin Pendaftaran', 'Petugas Administrasi', 'Staf Pendukung']
  };
  const ALL_POSITIONS = POSITIONS.APT.concat(POSITIONS.KLINIK);

  const DEPARTMENTS = {
    APT: ['Farmasi', 'Kasir & Penjualan', 'Administrasi', 'Operasional', 'Pengiriman'],
    KLINIK: ['Pelayanan Medis', 'Kebidanan', 'Keperawatan', 'Pendaftaran', 'Administrasi', 'Penunjang']
  };

  /** Peran pelaksana tindakan (dipakai pada pembagian pendapatan "petugas pelaksana"). */
  const ROLES = {
    dokter: { key: 'dokter', label: 'Dokter', positions: ['Dokter Umum'] },
    bidan: { key: 'bidan', label: 'Bidan', positions: ['Bidan'] },
    perawat: { key: 'perawat', label: 'Perawat', positions: ['Perawat'] },
    farmasi: { key: 'farmasi', label: 'Tenaga Farmasi', positions: ['Apoteker', 'Tenaga Teknis Kefarmasian (TTK)', 'Asisten Apoteker'] },
    petugas: { key: 'petugas', label: 'Petugas Lain', positions: [] }
  };

  const ADMIN_POSITIONS = ['Admin Apotek', 'Admin Pendaftaran', 'Petugas Administrasi'];
  const HEALTH_POSITIONS = ['Dokter Umum', 'Bidan', 'Perawat', 'Apoteker', 'Tenaga Teknis Kefarmasian (TTK)'];

  function roleOfPosition(pos) {
    for (const k of ['dokter', 'bidan', 'perawat', 'farmasi']) if (ROLES[k].positions.includes(pos)) return k;
    return 'petugas';
  }

  /** Kategori laporan untuk bagian pendapatan. */
  const SHARE_CATS = {
    apotek: 'Apotek Noura',
    klinik: 'Praktek Dokter Umum',
    dokter: 'Jasa Dokter',
    bidan: 'Jasa Bidan',
    perawat: 'Jasa Perawat',
    farmasi: 'Jasa Tenaga Farmasi',
    petugas: 'Jasa Petugas Lain',
    eksternal: 'Penerima Lainnya'
  };

  const SERVICE_CATEGORIES = [
    'Dokter Umum & Bidan',
    'Homecare',
    'Pemeriksaan laboratorium sederhana',
    'Pemeriksaan kesehatan',
    'Pemeriksaan dokter',
    'Tindakan medis',
    'Tindakan kebidanan',
    'Tindakan keperawatan',
    'Pelayanan farmasi',
    'Penjualan produk',
    'Pelayanan lainnya'
  ];

  /** Kelompok analisis tindakan: Homecare, Dokter Umum & Bidan (seluruh tindakan medis/kebidanan), Lainnya. */
  const SERVICE_GROUPS = { dokter_bidan: 'Dokter Umum & Bidan', homecare: 'Homecare', lainnya: 'Farmasi & Lainnya' };
  const NON_CLINICAL = ['Pelayanan farmasi', 'Penjualan produk', 'Pelayanan lainnya'];
  function serviceGroup(category, name) {
    if (category === 'Homecare' || /(^|\s)(HC|HOMECARE|HOME CARE)(\s|$)/i.test(String(name || ''))) return 'homecare';
    if (NON_CLINICAL.includes(category)) return 'lainnya';
    return 'dokter_bidan';
  }

  const EMP_STATUS = { aktif: 'Aktif', nonaktif: 'Tidak Aktif', cuti: 'Cuti', resign: 'Mengundurkan Diri' };

  /** Skema penggajian. useBase = memakai gaji pokok bulanan. fields = tarif honor yang relevan. */
  const PAY_SCHEMES = {
    monthly: { label: 'Gaji tetap bulanan', useBase: true, fields: [] },
    per_session: { label: 'Honor per sesi praktik', useBase: false, fields: ['sessionRate'] },
    per_patient: { label: 'Honor per pasien', useBase: false, fields: ['patientRate'] },
    per_shift: { label: 'Honor per shift', useBase: false, fields: ['shiftRate'] },
    per_action: { label: 'Honor per tindakan', useBase: false, fields: ['actionRate'] },
    service_only: { label: 'Jasa pelayanan / persentase jasa (tanpa gaji tetap)', useBase: false, fields: [] },
    monthly_service: { label: 'Gaji tetap + jasa pelayanan', useBase: true, fields: [] },
    monthly_incentive: { label: 'Gaji tetap + insentif pelayanan', useBase: true, fields: ['actionRate'] },
    combination: { label: 'Kombinasi gaji, honor praktik/shift, insentif & jasa', useBase: true, fields: ['sessionRate', 'patientRate', 'shiftRate', 'actionRate'] }
  };
  const SCHEMES_BY_ROLE = {
    dokter: ['monthly', 'per_session', 'per_patient', 'service_only', 'monthly_service', 'combination'],
    bidan: ['monthly', 'per_shift', 'per_session', 'per_action', 'service_only', 'monthly_service', 'monthly_incentive', 'combination'],
    perawat: ['monthly', 'per_shift', 'per_action', 'service_only', 'monthly_service', 'combination'],
    farmasi: ['monthly', 'monthly_service', 'combination'],
    petugas: ['monthly', 'monthly_service', 'per_shift', 'combination']
  };
  const RATE_LABELS = {
    sessionRate: 'Honor per sesi praktik',
    patientRate: 'Honor per pasien',
    shiftRate: 'Honor per shift',
    actionRate: 'Honor/insentif per tindakan'
  };

  const PTKP_LIST = ['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'];

  NP.C = {
    UNITS, EMP_UNITS, POSITIONS, ALL_POSITIONS, DEPARTMENTS, ROLES, ADMIN_POSITIONS, HEALTH_POSITIONS,
    roleOfPosition, SHARE_CATS, SERVICE_CATEGORIES, SERVICE_GROUPS, serviceGroup, EMP_STATUS, PAY_SCHEMES, SCHEMES_BY_ROLE, RATE_LABELS, PTKP_LIST
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = NP;
})(typeof globalThis !== 'undefined' ? globalThis : window);
