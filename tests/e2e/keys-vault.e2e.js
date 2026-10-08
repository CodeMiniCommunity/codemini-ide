// "My Keys" (the encrypted vault sidebar): setup, lock/unlock, CRUD, automatic locking, backup, erase, and
// the guarantees that matter: nothing readable in storage or in the page while locked, and no HTML injection.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const NOISE = /monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i;
const PW = 'correct horse battery staple', PW2 = 'another long passphrase 42';
const SECRET = 'sk-test-SECRET-9f8e7d6c', NAME = 'OpenAI prod', SERVICE = 'OpenAI', NOTES = 'billing key for the team';

async function boot(browser, viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8765' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
  });
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.goto('http://localhost:8765/index.html'); await sleep(3500);
  return { page, errors, context };
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  let { page, errors, context } = await boot(browser, { width: 1280, height: 800 });
  const ev = (f, a) => page.evaluate(f, a);
  const screen = () => ev(() => document.getElementById('kvRoot').dataset.screen);
  const waitScreen = (s, ms = 15000) => page.waitForFunction((x) => document.getElementById('kvRoot').dataset.screen === x, s, { timeout: ms }).then(() => true, () => false);
  const isOpen = () => ev(() => document.getElementById('keysSidebar').classList.contains('open'));
  const openVault = async () => { if (await isOpen()) return; await page.click('#mainMenuBtnItem'); await sleep(150); await page.click('#menuKeys'); await sleep(350); };
  const closeVault = async () => { await page.click('#keysSidebar [data-k="close"]'); await sleep(350); };
  const tab = async (name) => { await page.click(`#keysSidebar [data-k="tab"][data-tab="${name}"]`); await sleep(120); };
  const unlock = async (pw) => { await page.fill('#kvPw', pw); await page.click('#kvUnlock'); };
  const storage = () => ev(() => JSON.stringify(Object.assign({}, localStorage)));
  const pageText = () => ev(() => document.body.innerText + document.body.innerHTML);
  const act = async (k) => { await page.hover('.keys-item-main'); await page.click(`.keys-item-main [data-k="${k}"]`); };
  const importFile = async (file) => { const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-k="import-pick"]')]); await fc.setFiles(file); await sleep(300); };
  const leaks = async (needles) => { const [s, p] = [await storage(), await pageText()]; return needles.filter(n => s.includes(n) || p.includes(n)); };

  console.log('\n[first use: setup is a full-sidebar screen, not a modal]');
  await openVault();
  ok(await screen() === 'setup', 'opening My Keys for the first time shows the password setup screen');
  const lay = await ev(() => { const sb = document.getElementById('keysSidebar').getBoundingClientRect(), sc = document.querySelector('.keys-screen').getBoundingClientRect(); return { sbW: Math.round(sb.width), scW: Math.round(sc.width), sbH: Math.round(sb.height), scH: Math.round(sc.height), tabs: !!document.querySelector('#keysSidebar .keys-tabs'), modal: !!document.querySelector('#islandModal.show, .modal-backdrop.show, #modalBackdrop.show'), title: document.querySelector('.keys-title').textContent, refreshHidden: document.querySelector('[data-k="refresh"]').classList.contains('hidden') }; });
  ok(lay.scW >= lay.sbW - 2 && lay.scH >= lay.sbH * 0.8, 'the screen fills the sidebar', lay);
  ok(!lay.tabs && !lay.modal, 'no tabs behind it and no modal');
  ok(lay.title === 'My Keys' && lay.refreshHidden, 'header: title left; refresh is hidden until unlocked, close is available');
  ok(await ev(() => !!document.querySelector('.keys-header .keys-icons [data-k="close"]')), 'close icon is on the right');
  ok(await ev(() => document.getElementById('menuKeys').classList.contains('active')), 'menu item shows as active');

  console.log('\n[password rules]');
  const canCreate = () => ev(() => !document.getElementById('kvCreate').disabled);
  await page.fill('#kvPw1', 'short'); await page.fill('#kvPw2', 'short'); await page.check('#kvAck');
  ok(!(await canCreate()), 'a short password is refused');
  await page.fill('#kvPw1', 'password123'); await page.fill('#kvPw2', 'password123');
  ok(!(await canCreate()), 'a common password is refused');
  await page.fill('#kvPw1', PW); await page.fill('#kvPw2', 'something else entirely');
  ok(!(await canCreate()) && /do not match/.test(await ev(() => document.getElementById('kvErr').textContent)), 'mismatched confirmation is refused with a message');
  await page.fill('#kvPw2', PW); await page.uncheck('#kvAck');
  ok(!(await canCreate()), 'the "no recovery" acknowledgement is required');
  await page.check('#kvAck');
  ok(await canCreate(), 'a strong, matching, acknowledged password enables Create');
  ok(/Strong/.test(await ev(() => document.getElementById('kvM1Label').textContent)), 'strength meter reports it');
  await ev(() => document.getElementById('kvPw1').nextElementSibling.click());
  ok(await ev(() => document.getElementById('kvPw1').type === 'text'), 'the eye button shows the password');
  await ev(() => document.getElementById('kvPw1').nextElementSibling.click());

  console.log('\n[create the vault]');
  await page.click('#kvCreate');
  ok(await waitScreen('main'), 'vault created and unlocked');
  ok(await ev(() => [...document.querySelectorAll('.keys-tab')].map(t => t.textContent.replace(/\s*\(\d+\)/, '')).join('|') === 'Add Keys|My Keys|Config'), 'tabs: Add Keys, My Keys, Config');
  ok(await ev(() => document.querySelector('.keys-tab.active').dataset.tab === 'add'), 'an empty vault starts on Add Keys');
  ok(await ev(() => !document.querySelector('[data-k="refresh"]').classList.contains('hidden')), 'refresh icon is available once unlocked');
  const rec = await ev(() => JSON.parse(localStorage.getItem('codemini_vault_win_default')));
  ok(rec && rec.iter === 600000 && rec.kdf === 'PBKDF2-SHA256' && !('password' in rec), 'stored record uses PBKDF2 with 600,000 iterations and no password field', rec && { iter: rec.iter, kdf: rec.kdf });
  ok(!(await storage()).includes(PW), 'the password is stored nowhere');

  console.log('\n[add keys]');
  await page.fill('#kvName', NAME); await page.fill('#kvService', SERVICE); await page.fill('#kvValue', SECRET); await page.fill('#kvNotes', NOTES);
  await page.click('#kvSaveEntry');
  await page.waitForFunction(() => document.querySelectorAll('.keys-item').length === 1, null, { timeout: 8000 }).catch(() => {});
  ok(await ev(() => document.querySelector('.keys-tab.active').dataset.tab === 'my' && document.querySelectorAll('.keys-item').length === 1), 'saved key appears under My Keys');
  ok(await ev(() => document.getElementById('kvCount').textContent === '1'), 'the list header shows the count');
  ok(await ev(() => !document.getElementById('kvSecret') && !!document.querySelector('.keys-item .keys-item-name')), 'the value is not in the page until revealed');
  const inStorage = (await storage());
  ok([SECRET, NAME, SERVICE, NOTES].every(x => !inStorage.includes(x)), 'name, service, notes and value are not readable in localStorage', [SECRET, NAME, SERVICE, NOTES].filter(x => inStorage.includes(x)));
  ok(!(await pageText()).includes(SECRET), 'the secret value is not in the page while it is masked');
  await tab('add');
  await page.fill('#kvName', ''); await page.click('#kvSaveEntry');
  ok(/name/i.test(await ev(() => document.getElementById('kvAddErr').textContent)), 'a name is required');
  await page.fill('#kvName', 'No value'); await page.click('#kvSaveEntry');
  ok(/value/i.test(await ev(() => document.getElementById('kvAddErr').textContent)), 'a value is required');
  await page.check('#kvMulti');
  ok(await ev(() => document.getElementById('kvValue').tagName === 'TEXTAREA'), 'multi-line mode swaps in a textarea');
  await page.uncheck('#kvMulti'); await page.fill('#kvName', ''); 

  console.log('\n[list design: flat rows with a dashed bottom border, as designed]');
  await tab('my');
  const row = await ev(() => { const it = document.querySelector('.keys-item'); const cs = getComputedStyle(it); const sc = document.querySelector('.keys-item-main'); return { bb: cs.borderBottomStyle, bt: cs.borderTopStyle, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow, actions: getComputedStyle(document.querySelector('.keys-item-actions')).display, cards: document.querySelectorAll('.keys-card').length, nameSize: getComputedStyle(document.querySelector('.keys-item-name')).fontSize, metaSize: getComputedStyle(document.querySelector('.keys-item-meta')).fontSize }; });
  ok(row.bb === 'dashed' && row.bt === 'none' && row.radius === '0px' && row.shadow === 'none' && row.cards === 0, 'each key is a list row with a dashed bottom border (no card, no radius, no shadow)', row);
  ok(row.nameSize === '12px' && row.metaSize === '10px', 'row text sizes are 12px / 10px', row);
  ok(row.actions === 'none', 'row actions are tucked away until hover (until hover)', row.actions);
  await page.hover('.keys-item-main');
  ok(await ev(() => getComputedStyle(document.querySelector('.keys-item-actions')).display) === 'flex', 'and appear on hover');
  const sizes = await ev(() => { const g = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop]; return { tab: g('.keys-tab', 'fontSize') + '/' + g('.keys-tab', 'paddingTop'), title: g('.keys-title', 'fontSize'), search: g('#kvSearch', 'fontSize') + '/' + g('#kvSearch', 'paddingTop') + '/' + g('#kvSearch', 'borderTopLeftRadius') }; });
  ok(sizes.tab === '12px/9px' && sizes.title === '15px' && sizes.search === '12px/7px/4px', 'tabs, title and inputs use the vault sizes', sizes);

  console.log('\n[reveal, copy, search]');
  await tab('my');
  await act('reveal');
  ok(await ev(() => document.getElementById('kvSecret') && document.getElementById('kvSecret').textContent) === SECRET, 'reveal shows the value');
  await act('reveal');
  ok(await ev(() => !document.getElementById('kvSecret')) && !(await pageText()).includes(SECRET), 'reveal again hides it');
  await act('copy'); await sleep(300);
  ok(await ev(() => navigator.clipboard.readText()) === SECRET, 'copy puts the value on the clipboard');
  await page.fill('#kvSearch', 'zzz');
  ok(await ev(() => document.querySelectorAll('.keys-item').length === 0 && /No keys match/.test(document.getElementById('kvList').textContent)), 'search with no match says so');
  await page.fill('#kvSearch', 'openai');
  ok(await ev(() => document.querySelectorAll('.keys-item').length === 1), 'search matches by service, case-insensitively');
  await page.fill('#kvSearch', '');

  console.log('\n[auto-hide of a revealed key]');
  await tab('config');
  await page.selectOption('[data-cfg="revealSec"]', '10');
  await tab('my'); await act('reveal');
  ok(await ev(() => !!document.getElementById('kvSecret')), 'revealed');
  await sleep(10600);
  ok(await ev(() => !document.getElementById('kvSecret')) && !(await pageText()).includes(SECRET), 'hides itself after the chosen time');

  console.log('\n[edit and delete]');
  await act('edit'); await sleep(150);
  ok(await ev(() => document.querySelector('.keys-tab.active').dataset.tab === 'add' && document.querySelector('#kvAddForm .keys-sec-title').textContent === 'Edit key' && document.getElementById('kvName').value === 'OpenAI prod' && document.getElementById('kvValue').value === ''), 'edit opens the form pre-filled, with the value left blank (never put into the page)');
  await page.fill('#kvName', 'OpenAI staging'); await page.click('#kvSaveEntry');
  await page.waitForFunction(() => document.querySelector('.keys-item-name') && document.querySelector('.keys-item-name').textContent === 'OpenAI staging', null, { timeout: 8000 }).catch(() => {});
  ok(await ev(() => document.querySelector('.keys-item-name').textContent) === 'OpenAI staging', 'renamed');
  await act('reveal');
  ok(await ev(() => document.getElementById('kvSecret').textContent) === SECRET, 'a blank value on edit keeps the stored value');
  await act('reveal');
  await act('delete');
  ok(await ev(() => /cannot be undone/.test(document.querySelector('.keys-confirm').textContent)), 'delete asks for confirmation');
  await page.click('[data-k="delete-no"]');
  ok(await ev(() => document.querySelectorAll('.keys-item').length === 1), 'cancel keeps the key');

  console.log('\n[service chips]');
  await tab('add');
  await page.click('.keys-chip[data-service="GitHub"]');
  ok(await ev(() => document.getElementById('kvService').value) === 'GitHub', 'clicking a service chip fills the Service field');
  const btn = await ev(() => { const b = document.getElementById('kvSaveEntry'), i = document.getElementById('kvName'); const cs = getComputedStyle(b); return { btn: cs.fontSize + '/' + cs.paddingTop + '/' + cs.borderTopLeftRadius, input: getComputedStyle(i).fontSize + '/' + getComputedStyle(i).paddingTop }; });
  ok(btn.btn === '12px/8px/4px' && btn.input === '12px/7px', 'button (12px, 8px padding, 4px radius) and input sizes are correct', btn);
  await page.fill('#kvService', ''); await tab('my');

  console.log('\n[no HTML injection]');
  await tab('add');
  await page.fill('#kvName', '<img src=x onerror="window.__xss=1">'); await page.fill('#kvService', '<b>bold</b>'); await page.fill('#kvValue', '<script>window.__xss=2</script>'); await page.fill('#kvNotes', '<i>x</i>');
  await page.click('#kvSaveEntry'); await sleep(2500);
  ok(await ev(() => window.__xss === undefined && !document.querySelector('.keys-item img, .keys-item-name *, .keys-item-meta *, .keys-item-notes *')), 'markup in name/service/notes is shown as text and never runs');
  ok(await ev(() => [...document.querySelectorAll('.keys-item-name')].some(e => e.textContent.includes('<img src=x'))), 'it is displayed literally');
  await act('reveal'); await sleep(100);
  ok(await ev(() => window.__xss === undefined), 'a revealed value containing a <script> tag does not run either');
  // remove the XSS entry again
  await act('delete'); await page.click('[data-k="delete-yes"]'); await sleep(2200);
  ok(await ev(() => document.querySelectorAll('.keys-item').length) === 1, 'test entry removed');

  console.log('\n[locking: sidebar close, then password again]');
  await closeVault();
  ok(!(await ev(() => !!document.querySelector('.keys-item'))) && (await leaks([SECRET, 'OpenAI staging', SERVICE, NOTES])).length === 0, 'closing the sidebar removes every key from the page');
  await openVault();
  ok(await screen() === 'locked', 'reopening shows the full-screen password prompt (default: lock when the sidebar closes)');
  ok(await ev(() => !document.querySelector('#keysSidebar .keys-tabs')), 'no tabs or data behind the lock screen');
  await unlock('wrong password here'); await page.waitForFunction(() => /Incorrect/.test(document.getElementById('kvErr').textContent), null, { timeout: 8000 }).catch(() => {});
  ok(await screen() === 'locked' && /Incorrect password/.test(await ev(() => document.getElementById('kvErr').textContent)), 'wrong password: stays locked with an error');
  await unlock(PW);
  ok(await waitScreen('main'), 'correct password unlocks');
  ok(await ev(() => document.querySelector('.keys-item-name').textContent) === 'OpenAI staging', 'entries are back after unlocking');
  await page.click('[data-k="refresh"]'); await sleep(300);
  ok(await ev(() => document.getElementById('kvToast').textContent) === 'Refreshed', 'refresh reloads the list');
  await page.click('.keys-toolbar [data-k="lock"]'); await sleep(200);
  ok(await screen() === 'locked', 'the lock button locks immediately');

  console.log('\n[too many wrong attempts]');
  for (let i = 0; i < 5; i++) { await unlock('nope nope nope ' + i); await page.waitForFunction((k) => !document.getElementById('kvUnlock').disabled || /Too many/.test(document.getElementById('kvErr').textContent), i, { timeout: 8000 }).catch(() => {}); await sleep(150); }
  ok(await ev(() => document.getElementById('kvUnlock').disabled && /Too many attempts/.test(document.getElementById('kvErr').textContent)), 'five failures lock the form for a while');
  await ev(() => localStorage.removeItem('codemini_vaultguard_win_default')); await page.reload(); await sleep(3500);

  console.log('\n[restored locked after a reload]');
  ok(await isOpen() && await screen() === 'locked', 'the sidebar comes back open but locked (an unlocked state is never restored)');
  await unlock(PW); ok(await waitScreen('main'), 'unlocked again');

  console.log('\n[other automatic locks]');
  await tab('config');
  await page.uncheck('[data-cfg="lockOnClose"]');
  await closeVault(); await openVault();
  ok(await screen() === 'main', 'with "lock when the sidebar closes" off, it stays unlocked');
  await tab('config'); await page.check('[data-cfg="lockOnClose"]');
  await page.check('[data-cfg="lockOnHide"]');
  await ev(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(200);
  ok(await screen() === 'locked' && /background/.test(await ev(() => document.querySelector('.keys-screen-sub').textContent)), 'locks when the app goes to the background (when enabled)');
  await ev(() => { delete document.hidden; });
  await unlock(PW); await waitScreen('main');
  await tab('config'); await page.uncheck('[data-cfg="lockOnHide"]');
  await ev(() => localStorage.setItem('codemini_active_window', 'win_other'));
  await page.click('[data-k="refresh"]'); await sleep(300);
  ok(await screen() === 'setup', 'switching windows locks it, and the other window has its own (empty) vault');
  await ev(() => localStorage.setItem('codemini_active_window', 'win_default'));
  await page.reload(); await sleep(3500);
  await unlock(PW); await waitScreen('main');

  console.log('\n[idle auto-lock]');
  await page.clock.install(); // timers created from here on follow the fake clock
  await page.click('.keys-toolbar [data-k="lock"]'); await sleep(200);
  await unlock(PW); await waitScreen('main');
  await tab('config'); await page.selectOption('[data-cfg="idleMin"]', '1');
  await page.clock.fastForward('00:40'); await sleep(100);
  ok(await screen() === 'main', 'still unlocked after 40 seconds idle');
  await page.clock.fastForward('01:30'); await sleep(200);
  ok(await screen() === 'locked' && /idle/.test(await ev(() => document.querySelector('.keys-screen-sub').textContent)), 'locks after the chosen idle time');
  await page.clock.resume();

  console.log('\n[change password]');
  await unlock(PW); await waitScreen('main'); await tab('config');
  await page.fill('#kvCurPw', 'not my password'); await page.fill('#kvNewPw', PW2); await page.fill('#kvNewPw2', PW2);
  await page.click('#kvChangePw'); await page.waitForFunction(() => /incorrect/i.test(document.getElementById('kvPwErr').textContent), null, { timeout: 8000 }).catch(() => {});
  ok(/incorrect/i.test(await ev(() => document.getElementById('kvPwErr').textContent)), 'a wrong current password is refused');
  await page.fill('#kvCurPw', PW); await page.fill('#kvNewPw', 'weak'); await page.fill('#kvNewPw2', 'weak'); await page.click('#kvChangePw');
  ok(await ev(() => document.getElementById('kvPwErr').textContent.length > 0), 'a weak new password is refused');
  await page.fill('#kvNewPw', PW2); await page.fill('#kvNewPw2', PW2); await page.click('#kvChangePw');
  await page.waitForFunction(() => /Password changed/.test(document.getElementById('kvPwErr').textContent), null, { timeout: 10000 }).catch(() => {});
  ok(/Password changed/.test(await ev(() => document.getElementById('kvPwErr').textContent)), 'password changed');
  await page.click('.keys-pane[data-pane="config"] [data-k="lock"]'); await sleep(200);
  await unlock(PW); await page.waitForFunction(() => /Incorrect/.test(document.getElementById('kvErr').textContent), null, { timeout: 8000 }).catch(() => {});
  ok(await screen() === 'locked', 'the old password no longer works');
  await unlock(PW2); ok(await waitScreen('main'), 'the new password works');
  ok(await ev(() => document.querySelector('.keys-item-name').textContent) === 'OpenAI staging', 'keys survived the password change');

  console.log('\n[backup]');
  await tab('config');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-k="export"]')]);
  const file = path.join(os.tmpdir(), 'kv-backup.json'); await dl.saveAs(file);
  const raw = fs.readFileSync(file, 'utf8');
  ok(/^codemini-keys-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()) && JSON.parse(raw).type === 'codemini-vault', 'export downloads the encrypted record');
  ok([SECRET, 'OpenAI', NOTES].every(s => !raw.includes(s)), 'the backup file contains no readable data');
  await importFile(file);
  await page.fill('#kvImpPw', PW2); await page.click('#kvImpGo');
  await page.waitForFunction(() => /Imported/.test(document.getElementById('kvBackupMsg').textContent), null, { timeout: 12000 }).catch(() => {});
  ok(/Imported 0 new and updated 0 existing/.test(await ev(() => document.getElementById('kvBackupMsg').textContent)), 'importing the same backup changes nothing (merge, no duplicates)');
  await tab('my'); await act('delete'); await page.click('[data-k="delete-yes"]'); await sleep(2200);
  ok(await ev(() => document.querySelectorAll('.keys-item').length) === 0, 'deleted the only key');
  await tab('config'); await importFile(file);
  await page.fill('#kvImpPw', 'wrong'); await page.click('#kvImpGo');
  await page.waitForFunction(() => /Incorrect/.test(document.getElementById('kvBackupMsg').textContent), null, { timeout: 12000 }).catch(() => {});
  ok(/Incorrect password for that backup/.test(await ev(() => document.getElementById('kvBackupMsg').textContent)), 'a wrong backup password is refused');
  await page.fill('#kvImpPw', PW2); await page.click('#kvImpGo');
  await page.waitForFunction(() => /Imported 1 new/.test(document.getElementById('kvBackupMsg').textContent), null, { timeout: 12000 }).catch(() => {});
  ok(/Imported 1 new/.test(await ev(() => document.getElementById('kvBackupMsg').textContent)), 'restoring from the backup brings the key back');
  fs.writeFileSync(file, '{"not":"a backup"}'); await importFile(file);
  ok(/not a valid/.test(await ev(() => document.getElementById('kvBackupMsg').textContent)), 'a file that is not a backup is rejected');

  console.log('\n[forgot password / erase]');
  await ev(() => window.CodeMiniKeys.lock()); await sleep(200);
  await page.click('[data-k="forgot"]');
  ok(await screen() === 'forgot' && await ev(() => document.getElementById('kvEraseBtn').disabled), 'forgot password opens a full-screen erase confirmation, disabled until ERASE is typed');
  await page.click('[data-k="erase-cancel"]');
  ok(await screen() === 'locked', 'cancel returns to the password prompt');
  await page.click('[data-k="forgot"]'); await page.fill('#kvEraseConfirm', 'erase');
  ok(await ev(() => document.getElementById('kvEraseBtn').disabled), 'the confirmation is case-sensitive');
  await page.fill('#kvEraseConfirm', 'ERASE'); await page.click('#kvEraseBtn'); await sleep(300);
  ok(await screen() === 'setup' && await ev(() => !localStorage.getItem('codemini_vault_win_default') && !localStorage.getItem('codemini_vaultcfg_win_default')), 'erased: back to first-time setup and the stored data is gone');

  console.log('\n[unlocked erase from Config]');
  await page.fill('#kvPw1', PW); await page.fill('#kvPw2', PW); await page.check('#kvAck'); await page.click('#kvCreate'); await waitScreen('main');
  await tab('config'); await page.click('#kvEraseOpen'); await sleep(200);
  ok(await screen() === 'forgot', 'Erase vault in Config asks for confirmation on a full screen');
  await page.click('[data-k="erase-cancel"]'); ok(await screen() === 'main', 'cancel keeps you unlocked');

  console.log('\n[settings reset does not touch the vault]');
  ok(await ev(() => !!localStorage.getItem('codemini_vault_win_default')), 'vault record present (guarded by the reset exclusion list; see tests/my-keys.test.js)');
  ok(errors.filter(e => !NOISE.test(e)).length === 0, 'no page errors', errors.filter(e => !NOISE.test(e)));
  await context.close();

  console.log('\n[mobile layout]');
  ({ page, errors, context } = await boot(browser, { width: 390, height: 780 }));
  await page.evaluate(() => { document.getElementById('mainMenuBtnItem').click(); });
  await sleep(200); await page.evaluate(() => document.getElementById('menuKeys').click()); await sleep(500);
  const m = await page.evaluate(() => { const sb = document.getElementById('keysSidebar'), r = sb.getBoundingClientRect(), sc = document.querySelector('.keys-screen'); return { open: sb.classList.contains('open'), w: Math.round(r.width), vw: innerWidth, overflow: sc.scrollWidth > sc.clientWidth, screen: document.getElementById('kvRoot').dataset.screen }; });
  ok(m.open && m.w >= m.vw - 60 && !m.overflow && m.screen === 'setup', 'on a phone the setup screen fills the width with no sideways scrolling', m);
  ok(errors.filter(e => !NOISE.test(e)).length === 0, 'no page errors on mobile', errors);
  await context.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });