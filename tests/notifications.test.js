// Notifications: the toast that shows when Now Island is closed, and the five things that feed it (storage safety,
// offline readiness, Source Control problems, My Keys / Restricted Mode security events, long notebook work).
// Behaviour of js/core/app-alerts.js is run against fake browser APIs (no browser); the rest is wiring checks.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok', name); };
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------------------------------------------
// app-alerts.js behaviour
// ---------------------------------------------------------------------------------------------------------------
const alertsSrc = read('js/core/app-alerts.js');

function makeStore(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _m: m };
}

async function boot({ usage = 10, quota = 100, persisted = true, canPersist = true, persistResult = true, cacheNames = [], hasIndex = true,
  store = makeStore(), withNotifications = true, noStorageApi = false } = {}) {
  const added = [], removed = [], timeouts = [], toasts = [];
  const storage = noStorageApi ? undefined : {
    estimate: async () => ({ usage, quota }),
    persisted: async () => persisted,
    persist: canPersist ? async () => persistResult : undefined
  };
  const win = {
    CodeMiniNotifications: withNotifications ? { add: (x) => { added.push(x); return x.id; }, remove: (id) => { removed.push(id); } } : undefined,
    showSuccessToast: (m) => toasts.push(m),
    addEventListener() {}
  };
  const ctx = {
    window: win, localStorage: store, console, Date, JSON, Math, Promise, Array, Object, Number, String,
    document: { readyState: 'complete', hidden: false, addEventListener() {} },
    navigator: { storage, serviceWorker: { ready: Promise.resolve({}) } },
    caches: {
      keys: async () => cacheNames,
      open: async () => ({ match: async () => (hasIndex ? {} : undefined) })
    },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    setInterval: () => 0
  };
  win.navigator = ctx.navigator; win.localStorage = store; win.caches = ctx.caches; // in a browser these are all on window
  vm.runInNewContext(alertsSrc, ctx);
  // The checks are scheduled a few seconds after start-up; fire that first timer by hand.
  const first = timeouts.find((x) => x.ms >= 1000);
  assert.ok(first, 'the first check is scheduled after start-up');
  first.fn();
  await tick(); await tick(); await tick();
  return { added, removed, toasts, store, alerts: win.CodeMiniAlerts, state: () => JSON.parse(store.getItem('codemini_alerts_state') || '{}') };
}

