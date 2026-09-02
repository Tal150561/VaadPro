// ══════════════════════════════════════════════════════════════════════
// splitOverpayAcrossMonths (v2.14.38) — multi-month single-row payment split
// ══════════════════════════════════════════════════════════════════════
// THE BUG THIS FIXES (Randi/apt-3, session 21):
//   A tenant who falls behind and later pays ONE lump sum covering several
//   months (460 = 2×230, note "יולי אוגוסט") arrives as a SINGLE bank row with
//   ONE date. groupMatchesByMonth buckets by the row's date, so the whole 460
//   landed on August alone → a phantom 230 OVERPAYMENT (read live as credit),
//   while July stayed unrecorded and, once closed, its real 230 debt vanished.
//   Net effect: tenant "suddenly in credit" though they merely paid two months.
//
// THE FIX (design locked with Tal, session 21):
//   Given the buckets Map from groupMatchesByMonth, EXPAND any single-month
//   bucket whose sum is a clean integer multiple (≥2×) of that month's charge
//   into several one-charge buckets. Two strategies, in order:
//     (A) NOTE-NAMED months  — if the note names ≥2 Hebrew month names and the
//         multiple equals the count, split across exactly those months.
//     (B) BACKWARD-FILL       — fill genuinely-UNPAID prior months oldest→newest,
//         skipping any already-paid month; leftover stays as CREDIT (a real
//         advance) on the original month. (Tal Q1→note-then-backfill, Q2→
//         conservative: never push forward onto future months.)
//
//   HARD GUARDRAILS (make the change incapable of harm):
//     • Only ever triggers on a CLEAN multiple of the per-month charge.
//     • NEVER writes a month already marked paid (isPaid callback) — the split
//       only ever CONSUMES unpaid months; a paid month is skipped, never
//       overwritten.
//     • Per-month charge is resolved via chargeForMonth(mk) (tariff history),
//       never a hardcoded amount — a fee change mid-year splits correctly.
//     • If nothing splits cleanly, the buckets Map is returned UNCHANGED →
//       byte-identical to pre-v2.14.38 behaviour (the single-month common case).
//   Worst case the helper does nothing; it can neither erase a real payment nor
//   manufacture a debt.
//
// ⚠️ DUPLICATED VERBATIM in server.js (analyzeBankRowsServer, main + extra) and
//    public/app.html (analyzeBankRows) — no shared client/server module in this
//    repo (same pattern as kwMatches / bankRowFingerprint / extractAptNumbers).
//    Any change here MUST be mirrored in all copies. test-split-overpay.js runs
//    against THIS file; the render/money suites assert the copies exist + match.

const SPLIT_MONTHS_HE = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

// mk "YYYY-MM" → previous month key. "2026-01" → "2025-12".
function prevMonthKey(mk) {
  const p = String(mk).split('-');
  let y = parseInt(p[0]), m = parseInt(p[1]);
  m -= 1;
  if (m < 1) { m = 12; y -= 1; }
  return y + '-' + String(m).padStart(2, '0');
}

// Extract DISTINCT Hebrew month keys named in a free-text note, resolved against
// refYear. Word-bounded so "מאיה" doesn't match "מאי". Returns YYYY-MM strings in
// the order the months appear on the calendar (not the order typed). Empty if
// none. Cross-year note (e.g. "דצמבר ינואר") not supported → returns as found and
// the count-guard in the caller will simply decline to split (safe).
function monthsNamedInNote(note, refYear) {
  if (!note) return [];
  const s = String(note);
  const found = new Set();
  for (let i = 0; i < SPLIT_MONTHS_HE.length; i++) {
    const name = SPLIT_MONTHS_HE[i];
    const re = new RegExp('(?:^|[\\s,/(\\-])' + name + '(?=[\\s,/)\\-]|$)');
    if (re.test(s)) found.add(refYear + '-' + String(i + 1).padStart(2, '0'));
  }
  return Array.from(found).sort();
}

/**
 * Expand overpaying single-month buckets into per-month buckets.
 *
 * @param {Map} buckets  monthKey → { sum, payerName, count }  (from groupMatchesByMonth; MUTATED & returned)
 * @param {object} opts
 *   @param {(mk:string)=>number}  chargeForMonth  per-month charge (tariff-aware); >0
 *   @param {(mk:string)=>boolean} isPaid          true if that month already has a paid/bank_import sentLog
 *   @param {string}  [note]      the row's note text (for strategy A)
 *   @param {number}  [refYear]   year to resolve note month-names against (default: year of the bucket)
 *   @param {number}  [maxBack]   safety cap on how many months back to fill (default 12)
 * @returns {{buckets:Map, split:boolean, months:string[]}} split=true if any expansion happened
 */
