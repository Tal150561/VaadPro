// ════════════════════════════════════════════════════════════════
// test-contract-e2e.js — the server→page CONTRACT
// Run: npm test    (or: node scripts/test-contract-e2e.js)
// ════════════════════════════════════════════════════════════════
// Since v2.13.10 the pages compute nothing: they render whatever the server
// ships. That makes the PAYLOAD SHAPE a contract. Rename or drop a field in
// GET /api/data and the tables silently go blank — which is precisely how the
// "WhatsApp disconnect loop" was really an undefined variable.
//
// These tests build the real payload and assert:
//   1. every field the pages read is present
//   2. the numbers are right for a mixed building (a different fee per tenant)
//   3. the portal's amountDue is correct, including the "paid + surplus" case
//      that used to render "שולם ✅" and "לתשלום 30 ₪" at the same time

const { loadServer, enrichTenants, portalCurrent, readSource, makeRunner } = require('./test-lib');

const S = loadServer();
const t = makeRunner('server→page contract');
const TS = '2026-07-15T10:00:00.000Z';
const bank = (amt, payer) => 'bank_import_' + TS + '_' + amt + '_payer_' + (payer || 'x');

// Use the ACTIVE month so currentBalance resolves the way the app sees it.
const em = S.HEBREW_MONTHS[new Date().getMonth()];
const mk = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');

const building = {
  config: { amount: 300, manualMonth: em },
  tenants: [
    { id: '1', customAmount: 180, openingDebt: 0 },   // exact
    { id: '2', customAmount: 230, openingDebt: 0 },   // partial
    { id: '3', customAmount: 450, openingDebt: 0 },   // overpay
    { id: '4', customAmount: 800, openingDebt: 200 }, // unpaid + prior debt
    { id: '5', customAmount: null, openingDebt: 0 }   // default fee, partial
  ],
  sentLog: {
    ['1_' + em]: bank(180),
    ['2_' + em]: bank(150),
    ['3_' + em]: bank(600),
    ['5_' + em]: bank(250)
  },
  paymentHistory: { '1': [], '2': [], '3': [], '4': [], '5': [] }
};

const rows = enrichTenants(S, building);
const by = id => rows.find(r => String(r.id) === id);

t.section('GET /api/data — every field the pages read must exist');
for (const f of ['creditBalance', 'totalDebt', 'effectiveAmount', 'monthBalances', 'currentBalance']) {
  t.eq('tenant payload has `' + f + '`', by('1')[f] !== undefined, true);
}
t.eq('currentBalance carries a status', typeof by('1').currentBalance.status, 'string');
t.eq('effectiveAmount resolves customAmount', by('3').effectiveAmount, 450);
t.eq('effectiveAmount falls back to config.amount', by('5').effectiveAmount, 300);

t.section('GET /api/data — numbers for a building with a different fee per tenant');
t.eq('exact 180/180 ⇒ no debt, no credit',
  { debt: by('1').totalDebt, credit: by('1').creditBalance }, { debt: 0, credit: 0 });
t.eq('partial 150/230 ⇒ debt 80',
  { debt: by('2').totalDebt, status: by('2').currentBalance.status }, { debt: 80, status: 'partial' });
t.eq('overpay 600/450 ⇒ credit 150, no debt',
  { debt: by('3').totalDebt, credit: by('3').creditBalance }, { debt: 0, credit: 150 });
t.eq('unpaid + prior debt 200 ⇒ debt 200',
  { debt: by('4').totalDebt, status: by('4').currentBalance.status }, { debt: 200, status: 'unpaid' });
t.eq('default-fee tenant, partial 250/300 ⇒ debt 50', by('5').totalDebt, 50);

t.section('GET /api/data — resilient inputs');
t.noThrow('tenants array missing entirely', () => enrichTenants(S, { config: { amount: 230 }, sentLog: {}, paymentHistory: {} }));
t.noThrow('sentLog missing', () => enrichTenants(S, { config: { amount: 230 }, tenants: [{ id: '1' }], paymentHistory: {} }));
t.noThrow('paymentHistory missing', () => enrichTenants(S, { config: { amount: 230 }, tenants: [{ id: '1' }], sentLog: {} }));
t.noThrow('numeric tenant id', () => enrichTenants(S, {
  config: { amount: 230 }, tenants: [{ id: 1774516750744 }],
  sentLog: { ['1774516750744_' + em]: bank(230) }, paymentHistory: {}
}));

