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
import { byTimeThenId, normalizeEvent, occupancyAt, STALE_UNKNOWN_NAME, type NEvent, type OccOptions, type PendingSession } from "./occupancy";
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
  /** the first name the Pulse page greets on this machine (extension 0.1.1), last 10 min; a witness, never an identity. null when unknown */
  page_name: string | null;
};

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t ? t : null;
};

/** Pure. `warehouse` = the machine's warehouse doctor (latest consult today) or null; `cookie` = the extension's resolved occupant or null. */
export function buildOccupantDisplay(warehouse: WarehouseDoctor | null, cookie: DoctorRef | null, pageName: string | null = null): OccupantDisplay | null {
  const pn = clean(pageName);
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
      page_name: pn,
    };
  }
  if (cu || cn) return { uid: cu, name: cn, source: "cookie", label: null, consult_at: null, cookie_uid: cu, cookie_name: cn, stale: false, page_name: pn };
  return null; // no identity at all: the caller shows MachineOccupancy.page_name ("page: <name>") on its own
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

/** The grey line for a pending login: "session: <name> (pending, no console activity)". The reason field says whether identity_stale also fired. */
export const pendingLabel = (p: PendingSession | null | undefined): string =>
  p ? `session: ${clean(p.display_name) ?? "unknown"} (pending, no console activity)` : "";

/**
 * The grey line for a stale-cookie occupant: presence came from a login the extension itself flagged identity_stale, promoted by activity. The identity is the
 * page's greeting; the cookie doctor is named only as the stale witness. "page: <page_name> (cookie <cookie_name> stale)"; no page_name -> "unknown (stale cookie)".
 */
export const staleOccupantLabel = (s: { page_name?: string | null; cookie_name?: string | null } | null | undefined): string => {
  if (!s) return "";
  const page = clean(s.page_name);
  if (!page) return STALE_UNKNOWN_NAME;
  const cookie = clean(s.cookie_name);
  return cookie ? `page: ${page} (cookie ${cookie} stale)` : `page: ${page} (stale cookie)`;
};

export type StaleOccupant = { page_name: string | null; cookie_name: string | null; label: string };

export type MachineOccupancy = {
  machine: string;
  room_id: string | null;
  /** at least one extension stream is present */
  occupied: boolean;
  /** two focused streams the resolver could not separate: no single cookie occupant */
  ambiguous: boolean;
  occupant_rule: string | null;
  /** the extension's resolved occupant (null when none, ambiguous, or the occupant is a stale-cookie stream: see stale_occupant) */
  cookie_uid: string | null;
  cookie_name: string | null;
  /**
   * Set when the only presence is a stale-cookie stream (a login flagged identity_stale, promoted by activity): the page greeting stands in for the identity.
   * The cookie doctor is never cookie_uid/cookie_name and never an occupant; uid is always null here.
   */
  stale_occupant: StaleOccupant | null;
  /** the machine's warehouse doctor today (latest warehouse consult, any age; null when none today) */
  consulting: ConsultingDoctor | null;
  occupant_display: OccupantDisplay | null;
  /** first name the Pulse page greets on this machine in the last 10 min (extension 0.1.1); a witness, never an identity */
  page_name: string | null;
  /** distinct extension installs (Chrome profiles) reporting on the machine in the last 10 min; > 1 is informational, never an alert */
  instances: number;
  /**
   * A login the resolver did NOT treat as presence (no console activity at the Mac, or an identity_stale in the same seconds); it stays pending until activity
   * promotes it, a logout, a replacing login, or the nightly cutoff. Not present, not counted for windows; show it in grey (pendingLabel). null when none.
   */
  pending: PendingSession | null;
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
  const extMachines = new Set<string>(); // machines with an extension/resolver row; poller rows alone never make a machine appear
  for (const e of events) {
    const n = normalizeEvent(e);
    if (!n) continue;
    if (n.source !== "poller") extMachines.add(n.machine);
    const list = byMachine.get(n.machine);
    if (list) list.push(n);
    else byMachine.set(n.machine, [n]);
  }
  const names = new Set<string>([...extMachines, ...doctors.keys()]);
  const out: MachineOccupancy[] = [];
  for (const machine of [...names].sort()) {
    const es = (byMachine.get(machine) ?? []).sort(byTimeThenId);
    const occ = es.length ? occupancyAt(es, A, opts) : null;
    const occupied = (occ?.n_present ?? 0) > 0 || occ?.best != null; // a page-name stream alone is not a counted doctor but does occupy the room
    const consulting = doctors.get(machine) ?? null;
    const staleBest = occ?.stale ?? null; // the page-name stream, as the occupant or beside the real one (F11)
    const cookie: DoctorRef | null = occ?.best && !occ.best.stale_cookie ? { uid: occ.best.uid, name: occ.best.dn } : null;
    const stale_occupant: StaleOccupant | null = staleBest
      ? { page_name: staleBest.page_name ?? null, cookie_name: staleBest.cookie_name ?? null, label: staleOccupantLabel(staleBest) }
      : null;
    const shown = consulting && (occupied || consulting.live) ? consulting : null;
    out.push({
      machine,
      room_id: crosswalk.get(normalizeHostname(machine))?.room_id ?? null,
      occupied,
      ambiguous: occ?.ambiguous ?? false,
      occupant_rule: occ?.rule ?? null,
      cookie_uid: cookie?.uid ?? null,
      cookie_name: cookie?.name ?? null,
      stale_occupant,
      consulting,
      occupant_display: buildOccupantDisplay(shown, cookie, occ?.page_name ?? null),
      page_name: occ?.page_name ?? null,
      instances: occ?.instances ?? 0,
      pending: occ?.pending ?? null,
    });
  }
  return out;
}
