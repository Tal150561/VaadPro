// ── lib-match-score.js — VaadPro bank-row → tenant TIERED MATCH SCORING (v2.14.41) ──
//
// ⚠️ REFERENCE COPY. The two RUNTIME copies live verbatim inside:
//     • server.js  → analyzeBankRowsServer  (Agent path)
//     • public/app.html → analyzeBankRows    (manual path)
// They MUST stay md5-identical to the body here (same discipline as
// splitOverpayAcrossMonths / kwMatches / bankRowFingerprint). A change here
// must be mirrored into both, and scripts/test-lib.js md5-checks parity.
//
// WHY THIS EXISTS (design locked with Tal, session 24, A+B):
// The legacy matcher is TENANT-CENTRIC and first-match-wins: it walks tenants
// in list order and the first tenant that matches a row claims it, silently.
// It never asks "does ONE row match 2+ tenants?" nor "who matches this row
// BEST?". Two bugs fall out:
//   (A) ambiguous multi-match — a row genuinely matching 2+ tenants is grabbed
//       by whoever appears first (real case: בן קרטר's 300 → wrong member).
//   (B) duplicate / overlapping search-keywords — "קרטר" shared by two members;
//       the .some() keyword test is a BOOLEAN ("at least one word hit"), so it
//       can't tell that "בן,קרטר"=2 hits beats "אריה,קרטר"=1 hit.
//
// THE FIX — a QUALITY-TIERED score per (row, tenant), compared tier-by-tier,
// strongest tier first. A stronger tier DOMINATES a weaker one (never summed):
//   TIER 4  apt  — note names an EXISTING apartment that is this tenant's, AND
//                  the tenant also matches the row by name/keyword (tie-breaker,
//                  never a standalone matcher — preserves the v2.14.24 bugfix).
//   TIER 3  name — every part of the full name (≥2 parts) appears in the row.
//   TIER 2  kw   — number of DISTINCT search-keywords that word-boundary-match.
//                  (This is the (B) upgrade: a COUNT, not a boolean.)
//   TIER 1  phone— last-7 phone digits appear in the digit-collapsed row.
//                  Weakest & noisiest in a bank file ( references/accounts are
//                  digits too), so it only ever breaks a tie no higher tier did.
//   TIER 0  none — no match at all; not a candidate.
//
// Ranking key per candidate = [tier, kwCount] compared lexicographically:
//   • higher tier wins outright;
//   • within TIER 2 (kw) the larger kwCount wins ("בן,קרטר"=2 > "קרטר"=1);
//   • for TIER 3/4/1 kwCount is carried only as a secondary informational value
//     and does NOT change the tier decision.
// A row is AMBIGUOUS iff, after ranking, ≥2 candidates share the SAME top
// [tier,kwCount] — a genuine tie no signal could break. Those go to the panel.
// A lone top candidate WINS and is written silently, exactly as before.
//
// NOTE ON SCOPE: this module decides WHO a row belongs to. It does NOT touch
// money, dedup, or month logic — the caller still fingerprints, groups by month,
// and writes. Ambiguous rows are simply never written; they are queued.

'use strict';

// Word-bounded keyword test — IDENTICAL semantics to the legacy kwMatches, but
// returns a COUNT of distinct matching keywords instead of a boolean. The
// boolean form is exactly (kwMatchCount(...) > 0), so callers that only need
// yes/no stay correct.
function kwMatchCount(kws, rt) {
  if (!kws || !kws.length) return 0;
  var n = 0;
  for (var i = 0; i < kws.length; i++) {
    var k = kws[i];
    if (!k || k.length < 2) continue;
    var esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(?:^|[\\s,/(-])' + esc + '(?=[\\s,/)-]|$)').test(rt)) n++;
  }
  return n;
}

// Score ONE (row, tenant) pair → { tier, kwCount, matchType } or null when the
// tenant does not match the row at all.
//   fields: normalized inputs the caller already computes per tenant:
//     kw        : string[]  lowercased, trimmed, non-empty search keywords
//     ps        : string    last-7 phone digits ('' if none)
//     nameParts : string[]  lowercased name parts length>1
//     aptNum    : string    numeric apartment ('' if none)
//   row inputs:
//     rt        : string    lowercased search text (name column, or whole row)
//     rtDigits  : string    rtFull with all non-digits stripped (for phone)
//     noteApts  : string[]  numeric apt strings extracted from the note
//   aptBlocked  : boolean   note names ANOTHER existing tenant's apt whose owner
//                           also matches this row (the v2.14.24 guard) → weak
//                           tiers (kw/phone/name) are suppressed for THIS tenant.
function scoreTenantRowMatch(fields, rt, rtDigits, noteApts, aptBlocked) {
  var kw = fields.kw || [];
  var ps = fields.ps || '';
  var nameParts = fields.nameParts || [];
  var aptNum = fields.aptNum || '';
  var kwCount = kwMatchCount(kw, rt);
  var phoneHit = !!(ps && rtDigits.indexOf(ps) >= 0);
  var uniqParts = nameParts.filter(function (p, i) { return nameParts.indexOf(p) === i; });
  var nameHit = uniqParts.length >= 2 && uniqParts.every(function (p) { return rt.indexOf(p) >= 0; });
  var nameBasisMatch = (kwCount > 0) || phoneHit || nameHit;
  if (aptNum && noteApts.indexOf(aptNum) >= 0 && nameBasisMatch) {
    return { tier: 4, kwCount: kwCount, matchType: 'apt' };
  }
  if (aptBlocked) return null;
  if (nameHit)      return { tier: 3, kwCount: kwCount, matchType: 'name' };
  if (kwCount > 0)  return { tier: 2, kwCount: kwCount, matchType: 'keyword' };
  if (phoneHit)     return { tier: 1, kwCount: kwCount, matchType: 'phone' };
  return null;
}

