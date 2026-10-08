// Unit tests for where the GitHub token lives (js/git/git.js, the section that starts at "const GIT_TOKEN_KEY_LEGACY"
// and runs through gitGetGhProfile). That section is loaded for real, together with the real shield.js, into a
// sandbox with a fake localStorage, a fake IndexedDB and a fake My Keys. A "page reload" is a fresh sandbox that
// shares the same storage and IndexedDB. The real-browser version of the same story is tests/e2e/git-token.e2e.js.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const { webcrypto } = require('crypto');
const fakeIndexedDB = require('./lib/fake-idb');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

const git = read('js/git/git.js');
const from = git.indexOf('const GIT_TOKEN_KEY_LEGACY'), toMarker = 'function gitGetGhProfile() {';
const to = git.indexOf('\n}\n', git.indexOf(toMarker)) + 3;
assert.ok(from > 0 && to > from, 'token section not found in git.js');
const SECTION = git.slice(from, to);

const sleep = () => new Promise((r) => setImmediate(r));
// Polls in real time: WebCrypto work runs on a thread pool, so counting event-loop turns is not a clock.
async function waitFor(cond, what) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('timed out waiting for ' + what);
}
function fakeStorage() {
  const m = new Map();
  const ls = {
    failWrites: null, // a function (key) => true makes that setItem throw, like a full disk
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) { if (ls.failWrites && ls.failWrites(k)) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    dump: () => JSON.stringify(Array.from(m.entries()))
  };
  return ls;
}
function fakeKeys(unlocked) {
  const k = { unlocked: !!unlocked, secrets: {}, unlockAsked: 0, removed: 0,
    isUnlocked: () => k.unlocked,
    getSecret: (s) => (k.unlocked && k.secrets[s]) || '',
    setSecret: async (s, v) => { if (!k.unlocked) throw new Error('locked'); k.secrets[s] = v; },
    removeSecret: async (s) => { if (!k.unlocked) throw new Error('locked'); delete k.secrets[s]; k.removed++; },
    requestUnlock: () => { k.unlockAsked++; } };
  return k;
}
// A page: the token section of git.js running on top of the given browser storage.
function page(env, opts) {
  opts = opts || {};
  const handlers = {}, notices = [], logs = [];
  let ctxRef = null;
  const win = {
    crypto: webcrypto, btoa, atob, setTimeout, clearTimeout,
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
    // Like the real renderGitPanel, drawing the panel asks for the token to be loaded (this once recursed forever).
    renderGitPanel: () => { win.renders++; if (win.renders > 50) throw new Error('renderGitPanel is being called in a loop'); if (ctxRef && ctxRef.gitHydrateToken) ctxRef.gitHydrateToken(); }, renders: 0,
    CodeMiniKeys: opts.keys || null,
    CodeMiniNotifications: { add: (x) => notices.push(x), remove: () => {} }
  };
  if (!opts.noIdb) win.indexedDB = env.idb;
  const ctx = vm.createContext({
    window: win, localStorage: env.ls, console, Date, Math, JSON, Uint8Array, Array, Map, Set, Number, String, Error, Object, Promise, TextEncoder, TextDecoder,
    gitNotify: (x) => { notices.push(x); return true; }, gitLog: (a, m, l) => logs.push(l + ': ' + m),
    module: { exports: {} }
  });
  ctxRef = ctx;
  vm.runInContext(read('js/core/shield.js'), ctx);
  env.ls.setItem('codemini_active_window', opts.win || 'win_default');
  vm.runInContext(SECTION + `\nglobalThis.__t = { gitGetToken, gitSaveToken, gitHydrateToken, gitTokenLocked, gitTokenLoading, gitNoTokenMessage, gitMoveVaultTokenToDevice, gitEncKey, gitTokenKey, gitProfileKey, gitTokenCache, gitTokenProblem, gitStoreDevice };`, ctx);
  const api = ctx.__t; win.__t = api;
  return Object.assign(api, { win, notices, logs, handlers, fire: (type, e) => (handlers[type] || []).forEach((f) => f(e || {})) });
}
const newEnv = () => ({ idb: fakeIndexedDB(), ls: fakeStorage() });
const TOKEN = 'ghp_' + 'A1b2C3d4'.repeat(5), TOKEN2 = 'github_pat_' + 'Z9y8X7'.repeat(10);

