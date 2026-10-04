// Captures the screenshots for the richer install dialog from the RUNNING app and lists them in manifest.json.
//
//   npm install && npx playwright install chromium     (one time)
//   npm run screenshots
//
// Needs internet access: Monaco and the Remix Icon font load from CDNs, and a capture without them would show an
// empty editor and blank icons. The script checks for both and stops instead of saving a misleading picture.
// Writes screenshots/*.png and replaces the "screenshots" list in manifest.json (tests/pwa.test.js then checks it).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createServer } = require('../tests/e2e/lib/static-server');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots');
const MANIFEST = path.join(ROOT, 'manifest.json');
const PORT = 8766;

// Chrome's rules: PNG/JPEG/WebP, sides 320-3840px, longest side at most 2.3x the shortest, one size per form factor.
const FORMS = {
  wide: { viewport: { width: 1280, height: 720 }, scale: 1, mobile: false }, //  1280x720
  narrow: { viewport: { width: 390, height: 844 }, scale: 2, mobile: true }  //   780x1688
};

const SAMPLE = [
  '// A tiny to-do list that runs entirely in your browser.',
  'const todos = [];',
  '',
  'function addTodo(text) {',
  '  todos.push({ id: Date.now(), text, done: false });',
  '  render();',
  '}',
  '',
  'function toggle(id) {',
  '  const todo = todos.find((t) => t.id === id);',
  '  if (todo) todo.done = !todo.done;',
  '  render();',
  '}',
  '',
  'function render() {',
  "  const list = document.querySelector('#todos');",
  '  list.replaceChildren(...todos.map((t) => {',
  "    const li = document.createElement('li');",
  '    li.textContent = t.text;',
  "    li.className = t.done ? 'done' : '';",
  '    return li;',
  '  }));',
  '}',
  '',
  "addTodo('Try CodeMini IDE');",
  ''
].join('\n');

const click = (page, id) => page.evaluate((i) => document.getElementById(i).click(), id);

// Scenes run in order on one fresh profile per form factor. The start screen goes first, before any file exists.
const SCENES = [
  { file: 'workspace', forms: ['wide', 'narrow'], label: 'Start screen with notebooks, consoles and quick-start actions', run: async () => {} },
  {
    file: 'editor', forms: ['wide', 'narrow'], label: 'Code editor with a JavaScript file open',
    run: async (page) => {
      await click(page, 'menuNewFile');
      await page.fill('#modalInput', 'todo.js');
      await click(page, 'modalSubmit');
      await page.waitForSelector('.monaco-editor', { timeout: 20000 });
      await page.evaluate((code) => { monaco.editor.getModels().slice(-1)[0].setValue(code); }, SAMPLE);
      await page.waitForTimeout(800);
    }
  },
  {
    file: 'settings', forms: ['wide'], label: 'Settings',
    run: async (page) => {
      await click(page, 'settingsIconItem');
      await page.waitForSelector('.settings-container', { timeout: 10000 });
      await page.waitForTimeout(500);
    }
  }
];

async function assertRealApp(page) {
  const problems = await page.evaluate(async () => {
    const out = [];
    await document.fonts.ready;
    // fonts.check() says "true" when no such font was ever declared, so look for the loaded face itself.
    if (![...document.fonts].some((f) => /remixicon/i.test(f.family) && f.status === 'loaded')) out.push('the Remix Icon font did not load (icons would be blank)');
    if (!(window.monaco && window.monaco.editor && typeof window.monaco.editor.create === 'function')) out.push('Monaco did not load (the editor would be empty)');
    return out;
  });
  if (problems.length) throw new Error('Not capturing: ' + problems.join('; ') + '. Check your internet connection and retry.');
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

(async () => {
  const server = createServer(ROOT);
  await new Promise((resolve, reject) => { server.on('error', reject); server.listen(PORT, resolve); });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const shots = { wide: [], narrow: [] };
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const [form, cfg] of Object.entries(FORMS)) {
      const ctx = await browser.newContext({
        viewport: cfg.viewport, deviceScaleFactor: cfg.scale, isMobile: cfg.mobile, hasTouch: cfg.mobile,
        serviceWorkers: 'block' // never capture through a cached copy
      });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${PORT}/index.html`);
      await page.waitForFunction(() => !window.CodeMiniPreloader || !window.CodeMiniPreloader.isActive(), null, { timeout: 30000 });
      await page.waitForSelector('.tab', { timeout: 30000 });
      await assertRealApp(page);
      for (const scene of SCENES.filter((s) => s.forms.includes(form))) {
        await scene.run(page);
        const name = `${scene.file}-${form}.png`;
        await page.screenshot({ path: path.join(OUT_DIR, name), type: 'png' });
        const sizes = pngSize(path.join(OUT_DIR, name));
        shots[form].push({ src: `/screenshots/${name}`, sizes, type: 'image/png', form_factor: form, label: scene.label });
        console.log(`  ${name}  ${sizes}`);
      }
      await ctx.close();
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    manifest.screenshots = [...shots.wide, ...shots.narrow];
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\nmanifest.json now lists ${manifest.screenshots.length} screenshots. Run "npm test" to check them, and look at them before committing.`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('\nscreenshots failed:', e.message); process.exit(1); });
