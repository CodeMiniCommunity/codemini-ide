# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.
Use GitHub's private reporting instead: **Security tab > Report a vulnerability** on this repository.
If that is unavailable, email **codercriss@gmail.com** with the subject line "CodeMini security".

Include what you found, how to reproduce it, and the browser/OS you tested on.
You will get an acknowledgement as soon as the maintainer can respond.

## Scope notes

- CodeMini runs entirely in the browser. Files, settings and GitHub tokens are stored locally in IndexedDB / `localStorage` on the user's device.
- GitHub integration sends requests directly from the browser to `api.github.com` with the user's own token. Tokens are never sent anywhere else.
- Third-party libraries are loaded from public CDNs (see `THIRD_PARTY_NOTICES.md`).
