#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// inspect-tariffs.js — READ-ONLY Column A diagnostic (v2.13.16)
// ════════════════════════════════════════════════════════════════
// Prints, per tenant: the personalTariffs intervals, the effective rate NOW,
// and every paymentHistory record cross-checked against (a) the tariff table
// and (b) sentLog. Flags the "phantom-debt shape" — a record whose frozen
// `amount` does NOT match the tariff that was in effect for that month, or a
// `paid:true` record with no confirming sentLog.
//
// ⚠️ READS ONLY. It never writes, never touches the server, never calls any API.
// Safe to run against live prod data. Reuses the REAL resolution helpers by
// extracting them from server.js (no drift), so what it prints is exactly what
// the freeze path would compute.
//
// USAGE:
//   node scripts/inspect-tariffs.js <tenantDataId> [--all]
//     <tenantDataId>  the data file name without .json (e.g. e17cab8f-...)
//     --all           print clean rows too (default: only flagged rows + summary)
//
// EXAMPLE (Tal's own building):
//   node scripts/inspect-tariffs.js e17cab8f-bc04-4540-ba60-d44a348ec3f7

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Locate DATA_DIR + the data file ───────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const arg = process.argv[2];
const showAll = process.argv.includes('--all');

if (!arg || arg.startsWith('--')) {
  console.error('usage: node scripts/inspect-tariffs.js <tenantDataId> [--all]');
  console.error('  DATA_DIR = ' + DATA_DIR);
  process.exit(2);
}
const file = path.join(DATA_DIR, arg.replace(/\.json$/, '') + '.json');
if (!fs.existsSync(file)) {
  console.error('❌ data file not found: ' + file);
  console.error('   (set DATA_DIR if running outside the server, e.g. on Railway it is /app/data)');
  process.exit(2);
}

// ── Extract the REAL resolution helpers from server.js (no copies) ─
function extractFns(src, names) {
  let out = '';
  for (const n of names) {
    const re = new RegExp('^(?:async )?function ' + n + '\\s*\\([\\s\\S]*?^\\}', 'm');
    const m = src.match(re);
    if (!m) { console.error('⚠️  ' + n + ' not found in server.js — was it renamed?'); process.exit(3); }
    out += m[0] + '\n';
  }
  return out;
}
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const months = (serverSrc.match(/const HEBREW_MONTHS = \[[^\]]*\];/) || [''])[0];
const helperNames = ['monthInInterval', 'pickRateFromIntervals', 'resolveTariffRate', 'parseSentLogAmount', 'sentLogIsPayment'];
const sandbox = { module: { exports: {} }, console, Date, JSON, Math, parseFloat, parseInt, isNaN, String, Object, Array };
vm.createContext(sandbox);
vm.runInContext(months + '\n' + extractFns(serverSrc, helperNames) +
  'module.exports={' + helperNames.join(',') + ',HEBREW_MONTHS};', sandbox);
const S = sandbox.module.exports;

// ── Load the data ─────────────────────────────────────────────────
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const tenants = d.tenants || [];
const paymentHistory = d.paymentHistory || {};
const sentLog = d.sentLog || {};
const defaultTariffs = d.defaultTariffs || null;
const buildingDefault = (d.config && d.config.amount) || 300;
const HEB = S.HEBREW_MONTHS;

const now = new Date();
const nowKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
const nowYear = now.getFullYear();

// ── Header ────────────────────────────────────────────────────────
console.log('');
console.log('══════════════════════════════════════════════════════════');
console.log(' Column A tariff inspection — ' + path.basename(file));
console.log('══════════════════════════════════════════════════════════');
console.log(' building default (config.amount): ₪' + buildingDefault);
console.log(' defaultTariffs: ' + (defaultTariffs
  ? JSON.stringify(defaultTariffs)
  : '(not seeded yet — will lazy-seed on first freeze)'));
console.log(' tenants: ' + tenants.length + '   |   now: ' + nowKey);
console.log('');

let flaggedTotal = 0;
let phantomSum = 0;

