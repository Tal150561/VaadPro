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
// BANK-IMPORT DEDUP (v2.14.3) — the "צבי אלתר 434" bug
// ════════════════════════════════════════════════════════════════
// A bank file has no unique transaction id, so identity = date + amount + name
// (Tal's decision). Two failures existed:
//   • two IDENTICAL rows (same tenant+amount+date) in ONE file were both counted
//     (seenRowIdx dedups only by row index), summing to double the real payment.
//   • re-importing the same file (or overlapping month files) re-counted everything.
// Both had to be fixed for the MAIN account AND for extra accounts (the locked
// "whatever is true for the main account is true for extra accounts" rule).
{
  const { loadBankAnalyzer } = require('./test-lib');
  const B = loadBankAnalyzer();
  const mapping = { colName: 0, colAmount: 1, colDate: 2, colNote: -1 };

  t.section('Bank dedup — fingerprint helper');
  t.eq('217 and 217.00 collide', B.bankRowFingerprint('31/05', 217, 'צבי אלתר'),
                                  B.bankRowFingerprint('31/05', 217.00, 'צבי אלתר'));
  t.eq('whitespace/case normalised', B.bankRowFingerprint(' 31/05 ', 217, ' Zvi '),
                                     B.bankRowFingerprint('31/05', 217, 'zvi'));
  t.eq('different date → different fp', B.bankRowFingerprint('31/05', 217, 'x') !== B.bankRowFingerprint('29/06', 217, 'x'), true);
  t.eq('different amount → different fp', B.bankRowFingerprint('31/05', 217, 'x') !== B.bankRowFingerprint('31/05', 218, 'x'), true);

  // ── v2.14.28 (A): אסמכתא (reference) as optional 4th fingerprint component ──
  t.section('Bank dedup — v2.14.28: אסמכתא distinguishes same-day/same-amount rows');
  // Absent ref ⇒ byte-identical to the old 3-part key (back-compat / existing files).
  t.eq('no ref → identical to 3-part key', B.bankRowFingerprint('19/08', 230, 'שחם חנה'),
                                            B.bankRowFingerprint('19/08', 230, 'שחם חנה', ''));
  t.eq('null ref → identical to 3-part key', B.bankRowFingerprint('19/08', 230, 'שחם חנה'),
                                             B.bankRowFingerprint('19/08', 230, 'שחם חנה', null));
  t.eq('undefined ref → identical to 3-part key', B.bankRowFingerprint('19/08', 230, 'שחם חנה'),
                                                  B.bankRowFingerprint('19/08', 230, 'שחם חנה', undefined));
  // The reported bug: TWO genuine payments, identical date+amount+name, DIFFERENT אסמכתא.
  t.eq('different ref → DIFFERENT fp (two genuine payments)',
       B.bankRowFingerprint('19/08', 230, 'שחם חנה', '589592') !== B.bankRowFingerprint('19/08', 230, 'שחם חנה', '589593'), true);
  // SAME ref (re-import of the same file) still collides → cross-import dedup preserved.
  t.eq('same ref → same fp (re-import still deduped)',
       B.bankRowFingerprint('19/08', 230, 'שחם חנה', '589592'), B.bankRowFingerprint('19/08', 230, 'שחם חנה', '589592'));
  t.eq('ref whitespace/case normalised', B.bankRowFingerprint('19/08', 230, 'x', ' 589592 '),
                                          B.bankRowFingerprint('19/08', 230, 'x', '589592'));
  // Exact key format — guards against "always append ref" breaking stored (3-part)
  // fingerprints, and keeps the server byte-identical to the client key string.
  t.eq('no-ref key is exactly 3-part', B.bankRowFingerprint('19/08', 230, 'שחם חנה'), '19/08|230|שחם חנה');
  t.eq('with-ref key is exactly 4-part', B.bankRowFingerprint('19/08', 230, 'שחם חנה', '589592'), '19/08|230|שחם חנה|589592');

  t.section('Bank dedup — v2.14.28: real חנה case — 2 genuine payments both counted (main)');
  {
    // The exact uploaded file: שחם חנה, 19/8, 230, twice, אסמכתא 589592 vs 589593.
    // colRef mapped → distinct fingerprints → BOTH counted, NO duplicate warning.
    const refMapping = { colName: 0, colAmount: 1, colDate: 2, colNote: -1, colRef: 3 };
    const rows = [
      ['שם', 'סכום', 'תאריך', 'אסמכתא'],
      ['שחם חנה', '230', '19/08/2026', '589592'],
      ['שחם חנה', '230', '19/08/2026', '589593'],
    ];
    const tenants = [{ id: 'H', name: 'שחם חנה', phone: '0500000000', keywords: '', customAmount: 230, openingDebt: 0 }];
    const r = B.analyzeBankRowsServer(rows, refMapping, tenants, {}, '2026-08', { amount: 230 }, new Set());
    const amt = parseFloat(String(r.newSentLog['H_אוגוסט']).match(/bank_import_[^_]+_([\d.]+)_/)[1]);
    t.eq('BOTH payments counted → 460 (not 230)', amt, 460);
    t.eq('NO duplicate warning (genuine, distinct אסמכתא)', r.duplicateWarnings.length, 0);
    t.eq('two fingerprints consumed', r.newFingerprints.length, 2);

    // Contrast: WITHOUT the ref column (colRef:-1) the two rows still collapse to
    // one — proving the fix is what distinguishes them, and that legacy behaviour
    // is unchanged when no אסמכתא column is mapped.
    const noRefMapping = { colName: 0, colAmount: 1, colDate: 2, colNote: -1 };
    const r2 = B.analyzeBankRowsServer(rows, noRefMapping, tenants, {}, '2026-08', { amount: 230 }, new Set());
    const amt2 = parseFloat(String(r2.newSentLog['H_אוגוסט']).match(/bank_import_[^_]+_([\d.]+)_/)[1]);
    t.eq('without ref column → still collapses to 230 (legacy)', amt2, 230);
    t.eq('without ref column → duplicate warning surfaced', r2.duplicateWarnings.length, 1);
  }

  t.section('Bank dedup — v2.14.28: same אסמכתא re-import still deduped (cross-import)');
  {
    const refMapping = { colName: 0, colAmount: 1, colDate: 2, colNote: -1, colRef: 3 };
    const rows = [
      ['שם', 'סכום', 'תאריך', 'אסמכתא'],
      ['שחם חנה', '230', '19/08/2026', '589592'],
    ];
    const tenants = [{ id: 'H', name: 'שחם חנה', phone: '0500000000', keywords: '', customAmount: 230, openingDebt: 0 }];
    const r1 = B.analyzeBankRowsServer(rows, refMapping, tenants, {}, '2026-08', { amount: 230 }, new Set());
    t.eq('first import records one fingerprint', r1.newFingerprints.length, 1);
    const prior = new Set(r1.newFingerprints);
    const r2 = B.analyzeBankRowsServer(rows, refMapping, tenants, {}, '2026-08', { amount: 230 }, prior);
    t.eq('re-import of SAME file+ref adds no new fingerprints', r2.newFingerprints.length, 0);
    t.eq('re-import is skipped, not double-counted', (r2.alreadyImportedSkips||[]).length, 1);
  }

  t.section('Bank dedup — in-file duplicate counted once (main account)');
  {
    // צבי אלתר appears TWICE with 217 on the SAME date — the exact reported bug.
    const rows = [
      ['שם', 'סכום', 'תאריך'],
      ['צבי אלתר', '217', '31/05/2026'],
      ['צבי אלתר', '217', '31/05/2026'],  // identical duplicate
    ];
    const tenants = [{ id: 'Z', name: 'צבי אלתר', phone: '0528064806', keywords: '', customAmount: 217, openingDebt: 0 }];
    const r = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-06', { amount: 217 }, new Set());
    t.eq('matched once, not twice', r.matched.length, 1);
    // v2.14.4 (#3): both rows are dated 31/05 → they route to מאי (their own month),
    // NOT to the chosen יוני. Dedup still collapses the identical pair to a single 217.
    const amt = parseFloat(String(r.newSentLog['Z_מאי']).match(/bank_import_[^_]+_([\d.]+)_/)[1]);
    t.eq('sentLog amount is 217 (single), NOT 434', amt, 217);
    t.eq('routed to מאי (row date), not the chosen יוני', r.newSentLog['Z_יוני'], undefined);
    t.eq('a duplicate warning was surfaced', r.duplicateWarnings.length, 1);
    t.eq('warning names the tenant', r.duplicateWarnings[0].name, 'צבי אלתר');
    t.eq('one fingerprint consumed', r.newFingerprints.length, 1);
  }

  t.section('Bank dedup — genuine two different dates: split by month (v2.14.4 #3)');
  {
    // Real two-month payment: May 31 + June 29, DIFFERENT dates → both count, but
    // now each is recorded in ITS OWN month (May→מאי, June→יוני) instead of being
    // summed into the chosen month. This is exactly the #3 multi-month-split fix.
    const rows = [
      ['שם', 'סכום', 'תאריך'],
      ['צבי אלתר', '217', '31/05/2026'],
      ['צבי אלתר', '217', '29/06/2026'],
    ];
    const tenants = [{ id: 'Z', name: 'צבי אלתר', phone: '0528064806', keywords: '', customAmount: 217, openingDebt: 0 }];
    const r = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-06', { amount: 217 }, new Set());
    const may  = parseFloat(String(r.newSentLog['Z_מאי']).match(/bank_import_[^_]+_([\d.]+)_/)[1]);
    const june = parseFloat(String(r.newSentLog['Z_יוני']).match(/bank_import_[^_]+_([\d.]+)_/)[1]);
    t.eq('May payment recorded in מאי (217)', may, 217);
    t.eq('June payment recorded in יוני (217)', june, 217);
    t.eq('NOT summed into one month', may === 217 && june === 217, true);
    t.eq('matched row reports monthsSplit=2', r.matched[0].monthsSplit, 2);
    t.eq('no duplicate warning', r.duplicateWarnings.length, 0);
    t.eq('two fingerprints consumed', r.newFingerprints.length, 2);
  }

  t.section('Bank dedup — cross-import: re-import is skipped');
  {
    const rows = [
      ['שם', 'סכום', 'תאריך'],
      ['צבי אלתר', '217', '29/06/2026'],
    ];
    const tenants = [{ id: 'Z', name: 'צבי אלתר', phone: '0528064806', keywords: '', customAmount: 217, openingDebt: 0 }];
    // First import: fingerprint consumed.
    const r1 = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-06', { amount: 217 }, new Set());
    t.eq('first import matches', r1.matched.length, 1);
    t.eq('first import records the fingerprint', r1.newFingerprints.length, 1);
    // Second import of the SAME row, with the prior fingerprint remembered.
    const prior = new Set(r1.newFingerprints);
    const r2 = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-06', { amount: 217 }, prior);
    t.eq('re-import matches NOTHING (already imported)', r2.matched.length, 0);
    t.eq('re-import adds no new fingerprints', r2.newFingerprints.length, 0);
  }

  t.section('Bank dedup — extra accounts get the SAME treatment');
  {
    // A tenant with a ביטוח collection account, matched by keyword "ביטוח".
    // Two identical ביטוח rows same date → counted once. Then re-import → skipped.
    const rows = [
      ['שם', 'סכום', 'תאריך'],
      ['ביטוח מבנה', '50', '05/06/2026'],
      ['ביטוח מבנה', '50', '05/06/2026'],  // duplicate
    ];
    const tenants = [{
      id: 'Z', name: 'לא-מזוהה-ראשי', phone: '0500000000', keywords: '', customAmount: 217, openingDebt: 0,
      extraAccounts: [{ id: 'a1', label: 'ביטוח', amount: 50, active: true, matchKeywords: 'ביטוח' }]
    }];
    const r = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-06', { amount: 217 }, new Set());
    const extra = r.matched.filter(m => m.matchType === 'extra_account');
    t.eq('extra account matched once, not twice', extra.length, 1);
    t.eq('extra account amount is 50 (single), NOT 100', extra[0].amount, 50);
    t.eq('extra duplicate surfaced a warning', r.duplicateWarnings.some(w => w.scope === 'extra'), true);
    // Re-import → extra account skipped too.
    const prior = new Set(r.newFingerprints);
    const r2 = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-06', { amount: 217 }, prior);
    t.eq('extra account re-import matches nothing', r2.matched.filter(m => m.matchType === 'extra_account').length, 0);
  }
}

