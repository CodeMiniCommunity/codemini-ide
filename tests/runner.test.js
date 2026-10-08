// The runner shell (runner/shell.js) and the client (js/viewers/runner-client.js) driven against fake windows.
// The real-browser version, with two origins, is tests/e2e/runner.e2e.js.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

const IDE = 'https://the-code-mini-ide.vercel.app', RUNNER = 'https://the-code-mini-runner.vercel.app';
const NONCE = 'a'.repeat(32);

// ---- the shell, on a fake window ----
function shell(opts) {
  opts = opts || {};
  const handlers = [], toHost = [], toPage = [];
  const host = { postMessage: (m, o) => toHost.push({ m, o }) };
  const pageWin = { postMessage: (m, o) => toPage.push({ m, o }) };
  // A frame that behaves like a real one: after `src` is set it shows that address (unless the test blocks it).
  const writes = [];
  // like a browser, document.open() makes the document adopt the address of the script that called it (the shell's)
  pageWin.document = { documentElement: {}, readyState: 'complete', open() { writes.push('open'); pageWin.location.href = 'https://the-code-mini-runner.vercel.app/shell.html'; }, write(h) { writes.push(h); }, close() { writes.push('close'); } }; pageWin.location = { href: 'about:blank', protocol: 'about:' };
  // mode: 'ok' commits the page at once; 'late' keeps showing the old blank frame until commit() (WebKit fires the old
  // frame's load first); 'blocked' never shows the page; 'foreign' turns the frame cross-origin.
  const page = { contentWindow: pageWin, onload: null, _src: '', mode: 'ok',
    get src() { return this._src; },
    set src(v) {
      this._src = v;
      if (this.mode === 'ok') { pageWin.location.href = v; pageWin.location.protocol = 'blob:'; }
      if (this.mode === 'foreign') Object.defineProperty(pageWin, 'location', { configurable: true, get() { throw Object.assign(new Error('x'), { name: 'SecurityError' }); } });
    },
    commit() { pageWin.location.href = this._src; pageWin.location.protocol = 'blob:'; } };
  const clock = { t: 1000 }, timers = [];
  const made = new Set(); let seq = 0;
  const win = { parent: host, addEventListener: (type, fn) => { if (type === 'message') handlers.push(fn); } };
  const hostname = opts.hostname || 'the-code-mini-runner.vercel.app';
  win.CM_RUNNER_CONFIG = undefined;
  const ctx = vm.createContext({
    window: win, document: { getElementById: () => page },
    location: { origin: opts.origin || RUNNER, hostname, ancestorOrigins: opts.ancestors === undefined ? [IDE] : opts.ancestors },
    URL: { createObjectURL: () => { const u = 'blob:' + RUNNER + '/' + (++seq); made.add(u); return u; }, revokeObjectURL: (u) => made.delete(u) },
    Blob, Object, Array, String, Date: { now: () => clock.t },
    setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval: (id) => { timers[id - 1] = null; }
  });
  vm.runInContext(read('runner/config.js'), ctx);
  vm.runInContext(read('runner/shell.js'), ctx);
  const send = (source, origin, data) => handlers.forEach((h) => h({ source, origin, data }));
  const tick = (ms) => { clock.t += ms; timers.slice().forEach((fn) => { if (fn) fn(); }); };
  return { host, pageWin, page, toHost, toPage, made, send, win, ctx, tick, writes };
}
const hello = (s, origin, nonce) => s.send(s.host, origin || IDE, { cmRunner: 1, op: 'hello', nonce: nonce || NONCE });

