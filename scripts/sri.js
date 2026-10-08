#!/usr/bin/env node
// scripts/sri.js - adds, or checks, Subresource Integrity on the third-party <script> and <link rel="stylesheet">
// tags in index.html, so a tampered CDN file is refused by the browser instead of running with full access to the
// app (and to Shield, and to an unlocked My Keys vault).
//
//   node scripts/sri.js            download each external file, add integrity="sha384-..." crossorigin="anonymous"
//   node scripts/sri.js --dry      show what it would do, change nothing
//   node scripts/sri.js --check    re-download and verify the hashes already in index.html (exit 1 on a mismatch)
//
// Needs network access and Node 18+. Re-run it whenever you change a CDN URL or version.
// What this does NOT cover: files those libraries fetch later by themselves (Monaco's other modules, sql-wasm.wasm,
// Pyodide's wasm and packages). For full coverage, self-host the libraries and let the service worker precache them.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const TAG = /<(script|link)\b[^>]*>/gi;
const attr = (tag, name) => { const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"', 'i')); return m ? m[1] : null; };

// Third-party resources in the page: every <script src="https://..."> and <link rel="stylesheet" href="https://...">.
function findExternal(html) {
  const out = [];
  for (const m of html.matchAll(TAG)) {
    const tag = m[0], kind = m[1].toLowerCase();
    const url = kind === 'script' ? attr(tag, 'src') : ((attr(tag, 'rel') || '').toLowerCase() === 'stylesheet' ? attr(tag, 'href') : null);
    if (url && /^https:\/\//i.test(url)) out.push({ tag, url, integrity: attr(tag, 'integrity') });
  }
  return out;
}
// Adds integrity (+ crossorigin when missing) to exactly the tags in `hashes` (url -> "sha384-..."), leaving all
// other tags, and tags that already have integrity, untouched. Running it twice changes nothing the second time.
function applyIntegrity(html, hashes) {
  return html.replace(TAG, (tag) => {
    const ext = findExternal(tag)[0];
    if (!ext || ext.integrity || !hashes[ext.url]) return tag;
    const add = ` integrity="${hashes[ext.url]}"` + (attr(tag, 'crossorigin') === null ? ' crossorigin="anonymous"' : '');
    return tag.replace(/\s*\/?>$/, (end) => add + end);
  });
}
const sha384 = (bytes) => 'sha384-' + crypto.createHash('sha384').update(bytes).digest('base64');

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const args = process.argv.slice(2), check = args.includes('--check'), dry = args.includes('--dry');
  const file = path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const items = findExternal(html);
  if (!items.length) { console.log('No third-party scripts or stylesheets found in index.html.'); return; }
  const hashes = {}; let bad = 0;
  for (const it of items) {
    let h;
    try { h = sha384(await download(it.url)); } catch (e) { console.error('FAILED  ' + it.url + '\n        ' + e.message); bad++; continue; }
    if (check) {
      const ok = it.integrity && it.integrity.split(/\s+/).includes(h);
      console.log((ok ? 'ok      ' : it.integrity ? 'CHANGED ' : 'MISSING ') + it.url);
      if (!ok) bad++;
    } else {
      hashes[it.url] = h;
      console.log((it.integrity ? 'has SRI ' : 'adding  ') + it.url + (it.integrity ? '' : '\n        ' + h));
    }
  }
  if (!check && !dry && !bad) {
    const next = applyIntegrity(html, hashes);
    if (next !== html) { fs.writeFileSync(file, next); console.log('\nindex.html updated. Reload the app (and hard-refresh so the service worker picks it up) and check the console for integrity errors.'); }
    else console.log('\nNothing to change.');
  }
  if (bad) { console.error(`\n${bad} problem(s).` + (check ? ' A CHANGED hash means the file on the CDN is not what you pinned: find out why before shipping.' : '')); process.exit(1); }
}
module.exports = { findExternal, applyIntegrity };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
