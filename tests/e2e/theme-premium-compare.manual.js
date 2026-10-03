// MANUAL, NOT part of `npm run test:e2e`.
// One-off before/after comparison for the Premium theme work: it measures the same components in two builds
// and checks that nothing changed for the non-Premium themes.
//   port 8766 = a copy of the ORIGINAL (pre-change) app, port 8765 = the current app.
// To run it: serve the old build on 8766 and this repo on 8765, then `node tests/e2e/theme-premium-compare.manual.js`.
// Kept as a reference for how the theme/contrast checks are done; reuse the probing code for future theme changes.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };

// [key, html]. data-k marks the element under test.
const SPECS = [
  // --- floating / cards / rows / small controls / pills (radius) ---
  ['wt-dialog', '<div class="wt-dialog" data-k="wt-dialog"></div>'],
  ['git-gh-card', '<div class="git-gh-card" data-k="git-gh-card"></div>'],
  ['git-profile-card', '<div class="git-profile-card" data-k="git-profile-card"></div>'],
  ['git-commit-input', '<textarea class="git-commit-input" data-k="git-commit-input"></textarea>'],
  ['doc-swatch-grid', '<div class="doc-swatch-grid" data-k="doc-swatch-grid"></div>'],
  ['doc-symbol-grid', '<div class="doc-symbol-grid" data-k="doc-symbol-grid"></div>'],
  ['git-repo-row', '<div class="git-repo-row" data-k="git-repo-row"></div>'],
  ['git-result', '<div class="git-result" data-k="git-result"></div>'],
  ['search-result-item', '<div class="search-result-item" data-k="search-result-item"></div>'],
  ['lp-settings-radio-row', '<label class="lp-settings-radio-row" data-k="lp-settings-radio-row"></label>'],
  ['git-action-icon', '<i class="git-action-icon" data-k="git-action-icon"></i>'],
  ['bc-item', '<div class="bc-item" data-k="bc-item"></div>'],
  ['git-hint-inline', '<span class="git-hint-inline" data-k="git-hint-inline"></span>'],
  ['git-prefix-chip', '<span class="git-prefix-chip" data-k="git-prefix-chip"></span>'],
  ['git-count-badge', '<span class="git-count-badge" data-k="git-count-badge"></span>'],
  ['git-status-badge', '<span class="git-status-badge" data-k="git-status-badge"></span>'],
  ['git-tag-pill', '<span class="git-tag-pill" data-k="git-tag-pill"></span>'],
  ['git-scope-pill', '<span class="git-scope-pill" data-k="git-scope-pill"></span>'],
  ['git-commit-op', '<span class="git-commit-op" data-k="git-commit-op"></span>'],
  ['git-merge-abort', '<span class="git-merge-abort" data-k="git-merge-abort"></span>'],
  ['git-conflict-action', '<span class="git-conflict-action" data-k="git-conflict-action"></span>'],
  ['bin-timer-badge', '<span class="bin-timer-badge" data-k="bin-timer-badge"></span>'],
  ['lp-settings-tag', '<span class="lp-settings-tag" data-k="lp-settings-tag"></span>'],
  ['wt-badge', '<span class="wt-badge" data-k="wt-badge"></span>'],
  ['wt-btn(button)', '<button class="wt-btn" data-k="wt-btn(button)"></button>'],
  ['wt-manager-btn(button)', '<button class="wt-manager-btn" data-k="wt-manager-btn(button)"></button>'],
  // --- must NOT change: deliberately square / flush ---
  ['tab (exempt)', '<div class="tab" data-k="tab (exempt)"></div>'],
  ['file-item (exempt)', '<div class="file-item" data-k="file-item (exempt)"></div>'],
  ['wt-banner (exempt)', '<div class="wt-banner" data-k="wt-banner (exempt)"></div>'],
  // --- text on accent fills (colour) ---
  ['add-button', '<button class="add-button" data-k="add-button"></button>'],
  ['btn-submit', '<button class="btn-submit" data-k="btn-submit"></button>'],
  ['search-btn', '<button class="search-btn" data-k="search-btn"></button>'],
  ['git-btn', '<button class="git-btn" data-k="git-btn"></button>'],
  ['git-branch-pill', '<span class="git-branch-pill" data-k="git-branch-pill"></span>'],
  ['git-chip.active', '<button class="git-chip active" data-k="git-chip.active"></button>'],
  ['search-opt-btn.active', '<button class="search-opt-btn active" data-k="search-opt-btn.active"></button>'],
  ['ms-replace-btn', '<button class="ms-replace-btn" data-k="ms-replace-btn"></button>'],
  ['help-feedback-send-btn', '<button class="help-feedback-send-btn" data-k="help-feedback-send-btn"></button>'],
  ['update-badge', '<span class="update-badge" data-k="update-badge"></span>'],
  ['doc-status-bar', '<div class="doc-status-bar" data-k="doc-status-bar"></div>'],
  ['sm-scope-btn.active', '<button class="sm-scope-btn active" data-k="sm-scope-btn.active"></button>'],
  ['net-filter-btn.active', '<button class="net-filter-btn active" data-k="net-filter-btn.active"></button>'],
  ['mark.help-hl', '<mark class="help-hl" data-k="mark.help-hl"></mark>'],
  ['wt-btn.primary', '<button class="wt-btn primary" data-k="wt-btn.primary"></button>'],
  ['git-diff-view-toggle span.active', '<div class="git-diff-view-toggle"><span class="active" data-k="git-diff-view-toggle span.active"></span></div>'],
  ['profile-auth button.primary', '<div class="profile-auth-buttons"><button class="primary" data-k="profile-auth button.primary"></button></div>'],
];
const THEMES = [
  ['Light', 'CodeMini Light', 'None'], ['Dark', 'CodeMini Dark', 'None'], ['Light +', 'CodeMini Light +', 'None'], ['Dark +', 'CodeMini Dark +', 'None'],
  ['Premium', 'CodeMini Light', 'CodeMini Premium'], ['Premium Light', 'CodeMini Light', 'CodeMini Premium Light'],
];