(async () => {
  console.log('app-alerts behaviour');

  await t('storage at 92% raises one "storage is 92% full" notice from CodeMini', async () => {
    const r = await boot({ usage: 92 });
    const low = r.added.filter((x) => x.id === 'storage-low');
    assert.strictEqual(low.length, 1);
    assert.ok(/92%/.test(low[0].title) && low[0].source === 'CodeMini');
  });
  await t('below 80% nothing is raised', async () => {
    const r = await boot({ usage: 79 });
    assert.strictEqual(r.added.filter((x) => x.id === 'storage-low').length, 0);
  });
  await t('the same level is not repeated within a week (state is remembered)', async () => {
    const store = makeStore();
    await boot({ usage: 92, store });
    const again = await boot({ usage: 92, store });
    assert.strictEqual(again.added.filter((x) => x.id === 'storage-low').length, 0);
  });
  await t('a higher level (95%) is raised even inside that week', async () => {
    const store = makeStore();
    await boot({ usage: 82, store });
    const worse = await boot({ usage: 96, store });
    assert.strictEqual(worse.added.filter((x) => x.id === 'storage-low').length, 1);
  });
  await t('once usage drops back under 80% the old warning is removed', async () => {
    const store = makeStore();
    await boot({ usage: 92, store });
    const ok = await boot({ usage: 30, store });
    assert.ok(ok.removed.includes('storage-low'));
    assert.strictEqual(ok.state().quotaLevel, 0);
  });

  await t('storage that is not persistent raises one notice with a "Protect my files" action', async () => {
    const r = await boot({ persisted: false });
    const p = r.added.filter((x) => x.id === 'storage-persist');
    assert.strictEqual(p.length, 1);
    assert.deepStrictEqual(Array.from(p[0].actions), ['protect-storage']);
    assert.strictEqual(r.alerts.canProtectStorage(), true);
  });
  await t('...and not again within two weeks', async () => {
    const store = makeStore();
    await boot({ persisted: false, store });
    const again = await boot({ persisted: false, store });
    assert.strictEqual(again.added.filter((x) => x.id === 'storage-persist').length, 0);
  });
  await t('persistent storage raises nothing, and clears an earlier notice', async () => {
    const store = makeStore({ codemini_alerts_state: JSON.stringify({ persistAt: Date.now() }) });
    const r = await boot({ persisted: true, store });
    assert.strictEqual(r.added.filter((x) => x.id === 'storage-persist').length, 0);
    assert.ok(r.removed.includes('storage-persist'));
    assert.strictEqual(r.alerts.canProtectStorage(), false);
  });
  await t('a browser with no persist() is not nagged about something the person cannot fix', async () => {
    const r = await boot({ persisted: false, canPersist: false });
    assert.strictEqual(r.added.filter((x) => x.id === 'storage-persist').length, 0);
  });
  await t('Protect my files: granted removes the notice and confirms', async () => {
    const r = await boot({ persisted: false, persistResult: true });
    await r.alerts.protectStorage();
    assert.ok(r.removed.includes('storage-persist'));
    assert.ok(r.toasts.some((m) => /protected/i.test(m)));
    assert.strictEqual(r.alerts.canProtectStorage(), false);
  });
  await t('Protect my files: refused replaces the notice with an honest explanation', async () => {
    const r = await boot({ persisted: false, persistResult: false });
    await r.alerts.protectStorage();
    const last = r.added[r.added.length - 1];
    assert.strictEqual(last.id, 'storage-persist');
    assert.ok(/did not agree/.test(last.title));
  });

  await t('offline ready: raised once when the app shell is cached and the worker is active', async () => {
    const store = makeStore();
    const r = await boot({ cacheNames: ['codemini-static-v1.3.1'], store });
    assert.strictEqual(r.added.filter((x) => x.id === 'offline-ready').length, 1);
    const again = await boot({ cacheNames: ['codemini-static-v1.3.1'], store });
    assert.strictEqual(again.added.filter((x) => x.id === 'offline-ready').length, 0, 'said once, ever');
  });
  await t('offline ready: nothing when the shell is not cached yet', async () => {
    const none = await boot({ cacheNames: [] });
    assert.strictEqual(none.added.filter((x) => x.id === 'offline-ready').length, 0);
    const noIndex = await boot({ cacheNames: ['codemini-static-v1.3.1'], hasIndex: false });
    assert.strictEqual(noIndex.added.filter((x) => x.id === 'offline-ready').length, 0);
  });
  await t('without the notification system, or without the Storage API, nothing throws', async () => {
    await boot({ usage: 99, persisted: false, withNotifications: false, cacheNames: ['codemini-static-v1.3.1'] });
    const r = await boot({ noStorageApi: true });
    assert.strictEqual(r.added.filter((x) => /storage/.test(x.id)).length, 0);
  });

  // -------------------------------------------------------------------------------------------------------------
  console.log('wiring: the toast');
  const island = read('js/core/now-island.js'), style = read('css/style.css'), themes = read('css/themes.css');
  const islandCss = island.slice(island.indexOf('style.innerHTML = `') + 19, island.indexOf('document.head.appendChild(style)'));
  const cssNoComments = islandCss.replace(/\/\*[\s\S]*?\*\//g, '');

  await t('it has its own names: no selector reuses the app toast\'s ids or classes', () => {
    const selectors = (cssNoComments.match(/[^{}]+(?=\{)/g) || []).join('\n');
    assert.ok(/#notifToastStack/.test(selectors) && /\.nt-toast/.test(selectors));
    assert.ok(!/custom-toast|toast-container/.test(selectors), 'no shared selector');
    assert.ok(/stack\.id = 'notifToastStack'|toastStack\.id = 'notifToastStack'/.test(island));
    assert.ok(!/id = 'toast-container'|className = 'toast-container'|'custom-toast'/.test(island), 'the JS never creates the app toast elements');
    assert.ok(!/\bnt-|notifToast/.test(style), 'and style.css does not know about them');
  });
  await t('it sits exactly where the app toast sits, on desktop and on mobile', () => {
    const app = style.slice(style.indexOf('.toast-container {'));
    const appDesk = app.match(/bottom:\s*(\d+)px;\s*right:\s*(\d+)px/);
    const appMob = style.slice(style.indexOf('@media (max-width: 768px) {\n    .toast-container')).match(/right:\s*(\d+)px;\s*left:\s*(\d+)px;\s*bottom:\s*(\d+)px/);
    assert.ok(appDesk && appMob, 'found the app toast position');
    const desk = cssNoComments.match(/#notifToastStack\s*\{[^}]*bottom:\s*calc\((\d+)px[^}]*right:\s*(\d+)px/);
    assert.ok(desk && desk[1] === appDesk[1] && desk[2] === appDesk[2], `desktop bottom/right ${desk && desk.slice(1)} vs ${appDesk.slice(1)}`);
    const mob = cssNoComments.slice(cssNoComments.indexOf('@media (max-width: 768px)')).match(/#notifToastStack\s*\{[^}]*left:\s*(\d+)px;[^}]*right:\s*(\d+)px;[^}]*bottom:\s*calc\((\d+)px/);
    assert.ok(mob && mob[1] === appMob[2] && mob[2] === appMob[1] && mob[3] === appMob[3], `mobile ${mob && mob.slice(1)} vs ${appMob.slice(1)}`);
  });
  await t('layout: source (top left) and close (top right) on one row, then title, then a one-line truncated text', () => {
    const build = island.slice(island.indexOf('function showToast'), island.indexOf('// ---- viewer ----'));
    assert.ok(/head\.append\(el\('span', 'nt-source'\), close\)/.test(build), 'source then close in the head row');
    assert.ok(/t\.append\(head, el\('div', 'nt-title'\), el\('div', 'nt-text'\)\)/.test(build), 'head, title, text in that order');
    assert.ok(/\.nt-head\s*\{[^}]*justify-content:\s*space-between/.test(cssNoComments));
    assert.ok(/\.nt-text\s*\{[^}]*white-space:\s*nowrap[^}]*\}/.test(cssNoComments) && /\.nt-text\s*\{[^}]*text-overflow:\s*ellipsis/.test(cssNoComments), 'one line, truncated');
    assert.ok(/\.nt-toast\s*\{[^}]*text-align:\s*left/.test(cssNoComments), 'left aligned');
    assert.ok(/textContent = n\.source/.test(build) && /textContent = n\.title/.test(build) && /textContent = n\.text/.test(build), 'text is set with textContent (never as HTML)');
  });
  await t('it shows only while Now Island is closed, and opening the island clears it', () => {
    assert.ok(/!panel\.classList\.contains\('show'\)\) showToast\(n\)/.test(island));
    assert.ok(/if \(open\) dismissAllToasts\(\)/.test(island) && /function openNotification\(id\) \{\s*panel\.classList\.add\('show'\);\s*dismissAllToasts\(\)/.test(island));
  });
  await t('clicking the toast opens that notification; the X only dismisses it', () => {
    assert.ok(/t\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); dismissToast\(n\.id\); openNotification\(n\.id\); \}\)/.test(island), 'stops the click reaching the click-outside handler');
    assert.ok(/close\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); dismissToast\(n\.id\); \}\)/.test(island));
  });
  await t('it is removed when the notification is read or deleted, and survives Performance Mode (timer fallback)', () => {
    assert.ok(/n\.read = true;\s*dismissToast\(id\);/.test(island) && /hideViewer\(\);\s*dismissToast\(id\);/.test(island));
    assert.ok(/setTimeout\(finish, 300\)/.test(island));
  });
  await t('it lifts itself above the app toast instead of overlapping it', () => {
    assert.ok(/getElementById\('toast-container'\)/.test(island) && /--nt-offset/.test(island));
  });
  await t('every notification can carry a source, and the update notice does not double-toast', () => {
    assert.ok(/source: String\(\(input && input\.source\) \|\| 'CodeMini'\)/.test(island));
    assert.ok(/toast: false, \/\/ pwa\.js already shows its own/.test(island));
    assert.ok(/input\.toast === false/.test(island));
  });
  await t('the premium theme rounds it like the app toast', () => {
    assert.ok(/codemini-premium"\] \.nt-toast,/.test(themes));
  });

  // -------------------------------------------------------------------------------------------------------------
  console.log('wiring: actions and files');
  const html = read('index.html'), sw = read('sw.js');
  await t('app-alerts.js loads after now-island.js and is precached', () => {
    assert.ok(html.indexOf('js/core/app-alerts.js') > html.indexOf('js/core/now-island.js'));
    assert.ok(sw.includes("'/js/core/app-alerts.js'"));
  });
  await t('every action a notification asks for exists, and the sidebars they open exist', () => {
    ['open-source-control', 'open-keys', 'open-security', 'protect-storage', 'reload', 'open-updates'].forEach((k) => assert.ok(new RegExp(`'${k}':`).test(island), k));
    ['id="sourceControlSidebar"', 'id="keysSidebar"', 'id="menuKeys"'].forEach((s) => assert.ok(html.includes(s), s));
    assert.ok(/id="menuSource"/.test(html) || /menuSource/.test(read('js/core/script.js')));
    assert.ok(/data-tab="security"/.test(read('js/core/settings-profile.js')));
  });

  console.log('wiring: Source Control');
  const git = read('js/git/git.js');
  await t('merge, cherry-pick and rebase conflicts each raise a Source Control notice (toast kept as fallback)', () => {
    assert.strictEqual((git.match(/gitNotifyConflict\(dbName, '/g) || []).length, 3);
    assert.ok(/id: 'git-conflict-' \+ dbName|'git-conflict-' \+ dbName/.test(git));
    assert.ok(/source: 'Source Control'/.test(git));
  });
  await t('a conflict notice is cleared when the merge/rebase is finished or aborted', () => {
    assert.ok(/gitClearNotice\('git-conflict-' \+ dbName\)/.test(git));
  });
  await t('a rejected saved token raises one notice; trying a new token from the form does not', () => {
    assert.ok(/res\.status === 401 && !tokenOverride\) gitNotifyTokenRejected\(\)/.test(git));
    assert.ok(/gitNotifyTokenRejected\(\); \}/.test(git), 'also from the silent re-verify');
    assert.strictEqual((git.match(/gitClearNotice\('git-token'\)/g) || []).length >= 3, true, 'cleared on connect, verify and disconnect');
  });
  await t('push and pull failures notify, but a rejected token is not announced twice', () => {
    assert.ok(/id: 'git-push-failed'/.test(git) && /id: 'git-pull-failed'/.test(git));
    assert.strictEqual((git.match(/if \(!\(e\.status === 401 && !e\.noToken\)\)/g) || []).length, 2);
    assert.ok(/gitClearNotice\('git-push-failed'\)/.test(git) && /gitClearNotice\('git-pull-failed'\)/.test(git), 'cleared by the next success');
  });
  await t('notice text is passed through the token redaction first', () => {
    assert.ok(/text: gitRedact\(String\(n\.text \|\| ''\)\)\.slice\(0, 400\)/.test(git));
  });

  console.log('wiring: My Keys');
  const vault = read('js/core/my-keys.js');
  await t('5 wrong passwords in a row raise one (replaced, not stacked) security notice', () => {
    assert.ok(/g\.fails >= 5 && g\.fails % 5 === 0/.test(vault) && /id: 'vault-attempts'/.test(vault));
    assert.ok(/source: 'My Keys'/.test(vault));
  });
  await t('the backup reminder: weekly at most, 2 days after first use or when the last backup is 30 days old', () => {
    assert.ok(/BACKUP_FIRST_MS = 2 \* DAY_MS/.test(vault) && /BACKUP_STALE_MS = 30 \* DAY_MS/.test(vault) && /BACKUP_REPEAT_MS = 7 \* DAY_MS/.test(vault));
    assert.ok(/maybeNudgeBackup\(\);\s*\}/.test(vault), 'checked when a vault is opened');
    assert.ok(/st\.cfg\.lastBackup = Date\.now\(\)/.test(vault) && /clearNotice\('vault-backup'\)/.test(vault), 'an export answers it');
    assert.ok(/since: stamp\(c\.since\)/.test(vault), 'the timestamps survive the settings sanitising');
  });
  await t('no notification text can contain vault contents', () => {
    const calls = (vault.match(/notifyApp\(\{[\s\S]*?\n\s*\}\);/g) || []);
    assert.strictEqual(calls.length, 2, 'attempts + backup');
    calls.forEach((c) => assert.ok(!/entries|\.value|secret|st\.key|\.name\b|service/.test(c), 'no entry data in: ' + c.slice(0, 60)));
  });

  console.log('wiring: Workspace Trust');
  const trust = read('js/core/workspace-trust.js');
  await t('an untrusted workspace raises one "Restricted Mode is on" notice per workspace, cleared on trust', () => {
    assert.ok(/id: noticeId\(dbName\)/.test(trust) && /restrictedNoticed\.has\(dbName\)/.test(trust));
    assert.ok(/noticeRestricted\(name\);\s*return 'restricted'/.test(trust), 'declining the prompt');
    assert.ok(/else setTimeout\(\(\) => \{ if \(ctx\.db === dbName\) noticeRestricted\(dbName\)/.test(trust), 'opened untrusted with no prompt');
    assert.ok(/stateFor\(dbName\)\.trusted\) clearRestrictedNotice\(dbName\)/.test(trust));
    assert.ok(/st\.isRoot/.test(trust.slice(trust.indexOf('function noticeRestricted'))), 'an empty window has nothing to restrict');
  });

  console.log('wiring: Notebooks');
  const kern = read('js/notebook/notebook-kernels.js'), nbui = read('js/notebook/notebook-ui.js');
  await t('Python / R engine loads and package installs notify only when the person is not looking', () => {
    assert.ok(/function _nbAway\(startWin\) \{\s*return document\.hidden \|\| _getWinId\(\) !== startWin;/.test(kern));
    assert.strictEqual((kern.match(/if \(_nbAway\((winId|installWin)\)\) _nbNotify\(/g) || []).length, 3, 'python, r, package');
    assert.ok(/source: 'Notebooks'/.test(kern));
  });
  await t('Run All notifies after 15 s or more, never for a run the person stopped', () => {
    assert.ok(/NB_LONG_RUN_MS = 15000/.test(kern));
    assert.ok(/interrupted \|\| Date\.now\(\) - startedAt < NB_LONG_RUN_MS \|\| !_nbAway\(startWin\)\) return/.test(kern));
    assert.strictEqual((nbui.match(/window\.notifyNotebookRunDone\(pane, runStart, runWin, runStopped\)/g) || []).length, 2, 'both Run All variants');
  });

  console.log(`\n${n} notification checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