(async () => {
  console.log('the runner shell');
  await t('announces itself to the embedding app (and only to an allowed ancestor)', () => {
    const s = shell(); assert.deepStrictEqual(s.toHost.map((x) => [x.m.op, x.o]), [['ready', IDE]]);
    const stranger = shell({ ancestors: ['https://evil.example'] }); assert.strictEqual(stranger.toHost.length, 0);
    const firefox = shell({ ancestors: null }); assert.strictEqual(firefox.toHost[0].o, '*'); // no ancestorOrigins: an empty announcement to any parent
  });
  await t('the production runner allows only the production app; localhost is allowed only when the runner itself is on localhost', () => {
    assert.deepStrictEqual(Array.from(shell().win.CM_RUNNER_CONFIG.allowedParents), [IDE]);
    assert.ok(shell({ hostname: 'localhost', origin: 'http://localhost:8766' }).win.CM_RUNNER_CONFIG.allowedParents.includes('http://localhost:8765'));
  });
  await t('only an allowed origin can shake hands, and only once; the ack carries the nonce', () => {
    const s = shell(); s.toHost.length = 0;
    hello(s, 'https://evil.example'); assert.strictEqual(s.toHost.length, 0);
    s.send(s.pageWin, IDE, { cmRunner: 1, op: 'hello', nonce: NONCE }); assert.strictEqual(s.toHost.length, 0, 'the previewed page cannot say hello');
    hello(s, IDE, 'short'); assert.strictEqual(s.toHost.length, 0, 'a weak nonce is refused');
    hello(s); assert.deepStrictEqual(s.toHost.map((x) => [x.m.op, x.m.nonce, x.o]), [['hello-ack', NONCE, IDE]]);
    hello(s, IDE, 'b'.repeat(32)); assert.strictEqual(s.toHost.length, 1, 'a second hello does not change the pin');
  });
  await t('nothing is minted, shown or relayed before the handshake', () => {
    const s = shell(); s.toHost.length = 0;
    s.send(s.host, IDE, { cmRunner: 1, op: 'mint', id: 1, blob: new Blob(['x']) });
    s.send(s.host, IDE, { type: 'console' });
    assert.strictEqual(s.toHost.length, 0); assert.strictEqual(s.toPage.length, 0); assert.strictEqual(s.made.size, 0);
  });
  await t('mints blob URLs on request, refuses non-blobs, and revokes only what it made', () => {
    const s = shell(); hello(s); s.toHost.length = 0;
    s.send(s.host, IDE, { cmRunner: 1, op: 'mint', id: 7, blob: new Blob(['body{}'], { type: 'text/css' }) });
    const m = s.toHost[0].m; assert.strictEqual(m.op, 'minted'); assert.strictEqual(m.id, 7); assert.ok(m.url.startsWith('blob:' + RUNNER + '/')); assert.strictEqual(m.nonce, NONCE);
    s.send(s.host, IDE, { cmRunner: 1, op: 'mint', id: 8, blob: 'not a blob' }); assert.ok(s.toHost[1].m.error);
    s.send(s.host, IDE, { cmRunner: 1, op: 'revoke', urls: [m.url, 'blob:https://elsewhere/1'] }); assert.ok(!s.made.has(m.url));
  });
  await t('shows only URLs it minted, and reports when the page has loaded', () => {
    const s = shell(); hello(s); s.toHost.length = 0;
    s.send(s.host, IDE, { cmRunner: 1, op: 'mint', id: 1, blob: new Blob(['<p>']) }); const url = s.toHost[0].m.url;
    s.send(s.host, IDE, { cmRunner: 1, op: 'show', id: 2, url: 'https://evil.example/' }); assert.ok(s.toHost[1].m.error); assert.strictEqual(s.page.src, '');
    s.send(s.host, IDE, { cmRunner: 1, op: 'show', id: 3, url }); assert.strictEqual(s.page.src, url);
    s.page.onload(); assert.deepStrictEqual([s.toHost[2].m.op, s.toHost[2].m.id], ['shown', 3]);
    s.send(s.host, IDE, { cmRunner: 1, op: 'show', id: 4, url }); const stale = s.page.onload; s.send(s.host, IDE, { cmRunner: 1, op: 'show', id: 5, url });
    stale(); assert.ok(!s.toHost.some((x) => x.m.id === 4 && x.m.op === 'shown'), 'a superseded show does not report');
  });
  const minted = (s) => { s.send(s.host, IDE, { cmRunner: 1, op: 'mint', id: 1, blob: new Blob(['<p>']) }); return s.toHost[s.toHost.length - 1].m.url; };
  await t('WebKit: the old blank frame\'s load event is NOT taken for the page; it reports once the page really commits', () => {
    const s = shell(); hello(s); s.page.mode = 'late'; const url = minted(s); s.toHost.length = 0;
    s.send(s.host, IDE, { cmRunner: 1, op: 'show', id: 2, url });
    s.page.onload();                                          // the initial about:blank finishing: must not count
    s.tick(100); assert.strictEqual(s.toHost.length, 0, 'still waiting for the page');
    s.page.commit(); s.tick(100);
    assert.deepStrictEqual(s.toHost.map((x) => [x.m.op, x.m.id, x.m.error]), [['shown', 2, undefined]]);
    s.tick(5000); assert.strictEqual(s.toHost.length, 1, 'reported once');
  });
  await t('a page still loading at the deadline is reported as shown (it is there, just slow)', () => {
    const s = shell(); hello(s); const url = minted(s); s.toHost.length = 0;
    s.pageWin.document.readyState = 'loading';
    s.send(s.host, IDE, { cmRunner: 1, op: 'show', id: 2, url }); s.tick(100); assert.strictEqual(s.toHost.length, 0);
    s.tick(4000); assert.deepStrictEqual(s.toHost.map((x) => [x.m.op, x.m.error]), [['shown', undefined]]);
  });
  await t('a frame that stays blank is reported as failed after the deadline, with the reason', () => {
    const s = shell(); hello(s); s.page.mode = 'blocked'; const url = minted(s); s.toHost.length = 0;
    s.send(s.host, IDE, { cmRunner: 1, op: 'show', id: 2, url }); s.page.onload(); s.tick(3000); assert.strictEqual(s.toHost.length, 0);
    s.tick(1500); assert.match(s.toHost[0].m.error, /page did not load: the frame still shows about: after 4 s/);
  });
  await t('a frame that turned cross-origin (an error page) is reported at once', () => {
    const s = shell(); hello(s); s.page.mode = 'foreign'; const url = minted(s); s.toHost.length = 0;
    s.send(s.host, IDE, { cmRunner: 1, op: 'show', id: 2, url }); s.tick(100);
    assert.match(s.toHost[0].m.error, /not reachable \(SecurityError\)/);
  });
  await t('an empty document with no <html> is reported as an empty frame', () => {
    const s = shell(); hello(s); s.page.mode = 'blocked'; const url = minted(s); s.toHost.length = 0;
    s.pageWin.document = { documentElement: null };
    s.send(s.host, IDE, { cmRunner: 1, op: 'show', id: 2, url }); s.tick(4100);
    assert.match(s.toHost[0].m.error, /stayed empty/);
  });
  await t('rewrite: writes new HTML into the page that is showing (keeping its window), and says so when nothing is showing', () => {
    const s = shell(); hello(s); const url = minted(s); s.toHost.length = 0;
    s.send(s.host, IDE, { cmRunner: 1, op: 'rewrite', id: 5, html: '<p>x</p>' });
    assert.match(s.toHost[0].m.error, /no page to rewrite/); assert.strictEqual(s.writes.length, 0, 'nothing shown yet: no write');
    s.send(s.host, IDE, { cmRunner: 1, op: 'show', id: 6, url }); s.tick(100);                // now a page is showing
    s.toHost.length = 0;
    s.send(s.host, IDE, { cmRunner: 1, op: 'rewrite', id: 7, html: '<h1>new</h1>' });
    assert.deepStrictEqual(s.writes, ['open', '<h1>new</h1>', 'close']); assert.deepStrictEqual([s.toHost[0].m.op, s.toHost[0].m.id, s.toHost[0].m.error], ['rewritten', 7, undefined]);
    s.send(s.host, IDE, { cmRunner: 1, op: 'rewrite', id: 8, html: { not: 'a string' } }); assert.match(s.toHost[1].m.error, /bad html/);
    s.writes.length = 0; s.send(s.host, IDE, { cmRunner: 1, op: 'rewrite', id: 10, html: '<h1>again</h1>' });   // a SECOND rewrite works too, though the frame now shows the shell's address
    assert.deepStrictEqual(s.writes, ['open', '<h1>again</h1>', 'close']); assert.strictEqual(s.toHost[2].m.error, undefined);
    s.pageWin.location.href = 'https://elsewhere.example/'; s.writes.length = 0;                 // the page navigated away
    s.send(s.host, IDE, { cmRunner: 1, op: 'rewrite', id: 9, html: '<p>' }); assert.match(s.toHost[3].m.error, /no page to rewrite/); assert.strictEqual(s.writes.length, 0);
  });
  await t('rewrite is only accepted from the app, never from the page', () => {
    const s = shell(); hello(s); const url = minted(s);
    s.send(s.host, IDE, { cmRunner: 1, op: 'show', id: 1, url }); s.tick(100); s.toHost.length = 0; s.writes.length = 0;
    s.send(s.pageWin, RUNNER, { cmRunner: 1, op: 'rewrite', id: 2, html: '<script>evil()</script>' });
    assert.strictEqual(s.writes.length, 0); assert.strictEqual(s.toHost[0].m.op, 'page'); // it is only ever relayed as page data
  });
  await t('relays app messages to the page (to the runner origin only) and wraps page messages in an envelope', () => {
    const s = shell(); hello(s); s.toHost.length = 0;
    s.send(s.host, IDE, { type: 'toggle-inspector', enabled: true });
    assert.deepStrictEqual([s.toPage[0].m.type, s.toPage[0].o], ['toggle-inspector', RUNNER]);
    s.send(s.pageWin, RUNNER, { type: 'console', args: ['hi'] });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(s.toHost[0])), { m: { cmRunner: 1, op: 'page', data: { type: 'console', args: ['hi'] } }, o: IDE });
    assert.strictEqual(s.toHost[0].m.nonce, undefined, 'page envelopes carry no nonce, so a page can never be mistaken for the shell');
  });
  await t('ignores a page that has navigated to another origin, and any other sender', () => {
    const s = shell(); hello(s); s.toHost.length = 0;
    s.send(s.pageWin, 'https://evil.example', { type: 'console' }); s.send({}, RUNNER, { type: 'console' }); s.send(s.host, 'https://evil.example', { type: 'x' });
    assert.strictEqual(s.toHost.length, 0); assert.strictEqual(s.toPage.length, 0);
  });
  await t('a page cannot pass app-control messages: its cmRunner objects are only ever wrapped as data', () => {
    const s = shell(); hello(s); s.toHost.length = 0;
    s.send(s.pageWin, RUNNER, { cmRunner: 1, op: 'minted', id: 1, url: 'blob:https://evil/1', nonce: NONCE });
    const m = s.toHost[0].m; assert.strictEqual(m.op, 'page'); assert.strictEqual(m.nonce, undefined); assert.strictEqual(m.data.op, 'minted');
    assert.strictEqual(s.made.size, 0);
  });

  console.log('the client');
  function client(opts) {
    opts = opts || {};
    const ls = Object.assign({}, opts.ls || {});
    const events = [], listeners = [];
    const frameListeners = {};
    const iframe = { dataset: {}, contentWindow: { postMessage() {} }, removeAttribute() {}, set src(v) { this._src = v; }, get src() { return this._src; },
      addEventListener: (type, fn) => { frameListeners[type] = fn; }, removeEventListener() {}, fireLoad: () => frameListeners.load && frameListeners.load() };
    const win = { addEventListener: (t2, fn) => { if (t2 === 'message') listeners.push(fn); }, dispatchEvent: (e) => { events.push(e); return true; } };
    const ctx = vm.createContext({
      window: win, document: { getElementById: () => iframe },
      location: { origin: opts.origin || IDE, hostname: opts.hostname || 'the-code-mini-ide.vercel.app' },
      localStorage: { getItem: (k) => (k in ls ? ls[k] : null) }, URL, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
      MessageEvent: class {}, crypto: require('crypto').webcrypto, Uint8Array, Array, Object, Map, WeakMap, Date, Promise, Error, setTimeout, clearTimeout
    });
    vm.runInContext(read('js/viewers/runner-client.js'), ctx);
    return { R: win.CodeMiniRunner, iframe, events, ctx };
  }
  await t('refuses a runner on the app\'s own origin (it would give no isolation), and reports "unavailable"', async () => {
    const c = client({ origin: RUNNER, hostname: 'the-code-mini-runner.vercel.app' });
    assert.strictEqual(await c.R.ensure(c.iframe), false); assert.strictEqual(c.R.status(), 'unavailable');
  });
  await t('can be switched off, and then does not touch the frame', async () => {
    const c = client({ ls: { codemini_runner: 'off' } });
    assert.strictEqual(await c.R.ensure(c.iframe), false); assert.strictEqual(c.R.status(), 'off'); assert.strictEqual(c.iframe.src, undefined);
  });
  await t('the URL override is honoured on localhost only, and an insecure remote runner is refused', async () => {
    const remote = client({ ls: { codemini_runner_url: 'http://evil.example' } });
    remote.R.ensure(remote.iframe); // would start a handshake with the default (https) runner, not the override
    assert.strictEqual(remote.iframe.src, RUNNER + '/shell.html');
    const local = client({ hostname: 'localhost', origin: 'http://localhost:8765', ls: { codemini_runner_url: 'http://localhost:8766' } });
    local.R.ensure(local.iframe); assert.strictEqual(local.iframe.src, 'http://localhost:8766/shell.html');
    const insecure = client({ hostname: 'localhost', origin: 'http://localhost:8765', ls: { codemini_runner_url: 'http://example.com' } });
    assert.strictEqual(await insecure.R.ensure(insecure.iframe), false); assert.strictEqual(insecure.R.status(), 'unavailable');
  });
  await t('a runner that never answers falls back after the handshake timeout, and is not retried straight away', async () => {
    const c = client();
    const real = setTimeout; // shorten the 6 s wait for the test
    c.ctx.setTimeout = (fn, ms) => real(fn, ms >= 6000 ? 30 : ms);
    assert.strictEqual(await c.R.ensure(c.iframe), false); assert.strictEqual(c.R.status(), 'fallback');
    assert.match(c.R.lastError(), /runner page did not load/, 'a runner that never loads says so');
    assert.strictEqual(c.iframe.src, 'about:blank'); assert.strictEqual(await c.R.ensure(c.iframe), false);
    assert.strictEqual(c.iframe.src, 'about:blank'); // the second call returned at once, without loading the runner again
    c.R.retryNow(); c.R.ensure(c.iframe); assert.strictEqual(c.iframe.src, RUNNER + '/shell.html');
  });
  await t('a runner page that loads but never announces itself is reported as refusing this app, and quickly', async () => {
    const c = client(); const real = setTimeout;
    c.ctx.setTimeout = (fn, ms) => real(fn, ms >= 1000 ? 30 : ms);
    const p = c.R.ensure(c.iframe); c.iframe.fireLoad();      // the frame finished loading, but no "ready" arrived
    assert.strictEqual(await p, false);
    assert.match(c.R.lastError(), /loaded but did not announce itself.*frame-ancestors.*allowedParents/);
  });
  await t('offline: no attempt is made, and the reason says so', async () => {
    const c = client(); c.ctx.navigator = { onLine: false };
    assert.strictEqual(await c.R.ensure(c.iframe), false); assert.strictEqual(c.R.lastError(), 'the browser is offline'); assert.strictEqual(c.iframe.src, undefined);
  });
  await t('fail() drops the runner for a while, remembers why, and resets the frame so the caller can render locally', async () => {
    const c = client();
    c.R.fail(c.iframe, 'the page did not load: empty document');
    assert.strictEqual(c.R.status(), 'fallback'); assert.strictEqual(c.R.lastError(), 'the page did not load: empty document');
    assert.strictEqual(c.iframe.src, 'about:blank'); assert.strictEqual(c.iframe.dataset.cmRunner, '');
    assert.strictEqual(await c.R.ensure(c.iframe), false); assert.strictEqual(c.iframe.src, 'about:blank');
    c.R.retryNow(); assert.strictEqual(c.R.lastError(), '');
  });
  await t('owns() recognises only blob URLs of the runner origin', () => {
    const c = client();
    assert.ok(c.R.owns('blob:' + RUNNER + '/abc')); assert.ok(!c.R.owns('blob:' + IDE + '/abc')); assert.ok(!c.R.owns('https://x/y')); assert.ok(!c.R.owns(null));
  });

  console.log('wiring');
  await t('the shell and the production vercel.json agree on who may embed the runner, and the page loads the client before preview.js', () => {
    const v = JSON.parse(read('runner/vercel.json'));
    const csp = v.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
    // 'self': the previewed page is framed by the runner's own shell, and WebKit applies the policy to it as well.
    assert.strictEqual(csp, "frame-ancestors 'self' " + IDE);
    const html = read('index.html');
    assert.ok(html.indexOf('js/viewers/runner-client.js') > 0 && html.indexOf('js/viewers/runner-client.js') < html.indexOf('js/viewers/preview.js'));
    assert.ok(read('sw.js').includes("'/js/viewers/runner-client.js'"));
  });
  await t('the app is not embeddable by other sites, and the runner folder is not shipped with the app', () => {
    const v = JSON.parse(read('vercel.json'));
    const all = v.headers.find((h) => h.source === '/(.*)').headers;
    assert.strictEqual(all.find((h) => h.key === 'Content-Security-Policy').value, "frame-ancestors 'self'");
    assert.strictEqual(all.find((h) => h.key === 'X-Content-Type-Options').value, 'nosniff');
    assert.ok(/^runner$/m.test(read('.vercelignore')));
  });
  await t('preview.js mints every page URL through the runner adapter (only the adapter, the pop-out and a file download touch URL.createObjectURL)', () => {
    const src = read('js/viewers/preview.js');
    const lines = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /URL\.createObjectURL/.test(l) && !/^\s*\/\//.test(l));
    assert.strictEqual(lines.length, 3, 'unexpected createObjectURL use: ' + JSON.stringify(lines.map(([i]) => i)));
    assert.ok(/cmRunnerOn\(\) \? await window\.CodeMiniRunner\.mint/.test(lines[0][1]));
    assert.ok(!/URL\.revokeObjectURL\(.*(activeObjectUrls|_lastDocUrl|oldDocUrl|oldUrl)/.test(src), 'page URLs must be released through cmRevoke');
    assert.ok(/if \(event\.isTrusted && data\.cmRunner === 1\) return;/.test(src));
  });

  console.log(`\n${n} runner checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
