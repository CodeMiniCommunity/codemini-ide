// Isolated previews, for real: the app on http://localhost:8765 and the runner on http://localhost:8766 are two
// different origins. Checks that a previewed page works (CSS, JS, console, refresh), that it cannot reach the app
// (storage, functions, messages), that forged messages are ignored, and that the app falls back safely when the
// runner is missing, switched off, or pointed at the app's own origin.
const path = require('path'), http = require('http');
const { chromium } = require('playwright');
const { createServer } = require('./lib/static-server');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const APP = 'http://localhost:8765', RUNNER = 'http://localhost:8766';

const FILES = [
  { id: 'rn1', name: 'index.html', content: '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 id="t">Hello isolated</h1><script src="app.js"></script></body></html>' },
  { id: 'rn2', name: 'style.css', content: 'h1 { color: rgb(1, 2, 3); }' },
  { id: 'rn3', name: 'app.js', content: "document.getElementById('t').dataset.ran = 'yes'; console.log('from-the-page');" }
];

async function open(browser, runnerUrl, extraLs) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/^\[CodeMini\]/.test(m.text())) console.log('    [app]', m.text().slice(0, 160)); });
  await page.addInitScript(([runnerUrl, extraLs]) => {
    if (location.port === '8765') {
      if (runnerUrl) localStorage.setItem('codemini_runner_url', runnerUrl);
      Object.keys(extraLs || {}).forEach(k => localStorage.setItem(k, extraLs[k]));
    }
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  }, [runnerUrl, extraLs || {}]);
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto(APP + '/index.html'); await sleep(3500);
  // The preview prefers live editor content. The mocked Monaco has none, so say "no editor is open for this file"
  // and let it use the saved file, as it does for any file that is not being edited.
  await page.evaluate(() => { const m = window.monaco; window.monaco = new Proxy(m, { get: (t, k) => (k === 'editor' ? new Proxy(t.editor, { get: (e, j) => (j === 'getEditors' ? () => [] : e[j]) }) : t[k]) }); });
  await page.evaluate(async (FILES) => {
    for (const f of FILES) await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put({ id: f.id, parentId: 'root', name: f.name, type: 'file', content: f.content, timestamp: Date.now() }); tx.oncomplete = res; });
    openFileInTab({ id: 'rn1', parentId: 'root', name: 'index.html', type: 'file', content: FILES[0].content, timestamp: Date.now() });
  }, FILES);
  await sleep(800);
  return { ctx, page, errors };
}
const innerFrame = (page) => page.frames().find(f => f.parentFrame() && /shell\.html/.test(f.parentFrame().url())); // the page, whatever its URL (an in-place rewrite changes it)
const previewFrame = (page, origin) => page.frames().find(f => f.url().startsWith('blob:' + origin + '/'));

