// Unit tests for js/core/shield.js (the shared crypto layer), plus the proof that records written BEFORE Shield
// existed still open: tests/fixtures/legacy-formats.json was produced by the old vault.js and file-lock.js.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const { webcrypto } = require('crypto');
const fakeIndexedDB = require('./lib/fake-idb');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

function sandbox(win) {
  return vm.createContext({
    window: win || { crypto: webcrypto, btoa, atob }, TextEncoder, TextDecoder, console, Date, Math, JSON, Uint8Array, Array, Map, Set, WeakSet, Number, String, Error, Object, Promise
  });
}
function loadShield(win) {
  const ctx = sandbox(win), mod = { exports: {} };
  ctx.module = mod;
  vm.runInContext(read('js/core/shield.js'), ctx);
  return { S: mod.exports, ctx };
}
function loadAll() {
  const { S, ctx } = loadShield();
  const out = {};
  for (const [name, file] of [['V', 'js/core/my-keys.js'], ['L', 'js/core/file-lock.js']]) {
    const mod = { exports: {} };
    ctx.module = mod;
    vm.runInContext(read(file), ctx);
    out[name] = mod.exports;
  }
  return Object.assign({ S }, out);
}
const { S } = loadShield();
const FAST = 100000, SALT = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const plainJson = (x) => JSON.parse(JSON.stringify(x)); // values from the vm realm

