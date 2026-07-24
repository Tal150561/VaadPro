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

t.section('Column A — v2.13.28: ZERO-LIFE interval (set-then-revert same month)');
{
  // Tal's second incident: personal tariff 350 set 18/07, reverted 19/07.
  // The corpse [18/07 -> 19/07] swallowed ALL of July via month-prefix compare,
  // so a 230 bank payment was scored against expected=350 => phantom 120 debt.
  const dflt = [{ rate: 230, startDate: '2000-01-01', endDate: null }];
  const zl = { rate: 350, startDate: '2026-07-18', endDate: '2026-07-19' };

  t.eq('zero-life interval does NOT claim its own month',
    S.monthInInterval('2026-07', zl), false);
  t.eq('zero-life interval claims no later month',
    S.monthInInterval('2026-08', zl), false);
  t.eq('zero-life interval claims no earlier month',
    S.monthInInterval('2026-06', zl), false);

  const tal = { id: 'tal', personalTariffs: [zl] };
  t.eq('July resolves to building default 230, not the reverted 350',
    S.resolveTariffRate(tal, dflt, '2026-07', 230), 230);
  t.eq('230 paid against 230 expected => NO shortfall',
    S.calcMonthBalance('bank_import_1721_230_payer_TAL', 230).shortfall, 0);
  t.eq('230 paid against 230 expected => status paid',
    S.calcMonthBalance('bank_import_1721_230_payer_TAL', 230).status, 'paid');

  // --- guards: the fix must NOT swallow legitimate intervals ---
  t.eq('a STILL-OPEN mid-month change keeps owning its month',
    S.resolveTariffRate({ personalTariffs: [{ rate: 350, startDate: '2026-07-18', endDate: null }] },
      dflt, '2026-07', 230), 350);
  const multi = { personalTariffs: [{ rate: 400, startDate: '2026-03-05', endDate: '2026-06-20' }] };
  t.eq('real multi-month interval still owns its start month',
    S.resolveTariffRate(multi, dflt, '2026-03', 230), 400);
  t.eq('real multi-month interval still owns its end month',
    S.resolveTariffRate(multi, dflt, '2026-06', 230), 400);
  t.eq('real multi-month interval owns a middle month',
    S.resolveTariffRate(multi, dflt, '2026-05', 230), 400);
  t.eq('month after a real interval falls back to default',
    S.resolveTariffRate(multi, dflt, '2026-07', 230), 230);
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

// ════════════════════════════════════════════════════════════════
// markUnpaid orphan cleanup (v2.13.14) — a cancelled payment must NOT
// be resurrected by closeMonthUnpaid on the 1st of the month.
// ════════════════════════════════════════════════════════════════
// The bug: markUnpaid / resetSent / delete-tenant used to delete ONLY the
// sentLog key, leaving the paid paymentHistory record behind. closeMonthUnpaid
// reads that record's paidAmount and re-derives credit/debt from the dead
// payment — the "Tami" shape (paid:true with no confirming sentLog).
// The fix: the /api/sentlog-key delete branch also strips the matching
// manual/bank record. These tests run the REAL cleanup predicate (extracted
// from the route) AND the REAL closeMonthUnpaid, so removing either fails here.
const { loadSentlogKeyDelete } = require('./test-lib');

t.section('markUnpaid cleanup — the real delete-branch predicate (v2.13.14)');
{
  const cleanup = loadSentlogKeyDelete(); // throws loudly if the fix was removed
  // June orphan (manual) removed; unrelated May bank record survives.
  const recs = [
    { month: '2026-06', paid: true, type: 'manual', amount: 230, paidAmount: 230, date: '2026-07-18' },
    { month: '2026-05', paid: true, type: 'bank',   amount: 230, paidAmount: 230, date: '2026-05-10' }
  ];
  const after = cleanup(recs, '2026-06');
  t.eq('June manual record removed on unmark', after.length, 1);
  t.eq('unrelated May record survives', after[0].month, '2026-05');

  // A wa_sent-only record for the month must NOT be touched (no payment to undo).
  const waOnly = [{ month: '2026-06', paid: false, type: 'wa_sent', date: '2026-06-05' }];
  t.eq('wa_sent record is left intact on unmark',
    cleanup(waOnly, '2026-06').length, 1);

  // A bank record for the unmarked month is removed too (same as manual).
  const bankRec = [{ month: '2026-06', paid: true, type: 'bank', amount: 230, paidAmount: 230 }];
  t.eq('bank record for the month removed on unmark',
    cleanup(bankRec, '2026-06').length, 0);
}

t.section('markUnpaid → closeMonthUnpaid — cancelled payment is NOT resurrected');
{
  const cleanup = loadSentlogKeyDelete();
  const NOW = new Date('2026-07-01T08:00:00.000Z'); // prevKey = 2026-06 (June)
  const cfg = { amount: 230 };

  // ── Scenario: tenant was marked paid for June (manual 230), then the manager
  // clicks "✕ בטל". The sentLog key is deleted AND the paymentHistory record is
  // stripped by the real cleanup. On the 1st, closeMonthUnpaid runs.
  {
    const tid = 'u1';
    // State BEFORE unmark: paid record + confirming sentLog.
    let hist = [{ month: '2026-06', paid: true, type: 'manual', amount: 230, paidAmount: 230, date: '2026-06-20' }];
    // ── Unmark: delete sentLog key (not modelled here) + run the REAL cleanup.
    hist = cleanup(hist, '2026-06');
    t.eq('after unmark: no June record left', hist.length, 0);

    // ── 1st of month: run the REAL closeMonthUnpaid with the cleaned state.
    const building = {
      config: cfg,
      tenants: [{ id: tid, name: 'דן', customAmount: 230, openingDebt: 0 }],
      paymentHistory: { [tid]: hist },
      sentLog: {} // key was deleted on unmark
    };
    const { run } = loadCloseMonth(building, NOW);
    run();
    const tenant = building.tenants[0];
    // Correct outcome: the month is treated as genuinely UNPAID (payment was
    // cancelled) → full 230 accrues. NOT a resurrected credit, NOT 0.
    t.eq('cancelled payment → June accrues as unpaid (230), no resurrection',
      tenant.openingDebt, 230);
  }

  // ── Contrast (proves the test bites): if the orphan record SURVIVES (old buggy
  // behaviour — cleanup skipped), closeMonthUnpaid reads it as paid and does NOT
  // accrue the 230. This is the resurrection the fix prevents.
  {
    const tid = 'u2';
    const building = {
      config: cfg,
      tenants: [{ id: tid, name: 'דן', customAmount: 230, openingDebt: 0 }],
      // Orphan left behind (simulating the pre-v2.13.14 bug): paid:true, no sentLog.
      paymentHistory: { [tid]: [{ month: '2026-06', paid: true, type: 'manual', amount: 230, paidAmount: 230 }] },
      sentLog: {}
    };
    const { run } = loadCloseMonth(building, NOW);
    run();
    t.eq('WITHOUT cleanup the orphan suppresses accrual (openingDebt stays 0) — the bug',
      building.tenants[0].openingDebt, 0);
  }
}

// ── hebMonthToMonthKey — year-boundary safety (v2.13.23) ──────────
// sentLog keys carry no year; the year is inferred from a reference monthKey,
// correcting for the Dec↔Jan boundary. Old "approach A" mis-yeared a December
// file imported in January. These lock the correct behaviour and prove the
// same-year (99%) path is untouched.
t.section('hebMonthToMonthKey — Dec↔Jan year boundary');
t.eq('THE FIX: December file imported in January → previous year',
  S.hebMonthToMonthKey('דצמבר', '2027-01'), '2026-12');
t.eq('November imported in January → previous year',
  S.hebMonthToMonthKey('נובמבר', '2026-01'), '2025-11');
t.eq('same-year, current month (June in July) — UNCHANGED',
  S.hebMonthToMonthKey('יוני', '2026-07'), '2026-06');
t.eq('same-year, same month (Jan in Jan) — boundary, NOT flipped',
  S.hebMonthToMonthKey('ינואר', '2026-01'), '2026-01');
t.eq('same-year, current month (July in July)',
  S.hebMonthToMonthKey('יולי', '2026-07'), '2026-07');
t.eq('same-year, several months back (Feb in December)',
  S.hebMonthToMonthKey('פברואר', '2026-12'), '2026-02');
t.eq('December imported in December (same month) — not flipped',
  S.hebMonthToMonthKey('דצמבר', '2026-12'), '2026-12');
t.eq('legacy ISO key (not a Hebrew month) → null (caller skips)',
  S.hebMonthToMonthKey('2026-04', '2026-07'), null);
t.eq('empty string → null',
  S.hebMonthToMonthKey('', '2026-07'), null);
t.eq('malformed ref monthKey → null (no silent wrong date)',
  S.hebMonthToMonthKey('יוני', 'garbage'), null);

// ══════════════════════════════════════════════════════════════════
// v2.14.0 — חייבים חריגים (excessive debt)
// ══════════════════════════════════════════════════════════════════
// ⚠️ The load-bearing assertion here is RECONCILIATION: the itemised
// month-by-month lines shown to the tenant MUST sum to the `owed` figure the
// tenant is being chased for. A letter whose lines do not add up to its own
// total is worse than no letter. Two real gaps were caught this way during
// development: the ACTIVE month (no sentLog row yet) and openingDebt (carried
// forward, not month-attributable) were both in `owed` but absent from the list.
const exBuild = (over) => Object.assign({
  config: { amount: 230, manualMonth: '', excessDebtThreshold: 1000 },
  tenants: [], sentLog: {}, paymentHistory: {}
}, over);

t.section('חוב חריג — threshold resolution');
t.eq('unset → default 1000', S.getExcessDebtThreshold({}), 1000);
t.eq('configured value wins', S.getExcessDebtThreshold({ excessDebtThreshold: 2500 }), 2500);
t.eq('zero falls back to default', S.getExcessDebtThreshold({ excessDebtThreshold: 0 }), 1000);
t.eq('negative falls back to default', S.getExcessDebtThreshold({ excessDebtThreshold: -5 }), 1000);
t.eq('numeric string accepted', S.getExcessDebtThreshold({ excessDebtThreshold: '1500' }), 1500);

const exD1 = exBuild({
  tenants: [
    { id: 1, name: 'לימור', openingDebt: 1380, extraAccounts: [] },
    { id: 2, name: 'דנה',  openingDebt: 0,    extraAccounts: [] }
  ],
  paymentHistory: { '1': [
    { month: '2026-04', paid: false, type: 'unpaid_rollover', amount: 230 },
    { month: '2026-05', paid: false, type: 'unpaid_rollover', amount: 230 },
    { month: '2026-06', paid: false, type: 'unpaid_rollover', amount: 230 }
  ]}
});
const exR1 = S.buildExcessDebtRows(exD1);

t.section('חוב חריג — filtering by threshold');
t.eq('only the over-threshold tenant is listed', exR1.rows.length, 1);
t.eq('listed tenant is לימור', exR1.rows[0].name, 'לימור');
t.eq('לימור owed = 2300 (1380 opening + 4×230)', exR1.rows[0].owed, 2300);
t.eq('דנה (230 < 1000) excluded', !!(!exR1.rows.some(r => r.name === 'דנה')), true);

t.section('⭐ חוב חריג — itemised detail RECONCILES with the total');
const exDet1 = S.buildDebtDetail(exD1, exD1.tenants[0], '2026-07');
t.eq('months + openingDebt equal the owed figure',
  Math.round((exDet1.months.reduce((s, m) => s + m.shortfall, 0) + exDet1.openingDebt) * 100) / 100,
  exR1.rows[0].owed);
t.eq('the ACTIVE month is itemised even with no sentLog/history row', !!(exDet1.months.some(m => m.monthKey === '2026-07' && m.shortfall === 230)), true);
t.eq('openingDebt surfaced separately (not month-attributable)', exDet1.openingDebt, 1380);
t.eq('openingDebt appears in the rendered block', !!(S.buildDebtDetailBlock(exDet1).includes('1380')), true);

const exD2 = exBuild({
  tenants: [{ id: 3, name: 'אור', openingDebt: 0,
    extraAccounts: [{ id: 'a1', label: 'ביטוח', amount: 50, active: true, openingDebt: 900 }] }],
  sentLog: { '3_יולי': 'bank_import_2026-07-05_100_payer_אור' },
  paymentHistory: {
    '3': [{ month: '2026-07', paid: true, type: 'bank', amount: 230, paidAmount: 100 }],
    '3__acc__a1': []
  }
});
const exR2 = S.buildExcessDebtRows(exD2).rows[0];

t.section('חוב חריג — partial payment + extra accounts');
t.eq('partial shortfall is 130, not the full 230', exR2.currentMonthDebt, 130);
t.eq('extras = 50 current + 900 account debt', exR2.extrasTotal, 950);
t.eq('owed = 130 + 950', exR2.owed, 1080);
t.eq('the partial month is labelled partial', !!(exR2.months.some(m => m.status === 'partial' && m.shortfall === 130)), true);
t.eq('detail reconciles with owed',
  Math.round((exR2.months.reduce((s, m) => s + m.shortfall, 0)
            + exR2.accounts.reduce((s, a) => s + a.total, 0)) * 100) / 100,
  exR2.owed);
const exBlk2 = S.buildDebtDetailBlock(exR2);
t.eq('block states how much was actually paid', !!(exBlk2.includes('שולם 100 ₪ מתוך 230 ₪')), true);
t.eq('block names the extra account', !!(exBlk2.includes('ביטוח')), true);
t.eq("block shows the account's own prior debt", !!(exBlk2.includes('900')), true);

t.section('חוב חריג — exclusions');
const exD3 = exBuild({
  tenants: [{ id: 4, name: 'שולם', openingDebt: 0, extraAccounts: [] }],
  sentLog: { '4_יולי': 'bank_import_2026-07-05_230_payer_שולם' },
  paymentHistory: { '4': [{ month: '2026-07', paid: true, type: 'bank', amount: 230, paidAmount: 230 }] }
});
t.eq('a fully-paid tenant is never listed', S.buildExcessDebtRows(exD3).rows.length, 0);

const exD4 = exBuild({
  tenants: [{ id: 5, name: 'תזכורת', openingDebt: 2000, extraAccounts: [] }],
  paymentHistory: { '5': [{ month: '2026-06', paid: false, type: 'wa_sent', amount: 230 }] }
});
t.eq('a wa_sent row is NOT itemised as a charge', !!(!S.buildExcessDebtRows(exD4).rows[0].months.some(m => m.monthKey === '2026-06')), true);

const exD5 = exBuild({
  config: { amount: 230, manualMonth: '', excessDebtThreshold: 230 },
  tenants: [{ id: 6, name: 'בדיוק', openingDebt: 0, extraAccounts: [] }]
});
t.eq('a debt exactly AT the threshold is included (>=)',
  S.buildExcessDebtRows(exD5).rows.length, 1);

t.section('חוב חריג — message composition');
const exMsg = S.buildExcessDebtMessage(exD1, exD1.tenants[0], exR1.rows[0], null, 'tid');
t.eq('{שם} replaced with the tenant name', !!(exMsg.includes('לימור')), true);
t.eq('{סה"כ_חוב} replaced with the owed figure', !!(exMsg.includes('2300')), true);
t.eq('{פירוט_חוב} replaced by the month list', !!(exMsg.includes('אפריל')), true);
t.eq('no unreplaced placeholder remains', !!(!/\{[^}]*\}/.test(exMsg)), true);
const exCustom = S.buildExcessDebtMessage(exD1, exD1.tenants[0], exR1.rows[0],
  'חוב: {סה"כ_חוב}₪', 'tid');
