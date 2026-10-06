/**
 * lib/steward/results.ts — apply 'steward.result' kiosk-health events to steward_tickets (part 1; records outcomes, acts on nothing).
 *
 * Event payload: { ticket_id: string, nonce: string, outcome: done|failed|rejected|expired|unsupported, detail?: string (<= 2 KB) }.
 * For each steward.result row (the event itself is already stored by the ingest route):
 *   1. payload invalid -> ignored. A detail over 2048 bytes is TRUNCATED to 2048 bytes (ending in "…"), never dropped; the outcome still applies.
 *   2. ONE statement does the rest: it inserts the nonce (ON CONFLICT DO NOTHING) only when a ticket with this ticket_id, machine and nonce exists in a
 *      non-terminal state, and updates that ticket (done for outcome done; failed otherwise, outcome kept in result) only when the nonce row was just inserted.
 *      Being one statement, a failed update rolls the nonce back: it is never spent without the ticket being updated, so a resend succeeds.
 *      No row back = ignored (unknown ticket, wrong machine, wrong nonce, ticket already finished, or replayed nonce).
 * Never throws: callers must not fail the ingest response because of this. Logs carry counts and generic reasons only.
 */
import type { StewardSql } from "./tickets";

export const STEWARD_RESULT_KIND = "steward.result";
export const RESULT_OUTCOMES = ["done", "failed", "rejected", "expired", "unsupported"] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];
export const MAX_DETAIL_BYTES = 2048;

export type StewardResultPayload = { ticket_id: string; nonce: string; outcome: ResultOutcome; detail?: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

const MARKER = "…"; // 3 bytes in UTF-8

/** At most MAX_DETAIL_BYTES bytes: an oversize detail is cut on a character boundary and ends with "…". */
export function truncateDetail(detail: string): string {
  const buf = Buffer.from(detail, "utf8");
  if (buf.length <= MAX_DETAIL_BYTES) return detail;
  let end = MAX_DETAIL_BYTES - Buffer.byteLength(MARKER, "utf8");
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // never split a multi-byte character
  return buf.subarray(0, end).toString("utf8") + MARKER;
}

export function validateResultPayload(p: unknown): StewardResultPayload | null {
  if (!isObj(p)) return null;
  const { ticket_id, nonce, outcome, detail } = p;
  if (typeof ticket_id !== "string" || ticket_id.length < 1 || ticket_id.length > 64) return null;
  if (typeof nonce !== "string" || nonce.length < 1 || nonce.length > 64) return null;
  if (typeof outcome !== "string" || !(RESULT_OUTCOMES as readonly string[]).includes(outcome)) return null;
  if (detail !== undefined && detail !== null) {
    if (typeof detail !== "string") return null;
  }
  const out: StewardResultPayload = { ticket_id, nonce, outcome: outcome as ResultOutcome };
  if (typeof detail === "string") out.detail = truncateDetail(detail);
  return out;
}

export type StewardResultRow = { machine: string; kind: string; payload: Record<string, unknown> };

export type ResultStats = { applied: number; ignored: number; errors: number };

export async function applyStewardResults(sql: StewardSql, rows: readonly StewardResultRow[]): Promise<ResultStats> {
  const stats: ResultStats = { applied: 0, ignored: 0, errors: 0 };
  for (const row of rows) {
    if (row.kind !== STEWARD_RESULT_KIND) continue;
    try {
      const p = validateResultPayload(row.payload);
      if (!p) { stats.ignored++; continue; }
      const status = p.outcome === "done" ? "done" : "failed";
      const done = (await sql`
        WITH spent AS (
          INSERT INTO steward_nonces (nonce, machine)
          SELECT ${p.nonce}::text, ${row.machine}::text
           WHERE EXISTS (SELECT 1 FROM steward_tickets
                          WHERE ticket_id = ${p.ticket_id} AND machine = ${row.machine} AND nonce = ${p.nonce} AND status IN ('issued', 'fetched', 'expired'))
          ON CONFLICT (nonce) DO NOTHING
          RETURNING nonce
        )
        UPDATE steward_tickets SET status = ${status}, completed_at = now(), result = ${JSON.stringify(p)}::jsonb
         WHERE ticket_id = ${p.ticket_id} AND machine = ${row.machine} AND nonce = ${p.nonce} AND status IN ('issued', 'fetched', 'expired')
           AND EXISTS (SELECT 1 FROM spent)
        RETURNING ticket_id
      `) as unknown[];
      if (!done || done.length === 0) { stats.ignored++; continue; }
      stats.applied++;
    } catch {
      stats.errors++;
    }
  }
  if (stats.errors > 0) console.error(`[steward-results] update failed: errors=${stats.errors} applied=${stats.applied} ignored=${stats.ignored}`);
  return stats;
}
