#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// inspect-extra-close.js — READ-ONLY (v2.14.77, 1ד, decision ד7-A)
// ════════════════════════════════════════════════════════════════
// Until v2.14.76 the extra-account month close (closeExtraAccountsUnpaid) lost money
// silently in two cases that v2.14.77 fixes going FORWARD only (the past is not
// rewritten — ד7-A):
//   • a PARTIAL payment: the shortfall never accrued to acc.openingDebt
//   • a payment in a month with NO charge (suspended, not a billing month, amount 0):
//     the close skipped the month, so the payment never became credit
// plus one side effect: an UNPAID record left in a skipped month is still counted as
// debt by extraAccountSplit (histDebt).
// This script lists those cases in already-CLOSED extra months, so Tal can decide per
// building whether anything needs a manual fix. It NEVER writes. It reuses the REAL
// helpers from server.js (extraAmountForMonth, crSuspendedIn) — no copies.
//
// USAGE:
//   node scripts/inspect-extra-close.js <file.json | tenantDataId>
//     file.json      a building data file or a downloaded backup (vaad-backup-*.json)
//     tenantDataId   data file name without .json, read from DATA_DIR (Railway: /app/data)
// Exit code: 0 = nothing found, 1 = cases found, 2 = usage / file error.

const fs = require('fs');
const path = require('path');
const lib = require('./test-lib');

const arg = process.argv[2];
if (!arg) { console.error('usage: node scripts/inspect-extra-close.js <file.json | tenantDataId>'); process.exit(2); }
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const file = fs.existsSync(arg) ? arg : path.join(DATA_DIR, arg.replace(/\.json$/, '') + '.json');
if (!fs.existsSync(file)) { console.error('❌ file not found: ' + file); process.exit(2); }

let raw;
try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error('❌ not valid JSON: ' + e.message); process.exit(2); }

// A building object, or a container whose values are buildings.
const buildings = Array.isArray(raw && raw.tenants) ? [['(file)', raw]]
  : Object.entries(raw || {}).filter(([, v]) => v && Array.isArray(v.tenants));
if (!buildings.length) { console.error('❌ no building data (tenants[]) found in ' + file); process.exit(2); }

const src = lib.readSource('server.js');
const H = lib.runInSandbox(lib.extractFunctions(src, lib.EXTRA_AMOUNT_FNS) + 'module.exports={extraAmountForMonth,crSuspendedIn,extraBillsInMonth};');
const r2 = n => Math.round(n * 100) / 100;

let found = 0;
for (const [bid, d] of buildings) {
  const closed = Array.isArray(d.closedMonthsExtra) ? d.closedMonthsExtra.slice().sort() : [];
  const rows = [];
  for (const t of (d.tenants || [])) {
    for (const acc of (t.extraAccounts || [])) {
      if (acc.active === false) continue;
      const hist = ((d.paymentHistory || {})[String(t.id) + '__acc__' + acc.id]) || [];
      for (const M of closed) {
        const rec = hist.find(r => r.month === M);
        if (!rec) continue;
        const billing = H.extraBillsInMonth(d, acc, M);   // v2.14.80 (ה6) — the REAL billing-months resolver
        const dated = H.extraAmountForMonth(d, acc, M);
        const suspended = H.crSuspendedIn(acc, M);
        const amount = (billing && !suspended && dated > 0) ? dated : 0;
        const why = !billing ? 'לא חודש חיוב' : suspended ? 'מושהה' : dated > 0 ? '' : 'סכום 0';
        if (!rec.paid) {
          if (amount === 0) rows.push([t.name, acc.label, M, 'רשומה לא משולמת בחודש בלי חיוב (' + why + ') — נספרת כחוב', r2(parseFloat(rec.amount) || 0)]);
          continue;
        }
        const expected = amount > 0 ? (parseFloat(rec.amount ?? amount) || amount) : 0;
        const paid = parseFloat(rec.paidAmount ?? rec.amount ?? expected) || 0;
        const diff = r2(paid - expected);
        if (amount === 0 && paid > 0 && !rec.creditBanked) rows.push([t.name, acc.label, M, 'תשלום בחודש בלי חיוב (' + why + ') — זכות שלא נצברה', paid]);
        else if (diff < 0 && !rec.shortfallBanked) rows.push([t.name, acc.label, M, 'תשלום חלקי ' + paid + '/' + expected + ' — מחסור שלא נצבר', -diff]);
      }
    }
  }
  console.log('\n══ ' + bid + ' — חודשים סגורים בחשבונות נוספים: ' + (closed.join(', ') || '(אין)'));
  if (!rows.length) { console.log('  ✓ לא נמצאו מקרים'); continue; }
  found += rows.length;
  rows.forEach(r => console.log('  • ' + r[0] + ' · ' + r[1] + ' · ' + r[2] + ' · ' + r[3] + ' · ₪' + r[4]));
}
console.log('\nסה"כ מקרים: ' + found + '  (קריאה בלבד — שום דבר לא נכתב)');
process.exit(found ? 1 : 0);