// Compare two scores by [tier, kwCount]. >0 ⇒ a ranks ABOVE b.
function compareScore(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.tier === 2 && b.tier === 2) return a.kwCount - b.kwCount;
  return 0;
}

// Given all scored candidates for ONE row, return { winner, ambiguous, top }.
//   candidates: [{ id, score }]  (score = output of scoreTenantRowMatch, non-null)
//   winner    : the single top candidate id, or null when ambiguous / none
//   ambiguous : true when ≥2 candidates share the top [tier,kwCount]
//   top       : the array of top-ranked candidates (length 1 ⇒ winner,
//               length ≥2 ⇒ the tie that goes to the panel)
function resolveRowCandidates(candidates) {
  if (!candidates || !candidates.length) return { winner: null, ambiguous: false, top: [] };
  var best = candidates[0];
  for (var i = 1; i < candidates.length; i++) {
    if (compareScore(candidates[i].score, best.score) > 0) best = candidates[i];
  }
  var top = candidates.filter(function (c) { return compareScore(c.score, best.score) === 0; });
  if (top.length === 1) return { winner: top[0].id, ambiguous: false, top: top };
  return { winner: null, ambiguous: true, top: top };
}

// ── (B) setup-time keyword-uniqueness — SOFT WARNING, never blocks ──────────
// Design (locked with Tal, session 24): duplicate/overlapping keywords across
// members are a LEGITIMATE state (two "כהן", father+son). We do NOT block and
// we do NOT route to the panel on this basis alone — the tiered scorer already
// separates them when any other signal differs. This is a HELPFUL heads-up at
// setup: "consider adding a distinguisher (apt / gush-chelka)". Exact-match on
// the normalized keyword (trim+lowercase), as the design fixed for (B).
//
// findKeywordCollisions(tenants[, opts]) → array of collisions:
//   [{ keyword, members: [{ id, name }] }]  (only keywords shared by ≥2 members)
//   opts.excludeId  : ignore this tenant id (for edit — compare against OTHERS)
//   opts.extraKeywords / opts.extraName / opts.extraId : a not-yet-saved member
//     (add/edit form) to test against the existing list.
//
// v2.14.41 refinement (Tal, session 24): SUPPRESS a shared keyword when the
// members sharing it are already separable by OTHER keywords — i.e. every
// sharer also owns at least one keyword that none of the other sharers has.
// Example: נועה="נועה,ברקן" + עומר="עומר,ברקן" share "ברקן", but each has a
// unique word (נועה / עומר) that the tiered matcher uses to win outright, so a
// real "נועה ברקן" / "עומר ברקן" row never reaches the panel — no warning
// needed. We still warn when the shared keyword is the ONLY separator (a bare
// "ברקן" row would tie), so the user knows to add a distinguisher.
function findKeywordCollisions(tenants, opts) {
  opts = opts || {};
  var map = {};    // keyword → [{id,name}]
  var kwSets = {}; // member id → { keyword: 1 }
  function addMember(id, name, kwString) {
    if (opts.excludeId != null && id === opts.excludeId) return;
    var kws = String(kwString || '').split(',')
      .map(function (k) { return k.trim().toLowerCase(); }).filter(Boolean);
    var seen = {};
    kwSets[id] = kwSets[id] || {};
    kws.forEach(function (k) {
      if (k.length < 2 || seen[k]) return;
      seen[k] = 1;
      kwSets[id][k] = 1;
      (map[k] = map[k] || []).push({ id: id, name: name || '' });
    });
  }
  (tenants || []).forEach(function (t) { addMember(t.id, t.name, t.keywords); });
  if (opts.extraKeywords != null) {
    addMember(opts.extraId != null ? opts.extraId : '__new__', opts.extraName || '', opts.extraKeywords);
  }
  var out = [];
  Object.keys(map).forEach(function (k) {
    var sharers = map[k];
    if (sharers.length < 2) return;
    var everySeparable = sharers.every(function (mem) {
      var mine = kwSets[mem.id] || {};
      return Object.keys(mine).some(function (w) {
        if (w === k) return false;
        return !sharers.some(function (other) {
          return other.id !== mem.id && (kwSets[other.id] || {})[w];
        });
      });
    });
    if (!everySeparable) out.push({ keyword: k, members: sharers });
  });
  return out;
}

module.exports = { kwMatchCount, scoreTenantRowMatch, compareScore, resolveRowCandidates, findKeywordCollisions };
