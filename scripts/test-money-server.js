// ════════════════════════════════════════════════════════════════
// test-money-server.js — server-side debt/credit math
// Run: npm test    (or: node scripts/test-money-server.js)
// ════════════════════════════════════════════════════════════════
// Covers the original bug report: "the system marks paid/unpaid regardless of
// the amount actually received", for BOTH per-tenant customAmount and the
// building default.
//
// ⚠️ Invariants these tests defend (see SKILL "sentLog / paymentHistory"):
//   • amount PAID   comes from the sentLog VALUE (source of truth)
//   • amount DUE    comes from paymentHistory.amount (tariff frozen at pay time)
//   • the `paid` FLAG is never consulted for money decisions
//   • overpay ⇒ credit immediately, NOT only after closeMonthUnpaid
//   • a negative openingDebt means the surplus is already banked ⇒ do not
//     count derived credit again (double-count guard)

const { loadServer, makeRunner } = require('./test-lib');

const S = loadServer();
const t = makeRunner('server money math');
const TS = '2026-07-15T10:00:00.000Z';
const J = o => JSON.parse(JSON.stringify(o));

const bank = (amt, payer) => 'bank_import_' + TS + '_' + amt + '_payer_' + (payer || 'x');
const manual = amt => 'manual_paid_' + TS + '_amount_' + amt;

// ── parseSentLogAmount ────────────────────────────────────────────
t.section('parseSentLogAmount — reading what actually arrived');
t.eq('bank, full', S.parseSentLogAmount(bank(450)), 450);
t.eq('bank, decimal', S.parseSentLogAmount(bank(1200.5)), 1200.5);
t.eq('bank, payer name contains "_"', S.parseSentLogAmount(bank(430, 'a_b')), 430);
t.eq('bank, Hebrew payer', S.parseSentLogAmount(bank(430, 'ברקן טל')), 430);
t.eq('manual', S.parseSentLogAmount(manual(500)), 500);
t.eq('reminder is not a payment', S.parseSentLogAmount('sent_' + TS), null);
t.eq('empty', S.parseSentLogAmount(''), null);
t.eq('legacy bank value with no amount', S.parseSentLogAmount('bank_import_' + TS), null);

// ── calcMonthBalance — the core primitive ─────────────────────────
t.section('calcMonthBalance — the reported bug');
t.eq('THE BUG: 300 paid on a 450 fee ⇒ partial, 150 short',
  S.calcMonthBalance(bank(300), 450),
  { status: 'partial', paidAmount: 300, expected: 450, shortfall: 150, credit: 0 });
t.eq('exact payment ⇒ paid, nothing owed',
  S.calcMonthBalance(bank(450), 450),
  { status: 'paid', paidAmount: 450, expected: 450, shortfall: 0, credit: 0 });
t.eq('overpay 600/450 ⇒ paid + 150 credit',
  S.calcMonthBalance(bank(600), 450),
  { status: 'paid', paidAmount: 600, expected: 450, shortfall: 0, credit: 150 });
t.eq('no sentLog entry ⇒ unpaid',
  S.calcMonthBalance('', 450),
  { status: 'unpaid', paidAmount: 0, expected: 450, shortfall: 450, credit: 0 });
t.eq('reminder only ⇒ reminded, NOT paid (the "Tami" rule)',
  S.calcMonthBalance('sent_' + TS, 230),
  { status: 'reminded', paidAmount: 0, expected: 230, shortfall: 230, credit: 0 });
t.eq('legacy value, no amount ⇒ treat as full (no retroactive debt)',
  S.calcMonthBalance('bank_import_' + TS, 450),
  { status: 'paid', paidAmount: 450, expected: 450, shortfall: 0, credit: 0 });
t.eq('default-amount tenant, partial 200/300',
  S.calcMonthBalance(manual(200), 300),
  { status: 'partial', paidAmount: 200, expected: 300, shortfall: 100, credit: 0 });

// ── getExpectedAmount — frozen tariff ─────────────────────────────
t.section('getExpectedAmount — the frozen tariff guard');
const hist = [
  { month: '2026-03', amount: 450, paid: true },
  { month: '2026-04', amount: 450, paid: false },
  { month: '2026-05', amount: 0, type: 'wa_sent' }
];
t.eq('historical month keeps its own tariff', S.getExpectedAmount(hist, '2026-03', 500), 450);
t.eq('no record ⇒ fall back to the live amount', S.getExpectedAmount(hist, '2026-07', 500), 500);
t.eq('wa_sent rows are ignored', S.getExpectedAmount(hist, '2026-05', 230), 230);
t.eq('the paid FLAG is never consulted, only `amount`',
  S.getExpectedAmount([{ month: '2026-06', amount: 230, paid: true }], '2026-06', 500), 230);

