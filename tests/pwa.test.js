// Keeps the PWA wiring honest: manifest, icon files, <head> links and the service worker precache list must agree.
// The icon checks read real PNG headers, so a JPEG renamed to .png (it happens) fails here instead of in the browser.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p.replace(/^\//, '')));
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngSize(file) {
  const b = fs.readFileSync(path.join(root, file.replace(/^\//, '')));
  assert.ok(b.subarray(0, 8).equals(PNG_SIG), `${file} is not a real PNG (bad signature)`);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

const manifest = JSON.parse(read('manifest.json'));
const html = read('index.html');
const sw = read('sw.js');
const precache = [...sw.matchAll(/^\s*'(\/[^']*)'/gm)].map((m) => m[1]);

console.log('manifest');
t('has identity, scope and a start_url inside the scope', () => {
  for (const k of ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'background_color', 'theme_color']) assert.ok(manifest[k], `missing ${k}`);
  assert.ok(manifest.start_url.startsWith(manifest.scope));
});
t('every icon exists, is a real PNG and has the size it declares', () => {
  assert.ok(manifest.icons.length >= 4);
  for (const i of manifest.icons) {
    assert.ok(exists(i.src), `${i.src} is missing`);
    assert.strictEqual(pngSize(i.src), i.sizes, `${i.src} is not ${i.sizes}`);
    assert.strictEqual(i.type, 'image/png');
  }
});
t('provides 192 and 512 icons for both "any" and "maskable"', () => {
  for (const purpose of ['any', 'maskable'])
    for (const size of ['192x192', '512x512'])
      assert.ok(manifest.icons.some((i) => i.purpose === purpose && i.sizes === size), `no ${purpose} ${size} icon`);
});
t('no icon claims "any maskable" (one file should not serve both purposes)', () => {
  assert.ok(!manifest.icons.some((i) => /\bany\b.*\bmaskable\b|\bmaskable\b.*\bany\b/.test(i.purpose || '')));
});

console.log('shortcuts');
t('every shortcut has a name and a url inside the scope, and there are at most four (Android shows only four)', () => {
  const sc = manifest.shortcuts || [];
  assert.ok(sc.length >= 1 && sc.length <= 4, `expected 1-4 shortcuts, got ${sc.length}`);
  for (const s of sc) {
    assert.ok(s.name && s.short_name, 'shortcut needs name and short_name');
    assert.ok(new URL(s.url, 'https://x' + manifest.scope).pathname.startsWith(manifest.scope), `${s.url} is outside the scope`);
  }
});
t('every shortcut points at an ?action= that app.js handles (and every handled action has a shortcut)', () => {
  const app = read('js/core/app.js');
  const block = app.slice(app.indexOf('const LAUNCH_ACTIONS = {'), app.indexOf('let pending = null;'));
  const handled = [...block.matchAll(/^\s*'([a-z-]+)':\s*\(\)\s*=>/gm)].map((m) => m[1]).sort();
  assert.ok(handled.length >= 1, 'LAUNCH_ACTIONS not found in app.js');
  const used = manifest.shortcuts.map((s) => new URL(s.url, 'https://x/').searchParams.get('action')).sort();
  assert.deepStrictEqual(used, handled);
});
t('every launch action drives a control that exists in index.html', () => {
  const app = read('js/core/app.js');
  const block = app.slice(app.indexOf('const LAUNCH_ACTIONS = {'), app.indexOf('let pending = null;'));
  for (const id of new Set([...block.matchAll(/'([A-Za-z]+(?:Item|File))'/g)].map((m) => m[1])))
    assert.ok(html.includes(`id="${id}"`), `#${id} is not in index.html`);
});
t('app.js runs the action after the session restore, and shortcuts open a URL the service worker can serve offline', () => {
  assert.ok(/window\.runLaunchAction\(\)/.test(read('js/core/app.js')), 'loadFilesFromDB should call runLaunchAction');
  assert.ok(/ignoreSearch:\s*isNavigation/.test(sw), 'navigations with a query string must still find the cached shell');
});

console.log('screenshots (richer install dialog)');
t('declared screenshots exist, are real PNGs of the declared size, and follow the Chrome rules', () => {
  const shots = manifest.screenshots || [];
  const by = { wide: [], narrow: [] };
  for (const sh of shots) {
    assert.ok(exists(sh.src), `${sh.src} is missing`);
    assert.strictEqual(sh.type, 'image/png');
    assert.strictEqual(pngSize(sh.src), sh.sizes, `${sh.src} is not ${sh.sizes}`);
    assert.ok(sh.form_factor === 'wide' || sh.form_factor === 'narrow', `${sh.src}: form_factor must be wide or narrow`);
    assert.ok(sh.label, `${sh.src}: add a label (shown to screen readers)`);
    const [w, h] = sh.sizes.split('x').map(Number);
    assert.ok(Math.min(w, h) >= 320 && Math.max(w, h) <= 3840, `${sh.src}: sides must be 320-3840px`);
    assert.ok(Math.max(w, h) / Math.min(w, h) <= 2.3, `${sh.src}: aspect ratio must not exceed 2.3:1`);
    if (sh.form_factor === 'wide') assert.ok(w > h, `${sh.src}: wide must be landscape`); else assert.ok(h > w, `${sh.src}: narrow must be portrait`);
    by[sh.form_factor].push(sh.sizes);
  }
  assert.ok(by.wide.length <= 8 && by.narrow.length <= 5, 'at most 8 wide and 5 narrow screenshots are shown');
  for (const k of ['wide', 'narrow']) assert.ok(new Set(by[k]).size <= 1, `all ${k} screenshots should share one size so the dialog does not jump`);
});

console.log('index.html');
t('links the manifest, favicons and apple-touch-icon, and every linked icon exists', () => {
  assert.ok(/rel="manifest"/.test(html));
  const hrefs = [...html.matchAll(/<link[^>]+rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 3, 'expected favicon + apple-touch-icon links');
  assert.ok(html.includes('rel="apple-touch-icon"'));
  for (const h of hrefs) assert.ok(exists(h), `${h} is missing`);
});
t('apple-touch-icon is 180x180', () => assert.strictEqual(pngSize('/icons/apple-touch-icon.png'), '180x180'));
t('pwa.js is loaded, and registration is not duplicated inline', () => {
  assert.ok(html.includes('js/core/pwa.js'));
  assert.ok(!/serviceWorker\.register/.test(html), 'service worker registration should live in js/core/pwa.js only');
});
t('Settings > About logo points at an existing file', () => {
  const m = read('js/core/settings-profile.js').match(/<img src="([^"]*icons\/[^"]+)" alt="CodeMini Logo"/);
  assert.ok(m, 'About logo <img> not found');
  assert.ok(exists(m[1]), `${m[1]} is missing`);
});

console.log('service worker');
t('precaches every manifest icon, the favicons and pwa.js', () => {
  for (const i of manifest.icons) assert.ok(precache.includes(i.src), `${i.src} is not precached`);
  for (const f of ['/icons/apple-touch-icon.png', '/icons/favicon-32.png', '/icons/favicon-16.png', '/icons/favicon.ico', '/js/core/pwa.js', '/manifest.json'])
    assert.ok(precache.includes(f), `${f} is not precached`);
});
t('every precached path exists (a 404 here makes the whole install fail)', () => {
  for (const p of precache.filter((p) => p !== '/')) assert.ok(exists(p), `${p} is missing`);
});

console.log('hosting');
t('vercel.json is valid, keeps sw.js uncached and serves the manifest as application/manifest+json', () => {
  const v = JSON.parse(read('vercel.json')), by = (src) => (v.headers.find((h) => h.source === src) || { headers: [] }).headers;
  assert.ok(by('/sw.js').some((h) => h.key === 'Cache-Control' && /no-cache/.test(h.value)));
  assert.ok(by('/manifest.json').some((h) => h.key === 'Content-Type' && h.value === 'application/manifest+json'));
});
console.log(`\n${n} pwa checks passed`);
