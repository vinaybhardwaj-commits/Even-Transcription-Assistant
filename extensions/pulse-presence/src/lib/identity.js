
// Identity extraction (R1). Primary identity is the Pulse API: doctor_uid (stable) + display_name. A Google login
// is answered from the __session cookie; an OTP login has NO cookie (Firebase token in IndexedDB only), so the call
// carries the page's own Firebase access token as a Bearer header, exactly as the page does. extractIdentity keeps
// ONLY uid, email, displayName. The access token is read by readBearerToken alone, held in a local variable for one
// call to pulse.even.in, and never logged, stored, posted or returned. Fails closed.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PulseLib = Object.assign(root.PulseLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  const DB_NAME = 'firebaseLocalStorageDb';
  const STORE = 'firebaseLocalStorage';
  const KEY_PREFIX = 'firebase:authUser:';
  const ACCESS_URL = 'https://pulse.even.in/api/auth/clinical/access/verify';
  const NAME_URL = 'https://pulse.even.in/api/auth/getName';
  const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

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

  // Read-only scan for the page's Firebase access token. Returns { state: 'none' | 'ok' | 'expired', token? }.
  // none: no usable record (cookie-only call, as before). expired: expirationTime is not in the future.
  // The token appears only in the 'ok' result, which readPulseIdentity keeps in a local variable.
  function readBearerToken(idb, nowMs) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      const NONE = { state: 'none' };
      let req;
      try { req = idb.open(DB_NAME); } catch (e) { return fin(NONE); }
      req.onupgradeneeded = () => { try { req.transaction.abort(); } catch (e) { /* ignore */ } fin(NONE); };
      req.onerror = () => fin(NONE);
      req.onsuccess = () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains(STORE)) { db.close(); return fin(NONE); }
          const cur = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
          const found = [];
          cur.onsuccess = () => {
            const c = cur.result;
            if (c) {
              if (typeof c.key === 'string' && c.key.startsWith(KEY_PREFIX)) {
                const v = c.value && c.value.value;
                const t = v && typeof v === 'object' ? v.stsTokenManager : null;
                const ok = t && typeof t === 'object' && typeof t.accessToken === 'string' && t.accessToken.length > 0 && t.accessToken.length <= 8192 && /^[\x21-\x7e]+$/.test(t.accessToken) && typeof t.expirationTime === 'number';
                found.push(ok ? { token: t.accessToken, exp: t.expirationTime } : null);
              }
              c.continue();
            } else {
              db.close();
              // exactly one usable record; zero, several or a malformed one -> cookie call
              if (found.length !== 1 || !found[0]) return fin(NONE);
              fin(found[0].exp > nowMs ? { state: 'ok', token: found[0].token } : { state: 'expired' });
            }
          };
          cur.onerror = () => { try { db.close(); } catch (e) { /* ignore */ } fin(NONE); };
        } catch (e) {
          try { db.close(); } catch (e2) { /* ignore */ }
          fin(NONE);
        }
      };
    });
  }

  // Reads who is logged in from the Pulse API, same-origin. Cookie call by default; with idb and a live Firebase
  // access token it is the page's own call shape: POST {} with Authorization: Bearer (only to pulse.even.in).
  // An expired token falls back to the cookie call; a 401/403 then is unknown (invalid, stale_token), never absent.
  //   present  -> { status, impersonating, identity: { doctor_uid, display_name, email: null }, reason }
  //               reason is null, or a name_* code when getName failed (identity is still present, display_name null)
  //   absent   -> 401/403 (a real logout). reason 'absent_401' / 'absent_403'
  //   invalid  -> fail closed (caller keeps last-known). reason: 'absent_<status>' for any other non-2xx,
  //               'invalid_no_doctor' for a 2xx without a doctor object, null for a network error or unreadable body
  //               (null is reported by the worker as 'identity_unreadable').
  // Only HTTP statuses and the JSON body fields above are read; no token, cookie or storage is touched.
  function statusReason(prefix, n) {
    return typeof n === 'number' && n >= 100 && n <= 599 ? prefix + '_' + n : null;
  }

  async function readPulseIdentity(fetchFn, idb, nowFn) {
    let init = { credentials: 'include', headers: { Accept: 'application/json' } };
    let expired = false;
    if (idb) {
      const b = await readBearerToken(idb, typeof nowFn === 'function' ? nowFn() : Date.now());
      if (b.state === 'ok') {
        init = { method: 'POST', redirect: 'error', credentials: 'include', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + b.token }, body: '{}' };
      } else if (b.state === 'expired') {
        expired = true;
      }
    }
    const r = await readPulseIdentityWith(fetchFn, init);
    // An expired record means the doctor is still signed in (Firebase refreshes it): a cookie 401/403 is NOT a logout.
    if (expired && r.status === 'absent') return { status: 'invalid', reason: 'stale_token' };
    return r;
  }

  async function readPulseIdentityWith(fetchFn, init) {
    let res;
    try {
      res = await fetchFn(ACCESS_URL, init);
    } catch (e) {
      return { status: 'invalid', reason: null };
    }
    if (!res) return { status: 'invalid', reason: null };
    if (!res.ok) {
      return { status: res.status === 401 || res.status === 403 ? 'absent' : 'invalid', reason: statusReason('absent', res.status) };
    }
    let data;
    try {
      const body = await res.json();
      data = body && body.data;
    } catch (e) {
      return { status: 'invalid', reason: null };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { status: 'invalid', reason: 'invalid_no_doctor' };
    const impersonating = data.is_impersonating === true;
    const uid = data.doctor && typeof data.doctor === 'object' ? data.doctor.uid : undefined;
    if (typeof uid !== 'string' || !UID_RE.test(uid)) return { status: 'invalid', impersonating, reason: 'invalid_no_doctor' };
    let display_name = null;
    let reason = null;
    try {
      const nres = await fetchFn(NAME_URL, init);
      if (!nres) {
        reason = 'name_unreadable';
      } else if (!nres.ok) {
        reason = statusReason('name_absent', nres.status) || 'name_unreadable';
      } else {
        const nbody = await nres.json();
        const n = nbody && nbody.data;
        if (typeof n === 'string' && n.length <= 200 && n.trim()) display_name = n.trim();
        else reason = 'name_invalid';
      }
    } catch (e) {
      display_name = null; // best effort: never fatal
      reason = 'name_unreadable';
    }
    return { status: 'present', impersonating, identity: { doctor_uid: uid, display_name, email: null }, reason };
  }

  // ---- Page greeting (DOM text only) and the stale-cookie decision ----

  // Strips leading honorifics ("Dr", "Dr.") and returns the first name token, or null.
  function firstName(text) {
    if (typeof text !== 'string') return null;
    let s = text.normalize('NFC').trim();
    for (let i = 0; i < 2; i++) s = s.replace(/^dr\.\s*/i, '').replace(/^dr\s+/i, '');
    if (/^dr\.?$/i.test(s)) return null;
    const m = /^[\p{L}\p{M}][\p{L}\p{M}'’-]*/u.exec(s);
    if (!m) return null;
    const tok = m[0].replace(/['’-]+$/, '');
    return tok && tok.length <= 50 ? tok : null;
  }

  // "Hello, <title> <first name>" + emoji -> "<first name>";  "Hello, <first name>" -> "<first name>";  anything else -> null.
  function parseGreeting(text) {
    if (typeof text !== 'string' || text.length > 400) return null;
    const m = /^\s*hello\b\s*,?\s*(.+)$/is.exec(text.normalize('NFC'));
    const name = m ? firstName(m[1]) : null;
    // Pulse renders "Hello, Doctor" while the real name is still loading: a placeholder, not a name.
    return name && name.toLowerCase() !== 'doctor' ? name : null;
  }

  // True when the cookie identity cannot be the person the page greets. Not stale (false) whenever either side is
  // unknown: no evidence of a mismatch is not evidence of one.
  function isStale(cookieName, pageName) {
    const c = firstName(cookieName);
    const p = firstName(pageName);
    if (!c || !p) return false;
    return c.toLowerCase() !== p.toLowerCase();
  }

  return { DB_NAME, STORE, KEY_PREFIX, ACCESS_URL, NAME_URL, UID_RE, extractIdentity, resolveIdentity, readFirebaseIdentity, readBearerToken, readPulseIdentity, firstName, parseGreeting, isStale };
});
