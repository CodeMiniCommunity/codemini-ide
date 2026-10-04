# CodeMini IDE

An offline-first, installable IDE that runs entirely in your browser. No backend, no account, no build step.

**[Try it live](https://the-code-mini-ide.vercel.app/)** (open it in Chrome, Edge or Safari and use the browser's install option to add it as an app)

Your files live on your device (IndexedDB). Install it as a PWA and it keeps working without a connection once its assets are cached.

## Features

- **Code editor** powered by Monaco, with Emmet support
- **Multiple windows and profiles**, each with its own isolated file storage and UI state
- **Notebooks** with in-browser kernels for Python (Pyodide), R (WebR), SQL (sql.js) and Ruby
- **PHP and web previews** that run in the browser
- **Built-in viewers** for PDF, Word documents, images, audio, video and archives
- **Integrated terminal** with a set of shell-style commands
- **Git and GitHub integration** (clone/import, pull, push) using your own token, called directly from the browser
- **Workspace Trust** with a Restricted Mode, configurable in Settings > Security
- **Themes**, light and dark
- **Installable PWA** with offline support, an in-app **Install App** menu item (Chromium), app shortcuts (New File, Terminal, Search, Settings) and an "updated, reload" notice when a new version is deployed
- **Notifications** in the Now Island, including app updates; Settings > Updates shows the update status and a "Check for updates" button

## Run locally

CodeMini is static files, but it must be served over HTTP(S) (a service worker does not run from `file://`).

```bash
git clone https://github.com/CodeMiniCommunity/codemini-ide.git
cd codemini-ide
npm start          # serves on http://localhost:3000
```

Any static server works, for example `python3 -m http.server 3000`.
`localhost` counts as a secure context, so the service worker and install prompt work in development.

## Project structure

```
.
├── index.html              App shell and script load order
├── sw.js                   Service worker (must stay at the site root)
├── manifest.json           PWA manifest
├── vercel.json             Hosting headers (keeps sw.js uncached)
├── icons/                  App icons: icon.png (512), icon-192, icon-maskable-192/512, apple-touch-icon, favicons
├── PRIVACY.md, SECURITY.md, LICENSE, THIRD_PARTY_NOTICES.md
├── css/
│   ├── style.css           Layout and components
│   └── themes.css          Theme variables
├── js/
│   ├── core/               App bootstrap (incl. ?action= shortcuts), app-info (version/links), pwa (service worker registration, install, update state), now-island (notifications), editor, settings, search, uploads, workspace trust
│   ├── notebook/           Notebook UI, kernels, plot/table preview
│   ├── viewers/            PDF, Word, media, archive and web preview tabs
│   ├── terminal/           Terminal window, commands, console panel
│   └── git/                Git/GitHub integration and stacks
├── tools/
│   └── capture-screenshots.js  Captures the install-dialog screenshots into screenshots/ and manifest.json
└── tests/
    ├── policy.test.js      Workspace Trust policy unit tests (no browser needed)
    ├── app-info.test.js    Keeps version, links and About page consistent with the repo
    ├── pwa.test.js         Manifest, icons, shortcuts (must match the ?action= handlers in app.js), screenshots, <head> links and precache list agree
    ├── update-state.test.js  Update flow in pwa.js: shared state, toast, manual vs scheduled checks, Auto Check Updates (no browser needed)
    ├── sw.test.js          Service worker strategy: network-first, timeout, offline fallback (no browser needed)
    └── e2e/                Playwright end-to-end suites + runner
```

## Adding or moving a file

Scripts are plain `<script>` tags, so **load order in `index.html` matters**. When you add, rename or move an asset:

1. Update the tag in `index.html`.
2. Update `STATIC_ASSETS` in `sw.js`.
3. Bump `CACHE_NAME` in `sw.js` so installed copies refresh (this means bumping `version` in `package.json` and `js/core/app-info.js` too; `npm test` checks they match).

CI fails if a precached path does not exist.

## Tests

```bash
npm test                      # fast unit tests (Node only)

npm install                   # one time: installs Playwright
npx playwright install chromium
npm run test:e2e              # all end-to-end suites
npm run test:e2e -- preloader # only suites whose file name contains "preloader"
```

The e2e runner serves the repo on `http://localhost:8765` itself, so nothing else needs to be running. Suites block third-party CDNs and stub Monaco, so they run offline and fast.

| Suite | Covers |
| --- | --- |
| `workspace-trust.e2e.js` | Trust prompt, Restricted Mode, banner, settings and persistence |
| `terminal-trust.e2e.js` | Terminal refuses to run files in a restricted workspace |
| `theme-flash.e2e.js` | Saved theme, accent and opacity applied from the first frame (no flash) |
| `preloader.e2e.js` | Startup overlay timing, minimum/maximum display, fade-out |
| `profile-overlay.e2e.js` | Profile/window switch overlay behavior |
| `explorer.e2e.js` | Explorer toolbar, search box and New Folder flow |
| `preview-panels.e2e.js` | Live Preview Console/Network/Inspector panels: layout, push behavior, one-at-a-time |
| `notifications.e2e.js` | Now Island notifications (item design, viewer, actions) and the update flow: toast, notification, Settings > Updates |
| `launch-actions.e2e.js` | App shortcuts: `/?action=new-file`, `terminal`, `search`, `settings` |

`tests/e2e/theme-premium-compare.manual.js` is a manual before/after comparison tool and is not part of the automated run.

## App icons

The icon set in `icons/` is generated from one 940x940 master image. When you change the logo, regenerate all of these (sizes matter, `npm test` verifies real PNG headers and dimensions):

| File | Size | Used for |
| --- | --- | --- |
| `icon.png` | 512x512 | Manifest ("any"), Settings > About |
| `icon-192.png` | 192x192 | Manifest ("any") |
| `icon-maskable-192.png`, `icon-maskable-512.png` | 192 / 512 | Manifest ("maskable"): full-bleed background, logo kept inside the central 80% safe zone so Android's circle/squircle masks never clip it |
| `apple-touch-icon.png` | 180x180 | iOS home screen |
| `favicon.ico`, `favicon-32.png`, `favicon-16.png` | 16-48 | Browser tabs. Logo only on a transparent background so it stays readable at tiny sizes and on dark tab strips |

## App shortcuts

Installed copies get shortcuts (long-press the icon on Android, right-click it on Windows/Linux/ChromeOS, the dock menu on macOS). They are the `shortcuts` in `manifest.json` and open the app at `/?action=<name>`; `js/core/app.js` (`LAUNCH_ACTIONS`) performs the action once the app has finished starting, then removes it from the address bar. To add one, add the handler, add the manifest entry, and keep it to four (Android shows no more); `npm test` checks the two lists agree. The shortcuts have no icons of their own, so platforms show the app icon.

## Updates

When a new version is deployed, an installed or open copy notices it in the background: it re-checks hourly and whenever the app is shown again (both skipped if **Settings > Updates > Auto Check Updates** is off), and **Check for updates** in that pane always works. A new version never reloads the page by itself, so unsaved edits are safe. Instead:

- a toast says "CodeMini IDE was updated" with a **Reload** button,
- Settings > Updates shows "Update installed" with **Reload now**,
- Now Island > Notifications gets an "Update installed" notification (unread dot on the status-bar button). After the next reload it reads "Update applied".

`js/core/pwa.js` owns the state (`CodeMiniPWA.getUpdateState()` and the `codemini:update-state` event); the three places above only display it. To ship an update the service worker file has to change, so bump the version as described in "Adding or moving a file".

## Install-dialog screenshots

Chrome shows a richer install dialog when the manifest lists screenshots. They must be real captures of the running app, so they are generated rather than hand-made:

```bash
npm install && npx playwright install chromium   # one time
npm run screenshots
```

This needs internet access (Monaco and the icon font come from CDNs; the script stops instead of saving a capture without them), writes `screenshots/*.png` (wide 1280x720, narrow 780x1688) and rewrites the `screenshots` list in `manifest.json`. Look at the pictures before committing, and re-run it when the UI changes noticeably. `npm test` checks the declared files and Chrome's size rules.

## Deploying

The reference deployment runs on Vercel at https://the-code-mini-ide.vercel.app/. Any static host works. The repository includes a `vercel.json` that serves `sw.js` with `no-cache` so updates reach users promptly.
Serve the site from the **root of a domain** (or adapt the absolute `/sw.js`, `/icons/...`, `id`, `scope` and `start_url` paths in `index.html`, `js/core/pwa.js`, `sw.js` and `manifest.json`).

## Privacy

See [PRIVACY.md](PRIVACY.md) for details. Everything runs client-side. Files, settings and tokens stay in your browser storage. Runtime libraries are fetched from public CDNs (listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)) and cached for offline use.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## Credits

Created and maintained by [The CodeMini Community](https://github.com/CodeMiniCommunity). Lead developer: [Christian Forson](https://github.com/CoderCriss).

## License

[MIT](LICENSE). Third-party libraries keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
