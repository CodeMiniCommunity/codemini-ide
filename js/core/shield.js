// ==========================================
// shield.js - "CodeMini Shield": the one shared crypto layer. No UI, no passwords of its own, one small store.
// ==========================================
// WHAT IT OWNS
//   Key derivation (PBKDF2-SHA256), AES-256-GCM encrypt and decrypt, random salts and IVs, base64 helpers,
//   record-shape checks, and an in-memory key ring that is emptied on lock. my-keys.js and file-lock.js call
//   this instead of carrying their own crypto, so there is one place to audit and one place to raise the
//   iteration count.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   Shield never unlocks a password-protected item on its own. A caller has to hand it the user's password (or a
//   key it already derived from one). If Shield could open locked files or the My Keys vault by itself, the
//   password would be pointless and a lock would be a UI gate again. Shield keeps no copy of any password or
//   key it derives: the callers hold those (My Keys in its own state, file-lock in a key ring made by
//   createKeyring()). The device key below is a separate thing and is never used for locks or the vault.
//
// THE DEVICE KEY (the one thing Shield stores)
//   For secrets that have no user password (today: the GitHub token), Shield makes one AES-256-GCM key with
//   extractable=false and keeps it in IndexedDB (database "codemini_shield", store "keys", id "device-v1").
//   device.seal() / device.open() use it. No prompt is needed, so these secrets stay usable after My Keys locks.
//   What that protects against: a copy of the browser's storage, a sync or backup leak, or reading the encrypted
//   record out of localStorage; none of those give an attacker the key bytes, because they do not exist as bytes.
//   What it does NOT protect against: someone using this open browser profile, or script running in this page,
//   because either can ask the browser to decrypt with the key. Do not put anything here that a password should
//   guard. The record format and this trade-off are written up in SECURITY.md.
//
// STORED FORMATS
//   This file does not define a new one. `normalize` and `aad` are parameters because My Keys and file locks
//   were written with different values (NFKC / "codemini-vault:v1" and NFC / "codemini-lock:v1"). Records made
//   before this file existed open unchanged. tests/fixtures/legacy-formats.json holds records made by the old
//   code, and tests/shield.test.js opens them.
//
// LOAD ORDER
//   Loads right after app-info.js and before my-keys.js and file-lock.js. The browser primitives are captured
//   once, below, and the exported object is frozen, so later monkey-patching of crypto.subtle or JSON cannot
//   hook what happens here, and a caller that captures window.CodeMiniShield at load keeps this exact object.
//   Same-origin code can still call these functions, but every one of them needs a password or a key it
//   cannot get, so that adds nothing beyond what crypto.subtle already allows.
// tests/shield.test.js covers this module.
(function () {
    'use strict';

    // ---- primitives captured at load ------------------------------------------------------------
    const W = typeof window !== 'undefined' ? window : globalThis;
    const _c = W.crypto;
    const _s = _c && _c.subtle;
    const subtle = _s ? {
        importKey: _s.importKey.bind(_s), deriveKey: _s.deriveKey.bind(_s), deriveBits: _s.deriveBits.bind(_s),
        generateKey: _s.generateKey ? _s.generateKey.bind(_s) : null, encrypt: _s.encrypt.bind(_s), decrypt: _s.decrypt.bind(_s)
    } : null;
    const _grv = _c && _c.getRandomValues ? _c.getRandomValues.bind(_c) : null;
    const TE = new TextEncoder(), TD = new TextDecoder('utf-8', { fatal: true });
    const _btoa = W.btoa.bind(W), _atob = W.atob.bind(W);
    const _JP = JSON.parse.bind(JSON), _JS = JSON.stringify.bind(JSON);

    const KDF = Object.freeze({
        name: 'PBKDF2-SHA256',
        ITER: 600000, MIN_ITER: 100000, MAX_ITER: 5000000,
        SALT_LEN: 16, IV_LEN: 12
    });
    const FORMS = ['NFC', 'NFKC'];
    const supported = !!(subtle && _grv);

    // Codes: 'unsupported' (no Web Crypto, or no IndexedDB for the device key), 'bad-input' (a caller bug),
    // 'auth-failed' (AES-GCM rejected the data: wrong key, or the ciphertext/IV/AAD was changed), 'damaged' (the
    // record is not even well formed), 'no-key' (a device record exists but this browser has no device key any
    // more) and 'storage' (IndexedDB could not be reached; may be temporary). Callers decide what 'auth-failed'
    // means to a person: for a password-derived key it is a wrong password.
    class ShieldError extends Error { constructor(code) { super(code); this.code = code; } }

    // ---- bytes and encoding -------------------------------------------------------------------------
    function randomBytes(n) {
        if (!_grv) throw new ShieldError('unsupported');
        return _grv(new Uint8Array(n));
    }
    function toB64(u8) {
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return _btoa(s);
    }
    function fromB64(b64) {
        const s = _atob(String(b64));
        const u = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        return u;
    }
    // Constant-time compare for two byte arrays (used for password verifiers).
    function ctEq(a, b) {
        if (a.length !== b.length) return false;
        let d = 0;
        for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
        return d === 0;
    }
    const aadBytes = (aad) => (typeof aad === 'string' ? TE.encode(aad) : aad);

    // ---- key derivation -------------------------------------------------------------------------------
    function passwordBytes(password, normalize) {
        if (FORMS.indexOf(normalize) < 0) throw new ShieldError('bad-input');
        return TE.encode(String(password).normalize(normalize));
    }
    // Password -> a non-extractable AES-256-GCM CryptoKey. The key bytes never exist in JavaScript.
    async function deriveKey(password, salt, iter, opts) {
        if (!supported) throw new ShieldError('unsupported');
        const base = await subtle.importKey('raw', passwordBytes(password, opts && opts.normalize), 'PBKDF2', false, ['deriveKey']);
        return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    // Password -> { key, check }. 64 bytes come out of PBKDF2: the first 32 become the AES-256-GCM key (still
    // non-extractable) and the last 32 are returned as `check`, a verifier that tells a wrong password from a
    // right one without trying to decrypt anything. The raw bytes are zeroed before this returns.
    async function deriveKeyAndCheck(password, salt, iter, opts) {
        if (!supported) throw new ShieldError('unsupported');
        const base = await subtle.importKey('raw', passwordBytes(password, opts && opts.normalize), 'PBKDF2', false, ['deriveBits']);
        const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, 512));
        const key = await subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
        const check = bits.slice(32, 64);
        bits.fill(0);
        return { key, check };
    }

    // ---- AES-256-GCM ------------------------------------------------------------------------------------
    // `data` is a string (UTF-8) or a Uint8Array. `aad` (string or bytes) is authenticated but not stored; it
    // ties a ciphertext to its purpose, so a lock record cannot be opened as a vault record. `opts.padTo` pads
    // the plaintext with spaces up to a multiple of that many bytes (always at least one), which is only valid
    // for JSON: it hides the real size and JSON.parse ignores the trailing spaces.
    async function encrypt(key, data, aad, opts) {
        if (!supported) throw new ShieldError('unsupported');
        let bytes = typeof data === 'string' ? TE.encode(data) : data;
        const padTo = opts && opts.padTo;
        if (padTo) {
            const padded = new Uint8Array(Math.ceil((bytes.length + 1) / padTo) * padTo);
            padded.fill(0x20);
            padded.set(bytes);
            bytes = padded;
        }
        const iv = randomBytes(KDF.IV_LEN);
        const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadBytes(aad) }, key, bytes));
        return { iv: toB64(iv), ct: toB64(ct) };
    }
    // `sealed` is { iv, ct } (base64), as returned by encrypt. Returns the plaintext bytes.
    // Throws ShieldError('auth-failed') when GCM rejects it and ShieldError('damaged') when it is malformed.
    async function decrypt(key, sealed, aad) {
        if (!supported) throw new ShieldError('unsupported');
        let iv, ct;
        try {
            iv = fromB64(sealed.iv); ct = fromB64(sealed.ct);
        } catch (e) { throw new ShieldError('damaged'); }
        if (iv.length !== KDF.IV_LEN) throw new ShieldError('damaged');
        try {
            return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aadBytes(aad) }, key, ct));
        } catch (e) {
            throw new ShieldError(e && e.name === 'OperationError' ? 'auth-failed' : 'damaged');
        }
    }
    // decrypt() and then strict UTF-8 decoding. Invalid UTF-8 means the record is damaged.
    async function decryptText(key, sealed, aad) {
        const plain = await decrypt(key, sealed, aad);
        try { return TD.decode(plain); } catch (e) { throw new ShieldError('damaged'); }
    }

    // ---- record-shape checks (never throw) ------------------------------------------------------------
    const validIter = (n) => Number.isInteger(n) && n >= KDF.MIN_ITER && n <= KDF.MAX_ITER;
    function b64Len(s) { try { return typeof s === 'string' ? fromB64(s).length : -1; } catch (e) { return -1; } }
    const validSalt = (s) => b64Len(s) === KDF.SALT_LEN;
    // True when `rec.iv` is a well-formed IV and `rec.ct` is a base64 string of at most `maxChars` characters
    // that decodes to at least `minBytes` bytes (a GCM tag is 16 bytes, so 16 is the floor).
    function validSealed(rec, limits) {
        try {
            if (!rec || typeof rec !== 'object' || b64Len(rec.iv) !== KDF.IV_LEN) return false;
            if (typeof rec.ct !== 'string' || (limits && limits.maxChars && rec.ct.length > limits.maxChars)) return false;
            return b64Len(rec.ct) >= ((limits && limits.minBytes) || 16);
        } catch (e) { return false; }
    }

    // ---- in-memory key ring ------------------------------------------------------------------------------
    // A Map-shaped holder for keys a caller has derived: set / get / has / delete / clear. Nothing here is ever
    // written to storage. Locking means calling clear() (or delete(id)); the keys are then gone from this page.
    function createKeyring() {
        const m = new Map();
        return Object.freeze({
            set: (id, key) => { m.set(id, key); },
            get: (id) => m.get(id),
            has: (id) => m.has(id),
            delete: (id) => m.delete(id),
            clear: () => { m.clear(); }
        });
    }

    // ---- device key (see the header; this is the only part of Shield that touches storage) ------------------
    const DEVICE = Object.freeze({
        DB: 'codemini_shield', STORE: 'keys', ID: 'device-v1',
        AAD: 'codemini-device:v1:',   // + the caller's purpose; part of the stored format, do not change
        PAD_TO: 256,                  // sealed values are padded to a multiple of this, hiding the real length
        MAX_CHARS: 65536, TIMEOUT_MS: 8000
    });
    const _idb = W.indexedDB || null;
    const _setT = typeof W.setTimeout === 'function' ? W.setTimeout.bind(W) : null;
    const _clearT = typeof W.clearTimeout === 'function' ? W.clearTimeout.bind(W) : null;
    const deviceSupported = !!(supported && _idb && subtle.generateKey);

    // Only a non-extractable AES-256-GCM secret key is accepted; anything else in that slot is treated as absent.
    const validDeviceKey = (k) => !!k && typeof k === 'object' && k.type === 'secret' && k.extractable === false &&
        !!k.algorithm && k.algorithm.name === 'AES-GCM' && k.algorithm.length === 256 &&
        Array.isArray(k.usages) && k.usages.indexOf('encrypt') > -1 && k.usages.indexOf('decrypt') > -1;

    function idbOpen() {
        return new Promise((resolve, reject) => {
            let req, done = false, timer = null;
            const fail = () => { if (done) return; done = true; if (timer && _clearT) _clearT(timer); reject(new ShieldError('storage')); };
            try { req = _idb.open(DEVICE.DB, 1); } catch (e) { fail(); return; }
            req.onupgradeneeded = () => {
                try { if (!req.result.objectStoreNames.contains(DEVICE.STORE)) req.result.createObjectStore(DEVICE.STORE); } catch (e) { /* the open fails below */ }
            };
            req.onsuccess = () => {
                // A late success after a timeout must not leave a connection open.
                if (done) { try { req.result.close(); } catch (e) { /* nothing to close */ } return; }
                done = true; if (timer && _clearT) _clearT(timer); resolve(req.result);
            };
            req.onerror = fail; req.onblocked = fail;
            if (_setT) timer = _setT(fail, DEVICE.TIMEOUT_MS);
        });
    }
    function idbReadKey(db) {
        return new Promise((resolve, reject) => {
            try {
                const r = db.transaction(DEVICE.STORE, 'readonly').objectStore(DEVICE.STORE).get(DEVICE.ID);
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(new ShieldError('storage'));
            } catch (e) { reject(new ShieldError('storage')); }
        });
    }
    // Read-then-write in ONE readwrite transaction, so two tabs that both find no key cannot each keep their own:
    // whichever transaction runs second sees the first one's key and uses it. Resolves with the key that stays.
    function idbEnsureKey(db, fresh) {
        return new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(DEVICE.STORE, 'readwrite'), os = tx.objectStore(DEVICE.STORE);
                let winner = null;
                const g = os.get(DEVICE.ID);
                g.onsuccess = () => {
                    if (validDeviceKey(g.result)) winner = g.result;
                    else { winner = fresh; os.put(fresh, DEVICE.ID); }
                };
                tx.oncomplete = () => resolve(winner);
                tx.onerror = tx.onabort = () => reject(new ShieldError('storage'));
            } catch (e) { reject(new ShieldError('storage')); }
        });
    }
    // One lookup at a time, and the key is kept in memory once found. `create` is true only for seal(): opening
    // a record never invents a key, because a brand-new key could not decrypt it anyway.
    let deviceKey = null, deviceChain = Promise.resolve();
    function deviceKeyFor(create) {
        const run = async () => {
            if (deviceKey) return deviceKey;
            const db = await idbOpen();
            try {
                const found = await idbReadKey(db);
                if (validDeviceKey(found)) return (deviceKey = found);
                if (!create) return null;
                const fresh = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
                return (deviceKey = await idbEnsureKey(db, fresh));
            } finally { try { db.close(); } catch (e) { /* already closed */ } }
        };
        const p = deviceChain.then(run);
        deviceChain = p.catch(() => { /* the next call starts clean */ });
        return p;
    }
    function devicePurpose(purpose) {
        if (typeof purpose !== 'string' || !purpose || purpose.length > 200) throw new ShieldError('bad-input');
        return DEVICE.AAD + purpose;
    }
    // `purpose` names what the value is for (e.g. "github-token:win_default"). It is authenticated, so a record
    // sealed for one purpose does not open under another. `value` is anything JSON can hold.
    // Returns { v: 1, iv, ct }, ready to be stored as JSON by the caller.
    async function deviceSeal(purpose, value) {
        const aad = devicePurpose(purpose);
        if (!deviceSupported) throw new ShieldError('unsupported');
        let text;
        try { text = _JS(value); } catch (e) { throw new ShieldError('bad-input'); }
        if (typeof text !== 'string') throw new ShieldError('bad-input');
        const key = await deviceKeyFor(true);
        const sealed = await encrypt(key, text, aad, { padTo: DEVICE.PAD_TO });
        return { v: 1, iv: sealed.iv, ct: sealed.ct };
    }
    // Returns the value that was sealed. Errors: 'damaged' (not a well-formed record or not JSON inside),
    // 'no-key' (this browser has no device key), 'auth-failed' (wrong key or purpose, or changed data), 'storage'.
    async function deviceOpen(purpose, record) {
        const aad = devicePurpose(purpose);
        if (!deviceSupported) throw new ShieldError('unsupported');
        if (!record || typeof record !== 'object' || record.v !== 1 || !validSealed(record, { maxChars: DEVICE.MAX_CHARS })) throw new ShieldError('damaged');
        const key = await deviceKeyFor(false);
        if (!key) throw new ShieldError('no-key');
        const text = await decryptText(key, record, aad);
        try { return _JP(text); } catch (e) { throw new ShieldError('damaged'); }
    }
    const device = Object.freeze({ supported: deviceSupported, seal: deviceSeal, open: deviceOpen });

    const api = Object.freeze({
        KDF, supported, ShieldError,
        randomBytes, toB64, fromB64, ctEq,
        deriveKey, deriveKeyAndCheck,
        encrypt, decrypt, decryptText,
        validIter, validSalt, validSealed,
        createKeyring, device
    });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    // Defined once and not replaceable, so nothing can swap the object out from under a later reader.
    if (typeof window !== 'undefined' && !Object.prototype.hasOwnProperty.call(W, 'CodeMiniShield')) {
        Object.defineProperty(W, 'CodeMiniShield', { value: api, writable: false, configurable: false, enumerable: true });
    }
})();
