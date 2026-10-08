// File, folder and archive-entry names are attacker-controlled (a zip you opened, a repo you cloned, a file you
// imported). Everything runs in one origin, so a name that becomes HTML is a path to full compromise. This seeds
// hostile names and checks that each surface shows them as plain text: nothing runs, nothing is injected.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };

const IMG = '<img src=x onerror="window.__xss=\'img\'">.txt';
const ATTR = 'a" onmouseover="window.__xss=\'attr\'" data-x=".txt';
const SVG = '<svg onload="window.__xss=\'svg\'">';

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { page.__dialog = d.message(); d.dismiss(); });
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto('http://localhost:8765/index.html'); await sleep(5000);
  const ev = (f, a) => page.evaluate(f, a);
  const injected = () => ev(() => ({
    xss: window.__xss || null,
    imgs: document.querySelectorAll('img[src="x"]').length,
    svgs: document.querySelectorAll('svg[onload]').length,
    handlers: [...document.querySelectorAll('[onmouseover],[onerror],[onload]')].filter(e => /__xss/.test(e.outerHTML)).length,
    // where injected elements ended up, to make a failure easy to trace
    where: [...document.querySelectorAll('img[src="x"], svg[onload], [onmouseover]')].map(e => { const p = e.closest('[id],[class]'); return (p ? (p.id ? '#' + p.id : '.' + String(p.className).split(' ')[0]) : '?') + ' > ' + e.tagName.toLowerCase(); })
  }));

  await ev(async ({ IMG, ATTR, SVG }) => {
    const put = (rec) => new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put(rec); tx.oncomplete = res; });
    await put({ id: 'h_img', parentId: 'root', name: IMG, type: 'file', content: 'findme-needle', timestamp: Date.now() });
    await put({ id: 'h_attr', parentId: 'root', name: ATTR, type: 'file', content: 'findme-needle', timestamp: Date.now() });
    await put({ id: 'h_dir', parentId: 'root', name: SVG, type: 'folder', timestamp: Date.now() });
    await put({ id: 'h_child', parentId: 'h_dir', name: IMG, type: 'file', content: 'findme-needle', timestamp: Date.now() });
    loadFilesFromDB();
  }, { IMG, ATTR, SVG });
  await sleep(600);

  console.log('\n[explorer]');
  await ev(() => document.getElementById('folderIconItem').click()); await sleep(600);
  const text = await ev(() => document.getElementById('fileList').innerText);
  ok(text.includes('<img src=x'), 'the hostile name is shown literally, as text', text.slice(0, 120));
  let r = await injected();
  ok(!r.xss && !r.imgs && !r.svgs && !r.handlers, 'nothing ran and nothing was injected', r);
  ok(await ev(() => [...document.querySelectorAll('#fileList .file-name-wrap')].every(e => !e.getAttribute('title') || e.getAttribute('title').length > 0)), 'rows still render');

  console.log('\n[search results]');
  await ev(() => document.getElementById('searchIconItem').click()); await sleep(400);
  await ev(() => { document.getElementById('globalSearchInput').value = 'findme-needle'; document.getElementById('runSearchBtn').click(); });
  await sleep(1500);
  const sr = await ev(() => document.getElementById('searchResultsContainer').innerText);
  ok(sr.includes('<img src=x'), 'search results list the hostile name as text', sr.slice(0, 150));
  r = await injected();
  ok(!r.xss && !r.imgs && !r.svgs && !r.handlers, 'search: nothing ran and nothing was injected', r);

  console.log('\n[open in a tab and breadcrumb]');
  await ev(async ({ IMG }) => {
    const rec = await new Promise(res => { const q = db.transaction('filesystem').objectStore('filesystem').get('h_img'); q.onsuccess = () => res(q.result); });
    openFileInTab(rec);
  }, { IMG });
  await sleep(900);
  r = await injected();
  ok(!r.xss && !r.imgs && !r.svgs && !r.handlers, 'tab bar / breadcrumb: nothing ran and nothing was injected', r);

  console.log('\n[archive viewer tree]');
  const tree = await ev(({ IMG, ATTR, SVG }) => {
    const entries = [{ path: SVG + '/' + IMG, size: 1 }, { path: ATTR, size: 2 }, { path: IMG, size: 3 }];
    const host = document.createElement('div'); host.id = 'xssArchiveHost'; document.body.appendChild(host);
    host.innerHTML = _renderTreeNode(_buildEntryTree(entries), 0, '');
    return { text: host.innerText, rows: host.querySelectorAll('.archive-tree-row').length, paths: [...host.querySelectorAll('[data-entry-path]')].map(e => e.getAttribute('data-entry-path')) };
  }, { IMG, ATTR, SVG });
  r = await injected();
  ok(!r.xss && !r.imgs && !r.svgs && !r.handlers, 'archive tree: nothing ran and nothing was injected', r);
  ok(tree.paths.includes(ATTR) && tree.paths.includes(IMG), 'and the entry path an extract uses is exactly the real name', tree.paths);

  ok(!page.__dialog, 'no dialog was opened by injected script', page.__dialog);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
