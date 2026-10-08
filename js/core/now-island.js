// ==========================================
// now-island.js
// ==========================================

(function initNowIsland() {
    // 1. Inject Styles for Now Island
    const style = document.createElement('style');
    style.innerHTML = `
        #nowIslandPanel {
            position: fixed;
            bottom: 30px; /* Above PC status bar (26px) + margin */
            right: 15px;
            width: 370px;
            height: 290px;
            background-color: var(--bg-white);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            box-shadow: 0 4px 20px var(--shadow-color);
            display: flex;
            flex-direction: column;
            z-index: 9999;
            transform: translateY(15px);
            opacity: 0;
            visibility: hidden;
            transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
        }
        
        #nowIslandPanel.show {
            transform: translateY(0);
            opacity: 1;
            visibility: visible;
        }
        
        .ni-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 15px;
            background-color: var(--bg-white);
            border-radius: 6px 6px 0 0;
        }
        
        .ni-title {
            font-weight: 600;
            font-size: 13px;
            color: var(--text-main);
        }
        
        .ni-controls {
            display: flex;
            align-items: center;
            gap: 15px;
        }
        
        .ni-tabs {
            display: flex;
            gap: 12px;
        }
        
        .ni-tab {
            font-size: 11px;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            cursor: pointer;
            transition: color 0.2s;
        }
        
        
        .ni-tab.active {
            color: var(--accent-blue);
            font-weight: 700;
        }
        
        #nowIslandClose {
            cursor: pointer;
            font-size: 16px;
            color: var(--icon-gray);
            transition: color 0.2s;
        }
        
        #nowIslandClose:hover {
            color: var(--color-danger);
        }
        
        .ni-body {
            flex: 1;
            min-height: 0;
            position: relative;
            background-color: var(--bg-white);
            border-radius: 0 0 6px 6px;
        }

        .ni-pane {
            display: none;
            height: 100%;
            overflow-y: auto;
        }

        .ni-pane.active {
            display: block;
        }

        .ni-badge {
            display: inline-block;
            min-width: 14px;
            padding: 0 4px;
            margin-left: 4px;
            border-radius: 8px;
            background-color: var(--accent-new, #00897b);
            color: var(--text-on-accent, #fff);
            font-size: 10px;
            line-height: 14px;
            text-align: center;
            vertical-align: 1px;
        }

        .ni-badge[hidden] {
            display: none;
        }

        /* Status-bar button: the unread count, as plain text (no background) right after the icon.
           It is a flex item of .status-item, so it is vertically centred with the icon and never
           overlaps it. The number comes from the data-unread attribute set in render(). */
        #nowIsland.has-unread::after {
            content: attr(data-unread);
            color: var(--accent-new, #00897b);
            font-size: 11px;
            font-weight: 700;
            line-height: 1;
            font-variant-numeric: tabular-nums;
        }

        .ni-empty {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 6px;
            height: 100%;
            color: var(--text-muted);
            font-size: 12px;
        }

        .ni-empty i {
            font-size: 26px;
            opacity: 0.6;
        }

        /* ---- Notification item: white background, dashed bottom border ---- */
        .ni-notif-list {
            list-style: none;
            margin: 0;
            padding: 0;
        }

        .ni-notif {
            background-color: var(--bg-white);
            border-bottom: 1px dashed var(--border-color);
            padding: 10px 15px;
            cursor: pointer;
        }

        .ni-notif:focus-visible {
            outline: 1px solid var(--accent-blue);
            outline-offset: -1px;
        }

        .ni-notif-top {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .ni-notif-title {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 13px;
            font-weight: 500;
            color: var(--text-main);
        }

        .ni-notif.unread .ni-notif-title {
            font-weight: 700;
        }

        .ni-notif.unread .ni-notif-title::before {
            content: '';
            display: inline-block;
            width: 7px;
            height: 7px;
            margin-right: 7px;
            border-radius: 50%;
            background-color: var(--accent-new, #00897b);
            vertical-align: 1px;
        }

        .ni-notif-actions {
            display: flex;
            align-items: center;
            gap: 12px;
            flex: none;
        }

        .ni-icon-btn {
            display: inline-flex;
            align-items: center;
            padding: 0;
            border: 0;
            background: none;
            font: inherit;
            font-size: 15px;
            color: var(--icon-gray);
            cursor: pointer;
            transition: color 0.2s;
        }

        .ni-icon-btn:hover,
        .ni-icon-btn:focus-visible {
            color: var(--accent-blue);
        }

        .ni-icon-btn.danger:hover,
        .ni-icon-btn.danger:focus-visible {
            color: var(--color-danger);
        }

        .ni-notif-text {
            margin-top: 4px;
            font-size: 12px;
            line-height: 1.45;
            color: var(--text-muted);
            overflow: hidden;
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 2;
            line-clamp: 2;
        }

        /* ---- Notification viewer: covers the whole island ---- */
        .ni-viewer {
            position: absolute;
            inset: 0;
            z-index: 2;
            display: none;
            flex-direction: column;
            background-color: var(--bg-white);
            /* Follows the panel's corners, so a theme pack that rounds #nowIslandPanel rounds this too. */
            border-radius: inherit;
            overflow: hidden;
        }

        .ni-viewer.show {
            display: flex;
        }

        .ni-viewer-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 10px 15px;
        }

        .ni-viewer-left {
            display: flex;
            align-items: center;
            gap: 10px;
            flex: 1;
            min-width: 0;
        }

        .ni-viewer-back {
            font-size: 18px;
            flex: none;
        }

        .ni-viewer-title {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-main);
        }

        .ni-viewer-content {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding: 12px 15px 15px;
            font-size: 13px;
            line-height: 1.55;
            color: var(--text-main);
        }

        .ni-viewer-time {
            margin-bottom: 8px;
            font-size: 11px;
            color: var(--text-muted);
        }

        .ni-viewer-text {
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .ni-viewer-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 14px;
        }

        .ni-btn {
            cursor: pointer;
            border: 1px solid var(--border-color);
            border-radius: 3px;
            background: var(--bg-panel);
            color: var(--text-main);
            font: inherit;
            font-size: 12px;
            padding: 5px 12px;
        }

        .ni-btn.primary {
            background: var(--accent-blue);
            border-color: var(--accent-blue);
            color: var(--text-on-accent, #fff);
        }

        /* ---- Notification toast: appears where the app's other toasts appear when a notification arrives
           while Now Island is closed. Own names (#notifToastStack, .nt-*) so it never shares rules with
           .toast-container / .custom-toast. --nt-offset lifts it above any visible app toast. ---- */
        #notifToastStack {
            position: fixed;
            bottom: calc(35px + var(--nt-offset, 0px));
            right: 20px;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: none;
        }

        .nt-toast {
            pointer-events: auto;
            cursor: pointer;
            box-sizing: border-box;
            width: 360px;
            max-width: calc(100vw - 40px);
            padding: 10px 14px 12px;
            background-color: var(--bg-white, #ffffff);
            border: 1px solid var(--border-color, #cccccc);
            border-radius: 3px;
            box-shadow: 0 4px 12px var(--shadow-color, rgba(0, 0, 0, 0.15));
            color: var(--text-main, #333333);
            font-family: var(--font-main, sans-serif);
            text-align: left;
            animation: ntFadeIn 0.3s cubic-bezier(0.25, 0.8, 0.25, 1) forwards;
        }

        .nt-toast:focus-visible {
            outline: 1px solid var(--accent-blue);
            outline-offset: -1px;
        }

        .nt-toast.fade-out {
            animation: ntFadeOut 0.3s cubic-bezier(0.25, 0.8, 0.25, 1) forwards;
        }

        .nt-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }

        .nt-source {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 11px;
            font-weight: 600;
            color: var(--text-muted, #666666);
        }

        .nt-close {
            flex: none;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: -4px -6px -4px 0;
            padding: 4px;
            border: none;
            background: none;
            cursor: pointer;
            font-size: 16px;
            color: var(--text-muted, #666666);
            transition: color 0.2s ease;
        }

        .nt-close:hover {
            color: var(--text-main, #333333);
        }

        .nt-title {
            margin-top: 4px;
            font-size: 13px;
            font-weight: 600;
            line-height: 1.35;
            color: var(--text-main, #333333);
            overflow: hidden;
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 2;
            line-clamp: 2;
            overflow-wrap: anywhere;
        }

        .nt-text {
            margin-top: 2px;
            font-size: 12px;
            color: var(--text-muted, #666666);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        @keyframes ntFadeIn {
            from { opacity: 0; transform: translateY(12px); }
            to { opacity: 1; transform: translateY(0); }
        }

        @keyframes ntFadeOut {
            from { opacity: 1; transform: translateY(0); }
            to { opacity: 0; transform: translateY(12px); }
        }

        /* Mobile Adaptations */
        @media (max-width: 768px) {
            /* Same spot as the app's own mobile toast: full width, above the status bar */
            #notifToastStack {
                left: 16px;
                right: 16px;
                bottom: calc(56px + var(--nt-offset, 0px));
            }

            .nt-toast {
                width: 100%;
                max-width: 100%;
            }

            #nowIslandPanel {
                bottom: 55px; /* Above mobile status bar (46px) + margin */
                right: 10px;
                /* Adapts to account for the 45px activity bar */
                left: 55px; 
                width: auto;
                height: 340px;
            }
            
            /* Dynamically adapts width if the layout hides the activity bar */
            body.hide-activity-bar #nowIslandPanel {
                left: 10px; 
            }

            /* Native Android Override (Accounts for default 26px status bar vs iOS safe areas) */
            html.is-android #nowIslandPanel {
                bottom: 35px;
            }
        }
    `;
    document.head.appendChild(style);

    // 2. Inject HTML Structure
    const panel = document.createElement('div');
    panel.id = 'nowIslandPanel';
    panel.innerHTML = `
        <div class="ni-header">
            <div class="ni-title">Now Island</div>
            <div class="ni-controls">
                <div class="ni-tabs">
                    <span class="ni-tab active" data-pane="now">Now</span>
                    <span class="ni-tab" data-pane="notifications">Notifications<span class="ni-badge" id="niUnreadBadge" hidden>0</span></span>
                </div>
                <i class="ri-layout-grid-fill" id=""></i>
                <i class="ri-close-line" id="nowIslandClose"></i>
            </div>
        </div>
        <div class="ni-body">
            <div class="ni-pane active" data-pane="now"></div>
            <div class="ni-pane" data-pane="notifications"></div>
        </div>
        <div class="ni-viewer" id="niViewer" role="dialog" aria-label="Notification"></div>
    `;
    document.body.appendChild(panel);

    // 3. Notification center (store + list + full-screen viewer)
    const NOTIF_KEY = 'codemini_notifications'; // app-wide: an update, for example, concerns every window
    const NOTIF_MAX = 50;
    const SESSION = Math.random().toString(36).slice(2); // tells this page load apart from earlier ones
    const nowIslandBtn = document.getElementById('nowIsland');
    const closeBtn = document.getElementById('nowIslandClose');
    const tabs = panel.querySelectorAll('.ni-tab');
    const panes = panel.querySelectorAll('.ni-pane');
    const notifPane = panel.querySelector('.ni-pane[data-pane="notifications"]');
    const viewer = panel.querySelector('#niViewer');
    const badge = panel.querySelector('#niUnreadBadge');
    const listeners = new Set();
    let openViewerId = null;

    function loadNotifications() {
        try {
            const raw = JSON.parse(localStorage.getItem(NOTIF_KEY));
            if (!Array.isArray(raw)) return [];
            return raw.filter(n => n && typeof n.id === 'string' && typeof n.title === 'string').slice(0, NOTIF_MAX);
        } catch (e) { return []; }
    }
    let items = loadNotifications();

    // An update notification still waiting for a reload when a NEW page load starts has been acted on: the
    // reload happened, so "Reload to use the latest version" would now be wrong.
    items.forEach(n => {
        if (n.kind === 'update' && n.pending && n.session !== SESSION) {
            const v = window.APP_INFO && window.APP_INFO.version;
            n.pending = false;
            n.title = 'Update applied';
            n.text = 'CodeMini IDE was updated and reloaded' + (v ? '. You are now running v' + v + '.' : '.');
        }
    });

    function unreadCount() { return items.filter(n => !n.read).length; }

    function commit() {
        try { localStorage.setItem(NOTIF_KEY, JSON.stringify(items.slice(0, NOTIF_MAX))); } catch (e) { /* storage full or blocked: keep working in memory */ }
        render();
        listeners.forEach(fn => { try { fn(items.slice()); } catch (e) { /* a bad listener must not break the rest */ } });
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function iconButton(iconClass, label, extraClass, onClick) {
        const btn = el('button', 'ni-icon-btn' + (extraClass ? ' ' + extraClass : ''));
        btn.type = 'button';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.appendChild(el('i', iconClass));
        // stopPropagation matters twice over: the click must not also open the item, and it must not reach the
        // document-level "click outside closes the island" handler (the button may already be gone by then, which
        // would make the click look like it came from outside the panel).
        btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return btn;
    }

    function render() {
        const unread = unreadCount();
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.hidden = unread === 0;
        if (nowIslandBtn) {
            nowIslandBtn.classList.toggle('has-unread', unread > 0);
            if (unread > 0) {
                nowIslandBtn.dataset.unread = badge.textContent; // same text as the tab badge (99+ cap)
                nowIslandBtn.setAttribute('aria-label', 'Now Island, ' + unread + ' unread notification' + (unread === 1 ? '' : 's'));
            } else {
                delete nowIslandBtn.dataset.unread;
                nowIslandBtn.removeAttribute('aria-label');
            }
        }

        notifPane.textContent = '';
        if (!items.length) {
            const empty = el('div', 'ni-empty');
            empty.append(el('i', 'ri-notification-off-line'), el('span', null, 'No notifications'));
            notifPane.appendChild(empty);
        } else {
            const list = el('ul', 'ni-notif-list');
            items.forEach(n => {
                const li = el('li', 'ni-notif' + (n.read ? '' : ' unread'));
                li.tabIndex = 0;
                li.dataset.id = n.id;

                const top = el('div', 'ni-notif-top');
                const title = el('div', 'ni-notif-title', n.title);
                title.title = n.title;
                const actions = el('div', 'ni-notif-actions');
                if (!n.read) actions.appendChild(iconButton('ri-check-double-line', 'Mark as read', '', () => markRead(n.id)));
                actions.appendChild(iconButton('ri-delete-bin-line', 'Delete', 'danger', () => remove(n.id)));
                top.append(title, actions);

                li.append(top, el('div', 'ni-notif-text', n.text || ''));
                li.addEventListener('click', (e) => { e.stopPropagation(); showViewer(n.id); });
                li.addEventListener('keydown', (e) => {
                    if (e.target === li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showViewer(n.id); }
                });
                list.appendChild(li);
            });
            notifPane.appendChild(list);
        }
        if (openViewerId) renderViewer(); // keeps an open viewer in step (text change, deletion elsewhere)
    }

    function add(input) {
        const n = {
            id: (input && input.id) || ('n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
            title: String((input && input.title) || 'Notification'),
            text: String((input && input.text) || ''),
            kind: input && input.kind ? String(input.kind) : 'info',
            source: String((input && input.source) || 'CodeMini'), // who it is from, shown on the toast
            actions: Array.isArray(input && input.actions) ? input.actions.filter(a => typeof a === 'string') : [],
            pending: !!(input && input.pending),
            session: SESSION,
            time: Date.now(),
            read: false
        };
        items = [n].concat(items.filter(x => x.id !== n.id)); // same id replaces: one live "update" notification at a time
        commit();
        // A toast only when the island is closed (when it is open the new item is already in front of the user)
        // and the sender did not opt out (the update notice already has its own toast in pwa.js).
        if (!(input && input.toast === false) && !panel.classList.contains('show')) showToast(n);
        return n.id;
    }

    function markRead(id) {
        const n = items.find(x => x.id === id);
        if (!n || n.read) return;
        n.read = true;
        dismissToast(id);
        commit();
    }

    function remove(id) {
        const had = items.length;
        items = items.filter(x => x.id !== id);
        if (items.length === had) return;
        if (openViewerId === id) hideViewer();
        dismissToast(id);
        commit();
    }

    // ---- notification toast ----
    const TOAST_MS = 6000;       // on screen
    const TOAST_RESUME_MS = 3000; // after the pointer or focus leaves it
    const TOAST_MAX = 3;
    const toastTimers = new Map(); // notification id -> timer
    let toastStack = null;
    let toastOther = null;         // the app's own #toast-container while a ResizeObserver watches it
    let toastResize = null;

    // Keeps this stack just above the app's other toast when both are on screen (they share a corner).
    function syncToastOffset() {
        if (!toastStack) return;
        const other = document.getElementById('toast-container');
        if (other !== toastOther) {
            if (toastResize) { toastResize.disconnect(); }
            toastOther = other;
            if (other && toastResize) toastResize.observe(other);
        }
        const h = other ? other.offsetHeight : 0;
        toastStack.style.setProperty('--nt-offset', h ? (h + 10) + 'px' : '0px');
    }

    function ensureToastStack() {
        if (toastStack && toastStack.isConnected) return toastStack;
        toastStack = el('div');
        toastStack.id = 'notifToastStack';
        toastStack.setAttribute('aria-live', 'polite');
        document.body.appendChild(toastStack);
        if (typeof ResizeObserver === 'function') toastResize = new ResizeObserver(syncToastOffset);
        if (typeof MutationObserver === 'function') new MutationObserver(syncToastOffset).observe(document.body, { childList: true });
        return toastStack;
    }

    function toastFor(id) {
        return toastStack ? Array.from(toastStack.children).find(t => t.dataset.id === id) : null;
    }

    function armToast(id, ms) {
        clearTimeout(toastTimers.get(id));
        toastTimers.set(id, setTimeout(() => dismissToast(id), ms));
    }

    function dismissToast(id) {
        clearTimeout(toastTimers.get(id));
        toastTimers.delete(id);
        const t = toastFor(id);
        if (!t || t.classList.contains('fade-out')) return;
        t.classList.add('fade-out');
        // Performance Mode turns animations off, so 'animationend' may never fire: the timer finishes the job
        // (300ms matches .nt-toast.fade-out, as the app's own toast does).
        let gone = false;
        const finish = () => {
            if (gone) return;
            gone = true;
            t.remove();
            syncToastOffset();
        };
        t.addEventListener('animationend', finish);
        setTimeout(finish, 300);
    }

    function dismissAllToasts() {
        if (!toastStack) return;
        Array.from(toastStack.children).forEach(t => dismissToast(t.dataset.id));
    }

    function showToast(n) {
        const stack = ensureToastStack();
        let t = toastFor(n.id);
        if (t && t.classList.contains('fade-out')) { t.remove(); t = null; }
        if (!t) {
            t = el('div', 'nt-toast');
            t.dataset.id = n.id;
            t.tabIndex = 0;
            t.setAttribute('role', 'status');
            t.title = 'Open in Now Island';

            const head = el('div', 'nt-head');
            const close = el('button', 'nt-close');
            close.type = 'button';
            close.setAttribute('aria-label', 'Dismiss notification');
            close.appendChild(el('i', 'ri-close-line'));
            close.addEventListener('click', (e) => { e.stopPropagation(); dismissToast(n.id); });
            head.append(el('span', 'nt-source'), close);
            t.append(head, el('div', 'nt-title'), el('div', 'nt-text'));

            // stopPropagation: otherwise the click reaches the document's "click outside closes the island" handler,
            // which sees a click outside the panel and closes it again straight after it opened.
            t.addEventListener('click', (e) => { e.stopPropagation(); dismissToast(n.id); openNotification(n.id); });
            t.addEventListener('keydown', (e) => {
                if (e.target !== t) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dismissToast(n.id); openNotification(n.id); }
                else if (e.key === 'Escape') dismissToast(n.id);
            });
            // Reading it (pointer or keyboard focus) pauses the countdown.
            t.addEventListener('mouseenter', () => clearTimeout(toastTimers.get(n.id)));
            t.addEventListener('mouseleave', () => armToast(n.id, TOAST_RESUME_MS));
            t.addEventListener('focusin', () => clearTimeout(toastTimers.get(n.id)));
            t.addEventListener('focusout', () => armToast(n.id, TOAST_RESUME_MS));
            stack.appendChild(t);
        }
        // Same id again (a repeated notification) refreshes the one toast instead of stacking another.
        t.querySelector('.nt-source').textContent = n.source || 'CodeMini';
        t.querySelector('.nt-title').textContent = n.title;
        t.querySelector('.nt-text').textContent = n.text || '';

        // More than TOAST_MAX at once: the oldest goes immediately (it is still in the list).
        while (stack.children.length > TOAST_MAX) {
            const oldest = stack.firstElementChild;
            clearTimeout(toastTimers.get(oldest.dataset.id));
            toastTimers.delete(oldest.dataset.id);
            oldest.remove();
        }
        syncToastOffset();
        armToast(n.id, TOAST_MS);
    }

    // ---- viewer ----
    function openUpdatesSettings() {
        setOpen(false);
        if (typeof window.openSettingsTab === 'function') window.openSettingsTab('updates');
        else document.getElementById('settingsIconItem')?.click();
    }

    // Opens a sidebar the same way its menu item does (and leaves it alone if it is already open).
    function openSidebarVia(menuId, sidebarId) {
        setOpen(false);
        const sb = document.getElementById(sidebarId);
        if (sb && !sb.classList.contains('open')) document.getElementById(menuId)?.click();
    }

    function openSettingsPage(tabId) {
        setOpen(false);
        if (typeof window.openSettingsTab === 'function') window.openSettingsTab(tabId);
        else document.getElementById('settingsIconItem')?.click();
    }

    const ACTIONS = {
        'reload': { label: 'Reload now', primary: true, show: () => !!(window.CodeMiniPWA && window.CodeMiniPWA.getUpdateState().status === 'updated'), run: () => window.CodeMiniPWA.reload() },
        'open-updates': { label: 'Open Updates settings', primary: false, show: () => true, run: openUpdatesSettings },
        'open-source-control': { label: 'Open Source Control', primary: true, show: () => true, run: () => openSidebarVia('menuSource', 'sourceControlSidebar') },
        'open-keys': { label: 'Open My Keys', primary: true, show: () => true, run: () => openSidebarVia('menuKeys', 'keysSidebar') },
        'open-security': { label: 'Open Security settings', primary: false, show: () => true, run: () => openSettingsPage('security') },
        // Needs a click (a user gesture): the browser may ask permission. app-alerts.js owns the logic.
        'protect-storage': {
            label: 'Protect my files', primary: true,
            show: () => !!(window.CodeMiniAlerts && window.CodeMiniAlerts.canProtectStorage()),
            run: () => { if (window.CodeMiniAlerts) window.CodeMiniAlerts.protectStorage(); }
        }
    };

    function renderViewer() {
        const n = items.find(x => x.id === openViewerId);
        if (!n) { hideViewer(); return; }
        viewer.textContent = '';

        const header = el('div', 'ni-viewer-header');
        const left = el('div', 'ni-viewer-left');
        const back = iconButton('ri-arrow-left-line', 'Back', 'ni-viewer-back', hideViewer);
        const title = el('div', 'ni-viewer-title', n.title);
        title.title = n.title;
        left.append(back, title);
        header.append(left, iconButton('ri-delete-bin-line', 'Delete', 'danger', () => remove(n.id)));

        const content = el('div', 'ni-viewer-content');
        content.appendChild(el('div', 'ni-viewer-time', new Date(n.time).toLocaleString()));
        content.appendChild(el('div', 'ni-viewer-text', n.text || ''));
        const wanted = (n.actions || []).filter(k => ACTIONS[k] && ACTIONS[k].show());
        if (wanted.length) {
            const row = el('div', 'ni-viewer-actions');
            wanted.forEach(k => {
                const btn = el('button', 'ni-btn' + (ACTIONS[k].primary ? ' primary' : ''), ACTIONS[k].label);
                btn.type = 'button';
                btn.addEventListener('click', (e) => { e.stopPropagation(); ACTIONS[k].run(); });
                row.appendChild(btn);
            });
            content.appendChild(row);
        }
        viewer.append(header, content);
    }

    function showViewer(id) {
        openViewerId = id;
        markRead(id); // opening it is reading it (commit() re-renders, including the viewer)
        renderViewer();
        viewer.classList.add('show');
    }

    function hideViewer() {
        openViewerId = null;
        viewer.classList.remove('show');
        viewer.textContent = '';
    }

    // ---- panel + tabs ----
    function setOpen(open) {
        panel.classList.toggle('show', open);
        if (open) dismissAllToasts();
        if (!open) hideViewer();
        if (window.saveCurrentUIState) window.saveCurrentUIState();
    }

    function setActiveTab(index) {
        if (!tabs[index]) index = 0; // a stale or hand-edited saved index
        tabs.forEach((t, i) => t.classList.toggle('active', i === index));
        panes.forEach(p => p.classList.toggle('active', p.dataset.pane === (tabs[index] && tabs[index].dataset.pane)));
        if (index !== 1) hideViewer();
    }

    function openNotification(id) {
        panel.classList.add('show');
        dismissAllToasts();
        setActiveTab(1);
        if (id) showViewer(id);
        if (window.saveCurrentUIState) window.saveCurrentUIState();
    }

    if (nowIslandBtn) {
        nowIslandBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setOpen(!panel.classList.contains('show'));
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setOpen(false);
        });
    }

    tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => {
            setActiveTab(i);
            if (window.saveCurrentUIState) window.saveCurrentUIState();
        });
    });

    document.addEventListener('click', (e) => {
        if (panel.classList.contains('show') && !panel.contains(e.target) && (!nowIslandBtn || !nowIslandBtn.contains(e.target))) {
            setOpen(false);
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && openViewerId && panel.classList.contains('show')) hideViewer();
    });

    // Another tab of the app added or removed something.
    window.addEventListener('storage', (e) => {
        if (e.key !== NOTIF_KEY) return;
        items = loadNotifications();
        render();
    });

    // App updates land here too. pwa.js owns the state; this only mirrors it into a notification.
    function onUpdateState(st) {
        if (!st || st.status !== 'updated') return;
        add({
            id: 'app-update',
            kind: 'update',
            pending: true,
            title: 'Update installed',
            toast: false, // pwa.js already shows its own "updated, reload" toast
            text: 'CodeMini IDE was updated. Reload to use the latest version. Nothing reloads by itself, so your unsaved changes are safe until you choose to.',
            actions: ['reload', 'open-updates']
        });
    }
    window.addEventListener('codemini:update-state', (e) => onUpdateState(e.detail));
    // An update that finished before this script ran (it loads last) must not be missed.
    if (window.CodeMiniPWA && typeof window.CodeMiniPWA.getUpdateState === 'function') onUpdateState(window.CodeMiniPWA.getUpdateState());

    window.CodeMiniNotifications = Object.freeze({
        add,
        remove,
        markRead,
        open: openNotification,
        list: () => items.map(n => Object.assign({}, n)),
        unreadCount,
        onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
    });

    commit(); // first render (also persists the "update applied" conversion above)

    // 4. Connect to Isolated Profile Window Registry
    document.addEventListener('DOMContentLoaded', () => {
        
        // Patch save function
        if (typeof window.saveCurrentUIState === 'function') {
            const originalSave = window.saveCurrentUIState;
            window.saveCurrentUIState = function() {
                originalSave();
                const winId = localStorage.getItem('codemini_active_window') || 'win_default';
                const isOpen = panel.classList.contains('show');
                const activeTabEl = panel.querySelector('.ni-tab.active');
                const activeTabIndex = activeTabEl ? Array.from(tabs).indexOf(activeTabEl) : 0;
                localStorage.setItem(`codemini_nowisland_state_${winId}`, JSON.stringify({ isOpen, activeTabIndex }));
            };
        }

        // Patch restore function
        if (typeof window.restoreCurrentUIState === 'function') {
            const originalRestore = window.restoreCurrentUIState;
            window.restoreCurrentUIState = function() {
                originalRestore();
                const winId = localStorage.getItem('codemini_active_window') || 'win_default';
                let activeTabIndex = 0;
                try {
                    const saved = JSON.parse(localStorage.getItem(`codemini_nowisland_state_${winId}`));
                    if (saved && saved.isOpen) {
                        panel.classList.add('show');
                    } else {
                        panel.classList.remove('show');
                    }
                    if (saved && Number.isInteger(saved.activeTabIndex)) activeTabIndex = saved.activeTabIndex;
                } catch(e) {
                    panel.classList.remove('show');
                }
                // Without this, whichever tab (Now / Notifications) was last
                // clicked in ANY window stays visually selected after
                // switching, since the tabs themselves are a DOM singleton
                // that switchWindow never rebuilds - it just looked like the
                // new window "remembered" the old window's last tab choice.
                setActiveTab(activeTabIndex);
                if (!panel.classList.contains('show')) hideViewer();
            };
        }

        // Initial restore pass
        if (typeof window.restoreCurrentUIState === 'function') {
            window.restoreCurrentUIState();
        }
    });
})();
