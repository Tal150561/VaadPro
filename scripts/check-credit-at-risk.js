#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// check-credit-at-risk.js — READ-ONLY (v2.14.62)
// ════════════════════════════════════════════════════════════════
// Before v2.14.62, closing a month UNPAID did `Math.max(0, openingDebt) + amount`
// (main: closeMonthUnpaidForBuilding ×2, extra: closeExtraAccountsUnpaid ×2), so a
// CREDIT (negative openingDebt) was WIPED and a debt opened instead.
//
// Part 1 — "what the next close does": runs the REAL close functions from
//   server.js on an in-memory COPY, twice — once with the legacy clamp restored
//   (the 4 lines reverted in the source text) and once as shipped — and lists
//   every main/extra account whose result differs. Nothing is written.
//   • Run BEFORE deploying v2.14.62 → who would have lost credit at the close.
//   • Run AFTER  → the same list shows the credit each member now KEEPS.
// Part 2 — "suspected past wipes" (HEURISTIC, main account only): a member whose
//   history shows a credit banked at a close (debtOffset.newCredit > 0), followed
//   by a LATER closed month with no paid record, whose openingDebt is now >= 0.
//   Check each one against a backup from before that later close. Extra accounts
//   keep no banked-credit receipt, so they cannot be detected this way.
//
// USAGE:
//   node scripts/check-credit-at-risk.js <tenantDataId>      one building
//   node scripts/check-credit-at-risk.js --all               every building in DATA_DIR
//   options: --month YYYY-MM   the month to close (default: the previous calendar month)
//   DATA_DIR env var points at the data dir (Railway: /app/data).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const args = process.argv.slice(2);
const monthIdx = args.indexOf('--month');
let prevKey = monthIdx !== -1 ? args[monthIdx + 1] : null;
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--month');
if (!target && !args.includes('--all')) {
  console.error('usage: node scripts/check-credit-at-risk.js <tenantDataId> | --all  [--month YYYY-MM]');
  console.error('  DATA_DIR = ' + DATA_DIR);
  process.exit(2);
}
if (!prevKey) {
  const n = new Date();
  const p = new Date(n.getFullYear(), n.getMonth() - 1, 1);
  prevKey = p.getFullYear() + '-' + String(p.getMonth() + 1).padStart(2, '0');
}
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(prevKey)) { console.error('❌ bad --month: ' + prevKey); process.exit(2); }

// ── Load the REAL close functions (as shipped + legacy-clamp variant) ──
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function extract(src, name) {
  const m = src.match(new RegExp('^function ' + name + '\\s*\\([\\s\\S]*?^\\}', 'm'));
  if (!m) throw new Error('function not found in server.js: ' + name);
  return m[0];
}
const MONTHS_SRC = SRC.match(/const HEBREW_MONTHS = \[[^\]]*\];/)[0];
function load(src) {
  const quiet = { log() {}, warn() {}, error() {} };
  const ctx = { module: { exports: {} }, console: quiet, Math, parseFloat, String, Array, Object, Number, JSON };
  vm.createContext(ctx);
  vm.runInContext(MONTHS_SRC + '\n' + extract(src, 'closeMonthUnpaidForBuilding') + '\n' + extract(src, 'closeExtraAccountsUnpaid') +
    '\nmodule.exports={closeMonthUnpaidForBuilding,closeExtraAccountsUnpaid,HEBREW_MONTHS};', ctx);
  return ctx.module.exports;
}
const NEW = load(SRC);
const LEGACY_SRC = SRC
  .split('((parseFloat(tenant.openingDebt) || 0) + amount)').join('(Math.max(0, parseFloat(tenant.openingDebt) || 0) + amount)')
  .split('((parseFloat(acc.openingDebt) || 0) + amount)').join('(Math.max(0, parseFloat(acc.openingDebt) || 0) + amount)');
const OLD = load(LEGACY_SRC);
const shipsFix = LEGACY_SRC !== SRC;
const prevHeb = NEW.HEBREW_MONTHS[Number(prevKey.slice(5)) - 1];

function runClose(mod, d) {
  const c = JSON.parse(JSON.stringify(d));
  if (!c.paymentHistory) c.paymentHistory = {};
  mod.closeMonthUnpaidForBuilding(c, prevKey, prevHeb);
  const extraClosed = Array.isArray(c.closedMonthsExtra) && c.closedMonthsExtra.includes(prevKey);
  if (!extraClosed) (c.tenants || []).forEach(t => mod.closeExtraAccountsUnpaid(c, t, prevKey));
  return c;
}
const fmt = n => { const v = Math.round((parseFloat(n) || 0) * 100) / 100; return v < 0 ? 'זכות ' + (-v) : (v > 0 ? 'חוב ' + v : '0'); };

