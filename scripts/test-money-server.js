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

process.exit(t.done() ? 1 : 0);
