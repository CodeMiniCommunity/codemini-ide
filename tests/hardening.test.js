// Page-level hardening that is easy to undo by accident: referrer policy, third-party scripts, how links and pop-ups
// are opened, CI permissions, and the SRI tool (tested offline with made-up hashes; it needs network for real ones).
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
const { findExternal, applyIntegrity } = require('../scripts/sri.js');
const html = read('index.html');

// Third-party files that had no integrity attribute when this check was added. A NEW third-party script or
// stylesheet without one fails the test; run `node scripts/sri.js` to fill these in, then empty this list.
const SRI_PENDING = new Set([
  'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.39.0/min/vs/loader.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js',
  'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js',
  'https://cdn.jsdelivr.net/npm/remixicon@3.5.0/fonts/remixicon.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
]);

(async () => {
  console.log('the page');
  await t('sends only the origin to other sites (explicit referrer policy)', () => {
    assert.ok(/<meta name="referrer" content="strict-origin-when-cross-origin">/.test(html));
  });
  await t('every third-party script/stylesheet is pinned to a version, uses https, and has integrity unless it is on the known pending list', () => {
    const ext = findExternal(html);
    assert.ok(ext.length >= 5);
    const noSri = [];
    for (const e of ext) {
      assert.ok(/\d+\.\d+/.test(e.url), 'not pinned to a version: ' + e.url);
      assert.ok(!/@latest|\/latest\//.test(e.url), 'floating version: ' + e.url);
      if (e.integrity) {
        assert.ok(/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(e.integrity.split(/\s+/)[0]), 'malformed integrity on ' + e.url);
        assert.ok(/crossorigin=/.test(e.tag), 'integrity needs crossorigin on ' + e.url);
      } else noSri.push(e.url);
    }
    const unexpected = noSri.filter((u) => !SRI_PENDING.has(u));
    assert.deepStrictEqual(unexpected, [], 'new third-party resource without integrity (run node scripts/sri.js)');
    if (noSri.length) console.log(`     note: ${noSri.length} third-party resource(s) still have no integrity; run: node scripts/sri.js`);
  });
  await t('no plain http:// subresources in the page', () => {
    assert.ok(!/(src|href)="http:\/\//i.test(html));
  });

  console.log('links and pop-ups');
  await t('every window.open with a URL passes noopener (the notebook print window is the one deliberate exception: it needs its handle)', () => {
    const files = [];
    (function walk(d) { for (const f of fs.readdirSync(path.join(root, d))) { const p = d + '/' + f; fs.statSync(path.join(root, p)).isDirectory() ? walk(p) : /\.js$/.test(f) && files.push(p); } })('js');
    const bad = [];
    for (const f of files) for (const m of read(f).matchAll(/window\.open\(([^)]*)\)/g)) {
      const a = m[1].trim();
      if (/^''\s*,/.test(a) || /^""\s*,/.test(a)) continue; // window.open('', '_blank') then writes into it
      if (!/noopener/.test(a)) bad.push(f + ': window.open(' + a.slice(0, 60) + ')');
    }
    assert.deepStrictEqual(bad, []);
  });
  await t('every link that opens a new tab has rel="noopener" (so it cannot reach window.opener)', () => {
    const files = ['index.html'];
    (function walk(d) { for (const f of fs.readdirSync(path.join(root, d))) { const p = d + '/' + f; fs.statSync(path.join(root, p)).isDirectory() ? walk(p) : /\.js$/.test(f) && files.push(p); } })('js');
    const bad = [];
    for (const f of files) read(f).split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/target="_blank"/.test(line) && !/noopener/.test(line)) bad.push(f + ':' + (i + 1));
    });
    assert.deepStrictEqual(bad, []);
  });

  console.log('CI and supply chain');
  await t('CI runs with read-only repository permissions', () => {
    const ci = read('.github/workflows/ci.yml');
    assert.ok(/^permissions:\s*\n\s+contents: read\s*$/m.test(ci));
    assert.ok(!/contents: write|permissions: write-all/.test(ci));
  });
  await t('Dependabot keeps GitHub Actions and npm dependencies current', () => {
    const d = read('.github/dependabot.yml');
    assert.ok(/package-ecosystem: "github-actions"/.test(d) && /package-ecosystem: "npm"/.test(d));
  });

  console.log('the SRI tool (offline, made-up hashes)');
  const H = { 'https://cdn.example/a.js': 'sha384-AAAA', 'https://cdn.example/b.css': 'sha384-BBBB', 'https://cdn.example/c.js': 'sha384-CCCC' };
  const page = [
    '<script src="js/core/shield.js"></script>',
    '<script src="https://cdn.example/a.js"></script>',
    '<link href="https://cdn.example/b.css" rel="stylesheet">',
    '<link rel="stylesheet" href="https://cdn.example/b.css" />',
    '<script src="https://cdn.example/c.js" integrity="sha384-KEEP" crossorigin="anonymous"></script>',
    '<link rel="icon" href="https://cdn.example/favicon.png">',
    '<script>var x = "https://cdn.example/a.js";</script>'
  ].join('\n');
  await t('finds only real third-party scripts and stylesheets (not local files, icons or inline text)', () => {
    assert.deepStrictEqual(findExternal(page).map((e) => e.url), ['https://cdn.example/a.js', 'https://cdn.example/b.css', 'https://cdn.example/b.css', 'https://cdn.example/c.js']);
  });
  await t('adds integrity + crossorigin to the right tags, keeps everything else byte-for-byte, and is idempotent', () => {
    const out = applyIntegrity(page, H), lines = out.split('\n');
    assert.strictEqual(lines[0], '<script src="js/core/shield.js"></script>');
    assert.strictEqual(lines[1], '<script src="https://cdn.example/a.js" integrity="sha384-AAAA" crossorigin="anonymous"></script>');
    assert.strictEqual(lines[2], '<link href="https://cdn.example/b.css" rel="stylesheet" integrity="sha384-BBBB" crossorigin="anonymous">');
    assert.strictEqual(lines[3], '<link rel="stylesheet" href="https://cdn.example/b.css" integrity="sha384-BBBB" crossorigin="anonymous" />');
    assert.strictEqual(lines[4], page.split('\n')[4], 'an existing integrity is never replaced');
    assert.strictEqual(lines[5], page.split('\n')[5]); assert.strictEqual(lines[6], page.split('\n')[6]);
    assert.strictEqual(applyIntegrity(out, H), out);
  });
  await t('applied to the real index.html with fake hashes it changes only those five tags and the page still parses the same', () => {
    const fake = {}; for (const e of findExternal(html)) fake[e.url] = 'sha384-FAKE';
    const out = applyIntegrity(html, fake);
    const before = html.split('\n'), after = out.split('\n');
    assert.strictEqual(before.length, after.length);
    const changed = before.map((l, i) => [l, after[i]]).filter(([a, b]) => a !== b);
    assert.strictEqual(changed.length, findExternal(html).filter((e) => !e.integrity).length);
    for (const [a, b] of changed) assert.strictEqual(b.replace(' integrity="sha384-FAKE" crossorigin="anonymous"', ''), a);
  });

  console.log(`\n${n} hardening checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
