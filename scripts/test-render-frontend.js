// ════════════════════════════════════════════════════════════════
// test-render-frontend.js — EXECUTES real code from app.html / portal
// Run: npm test    (or: node scripts/test-render-frontend.js)
// ════════════════════════════════════════════════════════════════
// ⚠️⚠️ WHY THIS FILE EXISTS — read before deleting or weakening it.
//
// v2.13.10 removed the local debt math from app.html but left the debtCell
// branches referencing `historyDebt` / `currentMonthDebt`. Result: a
// ReferenceError inside render() → empty tenants table → checkStatus()'s catch
// flipped the badge to "disconnected" → this looked like a WHATSAPP OUTAGE,
// with /api/data returning 200 and a completely clean server log.
//
// It shipped because `node --check` PARSES but does not RUN: an undefined
// variable is valid syntax. Every other suite tested server.js only.
//
// So: these tests EXECUTE the real page code. If you change render()'s debt
// block or the portal banner, run this. If markers below stop matching, the
// test fails loudly rather than silently testing nothing.

const { readSource, extractHtmlRegion, extractFunctions, runInSandbox, makeRunner } = require('./test-lib');

const t = makeRunner('frontend render');

// ── 1. app.html: the debtCell block must not throw ────────────────
// Extract from `const amount = ...` down to the end of the if/else chain.
const START = '       const amount = t.effectiveAmount';
const END = "            h+='<tr>';";
let block;
try {
  block = extractHtmlRegion('public/app.html', START, END);
} catch (e) {
  console.error('\n  ❌ CANNOT LOCATE the debtCell block in app.html.');
  console.error('     ' + e.message);
  console.error('     The markers moved — fix them, do NOT delete this test.\n');
  process.exit(1);
}

function renderDebtCell(tenant, isM, isB) {
  const data = { config: { amount: 230 } };
  const fn = new Function('t', 'isM', 'isB', 'data', block + '\n; return debtCell;');
  return fn(tenant, isM, isB, data);
}

const T = o => Object.assign({
  id: '1', effectiveAmount: 230, openingDebt: 0, creditBalance: 0, totalDebt: 0,
  currentBalance: { status: 'unpaid', shortfall: 230 }
}, o);

t.section('app.html debtCell — must never throw (the v2.13.12 regression)');
t.noThrow('paid in full, no debt', () =>
  renderDebtCell(T({ totalDebt: 0, currentBalance: { status: 'paid', shortfall: 0 } }), false, true));
t.noThrow('unpaid, owes the month', () =>
  renderDebtCell(T({ totalDebt: 230 }), false, false));
t.noThrow('partial payment, 80 short', () =>
  renderDebtCell(T({ totalDebt: 80, currentBalance: { status: 'partial', shortfall: 80 } }), false, true));
t.noThrow('credit 200', () =>
  renderDebtCell(T({ creditBalance: 200, currentBalance: { status: 'paid', shortfall: 0 } }), false, true));
t.noThrow('paid + prior debt', () =>
  renderDebtCell(T({ openingDebt: 200, totalDebt: 200, currentBalance: { status: 'paid', shortfall: 0 } }), false, true));
t.noThrow('unpaid + prior debt', () =>
  renderDebtCell(T({ openingDebt: 200, totalDebt: 430 }), false, false));
t.noThrow('manual mark (isM)', () =>
  renderDebtCell(T({ totalDebt: 0, currentBalance: { status: 'paid', shortfall: 0 } }), true, false));

t.section('app.html debtCell — resilient to missing server fields');
t.noThrow('currentBalance absent', () => {
  const x = T({ totalDebt: 230 }); delete x.currentBalance;
  renderDebtCell(x, false, false);
});
t.noThrow('every computed field absent (old cached payload)', () =>
  renderDebtCell({ id: '9' }, false, false));
t.noThrow('totalDebt is a string', () =>
  renderDebtCell(T({ totalDebt: '150', currentBalance: { status: 'partial', shortfall: 150 } }), false, true));

t.section('app.html debtCell — content sanity');
const partialCell = String(renderDebtCell(
  T({ totalDebt: 80, currentBalance: { status: 'partial', shortfall: 80 } }), false, true));
t.eq('a short payment is labelled "חסר החודש", not "חוב קודם"',
  partialCell.includes('חסר החודש') && !partialCell.includes('חוב קודם'), true);
