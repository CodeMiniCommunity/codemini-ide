# Changelog

The app currently reports itself as v1.3.1 (Settings > About / Updates).

## Unreleased

### Security
- **Isolated previews (phase 1).** Live Preview now runs the previewed page on a separate origin, the new **preview runner** (`runner/`, its own Vercel project, `https://the-code-mini-runner.vercel.app`; deployment steps in `runner/README.md`). A previewed page can no longer read the app's storage (vault, token record, device key), call its functions, or fetch its files. The runner mints the page's `blob:` URLs and relays the console, network, inspector and reload traffic, so those tools work as before. If the runner is unreachable the preview falls back to the previous same-origin mode and the toolbar shows an amber warning (green shield when isolated). `codemini_runner` = `off` switches it off; `codemini_runner_url` overrides the address on localhost only; a runner on the app's own origin is refused. Pop-out is unavailable while isolated. The terminal, Console and notebooks are not yet covered (later phases).
- **Isolated previews keep both reload strategies.** "Full Navigation" works as before. "Legacy (in-place rewrite)" now also works while isolated: the runner shell, which shares the page's origin, rewrites the page in place (state kept) and navigates instead when nothing is showing yet.
- **Fixed: the in-place rewrite always crashed the page's injected helper script** (`Identifier 'lastErrorTracker' has already been declared`, in the original same-origin mode too), which also left the console, network and inspector relay dead after a rewrite. The helper's top-level `let`s are now `var`, and its console/fetch/XHR patches are installed once per window, so a rewrite no longer throws or logs twice.
- **Isolation status is now readable on a phone.** Tapping the shield (or the warning icon) opens a note inside the preview with the status, the reason for any fallback, the runner address and the app origin, with Retry and Close; it also opens once on its own the first time isolation falls back. (It used to use a toast that sat under the full-screen preview.) The shell now reports a page as loaded only once the frame really shows it, and the reasons for falling back are specific.
- The app's `vercel.json` now sends `X-Content-Type-Options: nosniff`, `frame-ancestors 'self'` and a referrer policy; `.vercelignore` keeps `runner/` out of the app deployment.
- New tests: `tests/runner.test.js` (the shell and client against fake windows: origin allowlist, handshake and nonce, relay envelope, spoofing attempts, fallback timing) and `tests/e2e/runner.e2e.js` (two real origins in Chromium: the page works, cannot reach the app's storage, functions, files or databases, forged messages are ignored, refresh works, another site cannot embed the runner, and the fallback, off and misconfigured cases).
- **File names could run script (fixed).** A name like `<img src=x onerror=...>` in a zip you opened, a repo you cloned or a file you imported was put into the page as HTML in the Explorer (including its tooltip), search results, tab titles, the breadcrumb, the archive viewer (where a quote also broke out of `data-entry-path`), the Stacks panel, the terminal's `ls`, `find` and `tree`, toasts, context menus and dialogs. All now go through the new shared `CodeMiniEscape` (`js/core/html-escape.js`), or `textContent`. Dialog text is now plain text.
- **Markdown, documents and saved output are allowlisted.** Notebook Markdown cells, the Markdown preview, the document editor (`.docx` links and styles, old saved HTML documents) and restored terminal/console output go through `CodeMiniEscape.sanitize`.
- **Inline `onclick` values** built from names the previewed page controls (storage keys, request ids) and from notebook package names are JSON-quoted, then escaped. The preview's object tree escapes keys and values.
- `shield.js` is the first script on the page, before the inline and CDN scripts, and a test pins it. Added a referrer policy, `noopener` on the preview pop-out and an external link, read-only CI permissions and Dependabot.
- New tools: `scripts/sri.js` (add or check Subresource Integrity hashes; needs network and a maintainer run), `scripts/scan-html-sinks.js` (lists unescaped HTML interpolations). New tests: `tests/html-sinks.test.js` (with a per-file ratchet), `tests/hardening.test.js`, `tests/e2e/xss-names.e2e.js` (hostile names across the Explorer, search, tabs and archive tree), `tests/e2e/sanitize.e2e.js` (30 hostile payloads, mutation-stability, legitimate Markdown surviving).

- **Locked files and folders** no longer store their password. A lock is now a random salt plus a PBKDF2-SHA256 verifier (600,000 rounds), and a locked file's text is encrypted with AES-256-GCM, so reading IndexedDB no longer reveals either. Locks made by earlier versions are upgraded automatically when the app loads. Raw and zip downloads skip locked files (the JSON export keeps them encrypted and restores them locked). Items inside a locked folder are not individually encrypted.
- **GitHub token** is no longer kept in plain `localStorage`, and no longer needs My Keys to be unlocked. It is encrypted with a new **device key** (see Shield below) and stored as ciphertext per window (`codemini_git_gh_tokenenc_<window>`). It stays usable after My Keys locks and after a reload. The decrypted token is held in memory while the page is open (a session cache), because Git operations read it synchronously. Older copies migrate on their own: a plain-text token when the page loads, a token in My Keys the next time it is unlocked (the vault copy is then removed, and only after the new copy has been stored and read back). If IndexedDB is unavailable the token falls back to the My Keys vault, as in the previous build. A failed save never destroys a working token. If the device key is lost while the record remains, the record is removed, a notice is shown, and the token has to be added again. Honest limits are in SECURITY.md: the device key protects against copied storage and leaked backups, not against someone using the open browser or script running in the page.
- My Keys still exposes one narrow, named slot for the GitHub token (`getSecret` / `setSecret` / `removeSecret`), now used for the fallback and for moving old tokens out; all other entries remain unreadable by code.
- **"Reset settings"** keeps the encrypted token record, the same way it keeps the vault. (Delete Profile and Wipe Native Data still remove it with the rest of that window's data; the shared device key stays.)
- New: `js/core/file-lock.js`, `tests/file-lock.test.js` (in `npm test`).
- **CodeMini Shield** (`js/core/shield.js`): one shared crypto layer with no UI. Key derivation (PBKDF2-SHA256), AES-256-GCM, random salts and IVs, base64 helpers, record-shape checks and an in-memory key ring now live there, and My Keys and file locks call it instead of carrying their own copies. Shield never unlocks a password-protected item by itself: locked files, locked folders and My Keys still open only with the password you chose, and they never use the device key.
- **Shield device key** (`Shield.device.seal` / `open`): one non-extractable AES-256-GCM key kept in IndexedDB (`codemini_shield`), for secrets with no password of their own (today only the GitHub token). Records are `{ v, iv, ct }`, padded to hide length, and bound to a purpose string (`github-token:<window>`), so a record copied into another window's slot does not open. Two tabs racing to create the key end up sharing one. This is the only part of Shield that touches storage; `tests/shield.test.js` checks that.
- New: `tests/git-token.test.js` (in `npm test`, real `shield.js` and `git.js` against fake storage), `tests/lib/fake-idb.js`, and `tests/e2e/git-token.e2e.js` (real Chromium: real IndexedDB, the key refuses export, reload with My Keys locked, disconnect, lost key, plain-text migration). **Nothing is migrated:** the stored formats are unchanged, and records from before this change open as before (and the reverse, so a rollback loses nothing). `tests/fixtures/legacy-formats.json` holds records written by the old code, and `tests/shield.test.js` (in `npm test`) opens them.
- **Renamed** `js/core/vault.js` to `js/core/my-keys.js` and `tests/vault.test.js` to `tests/my-keys.test.js`. The saved data keeps its names (`codemini_vault_<window>`, `type: "codemini-vault"`), because renaming those would orphan existing vaults. `index.html` and the service worker precache list load `shield.js` right after `app-info.js`, then `my-keys.js`.

## 1.3.1

### My Keys

- **My Keys** (activity menu) is now a real sidebar: an encrypted vault for API keys, tokens and passwords. Header with the title on the left and refresh and close on the right; tabs **Add Keys**, **My Keys** and **Config**.
- **First use** shows a full-sidebar "Create your vault password" screen (not a modal): password plus confirmation, a strength meter, weak and common passwords refused, and an acknowledgement that a forgotten password cannot be recovered. Afterwards a full-sidebar **locked** screen asks for the password every time the vault is opened.
- **Encryption**: everything (names, services, notes, values) is one AES-256-GCM blob, with a key derived from the password by PBKDF2-SHA256 (600,000 rounds, random salt). Only ciphertext is stored (`codemini_vault_<window>`); the password and key are never saved. The stored size is padded so it does not reveal how many keys there are. Each window or profile has its own vault.
- **Locking**: when the sidebar closes (default), after 1, 5, 15, 30 or 60 idle minutes, when switching windows, optionally when the app goes to the background, and on page hide. Five wrong passwords in a row slow further tries. A restored session always comes back locked.
- **My Keys tab**: search, masked values, reveal (hides itself after 10 to 60 seconds), copy, edit and delete with confirmation. **Add Keys**: name, service, type, value (optionally multi-line) and notes.
- **Config tab**: auto-lock time, lock-on-close, lock-on-background, reveal time, lock now, change password (re-encrypts), encrypted backup export and import (merge), plain-language notes on what is and is not protected, and an erase-vault danger zone. "Forgot your password?" leads to a type-ERASE confirmation.
- "Reset settings" in Settings leaves the vault alone; Factory Reset and deleting a profile remove it with the rest of that window's data.
- New: `js/core/vault.js`, `tests/vault.test.js` (in `npm test`), `tests/e2e/keys-vault.e2e.js`. PRIVACY.md and SECURITY.md describe the vault.
- The three on/off options in the Config tab are now the same 40x22 pill switches used in Settings, instead of small native checkboxes.
- Version bumped to 1.3.1 (`package.json`, `app-info.js` and `CACHE_NAME` match).

### Notifications

- **Notification toast**: a notification that arrives while Now Island is closed now shows as a toast in the same corner as the app's other toasts (bottom right on desktop, full width above the status bar on mobile). Source name at the top left (for example "Source Control"), close icon at the top right, the title below it, then the text on one line, truncated. Click it to open the notification in Now Island; the X only dismisses it. It stays 6 seconds (paused while the pointer or focus is on it), at most 3 at a time, and lifts above the app's own toast when both are showing. Own names (`#notifToastStack`, `.nt-*`), nothing shared with `.toast-container` / `.custom-toast`. The update notice keeps its existing toast and does not toast twice.
- Notifications carry a `source` (CodeMini, Source Control, My Keys, Workspace Trust, Notebooks).
- **Storage safety** (`js/core/app-alerts.js`): a notice when browser storage passes 80%, 90% and 95% (each level at most weekly, removed when usage drops), and when storage is not persistent, with a **Protect my files** button (fortnightly at most).
- **Offline ready**: said once, when the service worker is active and the app shell is cached.
- **Source Control**: merge, cherry-pick and rebase conflicts, a rejected saved GitHub token, and failed pushes and pulls. Each clears itself when resolved (conflicts finished, token replaced, next success). Messages go through the token redaction first.
- **Security**: five wrong My Keys passwords in a row (and every five after); a My Keys backup reminder (two days after first use with no backup, or when the last export is a month old, weekly at most; it holds no vault data); and "Restricted Mode is on" when a workspace is not trusted.
- **Notebooks**: Python or R finishing loading, a package install finishing, and Run All finishing after 15 seconds or more, only when the app is in the background or you moved to another window or profile, and never for a run you stopped.
- New: `js/core/app-alerts.js`, `tests/notifications.test.js` (in `npm test`).

## 1.2.0

### Settings > Updates

- The version history is now a list of collapsible release cards (`Version history`): each shows the version, a one-line summary, the date and a change count, and opens with an animation to a checklist of changes. The newest release starts open. Cards have a plain neutral border (no coloured edge, no accent border when open). Settings > Updates lists up to 6 releases, followed by **View all versions**, which opens (or switches to) a **Version History** tab listing every release. Releases are one array (`_RELEASES` in `js/core/settings-profile.js`). The cards follow the theme pack's rounding.

### PWA

- **App shortcuts**: `manifest.json` now lists New File, Open Terminal, Search Workspace and Settings, which open `/?action=<name>`. `js/core/app.js` handles the action once, after the startup preloader has gone and the saved session is restored, and removes `?action` from the address bar (other parameters and the hash are kept). Unknown or inherited names are ignored; Search is not toggled off if it was already open. `tests/pwa.test.js` keeps the manifest and the handlers in step.
- **Update state** (`js/core/pwa.js`): one shared state (`CodeMiniPWA.getUpdateState()`, `codemini:update-state` event, `checkForUpdates()` that reports `updated` / `up-to-date` / `failed` / `unsupported`, `reload()`). The "was updated, Reload" toast, Settings > Updates and the Now Island notification all read it. Still never reloads by itself.
- The hourly and on-return re-checks now follow **Settings > Updates > Auto Check Updates** (previously the setting did nothing); manual checks always run.
- `tools/capture-screenshots.js` (`npm run screenshots`) captures wide and narrow screenshots from the running app for the richer install dialog and lists them in `manifest.json`. No screenshots are included yet: they have to be captured with internet access. `tests/pwa.test.js` validates them once present.

### Settings > Updates

- Live status: up to date (with last-checked time and a **Check for updates** button), checking, "Update installed" with **Reload now**, or "could not check" when offline.
- New "How updates work" text (the notice, the hourly/on-return re-check, notifications) and a v1.2.0 entry in the feature list. The pane no longer claims v1.0.0 is current.

### Now Island

- **Notifications tab** is now real. Each item has a white background and a dashed bottom border, the title at the top left (truncated) with mark-as-read and delete at the top right, and the text below, cut off after two lines. Unread items are bold with a dot; the tab shows an unread count and the status-bar button shows the number (plain text, no background) next to its icon. The full notification viewer follows the panel's rounded corners under theme packs.
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
