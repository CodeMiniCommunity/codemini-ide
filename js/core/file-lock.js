// ==========================================
// file-lock.js - the crypto behind "Lock File / Lock Folder".
// ==========================================
// WHAT IS STORED
//   A locked record never holds its password. It holds `lock`: { v, kdf, iter, salt, check }.
//   PBKDF2-SHA256 (600,000 rounds, random 16-byte salt) turns the password into 64 bytes: the first 32 are the
//   AES-256-GCM key, the last 32 are `check`, used only to tell a wrong password from a right one.
//   The crypto itself lives in shield.js (CodeMini Shield); this file owns the lock record and its rules.
//   Shield never opens a locked item on its own: only the item's password does.
//   A locked FILE's text is stored encrypted in `enc` ({ iv, ct }) and its `content` field is left empty.
//   A locked FOLDER / WORKSPACE has no text of its own, so it only gets the `lock` verifier.
//
// WHAT STAYS IN MEMORY
//   After a correct password the derived key is kept in a Shield key ring in this closure (per record id) until
//   the page closes, so
//   the editor can save without asking again. `reveal()` puts the plain text on the in-memory record only;
//   `seal()` is what every writer must call before persisting, and it refuses to write plain text for a locked
//   record. Nothing here writes to storage itself.
//
// WHAT IT DOES NOT DO
//   Items inside a locked folder are not encrypted individually; the folder lock gates the UI. Lock the files
//   themselves if their content needs protecting. File names, sizes and timestamps are not encrypted. Code that
//   runs in this origin (previews, notebooks, the terminal) can read the page while a file is unlocked.
//
// Old records (from before this module) kept the password as plain text in `password`. They still open with the
// right password and are upgraded in place the first time that happens.
// tests/file-lock.test.js covers this module.
(function () {
    'use strict';

    const W = typeof window !== 'undefined' ? window : globalThis;
    // shield.js loads first. Captured once (the object is frozen), so replacing window.CodeMiniShield later
    // changes nothing. If it is missing, every lock operation fails with 'unsupported' rather than writing plain text.
    const Shield = W.CodeMiniShield || null;

    const KDF = Shield ? Shield.KDF : Object.freeze({ name: 'PBKDF2-SHA256', ITER: 0, MIN_ITER: 0, MAX_ITER: 0, SALT_LEN: 0, IV_LEN: 0 });
    const ITER = KDF.ITER, MIN_ITER = KDF.MIN_ITER, MAX_ITER = KDF.MAX_ITER, SALT_LEN = KDF.SALT_LEN;
    // Part of the stored format (authenticated, not stored): do not change without a versioned migration.
    const AAD = 'codemini-lock:v1';
    const PASSWORD_FORM = 'NFC';
    const TE = new TextEncoder();

    class LockError extends Error { constructor(code) { super(code); this.code = code; } }

    const toB64 = (u8) => Shield.toB64(u8), fromB64 = (b64) => Shield.fromB64(b64);
    const ctEq = (a, b) => Shield.ctEq(a, b);
    const randomBytes = (n) => {
        if (!Shield || !Shield.supported) throw new LockError('unsupported');
        return Shield.randomBytes(n);
    };

    // Keys held while the page is open, and the in-memory records that currently hold plain text.
    const keys = Shield ? Shield.createKeyring() : new Map(); // same set/get/has/delete/clear shape either way
    const plain = new WeakSet();

    async function derive(password, salt, iter) {
        if (!Shield || !Shield.supported) throw new LockError('unsupported');
        return Shield.deriveKeyAndCheck(password, salt, iter, { normalize: PASSWORD_FORM });
    }

    function validLock(L) {
        return !!L && L.v === 1 && L.kdf === KDF.name && Number.isInteger(L.iter) && L.iter >= MIN_ITER && L.iter <= MAX_ITER &&
            typeof L.salt === 'string' && typeof L.check === 'string';
    }
    async function makeLock(password, opts) {
        const iter = (opts && opts.iter) || ITER, salt = randomBytes(SALT_LEN);
        const { key, check } = await derive(password, salt, iter);
        return { key, lock: { v: 1, kdf: KDF.name, iter, salt: toB64(salt), check: toB64(check) } };
    }
    async function verifyLock(L, password) {
        if (!validLock(L)) return null;
        try {
            const { key, check } = await derive(password, fromB64(L.salt), L.iter);
            return ctEq(check, fromB64(L.check)) ? key : null;
        } catch (e) { return null; }
    }
    async function encryptText(key, text) {
        if (!Shield || !Shield.supported) throw new LockError('unsupported');
        return Shield.encrypt(key, text, AAD);
    }
    async function decryptText(key, enc) {
        try { return await Shield.decryptText(key, enc, AAD); } catch (e) { throw new LockError('damaged'); }
    }

    const hasText = (rec) => rec.type === 'file';
    const isLegacy = (rec) => !!rec && rec.isLocked === true && !rec.lock && typeof rec.password === 'string' && rec.password !== '';
    const isLocked = (rec) => !!rec && rec.isLocked === true;
    const isUnlocked = (rec) => !!rec && keys.has(rec.id);
    const isRevealed = (rec) => !!rec && plain.has(rec);

    // Locks `rec` in place: new salt, verifier, and (for files) encrypted text. Returns the record.
    async function lockRecord(rec, password, opts) {
        if (!password) throw new LockError('empty-password');
        const text = typeof rec.content === 'string' ? rec.content : '';
        if (hasText(rec) && rec.content != null && typeof rec.content !== 'string') throw new LockError('unsupported-content');
        const { key, lock } = await makeLock(password, opts);
        if (hasText(rec)) rec.enc = await encryptText(key, text); else delete rec.enc;
        rec.lock = lock; rec.isLocked = true; rec.password = null;
        if (hasText(rec)) rec.content = '';
        keys.set(rec.id, key); plain.delete(rec);
        return rec;
    }

    // Checks a password against `rec`. On success the key is remembered for this page. A pre-upgrade record is
    // upgraded in place and handed to `persist(rec)` (if given) so the plain-text password leaves storage.
    async function unlock(rec, password, persist) {
        if (!isLocked(rec) || !password) return false;
        if (isLegacy(rec)) {
            const a = TE.encode(String(password)), b = TE.encode(rec.password);
            if (!ctEq(a, b)) return false;
            await lockRecord(rec, password);
            if (typeof persist === 'function') await persist(rec);
            return true;
        }
        const key = await verifyLock(rec.lock, password);
        if (!key) return false;
        keys.set(rec.id, key);
        return true;
    }

    // Puts the plain text on the in-memory record (never persisted as-is; see seal). Needs unlock() first.
    async function reveal(rec) {
        if (!isLocked(rec) || !hasText(rec) || plain.has(rec) || !rec.enc) return rec;
        const key = keys.get(rec.id);
        if (!key) throw new LockError('locked');
        rec.content = await decryptText(key, rec.enc);
        plain.add(rec);
        return rec;
    }

    // Returns the version of `rec` that is safe to write. Plain text of a locked record is encrypted on the way
    // out; if that is impossible the write is refused instead of falling back to plain text.
    async function seal(rec) {
        if (!isLocked(rec)) return rec;
        if (isLegacy(rec)) throw new LockError('locked');
        if (!hasText(rec)) return Object.assign({}, rec, { password: null });
        // A locked record is stored with empty `content`, so non-empty content here is plain text (a revealed record,
        // or a copy of one made with a spread) and gets encrypted. Without the key it is refused.
        if (plain.has(rec) || rec.content) {
            const key = keys.get(rec.id);
            if (!key) throw new LockError('locked');
            return Object.assign({}, rec, { content: '', enc: await encryptText(key, String(rec.content == null ? '' : rec.content)), password: null });
        }
        return rec;
    }

    // New text for an already-unlocked file (the editor's save). Mutates and returns rec.
    async function setContent(rec, text) {
        const key = keys.get(rec.id);
        if (!key) throw new LockError('locked');
        rec.enc = await encryptText(key, String(text == null ? '' : text));
        rec.content = ''; plain.delete(rec);
        return rec;
    }

    // Removes the lock after a correct password: the text goes back to plain `content`.
    async function removeLock(rec, password) {
        if (!await unlock(rec, password)) return false;
        if (isLegacy(rec)) return false; // unlock() upgrades first, so this is not reachable
        await reveal(rec);
        delete rec.lock; delete rec.enc; rec.isLocked = false; rec.password = null;
        plain.delete(rec); keys.delete(rec.id);
        return true;
    }

    async function changePassword(rec, oldPassword, newPassword, opts) {
        if (!newPassword) throw new LockError('empty-password');
        if (!await unlock(rec, oldPassword)) return false;
        await reveal(rec);
        const text = hasText(rec) ? rec.content : '';
        plain.delete(rec);
        rec.content = text; delete rec.enc;
        await lockRecord(rec, newPassword, opts);
        return true;
    }

    // Upgrades every pre-upgrade record in `records` right away (their old password is on the record, so no prompt
    // is needed): the plain-text password is removed and the file text is encrypted. `persist(rec)` writes each one.
    // Keys are not kept, so each item still asks for its password when opened.
    let migrating = false;
    async function migrateLegacy(records, persist) {
        if (migrating || !Array.isArray(records)) return 0;
        migrating = true;
        let n = 0;
        try {
            for (const rec of records) {
                if (!isLegacy(rec)) continue;
                try { await lockRecord(rec, rec.password); keys.delete(rec.id); await persist(rec); n++; } catch (e) { /* stays as it was; retried next load */ }
            }
        } finally { migrating = false; }
        return n;
    }

    function forget(id) { keys.delete(id); }
    function forgetAll() { keys.clear(); }

    const api = Object.freeze({
        ITER, LockError, isLocked, isLegacy, isUnlocked, isRevealed,
        lockRecord, unlock, reveal, seal, setContent, removeLock, changePassword, migrateLegacy, forget, forgetAll,
        _internal: Object.freeze({ makeLock, verifyLock, encryptText, decryptText, validLock })
    });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') W.CodeMiniLock = api;
})();
