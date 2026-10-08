// ==========================================
// app-alerts.js - app-level notifications that nothing else owns:
//   1. Storage safety: browser storage nearly full, and storage that is not marked persistent.
//   2. Offline readiness: a one-time "CodeMini now works without a connection".
// They are delivered through CodeMiniNotifications (now-island.js), which must load first.
// Git, My Keys, Notebooks and Workspace Trust send their own notifications from their own files.
// ==========================================
(function initAppAlerts() {
    'use strict';

    const SOURCE = 'CodeMini';
    const STATE_KEY = 'codemini_alerts_state'; // when each alert was last raised, so nothing nags
    const DAY = 24 * 60 * 60 * 1000;
    const QUOTA_LEVELS = [95, 90, 80];          // percent of the browser's quota, highest first
    const QUOTA_REPEAT_MS = 7 * DAY;            // same level again only after this long
    const PERSIST_REPEAT_MS = 14 * DAY;
    const RECHECK_MS = 30 * 60 * 1000;
    const FIRST_CHECK_MS = 6000;                // after start-up, so the checks never compete with loading

    const hasStorageApi = !!(navigator.storage && typeof navigator.storage.estimate === 'function');
    let persisted = null;                       // null = not known yet

    function readState() {
        try {
            const s = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
            return s && typeof s === 'object' ? s : {};
        } catch (e) { return {}; }
    }
    function writeState(patch) {
        try { localStorage.setItem(STATE_KEY, JSON.stringify(Object.assign(readState(), patch))); } catch (e) { /* storage blocked */ }
    }
    function notify(n) {
        const api = window.CodeMiniNotifications;
        if (api) api.add(Object.assign({ source: SOURCE }, n));
    }
    function dismiss(id) {
        const api = window.CodeMiniNotifications;
        if (api) api.remove(id);
    }
    function fmtBytes(b) {
        if (!(b > 0)) return '0 MB';
        const mb = b / 1048576;
        return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.max(1, Math.round(mb)) + ' MB';
    }

    // ---- 1a. storage nearly full ---------------------------------------------------------------------------
    async function checkQuota() {
        if (!hasStorageApi) return;
        let est;
        try { est = await navigator.storage.estimate(); } catch (e) { return; }
        if (!est || !(est.quota > 0)) return;

        const pct = Math.floor((est.usage / est.quota) * 100);
        const level = QUOTA_LEVELS.find(l => pct >= l) || 0;
        const st = readState();

        if (!level) { // back under the lowest threshold: the warning no longer applies
            if (st.quotaLevel) { writeState({ quotaLevel: 0 }); dismiss('storage-low'); }
            return;
        }
        // Already told at this level (or a higher one) recently.
        if (level <= (st.quotaLevel || 0) && Date.now() - (st.quotaAt || 0) < QUOTA_REPEAT_MS) return;

        writeState({ quotaLevel: level, quotaAt: Date.now() });
        notify({
            id: 'storage-low',
            kind: 'storage',
            title: 'Browser storage is ' + pct + '% full',
            text: 'Your browser reports that CodeMini is using about ' + fmtBytes(est.usage) + ' of the ' + fmtBytes(est.quota) +
                ' it allows for this site (this includes downloaded engines such as Python). When it runs out, saving files can fail. ' +
                'Delete files you no longer need, or export the ones you want to keep.'
        });
    }

    // ---- 1b. storage the browser is allowed to clear ---------------------------------------------------------
    async function checkPersisted() {
        if (!(navigator.storage && typeof navigator.storage.persisted === 'function')) return;
        try { persisted = await navigator.storage.persisted(); } catch (e) { return; }
        const st = readState();

        if (persisted) { // protected now: whatever we said earlier is out of date
            if (st.persistAt) { writeState({ persistAt: 0 }); dismiss('storage-persist'); }
            return;
        }
        if (typeof navigator.storage.persist !== 'function') return; // nothing the user could do about it
        if (Date.now() - (st.persistAt || 0) < PERSIST_REPEAT_MS) return;

        writeState({ persistAt: Date.now() });
        notify({
            id: 'storage-persist',
            kind: 'storage',
            actions: ['protect-storage'],
            title: 'Your files could be cleared by the browser',
            text: 'Your files live only in this browser. Unless storage is marked as persistent, the browser may delete it when the device runs low on space. ' +
                'Choose Protect my files to ask the browser to keep it. Exporting important work is still the safest backup.'
        });
    }

    // Runs from a button click (a user gesture), because some browsers ask for permission.
    async function protectStorage() {
        try {
            const ok = !!(await navigator.storage.persist());
            persisted = ok;
            if (ok) {
                writeState({ persistAt: 0 });
                dismiss('storage-persist');
                if (window.showSuccessToast) window.showSuccessToast('Your files are now protected from automatic clearing');
            } else {
                // Same id: replaces the earlier notice (and shows it again, so the answer is not missed).
                notify({
                    id: 'storage-persist',
                    kind: 'storage',
                    title: 'The browser did not agree',
                    text: 'Browsers usually say yes once the app is installed (More menu > Install App) or used regularly. ' +
                        'Until then, export anything important so it is safe.'
                });
            }
        } catch (e) {
            notify({ id: 'storage-persist', kind: 'storage', title: 'Could not protect your files', text: 'This browser does not allow it right now. Export anything important so it is safe.' });
        }
    }

    // ---- 2. offline readiness ---------------------------------------------------------------------------------
    // The service worker only becomes active after it has cached the whole app shell (sw.js waits for addAll),
    // so "active + index.html in the cache" means the app will open without a connection. Said once, ever.
    async function checkOfflineReady() {
        if (!('serviceWorker' in navigator) || !('caches' in window)) return;
        if (readState().offlineAt) return;
        try {
            await navigator.serviceWorker.ready; // never resolves where no worker is registered, which is fine
            const name = (await caches.keys()).find(k => k.indexOf('codemini-static-v') === 0);
            if (!name) return;
            const cached = await (await caches.open(name)).match('/index.html');
            if (!cached) return;
            writeState({ offlineAt: Date.now() });
            notify({
                id: 'offline-ready',
                kind: 'offline',
                title: 'Ready to work offline',
                text: 'CodeMini is saved on this device and opens without a connection. Notebook engines (Python, R) and some editor parts ' +
                    'download the first time you use them, so open them once while you are online.'
            });
        } catch (e) { /* no service worker: nothing to announce */ }
    }

    // ---- schedule -----------------------------------------------------------------------------------------------
    function runChecks() {
        checkQuota();
        checkPersisted();
    }
    function start() {
        setTimeout(() => { runChecks(); checkOfflineReady(); }, FIRST_CHECK_MS);
        setInterval(runChecks, RECHECK_MS);
        let lastSeen = Date.now();
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) return;
            if (Date.now() - lastSeen > 10 * 60 * 1000) { lastSeen = Date.now(); runChecks(); }
        });
    }
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });

    window.CodeMiniAlerts = Object.freeze({
        canProtectStorage: () => persisted === false && !!(navigator.storage && typeof navigator.storage.persist === 'function'),
        protectStorage
    });
})();
