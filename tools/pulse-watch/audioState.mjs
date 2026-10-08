// audioState.mjs — AUDIO column for the pulse-watch board. Reads room_audio_state (written hourly at :20 by the box job, so the data lags the room by up to ~70 min).
// Read-only. Pure helpers (labelOf, colorOf, hmm, pickForMachine, asOfClock) are unit-tested in audioState.test.mjs; the monitor does the I/O.
export const CACHE_MS = 60_000;      // the screen may refresh faster; Neon is asked at most once a minute (failures retry on the same cadence)
export const MAP_CACHE_MS = 10 * 60_000;   // the room->machine map changes rarely: a normal refresh is ONE query
export const STALE_MS = 10 * 60_000;       // last successful refresh older than this: every cell is a dash
export const TIMEOUT_MS = 5_000;     // an audio query never holds anything up longer than this, and never blocks a render at all

export const LABELS = { recorder_off: 'OFF', muted: 'MUTED', zero_all_day: 'ZERO', audio_present: 'OK', audio_gated: 'GATED', withheld: 'WITHHELD',
  device_missing: 'MISSING', device_dead: 'DEAD', speech: 'OK', consult: 'OK', room_quiet: 'OK' };
export const labelOf = (state) => LABELS[state] || (state ? String(state).slice(0, 8) : '?');   // any other state: the raw value, 8 chars, never coloured (see colorOf)

// RED / AMBER rule. NOTE the data lags: RED means "the last known audio state was bad while a consult is open NOW" — not "the mic is dead this second".
//   consulting = the board's existing open-consult notion (occupant_display.label === 'consulting', the warehouse consult inside its label window).
//   RED   : consulting AND state in {muted, zero_all_day, recorder_off, device_missing, device_dead}
//   AMBER : consulting AND state = audio_gated
//   else  : neutral (no consult open, or a good/withheld/unknown state)
export const RED_STATES = new Set(['muted', 'zero_all_day', 'recorder_off', 'device_missing', 'device_dead']);
export function colorOf(state, consulting) {
  if (!consulting) return 'neutral';
  if (RED_STATES.has(state)) return 'red';
  if (state === 'audio_gated') return 'amber';
  return 'neutral';
}

// time in state as h:mm (minutes zero-padded); a ts_start in the future (clock skew) clamps to 0:00; bad input -> '?:??'
export function hmm(tsStart, now = Date.now()) {
  if (tsStart == null) return '?:??';
  const t = new Date(tsStart).getTime();
  if (!Number.isFinite(t)) return '?:??';
  const m = Math.max(0, Math.floor((now - t) / 60000));
  return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
}

// "HH:MM" IST of the newest written_at across rows; '—' when there is none
export function asOfClock(rows) {
  let best = NaN;
  for (const r of rows || []) { if (r.written_at == null) continue; const t = new Date(r.written_at).getTime(); if (Number.isFinite(t) && !(t <= best)) best = t; }
  return Number.isFinite(best) ? new Date(best).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' }) : '—';
}

// room_id -> machine, ONLY when the room has exactly one distinct machine in eta_encounter_windows (room_slug via room.slug). Ambiguous or absent: no entry.
export function buildRoomMachineMap(pairs) {
  const seen = new Map();
  for (const p of pairs || []) {
    if (!p || !p.room_id || !p.machine) continue;
    if (!seen.has(p.room_id)) seen.set(p.room_id, new Set());
    seen.get(p.room_id).add(p.machine);
  }
  const out = new Map();
  for (const [room, ms] of seen) if (ms.size === 1) out.set(room, [...ms][0]);
  return out;
}

// the latest interval for a watch machine. Row.machine (non-null) wins; a null-machine row maps through roomMachineMap; unmapped -> null (shown as '?', never guessed).
// If several rooms resolve to the same machine, the newest ts_end (then written_at) wins.
export function pickForMachine(machine, latestRows, roomMachineMap = new Map()) {
  let best = null;
  for (const r of latestRows || []) {
    const m = r.machine || roomMachineMap.get(r.room_id) || null;
    if (m !== machine) continue;
    const k = [new Date(r.ts_end).getTime() || 0, new Date(r.written_at).getTime() || 0];
    if (!best || k[0] > best.k[0] || (k[0] === best.k[0] && k[1] > best.k[1])) best = { r, k };
  }
  return best ? best.r : null;
}

