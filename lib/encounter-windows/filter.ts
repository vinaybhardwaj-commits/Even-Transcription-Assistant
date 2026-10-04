/**
 * lib/encounter-windows/filter.ts — the event-load filter, in TypeScript.
 *
 * fetchEvents (./db.ts) applies this rule in SQL so background heartbeats never leave the database:
 *   base  = rows with source in (ext, resolver), a machine, and ts in the read window
 *   keep  = every row that is not a heartbeat, every heartbeat with tab_focus = 'true',
 *           and every row where tab_focus FLIPS from the previous row of the same (machine, doctor_uid) stream
 *   flips = among source = 'ext' rows with event <> 'logout', ordered by (ts, id) within (machine, doctor_uid):
 *           rows where  LAG(flag) IS DISTINCT FROM flag
 * where flag = (payload->>'tab_focus' = 'true') is THREE-VALUED: true, false, or NULL when tab_focus is missing or JSON
 * null. A missing flag is UNKNOWN, not false. Consequences, all deliberate and the same here as in SQL:
 *   - LAG is NULL both for "no previous row" and for "previous row had no flag", so the two cannot be told apart;
 *   - NULL IS DISTINCT FROM NULL is false: a heartbeat with no flag after a row with no flag (or as the first row of a
 *     stream) is NOT a flip and is dropped;
 *   - true -> NULL, NULL -> false and NULL -> true are flips (the flag changed); false -> NULL too.
 * A row whose event is NULL is kept only when its flag is true (event <> 'heartbeat' is NULL, and it never enters flips).
 *
 * WHY THE FLIPS MATTER. The occupancy tiebreak reads each stream's LATEST tab_focus flag. Dropping all background
 * heartbeats leaves a profile that was focused and then backgrounded reading "focused" forever, so two profiles look
 * focused and the occupant comes out ambiguous. Keeping the flip event gives the same latest flag as the full stream
 * with far fewer rows (the resolver reads nothing else from a background heartbeat; it treats a missing flag as false,
 * which is what the retained flip rows carry too).
 *
 * This function mirrors the SQL so the rule can be unit-tested without a database. It is NOT called on the
 * production path; a scratch run against a real Postgres engine (pglite) checked that the SQL and this function keep
 * the same ids on random streams, missing flags included.
 */
import type { PresenceEvent } from "./types";

type Flag = boolean | null;

/** SQL: (payload->>'tab_focus') = 'true'. true / 'true' -> true; missing / null -> NULL; anything else -> false. */
function flagOf(v: PresenceEvent["focus"]): Flag {
  if (v === undefined || v === null) return null;
  return v === true || v === "true";
}

/** Returns the events the SQL filter would return, in (ts, id) order. */
export function keepFocusFlips(events: PresenceEvent[]): PresenceEvent[] {
  type Row = { raw: PresenceEvent; t: number; id: number; flag: Flag; stream: string };
  const rows: Row[] = [];
  for (const raw of events) {
    if (raw.source !== "ext" && raw.source !== "resolver") continue;
    if (!raw.machine) continue;
    const t = raw.ts instanceof Date ? raw.ts.getTime() : typeof raw.ts === "number" ? raw.ts : new Date(raw.ts).getTime();
    if (!Number.isFinite(t)) continue;
    rows.push({ raw, t, id: Number(raw.id), flag: flagOf(raw.focus), stream: `${raw.machine}\u0000${raw.uid ?? "\u0001null"}` });
  }
  rows.sort((a, b) => a.t - b.t || a.id - b.id);
  const prev = new Map<string, Flag>(); // stream -> previous non-logout ext flag (NULL when none or unknown)
  const out: PresenceEvent[] = [];
  for (const r of rows) {
    const { raw } = r;
    let keep: boolean;
    if (raw.event === null || raw.event === undefined) keep = r.flag === true;
    else keep = raw.event !== "heartbeat" || r.flag === true;
    if (raw.source === "ext" && raw.event !== null && raw.event !== undefined && raw.event !== "logout") {
      const before = prev.get(r.stream) ?? null;
      if (before !== r.flag) keep = true; // IS DISTINCT FROM, NULL-aware: NULL vs NULL is not distinct
      prev.set(r.stream, r.flag);
    }
    if (keep) out.push(raw);
  }
  return out;
}
