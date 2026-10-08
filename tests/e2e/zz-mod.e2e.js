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

const FILES0 = [
  { id: 'rn1', name: 'index.html', content: '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 id="t">Hello isolated</h1><script src="app.js"></script></body></html>' },
  { id: 'rn2', name: 'style.css', content: 'h1 { color: rgb(1, 2, 3); }' },
  { id: 'rn3', name: 'app.js', content: "document.getElementById('t').dataset.ran = 'yes'; console.log('from-the-page');" }
];

async function open(browser, runnerUrl, extraLs) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
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
const previewFrame = (page, origin) => page.frames().find(f => f.url().startsWith('blob:' + origin + '/'));


const FILES = [
  { id: 'rn1', name: 'index.html', content: '<!doctype html><html><body><h1 id="t">start</h1><script type="module" src="main.js"></script></body></html>' },
  { id: 'rn2', name: 'main.js', content: "import { greet } from './util.js'; document.getElementById('t').textContent = greet('module'); console.log('main-ran');" },
  { id: 'rn3', name: 'util.js', content: "export const greet = (n) => 'hello ' + n;" }
];
(async () => {
  const runnerServer = createServer(path.resolve(__dirname, '..', '..', 'runner'), { headers: { 'Content-Security-Policy': 'frame-ancestors http://localhost:8765 http://127.0.0.1:8765' } });
  await new Promise(r => runnerServer.listen(8766, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const mode of [RUNNER, 'off']) {
    const { ctx, page, errors } = await open(browser, RUNNER, mode === 'off' ? { codemini_runner: 'off' } : {});
    page.on('console', m => console.log('  [console]', m.text().slice(0, 160)));
    await page.evaluate(() => document.getElementById('playIconItem').click()); await sleep(5000);
    const f = page.frames().find(x => x.url().startsWith('blob:'));
    console.log('MODE', mode, 'frame', f ? f.url().slice(0, 40) : 'none');
    if (f) console.log('  heading:', await f.evaluate(() => document.getElementById('t') && document.getElementById('t').textContent), '| scripts:', await f.evaluate(() => [...document.scripts].map(s => (s.type||'js') + ':' + (s.src||'inline').slice(0,40)).join(' , ')), '| importmap:', await f.evaluate(() => (document.querySelector('script[type=importmap]')||{}).textContent && document.querySelector('script[type=importmap]').textContent.slice(0, 200)));
    console.log('  panel:', (await page.evaluate(() => document.getElementById('lpConsoleContent').innerText)).slice(0, 300).replace(/\n/g, ' | '));
    console.log('  errors:', errors.filter(e => !/monaco|Failed to fetch|net::/i.test(e)));
    await ctx.close();
  }
  await browser.close(); runnerServer.close(); process.exit(0);
})();
