const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const NOISE = /monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i;

// seed(): runs once, on the very first navigation only, to put settings into localStorage
async function newPage(browser, seedSrc) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.addInitScript((seedSrc) => {
    if (!localStorage.getItem('__seeded')) { localStorage.setItem('__seeded', '1'); try { new Function(seedSrc)(); } catch (e) { console.error('seed failed', e); } }
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
    window.__f = []; const t0 = performance.now();
    const tick = () => {
      const root = document.documentElement, body = document.body, pre = document.getElementById('appPreloader');
      const cs = pre ? getComputedStyle(pre) : null;
      window.__f.push({ t: Math.round(performance.now() - t0), app: !!document.querySelector('.top-menu'), theme: root.getAttribute('data-theme'), variant: root.getAttribute('data-theme-variant'), pack: root.getAttribute('data-theme-pack'),
        accent: root.style.getPropertyValue('--accent-blue'), tabsBar: root.style.getPropertyValue('--bg-tabs-bar'), bodyOp: body ? body.style.opacity : null, pre: !!pre, preOp: cs ? +cs.opacity : null, preVis: cs ? cs.visibility : null });
      if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, seedSrc);
  return { page, errors };
}
const frames = (page) => page.evaluate(() => window.__f);
const settle = async (page, ms = 3200) => sleep(ms);
const cacheOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('codemini_theme_cache')));

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const URL = 'http://localhost:8765/index.html';

  console.log('\n[1] Native window: dark+ theme, orange accent, 90% opacity');
  let { page, errors } = await newPage(browser, `localStorage.setItem('codemini_colorTheme','CodeMini Dark +'); localStorage.setItem('codemini_accentColor','#ff5500'); localStorage.setItem('codemini_windowOpacity','90');`);
  await page.goto(URL); await settle(page); await page.reload(); await settle(page);
  let f = await frames(page);
  ok(f[0].theme === 'dark', 'the very first frame already has the saved theme', f[0].theme);
  ok(f.every(x => x.theme === 'dark' && x.variant === 'plus'), 'every frame: dark / plus (0 wrong, was 2 before)');
  ok(f.every(x => x.accent === '#ff5500'), 'every frame: saved accent colour');
  ok(f.filter(x => x.app).every(x => x.bodyOp === '0.9'), 'every frame the app is visible: saved window opacity');
  const firstApp = f.find(x => x.app);
  ok(firstApp.preOp === 1 && firstApp.preVis === 'visible', 'preloader is already fully opaque when the app first appears', firstApp);
  ok(f.slice(0, f.indexOf(firstApp) + 1).every(x => !x.app || (x.preOp === 1 && x.preVis === 'visible')), 'the app is never visible without the opaque preloader over it');
  ok(errors.filter(e => !NOISE.test(e)).length === 0, 'no page errors', errors);

  console.log('\n[2] Preloader leaves with a real fade (not a snap)');
  const fade = f.filter(x => x.pre && x.preOp > 0 && x.preOp < 1);
  ok(fade.length >= 5, 'opacity passes through intermediate values while fading out', fade.length);
  ok(!f[f.length - 1].pre, 'and the overlay is removed afterwards');
  await page.context().close();

  console.log('\n[3] Profile window has its OWN theme');
  ({ page, errors } = await newPage(browser, `
    localStorage.setItem('codemini_windows', JSON.stringify([{id:'win_default',name:'Native',db:'CodeMiniDB',profile:false},{id:'win_p1',name:'Work',db:'CodeMiniDB_profile_1',profile:true}]));
    localStorage.setItem('codemini_active_window','win_p1');
    localStorage.setItem('codemini_colorTheme','CodeMini Light');
    localStorage.setItem('codemini_win_p1_colorTheme','CodeMini Dark'); localStorage.setItem('codemini_win_p1_accentColor','#00aa00');`));
  await page.goto(URL); await settle(page); await page.reload(); await settle(page);
  f = await frames(page);
  ok(f.every(x => x.theme === 'dark' && x.variant === 'base'), 'profile uses its own dark theme, not the native light one');
  ok(f.every(x => x.accent === '#00aa00'), 'and its own accent colour');
  ok(f.every(x => x.tabsBar === '#1a2333'), 'and the profile accent tint (--bg-tabs-bar) from the first frame');
  ok(errors.filter(e => !NOISE.test(e)).length === 0, 'no page errors', errors);
  await page.context().close();

  console.log('\n[4] Theme Pack overrides colour theme and accent');
  ({ page, errors } = await newPage(browser, `localStorage.setItem('codemini_colorTheme','CodeMini Light'); localStorage.setItem('codemini_themePack','CodeMini Premium'); localStorage.setItem('codemini_accentColor','#ff5500');`));
  await page.goto(URL); await settle(page); await page.reload(); await settle(page);
  f = await frames(page);
  ok(f.every(x => x.theme === 'dark' && x.variant === 'premium' && x.pack === 'codemini-premium'), 'pack decides dark/variant/slug from the first frame');
  ok(f.every(x => x.accent === ''), 'the saved accent is NOT applied while a pack is active (same as applyTheme)');
  await page.context().close();

  console.log('\n[5] Changing the theme at runtime updates what the next load shows');
  ({ page, errors } = await newPage(browser, ``));
  await page.goto(URL); await settle(page, 2500);
  ok((await cacheOf(page)).win_default.theme === 'light', 'default install caches the light theme');
  await page.evaluate(() => window.saveSetting('colorTheme', 'CodeMini Dark')); await sleep(300);
  ok((await cacheOf(page)).win_default.theme === 'dark', 'saveSetting updates the cache immediately');
  await page.reload(); await settle(page);
  f = await frames(page);
  ok(f.every(x => x.theme === 'dark'), 'next load is dark from frame 0');
  await page.evaluate(() => window.saveSetting('colorTheme', 'CodeMini Light')); await sleep(300);
  await page.reload(); await settle(page); f = await frames(page);
  ok(f.every(x => x.theme === 'light'), 'and switching back works the same way');
  await page.context().close();

  console.log('\n[6] Robustness');
  ({ page, errors } = await newPage(browser, `localStorage.setItem('codemini_colorTheme','CodeMini Dark'); localStorage.setItem('codemini_theme_cache','{bad json');`));
  await page.goto(URL); await settle(page);
  ok(errors.filter(e => !NOISE.test(e)).length === 0, 'corrupt cache: no page errors', errors);
  ok(await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark', 'corrupt cache: app still ends up on the right theme');
  ok((await cacheOf(page)).win_default.theme === 'dark', 'corrupt cache: rewritten as valid JSON');
  await page.reload(); await settle(page); f = await frames(page);
  ok(f.every(x => x.theme === 'dark'), 'corrupt cache: self-healed, no flash on the next load');
  await page.context().close();

  ({ page, errors } = await newPage(browser, `localStorage.setItem('codemini_colorTheme','CodeMini Light'); localStorage.setItem('codemini_theme_cache', JSON.stringify({win_default:{theme:'dark',variant:'base',pack:'none',vars:{},opacity:1}}));`));
  await page.goto(URL); await settle(page); f = await frames(page);
  ok(f[0].theme === 'dark' && f[f.length - 1].theme === 'light', 'stale cache: wrong at first, corrected by applyTheme (never stuck wrong)', { first: f[0].theme, last: f[f.length - 1].theme });
  ok((await cacheOf(page)).win_default.theme === 'light', 'stale cache: rewritten with the truth');
  await page.context().close();

  ({ page, errors } = await newPage(browser, ``));
  await page.goto(URL); await settle(page); f = await frames(page);
  ok(f[0].theme === null && f.at(-1).theme === 'light' && errors.filter(e => !NOISE.test(e)).length === 0, 'first ever load (no cache): untouched defaults, no errors');
  await page.context().close();

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