// ════════════════════════════════════════════════════════════════
// #3 — MULTI-MONTH IMPORT SPLIT (v2.14.4)
// ════════════════════════════════════════════════════════════════
// A bank file spanning >1 month, imported into one chosen month, used to sum
// every payment into ONE bank_import for the chosen month (the extra months read
// as a phantom overpayment credit). Fix: each payment is recorded in its OWN
// month by the row's date. Single-month files are unchanged; rows with no date
// fall back to the chosen month. Symmetric for the main account and extras.
{
  const { loadBankAnalyzer } = require('./test-lib');
  const B = loadBankAnalyzer();
  const mapping = { colName: 0, colAmount: 1, colDate: 2, colNote: -1 };

  t.section('#3 helpers — bankRowMonthKey parses every bank date format');
  t.eq('DD/MM/YYYY', B.bankRowMonthKey('31/05/2026'), '2026-05');
  t.eq('DD.MM.YYYY',  B.bankRowMonthKey('29.06.2026'), '2026-06');
  t.eq('YYYY-MM-DD',  B.bankRowMonthKey('2026-04-10'), '2026-04');
  t.eq('Excel serial (≈ 15/07/2026)', B.bankRowMonthKey('46218'), '2026-07');
  t.eq('empty → null (caller falls back)', B.bankRowMonthKey(''), null);
  t.eq('garbage → null', B.bankRowMonthKey('not-a-date'), null);

  t.section('v2.14.16 — numeric non-date values must NOT parse to January');
  // Root cause of the "everything tagged ינואר" bug: a bare number that is NOT an
  // Excel serial (asmachta / amount / bank code) fell through to new Date("6819"),
  // which JS reads as YEAR 6819 → month January. Must now be null so the caller
  // falls back to the chosen import month.
  t.eq('4-digit asmachta 6819 → null (not 6819-01)', B.bankRowMonthKey('6819'), null);
  t.eq('asmachta 3156 → null',                        B.bankRowMonthKey('3156'), null);
  t.eq('amount 230 → null (not 0230-01)',             B.bankRowMonthKey('230'),  null);
  t.eq('bank code 10 → null',                         B.bankRowMonthKey('10'),   null);
  t.eq('long asmachta 767735 → null',                 B.bankRowMonthKey('767735'), null);
  t.eq('20-digit ref → null',        B.bankRowMonthKey('26072609234169250010'), null);
  // Real dates still work (regression guard for the fix).
  t.eq('real serial still July',     B.bankRowMonthKey('46229'), '2026-07');
  t.eq('real DD/MM/YYYY still works', B.bankRowMonthKey('26/07/2026'), '2026-07');

  t.section('#3 helpers — groupMatchesByMonth buckets by month');
  {
    const g = B.groupMatchesByMonth([
      { amount: 100, date: '05/04/2026', payerName: 'A' },
      { amount: 200, date: '06/04/2026', payerName: 'A' },
      { amount: 300, date: '07/05/2026', payerName: 'A' },
    ], '2026-06');
    t.eq('two distinct months', g.distinctMonths, 2);
    t.eq('April bucket sums 100+200', g.buckets.get('2026-04').sum, 300);
    t.eq('May bucket = 300', g.buckets.get('2026-05').sum, 300);
    t.eq('no June bucket (nothing dated June)', g.buckets.has('2026-06'), false);
  }
  {
    const g = B.groupMatchesByMonth([
      { amount: 100, date: '', payerName: 'A' },          // no date → fallback
      { amount: 50,  date: 'junk', payerName: 'A' },       // unparseable → fallback
    ], '2026-06');
    t.eq('undated rows land in the fallback month', g.buckets.get('2026-06').sum, 150);
    t.eq('distinctMonths counts only DATED months (0 here)', g.distinctMonths, 0);
  }

  t.section('#3 — single-month file is UNCHANGED (one key, chosen month)');
  {
    // All rows dated June, chosen June → exactly the old behaviour: one יוני key.
    const rows = [
      ['שם', 'סכום', 'תאריך'],
      ['דנה כהן', '300', '03/06/2026'],
      ['דנה כהן', '300', '20/06/2026'],
    ];
    const tenants = [{ id: 'D', name: 'דנה כהן', phone: '0501112222', keywords: '', customAmount: 300, openingDebt: 0 }];
    const r = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-06', { amount: 300 }, new Set());
    const keys = Object.keys(r.newSentLog).filter(k => k.startsWith('D_'));
    t.eq('exactly one main sentLog key', keys.length, 1);
    t.eq('it is יוני', keys[0], 'D_יוני');
    const amt = parseFloat(String(r.newSentLog['D_יוני']).match(/bank_import_[^_]+_([\d.]+)_/)[1]);
    t.eq('summed within the same month (600)', amt, 600);
    t.eq('monthsSplit = 1', r.matched[0].monthsSplit, 1);
  }

  t.section('#3 — three-month file splits into three months');
  {
    const rows = [
      ['שם', 'סכום', 'תאריך'],
      ['דנה כהן', '300', '10/04/2026'],
      ['דנה כהן', '300', '10/05/2026'],
      ['דנה כהן', '300', '10/06/2026'],
    ];
    const tenants = [{ id: 'D', name: 'דנה כהן', phone: '0501112222', keywords: '', customAmount: 300, openingDebt: 0 }];
    const r = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-06', { amount: 300 }, new Set());
    const amt = (heb) => parseFloat(String(r.newSentLog['D_' + heb]).match(/bank_import_[^_]+_([\d.]+)_/)[1]);
    t.eq('אפריל = 300', amt('אפריל'), 300);
    t.eq('מאי = 300',   amt('מאי'),   300);
    t.eq('יוני = 300',  amt('יוני'),  300);
    t.eq('three distinct month keys', Object.keys(r.newSentLog).filter(k => k.startsWith('D_')).length, 3);
    t.eq('monthsSplit = 3', r.matched[0].monthsSplit, 3);
    t.eq('reported total still 900', r.matched[0].amount, 900);
  }

  t.section('#3 — undated rows fall back to the chosen month');
  {
    const rows = [
      ['שם', 'סכום', 'תאריך'],
      ['דנה כהן', '300', '10/04/2026'],  // April
      ['דנה כהן', '300', ''],            // no date → chosen (June)
    ];
    const tenants = [{ id: 'D', name: 'דנה כהן', phone: '0501112222', keywords: '', customAmount: 300, openingDebt: 0 }];
    const r = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-06', { amount: 300 }, new Set());
    t.eq('April row → אפריל', parseFloat(String(r.newSentLog['D_אפריל']).match(/_([\d.]+)_payer/)[1]), 300);
    t.eq('undated row → chosen יוני', parseFloat(String(r.newSentLog['D_יוני']).match(/_([\d.]+)_payer/)[1]), 300);
  }

  t.section('v2.14.16 — agent path: numeric non-date column falls back, NOT January');
  {
    // Twin of the manual-path bug: if colDate points at a numeric non-date column
    // (asmachta / a stale per-building mapping), the row date is a bare number. It
    // must fall back to the chosen import month, never ינואר (new Date("6819")=yr 6819).
    const badMapping = { colName: 0, colAmount: 1, colDate: 2, colNote: -1, bankAmount: '300', bankTolerance: '5' };
    const rows = [
      ['שם', 'סכום', 'אסמכתא'],
      ['דנה כהן', '300', '6819'],
      ['דנה כהן', '300', '3156'],
    ];
    const tenants = [{ id: 'D', name: 'דנה כהן', phone: '0501112222', keywords: '', customAmount: 300, openingDebt: 0 }];
    const r = B.analyzeBankRowsServer(rows, badMapping, tenants, {}, '2026-07', { amount: 300 }, new Set());
    t.eq('no ינואר key was written', r.newSentLog['D_ינואר'], undefined);
    t.eq('both rows fell back to chosen יולי', parseFloat(String(r.newSentLog['D_יולי']).match(/bank_import_[^_]+_([\d.]+)_/)[1]), 600);
    t.eq('single (chosen) month bucket', Object.keys(r.newSentLog).filter(k => k.startsWith('D_')).length, 1);
  }

  t.section('#3 — year boundary: December file imported in January');
  {
    // Chosen month January 2026; a row dated 15/12/2025 must land in 2025-12 (דצמבר),
    // not 2026-12. bankRowMonthKey reads the real year off the row date directly.
    const rows = [
      ['שם', 'סכום', 'תאריך'],
      ['דנה כהן', '300', '15/12/2025'],
    ];
    const tenants = [{ id: 'D', name: 'דנה כהן', phone: '0501112222', keywords: '', customAmount: 300, openingDebt: 0 }];
    const r = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-01', { amount: 300 }, new Set());
    t.eq('recorded under דצמבר', !!r.newSentLog['D_דצמבר'], true);
    t.eq('not under ינואר', r.newSentLog['D_ינואר'], undefined);
  }

  t.section('#3 — extra accounts split by month too (symmetric)');
  {
    // ביטוח collected across April + May, imported into June. Each month gets its
    // own key AND its own paymentHistory record — the locked "main == extra" rule.
    const rows = [
      ['שם', 'סכום', 'תאריך'],
      ['ביטוח מבנה', '50', '05/04/2026'],
      ['ביטוח מבנה', '50', '05/05/2026'],
    ];
    const tenants = [{
      id: 'Z', name: 'לא-מזוהה', phone: '0500000000', keywords: '', customAmount: 217, openingDebt: 0,
      extraAccounts: [{ id: 'a1', label: 'ביטוח', amount: 50, active: true, matchKeywords: 'ביטוח' }]
    }];
    const r = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-06', { amount: 217 }, new Set());
    t.eq('ביטוח אפריל key set', !!r.newSentLog['Z__acc__a1_אפריל'], true);
    t.eq('ביטוח מאי key set',   !!r.newSentLog['Z__acc__a1_מאי'],   true);
    t.eq('NOT collapsed into יוני', r.newSentLog['Z__acc__a1_יוני'], undefined);
    const ph = r.newPaymentHistory['Z__acc__a1'] || [];
    t.eq('two extra-account paymentHistory records', ph.length, 2);
    t.eq('one for 2026-04', ph.some(x => x.month === '2026-04' && x.paidAmount === 50), true);
    t.eq('one for 2026-05', ph.some(x => x.month === '2026-05' && x.paidAmount === 50), true);
  }
}