// ── Portal contract ───────────────────────────────────────────────
const cfg = { amount: 230 };
const sk = '1_' + em;
const P = (od, sentLog, ph) => ({
  config: cfg, tenants: [{ id: '1', customAmount: null, openingDebt: od }],
  sentLog, paymentHistory: { '1': ph }
});
const due = d => portalCurrent(S, d, '1', 230, mk, sk).amountDue;

t.section('GET /api/portal — amountDue');
t.eq('★ paid 430 on a 230 fee ⇒ 0 due (was showing 30 — the same money twice)',
  due(P(0, { [sk]: bank(430) }, [{ month: mk, paid: true, amount: 230 }])), 0);
t.eq('unpaid ⇒ the full fee', due(P(0, {}, [])), 230);
t.eq('exact payment ⇒ 0', due(P(0, { [sk]: bank(230) }, [{ month: mk, paid: true, amount: 230 }])), 0);
t.eq('partial 150/230 ⇒ 80 still due',
  due(P(0, { [sk]: bank(150) }, [{ month: mk, paid: true, amount: 230 }])), 80);
t.eq('credit 200 from an earlier month ⇒ 30 due', due(P(-200, {}, [])), 30);
t.eq('credit 400 covers the month ⇒ 0 due', due(P(-400, {}, [])), 0);
t.eq('unpaid + prior debt 200 ⇒ 430 due', due(P(200, {}, [])), 430);
t.eq('paid + prior debt 200 ⇒ 200 due',
  due(P(200, { [sk]: bank(230) }, [{ month: mk, paid: true, amount: 230 }])), 200);
t.eq('partial + prior debt 200 ⇒ 280 due',
  due(P(200, { [sk]: bank(150) }, [{ month: mk, paid: true, amount: 230 }])), 280);
t.eq('reminder only ⇒ the full fee', due(P(0, { [sk]: 'sent_' + TS }, [])), 230);

t.section('GET /api/portal — payload fields the page reads');
const cur = portalCurrent(S, P(0, { [sk]: bank(430) }, [{ month: mk, paid: true, amount: 230 }]), '1', 230, mk, sk);
for (const f of ['balance', 'amountDue', 'priorDebt', 'creditBalance']) {
  t.eq('current has `' + f + '`', cur[f] !== undefined, true);
}
t.eq('balance.status is exposed for the banner', cur.balance.status, 'paid');
t.eq('credit is real-time (no wait for closeMonthUnpaid)', cur.creditBalance, 200);

// ── The route must still attach the fields ────────────────────────
t.section('server.js — the enrichment is actually wired into the routes');
const server = readSource('server.js');
t.eq('GET /api/data computes totalDebt via calcTotalDebt',
  /const totalNow = calcTotalDebt\(d, tid, mkNow\)/.test(server), true);
t.eq('GET /api/data attaches totalDebt', /totalDebt:\s*totalNow/.test(server), true);
// v2.13.32 — priorDebt must be shipped too, or app.html re-derives it and
// double-counts an unpaid current-month history row (₪230 reported as ₪460).
t.eq('GET /api/data attaches priorDebt', /priorDebt:\s*Math\.max\(0, totalNow - curInTotal\)/.test(server), true);
t.eq('priorDebt subtracts the partial shortfall',
  /emBal\.status === 'partial' \? \(parseFloat\(emBal\.shortfall\)/.test(server), true);
t.eq('priorDebt subtracts an unpaid current-month history row',
  /hist\.some\(r => r\.month === mkNow && !r\.paid && r\.type !== 'wa_sent'\)/.test(server), true);
t.eq('GET /api/data attaches monthBalances', /monthBalances,/.test(server), true);
t.eq('portal route attaches amountDue', /amountDue:\s*amountDue/.test(server), true);

process.exit(t.done() ? 1 : 0);
