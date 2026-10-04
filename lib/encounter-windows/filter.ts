/**
 * lib/encounter-windows/filter.ts — the event-load filter, in TypeScript.
 *
 * fetchEvents (./db.ts) applies this rule in SQL so background heartbeats never leave the database: drop every
 * heartbeat whose tab_focus is false, EXCEPT a heartbeat where tab_focus flips from the previous non-logout ext event
 * of the same (machine, doctor_uid) stream (ordered by ts, id; the first event of a stream counts as a flip).
 * Everything that is not a heartbeat, and every focused heartbeat, is kept.
 *
 * WHY THE FLIPS MATTER. The occupancy tiebreak reads each stream's LATEST tab_focus flag. Dropping all background
 * heartbeats leaves a profile that was focused and then backgrounded reading "focused" forever, so two profiles look
 * focused and the occupant comes out ambiguous. Keeping only the flip event gives the same latest flag as the full
 * stream with far fewer rows (the resolver reads nothing else from a background heartbeat).
 *
 * This function mirrors the SQL so the rule can be unit-tested without a database. It is NOT called on the
 * production path; a scratch run against a real Postgres engine (pglite) checked that the SQL and this function keep
 * the same ids on random streams.
 */
import { byTimeThenId, normalizeEvent, type NEvent } from "./occupancy";
import type { PresenceEvent } from "./types";

/** Returns the events the SQL filter would return, in (ts, id) order. */
export function keepFocusFlips(events: PresenceEvent[]): PresenceEvent[] {
  const pairs = events
    .map((raw) => ({ raw, n: normalizeEvent(raw) }))
    .filter((p): p is { raw: PresenceEvent; n: NEvent } => p.n !== null);
  pairs.sort((a, b) => byTimeThenId(a.n, b.n));
  const prev = new Map<string, boolean>(); // (machine, uid) -> previous non-logout ext flag
  const out: PresenceEvent[] = [];
  for (const { raw, n } of pairs) {
    let keep = n.event !== "heartbeat" || n.focus;
    if (n.source === "ext" && n.event !== "logout") {
      const k = `${n.machine}\u0000${n.uid ?? ""}`;
      const before = prev.get(k);
      if (before === undefined || before !== n.focus) keep = true;
      prev.set(k, n.focus);
    }
    if (keep) out.push(raw);
  }
  return out;
}
