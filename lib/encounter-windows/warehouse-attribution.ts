/**
 * lib/encounter-windows/warehouse-attribution.ts — who the doctor REALLY was, from Pulse's own consult record.
 *
 * eta_encounter_windows.doctor_uid / display_name are the doctor the Pulse extension saw logged in on the machine;
 * measured 5 Oct 2026 that disagrees with Pulse for 77 of 162 consults. The Even warehouse (Metabase db 13) holds the
 * consult record Pulse itself writes at startConsult: table "individuals-prescriptions" (consult_uid = our consult_uid,
 * uid = our prescription_ref, doctor_uid, _create_time; sometimes two rows per consult, the earliest is the start) and
 * table doctors (uid, name_with_prefix). This module reads it and fills the 0124 columns:
 *
 *   warehouse_doctor_uid / _name / _prescription_uid / _checked_at   what the warehouse said
 *   consulting_doctor_uid / _name, attribution_source                 the doctor to REPORT: warehouse > extension > none
 *   doctor_mismatch                                                   both sources name a doctor and they differ
 *
 * It NEVER writes doctor_uid, display_name or attribution: the extension's view stays as the resolver computed it.
 *
 * WORK QUEUE. A row is looked up when it has a consult_uid or prescription_ref, t_open is inside the window, and it has
 * never been checked, or was checked without an answer more than 10 minutes ago and fewer than MAX_UNRESOLVED_CHECKS (12)
 * times (Pulse writes the record within 60 s of startConsult, but a sync can lag). A row that was answered is not looked up
 * again; a row that used up its 12 unresolved checks is final (it keeps reading extension/none). A lookup that finds nothing still
 * stamps warehouse_checked_at, so the queue drains and the retry is paced.
 *
 * Neon HTTP: tagged templates only, every value bound, no sql.unsafe(), timestamps come back as strings. The ONLY values
 * inlined are uids that passed isSafeUid, into the Metabase query text (Metabase takes no bound parameters).
 */
import { isSafeUid, metabaseQuery, uidListLiteral } from "@/lib/metabase";
import type { WindowsDb } from "./db";
import type { AttributionSource } from "./types";

/** A row waiting for its warehouse lookup. */
export type Candidate = {
  consult_key: string;
  consult_uid: string | null;
  prescription_ref: string | null;
  machine: string;
  room_slug: string | null;
  doctor_uid: string | null;
  display_name: string | null;
};

/** One warehouse row, as the query returns it. */
export type WarehouseRow = {
  consult_uid: string | null;
  prescription_uid: string | null;
  doctor_uid: string | null;
  doctor_name: string | null;
  created_at: string | null;
};

export type Decision = {
  warehouse_doctor_uid: string | null;
  warehouse_doctor_name: string | null;
  warehouse_prescription_uid: string | null;
  consulting_doctor_uid: string | null;
  consulting_doctor_name: string | null;
  attribution_source: AttributionSource;
  doctor_mismatch: boolean;
};

/** Unresolved lookups after which a consult is no longer retried (migration 0124, warehouse_attempts). */
export const MAX_UNRESOLVED_CHECKS = 12;

export type WarehouseSummary = {
  /** rows the queue handed over */
  candidates: number;
  /** rows written (stamped warehouse_checked_at) */
  checked: number;
  resolved: number;
  unresolved: number;
  mismatches: number;
  /** candidates not written because the extension doctor changed under us (a refresh); they stay queued */
  raced: number;
  /** candidates not looked up because the deadline came first; they stay queued */
  deferred: number;
  /** rows written unresolved for the MAX_UNRESOLVED_CHECKS-th time: final, never retried */
  gave_up: number;
};

export type QueryFn = (sqlText: string) => Promise<Array<Record<string, unknown>>>;

export type AttributeOptions = {
  /** Look back this many hours from now by t_open. Default 36. */
  hours?: number;
  /** Max candidate rows per call. Default 500. */
  limit?: number;
  /** Candidate rows per Metabase query. Default 200 (the endpoint returns ~2000 rows at most; two per consult). */
  chunkSize?: number;
  /** Do not START any Metabase chunk after this epoch ms (the first one included: a late start defers the whole queue). */
  deadlineMs?: number;
  /** Injected in tests; defaults to the real Metabase client. */
  query?: QueryFn;
};

const RECHECK_MINUTES = 10;
const WAREHOUSE_ROW_CAP = 2000;

