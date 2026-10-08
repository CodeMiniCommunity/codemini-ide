// ==========================================
// app-info.js - single source of truth for version, project links and contact details.
// ==========================================
// Must load BEFORE settings-profile.js (its Settings > About markup is built when that file loads)
// and help-feedback.js. Keep `version` in sync with package.json and CACHE_NAME in sw.js;
// tests/app-info.test.js fails if the repository links or version drift apart.
(function () {
    const REPO = 'https://github.com/CodeMiniCommunity/codemini-ide';
    window.APP_INFO = Object.freeze({
        name: 'CodeMini IDE',
        version: '1.3.1',
        build: '2026.04',
        copyright: 'Christian Forson and The CodeMini Community',
        license: 'MIT',
        feedbackEmail: 'codercriss@gmail.com',
        links: Object.freeze({
            repo: REPO,
            license: REPO + '/blob/main/LICENSE',
            privacy: REPO + '/blob/main/PRIVACY.md',
            issues: REPO + '/issues',
            security: REPO + '/blob/main/SECURITY.md',
            notices: REPO + '/blob/main/THIRD_PARTY_NOTICES.md',
            changelog: REPO + '/blob/main/CHANGELOG.md',
            live: 'https://the-code-mini-ide.vercel.app/'
        })
    });
})();
