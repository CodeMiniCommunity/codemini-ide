// Unit tests for js/core/my-keys.js: the record format and validation layer behind "My Keys" (the crypto itself is
// tested in shield.test.js), plus static checks that it is wired in safely (script order, precache, sidebar
// plumbing, no logging of secrets, no crypto of its own).
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const { webcrypto } = require('crypto');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

// `document` is left undefined on purpose: my-keys.js then stops after its pure layer and exports it.
// shield.js runs first in the same sandbox, as it does in the page, and puts itself on window.CodeMiniShield.
const mod = { exports: {} };
const ctx = vm.createContext({
  module: mod, window: { crypto: webcrypto, btoa, atob }, TextEncoder, TextDecoder, console, Date, Math, JSON, Uint8Array, Array, Map, Set, Number, String, Error, Object, Promise
});
vm.runInContext(read('js/core/shield.js'), ctx);
mod.exports = {}; // shield.js also sets module.exports; my-keys.js gets a fresh one
vm.runInContext(read('js/core/my-keys.js'), ctx);
const V = mod.exports;
const FAST = { iter: 100000 }; // the minimum the loader accepts; one test below uses the real 600,000
const entry = (over) => Object.assign({ id: 'a1b2c3d4e5f6a7b8', name: 'OpenAI prod', service: 'OpenAI', type: 'api', value: 'sk-SECRET-VALUE-123', notes: 'billing', created: 1, updated: 1 }, over);

