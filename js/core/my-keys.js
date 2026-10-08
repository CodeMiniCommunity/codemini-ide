// ==========================================
// my-keys.js - "My Keys": an encrypted, password-protected place for API keys, tokens and passwords.
// ==========================================
// HOW IT PROTECTS DATA
//   - Everything (names, services, notes, values) is encrypted as ONE blob with AES-256-GCM. The key is
//     derived from the user's vault password with PBKDF2-SHA256 (600,000 iterations, random 16-byte salt).
//     The crypto itself lives in shield.js (CodeMini Shield); this file decides what is encrypted and when
//     the vault is locked. Shield never opens the vault on its own: only this password does.
//   - Only ciphertext is stored (localStorage `codemini_vault_<windowId>`). The password and the key are never
//     written anywhere. The derived key is a non-extractable CryptoKey held in this closure while unlocked.
//   - There is no recovery. A wrong password simply fails AES-GCM authentication.
//   - Each window/profile has its own vault, like the rest of the app's per-window data.
//   - It locks when the sidebar closes (default), after idle time, on window switch and (optionally) when the
//     app is backgrounded. Locking drops the key and the decrypted entries and rebuilds the DOM.
//
// WHAT IT CANNOT PROTECT AGAINST (said plainly in Config > "How your keys are protected")
//   - Code that runs inside this IDE (previewed pages, notebooks, the terminal) shares this origin. While the
//     vault is unlocked, or a value is revealed, such code could read what is on screen. The page also keeps
//     Shield's crypto primitives and this module's JSON primitives are captured at load so later
//     monkey-patching cannot hook them, and nothing here exposes a way to read entries, but it cannot hide
//     the DOM from same-origin code.
//   - Malware, keyloggers, screen capture, shoulder surfing, a weak password.
//
// Loads right after shield.js, which loads right after app-info.js, so the primitives are captured before any
// other script runs. tests/my-keys.test.js covers the record/validation layer; tests/e2e/keys-vault.e2e.js
// covers the UI. (The stored record is still `type: 'codemini-vault'` and lives under `codemini_vault_<window>`;
// those names are part of the saved format and are not renamed.)
(function () {
    'use strict';

    // ---- primitives captured at load ------------------------------------------------------------
    const W = window;
    // shield.js loads first. Captured once here (the object is frozen), so replacing window.CodeMiniShield later
    // changes nothing. If it failed to load, `supported` is false and the sidebar shows the "unsupported" screen.
    const Shield = W.CodeMiniShield || null;
    const supported = !!(Shield && Shield.supported);
    const KDF = Shield ? Shield.KDF : Object.freeze({ name: 'PBKDF2-SHA256', ITER: 0, MIN_ITER: 0, MAX_ITER: 0, SALT_LEN: 0, IV_LEN: 0 });
    const randomBytes = (n) => Shield.randomBytes(n);
    const toB64 = (u8) => Shield.toB64(u8), fromB64 = (b64) => Shield.fromB64(b64);
    const JP = JSON.parse.bind(JSON), JS = JSON.stringify.bind(JSON);

    const ITER = KDF.ITER, MIN_ITER = KDF.MIN_ITER;
    const PAD_TO = 1024, MAX_RECORD_BYTES = 4 * 1024 * 1024;
    // Part of the stored format (authenticated, not stored): do not change without a versioned migration.
    const AAD = 'codemini-vault:v1';
    const PASSWORD_FORM = 'NFKC';
    const LIMITS = { name: 80, service: 60, value: 16384, notes: 1000, entries: 500 };
    const TYPES = [['api', 'API key'], ['token', 'Access token'], ['password', 'Password'], ['secret', 'Secret / env var'], ['other', 'Other']];
    const TYPE_ICON = { api: 'ri-key-2-line', token: 'ri-shield-keyhole-line', password: 'ri-lock-password-line', secret: 'ri-file-lock-line', other: 'ri-more-2-line' };
    const SERVICES = ['OpenAI', 'Anthropic', 'Google', 'GitHub', 'GitLab', 'AWS', 'Azure', 'Firebase', 'Supabase', 'Stripe', 'Vercel', 'Netlify', 'Cloudflare', 'Twilio', 'SendGrid', 'Hugging Face'];
    const IDLE_CHOICES = [1, 5, 15, 30, 60], REVEAL_CHOICES = [10, 15, 30, 60];
    const DEFAULT_CFG = { idleMin: 5, lockOnClose: true, lockOnHide: false, revealSec: 15 };
    // The only entries other parts of the app may read or write by name. Source Control normally keeps its GitHub
    // token under Shield's device key; it lands here only when the browser cannot keep that key, or when a token
    // saved by the previous version is still waiting to be moved out. Every other entry stays unreadable to code:
    // there is no general "get".
    const SECRET_SLOTS = {
        'github-token': { id: '6768746f6b656e', name: 'GitHub token (Source Control)', service: 'GitHub', type: 'token', notes: 'Used by Source Control in this window. Delete it to disconnect GitHub.' }
    };
    // Backup reminder timing. Stored with the settings as plain timestamps: `since` (first time this vault was
    // opened), `lastBackup` and `backupNudge` (last reminder). Nothing here depends on what the vault holds, so a
    // reminder cannot reveal whether (or how many) keys are saved.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const BACKUP_FIRST_MS = 2 * DAY_MS;   // never backed up: remind after this long
    const BACKUP_STALE_MS = 30 * DAY_MS;  // backed up before: remind when the backup is this old
    const BACKUP_REPEAT_MS = 7 * DAY_MS;  // and no more often than this
    const stamp = (v) => (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
    const COMMON = ['password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890', 'qwertyuiop', 'qwerty123', 'iloveyou', 'letmein123', 'admin1234', 'welcome123', 'abc12345', 'codemini', 'codemini123', '11111111', '00000000'];

    class VaultError extends Error { constructor(code) { super(code); this.code = code; } }

    // ---- encoding helpers -------------------------------------------------------------------------
    const esc = (v) => String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const newId = () => Array.from(randomBytes(12), (b) => b.toString(16).padStart(2, '0')).join('');

    // ---- entries ------------------------------------------------------------------------------------
    const cleanStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    function sanitizeEntry(e) {
        if (!e || typeof e !== 'object') return null;
        if (typeof e.id !== 'string' || !/^[a-f0-9]{8,64}$/.test(e.id)) return null;
        const name = cleanStr(e.name, LIMITS.name).trim();
        const value = typeof e.value === 'string' ? e.value.slice(0, LIMITS.value) : '';
        if (!name || !value) return null;
        return {
            id: e.id, name, value,
            service: cleanStr(e.service, LIMITS.service).trim(),
            type: TYPES.some((t) => t[0] === e.type) ? e.type : 'other',
            notes: cleanStr(e.notes, LIMITS.notes),
            created: Number.isFinite(e.created) ? e.created : Date.now(),
            updated: Number.isFinite(e.updated) ? e.updated : Date.now()
        };
    }
    function sanitizeEntries(list) {
        if (!Array.isArray(list)) throw new VaultError('damaged');
        const out = [], seen = new Set();
        for (const e of list) {
            const c = sanitizeEntry(e);
            if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
        }
        return out.slice(0, LIMITS.entries);
    }
    // Merge an imported list into the current one: new ids are added, the same id keeps whichever is newer.
    function mergeEntries(current, incoming) {
        const byId = new Map(current.map((e) => [e.id, e]));
        let added = 0, updated = 0;
        for (const e of sanitizeEntries(incoming)) {
            const have = byId.get(e.id);
            if (!have) { byId.set(e.id, e); added++; }
            else if (e.updated > have.updated) { byId.set(e.id, e); updated++; }
        }
        return { entries: Array.from(byId.values()).slice(0, LIMITS.entries), added, updated };
    }

    // ---- passwords ------------------------------------------------------------------------------------
    function evaluatePassword(pw) {
        pw = String(pw || '');
        const len = pw.length;
        const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
        const lower = pw.toLowerCase();
        const common = COMMON.some((c) => lower === c || (c.length >= 8 && lower.replace(/[^a-z0-9]/g, '') === c));
        const oneChar = len > 0 && /^(.)\1*$/.test(pw);
        const digitsOnly = /^[0-9]+$/.test(pw) && len < 14;
        const sequence = /^(?:0123456789|abcdefghij|qwertyuiop|asdfghjkl)/i.test(pw) && len < 14;
        let score = len >= 16 ? 3 : len >= 12 ? 2 : len >= 8 ? 1 : 0;
        if (classes >= 3) score += 1;
        else if (len >= 20) score += 1;
        score = Math.min(score, 4);
        const ok = !common && !oneChar && !digitsOnly && !sequence && (len >= 10 || (len >= 8 && classes >= 3));
        if (!ok) score = Math.min(score, 1);
        let hint = '';
        if (len === 0) hint = 'Use at least 10 characters, or 8 with letters, numbers and symbols.';
        else if (common || oneChar || digitsOnly || sequence) hint = 'That is too easy to guess. Try a few unrelated words.';
        else if (!ok) hint = 'Use at least 10 characters, or 8 with letters, numbers and symbols.';
        else if (score <= 2) hint = 'Longer is stronger: a passphrase of 4 or more words works well.';
        return { score, ok, label: ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'][len === 0 ? 0 : score], hint };
    }

    // ---- crypto (all of it is done by Shield; these wrap it in this vault's record format) --------------------
    const deriveKey = (password, salt, iter) => Shield.deriveKey(password, salt, iter, { normalize: PASSWORD_FORM });
    async function seal(key, entries) {
        // Padded to a multiple of 1 KB so the stored size does not reveal how many keys there are.
        return Shield.encrypt(key, JS({ v: 1, entries }), AAD, { padTo: PAD_TO });
    }
    async function openSealed(key, rec) {
        const data = JP(await Shield.decryptText(key, rec, AAD));
        if (!data || data.v !== 1) throw new VaultError('damaged');
        return sanitizeEntries(data.entries);
    }
    function validateRecord(rec) {
        try {
            if (!rec || typeof rec !== 'object' || rec.type !== 'codemini-vault' || rec.v !== 1 || rec.kdf !== KDF.name) return false;
            if (!Shield.validIter(rec.iter) || !Shield.validSalt(rec.salt)) return false;
            return Shield.validSealed(rec, { minBytes: 16 + PAD_TO, maxChars: MAX_RECORD_BYTES });
        } catch (e) { return false; }
    }
    async function createRecord(password, entries, opts) {
        const iter = (opts && opts.iter) || ITER;
        const salt = randomBytes(KDF.SALT_LEN);
        const key = await deriveKey(password, salt, iter);
        const sealed = await seal(key, entries);
        return { key, record: { type: 'codemini-vault', v: 1, kdf: KDF.name, iter, salt: toB64(salt), iv: sealed.iv, ct: sealed.ct } };
    }
    // Shield reports 'auth-failed' when the password is wrong; anything else (a malformed record, bad JSON) is damage.
    async function unlockRecord(password, record) {
        if (!validateRecord(record)) throw new VaultError('damaged');
        const key = await deriveKey(password, fromB64(record.salt), record.iter);
        try {
            return { key, entries: await openSealed(key, record) };
        } catch (e) {
            throw new VaultError(e && e.code === 'auth-failed' ? 'wrong-password' : 'damaged');
        }
    }

    // Test hook only: in a browser `module` is undefined, so nothing is exposed.
    if (typeof module === 'object' && module && module.exports) {
        module.exports = { createRecord, unlockRecord, validateRecord, evaluatePassword, mergeEntries, sanitizeEntries, sanitizeEntry, seal, openSealed, deriveKey, toB64, fromB64, VaultError, ITER, MIN_ITER, LIMITS, TYPES };
    }
    if (typeof document === 'undefined') return;

    // =====================================================================================================
    // UI
    // =====================================================================================================
    const st = {
        key: null, entries: null, record: null, unlockedWin: null,
        tab: 'my', search: '', editId: null, confirmDeleteId: null,
        revealId: null, revealTimer: null, view: 'main', notice: '', busy: false,
        cfg: null, importRec: null, lastActivity: 0, idleTimer: null, toastTimer: null, lockTick: null, supported
    };
    const $ = (id) => document.getElementById(id);
    const winId = () => { try { return localStorage.getItem('codemini_active_window') || 'win_default'; } catch (e) { return 'win_default'; } };
    const recKey = (w) => `codemini_vault_${w}`;
    const cfgKey = (w) => `codemini_vaultcfg_${w}`;
    const guardKey = (w) => `codemini_vaultguard_${w}`;
    const sidebar = () => $('keysSidebar');
    const root = () => $('kvRoot');
    const isOpen = () => !!(sidebar() && sidebar().classList.contains('open'));

    function readRecord(w) {
        let raw = null;
        try { raw = localStorage.getItem(recKey(w)); } catch (e) { /* storage blocked */ }
        if (raw === null) return { state: 'none' };
        try { const rec = JP(raw); return validateRecord(rec) ? { state: 'ok', record: rec } : { state: 'damaged' }; } catch (e) { return { state: 'damaged' }; }
    }
    function writeRecord(w, rec) {
        try { localStorage.setItem(recKey(w), JS(rec)); } catch (e) { throw new VaultError('storage'); }
    }
    function loadCfg(w) {
        let c = {};
        try { c = JP(localStorage.getItem(cfgKey(w)) || '{}') || {}; } catch (e) { c = {}; }
        return {
            idleMin: IDLE_CHOICES.includes(c.idleMin) ? c.idleMin : DEFAULT_CFG.idleMin,
            lockOnClose: typeof c.lockOnClose === 'boolean' ? c.lockOnClose : DEFAULT_CFG.lockOnClose,
            lockOnHide: typeof c.lockOnHide === 'boolean' ? c.lockOnHide : DEFAULT_CFG.lockOnHide,
            revealSec: REVEAL_CHOICES.includes(c.revealSec) ? c.revealSec : DEFAULT_CFG.revealSec,
            since: stamp(c.since), lastBackup: stamp(c.lastBackup), backupNudge: stamp(c.backupNudge)
        };
    }
    function saveCfg() { try { localStorage.setItem(cfgKey(st.unlockedWin || winId()), JS(st.cfg)); } catch (e) { /* defaults next time */ } }
    const cfg = () => st.cfg || (st.cfg = loadCfg(winId()));

    // failed-attempt throttle (a speed bump for the UI; it cannot stop offline guessing, strong passwords do)
    function readGuard(w) { try { const g = JP(localStorage.getItem(guardKey(w)) || '{}') || {}; return { fails: g.fails | 0, until: +g.until || 0 }; } catch (e) { return { fails: 0, until: 0 }; } }
    function writeGuard(w, g) { try { localStorage.setItem(guardKey(w), JS(g)); } catch (e) { /* ignore */ } }
    function clearGuard(w) { try { localStorage.removeItem(guardKey(w)); } catch (e) { /* ignore */ } }
    // Notifications (Now Island). Text never includes anything from the vault.
    function notifyApp(n) {
        try { if (W.CodeMiniNotifications) W.CodeMiniNotifications.add(Object.assign({ source: 'My Keys', kind: 'security', actions: ['open-keys'] }, n)); } catch (e) { /* notifications are optional */ }
    }
    function clearNotice(id) { try { if (W.CodeMiniNotifications) W.CodeMiniNotifications.remove(id); } catch (e) { /* optional */ } }
    function registerFailure(w) {
        const g = readGuard(w); g.fails += 1;
        if (g.fails >= 5) g.until = Date.now() + Math.min(900, 30 * Math.pow(2, g.fails - 5)) * 1000;
        writeGuard(w, g);
        // Every 5th wrong password in a row. Same id, so a long run of tries is one notice, not a pile.
        if (g.fails >= 5 && g.fails % 5 === 0) {
            notifyApp({
                id: 'vault-attempts',
                title: g.fails + ' wrong passwords in a row',
                text: 'Someone tried to unlock My Keys ' + g.fails + ' times with the wrong password, and further tries are being slowed down. ' +
                    'Your keys stay encrypted. If it was not you, change your password after you unlock.'
            });
        }
        return g;
    }

    // ---- locking ----------------------------------------------------------------------------------------
    function clearReveal() { clearTimeout(st.revealTimer); st.revealTimer = null; st.revealId = null; }
    function stopIdle() { clearInterval(st.idleTimer); st.idleTimer = null; }
    function startIdle() {
        stopIdle();
        st.lastActivity = Date.now();
        st.idleTimer = setInterval(() => {
            if (!st.key) { stopIdle(); return; }
            if (st.unlockedWin !== winId()) { lock('window'); return; }
            if (Date.now() - st.lastActivity > cfg().idleMin * 60000) lock('idle');
        }, 5000);
    }
    function lock(reason) {
        st.key = null; st.entries = null; st.unlockedWin = null;
        st.editId = null; st.confirmDeleteId = null; st.importRec = null; st.view = 'main'; st.search = '';
        clearReveal(); stopIdle();
        emitState();
        st.notice = ({ idle: 'Locked after being idle.', window: 'Locked because you switched windows.', changed: 'Locked because the vault changed in another tab.', hidden: 'Locked when the app went to the background.' })[reason] || '';
        render();
    }
    const guardWindow = () => { if (st.key && st.unlockedWin !== winId()) { lock('window'); return false; } return !!st.key; };

    // Re-read the stored vault. If another tab changed it (same password), pick up its entries; otherwise lock.
    async function resync() {
        if (!st.key) return false;
        const cur = readRecord(st.unlockedWin);
        if (cur.state !== 'ok') { lock('changed'); return false; }
        if (cur.record.ct === st.record.ct) return true;
        if (cur.record.salt !== st.record.salt) { lock('changed'); return false; }
        try { st.entries = await openSealed(st.key, cur.record); st.record = cur.record; return true; } catch (e) { lock('changed'); return false; }
    }
    // Apply a change to the freshest copy of the entries and save it.
    async function commit(mutate) {
        if (!(await resync())) throw new VaultError('locked');
        const next = sanitizeEntries(mutate(st.entries.slice()));
        const sealed = await seal(st.key, next);
        const rec = Object.assign({}, st.record, { iv: sealed.iv, ct: sealed.ct });
        writeRecord(st.unlockedWin, rec);
        st.record = rec; st.entries = next;
    }

    // ---- named secret slots (see SECRET_SLOTS) -------------------------------------------------------------
    // Fired whenever the vault locks or unlocks or a slot changes, so Source Control can redraw.
    function emitState() {
        try { W.dispatchEvent(new CustomEvent('codemini:vault-state', { detail: { unlocked: !!st.key } })); } catch (e) { /* optional */ }
    }
    function getSecret(slot) {
        const d = SECRET_SLOTS[slot];
        if (!d || !st.key || !st.entries || st.unlockedWin !== winId()) return '';
        const e = st.entries.find((x) => x.id === d.id);
        return e ? e.value : '';
    }
    async function setSecret(slot, value) {
        const d = SECRET_SLOTS[slot];
        if (!d) throw new VaultError('unknown-slot');
        if (typeof value !== 'string' || !value || value.length > LIMITS.value) throw new VaultError('bad-value');
        if (!guardWindow()) throw new VaultError('locked');
        await commit((list) => {
            const now = Date.now(), i = list.findIndex((x) => x.id === d.id);
            const entry = { id: d.id, name: d.name, service: d.service, type: d.type, notes: d.notes, value, created: i >= 0 ? list[i].created : now, updated: now };
            if (i >= 0) list[i] = entry; else list.push(entry);
            return list;
        });
        emitState(); render();
    }
    async function removeSecret(slot) {
        const d = SECRET_SLOTS[slot];
        if (!d) throw new VaultError('unknown-slot');
        if (!guardWindow()) throw new VaultError('locked');
        await commit((list) => list.filter((x) => x.id !== d.id));
        emitState(); render();
    }

    // ---- styles ---------------------------------------------------------------------------------------
    function injectStyles() {
        if ($('keysStyles')) return;
        const style = document.createElement('style');
        style.id = 'keysStyles';
        style.textContent = `
        /* My Keys sidebar styles. Everything is namespaced under .keys-* / #keysSidebar / kv* ids.
           Scale: 15px title, 12px body text, 11px labels, 10px hints, 4px radii, 8px buttons, dashed row dividers. */
        #keysSidebar .keys-root { display:flex; flex-direction:column; flex:1; min-height:0; white-space:normal; position:relative; color:var(--text-main); font-family:var(--font-main); }
        .keys-header { display:flex; justify-content:space-between; align-items:center; padding:13px 15px; background:var(--bg-white); flex-shrink:0; }
        .keys-title { font-weight:700; font-size:15px; color:var(--text-main); letter-spacing:-0.2px; }
        .keys-icons { display:flex; gap:6px; align-items:center; font-size:18px; }
        .keys-icon { cursor:pointer; opacity:0.7; padding:4px; border-radius:3px; color:var(--icon-gray); transition:opacity .15s, background-color .15s, color .15s; }
        .keys-icons .keys-icon { padding:3px; }
        .keys-icon:hover { opacity:1; background:var(--bg-panel); color:var(--text-main); }
        .keys-icon.hidden { visibility:hidden; pointer-events:none; }
        .keys-tabs { display:flex; background:var(--bg-white); border-bottom:1px solid var(--border-color); flex-shrink:0; }
        .keys-tab { flex:1; text-align:center; padding:9px 6px; font-size:12px; font-weight:600; color:var(--text-muted); cursor:pointer; border-bottom:2px solid transparent; white-space:nowrap; }
        .keys-tab:hover { color:var(--text-main); }
        .keys-tab.active { color:var(--accent-blue); border-bottom-color:var(--accent-blue); }
        .keys-panes { flex:1; min-height:0; overflow-y:auto; }
        .keys-pane { display:none; padding-bottom:20px; }
        .keys-pane.active { display:block; }
        .keys-box { padding:12px 15px; }
        .keys-box + .keys-box { border-top:1px solid var(--border-color); }
        .keys-sec-title { font-size:13px; font-weight:600; color:var(--text-main); margin:0 0 10px; }
        .keys-label { display:block; font-size:11px; font-weight:600; color:var(--text-muted); margin:10px 0 4px; }
        .keys-label:first-child { margin-top:0; }
        .keys-input, .keys-select, .keys-textarea { width:100%; box-sizing:border-box; background:var(--bg-panel); border:1px solid var(--border-color); border-radius:4px; padding:7px 9px; font-size:12px; color:var(--text-main); outline:none; font-family:var(--font-main); }
        .keys-input.mono, .keys-textarea.mono { font-family:var(--font-mono); }
        .keys-select { width:auto; min-width:64px; padding:5px 8px; }
        .keys-select.full { width:100%; padding:7px 9px; }
        .keys-textarea { resize:vertical; min-height:56px; }
        .keys-input:focus, .keys-select:focus, .keys-textarea:focus { border-color:var(--accent-blue); }
        .keys-pw { position:relative; }
        .keys-pw .keys-input { padding-right:34px; }
        .keys-eye { position:absolute; right:2px; top:50%; transform:translateY(-50%); background:none; border:none; color:var(--icon-gray); font-size:15px; cursor:pointer; padding:5px 7px; border-radius:4px; }
        .keys-eye:hover { color:var(--text-main); }
        .keys-btn { width:100%; padding:8px; background:var(--accent-blue); color:var(--text-on-accent, #fff); border:none; border-radius:4px; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px; box-sizing:border-box; margin-top:12px; }
        .keys-btn:disabled { opacity:0.5; cursor:not-allowed; }
        .keys-btn.secondary { background:var(--icon-gray); }
        .keys-btn.danger { background:var(--color-danger); color:#fff; }
        .keys-btn.inline { width:auto; padding:5px 10px; margin-top:0; flex-shrink:0; }
        .keys-actions { display:flex; gap:8px; margin-top:10px; }
        .keys-actions .keys-btn { width:auto; flex:1; padding:7px; margin-top:0; }
        .keys-error { color:var(--color-danger); font-size:11px; min-height:14px; margin-top:6px; }
        .keys-ok { color:var(--color-success); font-size:11px; margin-top:6px; }
        .keys-hint { font-size:10px; color:var(--text-muted); line-height:1.6; padding:0; margin:6px 0 0; word-break:break-word; overflow-wrap:break-word; }
        .keys-card-info { display:flex; gap:10px; align-items:flex-start; padding:10px; background:var(--bg-panel); border-radius:6px; margin:0 0 8px; font-size:11px; color:var(--text-muted); line-height:1.5; }
        .keys-card-info > i { font-size:18px; color:var(--icon-gray); flex-shrink:0; }
        .keys-check { display:flex; gap:6px; align-items:flex-start; font-size:11px; color:var(--text-muted); margin:10px 0 0; cursor:pointer; line-height:1.5; user-select:none; }
        .keys-check input { margin:2px 0 0; flex-shrink:0; cursor:pointer; }
        .keys-chips { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0 0; }
        .keys-chip { font-size:10px; font-family:var(--font-mono); padding:2px 8px; background:var(--bg-panel); border:1px solid var(--border-color); border-radius:10px; color:var(--text-muted); cursor:pointer; }
        .keys-chip:hover { color:var(--accent-blue); border-color:var(--accent-blue); }
        .keys-meter { height:4px; background:var(--bg-panel); border:1px solid var(--border-color); border-radius:3px; margin-top:8px; overflow:hidden; }
        .keys-meter-bar { height:100%; width:0; transition:width .2s, background-color .2s; }
        .keys-meter-label { font-size:10px; color:var(--text-muted); margin-top:4px; min-height:13px; }
        /* full-sidebar screens: set a password / locked / erase */
        .keys-screen { flex:1; overflow-y:auto; padding:24px 15px 20px; display:flex; flex-direction:column; }
        .keys-screen-icon { width:48px; height:48px; border-radius:50%; background:var(--bg-panel); border:1px solid var(--border-color); display:flex; align-items:center; justify-content:center; font-size:22px; color:var(--accent-blue); margin:0 auto 12px; flex-shrink:0; }
        .keys-screen-icon.warn { color:var(--color-danger); }
        .keys-screen h2 { margin:0 0 6px; font-size:15px; text-align:center; font-weight:700; letter-spacing:-0.2px; }
        .keys-screen-sub { margin:0 0 10px; font-size:11px; color:var(--text-muted); text-align:center; line-height:1.6; }
        .keys-fineprint { font-size:10px; color:var(--text-muted); text-align:center; margin:12px 0 0; line-height:1.6; }
        .keys-linkbtn { background:none; border:none; color:var(--accent-blue); font-size:11px; cursor:pointer; margin:12px auto 0; padding:4px; }
        .keys-linkbtn:hover { text-decoration:underline; }
        /* My Keys: a flat list of entries with dashed dividers */
        .keys-list-head { display:flex; justify-content:space-between; align-items:center; padding:10px 15px 6px; font-size:11px; font-weight:700; letter-spacing:0.4px; color:var(--text-muted); text-transform:uppercase; }
        .keys-count { background:var(--bg-panel); color:var(--text-muted); padding:1px 6px; border-radius:9px; font-size:10px; margin-left:6px; border:1px solid var(--border-color); letter-spacing:0; }
        .keys-list-head .keys-icon { font-size:16px; text-transform:none; }
        .keys-searchbox { padding:0 15px 8px; }
        .keys-item { border-bottom:1px dashed var(--border-color); }
        .keys-item-main { display:flex; align-items:center; gap:8px; padding:8px 15px; cursor:default; }
        .keys-item-main:hover, .keys-item.open .keys-item-main { background:var(--bg-panel); }
        .keys-item-icon { font-size:15px; color:var(--icon-gray); flex-shrink:0; }
        .keys-item-info { flex:1; min-width:0; }
        .keys-item-name { font-size:12px; font-weight:500; color:var(--text-main); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .keys-item-meta { font-size:10px; color:var(--text-muted); margin-top:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .keys-item-actions { display:none; gap:2px; margin-left:auto; flex-shrink:0; font-size:15px; }
        .keys-item-actions .keys-icon { padding:3px 4px; }
        .keys-item-main:hover .keys-item-actions, .keys-item.open .keys-item-actions, .keys-item-main:focus-within .keys-item-actions { display:flex; }
        @media (hover: none) { .keys-item-actions { display:flex; } }
        .keys-item-body { padding:0 15px 10px 38px; }
        .keys-secret { font-family:var(--font-mono); font-size:11px; padding:6px 8px; background:var(--bg-panel); border:1px solid var(--border-color); border-radius:4px; word-break:break-all; white-space:pre-wrap; max-height:140px; overflow:auto; user-select:text; }
        .keys-item-notes { font-size:10px; color:var(--text-muted); margin-top:6px; white-space:pre-wrap; word-break:break-word; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
        .keys-confirm { margin-top:8px; padding:8px; border:1px solid var(--color-danger); border-radius:4px; font-size:11px; }
        .keys-confirm .keys-actions { margin-top:8px; }
        .keys-empty { text-align:center; color:var(--text-muted); font-size:12px; font-style:italic; padding:24px 15px; line-height:1.6; }
        .keys-empty i { font-size:26px; display:block; margin-bottom:6px; opacity:.6; font-style:normal; }
        .keys-setting { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:6px 0; font-size:12px; }
        .keys-setting small { display:block; color:var(--text-muted); font-size:10px; margin-top:1px; }
        /* On/off switch: same 40x22 pill as the toggles in Settings, so it no longer renders as a tiny native checkbox */
        .keys-switch { appearance:none; -webkit-appearance:none; outline:none; position:relative; flex-shrink:0; width:40px; height:22px; margin:0; background-color:var(--border-color); border-radius:12px; cursor:pointer; transition:background-color .3s; }
        .keys-switch::after { content:''; position:absolute; top:2px; left:2px; width:18px; height:18px; background-color:#fff; border-radius:50%; transition:transform .3s; box-shadow:0 2px 4px var(--shadow-color); }
        .keys-switch:checked { background-color:var(--accent-blue); }
        .keys-switch:checked::after { transform:translateX(18px); }
        .keys-switch:focus-visible { outline:2px solid var(--accent-blue); outline-offset:2px; }
        .keys-switch:disabled { opacity:0.5; cursor:not-allowed; }
        .keys-notes-list { margin:0; padding-left:16px; font-size:10px; color:var(--text-muted); line-height:1.6; }
        .keys-notes-list li { margin-bottom:3px; }
        .keys-notes-list.warn li::marker { color:var(--color-danger); }
        @keyframes kvspin { to { transform:rotate(360deg); } }
        .keys-toast { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); background:var(--text-main); color:var(--bg-white); padding:6px 12px; border-radius:14px; font-size:11px; opacity:0; pointer-events:none; transition:opacity .2s; z-index:5; max-width:90%; text-align:center; }
        .keys-toast.show { opacity:.95; }
        [data-theme-pack^="codemini-premium"] .keys-card-info { border-radius:14px; }
        [data-theme-pack^="codemini-premium"] .keys-input, [data-theme-pack^="codemini-premium"] .keys-select, [data-theme-pack^="codemini-premium"] .keys-textarea, [data-theme-pack^="codemini-premium"] .keys-btn, [data-theme-pack^="codemini-premium"] .keys-secret, [data-theme-pack^="codemini-premium"] .keys-confirm { border-radius:10px; }
        `;
        document.head.appendChild(style);
    }

    // ---- screens (full-sidebar: setup, locked, erase, damaged, unsupported) --------------------------------
    const pwField = (id, label, auto, mono) => `
        <label class="keys-label" for="${id}">${label}</label>
        <div class="keys-pw"><input id="${id}" type="password" class="keys-input${mono ? ' mono' : ''}" autocomplete="${auto || 'off'}" autocapitalize="off" autocorrect="off" spellcheck="false">
        <button type="button" class="keys-eye" data-k="toggle-pw" data-target="${id}" title="Show or hide" aria-label="Show or hide password"><i class="ri-eye-line"></i></button></div>`;
    const meter = (idPrefix) => `<div class="keys-meter"><div class="keys-meter-bar" id="${idPrefix}Bar"></div></div><div class="keys-meter-label" id="${idPrefix}Label"></div>`;

    function screenSetup() {
        return `<div class="keys-screen">
            <div class="keys-screen-icon"><i class="ri-shield-keyhole-line"></i></div>
            <h2>Create your vault password</h2>
            <p class="keys-screen-sub">Your keys are encrypted on this device with this password, and you will enter it every time you open My Keys.</p>
            ${pwField('kvPw1', 'Password', 'new-password')}
            ${meter('kvM1')}
            ${pwField('kvPw2', 'Confirm password', 'new-password')}
            <label class="keys-check"><input type="checkbox" id="kvAck"><span>I understand there is <b>no way to recover</b> a forgotten password. If I lose it, my saved keys are gone.</span></label>
            <div class="keys-error" id="kvErr" role="alert"></div>
            <button type="button" class="keys-btn" id="kvCreate" data-k="create" disabled>Create vault</button>
            <p class="keys-fineprint">Nothing is uploaded. Each window or profile has its own vault.</p>
        </div>`;
    }
    function screenLocked() {
        return `<div class="keys-screen">
            <div class="keys-screen-icon"><i class="ri-lock-2-line"></i></div>
            <h2>My Keys is locked</h2>
            <p class="keys-screen-sub">${st.notice ? esc(st.notice) + ' ' : ''}Enter your vault password to continue.</p>
            ${pwField('kvPw', 'Password', 'current-password')}
            <div class="keys-error" id="kvErr" role="alert"></div>
            <button type="button" class="keys-btn" id="kvUnlock" data-k="unlock"><i class="ri-lock-unlock-line"></i> Unlock</button>
            <button type="button" class="keys-linkbtn" data-k="forgot">Forgot your password?</button>
        </div>`;
    }
    function screenErase(damaged) {
        return `<div class="keys-screen">
            <div class="keys-screen-icon warn"><i class="ri-error-warning-line"></i></div>
            <h2>${damaged ? 'Vault data is unreadable' : 'Erase this vault?'}</h2>
            <p class="keys-screen-sub">${damaged ? 'The saved vault data is damaged and cannot be opened.' : 'Without the password, saved keys cannot be recovered.'} Erasing deletes <b>everything</b> in this vault permanently, so you can set a new password and start fresh.</p>
            <label class="keys-label" for="kvEraseConfirm">Type ERASE to confirm</label>
            <input id="kvEraseConfirm" class="keys-input" autocomplete="off" autocapitalize="characters" spellcheck="false">
            <div class="keys-error" id="kvErr" role="alert"></div>
            <button type="button" class="keys-btn danger" id="kvEraseBtn" data-k="erase" disabled><i class="ri-delete-bin-line"></i> Erase vault</button>
            ${damaged ? '' : '<button type="button" class="keys-btn secondary" data-k="erase-cancel">Cancel</button>'}
        </div>`;
    }
    function screenUnsupported() {
        return `<div class="keys-screen">
            <div class="keys-screen-icon warn"><i class="ri-shield-cross-line"></i></div>
            <h2>Encryption is not available</h2>
            <p class="keys-screen-sub">My Keys needs the browser's built-in encryption (Web Crypto), which only works on a secure connection (HTTPS or localhost). Open CodeMini over HTTPS to use it.</p>
        </div>`;
    }

    // ---- main (unlocked) layout -----------------------------------------------------------------------------
    function typeOptions(sel) { return TYPES.map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join(''); }
    function selectOptions(list, cur, fmt) { return list.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${fmt(v)}</option>`).join(''); }
    const fmtMin = (m) => (m === 60 ? '1 hour' : `${m} min`);

    function mainHTML() {
        const c = cfg();
        return `
        <div class="keys-tabs">
            <div class="keys-tab" data-k="tab" data-tab="add" id="kvTabAdd">Add Keys</div>
            <div class="keys-tab" data-k="tab" data-tab="my" id="kvTabMy">My Keys</div>
            <div class="keys-tab" data-k="tab" data-tab="config">Config</div>
        </div>
        <div class="keys-panes">
            <div class="keys-pane" data-pane="add"><div class="keys-box" id="kvAddForm"></div></div>
            <div class="keys-pane" data-pane="my">
                <div class="keys-list-head keys-toolbar"><span>Your keys<span class="keys-count" id="kvCount">0</span></span>
                    <i class="ri-lock-line keys-icon" data-k="lock" title="Lock now" aria-label="Lock now"></i></div>
                <div class="keys-searchbox"><input id="kvSearch" class="keys-input" type="search" placeholder="Search keys" autocomplete="off" spellcheck="false"></div>
                <div id="kvList"></div>
            </div>
            <div class="keys-pane" data-pane="config">
                <div class="keys-box">
                    <div class="keys-sec-title">Security</div>
                    <div class="keys-setting"><div>Auto-lock after<small>When you stop using the app</small></div>
                        <select class="keys-select" data-cfg="idleMin">${selectOptions(IDLE_CHOICES, c.idleMin, fmtMin)}</select></div>
                    <div class="keys-setting"><div>Lock when this sidebar closes<small>Recommended</small></div>
                        <input type="checkbox" class="keys-switch" data-cfg="lockOnClose"${c.lockOnClose ? ' checked' : ''}></div>
                    <div class="keys-setting"><div>Lock when the app goes to the background<small>Switching apps or tabs</small></div>
                        <input type="checkbox" class="keys-switch" data-cfg="lockOnHide"${c.lockOnHide ? ' checked' : ''}></div>
                    <div class="keys-setting"><div>Hide a revealed key after<small>Revealed values hide again by themselves</small></div>
                        <select class="keys-select" data-cfg="revealSec">${selectOptions(REVEAL_CHOICES, c.revealSec, (s) => `${s} sec`)}</select></div>
                    <button type="button" class="keys-btn secondary" data-k="lock"><i class="ri-lock-line"></i> Lock now</button>
                </div>

                <div class="keys-box">
                    <div class="keys-sec-title">Change password</div>
                    ${pwField('kvCurPw', 'Current password', 'current-password')}
                    ${pwField('kvNewPw', 'New password', 'new-password')}
                    ${meter('kvM2')}
                    ${pwField('kvNewPw2', 'Confirm new password', 'new-password')}
                    <div class="keys-error" id="kvPwErr" role="alert"></div>
                    <button type="button" class="keys-btn" id="kvChangePw" data-k="change-pw">Change password</button>
                </div>

                <div class="keys-box">
                    <div class="keys-sec-title">Backup</div>
                    <div class="keys-card-info"><i class="ri-archive-line"></i><div>Backups stay encrypted with the password they were made with, so the file is safe to store. Keep it somewhere private.</div></div>
                    <div class="keys-actions">
                        <button type="button" class="keys-btn secondary" data-k="export"><i class="ri-download-2-line"></i> Export</button>
                        <button type="button" class="keys-btn secondary" data-k="import-pick"><i class="ri-upload-2-line"></i> Import</button>
                    </div>
                    <input type="file" id="kvImportFile" accept="application/json,.json" style="display:none">
                    <div id="kvImportBox"></div>
                    <div class="keys-error" id="kvBackupMsg" role="status"></div>
                </div>

                <div class="keys-box">
                    <div class="keys-sec-title">How your keys are protected</div>
                    <ul class="keys-notes-list">
                        <li>Encrypted with AES-256-GCM. The key comes from your password via PBKDF2 (600,000 rounds).</li>
                        <li>Stored only on this device, never uploaded. Your password is never saved.</li>
                        <li>This window or profile has its own vault.</li>
                        <li>There is no recovery. Export a backup and keep your password safe.</li>
                    </ul>
                    <div class="keys-sec-title" style="margin-top:12px">What it cannot protect against</div>
                    <ul class="keys-notes-list warn">
                        <li>Code you run inside CodeMini (previews, notebooks, terminal) shares the app's page. Keep the vault locked while running code you don't trust.</li>
                        <li>Malware, screen recording, or someone watching your screen.</li>
                        <li>A weak password. Copying a key also places it on your clipboard, where other apps can read it.</li>
                    </ul>
                </div>

                <div class="keys-box">
                    <div class="keys-sec-title">Danger zone</div>
                    <button type="button" class="keys-btn danger" id="kvEraseOpen" data-k="forgot" style="margin-top:0"><i class="ri-delete-bin-line"></i> Erase vault</button>
                </div>
            </div>
        </div>
        <div class="keys-toast" id="kvToast" role="status"></div>`;
    }

    function addFormHTML() {
        const e = st.editId && st.entries ? st.entries.find((x) => x.id === st.editId) : null;
        return `
            <div class="keys-sec-title">${e ? 'Edit key' : 'Add a key'}</div>
            <label class="keys-label" for="kvName">Name *</label>
            <input id="kvName" class="keys-input" maxlength="${LIMITS.name}" placeholder="e.g. OpenAI production" autocomplete="off" spellcheck="false" value="${e ? esc(e.name) : ''}">
            <label class="keys-label" for="kvService">Service</label>
            <input id="kvService" class="keys-input" maxlength="${LIMITS.service}" placeholder="e.g. OpenAI" autocomplete="off" spellcheck="false" value="${e ? esc(e.service) : ''}">
            <div class="keys-chips">${SERVICES.slice(0, 8).map((n) => `<span class="keys-chip" data-k="service-chip" data-service="${esc(n)}">${esc(n)}</span>`).join('')}</div>
            <label class="keys-label" for="kvType">Type</label>
            <select id="kvType" class="keys-select full">${typeOptions(e ? e.type : 'api')}</select>
            <label class="keys-label" for="kvValue">${e ? 'Value (leave blank to keep the current one)' : 'Value *'}</label>
            <div id="kvValueWrap"></div>
            <label class="keys-check"><input type="checkbox" id="kvMulti"><span>Multi-line value (for example a private key)</span></label>
            <label class="keys-label" for="kvNotes">Notes</label>
            <textarea id="kvNotes" class="keys-textarea" rows="3" maxlength="${LIMITS.notes}" placeholder="Optional">${e ? esc(e.notes) : ''}</textarea>
            <div class="keys-error" id="kvAddErr" role="alert"></div>
            <button type="button" class="keys-btn" id="kvSaveEntry" data-k="save-entry"><i class="ri-save-3-line"></i> ${e ? 'Save changes' : 'Save key'}</button>
            ${e ? '<button type="button" class="keys-btn secondary" data-k="cancel-edit">Cancel</button>' : ''}`;
    }
    function setValueField(multi, keep) {
        const wrap = $('kvValueWrap'); if (!wrap) return;
        const prev = $('kvValue') ? $('kvValue').value : '';
        wrap.innerHTML = multi
            ? `<textarea id="kvValue" class="keys-textarea mono" rows="5" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the full value"></textarea>`
            : `<div class="keys-pw"><input id="kvValue" type="password" class="keys-input mono" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${st.editId ? 'Unchanged' : 'Paste or type the secret'}">
               <button type="button" class="keys-eye" data-k="toggle-pw" data-target="kvValue" title="Show or hide" aria-label="Show or hide value"><i class="ri-eye-line"></i></button></div>`;
        if (keep) $('kvValue').value = prev;
    }
    function renderAddForm() {
        const f = $('kvAddForm'); if (!f) return;
        f.innerHTML = addFormHTML();
        setValueField(false, false);
    }

    function fmtDate(ts) { try { return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return ''; } }
    function renderList() {
        const list = $('kvList'); if (!list || !st.entries) return;
        const cnt = $('kvCount'); if (cnt) cnt.textContent = String(st.entries.length);
        const q = st.search.trim().toLowerCase();
        const typeLabel = (t) => (TYPES.find((x) => x[0] === t) || [0, 'Other'])[1];
        const shown = st.entries
            .filter((e) => !q || [e.name, e.service, typeLabel(e.type), e.notes].some((s) => s.toLowerCase().includes(q)))
            .sort((a, b) => a.name.localeCompare(b.name));
        if (!st.entries.length) {
            list.innerHTML = `<div class="keys-empty"><i class="ri-key-2-line"></i>No keys saved yet.<br><button type="button" class="keys-linkbtn" data-k="tab" data-tab="add">Add your first key</button></div>`;
            return;
        }
        if (!shown.length) { list.innerHTML = `<div class="keys-empty">No keys match "${esc(st.search)}".</div>`; return; }
        list.innerHTML = shown.map((e) => {
            const revealed = st.revealId === e.id, confirming = st.confirmDeleteId === e.id;
            const meta = [e.service, typeLabel(e.type), fmtDate(e.updated)].filter(Boolean).map(esc).join(' · ');
            const hasBody = revealed || confirming || e.notes;
            return `<div class="keys-item${revealed || confirming ? ' open' : ''}" data-id="${e.id}">
                <div class="keys-item-main">
                    <i class="${TYPE_ICON[e.type] || TYPE_ICON.other} keys-item-icon"></i>
                    <div class="keys-item-info"><div class="keys-item-name" title="${esc(e.name)}">${esc(e.name)}</div><div class="keys-item-meta">${meta}</div></div>
                    <div class="keys-item-actions">
                        <i class="${revealed ? 'ri-eye-off-line' : 'ri-eye-line'} keys-icon" data-k="reveal" data-id="${e.id}" title="${revealed ? 'Hide' : 'Reveal'}"></i>
                        <i class="ri-file-copy-line keys-icon" data-k="copy" data-id="${e.id}" title="Copy value"></i>
                        <i class="ri-edit-line keys-icon" data-k="edit" data-id="${e.id}" title="Edit"></i>
                        <i class="ri-delete-bin-line keys-icon" data-k="delete" data-id="${e.id}" title="Delete"></i>
                    </div>
                </div>
                ${hasBody ? `<div class="keys-item-body">
                    ${revealed ? '<div class="keys-secret" id="kvSecret"></div>' : ''}
                    ${e.notes ? `<div class="keys-item-notes">${esc(e.notes)}</div>` : ''}
                    ${confirming ? `<div class="keys-confirm">Delete "${esc(e.name)}"? This cannot be undone.<div class="keys-actions">
                        <button type="button" class="keys-btn danger inline" data-k="delete-yes" data-id="${e.id}">Delete</button>
                        <button type="button" class="keys-btn secondary inline" data-k="delete-no">Cancel</button></div></div>` : ''}
                </div>` : ''}
            </div>`;
        }).join('');
        if (st.revealId) {
            const s = $('kvSecret'), e = st.entries.find((x) => x.id === st.revealId);
            if (s && e) s.textContent = e.value; // textContent: never parsed as HTML
        }
    }

    function showTab(name) {
        st.tab = name;
        const r = root(); if (!r) return;
        r.querySelectorAll('.keys-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
        r.querySelectorAll('.keys-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
    }
    function toast(msg) {
        const t = $('kvToast'); if (!t) return;
        t.textContent = msg; t.classList.add('show');
        clearTimeout(st.toastTimer);
        st.toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
    }

    // ---- render ---------------------------------------------------------------------------------------------
    function render() {
        injectStyles();
        const r = root(); if (!r) return;
        clearInterval(st.lockTick);
        const w = winId();
        let body = '', unlocked = false, tag = '';
        if (!st.supported) { body = screenUnsupported(); tag = 'unsupported'; }
        else if (st.key && st.unlockedWin === w) { unlocked = true; tag = 'main'; }
        else {
            if (st.key) { st.key = null; st.entries = null; st.unlockedWin = null; clearReveal(); stopIdle(); }
            const rec = readRecord(w);
            if (rec.state === 'none') { body = screenSetup(); tag = 'setup'; }
            else if (rec.state === 'damaged') { body = screenErase(true); tag = 'damaged'; }
            else if (st.view === 'forgot') { body = screenErase(false); tag = 'forgot'; }
            else { st.record = rec.record; body = screenLocked(); tag = 'locked'; }
        }
        if (unlocked && st.view === 'forgot') { body = screenErase(false); unlocked = false; tag = 'forgot'; }
        r.innerHTML = `
            <div class="keys-header"><div class="keys-title">My Keys</div>
                <div class="keys-icons">
                    <i class="ri-refresh-line keys-icon${unlocked ? '' : ' hidden'}" data-k="refresh" title="Refresh"></i>
                    <i class="ri-close-line keys-icon" data-k="close" title="Close My Keys"></i>
                </div></div>
            ${unlocked ? mainHTML() : body}`;
        r.dataset.screen = tag;
        if (unlocked) {
            renderAddForm(); renderList(); showTab(st.tab);
            const s = $('kvSearch'); if (s) s.value = st.search;
        } else {
            updateSetupState();
            if (tag === 'locked') armLockCountdown();
            if (window.innerWidth > 768 && isOpen()) {
                const first = $('kvPw1') || $('kvPw') || $('kvEraseConfirm');
                if (first) setTimeout(() => first.focus(), 30);
            }
        }
    }

    function updateSetupState() {
        const p1 = $('kvPw1'); if (!p1) return;
        const ev = evaluatePassword(p1.value), p2 = $('kvPw2');
        paintMeter('kvM1', ev, p1.value);
        const match = p1.value === p2.value && p2.value.length > 0;
        $('kvCreate').disabled = st.busy || !(ev.ok && match && $('kvAck').checked);
        const err = $('kvErr');
        if (err && !err.dataset.sticky) err.textContent = (p2.value && !match) ? 'Passwords do not match.' : '';
    }
    function paintMeter(prefix, ev, value) {
        const bar = $(prefix + 'Bar'), lab = $(prefix + 'Label'); if (!bar || !lab) return;
        const colors = ['var(--color-danger)', 'var(--color-danger)', 'var(--color-warning)', 'var(--color-success)', 'var(--color-success)'];
        bar.style.width = value ? `${(ev.score + 1) * 20}%` : '0';
        bar.style.background = colors[ev.score];
        lab.textContent = value ? `${ev.label}. ${ev.hint}`.trim() : ev.hint;
    }
    function armLockCountdown() {
        const tick = () => {
            const b = $('kvUnlock'), err = $('kvErr'); if (!b) { clearInterval(st.lockTick); return; }
            const left = Math.ceil((readGuard(winId()).until - Date.now()) / 1000);
            if (left > 0) { b.disabled = true; if (err) err.textContent = `Too many attempts. Try again in ${left}s.`; }
            else if (b.disabled && !st.busy) { b.disabled = false; if (err) err.textContent = ''; }
        };
        tick();
        if (readGuard(winId()).until > Date.now()) st.lockTick = setInterval(tick, 1000);
    }

    // ---- actions --------------------------------------------------------------------------------------------
    function setBusy(btn, on, label) {
        st.busy = on;
        if (!btn) return;
        if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<i class="ri-loader-4-line" style="animation:kvspin .8s linear infinite"></i> ${label}`; }
        else { btn.innerHTML = btn.dataset.label || btn.innerHTML; btn.disabled = false; }
    }

    // Runs when a vault is opened. The first time only records `since`; after that it reminds (at most weekly)
    // when there has never been a backup for a couple of days, or the last one is a month old.
    function maybeNudgeBackup() {
        const c = st.cfg, now = Date.now();
        if (!c) return;
        if (!c.since) { c.since = now; saveCfg(); return; }
        const due = c.lastBackup ? now - c.lastBackup >= BACKUP_STALE_MS : now - c.since >= BACKUP_FIRST_MS;
        if (!due || (c.backupNudge && now - c.backupNudge < BACKUP_REPEAT_MS)) return;
        c.backupNudge = now; saveCfg();
        notifyApp({
            id: 'vault-backup',
            kind: 'backup',
            title: c.lastBackup ? 'Time to back up My Keys' : 'Back up My Keys',
            text: (c.lastBackup ? 'Your last encrypted backup is over a month old. ' : 'You have not exported an encrypted backup yet. ') +
                'A forgotten password cannot be recovered, and the vault exists only in this browser. ' +
                'Open the Config tab and choose Export, then keep the file somewhere safe.'
        });
    }

    function openSession(key, entries, record, w) {
        st.key = key; st.entries = entries; st.record = record; st.unlockedWin = w;
        st.cfg = loadCfg(w); st.tab = entries.length ? 'my' : 'add'; st.notice = ''; st.view = 'main'; st.search = '';
        startIdle(); render();
        emitState();
        maybeNudgeBackup();
    }

    async function doCreate() {
        const w = winId(), p1 = $('kvPw1').value, p2 = $('kvPw2').value, err = $('kvErr');
        if (!evaluatePassword(p1).ok || p1 !== p2 || !$('kvAck').checked) return;
        setBusy($('kvCreate'), true, 'Encrypting…');
        try {
            const { key, record } = await createRecord(p1, []);
            writeRecord(w, record);
            clearGuard(w);
            $('kvPw1').value = ''; $('kvPw2').value = '';
            setBusy(null, false);
            openSession(key, [], record, w);
        } catch (e) {
            setBusy($('kvCreate'), false);
            err.dataset.sticky = '1';
            err.textContent = e.code === 'storage' ? 'Could not save: browser storage is full or blocked.' : 'Could not create the vault.';
        }
    }

    async function doUnlock() {
        const w = winId(), inp = $('kvPw'), err = $('kvErr');
        if (!inp || !inp.value) { err.textContent = 'Enter your password.'; return; }
        if (readGuard(w).until > Date.now()) return;
        const rec = readRecord(w);
        if (rec.state !== 'ok') { render(); return; }
        setBusy($('kvUnlock'), true, 'Unlocking…');
        try {
            const { key, entries } = await unlockRecord(inp.value, rec.record);
            inp.value = '';
            clearGuard(w);
            setBusy(null, false);
            openSession(key, entries, rec.record, w);
        } catch (e) {
            setBusy($('kvUnlock'), false);
            if (e.code === 'wrong-password') {
                const g = registerFailure(w);
                inp.value = ''; inp.focus();
                err.textContent = 'Incorrect password.';
                if (g.until > Date.now()) armLockCountdown();
            } else { err.textContent = 'This vault could not be read.'; render(); }
        }
    }

    function eraseVault() {
        const w = st.unlockedWin || winId();
        [recKey(w), cfgKey(w), guardKey(w)].forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
        st.key = null; st.entries = null; st.unlockedWin = null; st.record = null; st.cfg = null;
        clearReveal(); stopIdle(); st.view = 'main'; st.editId = null; st.notice = '';
        clearNotice('vault-backup'); // nothing left to back up
        render();
    }

    async function saveEntry() {
        if (!guardWindow()) return;
        const err = $('kvAddErr'), btn = $('kvSaveEntry');
        const name = $('kvName').value.trim(), value = $('kvValue').value;
        const editing = st.editId ? st.entries.find((x) => x.id === st.editId) : null;
        if (!name) { err.textContent = 'Give the key a name.'; return; }
        if (!editing && !value) { err.textContent = 'Enter the value to store.'; return; }
        if (value.length > LIMITS.value) { err.textContent = `Value is too long (max ${LIMITS.value} characters).`; return; }
        if (!editing && st.entries.length >= LIMITS.entries) { err.textContent = `Vault is full (max ${LIMITS.entries} keys).`; return; }
        err.textContent = '';
        const data = { name, service: $('kvService').value.trim(), type: $('kvType').value, notes: $('kvNotes').value };
        setBusy(btn, true, 'Saving…');
        try {
            const id = editing ? editing.id : newId();
            await commit((list) => {
                const now = Date.now(), i = list.findIndex((x) => x.id === id);
                if (i >= 0) list[i] = Object.assign({}, list[i], data, { value: value || list[i].value, updated: now });
                else list.push(Object.assign({ id, value, created: now, updated: now }, data));
                return list;
            });
            setBusy(btn, false);
            const wasEdit = !!editing;
            st.editId = null; st.search = '';
            renderAddForm(); renderList(); showTab('my');
            toast(wasEdit ? 'Changes saved' : 'Key saved');
        } catch (e) {
            setBusy(btn, false);
            if (e.code === 'locked') return;
            err.textContent = e.code === 'storage' ? 'Could not save: browser storage is full or blocked.' : 'Could not save this key.';
        }
    }

    async function copyText(text) {
        try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall through */ }
        try {
            const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
            document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
        } catch (e) { return false; }
    }

    function exportBackup() {
        if (!guardWindow()) return;
        const blob = new Blob([JS(st.record, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `codemini-keys-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        const m = $('kvBackupMsg'); if (m) { m.className = 'keys-ok'; m.textContent = 'Encrypted backup downloaded.'; }
        if (st.cfg) { st.cfg.lastBackup = Date.now(); saveCfg(); }
        clearNotice('vault-backup'); // the reminder has been answered
    }
    function importPicked(file) {
        const m = $('kvBackupMsg'), box = $('kvImportBox');
        const fail = (t) => { m.className = 'keys-error'; m.textContent = t; box.innerHTML = ''; st.importRec = null; };
        if (!file) return;
        if (file.size > MAX_RECORD_BYTES * 1.4) return fail('That file is too large to be a backup.');
        const fr = new FileReader();
        fr.onload = () => {
            let rec = null;
            try { rec = JP(String(fr.result)); } catch (e) { /* handled below */ }
            if (!validateRecord(rec)) return fail('That is not a valid CodeMini keys backup.');
            st.importRec = rec; m.textContent = '';
            box.innerHTML = `<div style="margin-top:10px">${pwField('kvImpPw', 'Password of that backup', 'off')}
                <div class="keys-actions"><button type="button" class="keys-btn" id="kvImpGo" data-k="import-run">Import</button>
                <button type="button" class="keys-btn secondary" data-k="import-cancel">Cancel</button></div></div>`;
        };
        fr.onerror = () => fail('Could not read that file.');
        fr.readAsText(file);
    }
    async function runImport() {
        if (!guardWindow() || !st.importRec) return;
        const m = $('kvBackupMsg'), pw = $('kvImpPw'), btn = $('kvImpGo');
        if (!pw.value) { m.className = 'keys-error'; m.textContent = 'Enter that backup\'s password.'; return; }
        setBusy(btn, true, 'Importing…');
        try {
            const { entries } = await unlockRecord(pw.value, st.importRec);
            let result = null;
            await commit((list) => { result = mergeEntries(list, entries); return result.entries; });
            pw.value = ''; st.importRec = null; $('kvImportBox').innerHTML = '';
            setBusy(null, false); renderList();
            m.className = 'keys-ok'; m.textContent = `Imported ${result.added} new and updated ${result.updated} existing.`;
        } catch (e) {
            setBusy(btn, false);
            if (e.code === 'locked') return;
            m.className = 'keys-error';
            m.textContent = e.code === 'wrong-password' ? 'Incorrect password for that backup.' : e.code === 'storage' ? 'Could not save: browser storage is full or blocked.' : 'Could not import that backup.';
        }
    }

    async function changePassword() {
        if (!guardWindow()) return;
        const err = $('kvPwErr'), btn = $('kvChangePw');
        const cur = $('kvCurPw').value, nw = $('kvNewPw').value, nw2 = $('kvNewPw2').value;
        err.className = 'keys-error';
        if (!cur) { err.textContent = 'Enter your current password.'; return; }
        if (!evaluatePassword(nw).ok) { err.textContent = evaluatePassword(nw).hint || 'Choose a stronger password.'; return; }
        if (nw !== nw2) { err.textContent = 'The new passwords do not match.'; return; }
        if (nw === cur) { err.textContent = 'The new password must be different.'; return; }
        err.textContent = '';
        setBusy(btn, true, 'Re-encrypting…');
        try {
            if (!(await resync())) { setBusy(btn, false); return; }
            await unlockRecord(cur, st.record); // proves the current password
            const { key, record } = await createRecord(nw, st.entries);
            writeRecord(st.unlockedWin, record);
            st.key = key; st.record = record;
            ['kvCurPw', 'kvNewPw', 'kvNewPw2'].forEach((id) => { $(id).value = ''; });
            paintMeter('kvM2', evaluatePassword(''), '');
            setBusy(btn, false);
            err.className = 'keys-ok'; err.textContent = 'Password changed.';
        } catch (e) {
            setBusy(btn, false);
            err.textContent = e.code === 'wrong-password' ? 'Current password is incorrect.' : e.code === 'storage' ? 'Could not save: browser storage is full or blocked.' : 'Could not change the password.';
        }
    }

    function revealEntry(id) {
        if (!guardWindow()) return;
        const hide = st.revealId === id;
        clearReveal();
        if (!hide) {
            st.revealId = id;
            st.revealTimer = setTimeout(() => { clearReveal(); renderList(); }, cfg().revealSec * 1000);
        }
        renderList();
    }

    function onClick(ev) {
        const el = ev.target.closest('[data-k]'); if (!el || !root() || !root().contains(el)) return;
        const k = el.dataset.k, id = el.dataset.id;
        if (k !== 'close' && k !== 'toggle-pw' && k !== 'forgot' && k !== 'erase' && k !== 'erase-cancel' && k !== 'unlock' && k !== 'create' && st.key && !guardWindow()) return;
        switch (k) {
            case 'close': if (window.closeAllSidebars) window.closeAllSidebars(); if (window.saveCurrentUIState) window.saveCurrentUIState(); break;
            case 'refresh': resync().then((ok) => { if (!ok) return; clearReveal(); renderList(); toast('Refreshed'); }); break;
            case 'toggle-pw': {
                const inp = $(el.dataset.target); if (!inp) break;
                const show = inp.type === 'password'; inp.type = show ? 'text' : 'password';
                el.innerHTML = `<i class="${show ? 'ri-eye-off-line' : 'ri-eye-line'}"></i>`; break;
            }
            case 'create': doCreate(); break;
            case 'unlock': doUnlock(); break;
            case 'forgot': st.view = 'forgot'; render(); break;
            case 'erase-cancel': st.view = 'main'; render(); break;
            case 'erase': if ($('kvEraseConfirm') && $('kvEraseConfirm').value.trim() === 'ERASE') eraseVault(); break;
            case 'tab': showTab(el.dataset.tab); break;
            case 'service-chip': { const f = $('kvService'); if (f) { f.value = el.dataset.service || ''; f.focus(); } break; }
            case 'lock': lock(''); break;
            case 'save-entry': saveEntry(); break;
            case 'cancel-edit': st.editId = null; renderAddForm(); showTab('my'); break;
            case 'reveal': revealEntry(id); break;
            case 'copy': {
                const e = st.entries.find((x) => x.id === id); if (!e) break;
                copyText(e.value).then((ok) => toast(ok ? 'Copied to clipboard' : 'Could not copy')); break;
            }
            case 'edit': st.editId = id; clearReveal(); renderAddForm(); renderList(); showTab('add'); break;
            case 'delete': st.confirmDeleteId = id; renderList(); break;
            case 'delete-no': st.confirmDeleteId = null; renderList(); break;
            case 'delete-yes':
                commit((list) => list.filter((x) => x.id !== id)).then(() => { st.confirmDeleteId = null; clearReveal(); renderList(); toast('Key deleted'); }).catch(() => { /* locked or storage */ });
                break;
            case 'change-pw': changePassword(); break;
            case 'export': exportBackup(); break;
            case 'import-pick': { const f = $('kvImportFile'); if (f) { f.value = ''; f.click(); } break; }
            case 'import-run': runImport(); break;
            case 'import-cancel': st.importRec = null; $('kvImportBox').innerHTML = ''; break;
            default: break;
        }
    }
    function onInput(ev) {
        const t = ev.target;
        if (t.id === 'kvPw1' || t.id === 'kvPw2') { const e = $('kvErr'); if (e) delete e.dataset.sticky; updateSetupState(); }
        else if (t.id === 'kvNewPw') paintMeter('kvM2', evaluatePassword(t.value), t.value);
        else if (t.id === 'kvEraseConfirm') $('kvEraseBtn').disabled = t.value.trim() !== 'ERASE';
        else if (t.id === 'kvSearch') { st.search = t.value; renderList(); }
    }
    function onChange(ev) {
        const t = ev.target;
        if (t.id === 'kvAck') updateSetupState();
        else if (t.id === 'kvMulti') setValueField(t.checked, true);
        else if (t.id === 'kvImportFile') importPicked(t.files && t.files[0]);
        else if (t.dataset && t.dataset.cfg && st.key) {
            const key = t.dataset.cfg;
            if (key === 'idleMin' || key === 'revealSec') st.cfg[key] = parseInt(t.value, 10);
            else st.cfg[key] = !!t.checked;
            st.cfg = loadCfgFrom(st.cfg); saveCfg();
        }
    }
    const loadCfgFrom = (c) => ({
        idleMin: IDLE_CHOICES.includes(c.idleMin) ? c.idleMin : DEFAULT_CFG.idleMin, lockOnClose: !!c.lockOnClose,
        lockOnHide: !!c.lockOnHide, revealSec: REVEAL_CHOICES.includes(c.revealSec) ? c.revealSec : DEFAULT_CFG.revealSec,
        since: stamp(c.since), lastBackup: stamp(c.lastBackup), backupNudge: stamp(c.backupNudge)
    });
    function onKeydown(ev) {
        if (ev.key !== 'Enter' || ev.target.tagName === 'TEXTAREA') return;
        const id = ev.target.id;
        if (id === 'kvPw') doUnlock();
        else if (id === 'kvPw2' && !$('kvCreate').disabled) doCreate();
        else if (id === 'kvEraseConfirm' && !$('kvEraseBtn').disabled) eraseVault();
        else if (id === 'kvImpPw') runImport();
    }

    // ---- wiring ---------------------------------------------------------------------------------------------
    function ensureResizer(sb) {
        if (sb.querySelector('.sidebar-resizer')) return;
        const rz = document.createElement('div'); rz.className = 'sidebar-resizer'; sb.appendChild(rz);
        if (typeof window.makeResizable !== 'function') return;
        let startWidth = 0;
        window.makeResizable(rz, {
            cursor: 'ew-resize',
            onStart: () => { startWidth = sb.offsetWidth; sb.style.transition = 'none'; },
            onMove: (dx) => { let w = startWidth + dx; if (w < 220) w = 220; if (w > window.innerWidth * 0.6) w = window.innerWidth * 0.6; document.documentElement.style.setProperty('--sidebar-width', `${w}px`); },
            onEnd: () => { sb.style.transition = ''; localStorage.setItem(`codemini_sidebar_width_${winId()}`, sb.offsetWidth); }
        });
    }

    function init() {
        const sb = sidebar(); if (!sb) return;
        injectStyles();
        sb.innerHTML = '<div class="keys-root" id="kvRoot"></div>';
        ensureResizer(sb);
        sb.addEventListener('click', onClick);
        sb.addEventListener('input', onInput);
        sb.addEventListener('change', onChange);
        sb.addEventListener('keydown', onKeydown);

        // The activity-bar menu item. Bound on the element itself: the main menu's own
        // handler stops clicks from bubbling up to the document, so document-level delegation never sees them.
        // The same element is reused when it is dragged between the overflow menu and the activity bar.
        const menuItem = $('menuKeys');
        if (menuItem) menuItem.addEventListener('click', () => {
            document.getElementById('mainMenuDropdown')?.classList.remove('show');
            const wasOpen = isOpen();
            if (window.closeAllSidebars) window.closeAllSidebars();
            if (!wasOpen) { sb.classList.add('open'); menuItem.classList.add('active'); }
            if (window.saveCurrentUIState) window.saveCurrentUIState();
        });

        // Locking when the sidebar closes, however it was closed (menu item, another sidebar, close icon, restore).
        let wasOpen = isOpen();
        new MutationObserver(() => {
            const now = isOpen();
            if (wasOpen && !now && st.key && cfg().lockOnClose) lock('');
            else if (!wasOpen && now) render();
            wasOpen = now;
        }).observe(sb, { attributes: true, attributeFilter: ['class'] });

        // Activity for the idle timer, and the other automatic locks.
        const touch = () => { st.lastActivity = Date.now(); };
        ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((n) => document.addEventListener(n, touch, { passive: true, capture: true }));
        let lastMove = 0;
        document.addEventListener('pointermove', () => { const n = Date.now(); if (n - lastMove > 1000) { lastMove = n; touch(); } }, { passive: true, capture: true });
        document.addEventListener('visibilitychange', () => {
            if (!st.key) return;
            if (document.hidden && cfg().lockOnHide) lock('hidden');
            else if (!document.hidden && Date.now() - st.lastActivity > cfg().idleMin * 60000) lock('idle');
        });
        window.addEventListener('pagehide', () => { if (st.key) lock(''); });
        window.addEventListener('storage', (e) => {
            if (!e.key || e.key !== recKey(st.unlockedWin || winId())) return;
            if (st.key) resync().then((ok) => { if (ok) renderList(); }); else render();
        });

        render();
        W.CodeMiniKeys = Object.freeze({
            isUnlocked: () => !!st.key && st.unlockedWin === winId(),
            lock: () => lock(''),
            getSecret,
            setSecret,
            removeSecret,
            // Brings up the My Keys password prompt (or setup screen) so the person can unlock the vault.
            requestUnlock: () => {
                const sb2 = sidebar(); if (!sb2) return;
                if (!isOpen()) {
                    if (W.closeAllSidebars) W.closeAllSidebars();
                    sb2.classList.add('open');
                    const mi = $('menuKeys'); if (mi) mi.classList.add('active');
                    if (W.saveCurrentUIState) W.saveCurrentUIState();
                } else render();
            }
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();