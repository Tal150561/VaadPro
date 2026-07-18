// ════════════════════════════════════════════════════════════════
// check-syntax.js — parse every inline <script> block in the pages
// Run: npm test    (or: node scripts/check-syntax.js)
// ════════════════════════════════════════════════════════════════
// app.html carries three separate script blocks and contains three decoy
// "</body>" strings inside JS template literals, so a naive check can miss a
// block entirely. This parses each block on its own and names the file+index
// when one fails.
//
// ⚠️ LIMITATION worth remembering: this only PARSES. `node --check` happily
// accepts an undefined variable — that is how the v2.13.11 (selectOS) and
// v2.13.12 (historyDebt) ReferenceErrors both shipped. Parsing is necessary,
// not sufficient: test-render-frontend.js is what actually EXECUTES the code.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PAGES = ['public/app.html', 'public/tenant-portal.html', 'public/admin.html', 'public/index.html'];
const STANDALONE = ['server.js', 'public/vaadpro-guide.js'];

let failed = 0;

for (const rel of STANDALONE) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
    console.log('  ✓ ' + rel);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + rel + '\n' + String(e.stderr || e.message).split('\n').slice(0, 4).map(l => '      ' + l).join('\n'));
  }
}

for (const rel of PAGES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  const blocks = src.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g) || [];
  let i = 0;
  for (const raw of blocks) {
    const body = raw.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    if (!body.trim()) { i++; continue; }
    const tmp = path.join(os.tmpdir(), 'vp-syntax-' + process.pid + '-' + i + '.js');
    fs.writeFileSync(tmp, body);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      console.log('  ✓ ' + rel + ' [block ' + i + ', ' + body.split('\n').length + ' lines]');
    } catch (e) {
      failed++;
      console.log('  ✗ ' + rel + ' [block ' + i + ']\n' +
        String(e.stderr || e.message).split('\n').slice(0, 5).map(l => '      ' + l).join('\n'));
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    i++;
  }
}

console.log('\n  ' + (failed === 0 ? '✅ syntax: all files parse' : '❌ syntax: ' + failed + ' failure(s)'));
process.exit(failed ? 1 : 0);