// ── Debt / credit end to end ──────────────────────────────────────
const cfg = { amount: 300 };
const T = (customAmount, openingDebt, sentLog, ph) => ({
  config: cfg,
  tenants: [{ id: '1', customAmount, openingDebt }],
  sentLog, paymentHistory: { '1': ph }
});
const debt = d => S.calcTotalDebt(J(d), '1', '2026-07');
const credit = d => S.getCreditBalance(J(d), '1');

t.section('calcTotalDebt / getCreditBalance');
t.eq('full payment ⇒ no debt',
  debt(T(450, 0, { '1_יולי': bank(450) }, [{ month: '2026-07', paid: true, amount: 450 }])), 0);
t.eq('partial 300/450 ⇒ debt 150',
  debt(T(450, 0, { '1_יולי': bank(300) }, [{ month: '2026-07', paid: true, amount: 450 }])), 150);
t.eq('partial + prior openingDebt 200 ⇒ 350',
  debt(T(450, 200, { '1_יולי': bank(300) }, [{ month: '2026-07', paid: true, amount: 450 }])), 350);
t.eq('unpaid history month ⇒ debt 450',
  debt(T(450, 0, {}, [{ month: '2026-06', paid: false, amount: 450 }])), 450);
t.eq('reminder only ⇒ still owed',
  debt(T(230, 0, { '1_יוני': 'sent_' + TS }, [{ month: '2026-06', paid: false, amount: 230 }])), 230);
t.eq('two partial months accumulate',
  debt(T(450, 0, { '1_יוני': bank(300), '1_יולי': bank(350) },
    [{ month: '2026-06', paid: true, amount: 450 }, { month: '2026-07', paid: true, amount: 450 }])), 250);

t.section('credit — must be symmetric with shortfall');
t.eq("Tal's case: 430 paid on a 230 fee ⇒ credit 200 IMMEDIATELY",
  credit(T(null, 0, { '1_יולי': bank(430) }, [{ month: '2026-07', paid: true, amount: 230 }])), 200);
t.eq('DOUBLE-COUNT GUARD: after closeMonthUnpaid banked it (openingDebt −550) ⇒ still 550, not 1100',
  credit(T(450, -550, { '1_יולי': bank(1000) }, [{ month: '2026-07', paid: true, amount: 450 }])), 550);
t.eq('overpay 600/450 ⇒ credit 150',
  credit(T(450, 0, { '1_יולי': bank(600) }, [{ month: '2026-07', paid: true, amount: 450 }])), 150);
t.eq('existing credit absorbs a later shortfall (550 − 150 = 400)',
  credit(T(450, -550, { '1_יולי': bank(300) }, [{ month: '2026-07', paid: true, amount: 450 }])), 400);
t.eq('surplus smaller than a later shortfall ⇒ net debt',
  debt(T(450, 0, { '1_יוני': bank(500) , '1_יולי': bank(200) },
    [{ month: '2026-06', paid: true, amount: 450 }, { month: '2026-07', paid: true, amount: 450 }])), 200);

t.section('tariff change must not invent debt retroactively');
t.eq('paid 450 in March, fee later raised to 500 ⇒ still no debt',
  debt(T(500, 0, { '1_מרץ': bank(450) }, [{ month: '2026-03', paid: true, amount: 450 }])), 0);

t.section('isolation');
t.eq('__acc__ (extra-account) keys are ignored',
  debt(T(450, 0, { '1__acc__acc_9_יולי': bank(10), '1_יולי': bank(450) },
    [{ month: '2026-07', paid: true, amount: 450 }])), 0);
t.eq('legacy ISO-style sentLog key is ignored',
  debt(T(450, 0, { '1_2026-04': bank(1), '1_יולי': bank(450) },
    [{ month: '2026-07', paid: true, amount: 450 }])), 0);
t.eq("another tenant's sentLog does not leak in",
  S.calcTotalDebt(J({
    config: cfg,
    tenants: [{ id: '1', customAmount: 450, openingDebt: 0 }, { id: '2', customAmount: 450, openingDebt: 0 }],
    sentLog: { '2_יולי': bank(100), '1_יולי': bank(450) },
    paymentHistory: { '1': [{ month: '2026-07', paid: true, amount: 450 }], '2': [] }
  }), '1', '2026-07'), 0);