(async () => {
  const runnerServer = createServer(path.resolve(__dirname, '..', '..', 'runner'), { headers: { 'Content-Security-Policy': "frame-ancestors 'self' http://localhost:8765 http://127.0.0.1:8765" } });
  await new Promise(r => runnerServer.listen(8766, r));
  const strangerServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<iframe id="r" src="http://localhost:8766/shell.html" style="width:300px;height:200px"></iframe>'); });
  await new Promise(r => strangerServer.listen(8769, r));
  // A runner whose inner page never loads: its shell shows about:blank instead of the page (the blank preview seen on a phone).
  const fs = require('fs');
  const brokenServer = createServer(path.resolve(__dirname, '..', '..', 'runner'));
  const baseHandler = brokenServer.listeners('request')[0];
  brokenServer.removeAllListeners('request');
  brokenServer.on('request', (req, res) => {
    if (req.url.split('?')[0] === '/shell.js') {
      const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'runner', 'shell.js'), 'utf8').replace('page.src = d.url;', "page.src = 'about:blank';");
      res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(src);
    } else baseHandler(req, res);
  });
  await new Promise(r => brokenServer.listen(8768, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  console.log('\n[isolated preview]');
  let { ctx, page, errors } = await open(browser, RUNNER);
  const ev = (f, a) => page.evaluate(f, a);
  await ev(() => document.getElementById('playIconItem').click()); await sleep(4500);
  ok(await ev(() => document.getElementById('livePreviewContainer').classList.contains('show')), 'preview opened');
  ok(await ev(() => new URL(document.getElementById('lpIframe').src).origin) === RUNNER, 'the preview frame is the runner, on its own origin');
  ok(await ev(() => /Isolated/.test(document.getElementById('lpIsolation').title) && document.getElementById('lpIsolation').style.display !== 'none'), 'the toolbar says it is isolated');
  let pf = previewFrame(page, RUNNER);
  ok(!!pf, 'the page itself is a blob: document on the runner origin', page.frames().map(f => f.url().slice(0, 40)));
  if (pf) {
    ok(await pf.evaluate(() => document.getElementById('t').textContent) === 'Hello isolated', 'the HTML rendered');
    ok(await pf.evaluate(() => getComputedStyle(document.getElementById('t')).color) === 'rgb(1, 2, 3)', 'the linked stylesheet applied (minted by the runner)');
    ok(await pf.evaluate(() => document.getElementById('t').dataset.ran) === 'yes', 'the linked script ran');
  }
  ok((await ev(() => document.getElementById('lpConsoleContent').innerText)).includes('from-the-page'), "the page's console output reaches the app's console panel through the relay");

  console.log('\n[the page cannot reach the app]');
  if (pf) {
    const probe = await pf.evaluate(async (APP) => {
      const o = {};
      try { o.topStorage = window.top.localStorage.length; } catch (e) { o.topStorage = 'blocked:' + e.name; }
      try { o.topShield = typeof window.top.CodeMiniShield; } catch (e) { o.topShield = 'blocked:' + e.name; }
      try { o.appDoc = typeof window.parent.parent.document.title; } catch (e) { o.appDoc = 'blocked:' + e.name; }
      try { o.fetch = (await fetch(APP + '/js/core/shield.js')).status; } catch (e) { o.fetch = 'blocked:' + e.name; }
      try { o.dbs = (await indexedDB.databases()).map(d => d.name); } catch (e) { o.dbs = 'err:' + e.name; }
      o.ownOrigin = location.origin;
      return o;
    }, APP);
    ok(/^blocked/.test(probe.topStorage), "cannot read the app's localStorage", probe.topStorage);
    ok(/^blocked/.test(probe.topShield), 'cannot call window.top.CodeMiniShield', probe.topShield);
    ok(/^blocked/.test(probe.appDoc), "cannot reach the app's document", probe.appDoc);
    ok(/^blocked/.test(probe.fetch), "cannot read the app's files with fetch (no CORS)", probe.fetch);
    ok(!probe.dbs.some(n => /codemini|CodeMiniDB|shield/i.test(n)), "the app's IndexedDB databases (workspace, device key) are not visible", probe.dbs);
    ok(probe.ownOrigin === RUNNER, 'the page runs on the runner origin', probe.ownOrigin);

    console.log('\n[forged messages are ignored]');
    await pf.evaluate(() => {
      window.top.postMessage({ type: 'console', level: 'log', args: ['FORGED-TOP'] }, '*');
      window.top.postMessage({ cmRunner: 1, op: 'minted', id: 1, nonce: '0'.repeat(32), url: 'blob:http://localhost:8766/evil' }, '*');
      window.parent.postMessage({ cmRunner: 1, op: 'page', data: { type: 'console', level: 'log', args: ['FORGED-WRAPPED'] } }, '*');
      window.parent.postMessage({ cmRunner: 1, op: 'minted', id: 1, nonce: '0'.repeat(32), url: 'blob:http://localhost:8766/evil2' }, '*');
      console.log('after-forgeries');
    });
    await sleep(800);
    const con = await ev(() => document.getElementById('lpConsoleContent').innerText);
    ok(con.includes('after-forgeries') && !/FORGED/.test(con), 'forged console messages (direct and wrapped) never reach the console panel', con.slice(0, 200));
  }

  console.log('\n[refresh and pop-out]');
  await ev(async () => { await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const st = tx.objectStore('filesystem'); const g = st.get('rn1'); g.onsuccess = () => { const r = g.result; r.content = r.content.replace('Hello isolated', 'Hello again'); st.put(r); }; tx.oncomplete = res; }); });
  await ev(() => document.getElementById('lpRefreshBtn').click()); await sleep(2500);
  pf = previewFrame(page, RUNNER);
  ok(!!pf && await pf.evaluate(() => document.getElementById('t').textContent) === 'Hello again', 'Refresh reloads the edited file through the runner');
  ok(!!pf && await pf.evaluate(() => getComputedStyle(document.getElementById('t')).color) === 'rgb(1, 2, 3)', 'and its stylesheet still applies after the reload');
  console.log('\n[reload strategy: in-place rewrite vs full navigation]');
  await pf.evaluate(() => { window.__keep = 1; });                     // JS state inside the page
  const urlBefore = pf.url();
  await ev(async () => { await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const st = tx.objectStore('filesystem'); const g = st.get('rn1'); g.onsuccess = () => { const r = g.result; r.content = r.content.replace('Hello again', 'Navigated'); st.put(r); }; tx.oncomplete = res; }); });
  await ev(() => document.getElementById('lpRefreshBtn').click()); await sleep(2500);
  pf = previewFrame(page, RUNNER);
  ok(!!pf && await pf.evaluate(() => document.getElementById('t').textContent) === 'Navigated', 'Full Navigation: the edit shows');
  ok(!!pf && await pf.evaluate(() => window.__keep) === undefined, 'Full Navigation starts a fresh page (its JavaScript state is gone)');
  ok(!!pf && pf.url() !== urlBefore, 'and it is a new document URL');
  await ev(() => localStorage.setItem('codemini_preview_reload_mode', 'legacy'));
  await ev(() => document.getElementById('lpRefreshBtn').click()); await sleep(2500);     // first legacy render: nothing to rewrite yet, so it navigates
  pf = previewFrame(page, RUNNER);
  ok(!!pf && await pf.evaluate(() => document.getElementById('t').textContent) === 'Navigated', 'Legacy, first render: falls back to navigating (nothing to rewrite yet)');
  await pf.evaluate(() => { window.__keep = 7; });
  const frameBefore = pf;
  const logsBefore = (await ev(() => document.getElementById('lpConsoleContent').innerText)).split('from-the-page').length - 1;
  await ev(async () => { await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const st = tx.objectStore('filesystem'); const g = st.get('rn1'); g.onsuccess = () => { const r = g.result; r.content = r.content.replace('Navigated', 'Rewritten'); st.put(r); }; tx.oncomplete = res; }); });
  await ev(() => document.getElementById('lpRefreshBtn').click()); await sleep(2500);
  pf = innerFrame(page);
  ok(!!pf && await pf.evaluate(() => document.getElementById('t').textContent) === 'Rewritten', 'Legacy: the edit shows');
  ok(!!pf && await pf.evaluate(() => window.__keep) === 7, 'Legacy rewrites in place: the page keeps its window and JavaScript state');
  ok(pf === frameBefore, 'in the same frame (nothing was navigated)');
  ok(!!pf && await pf.evaluate(() => getComputedStyle(document.getElementById('t')).color) === 'rgb(1, 2, 3)', 'and the stylesheet still applies after the rewrite');
  const logsAfter = (await ev(() => document.getElementById('lpConsoleContent').innerText)).split('from-the-page').length - 1;
  ok(logsAfter === logsBefore + 1, 'the rewritten page reports to the console panel exactly once (the helper script is not installed twice)', { logsBefore, logsAfter });
  await ev(async () => { await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const st = tx.objectStore('filesystem'); const g = st.get('rn1'); g.onsuccess = () => { const r = g.result; r.content = r.content.replace('Rewritten', 'Rewritten twice'); st.put(r); }; tx.oncomplete = res; }); });
  await ev(() => document.getElementById('lpRefreshBtn').click()); await sleep(2500);
  pf = innerFrame(page);
  ok(!!pf && await pf.evaluate(() => document.getElementById('t').textContent) === 'Rewritten twice' && await pf.evaluate(() => window.__keep) === 7, 'a second in-place rewrite also works and still keeps the state');
  await ev(() => localStorage.removeItem('codemini_preview_reload_mode'));
  const pagesBefore = ctx.pages().length;
  await ev(() => document.getElementById('lpPopOutBtn').click()); await sleep(600);
  ok(ctx.pages().length === pagesBefore, 'pop-out does not open a same-origin copy while isolated');
  const real = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(real.length === 0, 'no page errors', real);
  await ctx.close();

  console.log('\n[only the app can drive the runner]');
  const sp = await (await browser.newContext()).newPage();
  await sp.goto('http://localhost:8769/'); await sleep(1500);
  const embedded = sp.frames().find(f => f.url().startsWith(RUNNER));
  ok(!embedded, 'another site cannot embed the runner (frame-ancestors)', sp.frames().map(f => f.url()));
  await sp.context().close();

  console.log('\n[fallback: runner unreachable]');
  ({ ctx, page, errors } = await open(browser, 'http://localhost:8767'));
  await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(5000);
  ok(await page.evaluate(() => document.getElementById('lpIframe').src.startsWith('blob:http://localhost:8765/')), 'the preview still renders, as a same-origin blob');
  ok(await page.evaluate(() => /Not isolated/.test(document.getElementById('lpIsolation').title)), 'and the toolbar says it is NOT isolated');
  const noteVisible = () => page.evaluate(() => { const n = document.getElementById('lpIsolationNote'); if (!n || n.style.display === 'none') return null; const r = n.getBoundingClientRect(); return { text: n.innerText, inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && r.height > 20 }; });
  let note = await noteVisible();
  ok(!!note && note.inView, 'a note opens inside the preview on its own the first time isolation falls back, fully on screen', note);
  ok(!!note && /Not isolated/.test(note.text) && /Reason: .*(did not load|did not announce)/.test(note.text) && /Runner: http:\/\/localhost:8767\/shell.html/.test(note.text) && /App: http:\/\/localhost:8765/.test(note.text), 'and it says why, which runner, and which app', note && note.text);
  await page.evaluate(() => [...document.querySelectorAll('#lpIsolationNote button')].find(b => b.textContent === 'Close').click());
  ok(!(await noteVisible()), 'Close hides it');
  await page.evaluate(() => document.getElementById('lpIsolation').click());
  ok(!!(await noteVisible()), 'tapping the indicator shows it again');
  await page.evaluate(() => document.getElementById('lpIsolation').click());
  ok(!(await noteVisible()), 'and tapping again hides it');
  const fpf = previewFrame(page, 'http://localhost:8765');
  ok(!!fpf && await fpf.evaluate(() => document.getElementById('t').textContent) === 'Hello isolated', 'content is correct in the fallback');
  ok(!!fpf && await fpf.evaluate(() => typeof window.top.CodeMiniShield) === 'object', 'and, as the label warns, fallback code CAN reach the app (the exposure isolation removes)');
  await ctx.close();

  console.log('\n[the runner loads but the page is blocked]');
  ({ ctx, page, errors } = await open(browser, 'http://localhost:8768'));
  await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(8000); // the shell gives a blank frame 4 s
  ok(await page.evaluate(() => document.getElementById('lpIframe').src.startsWith('blob:http://localhost:8765/')), 'the preview falls back to a same-origin page instead of staying blank');
  const bf = previewFrame(page, 'http://localhost:8765');
  ok(!!bf && await bf.evaluate(() => document.getElementById('t').textContent) === 'Hello isolated', 'and the content is there');
  ok(await page.evaluate(() => /Not isolated/.test(document.getElementById('lpIsolation').title) && /did not load/.test(document.getElementById('lpIsolation').title)), 'the indicator says not isolated and why');
  ok(await page.evaluate(() => /the frame still shows about: after 4 s/.test(CodeMiniRunner.lastError())), 'CodeMiniRunner.lastError() says what the frame was showing');
  ok(await page.evaluate(() => document.getElementById('lpNavBack').classList.contains('disabled')), 'the retry did not add the page to the history twice (Back stays disabled)');
  await ctx.close();

  console.log('\n[in-place rewrite in the original same-origin mode]');
  ({ ctx, page, errors } = await open(browser, RUNNER, { codemini_runner: 'off', codemini_preview_reload_mode: 'legacy' }));
  await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(3500);
  const lf = () => page.frames().find(f => f.url() === 'about:blank');
  ok(!!lf() && await lf().evaluate(() => document.getElementById('t').textContent) === 'Hello isolated', 'legacy, same-origin: first render');
  await lf().evaluate(() => { window.__keep = 9; });
  const lBefore = (await page.evaluate(() => document.getElementById('lpConsoleContent').innerText)).split('from-the-page').length - 1;
  await page.evaluate(async () => { await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); const st = tx.objectStore('filesystem'); const g = st.get('rn1'); g.onsuccess = () => { const r = g.result; r.content = r.content.replace('Hello isolated', 'Rewritten here'); st.put(r); }; tx.oncomplete = res; }); });
  await page.evaluate(() => document.getElementById('lpRefreshBtn').click()); await sleep(2500);
  ok(await lf().evaluate(() => document.getElementById('t').textContent) === 'Rewritten here' && await lf().evaluate(() => window.__keep) === 9, 'in-place rewrite shows the edit and keeps the page state');
  const lAfter = (await page.evaluate(() => document.getElementById('lpConsoleContent').innerText)).split('from-the-page').length - 1;
  ok(lAfter === lBefore + 1, 'and logs once, not twice', { lBefore, lAfter });
  const lErr = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(lErr.length === 0, 'and no longer throws "has already been declared" (this was an existing bug)', lErr);
  await ctx.close();

  console.log('\n[switched off / misconfigured]');
  ({ ctx, page } = await open(browser, RUNNER, { codemini_runner: 'off' }));
  await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(2500);
  ok(await page.evaluate(() => document.getElementById('lpIframe').src.startsWith('blob:http://localhost:8765/')), 'codemini_runner=off uses same-origin previews at once');
  ok(await page.evaluate(() => /switched off/.test(document.getElementById('lpIsolation').title)), 'and says so');
  await ctx.close();
  ({ ctx, page } = await open(browser, APP));
  await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(2500);
  ok(await page.evaluate(() => document.getElementById('lpIframe').src.startsWith('blob:http://localhost:8765/')), "a runner configured as the app's own origin is refused (it would isolate nothing)");
  ok(await page.evaluate(() => /not configured/.test(document.getElementById('lpIsolation').title)), 'and the toolbar says isolation is not configured');
  await ctx.close();

  await browser.close(); runnerServer.close(); strangerServer.close(); brokenServer.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
