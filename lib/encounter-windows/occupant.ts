/**
 * lib/encounter-windows/occupant.ts — WHO IS IN THE ROOM, for display: the warehouse consulting doctor over the extension's cookie identity.
 *
 * WHY (proven 5 Oct 2026). The extension's doctor_uid comes from a Google `__session` cookie that Pulse never clears. A doctor who signs in by
 * phone OTP runs the page under a bearer the extension cannot see, so the extension keeps reporting the previous Google-login doctor (on 4 Oct
 * OPD 6 showed one doctor's login for 41 of another doctor's consults; on 5 Oct OPD 7 did the same). The warehouse doctor on
 * each consult (eta_encounter_windows.consulting_doctor_uid/_name with attribution_source = 'warehouse', refreshed every 2 minutes) is authoritative.
 *
 * This file changes WHAT IS SHOWN, never attribution: warehouse already wins in the stored rows (warehouse-attribution.ts) and nothing here writes.
 *
 * DISPLAY RULE (ruled 5 Oct 2026: the stale cookie name must never resurface once a warehouse doctor is known for the machine today)
 *   occupant   the warehouse doctor of the machine's LATEST warehouse-sourced consult in the current IST day (any age). The cookie identity
 *              is the occupant ONLY when the machine has no warehouse-attributed consult today.
 *   label      that consult is LIVE (t_open within WAREHOUSE_WINDOW_MIN = 90 min of asOf, or unclosed with t_open within UNCLOSED_MAX_H = 4 h)
 *              -> "consulting"; otherwise "last consult" (consult_at = its t_open). The 90-min / 4-h window decides ONLY this label.
 *   shown      machineOccupancy shows the warehouse doctor while the machine's extension stream is present OR the consult is live; a machine
 *              that is logged out with no live consult shows nothing (a stale warehouse doctor is not an occupant of an empty room).
 *   stale      a cookie identity is present and differs (by uid) from the warehouse doctor. The cookie is always carried (cookie_uid/_name) so
 *              the caller can show it dimmed as "session: <name>", marked stale.
 *
 *   consultingDoctorForMachine(db, machine, asOf)  the machine's warehouse doctor under that rule, or null.
 *   buildOccupantDisplay(warehouse, cookie)        pure: {uid, name, source, label, consult_at, cookie_uid, cookie_name, stale}.
 *   machineOccupancy(db, asOf)                     one row per machine: the extension's resolved occupant (occupancyAt, unchanged) plus the display.
 */
import { fetchEvents, istMidnightAtOrBefore, loadCrosswalk, type WindowsDb } from "./db";
import { byTimeThenId, normalizeEvent, occupancyAt, type NEvent, type OccOptions } from "./occupancy";
import { normalizeHostname, type PresenceEvent } from "./types";

/** A consult is LIVE (label "consulting") when it opened this recently (minutes), or is still unclosed. */
export const WAREHOUSE_WINDOW_MIN = 90;
/** An unclosed window older than this is a resolver leftover, not a live consult (the resolver caps a consult at 90 min). */
export const UNCLOSED_MAX_H = 4;

export type DoctorRef = { uid: string | null; name: string | null };
export type ConsultingDoctor = {
  uid: string;
  name: string | null;
  /** the LATEST warehouse-sourced consult today */
  t_open: string;
  t_close: string | null;
  consult_key: string;
  /** that consult is inside the 90-min / 4-h window: label "consulting" rather than "last consult" */
  live: boolean;
};
/** What buildOccupantDisplay needs from the warehouse side. */
export type WarehouseDoctor = DoctorRef & { live?: boolean; t_open?: string | null };

export type OccupantDisplay = {
  uid: string | null;
  name: string | null;
  source: "warehouse" | "cookie";
  /** warehouse source only: "consulting" (live consult) or "last consult" (older today); null for the cookie source */
  label: "consulting" | "last consult" | null;
  /** warehouse source only: t_open of the consult the doctor comes from */
  consult_at: string | null;
  /** the extension's (cookie) identity on the machine, whether or not it agrees */
  cookie_uid: string | null;
  cookie_name: string | null;
  /** a cookie identity is present and differs from the warehouse doctor */
  stale: boolean;
};

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t ? t : null;
};

/** Pure. `warehouse` = the machine's warehouse doctor (latest consult today) or null; `cookie` = the extension's resolved occupant or null. */
export function buildOccupantDisplay(warehouse: WarehouseDoctor | null, cookie: DoctorRef | null): OccupantDisplay | null {
  const cu = clean(cookie?.uid);
  const cn = clean(cookie?.name);
  const wu = clean(warehouse?.uid);
  if (wu) {
    return {
      uid: wu,
      name: clean(warehouse?.name),
      source: "warehouse",
      label: warehouse?.live === false ? "last consult" : "consulting",
      consult_at: warehouse?.t_open ?? null,
      cookie_uid: cu,
      cookie_name: cn,
      stale: cu !== null && cu !== wu,
    };
  }
  if (cu || cn) return { uid: cu, name: cn, source: "cookie", label: null, consult_at: null, cookie_uid: cu, cookie_name: cn, stale: false };
  return null;
}

type WindowDocRow = {
  machine: string;
  consult_key: string;
  t_open: unknown;
  t_close: unknown;
  consulting_doctor_uid: string | null;
  consulting_doctor_name: string | null;
};

const iso = (x: unknown): string => new Date(x as string | number | Date).toISOString();

