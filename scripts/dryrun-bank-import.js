#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// dryrun-bank-import.js — PREVIEW a bank-file import. WRITES NOTHING.
// ════════════════════════════════════════════════════════════════
// Runs the REAL server-side analyzer (analyzeBankRowsServer, extracted live
// from server.js via test-lib.loadBankAnalyzer — never copied) against a real
// building's tenants and a real bank file, and prints how each matched payment
// would be split across months (#3). It does NOT touch disk, sentLog, or debt.
//
// USAGE (Railway shell, from /app):
//   node scripts/dryrun-bank-import.js <dataFile.json> <bankFile.xlsx|csv> \
//        [--amount=N] [--tol=5] [--col-name=I] [--col-amount=I] \
//        [--col-date=I] [--col-note=I] [--month=YYYY-MM] [--header-rows=1]
//
//   <dataFile.json>  path to the building's data JSON (e.g. data/<id>.json)
//   <bankFile>       the .xlsx / .xls / .csv you would upload
//
// If you omit the column indexes, the script prints the header row with its
// column numbers so you can re-run with the right --col-* flags.
//
// Everything is READ-ONLY. Re-run as many times as you like.

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const lib = require('./test-lib');

function die(msg) { console.error('\n❌ ' + msg + '\n'); process.exit(1); }

// ── args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = {};
for (const a of args.filter(a => a.startsWith('--'))) {
  const [k, v] = a.replace(/^--/, '').split('=');
  flags[k] = v === undefined ? true : v;
}
const [dataFile, bankFile] = positional;
if (!dataFile || !bankFile) {
  die('usage: node scripts/dryrun-bank-import.js <dataFile.json> <bankFile.xlsx|csv> [--col-*=I ...]');
}
if (!fs.existsSync(dataFile)) die('data file not found: ' + dataFile);
if (!fs.existsSync(bankFile)) die('bank file not found: ' + bankFile);

// ── load data (tenants + config + existing sentLog) READ-ONLY ─────
const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const tenants = data.tenants || [];
const config = data.config || {};
const sentLog = data.sentLog || {}; // passed in so "already paid" months are respected, but NOT mutated
if (!tenants.length) die('no tenants in ' + dataFile);

// ── parse the bank file into a rows array (array-of-arrays) ───────
const wb = XLSX.readFile(bankFile, { cellDates: false });
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: true });
if (!rows.length) die('bank file has no rows');

const headerRows = parseInt(flags['header-rows'] ?? 1);
// analyzeBankRowsServer treats rows[0] as the header and slices from row 1,
// so if the file has N header rows we drop the extra N-1 here.
const trimmed = headerRows > 1 ? [rows[headerRows - 1], ...rows.slice(headerRows)] : rows;

// ── if no column mapping given, show the header and bail (read-only) ─
const haveMapping = ['col-name', 'col-amount', 'col-date'].some(k => flags[k] !== undefined);
if (!haveMapping) {
  console.log('\n📄 First rows of the bank file (0-indexed columns):\n');
  const header = trimmed[0] || [];
  header.forEach((c, i) => console.log('   col ' + i + ':  ' + JSON.stringify(c)));
  console.log('\n   sample data row:');
  (trimmed[1] || []).forEach((c, i) => console.log('   col ' + i + ':  ' + JSON.stringify(c)));
  console.log('\n➜ Re-run with the right columns, e.g.:');
  console.log('   node scripts/dryrun-bank-import.js ' + dataFile + ' ' + bankFile +
    ' --col-name=0 --col-amount=2 --col-date=1 [--amount=217 --tol=5]\n');
  process.exit(0);
}

const mapping = {
  colName:   flags['col-name']   ?? -1,
  colAmount: flags['col-amount'] ?? -1,
  colDate:   flags['col-date']   ?? -1,
  colNote:   flags['col-note']   ?? -1,
  bankAmount: flags['amount'] ?? '',
  bankTolerance: flags['tol'] ?? 5,
};

const monthKey = flags['month'] || null; // fallback month for undated rows (defaults to config month)

// ── run the REAL analyzer (extracted from live server.js) ─────────
const B = lib.loadBankAnalyzer();
// pass a FRESH empty Set for importedFingerprints so we see the full picture;
// the real sentLog is passed so extra-account "already paid" months are honoured.
const result = B.analyzeBankRowsServer(trimmed, mapping, tenants, sentLog, monthKey, config, new Set());

