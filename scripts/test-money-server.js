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

  t.section('Bank dedup — v2.14.29: prior import WITHOUT ref still de-dupes after mapping ref');
  {
    // The exact reported regression: a file was imported LAST MONTH with no
    // אסמכתא column mapped → fingerprints stored as 3-part (legacy). Now the admin
    // maps the ref column and re-imports the SAME file. Those rows must still read
    // "already imported" (via the legacy fallback), NOT re-appear as new.
    const refMapping   = { colName: 0, colAmount: 1, colDate: 2, colNote: -1, colRef: 3 };
    const noRefMapping = { colName: 0, colAmount: 1, colDate: 2, colNote: -1 };
    const rows = [
      ['שם', 'סכום', 'תאריך', 'אסמכתא'],
      ['ברקן טל', '230', '17/08/2026', '3367'],
    ];
    const tenants = [{ id: 'T', name: 'ברקן טל', phone: '0500000000', keywords: '', customAmount: 230, openingDebt: 0 }];
    // Prior import: NO ref column → legacy 3-part fingerprint stored.
    const r1 = B.analyzeBankRowsServer(rows, noRefMapping, tenants, {}, '2026-08', { amount: 230 }, new Set());
    t.eq('prior import stored a legacy (3-part) fingerprint', r1.newFingerprints.length, 1);
    t.eq('legacy fp has no ref part', r1.newFingerprints[0].split('|').length, 3);
    const prior = new Set(r1.newFingerprints);
    // Re-import the SAME file, now WITH ref mapped.
    const r2 = B.analyzeBankRowsServer(rows, refMapping, tenants, {}, '2026-08', { amount: 230 }, prior);
    t.eq('re-import with ref mapped adds NO new fingerprints', r2.newFingerprints.length, 0);
    t.eq('re-import is reported as already-imported, not matched', r2.matched.length, 0);
    t.eq('already-imported skip surfaced', (r2.alreadyImportedSkips||[]).length, 1);
  }

  t.section('Bank dedup — v2.14.29: legacy fallback does NOT re-collapse two genuine rows');
  {
    // Same-day/amount/name, distinct ref. One was already imported (as 4-part).
    // The OTHER must still count — the legacy fallback must not swallow it just
    // because they share a 3-part key.
    const refMapping = { colName: 0, colAmount: 1, colDate: 2, colNote: -1, colRef: 3 };
    const rowA = [['שם','סכום','תאריך','אסמכתא'], ['שחם חנה','230','19/08/2026','589592']];
    const rowB = [['שם','סכום','תאריך','אסמכתא'], ['שחם חנה','230','19/08/2026','589593']];
    const tenants = [{ id: 'H', name: 'שחם חנה', phone: '0500000000', keywords: '', customAmount: 230, openingDebt: 0 }];
    const r1 = B.analyzeBankRowsServer(rowA, refMapping, tenants, {}, '2026-08', { amount: 230 }, new Set());
    t.eq('first payment (589592) imported', r1.newFingerprints.length, 1);
    const prior = new Set(r1.newFingerprints);
    const r2 = B.analyzeBankRowsServer(rowB, refMapping, tenants, {}, '2026-08', { amount: 230 }, prior);
    t.eq('second payment (589593) still counts — NOT swallowed by legacy fallback', r2.matched.length, 1);
    t.eq('second payment records a new fingerprint', r2.newFingerprints.length, 1);
    t.eq('second payment not reported as already-imported', (r2.alreadyImportedSkips||[]).length, 0);
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
    // v2.14.43 — the client reset NO LONGER touches openingDebt or the tenants
    // list at all (that irreversible half moved to the admin-only endpoint).
    t.eq('tenants NOT in patch (openingDebt untouched by client reset)', patch.tenants, undefined);
    // config is NOT in the patch (never sent → never touched).
    t.eq('config not in patch (untouched)', patch.config, undefined);
    t.eq('defaultTariffs not in patch (untouched)', patch.defaultTariffs, undefined);
    t.eq('receipt returns backup filename', r.result.backupFile, 'backup-pre-restore-test.zip');
    // The building's real openingDebt survives the client reset.
    t.eq('building openingDebt survived (main)', b.tenants[0].openingDebt, 217);
    t.eq('building openingDebt survived (extra)', b.tenants[0].extraAccounts[0].openingDebt, 30);
  }

  // ── v2.14.51 — admin-only FULL building wipe (replaces openingDebt-only) ──
  const withQueues = () => Object.assign(makeBuilding(), {
    pendingClosedMonthPayments: [{ tenantId: 'Z', month: '2026-05' }],
    pendingAmbiguousMatches: [{ row: 'x' }, { row: 'y' }]
  });

  t.section('Admin full reset — dryRun previews without writing');
  {
    const { loadResetBuildingFull } = require('./test-lib');
    const b = withQueues();
    const users = [{ tenantId: 'T1', buildingName: 'בניין הבדיקה' }];
    const r = loadResetBuildingFull(b, { tenantId: 'T1', dryRun: true }, users);
    const s = r.result.summary;
    t.eq('dryRun ok', r.result.ok === true && r.result.dryRun === true, true);
    t.eq('returns building name for the confirm dialog', s.buildingName, 'בניין הבדיקה');
    t.eq('counts tenants with openingDebt', s.tenantsWithOpeningDebt, 1);
    t.eq('counts extra accounts with openingDebt', s.extraAccountsWithOpeningDebt, 1);
    t.eq('counts tenants with personalTariffs', s.tenantsWithPersonalTariffs, 1);
    t.eq('counts sentLog main', s.sentLogMain, 2);
    t.eq('counts sentLog extra', s.sentLogExtra, 1);
    t.eq('counts paymentHistory main', s.paymentHistoryRecordsMain, 1);
    t.eq('counts paymentHistory extra', s.paymentHistoryRecordsExtra, 1);
    t.eq('counts fingerprints', s.importedFingerprints, 2);
    t.eq('counts closed months (main+extra)', s.closedMonths, 4);
    t.eq('counts pending queue items', s.pendingQueued, 3);
    t.eq('dryRun wrote nothing', r.saved.length, 0);
    t.eq('dryRun took no backup', r.backupCalled, 0);
    t.eq('dryRun left openingDebt intact', b.tenants[0].openingDebt, 217);
    t.eq('dryRun left sentLog intact', Object.keys(b.sentLog).length, 3);
  }

  t.section('Admin full reset — real run wipes all money results, keeps tenants + settings');
  {
    const { loadResetBuildingFull } = require('./test-lib');
    const b = withQueues();
    const cfgBefore = JSON.stringify(b.config), dtBefore = JSON.stringify(b.defaultTariffs);
    const users = [{ tenantId: 'T1', buildingName: 'בניין הבדיקה' }];
    const r = loadResetBuildingFull(b, { tenantId: 'T1', dryRun: false }, users);
    t.eq('took a backup FIRST', r.backupCalled, 1);
    t.eq('wrote exactly once', r.saved.length, 1);
    const patch = r.saved[0].patch;
    // Wiped — main AND extra (main == extra).
    t.eq('tenant openingDebt zeroed', patch.tenants[0].openingDebt, 0);
    t.eq('extra account openingDebt zeroed', patch.tenants[0].extraAccounts[0].openingDebt, 0);
    t.eq('sentLog emptied (main + __acc__)', Object.keys(patch.sentLog).length, 0);
    t.eq('paymentHistory emptied (main + __acc__)', Object.keys(patch.paymentHistory).length, 0);
    t.eq('fingerprints emptied', patch.importedBankFingerprints.length, 0);
    t.eq('lastBankSyncImport cleared', patch.lastBankSyncImport, null);
    t.eq('closedMonths cleared', patch.closedMonths.length, 0);
    t.eq('closedMonthsExtra cleared', patch.closedMonthsExtra.length, 0);
    t.eq('pendingClosedMonthPayments cleared', patch.pendingClosedMonthPayments.length, 0);
    t.eq('pendingAmbiguousMatches cleared', patch.pendingAmbiguousMatches.length, 0);
    // personalTariffs dropped + re-seeded from customAmount by the REAL seed rule:
    // Z (217 == default 217) rides the default → no personal interval;
    // R (239 != 217) gets ONE open interval from 2000-01-01 at 239.
    t.eq('Z old personal interval (2026-01-01) removed, rides default', patch.tenants[0].personalTariffs, undefined);
    t.eq('R re-seeded: one interval', (patch.tenants[1].personalTariffs || []).length, 1);
    t.eq('R re-seeded rate = customAmount', patch.tenants[1].personalTariffs[0].rate, 239);
    t.eq('R re-seeded from 2000-01-01', patch.tenants[1].personalTariffs[0].startDate, '2000-01-01');
    // Kept.
    t.eq('tenant count kept', patch.tenants.length, 2);
    t.eq('tenant name kept', patch.tenants[0].name, 'צבי אלתר');
    t.eq('tenant phone kept', patch.tenants[0].phone, '0528064806');
    t.eq('keywords kept', patch.tenants[0].keywords, 'אלתר');
    t.eq('customAmount kept', patch.tenants[0].customAmount, 217);
    t.eq('extraAccount definition kept (label)', patch.tenants[0].extraAccounts[0].label, 'ביטוח');
    t.eq('extraAccount amount kept', patch.tenants[0].extraAccounts[0].amount, 50);
    t.eq('config not in patch', patch.config, undefined);
    t.eq('defaultTariffs not in patch (already existed)', patch.defaultTariffs, undefined);
    t.eq('config byte-unchanged', JSON.stringify(b.config), cfgBefore);
    t.eq('defaultTariffs byte-unchanged', JSON.stringify(b.defaultTariffs), dtBefore);
    t.eq('receipt returns backup filename', r.result.backupFile, 'backup-pre-restore-test.zip');
  }

  t.section('Admin full reset — rejects an unknown tenantId');
  {
    const { loadResetBuildingFull } = require('./test-lib');
    const b = makeBuilding();
    const users = [{ tenantId: 'T1', buildingName: 'בניין הבדיקה' }];
    const r = loadResetBuildingFull(b, { tenantId: 'GHOST', dryRun: false }, users);
    t.eq('rejected unknown tenantId', r.result.ok, false);
    t.eq('nothing written for bad id', r.saved.length, 0);
    t.eq('no backup for bad id', r.backupCalled, 0);
  }

  // REGRESSION (נווה ים, 2026-09-25): after the admin reset, importing a tenants
  // file with חוב_התחלתי 7,200 showed 6,700 — a leftover ₪500 overpayment in
  // sentLog was netted against the new opening balance. After a FULL reset the
  // displayed debt must equal the file value exactly, with zero credit.
  t.section('Admin full reset — re-imported opening debt is shown exactly (נווה ים)');
  {
    const { loadResetBuildingFull } = require('./test-lib');
    const mk = () => ({
      config: { amount: 200 },
      defaultTariffs: [{ rate: 200, startDate: '2000-01-01', endDate: null }],
      tenants: [{ id: 'OR', name: 'משפחת אור', phone: '0528333131', customAmount: 200, openingDebt: 0 }],
      sentLog: { 'OR_יוני': 'bank_import_x_700_payer_אור' },
      paymentHistory: { 'OR': [{ month: '2026-06', paid: true, amount: 200, paidAmount: 700 }] }
    });
    // Baseline — documents the bug: without wiping sentLog the leftover credit nets.
    const before = mk();
    before.tenants[0].openingDebt = 7200;              // tenants-file import
    const leaked = S.calcTotalDebt(before, 'OR', '2026-06');
    t.eq('without full reset: leftover credit nets the file value (< 7200)', leaked < 7200, true);
    // Fixed path: full reset → tenants-file import → exact file value.
    const b = mk();
    loadResetBuildingFull(b, { tenantId: 'T1', dryRun: false });
    b.tenants[0].openingDebt = 7200;                   // tenants-file import
    t.eq('after full reset + import: debt == file value', S.calcTotalDebt(b, 'OR', '2026-06'), 7200);
    t.eq('after full reset + import: no phantom credit', S.getCreditBalance(b, 'OR'), 0);
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

t.section('v2.14.30 — autoSendShouldRemind (skip ONLY a full payment)');
{
  const cfg = { amount: 230, manualMonth: 'מאי' };
  const mk = '2026-05';
  const tn = { id: 'p2', name: 'עמית' };
  const mk2 = (sl) => ({ config: cfg, sentLog: sl, paymentHistory: {}, tenants: [tn] });
  t.eq('nothing yet → remind', S.autoSendShouldRemind(mk2({}), tn, mk), true);
  // ⚠️ v2.14.30 — behaviour CHANGED: a `sent_` marker (manual OR a prior auto
  // reminder) no longer skips an unpaid tenant. This is the root-cause fix — a
  // manual nudge from the תשלומים tab must NOT suppress the scheduled send.
  t.eq('reminded (sent_) but UNPAID → still remind (v2.14.30)',
    S.autoSendShouldRemind(mk2({ 'p2_מאי': 'sent_2026-05-10T00:00:00Z' }), tn, mk), true);
  t.eq('full payment → skip',
    S.autoSendShouldRemind(mk2({ 'p2_מאי': 'bank_import_2026-05-10T00:00:00Z_230_payer_x' }), tn, mk), false);
  t.eq('PARTIAL payment → remind',
    S.autoSendShouldRemind(mk2({ 'p2_מאי': 'bank_import_2026-05-10T00:00:00Z_150_payer_x' }), tn, mk), true);
  t.eq('overpayment (full+credit) → skip',
    S.autoSendShouldRemind(mk2({ 'p2_מאי': 'bank_import_2026-05-10T00:00:00Z_300_payer_x' }), tn, mk), false);
  // Combined real-world case: operator reminded manually, tenant then paid in full
  // → must skip (the payment, not the reminder, is what stops the auto-send).
  t.eq('manually reminded THEN paid in full → skip',
    S.autoSendShouldRemind(mk2({ 'p2_מאי': 'manual_paid_2026-05-12T00:00:00Z_amount_230' }), tn, mk), false);
}

// ════════════════════════════════════════════════════════════════
// v2.14.31 — collection suspension (השהיית גבייה): exempt tenants/accounts
// ════════════════════════════════════════════════════════════════
// Design: 1A boolean flag · 2C per-entity (main tenant.suspended, per-account
// acc.suspended, independent) · 3A prior debt kept, only forward accrual frozen
// · 4A a distinct 'exempt' status. Runs the REAL close functions + real
// autoSendShouldRemind (no re-implementation).
t.section('v2.14.31 — suspension: main account no accrual on close (3A)');
{
  const { loadCloseMonth } = require('./test-lib');
  // Two tenants, neither paid מאי. One suspended, one not. Close 2026-05 on Jun 1.
  const mkBld = () => ({
    config: { amount: 300, manualMonth: 'מאי' },
    sentLog: {}, paymentHistory: {}, closedMonths: [],
    tenants: [
      { id: 'a', name: 'רגיל',  openingDebt: 0 },
      { id: 'b', name: 'מושהה', openingDebt: 100, suspended: true }
    ]
  });
  const bld = mkBld();
  const h = loadCloseMonth(bld, new Date('2026-06-01T06:00:00Z'));
  h.runForBuilding(bld, '2026-05', 'מאי');
  const norm = bld.tenants.find(x => x.id === 'a');
  const susp = bld.tenants.find(x => x.id === 'b');
  t.eq('normal tenant accrued the month (0→300)', norm.openingDebt, 300);
  t.eq('suspended tenant did NOT accrue (openingDebt unchanged)', susp.openingDebt, 100);
}

t.section('v2.14.31 — suspension: extra account no accrual on close (2C+3A)');
{
  const loadCloseExtra = require('./test-lib').loadCloseExtra;
  const closeExtra = loadCloseExtra();
  // One tenant, two extra accounts, neither paid. Account #1 suspended.
  const d = { paymentHistory: {} };
  const tenant = { id: 't', name: 'דייר', extraAccounts: [
    { id: 'ins', label: 'ביטוח', amount: 200, openingDebt: 50, suspended: true },
    { id: 'ele', label: 'חשמל',  amount: 80,  openingDebt: 0 }
  ] };
  const closed = closeExtra(d, tenant, '2026-05');
  const ins = tenant.extraAccounts.find(a => a.id === 'ins');
  const ele = tenant.extraAccounts.find(a => a.id === 'ele');
  t.eq('suspended account did NOT accrue (50 unchanged)', ins.openingDebt, 50);
  t.eq('active account DID accrue (0→80)', ele.openingDebt, 80);
  t.eq('only the non-suspended account counted as closed', closed, 1);
}

t.section('v2.14.31 — suspension: autoSend respects per-account rule (2C)');
{
  const cfg = { amount: 230, manualMonth: 'מאי' };
  const mk = '2026-05';
  // Suspended MAIN, but has an ACTIVE unpaid extra → still remind (for the extra).
  const tnExtra = { id: 's1', name: 'מושהה+ביטוח', suspended: true,
    extraAccounts: [{ id: 'ins', label: 'ביטוח', amount: 200, active: true }] };
  t.eq('suspended main + unpaid active extra → remind',
    S.autoSendShouldRemind({ config: cfg, sentLog: {}, paymentHistory: {}, tenants: [tnExtra] }, tnExtra, mk), true);
  // Suspended MAIN, extra also suspended → nothing to send.
  const tnBoth = { id: 's2', name: 'הכל מושהה', suspended: true,
    extraAccounts: [{ id: 'ins', label: 'ביטוח', amount: 200, active: true, suspended: true }] };
  t.eq('suspended main + suspended extra → skip',
    S.autoSendShouldRemind({ config: cfg, sentLog: {}, paymentHistory: {}, tenants: [tnBoth] }, tnBoth, mk), false);
  // Suspended MAIN, extra already paid → nothing to send.
  const tnPaid = { id: 's3', name: 'מושהה+שולם', suspended: true,
    extraAccounts: [{ id: 'ins', label: 'ביטוח', amount: 200, active: true }] };
  t.eq('suspended main + extra paid → skip',
    S.autoSendShouldRemind({ config: cfg,
      sentLog: { 's3__acc__ins_מאי': 'manual_paid_2026-05-10T00:00:00Z_amount_200' },
      paymentHistory: {}, tenants: [tnPaid] }, tnPaid, mk), false);
  // Suspended MAIN, no extras at all → skip.
  const tnNone = { id: 's4', name: 'מושהה בלבד', suspended: true, extraAccounts: [] };
  t.eq('suspended main + no extras → skip',
    S.autoSendShouldRemind({ config: cfg, sentLog: {}, paymentHistory: {}, tenants: [tnNone] }, tnNone, mk), false);
}

// ════════════════════════════════════════════════════════════════
// v2.14.36 — credit-in-advance gate in autoSendShouldRemind (design B+1)
// ════════════════════════════════════════════════════════════════
// A tenant who paid several months ahead has NO sentLog entry for the current
// month (nothing landed this month), yet owes nothing — the charge is covered by
// banked credit (negative openingDebt). The pre-v2.14.36 `!val → remind` rule
// nagged them. The gate consults getCreditBalance (authoritative) and suppresses
// the MAIN reminder when credit ≥ the month charge; an unpaid ACTIVE extra is
// still its own reason to remind (per-account, symmetric with the suspended rule).
// Runs the REAL autoSendShouldRemind + REAL getCreditBalance — no re-implementation.
t.section('v2.14.36 — autoSend: credit-in-advance suppresses the reminder');
{
  const cfg = { amount: 300, manualMonth: 'יולי' };
  const mk  = '2026-07';
  // Banked credit of 600 (paid 2 months ahead) → openingDebt -600, no sentLog this
  // month. getCreditBalance = 600 ≥ 300 month charge → MAIN covered → skip.
  const tnCredit = { id: 'c1', name: 'שילם מראש', openingDebt: -600 };
  t.eq('credit 600 ≥ charge 300, no sentLog → SKIP (was the bug)',
    S.autoSendShouldRemind({ config: cfg, sentLog: {}, paymentHistory: {}, tenants: [tnCredit] }, tnCredit, mk), false);
  // Exactly one month of credit (300) → still covers this month → skip.
  const tnExact = { id: 'c2', name: 'קרדיט מדויק', openingDebt: -300 };
  t.eq('credit 300 == charge 300 → SKIP',
    S.autoSendShouldRemind({ config: cfg, sentLog: {}, paymentHistory: {}, tenants: [tnExact] }, tnExact, mk), false);
  // Credit smaller than the month charge (partial credit) → NOT covered → remind.
  const tnShort = { id: 'c3', name: 'קרדיט חלקי', openingDebt: -100 };
  t.eq('credit 100 < charge 300 → REMIND (other direction)',
    S.autoSendShouldRemind({ config: cfg, sentLog: {}, paymentHistory: {}, tenants: [tnShort] }, tnShort, mk), true);
  // No credit at all, no sentLog → the ordinary unpaid case → remind (unchanged).
  const tnPlain = { id: 'c4', name: 'רגיל חייב', openingDebt: 0 };
  t.eq('no credit, no sentLog → REMIND (unchanged baseline)',
    S.autoSendShouldRemind({ config: cfg, sentLog: {}, paymentHistory: {}, tenants: [tnPlain] }, tnPlain, mk), true);
  // main==extra: credit covers the MAIN charge, but an ACTIVE extra is unpaid this
  // month → still remind (the body will carry only the extra line downstream).
  const tnCredExtra = { id: 'c5', name: 'קרדיט + חשמל חייב', openingDebt: -600,
    extraAccounts: [{ id: 'ele', label: 'חשמל', amount: 80, active: true }] };
  t.eq('credit covers main BUT active extra unpaid → REMIND (per-account)',
    S.autoSendShouldRemind({ config: cfg, sentLog: {}, paymentHistory: {}, tenants: [tnCredExtra] }, tnCredExtra, mk), true);
  // Same, but the extra is already paid → nothing owed anywhere → skip.
  const tnCredExtraPaid = { id: 'c6', name: 'קרדיט + חשמל שולם', openingDebt: -600,
    extraAccounts: [{ id: 'ele', label: 'חשמל', amount: 80, active: true }] };
  t.eq('credit covers main AND extra paid → SKIP',
    S.autoSendShouldRemind({ config: cfg,
      sentLog: { 'c6__acc__ele_יולי': 'manual_paid_2026-07-03T00:00:00Z_amount_80' },
      paymentHistory: {}, tenants: [tnCredExtraPaid] }, tnCredExtraPaid, mk), false);
  // A real PARTIAL payment this month (val present) must NOT be swallowed by the
  // credit gate — the gate only touches the no-sentLog case. Partial → remind.
  const tnPartial = { id: 'c7', name: 'קרדיט אבל שילם חלקית החודש', openingDebt: -600 };
  t.eq('partial payment this month still REMINDS (gate is no-sentLog only)',
    S.autoSendShouldRemind({ config: cfg,
      sentLog: { 'c7_יולי': 'bank_import_2026-07-05T00:00:00Z_100_payer_x' },
      paymentHistory: {}, tenants: [tnPartial] }, tnPartial, mk), true);
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

// ════════════════════════════════════════════════════════════════════════
// v2.14.38 — lump-sum single-row split across months (the Randi/apt-3 bug)
// A tenant who falls behind and pays ONE transfer covering several months
// (460=2×230, note "יולי אוגוסט") used to land wholly on the row's date-month
// as a phantom overpayment. analyzeBankRowsServer now fans it out per month.
// Mutation targets: removing the split → the FIRST test (two months) fails;
// ignoring isPaid → the "skip already-paid month" test fails.
// ════════════════════════════════════════════════════════════════════════
{
  const { loadBankAnalyzer } = require('./test-lib');
  const B = loadBankAnalyzer();
  const dft = [{ rate: 230, startDate: '2000-01-01', endDate: null }];
  const tOf = () => ([{ id: 'R', name: 'מירי', phone: '0527247713', keywords: 'סיגולים, מירי', aptNumber: '3', customAmount: null }]);
  const amtOf = (sl, heb) => parseFloat(String(sl['R_' + heb]).match(/bank_import_[^_]+_([\d.]+)_/)[1]);

  t.section('v2.14.38 — lump-sum split: note names the months');
  {
    const rows = [['שם','סכום','תאריך','הערה'], ['סיגולים מירי','460','07/08/2026','ועד הבית יולי אוגוסט']];
    const mapping = { colName: 0, colAmount: 1, colDate: 2, colNote: 3 };
    const r = B.analyzeBankRowsServer(rows, mapping, tOf(), {}, '2026-08', { amount: 230 }, new Set(), {}, dft);
    t.eq('split into TWO months', r.matched[0].monthsSplit, 2);
    t.eq('July key written = 230', amtOf(r.newSentLog, 'יולי'), 230);
    t.eq('August key written = 230 (NOT 460)', amtOf(r.newSentLog, 'אוגוסט'), 230);
    t.eq('splitMonths reported', JSON.stringify(r.matched[0].splitMonths), JSON.stringify(['2026-07','2026-08']));
  }

  t.section('v2.14.38 — lump-sum split: no note, backfill unpaid priors');
  {
    const rows = [['שם','סכום','תאריך','הערה'], ['סיגולים מירי','690','07/08/2026','']];
    const mapping = { colName: 0, colAmount: 1, colDate: 2, colNote: 3 };
    const r = B.analyzeBankRowsServer(rows, mapping, tOf(), {}, '2026-08', { amount: 230 }, new Set(), {}, dft);
    t.eq('x3 → three months', r.matched[0].monthsSplit, 3);
    t.eq('June=230', amtOf(r.newSentLog, 'יוני'), 230);
    t.eq('July=230', amtOf(r.newSentLog, 'יולי'), 230);
    t.eq('August=230', amtOf(r.newSentLog, 'אוגוסט'), 230);
  }

  t.section('v2.14.38 — lump-sum split: never overwrites an already-paid month');
  {
    // July already paid (in sentLog). 460 in Aug ⇒ backfill must SKIP July and use June.
    const sl = { 'R_יולי': 'bank_import_2026-07-01T00:00:00.000Z_230_payer_x' };
    const rows = [['שם','סכום','תאריך','הערה'], ['סיגולים מירי','460','07/08/2026','']];
    const mapping = { colName: 0, colAmount: 1, colDate: 2, colNote: 3 };
    const r = B.analyzeBankRowsServer(rows, mapping, tOf(), sl, '2026-08', { amount: 230 }, new Set(), {}, dft);
    t.eq('July NOT overwritten (still original)', r.newSentLog['R_יולי'], sl['R_יולי']);
    t.eq('June filled instead', amtOf(r.newSentLog, 'יוני'), 230);
    t.eq('August=230', amtOf(r.newSentLog, 'אוגוסט'), 230);
  }

  t.section('v2.14.38 — no split on exact single charge (byte-identical path)');
  {
    const rows = [['שם','סכום','תאריך','הערה'], ['סיגולים מירי','230','07/08/2026','']];
    const mapping = { colName: 0, colAmount: 1, colDate: 2, colNote: 3 };
    const r = B.analyzeBankRowsServer(rows, mapping, tOf(), {}, '2026-08', { amount: 230 }, new Set(), {}, dft);
    t.eq('single charge → one month only', r.matched[0].monthsSplit, 1);
    t.eq('August=230', amtOf(r.newSentLog, 'אוגוסט'), 230);
    t.eq('no July key', r.newSentLog['R_יולי'], undefined);
  }

  // ════════════════════════════════════════════════════════════════
  // v2.14.39 — FIX 2: closed-month payment approval (reverse-accrual)
  // via the REAL /api/apply-closed-month-payment route handler.
  // ════════════════════════════════════════════════════════════════
  t.section('v2.14.39 — closed-month reverse-accrual (main account)');
  {
    const { loadApplyClosedMonth } = require('./test-lib');
    // Tenant owes 230 accrued for July (July already closed).
    const mkBuilding = () => ({
      config: { amount: 230 },
      closedMonths: ['2026-07'],
      closedMonthsExtra: [],
      tenants: [{ id: 'R', name: 'רנדי', customAmount: 230, openingDebt: 230 }],
      paymentHistory: { R: [] },
      sentLog: {}
    });

    // 1) First approval → openingDebt 230→0, record carries the receipt, sentLog set.
    const b1 = mkBuilding();
    const r1 = loadApplyClosedMonth(b1, { tenantId: 'R', month: '2026-07', scope: 'main', paidAmount: 230, payerName: 'רנדי' });
    t.eq('applied=true', r1.result && r1.result.applied, true);
    t.eq('openingDebt 230→0', b1.tenants[0].openingDebt, 0);
    t.eq('reversed 230', r1.result.reversed, 230);
    const rec1 = b1.paymentHistory.R.find(x => x.month === '2026-07');
    t.eq('record has receipt (debtOffset.reversedFrom)', !!(rec1 && rec1.debtOffset && rec1.debtOffset.reversedFrom === '2026-07'), true);
    t.eq('sentLog July set to manual_paid', !!(String(b1.sentLog['R_יולי'] || '').startsWith('manual_paid')), true);

    // 2) SECOND approval on the SAME building → NO-OP (receipt guard). openingDebt stays 0.
    const r2 = loadApplyClosedMonth(b1, { tenantId: 'R', month: '2026-07', scope: 'main', paidAmount: 230 });
    t.eq('second approval applied=false', r2.result && r2.result.applied, false);
    t.eq('second approval alreadyApplied=true', r2.result && r2.result.alreadyApplied, true);
    t.eq('openingDebt STILL 0 (no double subtract)', b1.tenants[0].openingDebt, 0);

    // 3) Month not actually closed → 409, no write.
    const b3 = mkBuilding(); b3.closedMonths = [];
    const r3 = loadApplyClosedMonth(b3, { tenantId: 'R', month: '2026-07', scope: 'main' });
    t.eq('not-closed month → status 409', r3.status, 409);
    t.eq('not-closed month → openingDebt untouched', b3.tenants[0].openingDebt, 230);
  }

  // ════════════════════════════════════════════════════════════════
  // v2.14.39a — reverse-accrual applies FULL paidAmount; excess → credit
  // (openingDebt may go negative). openingDebt values below are POST-close
  // (already accrued), matching what the live endpoint receives.
  // The 7 rows mirror the Hebrew table locked with Tal (session 22).
  // ════════════════════════════════════════════════════════════════
  t.section('v2.14.39a — full-payment reverse-accrual + excess→credit');
  {
    const { loadApplyClosedMonth } = require('./test-lib');
    const mk = (openingDebtPostClose, charge) => ({
      config: { amount: charge },
      closedMonths: ['2026-08'],
      closedMonthsExtra: [],
      tenants: [{ id: 'R', name: 'אור', customAmount: charge, openingDebt: openingDebtPostClose }],
      paymentHistory: { R: [] },
      sentLog: {}
    });
    const apply = (b, paid) => loadApplyClosedMonth(b, { tenantId: 'R', month: '2026-08', scope: 'main', paidAmount: paid, payerName: 'אור' });

    // Row 1 — no prior debt, charge 200 accrued at close (=200), paid 1000 → −800 (credit 800)
    { const b = mk(200, 200); const r = apply(b, 1000);
      t.eq('row1 openingDebt 200→−800', b.tenants[0].openingDebt, -800);
      t.eq('row1 reversed=1000 (full paid)', r.result.reversed, 1000); }

    // Row 2 — prior debt 300 + charge 200 = 500 post-close, paid 1000 → −500 (credit 500)
    { const b = mk(500, 200); const r = apply(b, 1000);
      t.eq('row2 openingDebt 500→−500', b.tenants[0].openingDebt, -500); }

    // Row 3 — prior debt 900 + charge 200 = 1100 post-close, paid 1000 → 100 (debt 100, no credit)
    { const b = mk(1100, 200); const r = apply(b, 1000);
      t.eq('row3 openingDebt 1100→100 (debt remains)', b.tenants[0].openingDebt, 100); }

    // Row 4 — no prior debt, charge 200 (=200 post-close), paid exactly 200 → 0
    { const b = mk(200, 200); apply(b, 200);
      t.eq('row4 exact payment → openingDebt 0', b.tenants[0].openingDebt, 0); }

    // Row 5 — prior debt 500 + charge 200 = 700 post-close, paid only 200 → 500 remains
    { const b = mk(700, 200); apply(b, 200);
      t.eq('row5 partial → openingDebt 500 remains', b.tenants[0].openingDebt, 500); }

    // Row 7 — idempotency with credit: approve 1000 (→−800), re-approve → STILL −800 (not −1800)
    { const b = mk(200, 200);
      apply(b, 1000);
      t.eq('row7 first approval → −800', b.tenants[0].openingDebt, -800);
      const r2 = apply(b, 1000);
      t.eq('row7 re-approval applied=false', r2.result && r2.result.applied, false);
      t.eq('row7 credit NOT doubled (still −800)', b.tenants[0].openingDebt, -800); }

    // receipt records the FULL reversed amount (needed so a guard reads the right figure)
    { const b = mk(200, 200); apply(b, 1000);
      const rec = b.paymentHistory.R.find(x => x.month === '2026-08');
      t.eq('receipt reversedAmount = full paid (1000)', rec && rec.debtOffset && rec.debtOffset.reversedAmount, 1000); }

    // v2.14.39b — אוסנת case: member with monthly dues = 0 pays 100 → full 100 becomes
    // credit. The old `charge>0` guard wrongly blocked this (400 "דמי החודש אינם חיוביים").
    { const b = mk(0, 0); // openingDebt 0, charge 0
      const r = apply(b, 100);
      t.eq('dues=0 member: applied=true (not blocked)', r.result && r.result.applied, true);
      t.eq('dues=0 member: 100 → credit (openingDebt −100)', b.tenants[0].openingDebt, -100); }

    // guard still rejects a non-positive PAID amount
    { const b = mk(200, 200);
      const r = apply(b, 0);
      t.eq('paid=0 → rejected 400', r.status, 400); }
  }

  t.section('v2.14.39 — closed-month reverse-accrual (extra account)');
  {
    const { loadApplyClosedMonth } = require('./test-lib');
    const b = {
      config: { amount: 230 },
      closedMonths: [],
      closedMonthsExtra: ['2026-07'],
      tenants: [{ id: 'R', name: 'רנדי', extraAccounts: [{ id: 'A1', label: 'ביטוח', amount: 50, openingDebt: 50 }] }],
      paymentHistory: {},
      extraPaymentHistory: { 'R__acc__A1': [] },
      sentLog: {}
    };
    const r = loadApplyClosedMonth(b, { tenantId: 'R', month: '2026-07', scope: 'extra', accountId: 'A1' });
    t.eq('extra applied=true', r.result && r.result.applied, true);
    t.eq('extra acc.openingDebt 50→0', b.tenants[0].extraAccounts[0].openingDebt, 0);
    const rec = (b.extraPaymentHistory['R__acc__A1'] || []).find(x => x.month === '2026-07');
    t.eq('extra record has receipt', !!(rec && rec.debtOffset && rec.debtOffset.reversedFrom === '2026-07'), true);
    t.eq('extra sentLog key set', !!(String(b.sentLog['R__acc__A1_יולי'] || '').startsWith('manual_paid')), true);
    // idempotency on extra too
    const r2 = loadApplyClosedMonth(b, { tenantId: 'R', month: '2026-07', scope: 'extra', accountId: 'A1' });
    t.eq('extra second approval no-op', r2.result && r2.result.applied, false);
    t.eq('extra openingDebt still 0', b.tenants[0].extraAccounts[0].openingDebt, 0);
  }

  t.section('v2.14.39 — agent import queues closed-month hits, never reverse-accrues');
  {
    const { loadBankAnalyzer } = require('./test-lib');
    const B2 = loadBankAnalyzer();
    const dft = {};
    // July closed; a 230 payment dated in July arrives via the agent analyzer.
    const rows = [['שם','סכום','תאריך','הערה'], ['סיגולים מירי','230','15/07/2026','']];
    const mapping = { colName: 0, colAmount: 1, colDate: 2, colNote: 3 };
    const tenants = [{ id: 'R', name: 'מירי', phone: '0527247713', keywords: 'סיגולים, מירי', aptNumber: '3', customAmount: null }];
    const r = B2.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-07', { amount: 230 }, new Set(), {}, dft, ['2026-07'], []);
    t.eq('agent surfaces closedMonthHits', !!(Array.isArray(r.closedMonthHits) && r.closedMonthHits.length === 1), true);
    t.eq('hit month is July', r.closedMonthHits[0] && r.closedMonthHits[0].month, '2026-07');
    t.eq('hit scope main', r.closedMonthHits[0] && r.closedMonthHits[0].scope, 'main');
    t.eq('hit carries bucket-sum amount (230)', r.closedMonthHits[0] && r.closedMonthHits[0].amount, 230);
  }
}

// ── v2.14.41 (A): agent NEVER guesses ambiguous rows — queues them ──────────
{
  t.section('v2.14.41 — agent ambiguous-match (never guesses, queues instead)');
  const { loadBankAnalyzer } = require("./test-lib");
  const B = loadBankAnalyzer();
  const mapping = { colName: 0, colAmount: 1, colDate: 2, colNote: 3, colRef: -1 };

  // Two כהן, no distinguisher; a bare "כהן" row → ambiguous, must NOT be written.
  {
    const rows = [
      ['שם', 'סכום', 'תאריך', 'הערות'],
      ['כהן', '300', '10/08/2026', 'ערבות הדדית'],
    ];
    const tenants = [
      { id: 'A', name: 'כהן לוי', phone: '0500000001', keywords: 'כהן', customAmount: 300, openingDebt: 0 },
      { id: 'B', name: 'כהן כהן', phone: '0500000002', keywords: 'כהן', customAmount: 300, openingDebt: 0 },
    ];
    const r = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-08', { amount: 300 }, new Set());
    t.eq('ambiguous row NOT written to sentLog (A)', r.newSentLog['A_אוגוסט'] == null, true);
    t.eq('ambiguous row NOT written to sentLog (B)', r.newSentLog['B_אוגוסט'] == null, true);
    t.eq('agent surfaces ambiguousMatchHits', Array.isArray(r.ambiguousMatchHits) && r.ambiguousMatchHits.length === 1, true);
    t.eq('hit lists both candidates', r.ambiguousMatchHits[0].candidates.length, 2);
    t.eq('no fingerprint consumed for ambiguous row', r.newFingerprints.length, 0);
  }

  // Clear full-name win → NOT ambiguous, written normally.
  {
    const rows = [
      ['שם', 'סכום', 'תאריך', 'הערות'],
      ['נועה ברקן', '230', '10/08/2026', 'ערבות הדדית'],
    ];
    const tenants = [
      { id: 'N', name: 'נועה ברקן', phone: '0500000003', keywords: 'נועה,ברקן', customAmount: 230, openingDebt: 0 },
      { id: 'O', name: 'עומר ברקן', phone: '0500000004', keywords: 'עומר,ברקן', customAmount: 230, openingDebt: 0 },
    ];
    const r = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-08', { amount: 230 }, new Set());
    t.eq('clear winner written (נועה)', String(r.newSentLog['N_אוגוסט'] || '').startsWith('bank_import'), true);
    t.eq('other candidate NOT written (עומר)', r.newSentLog['O_אוגוסט'] == null, true);
    t.eq('no ambiguous hit for clear full-name', (r.ambiguousMatchHits || []).length, 0);
  }

  // Two identical "כהן 150" rows → BOTH queued as separate ambiguous hits (no swallow).
  {
    const rows = [
      ['שם', 'סכום', 'תאריך', 'הערות'],
      ['כהן', '150', '10/08/2026', 'זיכוי'],
      ['כהן', '150', '09/08/2026', 'זיכוי'],
    ];
    const tenants = [
      { id: 'A', name: 'כהן לוי', phone: '0500000001', keywords: 'כהן', customAmount: 150, openingDebt: 0 },
      { id: 'B', name: 'כהן כהן', phone: '0500000002', keywords: 'כהן', customAmount: 150, openingDebt: 0 },
    ];
    const r = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-08', { amount: 150 }, new Set());
    t.eq('two identical ambiguous rows both queued (no swallow)', (r.ambiguousMatchHits || []).length, 2);
    t.eq('neither written', r.newSentLog['A_אוגוסט'] == null && r.newSentLog['B_אוגוסט'] == null, true);
  }

  // apt-note resolves ambiguity → auto-assigned, NOT queued.
  {
    const rows = [
      ['שם', 'סכום', 'תאריך', 'הערות'],
      ['כהן', '400', '10/08/2026', 'ועד בית דירה 6'],
    ];
    const tenants = [
      { id: 'A', name: 'כהן לוי', phone: '0500000001', keywords: 'כהן', aptNumber: '5', customAmount: 400, openingDebt: 0 },
      { id: 'B', name: 'כהן כהן', phone: '0500000002', keywords: 'כהן', aptNumber: '6', customAmount: 400, openingDebt: 0 },
    ];
    const r = B.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-08', { amount: 400 }, new Set());
    t.eq('apt-note resolves → written to the apt-6 owner (B)', String(r.newSentLog['B_אוגוסט'] || '').startsWith('bank_import'), true);
    t.eq('apt-note resolves → NOT queued as ambiguous', (r.ambiguousMatchHits || []).length, 0);
  }
}
// ── v2.14.42: /api/apply-ambiguous-match — resolve agent-queued rows ──────────
{
  t.section('v2.14.42 — apply-ambiguous-match (accumulate, overlap guard, drop)');
  const { loadApplyAmbiguous } = require('./test-lib');
  const rowKeyOf = h => [h.rowIdx, h.amount, h.date||'', h.payerName||'', h.scope||'main'].join('|');

  const mkBuilding = () => ({
    config: { amount: 300 },
    closedMonths: [], closedMonthsExtra: [],
    defaultTariffs: {},
    tenants: [
      { id: 'A', name: 'כהן א', customAmount: 300, openingDebt: 0 },
      { id: 'B', name: 'כהן ב', customAmount: 300, openingDebt: 0 }
    ],
    paymentHistory: {}, sentLog: {},
    importedBankFingerprints: [],
    pendingAmbiguousMatches: [
      { rowIdx: 2, amount: 300, date: '10/08/2026', payerName: 'כהן', rawText: 'כהן', scope: 'main',
        candidates: [{ id: 'A', name: 'כהן א' }, { id: 'B', name: 'כהן ב' }] }
    ]
  });

  // 1) assign → payment written to chosen tenant, row dropped, fingerprint added
  {
    const b = mkBuilding();
    const rk = rowKeyOf(b.pendingAmbiguousMatches[0]);
    const r = loadApplyAmbiguous(b, { rowKey: rk, tenantId: 'A', decision: 'assign' });
    t.eq('applied=true', r.result && r.result.applied, true);
    t.eq('written to A (300)', /bank_import_[^_]+_300_/.test(String(b.sentLog['A_אוגוסט']||'')), true);
    t.eq('row dropped from queue', b.pendingAmbiguousMatches.length, 0);
    t.eq('fingerprint persisted', b.importedBankFingerprints.length, 1);
    t.eq('B untouched', b.sentLog['B_אוגוסט'] == null, true);
  }

  // 2) ACCUMULATE onto an existing amount (A already paid 230)
  {
    const b = mkBuilding();
    b.sentLog['A_אוגוסט'] = 'bank_import_ISO_230_payer_x';
    const rk = rowKeyOf(b.pendingAmbiguousMatches[0]);
    loadApplyAmbiguous(b, { rowKey: rk, tenantId: 'A', decision: 'assign' });
    t.eq('accumulates 230+300=530', /bank_import_[^_]+_530_/.test(String(b.sentLog['A_אוגוסט']||'')), true);
  }

  // 3) OVERLAP GUARD — fingerprint already present (manual import wrote it) → no write, just drop
  {
    const b = mkBuilding();
    const row = b.pendingAmbiguousMatches[0];
    // precompute the 3-part fingerprint the endpoint checks
    const dd = String(row.date).trim().toLowerCase().replace(/\s+/g,' ');
    const aa = String(Math.round((row.amount)*100)/100);
    const nn = String(row.rawText).trim().toLowerCase().replace(/\s+/g,' ');
    b.importedBankFingerprints = [dd+'|'+aa+'|'+nn];
    const rk = rowKeyOf(row);
    const r = loadApplyAmbiguous(b, { rowKey: rk, tenantId: 'A', decision: 'assign' });
    t.eq('overlap → applied=false', r.result.applied, false);
    t.eq('overlap → alreadyWritten flagged', r.result.alreadyWritten, true);
    t.eq('overlap → NOT written again', b.sentLog['A_אוגוסט'] == null, true);
    t.eq('overlap → still dropped from queue', b.pendingAmbiguousMatches.length, 0);
  }

  // 4) ignore → nothing written, row dropped
  {
    const b = mkBuilding();
    const rk = rowKeyOf(b.pendingAmbiguousMatches[0]);
    const r = loadApplyAmbiguous(b, { rowKey: rk, decision: 'ignore' });
    t.eq('ignore → applied=false', r.result.applied, false);
    t.eq('ignore → nothing written', Object.keys(b.sentLog).length, 0);
    t.eq('ignore → row dropped', b.pendingAmbiguousMatches.length, 0);
  }

  // 5) unknown rowKey → no-op notFound (idempotent double-click safety)
  {
    const b = mkBuilding();
    const r = loadApplyAmbiguous(b, { rowKey: 'nonexistent|1|x|y|main', tenantId: 'A', decision: 'assign' });
    t.eq('unknown key → notFound', r.result.notFound, true);
    t.eq('unknown key → queue intact', b.pendingAmbiguousMatches.length, 1);
  }
}

// ── evaluateDeliverySuspect — WA delivery self-heal detection (v2.14.47) ──
// PURE decision fn: "≥ minFails sends stale-undelivered AND nothing delivered
// since the oldest of them" ⇒ session likely corrupt. A few offline recipients
// among successful sends must NOT trip it.
{
  const { loadDeliverySuspect } = require('./test-lib');
  const { evaluateDeliverySuspect } = loadDeliverySuspect();
  t.section('evaluateDeliverySuspect — delivery-failure detection');
  const NOW = 1000000;
  const G = 240000, MAX = 1800000, MIN = 3;   // mirror live WA_DELIVERY_* constants
  const stale = { ts: NOW - 300000 };          // 5 min old: past grace, within window
  const fresh = { ts: NOW - 60000 };           // 1 min old: still inside grace
  const aged  = { ts: NOW - 2000000 };         // >30 min: aged out, ignored
  const ev = (undelivered, lastDeliveredAt) => evaluateDeliverySuspect({
    now: NOW, undelivered, lastDeliveredAt: lastDeliveredAt || 0,
    graceMs: G, minFails: MIN, maxAgeMs: MAX
  });

  t.eq('empty → not suspect', ev([]).suspect, false);
  t.eq('3 stale, never delivered → suspect', ev([stale,stale,stale], 0).suspect, true);
  t.eq('3 stale → staleFails counted', ev([stale,stale,stale], 0).staleFails, 3);
  t.eq('2 stale → below min → not suspect', ev([stale,stale], 0).suspect, false);
  t.eq('3 fresh (within grace) → not suspect yet', ev([fresh,fresh,fresh], 0).suspect, false);
  t.eq('3 aged-out (past max) → ignored → not suspect', ev([aged,aged,aged], 0).suspect, false);
  // a delivery AFTER the stale sends ⇒ session alive ⇒ not suspect
  t.eq('3 stale but delivered since → not suspect', ev([stale,stale,stale], NOW - 100000).suspect, false);
  // a delivery BEFORE the stale sends ⇒ nothing acked since ⇒ suspect
  t.eq('3 stale, last delivery predates them → suspect', ev([stale,stale,stale], NOW - 500000).suspect, true);
  // fresh ones don't count toward the threshold
  t.eq('2 stale + 2 fresh → still below min → not suspect', ev([stale,stale,fresh,fresh], 0).suspect, false);
}

// ════════════════════════════════════════════════════════════════
// v2.14.53 — UNDO LAST BANK IMPORT (real buildImportUndo / planImportUndo / route)
// ════════════════════════════════════════════════════════════════
{
  const { loadImportUndo, loadUndoRoute } = require('./test-lib');
  const U = loadImportUndo();
  const J = v => JSON.parse(JSON.stringify(v));
  // Building BEFORE the import: A paid June earlier (manual); B, C nothing yet.
  const base = () => ({
    config: { amount: 200 },
    defaultTariffs: [{ rate: 200, startDate: '2000-01-01', endDate: null }],
    tenants: [
      { id: 'A', name: 'אלף', customAmount: 200, openingDebt: 0 },
      { id: 'B', name: 'בית', customAmount: 200, openingDebt: 1000 },
      { id: 'C', name: 'גימל', customAmount: 200, openingDebt: 0,
        extraAccounts: [{ id: 'x1', label: 'ביטוח', amount: 40, openingDebt: 0 }] }
    ],
    sentLog: { 'A_יוני': 'manual_paid_2026-06-02_amount_200', 'B_ספטמבר': 'wa_sent_2026-09-01' },
    paymentHistory: { 'A': [{ month: '2026-06', paid: true, amount: 200, paidAmount: 200, date: '2026-06-02', type: 'manual', name: 'אלף', payerName: '' }] },
    importedBankFingerprints: ['old1', 'old2'],
    lastBankSyncImport: { timestamp: 'prev', month: 'אוגוסט' },
    closedMonths: ['2026-08'], closedMonthsExtra: ['2026-08']
  });
  // The import: B pays 700 for September (overwrites B's wa_sent), C pays 200 +
  // extra account 40, A's June record is merely RE-DATED by the sync (no money change),
  // 2 new fingerprints, a queued ambiguous row, and a new receipt.
  const importPatch = (prev) => {
    const ph = J(prev.paymentHistory);
    ph.A[0].date = '2026-09-25';                                        // re-date only
    ph.B = [{ month: '2026-09', paid: true, amount: 200, paidAmount: 700, date: '2026-09-25', type: 'bank', name: 'בית', payerName: 'בית' }];
    ph.C = [{ month: '2026-09', paid: true, amount: 200, paidAmount: 200, date: '2026-09-25', type: 'bank', name: 'גימל', payerName: 'גימל' }];
    ph['C__acc__x1'] = [{ month: '2026-09', paid: true, amount: 40, paidAmount: 40, date: '2026-09-25', type: 'bank' }];
    return {
      sentLog: Object.assign(J(prev.sentLog), {
        'B_ספטמבר': 'bank_import_2026-09-25T10:00_700_payer_בית',
        'C_ספטמבר': 'bank_import_2026-09-25T10:00_200_payer_גימל',
        'C__acc__x1_ספטמבר': 'bank_import_2026-09-25T10:00_40_payer_גימל'
      }),
      paymentHistory: ph,
      importedBankFingerprints: prev.importedBankFingerprints.concat(['new1', 'new2']),
      pendingAmbiguousMatches: [{ rowIdx: 7, amount: 300 }],
      lastBankSyncImport: { timestamp: 'now', month: 'ספטמבר' }
    };
  };
  const imported = () => {           // prev + import applied + undo record stored
    const b = base(); const prev = J(b); const patch = importPatch(prev);
    const rec = U.buildImportUndo(prev, patch, { source: 'agent', month: '2026-09' });
    Object.assign(b, patch, { lastImportUndo: rec });
    return { b, rec, prev };
  };

  t.section('Undo import — buildImportUndo records exactly what the import changed');
  {
    const { rec } = imported();
    t.eq('record built', !!rec, true);
    t.eq('source/month kept', rec.source + '|' + rec.month, 'agent|2026-09');
    t.eq('sentLog keys touched = 3 (B, C, C__acc__)', Object.keys(rec.sentLogAfter).sort().join(','), ['B_ספטמבר', 'C_ספטמבר', 'C__acc__x1_ספטמבר'].sort().join(','));
    t.eq('overwritten key remembers its previous value', rec.sentLogBefore['B_ספטמבר'], 'wa_sent_2026-09-01');
    t.eq('new key remembers it was absent (null)', rec.sentLogBefore['C_ספטמבר'], null);
    t.eq('extra-account key recorded (main == extra)', rec.sentLogBefore['C__acc__x1_ספטמבר'], null);
    t.eq('paymentHistory: re-date-only tenant A NOT recorded', Object.prototype.hasOwnProperty.call(rec.phAfter, 'A'), false);
    t.eq('paymentHistory: B, C, C__acc__x1 recorded', Object.keys(rec.phAfter).sort().join(','), ['B', 'C', 'C__acc__x1'].sort().join(','));
    t.eq('fingerprints added', rec.fingerprintsAdded.join(','), 'new1,new2');
    t.eq('queue before/after captured', rec.queues.pendingAmbiguousMatches.before === null && rec.queues.pendingAmbiguousMatches.after.length === 1, true);
    t.eq('previous receipt kept', rec.lastBankSyncImportBefore.timestamp, 'prev');
    t.eq('closed months at import time', rec.closedMonthsAt.join(','), '2026-08');
    t.eq('touched tenants = B, C (A excluded)', rec.tenantIds.slice().sort().join(','), 'B,C');
  }

  t.section('Undo import — idle run (nothing changed) produces NO record');
  {
    const prev = base();
    const idle = { sentLog: J(prev.sentLog), paymentHistory: J(prev.paymentHistory), importedBankFingerprints: prev.importedBankFingerprints.slice(), lastBankSyncImport: { timestamp: 'idle' } };
    idle.paymentHistory.A[0].date = '2026-09-25';   // even a re-date is not a change
    t.eq('buildImportUndo → null', U.buildImportUndo(prev, idle, { source: 'agent' }), null);
  }

  t.section('Undo import — plan restores the pre-import state exactly');
  {
    const { b, prev } = imported();
    const plan = U.planImportUndo(b);
    t.eq('plan ok', plan.ok, true);
    const after = Object.assign(J(b), plan.patch);
    t.eq('sentLog back to pre-import', JSON.stringify(after.sentLog), JSON.stringify(prev.sentLog));
    t.eq('B paymentHistory removed', after.paymentHistory.B, undefined);
    t.eq('C__acc__x1 paymentHistory removed', after.paymentHistory['C__acc__x1'], undefined);
    t.eq('A paymentHistory money unchanged', JSON.stringify(U.phMoneyView(after.paymentHistory.A)), JSON.stringify(U.phMoneyView(prev.paymentHistory.A)));
    t.eq('fingerprints back to pre-import', after.importedBankFingerprints.join(','), 'old1,old2');
    t.eq('queue restored (was absent → [])', after.pendingAmbiguousMatches.length, 0);
    t.eq('previous receipt restored', after.lastBankSyncImport.timestamp, 'prev');
    t.eq('undo record consumed (one level only)', after.lastImportUndo, null);
    t.eq('openingDebt never in the patch', plan.patch.tenants, undefined);
    t.eq('summary: 2 tenants', plan.summary.tenants, 2);
    t.eq('summary names', plan.summary.names.slice().sort().join(','), ['בית', 'גימל'].sort().join(','));
    t.eq('second undo → none', U.planImportUndo(after).reason, 'none');
  }

  t.section('Undo import — money view: debt returns to the pre-import figure');
  {
    const { b, prev } = imported();
    const debtBefore = S.calcTotalDebt(prev, 'B', '2026-09');
    const debtImported = S.calcTotalDebt(b, 'B', '2026-09');
    const after = Object.assign(J(b), U.planImportUndo(b).patch);
    t.eq('import changed B\'s debt', debtImported !== debtBefore, true);
    t.eq('after undo B\'s debt == pre-import', S.calcTotalDebt(after, 'B', '2026-09'), debtBefore);
    t.eq('after undo B has no credit from the undone payment', S.getCreditBalance(after, 'B'), S.getCreditBalance(prev, 'B'));
  }

  t.section('Undo import — BLOCKED when a month was closed after the import (2A)');
  {
    const { b } = imported();
    b.closedMonths = ['2026-08', '2026-09'];
    const plan = U.planImportUndo(b);
    t.eq('blocked: closed', plan.ok === false && plan.reason === 'closed', true);
    t.eq('names the closed month', plan.months.join(','), '2026-09');
    const b2 = imported().b; b2.closedMonthsExtra = ['2026-08', '2026-09'];
    t.eq('extra-account close also blocks (main == extra)', U.planImportUndo(b2).reason, 'closed');
  }

  t.section('Undo import — BLOCKED when something the import wrote was changed (conflict A)');
  {
    const { b } = imported();
    delete b.sentLog['C_ספטמבר'];                    // operator pressed "בטל" for גימל
    const plan = U.planImportUndo(b);
    t.eq('blocked: changed', plan.ok === false && plan.reason === 'changed', true);
    t.eq('names the changed tenant', plan.names.join(','), 'גימל');
    const b2 = imported().b;
    b2.paymentHistory['C__acc__x1'][0].paidAmount = 10; // extra-account history changed
    t.eq('extra-account change blocks + names the tenant', U.planImportUndo(b2).names.join(','), 'גימל');
    const b3 = imported().b;
    b3.pendingAmbiguousMatches = [];                  // queued row resolved afterwards
    const p3 = U.planImportUndo(b3);
    t.eq('queue resolved afterwards blocks', p3.reason === 'changed' && p3.queueConflict === true, true);
  }

  t.section('Undo import — later re-date or unrelated tenant change does NOT block');
  {
    const { b } = imported();
    b.paymentHistory.B[0].date = '2026-09-30';        // recordPayment re-ran on another day
    b.sentLog['A_ספטמבר'] = 'manual_paid_2026-09-26_amount_200'; // unrelated tenant marked
    b.paymentHistory.A.push({ month: '2026-09', paid: true, amount: 200, paidAmount: 200, date: '2026-09-26', type: 'manual' });
    const plan = U.planImportUndo(b);
    t.eq('still undoable', plan.ok, true);
    const after = Object.assign(J(b), plan.patch);
    t.eq('unrelated manual mark survives the undo', after.sentLog['A_ספטמבר'], 'manual_paid_2026-09-26_amount_200');
    t.eq('B import removed', after.sentLog['B_ספטמבר'], 'wa_sent_2026-09-01');
  }

  t.section('Undo import — fingerprints dropped by the 5000 cap come back');
  {
    const prev = base();
    const patch = { sentLog: Object.assign(J(prev.sentLog), { 'C_ספטמבר': 'bank_import_x_200_payer_ג' }), importedBankFingerprints: ['old2', 'new1'] };
    const b = Object.assign(J(prev), patch, { lastImportUndo: U.buildImportUndo(prev, patch, { source: 'manual' }) });
    const after = Object.assign(J(b), U.planImportUndo(b).patch);
    t.eq('dropped + kept, new removed', after.importedBankFingerprints.slice().sort().join(','), 'old1,old2');
    t.eq('manual record has no receipt key → receipt untouched', Object.prototype.hasOwnProperty.call(U.planImportUndo(b).patch, 'lastBankSyncImport'), false);
  }

  t.section('Undo import — route: dryRun previews, real run backs up then writes');
  {
    const { b } = imported();
    const r = loadUndoRoute(b, { dryRun: true });
    t.eq('dryRun ok', r.result.ok === true && r.result.dryRun === true, true);
    t.eq('dryRun wrote nothing', r.saved.length + r.backupCalled, 0);
    const r2 = loadUndoRoute(b, { dryRun: false });
    t.eq('real run: backup taken', r2.backupCalled, 1);
    t.eq('real run: one write', r2.saved.length, 1);
    t.eq('real run: record consumed', b.lastImportUndo, null);
    const r3 = loadUndoRoute(b, { dryRun: false });
    t.eq('second run: blocked none, nothing written', r3.result.blocked === true && r3.result.reason === 'none' && r3.saved.length === 0 && r3.backupCalled === 0, true);
    const { b: bc } = imported(); bc.closedMonths.push('2026-09');
    const r4 = loadUndoRoute(bc, { dryRun: false });
    t.eq('closed: blocked, no backup, no write', r4.result.reason === 'closed' && r4.saved.length === 0 && r4.backupCalled === 0, true);
  }

  t.section('Undo import — both resets forget the undo record');
  {
    const { loadResetPayments, loadResetBuildingFull } = require('./test-lib');
    const { b } = imported();
    const r = loadResetPayments(b, { dryRun: false });
    t.eq('client 🧹 clears lastImportUndo', r.saved[0].patch.lastImportUndo, null);
    const { b: b2 } = imported();
    const r2 = loadResetBuildingFull(b2, { tenantId: 'T1', dryRun: false });
    t.eq('admin 🧨 clears lastImportUndo', r2.saved[0].patch.lastImportUndo, null);
  }
}


// ════════════════════════════════════════════════════════════════
// v2.14.54 — reminder figures (design A): {סכום} = still owed THIS month,
// {חוב_קודם} = carried-over only, {סה"כ} = sum. Bug (Tal, תמי דירה 9): debt
// 230 + paid September 230 → reminder read 230 + 230 = 460. Partial payers were
// double-counted (shortfall inside calcTotalDebt AND the full tariff on top).
// ════════════════════════════════════════════════════════════════
{
  const SEP = 'ספטמבר';
  const bld = (sl, od, extra) => Object.assign({
    config: { amount: 230, manualMonth: SEP },
    tenants: [{ id: 9, name: 'תמי', openingDebt: od }],
    sentLog: sl, paymentHistory: {}
  }, extra || {});
  const mkS = S.getMonthKey({ manualMonth: SEP });
  const F = d => S.buildReminderFigures(d, d.tenants[0], mkS, SEP, 230);
  const fig = f => [f.monthDue, f.priorDebt, f.total].join('/');

  t.section('v2.14.54 — buildReminderFigures: the 4 reported cases');
  t.eq('THE BUG (תמי): prior 230, paid Sept in full → 0 / 230 / 230',
    fig(F(bld({ '9_ספטמבר': bank(230) }, 230))), '0/230/230');
  t.eq('partial, no prior debt: paid 100 of 230 → 130 / 0 / 130 (was 360)',
    fig(F(bld({ '9_ספטמבר': bank(100) }, 0))), '130/0/130');
  t.eq('partial + prior 230: paid 100 → 130 / 230 / 360 (was 590)',
    fig(F(bld({ '9_ספטמבר': bank(100) }, 230))), '130/230/360');
  t.eq('unpaid + prior 230 → 230 / 230 / 460 (unchanged)',
    fig(F(bld({}, 230))), '230/230/460');

  t.section('v2.14.54 — buildReminderFigures: edges');
  t.eq('reminded-only (sent_) counts as unpaid → full tariff',
    fig(F(bld({ '9_ספטמבר': 'sent_' + TS }, 0))), '230/0/230');
  t.eq('manual_paid full, no debt → 0 / 0 / 0',
    fig(F(bld({ '9_ספטמבר': manual(230) }, 0))), '0/0/0');
  t.eq('overpaid (300 on 230) with prior 230 → 0 / 160 / 160 (surplus nets prior)',
    fig(F(bld({ '9_ספטמבר': bank(300) }, 230))), '0/160/160');
  t.eq('legacy payment value (no amount) → treated as paid → 0 due',
    fig(F(bld({ '9_ספטמבר': 'bank_import_' + TS }, 230))), '0/230/230');
  {
    const d = bld({}, 0); d.tenants[0].suspended = true;
    t.eq('suspended main, unpaid → exempt, 0 due', fig(F(d)), '0/0/0');
    const d2 = bld({}, 120); d2.tenants[0].suspended = true;
    t.eq('suspended with prior 120 → 0 / 120 / 120', fig(F(d2)), '0/120/120');
  }
  {
    // current month already carries an UNPAID history row (e.g. a closed
    // month re-opened): calcTotalDebt counts it — priorDebt must not.
    const d = bld({}, 0, { paymentHistory: { '9': [{ month: mkS, paid: false, amount: 230, type: 'bank' }] } });
    t.eq('unpaid current-month history row → 230 / 0 / 230 (no double count)', fig(F(d)), '230/0/230');
  }
  t.eq('monthDue uses the CALLER-resolved tariff when unpaid',
    S.buildReminderFigures(bld({}, 0), bld({}, 0).tenants[0], mkS, SEP, 250).monthDue, 250);
  t.eq('status surfaced for the caller', F(bld({ '9_ספטמבר': bank(100) }, 0)).status, 'partial');

  t.section('v2.14.54 — splitCurrentMonthDebt: /api/data shape, map optional');
  {
    const d = bld({ '9_ספטמבר': bank(100) }, 230);
    const a = S.splitCurrentMonthDebt(d, d.tenants[0], mkS, SEP);
    const mb = { [SEP]: S.calcMonthBalance(bank(100), 230) };
    const b = S.splitCurrentMonthDebt(d, d.tenants[0], mkS, SEP, mb);
    t.eq('totalDebt == calcTotalDebt', a.totalDebt, S.calcTotalDebt(d, '9', mkS));
    t.eq('priorDebt excludes current shortfall', a.priorDebt, 230);
    t.eq('with / without monthBalances map → identical', JSON.stringify(a), JSON.stringify(b));
    t.eq('reads only — data untouched', JSON.stringify(d), JSON.stringify(bld({ '9_ספטמבר': bank(100) }, 230)));
  }
  t.section('v2.14.54 — rendered reminder (real placeholder helpers)');
  {
    const f = F(bld({ '9_ספטמבר': bank(230) }, 230));
    const msg = 'ועד בית: *{סכום} ₪*\n{שורת_חוב_קודם}\nסה"כ: {סה"כ}'
      .replace(/{סכום}/g, f.monthDue)
      .replace(/{שורת_חוב_קודם}/g, S.buildPriorDebtLine(f.priorDebt))
      .replace(/{סה"כ}/g, f.total);
    t.eq('תמי message', msg, 'ועד בית: *0 ₪*\nחוב קודם: *230 ₪*\nסה"כ: 230');
  }
}


// ════════════════════════════════════════════════════════════════
// v2.14.55 — חייבים חריגים consume splitCurrentMonthDebt; suspended tenant's
// ACTIVE month is exempt in the list AND in the itemised detail (design 3A).
// Bug: a suspended tenant with no debt was listed with owed = full tariff.
// ════════════════════════════════════════════════════════════════
{
  const SEP = 'ספטמבר';
  const mkS = S.getMonthKey({ manualMonth: SEP });
  const B = (tenants, sl, ph) => ({ config: { amount: 230, manualMonth: SEP, excessDebtThreshold: 100 },
    tenants, sentLog: sl || {}, paymentHistory: ph || {} });
  const row = (d, id) => S.buildExcessDebtRows(d).rows.find(r => r.id === String(id));

  t.section('v2.14.55 — excess-debt list: suspended active month is exempt');
  t.eq('THE BUG: suspended, no debt → NOT listed (was owed 230)',
    row(B([{ id: 1, name: 'A', openingDebt: 0, suspended: true }]), 1), undefined);
  {
    const r = row(B([{ id: 1, name: 'A', openingDebt: 300, suspended: true }]), 1);
    t.eq('suspended + prior 300 → owed 300 (was 530)', r && r.owed, 300);
    t.eq('suspended + prior 300 → current 0 / prior 300', r && (r.currentMonthDebt + '/' + r.priorDebt), '0/300');
  }
  t.eq('suspended, reminded (sent_) → still exempt, not listed',
    row(B([{ id: 1, name: 'A', openingDebt: 0, suspended: true }], { '1_ספטמבר': 'sent_' + TS }), 1), undefined);
  t.eq('suspended, paid during suspension → not listed',
    row(B([{ id: 1, name: 'A', openingDebt: 0, suspended: true }], { '1_ספטמבר': bank(230) }), 1), undefined);
  {
    const r = row(B([{ id: 1, name: 'A', openingDebt: 300 }]), 1);
    t.eq('ACTIVE tenant unchanged: unpaid + prior 300 → owed 530', r && r.owed, 530);
    t.eq('ACTIVE tenant unchanged: current 230 / prior 300', r && (r.currentMonthDebt + '/' + r.priorDebt), '230/300');
  }
  {
    const r = row(B([{ id: 1, name: 'A', openingDebt: 230 }], { '1_ספטמבר': bank(100) }), 1);
    t.eq('ACTIVE partial 100/230 + prior 230 → 130 / 230 / 360', r && [r.currentMonthDebt, r.priorDebt, r.owed].join('/'), '130/230/360');
  }

  t.section('v2.14.55 — buildDebtDetail: suspended active month not itemised');
  {
    const tn = { id: 1, name: 'A', openingDebt: 300, suspended: true };
    const det = S.buildDebtDetail(B([tn], { '1_ספטמבר': 'sent_' + TS }), tn, mkS);
    t.eq('no active-month line (sentLog path a)', det.months.length, 0);
    t.eq('openingDebt still itemised', det.openingDebt, 300);
    t.eq('monthsTotal = 300 (letter adds up to the row)', det.monthsTotal, 300);
    const det2 = S.buildDebtDetail(B([tn]), tn, mkS);
    t.eq('no active-month line (synthetic path c)', det2.months.length, 0);
  }
  {
    const tn = { id: 1, name: 'A', openingDebt: 0, suspended: true };
    const ph = { '1': [{ month: '2026-08', paid: false, amount: 230, type: 'bank' }] };
    const det = S.buildDebtDetail(B([tn], {}, ph), tn, mkS);
    t.eq('suspended: PRIOR unpaid month (אוגוסט) still itemised', det.months.map(m => m.monthKey).join(','), '2026-08');
  }
  {
    const tn = { id: 1, name: 'A', openingDebt: 0 };
    const det = S.buildDebtDetail(B([tn]), tn, mkS);
    t.eq('ACTIVE tenant: active month still itemised (unchanged)', det.months.map(m => m.hebMonth).join(','), SEP);
  }

  t.section('v2.14.55 — parity: list row == split + extras for every tenant');
  {
    const d = B([
      { id: 1, name: 'A', openingDebt: 300, suspended: true },
      { id: 2, name: 'B', openingDebt: 230 },
      { id: 3, name: 'C', openingDebt: 500 },
      { id: 4, name: 'D', openingDebt: 0 }
    ], { '2_ספטמבר': bank(100), '3_ספטמבר': bank(230), '4_ספטמבר': 'sent_' + TS });
    const rows = S.buildExcessDebtRows(d).rows;
    const ok = rows.every(r => {
      const tn = d.tenants.find(x => String(x.id) === r.id);
      const sp = S.splitCurrentMonthDebt(d, tn, mkS, SEP);
      const want = Math.round((sp.owedNow + r.extrasTotal) * 100) / 100;   // v2.14.57 — credit-aware
      return r.owed === want;
    });
    t.eq('every listed row matches splitCurrentMonthDebt', ok && rows.length === 4, true);
    t.eq('every row: detail total (months+openingDebt+extras) == owed',
      rows.every(r => Math.round((r.months.reduce((a, m) => a + m.shortfall, 0) + r.openingDebt + r.extrasTotal) * 100) / 100 === r.owed), true);
  }
}


// ════════════════════════════════════════════════════════════════
// v2.14.56 — portal runs the REAL route; consumes buildReminderFigures;
// suspended = exempt; tariff via resolveTariffRate; history reconciliation is
// display-only for real (copies) and stale "paid" → review (design B, Tal).
// ════════════════════════════════════════════════════════════════
{
  const { loadPortalRoute } = require('./test-lib');
  const SEP = 'ספטמבר';
  const mkS = S.getMonthKey({ manualMonth: SEP });
  const P = (tn, sl, ph, extra) => Object.assign({ config: { amount: 230, manualMonth: SEP },
    tenants: [Object.assign({ id: 9, name: 'תמי', openingDebt: 0 }, tn)], sentLog: sl || {}, paymentHistory: ph || {} }, extra || {});
  const run = d => loadPortalRoute(d, 9);
  const cur = d => run(d).current;

  t.section('v2.14.56 — portal: the verified divergences');
  {
    const c = cur(P({ openingDebt: 230 }, { '9_ספטמבר': bank(230) }));
    t.eq('תמי (paid + prior 230) → due 230 / monthDue 0 / prior 230', [c.amountDue, c.monthDue, c.priorDebt].join('/'), '230/0/230');
  }
  {
    const c = cur(P({ suspended: true }));
    t.eq('THE BUG: suspended, no debt → due 0 (was 230)', c.amountDue, 0);
    t.eq('suspended → status exempt', c.status, 'exempt');
    t.eq('suspended → balance.status exempt', c.balance.status, 'exempt');
    const c2 = cur(P({ suspended: true, openingDebt: 120 }));
    t.eq('suspended + prior 120 → due 120 (was 350)', c2.amountDue, 120);
    const c3 = cur(P({ suspended: true }, { '9_ספטמבר': bank(230) }));
    t.eq('paid during suspension → status paid, due 0', c3.status + '/' + c3.amountDue, 'paid/0');
  }
  {
    const d = P({}, { '9_ספטמבר': bank(230) }, { '9': [{ month: '2026-07', paid: true, amount: 230, type: 'bank' }] });
    const out = run(d);
    t.eq('THE BUG: stale paid:true (July, no sentLog) → prior 0 (was 230)', out.current.priorDebt, 0);
    const jul = out.history.find(r => r.monthKey === '2026-07');
    t.eq('…July shown as review, not paid', jul && (jul.review + '/' + jul.paid), 'true/false');
    t.eq('…stored record NOT mutated (display-only for real)', d.paymentHistory['9'][0].paid, true);
    t.eq('…portal prior == dashboard split prior',
      out.current.priorDebt, S.splitCurrentMonthDebt(d, d.tenants[0], mkS, SEP).priorDebt);
  }
  {
    const d = P({ customAmount: 230, personalTariffs: [{ rate: 250, startDate: '2026-01-01', endDate: null }] });
    const c = cur(d);
    t.eq('THE BUG: personal tariff 250 → due 250 (was 230)', c.amountDue, 250);
    t.eq('…current.amount = resolved tariff', c.amount, 250);
  }

  t.section('v2.14.56 — portal: unchanged behaviour & review scope');
  {
    const out = run(P({}, { '9_ספטמבר': bank(230) }, { '9': [{ month: '2026-07', paid: true, amount: 230, type: 'bank' }] },
      { sentLog: { '9_ספטמבר': bank(230), '9_יולי': bank(230) } }));
    const jul = out.history.find(r => r.monthKey === '2026-07');
    t.eq('July WITH sentLog payment → paid, no review', jul && (jul.paid + '/' + jul.review), 'true/false');
  }
  {
    const out = run(P({}, {}, { '9': [{ month: mkS, paid: true, amount: 230, type: 'bank' }] }));
    const cm = out.history.find(r => r.monthKey === mkS);
    t.eq('current month paid:true but no sentLog → unpaid (not review), due 230',
      cm && (cm.paid + '/' + cm.review + '/' + out.current.amountDue), 'false/false/230');
  }
  {
    const c = cur(P({ openingDebt: -100 }));
    t.eq('credit 100 still netted in the portal → due 130', c.amountDue, 130);
    const c2 = cur(P({}, { '9_ספטמבר': bank(100) }));
    t.eq('partial 100/230 → monthDue 130 / due 130', c2.monthDue + '/' + c2.amountDue, '130/130');
  }
  {
    const d = P({ extraAccounts: [{ id: 'a1', label: 'חניה', amount: 50 }] }, {},
      { '9__acc__a1': [{ month: '2026-07', paid: false, amount: 50 }, { month: '2026-08', paid: true, amount: 50 }] });
    const before = JSON.stringify(d);
    run(d);
    t.eq('route leaves the whole building data untouched (main + __acc__)', JSON.stringify(d), before);
  }

  t.section('v2.14.56 — parity: portal due == WA total − credit, prior == dashboard');
  {
    const cases = [
      P({ openingDebt: 230 }, { '9_ספטמבר': bank(100) }),
      P({ openingDebt: 500 }, { '9_ספטמבר': 'sent_' + TS }),
      P({ suspended: true, openingDebt: 80 }),
      P({}, { '9_ספטמבר': manual(230) })
    ];
    const ok = cases.every(d => {
      const c = cur(d);
      const f = S.buildReminderFigures(d, d.tenants[0], mkS, SEP, 230);
      const cr = S.getCreditBalance(d, '9');
      return c.amountDue === Math.max(0, Math.round((f.total - cr) * 100) / 100)
        && c.priorDebt === S.splitCurrentMonthDebt(d, d.tenants[0], mkS, SEP).priorDebt;
    });
    t.eq('4 mixed cases agree with the shared helpers', ok, true);
  }
}


// ════════════════════════════════════════════════════════════════
// v2.14.57 — CREDIT NETTED IMMEDIATELY (design A, Tal 2026-09-27).
// Verified bug: credit 100 + unpaid → portal 130 but WA "סה"כ 230" and the
// dashboard card 230; credit 400 covering the month → WA "סה"כ 230"; credit 100
// + partial 100/230 → really 30, but portal/WA/dashboard all said 130 (the
// clamped priorDebt dropped the absorbed credit).
// ════════════════════════════════════════════════════════════════
const SEP57 = 'ספטמבר';
const mk57 = S.getMonthKey({ manualMonth: SEP57 });
const C57 = (od, sl, extra) => Object.assign({
  config: { amount: 230, manualMonth: SEP57, excessDebtThreshold: 10,
            template: 'ועד בית: {סכום} | {שורת_חוב_קודם} | {שורת_זכות} | זכות {יתרת_זכות} | סה"כ {סה"כ}' },
  tenants: [{ id: 9, name: 'X', phone: '1', openingDebt: od }], sentLog: sl || {}, paymentHistory: {}
}, extra || {});
const sp57 = d => S.splitCurrentMonthDebt(d, d.tenants[0], mk57, SEP57);
const k57 = o => [o.owedNow, o.owedCurrent, o.owedPrior, o.creditApplied, o.creditLeft].join('/');

t.section('v2.14.57 — splitCurrentMonthDebt: owedNow/owedCurrent/owedPrior/creditApplied/creditLeft');
t.eq('THE BUG: credit 100, unpaid → 130 (applied 100, left 0)', k57(sp57(C57(-100))), '130/130/0/100/0');
t.eq('THE BUG: credit 400 covers the month → 0 (applied 230, left 170)', k57(sp57(C57(-400))), '0/0/0/230/170');
t.eq('overpay 300/230 this month → 0, credit 70 LEFT (not applied)', k57(sp57(C57(0, { '9_ספטמבר': bank(300) }))), '0/0/0/0/70');
t.eq('THE BUG: credit 100 + partial 100/230 → 30 (was 130)', k57(sp57(C57(-100, { '9_ספטמבר': bank(100) }))), '30/30/0/100/0');
t.eq('credit exactly the fee (−230), unpaid → 0 / applied 230 / left 0', k57(sp57(C57(-230))), '0/0/0/230/0');
t.eq('no credit: Tami (prior 230, paid) → 230 / 0 / 230', k57(sp57(C57(230, { '9_ספטמבר': bank(230) }))), '230/0/230/0/0');
t.eq('no credit: unpaid + prior 230 → 460 / 230 / 230', k57(sp57(C57(230))), '460/230/230/0/0');
t.eq('no credit: partial 100 + prior 230 → 360 / 130 / 230', k57(sp57(C57(230, { '9_ספטמבר': bank(100) }))), '360/130/230/0/0');
{
  const d = C57(-100); d.tenants[0].suspended = true;
  t.eq('suspended + credit 100 → 0 due, credit 100 left', k57(sp57(d)), '0/0/0/0/100');
}
t.eq('owedNow == calcTotalDebt when the month is already inside it (partial, no credit)',
  sp57(C57(0, { '9_ספטמבר': bank(100) })).owedNow, S.calcTotalDebt(C57(0, { '9_ספטמבר': bank(100) }), '9', mk57));
t.eq('chargeOverride (resolved tariff 250) drives an unpaid month',
  S.splitCurrentMonthDebt(C57(-100), C57(-100).tenants[0], mk57, SEP57, undefined, 250).owedNow, 150);

t.section('v2.14.57 — buildReminderFigures.total is net of credit');
t.eq('credit 100, unpaid → total 130', S.buildReminderFigures(C57(-100), C57(-100).tenants[0], mk57, SEP57, 230).total, 130);
t.eq('credit 400 → total 0', S.buildReminderFigures(C57(-400), C57(-400).tenants[0], mk57, SEP57, 230).total, 0);

t.section('v2.14.57 — buildCreditLinesFig');
t.eq('applied only', S.buildCreditLinesFig({ creditApplied: 100, creditLeft: 0 }), 'קוזזה יתרת זכות: *100 ₪*');
t.eq('applied + left', S.buildCreditLinesFig({ creditApplied: 230, creditLeft: 170 }), 'קוזזה יתרת זכות: *230 ₪*\nיתרת זכות: *170 ₪*');
t.eq('left only', S.buildCreditLinesFig({ creditApplied: 0, creditLeft: 70 }), 'יתרת זכות: *70 ₪*');
t.eq('none → empty', S.buildCreditLinesFig({ creditApplied: 0, creditLeft: 0 }), '');

t.section('v2.14.57 — portal (REAL route) nets credit, ships the split');
{
  const { loadPortalRoute } = require('./test-lib');
  const pc = d => loadPortalRoute(d, 9).current;
  const f = c => [c.amountDue, c.creditApplied, c.creditLeft].join('/');
  t.eq('credit 100, unpaid → 130 / 100 / 0', f(pc(C57(-100))), '130/100/0');
  t.eq('credit 400 → 0 / 230 / 170', f(pc(C57(-400))), '0/230/170');
  t.eq('overpay 70 → 0 / 0 / 70', f(pc(C57(0, { '9_ספטמבר': bank(300) }))), '0/0/70');
  t.eq('THE BUG: credit 100 + partial 100 → 30 (was 130)', f(pc(C57(-100, { '9_ספטמבר': bank(100) }))), '30/100/0');
}

t.section('v2.14.57 — חייבים חריגים: row + letter net the credit');
{
  const d = C57(-100, { '9_ספטמבר': bank(100) });
  const r = S.buildExcessDebtRows(d).rows[0];
  t.eq('row owed 30 (current 30, prior 0, applied 100)', r && [r.owed, r.currentMonthDebt, r.priorDebt, r.creditApplied].join('/'), '30/30/0/100');
  const itemised = Math.round((r.months.reduce((a, m) => a + m.shortfall, 0) + r.openingDebt - r.creditApplied + r.extrasTotal) * 100) / 100;
  t.eq('itemised lines − credit == owed', itemised, r.owed);
  const letter = S.buildExcessDebtMessage(d, d.tenants[0], r, 'סה"כ {סה"כ_חוב}\n{פירוט_חוב}', null);
  t.eq('letter shows the credit offset line', letter.includes('• קוזזה יתרת זכות: *-100 ₪*'), true);
  t.eq('letter total 30', letter.startsWith('סה"כ 30'), true);
}

// ════════════════════════════════════════════════════════════════
// v2.14.58 — ACCUMULATE a second payment of the same month across SEPARATE imports
// (Tami, דירה 9): prior debt 230; paid 230 on 2.9 (import #1) and 230 on 27.9
// (import #2). sentLog holds ONE key per tenant-month and every import path wrote
// it with `=` → the second import OVERWROTE the first → paidAmount 230 → the June
// debt survived month-close. Extra accounts were worse: `continue` dropped the
// second payment while its fingerprint was saved (lost for good).
// ════════════════════════════════════════════════════════════════
{
  t.section('v2.14.58 — accumulate across separate imports (Tami)');
  const { loadBankAnalyzer, loadServer, loadCloseMonth, loadApplyAmbiguous } = require('./test-lib');
  const B = loadBankAnalyzer();
  const S58 = loadServer();
  const amtOf = v => { const m = String(v || '').match(/^bank_import_[^_]+_([\d.]+)_payer_/); return m ? parseFloat(m[1]) : null; };
  const mapping = { colName: 0, colAmount: 1, colDate: 2, colNote: -1, colRef: 3 };
  const tamiT = () => [{ id: 9, name: 'זהבי תמר', phone: '0500000009', keywords: '', customAmount: 230, openingDebt: 230 }];
  const row2  = ['זהבי תמר', '230', '02/09/2026', '75790'];
  const row27 = ['זהבי תמר', '230', '27/09/2026', '650918'];
  const hdr = ['שם', 'סכום', 'תאריך', 'אסמכתא'];

  // helpers: the parser + accumulator
  t.eq('parseSentLogAmount reads manual_paid amount, NOT the ISO year', B.parseSentLogAmount('manual_paid_2026-09-28T10:00:00.000Z_amount_230'), 230);
  t.eq('accumulate onto bank_import 230 + 230 = 460', B.accumulatePaidAmount('bank_import_2026-09-02T10:00:00.000Z_230_payer_x', 230), 460);
  t.eq('accumulate onto manual_paid 100 + 130 = 230', B.accumulatePaidAmount('manual_paid_2026-09-03T10:00:00.000Z_amount_100', 130), 230);
  t.eq('reminder (sent_) contributes 0', B.accumulatePaidAmount('sent_2026-09-01T10:00:00.000Z', 230), 230);
  t.eq('empty contributes 0', B.accumulatePaidAmount(undefined, 230), 230);
  t.eq('cents are rounded', B.accumulatePaidAmount('bank_import_X_0.1_payer_x', 0.2), 0.3);

  // AGENT, main: import #1 (only the 2.9 row), then import #2 (whole file)
  const r1 = B.analyzeBankRowsServer([hdr, row2], mapping, tamiT(), {}, '2026-09', { amount: 230 }, new Set(), {}, {}, ['2026-08'], []);
  t.eq('import #1 → 230', amtOf(r1.newSentLog['9_ספטמבר']), 230);
  const prior = new Set(r1.newFingerprints);
  const r2 = B.analyzeBankRowsServer([hdr, row27, row2], mapping, tamiT(), r1.newSentLog, '2026-09', { amount: 230 }, prior, {}, {}, ['2026-08'], []);
  t.eq('THE BUG: import #2 ACCUMULATES → 460 (was 230)', amtOf(r2.newSentLog['9_ספטמבר']), 460);
  t.eq('the 2.9 row is skipped as already imported', (r2.alreadyImportedSkips || []).length, 1);
  t.eq('only the new row is fingerprinted', r2.newFingerprints.length, 1);
  // re-import the same file a third time → nothing new, stays 460
  const prior3 = new Set([...prior, ...r2.newFingerprints]);
  const r3 = B.analyzeBankRowsServer([hdr, row27, row2], mapping, tamiT(), r2.newSentLog, '2026-09', { amount: 230 }, prior3, {}, {}, ['2026-08'], []);
  t.eq('re-import of the same file → still 460 (no double count)', amtOf(r3.newSentLog['9_ספטמבר']), 460);
  t.eq('re-import → no tenant matched', r3.matched.length, 0);
  // both rows in ONE import were already summed before the fix — unchanged
  const rBoth = B.analyzeBankRowsServer([hdr, row27, row2], mapping, tamiT(), {}, '2026-09', { amount: 230 }, new Set(), {}, {}, ['2026-08'], []);
  t.eq('both rows in one import → 460 (unchanged)', amtOf(rBoth.newSentLog['9_ספטמבר']), 460);
  // on top of a MANUAL mark
  const rMan = B.analyzeBankRowsServer([hdr, row27], mapping, tamiT(), { '9_ספטמבר': 'manual_paid_2026-09-05T10:00:00.000Z_amount_100' }, '2026-09', { amount: 230 }, new Set(), {}, {}, ['2026-08'], []);
  t.eq('bank row on top of manual 100 → 330', amtOf(rMan.newSentLog['9_ספטמבר']), 330);
  // a CLOSED month keeps the single-value write (money goes via the closed-month queue)
  const rClosed = B.analyzeBankRowsServer([hdr, ['זהבי תמר', '230', '20/08/2026', '1']], mapping, tamiT(), { '9_אוגוסט': 'bank_import_2026-08-02T10:00:00.000Z_230_payer_x' }, '2026-09', { amount: 230 }, new Set(), {}, {}, ['2026-08'], []);
  t.eq('closed month → NOT accumulated (230, queued instead)', amtOf(rClosed.newSentLog['9_אוגוסט']), 230);
  t.eq('closed month → queued for approval', (rClosed.closedMonthHits || []).length, 1);

  // END TO END: sentLog → recordPayment (as /api/import-bank does) → month-close
  const closeWith = (slVal) => {
    const b = { config: { amount: 230 }, tenants: tamiT(), sentLog: { '9_ספטמבר': slVal }, paymentHistory: {}, closedMonths: ['2026-08'] };
    S58.recordPayment(b, '9', '2026-09', 'bank', 230, 'זהבי תמר', 'x', amtOf(slVal));
    const C = loadCloseMonth(b, new Date('2026-10-01T06:00:00Z'));
    const ow = console.log; console.log = () => {};
    try { C.runForBuilding(b, '2026-09', 'ספטמבר'); } finally { console.log = ow; }
    return b.tenants[0].openingDebt;
  };
  t.eq('END-TO-END: accumulated 460 → openingDebt 0 after close', closeWith(r2.newSentLog['9_ספטמבר']), 0);
  t.eq('END-TO-END contrast: overwritten 230 → debt stays 230', closeWith(r1.newSentLog['9_ספטמבר']), 230);

  t.section('v2.14.58 — extra accounts: second payment accumulates (was silently lost)');
  const extraT = () => [{ id: 'Z', name: 'לא-מזוהה-ראשי', phone: '0500000000', keywords: '', customAmount: 217, openingDebt: 0,
    extraAccounts: [{ id: 'a1', label: 'ביטוח', amount: 50, active: true, matchKeywords: 'ביטוח' }] }];
  const e1 = ['ביטוח מבנה', '50', '05/09/2026', '11'];
  const e2 = ['ביטוח מבנה', '50', '25/09/2026', '12'];
  const x1 = B.analyzeBankRowsServer([hdr, e1], mapping, extraT(), {}, '2026-09', { amount: 217 }, new Set(), {}, {}, [], ['2026-08']);
  t.eq('extra import #1 → 50', amtOf(x1.newSentLog['Z__acc__a1_ספטמבר']), 50);
  const x2 = B.analyzeBankRowsServer([hdr, e1, e2], mapping, extraT(), x1.newSentLog, '2026-09', { amount: 217 }, new Set(x1.newFingerprints), {}, {}, [], ['2026-08']);
  t.eq('THE BUG (extra): import #2 ACCUMULATES → 100', amtOf(x2.newSentLog['Z__acc__a1_ספטמבר']), 100);
  t.eq('extra: second payment is REPORTED as matched (was silent)', x2.matched.filter(m => m.matchType === 'extra_account').length, 1);
  t.eq('extra: reported amount = the NEW money (50)', x2.matched.filter(m => m.matchType === 'extra_account')[0].amount, 50);
  t.eq('extra: history record carries the month TOTAL (100)', x2.newPaymentHistory['Z__acc__a1'][0].paidAmount, 100);
  // extra CLOSED month already paid → still skipped (unchanged)
  const xC = B.analyzeBankRowsServer([hdr, ['ביטוח מבנה', '50', '25/08/2026', '13']], mapping, extraT(), { 'Z__acc__a1_אוגוסט': 'bank_import_X_50_payer_x' }, '2026-09', { amount: 217 }, new Set(), {}, {}, [], ['2026-08']);
  t.eq('extra closed+paid month → not written (unchanged)', amtOf(xC.newSentLog['Z__acc__a1_אוגוסט']), 50);

  // merge: UPSERT per account-month (close reads the FIRST record via find())
  const merged = { 'Z__acc__a1': [{ month: '2026-09', paid: true, amount: 50, paidAmount: 50, date: '2026-09-05', type: 'bank_import' }] };
  B.mergeExtraPaymentHistory(merged, x2.newPaymentHistory);
  t.eq('merge: still ONE record for the month', merged['Z__acc__a1'].filter(r => r.month === '2026-09').length, 1);
  t.eq('merge: that record holds the total (100)', merged['Z__acc__a1'][0].paidAmount, 100);
  const merged2 = { k: [{ month: '2026-07', paid: true, paidAmount: 50, date: 'd', type: 'bank_import' }] };
  B.mergeExtraPaymentHistory(merged2, { k: [{ month: '2026-09', paid: true, paidAmount: 50, date: 'd', type: 'bank_import' }] });
  t.eq('merge: a new month is appended', merged2.k.length, 2);
  const merged3 = { k: [{ month: '2026-09', paid: true, paidAmount: 50, date: 'd', type: 'bank_import' }] };
  B.mergeExtraPaymentHistory(merged3, { k: [{ month: '2026-09', paid: true, paidAmount: 50, date: 'd', type: 'bank_import' }] });
  t.eq('merge: identical record → no-op', merged3.k.length, 1);
  // end to end through the REAL extra close
  {
    const { loadCloseExtra } = require('./test-lib');
    const closeExtra = loadCloseExtra();
    const tn = extraT()[0];
    const d = { paymentHistory: merged };
    closeExtra(d, tn, '2026-09');
    t.eq('END-TO-END extra: paid 100 vs 50 → credit 50 (openingDebt -50)', tn.extraAccounts[0].openingDebt, -50);
  }

  t.section('v2.14.58 — undo of an ACCUMULATED import restores the earlier 230 (Tal\'s live test path)');
  {
    const { loadImportUndo } = require('./test-lib');
    const U = loadImportUndo();
    const J = o => JSON.parse(JSON.stringify(o));
    const before = { tenants: tamiT(), closedMonths: ['2026-08'], closedMonthsExtra: [],
      sentLog: { '9_ספטמבר': 'bank_import_2026-09-02T10:00:00.000Z_230_payer_זהבי תמר' },
      paymentHistory: { '9': [{ month: '2026-09', paid: true, amount: 230, paidAmount: 230, date: '2026-09-02', type: 'bank', name: 'תמי', payerName: 'x' }] },
      importedBankFingerprints: ['fp-2.9'] };
    const patch = { sentLog: { '9_ספטמבר': r2.newSentLog['9_ספטמבר'] },
      paymentHistory: { '9': [{ month: '2026-09', paid: true, amount: 230, paidAmount: 460, date: '2026-09-28', type: 'bank', name: 'תמי', payerName: 'x' }] },
      importedBankFingerprints: ['fp-2.9', 'fp-27.9'] };
    const rec = U.buildImportUndo(before, patch, { source: 'manual', month: '2026-09' });
    const after = Object.assign(J(before), J(patch), { lastImportUndo: rec });
    const plan = U.planImportUndo(after);
    t.eq('undo allowed (no close since)', plan.ok, true);
    const undone = Object.assign(J(after), plan.patch);
    t.eq('undo → sentLog back to 230', amtOf(undone.sentLog['9_ספטמבר']), 230);
    t.eq('undo → history back to 230', undone.paymentHistory['9'][0].paidAmount, 230);
    t.eq('undo → 27.9 fingerprint removed (re-import sees it as new)', undone.importedBankFingerprints.includes('fp-27.9'), false);
    t.eq('undo → 2.9 fingerprint kept', undone.importedBankFingerprints.includes('fp-2.9'), true);
  }

  t.section('v2.14.58 — apply-ambiguous-match: manual_paid parse + history total');
  const rowKeyOf = h => [h.rowIdx, h.amount, h.date||'', h.payerName||'', h.scope||'main'].join('|');
  const mkB = (sl) => ({
    config: { amount: 300 }, closedMonths: [], closedMonthsExtra: [], defaultTariffs: {},
    tenants: [{ id: 'A', name: 'כהן א', customAmount: 300, openingDebt: 0 }, { id: 'B', name: 'כהן ב', customAmount: 300, openingDebt: 0 }],
    paymentHistory: {}, sentLog: sl || {}, importedBankFingerprints: [],
    pendingAmbiguousMatches: [{ rowIdx: 2, amount: 300, date: '10/08/2026', payerName: 'כהן', rawText: 'כהן', scope: 'main',
      candidates: [{ id: 'A', name: 'כהן א' }, { id: 'B', name: 'כהן ב' }] }]
  });
  {
    const b = mkB({ 'A_אוגוסט': 'manual_paid_2026-08-03T10:00:00.000Z_amount_100' });
    loadApplyAmbiguous(b, { rowKey: rowKeyOf(b.pendingAmbiguousMatches[0]), tenantId: 'A', decision: 'assign' });
    t.eq('THE BUG: manual 100 + 300 = 400 (was 2026+300)', amtOf(b.sentLog['A_אוגוסט']), 400);
    t.eq('history record carries the TOTAL (400, not 300)', b.paymentHistory.A.find(r => r.month === '2026-08').paidAmount, 400);
  }
  {
    const b = mkB({ 'A_אוגוסט': 'bank_import_2026-08-02T10:00:00.000Z_230_payer_x' });
    loadApplyAmbiguous(b, { rowKey: rowKeyOf(b.pendingAmbiguousMatches[0]), tenantId: 'A', decision: 'assign' });
    t.eq('bank 230 + 300 → history total 530', b.paymentHistory.A.find(r => r.month === '2026-08').paidAmount, 530);
  }
}

async function v2_14_57_async() {
  t.section('v2.14.57 — WA send-one (REAL route) text');
  const { loadSendOneRoute } = require('./test-lib');
  const m = async d => loadSendOneRoute(d, 9);
  t.eq('THE BUG: credit 100, unpaid',
    await m(C57(-100)), 'ועד בית: 230 |  | קוזזה יתרת זכות: *100 ₪* | זכות 0 | סה"כ 130');
  t.eq('THE BUG: credit 400 covers the month',
    await m(C57(-400)), 'ועד בית: 230 |  | קוזזה יתרת זכות: *230 ₪*\nיתרת זכות: *170 ₪* | זכות 170 | סה"כ 0');
  t.eq('overpay 70 (unchanged shape)',
    await m(C57(0, { '9_ספטמבר': bank(300) })), 'ועד בית: 0 |  | יתרת זכות: *70 ₪* | זכות 70 | סה"כ 0');
  t.eq('THE BUG: credit 100 + partial 100',
    await m(C57(-100, { '9_ספטמבר': bank(100) })), 'ועד בית: 130 |  | קוזזה יתרת זכות: *100 ₪* | זכות 0 | סה"כ 30');
  t.eq('no credit — Tami unchanged',
    await m(C57(230, { '9_ספטמבר': bank(230) })), 'ועד בית: 0 | חוב קודם: *230 ₪* |  | זכות 0 | סה"כ 230');
  t.eq('no credit — unpaid + prior unchanged',
    await m(C57(230)), 'ועד בית: 230 | חוב קודם: *230 ₪* |  | זכות 0 | סה"כ 460');
}


// ════════════════════════════════════════════════════════════════
// v2.14.60 — COLLECTION REPORT (buildCollectionReport) — read-only
// Neve-Yam-shaped fixture: main + extra accounts, dated personal tariff,
// partial / overpay / suspended / quarterly / near-duplicate labels.
// ════════════════════════════════════════════════════════════════
{
  const { loadCloseMonth, loadCloseExtra } = require('./test-lib');
  const R = (d, o) => S.buildCollectionReport(d, Object.assign({ mkNow: '2026-09', emNow: 'ספטמבר' }, o || {}));
  const rec = (month, amount, paidAmount, type, extra) => Object.assign({ month, paid: true, amount, paidAmount, date: '2026-01-01', type, name: '', payerName: '' }, extra || {});
  const BI = a => 'bank_import_2026-09-05T10:00:00.000Z_' + a + '_payer_x';
  const MP = a => 'manual_paid_2026-09-05T10:00:00.000Z_amount_' + a;
  function fixture() {
    return {
      config: { amount: 230 },
      defaultTariffs: [{ rate: 230, startDate: '2000-01-01', endDate: null }],
      closedMonths: ['2026-07', '2026-08'], closedMonthsExtra: ['2026-07', '2026-08'],
      tenants: [
        { id: 1, name: 'אבי', aptNumber: '1', openingDebt: 230 },
        { id: 2, name: 'בתיה', aptNumber: '2', customAmount: 350, openingDebt: 300,
          personalTariffs: [{ rate: 300, startDate: '2000-01-01', endDate: '2026-08-15' }, { rate: 350, startDate: '2026-08-15', endDate: null }] },
        { id: 3, name: 'גד', aptNumber: '3', openingDebt: -230 },
        { id: 4, name: 'דנה', aptNumber: '4', suspended: true, openingDebt: 0 },
        { id: 5, name: 'הדס', gushChelka: '12/4', openingDebt: 0,
          extraAccounts: [{ id: 'e1', label: 'חשמל', amount: 100, openingDebt: 100 }, { id: 'e2', label: 'מים', amount: 90, frequency: 'quarterly' }] },
        { id: 6, name: 'ורד', aptNumber: '6', openingDebt: 0,
          extraAccounts: [{ id: 'e3', label: ' חשמל', amount: 100 }, { id: 'e4', label: 'חשמל-', amount: 20 }] }
      ],
      paymentHistory: {
        '1': [rec('2026-07', 230, 230, 'bank')],
        '2': [rec('2026-08', 350, 350, 'manual')],
        '3': [rec('2026-07', 230, 460, 'bank', { creditBanked: true }), rec('2026-08', 230, 230, 'bank')],
        '5': [rec('2026-07', 230, 230, 'manual'), rec('2026-08', 230, 230, 'manual')],
        '6': [rec('2026-07', 230, 230, 'bank'), rec('2026-08', 230, 230, 'bank')],
        '5__acc__e1': [rec('2026-07', 100, 100, 'bank')],
        '6__acc__e3': [rec('2026-07', 100, 100, 'bank'), rec('2026-08', 100, 100, 'bank')]
      },
      sentLog: {
        '1_ספטמבר': BI(230), '2_ספטמבר': MP(100), '3_ספטמבר': 'sent_2026-09-01T09:00:00.000Z',
        '5_ספטמבר': MP(230), '6_ספטמבר': BI(230),
        '5__acc__e1_ספטמבר': BI(100), '6__acc__e3_ספטמבר': BI(100),
        // stale last-year key that must NOT be read for a closed month
        '1_אוגוסט': BI(999)
      }
    };
  }
  const acc = (r, key) => r.accounts.find(a => a.key === key);
  const mem = (r, id) => r.members.find(m => String(m.id) === String(id));

  t.section('v2.14.60 — collection report: main account (Jul–Sep, 2 closed + open)');
  {
    const d = fixture();
    const before = JSON.stringify(d);
    const r = R(d, { from: '2026-07', to: '2026-09' });
    t.eq('READ-ONLY: building data unchanged', JSON.stringify(d), before);
    t.eq('range = 3 months', r.range.months, ['2026-07', '2026-08', '2026-09']);
    t.eq('closed months in range', r.closedInRange, ['2026-07', '2026-08']);
    t.eq('open month reported', r.openMonth, '2026-09');
    const m = acc(r, 'main');
    t.eq('main: charged 3760', m.charged, 3760);
    t.eq('main: paid (נגבה בפועל) 2980', m.paid, 2980);
    t.eq('main: covered (כיסוי חיוב) 2750', m.covered, 2750);
    t.eq('main: excess 230 (גד overpaid July)', m.excess, 230);
    t.eq('main: gap 1010 = charged − covered', m.gap, 1010);
    t.eq('main: pct 73.1 (covered/charged, never > 100)', m.pct, 73.1);
    t.eq('main: bank 1840 / manual 1140', [m.bank, m.manual], [1840, 1140]);
    t.eq('main: members 6, payers 5, debtors 3, exempt 1', [m.members, m.payers, m.debtors, m.exempt], [6, 5, 3, 1]);
  }
  t.section('v2.14.60 — per member (the rules behind the numbers)');
  {
    const r = R(fixture(), { from: '2026-07', to: '2026-09' });
    t.eq('אבי: closed Aug with NO record = charged & unpaid (close deleted it)', [mem(r, 1).charged, mem(r, 1).paid, mem(r, 1).gap], [690, 460, 230]);
    t.eq('אבי: stale sentLog "_אוגוסט" NOT read for a closed month', mem(r, 1).paid, 460);
    t.eq('בתיה: Jul charge from DATED tariff 300, Aug frozen 350, Sep live 350', mem(r, 2).charged, 1000);
    t.eq('בתיה: Sep partial 100 → paid 450, gap 550', [mem(r, 2).paid, mem(r, 2).gap], [450, 550]);
    t.eq('גד: overpay counted as paid 690, covered 460, excess 230', [mem(r, 3).paid, mem(r, 3).covered, mem(r, 3).excess], [690, 460, 230]);
    t.eq('גד: a reminder (sent_) is not a payment → gap 230', mem(r, 3).gap, 230);
    t.eq('דנה (suspended): charged 0, gap 0', [mem(r, 4).charged, mem(r, 4).gap, mem(r, 4).suspended], [0, 0, true]);
    t.eq('unit: aptNumber, else gushChelka', [mem(r, 1).unit, mem(r, 5).unit], ['1', '12/4']);
    t.eq('members sorted by gap desc, tie → name (גד 230 before הדס 190)', r.members.slice(0, 4).map(x => x.name + ':' + x.gap), ['בתיה:550', 'אבי:230', 'גד:230', 'הדס:190']);
  }
  t.section('v2.14.60 — extra accounts (main == extra)');
  {
    const r = R(fixture(), { from: '2026-07', to: '2026-09' });
    const el = acc(r, 'x:חשמל');
    t.eq('"חשמל" and " חשמל" grouped into ONE account', !!el && el.members === 2, true);
    t.eq('חשמל: charged 600, paid 500, gap 100', [el.charged, el.paid, el.gap], [600, 500, 100]);
    t.eq('חשמל: closed Aug with no record = unpaid 100 (הדס)', mem(r, 5).gap >= 100, true);
    const w = acc(r, 'x:מים');
    t.eq('מים quarterly: only Sep billed (90), Jul/Aug skipped', [w.charged, w.members], [90, 1]);
    const d4 = acc(r, 'x:חשמל-');
    t.eq('"חשמל-" is its own row (60 unpaid)', [d4.charged, d4.paid], [60, 0]);
    t.eq('near-duplicate label warning (+ v2.14.69 undated-suspension warning for דנה)', r.warnings, [{ type: 'similarLabels', labels: ['חשמל', 'חשמל-'] }, { type: 'suspensionNoDate', names: ['דנה'] }]);
    t.eq('main row first', r.accounts[0].key, 'main');
    t.eq('totals = sum of accounts (4510 charged)', r.totals.charged, 4510);
    t.eq('totals.covered = main + extras', r.totals.covered, 2750 + 500 + 0 + 0);
    t.eq('totals.pct', r.totals.pct, Math.round(3250 / 4510 * 1000) / 10);
  }
  t.section('v2.14.60 — internal consistency');
  {
    const r = R(fixture(), { from: '2026-07', to: '2026-09' });
    const sum = (arr, k) => Math.round(arr.reduce((s, x) => s + x[k], 0) * 100) / 100;
    ['charged', 'paid', 'covered', 'gap'].forEach(k => {
      t.eq('Σ members.' + k + ' == totals.' + k, sum(r.members, k), r.totals[k]);
    });
    ['charged', 'paid', 'covered'].forEach(k => {
      t.eq('Σ monthly.' + k + ' == totals.' + k, sum(r.monthly, k), r.totals[k]);
    });
    t.eq('covered never exceeds charged per account', r.accounts.every(a => a.covered <= a.charged), true);
  }
  t.section('v2.14.60 — member drill-down');
  {
    const r = R(fixture(), { from: '2026-07', to: '2026-09', tenantId: '2' });
    t.eq('detail returned for the chosen member only', r.member && r.member.name, 'בתיה');
    t.eq('detail rows: 3 months of main', r.member.rows.map(x => x.month + ':' + x.status), ['2026-07:unpaid', '2026-08:paid', '2026-09:partial']);
    t.eq('detail row source', r.member.rows.map(x => x.source), [null, 'manual', 'manual']);
    const S2 = S.splitCurrentMonthDebt(fixture(), fixture().tenants[1], '2026-09', 'ספטמבר', null);
    t.eq('owedNow CONSUMED from splitCurrentMonthDebt', r.member.owedNow, S2.owedNow);
    const r5 = R(fixture(), { from: '2026-07', to: '2026-09', tenantId: 5 });
    t.eq('member with extras: rows include each account', [...new Set(r5.member.rows.map(x => x.account))], ['main', 'x:חשמל', 'x:מים']);
    t.eq('no tenantId → member null', R(fixture(), { from: '2026-07', to: '2026-09' }).member, null);
  }
  t.section('v2.14.60 — range clamping, building start, member start');
  {
    const r = R(fixture(), { from: '2025-01', to: '2026-12' });
    t.eq('from clamped to building start (first closed month)', r.range.from, '2026-07');
    t.eq('to clamped to the open month', r.range.to, '2026-09');
    t.eq('requested range echoed', [r.range.requestedFrom, r.range.requestedTo], ['2025-01', '2026-12']);
    t.eq('invalid range → no months', R(fixture(), { from: '2026-09', to: '2026-07' }).range.months, []);
    const d = fixture();
    const newId = new Date(2026, 7, 10, 12).getTime();   // created 10 Aug 2026
    d.tenants.push({ id: newId, name: 'חדש', openingDebt: 0 });
    const rn = R(d, { from: '2026-07', to: '2026-09' });
    t.eq('member created in Aug is NOT charged for Jul', mem(rn, newId).charged, 460);
    t.eq('member start month exposed', mem(rn, newId).startMonth, '2026-08');
    d.paymentHistory[String(newId)] = [rec('2026-07', 230, 230, 'bank')];
    t.eq('…unless they have an earlier paid record (backfilled) → Jul counted', mem(R(d, { from: '2026-07', to: '2026-09' }), newId).charged, 690);
    t.eq('small legacy ids are not treated as timestamps', S.crTenantCreatedMonth({ id: 5 }), null);
    t.eq('building with no history → starts at the open month', S.crBuildingStartMonth({}, '2026-09'), '2026-09');
  }
  t.section('v2.14.60 — suspended edge cases');
  {
    const d = fixture();
    d.sentLog['4_ספטמבר'] = MP(100);
    const r = R(d, { from: '2026-09', to: '2026-09' });
    t.eq('suspended partial payer: charged 0 but cash 100 still "נגבה בפועל"', [mem(r, 4).charged, mem(r, 4).paid], [0, 100]);
    d.sentLog['4_ספטמבר'] = MP(230);
    t.eq('suspended who paid in full: charged normally (like /api/data)', mem(R(d, { from: '2026-09', to: '2026-09' }), 4).charged, 230);
    const d2 = fixture(); d2.tenants[4].extraAccounts[0].suspended = true;
    const r2 = R(d2, { from: '2026-07', to: '2026-09' });
    t.eq('suspended EXTRA: unpaid Aug exempt, paid months still charged', acc(r2, 'x:חשמל').charged, 500);
    t.eq('suspended EXTRA counted in exempt', acc(r2, 'x:חשמל').exempt, 1);
    const d3 = fixture(); d3.tenants[4].extraAccounts[0].active = false;
    t.eq('inactive extra account skipped', acc(R(d3, { from: '2026-07', to: '2026-09' }), 'x:חשמל').members, 1);
  }
  t.section('v2.14.61 — allRows (print / Excel detail)');
  {
    const plain = R(fixture(), { from: '2026-07', to: '2026-09' });
    t.eq('default: members carry NO rows (light payload)', plain.members.some(m => 'rows' in m), false);
    const full = R(fixture(), { from: '2026-07', to: '2026-09', allRows: true });
    t.eq('allRows: every member carries rows', full.members.every(m => Array.isArray(m.rows)), true);
    const r2 = n => Math.round(n * 100) / 100;
    t.eq('allRows: Σ rows == member figures (every member)', full.members.every(m =>
      ['charged', 'paid', 'covered', 'gap'].every(k => r2(m.rows.reduce((s, x) => s + x[k], 0)) === m[k])), true);
    t.eq('allRows: totals unchanged', full.totals, plain.totals);
    t.eq('allRows: הדס rows = 3 main + 3 חשמל + 1 מים', full.members.find(m => m.id === 5).rows.length, 7);
    t.eq('allRows: member created later has no rows before its start', (() => {
      const d = fixture(); const id = new Date(2026, 7, 10, 12).getTime(); d.tenants.push({ id, name: 'חדש' });
      return R(d, { from: '2026-07', to: '2026-09', allRows: true }).members.find(m => m.id === id).rows.map(x => x.month);
    })(), ['2026-08', '2026-09']);
    const withM = R(fixture(), { from: '2026-07', to: '2026-09', allRows: true, tenantId: 2 });
    t.eq('allRows + tenantId: drill-down still returned', withM.member.rows.length, 3);
  }
  t.section('v2.14.63 — extraAccountBalance (as of now)');
  {
    const B = (acc, extra) => S.extraAccountBalance(Object.assign({ sentLog: {}, paymentHistory: {}, closedMonthsExtra: [] }, extra || {}),
      { id: 9 }, Object.assign({ id: 'e1', label: 'חשמל', amount: 100 }, acc), '2026-09', 'ספטמבר');
    const SL = v => ({ sentLog: { '9__acc__e1_ספטמבר': v } });
    t.eq('credit 1000, open month unpaid → credit 900', B({ openingDebt: -1000 }), { debt: 0, credit: 900 });
    t.eq('credit 1000, paid 100 → credit 1000', B({ openingDebt: -1000 }, SL(BI(100))), { debt: 0, credit: 1000 });
    t.eq('clean, overpaid 300 → live credit 200', B({ openingDebt: 0 }, SL(BI(300))), { debt: 0, credit: 200 });
    t.eq('debtor 50, month unpaid → debt 150', B({ openingDebt: 50 }), { debt: 150, credit: 0 });
    t.eq('partial 40 of 100 → debt 60', B({ openingDebt: 0 }, SL(MP(40))), { debt: 60, credit: 0 });
    t.eq('legacy payment value without amount → full', B({ openingDebt: 0 }, SL('bank_import_x')), { debt: 0, credit: 0 });
    t.eq('suspended, unpaid → exempt (credit untouched)', B({ openingDebt: -1000, suspended: true }), { debt: 0, credit: 1000 });
    t.eq('quarterly, Sep IS billing → charged', B({ openingDebt: 0, frequency: 'quarterly' }), { debt: 100, credit: 0 });
    t.eq('yearly, Sep not billing → nothing', B({ openingDebt: -50, frequency: 'yearly' }), { debt: 0, credit: 50 });
    t.eq('unpaid history record of an unclosed month is added', B({ openingDebt: 0 },
      { paymentHistory: { '9__acc__e1': [{ month: '2026-08', paid: false, amount: 100, type: 'manual' }] } }), { debt: 200, credit: 0 });
    t.eq('wa_sent record ignored', B({ openingDebt: 0 },
      { paymentHistory: { '9__acc__e1': [{ month: '2026-08', paid: false, amount: 100, type: 'wa_sent' }] } }), { debt: 100, credit: 0 });
    t.eq('current month already closed → only the banked balance', B({ openingDebt: -300 }, { closedMonthsExtra: ['2026-09'] }), { debt: 0, credit: 300 });
    t.eq('inactive → null', B({ active: false }), null);
  }
  t.section('v2.14.63 — report balances: consumed, per member / account / building');
  {
    const d = fixture();
    const r = R(d, { from: '2026-07', to: '2026-09' });
    const tn = id => d.tenants.find(x => x.id === id);
    [1, 2, 3, 4, 5, 6].forEach(id => {
      const sp = S.splitCurrentMonthDebt(fixture(), tn(id), '2026-09', 'ספטמבר', null);
      const mb = mem(r, id).balance.accounts.find(a => a.key === 'main');
      t.eq('member ' + id + ': main balance CONSUMED from splitCurrentMonthDebt', [mb.debt, mb.credit], [sp.owedNow, sp.creditLeft]);
    });
    t.eq('גד (credit 230 covers Sep) → balanced', [mem(r, 3).balance.debt, mem(r, 3).balance.credit], [0, 0]);
    t.eq('הדס extras: חשמל 100 (carried) + מים 90 (quarterly Sep) → debt 190', mem(r, 5).balance.debt, 190);
    t.eq('הדס balance lists main + each extra with a balance', mem(r, 5).balance.accounts.map(a => a.key + ':' + a.debt), ['main:0', 'x:חשמל:100', 'x:מים:90']);
    t.eq('ורד: " חשמל" paid → not listed, "חשמל-" 20 → debt 20', [mem(r, 6).balance.debt, mem(r, 6).balance.accounts.map(a => a.key)], [20, ['main', 'x:חשמל-']]);
    t.eq('account openDebt/credit = Σ member balances', r.accounts.every(a => {
      const sd = Math.round(r.members.reduce((x, m) => x + ((m.balance.accounts.find(b => b.key === a.key) || {}).debt || 0), 0) * 100) / 100;
      const sc = Math.round(r.members.reduce((x, m) => x + ((m.balance.accounts.find(b => b.key === a.key) || {}).credit || 0), 0) * 100) / 100;
      return sd === a.openDebt && sc === a.credit;
    }), true);
    t.eq('totals.balanceDebt = Σ members debt', r.totals.balanceDebt, Math.round(r.members.reduce((x, m) => x + m.balance.debt, 0) * 100) / 100);
    t.eq('totals.balanceNet = debt − credit', r.totals.balanceNet, Math.round((r.totals.balanceDebt - r.totals.balanceCredit) * 100) / 100);
    t.eq('totals.debtors counts members with debt', r.totals.debtors, r.members.filter(m => m.balance.debt > 0).length);
    t.eq('balance is range-independent (July-only report, same balances)', R(fixture(), { from: '2026-07', to: '2026-07' }).totals.balanceDebt, r.totals.balanceDebt);
    const rj = R(fixture(), { from: '2026-07', to: '2026-07' });
    t.eq('account with a balance but no rows in range still listed (מים, July)', !!rj.accounts.find(a => a.key === 'x:מים' && a.members === 0 && a.openDebt === 90), true);
  }
  t.section('v2.14.63 — the prepaid member: gap in range, but credit today');
  {
    const d = fixture();
    d.tenants.push({ id: 7, name: 'מראש', openingDebt: -2530 });   // prepaid, nothing recorded in Sep
    const r = R(d, { from: '2026-09', to: '2026-09' });
    const m7 = mem(r, 7);
    t.eq('Sep: charged 230, paid 0 → gap 230 (honest cash view)', [m7.charged, m7.paid, m7.gap], [230, 0, 230]);
    t.eq('balance today: no debt, credit 2300 (2530 − Sep)', [m7.balance.debt, m7.balance.credit], [0, 2300]);
    t.eq('building credit total includes it', r.totals.balanceCredit >= 2300 && r.totals.inCredit >= 1, true);
    const withM = R(d, { from: '2026-09', to: '2026-09', tenantId: 7 });
    t.eq('drill-down carries the same balance', withM.member.balance, m7.balance);
  }
  t.section('v2.14.60 — END-TO-END: the same month reports the same before and after the REAL month-close');
  {
    // August still OPEN (mkNow 2026-08). Payments live in sentLog + synced history.
    const open = {
      config: { amount: 230 },
      defaultTariffs: [{ rate: 230, startDate: '2000-01-01', endDate: null }],
      closedMonths: ['2026-07'], closedMonthsExtra: ['2026-07'],
      tenants: [
        { id: 1, name: 'full', openingDebt: 0 },
        { id: 2, name: 'none', openingDebt: 0 },
        { id: 3, name: 'partial', openingDebt: 0 },
        { id: 4, name: 'over', openingDebt: 230 },
        { id: 5, name: 'reminded', openingDebt: 0,
          extraAccounts: [{ id: 'e1', label: 'חשמל', amount: 100 }, { id: 'e2', label: 'חניה', amount: 50 }] }
      ],
      paymentHistory: {
        '1': [rec('2026-07', 230, 230, 'bank'), rec('2026-08', 230, 230, 'bank')],
        '3': [rec('2026-08', 230, 100, 'manual')],
        '4': [rec('2026-08', 230, 460, 'bank')],
        '5': [{ month: '2026-08', paid: false, amount: 230, paidAmount: 230, type: 'wa_sent' }],
        '5__acc__e1': [rec('2026-08', 100, 100, 'bank')]
      },
      sentLog: { '1_אוגוסט': BI(230), '3_אוגוסט': MP(100), '4_אוגוסט': BI(460), '5_אוגוסט': 'sent_x',
                 '5__acc__e1_אוגוסט': BI(100) }
    };
    const pre = S.buildCollectionReport(open, { from: '2026-08', to: '2026-08', mkNow: '2026-08', emNow: 'אוגוסט' });
    const d = JSON.parse(JSON.stringify(open));
    const cm = loadCloseMonth(d);
    cm.runForBuilding(d, '2026-08', 'אוגוסט');
    const closeExtra = loadCloseExtra();
    d.tenants.forEach(tn => closeExtra(d, tn, '2026-08'));
    d.closedMonthsExtra.push('2026-08');
    t.eq('real close ran: Aug now closed', d.closedMonths.includes('2026-08'), true);
    t.eq('real close deleted the unpaid record (none has no Aug record)', (d.paymentHistory['2'] || []).some(r => r.month === '2026-08'), false);
    const post = S.buildCollectionReport(d, { from: '2026-08', to: '2026-08', mkNow: '2026-09', emNow: 'ספטמבר' });
    const pick = r => r.members.map(m => [m.name, m.charged, m.paid, m.covered, m.gap]).sort();
    t.eq('per-member figures identical before/after close', pick(post), pick(pre));
    t.eq('account figures identical before/after close', post.accounts.map(a => [a.key, a.charged, a.paid, a.covered, a.gap]),
      pre.accounts.map(a => [a.key, a.charged, a.paid, a.covered, a.gap]));
    t.eq('Aug totals: charged 5×230+150, covered 230+0+100+230+0+100', [post.totals.charged, post.totals.covered], [1300, 660]);
    t.eq('Aug paid (cash) 230+100+460+100', post.totals.paid, 890);
  }
}


// ════════════════════════════════════════════════════════════════
// v2.14.62 — month-close CONSUMES a credit instead of wiping it
// (Tal, 2026-09-30: a member who prepaid a year became a debtor at the
// first close without a payment). REAL closeMonthUnpaidForBuilding +
// closeExtraAccountsUnpaid + /api/apply-closed-month-payment.
// ════════════════════════════════════════════════════════════════
{
  const { loadCloseMonth, loadCloseExtra, loadApplyClosedMonth } = require('./test-lib');
  const closeExtra = loadCloseExtra();
  const BIa = a => 'bank_import_2026-09-03T10:00:00.000Z_' + a + '_payer_x';
  const mk = over => Object.assign({
    config: { amount: 230 }, defaultTariffs: [{ rate: 230, startDate: '2000-01-01', endDate: null }],
    closedMonths: ['2026-08'], closedMonthsExtra: ['2026-08'], sentLog: {}, paymentHistory: {}
  }, over);
  const close = (d, key, heb) => { loadCloseMonth(d).runForBuilding(d, key, heb); d.tenants.forEach(tn => closeExtra(d, tn, key)); };

  t.section('v2.14.62 — THE BUG: prepaid a year (12×230) in September');
  {
    const d = mk({
      tenants: [{ id: 1, name: 'מראש', openingDebt: 0 }],
      paymentHistory: { '1': [{ month: '2026-09', paid: true, amount: 230, paidAmount: 2760, type: 'bank' }] },
      sentLog: { '1_ספטמבר': BIa(2760) }
    });
    close(d, '2026-09', 'ספטמבר');
    t.eq('after Sep close: credit 2530 (overpay branch, unchanged)', d.tenants[0].openingDebt, -2530);
    close(d, '2026-10', 'אוקטובר');
    t.eq('after Oct close (nothing paid): credit 2300 — was: DEBT 230', d.tenants[0].openingDebt, -2300);
    close(d, '2026-11', 'נובמבר');
    t.eq('after Nov close: credit 2070 — was: debt 460', d.tenants[0].openingDebt, -2070);
    t.eq('getCreditBalance = 2070', S.getCreditBalance(d, '1'), 2070);
    t.eq('calcTotalDebt = 0', S.calcTotalDebt(d, '1', '2026-12'), 0);
    for (let m = 12; m <= 20; m++) {
      const y = m <= 12 ? 2026 : 2027, mm = m <= 12 ? m : m - 12;
      close(d, y + '-' + String(mm).padStart(2, '0'), S.HEBREW_MONTHS[mm - 1]);
    }
    t.eq('after 11 more closes (Oct..Aug): credit fully used → 0', d.tenants[0].openingDebt, 0);
    close(d, '2027-09', 'ספטמבר');
    t.eq('13th month unpaid → normal debt 230', d.tenants[0].openingDebt, 230);
  }
  t.section('v2.14.62 — main account: every branch');
  {
    const d = mk({ tenants: [{ id: 1, openingDebt: -100 }] });
    close(d, '2026-09', 'ספטמבר');
    t.eq('credit 100 < charge 230 → debt 130', d.tenants[0].openingDebt, 130);
    const d2 = mk({ tenants: [{ id: 1, openingDebt: 230 }] });
    close(d2, '2026-09', 'ספטמבר');
    t.eq('REGRESSION: debtor 230 unpaid → 460 (unchanged)', d2.tenants[0].openingDebt, 460);
    const d3 = mk({ tenants: [{ id: 1, openingDebt: 0 }] });
    close(d3, '2026-09', 'ספטמבר');
    t.eq('REGRESSION: clean 0 unpaid → 230 (unchanged)', d3.tenants[0].openingDebt, 230);
    const d4 = mk({ tenants: [{ id: 1, openingDebt: -500 }],
      paymentHistory: { '1': [{ month: '2026-09', paid: false, amount: 230, paidAmount: 230, type: 'wa_sent' }] } });
    close(d4, '2026-09', 'ספטמבר');
    t.eq('unpaid-RECORD branch: credit 500 → 270', d4.tenants[0].openingDebt, -270);
    t.eq('unpaid-record branch still deletes the record', d4.paymentHistory['1'].length, 0);
    const d5 = mk({ tenants: [{ id: 1, openingDebt: -500, customAmount: 350 }] });
    close(d5, '2026-09', 'ספטמבר');
    t.eq('personal fee 350: credit 500 → 150', d5.tenants[0].openingDebt, -150);
    const d6 = mk({ tenants: [{ id: 1, openingDebt: -500, suspended: true }] });
    close(d6, '2026-09', 'ספטמבר');
    t.eq('suspended: credit untouched', d6.tenants[0].openingDebt, -500);
    const d7 = mk({ tenants: [{ id: 1, openingDebt: -500 }], closedMonths: ['2026-08', '2026-09'] });
    close(d7, '2026-09', 'ספטמבר');
    t.eq('idempotent: already-closed month → credit untouched', d7.tenants[0].openingDebt, -500);
    const d8 = mk({ tenants: [{ id: 1, openingDebt: -500 }],
      paymentHistory: { '1': [{ month: '2026-09', paid: true, amount: 230, paidAmount: 100, type: 'manual' }] },
      sentLog: { '1_ספטמבר': 'manual_paid_2026-09-05T10:00:00.000Z_amount_100' } });
    close(d8, '2026-09', 'ספטמבר');
    t.eq('partial 100/230 on credit 500 → 370 (branch never clamped)', d8.tenants[0].openingDebt, -370);
  }
  t.section('v2.14.62 — extra accounts (main == extra)');
  {
    const d = mk({ tenants: [{ id: 1, openingDebt: 0, extraAccounts: [{ id: 'e1', label: 'חשמל', amount: 100, openingDebt: -1100 }] }] });
    close(d, '2026-09', 'ספטמבר');
    t.eq('no record: credit 1100 → 1000 — was: DEBT 100', d.tenants[0].extraAccounts[0].openingDebt, -1000);
    d.paymentHistory['1__acc__e1'] = [{ month: '2026-10', paid: false, amount: 100, type: 'wa_sent' }];
    close(d, '2026-10', 'אוקטובר');
    t.eq('unpaid-record branch: 1000 → 900', d.tenants[0].extraAccounts[0].openingDebt, -900);
    const d2 = mk({ tenants: [{ id: 1, openingDebt: 0, extraAccounts: [{ id: 'e1', label: 'חשמל', amount: 100, openingDebt: 50 }] }] });
    close(d2, '2026-09', 'ספטמבר');
    t.eq('REGRESSION: extra debtor 50 → 150 (unchanged)', d2.tenants[0].extraAccounts[0].openingDebt, 150);
    const d3 = mk({ tenants: [{ id: 1, openingDebt: 0, extraAccounts: [{ id: 'e1', label: 'מים', amount: 90, frequency: 'quarterly', openingDebt: -200 }] }] });
    close(d3, '2026-10', 'אוקטובר');
    t.eq('quarterly, non-billing month: credit untouched', d3.tenants[0].extraAccounts[0].openingDebt, -200);
    const d4 = mk({ tenants: [{ id: 1, openingDebt: 0, extraAccounts: [{ id: 'e1', label: 'חשמל', amount: 100, openingDebt: -300, suspended: true }] }] });
    close(d4, '2026-09', 'ספטמבר');
    t.eq('suspended extra: credit untouched', d4.tenants[0].extraAccounts[0].openingDebt, -300);
  }
  t.section('v2.14.62 — a late payment for a month closed on top of a credit restores it');
  {
    const d = mk({ tenants: [{ id: 'R', name: 'ר', customAmount: 230, openingDebt: -2530 }], paymentHistory: { R: [] } });
    close(d, '2026-09', 'ספטמבר');
    t.eq('Sep closed unpaid on credit 2530 → 2300', d.tenants[0].openingDebt, -2300);
    const r = loadApplyClosedMonth(d, { tenantId: 'R', month: '2026-09', scope: 'main', paidAmount: 230, payerName: 'ר' });
    t.eq('late Sep payment applied', r.result && r.result.applied, true);
    t.eq('credit back to 2530 (no floor, no double count)', d.tenants[0].openingDebt, -2530);
    const r2 = loadApplyClosedMonth(d, { tenantId: 'R', month: '2026-09', scope: 'main', paidAmount: 230 });
    t.eq('second approval is a NO-OP (receipt)', [r2.result.applied, d.tenants[0].openingDebt], [false, -2530]);
  }
  t.section('v2.14.62 — screens agree after the close (consume path)');
  {
    const d = mk({
      tenants: [{ id: 1, name: 'מראש', openingDebt: 0 }],
      paymentHistory: { '1': [{ month: '2026-09', paid: true, amount: 230, paidAmount: 2760, type: 'bank' }] },
      sentLog: { '1_ספטמבר': BIa(2760) }
    });
    close(d, '2026-09', 'ספטמבר'); close(d, '2026-10', 'אוקטובר');
    const sp = S.splitCurrentMonthDebt(d, d.tenants[0], '2026-11', 'נובמבר', null);
    t.eq('November open: owedNow 0 (credit covers)', sp.owedNow, 0);
    t.eq('November open: creditLeft 2070 after this month', sp.creditLeft, 2070);
  }
}


// v2.14.62 — scripts/check-credit-at-risk.js (read-only) — EXECUTED on a temp DATA_DIR
{
  const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpcr-'));
  const b = { config: { amount: 230, buildingName: 'בדיקה' }, defaultTariffs: [{ rate: 230, startDate: '2000-01-01', endDate: null }],
    closedMonths: ['2026-07', '2026-08'],
    tenants: [
      { id: 1, name: 'רוני', openingDebt: -239 },
      { id: 2, name: 'שילם', openingDebt: -500 },
      { id: 3, name: 'חייב', openingDebt: 230 },
      { id: 4, name: 'מושהה', openingDebt: -300, suspended: true },
      { id: 5, name: 'עבר', openingDebt: 230, extraAccounts: [{ id: 'e1', label: 'חשמל', amount: 100, openingDebt: -400 }] }],
    paymentHistory: { '2': [{ month: '2026-09', paid: true, amount: 230, paidAmount: 230, type: 'bank' }],
      '5': [{ month: '2026-07', paid: true, amount: 230, paidAmount: 690, type: 'bank', creditBanked: true, debtOffset: { newCredit: 460 } }] },
    sentLog: { '2_ספטמבר': 'bank_import_2026-09-03T10:00:00.000Z_230_payer_x' } };
  const file = path.join(dir, 'B1.json');
  fs.writeFileSync(file, JSON.stringify(b));
  fs.writeFileSync(path.join(dir, 'users.json'), '[]');
  const before = fs.readFileSync(file, 'utf8');
  const out = cp.execFileSync('node', [path.join(__dirname, 'check-credit-at-risk.js'), 'B1', '--month', '2026-09'],
    { env: Object.assign({}, process.env, { DATA_DIR: dir }), encoding: 'utf8' });
  t.section('v2.14.62 — check-credit-at-risk.js');
  t.eq('READ-ONLY: data file unchanged', fs.readFileSync(file, 'utf8'), before);
  t.eq('רוני: old wipes to debt 230, fixed keeps credit 9', out.includes('רוני · ראשי: היום זכות 239 → בקוד הישן חוב 230 | בקוד המתוקן זכות 9'), true);
  t.eq('extra account listed (credit 400 → old debt 100 / fixed credit 300)', out.includes('עבר · חשמל: היום זכות 400 → בקוד הישן חוב 100 | בקוד המתוקן זכות 300'), true);
  t.eq('member who paid Sep NOT listed', out.includes('שילם ·'), false);
  t.eq('plain debtor NOT listed', out.includes('חייב ·'), false);
  t.eq('suspended NOT listed', out.includes('מושהה ·'), false);
  t.eq('past-wipe heuristic flags "עבר"', out.includes('🔎 עבר: נצברה זכות 460 בסגירת 2026-07'), true);
  t.eq('summary counts', out.includes('סיכום: 1 בניינים · 2 חשבונות שהסגירה הבאה משפיעה עליהם · 1 חשדות מהעבר.'), true);
  const all = cp.execFileSync('node', [path.join(__dirname, 'check-credit-at-risk.js'), '--all', '--month', '2026-09'],
    { env: Object.assign({}, process.env, { DATA_DIR: dir }), encoding: 'utf8' });
  t.eq('--all skips non-building files (users.json)', all.includes('סיכום: 1 בניינים'), true);
  fs.rmSync(dir, { recursive: true, force: true });
}


// ════════════════════════════════════════════════════════════════
// v2.14.64 — 0c stage 2: ONE source for extra-account money (extraAccountSplit)
// consumed by: report, WA {חשבונות}, auto-send, חייבים חריגים detail,
// /api/accounts-status, /api/tenant-accounts, tenant portal.
// ════════════════════════════════════════════════════════════════
const v2_14_64_async = async () => {
  const lib = require('./test-lib');
  const src = lib.readSource('server.js');
  const BIx = a => 'bank_import_2026-09-03T10:00:00.000Z_' + a + '_payer_x';
  const MPx = a => 'manual_paid_2026-09-03T10:00:00.000Z_amount_' + a;
  // config.manualMonth pins the active month to ספטמבר 2026 (current year) for every consumer.
  const base = over => Object.assign({ config: { amount: 230, manualMonth: 'ספטמבר' }, closedMonths: [], closedMonthsExtra: [],
    paymentHistory: {}, sentLog: {}, defaultTariffs: [{ rate: 230, startDate: '2000-01-01', endDate: null }] }, over);
  const MK = S.getMonthKey({ manualMonth: 'ספטמבר' }), EM = 'ספטמבר';
  const SP = (d, acc) => S.extraAccountSplit(d, { id: 9 }, acc, MK, EM);
  const A = o => Object.assign({ id: 'e1', label: 'חשמל', amount: 100 }, o);
  const slx = (v) => ({ sentLog: { ['9__acc__e1_' + EM]: v } });

  t.section('v2.14.64 — extraAccountSplit: every state');
  const pick = x => x && [x.status, x.owedCurrent, x.owedPrior, x.owedNow, x.creditLeft, x.creditApplied];
  t.eq('plain unpaid', pick(SP(base(), A({}))), ['unpaid', 100, 0, 100, 0, 0]);
  t.eq('unpaid + carried debt 50', pick(SP(base(), A({ openingDebt: 50 }))), ['unpaid', 100, 50, 150, 0, 0]);
  t.eq('credit 1000 covers the month', pick(SP(base(), A({ openingDebt: -1000 }))), ['covered', 0, 0, 0, 900, 100]);
  t.eq('credit 30 < month 100 → owes 70', pick(SP(base(), A({ openingDebt: -30 }))), ['unpaid', 70, 0, 70, 0, 30]);
  t.eq('partial 40 of 100', pick(SP(base(slx(MPx(40))), A({}))), ['partial', 60, 0, 60, 0, 0]);
  t.eq('overpaid 300 → live credit 200', pick(SP(base(slx(BIx(300))), A({}))), ['paid', 0, 0, 0, 200, 0]);
  t.eq('paid month + carried debt 50', pick(SP(base(slx(BIx(100))), A({ openingDebt: 50 }))), ['paid', 0, 50, 50, 0, 0]);
  t.eq('quarterly, Sep IS billing', pick(SP(base(), A({ frequency: 'quarterly' }))), ['unpaid', 100, 0, 100, 0, 0]);
  t.eq('yearly, Sep not billing', pick(SP(base(), A({ frequency: 'yearly' }))), ['notBilling', 0, 0, 0, 0, 0]);
  t.eq('yearly, not billing, carried debt 80', pick(SP(base(), A({ frequency: 'yearly', openingDebt: 80 }))), ['notBilling', 0, 80, 80, 0, 0]);
  t.eq('suspended, unpaid → exempt, carried debt kept (3A)', pick(SP(base(), A({ suspended: true, openingDebt: 50 }))), ['exempt', 0, 50, 50, 0, 0]);
  t.eq('suspended, paid in full → normal paid', pick(SP(base(slx(BIx(100))), A({ suspended: true }))), ['paid', 0, 0, 0, 0, 0]);
  t.eq('month already closed → only carried', pick(SP(base({ closedMonthsExtra: [MK] }), A({ openingDebt: -300 }))), ['notBilling', 0, 0, 0, 300, 0]);
  t.eq('inactive → null', SP(base(), A({ active: false })), null);
  const states = [A({}), A({ openingDebt: 50 }), A({ openingDebt: -1000 }), A({ openingDebt: -30 }), A({ frequency: 'yearly', openingDebt: 80 })];
  t.eq('invariant: owedCurrent + owedPrior == owedNow (all states)', states.every(a => { const x = SP(base(), a); return Math.round((x.owedCurrent + x.owedPrior) * 100) === Math.round(x.owedNow * 100); }), true);
  t.eq('extraAccountBalance == {owedNow, creditLeft} (report API unchanged)', states.every(a => {
    const x = SP(base(), a), b = S.extraAccountBalance(base(), { id: 9 }, a, MK, EM); return b.debt === x.owedNow && b.credit === x.creditLeft; }), true);

  // WA {חשבונות} block — the REAL buildAccountsBlock with its real dependencies
  const months = src.match(/const HEBREW_MONTHS = \[[^\]]*\];/)[0];
  const WA = lib.runInSandbox(months + '\n' + lib.extractFunctions(src, ['resolvePayerPhone', 'buildAccountsBlock', 'extraAccountSplit', 'extraMonthKeyFor',
    'getMonthKey', 'hebMonthToMonthKey', 'sentLogIsPayment', 'parseSentLogAmount']) + 'module.exports={buildAccountsBlock};');
  const block = (d, accs) => WA.buildAccountsBlock(d, { id: 9, name: 'x', extraAccounts: accs }, EM).block;
  t.section('v2.14.64 — WA {חשבונות}: byte-identical where it was right, fixed where it was wrong');
  t.eq('unpaid → "• חשמל: *100 ₪*" (unchanged)', block(base(), [A({})]), '\n• חשמל: *100 ₪*');
  t.eq('carried debt → same old format (unchanged)', block(base(), [A({ openingDebt: 50 })]), '\n• חשמל: *100 ₪* + חוב קודם 50 ₪ = *150 ₪*');
  t.eq('paid, nothing carried → no line (unchanged)', block(base(slx(BIx(100))), [A({})]), '');
  t.eq('suspended → no line (unchanged)', block(base(), [A({ suspended: true, openingDebt: 50 })]), '');
  t.eq('FIX: credit covers → no line (was "*100 ₪*")', block(base(), [A({ openingDebt: -1000 })]), '');
  t.eq('FIX: credit 30 → "*70 ₪*" (was 100)', block(base(), [A({ openingDebt: -30 })]), '\n• חשמל: *70 ₪*');
  t.eq('FIX: yearly, not billing → no line (was billed monthly)', block(base(), [A({ frequency: 'yearly' })]), '');
  t.eq('FIX: partial 40 → "*60 ₪*" (was hidden as paid)', block(base(slx(MPx(40))), [A({})]), '\n• חשמל: *60 ₪*');
  t.eq('FIX: paid month but carried debt → "חוב קודם *50 ₪*" (was hidden)', block(base(slx(BIx(100))), [A({ openingDebt: 50 })]), '\n• חשמל: חוב קודם *50 ₪*');

  t.section('v2.14.64 — auto-send decision (tenantOwesActiveExtra / autoSendShouldRemind)');
  const owes = (d, accs) => S.tenantOwesActiveExtra(d, { id: 9, extraAccounts: accs }, EM);
  t.eq('unpaid → owes (unchanged)', owes(base(), [A({})]), true);
  t.eq('paid → no (unchanged)', owes(base(slx(BIx(100))), [A({})]), false);
  t.eq('FIX: credit covers → no (was yes: a prepaid member got reminders)', owes(base(), [A({ openingDebt: -1000 })]), false);
  t.eq('FIX: not a billing month → no', owes(base(), [A({ frequency: 'yearly' })]), false);
  t.eq('FIX: partial → yes', owes(base(slx(MPx(40))), [A({})]), true);
  t.eq('paid + only carried debt → no (same rule as the main account)', owes(base(slx(BIx(100))), [A({ openingDebt: 50 })]), false);
  const tnS = { id: 9, name: 'מושהה', suspended: true, extraAccounts: [A({ openingDebt: -1000 })] };
  t.eq('suspended main + extra covered by credit → SKIP (was: remind)', S.autoSendShouldRemind(base({ tenants: [tnS] }), tnS, MK), false);

  t.section('v2.14.64 — חייבים חריגים detail: total == owedNow, lines add up');
  const det = (d, accs) => S.buildDebtDetail(d, { id: 9, name: 'x', openingDebt: 0, extraAccounts: accs }, MK).accounts;
  { const a = det(base(), [A({ openingDebt: -30 })])[0];
    t.eq('credit 30: total 70', a.total, 70);
    t.eq('credit 30: creditApplied line', a.creditApplied, 30);
    t.eq('credit 30: months 100 − credit 30 == total', a.months.reduce((x, m) => x + m.amount, 0) + a.openingDebt - (a.creditApplied || 0), a.total); }
  t.eq('credit covers → account not listed', det(base(), [A({ openingDebt: -1000 })]).length, 0);
  t.eq('partial 40 → current month 60 (was 0: hidden)', det(base(slx(MPx(40))), [A({})])[0].months.map(m => m.amount), [60]);
  t.eq('yearly not billing, carried 80 → no month line, total 80', (() => { const a = det(base(), [A({ frequency: 'yearly', openingDebt: 80 })])[0]; return [a.months.length, a.openingDebt, a.total]; })(), [0, 80, 80]);
  t.eq('suspended with carried debt → carried only (0c: month exempt)', (() => { const a = det(base(), [A({ suspended: true, openingDebt: 50 })])[0]; return [a.months.length, a.total]; })(), [0, 50]);
  t.eq('detail block prints the credit line', S.buildDebtDetailBlock({ months: [], accounts: det(base(), [A({ openingDebt: -30 })]) }).includes('◦ קוזזה יתרת זכות: *-30 ₪*'), true);

  // Route runners (REAL handler bodies)
  const route = (head, d, params) => {
    const st = src.indexOf(head); if (st < 0) throw new Error('route not found: ' + head);
    const body = src.slice(st + head.length, src.indexOf('\n});\n', st));
    const g = Object.assign({}, S, { loadTenantData: () => d });
    const names = Object.keys(g); let out;
    new Function(...names, 'req', 'res', body)(...names.map(n => g[n]), { params: params || {}, user: { tenantId: 'B' } }, { json: o => { out = o; }, status() { return this; } });
    return out;
  };
  const ACC = [A({ id: 'c', label: 'מכוסה', openingDebt: -1000 }), A({ id: 'p', label: 'חלקי' }), A({ id: 'y', label: 'שנתי', frequency: 'yearly', openingDebt: 80 }),
               A({ id: 'd', label: 'חייב', openingDebt: 50 }), A({ id: 's', label: 'מושהה', suspended: true, openingDebt: 20 }), A({ id: 'k', label: 'זכות30', openingDebt: -30 })];
  const D = base({ tenants: [{ id: 9, name: 'נ', openingDebt: 0, extraAccounts: ACC }], sentLog: { ['9__acc__p_' + EM]: MPx(40) } });
  const expected = {}; ACC.forEach(a => { expected[a.id] = SP(D, a).owedNow; });

  t.section('v2.14.64 — ONE NUMBER EVERYWHERE (same fixture through every consumer)');
  const st = route("app.get('/api/accounts-status', authMiddleware, (req, res) => {", D);
  t.eq('accounts-status: owedNow == split (all 6)', st.status['9'].map(x => x.owedNow), ACC.map(a => expected[a.id]));
  t.eq('accounts-status: owedCurrent + owedPrior == owedNow', st.status['9'].every(x => Math.round((x.owedCurrent + x.owedPrior) * 100) === Math.round(x.owedNow * 100)), true);
  t.eq('accounts-status: paidThisMonth keeps its meaning (partial has a payment)', st.status['9'].find(x => x.id === 'p').paidThisMonth, true);
  t.eq('accounts-status: statuses', st.status['9'].map(x => x.status), ['covered', 'partial', 'notBilling', 'unpaid', 'exempt', 'unpaid']);
  const ta = route("app.get('/api/tenant-accounts/:tenantId', authMiddleware, (req, res) => {", D, { tenantId: '9' });
  t.eq('tenant-accounts: owedNow == split', ta.accounts.map(x => x.owedNow), ACC.map(a => expected[a.id]));
  t.eq('tenant-accounts: credit exposed (מכוסה 900)', ta.accounts.find(x => x.id === 'c').creditLeft, 900);
  const portal = lib.loadPortalRoute(D, 9);
  t.eq('portal: extraBalances owedNow == split', ACC.map(a => portal.extraBalances[a.id].owedNow), ACC.map(a => expected[a.id]));
  t.eq('portal: suspended flag passed to the page', portal.tenant.extraAccounts.find(x => x.id === 's').suspended, true);
  const rep = S.buildCollectionReport(D, { from: MK, to: MK, mkNow: MK, emNow: EM });
  t.eq('report: Σ extra balance == Σ split', rep.members[0].balance.accounts.filter(b => b.key !== 'main').reduce((x, b) => x + b.debt, 0),
    ACC.reduce((x, a) => x + expected[a.id], 0));
  const dd = S.buildDebtDetail(D, D.tenants[0], MK);
  t.eq('debt detail: Σ account totals == Σ split owedNow', dd.accountsTotal, Math.round(ACC.reduce((x, a) => x + expected[a.id], 0) * 100) / 100);
  const wa = block(D, ACC);
  t.eq('WA block: covered + suspended absent; partial 60, yearly carried 80, debtor 150, credit30 70',
    wa, '\n• חלקי: *60 ₪*\n• שנתי: חוב קודם *80 ₪*\n• חייב: *100 ₪* + חוב קודם 50 ₪ = *150 ₪*\n• זכות30: *70 ₪*');
  const msg = await lib.loadSendOneRoute(Object.assign({}, D, { config: Object.assign({}, D.config, { template: 'שלום {שם}{חשבונות}' }) }), 9);
  t.eq('send-one (REAL route): the WhatsApp text carries the same block', msg && msg.includes('• זכות30: *70 ₪*') && !msg.includes('מכוסה'), true);
};


// ════════════════════════════════════════════════════════════════
// v2.14.66 — INCIDENT 2026-10-01: (1) cross-import dedup in both directions,
// (2) month-close catch-up after a missed 1st. REAL functions.
// ════════════════════════════════════════════════════════════════
{
  const lib = require('./test-lib');
  const src = lib.readSource('server.js');
  const B = lib.loadBankAnalyzer();
  const FP = lib.runInSandbox(lib.extractFunctions(src, ['bankRowFingerprint', 'bankFpPrefixes', 'bankFpAlreadySeen']) + 'module.exports={bankRowFingerprint,bankFpPrefixes,bankFpAlreadySeen};');
  t.section('v2.14.66 — dedup helpers, on the REAL fingerprints of 1.10');
  const stored = ['46290|230|שר שלום לילך ואו|640988', '46267|230|זהבי תמר|75790', '46200|230|ישן בלי אסמכתא'];
  const seen = new Set(stored), pre = FP.bankFpPrefixes(stored);
  const chk = (d, a, n, r) => FP.bankFpAlreadySeen(seen, pre, FP.bankRowFingerprint(d, a, n, r), FP.bankRowFingerprint(d, a, n));
  t.eq('INCIDENT: same row WITHOUT ref vs stored WITH ref → duplicate (was: new!)', chk('46290', 230, 'שר שלום לילך ואו', ''), true);
  t.eq('same row with the SAME ref → duplicate (unchanged)', chk('46290', 230, 'שר שלום לילך ואו', '640988'), true);
  t.eq('same date/amount/name, DIFFERENT ref → NEW (שחם double payment, v2.14.28)', chk('46290', 230, 'שר שלום לילך ואו', '640989'), false);
  t.eq('incoming WITH ref vs stored legacy 3-part → duplicate (v2.14.29, unchanged)', chk('46200', 230, 'ישן בלי אסמכתא', '111'), true);
  t.eq('different amount → new', chk('46290', 460, 'שר שלום לילך ואו', ''), false);
  t.eq('different date → new', chk('46291', 230, 'שר שלום לילך ואו', ''), false);
  t.eq('prefixes only from 4-part keys', [...pre].sort(), ['46267|230|זהבי תמר', '46290|230|שר שלום לילך ואו'].sort());

  t.section('v2.14.66 — INCIDENT end-to-end through the REAL agent analyzer (open September)');
  const mk = () => ({ config: { amount: 230 }, defaultTariffs: [{ rate: 230, startDate: '2000-01-01', endDate: null }],
    closedMonths: ['2026-08'], closedMonthsExtra: ['2026-08'], sentLog: {}, paymentHistory: {}, importedBankFingerprints: [],
    tenants: [{ id: 1, name: 'תומר', phone: '0501111111', keywords: 'תומר', customAmount: 230, openingDebt: 0 },
              { id: 9, name: 'תמי', phone: '0502222222', keywords: 'תמי', customAmount: 230, openingDebt: 0,
                extraAccounts: [{ id: 'e1', label: 'חשמל', amount: 100, matchKeywords: 'חשמל' }] }] });
  const imp = (d, rows, mapping, monthKey) => {
    const r = B.analyzeBankRowsServer(rows, mapping, d.tenants, d.sentLog, monthKey, d.config, new Set(d.importedBankFingerprints),
      d.paymentHistory, d.defaultTariffs, d.closedMonths, d.closedMonthsExtra);
    d.sentLog = r.newSentLog; d.importedBankFingerprints = d.importedBankFingerprints.concat(r.newFingerprints || []);
    return r;
  };
  const withRef = { colName: 0, colAmount: 1, colDate: 2, colNote: -1, colRef: 3 };
  const noRef   = { colName: 0, colAmount: 1, colDate: 2, colNote: -1, colRef: -1 };
  const sepWithRef = [['שם', 'סכום', 'תאריך', 'אסמכתא'], ['תומר', '230', '46267', '640988'], ['תמי', '460', '46268', '75790']];
  const sepNoRef   = [['שם', 'סכום', 'תאריך'], ['תומר', '230', '46267'], ['תמי', '460', '46268']];
  const d = mk();
  const r1 = imp(d, sepWithRef, withRef, '2026-09');
  t.eq('September import (with אסמכתא): 2 matched', r1.matched.length, 2);
  const before = JSON.stringify(d.sentLog);
  const r2 = imp(d, sepNoRef, noRef, '2026-09');
  t.eq('1.10 agent file WITHOUT אסמכתא: 0 matched (was 2 → doubled)', r2.matched.length, 0);
  t.eq('…both reported as already imported', (r2.alreadyImportedSkips || []).length, 2);
  t.eq('…sentLog untouched (no accumulate: תומר stays 230, תמי 460)', JSON.stringify(r2.newSentLog), before);
  t.eq('…no new fingerprints', (r2.newFingerprints || []).length, 0);
  const r3 = imp(d, [['שם', 'סכום', 'תאריך', 'אסמכתא'], ['תומר', '230', '46267', '640999']], withRef, '2026-09');
  t.eq('a GENUINE 2nd payment (other אסמכתא, same day/amount) is still counted', r3.matched.length, 1);
  // extra account (main == extra) — fixture shape of the existing extra-dedup test
  { const tx = [{ id: 'Z', name: 'לא-מזוהה-ראשי', phone: '0500000000', keywords: '', customAmount: 230, openingDebt: 0,
      extraAccounts: [{ id: 'a1', label: 'ביטוח', amount: 50, active: true, matchKeywords: 'ביטוח' }] }];
    const ex1 = B.analyzeBankRowsServer([['שם', 'סכום', 'תאריך', 'אסמכתא'], ['ביטוח מבנה', '50', '46269', '5551']], withRef, tx, {}, '2026-09', { amount: 230 }, new Set());
    t.eq('extra account: September row (with אסמכתא) matched', ex1.matched.filter(m => m.matchType === 'extra_account').length, 1);
    const ex2 = B.analyzeBankRowsServer([['שם', 'סכום', 'תאריך'], ['ביטוח מבנה', '50', '46269']], noRef, tx, {}, '2026-09', { amount: 230 }, new Set(ex1.newFingerprints));
    t.eq('extra account: same row WITHOUT אסמכתא → not counted again (was: counted)', ex2.matched.filter(m => m.matchType === 'extra_account').length, 0);
    t.eq('extra account: reported as already imported (scope extra)', (ex2.alreadyImportedSkips || []).some(x => x.scope === 'extra'), true); }
  t.eq('pending-queue overlap guard uses the same rule', src.includes('const alreadyWritten = bankFpAlreadySeen(new Set(fpList), bankFpPrefixes(fpList), fp, fpLegacy);'), true);

  t.section('v2.14.66 — month-close catch-up (REAL close functions)');
  const months = src.match(/const HEBREW_MONTHS = \[[^\]]*\];/)[0];
  const CU = (buildings, nowDate) => {
    const saved = [], backups = [];
    const code = months + '\n' + lib.extractFunctions(src, ['monthBeforeKey', 'monthCloseCatchUpDue', 'catchUpMonthClose',
      'closeMonthUnpaidForBuilding', 'closeExtraAccountsForBuilding', 'closeExtraAccountsUnpaid', 'monthInInterval', 'pickRateFromIntervals', 'resolveTariffRate'])
      + 'module.exports={catchUpMonthClose,monthCloseCatchUpDue,monthBeforeKey};';
    const m = lib.runInSandbox(code, {
      loadUsers: () => Object.keys(buildings).map(id => ({ tenantId: id })),
      loadTenantData: id => buildings[id], saveTenantData: (id, p) => saved.push({ id, keys: Object.keys(p).sort() }),
      createBackup: tag => backups.push(tag), console: { log() {}, error() {}, warn() {} } });
    return { r: m.catchUpMonthClose(nowDate), saved, backups, m };
  };
  const bld = (closed, closedX, od) => ({ config: { amount: 230 }, defaultTariffs: [{ rate: 230, startDate: '2000-01-01', endDate: null }],
    closedMonths: closed, closedMonthsExtra: closedX, sentLog: {}, paymentHistory: {},
    tenants: [{ id: 1, name: 'א', openingDebt: od || 0, customAmount: 230 }] });
  { const m = CU({}, new Date(2026, 9, 1, 16)).m;
    t.eq('monthBeforeKey 2026-09 → 2026-08; 2027-01 → 2026-12', [m.monthBeforeKey('2026-09'), m.monthBeforeKey('2027-01')], ['2026-08', '2026-12']);
    t.eq('due: prev open + month before closed', m.monthCloseCatchUpDue(['2026-07', '2026-08'], '2026-09'), true);
    t.eq('not due: prev already closed', m.monthCloseCatchUpDue(['2026-08', '2026-09'], '2026-09'), false);
    t.eq('not due: new building (nothing closed)', m.monthCloseCatchUpDue([], '2026-09'), false);
    t.eq('not due: gap (month before not closed)', m.monthCloseCatchUpDue(['2026-07'], '2026-09'), false); }
  { const tal = bld(['2026-07', '2026-08'], ['2026-07', '2026-08'], 1840);
    const fresh = bld([], [], 0), done = bld(['2026-08', '2026-09'], ['2026-08', '2026-09'], 0);
    const run = CU({ TAL: tal, NEW: fresh, DONE: done }, new Date(2026, 9, 1, 16, 13));
    t.eq("Tal's building (Aug closed, Sep open, 1.10 16:13) → September closed", tal.closedMonths, ['2026-07', '2026-08', '2026-09']);
    t.eq('…extras marker too (main == extra)', tal.closedMonthsExtra.includes('2026-09'), true);
    t.eq('…unpaid September accrued (1840 → 2070, like the regular close)', tal.tenants[0].openingDebt, 2070);
    t.eq('…saved once with the close fields', run.saved.filter(x => x.id === 'TAL').length, 1);
    t.eq('new building (nothing closed) untouched', [fresh.closedMonths.length, fresh.tenants[0].openingDebt], [0, 0]);
    t.eq('already-closed building untouched', done.tenants[0].openingDebt, 0);
    t.eq('one pre-catch-up backup', run.backups, ['pre-catchup-close']);
    t.eq('result lists the building', [run.r.prevKey, run.r.main], ['2026-09', ['TAL']]);
    const again = CU({ TAL: tal }, new Date(2026, 9, 2, 8));
    t.eq('second run is a NO-OP (no save, no backup, no double accrual)', [again.saved.length, again.backups.length, tal.tenants[0].openingDebt], [0, 0, 2070]); }
  { const y = bld(['2026-11'], ['2026-11'], 0);
    CU({ Y: y }, new Date(2027, 0, 3, 9));
    t.eq('year boundary: 3.1.2027 closes December 2026', y.closedMonths.includes('2026-12'), true); }
  t.section('v2.14.66 — wiring');
  t.eq('cron: day 1 unchanged, other days run the catch-up', /if \(today\.getDate\(\) === 1\) \{\s*console\.log\('\[runMaintenanceCron\] ראשון לחודש — מריץ closeMonthUnpaid'\);\s*closeMonthUnpaid\(\);\s*\} else \{[\s\S]{0,200}catchUpMonthClose\(new Date\(\)\)/.test(src), true);
  t.eq('boot catch-up after 2 min, skipped on the 1st before 09:00', /setTimeout\(\(\) => \{\s*const n = new Date\(\);\s*if \(n\.getDate\(\) === 1 && n\.getHours\(\) < 9\) return;\s*try \{ catchUpMonthClose\(n\);/.test(src) && src.includes('}, 2 * 60 * 1000);'), true);
}


// ════════════════════════════════════════════════════════════════
// v2.14.67 — collection trends (Phase 3): snapshots, compare, live series,
// routes (REAL handler bodies), GET /api/data strip.
// ════════════════════════════════════════════════════════════════
{
  const lib = require('./test-lib');
  const src = lib.readSource('server.js');
  if (!src.includes('const COLLECTION_REPORTS_MAX = 36;')) { console.error('  ❌ v2.14.67 consts moved'); process.exit(1); }
  const CONSTS = src.match(/const COLLECTION_REPORTS_MAX = 36;/)[0] + '\n' + src.match(/const CR_MONTH_RE = [^\n]*;/)[0];
  const BI7 = a => 'bank_import_2026-09-03T10:00:00.000Z_' + a + '_payer_x';
  const fx = () => ({ config: { amount: 230 }, defaultTariffs: [{ rate: 230, startDate: '2000-01-01', endDate: null }],
    closedMonths: ['2026-07', '2026-08'], closedMonthsExtra: ['2026-07', '2026-08'],
    tenants: [{ id: 1, name: 'אבי', aptNumber: '1', openingDebt: 460 },
              { id: 2, name: 'בתיה', aptNumber: '2', openingDebt: 0, extraAccounts: [{ id: 'e1', label: 'חשמל', amount: 100 }] },
              { id: 3, name: 'גד', aptNumber: '3', openingDebt: 0 }],
    paymentHistory: { '1': [{ month: '2026-07', paid: true, amount: 230, paidAmount: 230, type: 'bank' }],
                      '2': [{ month: '2026-07', paid: true, amount: 230, paidAmount: 230, type: 'bank' }, { month: '2026-08', paid: true, amount: 230, paidAmount: 230, type: 'bank' }],
                      '2__acc__e1': [{ month: '2026-07', paid: true, amount: 100, paidAmount: 100, type: 'bank' }],
                      '3': [{ month: '2026-07', paid: true, amount: 230, paidAmount: 230, type: 'bank' }, { month: '2026-08', paid: true, amount: 230, paidAmount: 230, type: 'bank' }] },
    sentLog: { '2_ספטמבר': BI7(230), '3_ספטמבר': BI7(230), '2__acc__e1_ספטמבר': BI7(100) } });
  const R = (d, o) => S.buildCollectionReport(d, Object.assign({ mkNow: '2026-09', emNow: 'ספטמבר' }, o));

  t.section('v2.14.67 — labels + monthly per-account series');
  t.eq('label: one month', S.crReportLabel('2026-09', '2026-09'), 'ספטמבר 2026');
  t.eq('label: same year', S.crReportLabel('2026-07', '2026-09'), 'יולי – ספטמבר 2026');
  t.eq('label: across years', S.crReportLabel('2025-11', '2026-01'), 'נובמבר 2025 – ינואר 2026');
  const rep = R(fx(), { from: '2026-07', to: '2026-09' });
  t.eq('monthly: Σ byAccount == month totals (every month)', rep.monthly.every(m => ['charged', 'paid', 'covered'].every(k =>
    Math.round(Object.values(m.byAccount).reduce((x, v) => x + v[k], 0) * 100) === Math.round(m[k] * 100))), true);
  t.eq('monthly: חשמל has its own series', rep.monthly.map(m => (m.byAccount['x:חשמל'] || {}).covered), [100, 0, 100]);

  t.section('v2.14.67 — snapshot (frozen, slim)');
  const sn = S.buildCollectionSnapshot(rep, 111, '2026-10-01T10:00:00.000Z');
  t.eq('snapshot meta', [sn.id, sn.label, sn.includesOpenMonth, sn.range.months.length], ['111', 'יולי – ספטמבר 2026', true, 3]);
  t.eq('snapshot keeps totals incl. balances of that day', [sn.totals.charged, sn.totals.balanceDebt], [rep.totals.charged, rep.totals.balanceDebt]);
  t.eq('snapshot members are slim (no monthly rows)', sn.members.every(m => !('rows' in m) && 'balance' in m && Object.keys(m.balance).sort().join() === 'credit,debt'), true);
  t.eq('snapshot does not alias the report (frozen copy of members)', sn.members[0] !== rep.members[0], true);
  t.eq('meta drops members, keeps totals', (() => { const m = S.crSnapshotMeta(sn); return [!('members' in m) || typeof m.members === 'number', m.totals.charged]; })(), [true, rep.totals.charged]);

  t.section('v2.14.67 — compare A → B');
  const dA = fx(); const snA = S.buildCollectionSnapshot(R(dA, { from: '2026-07', to: '2026-08' }), 1, '2026-09-01T00:00:00Z');
  const dB = fx(); dB.tenants[0].openingDebt = 0; dB.sentLog['1_ספטמבר'] = BI7(230);    // אבי cleared his debt
  dB.tenants[2].openingDebt = 690;                                                        // גד became a debtor
  dB.tenants.push({ id: 4, name: 'דן', aptNumber: '4', openingDebt: 0 });
  const snB = S.buildCollectionSnapshot(R(dB, { from: '2026-07', to: '2026-09' }), 2, '2026-10-01T00:00:00Z');
  const c = S.compareCollectionSnapshots(snA, snB);
  const tl = k => c.totals.find(x => x.key === k);
  t.eq('totals: delta = B − A', tl('charged').delta, Math.round((snB.totals.charged - snA.totals.charged) * 100) / 100);
  t.eq('totals: per-month average uses each period length (2 vs 3)', [tl('chargedPerMonth').a, tl('chargedPerMonth').b],
    [Math.round(snA.totals.charged / 2 * 100) / 100, Math.round(snB.totals.charged / 3 * 100) / 100]);
  t.eq('pct: delta in points', c.pct.deltaPts, Math.round((snB.totals.pct - snA.totals.pct) * 10) / 10);
  t.eq('deltaPct null when A is 0', c.totals.every(x => x.a !== 0 || x.deltaPct === null), true);
  t.eq('members: אבי improved (debt down)', c.members.improved.map(m => m.name), ['אבי']);
  t.eq('members: גד worsened (+690)', c.members.worsened.map(m => [m.name, m.debtDelta]), [['גד', 690]]);
  t.eq('members: new debtor גד, cleared אבי', [c.members.newDebtors, c.members.cleared], [['3'], ['1']]);
  t.eq('members: דן (only in B) is NOT judged as worse / new debtor', c.members.improved.concat(c.members.worsened).some(m => m.id === '4') || c.members.newDebtors.includes('4'), false);
  t.eq('members: דן listed as joined (with his debt in B)', c.members.joined.map(m => [m.name, m.debtB]), [['דן', 230]]);
  t.eq('members: nobody left', c.members.left, []);
  t.eq('accounts: union incl. חשמל with pct points', c.accounts.map(a => a.key).sort(), ['main', 'x:חשמל'].sort());

  t.section('v2.14.67 — live trend series');
  const d0 = fx();
  const all = S.buildCollectionTrend(d0, { from: '2026-07', to: '2026-09', account: 'all', mkNow: '2026-09', emNow: 'ספטמבר' });
  t.eq('series has every month', all.series.map(x => x.month), ['2026-07', '2026-08', '2026-09']);
  t.eq('series == report.monthly (all)', all.series.map(x => x.covered), R(fx(), { from: '2026-07', to: '2026-09' }).monthly.map(m => m.covered));
  t.eq('pct = covered/charged (one decimal)', all.series.every(x => x.charged > 0 ? x.pct === Math.round(x.covered / x.charged * 1000) / 10 : x.pct === null), true);
  const el = S.buildCollectionTrend(fx(), { from: '2026-07', to: '2026-09', account: 'x:חשמל', mkNow: '2026-09', emNow: 'ספטמבר' });
  t.eq('account filter x:חשמל', el.series.map(x => [x.charged, x.covered]), [[100, 100], [100, 0], [100, 100]]);
  t.eq('unknown account → zeros, pct null', S.buildCollectionTrend(fx(), { from: '2026-07', to: '2026-07', account: 'x:אין', mkNow: '2026-09', emNow: 'ספטמבר' }).series[0], { month: '2026-07', charged: 0, paid: 0, covered: 0, pct: null });
  t.eq('account list for the dropdown', all.accounts.map(a => a.key), ['main', 'x:חשמל']);

  t.section('v2.14.67 — routes (REAL handlers) with the REAL plan gate');
  const plansSrc = src.match(/const PLANS = \{[\s\S]*?\n\};/)[0];
  const PL = lib.runInSandbox(plansSrc + '\n' + lib.extractFunctions(src, ['getPlan', 'planHasFeature']) + 'module.exports={planHasFeature};');
  const helpers = lib.runInSandbox; // eslint quiet
  const body = head => { const st = src.indexOf(head); if (st < 0) throw new Error('route not found: ' + head); return src.slice(st + head.length, src.indexOf('\n});\n', st)); };
  const reqFn = lib.extractFunctions(src, ['crRequireTrends']);
  const run = (head, store, plan, req) => {
    const out = { status: 200 };
    const g = Object.assign({}, S, { planHasFeature: PL.planHasFeature, loadUsers: () => [{ tenantId: 'B', plan }],
      loadTenantData: () => JSON.parse(JSON.stringify(store.d)), saveTenantData: (id, p) => { Object.assign(store.d, p); store.saves++; } });
    const names = Object.keys(g);
    const fn = new Function(...names, 'req', 'res', CONSTS + '\n' + reqFn + '\n' + body(head));
    fn(...names.map(n => g[n]), Object.assign({ user: { tenantId: 'B' }, query: {}, params: {}, body: {} }, req),
      { status(c) { out.status = c; return this; }, json(o) { out.body = o; } });
    return out;
  };
  const H = { save: "app.post('/api/collection-reports', authMiddleware, (req, res) => {", list: "app.get('/api/collection-reports', authMiddleware, (req, res) => {",
              cmp: "app.get('/api/collection-reports-compare', authMiddleware, (req, res) => {", del: "app.delete('/api/collection-reports/:id', authMiddleware, (req, res) => {",
              trend: "app.get('/api/collection-trend', authMiddleware, (req, res) => {" };
  const store = { d: fx(), saves: 0 };
  t.eq('save on Basic → 403 Advanced', [run(H.save, store, 'basic', { body: { from: '2026-07', to: '2026-08' } }).status, store.saves], [403, 0]);
  t.eq('save bad range → 400', run(H.save, store, 'advanced', { body: { from: '2026-09', to: '2026-07' } }).status, 400);
  t.eq('save range before the building started → 400 (no months)', run(H.save, store, 'advanced', { body: { from: '2020-01', to: '2020-02' } }).status, 400);
  const s1 = run(H.save, store, 'advanced', { body: { from: '2026-07', to: '2026-08' } });
  t.eq('save → 200 + meta + count', [s1.status, s1.body.report.label, s1.body.count], [200, 'יולי – אוגוסט 2026', 1]);
  t.eq('stored snapshot computed by the SERVER (totals == report)', store.d.collectionReports[0].totals.charged, R(fx(), { from: '2026-07', to: '2026-08' }).totals.charged);
  const s2 = run(H.save, store, 'trial', { body: { from: '2026-07', to: '2026-09' } });
  t.eq('trial ("all") can save', s2.status, 200);
  const ls = run(H.list, store, 'advanced', {});
  t.eq('list: newest first, meta only (members = count)', [ls.body.reports.length, typeof ls.body.reports[0].members, ls.body.max], [2, 'number', 36]);
  t.eq('list on Basic → 403', run(H.list, store, 'basic', {}).status, 403);
  const [i1, i2] = store.d.collectionReports.map(x => x.id);
  t.eq('compare → 200 with deltas', (() => { const r = run(H.cmp, store, 'advanced', { query: { a: i1, b: i2 } }); return [r.status, Array.isArray(r.body.totals)]; })(), [200, true]);
  t.eq('compare same id → 400', run(H.cmp, store, 'advanced', { query: { a: i1, b: i1 } }).status, 400);
  t.eq('compare missing → 404', run(H.cmp, store, 'advanced', { query: { a: i1, b: 'nope' } }).status, 404);
  t.eq('trend → 200 / Basic 403 / bad range 400', [run(H.trend, store, 'advanced', { query: { from: '2026-07', to: '2026-09' } }).status,
    run(H.trend, store, 'basic', { query: { from: '2026-07', to: '2026-09' } }).status, run(H.trend, store, 'advanced', { query: { from: 'x', to: 'y' } }).status], [200, 403, 400]);
  t.eq('delete missing → 404', run(H.del, store, 'advanced', { params: { id: 'nope' } }).status, 404);
  t.eq('delete → 200, one left', (() => { const r = run(H.del, store, 'advanced', { params: { id: i1 } }); return [r.status, store.d.collectionReports.length]; })(), [200, 1]);
  { const full = { d: fx(), saves: 0 }; full.d.collectionReports = new Array(36).fill(0).map((_, i) => ({ id: 'x' + i, savedAt: '2026', label: 'l', range: { from: '2026-07', to: '2026-07', months: ['2026-07'] }, totals: {}, members: [] }));
    const r = run(H.save, full, 'advanced', { body: { from: '2026-07', to: '2026-08' } });
    t.eq('cap 36 → 409, nothing saved', [r.status, full.saves], [409, 0]); }
  t.eq('routes never write via saveTenantData anything but collectionReports', [H.save, H.del].every(h => /saveTenantData\(req\.user\.tenantId, \{ collectionReports: [^}]+\}\)/.test(body(h))), true);

  t.section('v2.14.67 — GET /api/data keeps saved reports out of the 2.5s poll');
  const gd = body("app.get('/api/data', authMiddleware, (req, res) => {");
  const strip = gd.slice(gd.indexOf('  // v2.14.67 — saved collection reports are large'), gd.lastIndexOf('res.json(d);'));
  const runStrip = q => { const d = { tenants: [], collectionReports: [{ id: 'a' }, { id: 'b' }] }; new Function('req', 'd', strip)({ query: q }, d); return d; };
  t.eq('poll: reports stripped, count kept', (() => { const d = runStrip({}); return ['collectionReports' in d, d.collectionReportsCount]; })(), [false, 2]);
  t.eq('?full=1 (backup download): reports included', runStrip({ full: '1' }).collectionReports.length, 2);
  t.eq('strip sits right before the final res.json(d)', /delete d\.collectionReports;\s*\}\s*res\.json\(d\);\s*$/.test(gd), true);
}


// ════════════════════════════════════════════════════════════════
// v2.14.69 — suspension PERIODS + "יחס גבייה בפועל" (Tal: לימור suspended from
// 1.10 still owes September; the paid ratio must be visible on the same cards)
// ════════════════════════════════════════════════════════════════
{
  const lib = require('./test-lib');
  const src = lib.readSource('server.js');
  const N = (prev, next, mk) => S.normalizeSuspensionPeriods(prev, next, mk || '2026-10');
  t.section('v2.14.69 — normalizeSuspensionPeriods');
  t.eq('off → on opens a period at the active month', N({}, { suspended: true }).suspensions, [{ from: '2026-10', to: null }]);
  t.eq('new tenant created suspended → period', N(undefined, { suspended: true }).suspensions, [{ from: '2026-10', to: null }]);
  t.eq('on → off closes at the month before', N({ suspended: true, suspensions: [{ from: '2026-06', to: null }] }, { suspensions: [{ from: '2026-06', to: null }] }).suspensions, [{ from: '2026-06', to: '2026-09' }]);
  t.eq('opened and closed in the same month → dropped', 'suspensions' in N({ suspended: true, suspensions: [{ from: '2026-10', to: null }] }, { suspensions: [{ from: '2026-10', to: null }] }), false);
  t.eq('LEGACY (suspended before 2.14.69, no period) stays undated', 'suspensions' in N({ suspended: true }, { suspended: true }), false);
  t.eq('page sets the start month (לימור → 2026-10)', N({ suspended: true }, { suspended: true, suspensions: [{ from: '2026-10', to: null }] }).suspensions, [{ from: '2026-10', to: null }]);
  t.eq('a future start month is clamped to the active month', N({ suspended: true }, { suspended: true, suspensions: [{ from: '2027-03', to: null }] }).suspensions, [{ from: '2026-10', to: null }]);
  t.eq('page omitted the field → previous periods are kept', N({ suspended: true, suspensions: [{ from: '2026-04', to: null }] }, { suspended: true }).suspensions, [{ from: '2026-04', to: null }]);
  t.eq('re-suspend keeps the old closed period + opens a new one', N({ suspensions: [{ from: '2026-03', to: '2026-05' }] }, { suspended: true }).suspensions, [{ from: '2026-03', to: '2026-05' }, { from: '2026-10', to: null }]);
  t.eq('two open periods collapse to the latest', N({ suspended: true }, { suspended: true, suspensions: [{ from: '2026-02', to: null }, { from: '2026-07', to: null }] }).suspensions, [{ from: '2026-07', to: null }]);
  t.eq('garbage entries dropped', N({}, { suspended: true, suspensions: [null, { from: 'x' }, 5] }).suspensions, [{ from: '2026-10', to: null }]);
  t.section('v2.14.69 — crSuspendedIn');
  const per = { suspended: true, suspensions: [{ from: '2026-10', to: null }] };
  t.eq('before the period → charged', [S.crSuspendedIn(per, '2026-09'), S.crSuspendedIn(per, '2026-10'), S.crSuspendedIn(per, '2026-12')], [false, true, true]);
  const closed = { suspensions: [{ from: '2026-03', to: '2026-05' }] };
  t.eq('closed period → only inside', ['2026-02', '2026-03', '2026-05', '2026-06'].map(m => S.crSuspendedIn(closed, m)), [false, true, true, false]);
  t.eq('legacy (suspended, no period) → every month', [S.crSuspendedIn({ suspended: true }, '2025-01'), S.crSuspensionUndated({ suspended: true })], [true, true]);
  t.eq('not suspended, no periods → never', S.crSuspendedIn({}, '2026-09'), false);

  t.section('v2.14.69 — THE CASE: September with לימור suspended from 1.10');
  const fx = withPeriod => ({ config: { amount: 230 }, defaultTariffs: [{ rate: 230, startDate: '2000-01-01', endDate: null }],
    closedMonths: ['2026-08', '2026-09'], closedMonthsExtra: ['2026-08', '2026-09'], sentLog: {},
    tenants: [{ id: 1, name: 'אבי', openingDebt: 0 }, { id: 9, name: 'תמי', openingDebt: -230 },
              Object.assign({ id: 4, name: 'לימור', openingDebt: 2070, suspended: true }, withPeriod ? { suspensions: [{ from: '2026-10', to: null }] } : {})],
    paymentHistory: { '1': [{ month: '2026-08', paid: true, amount: 230, paidAmount: 230, type: 'bank' }, { month: '2026-09', paid: true, amount: 230, paidAmount: 230, type: 'bank' }],
                      '9': [{ month: '2026-08', paid: true, amount: 230, paidAmount: 230, type: 'bank' }, { month: '2026-09', paid: true, amount: 230, paidAmount: 460, type: 'bank', creditBanked: true }] } });
  const rep = d => S.buildCollectionReport(d, { from: '2026-09', to: '2026-09', mkNow: '2026-10', emNow: 'אוקטובר' });
  { const r = rep(fx(true)), T = r.totals, L = r.members.find(m => m.id === 4);
    t.eq('dated: לימור CHARGED for September (unpaid)', [L.charged, L.paid, L.gap], [230, 0, 230]);
    t.eq('dated: charged 690 · covered 460 · paid 690 · gap 230', [T.charged, T.covered, T.paid, T.gap], [690, 460, 690, 230]);
    t.eq('dated: אחוז גבייה 66.7 (covered ÷ charged)', T.pct, 66.7);
    t.eq('dated: יחס בפועל 100 (paid ÷ charged), netPaid 0, excess 230 (תמי\'s June debt)', [T.paidPct, T.netPaid, T.excess], [100, 0, 230]);
    t.eq('dated: no undated-suspension warning', r.warnings.some(w => w.type === 'suspensionNoDate'), false);
    t.eq('dated: main account row carries paidPct / netPaid', [r.accounts[0].paidPct, r.accounts[0].netPaid], [100, 0]);
    const oct = S.buildCollectionReport(fx(true), { from: '2026-10', to: '2026-10', mkNow: '2026-10', emNow: 'אוקטובר' });
    t.eq('dated: October (inside the period) → exempt', oct.members.find(m => m.id === 4).charged, 0); }
  { const r = rep(fx(false)), T = r.totals;
    t.eq('LEGACY (no date): old behaviour — לימור exempt, 100% / paid 150%', [T.charged, T.pct, T.paidPct, T.netPaid], [460, 100, 150, 230]);
    t.eq('LEGACY: warning names her', r.warnings.find(w => w.type === 'suspensionNoDate').names, ['לימור']); }
  t.eq('paidPct null when nothing charged', S.buildCollectionReport({ config: { amount: 230 }, tenants: [], closedMonths: ['2026-08'], paymentHistory: {}, sentLog: {} },
    { from: '2026-09', to: '2026-09', mkNow: '2026-10', emNow: 'אוקטובר' }).totals.paidPct, null);
  { const d = fx(true); d.tenants[0].extraAccounts = [{ id: 'e1', label: 'חשמל', amount: 100, suspended: true, suspensions: [{ from: '2026-10', to: null }] }];
    const r = rep(d);
    t.eq('extra account (main == extra): suspended from Oct → September charged', r.accounts.find(a => a.key === 'x:חשמל').charged, 100); }

  t.section('v2.14.69 — save paths keep the periods (REAL code)');
  const pd = src.slice(src.indexOf("app.post('/api/data', authMiddleware, (req, res) => {"));
  const blkS = pd.slice(pd.indexOf('    // ── v2.14.69: suspension periods'), pd.indexOf('    // ── Column A (v2.13.16)'));
  const prevD = { config: { manualMonth: 'אוקטובר' }, tenants: [{ id: 4, name: 'לימור' }, { id: 5, name: 'רון', suspended: true, suspensions: [{ from: '2026-04', to: null }],
    extraAccounts: [{ id: 'x', label: 'חשמל', amount: 100 }] }] };
  const body = { tenants: [{ id: 4, name: 'לימור', suspended: true }, { id: 5, name: 'רון', extraAccounts: [{ id: 'x', label: 'חשמל', amount: 100, suspended: true }] }, { id: 6, name: 'חדש', suspended: true }] };
  new Function('req', 'loadTenantData', 'getMonthKey', 'normalizeSuspensionPeriods', 'console', blkS)
    ({ body, user: { tenantId: 'B' } }, () => prevD, S.getMonthKey, S.normalizeSuspensionPeriods, { error() {} });
  const mkNow = S.getMonthKey({ manualMonth: 'אוקטובר' });
  t.eq('POST /api/data: לימור suspended now → period from the active month', body.tenants[0].suspensions, [{ from: mkNow, to: null }]);
  t.eq('POST /api/data: רון un-suspended → his period closed', body.tenants[1].suspensions[0].to !== null, true);
  t.eq('POST /api/data: רון\'s extra account suspended → its own period', body.tenants[1].extraAccounts[0].suspensions, [{ from: mkNow, to: null }]);
  t.eq('POST /api/data: a NEW tenant created suspended → period', body.tenants[2].suspensions, [{ from: mkNow, to: null }]);
  // POST /api/tenant-accounts — the REAL handler (the dropped-suspension bug)
  const ta = src.indexOf("app.post('/api/tenant-accounts/:tenantId', authMiddleware, (req, res) => {");
  const taBody = src.slice(ta + "app.post('/api/tenant-accounts/:tenantId', authMiddleware, (req, res) => {".length, src.indexOf('\n});\n', ta));
  const runTA = (store, accounts) => { let out;
    new Function('loadTenantData', 'saveTenantData', 'getMonthKey', 'normalizeSuspensionPeriods', 'req', 'res', taBody)
      (() => store, (id, p) => Object.assign(store, p), S.getMonthKey, S.normalizeSuspensionPeriods,
       { user: { tenantId: 'B' }, params: { tenantId: '7' }, body: { accounts } }, { json: o => { out = o; } });
    return out; };
  const st = { config: { manualMonth: 'אוקטובר' }, tenants: [{ id: 7, name: 'ת', extraAccounts: [{ id: 'a1', label: 'מים', amount: 90, openingDebt: 0 }] }] };
  runTA(st, [{ id: 'a1', label: 'מים', amount: 90, openingDebt: 0, suspended: true }]);
  t.eq('FIX: the modal\'s ⏸ on an extra account is now SAVED (was dropped)', st.tenants[0].extraAccounts[0].suspended, true);
  t.eq('…and its period opened', st.tenants[0].extraAccounts[0].suspensions, [{ from: mkNow, to: null }]);
  runTA(st, [{ id: 'a1', label: 'מים', amount: 90, openingDebt: 0, suspensions: [{ from: '2026-08', to: null }], suspended: true }]);
  t.eq('modal "מחודש" sets the start month', st.tenants[0].extraAccounts[0].suspensions, [{ from: '2026-08', to: null }]);
  runTA(st, [{ id: 'a1', label: 'מים', amount: 90, openingDebt: 0 }]);
  t.eq('un-suspend from the modal → flag removed, period closed', [st.tenants[0].extraAccounts[0].suspended, st.tenants[0].extraAccounts[0].suspensions[0].to !== null], [undefined, true]);

  t.section('v2.14.69 — compare carries the paid ratio');
  const s1 = S.buildCollectionSnapshot(rep(fx(false)), 1, '2026-10-01T00:00:00Z'), s2 = S.buildCollectionSnapshot(rep(fx(true)), 2, '2026-10-02T00:00:00Z');
  t.eq('snapshot totals keep paidPct', [s1.totals.paidPct, s2.totals.paidPct], [150, 100]);
  t.eq('compare.paidPct a/b/deltaPts', S.compareCollectionSnapshots(s1, s2).paidPct, { a: 150, b: 100, deltaPts: -50 });
  const old = JSON.parse(JSON.stringify(s1)); delete old.totals.paidPct;
  t.eq('older snapshot without paidPct → nulls (no crash)', S.compareCollectionSnapshots(old, s2).paidPct, { a: null, b: 100, deltaPts: null });
}

// ════════════════════════════════════════════════════════════════
// v2.14.70 — נווה ים 3.10: (1) a manual import rewrote CLOSED months' records
// (creditBanked lost → September surplus counted twice), (2) an already-imported
// ambiguous row was offered again and accumulated, (3) a suspended member's
// payment was judged against the full tariff. THE FULL CHAIN, REAL code:
// manual import (POST /api/data) → REAL month-close → next month's manual import.
// ════════════════════════════════════════════════════════════════
{
  const lib = require('./test-lib');
  const src = lib.readSource('server.js');
  const pd = src.slice(src.indexOf("app.post('/api/data', authMiddleware, (req, res) => {"));
  const blk = pd.slice(pd.indexOf('  if (req.body.sentLog) {'), pd.indexOf('  if (_undoPrev) {'));
  // The page posts its WHOLE sentLog (app.html commitBankImport) — reproduce exactly that.
  const sync = (disk, newKeys, month) => {
    const body = { sentLog: Object.assign({}, disk.sentLog, newKeys), bankMonthOverride: month };
    new Function('req', 'loadTenantData', 'seedTariffsIfMissing', 'getMonthKey', 'hebMonthToMonthKey', 'paymentRateForMonth', 'recordPayment', 'console', blk)
      ({ body, user: { tenantId: 'B' } }, () => disk, S.seedTariffsIfMissing, S.getMonthKey, S.hebMonthToMonthKey, S.paymentRateForMonth, S.recordPayment, { error() {}, log() {} });
    disk.sentLog = body.sentLog; disk.paymentHistory = body.paymentHistory;
    if (body.tenants) disk.tenants = body.tenants; if (body.defaultTariffs) disk.defaultTariffs = body.defaultTariffs;
    return body;
  };
  const bk = (amt, payer, ts) => 'bank_import_' + (ts || '2026-09-29T06:55:21.179Z') + '_' + amt + '_payer_' + payer;
  const T = (id, name, fee, opening, extra) => Object.assign({ id, name, customAmount: fee, openingDebt: opening,
    personalTariffs: fee ? [{ rate: fee, startDate: '2000-01-01', endDate: null }] : undefined }, extra || {});
  const fx = () => ({
    config: { amount: 300, monthMode: 'manual', manualMonth: 'אוקטובר' },
    defaultTariffs: [{ rate: 300, startDate: '2000-01-01', endDate: null }],
    tenants: [T(1, 'בן', 200, 1300), T(2, 'אדרי', 200, 3400), T(3, 'אופיר', 100, 3400), T(4, 'חלקי', 200, 0),
              T(5, 'אורית', null, 0, { suspended: true, suspensions: [{ from: '2026-10', to: null }] }),
              T(6, 'אוסנת', null, 0, { suspended: true })],
    sentLog: {}, paymentHistory: {}, closedMonths: ['2026-08'], closedMonthsExtra: ['2026-08']
  });
  const d = fx();
  // 29.9 — September manual import
  sync(d, { '1_ספטמבר': bk(300, 'בן קרטר'), '2_ספטמבר': bk(500, 'אדרי'), '3_ספטמבר': bk(100, 'אופיר'), '4_ספטמבר': bk(150, 'חלקי') }, '2026-09');
  // 1.10 — the REAL close of September
  const C = lib.loadCloseMonth(d, new Date('2026-10-01T08:00:00'));
  const _log = console.log; console.log = () => {};
  C.runForBuilding(d, '2026-09', 'ספטמבר');
  console.log = _log;
  const deb = id => S.calcTotalDebt(d, String(id), '2026-10');
  t.section('v2.14.70 — chain: Sept import → REAL close (preconditions)');
  t.eq('precondition: close banked September (בן 1300+200−300=1200, אדרי 3100, אופיר 3400, חלקי 50)',
    d.tenants.slice(0, 4).map(x => x.openingDebt), [1200, 3100, 3400, 50]);
  const sep = id => (d.paymentHistory[String(id)] || []).find(r => r.month === '2026-09');
  t.eq('precondition: creditBanked on בן + אדרי, shortfallBanked on חלקי', [!!sep(1).creditBanked, !!sep(2).creditBanked, !!sep(4).shortfallBanked], [true, true, true]);
  t.eq('precondition: displayed debt right before October (1200 / 3100 / 50)', [deb(1), deb(2), deb(4)], [1200, 3100, 50]);
  const sepBefore = J([sep(1), sep(2), sep(3), sep(4)]);

  // 3.10 — October manual import (the page posts the WHOLE sentLog, September included)
  sync(d, { '1_אוקטובר': bk(350, 'בן קרטר', '2026-10-03T14:52:31.723Z'), '2_אוקטובר': bk(700, 'אדרי', '2026-10-03T14:52:31.723Z'),
            '3_אוקטובר': bk(300, 'אופיר', '2026-10-03T14:52:31.723Z'), '4_אוקטובר': bk(200, 'חלקי', '2026-10-03T14:52:31.723Z'),
            '5_אוקטובר': bk(100, 'ארזי (טל) אורית', '2026-10-03T14:52:31.723Z') }, '2026-10');
  t.section('v2.14.70 — bug 1: a manual import never rewrites a CLOSED month');
  t.eq('THE BUG: September records byte-identical after the October import (stamps kept)', J([sep(1), sep(2), sep(3), sep(4)]), sepBefore);
  t.eq('THE CASE בן: 1200 + 200 − 350 = 1050 (was 950)', deb(1), 1050);
  t.eq('THE CASE אדרי: 3100 + 200 − 700 = 2600 (was 2300)', deb(2), 2600);
  t.eq('אופיר (no Sept surplus) unchanged: 3200', deb(3), 3200);
  t.eq('closed PARTIAL not doubled: חלקי 50 + 200 − 200 = 50 (was 100)', deb(4), 50);
  t.eq('October records were written (open month still syncs)', ['1', '2', '3', '4'].map(id => d.paymentHistory[id].some(r => r.month === '2026-10' && r.paid)), [true, true, true, true]);
  {
    // unchanged open-month key with a paid record → kept as is (no churn)
    d.paymentHistory['1'].find(r => r.month === '2026-10').date = 'KEEP';
    sync(d, {}, '2026-10');
    t.eq('unchanged open-month key → record NOT rewritten', d.paymentHistory['1'].find(r => r.month === '2026-10').date, 'KEEP');
    // changed open-month key → rewritten (accumulated amount reaches the record)
    sync(d, { '1_אוקטובר': bk(550, 'בן קרטר', '2026-10-04T10:00:00.000Z') }, '2026-10');
    t.eq('changed open-month key → record updated (paidAmount 550)', d.paymentHistory['1'].find(r => r.month === '2026-10').paidAmount, 550);
    // changed CLOSED-month key with a paid record → still frozen
    sync(d, { '2_ספטמבר': bk(900, 'אדרי', '2026-10-04T10:00:00.000Z') }, '2026-10');
    t.eq('changed CLOSED-month key → record frozen (paidAmount 500, creditBanked kept)', [sep(2).paidAmount, !!sep(2).creditBanked], [500, true]);
    // a payment key with NO record → still created (heal path kept)
    delete d.paymentHistory['3'];
    sync(d, {}, '2026-10');
    t.eq('payment key without a record → record created (heal kept)', (d.paymentHistory['3'] || []).some(r => r.month === '2026-10' && r.paid), true);
  }

  t.section('v2.14.70 — bug 3: a suspended member pays → credit, never phantom debt');
  t.eq('paymentRateForMonth: inside the dated period → 0', S.paymentRateForMonth(d.tenants[4], d.defaultTariffs, '2026-10', 300), 0);
  t.eq('paymentRateForMonth: the month BEFORE the period → full tariff 300', S.paymentRateForMonth(d.tenants[4], d.defaultTariffs, '2026-09', 300), 300);
  t.eq('paymentRateForMonth: legacy undated suspension → 0', S.paymentRateForMonth(d.tenants[5], d.defaultTariffs, '2026-11', 300), 0);
  t.eq('paymentRateForMonth: not suspended → resolveTariffRate (200)', S.paymentRateForMonth(d.tenants[0], d.defaultTariffs, '2026-10', 300), 200);
  const orit = d.paymentHistory['5'].find(r => r.month === '2026-10');
  t.eq('THE CASE אורית: October record frozen at 0 (was 300 → "חלקי 100/300")', orit.amount, 0);
  t.eq('אורית: no debt, credit 100', [S.calcTotalDebt(d, '5', '2026-10'), S.getCreditBalance(d, '5')], [0, 100]);
  sync(d, { '6_נובמבר': bk(100, 'ארזי אוסנת', '2026-11-02T10:00:00.000Z') }, '2026-11');
  t.eq('אוסנת (legacy suspended) pays in November → frozen 0 → credit, no debt', [d.paymentHistory['6'].find(r => r.month === '2026-11').amount, S.calcTotalDebt(d, '6', '2026-11')], [0, 0]);
  t.eq('every payment-freeze site uses paymentRateForMonth (sync, sentlog-key, agent, apply-ambiguous)',
    (src.match(/= paymentRateForMonth\(tenant,/g) || []).length, 4);
  t.eq('repair-tariffs skips suspended months (never "repairs" 0 back to the tariff)',
    /app\.post\('\/api\/repair-tariffs'[\s\S]*?if \(crSuspendedIn\(tenant, rec\.month\)\) continue;[\s\S]*?const correct = resolveTariffRate/.test(src), true);
  {
    // apply-ambiguous-match (REAL handler) for a suspended member → amount 0
    const b = { config: { amount: 300 }, defaultTariffs: [{ rate: 300, startDate: '2000-01-01', endDate: null }],
      tenants: [{ id: 9, name: 'אורית', suspended: true, suspensions: [{ from: '2026-10', to: null }] }], sentLog: {}, paymentHistory: {},
      importedBankFingerprints: [], pendingAmbiguousMatches: [{ rowIdx: 3, amount: 100, date: '01/10/2026', payerName: 'ארזי (טל) אורית', rawText: 'ארזי (טל) אורית', scope: 'main' }] };
    const r = lib.loadApplyAmbiguous(b, { rowKey: '3|100|01/10/2026|ארזי (טל) אורית|main', tenantId: 9 });
    t.eq('apply-ambiguous (REAL): suspended member → record amount 0', [r.result.applied, b.paymentHistory['9'][0].amount], [true, 0]);
  }

  t.section('v2.14.70 — bug 2: an already-imported AMBIGUOUS row is not offered again (agent)');
  const B70 = lib.loadBankAnalyzer();
  const mapping = { colName: 0, colAmount: 1, colDate: 2, colNote: 3, colRef: 4 };
  const rows = [['שם', 'סכום', 'תאריך', 'הערות', 'אסמכתא'], ['כהן', '100', '01/10/2026', 'זיכוי', '260222222']];
  const tenants = [{ id: 'A', name: 'כהן לוי', phone: '0500000001', keywords: 'כהן', customAmount: 300, openingDebt: 0 },
                   { id: 'B', name: 'כהן כהן', phone: '0500000002', keywords: 'כהן', customAmount: 300, openingDebt: 0 }];
  const first = B70.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-10', { amount: 300 }, new Set());
  t.eq('precondition: first run → row is ambiguous (queued)', first.ambiguousMatchHits.length, 1);
  // what the assign path stores: date|amount|rawText WITHOUT ref (the אורית key)
  const stored = B70.bankRowFingerprint('01/10/2026', 100, 'כהן', '');
  const again = B70.analyzeBankRowsServer(rows, mapping, tenants, {}, '2026-10', { amount: 300 }, new Set([stored]));
  t.eq('THE BUG: re-run of the same file → NOT queued again', again.ambiguousMatchHits.length, 0);
  t.eq('…surfaced as already imported instead', again.alreadyImportedSkips.some(x => x.ambiguous === true && x.amount === 100), true);
  t.eq('…and nothing written', [again.newSentLog['A_אוקטובר'], again.newSentLog['B_אוקטובר']], [undefined, undefined]);
}

// ════════════════════════════════════════════════════════════════
// v2.14.71 — the negative-openingDebt belt hid credit that can never have been
// banked: the OPEN month (קרטר דורית 300 instead of 500 until the close) and a month
// close SKIPPED for a suspended member (אוסנת 200 instead of 300 — FOREVER).
// ════════════════════════════════════════════════════════════════
{
  const lib = require('./test-lib');
  const bk = (amt, p) => 'bank_import_2026-10-03T14:52:31.723Z_' + amt + '_payer_' + p;
  const base = extra => Object.assign({ config: { amount: 300, monthMode: 'manual', manualMonth: 'אוקטובר' },
    defaultTariffs: [{ rate: 300, startDate: '2000-01-01', endDate: null }], closedMonths: ['2026-09'], closedMonthsExtra: ['2026-09'] }, extra);
  t.section('v2.14.71 — belt narrowed: never-bankable credit counts under a negative openingDebt');
  {
    const d = base({ tenants: [{ id: 14, name: 'קרטר דורית', customAmount: 200, openingDebt: -300, personalTariffs: [{ rate: 200, startDate: '2000-01-01', endDate: null }] }],
      sentLog: { '14_אוקטובר': bk(400, 'קרטר') }, paymentHistory: { '14': [{ month: '2026-10', paid: true, amount: 200, paidAmount: 400, type: 'bank' }] } });
    t.eq('THE CASE קרטר דורית: credit 300 + October surplus 200 = 500 (was 300 until the close)', S.getCreditBalance(d, '14'), 500);
    t.eq('…no debt', S.calcTotalDebt(d, '14', '2026-10'), 0);
    const C = lib.loadCloseMonth(d, new Date('2026-11-01T08:00:00'));
    const _l = console.log; console.log = () => {}; C.runForBuilding(d, '2026-10', 'אוקטובר'); console.log = _l;
    t.eq('precondition: REAL close banks it (openingDebt −500, creditBanked)', [d.tenants[0].openingDebt, !!d.paymentHistory['14'][0].creditBanked], [-500, true]);
    t.eq('after the close: still 500 — not doubled to 700', S.getCreditBalance(d, '14'), 500);
  }
  {
    const d = base({ closedMonths: [], closedMonthsExtra: [],
      tenants: [{ id: 6, name: 'אוסנת', customAmount: null, openingDebt: -200, suspended: true }],
      sentLog: { '6_אוקטובר': bk(100, 'ארזי אוסנת') }, paymentHistory: { '6': [{ month: '2026-10', paid: true, amount: 0, paidAmount: 100, type: 'bank' }] } });
    t.eq('THE CASE אוסנת (after 🧹, nothing closed): credit 200 + 100 = 300 (was 200)', S.getCreditBalance(d, '6'), 300);
    const C = lib.loadCloseMonth(d, new Date('2026-11-01T08:00:00'));
    C.runForBuilding(d, '2026-10', 'אוקטובר');
    t.eq('precondition: the REAL close SKIPS her (suspended) — openingDebt stays −200, October now closed', [d.tenants[0].openingDebt, d.closedMonths.includes('2026-10')], [-200, true]);
    t.eq('after the close: still 300 — the ₪0 month close skipped is never lost', S.getCreditBalance(d, '6'), 300);
  }
  {
    const d = base({ tenants: [{ id: 7, name: 'ותיק', customAmount: 200, openingDebt: -300 }],
      sentLog: { '7_ספטמבר': bk(500, 'x') }, paymentHistory: { '7': [{ month: '2026-09', paid: true, amount: 200, paidAmount: 500, type: 'bank' }] } });
    t.eq('legacy belt KEPT: closed month, no stamp, negative openingDebt → 300 (not 600)', S.getCreditBalance(d, '7'), 300);
  }
  {
    const d = base({ config: { amount: 300, monthMode: 'manual', manualMonth: 'ינואר' }, closedMonths: ['2025-12'],
      tenants: [{ id: 8, name: 'דצמבר', customAmount: 200, openingDebt: -300 }],
      sentLog: { '8_דצמבר': bk(500, 'x') }, paymentHistory: { '8': [{ month: '2025-12', paid: true, amount: 200, paidAmount: 500, type: 'bank' }] } });
    t.eq('year boundary: a December key read in January is NOT treated as open → belt applies (300)', S.getCreditBalance(d, '8'), 300);
  }
  {
    const d = base({ tenants: [{ id: 1, name: 'בן', customAmount: 200, openingDebt: 1200 }],
      sentLog: { '1_אוקטובר': bk(350, 'x') }, paymentHistory: { '1': [{ month: '2026-10', paid: true, amount: 200, paidAmount: 350, type: 'bank' }] } });
    t.eq('positive openingDebt unchanged: בן 1,050', S.calcTotalDebt(d, '1', '2026-10'), 1050);
  }
}

(async () => { await v2_14_57_async(); await v2_14_64_async(); process.exit(t.done() ? 1 : 0); })();
