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
  const data = { tenants: [{ id: 11, name: 'דנה', totalDebt: 460, priorDebt: 460, openingDebt: 230,
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
    { id: 1, name: 'לימור', totalDebt: 2070, priorDebt: 2070, openingDebt: 1380, creditBalance: 0,
      currentBalance: { status: 'unpaid', shortfall: 230, expected: 230 } }
  ];
  for (let i = 2; i <= 7; i++) tenants.push({ id: i, totalDebt: 0, priorDebt: 0, openingDebt: 0, creditBalance: 0,
      currentBalance: { status: 'unpaid', shortfall: 230, expected: 230 } });
  for (let i = 8; i <= 12; i++) tenants.push({ id: i, totalDebt: 0, priorDebt: 0, openingDebt: 0, creditBalance: 0,
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
  const solo = run([{ id: 1, totalDebt: 0, priorDebt: 0, openingDebt: 0, creditBalance: 0,
    currentBalance: { status: 'unpaid', shortfall: 230, expected: 230 } }]);
  t.eq('unpaid tenant with empty history still owes this month', solo.mainCurrent, 230);
  t.eq('...and is counted', solo.mainCurrentCount, 1);

  // Partial payment must NOT be double-counted (shortfall is inside totalDebt).
  const part = run([{ id: 1, totalDebt: 530, priorDebt: 500, openingDebt: 500, creditBalance: 0,
    currentBalance: { status: 'partial', shortfall: 30, expected: 230 } }]);
  t.eq('partial: current = shortfall only', part.mainCurrent, 30);
  t.eq('partial: prior excludes the shortfall', part.mainDebt, 500);
  t.eq('partial: no double-count', part.grandTotal, 530);

  // v2.13.32 — an UNPAID tenant whose current month ALREADY has an unpaid
  // paymentHistory row. calcTotalDebt counts that row, so reconstructing prior
  // debt as (totalDebt - partialShortfall) double-counted it: ₪230 owed was
  // reported as ₪460. The page must consume server-supplied priorDebt instead.
  const rowAlready = run([{ id: 1, totalDebt: 230, priorDebt: 0, openingDebt: 0, creditBalance: 0,
    currentBalance: { status: 'unpaid', shortfall: 230, expected: 230 } }]);
  t.eq('unpaid + existing history row: current 230', rowAlready.mainCurrent, 230);
  t.eq('unpaid + existing history row: prior 0', rowAlready.mainDebt, 0);
  t.eq('unpaid + existing history row: NO double-count', rowAlready.grandTotal, 230);

  // Paid-this-month tenant with old debt contributes nothing to "current".
  const paidOld = run([{ id: 1, totalDebt: 800, priorDebt: 800, openingDebt: 800, creditBalance: 0,
    currentBalance: { status: 'paid', shortfall: 0, expected: 230 } }]);
  t.eq('paid this month => current 0', paidOld.mainCurrent, 0);
  t.eq('paid this month => prior 800', paidOld.mainDebt, 800);

  // Extra accounts must still be counted when the MAIN account is fully paid
  // (Tal: אין חוב on the main account, ביטוח ₪50 still open).
  const talExtras = run([{ id: 10, totalDebt: 0, priorDebt: 0, openingDebt: 0, creditBalance: 0,
    currentBalance: { status: 'paid', shortfall: 0, expected: 230 } }],
    { '10': [{ id: 'ins', label: 'ביטוח', amount: 50, paidThisMonth: false, totalDebt: 0, active: true }] });
  t.eq('extras counted even when main account is paid', talExtras.extrasTotal, 50);
  t.eq('extras appear in grandTotal', talExtras.grandTotal, 50);
  t.eq('extras row labelled', talExtras.extras[0].label, 'ביטוח');

  // Credit is reported, never collected.
  const cred = run([{ id: 1, totalDebt: 0, priorDebt: 0, openingDebt: -100, creditBalance: 100,
    currentBalance: { status: 'paid', shortfall: 0, expected: 230 } }]);
  t.eq('credit excluded from grandTotal', cred.grandTotal, 0);
  t.eq('credit reported separately', cred.mainCredit, 100);
}

t.section('app.html — extra accounts survive the async race (v2.13.33)');
// Tal's ביטוח ₪50 showed in his tenant row and in the portal but NOT on the
// dashboard card. Cause: loadData() fires loadAccountsIfNeeded() WITHOUT await,
// so render() computes the card while accountsStatus is still {}. The tenant
// row recovered because loadAccountsStatus() re-runs injectExtraAccountsCells();
// the card had no such refresh and stayed at its accounts-less total forever.
{
  const fns = extractFunctions(app, ['computeCollectionBreakdown', 'refreshCollectionCard']);

  t.eq('loadAccountsStatus refreshes the collection card',
    /accountsStatus = d\.status \|\| \{\};[\s\S]{0,600}?refreshCollectionCard\(\)/.test(app), true);
  t.eq('accountsStatus is a hoisted var, not a TDZ-prone let',
    /var accountsStatus = \{\}/.test(app), true);
  t.eq('no duplicate let accountsStatus declaration',
    /let accountsStatus/.test(app), false);

  const els = {};
  const el = id => (els[id] = els[id] || { id, textContent: '', innerHTML: '', style: {}, value: '230' });
  const data = { tenants: [{ id: 10, name: 'טל', totalDebt: 0, priorDebt: 0, openingDebt: 0,
    creditBalance: 0, currentBalance: { status: 'paid', shortfall: 0, expected: 230 } }],
    sentLog: {}, config: { amount: 230 } };
  const ctx = new Function('document', 'data', 'getEffectiveMonth',
    'var accountsStatus={};' + fns +
    '\n; return { refreshCollectionCard, setAccounts: a => { accountsStatus = a; } };'
  )({ getElementById: el }, data, () => 'יולי');

  // T1 — render() paints the card before the accounts fetch resolves.
  ctx.refreshCollectionCard();
  t.eq('card before accounts arrive', el('sAmount').textContent, '0₪');

  // T2 — the fetch resolves and loadAccountsStatus repaints the card.
  ctx.setAccounts({ '10': [{ id: 'ins', label: 'ביטוח', amount: 50,
    paidThisMonth: false, totalDebt: 0, active: true }] });
  ctx.refreshCollectionCard();
  t.eq('card AFTER accounts arrive includes the extra account',
    el('sAmount').textContent, '50₪');
  t.eq('hint names the extras', el('sAmountHint').textContent.includes('חשבונות 50₪'), true);
}

// ── v2.13.34: "ממתינים" / "שילמו החודש" click-through lists ──────
// FIXTURE PROVENANCE: the 12-tenant fixture below is Tal's REAL building,
// copied verbatim from a live GET /api/data (July 2026). Do not "tidy" the
// numbers — the whole point is that the list total must equal the ₪3,910
// the dashboard actually showed. The two `partial` tenants in the SECOND
// fixture are SYNTHETIC (the live building had no partial payment at the
// time); they keep the real ₪230 tariff shape.
{
  const app = readSource('public/app.html');
  const fns = extractFunctions(app, ['buildTenantStatusRows', 'showTenantStatusList']);

  // Real building, verbatim from /api/data
  const REAL = [
    ['תומר','unpaid',0,230,230,0],   ['חנה','paid',230,230,0,0],
    ['רנדי','unpaid',0,230,230,0],   ['לימור','unpaid',0,230,230,2070],
    ['עידו','unpaid',0,230,230,0],   ['ירין','paid',230,230,0,0],
    ['תמי','paid',230,230,0,230],    ['טל','paid',230,230,0,0],
    ['רוני','unpaid',0,230,230,0],   ['אורי','unpaid',0,230,230,0],
    ['גיל','paid',230,230,0,0],      ['אור','unpaid',0,230,230,0]
  ].map(([name,status,paidAmount,expected,shortfall,priorDebt],i)=>({
    id:i+1, name, priorDebt, totalDebt:priorDebt, creditBalance:0,
    currentBalance:{status,paidAmount,expected,shortfall,credit:0}
  }));

  const mk = (tenants, accountsStatus={}) => {
    const els = {};
    const el = id => (els[id] = els[id] || { id, textContent:'', innerHTML:'', style:{}, value:'230' });
    const ctx = new Function('document','data','accountsStatus','getEffectiveMonth','openModal',
      fns + '\n; return { buildTenantStatusRows, showTenantStatusList };'
    )({ getElementById: el }, { tenants }, accountsStatus, () => 'יולי', () => {});
    return { ctx, el };
  };

  const { ctx, el } = mk(REAL);
  const rows = ctx.buildTenantStatusRows();
  const pending = rows.filter(r => r.bucket === 'pending');
  const paid    = rows.filter(r => r.bucket === 'paid');

  t.eq('real building: 12 tenants classified', rows.length, 12);
  t.eq('real building: 8 pending (7 unpaid + תמי who owes prior debt)', pending.length, 8);
  t.eq('real building: 4 owe nothing', paid.length, 4);
  t.eq('⭐ pending total EQUALS the סה״כ לגביה card (3910)',
    Math.round(pending.reduce((a,r) => a + r.owed, 0) * 100) / 100, 3910);
  t.eq('cards are complements (pending + paid = tenants)', pending.length + paid.length, rows.length);

  // תמי: paid July in full, but carries prior debt → must NOT be counted as settled
  const tami = rows.find(r => r.name === 'תמי');
  t.eq('תמי paid the month but still owes', tami.bucket, 'pending');
  t.eq('תמי owes exactly her prior debt', tami.owed, 230);
  t.eq('תמי has no current-month charge', tami.currentMonthDebt, 0);

  // לימור: the large accrued debt case
  const limor = rows.find(r => r.name === 'לימור');
  t.eq('לימור owes current + prior', limor.owed, 2300);

  // אור: negative openingDebt (credit) must NOT reduce what he owes this month
  const or = rows.find(r => r.name === 'אור');
  t.eq('credit never nets against the collectible figure', or.owed, 230);

  // Partial payments (SYNTHETIC — none existed live)
  const PARTIAL = [
    { id:1, name:'חלקי', priorDebt:0, totalDebt:80, creditBalance:0,
      currentBalance:{ status:'partial', paidAmount:150, expected:230, shortfall:80, credit:0 } },
    { id:2, name:'חלקי+חוב', priorDebt:500, totalDebt:630, creditBalance:0,
      currentBalance:{ status:'partial', paidAmount:100, expected:230, shortfall:130, credit:0 } }
  ];
  const p = mk(PARTIAL);
  const prows = p.ctx.buildTenantStatusRows();
  t.eq('⭐ partial payer is PENDING, not "paid" (the v2.13.33 bug)', prows[0].bucket, 'pending');
  t.eq('partial payer owes only the shortfall', prows[0].owed, 80);
  t.eq('partial + prior debt sums both', prows[1].owed, 630);

  p.ctx.showTenantStatusList('pending');
  const ph = p.el('tenantStatusListBody').innerHTML;
  t.eq('partial row shows "שילם חלקית X מתוך Y"', /שילם חלקית[\s\S]*?150₪[\s\S]*?מתוך[\s\S]*?230₪/.test(ph), true);
  t.eq('partial row shows the remaining balance', ph.includes('נותר'), true);

  // Extra accounts must appear in the per-tenant rows
  const e = mk(
    [{ id:3, name:'שילם', priorDebt:0, totalDebt:0, creditBalance:0,
       currentBalance:{ status:'paid', paidAmount:230, expected:230, shortfall:0, credit:0 } }],
    { '3': [{ id:'ins', label:'ביטוח', amount:50, paidThisMonth:false, totalDebt:0, active:true }] }
  );
  const erows = e.ctx.buildTenantStatusRows();
  t.eq('dues paid but open extra account → still pending', erows[0].bucket, 'pending');
  t.eq('extra account amount is included', erows[0].owed, 50);
  e.ctx.showTenantStatusList('pending');
  t.eq('extra account is named in the list', e.el('tenantStatusListBody').innerHTML.includes('ביטוח'), true);

  // The modals must actually render without throwing
  ctx.showTenantStatusList('pending');
  const html = el('tenantStatusListBody').innerHTML;
  t.eq('pending modal renders tenant names', html.includes('לימור'), true);
  t.eq('pending modal shows the grand total', html.includes('3,910₪'), true);
  t.eq('pending modal states it matches the main card', html.includes('סה״כ לגביה'), true);
  t.eq('pending title set', el('tenantStatusListTitle').innerHTML.includes('חייבים'), true);

  ctx.showTenantStatusList('paid');
  const phtml = el('tenantStatusListBody').innerHTML;
  t.eq('paid modal lists only debt-free tenants', phtml.includes('חנה') && !phtml.includes('לימור'), true);
  t.eq('paid title set', el('tenantStatusListTitle').innerHTML.includes('ללא חוב'), true);

  // Wiring: the cards must be clickable
  t.eq('ממתינים card is bound to the list', /id="sPendingCard"[^>]*onclick="showTenantStatusList\('pending'\)"/.test(app), true);
  t.eq('card label is "חייבים" (not the month-only "ממתינים")',
    /id="sPendingCard"[\s\S]{0,300}?stat-label">חייבים/.test(app), true);
  t.eq('card label is "ללא חוב" (not the month-only "שילמו החודש")',
    /id="sSentCard"[\s\S]{0,300}?stat-label">ללא חוב/.test(app), true);
  t.eq('שילמו card is bound to the list', /id="sSentCard"[^>]*onclick="showTenantStatusList\('paid'\)"/.test(app), true);
  t.eq('stat counts derive from the shared classifier',
    /buildTenantStatusRows\(\)[\s\S]{0,200}?bucket==='pending'/.test(app), true);
}

// ══════════════════════════════════════════════════════════════════
// v2.14.0 — חייבים חריגים: the modal must ACTUALLY RENDER
// ══════════════════════════════════════════════════════════════════
// ⚠️ v2.13.30 lesson: grepping for a string proves the string is in the file,
// NOT that the user can ever see it. These tests EXECUTE buildExcessDebtHtml
// and toggleSection against a stub DOM and assert on what they produced.
{
  const app = readSource('public/app.html');
  const fns = extractFunctions(app, ['esc', '_exNis', '_exFmtDate', '_exChannelName',
    'buildExcessDebtHtml', 'toggleSection']);

  const rows = [{
    id: '1', name: 'לימור', apartment: '4', phone: '0501', email: '',
    currentMonthDebt: 230, priorDebt: 2070, extrasTotal: 0, owed: 2300,
    months: [
      { monthKey: '2026-04', hebMonth: 'אפריל', expected: 230, paidAmount: 0, shortfall: 230, status: 'unpaid' },
      { monthKey: '2026-07', hebMonth: 'יולי',  expected: 230, paidAmount: 100, shortfall: 130, status: 'partial' }
    ],
    accounts: [{ label: 'ביטוח', months: [{ monthKey: '2026-07', hebMonth: 'יולי', amount: 50 }], openingDebt: 900, total: 950 }],
    alerts: [{ date: '2026-07-01T10:00:00.000Z', channel: 'wa', amount: 2100 }]
  }];

  const ctx = new Function(fns + '\n; return { buildExcessDebtHtml, toggleSection, esc };')();

  t.section('חוב חריג — the list modal ACTUALLY renders');
  t.noThrow('buildExcessDebtHtml does not throw', () => ctx.buildExcessDebtHtml(rows, 1000, 'יולי'));
  const html = ctx.buildExcessDebtHtml(rows, 1000, 'יולי');
  t.eq('tenant name rendered', html.includes('לימור'), true);
  t.eq('total owed rendered', html.includes('2,300₪'), true);
  t.eq('threshold explained to the user', html.includes('1,000₪'), true);
  t.eq('active month shown', html.includes('יולי'), true);
  t.eq('an unpaid month is itemised', html.includes('אפריל'), true);
  t.eq('a partial month shows paid-of-expected', html.includes('שילם 100₪ מתוך 230₪'), true);
  t.eq('extra account named', html.includes('ביטוח'), true);
  t.eq("extra account's prior debt shown", html.includes('חוב קודם 900₪'), true);
  t.eq('previous alert history shown', html.includes('נשלחה התראה'), true);
  t.eq('alert channel is human-readable', html.includes('וואטסאפ'), true);
  t.eq('send button wired per tenant', html.includes("openExcessAlert('1')"), true);

  t.section('חוב חריג — empty and escaping');
  const empty = ctx.buildExcessDebtHtml([], 1000, 'יולי');
  t.eq('empty state is friendly, not blank', empty.includes('אין חייבים חריגים'), true);
  t.eq('no send button when nobody qualifies', empty.includes('openExcessAlert'), false);
  const xss = ctx.buildExcessDebtHtml([Object.assign({}, rows[0],
    { name: '<img src=x onerror=alert(1)>', months: [], accounts: [], alerts: [] })], 1000, 'יולי');
  t.eq('a tenant name is HTML-escaped', xss.includes('<img src=x'), false);
  t.eq('escaped form present instead', xss.includes('&lt;img'), true);

  t.section('חוב חריג — esc() is top-level (the v2.13.26 hoisting trap)');
  t.eq('esc is reachable outside its defining function', typeof ctx.esc, 'function');
  t.eq('esc escapes quotes', ctx.esc('a"b'), 'a&quot;b');

  t.section('הגדרות — collapse/expand sections');
  const els = {};
  const el = id => (els[id] = els[id] || { id, textContent: '', innerHTML: '', style: { display: 'none' } });
  const tog = new Function('document', extractFunctions(app, ['toggleSection']) + '\n; return toggleSection;')({ getElementById: el });
  tog('secPay');
  t.eq('collapsed section opens on click', el('secPayBody').style.display, 'block');
  t.eq('icon flips to כווץ', el('secPayIcon').textContent, '▼ כווץ');
  tog('secPay');
  t.eq('a second click collapses it again', el('secPayBody').style.display, 'none');
  t.eq('icon flips back to הרחב', el('secPayIcon').textContent, '▶ הרחב');
  t.noThrow('a missing section id does not throw', () => tog('doesNotExist'));

  t.section('חוב חריג / collapse — wiring in the markup');
  t.eq('the card is bound INLINE (v2.13.30 rule)',
    /id="sExcessCard"[^>]*onclick="showExcessDebtList\(\)"/.test(app), true);
  t.eq('card sits between חייבים and סה״כ לגביה',
    app.indexOf('id="sPendingCard"') < app.indexOf('id="sExcessCard"') &&
    app.indexOf('id="sExcessCard"') < app.indexOf('id="sAmountCard"'), true);
  t.eq('modal opens via openModal(), not a bare display',
    /openModal\('excessDebtModal'\)/.test(app), true);
  t.eq('threshold field exists in settings', /id="cfgExcessDebt"/.test(app), true);
  t.eq('threshold is persisted by saveConfig',
    /excessDebtThreshold\s*=\s*_ex/.test(app), true);
  t.eq('alert template field exists', /id="cfgExcessDebtTemplate"/.test(app), true);
  t.eq('fillForm populates the threshold', /exEl\.value=\(c\.excessDebtThreshold/.test(app), true);
  for (const k of ['secWa','secPay','secTpl','secBackup','secRepair','secAcc']) {
    t.eq(k + ' is collapsible and starts collapsed',
      new RegExp('onclick="toggleSection\\(\'' + k + '\'\\)"').test(app) &&
      new RegExp('id="' + k + 'Body" style="display:none;"').test(app), true);
  }
  t.eq('help buttons stop propagation so they do not toggle',
    /event\.stopPropagation\(\);showHelp\('wa'\)/.test(app), true);
  t.eq('the excess card is refreshed from render()',
    /refreshExcessDebtCard\(\);/.test(app), true);

  // ── v2.14.1 fixes (all three reported by Tal) ──────────────────
  t.section('v2.14.1 — the card must follow a threshold change');
  const saveCfg = (app.match(/async function saveConfig\(\)[\s\S]*?\n\}/) || [''])[0];
  t.eq('saveConfig exists', saveCfg.length > 0, true);
  t.eq('THE BUG: saveConfig repaints the excess card after saving',
    /refreshExcessDebtCard\(\)/.test(saveCfg), true);
  t.eq('the repaint is INSIDE the debounced save (after the POST resolves)',
    /body:\s*JSON\.stringify\(\{config:data\.config\}\)[\s\S]{0,700}?refreshExcessDebtCard\(\)/.test(saveCfg), true);

  t.section('v2.14.1 — openingDebt is itemised on screen');
  const rowsOD = [{ id: '9', name: 'לימור', apartment: '', phone: '', email: '',
    currentMonthDebt: 230, priorDebt: 1610, extrasTotal: 0, owed: 1840,
    openingDebt: 1380,
    months: [{ monthKey: '2026-04', hebMonth: 'אפריל', expected: 230, paidAmount: 0, shortfall: 230, status: 'unpaid' },
             { monthKey: '2026-07', hebMonth: 'יולי',  expected: 230, paidAmount: 0, shortfall: 230, status: 'unpaid' }],
    accounts: [], alerts: [] }];
  const htmlOD = ctx.buildExcessDebtHtml(rowsOD, 100, 'יולי');
  t.eq('carried-forward debt is labelled for the user',
    htmlOD.includes('חוב התחלתי / פתוח'), true);
  t.eq('its amount is shown', htmlOD.includes('1,380₪'), true);
  t.eq('a tenant with no openingDebt shows no such line',
    ctx.buildExcessDebtHtml([Object.assign({}, rowsOD[0], { openingDebt: 0 })], 100, 'יולי')
      .includes('חוב התחלתי'), false);

  t.section('v2.14.1 — dashboard: five cards on ONE row');
  t.eq('grid is 5 columns, not the stale 4',
    /\.stats-row\{[^}]*grid-template-columns:repeat\(5,1fr\)/.test(app), true);
  t.eq('no leftover repeat(4,1fr)', /grid-template-columns:repeat\(4,1fr\)/.test(app), false);
  t.eq('mobile keeps 5 columns (does not fall back to 2)',
    /@media\(max-width:600px\)\{\.stats-row\{grid-template-columns:repeat\(5,1fr\)/.test(app), true);
  t.eq('the stat number scales with the viewport',
    /\.stat-num\{font-size:clamp\(/.test(app), true);
  t.eq('the stat label scales with the viewport',
    /\.stat-label\{font-size:clamp\(/.test(app), true);
  t.eq('cards can shrink (min-width:0)', /\.stat-card\{[^}]*min-width:0/.test(app), true);
  t.eq('the 🔎 is hidden at phone width to save room',
    /\.stat-mag\{display:none;\}/.test(app), true);
  const statsRow = (app.match(/<div class="stats-row">[\s\S]*?\n  <\/div>/) || [''])[0];
  t.eq('exactly 5 stat cards in the row',
    (statsRow.match(/<div class="stat-card"/g) || []).length, 5);
}

process.exit(t.done() ? 1 : 0);
