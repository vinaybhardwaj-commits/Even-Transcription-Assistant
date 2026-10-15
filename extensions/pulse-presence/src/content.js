
// Content script: reads who is logged in from the Pulse API (doctor_uid + display_name; same-origin, cookie-authed),
// an optional email from the Firebase auth record (email only), the route type, and the impersonation flags,
// then reports them to the service worker. The only DOM text read is the signed-in greeting (h1 greeting on the home
// route, first name only), used by the worker to detect a stale cookie identity. No page-world injection.
(function (root, factory) {
  const api = factory(typeof require === 'function' && typeof module !== 'undefined' ? require : null, root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.PulseLib = Object.assign(root.PulseLib || {}, api);
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      api.createContent({
        chrome, indexedDB: root.indexedDB, location: root.location, sessionStorage: root.sessionStorage,
        document: root.document, setInterval: root.setInterval.bind(root), addEventListener: root.addEventListener.bind(root),
        fetch: root.fetch.bind(root),
      }).start();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function (req, root) {
  const L = req ? Object.assign({}, req('./lib/route.js'), req('./lib/identity.js')) : root.PulseLib;
  const URL_POLL_MS = 2000;
  const FULL_POLL_MS = 30000;

  function createContent(env) {
    let last = null;
    let lastKey = null;

    function sessionFlag() {
      try { return env.sessionStorage.getItem('is-impersonation'); } catch (e) { return null; }
    }

    // First name from the home-page greeting ("Hello, <title> <first name>"), or null when not on home / not rendered yet.
    function readPageName(route) {
      if (route.type !== 'home') return null;
      try {
        const d = env.document;
        if (!d || typeof d.querySelector !== 'function') return null;
        const el = d.querySelector('h1[class*="greeting"]');
        return el ? L.parseGreeting(el.textContent) : null;
      } catch (e) { return null; }
    }

    async function snapshot() {
      const href = env.location.href;
      const route = L.parseRoute(href);
      const impPre = L.isImpersonating(href, sessionFlag());
      let impersonating = impPre;
      let status = 'absent';
      let identity = null;
      let reason = null;
      if (route.type === 'login') {
        // On the Pulse login page the doctor is logged out. Authoritative; do not read identity.
        return {
          type: 'pulse_state',
          status: 'absent',
          identity: null,
          reason: null,
          page_name: null,
          page_reset: true,
          impersonating: false,
          route: { type: route.type, prescription_ref: route.prescription_ref },
          visible: env.document.visibilityState === 'visible',
        };
      }
      if (!impPre) { // when impersonating, the session is the impersonator's: do not read an identity
        const r = await L.readPulseIdentity(env.fetch, env.indexedDB);
        if (r.impersonating) {
          impersonating = true; // authoritative: the Pulse API says this session is impersonating
        } else {
          status = r.status;
          reason = r.reason || null;
          if (r.status === 'present') {
            identity = { doctor_uid: r.identity.doctor_uid, display_name: r.identity.display_name, email: null };
          }
        }
      }
      return {
        type: 'pulse_state',
        status: impersonating ? 'absent' : status,
        identity: impersonating ? null : identity,
        reason: impersonating ? null : reason,
        page_name: readPageName(route),
        impersonating,
        route: { type: route.type, prescription_ref: route.prescription_ref },
        visible: env.document.visibilityState === 'visible',
      };
    }

    // force=true bypasses the dedupe for one send (doctor returned to the machine). The worker only emits a new
    // login if its identity was cleared (idle_timeout), so a forced re-report while logged in adds no events.
    async function check(force) {
      const msg = await snapshot();
      const key = JSON.stringify(msg);
      if (key === last && force !== true) return;
      last = key;
      try { await env.chrome.runtime.sendMessage(msg); } catch (e) { /* worker asleep or extension reloaded */ }
    }

    function cheapKey() {
      return env.location.href + '|' + sessionFlag() + '|' + env.document.visibilityState + '|' + readPageName(L.parseRoute(env.location.href));
    }

    function rereport() { return check(true); }

    function start() {
      check();
      env.setInterval(() => {
        const k = cheapKey();
        if (k !== lastKey) { lastKey = k; check(); }
      }, URL_POLL_MS);
      env.setInterval(check, FULL_POLL_MS);
      // Returning to the machine after an idle_timeout logout: re-report even if the state is unchanged.
      env.addEventListener('focus', rereport);
      env.addEventListener('popstate', check);
      if (env.document && typeof env.document.addEventListener === 'function') {
        env.document.addEventListener('visibilitychange', () => {
          if (env.document.visibilityState === 'visible') rereport();
        });
      }
    }

    return { snapshot, check, rereport, start };
  }

  return { createContent };
});
