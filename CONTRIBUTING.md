# Contributing

Thanks for your interest in CodeMini.

## Setup

```bash
git clone https://github.com/CodeMiniCommunity/codemini-ide.git
cd codemini-ide
npm start      # http://localhost:3000
npm test
npm install && npx playwright install chromium   # only needed for e2e
npm run test:e2e
```

There is no build step and no dependencies to install. Edit a file, refresh the page.

## Guidelines

- Keep it dependency-free: plain HTML, CSS and JavaScript, with runtime libraries loaded from CDNs.
- Match the surrounding style (4-space indent, see `.editorconfig`).
- Comments should explain *why*, not *what*.
- Test in at least one Chromium-based browser and one other (Firefox or Safari) when touching storage, the service worker or the editor.
- If you touch the service worker: test a fresh install, an update from the previous version, and offline reload.

## Adding, renaming or moving files

When releasing a new version, change it in `package.json`, `js/core/app-info.js` and `CACHE_NAME` in `sw.js` together (`npm test` checks they match).

Update `index.html` (script order matters), the `STATIC_ASSETS` list in `sw.js`, and bump `CACHE_NAME`.

## Pull requests

Keep PRs focused, describe how you tested, and make sure `npm test` and `npm run test:e2e` pass. CI runs both on every PR. New user-facing behavior should come with an e2e suite or additions to an existing one (see `tests/e2e/`).

## Reporting bugs

Use the issue templates. Include browser, OS, whether the app was installed as a PWA, and any console errors.
