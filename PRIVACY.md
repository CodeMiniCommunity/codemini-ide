# Privacy Policy

_Last updated: October 2026_

CodeMini is a static web app. It has no backend, no accounts, and no analytics or telemetry. The maintainers do not receive your files, settings or usage data.

## What stays on your device

Everything you create or configure is stored in your browser, on your device:

- **Files, folders, workspaces and notebooks:** IndexedDB.
- **Settings, themes, window/profile state and trust decisions:** `localStorage`.
- **Notifications:** the last 50, and when each alert was last shown, in `localStorage`. The storage warnings read your browser's own storage usage figure on the device; nothing is sent anywhere.
- **My Keys vault** (if you use it): stored as ciphertext only, in `localStorage` per window or profile. Names, services, notes and values are all encrypted with AES-256-GCM using a key derived from your vault password (PBKDF2-SHA256, 600,000 rounds). The password and the key are never stored, and there is no recovery if you forget the password. The plain-language explanation is under **My Keys > Config > How your keys are protected**.
- **GitHub token** (if you use the Git integration): stored as ciphertext in `localStorage`, per window, encrypted (AES-256-GCM) with a **device key** that CodeMini keeps in IndexedDB (`codemini_shield`). The key is created by your browser and cannot be exported, but no password protects it, so it keeps the token safe from a copy of the stored data or a leaked backup, not from someone using this open browser. It stays usable when My Keys is locked. While the page is open the token is also held in memory. A token saved by an older version is encrypted automatically the next time the page loads (or moved out of My Keys the next time you unlock it), and the old copy is deleted. If your browser cannot keep the key, the token goes into your **My Keys** vault instead. Use a fine-grained token with the minimum scopes, and remove it from the Config tab of Source Control when you no longer need it.
- **Device key** (`codemini_shield`, IndexedDB): the one encryption key described above. It holds no personal data, is not sent anywhere, is shared by all your CodeMini windows and profiles, and is removed when you clear the site's data in your browser (Factory Reset removes the data it protects, not the key).
- **Locked files and folders**: the password is never stored. Each lock keeps a random salt and a PBKDF2-SHA256 verifier (600,000 rounds), and a locked file's text is stored encrypted with AES-256-GCM. File names, sizes and dates are not encrypted, and items inside a locked folder are not individually encrypted (lock the files themselves for that). Locks made by older versions are upgraded automatically the next time the app loads.
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
