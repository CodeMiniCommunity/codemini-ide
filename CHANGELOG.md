# Changelog

The app currently reports itself as v1.2.0 (Settings > About / Updates).

## 1.2.0

### PWA

- **App shortcuts**: `manifest.json` now lists New File, Open Terminal, Search Workspace and Settings, which open `/?action=<name>`. `js/core/app.js` handles the action once, after the startup preloader has gone and the saved session is restored, and removes `?action` from the address bar (other parameters and the hash are kept). Unknown or inherited names are ignored; Search is not toggled off if it was already open. `tests/pwa.test.js` keeps the manifest and the handlers in step.
- **Update state** (`js/core/pwa.js`): one shared state (`CodeMiniPWA.getUpdateState()`, `codemini:update-state` event, `checkForUpdates()` that reports `updated` / `up-to-date` / `failed` / `unsupported`, `reload()`). The "was updated, Reload" toast, Settings > Updates and the Now Island notification all read it. Still never reloads by itself.
- The hourly and on-return re-checks now follow **Settings > Updates > Auto Check Updates** (previously the setting did nothing); manual checks always run.
- `tools/capture-screenshots.js` (`npm run screenshots`) captures wide and narrow screenshots from the running app for the richer install dialog and lists them in `manifest.json`. No screenshots are included yet: they have to be captured with internet access. `tests/pwa.test.js` validates them once present.

### Settings > Updates

- Live status: up to date (with last-checked time and a **Check for updates** button), checking, "Update installed" with **Reload now**, or "could not check" when offline.
- New "How updates work" text (the notice, the hourly/on-return re-check, notifications) and a v1.2.0 entry in the feature list. The pane no longer claims v1.0.0 is current.

### Now Island

- **Notifications tab** is now real. Each item has a white background and a dashed bottom border, the title at the top left (truncated) with mark-as-read and delete at the top right, and the text below, cut off after two lines. Unread items are bold with a dot; the tab shows an unread count and the status-bar button shows a dot.
- Tapping an item opens a full-screen viewer inside the island: back icon and title (truncated) at the top left, delete at the top right, the contents below. Opening marks it read; Escape goes back.
- App updates appear here as "Update installed" (with Reload now / Open Updates settings) and read "Update applied" after the reload. Notifications are stored on the device (`codemini_notifications`, at most 50) and exposed as `window.CodeMiniNotifications` (`add`, `remove`, `markRead`, `open`, `list`, `unreadCount`, `onChange`).

### Tests

- New `tests/update-state.test.js` (in `npm test`), `tests/e2e/notifications.e2e.js` and `tests/e2e/launch-actions.e2e.js`; `tests/pwa.test.js` gained shortcut and screenshot checks.
- Version bumped to 1.2.0 (`package.json`, `app-info.js` and `CACHE_NAME` match).

## 1.1.0

### PWA

- Added the app icon set in `icons/` (the folder the manifest, About page and `apple-touch-icon` already pointed at but that did not exist): 512 and 192 "any" icons, separate 192/512 **maskable** icons (the old manifest reused one file for the maskable entry), a 180px Apple touch icon and logo-only favicons (`.ico`, 32, 16).
- `manifest.json`: added `id`, `scope`, `lang`, `dir`, `prefer_related_applications`, `minimal-ui` fallback and a splash `background_color` that matches the icon.
- `index.html`: favicon and Apple touch icon links, `description`, `application-name` and `apple-mobile-web-app-title` meta tags.
- New `js/core/pwa.js` replaces the inline registration snippet: registers `/sw.js` with `updateViaCache: 'none'`, re-checks for a new version hourly and when the app regains focus, shows an "updated - Reload" notice (never reloads on its own, so unsaved edits are safe), and adds **Install App** to the More menu when the browser offers installation. Exposes `window.CodeMiniPWA`.
- Service worker: precaches the icons and `pwa.js`; local files are still network-first but now fall back to the cached copy after 4 s on a flaky connection (the network request keeps running and refreshes the cache); offline navigations to any path (or with a query string) open the cached app shell.
- `vercel.json`: serves `manifest.json` as `application/manifest+json` and gives `/icons/*` a day of caching.
- Added `tests/pwa.test.js` and `tests/sw.test.js` (both run in `npm test`, no browser needed).
- Version bumped to 1.1.0 (`package.json`, `app-info.js` and `CACHE_NAME` must match).

### Other

- Reorganized the repository into `css/`, `js/<area>/` and `tests/` folders.
- Added README, LICENSE, CONTRIBUTING, SECURITY, third-party notices, CI and issue/PR templates.
- Added Playwright end-to-end suites under `tests/e2e/` with a dependency-free runner (`npm run test:e2e`) and a CI job.
- Added `js/core/app-info.js` as the single source for version and project links; Settings > About now links to the real License, Privacy Policy, GitHub repository, issue tracker, third-party notices and security policy.
- "Send Feedback" now opens an email addressed to the maintainer (it had no recipient).
- About page now states the MIT license instead of "All rights reserved".
- Added `PRIVACY.md`.
- Live Preview: the DOM Inspector and Network Monitor are now bottom panels that push the preview up (like the Console) instead of overlaying it. Only one of Console, Network and Inspector is open at a time. On desktop-width screens with the preview maximized, the Inspector becomes a right sidebar that pushes the preview left. Added `tests/e2e/preview-panels.e2e.js`.
- Bumped the service worker static cache so installed copies pick up the new file paths.