(async () => {
  console.log('encryption');
  await t('round trip with the default 600,000 PBKDF2 iterations', async () => {
    assert.strictEqual(V.ITER, 600000);
    const { record } = await V.createRecord('correct horse battery', [entry()]);
    assert.strictEqual(record.iter, 600000);
    const { entries } = await V.unlockRecord('correct horse battery', record);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(entries)), [entry()]); // JSON round trip: the module runs in its own vm realm
  });
  await t('wrong password fails with "wrong-password"', async () => {
    const { record } = await V.createRecord('right-password-1', [entry()], FAST);
    await assert.rejects(() => V.unlockRecord('right-password-2', record), (e) => e.code === 'wrong-password');
    await assert.rejects(() => V.unlockRecord('', record), (e) => e.code === 'wrong-password');
  });
  await t('the stored record contains no plaintext (names, services, values, notes)', async () => {
    const { record } = await V.createRecord('right-password-1', [entry()], FAST);
    const text = JSON.stringify(record);
    for (const s of ['OpenAI', 'prod', 'SECRET', 'billing', 'sk-']) assert.ok(!text.includes(s), s + ' leaked');
  });
  await t('every save uses a fresh IV and every vault a fresh salt', async () => {
    const a = await V.createRecord('right-password-1', [], FAST), b = await V.createRecord('right-password-1', [], FAST);
    assert.notStrictEqual(a.record.salt, b.record.salt);
    const s1 = await V.seal(a.key, []), s2 = await V.seal(a.key, []);
    assert.notStrictEqual(s1.iv, s2.iv);
    assert.notStrictEqual(s1.ct, s2.ct);
  });
  await t('a tampered ciphertext is rejected (authenticated encryption)', async () => {
    const { record } = await V.createRecord('right-password-1', [entry()], FAST);
    const raw = V.fromB64(record.ct); raw[5] ^= 1;
    await assert.rejects(() => V.unlockRecord('right-password-1', Object.assign({}, record, { ct: V.toB64(raw) })));
  });
  await t('a ciphertext cannot be opened with a different salt', async () => {
    const a = await V.createRecord('right-password-1', [entry()], FAST), b = await V.createRecord('right-password-1', [], FAST);
    await assert.rejects(() => V.unlockRecord('right-password-1', Object.assign({}, a.record, { salt: b.record.salt })));
  });
  await t('stored size is padded, so the number of keys is not obvious from it', async () => {
    const one = await V.createRecord('right-password-1', [entry()], FAST);
    const few = await V.createRecord('right-password-1', [entry(), entry({ id: 'b1b2c3d4e5f6a7b8', name: 'Second' }), entry({ id: 'c1b2c3d4e5f6a7b8', name: 'Third' })], FAST);
    assert.strictEqual(V.fromB64(one.record.ct).length, V.fromB64(few.record.ct).length);
  });
  await t('passwords are normalised (the same text typed on another keyboard still unlocks)', async () => {
    const composed = 'caf\u00e9-password', decomposed = 'cafe\u0301-password';
    const { record } = await V.createRecord(composed, [entry()], FAST);
    assert.strictEqual((await V.unlockRecord(decomposed, record)).entries.length, 1);
  });

  console.log('record validation');
  const good = (await V.createRecord('right-password-1', [], FAST)).record;
  await t('accepts a real record', () => assert.strictEqual(V.validateRecord(good), true));
  await t('rejects garbage, wrong versions and out-of-range iterations', () => {
    for (const bad of [null, 'x', {}, Object.assign({}, good, { v: 2 }), Object.assign({}, good, { type: 'other' }), Object.assign({}, good, { kdf: 'md5' }),
      Object.assign({}, good, { iter: 10 }), Object.assign({}, good, { iter: 1e12 }), Object.assign({}, good, { iter: '600000' }),
      Object.assign({}, good, { salt: 'AAAA' }), Object.assign({}, good, { iv: 'AAAA' }), Object.assign({}, good, { ct: 'AAAA' }), Object.assign({}, good, { ct: '!!!not base64!!!' })])
      assert.strictEqual(V.validateRecord(bad), false, JSON.stringify(bad).slice(0, 80));
  });
  await t('a damaged record is reported as "damaged", never as a wrong password', async () => {
    await assert.rejects(() => V.unlockRecord('x', Object.assign({}, good, { iter: 5 })), (e) => e.code === 'damaged');
  });

  console.log('passwords');
  const ok = (p) => V.evaluatePassword(p).ok;
  await t('rejects short, common, repeated, numeric and sequential passwords', () => {
    for (const p of ['', 'short', 'Ab1!', 'password', 'Password123', '12345678', '1234567890', 'aaaaaaaaaaaa', 'qwertyuiop', 'codemini123', '1111111111'])
      assert.strictEqual(ok(p), false, JSON.stringify(p));
  });
  await t('accepts 10+ characters, or 8 with three character classes', () => {
    for (const p of ['correct horse', 'gr33n-tea', 'Tr0ub4dor&3', 'my dog likes soup']) assert.strictEqual(ok(p), true, p);
    assert.strictEqual(ok('abcdefgh'), false);
  });
  await t('strength grows with length and variety', () => {
    assert.ok(V.evaluatePassword('correct horse battery staple').score > V.evaluatePassword('gr33n-tea').score);
    assert.strictEqual(V.evaluatePassword('correct horse battery staple').label, 'Strong');
  });

  console.log('entries');
  await t('sanitize drops invalid entries, clamps lengths, normalises types', () => {
    const out = V.sanitizeEntries([entry(), { id: 'bad id', name: 'x', value: 'y' }, entry({ id: 'f1f2f3f4f5f6f7f8', name: '   ', value: 'v' }), entry({ id: 'e1e2e3e4e5e6e7e8', type: 'weird', name: 'n'.repeat(500), value: 'v'.repeat(70000) }), null, 5]);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[1].type, 'other'); assert.strictEqual(out[1].name.length, V.LIMITS.name); assert.strictEqual(out[1].value.length, V.LIMITS.value);
  });
  await t('duplicate ids collapse to one and the vault is capped', () => {
    assert.strictEqual(V.sanitizeEntries([entry(), entry()]).length, 1);
    const many = Array.from({ length: 700 }, (_, i) => entry({ id: i.toString(16).padStart(8, '0') }));
    assert.strictEqual(V.sanitizeEntries(many).length, V.LIMITS.entries);
  });
  await t('merge adds new ids and keeps the newer copy of an existing one', () => {
    const cur = [entry({ updated: 10 })];
    const r = V.mergeEntries(cur, [entry({ updated: 5, name: 'older' }), entry({ id: 'b1b2c3d4e5f6a7b8', name: 'new' })]);
    assert.strictEqual(r.added, 1); assert.strictEqual(r.updated, 0); assert.strictEqual(r.entries.find((e) => e.id === 'a1b2c3d4e5f6a7b8').name, 'OpenAI prod');
    const r2 = V.mergeEntries(cur, [entry({ updated: 99, name: 'newer' })]);
    assert.strictEqual(r2.updated, 1); assert.strictEqual(r2.entries[0].name, 'newer');
  });

  console.log('wiring and hygiene');
  const src = read('js/core/my-keys.js'), html = read('index.html'), script = read('js/core/script.js');
  await t('shield.js is the FIRST script on the page (so no inline or third-party script can replace the crypto functions it captures), my-keys.js comes after it; both are precached', () => {
    const tags = Array.from(html.matchAll(/<script\b[^>]*>/g), (m) => m[0]);
    assert.strictEqual(tags[0], '<script src="js/core/shield.js">', 'the first <script> in index.html must be shield.js');
    const sh = html.indexOf('js/core/shield.js'), v = html.indexOf('<script src="js/core/my-keys.js">');
    assert.ok(v > sh && v < html.indexOf('js/core/settings-profile.js'));
    assert.strictEqual(html.split('js/core/shield.js').length - 1, 1, 'shield.js is loaded exactly once');
    assert.ok(!/<script src="https?:/.test(html.slice(0, sh)), 'no third-party script before Shield');
    const sw = read('sw.js');
    assert.ok(sw.includes("'/js/core/shield.js'") && sw.includes("'/js/core/my-keys.js'"));
    assert.ok(!sw.includes('vault.js') && !html.includes('vault.js'), 'no reference to the old file name');
  });
  await t('my-keys.js has no crypto of its own: it goes through Shield', () => {
    assert.ok(!/crypto\.subtle|\bsubtle\./.test(src) && !/getRandomValues/.test(src) && !/\bPBKDF2\b.*importKey/.test(src));
    assert.ok(/Shield\.deriveKey\(/.test(src) && /Shield\.encrypt\(/.test(src) && /Shield\.decryptText\(/.test(src));
    assert.ok(/W\.CodeMiniShield/.test(src));
  });
  await t('the sidebar exists and is closed/saved/restored with the other sidebars', () => {
    assert.ok(html.includes('id="keysSidebar"'));
    assert.ok(/getElementById\('keysSidebar'\)\?\.classList\.remove\('open'\)/.test(script), 'closeAllSidebars');
    assert.ok(/getElementById\('keysSidebar'\)\?\.classList\.contains\('open'\) \? 'keys'/.test(script), 'saveCurrentUIState');
    assert.ok(/uiState\.sidebar === 'keys'/.test(script), 'restoreCurrentUIState');
  });
  await t('"Reset settings" cannot wipe the vault', () => assert.ok(/trust_\|vault[|)]/.test(read('js/core/settings-profile.js'))));
  await t('secrets are never logged, evaluated or written with innerHTML from user data unescaped', () => {
    assert.ok(!/console\.(log|info|debug|warn|error)/.test(src), 'my-keys.js must not log');
    assert.ok(!/\beval\s*\(|new Function\s*\(/.test(src));
    assert.ok(/s\.textContent = e\.value/.test(src), 'a revealed value is written with textContent');
    assert.ok(!/\$\{esc\(e\.value\)\}|\$\{e\.value\}/.test(src), 'values are never templated into HTML');
  });
  await t('only ciphertext, settings and the attempt counter are written to storage', () => {
    const sets = (src.match(/localStorage\.setItem\([^;]*;/g) || []).join('\n');
    assert.ok(/recKey/.test(sets) && /cfgKey/.test(sets) && /guardKey/.test(sets) && /codemini_sidebar_width/.test(sets));
    assert.ok(!/sessionStorage|indexedDB/.test(src));
  });
  await t('the only things exposed on window are a fixed, narrow set (no way to read arbitrary entries)', () => {
    const block = (src.match(/W\.CodeMiniKeys = Object\.freeze\(\{([\s\S]*?)\n        \}\);/) || [])[1];
    assert.ok(block, 'CodeMiniKeys block not found');
    const names = Array.from(block.matchAll(/^\s{12}([A-Za-z]+)\b/gm), (m) => m[1]).sort();
    assert.deepStrictEqual(names, ['getSecret', 'isUnlocked', 'lock', 'removeSecret', 'requestUnlock', 'setSecret']);
    const others = (src.match(/W\.[A-Za-z]+ = [^;]*;/g) || []).filter((l) => !/CodeMiniKeys/.test(l)).join('\n');
    assert.ok(!/entries|getEntries|reveal|decrypt/.test(others));
  });
  await t('getSecret/setSecret/removeSecret only work for named slots, and the only slot is the GitHub token', () => {
    const slots = (src.match(/const SECRET_SLOTS = \{([\s\S]*?)\n    \};/) || [])[1];
    assert.ok(slots);
    assert.deepStrictEqual(Array.from(slots.matchAll(/^\s{8}'([a-z-]+)':/gm), (m) => m[1]), ['github-token']);
    for (const fn of ['getSecret', 'setSecret', 'removeSecret']) {
      const body = (src.match(new RegExp('(?:async )?function ' + fn + '\\(slot[\\s\\S]*?\\n    \\}\\n')) || [])[0];
      assert.ok(body && /SECRET_SLOTS\[slot\]/.test(body), fn + ' must look the slot up in SECRET_SLOTS');
    }
  });
  console.log(`\n${n} vault checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
