// runner-client.js - talks to the CodeMini runner: a tiny page on a DIFFERENT origin that hosts previews, so
// previewed code cannot read this app's storage (vault, token record, device key) or call its functions.
// See runner/ for the other half and SECURITY.md for what this does and does not protect.
//
//   CodeMiniRunner.ensure(iframe)       load the runner into the preview frame; true when isolated, false = fall back
//   CodeMiniRunner.mint(iframe, blob)   a blob: URL that pages in the runner can load (made by the runner)
//   CodeMiniRunner.show(iframe, url)    navigate the previewed page; resolves when it has loaded
//   CodeMiniRunner.revoke(urls)         release URLs made by mint
//   CodeMiniRunner.owns(url)            was this URL made by the runner (so it must be released through it)?
//   CodeMiniRunner.active(iframe)       is this frame currently in runner mode?
//
// Page messages (console, network, inspector...) arrive wrapped by the runner and are re-dispatched on window as
// ordinary message events whose source is the preview frame, so the existing preview code needs no changes.
// Control messages must carry the per-frame nonce; anything else from the frame is ignored.
//
// Settings (localStorage): codemini_runner = "off" turns isolation off. On localhost only, codemini_runner_url
// points at a local runner for development. The runner can never be the app's own origin.
(function () {
    'use strict';
    var DEFAULT_URL = 'https://the-code-mini-runner.vercel.app';
    // HANDSHAKE_MS bounds the whole attempt; LOAD_GRACE_MS is how long after the frame fires `load` we still wait for
    // the runner's announcement (a healthy runner sends it before load; an unreachable host loads an error page at once).
    var HANDSHAKE_MS = 6000, LOAD_GRACE_MS = 1200, RPC_MS = 30000, RETRY_AFTER_MS = 60000;
    var sessions = new WeakMap();
    var failedUntil = 0, lastError = '';
    var status = 'unknown';

    var isLocal = function (h) { return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'; };
    function config() {
        var url = DEFAULT_URL, off = false;
        try {
            off = localStorage.getItem('codemini_runner') === 'off';
            var o = localStorage.getItem('codemini_runner_url');
            if (o && isLocal(location.hostname)) url = o;
        } catch (e) { /* storage unavailable: defaults */ }
        var u;
        try { u = new URL(url); } catch (e) { return { enabled: false, reason: 'bad-url' }; }
        // A "runner" on the app's own origin would give none of the isolation, so it is refused outright.
        if (u.origin === location.origin) return { enabled: false, reason: 'same-origin' };
        if (!(u.protocol === 'https:' || (u.protocol === 'http:' && isLocal(u.hostname)))) return { enabled: false, reason: 'insecure' };
        return { enabled: !off, reason: off ? 'off' : '', origin: u.origin, shell: u.origin + '/shell.html' };
    }
    function randomHex(n) {
        var a = new Uint8Array(n); crypto.getRandomValues(a);
        return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }
    function setStatus(next, iframe) {
        if (next === status && !iframe) return;
        status = next;
        try { window.dispatchEvent(new CustomEvent('codemini:runner-status', { detail: { status: next } })); } catch (e) { /* nothing listens */ }
    }
    function post(iframe, s, msg) { iframe.contentWindow.postMessage(Object.assign({ cmRunner: 1 }, msg), s.cfg.origin); }

    function rpc(iframe, op, extra, ms) {
        var s = sessions.get(iframe);
        if (!s || !s.ready) return Promise.reject(new Error('runner not ready'));
        return new Promise(function (resolve, reject) {
            var id = ++s.seq;
            var timer = setTimeout(function () { s.pending.delete(id); reject(new Error('runner did not answer (' + op + ')')); }, ms || RPC_MS);
            s.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
            try { post(iframe, s, Object.assign({ op: op, id: id }, extra)); }
            catch (e) { clearTimeout(timer); s.pending.delete(id); reject(e); }
        });
    }
    function failAll(s, why) {
        s.pending.forEach(function (p) { clearTimeout(p.timer); p.reject(new Error(why)); });
        s.pending.clear();
    }

    window.addEventListener('message', function (e) {
        if (!e.isTrusted) return;                                   // our own re-dispatched page messages
        var iframe = document.getElementById('lpIframe');
        var s = iframe && sessions.get(iframe);
        if (!s || e.source !== iframe.contentWindow || e.origin !== s.cfg.origin) return;
        var d = e.data;
        if (!d || d.cmRunner !== 1) return;
        if (d.op === 'ready') {
            // First load, or the runner page reloaded under us (its URLs are gone): say hello again.
            if (s.ready) { s.ready = false; iframe.dataset.cmRunner = ''; failAll(s, 'runner reloaded'); }
            if (s.onReady) { s.onReady(); }
            return;
        }
        if (d.op === 'page') {
            // Wrapped page message: hand it to the preview code as if it had come straight from the frame.
            window.dispatchEvent(new MessageEvent('message', { data: d.data, origin: e.origin, source: iframe.contentWindow }));
            return;
        }
        if (d.nonce !== s.nonce) return;                            // control messages must prove who sent them
        if (d.op === 'hello-ack') { if (s.onAck) s.onAck(); return; }
        var p = s.pending.get(d.id);
        if (!p) return;
        s.pending.delete(d.id); clearTimeout(p.timer);
        if (d.error) { p.reject(new Error(d.error)); return; }
        if (d.op === 'minted') {
            // Only URLs the runner itself could have made are ever handed on.
            if (typeof d.url !== 'string' || d.url.indexOf('blob:' + s.cfg.origin + '/') !== 0) { p.reject(new Error('unexpected URL from runner')); return; }
            p.resolve(d.url);
        } else p.resolve();
    });

    function handshake(iframe, s) {
        return new Promise(function (resolve) {
            var done = false, timer, loadTimer = null, sawReady = false, sawLoad = false;
            var finish = function (ok, why) {
                if (done) return; done = true; clearTimeout(timer); clearTimeout(loadTimer);
                if (iframe.removeEventListener) iframe.removeEventListener('load', onLoad);
                s.onReady = s.onAck = null; s.why = why || ''; resolve(ok);
            };
            var noReady = 'the runner page loaded but did not announce itself: it may be refusing to be embedded by this app (check frame-ancestors and allowedParents)';
            var onLoad = function () { sawLoad = true; if (!sawReady && !loadTimer) loadTimer = setTimeout(function () { finish(false, noReady); }, LOAD_GRACE_MS); };
            s.onAck = function () { s.ready = true; iframe.dataset.cmRunner = '1'; finish(true); };
            s.onReady = function () { sawReady = true; clearTimeout(loadTimer); try { post(iframe, s, { op: 'hello', nonce: s.nonce }); } catch (e) { finish(false, 'could not message the runner'); } };
            timer = setTimeout(function () {
                finish(false, sawReady ? 'the runner announced itself but did not accept this app (is ' + location.origin + ' in allowedParents?)'
                    : sawLoad ? noReady : 'the runner page did not load (network, blocked, or not deployed)');
            }, HANDSHAKE_MS);
            if (iframe.addEventListener) iframe.addEventListener('load', onLoad);
            iframe.removeAttribute('srcdoc');
            iframe.dataset.cmRunner = '';
            iframe.src = s.cfg.shell;
        });
    }

    async function ensure(iframe) {
        var cfg = config();
        if (!cfg.enabled) { setStatus(cfg.reason === 'off' ? 'off' : 'unavailable'); return false; }
        var s = sessions.get(iframe);
        if (s && s.ready && iframe.dataset.cmRunner === '1' && s.cfg.origin === cfg.origin) return true;
        if (Date.now() < failedUntil) { setStatus('fallback'); return false; }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { lastError = 'the browser is offline'; setStatus('fallback'); return false; } // offline: do not wait for a host we cannot reach
        if (s) failAll(s, 'runner restarted');
        s = { cfg: cfg, nonce: randomHex(16), pending: new Map(), seq: 0, ready: false };
        sessions.set(iframe, s);
        var ok = await handshake(iframe, s);
        if (!ok) {
            lastError = s.why || 'the runner did not answer';
            sessions.delete(iframe);
            failedUntil = Date.now() + RETRY_AFTER_MS;              // do not make every preview wait for a runner that is not there
            iframe.dataset.cmRunner = '';
            iframe.src = 'about:blank';
            setStatus('fallback');
            return false;
        }
        setStatus('isolated');
        return true;
    }

    // The runner answered the handshake but a page could not be shown (blocked by the browser, a header, a crash):
    // stop using it for a while, so the caller can render the same-origin way instead of leaving a blank preview.
    function fail(iframe, reason) {
        var s = sessions.get(iframe);
        if (s) { failAll(s, 'runner failed'); sessions.delete(iframe); }
        failedUntil = Date.now() + RETRY_AFTER_MS;
        lastError = String(reason || 'unknown error').slice(0, 200);
        if (iframe) { iframe.dataset.cmRunner = ''; iframe.src = 'about:blank'; }
        try { console.warn('[CodeMini] Isolated preview failed, using same-origin preview: ' + lastError); } catch (e) { /* no console */ }
        setStatus('fallback', iframe);
    }

    window.CodeMiniRunner = Object.freeze({
        ensure: ensure,
        fail: fail,
        lastError: function () { return lastError; },
        active: function (iframe) { var s = iframe && sessions.get(iframe); return !!(s && s.ready && iframe.dataset.cmRunner === '1'); },
        mint: function (iframe, blob) { return rpc(iframe, 'mint', { blob: blob }); },
        show: function (iframe, url) { return rpc(iframe, 'show', { url: url }); },
        // Write HTML into the page that is already showing (the "in-place rewrite" reload mode). Rejects if none is.
        rewrite: function (iframe, html) { return rpc(iframe, 'rewrite', { html: html }); },
        diagnostics: function () {
            var c = config();
            return { status: status, lastError: lastError, runner: c.shell || '(not configured)', configNote: c.reason || '', app: location.origin,
                online: typeof navigator === 'undefined' ? null : navigator.onLine, retryInMs: Math.max(0, failedUntil - Date.now()) };
        },
        clear: function (iframe) { var s = sessions.get(iframe); if (s && s.ready) { try { post(iframe, s, { op: 'clear' }); } catch (e) { /* frame gone */ } } },
        revoke: function (iframe, urls) {
            var s = iframe && sessions.get(iframe);
            if (s && s.ready && urls && urls.length) { try { post(iframe, s, { op: 'revoke', urls: urls }); } catch (e) { /* frame gone */ } }
        },
        owns: function (url) { var c = config(); return !!(c.origin && typeof url === 'string' && url.indexOf('blob:' + c.origin + '/') === 0); },
        status: function () { return status; },
        retryNow: function () { failedUntil = 0; lastError = ''; }
    });
})();
