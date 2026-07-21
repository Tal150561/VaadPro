// ════════════════════════════════════════════════════════════════
// test-lib.js — shared harness for VaadPro's money-math tests
// ════════════════════════════════════════════════════════════════
// WHY THIS EXISTS: server.js is a single 5k-line file that binds an Express
// app and a Baileys socket at require() time, so it cannot simply be
// require()'d from a test. Instead we EXTRACT the pure functions by name and
// evaluate them in an isolated vm context. That keeps the tests running
// against the REAL source — no copies to drift out of sync.
//
// ⚠️ If you rename a function in server.js, these tests fail loudly. That is
// intentional: a silent rename is exactly how a mirror drifts.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Pull top-level `function name(...) { ... }` blocks out of a source string.
// Relies on the codebase convention that top-level functions start at column 0
// and close with a `}` at column 0.
function extractFunctions(src, names, { optional = [] } = {}) {
  let out = '';
  const missing = [];
  for (const name of names) {
    const re = new RegExp('^(?:async )?function ' + name + '\\s*\\([\\s\\S]*?^\\}', 'm');
    const m = src.match(re);
    if (m) out += m[0] + '\n';
    else if (!optional.includes(name)) missing.push(name);
  }
  if (missing.length) {
    throw new Error(
      'test-lib: function(s) not found in source: ' + missing.join(', ') +
      '\n  → they were renamed or deleted. Update the test or restore the function.'
    );
  }
  return out;
}

function runInSandbox(code, extraGlobals = {}) {
  const ctx = Object.assign({ module: { exports: {} }, console, Date, JSON, Math, parseFloat, parseInt, isNaN, String, Object, Array }, extraGlobals);
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.module.exports;
}

// ── Load the server's money functions ──────────────────────────────
const SERVER_FNS = [
  'getEffectiveMonth', 'getMonthKey',
  'parseSentLogAmount', 'sentLogIsPayment', 'getExpectedAmount',
  'calcMonthBalance', 'getDerivedCredit', 'calcShortfallFromSentLog',
  'calcTotalDebt', 'getCreditBalance', 'recordPayment',
  // Column A (v2.13.16) — fixed-amount tariff history
  'monthInInterval', 'pickRateFromIntervals', 'resolveTariffRate',
  'closeAndOpenInterval', 'seedTariffsIfMissing',
  // Stage 3 (v2.13.18) — partial-payment balance reminder
  'buildBalanceLine', 'autoSendShouldRemind'
];

function loadServer() {
  const src = readSource('server.js');
  const months = src.match(/const HEBREW_MONTHS = \[[^\]]*\];/);
  if (!months) throw new Error('test-lib: HEBREW_MONTHS not found in server.js');
  const code = months[0] + '\n'
    + extractFunctions(src, SERVER_FNS)
    + 'module.exports={' + SERVER_FNS.join(',') + ',HEBREW_MONTHS};';
  return runInSandbox(code);
}

// ── Load the Agent bank-import analyzer (Fix #0 / v2.13.15) ────────
// analyzeBankRowsServer is the server-side (Agent) port of the manual
// analyzeBankRows. Fix #0 removed its openingDebt netting so accrual lives
// ONLY in closeMonthUnpaid. Extracted here so the test runs against the REAL
// source: re-introducing applyPaymentToDebt(tenant, ...) inside it must fail.
function loadBankAnalyzer() {
  const src = readSource('server.js');
  const months = src.match(/const HEBREW_MONTHS = \[[^\]]*\];/);
  const code = (months ? months[0] + '\n' : '')
    + extractFunctions(src, ['getEffectiveMonth', 'getMonthKey', 'applyPaymentToDebt', 'analyzeBankRowsServer'])
    + 'module.exports={getMonthKey,applyPaymentToDebt,analyzeBankRowsServer};';
  return runInSandbox(code);
}

