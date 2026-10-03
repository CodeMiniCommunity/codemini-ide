// Keeps the in-app project metadata (Settings > About, feedback address) consistent with the repository.
const vm = require('vm'), fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const win = {};
vm.runInContext(read('js/core/app-info.js'), vm.createContext({ window: win }));
const info = win.APP_INFO, pkg = JSON.parse(read('package.json'));

console.log('app-info');
t('version matches package.json and the service worker cache name', () => {
  assert.strictEqual(info.version, pkg.version);
  assert.ok(read('sw.js').includes(`'codemini-static-v${pkg.version}'`), 'CACHE_NAME should be codemini-static-v' + pkg.version);
});
t('repo link matches package.json repository', () => {
  assert.strictEqual(info.links.repo + '.git', pkg.repository.url.replace(/^git\+/, ''));
  assert.strictEqual(info.links.issues, pkg.bugs.url);
});
t('live link matches package.json homepage', () => assert.strictEqual(info.links.live, pkg.homepage));
t('every linked repo file exists in the repository', () => {
  for (const k of ['license', 'privacy', 'security', 'notices', 'changelog']) {
    const file = info.links[k].split('/blob/main/')[1];
    assert.ok(fs.existsSync(path.join(root, file)), `${k} -> ${file} is missing`);
  }
});
t('feedback email is the maintainer address from package.json', () => assert.ok(pkg.author.includes(info.feedbackEmail)));
t('license matches LICENSE and package.json', () => {
  assert.strictEqual(info.license, pkg.license);
  assert.ok(read('LICENSE').startsWith('MIT License'));
});

console.log('wiring');
t('app-info.js loads before settings-profile.js and help-feedback.js, and is precached', () => {
  const html = read('index.html'), at = (f) => html.indexOf(`js/core/${f}.js`);
  assert.ok(at('app-info') > -1 && at('app-info') < at('settings-profile') && at('app-info') < at('help-feedback'));
  assert.ok(read('sw.js').includes("'/js/core/app-info.js'"));
});
t('Settings > About has no placeholder "#" links', () => {
  const s = read('js/core/settings-profile.js');
  const about = s.slice(s.indexOf('id="set-about"'));
  assert.ok(!/href="#"/.test(about), 'found href="#" in About');
  assert.ok(!/All rights reserved/i.test(about), 'About should state the MIT license, not "All rights reserved"');
});
t('Send Feedback addresses a recipient', () => assert.ok(/mailto:\$\{to\}/.test(read('js/core/help-feedback.js'))));
console.log(`\n${n} app-info checks passed`);