// ── The original complaint: a different amount per tenant ─────────
t.section('★ per-tenant customAmount (the original report)');
const building = {
  config: { amount: 300 },
  tenants: [
    { id: '101', customAmount: 180, openingDebt: 0 },
    { id: '102', customAmount: 230, openingDebt: 0 },
    { id: '103', customAmount: 450, openingDebt: 0 },
    { id: '104', customAmount: 800, openingDebt: 0 },
    { id: '105', customAmount: null, openingDebt: 0 }
  ],
  sentLog: {
    '101_יולי': bank(180), '102_יולי': bank(150), '103_יולי': bank(600),
    '104_יולי': bank(500), '105_יולי': bank(250)
  },
  paymentHistory: {
    '101': [{ month: '2026-07', paid: true, amount: 180 }],
    '102': [{ month: '2026-07', paid: true, amount: 230 }],
    '103': [{ month: '2026-07', paid: true, amount: 450 }],
    '104': [{ month: '2026-07', paid: true, amount: 800 }],
    '105': [{ month: '2026-07', paid: true, amount: 300 }]
  }
};
t.eq('180/180 exact ⇒ 0', S.calcTotalDebt(J(building), '101', '2026-07'), 0);
t.eq('150/230 partial ⇒ 80', S.calcTotalDebt(J(building), '102', '2026-07'), 80);
t.eq('600/450 overpay ⇒ debt 0', S.calcTotalDebt(J(building), '103', '2026-07'), 0);
t.eq('600/450 overpay ⇒ credit 150', S.getCreditBalance(J(building), '103'), 150);
t.eq('500/800 partial ⇒ 300', S.calcTotalDebt(J(building), '104', '2026-07'), 300);
t.eq('default 250/300 partial ⇒ 50', S.calcTotalDebt(J(building), '105', '2026-07'), 50);

t.section('customAmount edge cases');
const noHist = {
  config: cfg,
  tenants: [{ id: '201', customAmount: 450, openingDebt: 0 }, { id: '202', customAmount: null, openingDebt: 0 }],
  sentLog: { '201_יולי': bank(300), '202_יולי': bank(200) },
  paymentHistory: {}
};
t.eq('no paymentHistory ⇒ falls back to customAmount (450), not the default',
  S.calcTotalDebt(J(noHist), '201', '2026-07'), 150);
t.eq('no paymentHistory, no customAmount ⇒ falls back to config.amount (300)',
  S.calcTotalDebt(J(noHist), '202', '2026-07'), 100);
t.eq('customAmount = 0 is falsy ⇒ default applies',
  S.calcTotalDebt(J(T(0, 0, { '1_יולי': bank(300) }, [])), '1', '2026-07'), 0);

// ── customAmount changed BEFORE payment (the v2.13.14 bug) ────────
// approach A: the amount owed is decided at PAYMENT time. A stale frozen
// record from an earlier reminder must not win once the tenant pays.
t.section('★ customAmount changed before marking paid (v2.13.14)');
{
  const mk = S.getMonthKey({});
  // recordPayment with the LIVE amount (350) must overwrite a stale 230 record.
  const d = {
    config: { amount: 230 },
    tenants: [{ id: 'tal', customAmount: 350, openingDebt: 0, name: 'טל' }],
    sentLog: { '1_ignored': '' },
    paymentHistory: { tal: [{ month: mk, paid: true, amount: 230, paidAmount: 0, type: 'manual' }] }
  };
  // This mirrors exactly what the /sentlog-key manual-mark branch now does:
  const live = d.tenants[0].customAmount || d.config.amount || 300;
  // (recordPayment is loaded by loadServer)
  const S2 = require('./test-lib').loadServer();
  S2.recordPayment(d, 'tal', mk, 'manual', live, 'טל', '', 150);
  t.eq('stale 230 record is refreshed to the live 350', d.paymentHistory.tal[0].amount, 350);
  t.eq('paidAmount kept at 150', d.paymentHistory.tal[0].paidAmount, 150);
}
// And the expected amount must equal the refreshed tariff, giving debt 350-150.
{
  const S2 = require('./test-lib').loadServer();
  const mk = S2.getMonthKey({});
  const d = {
    config: { amount: 230 },
    tenants: [{ id: 'tal', customAmount: 350, openingDebt: 0, name: 'טל' }],
    sentLog: { ['tal_' + S2.HEBREW_MONTHS[parseInt(mk.split('-')[1]) - 1]]: 'manual_paid_x_amount_150' },
    paymentHistory: { tal: [{ month: mk, paid: true, amount: 350, paidAmount: 150, type: 'manual' }] }
  };
  t.eq('debt after refreshed tariff = 350 − 150 = 200', S2.calcTotalDebt(JSON.parse(JSON.stringify(d)), 'tal', mk), 200);
}
// A GENUINE historical tariff change must STILL be frozen (the guard we keep).
{
  const S2 = require('./test-lib').loadServer();
  const d = {
    config: { amount: 300 },
    tenants: [{ id: 'x', customAmount: 500, openingDebt: 0 }],
    sentLog: { '1_ignored': '' },
    paymentHistory: { x: [{ month: '2026-03', paid: true, amount: 450, paidAmount: 450, type: 'manual' }] }
  };
  // March was paid at 450; raising the fee to 500 today must not add debt to March.
  t.eq('a settled historical month keeps its own tariff (no retroactive debt)',
    S2.getExpectedAmount(d.paymentHistory.x, '2026-03', 500), 450);
}