// the cell text + color name for one machine row. snap = monitor.snapshot(); consulting = boolean.
// returns { text, color } where text is 'OFF 1:38' | '?' | '—' | '…' (not loaded yet) and color is 'red'|'amber'|'neutral'|'dim'
// a snapshot is usable only if its LAST refresh succeeded and that success is under STALE_MS old: RED/AMBER can only come from a fresh, successful read
export const isStale = (snap, now = Date.now()) => !!snap && snap.loaded && (!!snap.error || !(now - snap.okAt <= STALE_MS));
export function cellFor(machine, snap, consulting, now = Date.now()) {
  if (!snap || (!snap.loaded && !snap.error)) return { text: '…', color: 'dim' };
  if (!snap.loaded || isStale(snap, now)) return { text: '—', color: 'dim' };    // failed refresh (cached rows are NOT shown) or last success > 10 min old: dash
  const r = pickForMachine(machine, snap.rows, snap.roomMachine);
  if (!r) return { text: '?', color: 'dim' };
  return { text: `${labelOf(r.state)} ${hmm(r.ts_start, now)}`, color: colorOf(r.state, !!consulting) };
}

const withTimeout = (p, ms, onTimeout) => new Promise((res, rej) => {
  const t = setTimeout(() => { try { onTimeout && onTimeout(); } catch {} rej(new Error('audio query timeout')); }, ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});
// neon >= 1.0: sql.query(text, params, { fetchOptions }) takes a per-query fetch signal, so a timeout CANCELS the request. Older drivers: no signal (busy-skip below covers them).
const run = (sql, q, signal) => (sql.query ? sql.query(q, [], signal ? { fetchOptions: { signal } } : undefined) : sql(q));

export const LATEST_SQL = `SELECT DISTINCT ON (room_id) room_id, machine, state, ts_start, ts_end, written_at FROM room_audio_state ORDER BY room_id, ts_end DESC`;
export const MAP_SQL = `SELECT DISTINCT r.id AS room_id, w.machine FROM eta_encounter_windows w JOIN room r ON r.slug = w.room_slug WHERE w.machine IS NOT NULL`;

// monitor.refreshIfDue() never throws and never blocks the caller unless awaited; monitor.snapshot() is synchronous.
// A normal refresh is ONE query (LATEST_SQL); MAP_SQL runs on the first load and then every MAP_CACHE_MS.
// A failed refresh sets error; cellFor then dashes every cell (cached rows are never painted after an error). A refresh never starts while the previous one's requests are still
// open (busy), so requests cannot pile up even on a driver that cannot cancel.
export function createAudioMonitor(sql, { cacheMs = CACHE_MS, mapCacheMs = MAP_CACHE_MS, timeoutMs = TIMEOUT_MS, now = () => Date.now() } = {}) {
  let st = { loaded: false, rows: [], roomMachine: new Map(), asOf: '—', error: null, at: null, okAt: 0, mapAt: null };
  let inflight = null, busy = false;
  async function load() {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      const needMap = st.mapAt == null || now() - st.mapAt >= mapCacheMs;
      let under;
      try { under = Promise.all([run(sql, LATEST_SQL, ac && ac.signal), needMap ? run(sql, MAP_SQL, ac && ac.signal) : null]); } catch (e) { under = Promise.reject(e); }
      busy = true;
      under.then(() => { busy = false; }, () => { busy = false; });   // busy ends when the requests really end (settled, or cancelled by the abort)
      const [rows, pairs] = await withTimeout(under, timeoutMs, () => ac && ac.abort());
      const t = now();
      st = { loaded: true, rows, roomMachine: pairs ? buildRoomMachineMap(pairs) : st.roomMachine, asOf: asOfClock(rows), error: null, at: t, okAt: t, mapAt: pairs ? t : st.mapAt };
    } catch (e) {
      st = { ...st, error: String((e && e.message) || e).slice(0, 80), at: now() };   // message only, 80 chars; the driver's errors carry no connection string
    } finally { inflight = null; }
  }
  return {
    refreshIfDue(force = false) {
      if (inflight) return inflight;
      if (busy) return Promise.resolve();                                   // previous requests still open: skip, never pile up
      if (!force && st.at != null && now() - st.at < cacheMs) return Promise.resolve();
      inflight = load();
      return inflight;
    },
    snapshot: () => st,
  };
}
