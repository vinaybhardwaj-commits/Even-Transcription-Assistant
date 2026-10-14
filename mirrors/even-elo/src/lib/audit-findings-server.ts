/**
 * src/lib/audit-findings-server.ts — loads the governance views of routed threads (Round 2 / F3).
 * Server only: CDMSS calls (GOV_API_KEY) and the local physician lookup. The pure shaping is in
 * audit-findings.ts.
 */

import { sql } from "@/lib/db";
import {
  describeEvents,
  parseInstance,
  rowsFromRoster,
  toFindingRow,
  type DoctorLookup,
  type FindingRow,
  type Instance,
  type SyncFlag,
  type TimelineEntry,
} from "@/lib/audit-findings";
import { fetchAuditSignal, fetchRosterAudits, upstreamError, type CatOutcome } from "@/lib/cdmss-governance";

interface PhysicianLink {
  id: string;
  full_name: string;
  cdmss_doctor_uid: string | null;
  cdmss_alias_uids: string[] | null;
}

/** CDMSS uid (canonical and alias) -> local physician, for every linked physician. */
export async function loadDoctorLookup(): Promise<DoctorLookup> {
  const byUid = new Map<string, { physician_id: string; full_name: string }>();
  try {
    const rows = (await sql`
      SELECT id::text AS id, full_name, cdmss_doctor_uid, cdmss_alias_uids
      FROM physicians WHERE cdmss_doctor_uid IS NOT NULL`) as unknown as PhysicianLink[];
    for (const r of rows) {
      const entry = { physician_id: r.id, full_name: r.full_name };
      if (r.cdmss_doctor_uid) byUid.set(r.cdmss_doctor_uid, entry);
      for (const a of r.cdmss_alias_uids ?? []) if (!byUid.has(a)) byUid.set(a, entry);
    }
  } catch {
    // Names fall back to what CDMSS sends; the worklist still works.
  }
  return { byUid };
}

interface SyncRow {
  reference: string | null;
  state: string | null;
  permanent: boolean | null;
  attempts: number | null;
}

/**
 * Threads whose doctor answer has not reached CDMSS: document_audit_findings.cdmss_sync_state is
 * 'failed', or still 'pending' (the inline attempt did not finish and the nightly retry has not run).
 * Keyed by CDMSS thread reference. Best effort: if the sync columns are not there yet (migration 038
 * unapplied) or the read fails, the worklist simply shows no badges.
 */
export async function loadSyncFlags(): Promise<Map<string, SyncFlag>> {
  const out = new Map<string, SyncFlag>();
  try {
    const rows = (await sql`
      SELECT btrim(signal_reference) AS reference,
             cdmss_sync_state AS state,
             coalesce(cdmss_sync_permanent, false) AS permanent,
             coalesce(cdmss_sync_attempts, 0)::int AS attempts
      FROM document_audit_findings
      WHERE coalesce(btrim(signal_reference), '') <> ''
        AND doctor_response_verb IS NOT NULL
        AND cdmss_sync_state IN ('pending', 'failed')`) as unknown as SyncRow[];
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r.reference || (r.state !== "pending" && r.state !== "failed")) continue;
      const flag: SyncFlag = { state: r.state, permanent: r.permanent === true, attempts: Number(r.attempts) || 0 };
      const have = out.get(r.reference);
      // A failure outranks a pending row for the same thread.
      if (!have || (have.state === "pending" && flag.state === "failed")) out.set(r.reference, flag);
    }
  } catch {
    // No badges rather than no worklist.
  }
  return out;
}

export type LoadFailure = { kind: "unavailable" } | { kind: "upstream"; status: number; message: string };

export type RosterLoad = { ok: true; rows: FindingRow[] } | { ok: false; failure: LoadFailure };

function failureOf(o: CatOutcome): LoadFailure {
  if (o.kind === "transport") return { kind: "unavailable" };
  return { kind: "upstream", status: o.status, message: upstreamError(o.body) };
}

