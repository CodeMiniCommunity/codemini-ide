const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };

async function scenario(browser, { monaco, filesDelay = 0, waitMs, probe }) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [], warns = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'warning') warns.push(m.text()); });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.addInitScript(({ monaco, filesDelay }) => {
    // timeline of the overlay, measured from navigation start
    window.__ev = {};
    new MutationObserver(() => {
      const el = document.getElementById('appPreloader');
      if (el && el.classList.contains('show') && !__ev.shown) __ev.shown = performance.now();
      if (el && !el.classList.contains('show') && __ev.shown && !__ev.fadeStart) __ev.fadeStart = performance.now();
      if (!el && __ev.shown && !__ev.removed) __ev.removed = performance.now();
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    // stand-in for Monaco's AMD loader. monaco: 'missing' = loader script failed; 'never' = loads but never finishes; number = ms until loaded
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    if (monaco !== 'missing') {
      window.require = (deps, cb) => { if (monaco === 'never') return; setTimeout(() => { window.monaco = mk(); cb(); }, monaco); };
      window.require.config = () => {};
    }
    // simulate a slow database open / session restore by delaying the 'files' signal
    let real;
    Object.defineProperty(window, 'CodeMiniPreloader', { configurable: true, get: () => real, set(v) { real = { markReady(n) { if (n === 'files' && filesDelay) setTimeout(() => v.markReady(n), filesDelay); else v.markReady(n); } }; } });
  }, { monaco, filesDelay });
  await page.goto('http://localhost:8765/index.html');
  let probed;
  if (probe) { await sleep(probe.at); probed = await page.evaluate(probe.fn); await sleep(Math.max(0, waitMs - probe.at)); } else await sleep(waitMs);
  const ev = await page.evaluate(() => ({ ...window.__ev, hasOverlay: !!document.getElementById('appPreloader'), hasStyles: !!document.getElementById('codemini-preloader-styles'), now: performance.now() }));
  return { page, ev, errors, warns, probed };
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const round = (n) => Math.round(n);

  console.log('\n[A] Fast load (Monaco + files ready immediately)');
  let r = await scenario(browser, { monaco: 0, waitMs: 3000 });
  console.log('   timeline(ms):', JSON.stringify({ shown: round(r.ev.shown), fadeStart: round(r.ev.fadeStart), removed: round(r.ev.removed) }));
  ok(r.ev.fadeStart < 2000, 'overlay starts fading well before the old fixed 4000ms', round(r.ev.fadeStart));
  ok(r.ev.fadeStart - r.ev.shown >= 480, 'but is shown at least ~500ms (no on/off flash)', round(r.ev.fadeStart - r.ev.shown));
  ok(!r.ev.hasOverlay && !r.ev.hasStyles, 'overlay and its <style> are removed from the DOM afterwards');
  await r.page.evaluate(() => window.CodeMiniPreloader.markReady('files'));
  ok(r.errors.filter(e => !/monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::/i.test(e)).length === 0, 'no page errors; calling markReady again after removal is harmless', r.errors);
  await r.page.context().close();

  console.log('\n[B] Slow Monaco (3000ms)');
  r = await scenario(browser, { monaco: 3000, waitMs: 5200, probe: { at: 2200, fn: () => { const o = document.getElementById('appPreloader'); return { shown: !!o && o.classList.contains('show'), pe: o ? getComputedStyle(o).pointerEvents : null, topAtCentre: document.elementFromPoint(640, 400) === o || (o && o.contains(document.elementFromPoint(640, 400))) }; } } });
  console.log('   timeline(ms):', JSON.stringify({ fadeStart: round(r.ev.fadeStart), removed: round(r.ev.removed) }));
  ok(r.probed.shown === true, 'still covering the app at 2.2s while the editor is loading');
  ok(r.probed.pe === 'all' && r.probed.topAtCentre, 'while visible it blocks interaction (it is what you would click)', r.probed);
  ok(r.ev.fadeStart >= 3000 && r.ev.fadeStart < 4600, 'fades out right after Monaco arrives', round(r.ev.fadeStart));
  ok(await r.page.evaluate(() => { const e = document.elementFromPoint(640, 400); return !!e && !e.closest('#appPreloader'); }), 'afterwards the app underneath receives clicks again');
  await r.page.context().close();

  console.log('\n[C] Slow restore / database (files signal at 3500ms)');
  r = await scenario(browser, { monaco: 0, filesDelay: 3500, waitMs: 5500, probe: { at: 3000, fn: () => !!document.getElementById('appPreloader') && document.getElementById('appPreloader').classList.contains('show') } });
  console.log('   timeline(ms):', JSON.stringify({ fadeStart: round(r.ev.fadeStart), removed: round(r.ev.removed) }));
  ok(r.probed === true, 'editor is ready but the overlay stays until the files are');
  ok(r.ev.fadeStart >= 3500 && r.ev.fadeStart < 5000, 'fades out right after the files report in', round(r.ev.fadeStart));
  await r.page.context().close();

  console.log('\n[D] Monaco loader unreachable (offline first visit): must not wait for it');
  r = await scenario(browser, { monaco: 'missing', waitMs: 3500 });
  console.log('   timeline(ms):', JSON.stringify({ fadeStart: round(r.ev.fadeStart), removed: round(r.ev.removed) }));
  ok(r.ev.fadeStart < 3000, 'hides soon after load instead of waiting for the safety cap', round(r.ev.fadeStart));
  ok(!r.ev.hasOverlay, 'overlay gone');
  await r.page.context().close();

  console.log('\n[E] Safety cap: Monaco never finishes');
  r = await scenario(browser, { monaco: 'never', waitMs: 9300 });
  console.log('   timeline(ms):', JSON.stringify({ fadeStart: round(r.ev.fadeStart), removed: round(r.ev.removed) }));
  ok(r.ev.fadeStart >= 7900 && r.ev.fadeStart < 8800, 'hides at the 8s cap rather than blocking forever', round(r.ev.fadeStart));
  ok(r.warns.some(w => /Preloader: hiding after/.test(w) && /editor/.test(w)), 'and logs what it was still waiting for', r.warns);
  ok(!r.ev.hasOverlay, 'overlay gone, app usable');
  await r.page.context().close();

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