(async () => {
  console.log('primitives');
  await t('exposes a fixed, frozen API with the documented KDF parameters', () => {
    assert.ok(Object.isFrozen(S) && Object.isFrozen(S.KDF));
    assert.deepStrictEqual(plainJson(S.KDF), { name: 'PBKDF2-SHA256', ITER: 600000, MIN_ITER: 100000, MAX_ITER: 5000000, SALT_LEN: 16, IV_LEN: 12 });
    assert.strictEqual(S.supported, true);
    assert.deepStrictEqual(Object.keys(S).sort(), ['KDF', 'ShieldError', 'createKeyring', 'ctEq', 'decrypt', 'decryptText', 'deriveKey', 'deriveKeyAndCheck', 'device', 'encrypt', 'fromB64', 'randomBytes', 'supported', 'toB64', 'validIter', 'validSalt', 'validSealed']);
  });
  await t('randomBytes gives the requested length and different bytes each time', () => {
    const a = S.randomBytes(16), b = S.randomBytes(16);
    assert.strictEqual(a.length, 16);
    assert.notStrictEqual(S.toB64(a), S.toB64(b));
  });
  await t('base64 round-trips (including sizes past the chunk boundary) and ctEq compares bytes', () => {
    const big = new Uint8Array(100000).map((_, i) => i % 251);
    assert.strictEqual(S.fromB64(S.toB64(big)).every((v, i) => v === big[i]), true);
    assert.strictEqual(S.ctEq(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3)), true);
    assert.strictEqual(S.ctEq(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4)), false);
    assert.strictEqual(S.ctEq(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3)), false);
  });

  console.log('key derivation');
  await t('the same password, salt and iterations always give the same key; any change gives a different one', async () => {
    const k1 = await S.deriveKey('pw-one-1234', SALT, FAST, { normalize: 'NFKC' });
    const sealed = await S.encrypt(k1, 'x', 'aad');
    const k2 = await S.deriveKey('pw-one-1234', SALT, FAST, { normalize: 'NFKC' });
    assert.strictEqual(await S.decryptText(k2, sealed, 'aad'), 'x');
    for (const [pw, salt, iter] of [['pw-one-1235', SALT, FAST], ['pw-one-1234', SALT.map((v) => v ^ 1), FAST], ['pw-one-1234', SALT, FAST + 1]]) {
      const other = await S.deriveKey(pw, salt, iter, { normalize: 'NFKC' });
      await assert.rejects(() => S.decryptText(other, sealed, 'aad'), (e) => e.code === 'auth-failed');
    }
  });
  await t('derived keys are non-extractable', async () => {
    const k = await S.deriveKey('pw-one-1234', SALT, FAST, { normalize: 'NFC' });
    assert.strictEqual(k.extractable, false);
    await assert.rejects(() => webcrypto.subtle.exportKey('raw', k));
    const { key } = await S.deriveKeyAndCheck('pw-one-1234', SALT, FAST, { normalize: 'NFC' });
    assert.strictEqual(key.extractable, false);
  });
  await t('deriveKeyAndCheck returns a 32-byte verifier that depends on the password and is not the key', async () => {
    const a = await S.deriveKeyAndCheck('pw-one-1234', SALT, FAST, { normalize: 'NFC' });
    const b = await S.deriveKeyAndCheck('pw-one-1234', SALT, FAST, { normalize: 'NFC' });
    const c = await S.deriveKeyAndCheck('pw-one-1235', SALT, FAST, { normalize: 'NFC' });
    assert.strictEqual(a.check.length, 32);
    assert.strictEqual(S.ctEq(a.check, b.check), true);
    assert.strictEqual(S.ctEq(a.check, c.check), false);
    // The key is the first half of the same PBKDF2 output, so it equals deriveKey's key.
    const direct = await S.deriveKey('pw-one-1234', SALT, FAST, { normalize: 'NFC' });
    assert.strictEqual(await S.decryptText(direct, await S.encrypt(a.key, 'same key', 'a'), 'a'), 'same key');
  });
  await t('the unicode form must be named, and NFC and NFKC really differ (ligature)', async () => {
    await assert.rejects(() => S.deriveKey('pw-one-1234', SALT, FAST), (e) => e.code === 'bad-input');
    await assert.rejects(() => S.deriveKey('pw-one-1234', SALT, FAST, { normalize: 'NFD' }), (e) => e.code === 'bad-input');
    const nfkc = await S.deriveKey('\ufb01x-pw-1234', SALT, FAST, { normalize: 'NFKC' });
    const asFi = await S.deriveKey('fix-pw-1234', SALT, FAST, { normalize: 'NFKC' });
    const nfc = await S.deriveKey('\ufb01x-pw-1234', SALT, FAST, { normalize: 'NFC' });
    const sealed = await S.encrypt(nfkc, 'x', 'a');
    assert.strictEqual(await S.decryptText(asFi, sealed, 'a'), 'x');                       // NFKC folds the ligature
    await assert.rejects(() => S.decryptText(nfc, sealed, 'a'), (e) => e.code === 'auth-failed'); // NFC does not
  });

  console.log('encrypt and decrypt');
  const key = await S.deriveKey('pw-one-1234', SALT, FAST, { normalize: 'NFKC' });
  await t('round trip for text (UTF-8) and for bytes', async () => {
    const text = 'h\u00e9llo \u4e2d\u6587 \ud83d\ude80';
    assert.strictEqual(await S.decryptText(key, await S.encrypt(key, text, 'aad'), 'aad'), text);
    const bytes = Uint8Array.of(0, 1, 2, 250, 255);
    const back = await S.decrypt(key, await S.encrypt(key, bytes, 'aad'), 'aad');
    assert.deepStrictEqual(Array.from(back), Array.from(bytes));
  });
  await t('every call uses a fresh 12-byte IV, so identical input never gives identical output', async () => {
    const a = await S.encrypt(key, 'same', 'aad'), b = await S.encrypt(key, 'same', 'aad');
    assert.strictEqual(S.fromB64(a.iv).length, 12);
    assert.notStrictEqual(a.iv, b.iv);
    assert.notStrictEqual(a.ct, b.ct);
  });
  await t('the output holds no plaintext', async () => {
    const s = await S.encrypt(key, 'SUPER-SECRET-VALUE', 'aad');
    assert.ok(!JSON.stringify(s).includes('SECRET') && !Buffer.from(S.fromB64(s.ct)).includes('SECRET'));
  });
  await t('padTo pads to a multiple of the size (at least one byte) so length hides the content size', async () => {
    const len = async (txt) => S.fromB64((await S.encrypt(key, txt, 'aad', { padTo: 1024 })).ct).length;
    assert.strictEqual(await len('a'), 1024 + 16);
    assert.strictEqual(await len('a'.repeat(1000)), 1024 + 16);
    assert.strictEqual(await len('a'.repeat(1023)), 1024 + 16); // 1023 + the one pad byte fills the block exactly
    assert.strictEqual(await len('a'.repeat(1024)), 2048 + 16); // a full block still gets a pad byte, so it spills to the next
    assert.strictEqual(S.fromB64((await S.encrypt(key, 'a', 'aad')).ct).length, 1 + 16); // no padding unless asked
  });
  await t('a tampered ciphertext, IV or tag is "auth-failed", never a wrong answer', async () => {
    const s = await S.encrypt(key, 'hello there', 'aad');
    const flip = (b64, i) => { const u = S.fromB64(b64); u[i] ^= 1; return S.toB64(u); };
    for (const bad of [{ iv: s.iv, ct: flip(s.ct, 0) }, { iv: s.iv, ct: flip(s.ct, s.ct.length > 0 ? S.fromB64(s.ct).length - 1 : 0) }, { iv: flip(s.iv, 0), ct: s.ct }])
      await assert.rejects(() => S.decrypt(key, bad, 'aad'), (e) => e.code === 'auth-failed');
  });
  await t('the AAD binds a ciphertext to its purpose (a lock record cannot be opened as a vault record)', async () => {
    const s = await S.encrypt(key, 'hello', 'codemini-lock:v1');
    await assert.rejects(() => S.decrypt(key, s, 'codemini-vault:v1'), (e) => e.code === 'auth-failed');
    assert.strictEqual(await S.decryptText(key, s, 'codemini-lock:v1'), 'hello');
  });
  await t('a wrong key is "auth-failed" (callers call that a wrong password)', async () => {
    const other = await S.deriveKey('pw-one-1235', SALT, FAST, { normalize: 'NFKC' });
    const sealed = await S.encrypt(key, 'x', 'aad');
    await assert.rejects(() => S.decrypt(other, sealed, 'aad'), (e) => e.code === 'auth-failed');
  });
  await t('malformed records are "damaged", which is different from a wrong password', async () => {
    const good = await S.encrypt(key, 'x', 'aad');
    for (const bad of [null, {}, { iv: good.iv }, { iv: '!!!', ct: good.ct }, { iv: good.iv, ct: '!!!' }, { iv: 'AAAA', ct: good.ct }])
      await assert.rejects(() => S.decrypt(key, bad, 'aad'), (e) => e.code === 'damaged', JSON.stringify(bad));
  });
  await t('plaintext that is not valid UTF-8 is "damaged" for decryptText', async () => {
    const s = await S.encrypt(key, Uint8Array.of(0xff, 0xfe, 0xfd), 'aad');
    await assert.rejects(() => S.decryptText(key, s, 'aad'), (e) => e.code === 'damaged');
  });

  console.log('record-shape checks');
  await t('validIter, validSalt and validSealed accept real values and reject anything else without throwing', async () => {
    assert.strictEqual(S.validIter(600000) && S.validIter(100000) && S.validIter(5000000), true);
    for (const bad of [99999, 5000001, 1e12, '600000', 600000.5, NaN, null, undefined]) assert.strictEqual(S.validIter(bad), false, String(bad));
    assert.strictEqual(S.validSalt(S.toB64(S.randomBytes(16))), true);
    for (const bad of ['AAAA', '', '!!!', null, 5, S.toB64(S.randomBytes(17))]) assert.strictEqual(S.validSalt(bad), false, String(bad));
    const ok = await S.encrypt(key, 'x', 'aad', { padTo: 1024 });
    assert.strictEqual(S.validSealed(ok, { minBytes: 1040, maxChars: 4 * 1024 * 1024 }), true);
    assert.strictEqual(S.validSealed(ok, { minBytes: 5000 }), false);
    assert.strictEqual(S.validSealed(ok, { maxChars: 10 }), false);
    for (const bad of [null, 'x', {}, { iv: ok.iv }, { iv: 'AAAA', ct: ok.ct }, { iv: ok.iv, ct: 5 }, { iv: ok.iv, ct: '!!!' }]) assert.strictEqual(S.validSealed(bad), false, JSON.stringify(bad));
  });

  console.log('key ring');
  await t('holds keys by id and forgets them on delete or clear; separate rings are independent', async () => {
    const a = S.createKeyring(), b = S.createKeyring();
    a.set('x', key); a.set('y', key); b.set('x', key);
    assert.ok(a.has('x') && a.get('x') === key && !a.has('z') && a.get('z') === undefined);
    a.delete('x');
    assert.ok(!a.has('x') && a.has('y'));
    a.clear();
    assert.ok(!a.has('y') && b.has('x'));
    assert.ok(Object.isFrozen(a));
  });

  console.log('hardening');
  await t('window.CodeMiniShield is defined once and cannot be replaced or removed', () => {
    const win = { crypto: webcrypto, btoa, atob };
    const { S: s1 } = loadShield(win);
    assert.strictEqual(win.CodeMiniShield, s1);
    assert.throws(() => { 'use strict'; win.CodeMiniShield = {}; });
    assert.throws(() => { 'use strict'; delete win.CodeMiniShield; });
    assert.strictEqual(win.CodeMiniShield, s1);
    // A second load keeps the first object instead of throwing or replacing it.
    const ctx = vm.createContext(Object.assign({}, { window: win, module: { exports: {} } }, { TextEncoder, TextDecoder, Uint8Array, Map, Object, Error, Number, String, Promise, Math, JSON, Array, Set, WeakSet, Date, console }));
    vm.runInContext(read('js/core/shield.js'), ctx);
    assert.strictEqual(win.CodeMiniShield, s1);
  });
  await t('later monkey-patching of crypto.subtle or getRandomValues cannot reach Shield (captured at load)', async () => {
    const fake = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto), subtle: {} };
    for (const k of ['importKey', 'deriveKey', 'deriveBits', 'encrypt', 'decrypt']) fake.subtle[k] = webcrypto.subtle[k].bind(webcrypto.subtle);
    const win = { crypto: fake, btoa, atob };
    const { S: s } = loadShield(win);
    let hit = 0;
    for (const k of Object.keys(fake.subtle)) fake.subtle[k] = () => { hit++; throw new Error('hooked'); };
    fake.getRandomValues = () => { hit++; throw new Error('hooked'); };
    const k = await s.deriveKey('pw-one-1234', SALT, FAST, { normalize: 'NFC' });
    assert.strictEqual(await s.decryptText(k, await s.encrypt(k, 'ok', 'a'), 'a'), 'ok');
    assert.strictEqual(hit, 0);
  });
  await t('without Web Crypto it reports "unsupported" instead of falling back to anything weaker', async () => {
    const { S: s } = loadShield({ btoa, atob }); // no crypto at all
    assert.strictEqual(s.supported, false);
    assert.throws(() => s.randomBytes(8), (e) => e.code === 'unsupported');
    await assert.rejects(() => s.deriveKey('p', SALT, FAST, { normalize: 'NFC' }), (e) => e.code === 'unsupported');
    await assert.rejects(() => s.encrypt({}, 'x', 'a'), (e) => e.code === 'unsupported');
  });
  await t('shield.js does not log, evaluate code, touch the DOM or the network, and only the device-key section touches storage', () => {
    const full = read('js/core/shield.js');
    const at = full.indexOf('// ---- device key');
    assert.ok(at > 0, 'device key section marker not found');
    const src = full.replace(/\/\/[^\n]*/g, ''); // code only: comments may talk about storage
    assert.ok(!/console\.(log|info|debug|warn|error)/.test(src));
    assert.ok(!/\beval\s*\(|new Function\s*\(/.test(src));
    assert.ok(!/localStorage|sessionStorage|document\./.test(src));
    assert.ok(!/fetch\s*\(|XMLHttpRequest|sendBeacon/.test(src));
    assert.ok(!/indexedDB/.test(full.slice(0, at).replace(/\/\/[^\n]*/g, '')), 'IndexedDB is used outside the device-key section');
    assert.strictEqual((src.match(/_idb\.[a-zA-Z]+/g) || []).join(','), '_idb.open', 'only open() is called on IndexedDB');
  });
  await t('the password-protected modules never use the device key', () => {
    for (const f of ['js/core/my-keys.js', 'js/core/file-lock.js']) {
      assert.ok(!/\.device\b|deviceSeal|deviceOpen/.test(read(f)), f + ' must not use the device key');
    }
  });

  console.log('the device key');
  const winWith = (idb, extra) => Object.assign({ crypto: webcrypto, btoa, atob, indexedDB: idb, setTimeout, clearTimeout }, extra || {});
  const shieldOn = (idb, extra) => loadShield(winWith(idb, extra)).S;
  await t('is unavailable without IndexedDB, and says so instead of falling back to something weaker', async () => {
    assert.strictEqual(S.device.supported, false);
    await assert.rejects(() => S.device.seal('p', 1), (e) => e.code === 'unsupported');
    await assert.rejects(() => S.device.open('p', { v: 1 }), (e) => e.code === 'unsupported');
    assert.ok(Object.isFrozen(S.device));
  });
  await t('seals a value and opens it again; the record is { v, iv, ct } and padded so its length does not show the value\'s length', async () => {
    const idb = fakeIndexedDB(), d = shieldOn(idb).device;
    assert.strictEqual(d.supported, true);
    const short = await d.seal('github-token:w', { t: 'ghp_short' });
    const long = await d.seal('github-token:w', { t: 'github_pat_' + 'x'.repeat(80) });
    assert.deepStrictEqual(Object.keys(short), ['v', 'iv', 'ct']);
    assert.strictEqual(short.v, 1);
    assert.strictEqual(S.fromB64(short.ct).length, S.fromB64(long.ct).length, 'both pad to the same size');
    assert.strictEqual(S.fromB64(short.ct).length, 256 + 16);
    assert.deepStrictEqual(plainJson(await d.open('github-token:w', short)), { t: 'ghp_short' });
    assert.strictEqual((await d.open('github-token:w', long)).t.length, 91);
    const again = await d.seal('github-token:w', { t: 'ghp_short' });
    assert.notStrictEqual(again.iv, short.iv); assert.notStrictEqual(again.ct, short.ct);
  });
  await t('the stored key is a non-extractable AES-256-GCM key, so its bytes cannot be read out of the browser', async () => {
    const idb = fakeIndexedDB(), d = shieldOn(idb).device;
    await d.seal('p', 1);
    const key = idb.storeOf('codemini_shield', 'keys').get('device-v1');
    assert.strictEqual(key.type, 'secret'); assert.strictEqual(key.extractable, false);
    assert.strictEqual(key.algorithm.name, 'AES-GCM'); assert.strictEqual(key.algorithm.length, 256);
    await assert.rejects(() => webcrypto.subtle.exportKey('raw', key));
  });
  await t('the record is bound to its purpose: it does not open under another one (another window\'s token slot)', async () => {
    const d = shieldOn(fakeIndexedDB()).device;
    const rec = await d.seal('github-token:win_a', { t: 'x' });
    await assert.rejects(() => d.open('github-token:win_b', rec), (e) => e.code === 'auth-failed');
    await assert.rejects(() => d.open('my-keys', rec), (e) => e.code === 'auth-failed');
  });
  await t('changed or malformed records are refused: tampering is auth-failed, the wrong shape is damaged', async () => {
    const d = shieldOn(fakeIndexedDB()).device;
    const rec = plainJson(await d.seal('p', { t: 'x' }));
    const ct = S.fromB64(rec.ct); ct[5] ^= 1;
    await assert.rejects(() => d.open('p', Object.assign({}, rec, { ct: S.toB64(ct) })), (e) => e.code === 'auth-failed');
    const iv = S.fromB64(rec.iv); iv[0] ^= 1;
    await assert.rejects(() => d.open('p', Object.assign({}, rec, { iv: S.toB64(iv) })), (e) => e.code === 'auth-failed');
    for (const bad of [null, 'x', 7, {}, { v: 2, iv: rec.iv, ct: rec.ct }, { v: 1, iv: 'AAAA', ct: rec.ct }, { v: 1, iv: rec.iv, ct: 'AAAA' }, { v: 1, iv: rec.iv, ct: 'A'.repeat(70000) }, { v: 1, iv: rec.iv, ct: '***' }]) {
      await assert.rejects(() => d.open('p', bad), (e) => e.code === 'damaged', JSON.stringify(bad).slice(0, 40));
    }
  });
  await t('bad purposes and values that cannot be stored are bad-input (a caller bug), not a crash', async () => {
    const d = shieldOn(fakeIndexedDB()).device;
    for (const p of ['', null, undefined, 5, 'x'.repeat(201)]) await assert.rejects(() => d.seal(p, 1), (e) => e.code === 'bad-input');
    await assert.rejects(() => d.open('', {}), (e) => e.code === 'bad-input');
    const cyc = {}; cyc.me = cyc;
    await assert.rejects(() => d.seal('p', undefined), (e) => e.code === 'bad-input');
    await assert.rejects(() => d.seal('p', cyc), (e) => e.code === 'bad-input');
    await assert.rejects(() => d.seal('p', () => 1), (e) => e.code === 'bad-input');
  });
  await t('the key persists: a new page on the same profile opens what an earlier page sealed', async () => {
    const idb = fakeIndexedDB();
    const rec = await shieldOn(idb).device.seal('p', { t: 'abc' });
    assert.deepStrictEqual(plainJson(await shieldOn(idb).device.open('p', rec)), { t: 'abc' });
    assert.strictEqual(idb.puts, 1, 'one key was ever written');
  });
  await t('opening never creates a key: with no key it says no-key and the store stays empty', async () => {
    const a = fakeIndexedDB(), b = fakeIndexedDB();
    const rec = await shieldOn(a).device.seal('p', 1);
    const other = shieldOn(b).device;
    await assert.rejects(() => other.open('p', rec), (e) => e.code === 'no-key');
    assert.strictEqual(b.puts, 0);
    await other.seal('p', 2); // a different device with its own key
    await assert.rejects(() => other.open('p', rec), (e) => e.code === 'auth-failed');
  });
  await t('two tabs (and parallel calls) that both find no key end up sharing exactly one', async () => {
    const idb = fakeIndexedDB(), A = shieldOn(idb).device, B = shieldOn(idb).device;
    const recs = await Promise.all([A.seal('p', 'a1'), B.seal('p', 'b1'), A.seal('p', 'a2'), B.seal('p', 'b2')]);
    assert.strictEqual(idb.puts, 1);
    assert.deepStrictEqual(await Promise.all(recs.map((r) => A.open('p', r))), ['a1', 'b1', 'a2', 'b2']);
    assert.deepStrictEqual(await Promise.all(recs.map((r) => B.open('p', r))), ['a1', 'b1', 'a2', 'b2']);
  });
  await t('a key in the slot that is extractable (or not AES-GCM) is ignored and replaced, never used', async () => {
    const idb = fakeIndexedDB(), d1 = shieldOn(idb).device;
    await d1.seal('p', 1);
    const weak = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    idb.storeOf('codemini_shield', 'keys').set('device-v1', weak);
    const d2 = shieldOn(idb).device;
    await assert.rejects(() => d2.open('p', { v: 1, iv: S.toB64(S.randomBytes(12)), ct: S.toB64(S.randomBytes(272)) }), (e) => e.code === 'no-key');
    await d2.seal('p', 2);
    assert.strictEqual(idb.storeOf('codemini_shield', 'keys').get('device-v1').extractable, false);
  });
  await t('when IndexedDB cannot be reached or hangs it reports "storage" (and recovers once it can)', async () => {
    const idb = fakeIndexedDB(), d = shieldOn(idb).device;
    idb.failOpen = true;
    await assert.rejects(() => d.seal('p', 1), (e) => e.code === 'storage');
    idb.failOpen = false; idb.hangOpen = true;
    const hung = shieldOn(idb, { setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {} }).device;
    await assert.rejects(() => hung.seal('p', 1), (e) => e.code === 'storage');
    idb.hangOpen = false;
    assert.strictEqual((await d.open('p', await d.seal('p', 'ok'))), 'ok');
  });

  console.log('records written before Shield still open (no migration)');
  const fx = JSON.parse(read('tests/fixtures/legacy-formats.json'));
  const { V, L } = loadAll();
  await t('a My Keys vault written by the old vault.js unlocks with its password (NFKC) and gives back every entry', async () => {
    assert.strictEqual(V.validateRecord(fx.vault.record), true);
    const { entries } = await V.unlockRecord(fx.vault.password, fx.vault.record);
    assert.deepStrictEqual(plainJson(entries), fx.vault.entries);
  });
  await t('the same vault also unlocks with the ligature typed as plain letters (NFKC is preserved), and rejects a wrong password', async () => {
    const pw = fx.vault.password.replace('\ufb01', 'fi').normalize('NFC');
    assert.strictEqual((await V.unlockRecord(pw, fx.vault.record)).entries.length, 1);
    await assert.rejects(() => V.unlockRecord(fx.vault.password + 'x', fx.vault.record), (e) => e.code === 'wrong-password');
  });
  await t('a locked file written by the old file-lock.js unlocks (NFC) and reveals its exact text', async () => {
    const rec = plainJson(fx.lockedFile.record);
    assert.strictEqual(L.isLocked(rec), true);
    L.forgetAll();
    assert.strictEqual(await L.unlock(rec, fx.lockedFile.password), true);
    await L.reveal(rec);
    assert.strictEqual(rec.content, fx.lockedFile.text);
  });
  await t('that lock does NOT open when the ligature is typed as plain letters (NFC is preserved, not widened to NFKC)', async () => {
    const rec = plainJson(fx.lockedFile.record);
    assert.strictEqual(await L.unlock(rec, fx.lockedFile.password.replace('\ufb01', 'fi')), false);
    assert.strictEqual(await L.unlock(rec, 'wrong-password'), false);
  });
  await t('a locked folder written by the old code still verifies its password', async () => {
    const rec = plainJson(fx.lockedFolder.record);
    assert.strictEqual(await L.unlock(rec, fx.lockedFolder.password), true);
    assert.strictEqual(await L.unlock(plainJson(fx.lockedFolder.record), 'nope'), false);
  });
  await t('records made now still carry the same fields and values the old code wrote', async () => {
    const { record } = await V.createRecord('right-password-1', [], { iter: FAST });
    assert.deepStrictEqual(Object.keys(record), Object.keys(fx.vault.record));
    assert.strictEqual(record.type, fx.vault.record.type); assert.strictEqual(record.v, fx.vault.record.v); assert.strictEqual(record.kdf, fx.vault.record.kdf);
    assert.strictEqual(S.fromB64(record.ct).length, S.fromB64(fx.vault.record.ct).length, 'same padding');
    const lk = await L.lockRecord({ id: 'n1', type: 'file', content: 'x', isLocked: false, password: null }, 'right-password-1', { iter: FAST });
    assert.deepStrictEqual(Object.keys(lk.lock), Object.keys(fx.lockedFile.record.lock));
    assert.deepStrictEqual(Object.keys(lk.enc), Object.keys(fx.lockedFile.record.enc));
    assert.strictEqual(lk.lock.kdf, fx.lockedFile.record.lock.kdf); assert.strictEqual(lk.lock.v, fx.lockedFile.record.lock.v);
  });

  console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
