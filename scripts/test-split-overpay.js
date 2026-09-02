// Unit tests for splitOverpayAcrossMonths (v2.14.38). Run: node scripts/test-split-overpay.js
const { splitOverpayAcrossMonths, monthsNamedInNote, prevMonthKey } = require('./lib-split-overpay');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', name); } }
function eq(name, a, b) { ok(name + ' (got ' + JSON.stringify(a) + ')', JSON.stringify(a) === JSON.stringify(b)); }

// helper to build a one-row single bucket
function bucket(mk, sum) { const m = new Map(); m.set(mk, { sum, payerName: 'P', count: 1 }); return m; }
const charge230 = () => 230;
const nonePaid = () => false;

// ── prevMonthKey ──
eq('prevMonthKey mid-year', prevMonthKey('2026-08'), '2026-07');
eq('prevMonthKey Jan→prev Dec', prevMonthKey('2026-01'), '2025-12');

// ── monthsNamedInNote ──
eq('note: יולי אוגוסט', monthsNamedInNote('ועד הבית יולי אוגוסט', 2026), ['2026-07','2026-08']);
eq('note: none', monthsNamedInNote('תשלום ועד', 2026), []);
eq('note: מאי not מאיה', monthsNamedInNote('עבור מאיה', 2026), []); // word-bounded
eq('note: single month only', monthsNamedInNote('אוגוסט', 2026), ['2026-08']);

// ── Common path: NOT a multiple → unchanged ──
{
  const b = bucket('2026-08', 230);
  const r = splitOverpayAcrossMonths(b, { chargeForMonth: charge230, isPaid: nonePaid });
  ok('single charge → no split', r.split === false && r.buckets.size === 1 && r.buckets.get('2026-08').sum === 230);
}
{
  const b = bucket('2026-08', 250); // 250 not a clean multiple
  const r = splitOverpayAcrossMonths(b, { chargeForMonth: charge230, isPaid: nonePaid });
  ok('partial/odd amount → no split', r.split === false && r.buckets.get('2026-08').sum === 250);
}
{
  // Boundary: EXACTLY 1× charge (mult=1) must never split — pins the `mult < 2`
  // guard. If the guard were weakened to `< 1`, a normal single-month payment
  // would try to "split" into just its own month and this would break.
  const b = bucket('2026-08', 230);
  const r = splitOverpayAcrossMonths(b, { chargeForMonth: charge230, isPaid: () => false });
  ok('exact 1x charge (mult=1) → never split', r.split === false && r.buckets.size === 1 && r.buckets.get('2026-08').sum === 230);
}
{
  // Pins `mult < 2` UNIQUELY: a 1× payment while prior months are unpaid must
  // NOT reach back and steal a prior month. If the guard were `mult < 1`, mult=1
  // would proceed and (with unpaid priors) could fabricate a split.
  const b = bucket('2026-08', 230);
  const r = splitOverpayAcrossMonths(b, { chargeForMonth: charge230, isPaid: () => false, note: '' });
  ok('1x with unpaid priors → still no split', r.split === false && r.buckets.size === 1);
}
{
  const b = bucket('2026-08', 690); const b2 = new Map(b); b2.set('2026-07',{sum:230,payerName:'P',count:1});
  const r = splitOverpayAcrossMonths(b2, { chargeForMonth: charge230, isPaid: nonePaid });
  ok('already multi-bucket → untouched', r.split === false && r.buckets.size === 2);
}

// ── THE RANDI CASE: 460 in Aug, note "יולי אוגוסט", July unpaid → split 07+08 ──
{
  const b = bucket('2026-08', 460);
  const r = splitOverpayAcrossMonths(b, { chargeForMonth: charge230, isPaid: nonePaid, note: 'ועד הבית יולי אוגוסט' });
  ok('Randi: split happened', r.split === true);
  ok('Randi: two months', r.buckets.size === 2);
  ok('Randi: July=230', r.buckets.get('2026-07') && r.buckets.get('2026-07').sum === 230);
  ok('Randi: Aug=230', r.buckets.get('2026-08') && r.buckets.get('2026-08').sum === 230);
  eq('Randi: months', r.months, ['2026-07','2026-08']);
}

// ── No note, 460, backward-fill: July unpaid → 07+08 ──
{
  const b = bucket('2026-08', 460);
  const r = splitOverpayAcrossMonths(b, { chargeForMonth: charge230, isPaid: nonePaid });
  ok('no-note x2: split', r.split === true && r.buckets.size === 2);
  ok('no-note x2: 07 filled', r.buckets.get('2026-07').sum === 230 && r.buckets.get('2026-08').sum === 230);
}