// ════════════════════════════════════════════════════════════════
// RESET BUILDING PAYMENTS (v2.14.3) — clean slate for a new building
// ════════════════════════════════════════════════════════════════
// Wipes ALL bank-import-derived data (sentLog, paymentHistory, fingerprints,
// lastBankSyncImport) + zeros openingDebt (main + extra accounts), while NEVER
// touching tenant settings (name/phone/keywords/customAmount/personalTariffs/
// extraAccounts definitions) or building config. Scoped to ONE building.
{
  const { loadResetPayments } = require('./test-lib');
  const makeBuilding = () => ({
    config: { amount: 217, whatsappTemplate: 'שלום {שם}' },
    defaultTariffs: [{ rate: 217, startDate: '2000-01-01', endDate: null }],
    tenants: [
      { id: 'Z', name: 'צבי אלתר', phone: '0528064806', keywords: 'אלתר', customAmount: 217, openingDebt: 217,
        personalTariffs: [{ rate: 217, startDate: '2026-01-01', endDate: null }],
        extraAccounts: [{ id: 'a1', label: 'ביטוח', amount: 50, active: true, matchKeywords: 'ביטוח', openingDebt: 30 }] },
      { id: 'R', name: 'רוני מרחבי', phone: '0500000000', keywords: '', customAmount: 239, openingDebt: 0 }
    ],
    sentLog: { 'Z_יוני': 'bank_import_x_434_payer_צבי', 'R_יוני': 'bank_import_x_956_payer_רוני', 'Z__acc__a1_יוני': 'bank_import_x_50_payer_צבי' },
    paymentHistory: { 'Z': [{ month: '2026-06', paid: true, amount: 217, paidAmount: 434 }], 'Z__acc__a1': [{ month: '2026-06', paid: true, amount: 50, paidAmount: 50 }] },
    importedBankFingerprints: ['31/05|217|צבי אלתר', '29/06|217|צבי אלתר'],
    lastBankSyncImport: { timestamp: 'x', matched: 9 },
    // v2.14.8 — a previous manual/cron close left these markers. The reset MUST
    // clear them, else a fresh close after re-import is a NO-OP → ₪0 fake debt.
    closedMonths: ['2026-05', '2026-06'],
    closedMonthsExtra: ['2026-05', '2026-06']
  });

  t.section('Reset payments — dryRun previews without writing');
  {
    const b = makeBuilding();
    const r = loadResetPayments(b, { dryRun: true });
    t.eq('dryRun reported', r.result.dryRun, true);
    t.eq('dryRun wrote NOTHING', r.saved.length, 0);
    t.eq('dryRun took no backup', r.backupCalled, 0);
    t.eq('counts sentLog main', r.result.summary.sentLogMain, 2);
    t.eq('counts sentLog extra', r.result.summary.sentLogExtra, 1);
    t.eq('counts paymentHistory main', r.result.summary.paymentHistoryRecordsMain, 1);
    t.eq('counts paymentHistory extra', r.result.summary.paymentHistoryRecordsExtra, 1);
    t.eq('counts tenants with openingDebt', r.result.summary.tenantsWithOpeningDebt, 1);
    t.eq('counts extra accounts with openingDebt', r.result.summary.extraAccountsWithOpeningDebt, 1);
    t.eq('counts fingerprints', r.result.summary.importedFingerprints, 2);
    // dryRun must NOT mutate the building object.
    t.eq('dryRun left sentLog intact', Object.keys(b.sentLog).length, 3);
    t.eq('dryRun left openingDebt intact', b.tenants[0].openingDebt, 217);
  }

  t.section('Reset payments — real run wipes payment data, keeps settings');
  {
    const b = makeBuilding();
    const r = loadResetPayments(b, { dryRun: false });
    t.eq('took a backup FIRST', r.backupCalled, 1);
    t.eq('wrote exactly once', r.saved.length, 1);
    const patch = r.saved[0].patch;
    // Deleted.
    t.eq('sentLog emptied', Object.keys(patch.sentLog).length, 0);
    t.eq('paymentHistory emptied', Object.keys(patch.paymentHistory).length, 0);
    t.eq('fingerprints emptied', patch.importedBankFingerprints.length, 0);
    t.eq('lastBankSyncImport cleared', patch.lastBankSyncImport, null);
    // v2.14.8 — close markers cleared so a fresh close accrues real debt.
    t.eq('closedMonths cleared', patch.closedMonths.length, 0);
    t.eq('closedMonthsExtra cleared', patch.closedMonthsExtra.length, 0);
    // openingDebt zeroed — main + extra.
    t.eq('tenant openingDebt zeroed', patch.tenants[0].openingDebt, 0);
    t.eq('extra account openingDebt zeroed', patch.tenants[0].extraAccounts[0].openingDebt, 0);
    // PRESERVED — settings untouched.
    t.eq('tenant name kept', patch.tenants[0].name, 'צבי אלתר');
    t.eq('tenant phone kept', patch.tenants[0].phone, '0528064806');
    t.eq('tenant keywords kept', patch.tenants[0].keywords, 'אלתר');
    t.eq('customAmount kept', patch.tenants[0].customAmount, 217);
    t.eq('personalTariffs kept', patch.tenants[0].personalTariffs[0].rate, 217);
    t.eq('extraAccount definition kept (label)', patch.tenants[0].extraAccounts[0].label, 'ביטוח');
    t.eq('extraAccount amount kept', patch.tenants[0].extraAccounts[0].amount, 50);
    t.eq('extraAccount matchKeywords kept', patch.tenants[0].extraAccounts[0].matchKeywords, 'ביטוח');
    t.eq('second tenant kept', patch.tenants[1].name, 'רוני מרחבי');
    // config is NOT in the patch (never sent → never touched).
    t.eq('config not in patch (untouched)', patch.config, undefined);
    t.eq('defaultTariffs not in patch (untouched)', patch.defaultTariffs, undefined);
    t.eq('receipt returns backup filename', r.result.backupFile, 'backup-pre-restore-test.zip');
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
// bug #4 (v2.14.5) — creditBanked: phantom credit after month close
// ════════════════════════════════════════════════════════════════
// Symmetric with Stage 4's shortfallBanked. The overpay branch of
// closeMonthUnpaid banks a surplus into (negative) openingDebt; it must now
// stamp creditBanked:true so the live derivation (calcShortfallFromSentLog)
// skips that month and does not count the same surplus twice. The crux the
// v2.13.8 number-only guard could NOT solve: openingDebt can be EXACTLY 0
// both post-close (a prior debt equal to the overpay consumed the surplus) and
// pre-close (a fresh live overpayment, openingDebt untouched) — data-identical
// except for the marker.
t.section('bug #4 — closeMonthUnpaid stamps creditBanked on overpay');
{
  const NOW = new Date('2026-07-01T08:00:00.000Z'); // prev = June / יוני
  const runClose = (tenant, sentLog) => {
    const building = { config: { amount: 230 }, tenants: [tenant],
      paymentHistory: { [tenant.id]: tenant._hist || [] }, sentLog: sentLog || {} };
    const { run } = loadCloseMonth(building, NOW);
    run();
    return { tenant: building.tenants[0], building };
  };

  // (a) OVERPAY 300/230 → surplus 70 banked AND record stamped creditBanked:true.
  {
    const tn = { id: 'c1', name: 'x', customAmount: 230, openingDebt: 0,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 300, type: 'bank' }] };
    const { tenant, building } = runClose(tn, { 'c1_יוני': bank(300) });
    t.eq('overpay 300/230 → openingDebt −70 (credit banked)', tenant.openingDebt, -70);
    const rec = building.paymentHistory['c1'].find(r => r.month === '2026-06');
    t.eq('overpay record stamped creditBanked:true', rec.creditBanked, true);
    t.eq('overpay record kept paid:true', rec.paid, true);
  }

  // (b) THE CRUX — prior debt exactly equal to the overpay → openingDebt lands
  // at EXACTLY 0 post-close. Number alone is ambiguous; the marker disambiguates.
  {
    const tn = { id: 'c2', name: 'x', customAmount: 230, openingDebt: 70,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 300, type: 'bank' }] };
    const { tenant, building } = runClose(tn, { 'c2_יוני': bank(300) });
    t.eq('prior debt 70 consumed by 70 surplus → openingDebt EXACTLY 0', tenant.openingDebt, 0);
    const rec = building.paymentHistory['c2'].find(r => r.month === '2026-06');
    t.eq('still stamped creditBanked even though openingDebt is 0', rec.creditBanked, true);
  }

  // (c) FULL / PARTIAL / no-record → NO creditBanked marker (only overpay stamps).
  {
    const full = { id: 'c3', customAmount: 230, openingDebt: 0,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 230, type: 'bank' }] };
    const { building } = runClose(full, { 'c3_יוני': bank(230) });
    const rec = building.paymentHistory['c3'].find(r => r.month === '2026-06');
    t.eq('full payment → no creditBanked marker', !!rec.creditBanked, false);

    const part = { id: 'c4', customAmount: 230, openingDebt: 0,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 150, type: 'bank' }] };
    const { building: b2 } = runClose(part, { 'c4_יוני': bank(150) });
    const rec2 = b2.paymentHistory['c4'].find(r => r.month === '2026-06');
    t.eq('partial → shortfallBanked, NOT creditBanked', !!rec2.creditBanked, false);
    t.eq('partial → shortfallBanked still set', rec2.shortfallBanked, true);
  }
}

