// Unit tests for js/core/file-lock.js: hashing and encryption of locked files and folders, the upgrade of old
// plain-text locks, and static checks that nothing else in the app reads or writes a lock password.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const { webcrypto } = require('crypto');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

function load() {
  const mod = { exports: {} };
  const ctx = vm.createContext({
    module: mod, window: { crypto: webcrypto, btoa, atob }, TextEncoder, TextDecoder, console, Date, Math, JSON, Uint8Array, Array, Map, Set, WeakSet, Number, String, Error, Object, Promise
  });
  vm.runInContext(read('js/core/shield.js'), ctx); // loads first in the page and puts itself on window.CodeMiniShield
  mod.exports = {};
  vm.runInContext(read('js/core/file-lock.js'), ctx);
  return mod.exports;
}
const L = load();
const FAST = { iter: 100000 }; // the minimum the loader accepts; one test uses the real 600,000
const file = (over) => Object.assign({ id: 'f1', parentId: 'root', name: 'notes.txt', type: 'file', content: 'top secret text \u00e9 \u4e2d', isLocked: false, password: null, timestamp: 1 }, over);

(async () => {
  console.log('locking a file');
  await t('uses 600,000 PBKDF2 rounds by default', async () => {
    assert.strictEqual(L.ITER, 600000);
    const r = await L.lockRecord(file(), 'right-password-1');
    assert.strictEqual(r.lock.iter, 600000);
  });
  await t('stores no password, hides the text, and keeps only ciphertext', async () => {
    const r = await L.lockRecord(file(), 'right-password-1', FAST);
    assert.strictEqual(r.isLocked, true);
    assert.strictEqual(r.password, null);
    assert.strictEqual(r.content, '');
    const dump = JSON.stringify(r);
    assert.ok(!dump.includes('right-password-1') && !dump.includes('top secret'));
    assert.ok(r.enc && r.enc.iv && r.enc.ct && r.lock.salt && r.lock.check && r.lock.kdf === 'PBKDF2-SHA256');
  });
  await t('a wrong password fails, the right one unlocks and reveals the text', async () => {
    const r = await L.lockRecord(file(), 'right-password-1', FAST);
    L.forgetAll();
    assert.strictEqual(await L.unlock(r, 'wrong-password-2'), false);
    assert.strictEqual(await L.unlock(r, ''), false);
    assert.strictEqual(L.isUnlocked(r), false);
    assert.strictEqual(await L.unlock(r, 'right-password-1'), true);
    await L.reveal(r);
    assert.strictEqual(r.content, 'top secret text \u00e9 \u4e2d');
  });
  await t('reveal refuses without the key', async () => {
    const r = await L.lockRecord(file(), 'right-password-1', FAST);
    L.forgetAll();
    await assert.rejects(() => L.reveal(r), (e) => e.code === 'locked');
  });
  await t('two locks of the same text and password differ (random salt and iv)', async () => {
    const a = await L.lockRecord(file(), 'right-password-1', FAST), b = await L.lockRecord(file(), 'right-password-1', FAST);
    assert.notStrictEqual(a.lock.salt, b.lock.salt);
    assert.notStrictEqual(a.enc.ct, b.enc.ct);
  });
  await t('tampered ciphertext is reported as damaged, never as plain text', async () => {
    const r = await L.lockRecord(file(), 'right-password-1', FAST);
    const ct = Buffer.from(r.enc.ct, 'base64'); ct[0] ^= 1; r.enc.ct = ct.toString('base64');
    await L.unlock(r, 'right-password-1');
    await assert.rejects(() => L.reveal(r), (e) => e.code === 'damaged');
  });
  await t('an empty password is refused', async () => {
    await assert.rejects(() => L.lockRecord(file(), '', FAST), (e) => e.code === 'empty-password');
  });
  await t('the same password typed in a different Unicode form still unlocks', async () => {
    const r = await L.lockRecord(file(), 'caf\u00e9-password', FAST);
    L.forgetAll();
    assert.strictEqual(await L.unlock(r, 'cafe\u0301-password'), true);
  });

  console.log('folders');
  await t('a folder gets a verifier only (no text is stored or invented)', async () => {
    const r = await L.lockRecord({ id: 'd1', parentId: 'root', name: 'docs', type: 'folder', content: '', isLocked: false }, 'right-password-1', FAST);
    assert.strictEqual(r.isLocked, true);
    assert.ok(r.lock && !r.enc);
    L.forgetAll();
    assert.strictEqual(await L.unlock(r, 'nope-nope-nope'), false);
    assert.strictEqual(await L.unlock(r, 'right-password-1'), true);
  });

  console.log('writing');
  await t('seal encrypts revealed text and never writes plain text', async () => {
    const r = await L.lockRecord(file(), 'right-password-1', FAST);
    await L.reveal(r);
    r.content = 'edited text';
    const out = await L.seal(r);
    assert.strictEqual(out.content, '');
    assert.ok(!JSON.stringify(out).includes('edited text'));
    const back = Object.assign({}, out); L.forgetAll(); await L.unlock(back, 'right-password-1'); await L.reveal(back);
    assert.strictEqual(back.content, 'edited text');
  });
  await t('seal refuses plain text for a locked record when the key is not held', async () => {
    const r = await L.lockRecord(file(), 'right-password-1', FAST);
    L.forgetAll();
    await assert.rejects(() => L.seal(Object.assign({}, r, { content: 'sneaky plain text' })), (e) => e.code === 'locked');
  });
  await t('seal passes an untouched stored locked record through unchanged', async () => {
    const r = await L.lockRecord(file(), 'right-password-1', FAST);
    L.forgetAll();
    assert.strictEqual(await L.seal(r), r);
  });
  await t('setContent (editor save) re-encrypts and needs the key', async () => {
    const r = await L.lockRecord(file(), 'right-password-1', FAST);
    await L.setContent(r, 'saved from editor');
    assert.strictEqual(r.content, '');
    L.forgetAll();
    await assert.rejects(() => L.setContent(r, 'x'), (e) => e.code === 'locked');
    await L.unlock(r, 'right-password-1'); await L.reveal(r);
    assert.strictEqual(r.content, 'saved from editor');
  });

  console.log('remove lock and change password');
  await t('removeLock needs the right password and restores plain text', async () => {
    const r = await L.lockRecord(file(), 'right-password-1', FAST);
    L.forgetAll();
    assert.strictEqual(await L.removeLock(r, 'wrong-password-2'), false);
    assert.strictEqual(r.isLocked, true);
    assert.strictEqual(await L.removeLock(r, 'right-password-1'), true);
    assert.strictEqual(r.isLocked, false);
    assert.strictEqual(r.content, 'top secret text \u00e9 \u4e2d');
    assert.ok(!r.lock && !r.enc && r.password === null);
  });
  await t('changePassword keeps the text, drops the old password, and uses a new salt', async () => {
    const r = await L.lockRecord(file(), 'right-password-1', FAST);
    const oldSalt = r.lock.salt;
    L.forgetAll();
    assert.strictEqual(await L.changePassword(r, 'wrong-password-2', 'new-password-3', FAST), false);
    assert.strictEqual(await L.changePassword(r, 'right-password-1', 'new-password-3', FAST), true);
    assert.notStrictEqual(r.lock.salt, oldSalt);
    L.forgetAll();
    assert.strictEqual(await L.unlock(r, 'right-password-1'), false);
    assert.strictEqual(await L.unlock(r, 'new-password-3'), true);
    await L.reveal(r);
    assert.strictEqual(r.content, 'top secret text \u00e9 \u4e2d');
  });

  console.log('old plain-text locks');
  const legacy = () => file({ isLocked: true, password: 'old-plain-pw' });
  await t('are recognised, and a wrong password does not upgrade them', async () => {
    const r = legacy();
    assert.strictEqual(L.isLegacy(r), true);
    assert.strictEqual(await L.unlock(r, 'not-it'), false);
    assert.strictEqual(r.password, 'old-plain-pw');
  });
  await t('upgrade in place on the first correct password and are handed to persist', async () => {
    const r = legacy(); let saved = null;
    assert.strictEqual(await L.unlock(r, 'old-plain-pw', async (rec) => { saved = JSON.stringify(rec); }), true);
    assert.strictEqual(L.isLegacy(r), false);
    assert.strictEqual(r.password, null);
    assert.ok(saved && !saved.includes('old-plain-pw') && !saved.includes('top secret'));
    await L.reveal(r);
    assert.strictEqual(r.content, 'top secret text \u00e9 \u4e2d');
  });
  await t('migrateLegacy upgrades every old record at once and keeps no keys', async () => {
    const a = legacy(), b = file({ id: 'f2', isLocked: true, password: 'other-pw', content: 'second' }), c = file({ id: 'f3' });
    const writes = [];
    assert.strictEqual(await L.migrateLegacy([a, b, c], async (rec) => { writes.push(JSON.stringify(rec)); }), 2);
    assert.strictEqual(writes.length, 2);
    assert.ok(writes.every((w) => !w.includes('old-plain-pw') && !w.includes('other-pw') && !w.includes('second') && !w.includes('top secret')));
    assert.strictEqual(L.isUnlocked(a), false);
    assert.strictEqual(c.isLocked, false); // untouched
    assert.strictEqual(await L.unlock(b, 'other-pw'), true);
    await L.reveal(b);
    assert.strictEqual(b.content, 'second');
  });

  console.log('wiring');
  const html = read('index.html'), sw = read('sw.js');
  const all = ['js/core/app.js', 'js/core/editor.js', 'js/core/up-down.js', 'js/terminal/terminal-window.js', 'js/terminal/terminal-commands.js', 'js/git/git.js'].map(read).join('\n');
  await t('file-lock.js loads before the code that uses it, and is precached', () => {
    const f = html.indexOf('js/core/file-lock.js');
    assert.ok(f > -1 && f < html.indexOf('js/core/editor.js') && f < html.indexOf('js/core/app.js') && f < html.indexOf('js/terminal/terminal-window.js'));
    assert.ok(sw.includes("'/js/core/file-lock.js'"));
  });
  await t('shield.js loads before file-lock.js and is precached; file-lock.js has no crypto of its own', () => {
    assert.ok(html.indexOf('js/core/shield.js') > -1 && html.indexOf('js/core/shield.js') < html.indexOf('js/core/file-lock.js'));
    assert.ok(sw.includes("'/js/core/shield.js'"));
    const src = read('js/core/file-lock.js');
    assert.ok(!/crypto\.subtle|\bsubtle\./.test(src) && !/getRandomValues/.test(src), 'file-lock.js must call Shield, not Web Crypto');
    assert.ok(/Shield\.deriveKeyAndCheck\(/.test(src) && /Shield\.encrypt\(/.test(src) && /Shield\.decryptText\(/.test(src) && /createKeyring\(\)/.test(src));
  });
  await t('nothing compares against or stores a lock password in plain text any more', () => {
    assert.ok(!/===\s*file\.password|!==\s*file\.password|file\.password\s*=[^=]/.test(all), 'file.password is still compared or assigned');
    assert.ok(!/password:\s*isLocked\s*\?\s*modalPassword\.value/.test(all));
  });
  await t('file-lock.js does not log', () => {
    assert.ok(!/console\.(log|info|debug|warn|error)/.test(read('js/core/file-lock.js')));
  });
  await t('the GitHub token is no longer written to localStorage', () => {
    const git = read('js/git/git.js');
    assert.ok(!/localStorage\.setItem\(gitTokenKey\(\)\s*,\s*token\)/.test(git));
    assert.ok(/setSecret\('github-token'/.test(git));
    assert.ok(/SECRET_SLOTS/.test(read('js/core/my-keys.js')));
  });

  console.log(`\n${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
