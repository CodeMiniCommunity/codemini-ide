// Behavioural tests for the service worker's same-origin strategy (network-first + timeout + offline fallback).
// Runs sw.js in a vm sandbox with fake caches/fetch, so no browser is needed.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
let src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
src = src.replace(/const NETWORK_TIMEOUT_MS = \d+;/, 'const NETWORK_TIMEOUT_MS = 60;'); // keep the suite fast

function makeEnv({ fetchImpl, cached = {} }) {
  const store = { ...cached }, puts = [], handlers = {};
  const Resp = class { constructor(body, ok = true) { this.body = body; this.ok = ok; } clone() { return new Resp(this.body, this.ok); } };
  Resp.error = () => new Resp('ERROR', false);
  const caches = {
    match: async (req) => { const u = typeof req === 'string' ? req : new URL(req.url).pathname; return store[u]; },
    open: async () => ({ put: async (req, res) => { puts.push(new URL(req.url).pathname); store[new URL(req.url).pathname] = res; }, addAll: async () => {} }),
    keys: async () => []
  };
  const ctx = { self: { addEventListener: (n, f) => { handlers[n] = f; }, skipWaiting() {}, clients: { claim() {} } },
    location: { origin: 'https://app.test' }, caches, fetch: fetchImpl, Response: Resp, URL, setTimeout, clearTimeout, console };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  const request = (p, mode = 'same-origin') => ({ url: 'https://app.test' + p, method: 'GET', mode, headers: { has: () => false } });
  const run = (req) => new Promise((resolve) => handlers.fetch({ request: req, respondWith: (p) => resolve(p) })).then((p) => p);
  const intercepted = (req) => { let hit = false; handlers.fetch({ request: req, respondWith: () => { hit = true; } }); return hit; };
  return { run, request, puts, Resp, intercepted };
}
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('service worker strategy');
  await t('online: serves the network response and refreshes the cache', async () => {
    const e = makeEnv({ fetchImpl: async () => new (makeEnv({ fetchImpl() {} }).Resp)('fresh') });
    const res = await e.run(e.request('/js/core/app.js'));
    assert.strictEqual(res.body, 'fresh'); await sleep(10); assert.deepStrictEqual(e.puts, ['/js/core/app.js']);
  });
  await t('offline: falls back to the cached copy', async () => {
    const R = makeEnv({ fetchImpl() {} }).Resp;
    const e = makeEnv({ fetchImpl: async () => { throw new TypeError('offline'); }, cached: { '/css/style.css': new R('cached-css') } });
    assert.strictEqual((await e.run(e.request('/css/style.css'))).body, 'cached-css');
  });
  await t('offline: an uncached subresource is a real network error, not a crash', async () => {
    const e = makeEnv({ fetchImpl: async () => { throw new TypeError('offline'); } });
    assert.strictEqual((await e.run(e.request('/nope.js'))).ok, false);
  });
  await t('offline navigation to an unknown path serves the cached app shell', async () => {
    const R = makeEnv({ fetchImpl() {} }).Resp;
    const e = makeEnv({ fetchImpl: async () => { throw new TypeError('offline'); }, cached: { '/index.html': new R('shell') } });
    assert.strictEqual((await e.run(e.request('/some/where', 'navigate'))).body, 'shell');
  });
  await t('slow network: serves the cached copy after the timeout instead of hanging', async () => {
    const R = makeEnv({ fetchImpl() {} }).Resp;
    const e = makeEnv({ fetchImpl: () => new Promise(() => {}), cached: { '/index.html': new R('shell') } });
    const t0 = Date.now(); const res = await e.run(e.request('/index.html', 'navigate'));
    assert.strictEqual(res.body, 'shell'); assert.ok(Date.now() - t0 < 1000);
  });
  await t('slow network with nothing cached: keeps waiting for the network', async () => {
    const R = makeEnv({ fetchImpl() {} }).Resp;
    const e = makeEnv({ fetchImpl: () => sleep(150).then(() => new R('late')) });
    assert.strictEqual((await e.run(e.request('/late.js'))).body, 'late');
  });
  await t('non-GET and api.github.com requests are left to the browser', async () => {
    const e = makeEnv({ fetchImpl: async () => { throw new Error('should not be called'); } });
    assert.strictEqual(e.intercepted({ ...e.request('/x'), method: 'POST' }), false);
    assert.strictEqual(e.intercepted({ url: 'https://api.github.com/user', method: 'GET', mode: 'cors', headers: { has: () => false } }), false);
    assert.strictEqual(e.intercepted({ ...e.request('/x'), headers: { has: (h) => h === 'Authorization' } }), false);
    assert.strictEqual(e.intercepted(e.request('/x')), true); // control: a plain same-origin GET IS handled
  });
  console.log(`\n${n} service worker checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
