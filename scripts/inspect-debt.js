#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// inspect-debt.js — READ-ONLY debt-breakdown diagnostic
// ════════════════════════════════════════════════════════════════
// Prints, per tenant, EXACTLY how totalDebt / creditBalance are built up:
//   • openingDebt (raw, on disk — may be negative = banked credit)
//   • every paymentHistory record  {month, expected(amount), paidAmount, paid, type, shortfallBanked}
//   • every main-account sentLog value + the credit/shortfall calcMonthBalance derives from it
//   • the final calcTotalDebt / getCreditBalance the server would ship to the UI
//   • a plain-language "why" line reconciling opening + charges − paid
//
// Purpose: the multi-month bank-import discrepancies (a tenant who paid two
// months in one file showing a wrong remaining debt/credit). This shows whether
// the number comes from a stale openingDebt, a collapsed month record, or the
// getDerivedCredit==0 boundary. It NEVER writes and never touches the server —
// safe on live prod. It reuses the REAL money functions extracted from
// server.js (no copies), so what it prints is what the server computes.
//
// USAGE:
//   node scripts/inspect-debt.js <tenantDataId> [nameFilter]
//     <tenantDataId>  data file name without .json (e.g. e17cab8f-...)
//     [nameFilter]    optional — only show tenants whose name includes this text
//                     (e.g. "אלתר" to see just צבי אלתר)
//   DATA_DIR env var points at the data dir (Railway: /app/data).

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const arg        = process.argv[2];
const nameFilter = process.argv[3] || '';

if (!arg || arg.startsWith('--')) {
  console.error('usage: node scripts/inspect-debt.js <tenantDataId> [nameFilter]');
  console.error('  DATA_DIR = ' + DATA_DIR);
  process.exit(2);
}
const file = path.join(DATA_DIR, arg.replace(/\.json$/, '') + '.json');
if (!fs.existsSync(file)) {
  console.error('❌ data file not found: ' + file);
  console.error('   (set DATA_DIR — on Railway it is /app/data)');
  process.exit(2);
}

// ── Extract the REAL money functions from server.js (no copies) ───
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
const monthsDecl = (serverSrc.match(/const HEBREW_MONTHS = \[[^\]]*\];/) || [''])[0];
const helperNames = [
  'hebMonthToMonthKey', 'parseSentLogAmount', 'sentLogIsPayment', 'getExpectedAmount',
  'monthInInterval', 'pickRateFromIntervals', 'resolveTariffRate',
  'calcMonthBalance', 'getDerivedCredit', 'calcShortfallFromSentLog',
  'calcTotalDebt', 'getCreditBalance'
];
const sandbox = { module: { exports: {} }, console, Date, JSON, Math, parseFloat, parseInt, isNaN, Number, String, Object, Array };
vm.createContext(sandbox);
vm.runInContext(
  monthsDecl + '\n' + extractFns(serverSrc, helperNames) +
  'module.exports={' + helperNames.join(',') + ',HEBREW_MONTHS};',
  sandbox
);
const S = sandbox.module.exports;
const HEB = S.HEBREW_MONTHS;

// ── Load data ─────────────────────────────────────────────────────
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const tenants = (d.tenants || []).filter(t =>
  !nameFilter || String(t.name || '').includes(nameFilter));
const now    = new Date();
const nowKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

console.log('');
console.log('══════════════════════════════════════════════════════════');
console.log(' Debt breakdown — ' + path.basename(file));
console.log(' building default (config.amount): ₪' + ((d.config && d.config.amount) || '(unset)'));
console.log(' now: ' + nowKey + (nameFilter ? '   filter: "' + nameFilter + '"' : ''));
console.log('══════════════════════════════════════════════════════════');

for (const t of tenants) {
  const tid  = String(t.id);
  const hist = (d.paymentHistory || {})[tid] || [];
  const opening = parseFloat(t.openingDebt) || 0;
  const live = t.customAmount || (d.config && d.config.amount) || 300;

  const totalDebt = S.calcTotalDebt(d, tid, nowKey);
  const credit    = S.getCreditBalance(d, tid);
  const sf        = S.calcShortfallFromSentLog(d, tid, {});

  console.log('\n────────────────────────────────────────────────────────');
  console.log('👤 ' + (t.name || '(no name)') + '   [id ' + tid + ']');
  console.log('   customAmount: ₪' + (t.customAmount ?? '(default)') +
              '    openingDebt (raw): ₪' + opening + (opening < 0 ? '  ⚠️ NEGATIVE = banked credit' : ''));

  // paymentHistory records
  if (!hist.length) {
    console.log('   paymentHistory: (none)');
  } else {
    console.log('   paymentHistory:');
    hist.forEach(r => {
      const bar = r.type === 'wa_sent' ? '·' : (r.paid ? '✓' : '✗');
      const sb  = r.shortfallBanked ? '  shortfallBanked' : '';
      console.log('     ' + bar + ' ' + (r.month || '?') +
                  '  expected ₪' + (r.amount ?? '?') +
                  '  paid ₪' + (r.paidAmount ?? r.amount ?? '?') +
                  '  [' + (r.type || '?') + ']' + sb);
    });
  }

  // sentLog main-account values + derived balance
  const slKeys = Object.keys(d.sentLog || {})
    .filter(k => !k.includes('__acc__'))
    .filter(k => { const sep = k.lastIndexOf('_'); return sep > 0 && k.slice(0, sep) === tid; });
  if (slKeys.length) {
    console.log('   sentLog (main account):');
    slKeys.forEach(k => {
      const heb = k.slice(k.lastIndexOf('_') + 1);
      const idx = HEB.indexOf(heb);
      const mk  = idx >= 0 ? nowKey.split('-')[0] + '-' + String(idx + 1).padStart(2, '0') : null;
      const expected = mk ? S.getExpectedAmount(hist, mk, live) : live;
      const bal = S.calcMonthBalance(d.sentLog[k], expected);
      const val = String(d.sentLog[k]);
      const short = val.length > 46 ? val.slice(0, 44) + '…' : val;
      console.log('     ' + heb + ' → paid ₪' + bal.paidAmount + ' / expected ₪' + bal.expected +
                  '  ⇒ ' + bal.status +
                  (bal.credit ? '  credit ₪' + bal.credit : '') +
                  (bal.shortfall ? '  shortfall ₪' + bal.shortfall : ''));
      console.log('        raw: ' + short);
    });
  }

  // The final numbers + reconciliation
  console.log('   ── derived (what the UI shows) ──');
  console.log('     calcShortfallFromSentLog: shortfall ₪' + sf.total + '   credit ₪' + sf.creditTotal);
  console.log('     getDerivedCredit(guard):  ' +
              (opening < 0 ? '0 (suppressed — openingDebt<0)' : '₪' + sf.creditTotal + (opening === 0 ? '  ⚠️ opening==0, guard does NOT suppress' : '')));
  console.log('     ➜ totalDebt   = ₪' + totalDebt);
  console.log('     ➜ credit      = ₪' + credit);
}

console.log('\n══════════════════════════════════════════════════════════');
console.log(' READ-ONLY. Nothing was written. To fix, we design from these facts.');
console.log('══════════════════════════════════════════════════════════\n');
