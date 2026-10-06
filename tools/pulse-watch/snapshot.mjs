// snapshot.mjs — per-machine facts for the pulse-watch board (ext version, heartbeat age, poller, instances, pending, warehouse doctor).
// One machine-scoped, 10-minute-bounded read of pulse_presence_events (ext + poller rows), cached for CACHE_MS; everything else comes from the resolver rows.
export const TARGET_EXT = '0.1.1.39';
export const WINDOW_MIN = 10;          // ext/poller rows older than this are ignored
export const CACHE_MS = 30_000;        // the board refreshes every 5 s; this query runs at most every 30 s
export const POLLER_STALE_S = 180;     // poller silent this long => red
export const HB_WARN_S = 90;           // heartbeat older than this => yellow
export const HB_RED_S = 180;           // heartbeat older than this on an occupied row => red

// numeric dotted-version compare: -1 / 0 / 1 (never lexical: 0.1.1.9 < 0.1.1.39)
export function compareVer(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0), pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

// the poller's pre-5-Oct short key for an extension machine id (consul4 for EHRC-CONSUL4s-Mac-mini); same map as occupancy.mjs POLLER_LEGACY_KEYS
const legacyKey = (machine) => { const m = /^EHRC-([A-Z0-9]+)s-Mac-mini$/.exec(machine); return m ? m[1].toLowerCase() : null; };

// -> Map<machine, {ver, hbTs, pollTs, pollEvent, pollIdle}> for the given machine ids, newest row of each kind in the last WINDOW_MIN minutes
export async function fetchFacts(sql, machines) {
  const keys = new Set();
  for (const m of machines) { keys.add(m); const l = legacyKey(m); if (l) keys.add(l); }
  const q = `select machine, source, event, ts, payload->>'ext_version' as ver,
      case when payload->>'idle_s' ~ '^[0-9]+([.][0-9]+)?$' then (payload->>'idle_s')::float8 end as idle
    from pulse_presence_events
    where machine = any($1::text[]) and source in ('ext','poller') and ts > now() - ($2::int * interval '1 minute')
    order by ts desc limit 4000`;
  const args = [[...keys], WINDOW_MIN];
  const rows = await (sql.query ? sql.query(q, args) : sql(q, args));   // neon <1.0 has no .query
  const byKey = new Map();
  const slot = (k) => { if (!byKey.has(k)) byKey.set(k, { ver: null, hbTs: null, pollTs: null, pollEvent: null, pollIdle: null }); return byKey.get(k); };
  for (const r of rows) {                                                // newest first: the first row of each kind wins
    const f = slot(r.machine);
    if (r.source === 'ext') {
      if (f.ver == null && r.ver) f.ver = r.ver;
      if (f.hbTs == null && r.event === 'heartbeat') f.hbTs = r.ts;
    } else if (f.pollTs == null) { f.pollTs = r.ts; f.pollEvent = r.event; f.pollIdle = r.idle; }
  }
  const out = new Map();
  for (const m of machines) {
    const a = byKey.get(m), l = legacyKey(m), b = l ? byKey.get(l) : null;
    const f = { ver: a?.ver ?? null, hbTs: a?.hbTs ?? null, pollTs: a?.pollTs ?? null, pollEvent: a?.pollEvent ?? null, pollIdle: a?.pollIdle ?? null };
    if (b && b.pollTs && (!f.pollTs || new Date(b.pollTs) > new Date(f.pollTs))) { f.pollTs = b.pollTs; f.pollEvent = b.pollEvent; f.pollIdle = b.pollIdle; }
    out.set(m, f);
  }
  return out;
}

// in-memory cache: returns the last facts, refreshing at most every CACHE_MS (force=true always refreshes). A failed refresh keeps the old facts.
let cache = { at: 0, facts: new Map(), err: null };
export async function cachedFacts(sql, machines, force = false) {
  if (force || Date.now() - cache.at >= CACHE_MS) {
    try { cache = { at: Date.now(), facts: await fetchFacts(sql, machines), err: null }; }
    catch (e) { cache = { at: Date.now() - CACHE_MS + 5000, facts: cache.facts, err: e.message }; }   // retry in 5 s, keep the old facts meanwhile
  }
  return cache;
}

const ageS = (ts, now) => Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
const trunc = (s, n) => { s = String(s ?? ''); return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…'; };
const reasonShort = (r) => ({ no_console_activity: 'no console', identity_stale: 'stale id' }[r] || String(r || '?').replace(/_/g, ' '));
const ageFmt = (s) => (s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h');

// -> [{text, color}] segments, color one of 'dim'|'red'|'yellow'|'gray'
export function suffixParts(m, f, now = Date.now()) {
  const P = [];
  const present = !!m.occupied || !!(m.occupant_display && m.occupant_display.label === 'consulting');   // someone is in the room: missing/stale extension data is a fault (red), else grey
  if (!f || !f.ver) P.push({ text: 'ext —', color: present ? 'red' : 'gray' });
  else P.push({ text: 'ext ' + f.ver, color: compareVer(f.ver, TARGET_EXT) < 0 ? 'red' : 'dim' });
  if (f && f.hbTs) { const s = ageS(f.hbTs, now); P.push({ text: 'hb ' + ageFmt(s), color: present && s > HB_RED_S ? 'red' : s > HB_WARN_S ? 'yellow' : 'dim' }); }
  else P.push({ text: 'hb —', color: present ? 'red' : 'gray' });
  if (f && f.pollTs) {
    const s = ageS(f.pollTs, now), stale = s > POLLER_STALE_S, ok = f.pollEvent === 'ok';
    const idle = f.pollIdle != null ? ' idle ' + ageFmt(Math.round(f.pollIdle)) : '';
    P.push({ text: 'poll ' + (stale ? (f.pollEvent || '?') + ' ' + ageFmt(s) + ' ago' : (f.pollEvent || '?') + idle), color: stale || !ok ? 'red' : 'dim' });
  } else P.push({ text: 'poll —', color: 'red' });
  if (m.instances > 1) P.push({ text: '×' + m.instances, color: 'dim' });
  if (m.pending) P.push({ text: 'PENDING: ' + trunc(m.pending.display_name || 'unknown', 14) + ' (' + reasonShort(m.pending.reason) + ')', color: 'yellow' });
  const c = m.consulting, od = m.occupant_display;
  if (c && c.uid && (c.live || c.t_close == null)) {
    const shownUid = od ? od.uid : m.doctor_uid;
    if (shownUid !== c.uid) P.push({ text: 'wh: ' + trunc(c.name || c.uid, 18), color: 'dim' });
  }
  return P;
}

export const HEADER_NOTE = 'cols: ext version · hb age · poller · instances · PENDING · wh=warehouse doctor';