// ── No note, 690 (x3), all priors unpaid → 06+07+08 ──
{
  const b = bucket('2026-08', 690);
  const r = splitOverpayAcrossMonths(b, { chargeForMonth: charge230, isPaid: nonePaid });
  ok('x3 all unpaid: three months', r.split === true && r.buckets.size === 3);
  ok('x3 all unpaid: 06/07/08', ['2026-06','2026-07','2026-08'].every(m => r.buckets.get(m) && r.buckets.get(m).sum === 230));
}

// ── No note, 690, but July already PAID → skip July, fill 06+08, one month has leftover credit ──
{
  const paidJuly = (mk) => mk === '2026-07';
  const b = bucket('2026-08', 690);
  const r = splitOverpayAcrossMonths(b, { chargeForMonth: charge230, isPaid: paidJuly });
  ok('x3 skip paid July: split', r.split === true);
  ok('x3 skip paid July: never writes 07', !r.buckets.has('2026-07'));
  // priors gathered (mult-1=2) skipping July → 06 and 05; plus own 08 = three targets
  ok('x3 skip paid July: fills 05+06+08', r.buckets.get('2026-05') && r.buckets.get('2026-06') && r.buckets.get('2026-08'));
  // money conserved
  const tot = Array.from(r.buckets.values()).reduce((s,x)=>s+x.sum,0);
  ok('x3 skip paid July: money conserved 690', Math.abs(tot - 690) < 0.011);
}

// ── CONSERVATIVE leftover: 690 (x3) but only ONE unpaid prior available (rest paid) → fill that + own, remainder credit ──
{
  // every prior paid except June; so priors=[2026-06]; targets=[06,08]; place 2×230=460; leftover 230 → credit on 08
  const paidExceptJune = (mk) => mk !== '2026-06' && mk !== '2026-08';
  const b = bucket('2026-08', 690);
  const r = splitOverpayAcrossMonths(b, { chargeForMonth: charge230, isPaid: paidExceptJune });
  ok('leftover: split', r.split === true);
  ok('leftover: June filled 230', r.buckets.get('2026-06') && r.buckets.get('2026-06').sum === 230);
  ok('leftover: Aug carries own+credit = 460', r.buckets.get('2026-08') && Math.abs(r.buckets.get('2026-08').sum - 460) < 0.011);
  ok('leftover: never wrote a paid month', !r.buckets.has('2026-07') && !r.buckets.has('2026-05'));
  const tot = Array.from(r.buckets.values()).reduce((s,x)=>s+x.sum,0);
  ok('leftover: money conserved 690', Math.abs(tot - 690) < 0.011);
}

// ── x2 but NO unpaid priors at all → leave as advance credit (no split) ──
{
  const allPaid = (mk) => mk !== '2026-08'; // only own month unpaid
  const b = bucket('2026-08', 460);
  const r = splitOverpayAcrossMonths(b, { chargeForMonth: charge230, isPaid: allPaid });
  ok('x2 no unpaid priors → no split (stays credit)', r.split === false && r.buckets.get('2026-08').sum === 460);
}

// ── Tariff change: charge differs per month. 08 charge 250, 07 charge 230 → 480 splits ──
{
  const chargeVar = (mk) => mk === '2026-08' ? 250 : 230;
  // 08 alone: 500 = 2×250 clean → backfill 07(@230)+08(@250)=480, leftover 20 → credit on 08
  const b = bucket('2026-08', 500);
  const r = splitOverpayAcrossMonths(b, { chargeForMonth: chargeVar, isPaid: nonePaid });
  ok('tariff-var: split', r.split === true);
  ok('tariff-var: 07=230', r.buckets.get('2026-07') && r.buckets.get('2026-07').sum === 230);
  ok('tariff-var: 08=250+20 leftover=270', r.buckets.get('2026-08') && Math.abs(r.buckets.get('2026-08').sum - 270) < 0.011);
  const tot = Array.from(r.buckets.values()).reduce((s,x)=>s+x.sum,0);
  ok('tariff-var: money conserved 500', Math.abs(tot - 500) < 0.011);
}

// ── Note conflict: note names a DIFFERENT already-paid month → fall back to backfill ──
{
  // note "מאי אוגוסט" but מאי already paid → strategy A declines → backfill 07+08
  const paidMay = (mk) => mk === '2026-05';
  const b = bucket('2026-08', 460);
  const r = splitOverpayAcrossMonths(b, { chargeForMonth: charge230, isPaid: paidMay, note: 'מאי אוגוסט' });
  ok('note-conflict → backfill not May', r.split === true && !r.buckets.has('2026-05') && r.buckets.get('2026-07') && r.buckets.get('2026-08'));
}

// ── MUTATION direction 1: if trigger fired on non-multiple, the 250 test would split (proves guard active) ──
// (implicitly covered: 'partial/odd amount → no split' would fail if the multiple-guard were removed)
// ── MUTATION direction 2: if isPaid were ignored, 'x3 skip paid July' would write 2026-07 (proves guard active) ──

console.log(`\nsplit-overpay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
