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
  const fns = 'const VP_MONTHS=["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];\n'
    + extractFunctions(app, ['tenantOffsetNote', 'buildTenantStatusRows', 'showTenantStatusList']);

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
      fns + '\n; return { buildTenantStatusRows, showTenantStatusList, tenantOffsetNote };'
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

  // v2.14.12 (option A) — tenantOffsetNote + inline note in the status list.
  {
    const yr = new Date().getFullYear();
    const els2 = {};
    const el2 = id => (els2[id] = els2[id] || { id, textContent:'', innerHTML:'', style:{}, value:'230' });
    const data2 = {
      tenants: [{ id: 1, name: 'רוני', priorDebt: 0, totalDebt: 0, creditBalance: 239,
        currentBalance: { status: 'paid', paidAmount: 956, expected: 239, shortfall: 0, credit: 239 } }],
      paymentHistory: { 1: [ { month: yr+'-06', paid: true,
        debtOffset: { monthCharge: 239, surplus: 717, priorDebtPaid: 478, newCredit: 239 } } ] }
    };
    const ctx2 = new Function('document','data','accountsStatus','getEffectiveMonth','openModal',
      fns + '\n; return { tenantOffsetNote, showTenantStatusList };'
    )({ getElementById: el2 }, data2, {}, () => 'יולי', () => {});
    const off = ctx2.tenantOffsetNote(1);
    t.eq('tenantOffsetNote returns short + full', !!(off && off.short && off.full), true);
    t.eq('short note names the month (יוני)', off.short.includes('יוני'), true);
    t.eq('short note names prior-debt paydown', off.short.includes('478 ₪ לכיסוי חוב קודם'), true);
    t.eq('no offset → null', ctx2.tenantOffsetNote(999), null);
    ctx2.showTenantStatusList('paid');
    t.eq('status list shows the inline offset note', el2('tenantStatusListBody').innerHTML.includes('קיזוז יוני'), true);
  }

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

  // ── v2.14.2 — list search / sort / collapse ────────────────────
  t.section('v2.14.2 — \u05e8\u05e9\u05d9\u05de\u05ea \u05d3\u05d9\u05d9\u05e8\u05d9\u05dd: search + collapse');
  t.eq('a search box exists and is wired live', /id="tenantSearch"[^>]*oninput="onTenantSearch\(this\.value\)"/.test(app), true);
  t.eq('typing in it does not toggle the card', /id="tenantSearch"[\s\S]{0,400}?onclick="event\.stopPropagation\(\)"/.test(app), true);
  t.eq('the query lives at module level, NOT on `data`', /^let tenantSearchQuery = '';$/m.test(app), true);
  t.eq('no data.tenantSearchQuery anywhere', /data\.tenantSearchQuery/.test(app), false);
  t.eq('the list is collapsible', /onclick="toggleSection\('tenantsList'\)"/.test(app), true);
  t.eq('and starts EXPANDED', /id="tenantsListBody" style="display:block;"/.test(app), true);
  t.eq('the export button does not toggle the card',
    /event\.stopPropagation\(\);exportTenantsExcel\(\)/.test(app), true);
  const filt = (app.match(/const _visibleTenants = data\.tenants\.filter[\s\S]*?\}\);/) || [''])[0];
  t.eq('filter exists', filt.length > 0, true);
  for (const f of ['tenantDisplayName(t)', 't.keywords', 't.phone', 't.email', 'amountText', 'statusText']) {
    t.eq('search covers ' + f, filt.includes(f), true);
  }
  t.eq('matching is case-insensitive', /\.toLowerCase\(\)\.includes\(tenantSearchQuery\)/.test(filt), true);
  t.eq('an empty query keeps every tenant', /if \(!tenantSearchQuery\) return true;/.test(filt), true);

  t.section('v2.14.2 — \u05e1\u05d8\u05d8\u05d5\u05e1 \u05ea\u05e9\u05dc\u05d5\u05de\u05d9\u05dd: sortable headers');
  for (const k of ['debt', 'status', 'manual']) {
    t.eq(k + ' header is clickable', new RegExp("_sortTh\\('" + k + "'").test(app), true);
  }
  t.eq('sort state is module-level', /^let paySortKey = '';/m.test(app), true);
  t.eq('clicking the same key flips direction',
    /if \(paySortKey === k\) paySortDir = -paySortDir;/.test(app), true);
  t.eq('sorting works on a COPY, never mutating data.tenants',
    /const _payRows = data\.tenants\.slice\(\);/.test(app), true);
  t.eq('rows are rendered from the sorted copy', /_payRows\.forEach\(function\(t\)\{/.test(app), true);
  const sortVal = (app.match(/function paySortValue\([\s\S]*?\n\}/) || [''])[0];
  t.eq('debt sorts on the SERVER figure, not a local recompute',
    /parseFloat\(t\.totalDebt\)/.test(sortVal), true);
  t.eq('no money is recomputed while sorting',
    /expected|shortfall\s*[-+*]/.test(sortVal), false);

  t.section('v2.14.2 — \u05d4\u05d5\u05e1\u05e3 \u05d7\u05e9\u05d1\u05d5\u05df column + \u05e9\u05dc\u05d9\u05d7\u05d4 last');
  t.eq('the new column header exists', /<th>\u05d4\u05d5\u05e1\u05e3 \u05d7\u05e9\u05d1\u05d5\u05df<\/th>/.test(app), true);
  t.eq('\u05e9\u05dc\u05d9\u05d7\u05d4 is the LAST header (leftmost in RTL)',
    /<th>\u05d4\u05d5\u05e1\u05e3 \u05d7\u05e9\u05d1\u05d5\u05df<\/th><th>\u05e9\u05dc\u05d9\u05d7\u05d4<\/th>/.test(app), true);
  t.eq('every row carries a matching cell', /<td class="acc-mgr-cell"/.test(app), true);
  t.eq('the injector targets that cell, not the send cell',
    /row\.querySelector\('\.acc-mgr-cell'\)/.test(app), true);
  t.eq('the payments card is collapsible', /onclick="toggleSection\('paymentsStatus'\)"/.test(app), true);
  t.eq('and starts EXPANDED', /id="paymentsStatusBody" style="display:block;"/.test(app), true);
  t.eq('the month selector does not toggle the card',
    /id="viewMonthSelect" onclick="event\.stopPropagation\(\)"/.test(app), true);

  t.section('v2.14.2 — collapsed-by-default sections');
  for (const k of ['trendSaved', 'blRecipients', 'blHistory']) {
    t.eq(k + ' is collapsible', new RegExp("onclick=\"toggleSection\\('" + k + "'\\)\"").test(app), true);
    t.eq(k + ' starts COLLAPSED',
      new RegExp('id="' + k + 'Body" style="display:none;"').test(app), true);
    t.eq(k + ' is seeded collapsed in state', new RegExp('^\\s*' + k + ': true,?$', 'm').test(app), true);
  }
  t.eq('the two default-open sections are NOT seeded collapsed',
    /tenantsList: true|paymentsStatus: true/.test(app), false);

  t.section('v2.14.2 — one toggleSection only (no shadowing)');
  t.eq('exactly ONE toggleSection declaration',
    (app.match(/function toggleSection\(/g) || []).length, 1);
  t.eq('it mirrors state so a poll repaint cannot undo a collapse',
    /collapsedSections\[key\] = !open;/.test(app), true);
  t.eq('the mirror is guarded for isolated unit tests',
    /typeof collapsedSections !== 'undefined'/.test(app), true);
  const applyFn = (app.match(/function applySectionState\([\s\S]*?\n\}/) || [''])[0];
  t.eq('applySectionState reads the state map', /collapsedSections\[key\]/.test(applyFn), true);
  t.eq('render() repaints the tenants list state',
    /applySectionState\('tenantsList'\);/.test(app), true);
}

t.section('app.html — #3 multi-month split (v2.14.4)');
{
  // EXECUTE the client-side split helpers (bankRowMonthKey + groupMatchesByMonth),
  // lifted from inside analyzeBankRows by anchor, with parseDate + MONTH_NAMES_HE
  // in scope. Not a grep test: a broken split here fails the suite.
  const parseDateFn = (app.match(/function parseDate\(v\)\{[\s\S]*?\n\}/) || [''])[0];
  const mkFn  = (app.match(/function bankRowMonthKey\(dateVal\)\{[\s\S]*?\n  \}/) || [''])[0];
  const grpFn = (app.match(/function groupMatchesByMonth\(matches, fallbackMk\)\{[\s\S]*?\n  \}/) || [''])[0];
  t.eq('bankRowMonthKey lifted from source', mkFn.length > 0, true);
  t.eq('groupMatchesByMonth lifted from source', grpFn.length > 0, true);

  const helpers = new Function(
    "const MONTH_NAMES_HE=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];\n"
    + parseDateFn + '\n' + mkFn + '\n' + grpFn
    + '\n; return { bankRowMonthKey, groupMatchesByMonth };'
  )();

  t.eq('client parses DD/MM/YYYY → YYYY-MM', helpers.bankRowMonthKey('31/05/2026'), '2026-05');
  t.eq('client empty date → null', helpers.bankRowMonthKey(''), null);

  const g = helpers.groupMatchesByMonth([
    { amount: 300, date: '10/04/2026', payerName: 'A' },
    { amount: 300, date: '10/05/2026', payerName: 'A' },
    { amount: 300, date: '10/06/2026', payerName: 'A' },
  ], '2026-06');
  t.eq('client splits into 3 months', g.buckets.size, 3);
  t.eq('client April bucket = 300', g.buckets.get('2026-04').sum, 300);

  const g2 = helpers.groupMatchesByMonth([
    { amount: 300, date: '10/06/2026', payerName: 'A' },
    { amount: 300, date: '25/06/2026', payerName: 'A' },
  ], '2026-06');
  t.eq('client single-month → one bucket', g2.buckets.size, 1);
  t.eq('client single-month sums within month (600)', g2.buckets.get('2026-06').sum, 600);

  const g3 = helpers.groupMatchesByMonth([
    { amount: 300, date: '', payerName: 'A' },
  ], '2026-06');
  t.eq('client undated → fallback month', g3.buckets.get('2026-06').sum, 300);

  // Guards on the write/confirm wiring (these can't be executed without DOM/confirm).
  t.eq('split write is gated behind a confirm', /confirm\(\s*\n?\s*'הקובץ מכיל תשלומים מ-'/.test(app), true);
  t.eq('declining the split writes into the chosen month (em)',
    /data\.sentLog\[m\.tenant\.id \+ '_' \+ em\]/.test(app), true);
  t.eq('accepting the split writes per-month keys',
    /data\.sentLog\[m\.tenant\.id \+ '_' \+ hebMk\]/.test(app), true);
  t.eq('the Map is not shipped to showBankResult', /delete m\._buckets;/.test(app), true);

  // v2.14.16 — TWO-STEP manual import: detect/preview must NOT commit.
  var detect = (app.match(/function analyzeBankRows[\s\S]*?\n}\n\n\/\/ ── v2\.14\.16: commit step/) || [''])[0];
  var commit = (app.match(/function commitBankImport\(\)\{[\s\S]*?\n}\n\nfunction cancelBankImport/) || [''])[0];
  t.eq('analyzeBankRows stashes _pendingBankImport', /_pendingBankImport\s*=\s*\{/.test(detect), true);
  t.eq('analyzeBankRows previews (previewMode=true)', /showBankResult\([^)]*previewMode=\*\/true/.test(detect) || /\/\*previewMode=\*\/true/.test(detect), true);
  t.eq('analyzeBankRows does NOT POST /data itself', /fetch\(API\+'\/data'/.test(detect), false);
  t.eq('analyzeBankRows does NOT persist fingerprints itself', /data\.importedBankFingerprints\s*=/.test(detect), false);
  t.eq('analyzeBankRows does NOT write sentLog itself', /data\.sentLog\[m\.tenant\.id/.test(detect), false);
  t.eq('commitBankImport POSTs /data', /fetch\(API\+'\/data'/.test(commit), true);
  t.eq('commitBankImport persists fingerprints', /data\.importedBankFingerprints\s*=\s*allFp/.test(commit), true);
  t.eq('commitBankImport writes sentLog', /data\.sentLog\[m\.tenant\.id/.test(commit), true);
  t.eq('commitBankImport clears the pending import', /_pendingBankImport\s*=\s*null/.test(commit), true);
  t.eq('cancelBankImport saves nothing', /function cancelBankImport\(\)\{[\s\S]*?_pendingBankImport\s*=\s*null/.test(app), true);
  t.eq('preview wires אשר ורשום → commit', /onclick="commitBankImport\(\)"/.test(app), true);
  t.eq('preview wires בטל → cancel', /onclick="cancelBankImport\(\)"/.test(app), true);
}

t.section('app.html — tenant CSV import (v2.14.6)');
{
  // EXECUTE the pure import helpers lifted from app.html: tenantHeaderToKey,
  // parseMoneyCell, rowToFields, planTenantImport. A broken plan fails here.
  const hdrFn  = (app.match(/^function tenantHeaderToKey\(rawHeader\) \{[\s\S]*?^\}/m) || [''])[0];
  const moneyFn = (app.match(/^function parseMoneyCell\(raw, defaultVal, allowNegative\) \{[\s\S]*?^\}/m) || [''])[0];
  const rowFn  = (app.match(/^function rowToFields\(headerKeys, row\) \{[\s\S]*?^\}/m) || [''])[0];
  const planFn = (app.match(/^function planTenantImport\(existingTenants, headerKeys, dataRows\) \{[\s\S]*?^\}/m) || [''])[0];
  t.eq('tenantHeaderToKey lifted', hdrFn.length > 0, true);
  t.eq('parseMoneyCell lifted', moneyFn.length > 0, true);
  t.eq('rowToFields lifted', rowFn.length > 0, true);
  t.eq('planTenantImport lifted', planFn.length > 0, true);

  const H = new Function(
    hdrFn + '\n' + moneyFn + '\n' + rowFn + '\n' + planFn
    + '\n; return { tenantHeaderToKey, parseMoneyCell, rowToFields, planTenantImport };'
  )();

  // ── header mapping ──
  t.eq('Hebrew header שם → name', H.tenantHeaderToKey('שם'), 'name');
  t.eq('Hebrew header חוב_התחלתי → openingDebt', H.tenantHeaderToKey('חוב_התחלתי'), 'openingDebt');
  t.eq('English header customAmount → customAmount', H.tenantHeaderToKey('customAmount'), 'customAmount');
  t.eq('unknown header → null', H.tenantHeaderToKey('גיבריש'), null);

  // ── money parsing ──
  t.eq('empty money → default', H.parseMoneyCell('', 0).value, 0);
  t.eq('empty customAmount → null default', H.parseMoneyCell('', null).value, null);
  t.eq('numeric money parses', H.parseMoneyCell('288', 0).value, 288);
  t.eq('₪ and commas tolerated', H.parseMoneyCell('₪1,250', 0).value, 1250);
  t.eq('negative rejected by default (fee)', H.parseMoneyCell('-5', 0).ok, false);
  // v2.14.13 — openingDebt import allows credit (negative) when allowNegative=true
  t.eq('negative ALLOWED with allowNegative (credit)', H.parseMoneyCell('-239', 0, true).ok, true);
  t.eq('negative credit value parses', H.parseMoneyCell('-239', 0, true).value, -239);
  t.eq('negative still rejected without the flag', H.parseMoneyCell('-239', 0, false).ok, false);
  t.eq('non-numeric rejected', H.parseMoneyCell('abc', 0).ok, false);
  t.eq('zero openingDebt allowed', H.parseMoneyCell('0', 5).value, 0);

  // ── planTenantImport: identity + insert/update + errors ──
  const existing = [
    { id: 101, name: 'לילך', phone: '0545745271', keywords: 'ליל', customAmount: 217, openingDebt: 0 },
    { id: 102, name: 'דוד',  phone: '0501234567', keywords: 'דוד', customAmount: null, openingDebt: 50 }
  ];
  const keys = ['id','name','phone','email','keywords','customAmount','openingDebt','propertyLabel'];

  // match by id → update; changed openingDebt is flagged
  const p1 = H.planTenantImport(existing, keys,
    [['101','לילך גילים','0545745271','','ליל, גילים','217','120','דירה 4']]);
  t.eq('match by id → 1 update', p1.updates.length, 1);
  t.eq('no creates', p1.creates.length, 0);
  t.eq('openingDebt change flagged', p1.updates[0].moneyChanges.length, 1);

  // match by phone when id absent → update, not create
  const p2 = H.planTenantImport(existing, keys,
    [['','דוד כהן','0501234567','','דוד','','50','']]);
  t.eq('id-less row matches by phone → update', p2.updates.length, 1);
  t.eq('phone match makes no new tenant', p2.creates.length, 0);

  // new tenant (no id, unknown phone)
  const p3 = H.planTenantImport(existing, keys,
    [['','רוני','0509999999','','רוני','300','0','']]);
  t.eq('unknown phone → create', p3.creates.length, 1);
  t.eq('no accidental update', p3.updates.length, 0);

  // missing name / phone → error rows, skipped
  const p4 = H.planTenantImport(existing, keys,
    [['','','0500000000','','','','',''], ['','שם בלי טלפון','','','','','','']]);
  t.eq('missing name → error', p4.errors.length, 2);
  t.eq('error rows are not created', p4.creates.length, 0);

  // v2.14.13 — negative openingDebt is now ACCEPTED (credit; a tenant who prepaid)
  const p5 = H.planTenantImport(existing, keys,
    [['','חדש','0508888888','','','','-99','']]);
  t.eq('negative openingDebt no longer errors (credit allowed)', p5.errors.length, 0);
  t.eq('credit row IS created', p5.creates.length, 1);
  t.eq('credit value preserved as negative', p5.creates[0].fields.openingDebt, -99);
  // a negative FEE (customAmount) is still rejected
  const p5b = H.planTenantImport(existing, keys,
    [['','שלילי','0507777777','','','-50','','']]);
  t.eq('negative monthly fee still errors', p5b.errors.length, 1);

  // empty keywords → warning, but still imported (round-trip safety)
  const p6 = H.planTenantImport(existing, keys,
    [['','ללא מילים','0507777777','','','','0','']]);
  t.eq('empty keywords warns', p6.warnings.length >= 1, true);
  t.eq('empty keywords still creates', p6.creates.length, 1);

  // blank rows are skipped entirely
  const p7 = H.planTenantImport(existing, keys, [['','','','','','','','']]);
  t.eq('fully blank row skipped', p7.updates.length + p7.creates.length + p7.errors.length, 0);

  // MUTATION CHECK — importer must never touch payment data. Assert the write
  // path (confirmImport, merged v2.14.6) references only tenant fields, never paymentHistory/sentLog.
  const confirmBody = (app.match(/async function confirmImport\(\) \{[\s\S]*?^\}/m) || [''])[0];
  t.eq('confirm writes tenants only (no paymentHistory)', /paymentHistory/.test(confirmBody), false);
  t.eq('confirm writes tenants only (no sentLog)', /sentLog/.test(confirmBody), false);
  t.eq('confirm posts {tenants} to /api/data', /body:JSON\.stringify\(\{tenants:data\.tenants\}\)/.test(confirmBody), true);

  // MERGE (v2.14.6): exactly ONE tenant importer — no duplicate header button/modal.
  t.eq('no leftover separate import modal', /tenantImportModal/.test(app), false);
  t.eq('no leftover importTenantsFile fn', /function importTenantsFile/.test(app), false);
  t.eq('processImportFile routes through planTenantImport', /function processImportFile[\s\S]*?planTenantImport\(data\.tenants/.test(app), true);
  t.eq('merged reader uses SheetJS (not naive CSV split)', /function processImportFile[\s\S]*?XLSX\.read/.test(app), true);
}

// ════════════════════════════════════════════════════════════════
// v2.14.10 — annual export shows per-tenant amounts, not config default
// ════════════════════════════════════════════════════════════════
// BUG: exportAnnualPayments used config.amount (288) for EVERY tenant and a
// fragile regex on the sentLog string (which fails when the value ends in a
// payer name, not a number), so every cell fell back to 288 — even for a
// tenant whose real fee is 217 and who paid exactly 217. FIX: read
// paymentHistory (the debt engine's source of truth) for expected + paid,
// falling back to the tenant's OWN customAmount, never config.amount.
{
  t.section('v2.14.10 — annual export uses paymentHistory, not the 288 default');
  const MONTHS_HE = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const PAY_STATUS = {
    PAID_BANK:{label:'שולם (בנק)',code:'B'}, PAID_MANUAL:{label:'שולם (ידני)',code:'M'},
    PAID_PARTIAL:{label:'שולם חלקית',code:'P'}, EXEMPT:{label:'פטור',code:'E'}, UNPAID:{label:'לא שולם',code:''}
  };
  const fns = extractFunctions(app, ['getPayStatusForMonth', 'annualMonthKey', 'annualRecordFor', 'annualExpected', 'annualPaid']);

  // צבי: fee 217, paid 217 in May+June (bank), sentLog value ENDS IN A PAYER NAME
  // (the exact shape from Tal's real backup that broke the old regex).
  const yr = new Date().getFullYear();
  const data = {
    config: { amount: 288 },
    tenants: [{ id: 'z1', name: 'צבי', customAmount: 217 }],
    sentLog: {
      'z1_מאי':  'bank_import_2026-07-28T06:42:19.842Z_217_payer_המבצע: דר אלתר צבי',
      'z1_יוני': 'bank_import_2026-07-28T06:42:19.842Z_217_payer_המבצע: דר אלתר צבי'
    },
    paymentHistory: { z1: [
      { month: yr+'-05', paid: true, amount: 217, paidAmount: 217, type: 'bank' },
      { month: yr+'-06', paid: true, amount: 217, paidAmount: 217, type: 'bank' }
    ] }
  };
  const ctx = new Function('data','MONTHS_HE','PAY_STATUS',
    fns + '\n; return { annualExpected, annualPaid, getPayStatusForMonth };'
  )(data, MONTHS_HE, PAY_STATUS);
  const zvi = data.tenants[0];

  t.eq('expected(May) = 217 not 288', ctx.annualExpected(zvi, 'מאי'), 217);
  t.eq('expected(June) = 217 not 288', ctx.annualExpected(zvi, 'יוני'), 217);
  t.eq('paid(May) = 217 (payer-name suffix no longer breaks it)', ctx.annualPaid(zvi, 'מאי'), 217);
  t.eq('paid(June) = 217', ctx.annualPaid(zvi, 'יוני'), 217);
  // A month with NO record and NO payment falls back to the tenant's OWN fee, not 288.
  t.eq('expected(July, no record) = customAmount 217 not config 288', ctx.annualExpected(zvi, 'יולי'), 217);
  t.eq('paid(July, nothing paid) = empty', ctx.annualPaid(zvi, 'יולי'), '');
  // MUTATION: the export loop must not reintroduce the flat config.amount.
  const exportBody = (app.match(/function exportAnnualPayments\(\)[\s\S]*?\n\}/) || [''])[0];
  t.eq('export loop no longer uses parseInt(cfg.amount) fallback per-cell',
    /const amount = parseInt\(cfg\.amount\)/.test(exportBody), false);
}

// ════════════════════════════════════════════════════════════════
// v2.14.12 — export: real-debt column + debt-offset note
// ════════════════════════════════════════════════════════════════
{
  t.section('v2.14.12 — annualOffsetNote renders the split, real-debt column present');
  const MONTHS_HE = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const fns = extractFunctions(app, ['annualMonthKey', 'annualRecordFor', 'annualOffsetNote']);
  const yr = new Date().getFullYear();
  const data = {
    tenants: [{ id: 'z1', name: 'רוני' }],
    paymentHistory: { z1: [
      { month: yr+'-06', paid: true, amount: 239, paidAmount: 956, type: 'bank',
        debtOffset: { monthCharge: 239, surplus: 717, priorDebtPaid: 478, newCredit: 239 } }
    ] }
  };
  const ctx = new Function('data','MONTHS_HE', fns + '; return { annualOffsetNote };')(data, MONTHS_HE);
  const note = ctx.annualOffsetNote(data.tenants[0], 'יוני');
  t.eq('note leads with month charge', note.indexOf('239 ₪ עבור החודש') === 0, true);
  t.eq('note mentions prior-debt paydown', note.includes('478 ₪ לכיסוי חוב קודם'), true);
  t.eq('note mentions leftover credit', note.includes('239 ₪ יתרת זכות'), true);
  const data2 = { tenants:[{id:'x'}], paymentHistory:{ x:[{ month: yr+'-06', paid:true }] } };
  const ctx2 = new Function('data','MONTHS_HE', fns + '; return { annualOffsetNote };')(data2, MONTHS_HE);
  t.eq('no offset → empty note', ctx2.annualOffsetNote(data2.tenants[0], 'יוני'), '');

  const exportBody = (app.match(/function exportAnnualPayments\(\)[\s\S]*?\n\}/) || [''])[0];
  t.eq('export header includes real-debt column', app.includes("'חוב מצטבר אמיתי'"), true);
  t.eq('export row reads openingDebt for real-debt', /parseFloat\(t\.openingDebt\)/.test(exportBody), true);
}

// ════════════════════════════════════════════════════════════════
// v2.14.17 — WA reset (Baileys upgrade): banner shows immediately on
// resetPending, and the banner button runs the full reset flow.
// ════════════════════════════════════════════════════════════════
{
  t.section('v2.14.17 — WA reset wiring (app.html)');
  const app = readSource('public/app.html');

  // module-level flag declared alongside the other WA flags
  t.eq('_waResetPending declared', /let _waDisconnectedSince[^;]*_waResetPending = false;/.test(app), true);

  // status handler reads the server flag and shows the banner immediately (no 5-min gate)
  t.eq('reads s.resetPending', app.includes('_waResetPending = !!s.resetPending;'), true);
  t.eq('immediate banner on reset (bypasses 5-min delay)',
    /if \(_waResetPending\) \{\s*showWaBanner\(true/.test(app), true);
  t.eq('reset banner mentions engine upgrade', app.includes('עדכנו את מנוע ה-WhatsApp'), true);

  // flag cleared on ready
  const readyBlock = (app.match(/if\(s\.status==='ready'\)\{[\s\S]*?showWaBanner\(false\);/) || [''])[0];
  t.eq('resetPending cleared on ready', readyBlock.includes('_waResetPending = false;'), true);

  // banner button points at bannerReconnect (NOT plain handleConnClick)
  t.eq('banner button calls bannerReconnect', app.includes('onclick="bannerReconnect()"'), true);

  // bannerReconnect exists and runs the full reset (calls reset-auth) when pending
  const brBody = (app.match(/async function bannerReconnect\(\)[\s\S]*?\n\}/) || [''])[0];
  t.eq('bannerReconnect exists', brBody.length > 0, true);
  t.eq('bannerReconnect posts reset-auth when pending', brBody.includes("/wa/reset-auth"), true);
  t.eq('bannerReconnect falls back to handleConnClick when not pending',
    /if \(!_waResetPending\) \{ handleConnClick\(\); return; \}/.test(brBody), true);
  t.eq('bannerReconnect polls /status for fresh QR', brBody.includes("/status") && brBody.includes('qrDataUrl'), true);

  // MUTATION guard: the old wiring (banner → handleConnClick only) must be gone
  t.eq('banner no longer wired directly to handleConnClick',
    app.includes('id="waBannerReconnectBtn" onclick="handleConnClick()"'), false);
}

// ════════════════════════════════════════════════════════════════
// v2.14.17 — admin.html: bulk WA reset button + handler
// ════════════════════════════════════════════════════════════════
{
  t.section('v2.14.17 — admin WA reset wiring (admin.html)');
  const admin = readSource('public/admin.html');

  t.eq('reset button present', admin.includes('onclick="resetBuildingWa()"'), true);
  const rb = (admin.match(/async function resetBuildingWa\(\)[\s\S]*?\n\}/) || [''])[0];
  t.eq('handler exists', rb.length > 0, true);
  t.eq('lists buildings first', rb.includes('/api/admin/wa-buildings'), true);
  t.eq('posts to reset endpoint', rb.includes('/api/admin/reset-building-wa'), true);
  t.eq('supports all + single', rb.includes('{ all: true }') && rb.includes('{ tenantId:'), true);
  t.eq('guards against non-server mode', rb.includes("data.mode !== 'server'"), true);
  t.eq('double-confirms (prompt + confirm)', rb.includes('prompt(') && rb.includes('confirm('), true);
}

// ════════════════════════════════════════════════════════════════
// v2.14.18 — {שורת_חוב_קודם} whole-line prior-debt placeholder
// (chip + hint + preview ordering + AI-preserve list)
// ════════════════════════════════════════════════════════════════
{
  t.section('v2.14.18 — {שורת_חוב_קודם} chip / hint / preview / AI list');
  const app = readSource('public/app.html');

  // chip present in the template-editor var-tag row
  t.eq('chip inserts {שורת_חוב_קודם}',
    app.includes("insertVar('{שורת_חוב_קודם}')"), true);
  // the old bare chip is still there (backward compat — not removed)
  t.eq('bare {חוב_קודם} chip still present',
    app.includes("insertVar('{חוב_קודם}')"), true);
  // hint explains both variants
  t.eq('hint explains the whole-line variant', app.includes('שורה שלמה "חוב קודם'), true);
  t.eq('hint explains the bare variant yields 0', app.includes('המספר בלבד (0 כשאין)'), true);
  // AI-improve preserve list includes the new placeholder
  t.eq('AI-improve preserves {שורת_חוב_קודם}',
    /הפלייסהולדרים: \{שם\}[^']*\{שורת_חוב_קודם\}[^']*\{חוב_קודם\}/.test(app), true);

  // PREVIEW ORDERING GUARD — the whole-line replacement must run before the
  // bare one, or /{חוב_קודם}/g would eat the substring inside {שורת_חוב_קודם}.
  // Execute the exact replacement chain used by updatePreview on a template
  // containing BOTH placeholders and assert the line survives intact.
  const sampleDebt = 200;
  const rendered = 'שלום {שם}\n{שורת_חוב_קודם}\nחוב מספרי: {חוב_קודם}'
    .replace(/{שם}/g, 'דנה')
    .replace(/{שורת_חוב_קודם}/g, 'חוב קודם: *' + sampleDebt + ' ₪*')
    .replace(/{חוב_קודם}/g, sampleDebt);
  t.eq('preview keeps the whole line intact', rendered.includes('חוב קודם: *200 ₪*'), true);
  t.eq('preview fills the bare number too', rendered.includes('חוב מספרי: 200'), true);
  // the literal placeholder text must NOT survive
  t.eq('no leftover {שורת_חוב_קודם} literal', rendered.includes('{שורת_חוב_קודם}'), false);

  // The two placeholders CANNOT collide: {חוב_קודם} is NOT a substring of
  // {שורת_חוב_קודם} (brace boundary differs — {שורת_… vs {חוב_…), so the
  // /{חוב_קודם}/g regex leaves the whole-line placeholder untouched even if
  // run first. This is what makes both placeholders safe to coexist.
  t.eq('bare placeholder is not a substring of the whole-line one',
    '{שורת_חוב_קודם}'.includes('{חוב_קודם}'), false);
  // regardless of replace order, the whole line survives
  const barefirst = '{שורת_חוב_קודם}'
    .replace(/{חוב_קודם}/g, sampleDebt)
    .replace(/{שורת_חוב_קודם}/g, 'חוב קודם: *' + sampleDebt + ' ₪*');
  t.eq('bare-first order still yields the intact line', barefirst, 'חוב קודם: *200 ₪*');
}

// ════════════════════════════════════════════════════════════════
// v2.14.19 — {שורת_זכות} / {יתרת_זכות} credit placeholders
// ════════════════════════════════════════════════════════════════
{
  t.section('v2.14.19 — credit placeholders: chip / hint / preview / collision');
  const app = readSource('public/app.html');

  t.eq('chip inserts {שורת_זכות}', app.includes("insertVar('{שורת_זכות}')"), true);
  t.eq('chip inserts {יתרת_זכות}', app.includes("insertVar('{יתרת_זכות}')"), true);
  t.eq('hint explains the whole-line credit variant', app.includes('שורה שלמה "יתרת זכות'), true);
  t.eq('AI-improve preserves credit placeholders',
    /\{שורת_זכות\}[^']*\{יתרת_זכות\}/.test(app), true);

  // COLLISION SAFETY — the critical one: {יתרה} (existing) must NOT be a
  // substring of {יתרת_זכות}, or /{יתרה}/g would corrupt the credit placeholder.
  t.eq('{יתרה} is NOT a substring of {יתרת_זכות}',
    '{יתרת_זכות}'.includes('{יתרה}'), false);
  t.eq('{יתרת_זכות} is NOT a substring of {שורת_זכות}',
    '{שורת_זכות}'.includes('{יתרת_זכות}'), false);

  // Execute the preview substitution order used by updatePreview and prove the
  // credit line survives even though {יתרה} is replaced in the same chain.
  const sampleCredit = 120;
  const rendered = '{שורת_זכות}\nמס: {יתרת_זכות}\n{יתרה}'
    .replace(/{שורת_זכות}/g, 'יתרת זכות: *' + sampleCredit + ' ₪*')
    .replace(/{יתרת_זכות}/g, sampleCredit)
    .replace(/{יתרה}/g, 'שילמת 150 ₪, נותר לתשלום: *80 ₪*');
  t.eq('credit whole-line survives', rendered.includes('יתרת זכות: *120 ₪*'), true);
  t.eq('bare credit number filled', rendered.includes('מס: 120'), true);
  t.eq('{יתרה} still resolves independently', rendered.includes('נותר לתשלום'), true);
  t.eq('no leftover {שורת_זכות} literal', rendered.includes('{שורת_זכות}'), false);
  t.eq('no leftover {יתרת_זכות} literal', rendered.includes('{יתרת_זכות}'), false);
}

process.exit(t.done() ? 1 : 0);