// ── Load the REAL closeMonthUnpaid (Stage 4 / v2.13.21) ───────────
// closeMonthUnpaid is the ONLY function that accrues debt to disk. Stage 4 added
// the `overpay < 0` partial-payment shortfall branch. We extract it and inject
// stubs for its only external deps (loadUsers / loadTenantData / saveTenantData)
// so the test runs the ACTUAL accrual logic, not a copy. saveTenantData captures
// the written patch so the test can assert openingDebt + shortfallBanked.
// It also needs the money helpers in scope (none, actually — it is self-contained
// on HEBREW_MONTHS + the injected I/O), so we extract just the function.
function loadCloseMonth(building, nowDate) {
  const src = readSource('server.js');
  const months = src.match(/const HEBREW_MONTHS = \[[^\]]*\];/);
  if (!months) throw new Error('test-lib: HEBREW_MONTHS not found');
  const code = months[0] + '\n'
    + extractFunctions(src, ['closeMonthUnpaid'])
    + 'module.exports={closeMonthUnpaid};';
  // building is mutated in place by closeMonthUnpaid via the loadTenantData ref.
  const saved = [];
  const stubs = {
    loadUsers: () => [{ tenantId: 'T1' }],
    loadTenantData: () => building,
    saveTenantData: (id, patch) => { saved.push({ id, patch }); },
    // Freeze "now" so prevKey/prevHebMonth are deterministic.
    Date: nowDate ? class extends Date { constructor(...a){ super(...(a.length?a:[nowDate])); } } : Date
  };
  const mod = runInSandbox(code, stubs);
  return { run: mod.closeMonthUnpaid, saved, building };
}

// ── Load the /api/sentlog-key DELETE-branch cleanup (v2.13.14) ─────
// The "unmark paid" path (markUnpaid / resetSent / delete-tenant) posts value:null
// to /api/sentlog-key. v2.13.14 made that branch ALSO strip the matching
// manual/bank paymentHistory record, so closeMonthUnpaid can't resurrect a
// cancelled payment (the "orphan record" bug). That logic lives INLINE in the
// route handler, not in a named function, so we cannot extractFunctions() it.
// Instead we lift the exact filter predicate out of the route source by a stable
// anchor and expose it as a testable function. If the cleanup is ever removed,
// the anchor vanishes and this throws — a loud regression signal.
function loadSentlogKeyDelete() {
  const src = readSource('server.js');
  // Anchor on the route so we only match the real handler, then find the
  // paymentHistory-cleanup filter inside its delete branch.
  const routeIdx = src.indexOf("app.post('/api/sentlog-key'");
  if (routeIdx < 0) throw new Error('test-lib: /api/sentlog-key route not found');
  const region = src.slice(routeIdx, routeIdx + 3000);
  // The delete branch filters out paid records of type manual|bank for the month.
  const m = region.match(/d\.paymentHistory\[tenantId\]\s*=\s*d\.paymentHistory\[tenantId\]\.filter\(\s*([\s\S]*?)\);/);
  if (!m) {
    throw new Error(
      'test-lib: unmark-cleanup filter NOT FOUND in /api/sentlog-key delete branch.\n' +
      '  → the paymentHistory cleanup (v2.13.14) was removed. The "orphan record"\n' +
      '    bug is back: closeMonthUnpaid will resurrect a cancelled payment.'
    );
  }
  // The extracted arrow is `r => <expr>` where <expr> closes over `monthKey`.
  // Re-bind both as explicit params so the REAL predicate body drives the test.
  const body = m[1].trim().replace(/^r\s*=>\s*/, '');
  const predicate = new Function('r', 'monthKey', 'return (' + body + ');');
  // Apply the REAL filter for a given tenant's records + resolved monthKey.
  return function cleanupOnUnmark(records, monthKey) {
    return records.filter(r => predicate(r, monthKey));
  };
}

