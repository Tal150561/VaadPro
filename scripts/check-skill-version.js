#!/usr/bin/env node
// check-skill-version.js (v2.14.69) — release hygiene, NOT part of `npm test`
// (the SKILL file is not always committed to the repo). Verifies that the version in
// package.json, app.html HTML_VERSION, the SKILL file name, its "**Current version**"
// line and its START HERE "CURRENT VERSION" all agree.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json')).version;
const app = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
const html = (app.match(/const HTML_VERSION = '([^']+)'/) || [])[1];
const skills = fs.readdirSync(root).filter(f => /^SKILL-vaadpro-v[\d_]+\.md$/.test(f));
const problems = [];
if (html !== pkg) problems.push(`HTML_VERSION ${html} ≠ package.json ${pkg}`);
if (skills.length !== 1) problems.push(`expected exactly one SKILL-vaadpro-v*.md in the repo root, found ${skills.length}: ${skills.join(', ') || '—'}`);
else {
  const f = skills[0], fileVer = f.replace(/^SKILL-vaadpro-v/, '').replace(/\.md$/, '').replace(/_/g, '.');
  const sk = fs.readFileSync(path.join(root, f), 'utf8');
  const cur = (sk.match(/\*\*Current version\*\*: v([\d.]+)/) || [])[1];
  const start = (sk.match(/CURRENT VERSION v([\d.]+)/) || [])[1];
  if (fileVer !== pkg) problems.push(`SKILL file name ${f} ≠ package.json ${pkg}`);
  if (cur !== pkg) problems.push(`SKILL "**Current version**" = ${cur || 'missing'} ≠ ${pkg}`);
  if (start !== pkg) problems.push(`SKILL START HERE "CURRENT VERSION" = ${start || 'missing'} ≠ ${pkg}`);
}
if (problems.length) { console.error('❌ version mismatch:\n  - ' + problems.join('\n  - ')); process.exit(1); }
console.log(`✅ version ${pkg}: package.json · HTML_VERSION · SKILL file · Current version · START HERE — all agree`);
