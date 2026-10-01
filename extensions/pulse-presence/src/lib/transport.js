// Transport (R5): local retry queue in storage.local, 24 h expiry, exponential backoff, batched POST.
(function (root, factory) {
  const api = factory(typeof require === 'function' && typeof module !== 'undefined' ? require : null, root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PulseLib = Object.assign(root.PulseLib || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : self, function (req, root) {
  const E = req ? req('./events.js') : root.PulseLib;

  // Per-host config, baked in as a literal at package time (kit replaces the next line).
  const BAKED_CONFIG = {}; // ETA_BAKE

  const EXPIRY_MS = 24 * 60 * 60 * 1000;
  const BACKOFF_BASE_MS = 10 * 1000;
  const BACKOFF_MAX_MS = 15 * 60 * 1000;
  const BATCH_SIZE = 50;
  const QUEUE_CAP = 2000;
  const FETCH_TIMEOUT_MS = 15 * 1000;
  const CONFIG_KEYS = ['machine_id', 'room', 'ingest_url', 'token'];
  // 4xx answers that mean "this batch is bad", not "try later". Everything else is retried.
  const RETRYABLE_4XX = [401, 403, 408, 425, 429];

  function backoffDelay(failures) {
    if (failures <= 0) return 0;
    return Math.min(BACKOFF_BASE_MS * Math.pow(2, failures - 1), BACKOFF_MAX_MS);
  }

  function prune(queue, now) {
    const live = queue.filter((q) => q && typeof q.at === 'number' && now - q.at < EXPIRY_MS);
    return live.length > QUEUE_CAP ? live.slice(live.length - QUEUE_CAP) : live;
  }

  function createTransport({ chrome, fetchFn, now }) {
    let lock = Promise.resolve();
    function serial(fn) {
      const run = lock.then(fn);
      lock = run.catch(() => {});
      return run;
    }

    // Per key: storage.managed, then storage.local (dev), then config baked into the package
    // (manifest.eta_config, written per host by the install kit).
    async function getConfig() {
      let managed = {};
      let local = {};
      try { managed = (await chrome.storage.managed.get(CONFIG_KEYS)) || {}; } catch (e) { managed = {}; }
      try { local = (await chrome.storage.local.get(CONFIG_KEYS)) || {}; } catch (e) { local = {}; }
      let pkg = {};
      try { pkg = (typeof globalThis !== 'undefined' && globalThis.ETA_CONFIG) ? globalThis.ETA_CONFIG : {}; } catch (e) { pkg = {}; }
      let baked = {};
      try { baked = (chrome.runtime.getManifest() || {}).eta_config || {}; } catch (e) { baked = {}; }
      const cfg = {};
      for (const k of CONFIG_KEYS) {
        const pick = (o) => (o && typeof o[k] === 'string' && o[k] ? o[k] : null);
        const v = pick(managed) || pick(local) || pick(BAKED_CONFIG) || pick(pkg) || pick(baked);
        cfg[k] = typeof v === 'string' && v ? v : null;
      }
      return cfg;
    }

    async function load() {
      const s = await chrome.storage.local.get(['queue', 'transport']);
      return {
        queue: Array.isArray(s.queue) ? s.queue : [],
        t: s.transport && typeof s.transport === 'object' ? s.transport : { failures: 0, nextAttemptAt: 0 },
      };
    }

    function enqueue(events) {
      return serial(async () => {
        const { queue } = await load();
        const t = now();
        for (const ev of events) queue.push({ at: t, event: ev });
        await chrome.storage.local.set({ queue: prune(queue, t) });
      });
    }

    async function post(cfg, events) {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
      try {
        const res = await fetchFn(cfg.ingest_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
          body: JSON.stringify({ events }),
          credentials: 'omit',
          signal: ctl ? ctl.signal : undefined,
        });
        return res.status;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    function flush() {
      return serial(async () => {
        const cfg = await getConfig();
        let { queue, t } = await load();
        queue = prune(queue, now());
        // Anything that is not an exact R6 event is dropped here, never sent.
        queue = queue.filter((q) => E.validateEvent(q.event).length === 0);
        const save = () => chrome.storage.local.set({ queue, transport: t });
        if (!cfg.ingest_url || !cfg.token || !/^https:\/\//.test(cfg.ingest_url)) { await save(); return { sent: 0, reason: 'unconfigured' }; }
        if (now() < t.nextAttemptAt) { await save(); return { sent: 0, reason: 'backoff' }; }
        let sent = 0;
        while (queue.length) {
          const batch = queue.slice(0, BATCH_SIZE);
          let status = 0;
          try { status = await post(cfg, batch.map((q) => q.event)); } catch (e) { status = 0; }
          const ok = status >= 200 && status < 300;
          const poison = status >= 400 && status < 500 && !RETRYABLE_4XX.includes(status);
          if (ok || poison) {
            queue = queue.slice(batch.length);
            t = { failures: 0, nextAttemptAt: 0 };
            if (ok) sent += batch.length;
          } else {
            const failures = (t.failures || 0) + 1;
            t = { failures, nextAttemptAt: now() + backoffDelay(failures) };
            await save();
            return { sent, reason: 'retry' };
          }
        }
        await save();
        return { sent, reason: 'ok' };
      });
    }

    return { getConfig, enqueue, flush };
  }

  return { EXPIRY_MS, BACKOFF_BASE_MS, BACKOFF_MAX_MS, BATCH_SIZE, QUEUE_CAP, backoffDelay, prune, createTransport };
});
