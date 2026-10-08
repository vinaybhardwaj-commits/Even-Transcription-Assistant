/**
 * lib/rubrics/store.ts — S7-0: rubric_run / rubric_result in Neon (bound SQL; migration 0139) and the per-unit evidence in R2 (eta-lab-results rubric/<id>/<version>/<name>.json
 * through the allowlisted lab store). No transcript text goes into either table. An unavailable lab store skips the evidence (the result row says evidence:false), never the run.
 */
import { customAlphabet } from "nanoid";
import { sql } from "@/lib/db";
import { labStore } from "@/lib/sarvam-lab";
import { BLIND_ROOM_DAYS, BlindRoomDayError, isBlindRoomDay } from "./blind-room-days";
import { parseRoomHourKey } from "./readers/audio-state";

const nano = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);
export const newRunId = (): string => `rub_${nano()}`;

/** WRITERS REFUSE THE HELD-OUT SET (S7-0-R2): a (room, IST date) in lib/rubrics/blind-room-days.ts, given as columns or encoded in a room-hour unit key, is never written. Throws BlindRoomDayError. */
export function assertNotBlind(roomId: string | null | undefined, istDate: string | null | undefined, unitKey?: string): void {
  const k = unitKey ? parseRoomHourKey(unitKey) : null;
  if (isBlindRoomDay(istDate, roomId) || (k && isBlindRoomDay(k.ist_date, k.room_id))) throw new BlindRoomDayError();
}

export const evidenceKey = (rubricId: string, version: string, name: string): string =>
  `rubric/${rubricId}/${version}/${name.replace(/[^A-Za-z0-9_.:@=-]/g, "_").slice(0, 190)}.json`;

export async function insertRun(r: { run_id: string; rubric_id: string; version: string; kind: "run" | "bench"; units_planned: number; actor: string | null }): Promise<void> {
  await sql`
    INSERT INTO rubric_run (run_id, rubric_id, version, kind, units_planned, actor)
    VALUES (${r.run_id}::text, ${r.rubric_id}::text, ${r.version}::text, ${r.kind}::text, ${r.units_planned}::int, ${r.actor}::text)
    ON CONFLICT (run_id) DO NOTHING
  `;
}

export async function finishRun(r: { run_id: string; units_ok: number; units_failed: number; cost_usd?: number }): Promise<void> {
  await sql`
    UPDATE rubric_run SET units_ok = ${r.units_ok}::int, units_failed = ${r.units_failed}::int, cost_usd = ${r.cost_usd ?? 0}::numeric, finished_at = now()
     WHERE run_id = ${r.run_id}::text
  `;
}

export type ResultRow = {
  rubric_id: string; version: string; unit_kind: string; unit_key: string; room_id: string | null; ist_date: string | null; run_id: string;
  status: "ok" | "empty" | "skipped" | "failed"; score: Record<string, unknown> | null; findings: string[]; lab: boolean;
};

/** One unit's outcome; a rerun of the same (rubric, version, unit, lab) REPLACES it (unique key), so a result is always the latest. */
export async function upsertResult(r: ResultRow): Promise<void> {
  assertNotBlind(r.room_id, r.ist_date, r.unit_key); // before the statement is built
  await sql`
    INSERT INTO rubric_result (rubric_id, version, unit_kind, unit_key, room_id, ist_date, run_id, status, score, findings, lab)
    VALUES (${r.rubric_id}::text, ${r.version}::text, ${r.unit_kind}::text, ${r.unit_key}::text, ${r.room_id}::text, ${r.ist_date}::date, ${r.run_id}::text, ${r.status}::text,
            ${r.score === null ? null : JSON.stringify(r.score)}::jsonb, ${JSON.stringify(r.findings)}::jsonb, ${r.lab}::boolean)
    ON CONFLICT (rubric_id, version, unit_key, lab) DO UPDATE
       SET run_id = EXCLUDED.run_id, unit_kind = EXCLUDED.unit_kind, room_id = EXCLUDED.room_id, ist_date = EXCLUDED.ist_date, status = EXCLUDED.status,
           score = EXCLUDED.score, findings = EXCLUDED.findings, created_at = now()
  `;
}

