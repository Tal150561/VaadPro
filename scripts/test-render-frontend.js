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

t.section('app.html — boot-load guard survives loadData (v2.13.20)');
// The template-textarea overwrite bug: checkStatus's one-time fillForm() was
// guarded by data._loaded, but loadData() does `data = await r.json()` which
// REPLACES data and wipes the flag → fillForm re-ran every 2.5s and clobbered the
// user's typing. The guard MUST be a standalone variable, not a property on data.
// Strip // comments so the guard tests real code, not the explanatory comment
// that mentions data._loaded.
const appNoComments = app.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
t.eq('boot-load guard is a standalone flag, not data._loaded',
  /data\._loaded/.test(appNoComments), false);
t.eq('standalone _dataLoadedOnce flag is declared',
  /let _dataLoadedOnce/.test(app), true);
t.eq('checkStatus uses the standalone flag',
  /if\(!_dataLoadedOnce\)/.test(app), true);

t.section('app.html — collection breakdown modal ACTUALLY OPENS (v2.13.30)');
// v2.13.27 shipped the modal with the card bound only via a DOMContentLoaded
// addEventListener. The user reported "I don't see the changes" — a modal that
// never opens is indistinguishable from a feature that was never written.
// These tests EXECUTE showCollectionBreakdown and assert the rendered labels,
// so a silently-dead modal fails the suite instead of shipping.
{
  const fns = extractFunctions(app, ['computeCollectionBreakdown', 'showCollectionBreakdown']);

  t.eq('card is bound with an inline onclick (cannot be missed)',
    /id="sAmountCard"[^>]*onclick="showCollectionBreakdown\(\)"/.test(app), true);

  const els = {};
  const el = id => (els[id] = els[id] || { id, innerHTML: '', textContent: '', style: {} });
  const doc = { getElementById: el };
  const data = { tenants: [{ id: 11, name: 'דנה', totalDebt: 460, openingDebt: 230,
      creditBalance: 0, currentBalance: { status: 'unpaid', shortfall: 230 }, effectiveAmount: 230 }],
    sentLog: {}, config: { amount: 230 } };
  const accountsStatus = { '11': [{ id: 'a1', label: 'חשמל', amount: 50,
      paidThisMonth: false, totalDebt: 100, active: true }] };
  let opened = null;
  const api = new Function('document', 'data', 'accountsStatus', 'getEffectiveMonth', 'openModal',
    'var collectionBreakdown=null;' + fns + '\n; return {computeCollectionBreakdown, showCollectionBreakdown};'
  )(doc, data, accountsStatus, () => 'יולי', id => { opened = id; });

  let threw = null;
  try { api.showCollectionBreakdown(); } catch (e) { threw = e.message; }
  t.eq('showCollectionBreakdown does not throw', threw, null);
  t.eq('it opens the modal via openModal', opened, 'collectionBreakdownModal');

  const html = el('collectionBreakdownBody').innerHTML;
  t.eq('renders "חיוב החודש שטרם שולם"', html.includes('חיוב החודש שטרם שולם'), true);
  t.eq('renders "חוב מחודשים קודמים"',   html.includes('חוב מחודשים קודמים'), true);
  t.eq('renders the not-yet-collected note', html.includes('לא נגבה'), true);
  t.eq('names the active month',          html.includes('יולי'), true);
  t.eq('per-account "חיוב החודש:" line',  html.includes('חיוב החודש: '), true);
  t.eq('per-account "חוב קודם:" line',    html.includes('חוב קודם: '), true);
  t.eq('shows tenant counts',             /\d+ דיירים/.test(html), true);

  // v2.13.31: current month comes from currentBalance.shortfall (230), and the
  // whole of totalDebt (460) is prior debt — the unpaid current month is NOT
  // inside totalDebt, so nothing is subtracted from it here.
  const b = api.computeCollectionBreakdown(230);
  t.eq('current = shortfall 230', b.mainCurrent, 230);
  t.eq('prior = totalDebt 460',   b.mainDebt, 460);
  t.eq('grandTotal = 230 + 460 + extras 150', b.grandTotal, 840);
  t.eq('mainCurrentCount counted', b.mainCurrentCount, 1);
  t.eq('mainDebtCount counted',    b.mainDebtCount, 1);
}

