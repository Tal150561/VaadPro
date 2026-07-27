#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// fix-yearboundary-paymenthistory.js — one-shot remediation for the
// v2.14.7 year-boundary mis-tag (July filed as 2025-07 instead of 2026-07)
// ════════════════════════════════════════════════════════════════
// THE BUG IT REPAIRS (fixed at source in v2.14.7): the old hebMonthToMonthKey
// flipped ANY forward month to the previous year. A multi-month bank file whose
// selected reference month was earlier than some rows (e.g. selected יוני, file
// also had יולי) filed those forward months a YEAR EARLY in paymentHistory.
// The sentLog key (tenantId_<hebMonth>) is CORRECT — only the DERIVED
// paymentHistory.month is wrong. This script re-derives the correct month for
// every paymentHistory record from its tenant's sentLog key, using the FIXED
// resolver, and remaps only the records whose month disagrees.
//
// SAFETY MODEL (identical discipline to the manual-fix recipe in the SKILL):
//   • Single building only (the id you pass). Never touches other buildings.
//   • DRY-RUN by default — prints exactly what WOULD change, writes nothing.
//     Pass --apply to actually write.
//   • Atomic backup first: writes <id>.manualfix-<ts>.json BEFORE any change
//     (suffix is NOT .bak — that collides with the system's own recovery files).
//   • Only paymentHistory.month is rewritten. openingDebt, sentLog, amounts,
//     paid flags, shortfallBanked/creditBanked, tenants, config, tariffs — all
//     left byte-untouched.
//   • MERGE GUARD: if a tenant already has a record for the corrected month
//     (would be a duplicate), the script REFUSES to auto-merge and lists the
//     collision for manual handling — never silently combines two records.
//
// USAGE:
//   node scripts/fix-yearboundary-paymenthistory.js <tenantDataId>            # dry-run
//   node scripts/fix-yearboundary-paymenthistory.js <tenantDataId> --apply    # write
//   DATA_DIR env var points at the data dir (Railway: /app/data).

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const arg   = process.argv[2];
const apply = process.argv.includes('--apply');

if (!arg || arg.startsWith('--')) {
  console.error('usage: node scripts/fix-yearboundary-paymenthistory.js <tenantDataId> [--apply]');
  console.error('  DATA_DIR = ' + DATA_DIR);
  process.exit(2);
}
const file = path.join(DATA_DIR, arg.replace(/\.json$/, '') + '.json');
if (!fs.existsSync(file)) {
  console.error('no such data file: ' + file);
  process.exit(2);
}

// The HEBREW_MONTHS order + the FIXED resolver, kept in sync with server.js
// v2.14.7. (Copied deliberately: this is a standalone one-shot tool, not part of
// the server; the money tests own the canonical resolver.)
const HEBREW_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי',
                       'אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
function hebMonthToMonthKey(hebMonth, refMonthKey) {
  const monthIdx = HEBREW_MONTHS.indexOf(hebMonth);
  if (monthIdx < 0) return null;
  const monthNum = monthIdx + 1;
  const parts = String(refMonthKey).split('-');
  let year = parseInt(parts[0], 10);
  const refMon = parseInt(parts[1], 10);
  if (!Number.isFinite(year) || !Number.isFinite(refMon)) return null;
  if (monthNum - refMon > 6) year -= 1;
  return year + '-' + String(monthNum).padStart(2, '0');
}

const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const ph = d.paymentHistory || {};
const sl = d.sentLog || {};
const tenants = {};
(d.tenants || []).forEach(t => { tenants[String(t.id)] = t.name; });

// Reference month for re-derivation: the building's current effective month.
// This mirrors what the POST /api/data sync loop uses (bankMonthOverride ||
// current month). effectiveMonth is a Hebrew name; convert to YYYY-MM using the
// same anchor the app uses (current calendar year for the effective month).
const now = new Date();
const effHeb = d.effectiveMonth || HEBREW_MONTHS[now.getMonth()];
const effIdx = HEBREW_MONTHS.indexOf(effHeb);
const refYear = now.getFullYear();
const refMk = refYear + '-' + String((effIdx >= 0 ? effIdx : now.getMonth()) + 1).padStart(2, '0');