// ════════════════════════════════════════════════════════════════
// Fix #0 (v2.13.15) — the Agent import path must NOT net openingDebt.
// Accrual lives ONLY in closeMonthUnpaid, so a bank import via the Agent
// (analyzeBankRowsServer) leaves openingDebt untouched — identical footprint
// to the manual path (which only sets sentLog). Re-introducing the netting
// call (applyPaymentToDebt inside analyzeBankRowsServer) MUST fail these.
// ════════════════════════════════════════════════════════════════
t.section('Fix #0 — Agent import does not net openingDebt');
{
  const { loadBankAnalyzer } = require('./test-lib');
  const B = loadBankAnalyzer();

  // helper: one tenant with an opening debt, one bank row that matches by name.
  const runImport = (openingDebt, rowAmount) => {
    const rows = [
      ['שם', 'סכום'],            // header
      ['דוד כהן', String(rowAmount)]
    ];
    const mapping = { colName: 0, colAmount: 1, colDate: -1, colNote: -1 };
    const tenants = [{ id: 'dk', name: 'דוד כהן', phone: '0501234567', keywords: '', customAmount: 230, openingDebt }];
    return B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-07', { amount: 230 });
  };

  // (a) a payment larger than the debt used to zero openingDebt — now it must stay put.
  {
    const r = runImport(500, 230);
    t.eq('matched the tenant', r.matched.length, 1);
    t.eq('openingDebt is UNCHANGED by the import (was 500)', r.updatedTenants[0].openingDebt, 500);
    t.eq('sentLog is set on match', String(r.newSentLog['dk_יולי'] || '').startsWith('bank_import_'), true);
  }
  // (b) a partial payment used to reduce openingDebt — now it must stay put.
  {
    const r = runImport(300, 100);
    t.eq('openingDebt is UNCHANGED by a partial import (was 300)', r.updatedTenants[0].openingDebt, 300);
  }
  // (c) debtReduced is now always false (no netting happens at import time).
  {
    const r = runImport(500, 230);
    t.eq('matched[].debtReduced is false (netting deferred to closeMonthUnpaid)', r.matched[0].debtReduced, false);
  }
  // (d) applyPaymentToDebt itself is unchanged (kept for Stage 3/4) — it still nets
  //     when called directly. This proves the fix removed the CALL, not the logic.
  {
    const tt = { openingDebt: 500 };
    const out = B.applyPaymentToDebt(tt, 230);
    t.eq('applyPaymentToDebt still nets when called directly (logic intact)', tt.openingDebt, 270);
    t.eq('applyPaymentToDebt returns creditForMonth 0 on partial', out.creditForMonth, 0);
  }
}

// ════════════════════════════════════════════════════════════════
// COLUMN A — fixed-amount tariff history (v2.13.16)
// ════════════════════════════════════════════════════════════════
// The phantom-debt fix: a retroactive import must freeze the tariff in effect
// FOR the imported month, not today's customAmount. These tests run against the
// REAL server helpers extracted by test-lib (monthInInterval, pickRateFromIntervals,
// resolveTariffRate, closeAndOpenInterval, seedTariffsIfMissing).

