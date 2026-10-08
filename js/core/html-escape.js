// html-escape.js - one shared way to put untrusted text into HTML.
//
// Every file, folder, workspace and archive-entry name, every repo and branch name, and every message that
// can come from outside (a zip you opened, a repo you cloned, a file you imported) is attacker-controlled, and the
// whole app runs in one origin: a name that becomes HTML is a path to taking over the app. So text goes into
// markup only through this (or through textContent / setAttribute, which need no escaping at all).
//
//   CodeMiniEscape.html(v)   text content AND double- or single-quoted attribute values
//   CodeMiniEscape.attr(v)   the same function; use it where the value lands in an attribute so the intent is visible
//   CodeMiniEscape.sanitize(html, opts)   for HTML that is meant to be markup but comes from outside (see below)
//
// null and undefined become an empty string. Loaded right after shield.js. tests/e2e/xss-names.e2e.js proves the
// surfaces that use it, and scripts/scan-html-sinks.js lists the places that still build HTML from other values.
(function () {
    'use strict';
    const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
    const html = (v) => (v === null || v === undefined ? '' : String(v)).replace(/[&<>"'`]/g, (c) => MAP[c]);
    // sanitize(html, { allowStyle }) - for HTML that is MEANT to be markup but comes from outside: Markdown that
    // contains raw HTML (a notebook cell, a README), or a document. It parses into an inert document (nothing runs,
    // nothing loads), keeps only an allowlist of tags and attributes, and serializes the result. Tags that are not on
    // the list are unwrapped (their text stays); script, style, iframe, object, embed, svg, math, form controls, link,
    // meta, base, template and similar are removed with their contents. Event handlers, id/name (DOM clobbering) and
    // javascript:/vbscript:/file: URLs are always dropped. Links get rel="noopener noreferrer". Images may be
    // http(s), blob:, relative, or a data: PNG/JPEG/GIF/WebP/BMP. allowStyle (documents) also keeps data-* attributes
    // and a filtered style attribute (no url(), expression(), @import, backslashes or angle brackets).
    //
    // This function must stay SELF-CONTAINED (no outer variables, no backticks, no template placeholders, no closing
    // script tag): the Markdown preview runs inside its own iframe and receives this function as source text.
    function sanitize(html, opts) {
        var allowStyle = !!(opts && opts.allowStyle);
        var DROP = {}; ('script style iframe frame frameset object embed applet link meta base template noscript svg math form select textarea button audio video source track canvas title head xmp plaintext noembed noframes dialog portal slot').split(' ').forEach(function (t) { DROP[t] = 1; });
        var ALLOW = {}; ('a abbr article aside b big blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font h1 h2 h3 h4 h5 h6 hr i img input ins kbd li mark ol p pre q s samp section small span strike strong sub summary sup table tbody td tfoot th thead tr tt u ul var').split(' ').forEach(function (t) { ALLOW[t] = 1; });
        var PLAIN = /^(title|lang|dir|align|valign|colspan|rowspan|start|reversed|alt|open|checked|disabled|color|face|size|width|height)$/;
        function okUrl(v, isImg) {
            var u = String(v).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '').toLowerCase();
            var m = u.match(/^([a-z][a-z0-9+.\-]*):/);
            if (!m) return true; // relative or fragment
            if (m[1] === 'http' || m[1] === 'https') return true;
            if (!isImg) return m[1] === 'mailto' || m[1] === 'tel';
            if (m[1] === 'blob') return true;
            return /^data:image\/(png|jpe?g|gif|webp|bmp)[;,]/.test(u);
        }
        function cleanStyle(v) {
            return String(v).split(';').map(function (d) { return d.trim(); }).filter(function (d) {
                var i = d.indexOf(':'); if (i < 1) return false;
                var prop = d.slice(0, i).trim(), val = d.slice(i + 1);
                return /^[a-zA-Z-]+$/.test(prop) && !/url\s*\(|expression|javascript:|vbscript:|@import|behavior|binding|\\|[<>]/i.test(val);
            }).map(function (d) { var i = d.indexOf(':'); return d.slice(0, i).trim() + ': ' + d.slice(i + 1).trim(); }).join('; ');
        }
        function cleanAttrs(el, tag) {
            Array.prototype.slice.call(el.attributes).forEach(function (a) {
                var n = a.name.toLowerCase(), v = a.value, keep = false;
                // Markup inside an attribute value is how mutation XSS hides; no legitimate value here needs it.
                if (/[<>]/.test(v)) { el.removeAttribute(a.name); return; }
                if (tag === 'input') keep = (n === 'type' && v.toLowerCase() === 'checkbox') || n === 'checked';
                else if (n === 'href') keep = tag === 'a' && okUrl(v, false);
                else if (n === 'src') keep = tag === 'img' && okUrl(v, true);
                else if (n === 'class') {
                    var toks = v.split(/\s+/).filter(function (c) { return allowStyle ? /^[\w-]+$/.test(c) : /^language-[\w-]+$/.test(c); });
                    if (toks.length) { el.setAttribute('class', toks.join(' ')); keep = true; }
                } else if (n === 'style') {
                    if (allowStyle) { var cs = cleanStyle(v); if (cs) { el.setAttribute('style', cs); keep = true; } }
                } else if (PLAIN.test(n)) keep = !/^(width|height)$/.test(n) || /^\d+(\.\d+)?(px|%)?$/.test(v.trim());
                else if (n === 'type') keep = tag === 'ol' || tag === 'ul';
                else if (allowStyle && /^data-[\w-]+$/.test(n)) keep = true;
                if (!keep) el.removeAttribute(a.name);
            });
            if (tag === 'a') el.setAttribute('rel', 'noopener noreferrer');
            if (tag === 'input') { el.setAttribute('type', 'checkbox'); el.setAttribute('disabled', ''); }
        }
        function clean(parent) {
            Array.prototype.slice.call(parent.childNodes).forEach(function (node) {
                if (node.nodeType === 3) return;
                if (node.nodeType !== 1) { parent.removeChild(node); return; }
                var tag = node.tagName.toLowerCase();
                if (DROP[tag] || (tag === 'input' && (node.getAttribute('type') || '').toLowerCase() !== 'checkbox')) { parent.removeChild(node); return; }
                clean(node);
                if (!ALLOW[tag]) { while (node.firstChild) parent.insertBefore(node.firstChild, node); parent.removeChild(node); return; }
                cleanAttrs(node, tag);
            });
        }
        var doc = new DOMParser().parseFromString(String(html === null || html === undefined ? '' : html), 'text/html');
        clean(doc.body);
        return doc.body.innerHTML;
    }
    const W = typeof window !== 'undefined' ? window : globalThis;
    if (!W.CodeMiniEscape) W.CodeMiniEscape = Object.freeze({ html, attr: html, sanitize });
    if (typeof module !== 'undefined' && module.exports) module.exports = W.CodeMiniEscape;
})();
