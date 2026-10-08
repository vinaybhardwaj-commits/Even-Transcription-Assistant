/**
 * lib/steward/occupancy-read.ts — the steward's SCOPED occupancy reader (refuter F6).
 *
 * lib/encounter-windows/occupant.ts machineOccupancy reads 25-49 h of EVERY machine's extension events with no machine predicate (a scan, then a LAG window over
 * every ext row) — fine for an admin page, too heavy for a one-minute loop. This reader keeps the same occupancy RULES (occupancyAt / normalizeEvent, unchanged) and
 * changes only what is fetched:
 *   - `machine = ANY($keys)` over the roster machines only (rides pulse_presence_events (machine, ts)),
 *   - ts in [asOf - 2 h, asOf],
 *   - at most 5000 newest base rows (LIMIT inside the base CTE),
 *   - the same heartbeat filter as fetchEvents: focus flips and focused heartbeats kept, background heartbeats dropped.
 * It does not read the crosswalk or the warehouse consult table (the steward needs only occupied / pending / stale_occupant). lib/encounter-windows/db.ts and
 * occupant.ts are untouched. Neon HTTP: one bound-parameter statement for the events plus the login-poller statement withLoginPollerRows already issues.
 *
 * Difference to machineOccupancy, by design: a login older than 2 h whose machine has sent no focused heartbeat or other event since is not seen (the window is 2 h,
 * not 25-49 h). Present occupants keep sending focused heartbeats, so they stay visible. UNVERIFIED against production traffic.
 */
import { withLoginPollerRows, type WindowsDb } from "@/lib/encounter-windows/db";
import { staleOccupantLabel, type StaleOccupant } from "@/lib/encounter-windows/occupant";
import { byTimeThenId, normalizeEvent, occupancyAt, type NEvent, type OccOptions, type PendingSession } from "@/lib/encounter-windows/occupancy";
import type { PresenceEvent } from "@/lib/encounter-windows/types";

export const OCCUPANCY_LOOKBACK_MS = 2 * 3_600_000;
export const OCCUPANCY_ROW_LIMIT = 5000;

export type ScopedOccupancy = {
  machine: string;
  occupied: boolean;
  ambiguous: boolean;
  stale_occupant: StaleOccupant | null;
  pending: PendingSession | null;
  page_name: string | null;
  /** the chosen occupant's uid / display name (null when none, ambiguous, or a stale-cookie stream: then `best_stale` is true and dn is the page greeting, never the cookie's name) */
  best_uid: string | null;
  best_dn: string | null;
  best_stale: boolean;
};

export async function scopedOccupancy(db: WindowsDb, asOf: string | number | Date, machineKeys: readonly string[], opts: OccOptions = {}): Promise<ScopedOccupancy[]> {
  const A = new Date(asOf).getTime();
  if (!Number.isFinite(A)) throw new Error("scopedOccupancy: bad asOf");
  if (machineKeys.length === 0) return [];
  const lo = new Date(A - OCCUPANCY_LOOKBACK_MS).toISOString();
  const hi = new Date(A).toISOString();
  const keys = [...machineKeys];
  const rows = (await db`
    WITH base AS (
      SELECT id, source, machine, event, ts,
             payload->>'doctor_uid'       AS uid,
             payload->>'display_name'     AS dn,
             payload->>'encounter_id'     AS enc,
             payload->>'prescription_ref' AS rx,
             payload->>'tab_focus'        AS focus,
             payload->>'reason'           AS reason,
             payload->>'page_name'        AS page,
             payload->>'instance_id'      AS inst,
             payload->>'cookie_uid'       AS cookie_uid
        FROM pulse_presence_events
       WHERE source IN ('ext', 'resolver')
         AND machine = ANY(${keys}::text[])
         AND ts >= ${lo}::timestamptz AND ts <= ${hi}::timestamptz
       ORDER BY ts DESC, id DESC
       LIMIT ${OCCUPANCY_ROW_LIMIT}::int
    ),
    flips AS (
      SELECT id FROM (
        SELECT id, (focus = 'true') AS f,
               LAG(focus = 'true') OVER (PARTITION BY machine, uid ORDER BY ts, id) AS prev_f
          FROM base
         WHERE source = 'ext' AND event <> 'logout'
      ) s
      WHERE prev_f IS DISTINCT FROM f
    )
    SELECT id, source, machine, event, ts, uid, dn, enc, rx, focus, reason, page, inst, cookie_uid
      FROM base
     WHERE event <> 'heartbeat' OR focus = 'true' OR id IN (SELECT id FROM flips)
     ORDER BY ts, id
  `) as unknown as PresenceEvent[];
  const events = await withLoginPollerRows(db, rows, A);

  const byMachine = new Map<string, NEvent[]>();
  const extMachines = new Set<string>(); // poller rows alone never make a machine appear
  for (const e of events) {
    const n = normalizeEvent(e);
    if (!n) continue;
    if (n.source !== "poller") extMachines.add(n.machine);
    const list = byMachine.get(n.machine);
    if (list) list.push(n);
    else byMachine.set(n.machine, [n]);
  }
  const out: ScopedOccupancy[] = [];
  for (const machine of [...extMachines].sort()) {
    const es = (byMachine.get(machine) ?? []).sort(byTimeThenId);
    const occ = es.length ? occupancyAt(es, A, opts) : null;
    const occupied = (occ?.n_present ?? 0) > 0 || occ?.best != null;
    const staleBest = occ?.stale ?? null;
    out.push({
      machine,
      occupied,
      ambiguous: occ?.ambiguous ?? false,
      stale_occupant: staleBest ? { page_name: staleBest.page_name ?? null, cookie_name: staleBest.cookie_name ?? null, label: staleOccupantLabel(staleBest) } : null,
      pending: occ?.pending ?? null,
      page_name: occ?.page_name ?? null,
      best_uid: occ?.best?.uid ?? null,
      best_dn: occ?.best?.dn ?? null,
      best_stale: !!occ?.best?.stale_cookie,
    });
  }
  return out;
}
