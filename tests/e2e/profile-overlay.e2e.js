const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const NOISE = /monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i;

async function open(browser, { active, profileName = 'Work Profile' }) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [], warns = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'warning') warns.push(m.text()); });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.addInitScript(({ active, profileName }) => {
    if (!localStorage.getItem('codemini_windows')) {
      localStorage.setItem('codemini_windows', JSON.stringify([
        { id: 'win_default', name: '- Native Window -', db: 'CodeMiniDB', profile: false },
        { id: 'win_p1', name: profileName, db: 'CodeMiniDB_profile_1', profile: true }]));
      localStorage.setItem('codemini_active_window', active);
    }
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
    // per-frame record of both overlays (+ what the preloader says), and transitions of the profile overlay
    window.__t0 = performance.now(); window.__frames = []; window.__profEvents = []; let last = null;
    const tick = () => {
      const pre = document.getElementById('appPreloader'), prof = document.getElementById('profileLoadingOverlay');
      const preShow = !!pre && pre.classList.contains('show'), profShow = !!prof && prof.classList.contains('show');
      window.__frames.push({ t: performance.now() - __t0, pre: preShow, prof: profShow, preText: pre ? pre.innerText.replace(/\s+/g, ' ').trim() : null, hasProfileLabel: !!(pre && pre.querySelector('.app-preloader-profile')) });
      if (profShow !== last) { last = profShow; window.__profEvents.push({ t: performance.now(), show: profShow, text: (document.getElementById('profileLoadingText') || {}).textContent, name: (document.getElementById('profileLoadingName') || {}).textContent }); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { active, profileName });
  await page.goto('http://localhost:8765/index.html');
  return { page, errors, warns, ev: (f, a) => page.evaluate(f, a) };
}
const round = Math.round;
const lastEvent = (evs, show) => [...evs].reverse().find(e => e.show === show);

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  console.log('\n[1] Startup with a PROFILE window active');
  let s = await open(browser, { active: 'win_p1', profileName: 'Work <b>Profile</b>' });
  await sleep(2500);
  let fr = await s.ev(() => window.__frames);
  const both = fr.filter(f => f.pre && f.prof).length;
  ok(both === 0, 'the two overlays are never on screen at the same time (was ~150 frames / 3s before)', both);
  ok(fr.every(f => !f.prof), 'the profile overlay is not used at startup at all');
  const withLabel = fr.find(f => f.pre && f.hasProfileLabel);
  ok(!!withLabel && /Work <b>Profile<\/b>/.test(withLabel.preText), 'the single preloader names the profile (literally - HTML in the name is not interpreted)', withLabel && withLabel.preText);
  ok(!!withLabel && /Loading profile\.\.\./.test(withLabel.preText), 'and says "Loading profile..."', withLabel && withLabel.preText);
  ok(await s.ev(() => !document.getElementById('appPreloader') && !document.querySelector('.app-preloader-profile b')), 'preloader gone afterwards; no injected <b> element was created');
  ok(await s.ev(() => { const o = document.getElementById('profileLoadingOverlay'); return getComputedStyle(o).pointerEvents === 'none'; }), 'nothing left blocking the app');
  ok(await s.ev(() => cellActiveWindow.profile === true), 'app really did start in the profile window');
  ok(s.errors.filter(e => !NOISE.test(e)).length === 0, 'no page errors', s.errors);
  await s.page.context().close();

  console.log('\n[2] Startup with the NATIVE window active (unchanged)');
  s = await open(browser, { active: 'win_default' });
  await sleep(1800);
  fr = await s.ev(() => window.__frames);
  const nat = fr.find(f => f.pre);
  ok(nat && !nat.hasProfileLabel && /Loading CodeMini\.\.\./.test(nat.preText), 'plain preloader, no profile line, "Loading CodeMini..."', nat && nat.preText);
  ok(fr.every(f => !f.prof), 'profile overlay not shown');
  await s.page.context().close();

  // The remaining scenarios start native and switch windows at runtime.
  const startNative = async () => { const x = await open(browser, { active: 'win_default' }); await sleep(2200); await x.ev(() => { window.__profEvents.length = 0; }); return x; };

  console.log('\n[3] Switching windows - fast load');
  s = await startNative();
  await s.ev(() => { window.__t = performance.now(); switchWindow('win_p1'); });
  await sleep(3500);
  let evs = await s.ev(() => window.__profEvents);
  let up = lastEvent(evs, true), down = lastEvent(evs, false);
  console.log('   shown for', round(down.t - up.t), 'ms');
  ok(up && up.text === 'Loading profile...' && up.name === 'Work Profile', 'overlay shows the right text and name');
  ok(down.t - up.t >= 480 && down.t - up.t < 1800, 'hides as soon as the window has loaded (min 500ms) - was always 3000ms', round(down.t - up.t));
  ok(await s.ev(() => document.getElementById('profileLoadingOverlay').style.display !== 'block' && getComputedStyle(document.getElementById('profileLoadingOverlay')).pointerEvents === 'none'), 'app is clickable again');
  ok(await s.ev(() => cellActiveWindow.id === 'win_p1' && db && db.name === 'CodeMiniDB_profile_1'), 'and the profile window really is loaded');

  console.log('\n[4] Switching windows - profile -> native');
  await s.ev(() => { window.__profEvents.length = 0; switchWindow('win_default'); });
  await sleep(2500);
  evs = await s.ev(() => window.__profEvents); up = lastEvent(evs, true); down = lastEvent(evs, false);
  ok(up && up.text === 'Loading Native Window...' && down && down.t - up.t >= 480 && down.t - up.t < 1800, 'native text, and hides when loaded', up && { text: up.text, ms: down && round(down.t - up.t) });

  console.log('\n[5] Creating a window with a profile');
  await s.ev(() => { window.__profEvents.length = 0; cellActiveWindow = cellWindows[1]; window.showProfileLoadingOverlay('New One', true); window.profileLoadingReady(cellActiveWindow.db); });
  await sleep(300);
  evs = await s.ev(() => window.__profEvents);
  ok(lastEvent(evs, true) && lastEvent(evs, true).text === 'Creating window with profile...', 'creating text');
  await sleep(1200);
  await s.page.context().close();

  console.log('\n[6] A window that is slow to load (reports in at 4500ms)');
  s = await startNative();
  await s.ev(() => { const real = window.profileLoadingReady; window.profileLoadingReady = (d) => setTimeout(() => real(d), 4500); switchWindow('win_p1'); });
  await sleep(3800);
  ok(await s.ev(() => document.getElementById('profileLoadingOverlay').classList.contains('show')), 'still showing at 3.8s - the old fixed 3000ms timer would already have dismissed it');
  await sleep(2200);
  evs = await s.ev(() => window.__profEvents); up = lastEvent(evs, true); down = lastEvent(evs, false);
  ok(down.t - up.t >= 4400 && down.t - up.t < 5800, 'then hides right after the window reports in', round(down.t - up.t));
  await s.page.context().close();

  console.log('\n[7] A stale completion from another database must not dismiss it');
  s = await startNative();
  await s.ev(() => { window.__profEvents.length = 0; cellActiveWindow = cellWindows[1]; window.showProfileLoadingOverlay('X', false); });
  await s.ev(() => window.profileLoadingReady('CodeMiniDB'));         // wrong database (the window we just left)
  await sleep(1300);
  ok(await s.ev(() => document.getElementById('profileLoadingOverlay').classList.contains('show')), 'a completion for the OLD database is ignored - overlay stays');
  await s.ev(() => window.profileLoadingReady('CodeMiniDB_profile_1')); // the right one
  await sleep(1300);
  ok(!(await s.ev(() => document.getElementById('profileLoadingOverlay').classList.contains('show'))), 'the matching completion dismisses it');
  await s.page.context().close();

  console.log('\n[8] Rapid double switch never leaves it stuck');
  s = await startNative();
  await s.ev(() => { switchWindow('win_p1'); switchWindow('win_default'); });
  await sleep(3000);
  const rap = await s.ev(() => ({ shown: document.getElementById('profileLoadingOverlay').classList.contains('show'), win: cellActiveWindow.id, db: db && db.name }));
  ok(rap.shown === false && rap.win === 'win_default', 'overlay gone and the last window wins', rap);
  await s.page.context().close();

  console.log('\n[9] Safety cap: the window never reports in');
  s = await startNative();
  await s.ev(() => { window.profileLoadingReady = () => {}; switchWindow('win_p1'); });
  await sleep(8900);
  evs = await s.ev(() => window.__profEvents); up = lastEvent(evs, true); down = lastEvent(evs, false);
  ok(down && down.t - up.t >= 7900 && down.t - up.t < 8700, 'hides at the 8s cap instead of blocking forever', down && round(down.t - up.t));
  ok(s.warns.some(w => /Profile loading overlay: hiding after/.test(w)), 'and logs why', s.warns);
  ok(s.errors.filter(e => !NOISE.test(e)).length === 0, 'no page errors', s.errors);
  await s.page.context().close();

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