const creditCell = String(renderDebtCell(
  T({ creditBalance: 200, currentBalance: { status: 'paid', shortfall: 0 } }), false, true));
t.eq('credit is shown as credit', creditCell.includes('קרדיט'), true);

// ── 2. app.html: no local money math may creep back in ────────────
t.section('app.html — the single-source-of-truth rule still holds');
const app = readSource('public/app.html');
t.eq('no vp* mirror of the server helpers',
  /function vp(ParseSentLogAmount|CalcMonthBalance|GetExpectedAmount|SentLogIsPayment)/.test(app), false);
t.eq('no local unpaid-history reduce',
  /filter\(\s*r\s*=>\s*!r\.paid[\s\S]{0,80}reduce/.test(app), false);

// ── 3. app.html: no orphaned identifiers in the edited scope ──────
// Cheap guard for the exact class of bug that shipped twice (selectOS,
// historyDebt). Not a full scope analysis — a targeted watchlist.
t.section('app.html — orphaned identifier watchlist');
const WATCH = ['historyDebt', 'currentMonthDebt', 'tHistory', 'otherShortfall',
  'emKey', 'emLv', 'vmKey', 'vmHist', 'vmExpected', 'totalPriorDebt',
  'effectiveOpeningDebt', 'creditAfterHistory'];
for (const name of WATCH) {
  const declared = new RegExp('(?:const|let|var)\\s+' + name + '\\b').test(app);
  const used = new RegExp('\\b' + name + '\\b').test(app);
  t.eq(name + (used ? (declared ? ' — used & declared' : ' — USED BUT NEVER DECLARED') : ' — unused'),
    used && !declared, false);
}

// ── 4. selectOS must survive a missing installer UI ───────────────
t.section('app.html — boot path (the v2.13.11 regression)');
const bootCode = extractFunctions(app, ['selectOS']);
t.noThrow('selectOS with none of its elements present', () => {
  const sandbox = runInSandbox(
    bootCode + 'module.exports={selectOS};',
    { document: { getElementById: () => null }, localStorage: { getItem: () => null, setItem: () => {} } }
  );
  sandbox.selectOS('win');
});
t.noThrow('selectOS with the elements present', () => {
  const sandbox = runInSandbox(
    bootCode + 'module.exports={selectOS};',
    {
      document: { getElementById: () => ({ style: {}, className: '' }) },
      localStorage: { getItem: () => 'mac', setItem: () => {} }
    }
  );
  sandbox.selectOS('mac');
});

// ── 5. tenant-portal.html: consume-only ───────────────────────────
t.section('tenant-portal.html — consume-only rule');
const portal = readSource('public/tenant-portal.html');
t.eq('reads amountDue from the server payload', /c\.amountDue/.test(portal), true);
t.eq('no local amountDue arithmetic',
  /const amountDue = Math\.max\(0, (currentCharge|c\.amount) \+/.test(portal), false);
for (const dead of ['effectiveOpeningDebt', 'creditAfterHistory', 'totalPriorDebt']) {
  const declared = new RegExp('(?:const|let|var)\\s+' + dead + '\\b').test(portal);
  const used = new RegExp('\\b' + dead + '\\b').test(portal);
  t.eq(dead + ' is not an orphan', used && !declared, false);
}

t.section('app.html — import month is self-contained (v2.13.17)');
// The July/June mis-tag root cause: with an empty bankMonth, analyzeBankRows fell
// back to getEffectiveMonth() = the global manualMonth, so importing an old month
// required changing the building-wide setting (which then mis-tagged the file).
// Guard: the bankMonth fallback must derive from the real calendar date, and must
// NOT call getEffectiveMonth in that branch.
// Isolate JUST the month-selection if/else, and strip // comments so the guard
// tests real code, not explanatory prose that mentions getEffectiveMonth.
const selStart = app.indexOf('const bankMonthKey = document.getElementById');
const selRaw = selStart >= 0 ? app.slice(selStart, selStart + 1600) : '';
const selCode = selRaw.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
t.eq('month-selection code does NOT call getEffectiveMonth',
  /getEffectiveMonth\s*\(/.test(selCode), false);
t.eq('month-selection else branch derives from new Date()',
  /new Date\(\)/.test(selCode), true);
t.eq('month-mismatch soft warning exists',
  /warnMonthMismatch/.test(app), true);
t.eq('manualMonth reminder in import panel exists',
  /bankManualMonthWarn/.test(app), true);

process.exit(t.done() ? 1 : 0);
