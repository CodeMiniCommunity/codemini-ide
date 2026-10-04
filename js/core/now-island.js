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

        /* Status-bar button: a small dot while something is unread. */
        #nowIsland {
            position: relative;
        }

        #nowIsland.has-unread::after {
            content: '';
            position: absolute;
            top: 3px;
            right: 3px;
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background-color: var(--accent-new, #00897b);
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
            border-radius: 4px;
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
            border-bottom: 1px dashed var(--border-color);
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

        /* Mobile Adaptations */
        @media (max-width: 768px) {
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
        if (nowIslandBtn) nowIslandBtn.classList.toggle('has-unread', unread > 0);

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
            actions: Array.isArray(input && input.actions) ? input.actions.filter(a => typeof a === 'string') : [],
            pending: !!(input && input.pending),
            session: SESSION,
            time: Date.now(),
            read: false
        };
        items = [n].concat(items.filter(x => x.id !== n.id)); // same id replaces: one live "update" notification at a time
        commit();
        return n.id;
    }

    function markRead(id) {
        const n = items.find(x => x.id === id);
        if (!n || n.read) return;
        n.read = true;
        commit();
    }

    function remove(id) {
        const had = items.length;
        items = items.filter(x => x.id !== id);
        if (items.length === had) return;
        if (openViewerId === id) hideViewer();
        commit();
    }

    // ---- viewer ----
    function openUpdatesSettings() {
        setOpen(false);
        if (typeof window.openSettingsTab === 'function') window.openSettingsTab('updates');
        else document.getElementById('settingsIconItem')?.click();
    }

    const ACTIONS = {
        'reload': { label: 'Reload now', primary: true, show: () => !!(window.CodeMiniPWA && window.CodeMiniPWA.getUpdateState().status === 'updated'), run: () => window.CodeMiniPWA.reload() },
        'open-updates': { label: 'Open Updates settings', primary: false, show: () => true, run: openUpdatesSettings }
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