/**
 * The LATEST warehouse-sourced consult per machine in the IST day containing asOf (t_open from the IST midnight to asOf), any age.
 * `machine` null = every machine. One query either way; DISTINCT ON picks the newest per machine.
 */
async function loadConsultingDoctors(db: WindowsDb, asOf: Date, machine: string | null): Promise<Map<string, ConsultingDoctor>> {
  const at = asOf.toISOString();
  const dayStart = new Date(istMidnightAtOrBefore(asOf.getTime())).toISOString();
  const rows = (await db`
    SELECT DISTINCT ON (w.machine) w.machine, w.consult_key, w.t_open, w.t_close, w.consulting_doctor_uid, w.consulting_doctor_name
      FROM eta_encounter_windows w
     WHERE (${machine}::text IS NULL OR w.machine = ${machine}::text)
       AND w.attribution_source = 'warehouse' AND w.consulting_doctor_uid IS NOT NULL
       AND w.t_open >= ${dayStart}::timestamptz AND w.t_open <= ${at}::timestamptz
     ORDER BY w.machine, w.t_open DESC, w.consult_key DESC
  `) as unknown as WindowDocRow[];
  const A = asOf.getTime();
  const out = new Map<string, ConsultingDoctor>();
  for (const r of rows) {
    if (!r.consulting_doctor_uid) continue;
    const open = new Date(r.t_open as string | number | Date).getTime();
    const closed = r.t_close != null;
    out.set(r.machine, {
      uid: r.consulting_doctor_uid,
      name: r.consulting_doctor_name,
      t_open: iso(r.t_open),
      t_close: closed ? iso(r.t_close) : null,
      consult_key: r.consult_key,
      live: A - open <= WAREHOUSE_WINDOW_MIN * 60_000 || (!closed && A - open <= UNCLOSED_MAX_H * 3_600_000),
    });
  }
  return out;
}

/** The machine's warehouse doctor under the display rule (see the file header): latest warehouse consult today, any age; or null. */
export async function consultingDoctorForMachine(db: WindowsDb, machine: string, asOf: string | number | Date = Date.now()): Promise<ConsultingDoctor | null> {
  const m = normalizeHostname(machine);
  const at = new Date(asOf);
  if (!Number.isFinite(at.getTime())) throw new Error("consultingDoctorForMachine: bad asOf");
  return (await loadConsultingDoctors(db, at, m)).get(m) ?? null;
}

export type MachineOccupancy = {
  machine: string;
  room_id: string | null;
  /** at least one extension stream is present */
  occupied: boolean;
  /** two focused streams the resolver could not separate: no single cookie occupant */
  ambiguous: boolean;
  occupant_rule: string | null;
  /** the extension's resolved occupant (null when none or ambiguous) */
  cookie_uid: string | null;
  cookie_name: string | null;
  /** the machine's warehouse doctor today (latest warehouse consult, any age; null when none today) */
  consulting: ConsultingDoctor | null;
  occupant_display: OccupantDisplay | null;
};

/**
 * One row per machine that has extension events or a warehouse-attributed consult today. The cookie side is occupancyAt() exactly as the
 * window resolver uses it; the warehouse side is loadConsultingDoctors(). The warehouse doctor is shown while the extension stream is present
 * or the consult is live; otherwise the machine is empty and shows nothing. Read-only.
 */
export async function machineOccupancy(db: WindowsDb, asOf: string | number | Date = Date.now(), opts: OccOptions = {}): Promise<MachineOccupancy[]> {
  const at = new Date(asOf);
  const A = at.getTime();
  if (!Number.isFinite(A)) throw new Error("machineOccupancy: bad asOf");
  // fetchEvents reads from (IST midnight before `from`) - 24 h to `to` + 2 h, enough for the 45-min / nightly-cutoff rules.
  const [events, crosswalk, doctors] = await Promise.all([
    fetchEvents(db, new Date(A - 3_600_000), at) as Promise<PresenceEvent[]>,
    loadCrosswalk(db),
    loadConsultingDoctors(db, at, null),
  ]);
  const byMachine = new Map<string, NEvent[]>();
  for (const e of events) {
    const n = normalizeEvent(e);
    if (!n) continue;
    const list = byMachine.get(n.machine);
    if (list) list.push(n);
    else byMachine.set(n.machine, [n]);
  }
  const names = new Set<string>([...byMachine.keys(), ...doctors.keys()]);
  const out: MachineOccupancy[] = [];
  for (const machine of [...names].sort()) {
    const es = (byMachine.get(machine) ?? []).sort(byTimeThenId);
    const occ = es.length ? occupancyAt(es, A, opts) : null;
    const occupied = (occ?.n_present ?? 0) > 0;
    const consulting = doctors.get(machine) ?? null;
    const cookie: DoctorRef | null = occ?.best ? { uid: occ.best.uid, name: occ.best.dn } : null;
    const shown = consulting && (occupied || consulting.live) ? consulting : null;
    out.push({
      machine,
      room_id: crosswalk.get(normalizeHostname(machine))?.room_id ?? null,
      occupied,
      ambiguous: occ?.ambiguous ?? false,
      occupant_rule: occ?.rule ?? null,
      cookie_uid: cookie?.uid ?? null,
      cookie_name: cookie?.name ?? null,
      consulting,
      occupant_display: buildOccupantDisplay(shown, cookie),
    });
  }
  return out;
}