t.section('bug #4 — no phantom credit after month close (marker skip)');
{
  const cfg = { amount: 230, manualMonth: 'יולי' }; // current month July → June is history
  // June overpay 400/230 (surplus 170) already banked by closeMonthUnpaid.
  const base = (tid, openingDebt, creditBanked) => ({
    config: cfg,
    sentLog: { [tid + '_יוני']: bank(400) },
    tenants: [{ id: tid, name: 'x', customAmount: 230, openingDebt }],
    paymentHistory: { [tid]: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 400, type: 'bank', creditBanked }] }
  });

  // POST-CLOSE, openingDebt −170 (legacy negative guard would also catch this).
  const dNeg = base('p1', -170, true);
  t.eq('credit-banked June skipped → live creditTotal 0 (marker suppresses it)',
    S.calcShortfallFromSentLog(dNeg, 'p1', { year: 2026 }).creditTotal, 0);
  // The surplus lives ONLY in the negative openingDebt now; getCreditBalance
  // surfaces it from there (−openingDebt) → 170, not 170+170.
  t.eq('getCreditBalance post-close = 170, NOT 340 (no double-count)',
    S.getCreditBalance(dNeg, 'p1'), 170);

  // THE CRUX POST-CLOSE: openingDebt EXACTLY 0 (prior debt 170 ate the surplus).
  // The number guard (<0) can't see it; only the creditBanked marker suppresses
  // the phantom. Correct credit here = 0 (surplus already spent paying the debt).
  const dZero = base('p2', 0, true);
  t.eq('CRUX: openingDebt 0 + creditBanked → NO phantom credit (0)',
    S.getCreditBalance(dZero, 'p2'), 0);
  t.eq('CRUX: openingDebt 0 + creditBanked → totalDebt 0',
    S.calcTotalDebt(dZero, 'p2', '2026-07'), 0);

  // CONTRAST — PRE-CLOSE: same openingDebt 0, same sentLog surplus, but NO marker
  // yet (closeMonthUnpaid hasn't run). The live credit MUST still show (v2.13.8
  // real-time credit). This is the case a naive `<=0` guard would have broken.
  const dLive = base('p3', 0, false);
  t.eq('pre-close live overpayment still credits 170 (real-time credit intact)',
    S.getCreditBalance(dLive, 'p3'), 170);

  // Interaction: a credit-banked June PLUS a live partial in July.
  // June credit suppressed (banked); July partial 100 short counts live.
  const dMix = {
    config: cfg,
    sentLog: { 'p4_יוני': bank(400), 'p4_יולי': bank(130) },
    tenants: [{ id: 'p4', name: 'x', customAmount: 230, openingDebt: -170 }],
    paymentHistory: { 'p4': [
      { month: '2026-06', paid: true, amount: 230, paidAmount: 400, type: 'bank', creditBanked: true },
      { month: '2026-07', paid: true, amount: 230, paidAmount: 130, type: 'bank' }
    ] }
  };
  // banked June credit skipped; July shortfall 100 live. net credit = 170 − 100 = 70.
  t.eq('banked June credit + live July shortfall → net credit 70',
    S.getCreditBalance(dMix, 'p4'), 70);
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