t.section('Column A — monthInInterval');
t.eq('month inside an open interval', S.monthInInterval('2026-05', { rate: 230, startDate: '2026-01-01', endDate: null }), true);
t.eq('month before start', S.monthInInterval('2025-12', { rate: 230, startDate: '2026-01-01', endDate: null }), false);
t.eq('month inside a closed interval', S.monthInInterval('2026-03', { rate: 230, startDate: '2026-01-01', endDate: '2026-06-30' }), true);
t.eq('month after a closed interval', S.monthInInterval('2026-07', { rate: 230, startDate: '2026-01-01', endDate: '2026-06-30' }), false);
t.eq('start month itself is covered (mid-month start)', S.monthInInterval('2026-01', { rate: 230, startDate: '2026-01-15', endDate: null }), true);

t.section('Column A — pickRateFromIntervals (latest start wins)');
t.eq('empty → null', S.pickRateFromIntervals([], '2026-05'), null);
t.eq('single open interval', S.pickRateFromIntervals([{ rate: 230, startDate: '2026-01-01', endDate: null }], '2026-05'), 230);
t.eq('picks the historical closed interval for an old month',
  S.pickRateFromIntervals([
    { rate: 230, startDate: '2026-01-01', endDate: '2026-06-30' },
    { rate: 350, startDate: '2026-07-01', endDate: null }
  ], '2026-04'), 230);
t.eq('picks the current open interval for a recent month',
  S.pickRateFromIntervals([
    { rate: 230, startDate: '2026-01-01', endDate: '2026-06-30' },
    { rate: 350, startDate: '2026-07-01', endDate: null }
  ], '2026-08'), 350);
t.eq('no interval covers the month → null', S.pickRateFromIntervals([{ rate: 230, startDate: '2026-05-01', endDate: null }], '2026-01'), null);

t.section('Column A — resolveTariffRate (THE resolution order)');
{
  const dflt = [{ rate: 300, startDate: '2000-01-01', endDate: null }];
  // 1. personal override wins
  const tenantWithPersonal = { personalTariffs: [{ rate: 230, startDate: '2026-01-01', endDate: null }] };
  t.eq('personal overrides default', S.resolveTariffRate(tenantWithPersonal, dflt, '2026-05', 999), 230);
  // 2. falls to default when no personal covers the month
  t.eq('default when no personal', S.resolveTariffRate({ personalTariffs: [] }, dflt, '2026-05', 999), 300);
  // 3. legacy fallback when nothing resolves
  t.eq('legacy fallback when no tables', S.resolveTariffRate({}, null, '2026-05', 250), 250);
  // 4. NEVER a silent 0/undefined — returns the numeric fallback
  t.eq('never silent undefined — returns numeric fallback', S.resolveTariffRate({}, [], '2026-05', 300), 300);
}

t.section('Column A — THE phantom-debt bug: retroactive import uses HISTORICAL rate');
{
  // Tal's real incident: on 230 Jan–Jun, changed to 350 in July, then imported
  // old Apr/May/Jun files. Old code stamped 350 (today) → 3×120 = 360 phantom debt.
  const tenant = { id: 't1', personalTariffs: [
    { rate: 230, startDate: '2026-01-01', endDate: '2026-06-30' },
    { rate: 350, startDate: '2026-07-01', endDate: null }
  ]};
  const dflt = [{ rate: 300, startDate: '2000-01-01', endDate: null }];
  // Importing April (a closed-interval month) must freeze 230, NOT 350.
  t.eq('retroactive April import freezes 230, not today\'s 350',
    S.resolveTariffRate(tenant, dflt, '2026-04', 350), 230);
  t.eq('retroactive May import freezes 230', S.resolveTariffRate(tenant, dflt, '2026-05', 350), 230);
  t.eq('current-month (July) payment freezes 350', S.resolveTariffRate(tenant, dflt, '2026-07', 350), 350);
  // The full record then carries the correct expected, so calcMonthBalance is right:
  const aprBal = S.calcMonthBalance(bank(230), S.resolveTariffRate(tenant, dflt, '2026-04', 350));
  t.eq('April 230/230 reads as PAID (no phantom shortfall)',
    aprBal, { status: 'paid', paidAmount: 230, expected: 230, shortfall: 0, credit: 0 });
}