t.eq('a custom template overrides the default', exCustom, 'חוב: 2300₪');

t.section('v2.14.1 — openingDebt must ride on the ROW, not only in detail');
// ⚠️ Tal reported לימור's carried-forward debt missing from the on-screen list.
// buildDebtDetail computed it correctly all along, but buildExcessDebtRows did
// not copy it onto the row — so it reached the letter (buildDebtDetailBlock)
// and NOT the modal. The row-level RECONCILIATION below is what makes that
// class of omission impossible to ship again.
const exD6 = exBuild({
  config: { amount: 230, manualMonth: '', excessDebtThreshold: 100 },
  tenants: [{ id: 7, name: 'לימור', openingDebt: 1380, extraAccounts: [] }],
  paymentHistory: { '7': [{ month: '2026-04', paid: false, type: 'unpaid_rollover', amount: 230 }] }
});
const exR6 = S.buildExcessDebtRows(exD6).rows[0];
t.eq('the row exposes openingDebt', exR6.openingDebt, 1380);
t.eq('⭐ ROW-level reconciliation: months + accounts + openingDebt === owed',
  Math.round((exR6.months.reduce((s, m) => s + m.shortfall, 0)
            + exR6.accounts.reduce((s, a) => s + a.total, 0)
            + exR6.openingDebt) * 100) / 100,
  exR6.owed);