// ── v2.14.7 — multi-month file FORWARD-STEP must NOT flip the year ─────────
// Tal's reported bug (backup 2026-07-27): a bank file whose selected reference
// month was יוני (2026-06) also contained יולי rows (v2.14.4 multi-month split).
// The old `monthNum > refMon` test filed יולי under 2025-07 instead of 2026-07.
// The fix is `monthNum - refMon > 6`: a SMALL forward step (≤6) is the same
// collection cycle (current year); only a LARGE forward gap (>6) is a real
// Dec-in-Jan year wrap. These lock the fix AND prove the wrap still works.
t.section('hebMonthToMonthKey — multi-month forward step (v2.14.7)');
t.eq('THE BUG: יולי in a יוני-referenced file → SAME year, not previous',
  S.hebMonthToMonthKey('יולי', '2026-06'), '2026-07');
t.eq('מאי in a יוני-referenced file → same year (backward step, unchanged)',
  S.hebMonthToMonthKey('מאי', '2026-06'), '2026-05');
t.eq('יוני in a יוני-referenced file → same month, same year',
  S.hebMonthToMonthKey('יוני', '2026-06'), '2026-06');
t.eq('אוגוסט (2 months forward) in a יוני file → same year',
  S.hebMonthToMonthKey('אוגוסט', '2026-06'), '2026-08');
t.eq('אוקטובר (4 months forward) in a יוני file → same year',
  S.hebMonthToMonthKey('אוקטובר', '2026-06'), '2026-10');
t.eq('boundary: exactly 6 months forward (דצמבר in a יוני file) = NOT flipped, same year',
  S.hebMonthToMonthKey('דצמבר', '2026-06'), '2026-12'); // 12-6=6, and 6 > 6 is false → same year
t.eq('נובמבר (5 forward) in a יוני file → same year',
  S.hebMonthToMonthKey('נובמבר', '2026-06'), '2026-11');
t.eq('WRAP STILL WORKS: 7 months forward flips (דצמבר in a מאי file → previous year)',
  S.hebMonthToMonthKey('דצמבר', '2026-05'), '2025-12'); // 12-5=7, 7 > 6 → previous year
t.eq('ינואר (6 back) in a יולי file → same year',
  S.hebMonthToMonthKey('ינואר', '2026-07'), '2026-01');

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
  // manualMonth pins July as the ACTIVE month so it lines up with the fixture's
  // July sentLog + paymentHistory. Without this the report runs on the real
  // current month (August) and — correctly — also charges the empty active
  // month, so owed would be 130+230+950. The scenario under test is a PARTIAL
  // payment in the active month, so the active month IS July.
  config: { amount: 230, manualMonth: 'יולי', excessDebtThreshold: 1000 },
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

// ════════════════════════════════════════════════════════════════
// v2.14.8 — closeMonthUnpaid IDEMPOTENCY GUARD (closedMonths marker)
// ════════════════════════════════════════════════════════════════
// The old note claimed closeMonthUnpaid was idempotent so a manual button could
// "call it AS-IS". That was FALSE — a second run on the SAME previous month
// double-accrued. These tests prove: (1) a FIRST run accrues exactly once (the
// existing behaviour), and (2) a SECOND run on the same month is a NO-OP for
// ALL FIVE branches. loadCloseMonth returns the SAME building on every
// loadTenantData() call, so calling run() twice simulates a double-click / a
// cron firing twice after a Railway redeploy on the 1st.
t.section('v2.14.8 — closeMonthUnpaid double-run is a NO-OP (all 5 branches)');
{
  const NOW = new Date('2026-07-01T08:00:00.000Z'); // prevKey 2026-06, prevHeb יוני
  const cfg = { amount: 230 };

  // Build a one-tenant building, run close TWICE, return openingDebt after each.
  const runTwice = (tenant, sentLog) => {
    const building = { config: cfg, tenants: [tenant], paymentHistory: { [tenant.id]: [] }, sentLog: sentLog || {} };
    if (tenant._hist) building.paymentHistory[tenant.id] = tenant._hist;
    const { run } = loadCloseMonth(building, NOW);
    run();
    const after1 = building.tenants[0].openingDebt;
    run(); // ← the double-run that used to double-accrue
    const after2 = building.tenants[0].openingDebt;
    return { after1, after2, building };
  };

  // Branch 1 — unpaid, NO record (the "no paymentHistory record" path).
  {
    const tn = { id: 'u1', name: 'א', customAmount: 300, openingDebt: 0 };
    const { after1, after2 } = runTwice(tn, {});
    t.eq('unpaid-no-record: 1st run accrues 300', after1, 300);
    t.eq('unpaid-no-record: 2nd run NO-OP (still 300, not 600)', after2, 300);
  }

  // Branch 2 — unpaid, WITH a paid:false record.
  {
    const tn = { id: 'u2', name: 'ב', customAmount: 300, openingDebt: 0,
      _hist: [{ month: '2026-06', paid: false, amount: 300 }] };
    const { after1, after2 } = runTwice(tn, {});
    t.eq('unpaid-with-record: 1st run accrues 300', after1, 300);
    t.eq('unpaid-with-record: 2nd run NO-OP (still 300, not 600)', after2, 300);
  }

  // Branch 3 — partial payment (shortfall accrual).
  {
    const tn = { id: 'p1', name: 'ג', customAmount: 230, openingDebt: 0,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 150, type: 'bank' }] };
    const { after1, after2 } = runTwice(tn, { 'p1_יוני': bank(150) });
    t.eq('partial: 1st run accrues 80 shortfall', after1, 80);
    t.eq('partial: 2nd run NO-OP (still 80, not 160)', after2, 80);
  }

  // Branch 4 — overpay (credit banked into negative openingDebt).
  {
    const tn = { id: 'o1', name: 'ד', customAmount: 230, openingDebt: 0,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 400, type: 'bank' }] };
    const { after1, after2 } = runTwice(tn, { 'o1_יוני': bank(400) });
    t.eq('overpay: 1st run banks −170 credit', after1, -170);
    t.eq('overpay: 2nd run NO-OP (still −170, not −340)', after2, -170);
  }

  // Branch 5 — full payment (no accrual either way, but marker still set).
  {
    const tn = { id: 'f1', name: 'ה', customAmount: 230, openingDebt: 50,
      _hist: [{ month: '2026-06', paid: true, amount: 230, paidAmount: 230, type: 'bank' }] };
    const { after1, after2, building } = runTwice(tn, { 'f1_יוני': bank(230) });
    t.eq('full-pay: 1st run leaves openingDebt untouched (50)', after1, 50);
    t.eq('full-pay: 2nd run NO-OP (still 50)', after2, 50);
    t.eq('full-pay: month marked closed even with no accrual',
      (building.closedMonths || []).includes('2026-06'), true);
  }
}