// Reproduces the GET /api/data enrichment. Kept here (not extracted) because it
// lives inline in a route handler. If you change the route, change this too —
// the E2E test asserts the shape the frontend depends on.
function enrichTenants(S, d) {
  const mkNow = S.getMonthKey(d.config || {});
  const emNow = S.getEffectiveMonth(d.config || {});
  return (d.tenants || []).map(t => {
    const tid = String(t.id);
    const hist = (d.paymentHistory || {})[tid] || [];
    const live = t.customAmount || (d.config && d.config.amount) || 300;
    const monthBalances = {};
    Object.keys(d.sentLog || {}).forEach(key => {
      if (key.includes('__acc__')) return;
      const sep = key.lastIndexOf('_');
      if (sep < 0 || String(key.slice(0, sep)) !== tid) return;
      const heb = key.slice(sep + 1);
      const idx = S.HEBREW_MONTHS.indexOf(heb);
      if (idx < 0) return;
      const mKey = String(mkNow).split('-')[0] + '-' + String(idx + 1).padStart(2, '0');
      monthBalances[heb] = S.calcMonthBalance(d.sentLog[key], S.getExpectedAmount(hist, mKey, live));
    });
    const emBal = monthBalances[emNow] || S.calcMonthBalance(null, S.getExpectedAmount(hist, mkNow, live));
    return Object.assign({}, t, {
      creditBalance: S.getCreditBalance(d, tid),
      totalDebt: S.calcTotalDebt(d, tid, mkNow),
      effectiveAmount: live,
      monthBalances,
      currentBalance: emBal
    });
  });
}

// Reproduces the portal's server-side amountDue block.
function portalCurrent(S, d, tid, amount, monthKey, sentKey) {
  const hist = (d.paymentHistory || {})[tid] || [];
  const bal = S.calcMonthBalance((d.sentLog || {})[sentKey], S.getExpectedAmount(hist, monthKey, amount));
  const credit = S.getCreditBalance(d, tid);
  const total = S.calcTotalDebt(d, tid, monthKey);
  const rec = hist.find(r => r.month === monthKey && !r.paid && r.type !== 'wa_sent');
  const currentInTotal = (bal.status === 'partial' ? bal.shortfall : 0)
    + (rec ? (parseFloat(rec.amount) || 0) : 0);
  const priorDebt = Math.max(0, total - currentInTotal);
  const currentCharge = (bal.status === 'paid') ? 0
    : (bal.status === 'partial') ? bal.shortfall : amount;
  const amountDue = Math.max(0, currentCharge + priorDebt - credit);
  return { balance: bal, amountDue, priorDebt, creditBalance: credit };
}

// ── Extract a JS region from an HTML page and make it runnable ─────
function extractHtmlRegion(rel, startMarker, endMarker) {
  const src = readSource(rel);
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('test-lib: start marker not found in ' + rel + ': ' + startMarker.slice(0, 40));
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('test-lib: end marker not found in ' + rel + ': ' + endMarker.slice(0, 40));
  return src.slice(i, j);
}

// ── Tiny assertion helpers ─────────────────────────────────────────
function makeRunner(title) {
  let pass = 0, fail = 0;
  const failures = [];
  return {
    section(name) { console.log('\n  ── ' + name + ' ──'); },
    eq(name, actual, expected) {
      const a = JSON.stringify(actual), e = JSON.stringify(expected);
      if (a === e) { pass++; console.log('    ✓ ' + name); }
      else {
        fail++; failures.push(name);
        console.log('    ✗ ' + name + '\n        got:      ' + a + '\n        expected: ' + e);
      }
    },
    noThrow(name, fn) {
      try { fn(); pass++; console.log('    ✓ ' + name); }
      catch (e) {
        fail++; failures.push(name);
        console.log('    ✗ ' + name + ' → THREW: ' + e.message);
      }
    },
    done() {
      console.log('\n  ' + (fail === 0 ? '✅ ' + title + ': ' + pass + ' passed'
                                       : '❌ ' + title + ': ' + fail + ' FAILED (' + failures.join(', ') + ')'));
      return fail;
    }
  };
}

module.exports = {
  readSource, extractFunctions, runInSandbox,
  loadServer, loadBankAnalyzer, loadCloseMonth, loadSentlogKeyDelete, enrichTenants, portalCurrent,
  extractHtmlRegion, makeRunner
};
