// ==========================================
// pwa.js - service worker registration, "updated" notice and install prompt.
// ==========================================
// Loaded from <head> (before the app scripts) so the beforeinstallprompt listener exists before the
// browser can fire the event. Everything here is progressive enhancement: if any API is missing the
// app simply behaves like a normal web page.
(function () {
    'use strict';

    const UPDATE_CHECK_MS = 60 * 60 * 1000; // installed PWAs can stay open for days; re-check sw.js hourly
    const hadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    const STATE_EVENT = 'codemini:update-state';
    const CHECK_TIMEOUT_MS = 20000; // how long a manual check waits for a found update to finish installing
    let deferredPrompt = null;
    let registration = null;

    // One shared record of where updating stands, so the toast, Settings > Updates and the Now Island
    // notification can never disagree.
    //   status: 'idle'     - nothing pending (up to date, or not checked yet)
    //           'checking' - a manual check is running
    //           'updated'  - a new version installed and took over; this page still runs the old code until Reload
    const updateState = { status: 'idle', lastChecked: null, lastCheckFailed: false };

    function getUpdateState() { return Object.assign({}, updateState); }

    function setUpdateState(patch) {
        Object.assign(updateState, patch);
        try { window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: getUpdateState() })); } catch (e) { /* no CustomEvent: nothing is listening anyway */ }
    }

    function reloadApp() { window.location.reload(); }

    // Scheduled checks (hourly, and when the app is shown again) honour Settings > Updates > Auto Check Updates.
    // appSettings may not exist yet very early on; the default is on.
    function autoCheckEnabled() {
        return !(window.appSettings && window.appSettings.autoCheckUpdates === false);
    }

    function isStandalone() {
        try {
            return window.matchMedia('(display-mode: standalone)').matches ||
                window.matchMedia('(display-mode: window-controls-overlay)').matches ||
                window.navigator.standalone === true; // iOS Safari
        } catch (e) { return false; }
    }

    // ------------------------------------------------------------------
    // Toast (reuses the app's existing .toast-container / .custom-toast styles)
    // ------------------------------------------------------------------
    function showToast(message, { actionLabel, onAction, icon, duration } = {}) {
        const mount = () => {
            let container = document.getElementById('toast-container');
            if (!container) {
                container = document.createElement('div');
                container.id = 'toast-container';
                container.className = 'toast-container';
                document.body.appendChild(container);
            }
            const toast = document.createElement('div');
            toast.className = 'custom-toast';
            toast.setAttribute('role', 'status');

            const content = document.createElement('div');
            content.className = 'custom-toast-content';
            const i = document.createElement('i');
            i.className = icon || 'ri-checkbox-circle-line';
            const span = document.createElement('span');
            span.textContent = message;
            content.append(i, span);
            toast.appendChild(content);

            let removed = false;
            const remove = () => {
                if (removed) return;
                removed = true;
                toast.classList.add('fade-out');
                setTimeout(() => toast.remove(), 300); // same fallback the app's own toasts use
            };

            if (actionLabel && typeof onAction === 'function') {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = actionLabel;
                btn.style.cssText = 'cursor:pointer;border:1px solid var(--border-color,#ccc);border-radius:3px;' +
                    'background:var(--bg-panel,#f3f3f3);color:var(--text-main,#333);font:inherit;font-size:12px;' +
                    'padding:4px 10px;white-space:nowrap;';
                btn.addEventListener('click', () => { remove(); onAction(); });
                toast.appendChild(btn);
            }
            const close = document.createElement('i');
            close.className = 'ri-close-line custom-toast-close';
            close.addEventListener('click', remove);
            toast.appendChild(close);

            container.appendChild(toast);
            setTimeout(remove, duration || 6000);
        };
        if (document.body) mount();
        else document.addEventListener('DOMContentLoaded', mount, { once: true });
    }

    // ------------------------------------------------------------------
    // Service worker
    // ------------------------------------------------------------------
    function scheduledCheck() {
        if (!registration || !autoCheckEnabled() || updateState.status !== 'idle') return;
        registration.update().then(
            () => setUpdateState({ lastChecked: Date.now(), lastCheckFailed: false }),
            () => { /* offline - nothing to do, and nothing worth telling the user about */ }
        );
    }

    // Manual check (Settings > Updates > Check for updates). Always runs, whatever Auto Check Updates says.
    // Resolves with 'updated' | 'up-to-date' | 'failed' | 'unsupported'.
    function checkForUpdates() {
        if (updateState.status === 'updated') return Promise.resolve('updated');
        if (updateState.status === 'checking') return waitForCheck();
        if (!registration) return Promise.resolve('unsupported');
        setUpdateState({ status: 'checking' });
        return registration.update().then(() => {
            // update() resolves once sw.js has been fetched, not once a new version has installed. If one was
            // found, it is installing now and will announce itself through controllerchange.
            if (registration.installing || registration.waiting) return waitForCheck();
            setUpdateState({ status: 'idle', lastChecked: Date.now(), lastCheckFailed: false });
            return 'up-to-date';
        }).catch(() => {
            setUpdateState({ status: 'idle', lastCheckFailed: true });
            return 'failed';
        });
    }

    function waitForCheck() {
        return new Promise((resolve) => {
            let timer = null;
            const done = (e) => {
                const st = e.detail.status;
                if (st === 'checking') return;
                window.removeEventListener(STATE_EVENT, done);
                clearTimeout(timer);
                resolve(st === 'updated' ? 'updated' : (e.detail.lastCheckFailed ? 'failed' : 'up-to-date'));
            };
            window.addEventListener(STATE_EVENT, done);
            timer = setTimeout(() => {
                window.removeEventListener(STATE_EVENT, done);
                setUpdateState({ status: 'idle', lastChecked: Date.now(), lastCheckFailed: false });
                resolve('up-to-date');
            }, CHECK_TIMEOUT_MS);
        });
    }

    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;

        // The worker calls skipWaiting() + clients.claim(), so a new version takes over this page as soon as it
        // installs. Don't reload under the user (unsaved editor changes!) - just tell them. `hadController`
        // skips the very first install, where claim() also fires controllerchange but nothing was "updated".
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController || updateState.status === 'updated') return;
            // Listeners (Settings > Updates, the Now Island notification) hear about it through this state change.
            setUpdateState({ status: 'updated', lastChecked: Date.now(), lastCheckFailed: false });
            showToast('CodeMini IDE was updated. Reload to use the latest version.', {
                icon: 'ri-refresh-line',
                actionLabel: 'Reload',
                onAction: reloadApp,
                duration: 20000
            });
        });

        window.addEventListener('load', () => {
            // updateViaCache:'none' makes the browser bypass its HTTP cache for sw.js itself.
            navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => {
                registration = reg;
                setInterval(scheduledCheck, UPDATE_CHECK_MS);
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') scheduledCheck();
                });
            }).catch((err) => {
                console.error('SW Registration failed:', err);
            });
        });
    }

    // ------------------------------------------------------------------
    // Install prompt (Chromium: beforeinstallprompt). Safari/Firefox never fire it, so no menu item appears
    // there - users on those use the browser's own "Add to Home Screen" / "Install" option.
    // ------------------------------------------------------------------
    function removeInstallMenuItem() {
        document.getElementById('menuInstallApp')?.remove();
        document.getElementById('menuInstallAppDivider')?.remove();
    }

    function addInstallMenuItem() {
        if (document.getElementById('menuInstallApp')) return;
        const help = document.getElementById('menuHelp');
        const anchor = help && help.previousElementSibling; // the divider above "Help"
        if (!anchor || !anchor.parentNode) return;

        const divider = document.createElement('div');
        divider.id = 'menuInstallAppDivider';
        divider.style.cssText = 'height: 1px; background: var(--border-color); margin: 4px 0;';

        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.id = 'menuInstallApp';
        const icon = document.createElement('i');
        icon.className = 'ri-install-line';
        item.append(icon, document.createTextNode(' Install App'));
        item.addEventListener('click', () => {
            document.getElementById('moreDropdown')?.classList.remove('show');
            promptInstall();
        });

        anchor.parentNode.insertBefore(divider, anchor);
        anchor.parentNode.insertBefore(item, anchor);
    }

    function promptInstall() {
        if (!deferredPrompt) return Promise.resolve('unavailable');
        const evt = deferredPrompt;
        deferredPrompt = null; // a prompt event can only be used once
        removeInstallMenuItem();
        evt.prompt();
        return evt.userChoice.then((choice) => choice.outcome).catch(() => 'dismissed');
    }

    window.addEventListener('beforeinstallprompt', (e) => {
        if (isStandalone()) return;
        e.preventDefault(); // keep the prompt for our menu item instead of the browser's mini-infobar
        deferredPrompt = e;
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addInstallMenuItem, { once: true });
        else addInstallMenuItem();
    });

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        removeInstallMenuItem();
        showToast('CodeMini IDE was installed.');
    });

    window.CodeMiniPWA = Object.freeze({
        isStandalone,
        canInstall: () => !!deferredPrompt,
        install: promptInstall,
        checkForUpdates,
        getUpdateState,
        reload: reloadApp,
        UPDATE_EVENT: STATE_EVENT
    });

    registerServiceWorker();
})();
