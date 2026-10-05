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
 *   consultingDoctorForMachine(db, machine, asOf)  the warehouse doctor of the machine's MOST RECENT consult whose t_open is within
 *                                                  WAREHOUSE_WINDOW_MIN (90) minutes of asOf, or that is still unclosed (t_close null, t_open
 *                                                  within UNCLOSED_MAX_H of asOf). "Most recent" is decided over ALL sources first: an older
 *                                                  warehouse doctor never shows through a newer consult the warehouse has not answered yet.
 *   buildOccupantDisplay(warehouse, cookie)        pure: {uid, name, source, cookie_uid, cookie_name, stale}. source 'warehouse' when there is a
 *                                                  warehouse doctor, else 'cookie' when the extension names someone, else null.
 *                                                  stale = a cookie identity is present and differs (by uid) from the warehouse doctor.
 *   machineOccupancy(db, asOf)                     one row per machine: the extension's resolved occupant (occupancyAt, unchanged) plus the display.
 */
import { fetchEvents, loadCrosswalk, type WindowsDb } from "./db";
import { byTimeThenId, normalizeEvent, occupancyAt, type NEvent, type OccOptions } from "./occupancy";
import { normalizeHostname, type PresenceEvent } from "./types";

/** A consult counts for display when it opened this recently (minutes), or is still unclosed. */
export const WAREHOUSE_WINDOW_MIN = 90;
/** An unclosed window older than this is a resolver leftover, not a live consult (the resolver caps a consult at 90 min). */
export const UNCLOSED_MAX_H = 4;

export type DoctorRef = { uid: string | null; name: string | null };
export type ConsultingDoctor = { uid: string; name: string | null; t_open: string; t_close: string | null; consult_key: string };

export type OccupantDisplay = {
  uid: string | null;
  name: string | null;
  source: "warehouse" | "cookie";
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

/** Pure. `warehouse` = the consulting doctor (source 'warehouse') or null; `cookie` = the extension's resolved occupant or null. */
export function buildOccupantDisplay(warehouse: DoctorRef | null, cookie: DoctorRef | null): OccupantDisplay | null {
  const cu = clean(cookie?.uid);
  const cn = clean(cookie?.name);
  const wu = clean(warehouse?.uid);
  if (wu) {
    return { uid: wu, name: clean(warehouse?.name), source: "warehouse", cookie_uid: cu, cookie_name: cn, stale: cu !== null && cu !== wu };
  }
  if (cu || cn) return { uid: cu, name: cn, source: "cookie", cookie_uid: cu, cookie_name: cn, stale: false };
  return null;
}

type WindowDocRow = {
  machine: string;
  consult_key: string;
  t_open: unknown;
  t_close: unknown;
  consulting_doctor_uid: string | null;
  consulting_doctor_name: string | null;
  attribution_source: string | null;
};

const iso = (x: unknown): string => new Date(x as string | number | Date).toISOString();

/**
 * The most recent consult per machine (any source) within the display window, kept only when its attribution_source is 'warehouse' and it
 * names a doctor. `machine` null = every machine. One query either way.
 */
async function loadConsultingDoctors(db: WindowsDb, asOf: Date, machine: string | null): Promise<Map<string, ConsultingDoctor>> {
  const at = asOf.toISOString();
  const rows = (await db`
    SELECT DISTINCT ON (w.machine) w.machine, w.consult_key, w.t_open, w.t_close,
           w.consulting_doctor_uid, w.consulting_doctor_name, w.attribution_source
      FROM eta_encounter_windows w
     WHERE (${machine}::text IS NULL OR w.machine = ${machine}::text)
       AND w.t_open <= ${at}::timestamptz
       AND (w.t_open >= ${at}::timestamptz - (${WAREHOUSE_WINDOW_MIN}::int * interval '1 minute')
            OR (w.t_close IS NULL AND w.t_open >= ${at}::timestamptz - (${UNCLOSED_MAX_H}::int * interval '1 hour')))
     ORDER BY w.machine, w.t_open DESC, w.consult_key DESC
  `) as unknown as WindowDocRow[];
  const out = new Map<string, ConsultingDoctor>();
  for (const r of rows) {
    if (r.attribution_source !== "warehouse" || !r.consulting_doctor_uid) continue;
    out.set(r.machine, {
      uid: r.consulting_doctor_uid,
      name: r.consulting_doctor_name,
      t_open: iso(r.t_open),
      t_close: r.t_close == null ? null : iso(r.t_close),
      consult_key: r.consult_key,
    });
  }
  return out;
}

/** The warehouse doctor of the machine's most recent consult near `asOf` (see the file header), or null. */
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
  /** the warehouse consulting doctor near asOf (null when none) */
  consulting: ConsultingDoctor | null;
  occupant_display: OccupantDisplay | null;
};

/**
 * One row per machine that has extension events or a warehouse-attributed consult near asOf. The cookie side is occupancyAt() exactly as the
 * window resolver uses it; the warehouse side is loadConsultingDoctors(). Read-only.
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
    const consulting = doctors.get(machine) ?? null;
    const cookie: DoctorRef | null = occ?.best ? { uid: occ.best.uid, name: occ.best.dn } : null;
    out.push({
      machine,
      room_id: crosswalk.get(normalizeHostname(machine))?.room_id ?? null,
      occupied: (occ?.n_present ?? 0) > 0,
      ambiguous: occ?.ambiguous ?? false,
      occupant_rule: occ?.rule ?? null,
      cookie_uid: cookie?.uid ?? null,
      cookie_name: cookie?.name ?? null,
      consulting,
      occupant_display: buildOccupantDisplay(consulting, cookie),
    });
  }
  return out;
}
