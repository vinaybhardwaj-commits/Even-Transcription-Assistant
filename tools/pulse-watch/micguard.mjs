// Mic-permission guard state for the board. Pure: no I/O, no clock reads except through the `now` argument.
// Rows come from kiosk_health_events (kind 'mic_guard'); the newest row per room is classified here.
export const STALE_AFTER_S = 600;                       // newest row older than this => poller_silent
const ALERT_STATES = new Set(['restored', 'read_error', 'missing', 'write_failed', 'db_missing', 'stale']);
const IST_MS = 5.5 * 3600e3;
const istDay = (ms) => Math.floor((ms + IST_MS) / 86400e3);
const istClock = (ms) => { const d = new Date(ms + IST_MS); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
// Cell labels fit the 12-13 wide narrow layout; the full words are in the problem line.
export const LABEL = { read_error: 'PERM rd err', missing: 'PERM missing', write_failed: 'PERM wr fail', db_missing: 'PERM no db', stale: 'PERM stale' };
// A kiosk that is switched off reads as stale/ssh_unreachable; that is only an alert in clinic hours (08:00-21:00 IST).
const inClinicHours = (ms) => { const h = new Date(ms + IST_MS).getUTCHours(); return h >= 8 && h < 21; };
const parseMs = (v) => { const t = v == null ? NaN : new Date(v).getTime(); return Number.isFinite(t) ? t : NaN; };

// row: { ts, payload } or undefined. now: epoch ms.
// Returns null (no change to the mic cell) or { alert: true, state, reason, text, problem }.
export function classify(row, now = Date.now()) {
  if (!row) return null;
  const p = (row.payload && typeof row.payload === 'object') ? row.payload : {};
  if (p.state === 'not_installed') return null;
  const rowMs = parseMs(row.ts);
  if (!Number.isFinite(rowMs)) return null;
  if ((now - rowMs) / 1000 > STALE_AFTER_S) {
    return { alert: true, state: 'stale', reason: 'poller_silent', text: 'PERM stale',
      problem: 'mic permission check has gone quiet (poller_silent) — the guard state is unknown; check the room computer.' };
  }
  const state = String(p.state || '');
  const restoredN = Number(p.restored_today) || 0;
  const lastMs = parseMs(p.last_restored_at);
  // "restored today" counts only until IST midnight, judged from the restore time (or the row time when it is missing)
  const restoredToday = restoredN > 0 && istDay(Number.isFinite(lastMs) ? lastMs : rowMs) === istDay(now);
  if (state === 'restored' || (restoredToday && !ALERT_STATES.has(state))) {
    const at = Number.isFinite(lastMs) ? istClock(lastMs) : (state === 'restored' ? istClock(rowMs) : null);
    return { alert: true, state: 'restored', reason: p.reason || null, text: at ? `PERM r ${at}` : 'PERM restored',
      problem: `mic permission was switched off and restored${at ? ' at ' + at : ''} — check the recorder is capturing.` };
  }
  if (ALERT_STATES.has(state)) {
    if (state === 'stale' && p.reason === 'ssh_unreachable' && !inClinicHours(now)) return null;
    const reason = p.reason ? ` — ${p.reason}` : '';
    const words = {
      read_error: 'mic permission check cannot read (read_error)',
      missing: 'mic permission check is missing on the room computer (missing)',
      write_failed: 'mic permission could not be restored (write_failed)',
      db_missing: 'mic permission database not found (db_missing)',
      stale: 'mic permission check is out of date (stale)',
    }[state];
    return { alert: true, state, reason: p.reason || null, text: LABEL[state], problem: words + reason + '.' };
  }
  return null;   // ok, or an unknown state: leave the cell alone
}

// Apply to the mic cell. UNPLUGGED / SILENT keep their text; the PERM problem line is still pushed.
export function applyToMic(mic, problems, verdict) {
  if (!verdict) return mic;
  problems.push(verdict.problem);
  if (/^(UNPLUGGED|SILENT)/.test(mic.text)) return mic;
  return { text: verdict.text, color: 'red' };
}

// Fail-soft read: any error or no rows => empty Map (the board renders as before).
// run: () => Promise<rows>, the caller's tagged-template query.
export async function fetchMicGuard(run) {
  try {
    const rows = await run();
    const m = new Map();
    for (const r of Array.isArray(rows) ? rows : []) if (r && r.room_id) m.set(r.room_id, r);
    return m;
  } catch { return new Map(); }
}
