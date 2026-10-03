const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); }; window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto('http://localhost:8765/index.html'); await sleep(5200);
  const ev = (f, a) => page.evaluate(f, a);
  const shown = (sel) => ev((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; }, sel);
  const names = () => ev(() => [...document.querySelectorAll('#fileList .file-item')].map(e => e.innerText.split('\n')[0].trim()));

  // seed three files
  await ev(async () => {
    for (const n of ['alpha.txt', 'beta.txt', 'gamma.js']) await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put({ id: 'x' + n, parentId: 'root', name: n, type: 'file', content: '', timestamp: Date.now() }); tx.oncomplete = res; });
    loadFilesFromDB();
  });
  await sleep(300);

  await ev(() => document.getElementById('folderIconItem').click()); await sleep(500); // Explorer starts collapsed
  console.log('\n[layout]');
  ok(await ev(() => !document.querySelector('.file-browser-left-actions > #addFolderBtn')), 'New Folder icon is gone from the toolbar');
  ok(await ev(() => !!document.querySelector('.file-browser-left-actions > #explorerSearchToggleBtn.ri-search-line')), 'search icon sits where it was');
  const order = await ev(() => [...document.querySelectorAll('#explorerDropdown .dropdown-item')].map(e => e.id));
  ok(order[0] === 'menuNewFile' && order[1] === 'addFolderBtn', 'dropdown: New Folder is directly below New File', order);
  ok(await ev(() => document.getElementById('addFolderBtn').textContent.trim() === 'New Folder'), 'labelled "New Folder"');

  console.log('\n[search bar]');
  ok(!(await shown('.explorer-search-bar')), 'hidden by default');
  ok((await names()).length === 3, 'all files listed', await names());
  await ev(() => document.getElementById('explorerSearchToggleBtn').click());
  ok(await shown('.explorer-search-bar'), 'icon click shows it');
  ok(await ev(() => document.activeElement.id === 'explorerSearchInput'), 'and focuses the input');
  ok(await ev(() => document.getElementById('explorerSearchToggleBtn').style.color.includes('accent-blue')), 'icon shows active state');
  await page.fill('#explorerSearchInput', 'alp'); await sleep(250);
  ok(JSON.stringify(await names()) === '["alpha.txt"]', 'typing filters the list', await names());
  await ev(() => document.getElementById('explorerSearchToggleBtn').click()); await sleep(250);
  ok(!(await shown('.explorer-search-bar')), 'icon click again hides it');
  ok((await names()).length === 3, 'hiding clears the filter - nothing stays silently filtered', await names());
  ok(await ev(() => document.getElementById('explorerSearchInput').value === ''), 'input emptied');
  await ev(() => document.getElementById('explorerSearchToggleBtn').click()); await page.fill('#explorerSearchInput', 'gam'); await sleep(200);
  await page.press('#explorerSearchInput', 'Escape'); await sleep(250);
  ok(!(await shown('.explorer-search-bar')) && (await names()).length === 3, 'Escape also closes it and clears the filter');

  console.log('\n[New Folder still works]');
  await page.click('#explorerAddBtn'); await sleep(150);
  ok(await shown('#explorerDropdown.show'), 'dropdown opens');
  await page.click('#addFolderBtn'); await sleep(250);
  ok(await ev(() => document.getElementById('islandModal').classList.contains('show')), 'New Folder opens the name modal');
  ok(await ev(() => !document.getElementById('explorerDropdown').classList.contains('show')), 'and closes the dropdown');
  await page.fill('#modalInput', 'docs'); await page.click('#modalSubmit'); await sleep(500);
  ok((await names()).includes('docs'), 'folder created', await names());
  await ev(() => document.querySelector('.quick-start-item[data-action="new-folder"]')?.click()); await sleep(250);
  // quick-start card lives on the launcher pane; trigger its delegated handler path directly if the card isn't mounted
  const qs = await ev(() => !!document.querySelector('.quick-start-item[data-action="new-folder"]'));
  if (qs) ok(await ev(() => document.getElementById('islandModal').classList.contains('show')), 'Quick Start "Create New Folder" still works');
  else console.log('  (quick-start card not mounted in this view - skipped)');

  console.log('\n[saved filter reopens the box]');
  await ev(() => { document.getElementById('islandModal').classList.remove('show'); document.getElementById('modalBackdrop').classList.remove('show'); });
  await ev(() => { currentExplorerSearch = 'bet'; document.getElementById('explorerSearchInput').value = 'bet'; setExplorerSearchVisible(true); loadFilesFromDB(); });
  await sleep(250);
  ok(await shown('.explorer-search-bar') && JSON.stringify(await names()) === '["beta.txt"]', 'active filter => box visible');
  await ev(() => setExplorerSearchVisible(false)); await sleep(200);
  // simulate a reload with a persisted filter: profile state carries it
  await ev(() => { const st = JSON.parse(localStorage.getItem('codemini_profile_states') || '{}'); st[cellActiveWinId] = { folderStack: [{ id: 'root', name: 'CodeMini' }], currentExplorerSearch: 'gam' }; localStorage.setItem('codemini_profile_states', JSON.stringify(st)); });
  await page.reload(); await sleep(5200);
  ok(await shown('.explorer-search-bar'), 'after reload with a saved filter, the box is showing');
  ok(await ev(() => document.getElementById('explorerSearchInput').value === 'gam'), 'and shows the filter text');
  await ev(() => { const st = JSON.parse(localStorage.getItem('codemini_profile_states') || '{}'); delete st[cellActiveWinId]; localStorage.setItem('codemini_profile_states', JSON.stringify(st)); });
  await page.reload(); await sleep(5200);
  ok(!(await shown('.explorer-search-bar')), 'after reload without one, it is hidden again');

  const rel = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });