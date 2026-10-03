// ==========================================
// workspace-trust.js (Workspace Trust / Restricted Mode)
// ==========================================
// Makes the five Settings > Security options real:
//
//   Workspace Trust ................ master switch. Off = every workspace is trusted, nothing below applies.
//   Workspace Trust Window ......... whether a window's root (the "empty window", i.e. not inside any
//                                    workspace) is trusted without being asked.
//   Workspace Trust Startup Prompt . when entering a workspace that isn't trusted yet shows the
//                                    "do you trust the authors?" dialog (Always / Once / Never).
//   Workspace Trust Banner ......... when the Restricted Mode banner is shown (Always / Until Dismissed / Never).
//   Workspace Trust Untrusted Files  what happens when files from outside CodeMini (uploads, drag-and-drop,
//                                    GitHub import) are added to a TRUSTED workspace (Prompt / Open / New window).
//
// WHAT "WORKSPACE" MEANS HERE
//   A trust decision belongs to one IndexedDB database: either a workspace's own DB (CodeMiniDB_WS_...) or a
//   window's root DB (the empty window). That is the same unit the rest of the app already isolates by, and
//   `db.name` is what every file read/write actually targets, so it is the single source of truth for "where
//   am I". Non-profile windows share one root DB, so they share its trust state - same data, same decision.
//
// WHAT RESTRICTED MODE TURNS OFF (everything that executes workspace content)
//   - running notebook code cells            (notebook-kernels.js runCell)
//   - Live Preview                           (preview.js renderPreviewContent) - its iframe is sandboxed with
//                                            allow-scripts + allow-same-origin, i.e. workspace scripts would run
//                                            with full access to the app's storage
//   - running files from the terminal        (terminal-window.js executeFile: run/sh/bash/python/ruby/php/./x)
//   - running/debugging files in the editor  (editor.js runDebugSession, Run, "Run in console")
//   - marking a notebook "Trusted"           (notebook-ui.js), and notebook HTML/Markdown output is always
//                                            sanitized (notebook-kernels.js)
//   Typed input (the Console REPL, `js`/`py` one-liners) is deliberately NOT blocked: the person typing it is
//   the author. Restricted Mode is about running code you did not write.
//
// Decisions are stored per profile scope in localStorage (codemini_trust_records_<scope>), where scope is
// 'main' for the native/shared windows and the window id for isolated profile windows.