t.eq('a tenant with no carried debt reports 0, not undefined',
  S.buildExcessDebtRows(exBuild({
    config: { amount: 230, manualMonth: '', excessDebtThreshold: 100 },
    tenants: [{ id: 8, name: 'נקי', openingDebt: 0, extraAccounts: [] }]
  })).rows[0].openingDebt, 0);
t.eq('the letter names it the same as the screen',
  S.buildDebtDetailBlock(S.buildDebtDetail(exD6, exD6.tenants[0], '2026-07'))
    .includes('חוב התחלתי / פתוח'), true);

// ⚠️ REGRESSION (v2.14.1) — the LETTER route rebuilt a PARTIAL detail object
// ({months, accounts} only), dropping openingDebt, so the message read
// "סה״כ 1610 ₪" above lines totalling 230 ₪. The helper tests above passed
// because they call buildDebtDetailBlock directly and never saw that literal.
// This asserts the END-TO-END message, which is what the tenant receives.
const exMsg6 = S.buildExcessDebtMessage(exD6, exD6.tenants[0], exR6, null, 'tid');
t.eq('⭐ the composed MESSAGE itemises openingDebt (not just the helper)',
  exMsg6.includes('חוב התחלתי / פתוח') && exMsg6.includes('1380'), true);
{
  // every ₪ figure in the body must add up to the stated total
  const lineSum = (exMsg6.match(/\*(\d+(?:\.\d+)?) ₪\*/g) || [])
    .map(s => parseFloat(s.replace(/[^\d.]/g, '')))
    .slice(1)                       // [0] is the headline total itself
    .reduce((a, b) => a + b, 0);
  t.eq('⭐ MESSAGE reconciles: itemised lines sum to the stated total',
    lineSum, exR6.owed);
}

process.exit(t.done() ? 1 : 0);