t.section('Column A — closeAndOpenInterval');
{
  const before = [{ rate: 230, startDate: '2026-01-01', endDate: null }];
  const after = S.closeAndOpenInterval(before, 350, '2026-07-18');
  t.eq('open interval is closed at asOf', after[0].endDate, '2026-07-18');
  t.eq('new open interval opened at asOf', after[1], { rate: 350, startDate: '2026-07-18', endDate: null });
  t.eq('same-rate re-save is a no-op (no churn)',
    S.closeAndOpenInterval([{ rate: 230, startDate: '2026-01-01', endDate: null }], 230, '2026-07-18').length, 1);
  t.eq('opening on an empty array', S.closeAndOpenInterval([], 300, '2026-07-18'),
    [{ rate: 300, startDate: '2026-07-18', endDate: null }]);
}

t.section('Column A — delete reverts to default (past keeps override)');
{
  // "revert to default": close the open personal interval, don't open a new one.
  const arr = [{ rate: 230, startDate: '2026-01-01', endDate: null }];
  const open = arr.find(iv => iv.endDate == null);
  open.endDate = '2026-07-18';
  const dflt = [{ rate: 300, startDate: '2000-01-01', endDate: null }];
  const tenant = { personalTariffs: arr };
  t.eq('past month still uses the override 230', S.resolveTariffRate(tenant, dflt, '2026-03', 999), 230);
  t.eq('month after deletion reverts to default 300', S.resolveTariffRate(tenant, dflt, '2026-08', 999), 300);
}

t.section('Column A — seedTariffsIfMissing (lazy migration)');
{
  // customAmount == default → NO personalTariffs (rides default).
  const dOnDefault = { config: { amount: 300 }, tenants: [{ id: 'a', customAmount: 300 }] };
  const seeded1 = S.seedTariffsIfMissing(dOnDefault);
  t.eq('seeding happened (defaultTariffs created)', seeded1, true);
  t.eq('defaultTariffs seeded from config.amount', dOnDefault.defaultTariffs, [{ rate: 300, startDate: '2000-01-01', endDate: null }]);
  t.eq('tenant on default gets NO personalTariffs', dOnDefault.tenants[0].personalTariffs, undefined);

  // customAmount != default → one open personal interval.
  const dDiffers = { config: { amount: 300 }, tenants: [{ id: 'b', customAmount: 230 }] };
  S.seedTariffsIfMissing(dDiffers);
  t.eq('tenant differing from default gets one open personal interval',
    dDiffers.tenants[0].personalTariffs, [{ rate: 230, startDate: '2000-01-01', endDate: null }]);

  // Idempotent: second seed is a no-op.
  t.eq('second seed is a no-op', S.seedTariffsIfMissing(dDiffers), false);

  // null customAmount → rides default, no personal.
  const dNull = { config: { amount: 300 }, tenants: [{ id: 'c', customAmount: null }] };
  S.seedTariffsIfMissing(dNull);
  t.eq('null customAmount → no personalTariffs', dNull.tenants[0].personalTariffs, undefined);
}

// ════════════════════════════════════════════════════════════════
// STAGE 3 — partial-payment balance reminder (v2.13.18)
// ════════════════════════════════════════════════════════════════
// A partial payer must (a) get a {יתרה} balance line, and (b) NOT be skipped by
// AutoSend. A full payer gets neither. Delegates to calcMonthBalance (one source).

t.section('Stage 3 — buildBalanceLine ({יתרה})');
{
  // Pin the effective month to מאי (May) so the sentLog key + mk line up.
  const cfg = { amount: 230, manualMonth: 'מאי' };
  const mk = '2026-05';
  const mkTenant = { id: 'p1', name: 'דנה' };
  // partial: paid 150 of 230 → line present
  const dPartial = { config: cfg, sentLog: { 'p1_מאי': 'bank_import_2026-05-10T00:00:00Z_150_payer_x' }, paymentHistory: {}, tenants: [mkTenant] };
  t.eq('partial payer gets a balance line',
    S.buildBalanceLine(dPartial, mkTenant, mk), 'שילמת 150 ₪, נותר לתשלום: *80 ₪*');
  // full: paid 230 → empty
  const dFull = { config: cfg, sentLog: { 'p1_מאי': 'bank_import_2026-05-10T00:00:00Z_230_payer_x' }, paymentHistory: {}, tenants: [mkTenant] };
  t.eq('full payer gets no balance line', S.buildBalanceLine(dFull, mkTenant, mk), '');
  // unpaid: no sentLog payment → empty
  const dUnpaid = { config: cfg, sentLog: {}, paymentHistory: {}, tenants: [mkTenant] };
  t.eq('unpaid tenant gets no balance line', S.buildBalanceLine(dUnpaid, mkTenant, mk), '');
  // reminded only: sent_ → empty
  const dReminded = { config: cfg, sentLog: { 'p1_מאי': 'sent_2026-05-10T00:00:00Z' }, paymentHistory: {}, tenants: [mkTenant] };
  t.eq('reminded-only tenant gets no balance line', S.buildBalanceLine(dReminded, mkTenant, mk), '');
  // overpay: paid 300 of 230 → NOT partial → empty (credit, not balance)
  const dOver = { config: cfg, sentLog: { 'p1_מאי': 'bank_import_2026-05-10T00:00:00Z_300_payer_x' }, paymentHistory: {}, tenants: [mkTenant] };
  t.eq('overpayer gets no balance line', S.buildBalanceLine(dOver, mkTenant, mk), '');
}

