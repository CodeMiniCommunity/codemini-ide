// Now Island > Notifications, and the app-update flow that feeds it (toast, notification, Settings > Updates).
// The service worker is the real one; a new deploy is simulated by firing `controllerchange` on a page that
// already has a controller (which is exactly what the browser does when a new sw.js takes over).
const { chromium } = require('playwright');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n, x) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x !== undefined ? '-> ' + JSON.stringify(x) : '')); };
const NOISE = /monaco|pyodide|loadPyodide|initSqlJs|Failed to fetch|net::|require is not defined/i;

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, r => r.abort());
  await page.addInitScript(() => {
    const mk = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : mk()), apply: () => mk(), construct: () => mk() });
    window.require = (d, cb) => { setTimeout(() => { window.monaco = mk(); cb(); }, 0); }; window.require.config = () => {};
  });
  const ev = (f, a) => page.evaluate(f, a);
  // The icon-only status-bar button has no size when the Remix Icon font is blocked (as it is here), so click it via the DOM.
  const toggleIsland = () => ev(() => document.getElementById('nowIsland').click());
  const panelOpen = () => ev(() => document.getElementById('nowIslandPanel').classList.contains('show'));
  const items = () => ev(() => [...document.querySelectorAll('.ni-notif')].map(li => ({ id: li.dataset.id, title: li.querySelector('.ni-notif-title').textContent, unread: li.classList.contains('unread') })));
  const viewerOpen = () => ev(() => document.getElementById('niViewer').classList.contains('show'));
  const boot = async () => { await page.goto('http://localhost:8765/index.html'); await sleep(2500); };

  // First load installs the service worker; the second load is controlled by it.
  await boot(); await page.reload(); await sleep(2500);
  await ev(() => { localStorage.removeItem('codemini_notifications'); });
  await page.reload(); await sleep(2500);
  ok(await ev(() => !!navigator.serviceWorker.controller), 'page is controlled by the service worker (so an update counts as one)');

  console.log('\n[1] empty state');
  await toggleIsland();
  await ev(() => document.querySelector('.ni-tab[data-pane="notifications"]').click());
  ok(await ev(() => document.querySelector('.ni-pane[data-pane="notifications"]').classList.contains('active')), 'Notifications tab shows its pane');
  ok(await ev(() => !document.querySelector('.ni-pane[data-pane="now"]').classList.contains('active')), 'and hides the Now pane');
  ok(await ev(() => /No notifications/.test(document.querySelector('.ni-pane.active').textContent)), 'empty state is shown');
  ok(await ev(() => document.getElementById('niUnreadBadge').hidden && !document.getElementById('nowIsland').classList.contains('has-unread')), 'no unread badge or dot');

  console.log('\n[2] an app update arrives');
  await ev(() => { window.__still = 'same page'; navigator.serviceWorker.dispatchEvent(new Event('controllerchange')); });
  await sleep(300);
  ok(await ev(() => /was updated/.test(document.querySelector('.custom-toast')?.textContent || '') && /Reload/.test(document.querySelector('.custom-toast button')?.textContent || '')), 'the "was updated" toast appears with a Reload button');
  let list = await items();
  ok(list.length === 1 && list[0].title === 'Update installed' && list[0].unread, 'it also lands in Notifications, unread', list);
  ok(await ev(() => document.getElementById('niUnreadBadge').textContent === '1' && !document.getElementById('niUnreadBadge').hidden), 'the tab shows an unread count of 1');
  ok(await ev(() => document.getElementById('nowIsland').classList.contains('has-unread')), 'the status-bar button shows the unread dot');
  await sleep(1500);
  ok(await ev(() => window.__still === 'same page'), 'nothing reloaded by itself');
  await ev(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  ok((await items()).length === 1, 'a repeated signal does not add a second update notification');

  console.log('\n[3] item design');
  const d = await ev(() => {
    const li = document.querySelector('.ni-notif'), cs = getComputedStyle(li);
    const top = li.querySelector('.ni-notif-top'), title = top.querySelector('.ni-notif-title'), acts = top.querySelector('.ni-notif-actions');
    const text = li.querySelector('.ni-notif-text'), tcs = getComputedStyle(text);
    const probe = document.createElement('div'); probe.style.background = 'var(--bg-white)'; document.body.appendChild(probe);
    const white = getComputedStyle(probe).backgroundColor; probe.remove();
    const tb = title.getBoundingClientRect(), ab = acts.getBoundingClientRect(), xb = text.getBoundingClientRect(), lb = li.getBoundingClientRect();
    return { bg: cs.backgroundColor, white, borderStyle: cs.borderBottomStyle, borderWidth: cs.borderBottomWidth, clamp: tcs.webkitLineClamp,
      titleLeft: tb.left - lb.left, actsRight: lb.right - ab.right, textBelow: xb.top >= Math.max(tb.bottom, ab.bottom) - 1,
      buttons: [...acts.querySelectorAll('button')].map(b => b.getAttribute('aria-label')) };
  });
  ok(d.bg === d.white, 'item has the white (theme --bg-white) background', d);
  ok(d.borderStyle === 'dashed' && d.borderWidth === '1px', 'item has a dashed bottom border', d);
  ok(d.titleLeft < 20 && d.actsRight < 20, 'title sits top-left and the actions top-right', d);
  ok(d.textBelow, 'the text is below both');
  ok(d.clamp === '2', 'the text is cut off after two lines', d.clamp);
  ok(JSON.stringify(d.buttons) === JSON.stringify(['Mark as read', 'Delete']), 'actions are mark as read and delete', d.buttons);

  await ev(() => CodeMiniNotifications.add({ id: 'long', title: 'An extremely long notification title that cannot possibly fit on a single line of this small panel', text: 'x '.repeat(200) }));
  const trunc = await ev(() => { const t = document.querySelector('.ni-notif[data-id="long"] .ni-notif-title'), tx = document.querySelector('.ni-notif[data-id="long"] .ni-notif-text'); return { over: t.scrollWidth > t.clientWidth, ell: getComputedStyle(t).textOverflow, textH: tx.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(tx).lineHeight) }; });
  ok(trunc.over && trunc.ell === 'ellipsis', 'a long title is truncated with an ellipsis', trunc);
  ok(trunc.textH <= trunc.lh * 2 + 1, 'a long text takes no more than two lines', trunc);
  ok(await ev(() => { const t = document.querySelector('.ni-notif[data-id="long"] .ni-notif-title').getBoundingClientRect(), a = document.querySelector('.ni-notif[data-id="long"] .ni-notif-actions').getBoundingClientRect(); return t.right <= a.left + 1; }), 'and never pushes the actions out of view');
  ok((await items())[0].id === 'long', 'newest notification is on top');

  console.log('\n[4] actions on the item');
  await ev(() => document.querySelector('.ni-notif[data-id="long"] button[aria-label="Mark as read"]').click());
  ok(!(await items()).find(i => i.id === 'long').unread, 'mark as read clears the unread state');
  ok(!(await viewerOpen()), 'and does not open the viewer');
  ok(await panelOpen(), 'and does not close the island');
  ok(await ev(() => document.getElementById('niUnreadBadge').textContent === '1'), 'unread count drops to 1');
  ok(await ev(() => !document.querySelector('.ni-notif[data-id="long"] button[aria-label="Mark as read"]')), 'a read item no longer offers mark as read');
  await ev(() => document.querySelector('.ni-notif[data-id="long"] button[aria-label="Delete"]').click());
  ok(!(await items()).some(i => i.id === 'long'), 'delete removes the item');
  ok(await panelOpen(), 'and the island stays open after deleting (the clicked button is gone by the time the click reaches the document)');

  console.log('\n[5] viewer');
  await ev(() => CodeMiniNotifications.add({ id: 'v1', title: 'A long viewer title that has to be truncated before it reaches the delete icon on the right', text: 'First line of the contents.\nSecond line.' }));
  await ev(() => document.querySelector('.ni-notif[data-id="v1"]').click());
  ok(await viewerOpen(), 'tapping an item opens the viewer');
  const v = await ev(() => {
    const panel = document.getElementById('nowIslandPanel').getBoundingClientRect(), vw = document.getElementById('niViewer'), vb = vw.getBoundingClientRect();
    const back = vw.querySelector('button[aria-label="Back"]').getBoundingClientRect(), del = vw.querySelector('button[aria-label="Delete"]').getBoundingClientRect();
    const title = vw.querySelector('.ni-viewer-title'), tb = title.getBoundingClientRect(), content = vw.querySelector('.ni-viewer-content');
    const hdr = document.querySelector('.ni-header').getBoundingClientRect();
    return { covers: Math.abs(vb.left - panel.left) < 3 && Math.abs(vb.right - panel.right) < 3 && Math.abs(vb.top - panel.top) < 3 && Math.abs(vb.bottom - panel.bottom) < 3,
      coversHeader: vb.top <= hdr.top + 1, backLeftOfTitle: back.right <= tb.left + 1, titleLeftOfDelete: tb.right <= del.left + 1,
      deleteAtRight: vb.right - del.right < 25, titleText: title.textContent, truncated: title.scrollWidth > title.clientWidth,
      contentsBelow: content.getBoundingClientRect().top >= back.bottom, contents: content.textContent };
  });
  ok(v.covers && v.coversHeader, 'the viewer fills the whole island, header included', v);
  ok(v.backLeftOfTitle && v.titleLeftOfDelete && v.deleteAtRight, 'back icon + title at top-left, delete at top-right', v);
  ok(v.truncated, 'a long title is truncated in the viewer too');
  ok(v.contentsBelow && /First line of the contents\./.test(v.contents) && /Second line\./.test(v.contents), 'the contents are below them', v.contents);
  ok(!(await items()).find(i => i.id === 'v1').unread, 'opening it marks it read');
  await ev(() => document.querySelector('#niViewer button[aria-label="Back"]').click());
  ok(!(await viewerOpen()) && (await items()).some(i => i.id === 'v1'), 'back returns to the list');
  await ev(() => document.querySelector('.ni-notif[data-id="v1"]').click());
  await ev(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  ok(!(await viewerOpen()), 'Escape also goes back');
  await ev(() => document.querySelector('.ni-notif[data-id="v1"]').click());
  await ev(() => document.querySelector('#niViewer button[aria-label="Delete"]').click());
  ok(!(await viewerOpen()) && !(await items()).some(i => i.id === 'v1'), 'delete in the viewer removes it and returns to the list');
  ok(await panelOpen(), 'and the island stays open');
  await ev(() => document.querySelector('.ni-notif[data-id="app-update"]').click());
  ok(await ev(() => /Reload now/.test(document.getElementById('niViewer').textContent) && /Open Updates settings/.test(document.getElementById('niViewer').textContent)), 'the update notification offers Reload now and Open Updates settings');
  await ev(() => document.querySelector('#niViewer button[aria-label="Back"]').click());

  console.log('\n[6] Settings > Updates');
  await ev(() => document.querySelector('.ni-notif[data-id="app-update"]').click());
  await ev(() => [...document.querySelectorAll('#niViewer .ni-btn')].find(b => /Open Updates/.test(b.textContent)).click());
  await sleep(600);
  ok(!(await panelOpen()), 'opening Settings from the notification closes the island');
  ok(await ev(() => !!document.querySelector('.tab[data-type="settings"]')), 'a Settings tab is open');
  ok(await ev(() => document.querySelector('#set-updates')?.classList.contains('active')), 'on the Updates section');
  let upd = await ev(() => document.getElementById('updateStateContainer').innerText);
  ok(/Update installed/.test(upd) && /Reload now/.test(upd), 'it says an update is installed and offers Reload now', upd);
  ok(await ev(() => /never reloads by itself/.test(document.getElementById('set-updates').innerText) && /every hour/.test(document.getElementById('set-updates').innerText)), 'and explains the notice, the hourly/on-return re-check');

  console.log('\n[7] after the reload');
  await page.reload(); await sleep(2500);
  list = await items();
  const applied = list.find(i => i.id === 'app-update');
  ok(!!applied && applied.title === 'Update applied', 'the update notification now reads "Update applied" (Reload would be wrong)', list);
  ok(await ev(() => !/Reload to use/.test(CodeMiniNotifications.list().find(n => n.id === 'app-update').text)), 'and no longer asks to reload');
  ok(applied && !applied.unread, 'read state survived the reload');
  ok(await ev(() => document.getElementById('niUnreadBadge').hidden), 'no unread badge');
  await ev(() => document.querySelector('.ni-notif[data-id="app-update"]').click());
  ok(await ev(() => !/Reload now/.test(document.getElementById('niViewer').textContent)), 'Reload now is gone from its viewer');

  console.log('\n[8] Settings > Updates when up to date');
  await ev(() => document.querySelector('#niViewer button[aria-label="Back"]').click());
  await ev(() => document.getElementById('settingsIconItem').click()); await sleep(500);
  await ev(() => document.querySelector('.settings-sidebar-item[data-tab="updates"]').click());
  upd = await ev(() => document.getElementById('updateStateContainer').innerText);
  ok(/You are up to date/.test(upd) && /Check for updates/.test(upd), 'shows "You are up to date" with a Check for updates button', upd);
  ok(await ev(() => new RegExp('v' + APP_INFO.version.replace(/\./g, '\\.')).test(document.getElementById('updateStateContainer').innerText)), 'and names the running version');
  await ev(() => document.querySelector('#updateStateContainer .update-btn').click());
  await sleep(1500);
  upd = await ev(() => document.getElementById('updateStateContainer').innerText);
  ok(/up to date/i.test(upd) && /Last checked/.test(upd), 'a manual check finishes and shows when it last ran', upd);
  await ev(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  await sleep(200);
  ok(await ev(() => /Update installed/.test(document.getElementById('updateStateContainer').innerText)), 'an update arriving while Settings is open updates the pane live');
  ok(await ev(() => CodeMiniNotifications.list().find(n => n.id === 'app-update').pending === true && !CodeMiniNotifications.list().find(n => n.id === 'app-update').read), 'and re-raises the notification as a new unread one');

  const rel = errors.filter(e => !NOISE.test(e));
  ok(rel.length === 0, 'no unexpected page errors', rel);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e.message); process.exit(2); });
