// PWA app shortcuts: the installed app opens /?action=<name> (see "shortcuts" in manifest.json) and app.js performs it.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const NOISE = /monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i;
const BASE = 'http://localhost:8765/';

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' }, opts));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
    // Record whether the startup preloader was still covering the screen when each control was clicked.
    window.__clicks = [];
    const orig = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () { window.__clicks.push({ id: this.id, preloader: !!(window.CodeMiniPreloader && window.CodeMiniPreloader.isActive()) }); return orig.apply(this, arguments); };
  });
  return { page, errors, ev: (f, a) => page.evaluate(f, a) };
}
// Wait for the preloader to go, then a moment for the action to run.
const settle = async (page) => { await page.waitForFunction(() => !window.CodeMiniPreloader || !window.CodeMiniPreloader.isActive(), null, { timeout: 15000 }).catch(() => {}); await sleep(900); };

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const allErrors = [];

  console.log('\n[1] each action does its thing (desktop)');
  let s = await newPage(browser);
  await s.page.goto(BASE + '?action=new-file'); await settle(s.page);
  ok(await s.ev(() => document.getElementById('islandModal').classList.contains('show') && /New File Name/.test(document.getElementById('modalLabel').textContent)), 'new-file opens the New File dialog');
  ok(await s.ev(() => location.search === ''), 'and removes ?action from the address bar', await s.ev(() => location.href));
  const launchClick = await s.ev(() => window.__clicks.find(c => c.id === 'menuNewFile'));
  ok(launchClick && launchClick.preloader === false, 'it waited for the startup preloader to finish', launchClick);

  await s.page.goto(BASE + '?action=terminal'); await settle(s.page);
  ok(await s.ev(() => !!document.querySelector('.tab[data-type="terminal"]')), 'terminal opens a terminal tab');

  await s.page.goto(BASE + '?action=settings'); await settle(s.page);
  ok(await s.ev(() => document.querySelector('.tab.active[data-type="settings"]') !== null), 'settings opens (and activates) the Settings tab');

  await s.page.goto(BASE + '?action=search'); await settle(s.page);
  ok(await s.ev(() => document.getElementById('searchSidebar').classList.contains('open')), 'search opens the Search sidebar');
  allErrors.push(...s.errors);

  console.log('\n[2] URL handling');
  s = await newPage(browser);
  await s.page.goto(BASE + '?action=settings&foo=1#bar'); await settle(s.page);
  ok(await s.ev(() => location.search === '?foo=1' && location.hash === '#bar'), 'only ?action is removed; other params and the hash stay', await s.ev(() => location.href));
  ok(await s.ev(() => !!document.querySelector('.tab[data-type="settings"]')), 'the action still ran');
  await s.page.goto(BASE + '?action=bogus'); await settle(s.page);
  ok(await s.ev(() => location.search === '' && !document.getElementById('islandModal').classList.contains('show') && !document.querySelector('.tab[data-type="terminal"]')), 'an unknown action is ignored (and cleaned from the URL)');
  await s.page.goto(BASE + '?action=constructor'); await settle(s.page);
  ok(await s.ev(() => location.search === '' && !window.__clicks.some(c => c.id === 'menuNewFile')), 'inherited names like "constructor" are not actions either');
  allErrors.push(...s.errors);
  // Fresh profile: earlier steps left tabs in this one's saved session, and restoring those clicks the same controls.
  s = await newPage(browser);
  await s.page.goto(BASE); await settle(s.page);
  ok(await s.ev(() => !window.__clicks.some(c => /^(menuNewFile|terminalIconItem|searchIconItem|settingsIconItem)$/.test(c.id))), 'opening the app without an action triggers none');
  allErrors.push(...s.errors);

  console.log('\n[3] once only');
  s = await newPage(browser);
  await s.page.goto(BASE + '?action=new-file'); await settle(s.page);
  await s.ev(() => document.getElementById('modalCancel').click());
  await s.page.reload(); await settle(s.page);
  ok(await s.ev(() => !document.getElementById('islandModal').classList.contains('show')), 'reloading does not repeat the action');
  allErrors.push(...s.errors);

  console.log('\n[4] search is not toggled off when it was already open');
  s = await newPage(browser);
  await s.page.goto(BASE); await settle(s.page);
  await s.ev(() => document.getElementById('searchIconItem').click()); await sleep(300);
  ok(await s.ev(() => document.getElementById('searchSidebar').classList.contains('open')), 'precondition: Search is open (and saved with the session)');
  await s.page.goto(BASE + '?action=search'); await settle(s.page);
  ok(await s.ev(() => document.getElementById('searchSidebar').classList.contains('open')), 'the shortcut leaves it open instead of closing it');
  allErrors.push(...s.errors);

  console.log('\n[5] mobile layout');
  s = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await s.page.goto(BASE + '?action=search'); await settle(s.page);
  ok(await s.ev(() => !!document.querySelector('.mobile-search-bar.active')), 'search opens the mobile search bar');
  allErrors.push(...s.errors);

  const rel = allErrors.filter(e => !NOISE.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