// The marker is written to the SAVE patch (so it persists to disk, not just memory).
t.section('v2.14.8 — closedMonths persisted in the save patch');
{
  const NOW = new Date('2026-07-01T08:00:00.000Z');
  const building = { config: { amount: 300 }, tenants: [{ id: 'x', name: 'ז', customAmount: 300, openingDebt: 0 }],
    paymentHistory: { x: [] }, sentLog: {} };
  const { run, saved } = loadCloseMonth(building, NOW);
  run();
  const patch = saved.find(s => s.patch && s.patch.closedMonths);
  t.eq('save patch includes closedMonths', !!patch, true);
  t.eq('save patch closedMonths contains 2026-06',
    !!patch && patch.patch.closedMonths.includes('2026-06'), true);
}

// MUTATION-VERIFY the guard: with the guard REMOVED, the double-run test above
// WOULD fail (double accrual). We prove that here by extracting the helper,
// stripping the guard line, and confirming the second run then doubles.
t.section('v2.14.8 — mutation check: removing the guard re-breaks double-run');
{
  const { readSource, extractFunctions, runInSandbox } = require('./test-lib');
  const src = readSource('server.js');
  const months = src.match(/const HEBREW_MONTHS = \[[^\]]*\];/)[0];
  let code = months + '\n'
    + extractFunctions(src, ['closeMonthUnpaidForBuilding']);
  // Strip BOTH the early-return NO-OP and the marker push → back to non-idempotent.
  code = code.replace('if (d.closedMonths.includes(prevKey)) return { changed: false, closed: 0 };', '/* guard removed */');
  code += '\nmodule.exports={closeMonthUnpaidForBuilding};';
  const mod = runInSandbox(code, {});
  const d = { config: { amount: 300 }, tenants: [{ id: 'm', name: 'ח', customAmount: 300, openingDebt: 0 }],
    paymentHistory: { m: [] }, sentLog: {}, closedMonths: [] };
  mod.closeMonthUnpaidForBuilding(d, '2026-06', 'יוני');
  const a1 = d.tenants[0].openingDebt;
  mod.closeMonthUnpaidForBuilding(d, '2026-06', 'יוני');
  const a2 = d.tenants[0].openingDebt;
  t.eq('mutation: guard-removed 1st run = 300', a1, 300);
  t.eq('mutation: guard-removed 2nd run DOUBLES to 600 (proves guard is load-bearing)', a2, 600);
}

// ════════════════════════════════════════════════════════════════
// v2.14.8 — EXTRA ACCOUNTS idempotency (closedMonthsExtra marker)
// ════════════════════════════════════════════════════════════════
// Locked principle: what's true for the main account is true for extra accounts.
// closeExtraAccountsForBuilding must ALSO be double-run safe, via its OWN
// separate marker (closedMonthsExtra), so the two independent passes don't
// collide.
t.section('v2.14.8 — extra-accounts double-run is a NO-OP');
{
  const { readSource, extractFunctions, runInSandbox } = require('./test-lib');
  const src = readSource('server.js');
  const code = extractFunctions(src, ['closeExtraAccountsForBuilding', 'closeExtraAccountsUnpaid'])
    + '\nmodule.exports={closeExtraAccountsForBuilding};';
  const mod = runInSandbox(code, {});

  // One tenant with one monthly extra account, no payment record → unpaid accrues.
  const mkBuilding = () => ({
    tenants: [{ id: 't1', name: 'דייר', extraAccounts: [
      { id: 'a1', amount: 120, frequency: 'monthly', openingDebt: 0 }
    ] }],
    paymentHistory: {}
  });

  const d = mkBuilding();
  const r1 = mod.closeExtraAccountsForBuilding(d, '2026-06');
  const acc1 = d.tenants[0].extraAccounts[0].openingDebt;
  const r2 = mod.closeExtraAccountsForBuilding(d, '2026-06');
  const acc2 = d.tenants[0].extraAccounts[0].openingDebt;
  t.eq('extra: 1st run accrues 120 to account openingDebt', acc1, 120);
  t.eq('extra: 2nd run NO-OP (still 120, not 240)', acc2, 120);
  t.eq('extra: 2nd run reports changed:false', r2.changed, false);
  t.eq('extra: closedMonthsExtra marker set', (d.closedMonthsExtra || []).includes('2026-06'), true);

  // The extra marker is INDEPENDENT of the main marker — closing extra must not
  // be blocked by main already being closed, and vice-versa.
  const d2 = mkBuilding();
  d2.closedMonths = ['2026-06']; // main already closed…
  const r = mod.closeExtraAccountsForBuilding(d2, '2026-06');
  t.eq('extra: main closedMonths does NOT block extra close', r.closed, 1);
  t.eq('extra: extra still accrues when only main was closed',
    d2.tenants[0].extraAccounts[0].openingDebt, 120);
}

// ════════════════════════════════════════════════════════════════
// v2.14.9 — the "₪288 bug": new-tenant tariff must open retroactively
// ════════════════════════════════════════════════════════════════
// ROOT CAUSE (proven on Tal's real backup): when a tenant is CREATED via
// POST /api/data with a customAmount ≠ the building default, the tenant-tariff
// maintenance branch opened the personal interval at `today`. Importing a bank
// payment for a PAST month then found no personal rate for that month, fell
// through to the building default (288), froze the WRONG expected amount into
// paymentHistory.amount, and month-close accrued a phantom shortfall — every
// tenant collapsing to exactly openingDebt = config.amount (288).
//
// FIX (server.js ~1761): new-tenant interval opens at '2000-01-01' (matching
// seedTariffsIfMissing), so the fee applies to historical months too. An
// EXISTING tenant's fee CHANGE still opens at `today` (forward-only) — a
// different, correct rule that this fix must NOT disturb.
t.section('v2.14.9 — ₪288 bug: new-tenant tariff resolves for past months');
{
  const dflt = [{ rate: 288, startDate: '2000-01-01', endDate: null }];

  // THE BUG: interval opened at "today" → a past month falls to the 288 default.
  const buggy = S.closeAndOpenInterval([], 217, '2026-07-25');
  const tBuggy = { personalTariffs: buggy };
  t.eq('bug repro: today-dated interval → May resolves to WRONG 288',
    S.resolveTariffRate(tBuggy, dflt, '2026-05', 217), 288);
  t.eq('bug repro: today-dated interval → June resolves to WRONG 288',
    S.resolveTariffRate(tBuggy, dflt, '2026-06', 217), 288);

  // THE FIX: interval opened at 2000-01-01 → every month resolves to 217.
  const fixed = S.closeAndOpenInterval([], 217, '2000-01-01');
  const tFixed = { personalTariffs: fixed };
  t.eq('fix: interval opens at 2000-01-01', fixed[0].startDate, '2000-01-01');
  t.eq('fix: May resolves to correct 217',  S.resolveTariffRate(tFixed, dflt, '2026-05', 217), 217);
  t.eq('fix: June resolves to correct 217', S.resolveTariffRate(tFixed, dflt, '2026-06', 217), 217);
  t.eq('fix: July resolves to correct 217', S.resolveTariffRate(tFixed, dflt, '2026-07', 217), 217);
}