/** Every routed thread across doctors. */
export async function loadWorklistRows(): Promise<RosterLoad> {
  const [outcome, lookup] = await Promise.all([fetchRosterAudits(), loadDoctorLookup()]);
  if (outcome.kind !== "http" || outcome.status !== 200 || (outcome.body as { ok?: boolean } | null)?.ok === false) {
    return { ok: false, failure: failureOf(outcome) };
  }
  return { ok: true, rows: rowsFromRoster(outcome.body, lookup) };
}

/** One physician's threads: the canonical uid plus every alias uid, merged and de-duplicated. */
export async function loadPhysicianRows(physicianId: string): Promise<
  | { ok: true; mapped: false; rows: [] }
  | { ok: true; mapped: true; rows: FindingRow[] }
  | { ok: false; failure: LoadFailure }
> {
  let uids: string[] = [];
  let name = "";
  try {
    const rows = (await sql`
      SELECT full_name, cdmss_doctor_uid, cdmss_alias_uids FROM physicians WHERE id = ${physicianId}::uuid`) as unknown as Array<{
      full_name: string;
      cdmss_doctor_uid: string | null;
      cdmss_alias_uids: string[] | null;
    }>;
    const r = rows[0];
    if (r?.cdmss_doctor_uid) uids = [r.cdmss_doctor_uid, ...(r.cdmss_alias_uids ?? [])];
    name = r?.full_name ?? "";
  } catch {
    return { ok: false, failure: { kind: "unavailable" } };
  }
  uids = Array.from(new Set(uids.filter(Boolean)));
  if (uids.length === 0) return { ok: true, mapped: false, rows: [] };

  const lookup: DoctorLookup = {
    byUid: new Map(uids.map((u) => [u, { physician_id: physicianId, full_name: name }])),
  };
  const outcomes = await Promise.all(uids.map((u) => fetchRosterAudits({ doctorUid: u })));
  const merged: FindingRow[] = [];
  const seen = new Set<string>();
  for (const o of outcomes) {
    if (o.kind !== "http" || o.status !== 200 || (o.body as { ok?: boolean } | null)?.ok === false) {
      return { ok: false, failure: failureOf(o) };
    }
    for (const row of rowsFromRoster(o.body, lookup)) {
      if (seen.has(row.reference)) continue;
      seen.add(row.reference);
      merged.push(row);
    }
  }
  return { ok: true, mapped: true, rows: merged };
}

export interface ThreadDetail {
  row: FindingRow;
  instances: Instance[];
  timeline: TimelineEntry[];
}

export type ThreadLoad =
  | { ok: true; detail: ThreadDetail }
  | { ok: false; notFound: true }
  | { ok: false; notFound?: false; failure: LoadFailure };

export async function loadThread(reference: string): Promise<ThreadLoad> {
  const [outcome, lookup] = await Promise.all([fetchAuditSignal(reference), loadDoctorLookup()]);
  if (outcome.kind === "http" && outcome.status === 404) return { ok: false, notFound: true };
  if (outcome.kind !== "http" || outcome.status !== 200) return { ok: false, failure: failureOf(outcome) };
  const body = (outcome.body ?? {}) as { ok?: boolean; signal?: unknown; instances?: unknown; events?: unknown };
  if (body.ok === false) return { ok: false, failure: failureOf(outcome) };
  const row = toFindingRow(body.signal, lookup);
  if (!row) return { ok: false, failure: { kind: "upstream", status: 200, message: "thread missing from CDMSS answer" } };
  const instances = (Array.isArray(body.instances) ? body.instances : [])
    .map(parseInstance)
    .filter((i): i is Instance => !!i);
  // The representative can sit apart from instances[]; show it when the list is empty.
  if (instances.length === 0) {
    const rep = parseInstance((body.signal as { representative?: unknown } | null)?.representative);
    if (rep) instances.push(rep);
  }
  return { ok: true, detail: { row, instances, timeline: describeEvents(body.events, row.doctor_name) } };
}