t.section('Stage 3 — autoSendShouldRemind (partial payer NOT skipped)');
{
  const cfg = { amount: 230, manualMonth: 'מאי' };
  const mk = '2026-05';
  const tn = { id: 'p2', name: 'עמית' };
  const mk2 = (sl) => ({ config: cfg, sentLog: sl, paymentHistory: {}, tenants: [tn] });
  t.eq('nothing yet → remind', S.autoSendShouldRemind(mk2({}), tn, mk), true);
  t.eq('already reminded (sent_) → skip',
    S.autoSendShouldRemind(mk2({ 'p2_מאי': 'sent_2026-05-10T00:00:00Z' }), tn, mk), false);
  t.eq('full payment → skip',
    S.autoSendShouldRemind(mk2({ 'p2_מאי': 'bank_import_2026-05-10T00:00:00Z_230_payer_x' }), tn, mk), false);
  t.eq('PARTIAL payment → remind (the Stage 3 fix)',
    S.autoSendShouldRemind(mk2({ 'p2_מאי': 'bank_import_2026-05-10T00:00:00Z_150_payer_x' }), tn, mk), true);
  t.eq('overpayment → skip',
    S.autoSendShouldRemind(mk2({ 'p2_מאי': 'bank_import_2026-05-10T00:00:00Z_300_payer_x' }), tn, mk), false);
}

// ════════════════════════════════════════════════════════════════
// Stage 4 (v2.13.21) — closeMonthUnpaid accrues partial-payment shortfall
// ════════════════════════════════════════════════════════════════
// The ONLY stage that touches debt logic. Runs the REAL closeMonthUnpaid via
// loadCloseMonth (stubbed I/O), so re-removing the overpay<0 branch fails here.
const { loadCloseMonth } = require('./test-lib');