/** The Metabase SQL for one chunk. Pure. Throws when there is nothing safe to look up. */
export function warehouseQuerySql(consultUids: readonly string[], prescriptionRefs: readonly string[]): string {
  const conds: string[] = [];
  if (consultUids.length) conds.push(`p.consult_uid IN (${uidListLiteral(consultUids)})`);
  if (prescriptionRefs.length) conds.push(`p.uid IN (${uidListLiteral(prescriptionRefs)})`);
  if (conds.length === 0) throw new Error("warehouseQuerySql: nothing to look up");
  return (
    `SELECT p.consult_uid AS consult_uid, p.uid AS prescription_uid, p.doctor_uid AS doctor_uid, ` +
    `d.name_with_prefix AS doctor_name, p._create_time AS created_at ` +
    `FROM "individuals-prescriptions" p LEFT JOIN doctors d ON d.uid = p.doctor_uid ` +
    `WHERE ${conds.join(" OR ")} ORDER BY p._create_time ASC LIMIT ${WAREHOUSE_ROW_CAP}`
  );
}

const str = (v: unknown): string | null => (v == null ? null : String(v) || null);
const ms = (v: string | null): number => {
  const t = v === null ? NaN : Date.parse(v);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

export const toWarehouseRow = (r: Record<string, unknown>): WarehouseRow => ({
  consult_uid: str(r.consult_uid),
  prescription_uid: str(r.prescription_uid),
  doctor_uid: str(r.doctor_uid),
  doctor_name: str(r.doctor_name)?.trim() || null,
  created_at: str(r.created_at),
});

/**
 * The warehouse row for a consult: the EARLIEST (_create_time) row with consult_uid = the consult's, else, when there is
 * none, the earliest with uid = the consult's prescription_ref. Among the matches the earliest one that names a doctor
 * wins; if none names a doctor the earliest is returned (its prescription uid is still worth keeping). Pure.
 */
export function pickWarehouseRow(c: Pick<Candidate, "consult_uid" | "prescription_ref">, rows: readonly WarehouseRow[]): WarehouseRow | null {
  let pool = c.consult_uid ? rows.filter((r) => r.consult_uid === c.consult_uid) : [];
  if (pool.length === 0 && c.prescription_ref) pool = rows.filter((r) => r.prescription_uid === c.prescription_ref);
  if (pool.length === 0) return null;
  const sorted = pool.map((r, i) => ({ r, i })).sort((a, b) => ms(a.r.created_at) - ms(b.r.created_at) || a.i - b.i).map((x) => x.r);
  return sorted.find((r) => isSafeUid(r.doctor_uid)) ?? sorted[0]!;
}

/**
 * THE PRECEDENCE RULE (migration 0124), pure. warehouse > extension > none. The extension's own fields are inputs only;
 * nothing here (or in the UPDATE that applies it) writes them back.
 */
export function decideAttribution(c: Pick<Candidate, "doctor_uid" | "display_name">, wh: WarehouseRow | null): Decision {
  const whUid = wh && isSafeUid(wh.doctor_uid) ? wh.doctor_uid : null;
  const whName = whUid ? wh!.doctor_name : null;
  const base = {
    warehouse_doctor_uid: whUid,
    warehouse_doctor_name: whName,
    warehouse_prescription_uid: wh?.prescription_uid ?? null,
  };
  if (whUid) {
    const sameAsExtension = c.doctor_uid === whUid;
    return {
      ...base,
      consulting_doctor_uid: whUid,
      consulting_doctor_name: whName ?? (sameAsExtension ? c.display_name : null),
      attribution_source: "warehouse",
      doctor_mismatch: c.doctor_uid != null && !sameAsExtension,
    };
  }
  if (c.doctor_uid != null) {
    return { ...base, consulting_doctor_uid: c.doctor_uid, consulting_doctor_name: c.display_name, attribution_source: "extension", doctor_mismatch: false };
  }
  return { ...base, consulting_doctor_uid: null, consulting_doctor_name: null, attribution_source: "none", doctor_mismatch: false };
}

async function loadCandidates(db: WindowsDb, hours: number, limit: number): Promise<Candidate[]> {
  const rows = (await db`
    SELECT consult_key, consult_uid, prescription_ref, machine, room_slug, doctor_uid, display_name
      FROM eta_encounter_windows
     WHERE (consult_uid IS NOT NULL OR prescription_ref IS NOT NULL)
       AND t_open >= now() - make_interval(hours => ${hours}::int)
       AND (warehouse_checked_at IS NULL
            OR (warehouse_doctor_uid IS NULL AND warehouse_attempts < ${MAX_UNRESOLVED_CHECKS}::int
                AND warehouse_checked_at < now() - make_interval(mins => ${RECHECK_MINUTES}::int)))
     ORDER BY t_open DESC, id DESC
     LIMIT ${limit}
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    consult_key: String(r.consult_key),
    consult_uid: (r.consult_uid as string | null) ?? null,
    prescription_ref: (r.prescription_ref as string | null) ?? null,
    machine: String(r.machine),
    room_slug: (r.room_slug as string | null) ?? null,
    doctor_uid: (r.doctor_uid as string | null) ?? null,
    display_name: (r.display_name as string | null) ?? null,
  }));
}

/**
 * Write the decisions. The extension doctor read at queue time rides along as ext_uid and the UPDATE is skipped for a
 * row whose doctor_uid moved since (a window refresh landed between the read and this write): its mismatch flag would be
 * stale. That row keeps warehouse_checked_at NULL (or old) and is picked up again by the next run.
 */
async function writeDecisions(db: WindowsDb, items: Array<{ c: Candidate; d: Decision }>) {
  const payload = items.map(({ c, d }) => ({ consult_key: c.consult_key, ext_uid: c.doctor_uid, ...d }));
  return (await db`
    UPDATE eta_encounter_windows w SET
        warehouse_doctor_uid       = r.warehouse_doctor_uid,
        warehouse_doctor_name      = r.warehouse_doctor_name,
        warehouse_prescription_uid = r.warehouse_prescription_uid,
        warehouse_checked_at       = now(),
        warehouse_attempts         = w.warehouse_attempts + CASE WHEN r.warehouse_doctor_uid IS NULL THEN 1 ELSE 0 END,
        consulting_doctor_uid      = r.consulting_doctor_uid,
        consulting_doctor_name     = r.consulting_doctor_name,
        attribution_source         = r.attribution_source,
        doctor_mismatch            = r.doctor_mismatch
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS r(
        consult_key text, ext_uid text, warehouse_doctor_uid text, warehouse_doctor_name text, warehouse_prescription_uid text,
        consulting_doctor_uid text, consulting_doctor_name text, attribution_source text, doctor_mismatch boolean)
     WHERE w.consult_key = r.consult_key
       AND w.doctor_uid IS NOT DISTINCT FROM r.ext_uid
    RETURNING w.consult_key, w.machine, w.room_slug, w.consult_uid, w.doctor_uid, w.display_name,
              w.warehouse_doctor_uid, w.warehouse_doctor_name, w.doctor_mismatch, w.warehouse_attempts
  `) as unknown as Array<Record<string, unknown>>;
}

/** Look the queued consults up in the warehouse and write the 0124 columns. See the file header. */
export async function attributeFromWarehouse(db: WindowsDb, opts: AttributeOptions = {}): Promise<WarehouseSummary> {
  const hours = Math.min(Math.max(Math.trunc(opts.hours ?? 36), 1), 720);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 500), 1), 2000);
  const chunkSize = Math.min(Math.max(Math.trunc(opts.chunkSize ?? 200), 1), 500);
  const query = opts.query ?? metabaseQuery;
  const out: WarehouseSummary = { candidates: 0, checked: 0, resolved: 0, unresolved: 0, mismatches: 0, raced: 0, deferred: 0, gave_up: 0 };

  const queue = await loadCandidates(db, hours, limit);
  out.candidates = queue.length;
  for (let at = 0; at < queue.length; at += chunkSize) {
    const chunk = queue.slice(at, at + chunkSize);
    // EVERY chunk is gated on the deadline, the first too: a Metabase call may run 25 s, so the caller's budget plus that timeout must fit the function ceiling.
    if (opts.deadlineMs !== undefined && Date.now() > opts.deadlineMs) {
      out.deferred = queue.length - at;
      break;
    }
    const consultUids = chunk.map((c) => c.consult_uid).filter(isSafeUid);
    const rxRefs = chunk.map((c) => c.prescription_ref).filter(isSafeUid);
    // An unsafe or empty uid can never match: those rows are still stamped (unresolved) so they leave the queue and are retried on the 10-minute pace.
    const found = consultUids.length || rxRefs.length ? (await query(warehouseQuerySql(consultUids, rxRefs))).map(toWarehouseRow) : [];
    const items = chunk.map((c) => ({ c, d: decideAttribution(c, pickWarehouseRow(c, found)) }));
    const written = await writeDecisions(db, items);
    out.raced += chunk.length - written.length;
    for (const w of written) {
      out.checked++;
      if (w.warehouse_doctor_uid != null) out.resolved++;
      else {
        out.unresolved++;
        if (Number(w.warehouse_attempts) >= MAX_UNRESOLVED_CHECKS) out.gave_up++;
      }
      if (w.doctor_mismatch === true) {
        out.mismatches++;
        console.info(
          `[warehouse-attribution] mismatch room=${String(w.room_slug ?? w.machine)} consult_uid=${String(w.consult_uid)} ` +
            `extension=${String(w.doctor_uid)}(${String(w.display_name ?? "?")}) warehouse=${String(w.warehouse_doctor_uid)}(${String(w.warehouse_doctor_name ?? "?")})`,
        );
      }
    }
  }
  return out;
}