function checkBuilding(id, d) {
  const out = [];
  const name = (d.config && d.config.buildingName) || id;
  out.push('\n══ ' + name + '  (' + id + ') ══');
  if (!Array.isArray(d.tenants)) { out.push('  (no tenants)'); return { out, risk: 0, suspect: 0 }; }

  // Part 1
  let risk = 0;
  if (Array.isArray(d.closedMonths) && d.closedMonths.includes(prevKey)) {
    out.push('  1) ' + prevKey + ' כבר נסגר לחשבון הראשי — אין סגירה ממתינה.');
  }
  const a = runClose(OLD, d), b = runClose(NEW, d);
  d.tenants.forEach((t, i) => {
    const ta = a.tenants[i], tb = b.tenants[i];
    if ((parseFloat(ta.openingDebt) || 0) !== (parseFloat(tb.openingDebt) || 0)) {
      risk++;
      out.push('  ⚠️  ' + (t.name || t.id) + ' · ראשי: היום ' + fmt(t.openingDebt) + ' → בקוד הישן ' + fmt(ta.openingDebt) + ' | בקוד המתוקן ' + fmt(tb.openingDebt));
    }
    (t.extraAccounts || []).forEach((acc, j) => {
      const xa = ta.extraAccounts[j], xb = tb.extraAccounts[j];
      if ((parseFloat(xa.openingDebt) || 0) !== (parseFloat(xb.openingDebt) || 0)) {
        risk++;
        out.push('  ⚠️  ' + (t.name || t.id) + ' · ' + (acc.label || acc.id) + ': היום ' + fmt(acc.openingDebt) + ' → בקוד הישן ' + fmt(xa.openingDebt) + ' | בקוד המתוקן ' + fmt(xb.openingDebt));
      }
    });
  });
  if (!risk) out.push('  1) סגירת ' + prevKey + ': אין אף חשבון בזכות שהסגירה הייתה מאפסת. ✓');

  // Part 2 (heuristic)
  let suspect = 0;
  const closed = new Set(d.closedMonths || []);
  d.tenants.forEach(t => {
    if (t.suspended === true) return;
    const hist = (d.paymentHistory || {})[String(t.id)] || [];
    const banked = hist.filter(r => r && r.paid && r.debtOffset && parseFloat(r.debtOffset.newCredit) > 0 && closed.has(r.month))
      .sort((x, y) => String(x.month).localeCompare(String(y.month)));
    if (!banked.length) return;
    const last = banked[banked.length - 1];
    const laterUnpaid = [...closed].filter(m => m > last.month && !hist.some(r => r.month === m && r.paid)).sort();
    if (laterUnpaid.length && (parseFloat(t.openingDebt) || 0) >= 0) {
      suspect++;
      out.push('  🔎 ' + (t.name || t.id) + ': נצברה זכות ' + last.debtOffset.newCredit + ' בסגירת ' + last.month +
        ', אחר כך ' + laterUnpaid[0] + ' נסגר ללא תשלום, והיום ' + fmt(t.openingDebt) + ' — חשד שהזכות נמחקה. בדקו מול גיבוי מלפני סגירת ' + laterUnpaid[0] + '.');
    }
  });
  if (!suspect) out.push('  2) לא נמצא חשד למחיקת זכות בעבר (חשבון ראשי).');
  return { out, risk, suspect };
}

const files = args.includes('--all')
  ? fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'))
  : [String(target).replace(/\.json$/, '') + '.json'];
console.log('VaadPro — בדיקת זכויות (קריאה בלבד) · חודש לסגירה: ' + prevKey + ' (' + prevHeb + ')' +
  (shipsFix ? '' : '  ⚠️ server.js כאן עדיין בלי תיקון v2.14.62'));
let totalRisk = 0, totalSuspect = 0, scanned = 0;
for (const f of files) {
  const full = path.join(DATA_DIR, f);
  if (!fs.existsSync(full)) { console.error('❌ data file not found: ' + full + '  (set DATA_DIR — on Railway it is /app/data)'); process.exit(2); }
  let d;
  try { d = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { continue; }
  if (!d || !Array.isArray(d.tenants)) continue;       // users.json, tokens, etc.
  scanned++;
  const r = checkBuilding(f.replace(/\.json$/, ''), d);
  totalRisk += r.risk; totalSuspect += r.suspect;
  if (r.risk || r.suspect || !args.includes('--all')) console.log(r.out.join('\n'));
}
console.log('\nסיכום: ' + scanned + ' בניינים · ' + totalRisk + ' חשבונות שהסגירה הבאה משפיעה עליהם · ' + totalSuspect + ' חשדות מהעבר.');
