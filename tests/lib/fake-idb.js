// A small in-memory stand-in for IndexedDB, just big enough for Shield's device-key store (open with an upgrade
// step, a store, get / put inside a transaction). Requests answer asynchronously, like the real thing, and a
// transaction completes once none of its requests are pending. Several Shield instances can share one of these
// to act as several tabs of the same browser profile. It is for unit tests only; the e2e suite uses real IndexedDB.
module.exports = function fakeIndexedDB() {
  const dbs = new Map();
  const idb = {
    failOpen: false, hangOpen: false, opens: 0, puts: 0,
    // test helpers: look inside, or plant something
    storeOf(db, store) { const d = dbs.get(db); return d && d.stores.get(store); },
    open(name) {
      const req = {};
      idb.opens++;
      setImmediate(() => {
        if (idb.hangOpen) return;
        if (idb.failOpen) { req.error = new Error('blocked'); if (req.onerror) req.onerror(); return; }
        let d = dbs.get(name); const fresh = !d;
        if (!d) { d = { stores: new Map() }; dbs.set(name, d); }
        const db = {
          objectStoreNames: { contains: (n) => d.stores.has(n) },
          createObjectStore(n) { d.stores.set(n, new Map()); },
          close() {},
          transaction(storeName) {
            const store = d.stores.get(storeName);
            if (!store) throw new Error('NotFoundError');
            const tx = {}; let pending = 0, finished = false;
            const settle = () => setImmediate(() => { if (!pending && !finished) { finished = true; if (tx.oncomplete) tx.oncomplete(); } });
            tx.objectStore = () => ({
              get(k) {
                const r = {}; pending++;
                setImmediate(() => { r.result = store.get(k); if (r.onsuccess) r.onsuccess(); pending--; settle(); });
                return r;
              },
              put(v, k) { store.set(k, v); idb.puts++; return {}; }
            });
            settle();
            return tx;
          }
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
  return idb;
};
