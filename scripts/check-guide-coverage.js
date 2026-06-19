#!/usr/bin/env node
/* ============================================================================
 * check-guide-coverage.js — VaadPro guide-coverage linter
 * ----------------------------------------------------------------------------
 * מוודא שלכל טאב (switchTab('x')) ב-public/app.html קיים סקשן מתאים במדריך
 * (public/vaadpro-guide.js) — ישירות לפי id, או דרך מפת ALIAS.
 *
 * יוצא עם קוד 1 (ונכשל ב-CI/build) אם חסר ולו כיסוי אחד.
 *
 * הרצה:
 *   node scripts/check-guide-coverage.js
 *   node scripts/check-guide-coverage.js --json     # פלט מכונה
 * ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

// --- מיקומי קבצים (יחסית לשורש הפרויקט, בהנחה שהסקריפט תחת scripts/) ---
const ROOT = path.resolve(__dirname, '..');
const APP_HTML = path.join(ROOT, 'public', 'app.html');
const GUIDE_JS = path.join(ROOT, 'public', 'vaadpro-guide.js');

const asJson = process.argv.includes('--json');

function die(msg) {
  console.error('✖ ' + msg);
  process.exit(2); // 2 = שגיאת סביבה (קובץ חסר וכו'), נבדל מ-1 = כיסוי חסר
}

if (!fs.existsSync(APP_HTML)) die('לא נמצא: public/app.html (' + APP_HTML + ')');
if (!fs.existsSync(GUIDE_JS)) die('לא נמצא: public/vaadpro-guide.js (' + GUIDE_JS + ')');

const appSrc = fs.readFileSync(APP_HTML, 'utf8');
const guideSrc = fs.readFileSync(GUIDE_JS, 'utf8');

// --- 1) כל הטאבים: switchTab('x') / switchTab("x") — שם הטאב הוא הארגומנט הראשון ---
const tabs = new Set();
const tabRe = /switchTab\(\s*['"]([^'"]+)['"]/g;
let m;
while ((m = tabRe.exec(appSrc)) !== null) tabs.add(m[1]);

// --- 2) כל ה-SECTIONS ids במדריך: id: 'x' ---
const sectionIds = new Set();
const idRe = /\bid:\s*['"]([^'"]+)['"]/g;
while ((m = idRe.exec(guideSrc)) !== null) sectionIds.add(m[1]);

// --- 3) מפתחות ALIAS: לוכדים את הבלוק var ALIAS = { ... }; וקוראים את המפתחות ---
const aliasKeys = new Set();
const aliasBlock = guideSrc.match(/var\s+ALIAS\s*=\s*\{([\s\S]*?)\}\s*;/);
if (aliasBlock) {
  const keyRe = /([A-Za-z0-9_]+)\s*:/g;
  while ((m = keyRe.exec(aliasBlock[1])) !== null) aliasKeys.add(m[1]);
}

// --- 4) טאב "מכוסה" אם הוא id ישיר, או מפתח ALIAS שמצביע לסקשן קיים ---
function coveredBy(tab) {
  if (sectionIds.has(tab)) return 'id';
  if (aliasKeys.has(tab)) return 'alias';
  return null;
}

const missing = [];
const covered = [];
for (const tab of [...tabs].sort()) {
  const via = coveredBy(tab);
  if (via) covered.push({ tab, via });
  else missing.push(tab);
}

if (asJson) {
  console.log(JSON.stringify({
    tabs: [...tabs].sort(),
    sectionIds: [...sectionIds].sort(),
    aliasKeys: [...aliasKeys].sort(),
    covered, missing,
    ok: missing.length === 0
  }, null, 2));
} else {
  console.log('VaadPro — בדיקת כיסוי מדריך');
  console.log('  טאבים שנמצאו (switchTab): ' + tabs.size);
  console.log('  סקשנים במדריך (id):      ' + sectionIds.size);
  console.log('  מפתחות ALIAS:            ' + aliasKeys.size);
  console.log('');
  for (const c of covered) {
    console.log('  ✓ ' + c.tab + (c.via === 'alias' ? '  (דרך ALIAS)' : '  (id ישיר)'));
  }
  if (missing.length) {
    console.log('');
    console.error('✖ חסר סקשן מדריך לטאבים הבאים:');
    for (const t of missing) {
      console.error("    - switchTab('" + t + "')  →  הוסף SECTIONS{ id:'" + t +
        "' } או שורת ALIAS ב-vaadpro-guide.js");
    }
  }
}

if (missing.length) process.exit(1);
if (!asJson) console.log('\n✓ כל הטאבים מכוסים במדריך.');
process.exit(0);
