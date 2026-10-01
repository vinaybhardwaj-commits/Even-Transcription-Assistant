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
    tabs: { onActivated: emitter() },
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
    email: 'Dr.Test@Even.in',
    displayName: 'Dr Test',
    phoneNumber: '+910000000000',
    stsTokenManager: { refreshToken: 'SECRET-REFRESH-TOKEN', accessToken: 'SECRET-ACCESS-TOKEN', expirationTime: 1 },
    apiKey: 'AIzaFAKEKEY',
  },
};

module.exports = { makeChrome, makeFetch, makeIndexedDB, bytes, TOKEN_RECORD, emitter };
