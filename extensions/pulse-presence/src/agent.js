// Service worker logic. Registers every listener synchronously; state lives in storage.local
// because the worker can be stopped at any time. The worker only posts; it never touches Pulse pages.
(function (root, factory) {
  const api = factory(typeof require === 'function' && typeof module !== 'undefined' ? require : null, root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PulseLib = Object.assign(root.PulseLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : self, function (req, root) {
  const L = req
    ? Object.assign({}, req('./lib/events.js'), req('./lib/route.js'), req('./lib/body.js'), req('./lib/transport.js'))
    : root.PulseLib;

  const HEARTBEAT_ALARM = 'pulse-heartbeat';
  const IDLE_SECONDS = 120;
  const MAX_PENDING = 100;
  const STATES = ['present', 'absent', 'invalid'];
  const ROUTE_TYPES = ['home', 'login', 'prescription', 'patient', 'other'];

  function defaultState() {
    return { identity: null, identityStatus: 'absent', impersonating: false, openRef: null, tabFocus: false, idle: 'active' };
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
      const email = cleanStr(m.identity.email, 254);
      if (email && /^[^@\s]+@[^@\s]+$/.test(email)) identity = { email, display_name: cleanStr(m.identity.display_name, 200) };
    }
    const r = m.route || {};
    const ref = typeof r.prescription_ref === 'string' && L.REF_RE.test(r.prescription_ref) ? r.prescription_ref : null;
    return {
      status: status === 'present' && !identity ? 'invalid' : status,
      identity,
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
      const hidden = state.impersonating || state.identityStatus === 'invalid' || !state.identity;
      return {
        email: hidden ? null : state.identity.email,
        display_name: hidden ? null : state.identity.display_name,
        impersonating: state.impersonating,
      };
    }

    // R10: sorted, deduped, comma-joined set of active status codes; null when empty.
    function reasonSet(state, extra) {
      const codes = new Set();
      if (extra.reason) codes.add(extra.reason);
      // An explicit ctx is a real logout of a known doctor; impersonation never reads the record.
      if (state.identityStatus === 'invalid' && !state.impersonating && !extra.ctx) codes.add('identity_unreadable');
      return codes.size ? [...codes].sort().join(',') : null;
    }

    // Runs fn(state, emit) with the persisted state, then saves state and queues the events.
    function run(fn) {
      return serial(async () => {
        const state = await loadState();
        const cfg = await transport.getConfig();
        const out = [];
        const emit = (name, extra = {}) => {
          const ctx = extra.ctx || ctxOf(state);
          out.push(L.buildEvent({
            machine_id: cfg.machine_id, room: cfg.room,
            email: ctx.email, display_name: ctx.display_name, impersonating: ctx.impersonating,
            event: name, encounter_id: extra.encounter_id, prescription_ref: extra.prescription_ref,
            ts: L.isoLocal(now()), tab_focus: state.tabFocus, ext_version: version,
            reason: reasonSet(state, extra),
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
          // The Firebase user is the impersonator, not the doctor: no identity, no login/logout tracking.
          state.impersonating = true;
        } else {
          state.impersonating = false;
          const prev = state.identity;
          if (s.status === 'present') {
            if (prev && prev.email !== s.identity.email) {
              emit('logout', { ctx: { email: prev.email, display_name: prev.display_name, impersonating: false } });
              state.identity = null;
            }
            if (!state.identity) {
              state.identity = s.identity;
              state.identityStatus = 'present';
              emit('login');
            } else {
              state.identity = s.identity;
            }
            state.identityStatus = 'present';
          } else if (s.status === 'absent') {
            if (prev) emit('logout', { ctx: { email: prev.email, display_name: prev.display_name, impersonating: false } });
            state.identity = null;
            state.identityStatus = 'absent';
          } else {
            state.identityStatus = 'invalid'; // fail closed: doctor null until a valid record is read
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

    function onIdle(newState) {
      if (!['active', 'idle', 'locked'].includes(newState)) return Promise.resolve();
      return run(async (state, emit) => { state.idle = newState; emit(newState); });
    }

    function onHeartbeat() {
      return run(async (state, emit) => {
        await applyFocus(state, emit, undefined, true);
        emit('heartbeat');
      });
    }

    // webRequest: only the single consult_uid field is kept from the body.
    function onBeforeRequest(d) {
      if (!d || (d.method && d.method !== 'POST')) return;
      const kind = L.classifyUrl(d.url);
      if (!kind) return;
      const p = L.parseConsultBody(d.requestBody);
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
      pending.set(d.requestId, { kind, ok: p.ok, consult_uid: p.consult_uid });
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
          reason: p.ok ? null : 'body_unavailable',
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
      onState, onIdle, onHeartbeat, refreshFocus, onBeforeRequest, onCompleted, transport,
      settled: async () => { await chain; await flushP; await chain; },
    };
  }

  return { HEARTBEAT_ALARM, IDLE_SECONDS, sanitizeMessage, createAgent };
});
