# Changelog

The app currently reports itself as v1.0.0 (Settings > About / Updates).

## Unreleased

- Reorganized the repository into `css/`, `js/<area>/` and `tests/` folders.
- Added README, LICENSE, CONTRIBUTING, SECURITY, third-party notices, CI and issue/PR templates.
- Added Playwright end-to-end suites under `tests/e2e/` with a dependency-free runner (`npm run test:e2e`) and a CI job.
- Added `js/core/app-info.js` as the single source for version and project links; Settings > About now links to the real License, Privacy Policy, GitHub repository, issue tracker, third-party notices and security policy.
- "Send Feedback" now opens an email addressed to the maintainer (it had no recipient).
- About page now states the MIT license instead of "All rights reserved".
- Added `PRIVACY.md`.
- Bumped the service worker static cache so installed copies pick up the new file paths.
