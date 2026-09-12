// ── test-match-score.js — unit tests for the tiered bank-row matcher (v2.14.41) ──
// Run: node scripts/test-match-score.js   (also wired into `npm test` via test:match)
'use strict';
var L = require('./lib-match-score.js');
var pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name); } }
function eq(a, b, name) { ok(a === b, name + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

// helper: build normalized tenant fields like the matcher does
function F(o) {
  return {
    kw: (o.keywords || '').split(',').map(function (k) { return k.trim().toLowerCase(); }).filter(Boolean),
    ps: (o.phone || '').replace(/\D/g, '').slice(-7),
    nameParts: (o.name || '').trim().toLowerCase().split(/\s+/).filter(function (p) { return p.length > 1; }),
    aptNum: o.aptNumber != null ? String(o.aptNumber).replace(/\D/g, '') : ''
  };
}
function digits(s) { return s.replace(/\D/g, ''); }

console.log('\n  ── kwMatchCount: count, not boolean ──');
// name-column text (payer name), as the matcher searches rt = nameVal
eq(L.kwMatchCount(['קרטר'], 'בן קרטר'), 1, 'one keyword hit → 1');
eq(L.kwMatchCount(['בן', 'קרטר'], 'בן קרטר'), 2, 'two keyword hits → 2');
eq(L.kwMatchCount(['אריה', 'קרטר'], 'בן קרטר'), 1, 'only קרטר hits for אריה → 1');
eq(L.kwMatchCount([], 'x'), 0, 'no keywords → 0');
eq(L.kwMatchCount(['א'], 'א ב ג'), 0, 'sub-2-char keyword ignored → 0');
eq(L.kwMatchCount(['רון'], 'אהרון כהן'), 0, 'word-boundary: רון does NOT match inside אהרון');
eq(L.kwMatchCount(['רון'], 'רון כהן'), 1, 'word-boundary: רון matches standalone');

console.log('\n  ── scoreTenantRowMatch: tiers ──');
(function () {
  var rt = 'בן קרטר';
  var arie = L.scoreTenantRowMatch(F({ name: 'אריה קרטר', keywords: 'אריה,קרטר' }), rt, digits(rt), [], false);
  var ben = L.scoreTenantRowMatch(F({ name: 'בן קרטר', keywords: 'בן,קרטר' }), rt, digits(rt), [], false);
  // Both share surname; ben's full name is fully present, arie's is not.
  eq(ben.tier, 3, 'בן matches full name → tier 3');
  eq(arie.tier, 2, 'אריה only keyword (surname) → tier 2');
  ok(L.compareScore(ben, arie) > 0, 'בן ranks above אריה');
})();

(function () {
  // Full name NOT fully present for either → decide by keyword COUNT (tier 2 vs tier 2)
  var rt = 'קרטר בן'; // both keyword words present but neither full name (2 parts) fully ordered-present is fine, so give non-matching names
  var arie = L.scoreTenantRowMatch(F({ name: 'אריה כהן', keywords: 'אריה,קרטר' }), rt, digits(rt), [], false);
  var ben = L.scoreTenantRowMatch(F({ name: 'דוד לוי', keywords: 'בן,קרטר' }), rt, digits(rt), [], false);
  eq(arie.tier, 2, 'אריה tier 2 (only קרטר)');
  eq(arie.kwCount, 1, 'אריה kwCount 1');
  eq(ben.tier, 2, 'בן tier 2');
  eq(ben.kwCount, 2, 'בן kwCount 2 (בן+קרטר)');
  ok(L.compareScore(ben, arie) > 0, 'within tier 2, higher kwCount wins');
})();

console.log('\n  ── phone is the weakest tier ──');
(function () {
  var rt = 'העברה 0523456789 אסמכתא 12345';
  var d = digits(rt);
  var s = L.scoreTenantRowMatch(F({ name: 'דוד לוי', phone: '0523456789' }), rt, d, [], false);
  eq(s.tier, 1, 'phone-only → tier 1');
  // a keyword candidate must outrank a phone candidate
  var kwc = L.scoreTenantRowMatch(F({ name: 'x y', keywords: 'אסמכתא' }), rt, d, [], false);
  eq(kwc.tier, 2, 'keyword → tier 2');
  ok(L.compareScore(kwc, s) > 0, 'keyword (tier2) outranks phone (tier1)');
})();

console.log('\n  ── apt tier is a tie-breaker, never standalone ──');
(function () {
  var rt = 'בן קרטר';
  var note = ['11'];
  // tenant HAS apt 11 in note AND matches by name → tier 4
  var withName = L.scoreTenantRowMatch(F({ name: 'בן קרטר', keywords: 'קרטר', aptNumber: '11' }), rt, digits(rt), note, false);
  eq(withName.tier, 4, 'apt in note + name match → tier 4 (apt)');
  // tenant HAS apt 11 in note but does NOT match by name/keyword → NOT tier 4, null
  var noName = L.scoreTenantRowMatch(F({ name: 'משה לוי', keywords: 'סתם', aptNumber: '11' }), rt, digits(rt), note, false);
  ok(noName === null, 'apt number alone (no name/kw basis) → no match (v2.14.24 invariant)');
})();

console.log('\n  ── aptBlocked suppresses weak tiers (v2.14.24 guard) ──');
(function () {
  var rt = 'כהן דוד';
  // note points at ANOTHER owner's apt → this tenant blocked from kw/name/phone
  var blocked = L.scoreTenantRowMatch(F({ name: 'כהן דוד', keywords: 'כהן' }), rt, digits(rt), ['4'], true);
  ok(blocked === null, 'aptBlocked → weak-tier match suppressed');
  // but an apt-tier match for the tenant is NOT suppressed by aptBlocked
  var ownApt = L.scoreTenantRowMatch(F({ name: 'כהן דוד', keywords: 'כהן', aptNumber: '4' }), rt, digits(rt), ['4'], true);
  eq(ownApt && ownApt.tier, 4, 'own apt in note still scores tier 4 even under aptBlocked');
})();

console.log('\n  ── resolveRowCandidates: winner vs ambiguous ──');
(function () {
  // lone top → winner
  var r1 = L.resolveRowCandidates([
    { id: 'a', score: { tier: 3, kwCount: 0 } },
    { id: 'b', score: { tier: 2, kwCount: 1 } }
  ]);
  eq(r1.winner, 'a', 'lone tier-3 → winner a');
  eq(r1.ambiguous, false, 'not ambiguous');

  // genuine tie at top → ambiguous, no winner
  var r2 = L.resolveRowCandidates([
    { id: 'a', score: { tier: 2, kwCount: 1 } },
    { id: 'b', score: { tier: 2, kwCount: 1 } }
  ]);
  eq(r2.winner, null, 'tie → no winner');
  eq(r2.ambiguous, true, 'tie → ambiguous');
  eq(r2.top.length, 2, 'both in top');

  // kwCount breaks the tie inside tier 2
  var r3 = L.resolveRowCandidates([
    { id: 'a', score: { tier: 2, kwCount: 1 } },
    { id: 'b', score: { tier: 2, kwCount: 2 } }
  ]);
  eq(r3.winner, 'b', 'higher kwCount wins tier-2');
  eq(r3.ambiguous, false, 'not ambiguous when kwCount differs');

  // empty → nothing
  var r4 = L.resolveRowCandidates([]);
  eq(r4.winner, null, 'no candidates → no winner');
  eq(r4.ambiguous, false, 'no candidates → not ambiguous');

  // three candidates, one clear tier-4 winner over two tier-2
  var r5 = L.resolveRowCandidates([
    { id: 'a', score: { tier: 2, kwCount: 2 } },
    { id: 'b', score: { tier: 4, kwCount: 1 } },
    { id: 'c', score: { tier: 2, kwCount: 2 } }
  ]);
  eq(r5.winner, 'b', 'tier-4 beats two tier-2s');
})();

console.log('\n  ── compareScore: tier dominates kwCount across tiers ──');
ok(L.compareScore({ tier: 3, kwCount: 0 }, { tier: 2, kwCount: 9 }) > 0, 'tier 3 (0 kw) beats tier 2 (9 kw)');
ok(L.compareScore({ tier: 1, kwCount: 5 }, { tier: 2, kwCount: 0 }) < 0, 'phone never beats keyword');
eq(L.compareScore({ tier: 3, kwCount: 1 }, { tier: 3, kwCount: 9 }), 0, 'kwCount does NOT reorder within name tier');

console.log('\n  ── findKeywordCollisions (B): setup-time soft warning ──');
(function () {
  // נועה/עומר share "ברקן" BUT each has a unique word → SUPPRESSED (Tal's case)
  var separable = [
    { id: 1, name: 'נועה ברקן', keywords: 'נועה,ברקן' },
    { id: 2, name: 'עומר ברקן', keywords: 'עומר,ברקן' }
  ];
  eq(L.findKeywordCollisions(separable).length, 0, 'shared surname but unique first names → suppressed');

  // shared keyword is the ONLY separator → WARN
  var tied = [
    { id: 1, name: 'כהן א', keywords: 'כהן' },
    { id: 2, name: 'כהן ב', keywords: 'כהן' }
  ];
  var c = L.findKeywordCollisions(tied);
  eq(c.length, 1, 'only-shared keyword → warn');
  eq(c[0].keyword, 'כהן', 'the tied keyword is כהן');
  eq(c[0].members.length, 2, 'shared by 2 members');

  // three-way: two separable by unique words, one bare → still warn (the bare one ties)
  var mixed = [
    { id: 1, name: 'נועה ברקן', keywords: 'נועה,ברקן' },
    { id: 2, name: 'עומר ברקן', keywords: 'עומר,ברקן' },
    { id: 3, name: 'ברקן סתם', keywords: 'ברקן' }
  ];
  eq(L.findKeywordCollisions(mixed).length, 1, 'a bare sharer with no unique word → warn on ברקן');

  // no collisions when all unique
  var c2 = L.findKeywordCollisions([
    { id: 1, name: 'א', keywords: 'aaa' },
    { id: 2, name: 'ב', keywords: 'bbb' }
  ]);
  eq(c2.length, 0, 'all-unique → no collisions');

  // excludeId: editing member 2 should compare against others only
  var c3 = L.findKeywordCollisions(tied, { excludeId: 2 });
  eq(c3.length, 0, 'excludeId drops the collision when the other holder is excluded');

  // extraKeywords: a not-yet-saved add-form value that collides on the ONLY word
  var c4 = L.findKeywordCollisions(
    [{ id: 1, name: 'כהן א', keywords: 'כהן' }],
    { extraKeywords: 'כהן', extraName: 'כהן ב' }
  );
  eq(c4.length, 1, 'new member sharing the only keyword → collision surfaced');
  eq(c4[0].members.length, 2, 'existing + new both listed');

  // extra member that shares surname but has a unique first name → suppressed
  var c4b = L.findKeywordCollisions(
    [{ id: 1, name: 'נועה ברקן', keywords: 'נועה,ברקן' }],
    { extraKeywords: 'עומר,ברקן', extraName: 'עומר ברקן' }
  );
  eq(c4b.length, 0, 'new member with unique first name → suppressed');

  // intra-member duplicate keyword is not a cross-member collision
  var c5 = L.findKeywordCollisions([{ id: 1, name: 'x', keywords: 'כהן,כהן' }]);
  eq(c5.length, 0, 'same keyword twice on ONE member is not a collision');

  // sub-2-char keywords ignored
  var c6 = L.findKeywordCollisions([
    { id: 1, name: 'x', keywords: 'א' },
    { id: 2, name: 'y', keywords: 'א' }
  ]);
  eq(c6.length, 0, 'sub-2-char shared keyword ignored');
})();

console.log('\n  ── duplicate name-parts must not fake a full-name match (כהן כהן bug) ──');
(function () {
  // "כהן כהן" has a repeated word; a bare "כהן" row must NOT count as a full-name
  // match (tier 3) that beats a plain keyword match — both should tie → panel.
  var rt = 'כהן';
  var lo = L.scoreTenantRowMatch(F({ name: 'כהן לוי', keywords: 'כהן' }), rt, digits(rt), [], false);
  var ko = L.scoreTenantRowMatch(F({ name: 'כהן כהן', keywords: 'כהן' }), rt, digits(rt), [], false);
  eq(lo.tier, 2, 'כהן לוי → tier 2 (keyword)');
  eq(ko.tier, 2, 'כהן כהן → tier 2 (NOT a fake full-name tier 3)');
  var v = L.resolveRowCandidates([{ id: 1, score: lo }, { id: 2, score: ko }]);
  eq(v.ambiguous, true, 'both כהן → ambiguous → panel');
  // regression: a genuine two-word name still matches at tier 3
  var full = L.scoreTenantRowMatch(F({ name: 'נועה ברקן', keywords: 'נועה,ברקן' }), 'נועה ברקן', digits('נועה ברקן'), [], false);
  eq(full.tier, 3, 'genuine full name still tier 3');
})();

console.log('\n' + (fail === 0 ? '  ✅ match-score: ' + pass + ' passed' : '  ❌ match-score: ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