/** Write the per-unit evidence JSON to R2. Returns the key, or null when the lab store is not configured. A write failure throws (the step is retried). */
export async function writeEvidence(rubricId: string, version: string, name: string, body: unknown, pair?: { room_id: string | null; ist_date: string | null }): Promise<string | null> {
  assertNotBlind(pair?.room_id, pair?.ist_date, name);
  const store = labStore();
  if (!store) return null;
  const key = evidenceKey(rubricId, version, name);
  await store.put(key, JSON.stringify(body), {});
  return key;
}

/**
 * GATING-G62: the evidence of a held-out room-day is never fetched. The check runs BEFORE the store is touched, on the pair the caller holds (the result row's room and date) AND on the
 * room-hour key encoded in the evidence file's own name. Throws BlindRoomDayError (a result row for a blind pair cannot be written, but a row inserted by other means is still not served).
 */
export async function readEvidence(key: string, pair?: { room_id: string | null; ist_date: string | null }): Promise<unknown | null> {
  const name = key.split("/").pop()?.replace(/\.json$/, "");
  assertNotBlind(pair?.room_id, pair?.ist_date, name);
  // our G65: a pair that is given but incomplete cannot be classified: fail closed (the answer is the same refusal as a held-out pair)
  if (pair && (!pair.room_id || !pair.ist_date)) throw new BlindRoomDayError();
  const store = labStore();
  if (!store) return null;
  const got = await store.get(key);
  if (!got) return null;
  try {
    return JSON.parse(got.body);
  } catch {
    return null;
  }
}

/** GATING-G62: the held-out pairs as parallel arrays, for the listing's NOT EXISTS (a held-out row is excluded IN THE QUERY, so the limit counts real rows). */
const BLIND_DAYS: string[] = BLIND_ROOM_DAYS.map(([d]) => d);
const BLIND_ROOMS: string[] = BLIND_ROOM_DAYS.map(([, r]) => r);

export type ResultFilter = { rubric_id?: string; unit_kind?: string; room_id?: string; from?: string; to?: string; run_id?: string; lab?: boolean; status?: string; limit: number };

export async function listResults(f: ResultFilter): Promise<Array<Record<string, unknown>>> {
  const rows = (await sql`
    SELECT rubric_id, version, unit_kind, unit_key, room_id, ist_date::text AS ist_date, run_id, status, score, findings, lab, created_at
      FROM rubric_result
     WHERE (${f.rubric_id ?? null}::text IS NULL OR rubric_id = ${f.rubric_id ?? null}::text)
       AND (${f.unit_kind ?? null}::text IS NULL OR unit_kind = ${f.unit_kind ?? null}::text)
       AND (${f.room_id ?? null}::text IS NULL OR room_id = ${f.room_id ?? null}::text)
       AND (${f.from ?? null}::date IS NULL OR ist_date >= ${f.from ?? null}::date)
       AND (${f.to ?? null}::date IS NULL OR ist_date <= ${f.to ?? null}::date)
       AND (${f.run_id ?? null}::text IS NULL OR run_id = ${f.run_id ?? null}::text)
       AND (${f.lab ?? null}::boolean IS NULL OR lab = ${f.lab ?? null}::boolean)
       AND (${f.status ?? null}::text IS NULL OR status = ${f.status ?? null}::text)
       AND room_id IS NOT NULL AND ist_date IS NOT NULL -- GATING-G65 (ours): a row whose room or date is unknown cannot be checked against the held-out set, so it is never served
       AND NOT EXISTS (
             SELECT 1 FROM unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r)
              WHERE (b.d = rubric_result.ist_date AND b.r = rubric_result.room_id)
                 OR (rubric_result.unit_kind = 'room_hour' AND split_part(rubric_result.unit_key, ':', 1) = b.r AND split_part(rubric_result.unit_key, ':', 2) = b.d::text))
     ORDER BY created_at DESC, unit_key LIMIT ${f.limit}::int
  `) as Array<Record<string, unknown>>;
  return rows;
}

export async function listRuns(f: { rubric_id?: string; kind?: string; limit: number }): Promise<Array<Record<string, unknown>>> {
  return (await sql`
    SELECT run_id, rubric_id, version, kind, units_planned, units_ok, units_failed, cost_usd::float8 AS cost_usd, started_at, finished_at, actor
      FROM rubric_run
     WHERE (${f.rubric_id ?? null}::text IS NULL OR rubric_id = ${f.rubric_id ?? null}::text) AND (${f.kind ?? null}::text IS NULL OR kind = ${f.kind ?? null}::text)
     ORDER BY started_at DESC, run_id LIMIT ${f.limit}::int
  `) as Array<Record<string, unknown>>;
}