// Build the set of correct months per tenant from sentLog keys (the source of
// truth). Key shape: <tenantId>_<hebMonth>  (skip __acc__ and legacy ISO keys).
// A record's month is "correct" if it equals the resolver output for SOME
// sentLog hebMonth key of that tenant.
function correctMonthsForTenant(tid) {
  const out = new Set();
  Object.keys(sl).forEach(key => {
    if (key.includes('__acc__')) return;
    const sep = key.lastIndexOf('_');
    if (sep < 0) return;
    if (key.slice(0, sep) !== tid) return;
    const heb = key.slice(sep + 1);
    const mk = hebMonthToMonthKey(heb, refMk);
    if (mk) out.add(mk);
  });
  return out;
}

const changes = [];      // {tid, name, from, to, idx}
const collisions = [];   // {tid, name, from, to}
const unmatched = [];    // records whose month matches no sentLog key (left alone)

Object.keys(ph).forEach(tid => {
  const recs = ph[tid];
  if (!Array.isArray(recs)) return;
  const correct = correctMonthsForTenant(tid);
  if (!correct.size) return; // no sentLog basis → don't touch this tenant
  const existingMonths = new Set(recs.map(r => r.month));
  recs.forEach((r, idx) => {
    if (!r || !r.month) return;
    if (correct.has(r.month)) return; // already correct
    // This record's month is NOT one of the tenant's correct months.
    // Find the correct month with the SAME calendar month (MM) — that's the
    // one the mis-tag came from (only the year was wrong).
    const mm = String(r.month).split('-')[1];
    let target = null;
    correct.forEach(c => { if (String(c).split('-')[1] === mm) target = c; });
    if (!target) { unmatched.push({ tid, name: tenants[tid] || '?', month: r.month }); return; }
    if (target === r.month) return;
    if (existingMonths.has(target)) {
      collisions.push({ tid, name: tenants[tid] || '?', from: r.month, to: target });
      return;
    }
    changes.push({ tid, name: tenants[tid] || '?', from: r.month, to: target, idx,
                   amount: r.amount, paidAmount: r.paidAmount, type: r.type });
  });
});

console.log('── year-boundary paymentHistory fix ──');
console.log('building : ' + arg);
console.log('reference: ' + refMk + '  (effectiveMonth "' + effHeb + '")');
console.log('mode     : ' + (apply ? 'APPLY (will write)' : 'DRY-RUN (no write)'));
console.log('');

if (!changes.length && !collisions.length) {
  console.log('✓ nothing to fix — every paymentHistory record already agrees with its sentLog month.');
  process.exit(0);
}

if (changes.length) {
  console.log('records to REMAP (month field only):');
  changes.forEach(c => {
    console.log('  ' + c.tid + '  ' + (c.name || '') +
      '  | ' + c.from + ' → ' + c.to +
      '  | amount ' + c.amount + ', paidAmount ' + c.paidAmount + ', type ' + c.type);
  });
  console.log('  (' + changes.length + ' record' + (changes.length === 1 ? '' : 's') + ')');
}
if (collisions.length) {
  console.log('');
  console.log('⚠️  COLLISIONS — a correct-month record already exists; NOT auto-merged:');
  collisions.forEach(c => console.log('  ' + c.tid + '  ' + c.name + '  | ' + c.from + ' → ' + c.to + ' (target exists)'));
  console.log('  Handle these by hand (decide which record survives).');
}
if (unmatched.length) {
  console.log('');
  console.log('note — records with no matching sentLog key (LEFT UNTOUCHED):');
  unmatched.forEach(u => console.log('  ' + u.tid + '  ' + u.name + '  | ' + u.month));
}

if (!apply) {
  console.log('');
  console.log('DRY-RUN only. Re-run with --apply to write the ' + changes.length + ' remap(s).');
  process.exit(0);
}

// APPLY — back up first, then rewrite only the month fields.
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backup = file.replace(/\.json$/, '') + '.manualfix-' + ts + '.json';
fs.writeFileSync(backup, JSON.stringify(d, null, 2));
console.log('');
console.log('backup written: ' + path.basename(backup));

changes.forEach(c => { ph[c.tid][c.idx].month = c.to; });
// atomic write: tmp → rename
const tmp = file + '.tmp-' + ts;
fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
fs.renameSync(tmp, file);
console.log('✓ applied ' + changes.length + ' remap(s) to ' + path.basename(file));
if (collisions.length) console.log('⚠️  ' + collisions.length + ' collision(s) still need manual handling (see above).');
