const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (deps, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); };
    window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto('http://localhost:8765/index.html'); await sleep(5200);
  const ev = (f, a) => page.evaluate(f, a);
  const run = async (cmd) => { await page.fill('.term-input', cmd); await page.press('.term-input', 'Enter'); await sleep(700); };
  const termText = () => ev(() => document.querySelector('.term-output, .term-body, [id^="pane-term"]').innerText);

  console.log('\n[terminal] executeFile gate');
  await ev(async () => {
    const f = { id: 'tr1', parentId: 'root', name: 'run.js', type: 'file', content: 'window.__termRan = (window.__termRan || 0) + 1;', timestamp: Date.now() };
    await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put(f); tx.oncomplete = res; });
  });
  await ev(() => document.getElementById('terminalIconItem').click()); await sleep(800);
  ok(await ev(() => !!document.querySelector('.term-input')), 'terminal tab opened');

  await ev(() => window.saveSetting('workspaceTrustEmptyWindow', false)); // root becomes restricted
  ok(await ev(() => !window.WorkspaceTrust.isTrusted()), 'precondition: current location is restricted');
  await run('./run.js');
  ok(await ev(() => window.__termRan === undefined), 'restricted: the file did NOT run');
  const t1 = await termText();
  ok(/Restricted Mode/.test(t1), 'restricted: terminal says why', t1.slice(-200));

  await ev(() => window.saveSetting('workspaceTrustEmptyWindow', true)); // root trusted again
  await run('./run.js');
  ok(await ev(() => window.__termRan === 1), 'trusted (positive control): the same command now runs the file');

  await ev(() => window.saveSetting('workspaceTrustEmptyWindow', false));
  await run('node run.js'); await run('run run.js');
  ok(await ev(() => window.__termRan === 1), 'restricted again: other route forms (node/run) are blocked too (count unchanged)');

  await ev(() => window.saveSetting('workspaceTrustEnabled', false));
  await run('./run.js');
  ok(await ev(() => window.__termRan === 2), 'master switch off: runs normally');

  const rel = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
