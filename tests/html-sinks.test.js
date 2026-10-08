// Guards against new XSS: untrusted text must not be built into HTML. (1) the shared escaper, (2) the sink scanner's
// own behaviour, (3) a ratchet: the number of not-obviously-safe HTML interpolations per file may not grow. Fix a
// finding, then lower the ratchet with: node scripts/scan-html-sinks.js --update-baseline
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
const { scanSource, scanTree, safe, countsByFile } = require('../scripts/scan-html-sinks.js');
const esc = require('../js/core/html-escape.js');

(async () => {
  console.log('the shared escaper');
  await t('escapes & < > " \' and ` so the result is safe in text and in quoted attributes', () => {
    assert.strictEqual(esc.html('<img src=x onerror="a(\'b\')">&`'), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;&#96;');
    assert.strictEqual(esc.attr('a" onmouseover="x'), 'a&quot; onmouseover=&quot;x');
  });
  await t('treats null/undefined as empty, numbers and objects as text, and is frozen', () => {
    assert.strictEqual(esc.html(null), ''); assert.strictEqual(esc.html(undefined), ''); assert.strictEqual(esc.html(0), '0');
    assert.strictEqual(esc.html({ toString: () => '<b>' }), '&lt;b&gt;');
    assert.ok(Object.isFrozen(esc));
  });
  await t('is loaded right after shield.js and is precached', () => {
    const html = read('index.html'), tags = Array.from(html.matchAll(/<script\b[^>]*>/g), (m) => m[0]);
    assert.strictEqual(tags[1], '<script src="js/core/html-escape.js">');
    assert.ok(read('sw.js').includes("'/js/core/html-escape.js'"));
  });

  console.log('the scanner');
  const scan = (code) => scanSource(code, 'x.js').findings.map((f) => f.expr);
  await t('flags raw interpolations and credits escapers, numbers and literal ternaries', () => {
    assert.deepStrictEqual(scan('el.innerHTML = `<b>${name}</b> ${CodeMiniEscape.html(name)} ${items.length} ${a ? "x" : "y"} ${Math.round(p*100)}`;'), ['name']);
  });
  await t('only credits a call that is the WHOLE expression (a trailing concatenation is flagged)', () => {
    assert.deepStrictEqual(scan('el.innerHTML = `${esc(a) + b}`;'), ['esc(a) + b']);
    assert.deepStrictEqual(scan('el.innerHTML = `${esc(a) + "<i>" + esc(b)}`;'), []);
  });
  await t('follows nested templates and string-looking text inside expressions', () => {
    const f = scan('el.innerHTML = `<ul>${rows.map(r => `<li title="${r.t}">${esc(r.n)}</li>`).join("")}</ul>`;');
    assert.deepStrictEqual(f, ['r.t']);
  });
  await t('finds outerHTML, += and insertAdjacentHTML, and ignores reads and comparisons', () => {
    assert.deepStrictEqual(scan('a.outerHTML = `${x}`; b.innerHTML += `${y}`; c.insertAdjacentHTML("beforeend", `${z}`);'), ['x', 'y', 'z']);
    assert.deepStrictEqual(scan('const h = el.innerHTML; if (el.innerHTML == "") {}  el.innerHTML = "";'), []);
  });
  await t('flags HTML that arrives indirectly (a variable) but not a plain literal', () => {
    assert.deepStrictEqual(scan('a.innerHTML = html; b.innerHTML = "<hr>"; c.innerHTML = \'\';'), ['html']);
  });
  await t('is not fooled by ; inside strings or comments in the expression', () => {
    assert.deepStrictEqual(scan('a.innerHTML = `x; ${v} // not a comment ${w}`;'), ['v', 'w']);
  });
  await t('safe() basics', () => {
    assert.ok(safe('escapeHtml(x)') && safe('gitEsc(a.b)') && safe('5') && safe('"lit"') && safe('rows.length'));
    assert.ok(!safe('name') && !safe('escapeHtml(a) + b') && !safe('esc(a)(b)'));
  });

  console.log('the ratchet');
  const baseline = JSON.parse(read('tests/fixtures/html-sinks-baseline.json'));
  const now = countsByFile(scanTree(root).findings);
  await t('no file has MORE not-obviously-safe HTML interpolations than the baseline (escape the new one, or use textContent)', () => {
    const worse = Object.keys(now).filter((f) => now[f] > (baseline[f] || 0)).map((f) => `${f}: ${baseline[f] || 0} -> ${now[f]}`);
    assert.deepStrictEqual(worse, [], 'new unescaped HTML interpolation(s); list them with: node scripts/scan-html-sinks.js');
  });
  await t('the baseline is tight: if you fixed findings, lower it (node scripts/scan-html-sinks.js --update-baseline)', () => {
    const slack = Object.keys(baseline).filter((f) => (now[f] || 0) < baseline[f]).map((f) => `${f}: ${baseline[f]} -> ${now[f] || 0}`);
    assert.deepStrictEqual(slack, []);
  });
  await t('the surfaces that carry file and archive names use the escaper', () => {
    const must = [['js/core/app.js', 'title="${CodeMiniEscape.html(file.name)}"'], ['js/core/search.js', 'CodeMiniEscape.html(matchData.file.name)'], ['js/viewers/archive.js', 'data-entry-path="${CodeMiniEscape.html(pathPrefix + name)}"'],
      ['js/core/editor.js', '<span>${CodeMiniEscape.html(title)}</span>'], ['js/core/editor.js', '<span>${CodeMiniEscape.html(f.name)}</span>'], ['js/git/stacks.js', 'CodeMiniEscape.html(t.name)'],
      ['js/terminal/terminal-commands.js', 'CodeMiniEscape.html(child.name)'], ['js/terminal/terminal-commands.js', 'CodeMiniEscape.html(f.name)']];
    for (const [f, needle] of must) assert.ok(read(f).includes(needle), `${f} must contain ${needle}`);
    for (const [f, needle] of [['js/notebook/notebook-kernels.js', 'CodeMiniEscape.sanitize(md.parse(text))'], ['js/viewers/docs.js', 'CodeMiniEscape.sanitize(bodyHTML, { allowStyle: true })'],
      ['js/viewers/preview.js', '__cmSanitize(marked.parse(rawMdText))'], ['js/terminal/console.js', 'CodeMiniEscape.sanitize(savedState.outputHtml'], ['js/terminal/terminal-window.js', 'CodeMiniEscape.sanitize(parsed.outputHtml']])
      assert.ok(read(f).includes(needle), `${f} must sanitize HTML that comes from a file or saved state: ${needle}`);
    assert.ok(/genModalText\.textContent = text/.test(read('js/core/app.js')), 'dialog text must be a text node');
    assert.ok(!/genModalText\.innerHTML/.test(read('js/core/app.js')));
  });
  await t('no inline onclick builds a JS string from page-controlled values with HTML-escaping alone (use JSON.stringify)', () => {
    const src = read('js/viewers/preview.js');
    assert.ok(!/\('\$\{escapeHtml\((e|entry)\.(key|reqId)\)\}'\)/.test(src) && !/, '\$\{escapeHtml\(e\.key\)\}'\)/.test(src));
  });

  console.log(`\n${n} html-sink checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