t.section('v2.14.9 — future fee CHANGE on an existing tenant still forward-only');
{
  const dflt = [{ rate: 288, startDate: '2000-01-01', endDate: null }];
  // Tenant created today under the fix (retroactive 217), THEN 3 months later
  // (2026-10-25) the fee changes 217 → 250. Past months must keep 217; Oct+ = 250.
  let pt = S.closeAndOpenInterval([], 217, '2000-01-01');          // create (fixed path)
  pt = S.closeAndOpenInterval(pt, 250, '2026-10-25');             // existing-tenant change (today path, unchanged)
  const tn = { personalTariffs: pt };
  t.eq('past month (June) keeps OLD 217',  S.resolveTariffRate(tn, dflt, '2026-06', 217), 217);
  t.eq('month before change (Sep) keeps 217', S.resolveTariffRate(tn, dflt, '2026-09', 217), 217);
  t.eq('change month (Oct) is NEW 250',     S.resolveTariffRate(tn, dflt, '2026-10', 250), 250);
  t.eq('after change (Dec) is NEW 250',     S.resolveTariffRate(tn, dflt, '2026-12', 250), 250);
  // The retroactive interval was closed at the change date — no overlap.
  t.eq('retro interval closed at change date', pt[0].endDate, '2026-10-25');
  t.eq('new interval open-ended', pt[1].endDate, null);
}

// ════════════════════════════════════════════════════════════════
// v2.14.12 — debt-offset transparency note (additive, math unchanged)
// ════════════════════════════════════════════════════════════════
// When a month-close surplus offsets prior openingDebt, the record now carries
// a debtOffset breakdown {monthCharge, surplus, priorDebtPaid, newCredit} so
// the tenant view / WhatsApp / export can explain "X covered the month, Y
// offset prior debt". This must NOT change the accrual math — only annotate.
t.section('v2.14.12 — debtOffset note records the split without changing math');
{
  const NOW = new Date('2026-07-01T08:00:00.000Z'); // closes 2026-06
  const mk = (opening, fee, paid) => {
    const b = { config:{amount:fee}, tenants:[{id:'t1',name:'א',customAmount:fee,openingDebt:opening}],
      paymentHistory:{ t1:[{month:'2026-06',paid:true,amount:fee,paidAmount:paid,type:'bank'}] }, sentLog:{} };
    const { run } = loadCloseMonth(b, NOW); run();
    return b;
  };

  // Surplus fully absorbed by prior debt (no leftover credit): opening 1000, fee 100, paid 800.
  let b = mk(1000, 100, 800);
  let rec = b.paymentHistory.t1.find(r => r.month === '2026-06');
  t.eq('offset present', !!rec.debtOffset, true);
  t.eq('monthCharge = 100', rec.debtOffset.monthCharge, 100);
  t.eq('surplus = 700', rec.debtOffset.surplus, 700);
  t.eq('priorDebtPaid = 700 (all surplus hit debt)', rec.debtOffset.priorDebtPaid, 700);
  t.eq('newCredit = 0 (debt not fully cleared)', rec.debtOffset.newCredit, 0);
  t.eq('openingDebt after = 300 (math intact)', b.tenants[0].openingDebt, 300);

  // Surplus exceeds prior debt → leftover becomes credit: opening 478, fee 239, paid 956.
  b = mk(478, 239, 956);
  rec = b.paymentHistory.t1.find(r => r.month === '2026-06');
  t.eq('surplus = 717', rec.debtOffset.surplus, 717);
  t.eq('priorDebtPaid = 478 (capped at prior debt)', rec.debtOffset.priorDebtPaid, 478);
  t.eq('newCredit = 239 (leftover surplus)', rec.debtOffset.newCredit, 239);
  t.eq('openingDebt after = -239 (credit; math intact)', b.tenants[0].openingDebt, -239);

  // No prior debt → whole surplus is credit: opening 0, fee 217, paid 434.
  b = mk(0, 217, 434);
  rec = b.paymentHistory.t1.find(r => r.month === '2026-06');
  t.eq('no-debt: priorDebtPaid = 0', rec.debtOffset.priorDebtPaid, 0);
  t.eq('no-debt: newCredit = 217', rec.debtOffset.newCredit, 217);

  // Exact-fee payment → no surplus → NO debtOffset stamped.
  b = mk(217, 217, 217);
  rec = b.paymentHistory.t1.find(r => r.month === '2026-06');
  t.eq('exact-fee payment: no debtOffset', rec.debtOffset === undefined, true);
  t.eq('exact-fee: openingDebt unchanged (217)', b.tenants[0].openingDebt, 217);
}

t.section('v2.14.12 — buildOffsetBlock renders the {פירוט_קיזוז} placeholder');
{
  const yr = new Date().getFullYear();
  // debt paid down + leftover credit
  let d = { paymentHistory: { t1: [
    { month: yr+'-06', debtOffset: { monthCharge: 239, surplus: 717, priorDebtPaid: 478, newCredit: 239 } }
  ] } };
  let block = S.buildOffsetBlock(d, { id: 't1' });
  t.eq('block names the month charge', block.includes('*239 ₪* עבור דמי החודש'), true);
  t.eq('block names the prior-debt paydown', block.includes('*478 ₪* קוזזו מחוב קודם'), true);
  t.eq('block names the credit', block.includes('*239 ₪* נשמרו כיתרת זכות'), true);

  // no debtOffset anywhere → empty (opt-in template shows nothing)
  d = { paymentHistory: { t1: [ { month: yr+'-06', paid: true } ] } };
  t.eq('no offset → empty block', S.buildOffsetBlock(d, { id: 't1' }), '');

  // picks the MOST RECENT offset record
  d = { paymentHistory: { t1: [
    { month: yr+'-05', debtOffset: { monthCharge: 100, surplus: 50, priorDebtPaid: 50, newCredit: 0 } },
    { month: yr+'-06', debtOffset: { monthCharge: 100, surplus: 30, priorDebtPaid: 0,  newCredit: 30 } }
  ] } };
  block = S.buildOffsetBlock(d, { id: 't1' });
  t.eq('uses the latest month (June, credit 30)', block.includes('*30 ₪* נשמרו כיתרת זכות'), true);
  t.eq('does not use the older May record', block.includes('קוזזו מחוב קודם'), false);
}

t.section('v2.14.18 — buildPriorDebtLine renders the {שורת_חוב_קודם} placeholder');
{
  // debt > 0 → whole labelled line, with the ₪ and bold markers
  t.eq('positive debt → labelled line', S.buildPriorDebtLine(478), 'חוב קודם: *478 ₪*');
  // zero debt → EMPTY (no orphaned "חוב קודם:" heading) — the whole point
  t.eq('zero debt → empty (no dangling heading)', S.buildPriorDebtLine(0), '');
  // negative (credit) → empty, never a negative "prior debt"
  t.eq('credit (negative) → empty', S.buildPriorDebtLine(-239), '');
  // non-numeric / undefined → empty, not "NaN"
  t.eq('undefined → empty', S.buildPriorDebtLine(undefined), '');
  t.eq('null → empty', S.buildPriorDebtLine(null), '');
  // string number (defensive) → coerced
  t.eq('numeric string → coerced to line', S.buildPriorDebtLine('120'), 'חוב קודם: *120 ₪*');
  // contrast with the bare {חוב_קודם}: this line carries its own label so it
  // NEVER leaves a heading behind, whereas the bare placeholder now yields 0.
  t.eq('line is self-contained (starts with the label)', S.buildPriorDebtLine(50).startsWith('חוב קודם:'), true);
}

