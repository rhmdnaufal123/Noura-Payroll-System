/* Noura Payroll — PENGATURAN: identitas, periode gaji, pajak, BPJS, bonus penjualan, template slip,
 * penomoran dokumen, pengguna & hak akses, backup/restore, data demo, audit log, info penyimpanan. */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const ui = NP.ui;
  const C = NP.C;

  /* ===================== Panel bersama (dipakai juga di halaman Penggajian) ===================== */
  const panels = {};

  panels.taxBpjs = function (el, canEdit) {
    const s = NP.state.settings;
    const t = s.tax;
    const b = s.bpjs;
    const dis = canEdit ? '' : 'disabled';
    el.innerHTML = `<form class="settings-form" novalidate>
      <div class="alert alert-info">${ui.icon('info')}<div>Tarif dan batas dapat diperbarui sesuai ketentuan perpajakan dan BPJS yang berlaku. Perubahan hanya memengaruhi penggajian yang dihitung setelahnya; slip yang sudah terbit tidak berubah.</div></div>
      <h3>PPh 21</h3>
      <div class="grid-3">
        <label class="field"><span>Metode perhitungan</span><select name="method" ${dis}>${ui.options([['progressive', 'Progresif disetahunkan (Pasal 17)'], ['flat', 'Tarif tetap (%) dari bruto'], ['none', 'Tidak dipotong']], t.method)}</select></label>
        <label class="field"><span>Tarif tetap (%)</span><input type="number" step="0.01" name="flatRate" value="${t.flatRate}" ${dis}></label>
        <label class="check"><input type="checkbox" name="includeEmployerBpjs" ${t.includeEmployerBpjs ? 'checked' : ''} ${dis}><span>Iuran BPJS Kes, JKK, JKM pemberi kerja menambah bruto pajak</span></label>
        <label class="field"><span>Biaya jabatan (%)</span><input type="number" step="0.01" name="biayaJabatanRate" value="${t.biayaJabatanRate}" ${dis}></label>
        <label class="field"><span>Maks. biaya jabatan / bulan</span><input data-money name="biayaJabatanMax" value="${ui.moneyVal(t.biayaJabatanMax)}" ${dis}></label>
      </div>
      <h4 class="sec-title">PTKP per tahun</h4>
      <div class="grid-4">${C.PTKP_LIST.map((k) => `<label class="field"><span>${k}</span><input data-money data-ptkp="${k}" value="${ui.moneyVal(t.ptkp[k])}" ${dis}></label>`).join('')}</div>
      <h4 class="sec-title">Lapisan tarif progresif (PKP setahun)</h4>
      <div class="brackets">${t.brackets.map((br, i) => `<div class="grid-3"><label class="field"><span>Lapisan ${i + 1} sampai dengan</span><input data-money data-br-up="${i}" value="${br.upTo === null ? '' : ui.moneyVal(br.upTo)}" placeholder="Tidak terbatas" ${dis}></label><label class="field"><span>Tarif (%)</span><input type="number" step="0.01" data-br-rate="${i}" value="${br.rate}" ${dis}></label></div>`).join('')}</div>
      <h3>BPJS</h3>
      <div class="grid-3">
        <label class="field"><span>Dasar upah BPJS</span><select name="wageBase" ${dis}>${ui.options([['base_fixed', 'Gaji pokok + tunjangan tetap'], ['base', 'Gaji pokok saja']], b.wageBase)}</select></label>
      </div>
      <div class="grid-4">
        <label class="field"><span>Kesehatan — karyawan (%)</span><input type="number" step="0.01" name="kesEmp" value="${b.kes.employee}" ${dis}></label>
        <label class="field"><span>Kesehatan — pemberi kerja (%)</span><input type="number" step="0.01" name="kesEr" value="${b.kes.employer}" ${dis}></label>
        <label class="field"><span>Batas upah BPJS Kesehatan</span><input data-money name="kesCap" value="${ui.moneyVal(b.kes.cap)}" ${dis}></label>
        <span></span>
        <label class="field"><span>JHT — karyawan (%)</span><input type="number" step="0.01" name="jhtEmp" value="${b.jht.employee}" ${dis}></label>
        <label class="field"><span>JHT — pemberi kerja (%)</span><input type="number" step="0.01" name="jhtEr" value="${b.jht.employer}" ${dis}></label>
        <label class="field"><span>JP — karyawan (%)</span><input type="number" step="0.01" name="jpEmp" value="${b.jp.employee}" ${dis}></label>
        <label class="field"><span>JP — pemberi kerja (%)</span><input type="number" step="0.01" name="jpEr" value="${b.jp.employer}" ${dis}></label>
        <label class="field"><span>Batas upah JP</span><input data-money name="jpCap" value="${ui.moneyVal(b.jp.cap)}" ${dis}></label>
        <label class="field"><span>JKK — pemberi kerja (%)</span><input type="number" step="0.01" name="jkkEr" value="${b.jkk.employer}" ${dis}></label>
        <label class="field"><span>JKM — pemberi kerja (%)</span><input type="number" step="0.01" name="jkmEr" value="${b.jkm.employer}" ${dis}></label>
      </div>
      ${canEdit ? `<div class="form-actions"><button class="btn btn-primary" type="submit">${ui.icon('check')}<span>Simpan Pajak & BPJS</span></button></div>` : ''}
    </form>`;
    const f = el.querySelector('form');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const d = ui.formData(f);
      const ptkp = {};
      f.querySelectorAll('[data-ptkp]').forEach((i) => (ptkp[i.dataset.ptkp] = u.toInt(i.value)));
      const brackets = t.brackets.map((_, i) => {
        const up = f.querySelector(`[data-br-up="${i}"]`).value.trim();
        return { upTo: up === '' ? null : u.toInt(up), rate: u.toNum(f.querySelector(`[data-br-rate="${i}"]`).value) };
      });
      for (let i = 1; i < brackets.length; i++) if (brackets[i - 1].upTo !== null && brackets[i].upTo !== null && brackets[i].upTo <= brackets[i - 1].upTo) return ui.toast('Batas lapisan tarif harus bertambah.', 'error');
      const nums = ['flatRate', 'biayaJabatanRate', 'kesEmp', 'kesEr', 'jhtEmp', 'jhtEr', 'jpEmp', 'jpEr', 'jkkEr', 'jkmEr'];
      if (nums.some((k) => u.toNum(d[k]) < 0 || u.toNum(d[k]) > 100)) return ui.toast('Persentase harus 0–100.', 'error');
      await NP.saveSettings({
        tax: { method: d.method, flatRate: u.toNum(d.flatRate), includeEmployerBpjs: d.includeEmployerBpjs, biayaJabatanRate: u.toNum(d.biayaJabatanRate), biayaJabatanMax: d.biayaJabatanMax, ptkp, brackets },
        bpjs: { wageBase: d.wageBase, kes: { employee: u.toNum(d.kesEmp), employer: u.toNum(d.kesEr), cap: d.kesCap }, jht: { employee: u.toNum(d.jhtEmp), employer: u.toNum(d.jhtEr) }, jp: { employee: u.toNum(d.jpEmp), employer: u.toNum(d.jpEr), cap: d.jpCap }, jkk: { employer: u.toNum(d.jkkEr) }, jkm: { employer: u.toNum(d.jkmEr) } }
      }, 'Ubah pengaturan pajak & BPJS');
      ui.toast('Pengaturan pajak & BPJS disimpan.');
    };
  };

  panels.salesBonus = function (el, canEdit) {
    const sb = u.clone(NP.state.settings.salesBonus);
    const dis = canEdit ? '' : 'disabled';
    function draw() {
      el.innerHTML = `<form class="settings-form" novalidate>
        <p class="muted">Bonus target penjualan berlaku untuk karyawan Apotek Noura yang memiliki target penjualan bulanan (diatur di form karyawan). Realisasi penjualan diinput saat Generate Payroll.</p>
        <div class="grid-3">
          <label class="field"><span>Metode bonus</span><select name="method" ${dis}>${ui.options([['tiered', 'Bertingkat berdasarkan % pencapaian'], ['fixed', 'Nominal tetap bila target tercapai'], ['percent', 'Persentase dari realisasi penjualan'], ['manual', 'Bonus manual dari administrator']], sb.method)}</select></label>
          <label class="field"><span>Minimal pencapaian (%)</span><input type="number" name="minAchievement" value="${sb.minAchievement}" ${dis}></label>
          <label class="field"><span>Nominal tetap</span><input data-money name="fixedAmount" value="${ui.moneyVal(sb.fixedAmount)}" ${dis}></label>
          <label class="field"><span>Persentase dari penjualan (%)</span><input type="number" step="0.01" name="percent" value="${sb.percent}" ${dis}></label>
        </div>
        <h4 class="sec-title">Tingkatan (metode bertingkat)</h4>
        <div class="tiers">${sb.tiers.map((t, i) => `<div class="grid-3"><label class="field"><span>Pencapaian ≥ (%)</span><input type="number" data-tmin="${i}" value="${t.min}" ${dis}></label><label class="field"><span>Bonus</span><input data-money data-tamt="${i}" value="${ui.moneyVal(t.amount)}" ${dis}></label>${canEdit ? `<button type="button" class="btn btn-sm btn-ghost danger" data-tdel="${i}">${ui.icon('trash')}Hapus</button>` : ''}</div>`).join('')}</div>
        ${canEdit ? `<button type="button" class="btn btn-sm btn-ghost" data-tadd>${ui.icon('plus')}Tambah tingkatan</button><div class="form-actions"><button class="btn btn-primary" type="submit">${ui.icon('check')}<span>Simpan Bonus Penjualan</span></button></div>` : ''}
      </form>`;
      const f = el.querySelector('form');
      const sync = () => {
        f.querySelectorAll('[data-tmin]').forEach((i) => (sb.tiers[+i.dataset.tmin].min = u.toNum(i.value)));
        f.querySelectorAll('[data-tamt]').forEach((i) => (sb.tiers[+i.dataset.tamt].amount = u.toInt(i.value)));
        const d = ui.formData(f);
        Object.assign(sb, { method: d.method, minAchievement: u.toNum(d.minAchievement), fixedAmount: d.fixedAmount, percent: u.toNum(d.percent) });
      };
      f.onclick = (e) => {
        if (e.target.closest('[data-tadd]')) {
          sync();
          sb.tiers.push({ min: 100, amount: 0 });
          draw();
        }
        const dl = e.target.closest('[data-tdel]');
        if (dl) {
          sync();
          sb.tiers.splice(+dl.dataset.tdel, 1);
          draw();
        }
      };
      f.onsubmit = async (e) => {
        e.preventDefault();
        sync();
        sb.tiers.sort((a, b) => a.min - b.min);
        await NP.saveSettings({ salesBonus: sb }, 'Ubah pengaturan bonus penjualan (' + sb.method + ')');
        ui.toast('Pengaturan bonus penjualan disimpan.');
        draw();
      };
    }
    draw();
  };
  NP.settingsPanels = panels;

  /* ===================== Backup & Restore ===================== */
  const backup = {
    async build() {
      const data = await NP.db.exportAll();
      return { app: 'noura-payroll', format: 1, exportedAt: new Date().toISOString(), exportedBy: (NP.sec.user() || {}).username, counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])), data };
    },
    async download() {
      const b = await backup.build();
      const name = 'backup-noura-payroll-' + u.todayISO() + '-' + u.pad(new Date().getHours()) + u.pad(new Date().getMinutes()) + '.json';
      const ok = await NP.exp.download(new Blob([JSON.stringify(b)], { type: 'application/json' }), name);
      if (!ok) return null;
      await NP.saveSettings({ backup: { lastBackup: Date.now() } });
      await NP.audit.log('backup.download', 'system', '', 'Backup database (' + Object.entries(b.counts).map(([k, v]) => k + ':' + v).join(', ') + ')');
      ui.toast('Backup diunduh: ' + name);
      return name;
    },
    validate(obj) {
      if (!obj || obj.app !== 'noura-payroll' || !obj.data) throw new Error('File bukan backup Noura Payroll yang valid.');
      for (const s of NP.db.STORES) if (obj.data[s] !== undefined && !Array.isArray(obj.data[s])) throw new Error('Struktur backup rusak pada bagian ' + s + '.');
      if (!Array.isArray(obj.data.settings) || !obj.data.settings.some((x) => x.key === 'app')) throw new Error('Backup tidak memuat pengaturan aplikasi.');
      if (!Array.isArray(obj.data.users) || !obj.data.users.some((x) => x.role === 'admin' && x.active !== false)) throw new Error('Backup tidak memuat akun administrator aktif.');
      for (const t of obj.data.transactions || []) if (!t.id || !Array.isArray(t.items)) throw new Error('Data transaksi pada backup tidak valid.');
      return true;
    },
    async restore(file) {
      const text = await ui.readFile(file, 'text');
      let obj;
      try {
        obj = JSON.parse(text);
      } catch (_) {
        throw new Error('File JSON tidak dapat dibaca.');
      }
      backup.validate(obj);
      return obj;
    }
  };
  NP.backup = backup;

  /* ===================== Halaman ===================== */
  const TABS = [
    { key: 'identity', label: 'Identitas' },
    { key: 'payroll', label: 'Periode Gaji' },
    { key: 'tax', label: 'Pajak & BPJS' },
    { key: 'slip', label: 'Template Slip' },
    { key: 'numbering', label: 'Penomoran' },
    { key: 'users', label: 'Pengguna & Akses' },
    { key: 'backup', label: 'Backup & Restore' },
    { key: 'data', label: 'Data Demo' },
    { key: 'audit', label: 'Audit Log' },
    { key: 'system', label: 'Sistem' }
  ];

  async function render(view, params) {
    let tab = params.tab || 'identity';
    view.innerHTML = `
      <div class="page-head"><div><h2>Pengaturan</h2><p class="muted">Identitas usaha, penggajian, pajak & BPJS, slip, pengguna, backup, dan keamanan data.</p></div>
        <div class="actions"><a class="btn btn-ghost" href="#/services">${ui.icon('medical')}<span>Master & Tarif Tindakan</span></a><a class="btn btn-ghost" href="#/payroll">${ui.icon('wallet')}<span>Komponen Gaji</span></a></div></div>
      <div class="card"><div id="st-tabs"></div><div id="st-body"></div></div>`;
    const body = ui.$('#st-body', view);
    ui.tabs(ui.$('#st-tabs', view), TABS, tab, (k) => {
      tab = k;
      draw();
    });
    function draw() {
      const fn = { identity, payroll: payrollTab, tax: (el) => panels.taxBpjs(el, true), slip: slipTab, numbering, users, backup: backupTab, data: dataTab, audit, system }[tab];
      fn(body);
    }
    draw();
  }

  function identity(el) {
    const s = NP.state.settings;
    const unitBox = (k) => {
      const x = s.units[k];
      return `<fieldset class="panel"><legend>${C.UNITS[k].name}</legend>
        <div class="logo-row"><img class="logo-prev" data-logo-prev="${k}" src="${x.logo || s.company.logo || 'assets/logo.png'}" alt=""><div><button type="button" class="btn btn-sm btn-ghost" data-logo="${k}">${ui.icon('image')}Ganti logo unit</button> <button type="button" class="btn btn-sm btn-ghost" data-logo-clear="${k}">Pakai logo utama</button></div></div>
        <div class="grid-2">
          <label class="field"><span>Nama unit</span><input name="${k}.name" value="${u.esc(x.name)}"></label>
          <label class="field"><span>Telepon</span><input name="${k}.phone" value="${u.esc(x.phone)}"></label>
          <label class="field span-2"><span>Alamat</span><input name="${k}.address" value="${u.esc(x.address)}"></label>
          <label class="field"><span>Email</span><input name="${k}.email" value="${u.esc(x.email)}"></label>
          <label class="field"><span>Nama pimpinan (tanda tangan slip)</span><input name="${k}.leaderName" value="${u.esc(x.leaderName)}"></label>
          <label class="field span-2"><span>Jabatan pimpinan</span><input name="${k}.leaderTitle" value="${u.esc(x.leaderTitle)}"></label>
        </div></fieldset>`;
    };
    const logos = { company: s.company.logo, APT: s.units.APT.logo, KLINIK: s.units.KLINIK.logo };
    el.innerHTML = `<form class="settings-form" novalidate>
      <fieldset class="panel"><legend>Perusahaan</legend>
        <div class="logo-row"><img class="logo-prev" data-logo-prev="company" src="${s.company.logo || 'assets/logo.png'}" alt=""><div><button type="button" class="btn btn-sm btn-ghost" data-logo="company">${ui.icon('image')}Ganti logo Apotek Noura</button> <button type="button" class="btn btn-sm btn-ghost" data-logo-clear="company">Logo bawaan</button><p class="muted small">PNG/JPG, otomatis diperkecil.</p></div></div>
        <label class="field"><span>Nama perusahaan</span><input name="companyName" value="${u.esc(s.company.name)}"></label>
      </fieldset>
      <div class="grid-2 unit-boxes">${unitBox('APT')}${unitBox('KLINIK')}</div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${ui.icon('check')}<span>Simpan Identitas</span></button></div></form>`;
    const f = el.querySelector('form');
    f.onclick = async (e) => {
      const b = e.target.closest('[data-logo]');
      if (b) {
        const file = await ui.pickFile('image/*');
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) return ui.toast('Ukuran logo maksimal 5 MB.', 'error');
        logos[b.dataset.logo] = await ui.resizeImage(await ui.readFile(file, 'dataurl'), 300);
        f.querySelector(`[data-logo-prev="${b.dataset.logo}"]`).src = logos[b.dataset.logo];
      }
      const c = e.target.closest('[data-logo-clear]');
      if (c) {
        logos[c.dataset.logoClear] = null;
        f.querySelector(`[data-logo-prev="${c.dataset.logoClear}"]`).src = logos.company || 'assets/logo.png';
      }
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const d = ui.formData(f);
      if (!d.companyName) return ui.toast('Nama perusahaan wajib diisi.', 'error');
      const units = {};
      for (const k of ['APT', 'KLINIK']) {
        units[k] = { logo: logos[k] };
        for (const fld of ['name', 'phone', 'address', 'email', 'leaderName', 'leaderTitle']) units[k][fld] = d[k + '.' + fld];
        if (!units[k].name) return ui.toast('Nama unit wajib diisi.', 'error');
      }
      await NP.saveSettings({ company: { name: d.companyName, logo: logos.company }, units }, 'Ubah identitas usaha');
      ui.toast('Identitas disimpan.');
    };
  }

  function payrollTab(el) {
    const p = NP.state.settings.payroll;
    el.innerHTML = `<form class="settings-form" novalidate>
      <div class="grid-3">
        <label class="field"><span>Periode penggajian</span><input value="Bulanan (tanggal 1 s.d. akhir bulan)" readonly></label>
        <label class="field"><span>Hari kerja standar / bulan</span><input type="number" min="1" max="31" name="workDays" value="${p.workDays}"></label>
        <label class="field"><span>Tanggal pembayaran (bulan berikutnya)</span><input type="number" min="1" max="31" name="payDay" value="${p.payDay}"></label>
        <label class="field"><span>Pembagi upah lembur per jam</span><input type="number" min="1" name="overtimeDivisor" value="${p.overtimeDivisor}"></label>
        <label class="field"><span>Pengali lembur</span><input type="number" step="0.1" min="1" name="overtimeMultiplier" value="${p.overtimeMultiplier}"></label>
      </div>
      <fieldset class="panel"><legend>Status karyawan yang diikutkan penggajian</legend>${Object.entries(C.EMP_STATUS).map(([k, l]) => `<label class="check"><input type="checkbox" name="sts" data-multi value="${k}" ${p.includeEmployeeStatuses.includes(k) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>
      <p class="muted small">Upah lembur otomatis = gaji pokok ÷ pembagi × pengali per jam (bila komponen "Uang Lembur" bernilai 0).</p>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${ui.icon('check')}<span>Simpan</span></button></div></form>`;
    el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const d = ui.formData(e.target);
      if (!(d.workDays >= 1 && d.workDays <= 31)) return ui.toast('Hari kerja harus 1–31.', 'error');
      if (!(d.payDay >= 1 && d.payDay <= 31)) return ui.toast('Tanggal pembayaran harus 1–31.', 'error');
      if (!(d.sts || []).length) return ui.toast('Pilih minimal satu status karyawan.', 'error');
      await NP.saveSettings({ payroll: { workDays: d.workDays, payDay: d.payDay, overtimeDivisor: d.overtimeDivisor || 173, overtimeMultiplier: d.overtimeMultiplier || 1.5, includeEmployeeStatuses: d.sts } }, 'Ubah pengaturan periode gaji');
      ui.toast('Pengaturan periode gaji disimpan.');
    };
  }

  function slipTab(el) {
    const s = NP.state.settings.slip;
    el.innerHTML = `<form class="settings-form" novalidate>
      <div class="grid-2">
        <label class="check"><input type="checkbox" name="showServiceDetail" ${s.showServiceDetail ? 'checked' : ''}><span>Tampilkan rincian jasa pelayanan per tindakan</span></label>
        <label class="check"><input type="checkbox" name="showTerbilang" ${s.showTerbilang ? 'checked' : ''}><span>Tampilkan terbilang gaji bersih</span></label>
        <label class="check"><input type="checkbox" name="showBank" ${s.showBank ? 'checked' : ''}><span>Tampilkan bank & rekening (tersamar)</span></label>
        <label class="check"><input type="checkbox" name="showEmployerContrib" ${s.showEmployerContrib ? 'checked' : ''}><span>Tampilkan iuran BPJS pemberi kerja</span></label>
        <label class="field"><span>Nama pembuat (footer slip)</span><input name="issuerName" value="${u.esc(s.issuerName)}"></label>
        <label class="field"><span>Catatan kaki slip</span><input name="footerNote" value="${u.esc(s.footerNote)}" maxlength="120"></label>
      </div>
      <p class="muted small">Kop slip otomatis memakai logo & identitas unit karyawan (Apotek Noura atau Praktek Dokter Umum). Tanda tangan pimpinan diambil dari tab Identitas. Data STR/SIP tidak pernah ditampilkan pada slip.</p>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-prev>${ui.icon('eye')}<span>Preview contoh</span></button><button class="btn btn-primary" type="submit">${ui.icon('check')}<span>Simpan</span></button></div></form>`;
    const f = el.querySelector('form');
    f.onsubmit = async (e) => {
      e.preventDefault();
      await NP.saveSettings({ slip: ui.formData(f) }, 'Ubah template slip');
      ui.toast('Template slip disimpan.');
    };
    f.querySelector('[data-prev]').onclick = async () => {
      await NP.saveSettings({ slip: ui.formData(f) });
      const runs = (await NP.payroll.runs()).filter((r) => r.slips.length);
      if (!runs.length) return ui.toast('Belum ada data slip untuk preview.', 'warning');
      const run = runs[0];
      const sl = run.slips.find((x) => x.serviceDetail.length) || run.slips[0];
      NP.slip.previewModal(run, sl);
    };
  }

  async function numbering(el) {
    const n = NP.state.settings.numbering;
    const counters = (await NP.db.all('counters')).sort((a, b) => a.key.localeCompare(b.key));
    el.innerHTML = `<form class="settings-form" novalidate>
      <p class="muted">Awalan nomor dokumen. Nomor urut dibuat otomatis dan unik; perubahan awalan hanya berlaku untuk dokumen baru.</p>
      <div class="grid-3">
        <label class="field"><span>ID karyawan</span><input name="employee" value="${u.esc(n.employee)}" maxlength="6"><small class="muted">Contoh: ${u.esc(n.employee)}-0001</small></label>
        <label class="field"><span>Kode tindakan</span><input name="service" value="${u.esc(n.service)}" maxlength="6"><small class="muted">Contoh: ${u.esc(n.service)}-0001</small></label>
        <label class="field"><span>No. transaksi</span><input name="transaction" value="${u.esc(n.transaction)}" maxlength="6"><small class="muted">Contoh: ${u.esc(n.transaction)}-202611-0001</small></label>
        <label class="field"><span>No. penggajian</span><input name="payroll" value="${u.esc(n.payroll)}" maxlength="6"><small class="muted">Contoh: ${u.esc(n.payroll)}-202611-01</small></label>
        <label class="field"><span>No. slip</span><input name="slip" value="${u.esc(n.slip)}" maxlength="6"><small class="muted">Contoh: ${u.esc(n.slip)}/APT/2026/11/0001</small></label>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${ui.icon('check')}<span>Simpan</span></button></div>
      <h4 class="sec-title">Penghitung nomor urut saat ini</h4>
      <div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Kunci</th><th class="ta-right">Nomor terakhir</th></tr></thead><tbody>${counters.map((c) => `<tr><td>${u.esc(c.key)}</td><td class="ta-right">${c.value}</td></tr>`).join('')}</tbody></table></div></form>`;
    el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const d = ui.formData(e.target);
      for (const k of Object.keys(d)) {
        d[k] = d[k].toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!d[k]) return ui.toast('Awalan tidak boleh kosong.', 'error');
      }
      await NP.saveSettings({ numbering: d }, 'Ubah penomoran dokumen');
      ui.toast('Penomoran disimpan.');
      numbering(el);
    };
  }

  async function users(el) {
    const list = await NP.sec.users();
    const me = NP.sec.user();
    el.innerHTML = `
      <div class="card-head"><h3>Pengguna aplikasi</h3><button class="btn btn-sm btn-primary" data-u="add">${ui.icon('plus')}Tambah pengguna</button></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Nama pengguna</th><th>Nama</th><th>Hak akses</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((x) => `<tr><td><b>${u.esc(x.username)}</b>${x.id === me.id ? ' ' + ui.badge('Anda', 'green') : ''}${x.demo ? ' ' + ui.badge('Demo', 'gray') : ''}</td><td>${u.esc(x.name)}</td><td>${u.esc(NP.sec.ROLES[x.role].label)}</td><td>${ui.statusBadge(x.active !== false ? 'active' : 'nonaktif')}</td>
        <td class="ta-right"><div class="row-actions"><button class="icon-btn" data-u="edit" data-id="${x.id}" title="Edit">${ui.icon('edit')}</button><button class="icon-btn" data-u="pw" data-id="${x.id}" title="Atur ulang kata sandi">${ui.icon('lock')}</button>${x.id !== me.id ? `<button class="icon-btn danger" data-u="del" data-id="${x.id}" title="Hapus">${ui.icon('trash')}</button>` : ''}</div></td></tr>`).join('')}
      </tbody></table></div>
      <h4 class="sec-title">Matriks hak akses</h4>
      <div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Peran</th><th>Keterangan</th></tr></thead><tbody>${Object.values(NP.sec.ROLES).map((r) => `<tr><td><b>${r.label}</b></td><td>${r.desc}</td></tr>`).join('')}</tbody></table></div>
      <div class="table-wrap"><table class="tbl tbl-compact"><thead><tr><th>Izin</th>${Object.values(NP.sec.ROLES).map((r) => `<th class="ta-center">${r.label}</th>`).join('')}</tr></thead><tbody>
      ${Object.entries(NP.sec.PERMS).map(([p, roles]) => `<tr><td><code>${p}</code></td>${Object.keys(NP.sec.ROLES).map((r) => `<td class="ta-center">${r === 'admin' || roles.includes(r) ? '✓' : '–'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    el.onclick = async (e) => {
      const b = e.target.closest('[data-u]');
      if (!b) return;
      const x = list.find((y) => y.id === b.dataset.id);
      if (b.dataset.u === 'add' || b.dataset.u === 'edit') userForm(x, () => users(el));
      if (b.dataset.u === 'pw') {
        const pw = await ui.prompt({ title: 'Atur ulang kata sandi ' + x.username, label: 'Kata sandi baru (min. 6 karakter)', required: true, minLength: 6, requiredMsg: 'Minimal 6 karakter.' });
        if (!pw) return;
        await NP.sec.changePassword(x.id, pw);
        ui.toast('Kata sandi diatur ulang.');
      }
      if (b.dataset.u === 'del') {
        const admins = list.filter((y) => y.role === 'admin' && y.active !== false && y.id !== x.id);
        if (x.role === 'admin' && !admins.length) return ui.toast('Minimal harus ada satu administrator aktif.', 'error');
        if (!(await ui.confirm({ message: 'Hapus pengguna ' + x.username + '?', danger: true, okLabel: 'Hapus' }))) return;
        await NP.db.del('users', x.id);
        await NP.audit.log('user.delete', 'user', x.id, 'Hapus pengguna ' + x.username);
        users(el);
      }
    };
  }

  function userForm(x, done) {
    const isNew = !x;
    ui.modal({
      title: isNew ? 'Tambah Pengguna' : 'Edit Pengguna ' + x.username,
      size: 'sm',
      body: `${NP.db.remote && isNew ? '<label class="field"><span>Email (untuk login)</span><input name="email" type="email" autocomplete="off"></label><p class="muted small">Akun dibuat di Supabase Auth melalui fungsi server admin-users.</p>' : `<label class="field"><span>Nama pengguna</span><input name="username" value="${u.esc(x ? x.username : '')}" ${isNew ? '' : 'readonly'} autocomplete="off"></label>`}
        <label class="field"><span>Nama lengkap</span><input name="name" value="${u.esc(x ? x.name : '')}"></label>
        <label class="field"><span>Hak akses</span><select name="role">${ui.options(Object.entries(NP.sec.ROLES).map(([k, r]) => [k, r.label]), x ? x.role : 'ops')}</select></label>
        ${isNew ? '<label class="field"><span>Kata sandi (min. 6 karakter)</span><input name="password" type="password" autocomplete="new-password"></label>' : `<label class="check"><input type="checkbox" name="active" ${x.active !== false ? 'checked' : ''}><span>Aktif</span></label>`}
        <div class="form-error" hidden></div>`,
      actions: [
        { label: 'Batal', cls: 'btn-ghost', onClick: (m) => m.close() },
        {
          label: 'Simpan', cls: 'btn-primary', onClick: async (m) => {
            const d = ui.formData(m.body);
            const err = m.body.querySelector('.form-error');
            const fail = (s) => {
              err.hidden = false;
              err.textContent = s;
            };
            const all = await NP.db.all('users');
            if (isNew && NP.db.remote) {
              if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email || '')) return fail('Email tidak valid.');
              if (!d.password || d.password.length < 8) return fail('Kata sandi minimal 8 karakter.');
              if (!d.name) return fail('Nama lengkap wajib diisi.');
              try {
                await NP.db.adminUsers({ action: 'create', email: d.email, password: d.password, full_name: d.name, role: d.role });
              } catch (e) {
                return fail(e.message);
              }
            } else if (isNew) {
              if (!/^[a-z0-9._-]{3,20}$/i.test(d.username)) return fail('Nama pengguna 3–20 karakter (huruf, angka, titik, garis).');
              if (all.some((y) => y.username.toLowerCase() === d.username.toLowerCase())) return fail('Nama pengguna sudah dipakai.');
              if (!d.password || d.password.length < 6) return fail('Kata sandi minimal 6 karakter.');
              if (!d.name) return fail('Nama lengkap wajib diisi.');
              const usr = NP.sec.makeUser(d.username, d.name, d.role, d.password);
              await NP.db.put('users', usr);
              await NP.audit.log('user.create', 'user', usr.id, 'Tambah pengguna ' + usr.username + ' (' + d.role + ')');
            } else {
              if (!d.name) return fail('Nama lengkap wajib diisi.');
              if (x.role === 'admin' && (d.role !== 'admin' || !d.active) && !all.some((y) => y.id !== x.id && y.role === 'admin' && y.active !== false)) return fail('Minimal harus ada satu administrator aktif.');
              Object.assign(x, { name: d.name, role: d.role, active: d.active });
              await NP.db.put('users', x);
              await NP.audit.log('user.update', 'user', x.id, 'Ubah pengguna ' + x.username + ' → ' + d.role + (d.active ? '' : ' (nonaktif)'));
            }
            m.close();
            ui.toast('Pengguna disimpan.');
            done();
          }
        }
      ]
    });
  }

  async function backupTab(el) {
    const s = NP.state.settings;
    const est = await NP.db.estimate();
    const counts = {};
    for (const st of NP.db.STORES) counts[st] = await NP.db.all(st).then((x) => x.length, () => '-');
    el.innerHTML = `
      <div class="grid-2">
        <div class="panel"><h3>${ui.icon('download')} Backup database</h3>
          <p class="muted">Unduh seluruh data (karyawan, tindakan, transaksi, penggajian, pengaturan, pengguna, audit log) dalam satu file JSON. Simpan di tempat aman (flashdisk / cloud pribadi).</p>
          <p>Backup terakhir: <b>${s.backup.lastBackup ? u.fmtDateTime(s.backup.lastBackup) : 'belum pernah'}</b></p>
          <button class="btn btn-primary" data-b="dl">${ui.icon('download')}<span>Download Backup JSON</span></button>
          <label class="field" style="margin-top:14px"><span>Pengingat backup setiap (hari, 0 = nonaktif)</span><div class="inline"><input type="number" min="0" max="90" id="bk-days" value="${s.backup.reminderDays}"><button class="btn btn-ghost btn-sm" data-b="rem">Simpan</button></div></label>
        </div>
        ${NP.db.remote ? `<div class="panel"><h3>${ui.icon('archive')} Backup server Supabase</h3>
          <p class="muted">Database pusat dicadangkan di sisi server: backup harian Supabase (dan Point-in-Time Recovery pada paket berbayar), serta workflow GitHub Actions <code>db-backup.yml</code> yang membuat dump terenkripsi secara terjadwal.</p>
          <p class="muted">Restore dilakukan administrator database melalui Supabase Dashboard atau <code>psql</code> — tidak dari browser — agar data pusat tidak tertimpa secara tidak sengaja.</p>
        </div>` : `<div class="panel"><h3>${ui.icon('upload')} Restore database</h3>
          <p class="muted">Pulihkan data dari file backup JSON. <b>Seluruh data saat ini akan diganti</b> dengan isi backup.</p>
          <label class="check"><input type="checkbox" id="bk-safety" checked><span>Unduh backup data saat ini sebelum restore</span></label>
          <button class="btn btn-danger" data-b="restore">${ui.icon('upload')}<span>Pilih file & Restore</span></button>
        </div>`}
      </div>
      <h4 class="sec-title">Isi database saat ini</h4>
      <div class="grid-5 mini-stats">${Object.entries(counts).map(([k, v]) => `<div><span>${k}</span><b>${u.num(v)}</b></div>`).join('')}</div>
      ${est ? `<p class="muted small">Penggunaan penyimpanan browser: ${(est.usage / 1048576).toFixed(2)} MB dari kuota ±${(est.quota / 1073741824).toFixed(1)} GB.</p>` : ''}`;
    el.onclick = async (e) => {
      const b = e.target.closest('[data-b]');
      if (!b) return;
      if (b.dataset.b === 'dl') {
        await backup.download();
        NP.renderBanners();
        backupTab(el);
      }
      if (b.dataset.b === 'rem') {
        await NP.saveSettings({ backup: { reminderDays: u.toNum(el.querySelector('#bk-days').value) } }, 'Ubah pengingat backup');
        ui.toast('Pengingat backup disimpan.');
        NP.renderBanners();
      }
      if (b.dataset.b === 'restore') {
        const f = await ui.pickFile('.json,application/json');
        if (!f) return;
        let obj;
        try {
          obj = await backup.restore(f);
        } catch (err) {
          return ui.toast(err.message, 'error');
        }
        const ok = await ui.confirm({
          title: 'Restore database',
          danger: true,
          okLabel: 'Ganti seluruh data',
          html: `Backup tanggal <b>${u.esc(u.fmtDateTime(obj.exportedAt))}</b> berisi: ${Object.entries(obj.counts || {}).map(([k, v]) => u.esc(k) + ' ' + v).join(', ')}.<br><br>Seluruh data saat ini akan <b>diganti</b>. Lanjutkan?`
        });
        if (!ok) return;
        if (el.querySelector('#bk-safety').checked) await backup.download();
        await ui.busy('Memulihkan database...', async () => {
          await NP.db.importAll(obj.data);
          await NP.audit.log('backup.restore', 'system', '', 'Restore dari backup ' + obj.exportedAt);
        });
        ui.toast('Database berhasil dipulihkan. Aplikasi dimuat ulang.');
        setTimeout(() => location.reload(), 800);
      }
    };
  }

  async function dataTab(el) {
    if (NP.db.remote) {
      el.innerHTML = `<div class="panel"><h3>Database pusat Supabase</h3><p class="muted">Data demonstrasi dan penghapusan massal tidak tersedia pada database produksi. Seluruh data dikelola melalui proses aplikasi yang tercatat di audit log.</p></div>`;
      return;
    }
    const emps = await NP.db.all('employees');
    const demoCount = (await Promise.all(['employees', 'services', 'transactions', 'payrollRuns', 'worklogs'].map((s) => NP.db.all(s)))).reduce((a, l) => a + l.filter((x) => x.demo).length, 0);
    el.innerHTML = `
      <div class="grid-2">
        <div class="panel"><h3>Data demonstrasi</h3>
          <p class="muted">Aplikasi berisi data contoh (karyawan, tindakan, transaksi, dan penggajian) untuk mencoba seluruh fitur. Terdapat <b>${u.num(demoCount)}</b> data demo.</p>
          ${demoCount ? `<button class="btn btn-danger" data-d="remove">${ui.icon('trash')}<span>Hapus seluruh data demonstrasi</span></button>` : emps.length ? '<p>Data demo sudah dihapus.</p>' : `<button class="btn btn-primary" data-d="load">${ui.icon('refresh')}<span>Muat data demonstrasi</span></button>`}
          <p class="muted small">Data demo yang dihapus: karyawan, tindakan, transaksi, penggajian, catatan shift, dan akun demo. Komponen gaji, pengaturan, dan akun administrator tetap.</p>
        </div>
        <div class="panel"><h3>Reset</h3>
          <p class="muted">Hapus seluruh data operasional (karyawan, tindakan, transaksi, penggajian, catatan, nomor urut). Pengaturan, komponen gaji, dan pengguna tetap.</p>
          <button class="btn btn-danger" data-d="wipe">${ui.icon('trash')}<span>Hapus seluruh data operasional</span></button>
          <p class="muted small">Disarankan melakukan backup terlebih dahulu.</p>
        </div>
      </div>`;
    el.onclick = async (e) => {
      const b = e.target.closest('[data-d]');
      if (!b) return;
      if (b.dataset.d === 'load') {
        await ui.busy('Memuat data demonstrasi...', () => NP.demo.seed());
        ui.toast('Data demonstrasi dimuat.');
        dataTab(el);
      }
      if (b.dataset.d === 'remove') {
        if (!(await ui.confirm({ title: 'Hapus data demonstrasi', message: 'Seluruh data demo akan dihapus permanen. Data yang Anda input sendiri tetap tersimpan. Lanjutkan?', danger: true, okLabel: 'Hapus data demo' }))) return;
        const auth = await NP.sec.authorize('Menghapus seluruh data demonstrasi.', { noNote: true });
        if (!auth) return;
        await ui.busy('Menghapus data demonstrasi...', () => NP.demo.remove());
        ui.toast('Data demonstrasi dihapus.');
        setTimeout(() => location.reload(), 600);
      }
      if (b.dataset.d === 'wipe') {
        if (!(await ui.confirm({ title: 'Hapus seluruh data operasional', message: 'SEMUA karyawan, tindakan, transaksi, dan penggajian akan dihapus permanen. Lanjutkan?', danger: true, okLabel: 'Hapus semua' }))) return;
        const auth = await NP.sec.authorize('Menghapus seluruh data operasional.', { noNote: true });
        if (!auth) return;
        await NP.db.run(['employees', 'services', 'transactions', 'payrollRuns', 'worklogs', 'counters', 'auditLog', 'settings'], async (t) => {
          for (const s of ['employees', 'services', 'transactions', 'payrollRuns', 'worklogs', 'counters']) await t.clear(s);
          const st = await t.get('settings', 'app');
          st.demoLoaded = false;
          st.demoRemoved = true;
          await t.put('settings', st);
          await t.put('auditLog', NP.audit.entry('data.wipe', 'system', '', 'Hapus seluruh data operasional (otorisasi ' + auth.by + ')'));
        });
        ui.toast('Seluruh data operasional dihapus.');
        setTimeout(() => location.reload(), 600);
      }
    };
  }

  async function audit(el) {
    let logs = (await NP.db.all('auditLog')).sort((a, b) => b.ts - a.ts);
    el.innerHTML = `<div class="filters"><label class="search">${ui.icon('search')}<input type="search" id="al-q" placeholder="Cari aksi, pengguna, ID, keterangan..."></label><button class="btn btn-ghost" id="al-xls">${ui.icon('excel')}<span>Ekspor Excel</span></button></div><div id="al-list"></div>`;
    const tbl = ui.table(el.querySelector('#al-list'), {
      columns: [
        { key: 'ts', label: 'Waktu', render: (l) => u.fmtDateTime(l.ts), value: (l) => l.ts },
        { key: 'user', label: 'Pengguna', render: (l) => u.esc(l.userName || l.user) },
        { key: 'action', label: 'Aksi', render: (l) => `<code>${u.esc(l.action)}</code>` },
        { key: 'entityId', label: 'ID', render: (l) => u.esc(l.entityId) },
        { key: 'detail', label: 'Keterangan', render: (l) => `<small>${u.esc(l.detail)}</small>` }
      ],
      rows: logs,
      sortKey: 'ts',
      sortDir: 'desc',
      pageSize: 30
    });
    el.querySelector('#al-q').oninput = u.debounce((e) => {
      const q = e.target.value.toLowerCase();
      tbl.update(logs.filter((l) => !q || [l.user, l.userName, l.action, l.entityId, l.detail].join(' ').toLowerCase().includes(q)));
    }, 200);
    el.querySelector('#al-xls').onclick = () => NP.exp.excel([{ name: 'Audit Log', rows: tbl.rows().map((l) => ({ Waktu: u.fmtDateTime(l.ts), Pengguna: l.user, Aksi: l.action, Entitas: l.entity, ID: l.entityId, Keterangan: l.detail })) }], 'audit-log-' + u.todayISO() + '.xlsx');
  }

  async function system(el) {
    const est = await NP.db.estimate();
    el.innerHTML = `<div class="grid-2">
      <div class="panel"><h3>Penyimpanan data</h3>
        <div class="kv"><span>Mode</span><b>${u.esc(NP.db.name)}</b></div>
        <div class="kv"><span>Multi-perangkat</span><b>${NP.db.multiDevice ? 'Ya' : 'Tidak — data hanya ada di browser & perangkat ini'}</b></div>
        <div class="kv"><span>Nama database</span><b>${u.esc(NP.db.DB_NAME)}</b></div>
        ${est ? `<div class="kv"><span>Terpakai</span><b>${(est.usage / 1048576).toFixed(2)} MB</b></div>` : ''}
        <p class="muted small">Karena data tersimpan lokal, gunakan Backup JSON secara rutin dan jangan menghapus data situs/browser. Untuk dipakai beberapa perangkat atau beberapa administrator bersamaan, aplikasi perlu dihubungkan ke backend dengan autentikasi dan database terpusat (lihat README bagian Arsitektur).</p>
      </div>
      <div class="panel"><h3>Keamanan</h3>
        <label class="field"><span>Kunci otomatis bila tidak aktif (menit, 0 = nonaktif)</span><div class="inline"><input type="number" min="0" max="240" id="sy-lock" value="${NP.state.settings.security.autoLockMinutes}"><button class="btn btn-sm btn-ghost" id="sy-save">Simpan</button></div></label>
        <ul class="muted small"><li>Kata sandi disimpan dalam bentuk hash SHA-256 bergaram (500 iterasi).</li><li>Nomor rekening hanya terlihat oleh Administrator & Admin Keuangan.</li><li>Seluruh perubahan penting tercatat di Audit Log.</li><li>Transaksi pada periode gaji terkunci hanya dapat dikoreksi dengan otorisasi administrator.</li></ul>
      </div>
      <div class="panel"><h3>Aplikasi</h3>
        <div class="kv"><span>Versi</span><b>1.0.0</b></div>
        <div class="kv"><span>Mode PWA</span><b>${'serviceWorker' in navigator && /^https?:/.test(location.protocol) ? 'Didukung' : 'Jalankan lewat http(s) untuk instalasi PWA'}</b></div>
        <div class="kv"><span>Pustaka</span><b>Chart.js, SheetJS, jsPDF, html2canvas, JSZip</b></div>
      </div></div>`;
    el.querySelector('#sy-save').onclick = async () => {
      await NP.saveSettings({ security: { autoLockMinutes: u.toNum(el.querySelector('#sy-lock').value) } }, 'Ubah kunci otomatis');
      ui.toast('Pengaturan keamanan disimpan.');
    };
  }

  NP.pages.settings = { title: 'Pengaturan', render };
})(typeof globalThis !== 'undefined' ? globalThis : window);