(async () => {
  console.log('saving');
  await t('a saved token is encrypted with the device key: readable at once, absent from storage in plain text, no My Keys needed', async () => {
    const env = newEnv(), keys = fakeKeys(false), p = page(env, { keys });
    await p.gitHydrateToken();
    assert.strictEqual(await p.gitSaveToken(TOKEN), 'device');
    assert.strictEqual(p.gitGetToken(), TOKEN);
    assert.ok(env.ls.getItem(p.gitEncKey('win_default')), 'an encrypted record was written');
    assert.ok(!env.ls.dump().includes(TOKEN), 'the token is not in storage in plain text');
    assert.ok(!env.ls.dump().includes('Z9y8X7') && !env.ls.dump().includes('A1b2C3d4'));
    assert.strictEqual(keys.unlockAsked, 0);
  });
  await t('after a reload (My Keys locked) the token is loaded back by decrypting, and is never asked of My Keys', async () => {
    const env = newEnv();
    await page(env, { keys: fakeKeys(false) }).gitSaveToken(TOKEN);
    const keys = fakeKeys(false), p = page(env, { keys });
    assert.strictEqual(p.gitGetToken(), '', 'not decrypted yet in the first instant');
    assert.strictEqual(p.gitTokenLoading(), true);
    assert.match(p.gitNoTokenMessage(), /loading/i);
    await p.gitHydrateToken();
    assert.strictEqual(p.gitGetToken(), TOKEN);
    assert.strictEqual(p.gitTokenLoading(), false); assert.strictEqual(p.gitTokenLocked(), false);
    assert.ok(p.win.renders > 0, 'the panel was redrawn once the token was ready');
  });
  await t('the token stays usable when My Keys locks or unlocks (the session cache is not tied to the vault)', async () => {
    const env = newEnv(), keys = fakeKeys(true), p = page(env, { keys });
    await p.gitHydrateToken(); await p.gitSaveToken(TOKEN);
    keys.unlocked = false; p.fire('codemini:vault-state', { detail: { unlocked: false } });
    await sleep();
    assert.strictEqual(p.gitGetToken(), TOKEN); assert.strictEqual(p.gitTokenLocked(), false);
  });
  await t('each window/profile has its own record: another window sees no token, and a copied record does not open there', async () => {
    const env = newEnv();
    await page(env, { win: 'win_a' }).gitSaveToken(TOKEN);
    const b = page(env, { win: 'win_b' }); await b.gitHydrateToken();
    assert.strictEqual(b.gitGetToken(), '');
    env.ls.setItem(b.gitEncKey('win_b'), env.ls.getItem(b.gitEncKey('win_a'))); // someone copies A's record into B's slot
    env.ls.setItem(b.gitProfileKey('win_b'), '{"login":"x"}');
    const b2 = page(env, { win: 'win_b' }); await b2.gitHydrateToken();
    assert.strictEqual(b2.gitGetToken(), '', 'the copied record is refused');
    assert.strictEqual(env.ls.getItem(b.gitEncKey('win_b')), null);
  });

  console.log('moving older copies onto the device key');
  await t('a plain-text token (very old versions) is encrypted on load without any unlock, and the plain copy is removed', async () => {
    const env = newEnv(), keys = fakeKeys(false);
    env.ls.setItem('codemini_git_gh_token_win_default', TOKEN);
    const p = page(env, { keys });
    assert.strictEqual(p.gitGetToken(), TOKEN, 'still works while it is being moved');
    await p.gitHydrateToken();
    assert.strictEqual(env.ls.getItem('codemini_git_gh_token_win_default'), null);
    assert.ok(env.ls.getItem(p.gitEncKey('win_default')));
    assert.ok(!env.ls.dump().includes(TOKEN));
    assert.strictEqual(p.gitGetToken(), TOKEN); assert.strictEqual(keys.unlockAsked, 0);
    const again = page(env, { keys: fakeKeys(false) }); await again.gitHydrateToken();
    assert.strictEqual(again.gitGetToken(), TOKEN, 'and it survives a reload');
  });
  await t('a token left in My Keys by the previous version asks for one unlock, then moves to the device key and leaves the vault', async () => {
    const env = newEnv(), keys = fakeKeys(false);
    keys.secrets['github-token'] = TOKEN;
    env.ls.setItem('codemini_git_gh_profile_win_default', '{"login":"me"}');
    const p = page(env, { keys }); await p.gitHydrateToken();
    assert.strictEqual(p.gitGetToken(), ''); assert.strictEqual(p.gitTokenLocked(), true);
    assert.match(p.gitNoTokenMessage(), /unlock my keys once/i);
    keys.unlocked = true; p.fire('codemini:vault-state', { detail: { unlocked: true } });
    await waitFor(() => keys.removed === 1, 'the vault copy to be removed');
    assert.strictEqual(keys.secrets['github-token'], undefined);
    assert.strictEqual(p.gitGetToken(), TOKEN); assert.strictEqual(p.gitTokenLocked(), false);
    keys.unlocked = false;
    const q = page(env, { keys }); await q.gitHydrateToken();
    assert.strictEqual(q.gitGetToken(), TOKEN, 'now usable with My Keys locked');
  });
  await t('if a device copy already exists, an older vault copy is simply removed and never overwrites it', async () => {
    const env = newEnv(), keys = fakeKeys(false);
    await page(env, { keys: fakeKeys(false) }).gitSaveToken(TOKEN2);
    keys.secrets['github-token'] = TOKEN;
    const p = page(env, { keys }); await p.gitHydrateToken();
    keys.unlocked = true; await p.gitMoveVaultTokenToDevice();
    assert.strictEqual(keys.removed, 1); assert.strictEqual(keys.secrets['github-token'], undefined);
    assert.strictEqual(p.gitGetToken(), TOKEN2);
  });
  await t('the vault copy is kept if the device copy cannot be stored and read back', async () => {
    const env = newEnv(), keys = fakeKeys(false);
    keys.secrets['github-token'] = TOKEN;
    const p = page(env, { keys }); await p.gitHydrateToken();
    env.ls.failWrites = (k) => k.startsWith('codemini_git_gh_tokenenc_');
    keys.unlocked = true; await p.gitMoveVaultTokenToDevice();
    assert.strictEqual(keys.removed, 0); assert.strictEqual(keys.secrets['github-token'], TOKEN);
    assert.strictEqual(p.gitGetToken(), TOKEN, 'still readable from My Keys');
  });

  console.log('when the device key is not available or a save fails');
  await t('without IndexedDB it falls back to My Keys: needs it unlocked, asks for the unlock, never writes a plain copy', async () => {
    const env = newEnv(), keys = fakeKeys(false), p = page(env, { keys, noIdb: true });
    await p.gitHydrateToken();
    await assert.rejects(() => p.gitSaveToken(TOKEN), /Unlock My Keys/);
    assert.strictEqual(keys.unlockAsked, 1);
    keys.unlocked = true;
    assert.strictEqual(await p.gitSaveToken(TOKEN), 'vault');
    assert.strictEqual(keys.secrets['github-token'], TOKEN);
    assert.strictEqual(p.gitGetToken(), TOKEN);
    assert.ok(!env.ls.dump().includes(TOKEN) && !env.ls.dump().includes('tokenenc'));
  });
  await t('a failed device save with My Keys unlocked falls back to the vault and the new token wins', async () => {
    const env = newEnv(), keys = fakeKeys(true), p = page(env, { keys });
    await p.gitHydrateToken(); await p.gitSaveToken(TOKEN);
    env.ls.failWrites = (k) => k.startsWith('codemini_git_gh_tokenenc_');
    assert.strictEqual(await p.gitSaveToken(TOKEN2), 'vault');
    assert.strictEqual(p.gitGetToken(), TOKEN2, 'the older device copy no longer shadows the new token');
    assert.strictEqual(env.ls.getItem(p.gitEncKey('win_default')), null);
  });
  await t('a failed save with nowhere else to put the token keeps the old working token (a failed save never destroys one)', async () => {
    const env = newEnv(), keys = fakeKeys(false), p = page(env, { keys });
    await p.gitHydrateToken(); await p.gitSaveToken(TOKEN);
    const before = env.ls.getItem(p.gitEncKey('win_default'));
    const realSet = env.ls.setItem;
    env.ls.setItem = function (k, v) { realSet.call(env.ls, k, v); if (k.startsWith('codemini_git_gh_tokenenc_')) throw new Error('write came back wrong'); };
    await assert.rejects(() => p.gitSaveToken(TOKEN2), /could not store|would not let CodeMini/i);
    env.ls.setItem = realSet;
    assert.strictEqual(env.ls.getItem(p.gitEncKey('win_default')), before, 'the previous record was put back');
    assert.strictEqual(p.gitGetToken(), TOKEN);
    const q = page(env, { keys: fakeKeys(false) }); await q.gitHydrateToken();
    assert.strictEqual(q.gitGetToken(), TOKEN);
  });
  await t('a save made while the first load is still running wins over what that load finds', async () => {
    const env = newEnv();
    await page(env, { keys: fakeKeys(false) }).gitSaveToken(TOKEN);
    const p = page(env, { keys: fakeKeys(false) });          // loading TOKEN
    const saving = p.gitSaveToken(TOKEN2);                    // saving TOKEN2 at the same time
    await Promise.all([p.gitHydrateToken(), saving]);
    assert.strictEqual(p.gitGetToken(), TOKEN2);
    const q = page(env, { keys: fakeKeys(false) }); await q.gitHydrateToken();
    assert.strictEqual(q.gitGetToken(), TOKEN2);
  });

  console.log('a token that can no longer be read');
  await t('if this browser has lost its device key the record is removed, the person is told once, and nothing stale is shown', async () => {
    const env = newEnv();
    await page(env, { keys: fakeKeys(false) }).gitSaveToken(TOKEN);
    env.ls.setItem('codemini_git_gh_profile_win_default', '{"login":"me"}');
    env.idb = null; const lost = { idb: fakeIndexedDB(), ls: env.ls }; // same localStorage, empty IndexedDB
    const p = page(lost, { keys: fakeKeys(false) }); await p.gitHydrateToken();
    assert.strictEqual(p.gitGetToken(), '');
    assert.strictEqual(env.ls.getItem(p.gitEncKey('win_default')), null);
    assert.strictEqual(env.ls.getItem(p.gitProfileKey('win_default')), null);
    assert.strictEqual(p.notices.filter((x) => x.id === 'git-token').length, 1);
    assert.match(p.gitNoTokenMessage(), /can no longer be decrypted/);
    assert.strictEqual(lost.idb.puts, 0, 'reading never invents a new key');
    assert.strictEqual(p.gitTokenLocked(), false);
  });
  await t('a damaged record is treated the same way', async () => {
    const env = newEnv();
    await page(env, { keys: fakeKeys(false) }).gitSaveToken(TOKEN);
    env.ls.setItem('codemini_git_gh_tokenenc_win_default', '{not json');
    const p = page(env, { keys: fakeKeys(false) }); await p.gitHydrateToken();
    assert.strictEqual(p.gitGetToken(), ''); assert.strictEqual(env.ls.getItem('codemini_git_gh_tokenenc_win_default'), null);
  });
  await t('if key storage is merely unreachable right now, NOTHING is deleted and it is tried again on the next load', async () => {
    const env = newEnv();
    await page(env, { keys: fakeKeys(false) }).gitSaveToken(TOKEN);
    const rec = env.ls.getItem('codemini_git_gh_tokenenc_win_default');
    env.idb.failOpen = true;
    const p = page(env, { keys: fakeKeys(false) }); await p.gitHydrateToken();
    assert.strictEqual(p.gitGetToken(), '');
    assert.strictEqual(env.ls.getItem('codemini_git_gh_tokenenc_win_default'), rec);
    assert.match(p.gitNoTokenMessage(), /key storage cannot be reached/);
    env.idb.failOpen = false;
    const q = page(env, { keys: fakeKeys(false) }); await q.gitHydrateToken();
    assert.strictEqual(q.gitGetToken(), TOKEN);
  });

  console.log('drawing the panel');
  await t('loading with nothing to decrypt (or no device key) redraws once and does not loop', async () => {
    // With a device key the load ends by redrawing (once). Without one nothing changed, so there is no redraw.
    for (const [opts, min] of [[{ keys: fakeKeys(false) }, 1], [{ keys: fakeKeys(false), noIdb: true }, 0], [{ keys: null, noIdb: true }, 0]]) {
      const p = page(newEnv(), opts);
      await p.gitHydrateToken();
      await sleep(); await sleep();
      assert.ok(p.win.renders >= min && p.win.renders <= 3, 'renders: ' + p.win.renders);
    }
  });

  console.log('another tab');
  await t('when another tab replaces or removes the token, this page reads it again', async () => {
    const env = newEnv(), a = page(env, { keys: fakeKeys(false) }), b = page(env, { keys: fakeKeys(false) });
    await a.gitHydrateToken(); await b.gitHydrateToken();
    await a.gitSaveToken(TOKEN);
    b.fire('storage', { key: b.gitEncKey('win_default') });
    await waitFor(() => b.gitGetToken() === TOKEN, 'tab B to pick up the new token');
    await a.gitSaveToken(TOKEN2);
    b.fire('storage', { key: b.gitEncKey('win_default') });
    await waitFor(() => b.gitGetToken() === TOKEN2, 'tab B to pick up the replaced token');
    env.ls.removeItem(b.gitEncKey('win_default'));
    b.fire('storage', { key: b.gitEncKey('win_default') });
    await waitFor(() => b.gitGetToken() === '', 'tab B to drop the removed token');
    b.fire('storage', { key: 'some_other_key' }); // unrelated keys do nothing
  });

  console.log('wiring');
  await t('git.js stores through Shield only: no Web Crypto of its own, no plain write of the token, My Keys only as the fallback', () => {
    // (git.js does use crypto.subtle.digest for git object ids; that is hashing, not secrets.)
    assert.ok(!/subtle\.(encrypt|decrypt|importKey|deriveKey|deriveBits|generateKey|wrapKey)|getRandomValues/.test(git), 'git.js must call Shield for anything secret');
    // The only write of a plain token is the old one-time hand-over of an un-suffixed legacy token to its window slot
    // (gitMigrateLegacyToken); gitHydrateToken then encrypts it on load.
    const outside = git.replace(/function gitMigrateLegacyToken\(\) \{[\s\S]*?\n\}\n/, '');
    assert.ok(!/localStorage\.setItem\(gitTokenKey\(/.test(outside), 'a plain token is written outside the legacy hand-over');
    assert.ok(/CodeMiniShield/.test(git) && /dev\.seal\(/.test(git) && /dev\.open\(/.test(git));
    assert.ok(/setSecret\('github-token'/.test(git), 'the My Keys fallback is still there');
  });
  await t('every place that clears the token also clears the encrypted copy and the session cache', () => {
    const body = (git.match(/function gitDisconnectGitHub\(\) \{[\s\S]*?\n\}\n/) || [])[0];
    assert.ok(body && /gitEncKey\(winId\)/.test(body) && /delete gitTokenCache\[winId\]/.test(body) && /gitBumpTokenGen\(winId\)/.test(body));
  });

  await t('"Reset settings" keeps the encrypted token (like the vault), while a plain-text token is still cleared', () => {
    const src = read('js/core/settings-profile.js');
    const m = src.match(/key\.match\((\/\^codemini_\(profile_states[^\n]*?\)\/)\)/);
    assert.ok(m, 'keep-list regex not found in settings-profile.js');
    const keep = eval(m[1]); // a literal regex copied out of our own source
    assert.ok(keep.test('codemini_git_gh_tokenenc_win_default'), 'the encrypted token record must be kept');
    assert.ok(keep.test('codemini_vault_win_default'));
    assert.ok(!keep.test('codemini_git_gh_token_win_default'), 'a plain-text token is not protected by the keep-list');
  });
  await t('deleting a profile or wiping a window removes keys by window id, which covers the encrypted token record', () => {
    assert.ok(/key\.includes\(w\.id\)/.test(read('js/core/app.js')), 'app.js teardown matches keys by window id');
    assert.ok(/key\.includes\(winId\)/.test(read('js/core/settings-profile.js')), 'Wipe/Delete Profile matches keys by window id');
    assert.ok(/codemini_git_gh_tokenenc_\$\{/.test(git), 'the record key is built from the window id');
  });

  console.log(`\n${n} git token checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
