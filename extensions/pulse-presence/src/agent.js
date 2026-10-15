
// Service worker logic. Registers every listener synchronously; state lives in storage.local
// because the worker can be stopped at any time. The worker only posts; it never touches Pulse pages.
(function (root, factory) {
  const api = factory(typeof require === 'function' && typeof module !== 'undefined' ? require : null, root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PulseLib = Object.assign(root.PulseLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : self, function (req, root) {
  const L = req
    ? Object.assign({}, req('./lib/events.js'), req('./lib/route.js'), req('./lib/body.js'), req('./lib/transport.js'), req('./lib/identity.js'))
    : root.PulseLib;

  const HEARTBEAT_ALARM = 'pulse-heartbeat';
  const IDLE_SECONDS = 120;
  // Source-side ghost-session guard: a doctor idle/locked this long is gone; emit logout and drop identity.
  const IDLE_LOGOUT_MIN = 45;
  const MAX_PENDING = 100;
  const PRESENCE_EVENTS = ['heartbeat', 'idle', 'active', 'locked'];
  const STATES = ['present', 'absent', 'invalid'];
  const ROUTE_TYPES = ['home', 'login', 'prescription', 'patient', 'other'];
  const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  const REASON_RE = /^(?:absent_\d{3}|name_absent_\d{3}|invalid_no_doctor|name_invalid|name_unreadable|stale_token)$/;
  const PAGE_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}'\u2019-]{0,49}$/u;
  const INSTANCE_RE = /^[0-9a-f]{32}$/;

  // identityReason: why the cookie read is not a clean identity (absent_401, invalid_no_doctor, name_*), or null.
  // pageName: last greeting first name seen. stale: { cookie_uid, cookie_name } while the cookie identity contradicts the page.
  function defaultState() {
    return {
      identity: null, identityStatus: 'absent', identityReason: null, pageName: null, stale: null,
      impersonating: false, openRef: null, tabFocus: false, idle: 'active', awaySince: null,
      lastDoc: null, // { doctor_uid, at }: placement hint, NOT identity; survives stale/absent_401, cleared on logout / other doctor
      identityAt: null, // epoch ms of the last identity read that confirmed state.identity
    };
  }

  // Random per-install id; not derived from anything personal.
  function newInstanceId() {
    const b = new Uint8Array(16);
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
    else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function cleanStr(x, max) {
    return typeof x === 'string' && x.length > 0 && x.length <= max ? x : null;
  }

  // Re-validates a content-script message. Anything unexpected is reduced or dropped.
  function sanitizeMessage(m) {
    if (!m || m.type !== 'pulse_state') return null;
    const status = STATES.includes(m.status) ? m.status : 'invalid';
    let identity = null;
    if (status === 'present' && m.identity) {
      // doctor_uid is the identity key; email is an optional bonus and never required.
      const uid = m.identity.doctor_uid;
      if (typeof uid === 'string' && uid.length <= 128 && UID_RE.test(uid)) {
        const email = cleanStr(m.identity.email, 254);
        identity = {
          doctor_uid: uid,
          display_name: cleanStr(m.identity.display_name, 200),
          email: email && /^[^@\s]+@[^@\s]+$/.test(email) ? email : null,
        };
      }
    }
    const r = m.route || {};
    const ref = typeof r.prescription_ref === 'string' && L.REF_RE.test(r.prescription_ref) ? r.prescription_ref : null;
    return {
      status: status === 'present' && !identity ? 'invalid' : status,
      identity,
      reason: typeof m.reason === 'string' && REASON_RE.test(m.reason) ? m.reason : null,
      page_name: typeof m.page_name === 'string' && PAGE_NAME_RE.test(m.page_name) ? m.page_name : null,
      page_reset: m.page_reset === true,
      impersonating: m.impersonating === true,
      route: { type: ROUTE_TYPES.includes(r.type) ? r.type : 'other', prescription_ref: ref },
      visible: m.visible === true,
    };
  }

  function createAgent(chrome, opts = {}) {
    const now = opts.now || (() => Date.now());
    const fetchFn = opts.fetch || ((...a) => fetch(...a));
    const transport = L.createTransport({ chrome, fetchFn, now });
    const version = chrome.runtime.getManifest().version;
    const idleLogoutMs = (Number(opts.idleLogoutMin) > 0 ? Number(opts.idleLogoutMin) : IDLE_LOGOUT_MIN) * 60000;
    const pending = new Map();
    let chain = Promise.resolve();
    let flushP = Promise.resolve();

    function serial(fn) {
      const run = chain.then(fn);
      chain = run.catch(() => {});
      return run;
    }
    function kickFlush() {
      flushP = flushP.then(() => transport.flush()).catch(() => {});
    }
    async function loadState() {
      const s = await chrome.storage.local.get('state');
      return Object.assign(defaultState(), s.state || {});
    }
    function ctxOf(state) {
      const hidden = state.impersonating || state.identityStatus === 'invalid' || !state.identity || !!state.stale;
      return {
        doctor_uid: hidden ? null : state.identity.doctor_uid,
        email: hidden ? null : state.identity.email,
        display_name: hidden ? null : state.identity.display_name,
        impersonating: state.impersonating,
      };
    }
    function lastOf(state, ctx) {
      const l = state.lastDoc;
      if (!l || ctx.impersonating) return { uid: null, age: null };
      return { uid: l.doctor_uid, age: Math.max(0, Math.round((now() - l.at) / 1000)) };
    }
    // Whole seconds since the held identity was last confirmed; null when no identity or no confirmation time.
    function ageOf(state) {
      if (!state.identity || typeof state.identityAt !== 'number') return null;
      return Math.max(0, Math.round((now() - state.identityAt) / 1000));
    }

    async function getInstanceId() {
      try {
        const s = await chrome.storage.local.get('instance_id');
        const v = s && s.instance_id;
        if (typeof v === 'string' && INSTANCE_RE.test(v)) return v;
        const id = (opts.newInstanceId || newInstanceId)();
        await chrome.storage.local.set({ instance_id: id });
        return id;
      } catch (e) {
        return null;
      }
    }

    // R10: sorted, deduped, comma-joined set of active status codes; null when empty.
    function reasonSet(state, extra) {
      const codes = new Set();
      if (extra.reason) codes.add(extra.reason);
      // An explicit ctx is a real logout of a known doctor; impersonation never reads the record.
      if (!state.impersonating && !extra.ctx) {
        if (state.stale) codes.add('stale_cookie');
        else if (state.identityReason) codes.add(state.identityReason);
        else if (state.identityStatus === 'invalid') codes.add('identity_unreadable');
      }
      return codes.size ? [...codes].sort().join(',') : null;
    }

    // Runs fn(state, emit) with the persisted state, then saves state and queues the events.
    function run(fn) {
      return serial(async () => {
        const state = await loadState();
        const cfg = await transport.getConfig();
        const instanceId = await getInstanceId();
        const out = [];
        const emit = (name, extra = {}) => {
          const ctx = extra.ctx || ctxOf(state);
          let reason = reasonSet(state, extra);
          // Presence-type events with nobody attributed and no other explanation say so: reason "none".
          if (reason === null && ctx.doctor_uid == null && !ctx.impersonating && PRESENCE_EVENTS.includes(name)) reason = 'none';
          const last = lastOf(state, ctx);
          out.push(L.buildEvent({
            last_doctor_uid: last.uid, last_doctor_age_s: last.age,
            machine_id: cfg.machine_id, room: cfg.room,
            doctor_uid: ctx.doctor_uid, email: ctx.email, display_name: ctx.display_name, impersonating: ctx.impersonating,
            event: name, body_keys: extra.body_keys, encounter_id: extra.encounter_id, prescription_ref: extra.prescription_ref,
            ts: L.isoLocal(now()), tab_focus: state.tabFocus, ext_version: version,
            reason,
            identity_age_s: ctx.doctor_uid != null ? ageOf(state) : null,
            // The greeting is never promoted to a doctor_uid; during impersonation it is the impersonated doctor's.
            page_name: state.impersonating ? null : state.pageName,
            instance_id: instanceId, cookie_uid: extra.cookie_uid, cookie_name: extra.cookie_name,
          }));
        };
        await fn(state, emit);
        await chrome.storage.local.set({ state });
        if (out.length) await transport.enqueue(out);
        kickFlush();
      });
    }

    async function queryFocus(windowId) {
      try {
        if (windowId === chrome.windows.WINDOW_ID_NONE) return false;
        const w = await chrome.windows.getLastFocused({ populate: true });
        if (!w || !w.focused) return false;
        const t = (w.tabs || []).find((x) => x.active);
        return !!(t && typeof t.url === 'string' && t.url.startsWith(L.PULSE_ORIGIN + '/'));
      } catch (e) {
        return false;
      }
    }
    async function applyFocus(state, emit, windowId, quiet) {
      const focus = await queryFocus(windowId);
      if (focus !== state.tabFocus) {
        state.tabFocus = focus;
        if (!quiet) emit('heartbeat');
      }
    }
    function refreshFocus(windowId) {
      return run((state, emit) => applyFocus(state, emit, windowId, false));
    }

    function onState(raw) {
      const s = sanitizeMessage(raw);
      if (!s) return Promise.resolve();
      return run(async (state, emit) => {
        if (s.impersonating) {
          // The session is the impersonator's, not the doctor's: no identity, no login/logout tracking.
          state.impersonating = true;
        } else {
          state.impersonating = false;
          if (s.page_reset) state.pageName = null;
          else if (s.page_name) state.pageName = s.page_name;
          const prev = state.identity;
          if (s.status === 'present') {
            // Switch detection keys on doctor_uid (stable), never email (null for Google logins).
            let switched = false;
            if (prev && prev.doctor_uid !== s.identity.doctor_uid) {
              // Never assert the logout of a doctor whose login was withheld as stale.
              if (!state.stale) emit('logout', { ctx: { doctor_uid: prev.doctor_uid, email: prev.email, display_name: prev.display_name, impersonating: false } });
              state.identity = null;
              state.lastDoc = null; // a different doctor: the previous hint is gone
              state.stale = null;
              switched = true;
              if (!s.page_name) state.pageName = null; // the remembered greeting belonged to the previous cookie
            }
            // A new doctor (attributed or stale) never inherits another doctor's placement hint.
            if (state.lastDoc && state.lastDoc.doctor_uid !== s.identity.doctor_uid) state.lastDoc = null;
            const wasStale = !!state.stale;
            state.identity = s.identity;
            state.identityAt = now();
            state.identityStatus = 'present';
            state.identityReason = s.reason;
            if (L.isStale(s.identity.display_name, state.pageName)) {
              // The cookie says one doctor, the page greets another: assert nobody, once, until a matching read.
              if (!state.stale || state.stale.cookie_uid !== s.identity.doctor_uid) {
                state.stale = { cookie_uid: s.identity.doctor_uid, cookie_name: s.identity.display_name };
                emit('identity_stale', { cookie_uid: s.identity.doctor_uid, cookie_name: s.identity.display_name });
              }
            } else {
              state.stale = null;
              state.lastDoc = { doctor_uid: s.identity.doctor_uid, at: now() };
              if (!prev || switched || wasStale) emit('login');
            }
          } else if (s.status === 'absent') {
            // A hidden Pulse tab reporting "logged out" must not evict a doctor who is logged
            // in elsewhere on this machine (another tab/window/profile may hold the live
            // session). Only a visible tab's "absent" is an authoritative logout.
            if (s.visible) {
              if (prev && !state.stale) emit('logout', { ctx: { doctor_uid: prev.doctor_uid, email: prev.email, display_name: prev.display_name, impersonating: false } });
              state.identity = null;
              state.identityAt = null;
              state.stale = null;
              state.identityStatus = 'absent';
              // A true logout (no read-failure reason) clears the placement hint; absent_401 and friends do not.
              if (!s.reason) state.lastDoc = null;
              state.identityReason = s.reason; // e.g. absent_401; the page may still greet someone (page_name)
            }
          } else {
            state.identityStatus = 'invalid'; // fail closed: doctor null until a valid read; last-known kept, no logout
            state.identityReason = s.reason;
          }
        }
        if (s.visible) {
          const ref = s.route.prescription_ref;
          if (ref !== state.openRef) {
            if (state.openRef) emit('encounter_close', { prescription_ref: state.openRef });
            if (ref) emit('encounter_open', { prescription_ref: ref });
            state.openRef = ref;
          }
        }
      });
    }

    // Emits a real logout for the departing doctor and clears identity. Never fires for impersonation
    // or with no identity, and clears identity so a later heartbeat/tab event cannot emit a second one.
    function departIdentity(state, emit, reason) {
      const prev = state.identity;
      if (state.impersonating) return false;
      if (!prev) { state.lastDoc = null; return false; } // nobody held (e.g. after absent_401): the placement hint still ends here
      if (!state.stale) emit('logout', { reason, ctx: { doctor_uid: prev.doctor_uid, email: prev.email, display_name: prev.display_name, impersonating: false } });
      state.identity = null;
      state.identityAt = null;
      state.lastDoc = null;
      state.stale = null;
      state.identityStatus = 'absent';
      state.identityReason = null;
      state.pageName = null; // the next cookie identity must not be compared against this session's greeting
      state.awaySince = null;
      return true;
    }

    function onIdle(newState) {
      if (!['active', 'idle', 'locked'].includes(newState)) return Promise.resolve();
      return run(async (state, emit) => {
        state.idle = newState;
        if (newState === 'active') state.awaySince = null;
        else if (state.awaySince == null) state.awaySince = now();
        emit(newState);
      });
    }

    function onHeartbeat() {
      return run(async (state, emit) => {
        await applyFocus(state, emit, undefined, true);
        if (state.awaySince != null && now() - state.awaySince >= idleLogoutMs) departIdentity(state, emit, 'idle_timeout');
        emit('heartbeat');
      });
    }

    // Last Pulse tab closed while a doctor is attached: nothing can report the logout, so emit it here.
    function onTabRemoved() {
      if (!chrome.tabs || typeof chrome.tabs.query !== 'function') return Promise.resolve();
      return run(async (state, emit) => {
        if ((!state.identity && !state.lastDoc) || state.impersonating) return;
        let tabs;
        try { tabs = await chrome.tabs.query({}); } catch (e) { return; } // unknown: fail safe, no logout
        if (!Array.isArray(tabs)) return;
        const open = tabs.some((t) => t && typeof t.url === 'string' && t.url.startsWith(L.PULSE_ORIGIN + '/'));
        if (!open) departIdentity(state, emit, 'tab_closed');
      });
    }

    // webRequest: only the single consult_uid field is kept from the body.
    function onBeforeRequest(d) {
      if (!d || (d.method && d.method !== 'POST')) return;
      const kind = L.classifyUrl(d.url);
      if (!kind) return;
      const p = L.parseConsultBody(d.requestBody);
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
      pending.set(d.requestId, { kind, ok: p.ok, consult_uid: p.consult_uid, why: p.why, body_keys: p.body_keys });
    }
    function onCompleted(d) {
      const p = d && pending.get(d.requestId);
      if (!p) return Promise.resolve();
      pending.delete(d.requestId);
      if (!(d.statusCode >= 200 && d.statusCode < 300)) return Promise.resolve();
      return run(async (state, emit) => {
        emit(p.kind === 'start' ? 'encounter_open' : 'encounter_close', {
          encounter_id: p.consult_uid,
          prescription_ref: state.openRef,
          reason: p.ok ? null : 'body_' + (L.WHY.includes(p.why) ? p.why : 'no_body'),
          body_keys: p.ok ? undefined : p.body_keys,
        });
      });
    }
    function onErrorOccurred(d) {
      if (d) pending.delete(d.requestId);
    }

    // Listeners are registered synchronously at worker start.
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (!sender || sender.id !== chrome.runtime.id) return false;
      if (typeof sender.url !== 'string' || !sender.url.startsWith(L.PULSE_ORIGIN + '/')) return false;
      onState(msg).catch(() => {});
      return false;
    });
    chrome.idle.setDetectionInterval(IDLE_SECONDS);
    chrome.idle.onStateChanged.addListener((s) => { onIdle(s).catch(() => {}); });
    chrome.tabs.onActivated.addListener(() => { refreshFocus().catch(() => {}); });
    if (chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(() => { onTabRemoved().catch(() => {}); });
    chrome.windows.onFocusChanged.addListener((id) => { refreshFocus(id).catch(() => {}); });
    chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === HEARTBEAT_ALARM) onHeartbeat().catch(() => {}); });
    Promise.resolve(chrome.alarms.get(HEARTBEAT_ALARM)).then((a) => {
      if (!a) chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
    }).catch(() => {});
    const filter = { urls: [L.START_URL, L.END_URL] };
    chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter, ['requestBody']); // non-blocking
    chrome.webRequest.onCompleted.addListener((d) => { onCompleted(d).catch(() => {}); }, filter);
    chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, filter);

    return {
      onState, onIdle, onHeartbeat, onTabRemoved, refreshFocus, onBeforeRequest, onCompleted, transport,
      settled: async () => { await chain; await flushP; await chain; },
    };
  }

  return { HEARTBEAT_ALARM, IDLE_SECONDS, sanitizeMessage, createAgent };
});