for (const t of tenants) {
  const tid = String(t.id);
  const hist = paymentHistory[tid] || [];
  const personal = t.personalTariffs || null;
  const effNow = S.resolveTariffRate(t, defaultTariffs, nowKey,
    t.customAmount || buildingDefault);

  // Per-tenant header
  const nameLine = (t.name || '(no name)') + '  [id ' + tid + ']';
  const rows = [];

  for (const r of hist) {
    if (r.type === 'wa_sent') continue;           // reminders carry no money
    const mk = r.month;                            // "YYYY-MM"
    if (!mk) continue;
    const expected = S.resolveTariffRate(t, defaultTariffs, mk, t.customAmount || buildingDefault);
    const frozen = (r.amount != null && !isNaN(parseFloat(r.amount))) ? parseFloat(r.amount) : null;

    // sentLog cross-check: find the Hebrew-month key for this monthKey.
    const idx = parseInt(String(mk).split('-')[1], 10) - 1;
    const heb = (idx >= 0 && idx < HEB.length) ? HEB[idx] : null;
    const slVal = heb ? sentLog[tid + '_' + heb] : undefined;
    const slIsPay = S.sentLogIsPayment(slVal);
    const slAmt = S.parseSentLogAmount(slVal);

    const flags = [];
    // (1) phantom-debt shape: frozen amount != tariff in effect for that month.
    if (frozen != null && expected != null && frozen !== expected) {
      flags.push('TARIFF-MISMATCH frozen ₪' + frozen + ' vs tariff ₪' + expected +
        ' (Δ' + (frozen - expected) + ')');
      phantomSum += (frozen - expected);
    }
    // (2) paid record with no confirming sentLog (the "Tami" shape).
    if (r.paid && !slIsPay) {
      flags.push('PAID-NO-SENTLOG (sentLog[' + heb + ']="' + (slVal || '') + '")');
    }
    // (3) sentLog amount disagrees with paidAmount.
    if (slIsPay && slAmt != null && r.paidAmount != null && parseFloat(r.paidAmount) !== slAmt) {
      flags.push('PAIDAMOUNT-MISMATCH record ₪' + r.paidAmount + ' vs sentLog ₪' + slAmt);
    }

    const clean = flags.length === 0;
    if (clean && !showAll) continue;
    rows.push({
      mk, frozen, expected, paid: !!r.paid, paidAmount: r.paidAmount,
      date: r.date, type: r.type, sl: slVal || '(none)', flags
    });
    if (flags.length) flaggedTotal++;
  }

  if (rows.length === 0 && !showAll) continue;

  console.log('── ' + nameLine);
  console.log('   customAmount: ' + (t.customAmount != null ? '₪' + t.customAmount : '(default)') +
    '   |   effective now: ₪' + effNow);
  if (personal && personal.length) {
    console.log('   personalTariffs:');
    personal.slice().sort((a, b) => String(a.startDate) < String(b.startDate) ? 1 : -1)
      .forEach(iv => {
        const open = iv.endDate == null || iv.endDate === '';
        console.log('     ₪' + iv.rate + '   ' + iv.startDate + ' → ' + (open ? 'now' : iv.endDate));
      });
  } else {
    console.log('   personalTariffs: (none — rides building default)');
  }
  if (rows.length) {
    console.log('   paymentHistory:');
    rows.forEach(r => {
      const tag = r.flags.length ? '  🚩 ' + r.flags.join(' | ') : '  ✓';
      console.log('     ' + r.mk + '  frozen ₪' + r.frozen + '  tariff ₪' + r.expected +
        '  paid=' + r.paid + '  paidAmt ₪' + r.paidAmount + '  (' + r.date + ', ' + r.type + ')' + tag);
    });
  }
  console.log('');
}

// ── Summary ───────────────────────────────────────────────────────
console.log('══════════════════════════════════════════════════════════');
if (flaggedTotal === 0) {
  console.log(' ✅ no flagged records. Tariff table and paymentHistory agree.');
} else {
  console.log(' 🚩 ' + flaggedTotal + ' flagged record(s).');
  if (phantomSum !== 0) {
    console.log('    net tariff mismatch across flagged records: ₪' + Math.round(phantomSum * 100) / 100);
    console.log('    (a positive number is likely legacy phantom-debt frozen before v2.13.16 —');
    console.log('     clean per-tenant with /api/fix-payment-history {mode:\'inconsistent\'}, NOT mode:\'all\')');
  }
}
console.log('══════════════════════════════════════════════════════════');
console.log('');