// ── debt BEFORE vs AFTER (READ-ONLY computed preview) ─────────────
// Import does NOT touch openingDebt (Fix #0). What changes is the LIVE debt the
// UI shows: newly-marked months stop counting as a shortfall. We compute each
// tenant's totalDebt/credit against (a) the current sentLog and (b) the sentLog
// merged with the keys this import WOULD add — nothing is written.
let debtFns = null;
try { debtFns = lib.loadServer(); } catch (e) { /* debt preview optional */ }
const mergedSentLog = Object.assign({}, sentLog, result.newSentLog || {});
const nowMk = monthKey || (config && config.manualMonth ? null : null);
function debtSnapshot(fns, dataObj, tid) {
  // build a minimal tenantData shape the debt fns expect
  const td = { tenants: dataObj.tenants, config: dataObj.config, paymentHistory: dataObj.paymentHistory || {}, sentLog: dataObj.sentLog };
  const total = fns.calcTotalDebt(td, tid, nowMk || undefined);
  const credit = fns.getCreditBalance(td, tid);
  return { total, credit };
}

// ── report ────────────────────────────────────────────────────────
const HE = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
console.log('\n══════════════════════════════════════════════════════════');
console.log(' DRY-RUN bank import — ' + path.basename(bankFile));
console.log(' data: ' + path.basename(dataFile) + '   |   config.amount: ₪' + (config.amount ?? '—'));
console.log(' fallback month (undated rows): ' + (monthKey || '(config month)'));
console.log(' ⚠️  READ-ONLY — nothing was written.');
console.log('══════════════════════════════════════════════════════════\n');

// Diff the returned sentLog against the existing one to show ONLY new keys.
const before = new Set(Object.keys(sentLog));
const newMain = Object.keys(result.newSentLog || {}).filter(k => !before.has(k));

console.log('✅ MATCHED tenants: ' + result.matched.length +
            '   |   ✖ unmatched: ' + result.unmatched.length +
            '   |   duplicate-warnings: ' + (result.duplicateWarnings || []).length + '\n');

let multiMonth = 0;
for (const m of result.matched) {
  const split = m.monthsSplit || 1;
  if (split > 1) multiMonth++;
  const flag = split > 1 ? '  🔀 SPLIT across ' + split + ' months' : '';
  console.log('  👤 ' + m.name + '  —  ₪' + m.amount + flag);
  // show which month keys this tenant would get
  const mine = newMain.filter(k => k.startsWith(m.tenantId + '_'));
  mine.forEach(k => {
    const heb = k.split('_').slice(1).join('_');
    const val = result.newSentLog[k];
    const sum = (String(val).match(/_(\d+(?:\.\d+)?)_payer_/) || [])[1] || '?';
    console.log('       → ' + heb + '   ₪' + sum);
  });
  // debt before → after (read-only computed)
  if (debtFns) {
    try {
      const before = debtSnapshot(debtFns, { tenants, config, paymentHistory: data.paymentHistory, sentLog }, m.tenantId);
      const after  = debtSnapshot(debtFns, { tenants, config, paymentHistory: data.paymentHistory, sentLog: mergedSentLog }, m.tenantId);
      const delta = Math.round((before.total - after.total) * 100) / 100;
      const arrow = delta > 0 ? '  (⬇ חוב ירד ב-₪' + delta + ')' : (delta < 0 ? '  (⚠ חוב עלה ₪' + (-delta) + ')' : '  (ללא שינוי בחוב)');
      console.log('       חוב: ₪' + before.total + '  →  ₪' + after.total + arrow +
                  (after.credit ? '   קרדיט: ₪' + after.credit : ''));
    } catch (e) { /* skip debt line if shape mismatch */ }
  }
}

// extra-account splits (paymentHistory additions)
const extraPH = result.newPaymentHistory || {};
const extraKeys = Object.keys(extraPH);
if (extraKeys.length) {
  console.log('\n  ── extra / collection accounts (__acc__) ──');
  for (const phKey of extraKeys) {
    for (const rec of extraPH[phKey]) {
      console.log('  ' + phKey + '   → ' + rec.month + '   ₪' + rec.paidAmount);
    }
  }
}

if ((result.duplicateWarnings || []).length) {
  console.log('\n  ⚠️  in-file duplicates (counted once, not dropped silently):');
  for (const d of result.duplicateWarnings) {
    console.log('     ' + d.name + '  ₪' + d.amount + '  ' + d.date + '  [' + d.scope + ']');
  }
}

console.log('\n──────────────────────────────────────────────────────────');
console.log(' #3 check: ' + multiMonth + ' tenant(s) had payments SPLIT across >1 month.');
if (multiMonth === 0) {
  console.log(' (Single-month file → behaviour identical to pre-#3. To exercise the');
  console.log('  split, use a file whose rows span more than one calendar month.)');
} else {
  console.log(' Each payment above lands in ITS OWN month — no phantom overpayment.');
}
console.log(' READ-ONLY. Nothing was written.');
console.log('══════════════════════════════════════════════════════════\n');
