// Live Preview tool panels: Console, Network and the DOM Inspector are in-flow bottom panels that push the
// preview, only one is open at a time, and (desktop width + preview maximized) the inspector becomes a right sidebar.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  async function run(label, viewport) {
    console.log('\n[' + label + ']');
    const page = await (await browser.newContext({ viewport })).newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
      window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
    });
    await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
    await page.goto('http://localhost:8765/index.html'); await sleep(3500);
    const ev = (f, a) => page.evaluate(f, a);
    await ev(async () => {
      const f = { id: 'pv1', parentId: 'root', name: 'index.html', type: 'file', content: '<!doctype html><html><body><h1 id="t">Hello</h1><p>text</p></body></html>', timestamp: Date.now() };
      await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put(f); tx.oncomplete = res; });
      openFileInTab(f);
    });
    await sleep(800);
    await ev(() => document.getElementById('playIconItem').click()); await sleep(1800);
    const geo = () => ev(() => {
      const r = (id) => { const e = typeof id === 'string' ? document.querySelector(id) : id; if (!e) return null; const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), disp: cs.display }; };
      return { content: r('.lp-content'), insp: r('#lpInspectorPanel'), net: r('#lpNetworkPanel'), con: r('#lpConsolePanel'), wrap: r('.lp-content-wrapper'), open: { c: lpConsolePanel.classList.contains('show'), n: lpNetworkPanel.classList.contains('show'), i: lpInspectorPanel.classList.contains('show') }, cls: document.querySelector('.lp-content-wrapper').className };
    });
    const click = (id) => ev((i) => document.getElementById(i).click(), id);
    ok(await ev(() => document.getElementById('livePreviewContainer').classList.contains('show')), 'preview opened');
    const base = await geo(); const baseH = base.content.h;

    await click('lpInspectorBtn'); await sleep(450); let g = await geo();
    ok(g.open.i && !g.open.c && !g.open.n, 'inspector opens alone');
    ok(g.content.h < baseH - 50, 'inspector pushes the preview (content shrank)', [baseH, g.content.h]);
    ok(g.insp.y >= g.content.y + g.content.h - 2 && g.insp.w === g.wrap.w, 'inspector is a full-width bottom panel below the preview', g.insp);

    await click('lpNetworkBtn'); await sleep(450); g = await geo();
    ok(g.open.n && !g.open.i && !g.open.c, 'opening Network closes the inspector');
    ok(g.content.h < baseH - 50 && g.net.y >= g.content.y + g.content.h - 2, 'network pushes the preview and sits below it', [g.content, g.net]);
    ok(await ev(() => !document.getElementById('lpInspectorBtn').classList.contains('active-state') && document.getElementById('lpNetworkBtn').classList.contains('active-state')), 'button active states follow');

    await click('lpToggleConsole'); await sleep(500); g = await geo();
    ok(g.open.c && !g.open.n && !g.open.i, 'opening Console closes Network');
    ok(g.content.h < baseH - 50, 'console pushes the preview', g.content.h);

    await click('lpInspectorBtn'); await sleep(450); g = await geo();
    ok(g.open.i && !g.open.c && !g.open.n, 'opening inspector closes console');
    ok(await ev(() => document.getElementById('lpInspectorBtn').classList.contains('active-state') && !document.getElementById('lpToggleConsole').classList.contains('active-state')), 'console button no longer active');

    await click('lpInspectorBtn'); await sleep(450); g = await geo();
    ok(!g.open.i && !g.open.c && !g.open.n && Math.abs(g.content.h - baseH) <= 2, 'toggling inspector again closes it and the preview returns to full height', [baseH, g.content.h]);

    await click('lpToggleConsole'); await sleep(500); await click('lpCloseConsole'); await sleep(500); g = await geo();
    ok(!g.open.c && Math.abs(g.content.h - baseH) <= 2, 'console close button still works');
    await click('lpNetworkBtn'); await sleep(300); await click('lpCloseNetwork'); await sleep(300); g = await geo();
    ok(!g.open.n && Math.abs(g.content.h - baseH) <= 2, 'network close button still works');

    // maximized
    await click('lpMaximizeBtn'); await sleep(600);
    const maxBase = await geo();
    await click('lpInspectorBtn'); await sleep(500); g = await geo();
    if (viewport.width > 768) {
      ok(g.cls.includes('insp-open') && g.insp.x > g.content.x && g.insp.h === g.wrap.h, 'maximized + desktop: inspector is a right sidebar', g.insp);
      ok(g.content.w < maxBase.content.w - 200 && Math.abs(g.content.h - maxBase.content.h) <= 2, 'sidebar pushes the preview left (narrower, same height)', [maxBase.content, g.content]);
      await click('lpNetworkBtn'); await sleep(500); g = await geo();
      ok(g.open.n && !g.open.i && g.net.w === g.wrap.w && g.content.h < maxBase.content.h - 50 && g.content.w === maxBase.content.w, 'maximized: network is still a bottom panel (inspector closed)', g);
      await click('lpInspectorBtn'); await sleep(300); await click('lpMaximizeBtn'); await sleep(600); g = await geo();
      ok(g.open.i && g.insp.w === g.wrap.w && g.insp.y > g.content.y, 'un-maximizing returns the inspector to the bottom panel', g.insp);
    } else {
      ok(g.insp.w === g.wrap.w && g.insp.y > g.content.y, 'mobile: inspector stays a bottom panel');
    }
    ok(errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e)).length === 0, 'no page errors', errors);
    await page.context().close();
  }
  await run('desktop', { width: 1280, height: 800 });
  await run('mobile', { width: 390, height: 780 });
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
