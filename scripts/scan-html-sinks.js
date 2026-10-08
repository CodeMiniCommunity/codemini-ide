#!/usr/bin/env node
// scripts/scan-html-sinks.js - finds every place the app builds HTML as text (.innerHTML / .outerHTML assignment,
// insertAdjacentHTML) and lists the ${...} pieces and indirect values that are NOT obviously safe. Everything runs
// in one origin, so one unescaped file name, repo name or message in one of these is a path to full compromise.
//
// "Safe" here is deliberately narrow: the whole expression is a call to an escaper (escapeHtml, gitEsc, ...), a number
// (.length, Math.x(), Number(), toFixed()), a literal, or a ternary between two literals. Everything else is listed for
// a human to look at. It is a review aid, not a proof: a flagged item can be fine (for example an id the app made
// itself), and a call to a function that returns HTML is only as safe as that function.
//
//   node scripts/scan-html-sinks.js            list findings by file
//   node scripts/scan-html-sinks.js --json     machine-readable
//   node scripts/scan-html-sinks.js --update-baseline   after FIXING findings, lower the CI ratchet (tests/html-sinks.test.js)
'use strict';
const fs = require('fs'), path = require('path');

const ESCAPERS = ['escapeHtml', 'escapeHTML', '_escapeHtml', 'htmlEsc', '_htmlEsc', 'escHtml', 'escapeAttr', 'escAttr', 'gitEsc', 'esc', '_esc', 'escapeText', 'encodeURIComponent', 'CSS.escape', 'CodeMiniEscape.html', 'CodeMiniEscape.attr', 'CodeMiniEscape.sanitize'];
const SAFE_CALL = new RegExp('^(' + ESCAPERS.map((s) => s.replace('.', '\\.')).join('|') + ')\\(');
const NUMERIC = /^(\d+(\.\d+)?|[\w$.\[\]]*\.length|Math\.\w+\([^`]*\)|Number\([^`]*\)|parseInt\([^`]*\)|parseFloat\([^`]*\)|[\w$.\[\]]+\.toFixed\([^`]*\))$/;
const LITERAL = /^('[^'\\\n]*'|"[^"\\\n]*")$/;
const LITERAL_TERNARY = /^[^?`]+\?\s*(['"])[^'"`$\\]*\1\s*:\s*(['"])[^'"`$\\]*\2$/;

// Is `expr` one single call to an escaper, with nothing after the closing parenthesis?
function wholeEscaperCall(expr) {
  if (!SAFE_CALL.test(expr)) return false;
  let depth = 0, q = null;
  for (let i = expr.indexOf('('); i < expr.length; i++) {
    const c = expr[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i === expr.length - 1; }
  }
  return false;
}
// a + b + c with every operand safe (for example: escaper(x) + '<mark>' + escaper(y)).
function splitPlus(e) {
  const parts = []; let depth = 0, q = null, last = 0;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '+' && depth === 0) { parts.push(e.slice(last, i).trim()); last = i + 1; }
  }
  parts.push(e.slice(last).trim());
  return parts;
}
function safeOne(e) { return wholeEscaperCall(e) || NUMERIC.test(e) || LITERAL.test(e) || LITERAL_TERNARY.test(e); }
function safe(expr) {
  const e = expr.trim();
  if (safeOne(e)) return true;
  const parts = splitPlus(e);
  return parts.length > 1 && parts.every(safeOne);
}

// Reads source text from `i` until `stop(char, depth)` is true at nesting depth 0, understanding strings, template
// literals (and the ${} inside them), comments and brackets. Collects each ${} expression into `out`.
function readExpr(src, i, stop, out) {
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return src.length; i++; continue; }
    if (c === '"' || c === "'") { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++; continue; }
    if (c === '`') { i = readTemplate(src, i + 1, out); continue; }
    if (depth === 0 && stop(c)) return i;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; }
  }
  return i;
}
function readTemplate(src, i, out) {
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') return i;
    if (c === '$' && src[i + 1] === '{') {
      const start = i + 2;
      const end = readExpr(src, start, () => false, out); // stops at the matching }
      out.push({ expr: src.slice(start, end), at: start });
      i = end;
    }
  }
  return i;
}
const lineOf = (src, at) => src.slice(0, at).split('\n').length;

function scanSource(src, file) {
  const findings = [], sinks = [];
  const re = /\.(innerHTML|outerHTML)\s*(\+?=)(?!=)|insertAdjacentHTML\(\s*(['"])\w+\3\s*,/g;
  let m;
  while ((m = re.exec(src))) {
    const isCall = m[0].startsWith('insertAdjacentHTML');
    const from = m.index + m[0].length;
    const parts = [];
    const end = readExpr(src, from, isCall ? () => false : (c) => c === ';', parts);
    const rhs = src.slice(from, end).trim();
    sinks.push({ file, line: lineOf(src, m.index) });
    const plain = LITERAL.test(rhs) || /^`[^`$\\]*`$/.test(rhs);
    if (plain) continue;
    const isTemplate = rhs[0] === '`';
    if (!isTemplate && !parts.length) {
      // Indirect: the HTML comes from a variable, a call or a concatenation; judge by the expression.
      if (!safe(rhs)) findings.push({ file, line: lineOf(src, m.index), kind: 'indirect', expr: rhs.replace(/\s+/g, ' ').slice(0, 110) });
      continue;
    }
    for (const p of parts) {
      if (p.expr.includes('`')) continue; // a composite (like items.map(x => `...`)): its own ${} pieces are listed separately
      if (!safe(p.expr)) findings.push({ file, line: lineOf(src, p.at), kind: 'interp', expr: p.expr.replace(/\s+/g, ' ').trim().slice(0, 110) });
    }
  }
  return { sinks, findings };
}
function scanTree(root) {
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(path.join(root, d)).sort()) { const p = d + '/' + f; fs.statSync(path.join(root, p)).isDirectory() ? walk(p) : /\.js$/.test(f) && files.push(p); } })('js');
  let sinks = 0; const findings = [];
  for (const f of files) { const r = scanSource(fs.readFileSync(path.join(root, f), 'utf8'), f); sinks += r.sinks.length; findings.push(...r.findings); }
  return { sinks, findings };
}
module.exports = { scanSource, scanTree, safe, wholeEscaperCall };
// Per-file counts of findings, the shape tests/fixtures/html-sinks-baseline.json stores.
function countsByFile(findings) { const c = {}; for (const f of findings) c[f.file] = (c[f.file] || 0) + 1; return c; }
module.exports.countsByFile = countsByFile;
if (require.main === module) {
  const r = scanTree(path.join(__dirname, '..'));
  if (process.argv.includes('--update-baseline')) {
    const sorted = {}; Object.entries(countsByFile(r.findings)).sort().forEach(([k, v]) => { sorted[k] = v; });
    fs.writeFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'html-sinks-baseline.json'), JSON.stringify(sorted, null, 2) + '\n');
    console.log('baseline written: ' + r.findings.length + ' findings in ' + Object.keys(sorted).length + ' files');
    return;
  }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); return; }
  const by = {}; for (const f of r.findings) (by[f.file] = by[f.file] || []).push(f);
  console.log(`${r.sinks} HTML sinks, ${r.findings.length} interpolations/values not obviously safe\n`);
  for (const f of Object.keys(by)) { console.log(`${f}  (${by[f].length})`); for (const x of by[f]) console.log(`  ${x.line}\t${x.kind === 'indirect' ? '[indirect] ' : ''}${x.expr}`); }
}