async function measureAll(browser, port) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
  });
  await page.goto(`http://localhost:${port}/index.html`); await sleep(2500);
  // Several modules inject their CSS only when their panel first renders - without this the probe elements would
  // just get browser defaults and "pass" by accident.
  await page.evaluate(() => { if (window.injectGitStyles) window.injectGitStyles(); });
  for (const id of ['stackIconItem', 'searchIconItem', 'settingsIconItem']) { await page.evaluate((i) => document.getElementById(i) && document.getElementById(i).click(), id); await sleep(900); }
  const out = {};
  for (const [label, theme, pack] of THEMES) {
    await page.evaluate(([theme, pack]) => { window.saveSetting('themePack', pack); window.saveSetting('colorTheme', theme); }, [theme, pack]);
    await sleep(300);
    out[label] = await page.evaluate((specs) => {
      document.body.classList.add('no-transition');          // computed colours must not be mid-animation
      const probe = document.createElement('div'); probe.id = '__probe'; probe.style.cssText = 'position:fixed;left:-9999px;top:0;';
      probe.innerHTML = specs.map(s => s[1]).join(''); document.body.appendChild(probe);
      const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const res = {};
      for (const [key] of specs) {
        const el = probe.querySelector(`[data-k="${key.replace(/"/g, '\\"')}"]`);
        if (!el) { res[key] = null; continue; }
        const cs = getComputedStyle(el);
        const own = (prop) => { for (const ss of document.styleSheets) { let rules; try { rules = ss.cssRules; } catch (e) { continue; } for (const r of rules) { if (!r.selectorText || !r.style || !r.style.getPropertyValue(prop)) continue; if (r.selectorText.trim().startsWith('[data-theme-pack')) continue; try { if (el.matches(r.selectorText)) return true; } catch (e) {} } } return false; };
        res[key] = { radius: cs.borderTopLeftRadius, color: cs.color, bg: cs.backgroundColor, contrast: Math.round(ratio(cs.color, cs.backgroundColor) * 100) / 100, ownRadius: own('border-radius'), ownColor: own('color') };
      }
      const goto = document.getElementById('gotoLinePopover');
      res['gotoLinePopover'] = goto ? { radius: getComputedStyle(goto).borderTopLeftRadius } : null;
      probe.remove(); document.body.classList.remove('no-transition');
      return res;
    }, SPECS);
  }
  await page.context().close();
  return out;
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const before = await measureAll(browser, 8766);   // your original files
  const after = await measureAll(browser, 8765);    // patched
  await browser.close();

  console.log('\n[0] Harness sanity: every probed component is really styled by its own CSS (not browser defaults)');
  const RADIUS_KEYS = Object.keys({ 'wt-dialog':1,'git-gh-card':1,'git-profile-card':1,'git-commit-input':1,'doc-swatch-grid':1,'doc-symbol-grid':1,'git-repo-row':1,'git-result':1,'search-result-item':1,'lp-settings-radio-row':1,'git-action-icon':1,'bc-item':1,'git-hint-inline':1,'git-prefix-chip':1,'git-count-badge':1,'git-status-badge':1,'git-tag-pill':1,'git-scope-pill':1,'git-commit-op':1,'git-merge-abort':1,'git-conflict-action':1,'bin-timer-badge':1,'lp-settings-tag':1,'wt-badge':1,'wt-btn(button)':1,'wt-manager-btn(button)':1,'git-branch-pill':1 });
  const ACC0 = ['add-button','btn-submit','search-btn','git-btn','git-branch-pill','git-chip.active','search-opt-btn.active','ms-replace-btn','help-feedback-send-btn','update-badge','doc-status-bar','sm-scope-btn.active','net-filter-btn.active','mark.help-hl','wt-btn.primary','git-diff-view-toggle span.active','profile-auth button.primary'];
  const unstyled = [];
  for (const [build, data] of [['original', before], ['patched', after]]) {
    for (const k of RADIUS_KEYS) { if (build === 'original' && k.startsWith('wt-')) continue; if (!data['Light'][k] || !data['Light'][k].ownRadius) unstyled.push(`${build}:${k}:radius`); }
    for (const k of ACC0) { if (build === 'original' && k === 'wt-btn.primary') continue; if (!data['Light'][k] || !data['Light'][k].ownColor) unstyled.push(`${build}:${k}:color`); }
  }
  ok(unstyled.length === 0, 'all probed components have their own CSS loaded in both builds', unstyled);

  console.log('\n[1] No regressions: every non-Premium theme is identical to the original');
  for (const label of ['Light', 'Dark', 'Light +', 'Dark +']) {
    const diffs = [];
    for (const k of Object.keys(after[label])) {
      const b = before[label][k], a = after[label][k];
      if (!b || !a || k.startsWith('wt-')) continue;        // wt-* is new UI: the original has no such classes
      if (k === 'profile-auth button.primary' && label.startsWith('Dark')) continue;   // intentional bug fix, asserted below
      for (const prop of ['radius', 'color', 'bg']) if (b[prop] !== a[prop]) diffs.push(`${k}.${prop}: ${b[prop]} -> ${a[prop]}`);
    }
    ok(diffs.length === 0, `${label}: radius, text colour and background unchanged for every shared component`, diffs.slice(0, 6));
  }

  console.log('\n[1b] Sign-in primary button: accent fill restored in every dark-based theme');
  // Outside a pack the fill follows the user's Accent Color setting, so compare against the app's other primary button.
  for (const label of ['Dark', 'Dark +']) {
    const a = after[label]['profile-auth button.primary'], ref = after[label]['btn-submit'], b = before[label]['profile-auth button.primary'];
    ok(a.bg === ref.bg && a.bg !== b.bg, `${label}: now accent-filled like the other primary buttons (was ${b.bg}, now ${a.bg})`, { a: a.bg, ref: ref.bg });
    ok(a.color === ref.color, `${label}: same text colour as the other primary buttons`, { a: a.color, ref: ref.color });
  }
  {
    const a = after['Premium']['profile-auth button.primary'], b = before['Premium']['profile-auth button.primary'];
    ok(a.bg === 'rgb(217, 164, 65)', `Premium: gold fill (was ${b.bg})`, a.bg);
    ok(a.contrast >= 4.5, `Premium: readable text (${b.contrast}:1 -> ${a.contrast}:1)`, a.contrast);
  }
  ok(['Light', 'Light +', 'Premium Light'].every(l => after[l]['profile-auth button.primary'].bg === before[l]['profile-auth button.primary'].bg), 'light-based themes were already correct and are untouched');

  console.log('\n[2] Premium packs: radius coverage');
  const EXPECT = {
    'wt-dialog': '20px', 'gotoLinePopover': '20px',
    'git-gh-card': '14px', 'git-profile-card': '14px', 'git-commit-input': '14px', 'doc-swatch-grid': '14px', 'doc-symbol-grid': '14px',
    'git-repo-row': '10px', 'git-result': '10px', 'search-result-item': '10px', 'lp-settings-radio-row': '10px',
    'git-action-icon': '8px', 'bc-item': '8px', 'git-hint-inline': '6px',
    'git-prefix-chip': '999px', 'git-count-badge': '999px', 'git-status-badge': '999px', 'git-tag-pill': '999px', 'git-scope-pill': '999px', 'git-commit-op': '999px', 'git-merge-abort': '999px', 'git-conflict-action': '999px', 'bin-timer-badge': '999px', 'lp-settings-tag': '999px', 'wt-badge': '999px',
    'wt-btn(button)': '999px', 'wt-manager-btn(button)': '999px', 'git-branch-pill': '999px',
  };
  for (const label of ['Premium', 'Premium Light']) {
    const wrong = [], was = [];
    for (const [k, want] of Object.entries(EXPECT)) {
      const a = after[label][k]; if (!a) { wrong.push(`${k}: element missing`); continue; }
      if (a.radius !== want) wrong.push(`${k}: ${a.radius} (wanted ${want})`);
      const b = before[label][k]; if (b && b.radius !== want) was.push(k);
    }
    ok(wrong.length === 0, `${label}: all ${Object.keys(EXPECT).length} components now follow the pack's radius tiers`, wrong);
    console.log(`     (${was.length} of those were NOT adapting in your original under ${label})`);
  }
  const keepSquare = ['tab (exempt)', 'file-item (exempt)', 'wt-banner (exempt)'];
  for (const label of ['Premium', 'Premium Light']) {
    const moved = keepSquare.filter(k => before[label][k] && after[label][k] && before[label][k].radius !== after[label][k].radius);
    ok(moved.length === 0, `${label}: tabs, flush rows and docked bars deliberately left alone`, moved);
  }
  ok(!['Light', 'Dark', 'Light +', 'Dark +'].some(l => after[l]['wt-dialog'].radius !== '4px'), 'in normal themes the trust dialog keeps its ordinary 4px corners');

  console.log('\n[3] Text on accent fills');
  const COLOR_KEYS = SPECS.map(s => s[0]).filter(k => !/exempt|grid|row|card|input|item|icon|bc-|hint|chip$|badge$|op$|abort|action$|dialog|tag$|^wt-btn\(|manager|^wt-badge|pill$/.test(k) || /active|btn|bar|help|update-badge|branch/.test(k));
  const ACC = ['add-button', 'btn-submit', 'search-btn', 'git-btn', 'git-branch-pill', 'git-chip.active', 'search-opt-btn.active', 'ms-replace-btn', 'help-feedback-send-btn', 'update-badge', 'doc-status-bar', 'sm-scope-btn.active', 'net-filter-btn.active', 'mark.help-hl', 'wt-btn.primary', 'git-diff-view-toggle span.active', 'profile-auth button.primary'];
  const darkText = (c) => { const v = c.match(/[\d.]+/g).slice(0, 3).map(Number); return (v[0] + v[1] + v[2]) / 3 < 80; };
  for (const label of ['Premium']) {
    const bad = ACC.filter(k => !after[label][k] || !darkText(after[label][k].color));
    ok(bad.length === 0, `${label}: all ${ACC.length} accent-filled controls now use dark text on the gold`, bad);
    const minNew = Math.min(...ACC.map(k => after[label][k].contrast)), minOld = Math.min(...ACC.filter(k => before[label][k]).map(k => before[label][k].contrast));
    console.log(`     lowest text contrast on accent: ${minOld} (original, white on gold) -> ${minNew} (patched)`);
    ok(minNew >= 4.5, `${label}: meets 4.5:1 (WCAG AA) for every accent-filled control`, minNew);
  }
  const lightPack = ACC.map(k => after['Premium Light'][k].contrast);
  ok(Math.min(...lightPack) >= Math.min(...ACC.filter(k => before['Premium Light'][k]).map(k => before['Premium Light'][k].contrast)) - 0.2, 'Premium Light: contrast no worse than before', Math.min(...lightPack));
  ok(['Light', 'Dark', 'Light +', 'Dark +'].every(l => ACC.every(k => k.startsWith('wt-') || k === 'profile-auth button.primary' || after[l][k].color === before[l][k].color)), 'every other theme keeps exactly the same text colour (still white)');

  if (process.env.DETAIL) {
    console.log('\nDETAIL premium accent controls (patched):');
    for (const k of ACC) { const a = after['Premium'][k]; console.log(`  ${k.padEnd(36)} color=${a.color}  bg=${a.bg}  contrast=${a.contrast}`); }
    console.log('DETAIL other-theme colour diffs:');
    for (const l of ['Light', 'Dark', 'Light +', 'Dark +']) for (const k of ACC) { const b = before[l][k], a = after[l][k]; if (b && a && b.color !== a.color) console.log(`  ${l} ${k}: ${b.color} -> ${a.color}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
