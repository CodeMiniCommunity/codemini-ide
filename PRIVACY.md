# Privacy Policy

_Last updated: October 2026_

CodeMini is a static web app. It has no backend, no accounts, and no analytics or telemetry. The maintainers do not receive your files, settings or usage data.

## What stays on your device

Everything you create or configure is stored in your browser, on your device:

- **Files, folders, workspaces and notebooks:** IndexedDB.
- **Settings, themes, window/profile state and trust decisions:** `localStorage`.
- **GitHub token** (if you use the Git integration): `localStorage`, per window, **not encrypted**. Anyone with access to your browser profile can read it. Use a fine-grained token with the minimum scopes, and remove it from the Git panel when you are done.
- **Offline copies of the app and libraries:** the browser Cache Storage, managed by the service worker.

You can erase it at any time with **Settings > Application > Factory Reset**, or by clearing the site's data in your browser.

## Network requests the app makes

CodeMini does not send your files anywhere on its own. These requests do happen:

| When | Contacted | What is sent |
| --- | --- | --- |
| Loading the app and its features | Public CDNs: `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com`, `esm.sh`, `webr.r-wasm.org` | A normal HTTP request for the library (your IP address and browser details, as with any website). Cached afterwards for offline use. |
| Hosting | The site's host (currently Vercel) | A normal HTTP request for the app files. |
| You use the Git/GitHub integration | `api.github.com` | The requests you trigger (list repositories, pull, push, etc.), authenticated with your token. |
| You run the terminal `weather` command | `wttr.in` | The location you typed. |
| You run terminal package-lookup commands | `unpkg.com` | The package name you typed. |
| You run or preview your own code | Whatever your code requests | Whatever your code sends. |

These third parties have their own privacy policies.

## Feedback

**Send Feedback** in the Help tab opens your own email app with the message pre-filled, addressed to the maintainer. Nothing is sent until you press send in your email app.

## Children

CodeMini does not knowingly collect personal information from anyone, including children.

## Changes

Changes to this policy are recorded in the repository history. Questions: open an issue or email codercriss@gmail.com.
