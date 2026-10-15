
// Fakes for chrome.* and IndexedDB. Enough surface for the extension, nothing more.
function emitter() {
  const ls = [];
  return { addListener: (f) => ls.push(f), fire: (...a) => ls.map((f) => f(...a)), listeners: ls };
}

function area(initial = {}, opts = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (opts.throws) throw new Error('managed storage unavailable');
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
      return out;
    },
    async set(obj) { for (const k of Object.keys(obj)) data[k] = JSON.parse(JSON.stringify(obj[k])); },
    async remove(k) { delete data[k]; },
  };
}

function makeChrome({ managed = {}, local = {}, managedThrows = false, version = '0.1.0', eta_config } = {}) {
  const alarms = new Map();
  const c = {
    runtime: { id: 'ext-id', getManifest: () => ({ version, ...(eta_config ? { eta_config } : {}) }), onMessage: emitter(), sendMessage: async () => {} },
    storage: { managed: area(managed, { throws: managedThrows }), local: area(local) },
    alarms: {
      onAlarm: emitter(),
      create: (name, info) => alarms.set(name, info),
      get: async (name) => (alarms.has(name) ? { name, ...alarms.get(name) } : undefined),
      _map: alarms,
    },
    idle: { onStateChanged: emitter(), setDetectionInterval: (s) => { c.idle.interval = s; }, interval: null },
    webRequest: { onBeforeRequest: emitter(), onCompleted: emitter(), onErrorOccurred: emitter() },
    tabs: { onActivated: emitter(), onRemoved: emitter(), open: [], query: async () => c.tabs.open.map((x) => ({ ...x })) },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: emitter(),
      focused: { focused: false, tabs: [] },
      getLastFocused: async () => c.windows.focused,
    },
  };
  return c;
}

// Fake fetch that records every POST.
function makeFetch(statuses = []) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const status = statuses.length ? statuses.shift() : 200;
    return { status, ok: status >= 200 && status < 300 };
  };
  fn.calls = calls;
  return fn;
}

const ACCESS_URL = 'https://pulse.even.in/api/auth/clinical/access/verify';
const NAME_URL = 'https://pulse.even.in/api/auth/getName';

// Fake Pulse API fetch (GET, cookie-authed). Each endpoint is one of:
//   { status, body }  -> responds with that status and JSON body
//   { throws: true }  -> network error
//   { badJson: true } -> 200 whose body does not parse
// Mutate fn.accessSpec / fn.nameSpec between calls to simulate login changes. fn.calls records every URL fetched.
function makeApiFetch({ access, name } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const spec = url === ACCESS_URL ? fn.accessSpec : url === NAME_URL ? fn.nameSpec : { status: 404, body: {} };
    if (!spec) return { status: 404, ok: false, json: async () => ({}) };
    if (spec.throws) throw new TypeError('network down');
    const status = spec.status === undefined ? 200 : spec.status;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => { if (spec.badJson) throw new SyntaxError('bad json'); return JSON.parse(JSON.stringify(spec.body)); },
    };
  };
  fn.calls = calls;
  fn.accessSpec = access; // function.name is read-only, hence the Spec suffix
  fn.nameSpec = name;
  return fn;
}

// The two captured Pulse API shapes (Google session).
const ACCESS_OK = (uid = 'FAKEUID000000000001', over = {}) => ({
  status: 200,
  body: { data: { has_access: true, doctor: { uid, specialty: 'HEALTH_CHECK_UP', stream_data: {} }, user_type: 'DOCTOR', is_impersonating: false, message: 'OK', ...over }, message: 'OK' },
});
const NAME_OK = (n = 'Dr Vinay Bhardwaj') => ({ status: 200, body: { data: n, message: 'OK' } });

function bytes(obj) { return { raw: [{ bytes: new TextEncoder().encode(JSON.stringify(obj)).buffer }] }; }

// Fake IndexedDB: one optional database with one store of records.
function makeIndexedDB(records) {
  let created = false;
  return {
    get created() { return created; },
    open(name) {
      const req = {};
      setTimeout(() => {
        if (records === null) {
          req.transaction = { abort: () => { setTimeout(() => req.onerror && req.onerror(), 0); } };
          req.onupgradeneeded && req.onupgradeneeded();
          created = false;
          return;
        }
        req.result = {
          objectStoreNames: { contains: (s) => s === 'firebaseLocalStorage' },
          close() {},
          transaction() {
            return {
              objectStore() {
                return {
                  openCursor() {
                    const cur = {};
                    let i = 0;
                    const step = () => setTimeout(() => {
                      cur.result = i < records.length
                        ? { key: records[i].fbase_key, value: records[i], continue() { i++; step(); } }
                        : null;
                      cur.onsuccess && cur.onsuccess();
                    }, 0);
                    step();
                    return cur;
                  },
                };
              },
            };
          },
        };
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  };
}

const TOKEN_RECORD = {
  fbase_key: 'firebase:authUser:AIzaFAKEKEY:[DEFAULT]',
  value: {
    uid: 'uid-DOC-123',
    email: 'Dr.Test@Example.test',
    displayName: 'Dr Test',
    phoneNumber: '+910000000000',
    stsTokenManager: { refreshToken: 'SECRET-REFRESH-TOKEN', accessToken: 'SECRET-ACCESS-TOKEN', expirationTime: 1 },
    apiKey: 'AIzaFAKEKEY',
  },
};

module.exports = { makeChrome, makeFetch, makeApiFetch, ACCESS_OK, NAME_OK, ACCESS_URL, NAME_URL, makeIndexedDB, bytes, TOKEN_RECORD, emitter };
