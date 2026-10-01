// Content script: reads the Firebase auth record (three fields only), the route type, and the
// impersonation flags, then reports them to the service worker. No DOM scraping, no page-world injection.
(function (root, factory) {
  const api = factory(typeof require === 'function' && typeof module !== 'undefined' ? require : null, root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.PulseLib = Object.assign(root.PulseLib || {}, api);
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      api.createContent({
        chrome, indexedDB: root.indexedDB, location: root.location, sessionStorage: root.sessionStorage,
        document: root.document, setInterval: root.setInterval.bind(root), addEventListener: root.addEventListener.bind(root),
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

    async function snapshot() {
      const href = env.location.href;
      const route = L.parseRoute(href);
      const impersonating = L.isImpersonating(href, sessionFlag());
      let status = 'absent';
      let identity = null;
      if (!impersonating) { // when impersonating, the record is the impersonator's: do not read it
        const r = await L.readFirebaseIdentity(env.indexedDB);
        status = r.status;
        // uid stays here; only email and display_name leave the content script.
        if (r.status === 'present') identity = { email: r.identity.email, display_name: r.identity.displayName };
      }
      return {
        type: 'pulse_state',
        status: impersonating ? 'absent' : status,
        identity,
        impersonating,
        route: { type: route.type, prescription_ref: route.prescription_ref },
        visible: env.document.visibilityState === 'visible',
      };
    }

    async function check() {
      const msg = await snapshot();
      const key = JSON.stringify(msg);
      if (key === last) return;
      last = key;
      try { await env.chrome.runtime.sendMessage(msg); } catch (e) { /* worker asleep or extension reloaded */ }
    }

    function cheapKey() {
      return env.location.href + '|' + sessionFlag() + '|' + env.document.visibilityState;
    }

    function start() {
      check();
      env.setInterval(() => {
        const k = cheapKey();
        if (k !== lastKey) { lastKey = k; check(); }
      }, URL_POLL_MS);
      env.setInterval(check, FULL_POLL_MS);
      env.addEventListener('focus', check);
      env.addEventListener('popstate', check);
    }

    return { snapshot, check, start };
  }

  return { createContent };
});