t.section('v2.14.19 — buildCreditLine renders the {שורת_זכות} placeholder');
{
  // credit > 0 → whole labelled line
  t.eq('positive credit → labelled line', S.buildCreditLine(120), 'יתרת זכות: *120 ₪*');
  // zero credit → EMPTY (no orphaned "יתרת זכות:" heading)
  t.eq('zero credit → empty', S.buildCreditLine(0), '');
  // negative (defensive — getCreditBalance never returns <0, but guard anyway)
  t.eq('negative → empty', S.buildCreditLine(-50), '');
  t.eq('undefined → empty', S.buildCreditLine(undefined), '');
  t.eq('null → empty', S.buildCreditLine(null), '');
  t.eq('numeric string → coerced', S.buildCreditLine('90'), 'יתרת זכות: *90 ₪*');
  t.eq('line is self-contained', S.buildCreditLine(50).startsWith('יתרת זכות:'), true);
}

t.section('v2.14.19 — debt and credit are mutually exclusive (both lines never render together)');
{
  // A tenant in DEBT: calcTotalDebt > 0, getCreditBalance === 0.
  // openingDebt 300 (arrears), no payments.
  const dDebt = { config: { amount: 230 }, sentLog: {}, paymentHistory: {},
    tenants: [{ id: 'd1', name: 'חייב', openingDebt: 300, customAmount: 230 }] };
  const debt = S.calcTotalDebt(dDebt, 'd1', '2026-05');
  const creditWhenDebt = S.getCreditBalance(dDebt, 'd1');
  t.eq('debtor: debt line present', S.buildPriorDebtLine(debt).length > 0, true);
  t.eq('debtor: credit line EMPTY', S.buildCreditLine(creditWhenDebt), '');

  // A tenant in CREDIT: negative openingDebt (prepaid), no unpaid history.
  const dCredit = { config: { amount: 230 }, sentLog: {}, paymentHistory: {},
    tenants: [{ id: 'c1', name: 'זכאי', openingDebt: -120, customAmount: 230 }] };
  const debt2 = S.calcTotalDebt(dCredit, 'c1', '2026-05');
  const credit2 = S.getCreditBalance(dCredit, 'c1');
  t.eq('creditor: credit line present', S.buildCreditLine(credit2), 'יתרת זכות: *120 ₪*');
  t.eq('creditor: debt line EMPTY', S.buildPriorDebtLine(debt2), '');
}

// ════════════════════════════════════════════════════════════════
// v2.14.23 — apt-note→apartment matching (AGENT path, analyzeBankRowsServer)
// Runs the REAL server analyzer end-to-end. Priority-0: a bank note naming an
// apartment routes the row to the tenant whose aptNumber matches, BEFORE the
// ambiguous full-name check. Guard: a note naming a DIFFERENT apt cannot fall
// to name/phone. Main account only — extra accounts untouched (§5).
// ════════════════════════════════════════════════════════════════
{
  t.section('v2.14.23 — apt-note match (agent path, real analyzeBankRowsServer)');
  const { analyzeBankRowsServer } = require('./test-lib').loadBankAnalyzer();

  // Mapping mirrors the real Otsar file: name col 2, amount col 6, note col 10.
  const mapping = { colName:2, colAmount:6, colDate:-1, colNote:10, bankAmount:'', bankTolerance:5 };
  const hdr = ['h','h','שם','h','h','h','סכום','h','h','h','הערות'];
  const rowNote = (name, amt, note) => { const r=['','',name,'','','',String(amt),'','','','']; r[10]=note; return r; };
  const run = (rows, tenants) =>
    analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-07', { amount: 450 }, new Set());

  // Case A — the REAL RTL row from the July file: "6 וועד בית דירה".
  {
    const res = run([hdr, rowNote('וזנה ירין', 450, '6 וועד בית דירה')],
      [{ id:'T1', name:'וזנה ירין', phone:'0500000001', keywords:'', aptNumber:'6' }]);
    t.eq('A: real RTL note matches by apt', res.matched.length, 1);
    t.eq('A: match type is apt', res.matched[0] && res.matched[0].matchType, 'apt');
  }

  // Case C — two same-named owners (apt 6 / apt 7); note says "דירה 7" → T7 wins.
  {
    const res = run([hdr, rowNote('משה כהן', 450, 'דירה 7')], [
      { id:'T6', name:'משה כהן', phone:'0500000006', keywords:'', aptNumber:'6' },
      { id:'T7', name:'משה כהן', phone:'0500000007', keywords:'', aptNumber:'7' }
    ]);
    t.eq('C: exactly one match', res.matched.length, 1);
    t.eq('C: routed to the apt-7 owner (not first-iterated apt-6)',
      res.matched[0] && res.matched[0].tenantId, 'T7');
    t.eq('C: apt-6 owner correctly excluded',
      res.unmatched.some(u => u.tenantId === 'T6'), true);
  }

  // Case D — REGRESSION: no aptNumber anywhere → name-match, unchanged behavior.
  {
    const res = run([hdr, rowNote('משה כהן', 450, 'דירה 7')],
      [{ id:'T7', name:'משה כהן', phone:'0500000007', keywords:'' }]);
    t.eq('D: no aptNumber → falls to name-match', res.matched[0] && res.matched[0].matchType, 'name');
  }

  // Case E — REGRESSION: note has NO apartment → keyword still works as before.
  {
    const res = run([hdr, rowNote('כהן ביטוח', 450, 'ועד בית יולי')],
      [{ id:'T8', name:'משה כהן', phone:'0500000008', keywords:'כהן ביטוח', aptNumber:'8' }]);
    t.eq('E: note without apt → keyword match unaffected',
      res.matched[0] && res.matched[0].matchType, 'keyword');
  }

  // Case F — REGRESSION (the wrong-apt case Tal flagged): a single tenant with
  // aptNumber=6 whose note MISTYPES "דירה 7" — but NO tenant owns apt 7. The
  // guard must NOT block; the tenant is still found by keyword/name. This is the
  // difference between "note names another owner's apt" (block) and "note names
  // an apt nobody owns" (payer typo → don't block).
  {
    const res = run([hdr, rowNote('משה כהן', 450, 'דירה 7')],
      [{ id:'T9', name:'משה כהן', phone:'0521234567', keywords:'כהן מ', aptNumber:'6' }]);
    t.eq('F: wrong apt nobody owns → still matched (not blocked)', res.matched.length, 1);
    t.eq('F: falls back to name/keyword, not apt',
      res.matched[0] && res.matched[0].matchType !== 'apt', true);
    t.eq('F: not left unmatched', res.unmatched.length, 0);
  }

  // ── v2.14.24 REGRESSION (real Otsar file, 2026-08) ────────────────
  // Bug reported by Tal: Vazana paid 230 with note "8 וועד דירה" — he meant
  // MONTH 8 (August), not apartment 8. The extractor pulled apartment "8", and
  // Gil (aptNumber 8) was handed Vazana's row on TOP of his own → ×2 / 460.
  // Fix: apt-note is a TIE-BREAKER only — it may route a row to a tenant ONLY
  // when that tenant also matches the row by keyword/phone/name. A misleading
  // number in someone else's note can no longer steal an unrelated row.
  {
    // Two real rows, both 230. Gil's own row (name "זמיר נורית וזמיר") and
    // Vazana's row (name "וזנה ירין", note "8 וועד דירה").
    const rows = [
      hdr,
      rowNote('זמיר נורית וזמיר', 230, ' '),
      rowNote('וזנה ירין',        230, '8 וועד דירה')
    ];
    const tenants = [
      { id:'GIL',  name:'גיל זמיר',  phone:'054313223', keywords:'זמיר, נורית, וזמיר, גיל', aptNumber:'8' },
      { id:'VAZ',  name:'ירין וזנה', phone:'0500000009', keywords:'וזנה, ירין',            aptNumber:'' }
    ];
    const res = analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-08', { amount: 230 }, new Set());
    const gil = res.matched.find(m => m.tenantId === 'GIL');
    const vaz = res.matched.find(m => m.tenantId === 'VAZ');
    t.eq('G: Gil total is 230, not 460 (no stolen row)', gil && gil.amount, 230);
    t.eq('G: Gil NOT matched by apt (name/keyword basis)', gil && gil.matchType !== 'apt', true);
    t.eq('G: Vazana matched on her own row (guard did not block)', vaz && vaz.amount, 230);
    t.eq('G: exactly two tenants matched', res.matched.length, 2);
    t.eq('G: nobody left unmatched', res.unmatched.length, 0);
  }
}

process.exit(t.done() ? 1 : 0);
