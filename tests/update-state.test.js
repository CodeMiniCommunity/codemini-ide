// Update flow in js/core/pwa.js, run against fakes (no browser): the shared update state, the "was updated, Reload"
// toast, manual vs scheduled checks and the Auto Check Updates setting.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'js/core/pwa.js'), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

// Just enough DOM for the toast. Every created element is recorded so a test can count toasts.
function makeEnv({ controlled, updateImpl }) {
  const toasts = [], listeners = {}, swListeners = {}, intervals = [];
  const el = (tag) => {
    const e = { tag, className: '', style: {}, children: [], classList: { add() {}, remove() {} },
      append(...k) { this.children.push(...k); }, appendChild(k) { this.children.push(k); return k; },
      setAttribute() {}, addEventListener(ev, fn) { (this.on = this.on || {})[ev] = fn; }, remove() {} };
    if (tag === 'div') toasts.push(e);
    return e;
  };
  const doc = { body: el('body'), readyState: 'complete', getElementById: () => null, createElement: el, createTextNode: (s) => s,
    addEventListener() {}, visibilityState: 'visible' };
  const registration = { installing: null, waiting: null, update: () => updateImpl(registration) };
  const sw = { controller: controlled ? {} : null,
    addEventListener: (ev, fn) => { swListeners[ev] = fn; },
    register: () => Promise.resolve(registration) };
  const win = {
    document: doc, navigator: { serviceWorker: sw }, location: { reload() { win.reloaded = true; } },
    matchMedia: () => ({ matches: false }), reloaded: false,
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    dispatchEvent: (e) => { (listeners[e.type] || []).slice().forEach((f) => f(e)); return true; },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout, clearTimeout, setInterval: (fn) => { intervals.push(fn); return 0; }
  };
  win.window = win;
  const ctx = vm.createContext(Object.assign(win, { console, CustomEvent: win.CustomEvent, Promise, Date, Object, Error }));
  ctx.document = doc; ctx.navigator = win.navigator;
  vm.runInContext(src, ctx);
  const loaded = () => (listeners.load || []).forEach((f) => f());
  return { win, ctx, registration, toasts, intervals, controllerchange: () => swListeners.controllerchange(), loaded,
    states: () => { const out = []; win.addEventListener('codemini:update-state', (e) => out.push(e.detail.status)); return out; } };
}
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log('update state');
  await t('starts idle and exposes the API', async () => {
    const env = makeEnv({ controlled: true, updateImpl: () => Promise.resolve() });
    assert.strictEqual(env.win.CodeMiniPWA.getUpdateState().status, 'idle');
    assert.strictEqual(env.win.CodeMiniPWA.UPDATE_EVENT, 'codemini:update-state');
    assert.strictEqual(typeof env.win.CodeMiniPWA.reload, 'function');
  });

  await t('the very first install is not an "update" (no toast, no state change)', async () => {
    const env = makeEnv({ controlled: false, updateImpl: () => Promise.resolve() });
    env.controllerchange();
    assert.strictEqual(env.win.CodeMiniPWA.getUpdateState().status, 'idle');
    assert.strictEqual(env.toasts.filter((x) => x.className === 'custom-toast').length, 0);
  });

  await t('a new version becomes status "updated", announces it once, and shows the Reload toast', async () => {
    const env = makeEnv({ controlled: true, updateImpl: () => Promise.resolve() });
    const seen = env.states();
    env.controllerchange(); env.controllerchange();
    assert.deepStrictEqual(seen, ['updated']);
    assert.strictEqual(env.toasts.filter((x) => x.className === 'custom-toast').length, 1);
    assert.strictEqual(env.win.CodeMiniPWA.getUpdateState().status, 'updated');
  });

  await t('it never reloads by itself; reload() is the only way', async () => {
    const env = makeEnv({ controlled: true, updateImpl: () => Promise.resolve() });
    env.controllerchange();
    assert.strictEqual(env.win.reloaded, false);
    env.win.CodeMiniPWA.reload();
    assert.strictEqual(env.win.reloaded, true);
  });

  console.log('manual check');
  await t('"unsupported" until the service worker has registered', async () => {
    const env = makeEnv({ controlled: true, updateImpl: () => Promise.resolve() });
    assert.strictEqual(await env.win.CodeMiniPWA.checkForUpdates(), 'unsupported');
  });

  await t('nothing new: checking -> up-to-date, with a lastChecked time', async () => {
    const env = makeEnv({ controlled: true, updateImpl: () => Promise.resolve() });
    env.loaded(); await settle();
    const seen = env.states();
    assert.strictEqual(await env.win.CodeMiniPWA.checkForUpdates(), 'up-to-date');
    assert.deepStrictEqual(seen, ['checking', 'idle']);
    const st = env.win.CodeMiniPWA.getUpdateState();
    assert.ok(st.lastChecked > 0 && st.lastCheckFailed === false);
  });

  await t('a new version found while checking resolves "updated"', async () => {
    const env = makeEnv({ controlled: true, updateImpl: (reg) => { reg.installing = {}; return Promise.resolve(); } });
    env.loaded(); await settle();
    const p = env.win.CodeMiniPWA.checkForUpdates();
    await settle();
    env.controllerchange();
    assert.strictEqual(await p, 'updated');
    assert.strictEqual(env.win.CodeMiniPWA.getUpdateState().status, 'updated');
  });

  await t('offline: resolves "failed", flags it, and goes back to idle (not stuck on checking)', async () => {
    const env = makeEnv({ controlled: true, updateImpl: () => Promise.reject(new Error('offline')) });
    env.loaded(); await settle();
    assert.strictEqual(await env.win.CodeMiniPWA.checkForUpdates(), 'failed');
    const st = env.win.CodeMiniPWA.getUpdateState();
    assert.strictEqual(st.status, 'idle'); assert.strictEqual(st.lastCheckFailed, true);
  });

  await t('once updated, further checks just report "updated"', async () => {
    let calls = 0;
    const env = makeEnv({ controlled: true, updateImpl: () => { calls++; return Promise.resolve(); } });
    env.loaded(); await settle();
    env.controllerchange();
    assert.strictEqual(await env.win.CodeMiniPWA.checkForUpdates(), 'updated');
    assert.strictEqual(calls, 0);
  });

  console.log('scheduled checks');
  await t('hourly check runs while Auto Check Updates is on', async () => {
    let calls = 0;
    const env = makeEnv({ controlled: true, updateImpl: () => { calls++; return Promise.resolve(); } });
    env.loaded(); await settle();
    assert.strictEqual(env.intervals.length, 1);
    env.intervals[0](); await settle();
    assert.strictEqual(calls, 1);
  });

  await t('hourly check is skipped while Auto Check Updates is off, but a manual check still works', async () => {
    let calls = 0;
    const env = makeEnv({ controlled: true, updateImpl: () => { calls++; return Promise.resolve(); } });
    env.win.appSettings = { autoCheckUpdates: false };
    env.loaded(); await settle();
    env.intervals[0](); await settle();
    assert.strictEqual(calls, 0);
    assert.strictEqual(await env.win.CodeMiniPWA.checkForUpdates(), 'up-to-date');
    assert.strictEqual(calls, 1);
  });

  await t('a failed scheduled check is silent (no state flip, no toast)', async () => {
    const env = makeEnv({ controlled: true, updateImpl: () => Promise.reject(new Error('offline')) });
    env.loaded(); await settle();
    const seen = env.states();
    env.intervals[0](); await settle();
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(env.toasts.filter((x) => x.className === 'custom-toast').length, 0);
  });

  console.log(`\n${n} update-state checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
