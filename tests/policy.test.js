const vm = require('vm'), fs = require('fs'), assert = require('assert');
// Load the module in a stub environment just far enough to reach its pure policy functions.
const store = {};
const noop = () => {};
const fakeEl = () => new Proxy(function(){}, { get: (t, k) => k === 'classList' ? { toggle: noop, add: noop, remove: noop, contains: () => false } : (k === 'querySelector' ? () => null : noop), apply: () => fakeEl() });
const win = { addEventListener: noop, dispatchEvent: noop, CustomEvent: function(){} };
const ctx = vm.createContext({
  window: win, console, setTimeout, Promise, CustomEvent: function(){},
  localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => store[k] = String(v) },
  document: { readyState: 'complete', body: null, addEventListener: noop, getElementById: () => null, querySelector: () => null, createElement: fakeEl, head: {appendChild: noop} },
});
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'js', 'core', 'workspace-trust.js'), 'utf8'), ctx);
const P = win.WorkspaceTrust._policy;
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

console.log('resolveTrust');
t('master switch off => everything trusted, even an explicit denial', () =>
  assert.strictEqual(JSON.stringify(P.resolveTrust({ enabled: false, emptyWindow: false, isRoot: false, record: { trusted: false } })), JSON.stringify({ trusted: true, reason: 'disabled' })));
t('explicit grant', () => assert.strictEqual(P.resolveTrust({ enabled: true, emptyWindow: false, isRoot: false, record: { trusted: true } }).reason, 'granted'));
t('explicit denial beats the empty-window default', () => {
  const r = P.resolveTrust({ enabled: true, emptyWindow: true, isRoot: true, record: { trusted: false } });
  assert.strictEqual(JSON.stringify(r), JSON.stringify({ trusted: false, reason: 'denied' }));
});
t('empty window trusted only when setting on AND location is a root', () => {
  assert.strictEqual(P.resolveTrust({ enabled: true, emptyWindow: true, isRoot: true, record: null }).trusted, true);
  assert.strictEqual(P.resolveTrust({ enabled: true, emptyWindow: false, isRoot: true, record: null }).trusted, false);
  assert.strictEqual(P.resolveTrust({ enabled: true, emptyWindow: true, isRoot: false, record: null }).trusted, false);
});
t('unknown workspace is restricted', () => assert.strictEqual(P.resolveTrust({ enabled: true, emptyWindow: true, isRoot: false, record: null }).reason, 'unknown'));

console.log('shouldPromptOnOpen');
const base = { enabled: true, isRoot: false, trusted: false, hasRecord: false, startupPrompt: 'once', isSameLocation: false };
t('once: asks when nothing saved', () => assert.strictEqual(P.shouldPromptOnOpen(base), true));
t('once: does NOT ask again once any answer (even "no") is saved', () => assert.strictEqual(P.shouldPromptOnOpen({ ...base, hasRecord: true }), false));
t('always: asks even if a "no" is saved', () => assert.strictEqual(P.shouldPromptOnOpen({ ...base, startupPrompt: 'always', hasRecord: true }), true));
t('never: never asks', () => assert.strictEqual(P.shouldPromptOnOpen({ ...base, startupPrompt: 'never' }), false));
t('already trusted => no prompt in any mode', () => ['always','once','never'].forEach(m => assert.strictEqual(P.shouldPromptOnOpen({ ...base, trusted: true, startupPrompt: m }), false)));
t('root/empty window never gets a modal', () => assert.strictEqual(P.shouldPromptOnOpen({ ...base, isRoot: true, startupPrompt: 'always' }), false));
t('trust disabled => no prompt', () => assert.strictEqual(P.shouldPromptOnOpen({ ...base, enabled: false }), false));
t('re-opening the same location (terminal cd, db reopen) does not re-prompt', () => assert.strictEqual(P.shouldPromptOnOpen({ ...base, startupPrompt: 'always', isSameLocation: true }), false));

console.log('shouldPersistDenial');
t('always+startup "no" is not remembered (that is what makes it ask every time)', () => assert.strictEqual(P.shouldPersistDenial('startup', 'always'), false));
t('once+startup "no" is remembered', () => assert.strictEqual(P.shouldPersistDenial('startup', 'once'), true));
t('deliberate actions are always remembered, even under always', () => ['banner','action'].forEach(src => assert.strictEqual(P.shouldPersistDenial(src, 'always'), true)));

console.log('bannerVisible');
t('Always: shown whenever restricted, ignores dismissal', () => assert.strictEqual(P.bannerVisible({ enabled: true, trusted: false, banner: 'always', dismissed: true }), true));
t('Until Dismissed: hidden once dismissed', () => {
  assert.strictEqual(P.bannerVisible({ enabled: true, trusted: false, banner: 'untilDismissed', dismissed: false }), true);
  assert.strictEqual(P.bannerVisible({ enabled: true, trusted: false, banner: 'untilDismissed', dismissed: true }), false);
});
t('Never: never shown', () => assert.strictEqual(P.bannerVisible({ enabled: true, trusted: false, banner: 'never', dismissed: false }), false));
t('trusted or disabled => never shown', () => {
  assert.strictEqual(P.bannerVisible({ enabled: true, trusted: true, banner: 'always', dismissed: false }), false);
  assert.strictEqual(P.bannerVisible({ enabled: false, trusted: false, banner: 'always', dismissed: false }), false);
});

console.log('planIncomingFiles');
const inc = { enabled: true, destTrusted: true, destReason: 'granted', untrustedFiles: 'prompt', windowLimitReached: false };
t('Prompt => prompt', () => assert.strictEqual(P.planIncomingFiles(inc), 'prompt'));
t('Open => here', () => assert.strictEqual(P.planIncomingFiles({ ...inc, untrustedFiles: 'open' }), 'here'));
t('New window => newWindow', () => assert.strictEqual(P.planIncomingFiles({ ...inc, untrustedFiles: 'newWindow' }), 'newWindow'));
t('New window at the 4-window cap falls back to prompt', () => assert.strictEqual(P.planIncomingFiles({ ...inc, untrustedFiles: 'newWindow', windowLimitReached: true }), 'prompt'));
t('destination already restricted => just add (nothing to protect)', () => assert.strictEqual(P.planIncomingFiles({ ...inc, destTrusted: false }), 'here'));
t('empty window trusted by setting => add without asking (the documented purpose of that setting)', () => assert.strictEqual(P.planIncomingFiles({ ...inc, destReason: 'empty-window' }), 'here'));
t('trust disabled => here', () => assert.strictEqual(P.planIncomingFiles({ ...inc, enabled: false }), 'here'));
console.log(`\n${n} policy checks passed`);
