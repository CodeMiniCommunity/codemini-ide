// CodeMiniEscape.sanitize in a real browser: hostile HTML must come out inert, ordinary Markdown must survive,
// and the function must behave identically when embedded as source text (the Markdown preview iframe does that).
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };

const PAYLOADS = [
  '<img src=x onerror="window.__x=1">',
  '<script>window.__x=2</script>',
  '<a href="javascript:window.__x=3">c</a>',
  '<a href="  jA\tvA\nscript:window.__x=4">c</a>',
  '<svg onload="window.__x=5"></svg>',
  '<svg><script>window.__x=6</script></svg>',
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=window.__x=7&gt;">',
  '<noscript><p title="</noscript><img src=x onerror=window.__x=8>">',
  '<iframe srcdoc="<script>parent.__x=9</script>"></iframe>',
  '<form action="javascript:window.__x=10"><button>x</button></form>',
  '<input type=image src=x onerror=window.__x=11>',
  '<details open ontoggle="window.__x=12">x</details>',
  '<style>@import "x";</style><p>y</p>',
  '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
  '<img src="javascript:window.__x=15">',
  '<a href="data:text/html,<script>window.__x=16</script>">x</a>',
  '<div id="x" name="y" onclick="window.__x=17">t</div>',
  '<object data="x"></object><embed src="x">',
  '<base href="https://evil.example/">',
  '<meta http-equiv=refresh content="0;url=javascript:window.__x=20">',
  '<textarea><img src=x onerror=window.__x=22></textarea>',
  '<template><img src=x onerror=window.__x=23></template>',
  '<video><source onerror="window.__x=25"></video>',
  '<a href="https://ok.example/" target="_blank" onclick="window.__x=26">x</a>',
  '<p style="background:url(javascript:window.__x=27)">s</p>',
  '<x-foo onclick=window.__x=28>unknown</x-foo>',
  '<img src=x onerror=window.__x=29//',
  '<<script>window.__x=30//<</script>',
  '<a href="&#106;avascript:window.__x=31">e</a>',
  '<table><tr><td><img src=x onerror=window.__x=32></td></tr></table>'
];

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto('http://localhost:8765/index.html'); await sleep(3500);
  const ev = (f, a) => page.evaluate(f, a);

  console.log('\n[hostile input is inert]');
  const res = await ev(async (PAYLOADS) => {
    const out = [];
    for (const [i, p] of PAYLOADS.entries()) {
      for (const allowStyle of [false, true]) {
        const clean = CodeMiniEscape.sanitize(p, { allowStyle });
        const host = document.createElement('div'); document.body.appendChild(host); host.innerHTML = clean;
        await new Promise(r => setTimeout(r, 40));
        const bad = /<(script|iframe|svg|math|style|form|object|embed|base|meta|link|template|noscript|textarea|video|button)\b/i.test(clean)
          || /\son[a-z]+\s*=/i.test(clean) || /javascript:/i.test(clean) || /srcdoc|\sid=|\sname=|target=/i.test(clean) || /data:(?!image\/(png|jpe?g|gif|webp|bmp))/i.test(clean);
        const again = CodeMiniEscape.sanitize(clean, { allowStyle });
        out.push({ i, allowStyle, clean, bad, stable: again === clean, ran: window.__x || null });
        host.remove();
      }
    }
    return out;
  }, PAYLOADS);
  const bad = res.filter(r => r.bad || r.ran).map(r => ({ i: r.i, style: r.allowStyle, clean: r.clean.slice(0, 100), ran: r.ran }));
  ok(bad.length === 0, `${PAYLOADS.length} hostile payloads x 2 modes: nothing runs and nothing dangerous remains`, bad.slice(0, 4));
  const unstable = res.filter(r => !r.stable).map(r => ({ i: r.i, clean: r.clean.slice(0, 90) }));
  ok(unstable.length === 0, 'sanitizing the output again changes nothing (guards against mutation XSS)', unstable.slice(0, 3));
  ok(await ev(() => !window.__x), 'no payload set the canary');

  console.log('\n[specific outcomes]');
  const one = (h, o) => ev(([h, o]) => CodeMiniEscape.sanitize(h, o), [h, o]);
  ok((await one('<a href="https://ok.example/" target="_blank" onclick="x()">x</a>')) === '<a href="https://ok.example/" rel="noopener noreferrer">x</a>', 'a safe link keeps href, gains rel=noopener, loses target and onclick');
  ok((await one('<x-foo>kept <b>text</b></x-foo>')) === 'kept <b>text</b>', 'an unknown tag is unwrapped, its text stays');
  ok((await one('<script>alert(1)</script>after')) === 'after', 'script is removed with its contents');
  ok((await one('<img src="data:image/svg+xml;base64,AAAA" alt="s">')) === '<img alt="s">', 'a data: SVG image loses its src');
  ok((await one('<span style="color: red; background:url(x); font-size:12px" data-k="1">t</span>', { allowStyle: true })) === '<span style="color: red; font-size: 12px" data-k="1">t</span>', 'allowStyle keeps safe declarations and data-*, drops url()');
  ok((await one('<span style="color:red" data-k="1">t</span>')) === '<span>t</span>', 'by default style and data-* are dropped');
  ok((await one(null)) === '' && (await one(undefined)) === '' && (await one(12)) === '12', 'null, undefined and numbers are handled');

  console.log('\n[ordinary content survives]');
  const md = '<h1>T</h1><p>a <b>b</b> <em>i</em> <code class="language-js">x</code></p><pre><code>p</code></pre><ul><li><input type="checkbox" checked> t</li></ul><table><thead><tr><th>h</th></tr></thead><tbody><tr><td colspan="2">c</td></tr></tbody></table><blockquote>q</blockquote><a href="https://a.b/">l</a> <a href="#sec">f</a> <a href="mailto:a@b.c">m</a><img src="data:image/png;base64,iVBORw0KGgo=" alt="i"><hr><details open><summary>s</summary>d</details>';
  const kept = await one(md);
  for (const needle of ['<h1>T</h1>', '<b>b</b>', '<em>i</em>', 'class="language-js"', '<pre>', '<thead>', 'colspan="2"', '<blockquote>', 'href="https://a.b/"', 'href="#sec"', 'href="mailto:a@b.c"', 'src="data:image/png;base64,iVBORw0KGgo="', '<hr>', '<details open="">', '<summary>', 'type="checkbox"', 'disabled'])
    ok(kept.includes(needle), 'keeps ' + needle, kept.slice(0, 160));

  console.log('\n[embedded as source (the Markdown preview iframe)]');
  const same = await ev((PAYLOADS) => { const f = new Function('return ' + CodeMiniEscape.sanitize.toString())(); return PAYLOADS.every(p => f(p) === CodeMiniEscape.sanitize(p)); }, PAYLOADS);
  ok(same, 'the function rebuilt from its source text gives identical output');

  console.log('\n[the sinks use it]');
  const src = await ev(async () => { const g = (u) => fetch(u).then(r => r.text()); return { nb: await g('js/notebook/notebook-kernels.js'), pv: await g('js/viewers/preview.js'), docs: await g('js/viewers/docs.js') }; });
  ok(/wrap\.innerHTML = CodeMiniEscape\.sanitize\(md\.parse\(text\)\)/.test(src.nb), 'notebook Markdown cells');
  ok(/__cmSanitize\(marked\.parse\(rawMdText\)\)/.test(src.pv) && /const __cmSanitize = \$\{CodeMiniEscape\.sanitize\.toString\(\)\}/.test(src.pv), 'Markdown preview');
  ok(/contentEl\.innerHTML = CodeMiniEscape\.sanitize\(bodyHTML, \{ allowStyle: true \}\)/.test(src.docs), 'document editor');

  const real = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(real.length === 0, 'no page errors', real);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