t.section('Stage 4 — closeMonthUnpaid partial-payment shortfall accrual');
{
  // Freeze "now" to 1 July 2026 → prevKey = 2026-06 (June), prevHebMonth = יוני.
  const NOW = new Date('2026-07-01T08:00:00.000Z');
  const cfg = { amount: 230 };

  // Helper: build a one-tenant building for June (prevKey), run close, return
  // the tenant + the captured save patch.
  const runClose = (tenant, sentLog) => {
    const building = { config: cfg, tenants: [tenant], paymentHistory: { [tenant.id]: [] }, sentLog: sentLog || {} };
    if (tenant._hist) building.paymentHistory[tenant.id] = tenant._hist;
    const { run, saved } = loadCloseMonth(building, NOW);
    run();
    return { tenant: building.tenants[0], saved, building };
  };

  // (a) PARTIAL payment (paid 150 / expected 230) → shortfall 80 accrues.
  {
    const tn = { id: 'p1', name: 'לימור', customAmount: 230, openingDebt: 0,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 150, type: 'bank' }] };
    const { tenant } = runClose(tn, { 'p1_יוני': bank(150) });
    t.eq('partial 150/230 → openingDebt += 80', tenant.openingDebt, 80);
  }

  // (a′) The record is stamped shortfallBanked:true (double-count marker).
  {
    const tn = { id: 'p1', name: 'לימור', customAmount: 230, openingDebt: 0,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 150, type: 'bank' }] };
    const { building } = runClose(tn, { 'p1_יוני': bank(150) });
    const rec = building.paymentHistory['p1'].find(r => r.month === '2026-06');
    t.eq('partial record stamped shortfallBanked:true', rec.shortfallBanked, true);
    t.eq('partial record kept paid:true (money did arrive)', rec.paid, true);
  }

  // (b) PARTIAL on top of existing debt → adds to it.
  {
    const tn = { id: 'p1', name: 'לימור', customAmount: 230, openingDebt: 100,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 200, type: 'bank' }] };
    const { tenant } = runClose(tn, { 'p1_יוני': bank(200) });
    t.eq('partial 200/230 with prior debt 100 → 130', tenant.openingDebt, 130);
  }

  // (c) FULL payment (230/230) → no accrual, no marker.
  {
    const tn = { id: 'p1', name: 'x', customAmount: 230, openingDebt: 0,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 230, type: 'bank' }] };
    const { tenant, building } = runClose(tn, { 'p1_יוני': bank(230) });
    t.eq('full payment → openingDebt stays 0', tenant.openingDebt, 0);
    const rec = building.paymentHistory['p1'].find(r => r.month === '2026-06');
    t.eq('full payment → no shortfallBanked marker', !!rec.shortfallBanked, false);
  }

  // (d) OVERPAYMENT (300/230) → credit (negative openingDebt), unchanged behaviour.
  {
    const tn = { id: 'p1', name: 'x', customAmount: 230, openingDebt: 0,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 300, type: 'bank' }] };
    const { tenant } = runClose(tn, { 'p1_יוני': bank(300) });
    t.eq('overpay 300/230 → openingDebt −70 (credit)', tenant.openingDebt, -70);
  }

  // (e) FROZEN expected wins over live customAmount (Column A drift guard).
  // Tenant paid 230 in June (frozen amount:230) but fee was RAISED to 350 today.
  // Shortfall must be 0 (paid full 230 of the June rate), NOT 120.
  {
    const tn = { id: 'p1', name: 'x', customAmount: 350, openingDebt: 0,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 230, type: 'bank' }] };
    const { tenant } = runClose(tn, { 'p1_יוני': bank(230) });
    t.eq('frozen June rate 230 (not live 350) → no phantom shortfall', tenant.openingDebt, 0);
  }

  // (f) No record at all → full month accrues (pre-existing behaviour, unchanged).
  {
    const tn = { id: 'p1', name: 'x', customAmount: 230, openingDebt: 0, _hist: [] };
    const { tenant } = runClose(tn, {});
    t.eq('no record → full 230 accrues', tenant.openingDebt, 230);
  }
}

t.section('Stage 4 — double-count guard (banked shortfall not re-added live)');
{
  // After closeMonthUnpaid has banked June's 80 shortfall into openingDebt AND
  // stamped shortfallBanked:true, the live derivation must NOT add it again —
  // symmetric with the negative-openingDebt credit guard (getDerivedCredit).
  const cfg = { amount: 230, manualMonth: 'יולי' }; // current month = July, so June is history
  const base = tid => ({
    config: cfg,
    sentLog: { [tid + '_יוני']: bank(150) }, // June: partial 150/230 (shortfall 80)
    tenants: [{ id: tid, name: 'לימור', customAmount: 230, openingDebt: 80 }],
    paymentHistory: { [tid]: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 150, type: 'bank', shortfallBanked: true }] }
  });

  const d1 = base('p1');
  t.eq('shortfallBanked June skipped by calcShortfallFromSentLog',
    S.calcShortfallFromSentLog(d1, 'p1', { year: 2026 }).total, 0);
  // totalDebt = openingDebt(80) + historyDebt(0, record is paid) + live shortfall(0, banked) = 80
  t.eq('totalDebt = 80 (banked once, not doubled to 160)',
    S.calcTotalDebt(d1, 'p1', '2026-07'), 80);

  // Contrast: WITHOUT the banked marker (mid-month, pre-close) the live shortfall
  // DOES count — openingDebt 0, live shortfall 80 → 80. (Not doubled either way.)
  const d2 = base('p2');
  d2.tenants[0].openingDebt = 0;
  d2.paymentHistory['p2'][0].shortfallBanked = false;
  t.eq('un-banked partial counts live (pre-close)',
    S.calcShortfallFromSentLog(d2, 'p2', { year: 2026 }).total, 80);
  t.eq('totalDebt pre-close = 80 (live shortfall only)',
    S.calcTotalDebt(d2, 'p2', '2026-07'), 80);
}

process.exit(t.done() ? 1 : 0);
