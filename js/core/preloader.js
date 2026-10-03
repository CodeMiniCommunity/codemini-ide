// ==========================================
// preloader.js
// ==========================================

(function initPreloader() {
    // 1. Inject Styles for the Preloader
    const preloaderStyles = document.createElement('style');
    preloaderStyles.id = 'codemini-preloader-styles';
    preloaderStyles.innerHTML = `
        /* Full-screen overlay with exact profile-loading blur & fallback */
        .app-preloader-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 999999; /* Ensure it covers everything */
            background: transparent;
            backdrop-filter: blur(15px);
            -webkit-backdrop-filter: blur(10px);
            display: flex;
            justify-content: center;
            align-items: center;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.5s ease, visibility 0.5s ease;
            pointer-events: none;
        }

        .app-preloader-overlay.show {
            opacity: 1;
            visibility: visible;
            pointer-events: all;
        }

        /* Present from the very first frame: fading IN would let the sharp, unblurred app show through for the
           length of the fade. The transition is only restored when it's time to fade OUT. */
        .app-preloader-overlay.no-transition {
            transition: none;
        }

        /* Fallback for browsers that do not support backdrop-filter */
        @supports not (backdrop-filter: blur(10px)) {
            .app-preloader-overlay {
                background-color: rgba(245, 245, 245, 0.95);
            }
            [data-theme="dark"] .app-preloader-overlay {
                background-color: rgba(30, 30, 30, 0.95);
            }
        }

        /* Center Text Styling */
        .app-preloader-center { text-align: center; }
        .app-preloader-profile {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            margin-top: 14px;
            font-size: 16px;
            font-weight: 600;
            color: var(--text-muted);
        }
        .app-preloader-profile i { font-size: 20px; }
        .app-preloader-center h1 {
            font-size: 40px;
            font-weight: 500;
            color: var(--text-main);
            margin: 0;
            letter-spacing: 1px;
        }

        /* Bottom Right Loading Indicator */
        .app-preloader-bottom-right {
            position: absolute;
            bottom: 25px;
            right: 25px;
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 14px;
            color: var(--text-muted);
            font-weight: 500;
        }

        .app-preloader-spinner {
            font-size: 22px;
            color: var(--accent-blue);
            animation: spinStatus 0.8s linear infinite;
        }
    `;
    document.head.appendChild(preloaderStyles);

    // 2. Inject HTML Structure
    const preloaderContainer = document.createElement('div');
    preloaderContainer.id = 'appPreloader';
    preloaderContainer.className = 'app-preloader-overlay show no-transition';
    preloaderContainer.innerHTML = `
        <div class="app-preloader-center">
            <h1>CodeMini</h1>
        </div>
        <div class="app-preloader-bottom-right">
            <i class="ri-loader-4-line app-preloader-spinner"></i>
            <span>Loading CodeMini...</span>
        </div>
    `;

    // When the app opens straight into a profile window, say which one here. The profile loading overlay
    // (app.js) used to be shown on top of this at the same moment: two full-screen blurs stacked, with their
    // "Loading..." indicators drawn over each other in the same corner. This one overlay now carries both.
    // Read from the same localStorage keys app.js uses; textContent, because window names are user-editable.
    try {
        const activeId = localStorage.getItem('codemini_active_window') || 'win_default';
        const activeWin = (JSON.parse(localStorage.getItem('codemini_windows')) || []).find(w => w.id === activeId);
        if (activeWin && activeWin.profile) {
            const profileLabel = document.createElement('div');
            profileLabel.className = 'app-preloader-profile';
            profileLabel.innerHTML = '<i class="ri-user-smile-line"></i><span></span>';
            profileLabel.querySelector('span').textContent = activeWin.name;
            preloaderContainer.querySelector('.app-preloader-center').appendChild(profileLabel);
            preloaderContainer.querySelector('.app-preloader-bottom-right span').textContent = 'Loading profile...';
        }
    } catch (e) { /* unreadable storage: just show the plain preloader */ }

    document.body.appendChild(preloaderContainer);

    // 3. Already visible (see .no-transition above). shownAt is the minimum-display-time reference.
    const shownAt = performance.now();

    // 4. Hide when the app is actually ready (instead of after a fixed delay)
    //
    // "Ready" means both of these have happened:
    //   files  - the first loadFilesFromDB() has finished, which includes opening the database and restoring
    //            the saved tabs. app.js reports this through CodeMiniPreloader.markReady('files').
    //   editor - Monaco has loaded. editor.js sets window.monaco the moment it's available, so it's watched for
    //            here rather than needing a hook in that file. If Monaco's loader script itself failed to load
    //            (no global `require` once the page has finished loading - e.g. first visit while offline), the
    //            editor is never coming, so we stop waiting for it instead of holding the app hostage.
    //
    // Two limits keep this honest:
    //   MIN_VISIBLE_MS - a very fast load would otherwise snap the overlay on and off in a flash, so it stays at
    //                    least as long as its own fade-in.
    //   MAX_VISIBLE_MS - the overlay blocks all input (pointer-events: all), so it must never outlive a load
    //                    that failed: if something never reports in, hide anyway and say what was missing.
    const MIN_VISIBLE_MS = 500;
    const MAX_VISIBLE_MS = 8000;
    const FADE_OUT_MS = 500; // matches the .app-preloader-overlay opacity transition

    const pending = new Set(['files', 'editor']);
    let scheduled = false; // everything has reported in and a fade-out is queued
    let fading = false;    // the fade-out has actually started
    let pageLoaded = document.readyState === 'complete';
    let editorPoll = null;
    let capTimer = null;

    function fadeOutAndRemove() {
        if (fading) return;
        fading = true;
        clearInterval(editorPoll);
        clearTimeout(capTimer);
        window.removeEventListener('load', onPageLoad);
        // Bring the transition back, and flush styles so it actually runs instead of snapping closed.
        preloaderContainer.classList.remove('no-transition');
        void preloaderContainer.offsetWidth;
        preloaderContainer.classList.remove('show');

        // Clean up the DOM after the fade-out transition completes
        setTimeout(() => {
            preloaderContainer.remove();
            preloaderStyles.remove();
        }, FADE_OUT_MS);
    }

    function hideWhenReady() {
        if (scheduled || pending.size > 0) return;
        scheduled = true; // claim it now so a second signal can't queue a second fade
        const remaining = Math.max(0, MIN_VISIBLE_MS - (performance.now() - shownAt));
        setTimeout(fadeOutAndRemove, remaining);
    }

    function markReady(name) {
        pending.delete(name);
        hideWhenReady();
    }

    function onPageLoad() { pageLoaded = true; }
    window.addEventListener('load', onPageLoad);

    editorPoll = setInterval(() => {
        if (window.monaco) markReady('editor');
        else if (pageLoaded && typeof window.require !== 'function') markReady('editor');
    }, 100);

    capTimer = setTimeout(() => {
        if (fading) return;
        if (pending.size > 0) {
            console.warn('Preloader: hiding after ' + MAX_VISIBLE_MS + 'ms without being told everything was ready. Still waiting for: ' + Array.from(pending).join(', '));
        }
        fadeOutAndRemove();
    }, MAX_VISIBLE_MS);

    // isActive(): is the overlay still covering the screen? app.js uses it to avoid stacking its own
    // profile overlay on top of this one at startup.
    window.CodeMiniPreloader = { markReady, isActive: () => preloaderContainer.isConnected && !fading };

})();