t.section('app.html — collection totals: CURRENT MONTH IS NOT IN totalDebt (v2.13.31)');
// Tal's real building, from the modal screenshot he rejected:
//   12 tenants @230, 5 paid July, 7 unpaid.
//   לימור: openingDebt 1380 + Apr/May/Jun accrued (690) => totalDebt 2070.
//   One ביטוח extra account @50 unpaid.
// The old split derived the current month as (totalDebt - openingDebt), which
//   • mislabelled לימור's accrued 690 as "this month", and
//   • scored the 6 tenants with no history rows as owing 0.
// It showed 690 / 1 tenant. The truth is 1610 / 7 tenants, total 3730.
{
  const fns = extractFunctions(app, ['computeCollectionBreakdown']);
  const tenants = [
    { id: 1, name: 'לימור', totalDebt: 2070, openingDebt: 1380, creditBalance: 0,
      currentBalance: { status: 'unpaid', shortfall: 230, expected: 230 } }
  ];
  for (let i = 2; i <= 7; i++) tenants.push({ id: i, totalDebt: 0, openingDebt: 0, creditBalance: 0,
      currentBalance: { status: 'unpaid', shortfall: 230, expected: 230 } });
  for (let i = 8; i <= 12; i++) tenants.push({ id: i, totalDebt: 0, openingDebt: 0, creditBalance: 0,
      currentBalance: { status: 'paid', shortfall: 0, expected: 230 } });

  const run = (tl, accs) => new Function('data', 'accountsStatus', 'getEffectiveMonth',
    fns + '\n; return computeCollectionBreakdown;'
  )({ tenants: tl, sentLog: {}, config: { amount: 230 } }, accs || {}, () => 'יולי')(230);

  const b = run(tenants, { '2': [{ id: 'a1', label: 'ביטוח', amount: 50,
      paidThisMonth: false, totalDebt: 0, active: true }] });
  t.eq('current month = 7 unpaid x 230', b.mainCurrent, 1610);
  t.eq('current month counts ALL 7 unpaid tenants', b.mainCurrentCount, 7);
  t.eq('prior debt = limor opening 1380 + accrued 690', b.mainDebt, 2070);
  t.eq('prior debt counts only limor', b.mainDebtCount, 1);
  t.eq('extras = 50', b.extrasTotal, 50);
  t.eq('GRAND TOTAL = 1610 + 2070 + 50', b.grandTotal, 3730);

  // A tenant with NO accrued history still owes the current month.
  const solo = run([{ id: 1, totalDebt: 0, openingDebt: 0, creditBalance: 0,
    currentBalance: { status: 'unpaid', shortfall: 230, expected: 230 } }]);
  t.eq('unpaid tenant with empty history still owes this month', solo.mainCurrent, 230);
  t.eq('...and is counted', solo.mainCurrentCount, 1);

  // Partial payment must NOT be double-counted (shortfall is inside totalDebt).
  const part = run([{ id: 1, totalDebt: 530, openingDebt: 500, creditBalance: 0,
    currentBalance: { status: 'partial', shortfall: 30, expected: 230 } }]);
  t.eq('partial: current = shortfall only', part.mainCurrent, 30);
  t.eq('partial: prior excludes the shortfall', part.mainDebt, 500);
  t.eq('partial: no double-count', part.grandTotal, 530);

  // Paid-this-month tenant with old debt contributes nothing to "current".
  const paidOld = run([{ id: 1, totalDebt: 800, openingDebt: 800, creditBalance: 0,
    currentBalance: { status: 'paid', shortfall: 0, expected: 230 } }]);
  t.eq('paid this month => current 0', paidOld.mainCurrent, 0);
  t.eq('paid this month => prior 800', paidOld.mainDebt, 800);

  // Credit is reported, never collected.
  const cred = run([{ id: 1, totalDebt: 0, openingDebt: -100, creditBalance: 100,
    currentBalance: { status: 'paid', shortfall: 0, expected: 230 } }]);
  t.eq('credit excluded from grandTotal', cred.grandTotal, 0);
  t.eq('credit reported separately', cred.mainCredit, 100);
}

process.exit(t.done() ? 1 : 0);
