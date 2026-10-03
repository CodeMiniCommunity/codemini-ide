const { chromium } = require('playwright');
const BASE = 'http://localhost:8765/index.html';
let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  // Third-party CDNs (Monaco, Pyodide, icons) aren't reachable here - fail them fast instead of hanging.
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (deps, cb) => { window.monaco = mk(); setTimeout(() => cb(), 0); };
    window.require.config = () => {};
  });
  await page.goto(BASE);
  await sleep(5200); // preloader (4s + fade)

  const ev = (fn, arg) => page.evaluate(fn, arg);
  const visible = (sel) => ev((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; }, sel);
  const dialogTitle = () => ev(() => { const h = document.querySelector('.wt-dialog h3'); return h ? h.textContent : null; });
  const clickDialog = (label) => ev((l) => { const b = [...document.querySelectorAll('.wt-dialog .wt-btn')].find(x => x.textContent.includes(l)); if (b) b.click(); return !!b; }, label);
  const records = () => ev(() => JSON.parse(localStorage.getItem('codemini_trust_records_main') || '{}'));
  const trusted = () => ev(() => window.WorkspaceTrust.isTrusted());
  const set = (k, v) => ev(([k, v]) => window.saveSetting(k, v), [k, v]);

  console.log('\n[1] Load');
  ok(await ev(() => !!window.WorkspaceTrust), 'module loaded and exposed');
  ok(await ev(() => typeof window.initDatabase === 'function' && window.initDatabase.toString().includes('onDbOpened')), 'initDatabase is wrapped');
  ok(await ev(() => window.getWorkspaceTrustSettings().emptyWindow === true), 'Workspace Trust Window defaults to ON (VS Code default)');
  ok(await trusted(), 'empty window (root) is trusted by default');
  ok(!(await visible('#workspaceTrustBanner.show')), 'no banner at the trusted root');
  ok(!(await visible('#statusWorkspaceTrust.show')), 'no status-bar item at the trusted root');
  ok(await ev(() => !!document.querySelector('.content-area > #workspaceTrustBanner')), 'banner is mounted at the top of .content-area');
  ok(await ev(() => !!document.querySelector('.status-left > #statusWorkspaceTrust')), 'status item is mounted in the status bar');

  // Helper: create a workspace like the app does (own DB + record in root)
  const makeWs = (id, name) => ev(async ({ id, name }) => {
    const open = (n) => new Promise((res, rej) => { const r = indexedDB.open(n, window.CODEMINI_DB_VERSION); r.onupgradeneeded = e => window.ensureCodeMiniSchema(e.target.result); r.onsuccess = e => res(e.target.result); r.onerror = rej; });
    const wsDb = 'CodeMiniDB_WS_' + id; (await open(wsDb)).close();
    const root = await open(cellActiveWindow.db);
    const rec = { id, parentId: 'workspace-root', name, type: 'workspace', db: wsDb, isLocked: false, password: null, content: '', timestamp: Date.now() };
    await new Promise(res => { const tx = root.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put(rec); tx.oncomplete = res; });
    root.close();
    window.workspacesList = (window.workspacesList || []).filter(w => w.id !== id).concat(rec);
    return rec;
  }, { id, name });
  const enter = (rec) => ev((r) => window.enterWorkspace(r), rec);
  const goRoot = () => ev(() => new Promise(res => initDatabase(cellActiveWindow.db, () => { folderStack = [{ id: 'root', name: 'CodeMini' }]; res(); })));
  const waitDb = (name) => page.waitForFunction((n) => db && db.name === n, name, { timeout: 5000 });

  const wsA = await makeWs('a1', 'Imported Project');

  console.log('\n[2] Startup prompt = Once (default)');
  await enter(wsA); await waitDb('CodeMiniDB_WS_a1'); await sleep(300);
  ok((await dialogTitle() || '').includes('Imported Project'), 'dialog appears on first open and names the workspace', await dialogTitle());
  ok(!(await trusted()), 'workspace is restricted while the question is open');
  ok(await visible('#workspaceTrustBanner.show'), 'Restricted Mode banner is shown');
  ok(await visible('#statusWorkspaceTrust.show'), 'Restricted Mode status item is shown');
  await clickDialog("No, I don");
  await sleep(150);
  ok(await dialogTitle() === null, 'dialog closes');
  ok((await records())['CodeMiniDB_WS_a1']?.trusted === false, '"No" is remembered under Once');
  await goRoot(); await sleep(200);
  ok(await trusted(), 'back at the root: trusted again');
  ok(!(await visible('#workspaceTrustBanner.show')), 'banner disappears when leaving the restricted workspace');
  await enter(wsA); await waitDb('CodeMiniDB_WS_a1'); await sleep(300);
  ok(await dialogTitle() === null, 'Once: re-opening a workspace with a saved answer does not ask again', await dialogTitle());
  ok(!(await trusted()), '...and it stays restricted');

  console.log('\n[3] Banner > Manage > trust');
  await ev(() => document.querySelector('#workspaceTrustBanner .wt-banner-btn').click()); await sleep(150);
  ok(await dialogTitle() !== null, 'Manage opens the trust dialog');
  await clickDialog('Yes, I trust'); await sleep(150);
  ok(await trusted(), 'workspace becomes trusted');
  ok((await records())['CodeMiniDB_WS_a1']?.trusted === true, 'grant is saved');
  ok(!(await visible('#workspaceTrustBanner.show')) && !(await visible('#statusWorkspaceTrust.show')), 'banner and status item hide');

  console.log('\n[4] Revoking trust takes effect immediately');
  await ev(() => window.WorkspaceTrust.setTrust(db.name, false)); await sleep(100);
  ok(!(await trusted()) && await visible('#workspaceTrustBanner.show'), 'restricted again, banner returns');

  console.log('\n[5] Banner setting');
  await ev(() => document.querySelector('#workspaceTrustBanner .wt-banner-close').click()); await sleep(100);
  ok(!(await visible('#workspaceTrustBanner.show')), 'Until Dismissed: close hides the banner');
  ok(await ev(() => Object.keys(JSON.parse(localStorage.getItem('codemini_trust_banner_dismissed_main') || '{}')).includes('CodeMiniDB_WS_a1')), 'dismissal persisted per workspace');
  await set('workspaceTrustBanner', 'Always'); await sleep(100);
  ok(await visible('#workspaceTrustBanner.show'), 'switching to Always shows it again regardless of dismissal');
  ok(!(await visible('#workspaceTrustBanner .wt-banner-close')), 'Always: no dismiss control');
  await set('workspaceTrustBanner', 'Never'); await sleep(100);
  ok(!(await visible('#workspaceTrustBanner.show')) && await visible('#statusWorkspaceTrust.show'), 'Never: banner hidden, status item still shows restricted state');
  await set('workspaceTrustBanner', 'Until Dismissed');

  console.log('\n[6] Guard + notebook run');
  await ev(() => { document.querySelectorAll('.custom-toast').forEach(t => t.remove()); });
  ok(await ev(() => window.WorkspaceTrust.guard('Test feature') === false), 'guard() blocks in a restricted workspace');
  ok(await ev(() => /Test feature is disabled in Restricted Mode/.test(document.body.innerText)), 'and explains why in a toast');
  await ev(() => { document.querySelectorAll('.custom-toast').forEach(t => t.remove()); });
  const ran = await ev(async () => { try { await runCell({ dataset: { cellType: 'code' } }, null); return 'returned'; } catch (e) { return 'threw: ' + e.message; } });
  ok(ran === 'returned', 'runCell on a code cell returns before touching the cell', ran);
  ok(await ev(() => /Running notebook cells is disabled/.test(document.body.innerText)), 'runCell shows the Restricted Mode notice');
  await ev(() => { document.querySelectorAll('.custom-toast').forEach(t => t.remove()); });
  await ev(async () => { try { await runCell({ dataset: { cellType: 'markdown' }, querySelector: () => null }, null); } catch (e) {} });
  ok(await ev(() => !/Running notebook cells/.test(document.body.innerText)), 'markdown cells are NOT blocked (they only render, sanitized)');
  await ev(async () => { try { await window.runDebugSession(); } catch (e) {} });
  ok(await ev(() => /Debugging is disabled in Restricted Mode/.test(document.body.innerText)), 'runDebugSession is blocked with a notice');
  await ev(() => { document.querySelectorAll('.custom-toast').forEach(t => t.remove()); });

  console.log('\n[7] Startup prompt = Always: a "No" is not remembered');
  await ev(() => window.WorkspaceTrust.forget(db.name));
  await set('workspaceTrustStartupPrompt', 'Always');
  await goRoot(); await enter(wsA); await waitDb('CodeMiniDB_WS_a1'); await sleep(300);
  ok(await dialogTitle() !== null, 'asks on open');
  await clickDialog("No, I don"); await sleep(150);
  ok(!(await records())['CodeMiniDB_WS_a1'], '"No" was not saved');
  await goRoot(); await enter(wsA); await waitDb('CodeMiniDB_WS_a1'); await sleep(300);
  ok(await dialogTitle() !== null, 'asks again on the next open');
  await ev(() => document.querySelector('.wt-dialog .wt-x').click()); await sleep(100);
  ok(await dialogTitle() === null && !(await trusted()), 'closing the dialog with X leaves it restricted and saves nothing');

  console.log('\n[8] Startup prompt = Never');
  await set('workspaceTrustStartupPrompt', 'Never');
  await goRoot(); await enter(wsA); await waitDb('CodeMiniDB_WS_a1'); await sleep(300);
  ok(await dialogTitle() === null, 'no dialog');
  ok(!(await trusted()) && await visible('#statusWorkspaceTrust.show'), 'opens in Restricted Mode');
  await set('workspaceTrustStartupPrompt', 'Once');

  console.log('\n[9] Master switch');
  await set('workspaceTrustEnabled', false); await sleep(100);
  ok(await trusted() && await ev(() => window.WorkspaceTrust.guard('x')), 'off: everything is trusted');
  ok(!(await visible('#workspaceTrustBanner.show')) && !(await visible('#statusWorkspaceTrust.show')), 'off: no banner or status item');
  await set('workspaceTrustEnabled', true); await sleep(100);
  ok(!(await trusted()), 'back on: restricted again');

  console.log('\n[10] Workspace Trust Window (empty window)');
  await goRoot(); await sleep(150);
  ok(await trusted(), 'ON: root is trusted');
  await set('workspaceTrustEmptyWindow', false); await sleep(100);
  ok(!(await trusted()) && await visible('#statusWorkspaceTrust.show'), 'OFF: the root is restricted too');
  ok(await dialogTitle() === null, '...without a modal (root never gets the startup dialog)');
  await set('workspaceTrustEmptyWindow', true); await sleep(100);

  console.log('\n[11] Live Preview in Restricted Mode');
  await enter(wsA); await waitDb('CodeMiniDB_WS_a1'); await sleep(300);
  const prev = await ev(async () => {
    const f = { id: 'f1', parentId: 'root', name: 'page.html', type: 'file', content: '<h1>hi</h1><script>window.__ran = 1<\/script>', timestamp: Date.now() };
    await new Promise(res => { const tx = db.transaction('filesystem', 'readwrite'); tx.objectStore('filesystem').put(f); tx.oncomplete = res; });
    document.querySelectorAll('.editor-group.active-group .tab.active').forEach(t => t.classList.remove('active'));
    const tab = document.createElement('div'); tab.className = 'tab active'; tab.dataset.fileId = 'f1'; tab.dataset.type = 'monaco';
    tab.innerHTML = '<span>page.html</span>'; document.querySelector('.editor-group.active-group .tabs-bar').appendChild(tab);
    document.getElementById('playIconItem').click();
    await new Promise(r => setTimeout(r, 1200));
    const fr = document.getElementById('lpIframe');
    return { srcdoc: fr ? fr.srcdoc : null, src: fr ? fr.getAttribute('src') : null, ran: window.__ran, shown: document.getElementById('livePreviewContainer').classList.contains('show') };
  });
  ok(prev.srcdoc && prev.srcdoc.includes('Live Preview is off in Restricted Mode') && !prev.src && prev.ran === undefined && !/<script/.test(prev.srcdoc), 'preview shows the static notice, loads nothing and ran no script', { src: prev.src, ran: prev.ran });

  console.log('\n[12] Files from outside CodeMini (trusted workspace)');
  ok(await dialogTitle() !== null, '(entering under Once with no saved answer had opened the startup dialog)');
  await ev(() => document.querySelector('.wt-dialog .wt-x').click()); await sleep(100);
  await ev(() => window.WorkspaceTrust.setTrust(db.name, true)); await sleep(100);
  const fileCount = () => ev(() => new Promise(res => { const r = db.transaction('filesystem', 'readonly').objectStore('filesystem').getAll(); r.onsuccess = () => res(r.result.filter(f => f.name.startsWith('up_')).length); }));
  const upload = (name) => ev((n) => { window.__up = processFileList([new File(['hello'], n, { type: 'text/plain' })]); }, name);
  const settle = () => ev(() => Promise.race([window.__up, new Promise(r => setTimeout(r, 4000))]));

  await set('workspaceTrustUntrustedFiles', 'Prompt');
  await upload('up_cancel.txt'); await sleep(250);
  ok((await dialogTitle() || '').includes('Add files from outside'), 'Prompt: asks before adding');
  await clickDialog('Cancel'); await settle(); await sleep(150);
  ok(await fileCount() === 0, 'Cancel adds nothing');

  await upload('up_here.txt'); await sleep(250);
  await clickDialog('Add to This Workspace'); await settle(); await sleep(250);
  ok(await fileCount() === 1, '"Add to This Workspace" adds it here');

  await set('workspaceTrustUntrustedFiles', 'Open');
  await upload('up_open.txt'); await sleep(250);
  ok(await dialogTitle() === null, 'Open: no dialog'); await settle(); await sleep(250);
  ok(await fileCount() === 2, 'Open: added silently');

  const winsBefore = await ev(() => cellWindows.length);
  await set('workspaceTrustUntrustedFiles', 'New window');
  await upload('up_newwin.txt'); await sleep(250);
  ok(await dialogTitle() === null, 'New window: no dialog'); await settle(); await sleep(1500);
  ok(await ev(() => cellWindows.length) === winsBefore + 1, 'New window: a window was created');
  ok(await ev(() => cellActiveWindow.profile && cellActiveWindow.name.includes('Untrusted')), 'and it was switched to');
  await sleep(500);
  const newState = await ev(() => ({ trusted: window.WorkspaceTrust.isTrusted(), reason: window.WorkspaceTrust.getState().reason, db: db && db.name }));
  ok(newState.trusted === false && newState.reason === 'denied', 'the new window starts RESTRICTED even though empty windows are trusted by default', newState);
  ok(await ev(() => new Promise(res => { const r = db.transaction('filesystem', 'readonly').objectStore('filesystem').getAll(); r.onsuccess = () => res(r.result.some(f => f.name === 'up_newwin.txt' && f.parentId === 'root')); })), 'the file landed in the new window\'s root');
  ok(await ev(() => JSON.parse(localStorage.getItem('codemini_trust_records_' + cellActiveWinId) || '{}')[db.name]?.trusted === false), 'its record is stored in the new window\'s own scope');
  ok(!(await ev(() => JSON.parse(localStorage.getItem('codemini_trust_records_main') || '{}'))[await ev(() => db.name)]), 'and not leaked into the main scope');

  console.log('\n[13] Settings > Security manager');
  await ev(() => document.getElementById('settingsIconItem').click()); await sleep(900);
  const mgr = await ev(() => { const m = document.getElementById('trustManager'); return m ? m.innerText : null; });
  ok(mgr && /Current location/.test(mgr), 'manager renders inside the Security tab', mgr && mgr.slice(0, 120));

  console.log('\n[14] Persistence');
  ok(await ev(() => Object.keys(JSON.parse(localStorage.getItem('codemini_trust_records_main') || '{}')).length) >= 1, 'decisions are in localStorage');
  await ev(() => { document.getElementById('settingsIconItem'); });

  const relevant = errors.filter(e => !/monaco|pyodide|loadPyodide|sqljs|initSqlJs|Failed to fetch|net::|require is not defined|is not defined: (monaco|loadPyodide)/i.test(e));
  console.log('\nPage errors (excluding unreachable-CDN noise):', relevant.length ? relevant : 'none');
  ok(relevant.length === 0, 'no unexpected page errors', relevant);

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