(function initWorkspaceTrust() {
    'use strict';
    if (window.WorkspaceTrust) return;

    const RECORDS_PREFIX = 'codemini_trust_records_';
    const DISMISS_PREFIX = 'codemini_trust_banner_dismissed_';
    const MAX_WINDOWS = 4; // mirrors the limit enforced by "New Window" in script.js

    // ------------------------------------------------------------------
    // 1. Pure policy - no DOM, no storage. Unit-tested in isolation.
    // ------------------------------------------------------------------

    // Is this location trusted? Precedence: master switch > explicit decision > empty-window setting > unknown.
    function resolveTrust({ enabled, emptyWindow, isRoot, record }) {
        if (!enabled) return { trusted: true, reason: 'disabled' };
        if (record) return record.trusted ? { trusted: true, reason: 'granted' } : { trusted: false, reason: 'denied' };
        if (isRoot && emptyWindow) return { trusted: true, reason: 'empty-window' };
        return { trusted: false, reason: 'unknown' };
    }

    // Should entering this location open the startup dialog?
    //   always: ask whenever it isn't trusted (a "no" is never remembered, so every open asks again)
    //   once:   ask only if there's no saved answer yet (a "no" IS remembered)
    //   never:  never ask - it simply opens in Restricted Mode
    // The empty window (root) never gets a modal; it has the banner and the status-bar item instead.
    function shouldPromptOnOpen({ enabled, isRoot, trusted, hasRecord, startupPrompt, isSameLocation }) {
        if (!enabled || isRoot || isSameLocation || trusted) return false;
        if (startupPrompt === 'never') return false;
        if (startupPrompt === 'once' && hasRecord) return false;
        return true;
    }

    // Under 'always', a "no" from the startup dialog is not remembered - that is what makes it ask every time.
    // Anything the person does on purpose (banner > Manage, Settings, a blocked action) is always remembered.
    function shouldPersistDenial(source, startupPrompt) {
        return !(source === 'startup' && startupPrompt === 'always');
    }

    function bannerVisible({ enabled, trusted, banner, dismissed }) {
        if (!enabled || trusted) return false;
        if (banner === 'never') return false;
        if (banner === 'untilDismissed' && dismissed) return false;
        return true;
    }

    // Where do files arriving from outside CodeMini go? Only a TRUSTED workspace needs protecting from them.
    // A destination that is already restricted just takes them. An empty window that is trusted only because
    // of the Workspace Trust Window setting also takes them without asking - that is exactly what that setting
    // is documented to enable.
    function planIncomingFiles({ enabled, destTrusted, destReason, untrustedFiles, windowLimitReached }) {
        if (!enabled || !destTrusted) return 'here';
        if (destReason === 'empty-window') return 'here';
        if (untrustedFiles === 'open') return 'here';
        if (untrustedFiles === 'newWindow') return windowLimitReached ? 'prompt' : 'newWindow';
        return 'prompt';
    }

    // ------------------------------------------------------------------
    // 2. Storage
    // ------------------------------------------------------------------
    function readJSON(key, fallback) {
        try {
            const v = JSON.parse(localStorage.getItem(key));
            return v && typeof v === 'object' ? v : fallback;
        } catch (e) { return fallback; }
    }
    function writeJSON(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full/blocked: decision just won't persist */ }
    }

    function currentScope() {
        try {
            if (typeof cellActiveWindow !== 'undefined' && cellActiveWindow && cellActiveWindow.profile) return cellActiveWindow.id;
        } catch (e) { /* fall through */ }
        return 'main';
    }
    function activeWinId() {
        try { if (typeof cellActiveWinId !== 'undefined' && cellActiveWinId) return cellActiveWinId; } catch (e) { /* fall through */ }
        return localStorage.getItem('codemini_active_window') || 'win_default';
    }

    const allRecords = (scope) => readJSON(RECORDS_PREFIX + (scope || currentScope()), {});
    function getRecord(dbName, scope) {
        const r = allRecords(scope)[dbName];
        return r && typeof r.trusted === 'boolean' ? r : null;
    }
    function putRecord(dbName, record, scope) {
        const all = allRecords(scope);
        all[dbName] = record;
        writeJSON(RECORDS_PREFIX + (scope || currentScope()), all);
    }
    function deleteRecord(dbName, scope) {
        const all = allRecords(scope);
        delete all[dbName];
        writeJSON(RECORDS_PREFIX + (scope || currentScope()), all);
    }
    const dismissals = (scope) => readJSON(DISMISS_PREFIX + (scope || currentScope()), {});
    const isDismissed = (dbName) => !!dismissals()[dbName];
    function setDismissed(dbName, value) {
        const all = dismissals();
        if (value) all[dbName] = true; else delete all[dbName];
        writeJSON(DISMISS_PREFIX + currentScope(), all);
    }

    // ------------------------------------------------------------------
    // 3. Where am I / what are the settings
    // ------------------------------------------------------------------
    const ctx = {
        db: null,              // last database name an initDatabase() completed for
        pendingTrust: {},      // dbName -> in-flight requestTrust() promise (one dialog per workspace)
        lastBlockedAt: {},     // "dbName|feature" -> timestamp, for toast cooldown
        managerEl: null
    };

    function currentDbName() {
        try { if (typeof db !== 'undefined' && db && db.name) return db.name; } catch (e) { /* fall through */ }
        if (ctx.db) return ctx.db;
        try { if (typeof cellActiveWindow !== 'undefined' && cellActiveWindow && cellActiveWindow.db) return cellActiveWindow.db; } catch (e) { /* fall through */ }
        return 'CodeMiniDB';
    }

    // A window's own database is its empty window; anything else is a workspace.
    function isRootDb(dbName) {
        try {
            if (typeof cellWindows !== 'undefined' && cellWindows.some(w => w.db === dbName)) return true;
        } catch (e) { /* fall through */ }
        return dbName === 'CodeMiniDB' || String(dbName).startsWith('CodeMiniDB_profile_');
    }

    function settings() {
        if (typeof window.getWorkspaceTrustSettings === 'function') return window.getWorkspaceTrustSettings();
        console.warn('WorkspaceTrust: getWorkspaceTrustSettings() is missing - treating every workspace as trusted.');
        return { enabled: false, untrustedFiles: 'open', emptyWindow: true, startupPrompt: 'never', banner: 'never' };
    }

    function stateFor(dbName) {
        const name = dbName || currentDbName();
        const s = settings();
        const record = getRecord(name);
        const isRoot = isRootDb(name);
        const r = resolveTrust({ enabled: s.enabled, emptyWindow: s.emptyWindow, isRoot, record });
        return { dbName: name, isRoot, record, enabled: s.enabled, trusted: r.trusted, reason: r.reason };
    }
    const isTrusted = (dbName) => stateFor(dbName).trusted;

    function labelFor(dbName) {
        try {
            if (isRootDb(dbName)) {
                const w = (typeof cellWindows !== 'undefined' ? cellWindows : []).find(x => x.db === dbName);
                return w ? `${w.name} (no workspace open)` : 'This window (no workspace open)';
            }
            const ws = (window.workspacesList || []).find(x => (x.db || ('CodeMiniDB_WS_' + x.id)) === dbName);
            if (ws && ws.name) return ws.name;
            if (typeof folderStack !== 'undefined' && folderStack[0] && folderStack[0].isWorkspaceRoot
                && ('CodeMiniDB_WS_' + folderStack[0].id) === dbName) return folderStack[0].name;
        } catch (e) { /* fall through */ }
        const rec = getRecord(dbName);
        return (rec && rec.label) || dbName;
    }

    // ------------------------------------------------------------------
    // 4. Mutations
    // ------------------------------------------------------------------
    function emitChange(detail) {
        try { window.dispatchEvent(new CustomEvent('workspacetrustchange', { detail })); } catch (e) { /* non-critical */ }
    }

    function afterChange(dbName) {
        refreshChrome();
        if (!dbName || dbName === currentDbName()) enforce();
        emitChange({ dbName });
        renderManager();
    }

    function setTrust(dbName, trusted, opts = {}) {
        const name = dbName || currentDbName();
        putRecord(name, { trusted: !!trusted, label: opts.label || labelFor(name), at: Date.now() }, opts.scope);
        // A decision resets "dismissed": if trust is later revoked the banner should come back.
        if (!opts.scope) setDismissed(name, false);
        afterChange(name);
    }

    function forget(dbName) {
        deleteRecord(dbName);
        setDismissed(dbName, false);
        afterChange(dbName);
    }

    // A workspace the person just created is theirs - asking them if they trust themselves would be absurd.
    // (Imported / copied workspaces are NOT passed through here, so they still prompt.)
    function trustCreatedWorkspace(dbName, label) {
        putRecord(dbName, { trusted: true, label: label || dbName, at: Date.now() });
    }

    // ------------------------------------------------------------------
    // 5. Enforcement
    // ------------------------------------------------------------------
    // Called whenever the current location becomes (or might have become) restricted. Anything still running
    // from before - today that's an open Live Preview - is torn down. (Future code that spins up long-lived
    // execution should listen for 'workspacetrustchange' instead of being special-cased here.)
    function enforce() {
        if (stateFor().trusted) return;
        const container = document.getElementById('livePreviewContainer');
        if (container && container.classList.contains('show') && typeof window.forceClosePreview === 'function') {
            try { window.forceClosePreview(activeWinId()); } catch (e) { console.error('WorkspaceTrust: could not close Live Preview.', e); }
        }
    }

    // Returns true if the feature may run. Otherwise tells the person why (once per cooldown, so "Run All" on a
    // 50-cell notebook or an auto-reloading preview produces one notice, not fifty) and returns false.
    function guard(feature, opts = {}) {
        const st = stateFor(opts.dbName);
        if (st.trusted) return true;
        notifyBlocked(feature, st.dbName, opts.cooldownMs);
        return false;
    }

    function notifyBlocked(feature, dbName, cooldownMs) {
        const key = dbName + '|' + feature;
        const now = Date.now();
        if (now - (ctx.lastBlockedAt[key] || 0) < (cooldownMs || 2500)) return;
        ctx.lastBlockedAt[key] = now;
        showToast(`${feature} is disabled in Restricted Mode.`, {
            actionLabel: 'Manage',
            onAction: () => requestTrust({ dbName, source: 'action' })
        });
    }

    // Shown inside the Live Preview iframe in place of the page. Static - no script - so nothing here can run.
    function restrictedPreviewHtml() {
        return '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">'
            + '<style>body{font:14px/1.6 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;'
            + 'height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center;color:CanvasText;background:Canvas}'
            + 'div{max-width:360px}h2{font-size:16px;margin:0 0 8px}p{margin:0;opacity:.75}</style>'
            + '<div><h2>Live Preview is off in Restricted Mode</h2>'
            + '<p>This workspace isn\'t trusted, so its pages aren\'t run. Trust it from the banner or '
            + 'Settings &rsaquo; Security, then press Run again.</p></div>';
    }

    // ------------------------------------------------------------------
    // 6. Trust requests and the startup flow
    // ------------------------------------------------------------------
    function requestTrust({ dbName, source = 'action' } = {}) {
        const name = dbName || currentDbName();
        if (stateFor(name).trusted) return Promise.resolve('trusted');
        if (ctx.pendingTrust[name]) return ctx.pendingTrust[name];

        const title = document.createElement('span');
        title.textContent = `Do you trust the authors of \u201c${labelFor(name)}\u201d?`;

        const body = [
            para('Code in a workspace can run with full access to your CodeMini files and this site\u2019s browser storage. '
                + 'Only trust workspaces whose authors you know.'),
            para('Restricted Mode keeps a workspace safe to browse by turning off:', true),
            list(['Running notebook cells', 'Live Preview', 'Running files from the terminal, editor and debugger'])
        ];

        const p = choose({
            icon: 'ri-shield-keyhole-line',
            title,
            body,
            buttons: [
                { id: 'distrust', label: 'No, I don\u2019t trust the authors' },
                { id: 'trust', label: 'Yes, I trust the authors', primary: true }
            ]
        }).then((choice) => {
            delete ctx.pendingTrust[name];
            if (choice === 'trust') { setTrust(name, true); return 'trusted'; }
            if (choice === 'distrust') {
                if (shouldPersistDenial(source, settings().startupPrompt)) setTrust(name, false);
                return 'restricted';
            }
            return 'dismissed'; // closed without choosing: nothing is saved, so it will be asked again
        });
        ctx.pendingTrust[name] = p;
        return p;
    }

    // Runs after every successful initDatabase() (see the wrapper at the bottom).
    function onDbOpened(dbName) {
        const previous = ctx.db;
        ctx.db = dbName;
        refreshChrome();
        enforce();

        const st = stateFor(dbName);
        const go = shouldPromptOnOpen({
            enabled: st.enabled, isRoot: st.isRoot, trusted: st.trusted, hasRecord: !!st.record,
            startupPrompt: settings().startupPrompt, isSameLocation: previous === dbName
        });
        // Deferred a tick: the caller's own success callback (which sets folderStack and loads the file list,
        // and so lets labelFor() find the workspace's name) runs right after this returns.
        if (go) setTimeout(() => {
            if (ctx.db === dbName) requestTrust({ dbName, source: 'startup' });
        }, 0);
    }

    function onSettingsChanged() {
        refreshChrome();
        enforce();
        emitChange({ setting: true });
        renderManager();
    }

    // ------------------------------------------------------------------
    // 7. Files arriving from outside CodeMini
    // ------------------------------------------------------------------
    const windowLimitReached = () => {
        try { return typeof cellWindows !== 'undefined' && cellWindows.length >= MAX_WINDOWS; } catch (e) { return false; }
    };

    // Creates an isolated window whose root is explicitly RESTRICTED, ready to receive files. It does not
    // switch to it yet: the caller writes into `db` first, then calls finish().
    async function openInNewWindow() {
        if (typeof cellWindows === 'undefined' || typeof switchWindow !== 'function' || windowLimitReached()) return null;
        const stamp = Date.now();
        const newId = 'win_' + stamp;
        const dbName = 'CodeMiniDB_profile_' + stamp;
        const newDb = await new Promise((resolve) => {
            try {
                const req = indexedDB.open(dbName, window.CODEMINI_DB_VERSION || 4);
                req.onupgradeneeded = (e) => { if (window.ensureCodeMiniSchema) window.ensureCodeMiniSchema(e.target.result); };
                req.onsuccess = (e) => resolve(e.target.result);
                req.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        });
        if (!newDb) return null;

        const number = cellWindows.filter(w => w.profile).length + 1;
        cellWindows.push({ id: newId, name: `Window-${number} (Untrusted)`, db: dbName, profile: true });
        localStorage.setItem('codemini_windows', JSON.stringify(cellWindows));
        if (typeof window.recordMemberSince === 'function') window.recordMemberSince(newId);
        // Explicit, not left to the Workspace Trust Window default: the whole point of this window is that it
        // starts restricted, even when empty windows are otherwise trusted.
        putRecord(dbName, { trusted: false, label: 'Untrusted files', at: Date.now() }, newId);

        return {
            db: newDb,
            parentId: 'root',
            finish() {
                try { newDb.close(); } catch (e) { /* already closed */ }
                switchWindow(newId, true);
            }
        };
    }

    // Called by every import path (up-down.js drop + file picker, script.js GitHub import) BEFORE it writes.
    // Resolves to:
    //   null       - write to the current location as usual
    //   'cancel'   - the person backed out; write nothing
    //   {db, parentId, finish} - write into this database instead, then call finish() to switch to it
    async function routeIncoming({ dbName } = {}) {
        const s = settings();
        const st = stateFor(dbName);
        const plan = planIncomingFiles({
            enabled: s.enabled, destTrusted: st.trusted, destReason: st.reason,
            untrustedFiles: s.untrustedFiles, windowLimitReached: windowLimitReached()
        });
        if (plan === 'here') return null;
        if (plan === 'newWindow') return newWindowOrExplain();

        const canNewWindow = !windowLimitReached();
        const buttons = [{ id: 'cancel', label: 'Cancel' }, { id: 'here', label: 'Add to This Workspace' }];
        if (canNewWindow) buttons.push({ id: 'newWindow', label: 'Add in a New Restricted Window', primary: true });
        const choice = await choose({
            icon: 'ri-file-warning-line',
            title: 'Add files from outside CodeMini?',
            body: [
                para('This workspace is trusted. Files that came from somewhere else may contain code that would run '
                    + 'with the same access as everything else in it once you open or run them.'),
                para(canNewWindow
                    ? 'A new restricted window keeps them separate until you decide to trust them.'
                    : 'You already have the maximum number of windows open, so they can only be added here.')
            ],
            buttons
        });
        if (choice === 'here') return null;
        if (choice === 'newWindow') return newWindowOrExplain();
        return 'cancel';
    }

    async function newWindowOrExplain() {
        const target = await openInNewWindow();
        if (target) return target;
        showToast('Couldn\u2019t open a new window for these files, so nothing was added.');
        return 'cancel';
    }

    // ------------------------------------------------------------------
    // 8. UI - small DOM helpers
    // ------------------------------------------------------------------
    function el(tag, props, children) {
        const node = document.createElement(tag);
        if (props) Object.keys(props).forEach(k => {
            if (k === 'className') node.className = props[k];
            else if (k === 'text') node.textContent = props[k];
            else node.setAttribute(k, props[k]);
        });
        (children || []).forEach(c => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
        return node;
    }
    function para(text, tight) { return el('p', { className: tight ? 'wt-p wt-p-tight' : 'wt-p', text }); }
    function list(items) { return el('ul', { className: 'wt-ul' }, items.map(t => el('li', { text: t }))); }

    function injectStyles() {
        if (document.getElementById('workspace-trust-styles')) return;
        const style = el('style', { id: 'workspace-trust-styles' });
        style.textContent = `
        .wt-banner { display:none; align-items:center; gap:10px; flex-shrink:0; padding:7px 14px; font-size:12.5px;
            background:var(--bg-panel); color:var(--text-main); border-bottom:1px solid var(--border-color);
            border-left:3px solid var(--icon-yellow, #e6a700); }
        .wt-banner.show { display:flex; }
        .wt-banner > i:first-child { color:var(--icon-yellow, #e6a700); font-size:16px; flex-shrink:0; }
        .wt-banner-text { flex:1; min-width:0; }
        .wt-banner-btn { flex-shrink:0; cursor:pointer; font:inherit; padding:3px 10px; border-radius:3px;
            border:1px solid var(--border-color); background:var(--bg-white); color:var(--text-main); }
        .wt-banner-btn:hover { border-color:var(--accent-blue); color:var(--accent-blue); }
        .wt-banner-close { flex-shrink:0; cursor:pointer; font-size:16px; color:var(--text-muted); }
        .wt-banner-close:hover { color:var(--text-main); }
        .wt-status { display:none; cursor:pointer; }
        .wt-status.show { display:flex; }
        .wt-status i { color:var(--icon-yellow, #e6a700); }

        .wt-backdrop { position:fixed; inset:0; z-index:10010; display:flex; align-items:center; justify-content:center;
            padding:16px; background:rgba(0,0,0,.5); }
        .wt-dialog { position:relative; width:100%; max-width:460px; box-sizing:border-box; padding:20px;
            background:var(--bg-white); color:var(--text-main); border:1px solid var(--border-color); border-radius:4px;
            box-shadow:0 10px 30px rgba(0,0,0,.25); font-size:13px; line-height:1.55; max-height:90vh; overflow:auto; }
        .wt-head { display:flex; align-items:flex-start; gap:10px; margin:0 24px 10px 0; }
        .wt-head > i { font-size:22px; color:var(--accent-blue); flex-shrink:0; }
        .wt-head h3 { margin:0; font-size:15px; font-weight:600; word-break:break-word; }
        .wt-x { position:absolute; top:10px; right:10px; cursor:pointer; font-size:18px; color:var(--text-muted); }
        .wt-x:hover { color:var(--text-main); }
        .wt-p { margin:0 0 10px; color:var(--text-muted); }
        .wt-p-tight { margin-bottom:4px; color:var(--text-main); }
        .wt-ul { margin:0 0 4px; padding-left:20px; color:var(--text-main); }
        .wt-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; margin-top:16px; }
        .wt-btn { cursor:pointer; font:inherit; padding:7px 14px; border-radius:3px; border:1px solid var(--border-color);
            background:transparent; color:var(--text-main); }
        .wt-btn:hover { border-color:var(--accent-blue); }
        .wt-btn.primary { background:var(--accent-blue); border-color:var(--accent-blue); color:var(--text-on-accent, #fff); }
        .wt-btn:focus-visible { outline:2px solid var(--accent-blue); outline-offset:2px; }

        .wt-manager-label { margin:18px 0 6px; font-size:11px; font-weight:600; letter-spacing:.04em;
            text-transform:uppercase; color:var(--text-muted); }
        .wt-manager-btn { cursor:pointer; font:inherit; font-size:12px; padding:5px 12px; border-radius:3px;
            border:1px solid var(--border-color); background:var(--bg-panel); color:var(--text-main); }
        .wt-manager-btn:hover { border-color:var(--accent-blue); }
        .wt-manager-btn:disabled { opacity:.5; cursor:not-allowed; }
        .wt-manager-controls { display:flex; gap:6px; }
        .wt-badge { display:inline-block; padding:0 6px; margin-right:4px; border-radius:8px; font-size:11px; font-weight:600; }
        .wt-badge.ok { background:rgba(76,175,80,.18); color:var(--color-success, #4caf50); }
        .wt-badge.no { background:rgba(230,167,0,.2); color:var(--icon-yellow, #b58300); }
        `;
        document.head.appendChild(style);
    }

    // ------------------------------------------------------------------
    // 9. UI - toast
    // ------------------------------------------------------------------
    function showToast(message, { actionLabel, onAction } = {}) {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = el('div', { id: 'toast-container', className: 'toast-container' });
            document.body.appendChild(container);
        }
        const toast = el('div', { className: 'custom-toast' });
        const content = el('div', { className: 'custom-toast-content' }, [
            el('i', { className: 'ri-shield-flash-line', style: 'color:var(--icon-yellow,#e6a700)' }),
            el('span', { text: message })
        ]);
        toast.appendChild(content);

        const remove = () => {
            if (!toast.parentNode) return;
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300); // same fallback the app's own toasts use (animations can be disabled)
        };
        if (actionLabel && onAction) {
            const btn = el('button', { className: 'wt-banner-btn', text: actionLabel, type: 'button' });
            btn.addEventListener('click', () => { remove(); onAction(); });
            toast.appendChild(btn);
        }
        const close = el('i', { className: 'ri-close-line custom-toast-close' });
        close.addEventListener('click', remove);
        toast.appendChild(close);
        container.appendChild(toast);
        setTimeout(remove, 6000);
    }

    // ------------------------------------------------------------------
    // 10. UI - dialog (queued, so two requests can never stack on top of each other)
    // ------------------------------------------------------------------
    let dialogChain = Promise.resolve();

    function choose({ icon, title, body, buttons }) {
        const run = () => new Promise((resolve) => {
            injectStyles();
            const previouslyFocused = document.activeElement;
            let settled = false;

            const backdrop = el('div', { className: 'wt-backdrop' });
            const dialog = el('div', { className: 'wt-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wtDialogTitle' });
            const heading = el('h3', { id: 'wtDialogTitle' });
            heading.appendChild(typeof title === 'string' ? document.createTextNode(title) : title);
            const closeX = el('i', { className: 'ri-close-line wt-x', role: 'button', 'aria-label': 'Close', tabindex: '0' });
            dialog.appendChild(closeX);
            dialog.appendChild(el('div', { className: 'wt-head' }, [el('i', { className: icon || 'ri-shield-keyhole-line' }), heading]));
            body.forEach(n => dialog.appendChild(n));

            const actions = el('div', { className: 'wt-actions' });
            const btnEls = buttons.map(b => {
                const btn = el('button', { type: 'button', className: 'wt-btn' + (b.primary ? ' primary' : ''), text: b.label });
                btn.addEventListener('click', () => finish(b.id));
                actions.appendChild(btn);
                return btn;
            });
            dialog.appendChild(actions);
            backdrop.appendChild(dialog);

            function finish(value) {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKey, true);
                backdrop.remove();
                try { if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus(); } catch (e) { /* element gone */ }
                resolve(value);
            }
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); return; }
                if (e.key !== 'Tab') return;
                const focusable = [closeX, ...btnEls];
                const idx = focusable.indexOf(document.activeElement);
                const next = e.shiftKey ? (idx <= 0 ? focusable.length - 1 : idx - 1) : (idx === focusable.length - 1 ? 0 : idx + 1);
                e.preventDefault();
                focusable[next].focus();
            }

            closeX.addEventListener('click', () => finish(null));
            closeX.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') finish(null); });
            backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) finish(null); });
            document.addEventListener('keydown', onKey, true);
            document.body.appendChild(backdrop);
            const primary = btnEls[buttons.findIndex(b => b.primary)] || btnEls[btnEls.length - 1];
            if (primary) primary.focus();
        });

        const result = dialogChain.then(run);
        dialogChain = result.catch(() => {});
        return result;
    }

    // ------------------------------------------------------------------
    // 11. UI - banner + status-bar item
    // ------------------------------------------------------------------
    let bannerEl = null;
    let statusEl = null;

    function ensureChrome() {
        injectStyles();
        if (!bannerEl || !bannerEl.isConnected) {
            bannerEl = el('div', { id: 'workspaceTrustBanner', className: 'wt-banner', role: 'status' }, [
                el('i', { className: 'ri-shield-flash-line' }),
                el('span', { className: 'wt-banner-text', text: 'Restricted Mode is intended for safe code browsing. Trust this workspace to enable all features.' })
            ]);
            const manage = el('button', { type: 'button', className: 'wt-banner-btn', text: 'Manage' });
            manage.addEventListener('click', () => requestTrust({ source: 'banner' }));
            bannerEl.appendChild(manage);
            const close = el('i', { className: 'ri-close-line wt-banner-close', title: 'Dismiss', role: 'button', 'aria-label': 'Dismiss' });
            close.addEventListener('click', () => { setDismissed(currentDbName(), true); refreshChrome(); });
            bannerEl.appendChild(close);
            const area = document.querySelector('.content-area');
            if (area) area.insertBefore(bannerEl, area.firstChild);
            else document.body.insertBefore(bannerEl, document.body.firstChild);
        }
        if (!statusEl || !statusEl.isConnected) {
            const left = document.querySelector('.status-bar .status-left');
            if (left) {
                statusEl = el('div', { id: 'statusWorkspaceTrust', className: 'status-item wt-status', title: 'Restricted Mode - click to manage workspace trust' }, [
                    el('i', { className: 'ri-shield-flash-line' }),
                    el('span', { className: 'hide-on-mobile', text: 'Restricted Mode' })
                ]);
                statusEl.addEventListener('click', () => requestTrust({ source: 'banner' }));
                left.insertBefore(statusEl, left.firstChild);
            }
        }
    }

    function refreshChrome() {
        if (!document.body) return;
        ensureChrome();
        const st = stateFor();
        const s = settings();
        const restricted = st.enabled && !st.trusted;
        if (statusEl) statusEl.classList.toggle('show', restricted);
        if (bannerEl) {
            bannerEl.classList.toggle('show', bannerVisible({
                enabled: st.enabled, trusted: st.trusted, banner: s.banner, dismissed: isDismissed(st.dbName)
            }));
            // 'Always' means always: only the "until dismissed" mode gets a dismiss control.
            const close = bannerEl.querySelector('.wt-banner-close');
            if (close) close.style.display = s.banner === 'untilDismissed' ? '' : 'none';
        }
    }

    // ------------------------------------------------------------------
    // 12. UI - manager inside Settings > Security
    // ------------------------------------------------------------------
    function describe(st) {
        if (!st.enabled) return 'Workspace Trust is turned off, so every workspace is treated as trusted.';
        if (st.reason === 'empty-window') return 'Trusted because empty windows are trusted by default (Workspace Trust Window).';
        if (st.trusted) return 'Trusted. Every feature is enabled.';
        if (st.reason === 'denied') return 'Restricted Mode. You chose not to trust this workspace.';
        return 'Restricted Mode. No decision saved yet.';
    }

    function managerRow(title, description, controls) {
        return el('div', { className: 'settings-item' }, [
            el('div', { className: 'settings-item-info' }, [el('strong', { text: title }), el('span', { text: description })]),
            el('div', { className: 'settings-control wt-manager-controls' }, controls)
        ]);
    }

    function renderManager() {
        const host = document.getElementById('trustManager');
        if (!host) return;
        ctx.managerEl = host;
        host.textContent = '';

        const st = stateFor();
        const toggleBtn = el('button', {
            type: 'button', className: 'wt-manager-btn',
            text: st.trusted ? 'Restrict Workspace' : 'Trust Workspace'
        });
        toggleBtn.disabled = !st.enabled || st.reason === 'empty-window';
        if (st.reason === 'empty-window') toggleBtn.title = 'Controlled by the Workspace Trust Window setting above.';
        toggleBtn.addEventListener('click', () => setTrust(st.dbName, !st.trusted));
        host.appendChild(managerRow(`Current location: ${labelFor(st.dbName)}`, describe(st), [toggleBtn]));

        const saved = Object.entries(allRecords())
            .map(([dbName, rec]) => ({ dbName, rec }))
            .filter(x => x.rec && typeof x.rec.trusted === 'boolean' && x.dbName !== st.dbName)
            .sort((a, b) => (b.rec.at || 0) - (a.rec.at || 0));

        host.appendChild(el('div', { className: 'wt-manager-label', text: 'Other saved decisions' }));
        if (!saved.length) {
            host.appendChild(el('div', { className: 'settings-item' }, [
                el('div', { className: 'settings-item-info' }, [el('span', { text: 'None yet. Decisions you make when opening a workspace are listed here.' })])
            ]));
        }
        saved.forEach(({ dbName, rec }) => {
            const when = rec.at ? new Date(rec.at).toLocaleDateString() : '';
            const badge = el('span', { className: 'wt-badge ' + (rec.trusted ? 'ok' : 'no'), text: rec.trusted ? 'Trusted' : 'Restricted' });
            const flip = el('button', { type: 'button', className: 'wt-manager-btn', text: rec.trusted ? 'Restrict' : 'Trust' });
            flip.addEventListener('click', () => setTrust(dbName, !rec.trusted, { label: rec.label }));
            const remove = el('button', { type: 'button', className: 'wt-manager-btn', text: 'Forget', title: 'Remove the saved decision - you will be asked again next time.' });
            remove.addEventListener('click', () => forget(dbName));
            const row = managerRow(labelFor(dbName), '', [flip, remove]);
            const info = row.querySelector('.settings-item-info span');
            info.appendChild(badge);
            info.appendChild(document.createTextNode(when ? `Decided ${when}` : ''));
            host.appendChild(row);
        });

        pruneMissing(saved);
    }

    // A deleted workspace leaves its record behind. Drop records whose database no longer exists, so the list
    // doesn't fill with ghosts. (Skipped where indexedDB.databases() isn't available - they just stay listed.)
    let pruning = false;
    async function pruneMissing(saved) {
        if (pruning || typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function' || !saved.length) return;
        pruning = true;
        try {
            const existing = new Set((await indexedDB.databases()).map(d => d.name));
            // Records younger than a minute are skipped: a workspace's DB is created asynchronously, and its
            // record is written right alongside, so listing databases too early would wrongly call it missing.
            const gone = saved.filter(x => !isRootDb(x.dbName) && !existing.has(x.dbName) && Date.now() - (x.rec.at || 0) > 60000);
            gone.forEach(x => { deleteRecord(x.dbName); setDismissed(x.dbName, false); });
            if (gone.length) { pruning = false; renderManager(); }
        } catch (e) { /* listing unsupported or blocked - leave records as they are */ }
        pruning = false;
    }

    // ------------------------------------------------------------------
    // 13. Wire-up
    // ------------------------------------------------------------------
    // Every path into a workspace (workspace switcher, top search, Explorer double-click, terminal `cd`, window
    // switch, startup) funnels through initDatabase(), so wrapping it is one hook instead of five patches.
    // Reassigning window.initDatabase also rebinds the bare `initDatabase(...)` calls in other scripts, because a
    // top-level function declaration IS a property of the global object.
    if (typeof window.initDatabase === 'function') {
        const originalInitDatabase = window.initDatabase;
        window.initDatabase = function (dbName, onSuccess) {
            return originalInitDatabase.call(this, dbName, function () {
                try { onDbOpened(dbName); } catch (e) { console.error('WorkspaceTrust: onDbOpened failed.', e); }
                if (typeof onSuccess === 'function') return onSuccess.apply(this, arguments);
            });
        };
    } else {
        console.error('WorkspaceTrust: initDatabase() not found - load workspace-trust.js after app.js. Trust will not follow workspace changes.');
    }

    window.addEventListener('workspacetrustchange', refreshChrome);
    const setup = () => { refreshChrome(); renderManager(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
    else setup();

    window.WorkspaceTrust = {
        isEnabled: () => settings().enabled,
        isTrusted,
        getState: stateFor,
        guard,
        notifyBlocked,
        requestTrust,
        setTrust,
        forget,
        trustCreatedWorkspace,
        routeIncoming,
        restrictedPreviewHtml,
        onSettingsChanged,
        renderManager,
        refresh: refreshChrome,
        // exposed for tests only
        _policy: { resolveTrust, shouldPromptOnOpen, shouldPersistDenial, bannerVisible, planIncomingFiles }
    };
})();
