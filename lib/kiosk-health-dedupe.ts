/**
 * lib/kiosk-health-dedupe.ts — cross-source de-duplication for POST /api/kiosk-health (TS-H10 #47, the shadow period).
 *
 * Two senders post the same facts for the same Mac: the standalone daemon (source "daemon") and the helper's built-in collectors (source "helper"). An event is a TWIN of a stored
 * one when machine (same Mac under any spelling), kind and a DIFFERENT source match and the timestamps are within DEDUPE_WINDOW_MS. A twin is not stored; one row in
 * kiosk_health_dedupe (migration 0154) says what was skipped and whose copy stood, so the per-kind counts of the two sources can still be compared. Events from the SAME source are
 * never twins of each other (a sender may legitimately repeat a kind within 2 s). Idempotency on (machine, boot_id, seq) is unchanged and applies first.
 */
import { canonicalMachine, expandKeys, matchKey } from "@/lib/kiosk-health-read";
import { machineKeys } from "@/lib/encounter-windows/machine-keys";
import type { KioskHealthRow } from "@/lib/kiosk-health-ingest";

export const DEDUPE_WINDOW_MS = 2000;
/** most existing rows read to look for twins in one batch */
export const DEDUPE_LOOKUP_LIMIT = 20_000;

export type StoredRef = { machine: string; kind: string; source: string; ts: string | Date };
export type Dropped = { row: KioskHealthRow; twin_source: string };

const keyOf = (machine: string): string => matchKey(canonicalMachine(machine));
const ms = (t: string | Date): number => (t instanceof Date ? t.getTime() : Date.parse(t));

/** PURE. Which of `rows` have a twin among `stored`? */
export function splitTwins(rows: readonly KioskHealthRow[], stored: readonly StoredRef[]): { keep: KioskHealthRow[]; dropped: Dropped[] } {
  const byKey = new Map<string, Array<{ source: string; t: number }>>();
  for (const s of stored) {
    const t = ms(s.ts);
    if (!Number.isFinite(t)) continue;
    const k = `${keyOf(s.machine)}|${s.kind}`;
    const a = byKey.get(k);
    if (a) a.push({ source: s.source, t });
    else byKey.set(k, [{ source: s.source, t }]);
  }
  const keep: KioskHealthRow[] = [];
  const dropped: Dropped[] = [];
  for (const r of rows) {
    const t = ms(r.ts);
    const twin = Number.isFinite(t) ? byKey.get(`${keyOf(r.machine)}|${r.kind}`)?.find((s) => s.source !== r.source && Math.abs(s.t - t) <= DEDUPE_WINDOW_MS) : undefined;
    if (twin) dropped.push({ row: r, twin_source: twin.source });
    else keep.push(r);
  }
  return { keep, dropped };
}

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

/** The stored events that could be twins of `rows`: same machines and kinds, within the batch's time span +- the window. Read-only. */
export async function loadStoredNear(sql: Sql, rows: readonly KioskHealthRow[]): Promise<StoredRef[]> {
  if (rows.length === 0) return [];
  const keys = [...new Set(rows.flatMap((r) => expandKeys(machineKeys(r.machine))))];
  const kinds = [...new Set(rows.map((r) => r.kind))];
  const times = rows.map((r) => Date.parse(r.ts)).filter(Number.isFinite);
  if (times.length === 0) return [];
  const lo = new Date(Math.min(...times) - DEDUPE_WINDOW_MS).toISOString();
  const hi = new Date(Math.max(...times) + DEDUPE_WINDOW_MS).toISOString();
  return (await sql`
    SELECT machine, kind, source, ts FROM kiosk_health_events
     WHERE machine = ANY(${keys}::text[]) AND kind = ANY(${kinds}::text[]) AND ts >= ${lo}::timestamptz AND ts <= ${hi}::timestamptz
     LIMIT ${DEDUPE_LOOKUP_LIMIT}
  `) as StoredRef[];
}

/** Record what was skipped (identity only, no payload). Best effort: a failure is logged by count and never changes the response. */
export async function recordDropped(sql: Sql, dropped: readonly Dropped[]): Promise<void> {
  if (dropped.length === 0) return;
  try {
    await sql`
      INSERT INTO kiosk_health_dedupe (machine, kind, source, twin_source, ts)
      SELECT * FROM unnest(${dropped.map((d) => d.row.machine)}::text[], ${dropped.map((d) => d.row.kind)}::text[], ${dropped.map((d) => d.row.source)}::text[],
                           ${dropped.map((d) => d.twin_source)}::text[], ${dropped.map((d) => d.row.ts)}::timestamptz[])
      ON CONFLICT DO NOTHING
    `;
  } catch {
    console.warn(`[kiosk-health] dedupe record failed, rows=${dropped.length}`);
  }
}
