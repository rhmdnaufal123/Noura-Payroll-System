/* Noura Payroll — mesin perhitungan gaji (murni, dapat diuji otomatis).
 *
 * computeSlip(employee, ctx) menghasilkan rincian pendapatan, potongan, total,
 * alokasi biaya per unit (untuk karyawan lintas unit) dan iuran pemberi kerja.
 */
(function (root) {
  'use strict';
  const NP = (root.NP = root.NP || {});
  const u = NP.u;
  const C = NP.C;

  const INPUT_DEFAULTS = {
    workDays: 26, presentDays: 26, lateCount: 0, absentDays: 0, overtimeHours: 0,
    shifts: 0, sessions: 0, patients: 0, actions: 0, salesTarget: 0, salesActual: 0, manual: {}
  };

  function normInputs(inputs, settings) {
    const wd = u.toNum((inputs && inputs.workDays) || (settings && settings.payroll && settings.payroll.workDays) || 26);
    const o = Object.assign({}, INPUT_DEFAULTS, { workDays: wd, presentDays: wd }, inputs || {});
    for (const k of ['workDays', 'presentDays', 'lateCount', 'absentDays', 'overtimeHours', 'shifts', 'sessions', 'patients', 'actions']) o[k] = Math.max(0, u.toNum(o[k]));
    o.salesTarget = Math.max(0, u.toInt(o.salesTarget));
    o.salesActual = Math.max(0, u.toInt(o.salesActual));
    o.manual = Object.assign({}, o.manual || {});
    return o;
  }

  function componentApplies(comp, emp) {
    const ov = (emp.componentOverrides || {})[comp.code];
    if (ov && ov.enabled === false) return false;
    if (ov && ov.enabled === true) return true;
    if (!comp.active) return false;
    if (comp.units && comp.units.length) {
      const empUnits = emp.unit === 'LINTAS' ? ['APT', 'KLINIK', 'LINTAS'] : [emp.unit];
      if (!comp.units.some((x) => empUnits.includes(x))) return false;
    }
    if (comp.positions && comp.positions.length && !comp.positions.includes(emp.position)) return false;
    return true;
  }

  function componentValue(comp, emp) {
    const ov = (emp.componentOverrides || {})[comp.code];
    if (ov && ov.value !== undefined && ov.value !== null && ov.value !== '') return u.toNum(ov.value);
    if (comp.positionValues && comp.positionValues[emp.position] !== undefined && comp.positionValues[emp.position] !== '') return u.toNum(comp.positionValues[emp.position]);
    return u.toNum(comp.value);
  }

  function costSplit(emp) {
    if (emp.unit === 'LINTAS') {
      const a = Math.min(100, Math.max(0, u.toNum(emp.costSplit && emp.costSplit.APT !== undefined ? emp.costSplit.APT : 50)));
      return { APT: a / 100, KLINIK: (100 - a) / 100 };
    }
    return emp.unit === 'KLINIK' ? { APT: 0, KLINIK: 1 } : { APT: 1, KLINIK: 0 };
  }

  function progressiveTax(pkp, brackets) {
    let tax = 0;
    let prev = 0;
    for (const b of brackets) {
      const cap = b.upTo === null || b.upTo === undefined || b.upTo === '' ? Infinity : u.toNum(b.upTo);
      if (pkp <= prev) break;
      const portion = Math.min(pkp, cap) - prev;
      if (portion > 0) tax += (portion * u.toNum(b.rate)) / 100;
      prev = cap;
    }
    return tax;
  }

  function salesBonus(cfg, inputs) {
    const target = inputs.salesTarget;
    const actual = inputs.salesActual;
    if (cfg.method === 'manual') return { amount: u.toInt(inputs.manual.BONUS_SALES), note: 'Bonus manual administrator' };
    if (!target) return { amount: 0, note: '' };
    const ach = (actual / target) * 100;
    const note = 'Pencapaian ' + u.num(ach, 1) + '% dari target ' + u.rp(target);
    if (cfg.method === 'tiered') {
      const tiers = (cfg.tiers || []).slice().sort((a, b) => u.toNum(b.min) - u.toNum(a.min));
      const t = tiers.find((x) => ach + 1e-9 >= u.toNum(x.min));
      return { amount: t ? u.toInt(t.amount) : 0, note };
    }
    if (ach + 1e-9 < u.toNum(cfg.minAchievement || 100)) return { amount: 0, note };
    if (cfg.method === 'fixed') return { amount: u.toInt(cfg.fixedAmount), note };
    if (cfg.method === 'percent') return { amount: Math.round((actual * u.toNum(cfg.percent)) / 100), note: note + ' × ' + u.pct(cfg.percent) + ' penjualan' };
    return { amount: 0, note };
  }

  /** Kelompokkan baris jasa menjadi ringkasan per tindakan & tarif. */
  function summarizeService(lines) {
    const m = new Map();
    for (const l of lines || []) {
      const k = l.serviceName + '|' + l.unitAmount;
      if (!m.has(k)) m.set(k, { serviceName: l.serviceName, unitAmount: l.unitAmount, count: 0, qty: 0, amount: 0, unit: l.unit });
      const x = m.get(k);
      x.count += 1;
      x.qty += l.qty || 1;
      x.amount += l.amount;
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount || a.serviceName.localeCompare(b.serviceName));
  }

  /**
   * @param {object} emp    karyawan
   * @param {object} ctx    { components, settings, inputs, serviceLines, adjustments }
   */
  function computeSlip(emp, ctx) {
    const settings = ctx.settings;
    const inputs = normInputs(ctx.inputs, settings);
    const comps = (ctx.components || []).slice().sort((a, b) => (a.order || 99) - (b.order || 99));
    const scheme = C.PAY_SCHEMES[emp.payScheme] || C.PAY_SCHEMES.monthly;
    const pc = emp.payConfig || {};
    const base = scheme.useBase ? u.toInt(emp.baseSalary) : 0;
    const earnings = [];
    const deductions = [];
    const warnings = [];

    const pushE = (comp, amount, note, extra) => {
      amount = Math.round(amount);
      if (!amount && comp.code !== 'BASE') return;
      earnings.push(Object.assign({ code: comp.code, name: comp.name, group: comp.group, amount, fixed: !!comp.fixed, taxable: comp.taxable !== false, note: note || '' }, extra || {}));
    };
    const pushD = (comp, amount, note) => {
      amount = Math.round(amount);
      if (!amount) return;
      deductions.push({ code: comp.code, name: comp.name, group: comp.group, amount, note: note || '' });
    };

    const serviceLines = ctx.serviceLines || [];
    const adjustments = ctx.adjustments || [];
    let fixedAllowance = 0;

    for (const comp of comps.filter((x) => x.type === 'earning')) {
      if (!componentApplies(comp, emp)) continue;
      const v = componentValue(comp, emp);
      switch (comp.calc) {
        case 'system':
          if (comp.code === 'BASE') {
            if (scheme.useBase) pushE(comp, base, 'Skema: ' + scheme.label);
          } else if (comp.code === 'JASA') {
            const tot = u.sum(serviceLines, (l) => l.amount);
            if (tot) {
              const byUnit = { APT: 0, KLINIK: 0 };
              serviceLines.forEach((l) => (byUnit[l.unit === 'KLINIK' ? 'KLINIK' : 'APT'] += l.amount));
              pushE(comp, tot, serviceLines.length + ' baris tindakan', { unitAlloc: byUnit });
            }
            const adj = u.sum(adjustments, (a) => a.amount);
            if (adj) {
              const byUnit = { APT: 0, KLINIK: 0 };
              adjustments.forEach((a) => (byUnit[a.unit === 'KLINIK' ? 'KLINIK' : 'APT'] += a.amount));
              pushE(Object.assign({}, comp, { code: 'JASA_KOREKSI', name: 'Koreksi Jasa Pelayanan' }), adj, adjustments.map((a) => a.trxId).join(', '), { unitAlloc: byUnit });
            }
          } else if (comp.code === 'HONOR_PRAKTIK') {
            const f = scheme.fields;
            if (f.includes('sessionRate') && u.toInt(pc.sessionRate) && inputs.sessions)
              pushE(Object.assign({}, comp, { name: 'Honor Sesi Praktik' }), inputs.sessions * u.toInt(pc.sessionRate), u.num(inputs.sessions) + ' sesi × ' + u.rp(pc.sessionRate));
            if (f.includes('patientRate') && u.toInt(pc.patientRate) && inputs.patients)
              pushE(Object.assign({}, comp, { name: 'Honor per Pasien' }), inputs.patients * u.toInt(pc.patientRate), u.num(inputs.patients) + ' pasien × ' + u.rp(pc.patientRate));
            if (f.includes('shiftRate') && u.toInt(pc.shiftRate) && inputs.shifts)
              pushE(Object.assign({}, comp, { name: 'Honor Shift' }), inputs.shifts * u.toInt(pc.shiftRate), u.num(inputs.shifts) + ' shift × ' + u.rp(pc.shiftRate));
            if (f.includes('actionRate') && u.toInt(pc.actionRate) && inputs.actions) {
              const isIncentive = emp.payScheme === 'monthly_incentive';
              pushE(Object.assign({}, comp, { name: isIncentive ? 'Insentif Pelayanan' : 'Honor Tindakan', group: isIncentive ? 'incentive' : 'practice' }), inputs.actions * u.toInt(pc.actionRate), u.num(inputs.actions) + ' tindakan × ' + u.rp(pc.actionRate));
            }
          } else if (comp.code === 'BONUS_SALES') {
            const r = salesBonus(settings.salesBonus || {}, inputs);
            pushE(comp, r.amount, r.note);
          }
          break;
        case 'fixed':
          pushE(comp, v);
          if (comp.fixed) fixedAllowance += Math.round(v);
          break;
        case 'percent': {
          const a = (base * v) / 100;
          pushE(comp, a, u.pct(v) + ' × gaji pokok');
          if (comp.fixed) fixedAllowance += Math.round(a);
          break;
        }
        case 'per_day':
          pushE(comp, v * inputs.presentDays, u.num(inputs.presentDays) + ' hari × ' + u.rp(v));
          break;
        case 'per_shift':
          pushE(comp, v * inputs.shifts, u.num(inputs.shifts) + ' shift × ' + u.rp(v));
          break;
        case 'per_hour': {
          const rate = v || (base ? (base / u.toNum(settings.payroll.overtimeDivisor || 173)) * u.toNum(settings.payroll.overtimeMultiplier || 1.5) : 0);
          pushE(comp, rate * inputs.overtimeHours, u.num(inputs.overtimeHours, 1) + ' jam × ' + u.rp(rate));
          break;
        }
        case 'attendance':
          pushE(comp, inputs.absentDays === 0 && inputs.lateCount === 0 ? v : 0, 'Hadir penuh');
          break;
        case 'manual': {
          const m = inputs.manual[comp.code];
          pushE(comp, m !== undefined && m !== null && m !== '' ? u.toInt(m) : v);
          break;
        }
        default:
          break;
      }
    }

    const gross = u.sum(earnings, (e) => e.amount);

    // BPJS
    const bp = settings.bpjs || {};
    let wage = u.toInt(emp.bpjsWage) || (bp.wageBase === 'base_fixed' ? base + fixedAllowance : base);
    const employer = { kes: 0, jht: 0, jp: 0, jkk: 0, jkm: 0, total: 0 };
    let pensionEmployee = 0;
    for (const comp of comps.filter((x) => x.type === 'deduction')) {
      if (!componentApplies(comp, emp)) continue;
      const v = componentValue(comp, emp);
      switch (comp.calc) {
        case 'system':
          if (comp.code === 'BPJS_KES' && emp.bpjsKes && wage > 0) {
            const w = Math.min(wage, u.toInt(bp.kes.cap) || wage);
            pushD(comp, (w * u.toNum(bp.kes.employee)) / 100, u.pct(bp.kes.employee) + ' × ' + u.rp(w));
            employer.kes = Math.round((w * u.toNum(bp.kes.employer)) / 100);
          } else if (comp.code === 'BPJS_TK' && emp.bpjsTk && wage > 0) {
            const jht = Math.round((wage * u.toNum(bp.jht.employee)) / 100);
            const wj = Math.min(wage, u.toInt(bp.jp.cap) || wage);
            const jp = Math.round((wj * u.toNum(bp.jp.employee)) / 100);
            pensionEmployee = jht + jp;
            pushD(comp, jht + jp, 'JHT ' + u.pct(bp.jht.employee) + ' + JP ' + u.pct(bp.jp.employee));
            employer.jht = Math.round((wage * u.toNum(bp.jht.employer)) / 100);
            employer.jp = Math.round((wj * u.toNum(bp.jp.employer)) / 100);
            employer.jkk = Math.round((wage * u.toNum(bp.jkk.employer)) / 100);
            employer.jkm = Math.round((wage * u.toNum(bp.jkm.employer)) / 100);
          }
          break;
        case 'fixed':
          pushD(comp, v);
          break;
        case 'percent':
          pushD(comp, (base * v) / 100, u.pct(v) + ' × gaji pokok');
          break;
        case 'per_occurrence':
          pushD(comp, v * inputs.lateCount, u.num(inputs.lateCount) + ' kali × ' + u.rp(v));
          break;
        case 'per_absent_day': {
          const rate = v || (base && inputs.workDays ? base / inputs.workDays : 0);
          pushD(comp, rate * inputs.absentDays, u.num(inputs.absentDays) + ' hari × ' + u.rp(rate));
          break;
        }
        case 'per_day':
          pushD(comp, v * inputs.presentDays);
          break;
        case 'manual': {
          const m = inputs.manual[comp.code];
          pushD(comp, m !== undefined && m !== null && m !== '' ? u.toInt(m) : v);
          break;
        }
        default:
          break;
      }
    }
    employer.total = employer.kes + employer.jht + employer.jp + employer.jkk + employer.jkm;

    // PPh 21 (dihitung terakhir)
    const pphComp = comps.find((x) => x.code === 'PPH21');
    const tx = settings.tax || {};
    let taxInfo = null;
    if (pphComp && componentApplies(pphComp, emp) && emp.pph21 && tx.method !== 'none') {
      const taxableGross = u.sum(earnings.filter((e) => e.taxable), (e) => e.amount) + (tx.includeEmployerBpjs ? employer.kes + employer.jkk + employer.jkm : 0);
      let pph = 0;
      if (tx.method === 'flat') {
        pph = Math.round((taxableGross * u.toNum(tx.flatRate)) / 100);
        taxInfo = { method: 'flat', taxableGross, rate: tx.flatRate };
      } else {
        const bj = Math.min((taxableGross * u.toNum(tx.biayaJabatanRate)) / 100, u.toInt(tx.biayaJabatanMax));
        const netMonthly = taxableGross - bj - pensionEmployee;
        const ptkp = u.toInt((tx.ptkp || {})[emp.ptkp || 'TK/0']);
        const pkp = Math.max(0, Math.floor((netMonthly * 12 - ptkp) / 1000) * 1000);
        const annual = progressiveTax(pkp, tx.brackets || []);
        pph = Math.round(annual / 12);
        taxInfo = { method: 'progressive', taxableGross, biayaJabatan: Math.round(bj), netMonthly: Math.round(netMonthly), ptkp, pkp, annual: Math.round(annual) };
      }
      pushD(pphComp, pph, tx.method === 'flat' ? 'Tarif ' + u.pct(tx.flatRate) : 'PTKP ' + (emp.ptkp || 'TK/0'));
    }

    const totalDed = u.sum(deductions, (d) => d.amount);
    const net = gross - totalDed;
    if (net < 0) warnings.push('Gaji bersih negatif (' + u.rp(net) + '). Periksa potongan.');

    // Alokasi biaya per unit
    const split = costSplit(emp);
    const alloc = { APT: { gross: 0, deductions: 0, net: 0 }, KLINIK: { gross: 0, deductions: 0, net: 0 } };
    for (const e of earnings) {
      if (e.unitAlloc) {
        alloc.APT.gross += e.unitAlloc.APT;
        alloc.KLINIK.gross += e.unitAlloc.KLINIK;
      } else {
        const a = Math.round(e.amount * split.APT);
        alloc.APT.gross += a;
        alloc.KLINIK.gross += e.amount - a;
      }
    }
    const dA = gross ? Math.round((totalDed * alloc.APT.gross) / gross) : Math.round(totalDed * split.APT);
    alloc.APT.deductions = dA;
    alloc.KLINIK.deductions = totalDed - dA;
    alloc.APT.net = alloc.APT.gross - alloc.APT.deductions;
    alloc.KLINIK.net = alloc.KLINIK.gross - alloc.KLINIK.deductions;

    const sumGroup = (g) => u.sum(earnings.filter((e) => e.group === g), (e) => e.amount);
    const totals = {
      gross,
      deductions: totalDed,
      net,
      base: sumGroup('base'),
      allowance: sumGroup('allowance'),
      overtime: sumGroup('overtime'),
      bonus: sumGroup('bonus'),
      incentive: sumGroup('incentive'),
      practice: sumGroup('practice'),
      service: sumGroup('service'),
      other: sumGroup('other'),
      fixed: u.sum(earnings.filter((e) => e.fixed), (e) => e.amount),
      bpjs: u.sum(deductions.filter((d) => d.group === 'bpjs'), (d) => d.amount),
      tax: u.sum(deductions.filter((d) => d.group === 'tax'), (d) => d.amount)
    };
    totals.variable = gross - totals.fixed;

    return {
      employeeId: emp.id,
      earnings: earnings.map((e) => {
        const x = Object.assign({}, e);
        delete x.unitAlloc;
        return x;
      }),
      deductions,
      serviceDetail: summarizeService(serviceLines),
      serviceCount: serviceLines.length,
      serviceQty: u.sum(serviceLines, (l) => l.qty || 1),
      totals,
      allocation: alloc,
      split,
      employer,
      taxInfo,
      inputs,
      warnings
    };
  }

  NP.calc = { computeSlip, componentApplies, componentValue, costSplit, progressiveTax, salesBonus, summarizeService, normInputs, INPUT_DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = NP;
})(typeof globalThis !== 'undefined' ? globalThis : window);
