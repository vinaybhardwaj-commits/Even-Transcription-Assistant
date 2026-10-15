// tracker.mjs — the TRACKER column of the rooms board (pure; no database, no clock except `now`).
// Rule order: no tracker -> n/a; fresh signal -> ok / old version; outside the room's tracker hours -> 'after hours'; latest extension event is a logout
// (reason tab_closed or idle_timeout) -> 'signed out HH:MM' (not down); else 'no signal ...'.
import { compareVer } from './snapshot.mjs';

const IST = { timeZone: 'Asia/Kolkata', hour12: false };
const hhmm = (d) => d.toLocaleTimeString('en-GB', { ...IST, hour: '2-digit', minute: '2-digit' });
const ageSecAt = (ts, now) => (ts == null ? Infinity : Math.max(0, (now - new Date(ts).getTime()) / 1000));
const ageStrAt = (ts, now) => { const s = Math.round(ageSecAt(ts, now)); return s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
export const SIGNED_OUT_REASONS = ['tab_closed', 'idle_timeout'];

export function trackerOf(room, byMachine, facts, { okS, minExt, inTrackerHours, now = Date.now() }) {
  if (room.noTracker) return { text: 'n/a', color: 'dim', down: false };
  const f = facts.get(room.machine), r = byMachine.get(room.machine);
  const sig = Math.min(ageSecAt(f && f.hbTs, now), ageSecAt(r && r.ts, now));   // freshest sign of life from the extension
  if (sig < okS) {
    if (f && f.ver && compareVer(f.ver, minExt) < 0) return { text: 'old version', color: 'yellow', down: false };
    return { text: 'ok', color: 'green', down: false };
  }
  if (room.trackerHours && inTrackerHours && !inTrackerHours(room)) return { text: 'after hours', color: 'dim', down: false };
  if (f && f.lastEvt === 'logout' && f.lastEvtTs != null && SIGNED_OUT_REASONS.includes(f.lastEvtReason))
    return { text: `signed out ${hhmm(new Date(f.lastEvtTs))}`, color: 'dim', down: false };
  return { text: Number.isFinite(sig) ? `no signal ${ageStrAt(new Date(now - sig * 1000), now)}` : 'no signal', color: 'yellow', down: true, secs: sig };
}
