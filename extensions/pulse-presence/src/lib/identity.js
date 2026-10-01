// Identity extraction (R1). Reads the Firebase auth record and keeps ONLY uid, email, displayName.
// stsTokenManager and every other property are never read, copied or returned. Fails closed.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PulseLib = Object.assign(root.PulseLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  const DB_NAME = 'firebaseLocalStorageDb';
  const STORE = 'firebaseLocalStorage';
  const KEY_PREFIX = 'firebase:authUser:';

  // record = { fbase_key, value: { uid, email, displayName, ... } }
  function extractIdentity(record) {
    try {
      if (!record || typeof record !== 'object') return { status: 'invalid' };
      const v = record.value;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { status: 'invalid' };
      const uid = v.uid;
      const email = v.email;
      const name = v.displayName;
      if (typeof uid !== 'string' || !uid || uid.length > 128) return { status: 'invalid' };
      if (typeof email !== 'string' || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) return { status: 'invalid' };
      if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > 200)) return { status: 'invalid' };
      return {
        status: 'present',
        identity: { uid: String(uid), email: email.trim().toLowerCase(), displayName: typeof name === 'string' ? name : null },
      };
    } catch (e) {
      return { status: 'invalid' };
    }
  }

  function resolveIdentity(found) {
    if (found.length === 0) return { status: 'absent' };
    if (found.some((f) => f.status !== 'present')) return { status: 'invalid' };
    if (found.some((f) => f.identity.uid !== found[0].identity.uid)) return { status: 'invalid' };
    return found[0];
  }

  // Read-only scan. Each record is reduced to the three fields inside the cursor callback.
  function readFirebaseIdentity(idb) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      let req;
      try { req = idb.open(DB_NAME); } catch (e) { return fin({ status: 'invalid' }); }
      // The DB does not exist yet: abort the upgrade so we never create it.
      req.onupgradeneeded = () => {
        try { req.transaction.abort(); } catch (e) { /* ignore */ }
        fin({ status: 'absent' });
      };
      req.onerror = () => fin({ status: 'invalid' });
      req.onsuccess = () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains(STORE)) { db.close(); return fin({ status: 'absent' }); }
          const cur = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
          const found = [];
          cur.onsuccess = () => {
            const c = cur.result;
            if (c) {
              if (typeof c.key === 'string' && c.key.startsWith(KEY_PREFIX)) found.push(extractIdentity(c.value));
              c.continue();
            } else {
              db.close();
              fin(resolveIdentity(found));
            }
          };
          cur.onerror = () => { try { db.close(); } catch (e) { /* ignore */ } fin({ status: 'invalid' }); };
        } catch (e) {
          try { db.close(); } catch (e2) { /* ignore */ }
          fin({ status: 'invalid' });
        }
      };
    });
  }

  return { DB_NAME, STORE, KEY_PREFIX, extractIdentity, resolveIdentity, readFirebaseIdentity };
});