function splitOverpayAcrossMonths(buckets, opts) {
  opts = opts || {};
  const chargeForMonth = typeof opts.chargeForMonth === 'function' ? opts.chargeForMonth : () => 0;
  const isPaid = typeof opts.isPaid === 'function' ? opts.isPaid : () => false;
  const maxBack = opts.maxBack != null ? opts.maxBack : 12;
  const note = opts.note || '';

  // Only ever act on a SINGLE-bucket, SINGLE-row payment. A file that already has
  // multiple dated months (real multi-row) is left exactly as groupMatchesByMonth
  // produced it — that path already works. count>1 means several rows summed into
  // one month (e.g. two same-day transfers) — also left alone (ambiguous; not our
  // case). This keeps the common path byte-identical.
  if (!buckets || buckets.size !== 1) return { buckets, split: false, months: [] };
  const onlyMk = buckets.keys().next().value;
  const b = buckets.get(onlyMk);
  if (!b || b.count !== 1) return { buckets, split: false, months: [] };

  const charge = chargeForMonth(onlyMk);
  if (!(charge > 0)) return { buckets, split: false, months: [] };

  // Clean integer multiple ≥2? (tolerate 1-agora rounding)
  const ratio = b.sum / charge;
  const mult = Math.round(ratio);
  if (mult < 2 || Math.abs(b.sum - mult * charge) > 0.011) {
    return { buckets, split: false, months: [] };
  }

  // ── Strategy A: note names exactly `mult` months ──────────────────────
  const refYear = opts.refYear != null ? opts.refYear : parseInt(String(onlyMk).split('-')[0]);
  const named = monthsNamedInNote(note, refYear);
  let targetMonths = null;
  if (named.length === mult) {
    // Use the named months verbatim (they may include the row's own month). Only
    // accept if none of them is already paid EXCEPT the row's own month (which is
    // the bucket we're replacing). If a *different* named month is already paid,
    // decline strategy A and fall through to backward-fill (safer).
    const conflict = named.some(mk => mk !== onlyMk && isPaid(mk));
    if (!conflict) targetMonths = named.slice();
  }

  // ── Strategy B: backward-fill unpaid prior months, oldest→newest ──────
  if (!targetMonths) {
    // Collect the row's own month plus as many UNPAID prior months as needed to
    // absorb `mult` charges. Walk backward from the month BEFORE onlyMk, skipping
    // paid months, until we've gathered (mult-1) unpaid priors (the row's own
    // month is always target #1). Whatever we can't place stays as credit on
    // onlyMk (handled below by the leftover).
    const priors = [];
    let cur = prevMonthKey(onlyMk);
    let steps = 0;
    while (priors.length < mult - 1 && steps < maxBack) {
      if (!isPaid(cur)) priors.push(cur);
      cur = prevMonthKey(cur);
      steps++;
    }
    priors.reverse(); // oldest → newest
    targetMonths = priors.concat([onlyMk]); // own month last
  }

  // Nothing to do if the split collapses back to the single original month.
  if (targetMonths.length <= 1 && targetMonths[0] === onlyMk) {
    // But there may still be leftover credit (mult>1 yet no unpaid priors found).
    // Leave the whole sum on onlyMk exactly as-is → it reads as a legitimate
    // advance-payment credit. This is the "conservative, don't push forward" case.
    return { buckets, split: false, months: [] };
  }

  // Build the new bucket set. Each target month gets exactly one charge; the
  // ORIGINAL month absorbs any leftover (advance credit) so the money always
  // balances to b.sum to the agora.
  const newBuckets = new Map();
  let placed = 0;
  for (const mk of targetMonths) {
    const c = chargeForMonth(mk) || charge;
    newBuckets.set(mk, { sum: Math.round(c * 100) / 100, payerName: b.payerName, count: 1 });
    placed = Math.round((placed + c) * 100) / 100;
  }
  const leftover = Math.round((b.sum - placed) * 100) / 100;
  if (Math.abs(leftover) > 0.011) {
    // Remainder → credit on the original month (advance). Add on top of its charge.
    const ob = newBuckets.get(onlyMk);
    ob.sum = Math.round((ob.sum + leftover) * 100) / 100;
  }

  return { buckets: newBuckets, split: true, months: targetMonths.slice() };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { splitOverpayAcrossMonths, monthsNamedInNote, prevMonthKey, SPLIT_MONTHS_HE };
}
