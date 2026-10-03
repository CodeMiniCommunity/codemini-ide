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
- **Installable PWA** with offline support

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
├── icons/                  PWA icons referenced by the manifest
├── PRIVACY.md, SECURITY.md, LICENSE, THIRD_PARTY_NOTICES.md
├── css/
│   ├── style.css           Layout and components
│   └── themes.css          Theme variables
├── js/
│   ├── core/               App bootstrap, app-info (version/links), editor, settings, search, uploads, workspace trust
│   ├── notebook/           Notebook UI, kernels, plot/table preview
│   ├── viewers/            PDF, Word, media, archive and web preview tabs
│   ├── terminal/           Terminal window, commands, console panel
│   └── git/                Git/GitHub integration and stacks
└── tests/
    ├── policy.test.js      Workspace Trust policy unit tests (no browser needed)
    ├── app-info.test.js    Keeps version, links and About page consistent with the repo
    └── e2e/                Playwright end-to-end suites + runner
```

## Adding or moving a file

Scripts are plain `<script>` tags, so **load order in `index.html` matters**. When you add, rename or move an asset:

1. Update the tag in `index.html`.
2. Update `STATIC_ASSETS` in `sw.js`.
3. Bump `CACHE_NAME` in `sw.js` so installed copies refresh.

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

`tests/e2e/theme-premium-compare.manual.js` is a manual before/after comparison tool and is not part of the automated run.

## Deploying

The reference deployment runs on Vercel at https://the-code-mini-ide.vercel.app/. Any static host works. The repository includes a `vercel.json` that serves `sw.js` with `no-cache` so updates reach users promptly.
Serve the site from the **root of a domain** (or adapt the absolute `/sw.js`, `/icons/...` and `start_url` paths in `index.html`, `sw.js` and `manifest.json`).

## Privacy

See [PRIVACY.md](PRIVACY.md) for details. Everything runs client-side. Files, settings and tokens stay in your browser storage. Runtime libraries are fetched from public CDNs (listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)) and cached for offline use.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## Credits

Created and maintained by [The CodeMini Community](https://github.com/CodeMiniCommunity). Lead developer: [Christian Forson](https://github.com/CoderCriss).

## License

[MIT](LICENSE). Third-party libraries keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
