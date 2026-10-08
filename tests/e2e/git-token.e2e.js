// The GitHub token in a real browser: encrypted with Shield's device key (real IndexedDB, real non-extractable
// CryptoKey), usable with My Keys locked and after a reload, absent from storage in plain text, removed on
// Disconnect, and handled sensibly when the browser has lost its key. GitHub's API is answered by a stub.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const TOKEN = 'ghp_E2eTokenValue0123456789abcdefGHIJ';
const PROFILE = { login: 'octo-e2e', name: 'Octo E2E', html_url: 'https://github.com/octo-e2e', avatar_url: 'https://avatars.githubusercontent.com/u/1', public_repos: 3, followers: 1 };

async function boot(context, seen) {
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.route('https://api.github.com/**', (route) => {
    const req = route.request();
    seen.push({ url: req.url(), auth: req.headers()['authorization'] || '' });
    if (/\/user$/.test(req.url())) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'x-oauth-scopes': 'repo, workflow', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-oauth-scopes' }, body: JSON.stringify(PROFILE) });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' });
  });
  await page.goto('http://localhost:8765/index.html'); await sleep(3500);
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const seen = [];
  let { page, errors } = await boot(context, seen);
  const ev = (f, a) => page.evaluate(f, a);
  const storage = () => ev(() => JSON.stringify(Object.assign({}, localStorage)));
  const bearer = () => seen.filter(s => /\/user$/.test(s.url)).map(s => s.auth);
  const openConfig = async () => {
    await ev(() => { if (!document.getElementById('sourceControlSidebar').classList.contains('open')) document.getElementById('menuSource').click(); });
    await sleep(500);
    await ev(() => { const tab = document.querySelector('[data-git-action="switch-tab"][data-tab="config"], [data-tab="config"]'); if (tab) tab.click(); });
    await sleep(400);
  };
  const panelText = () => ev(() => document.getElementById('sourceControlSidebar').innerText);

  console.log('\n[the device key exists and is not extractable]');
  ok(await ev(() => !!(window.CodeMiniShield && window.CodeMiniShield.device && window.CodeMiniShield.device.supported)), 'Shield reports the device key is supported in this browser');
  ok(await ev(() => Object.isFrozen(window.CodeMiniShield.device)), 'the device API is frozen');

  console.log('\n[connect: nothing to unlock, nothing readable in storage]');
  await ev(() => { document.getElementById('mainMenuBtnItem') && 0; });
  await openConfig();
  const hasInput = await ev(() => !!document.getElementById('gitTokenInput'));
  ok(hasInput, 'the Config tab shows the token field', await panelText());
  await page.fill('#gitTokenInput', TOKEN);
  await page.click('[data-git-action="connect-github"]'); await sleep(2500);
  ok((await panelText()).includes('octo-e2e'), 'connected as the stubbed account without unlocking My Keys', (await panelText()).slice(0, 300));
  ok(!(await ev(() => document.getElementById('keysSidebar').classList.contains('open'))), 'My Keys was not opened or asked for');
  const st = await storage();
  ok(!st.includes(TOKEN) && !st.includes('E2eTokenValue'), 'the token is not in localStorage in plain text');
  ok(/codemini_git_gh_tokenenc_/.test(st), 'an encrypted record is stored for this window');
  const keyInfo = await ev(() => new Promise((resolve) => {
    const r = indexedDB.open('codemini_shield');
    r.onerror = () => resolve({ error: 'open failed' });
    r.onsuccess = () => {
      const g = r.result.transaction('keys').objectStore('keys').get('device-v1');
      g.onsuccess = async () => {
        const k = g.result; if (!k) return resolve({ error: 'no key' });
        let exported = 'exported';
        try { await crypto.subtle.exportKey('raw', k); } catch (e) { exported = 'refused'; }
        resolve({ type: k.type, extractable: k.extractable, alg: k.algorithm.name, len: k.algorithm.length, exported });
      };
    };
  }));
  ok(keyInfo.type === 'secret' && keyInfo.extractable === false && keyInfo.alg === 'AES-GCM' && keyInfo.len === 256, 'the real stored key is a non-extractable AES-256-GCM key', keyInfo);
  ok(keyInfo.exported === 'refused', 'the browser refuses to export its bytes', keyInfo);

  console.log('\n[usable with My Keys locked, and after a reload]');
  await page.click('[data-git-action="verify-token"]'); await sleep(1500);
  ok(bearer().includes('Bearer ' + TOKEN), 'Re-verify sends the saved token to GitHub while My Keys is locked', bearer());
  await page.reload(); await sleep(3500);
  await openConfig(); await sleep(800);
  ok((await panelText()).includes('octo-e2e'), 'after a reload the account is still connected');
  seen.length = 0;
  await page.click('[data-git-action="verify-token"]'); await sleep(1500);
  ok(bearer().includes('Bearer ' + TOKEN), 'after a reload the token decrypts and is used, still with My Keys locked', bearer());
  ok(!(await panelText()).match(/unlock my keys/i), 'no prompt to unlock My Keys is shown');

  console.log('\n[disconnect removes the encrypted copy]');
  await page.click('[data-git-action="disconnect-github"]'); await sleep(500);
  await ev(() => { const b = Array.from(document.querySelectorAll('button')).filter(x => x.offsetParent && /^\s*Disconnect\s*$/.test(x.textContent)); const m = b[b.length - 1]; if (m) m.click(); });
  await sleep(1200);
  ok(!/codemini_git_gh_tokenenc_/.test(await storage()), 'the encrypted record is gone');
  ok(!(await panelText()).includes('octo-e2e'), 'the account is shown as disconnected');
  await page.reload(); await sleep(3500); await openConfig();
  seen.length = 0;
  ok(await ev(() => (typeof gitGetToken === 'function') ? gitGetToken() === '' : true), 'after a reload there is no token to use');

  console.log('\n[the browser loses its key but keeps localStorage]');
  await openConfig();
  await page.fill('#gitTokenInput', TOKEN);
  await page.click('[data-git-action="connect-github"]'); await sleep(2500);
  ok(/codemini_git_gh_tokenenc_/.test(await storage()), 'reconnected, record stored again');
  await ev(() => new Promise((res) => { const r = indexedDB.deleteDatabase('codemini_shield'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
  await page.reload(); await sleep(3500);
  const after = await storage();
  ok(!/codemini_git_gh_tokenenc_/.test(after), 'the record nothing can decrypt any more is removed');
  ok(!after.includes('E2eTokenValue') && !after.includes(TOKEN), 'and no plain token appears');
  await openConfig();
  const txt = await panelText();
  ok(/add (it|the token) again|can no longer be decrypted/i.test(txt) || await ev(() => !!document.getElementById('gitTokenInput')), 'the person is shown the token field again', txt.slice(0, 200));

  console.log('\n[a very old plain-text token is encrypted on load]');
  await ev(() => { localStorage.setItem('codemini_git_gh_token_' + (localStorage.getItem('codemini_active_window') || 'win_default'), 'ghp_PlainOldToken0123456789abcdefGHIJKL'); });
  await page.reload(); await sleep(4000);
  const mig = await storage();
  ok(!mig.includes('PlainOldToken'), 'the plain-text copy is gone after load');
  ok(/codemini_git_gh_tokenenc_/.test(mig), 'an encrypted record replaced it');
  ok(await ev(() => gitGetToken() === 'ghp_PlainOldToken0123456789abcdefGHIJKL'), 'and the token still works');

  const real = errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i.test(e));
  ok(real.length === 0, 'no page errors', real);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
