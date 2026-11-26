/* File Excel jadwal sintetis (format ekspor "Jadwal Masuk") untuk uji impor. Nama fiktif. */
'use strict';
const WD3 = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
function build(period) {
  period = period || '2026-12';
  const [y, m] = period.split('-').map(Number);
  const N = new Date(y, m, 0).getDate();
  const head = ['Nama', 'Jabatan'];
  for (let d = 1; d <= N; d++) head.push(d + ' ' + WD3[new Date(y, m - 1, d).getDay()]);
  head.push('Masuk', 'Libur', 'Jam', 'P', 'S');
  const people = [
    ['apt. Uji Satu., S.Farm', 'Apoteker', (d) => (d % 7 === 3 ? 'L' : d % 2 ? 'P' : 'S')],
    ["Bd. Sal'sa Dua, A.Md.Keb.", 'Bidan', (d) => (d % 7 === 5 ? 'L' : 'S')],
    ['Tn. Orang Tiga, S.Pd.', 'Admin', (d) => (d === 10 ? 'M' : d % 7 === 0 ? 'L' : d % 3 ? 'S' : 'P')],
    ['Nama Tidak Dikenal', 'Kurir', () => 'P']
  ];
  const aoa = [head];
  for (const [name, pos, f] of people) {
    const row = [name, pos];
    for (let d = 1; d <= N; d++) row.push(f(d));
    row.push(0, 0, 0, 0, 0);
    aoa.push(row);
  }
  aoa.push([]);
  const count = (code) => {
    const row = ['Jumlah ' + code, 'terisi / ideal'];
    for (let d = 1; d <= N; d++) row.push(people.filter((p) => p[2](d) === code).length + '/' + (code === 'S' ? (d === 25 ? 1 : 2) : 1));
    return row;
  };
  aoa.push(count('P'), count('S'));
  const legend = [['Kode', 'Nama shift', 'Mulai', 'Selesai', 'Jam'], ['P', 'Pagi', '08:00', '15:00', 7], ['S', 'Siang', '14:00', '21:00', 7], ['M', 'Malam', 0.875, 0.3333333, 10], ['L', 'Libur', '', '', 0]];
  return { sheets: [{ name: 'Jadwal ' + period, aoa }, { name: 'Keterangan', aoa: legend }], N };
}
function writeXlsx(XLSX, file, period) {
  const { sheets } = build(period);
  const wb = XLSX.utils.book_new();
  for (const sh of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sh.aoa), sh.name);
  require('fs').writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return file;
}
module.exports = { build, writeXlsx };
