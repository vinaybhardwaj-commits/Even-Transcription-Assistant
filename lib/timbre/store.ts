/**
 * lib/timbre/store.ts — the app-side Timbre writer (Architecture #78/#79). Validates a payload built by
 * tools/timbre/store.py and loads it through the APP connection (@/lib/db) in ONE transaction: INGEST_SQL then RESOLVE_SQL.
 *
 * Idempotent: a re-post of the same inputs (same input_manifest_sha256 + git_sha + calibration map sha256) returns the
 * existing run id with inserted = 0. Validation is structural and refuses any text/name/url/audio key (a code, never the value).
 */
import { sql } from "@/lib/db";
import { INGEST_SQL, RESOLVE_SQL } from "@/lib/room-access/timbre-ingest-sql";

export const PAYLOAD_VERSION = "timbre-store-v1";
export const REASONS = [
  "no_voiceprint", "no_patient", "low_purity", "short_pure_speech", "low_patient_cosine", "overlap", "too_short",
  "attender_speaks_for_patient", "model_error",
] as const;
const FORBIDDEN = /(^|_)(transcript|name|url|audio|presigned|clip_path|r2_key)($|_)/i;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const MAX_WINDOWS = 20_000;

export type Validation = { ok: true; payload: TimbrePayload } | { ok: false; error: string };
export type TimbrePayload = {
  version: string;
  calibration_arousal: Record<string, unknown>;
  calibration_valence: Record<string, unknown>;
  run: Record<string, unknown>;
  windows: Array<Record<string, unknown>>;
  consults: Array<Record<string, unknown>>;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function forbiddenKey(rows: Array<Record<string, unknown>>): string | null {
  const first = rows[0];
  if (!first) return null;
  for (const k of Object.keys(first)) if (!k.startsWith("text_") && FORBIDDEN.test(k)) return k;
  return null;
}

export function validatePayload(body: unknown): Validation {
  if (!isObj(body)) return { ok: false, error: "body_not_object" };
  if (body.version !== PAYLOAD_VERSION) return { ok: false, error: "bad_version" };
  for (const key of ["calibration_arousal", "calibration_valence"] as const) {
    const m = body[key];
    if (!isObj(m) || typeof m.sha256 !== "string" || !HEX64.test(m.sha256) || typeof m.git_sha !== "string" || !HEX40.test(m.git_sha))
      return { ok: false, error: `bad_${key}` };
    if (m.target !== (key === "calibration_arousal" ? "arousal" : "valence")) return { ok: false, error: `bad_${key}_target` };
    if (!isObj(m.payload)) return { ok: false, error: `bad_${key}_payload` };
    for (const bad of ["window_id", "window_ids", "labels", "rows"]) if (bad in m.payload) return { ok: false, error: `${key}_not_aggregate` };
  }
  const run = body.run;
  if (!isObj(run)) return { ok: false, error: "bad_run" };
  if (typeof run.git_sha !== "string" || !HEX40.test(run.git_sha)) return { ok: false, error: "bad_git_sha" };
  if (typeof run.input_manifest_sha256 !== "string" || !HEX64.test(run.input_manifest_sha256)) return { ok: false, error: "bad_manifest_sha" };
  if (!["lab_gpu", "hf_gpu", "cpu_dev"].includes(String(run.compute))) return { ok: false, error: "bad_compute" };
  if (!["ok", "partial", "failed", "running"].includes(String(run.state))) return { ok: false, error: "bad_state" };
  if (!Array.isArray(body.windows) || !Array.isArray(body.consults)) return { ok: false, error: "bad_rows" };
  if (body.windows.length > MAX_WINDOWS) return { ok: false, error: "too_many_windows" };
  const windows = body.windows as unknown[];
  const consults = body.consults as unknown[];
  if (!windows.every(isObj) || !consults.every(isObj)) return { ok: false, error: "bad_rows" };
  const w = windows as Array<Record<string, unknown>>;
  const c = consults as Array<Record<string, unknown>>;
  const bad = forbiddenKey(w) ?? forbiddenKey(c);
  if (bad) return { ok: false, error: "forbidden_field" };
  const textOn = run.text_lane_on === true;
  for (const row of w) {
    if (typeof row.window_key !== "string" || typeof row.consult_uid !== "string" || typeof row.cut_version !== "string") return { ok: false, error: "bad_window_key" };
    if (typeof row.scorable !== "boolean") return { ok: false, error: "bad_scorable" };
    if (row.scorable) {
      if (row.unscorable_reason != null) return { ok: false, error: "scorable_with_reason" };
      if ([row.arousal_raw, row.arousal_calibrated, row.valence_raw, row.valence_calibrated].some((v) => num(v) === null)) return { ok: false, error: "scorable_without_scores" };
    } else {
      if (!REASONS.includes(row.unscorable_reason as (typeof REASONS)[number])) return { ok: false, error: "bad_reason" };
      if ([row.arousal_raw, row.arousal_calibrated, row.valence_raw, row.valence_calibrated].some((v) => v != null)) return { ok: false, error: "unscorable_with_scores" };
    }
    if (!textOn && [row.text_valence, row.text_arousal, row.text_status, row.text_language].some((v) => v != null)) return { ok: false, error: "text_lane_off" };
  }
  if (Number(run.n_windows) !== w.length || Number(run.n_consults) !== c.length) return { ok: false, error: "count_mismatch" };
  return { ok: true, payload: body as unknown as TimbrePayload };
}

export type IngestResult = { run_id: number; inserted: number; n_windows: number; n_consults: number };

/** One transaction: the load statement, then the resolve joins (keyed by the manifest sha, so they are idempotent too). */
export async function ingestTimbrePayload(payload: TimbrePayload): Promise<IngestResult> {
  const sha = String(payload.run.input_manifest_sha256);
  const q = sql as unknown as ((text: string, params: unknown[]) => unknown) & { transaction: (qs: unknown[]) => Promise<unknown[]> };
  const results = (await q.transaction([q(INGEST_SQL, [JSON.stringify(payload)]), ...RESOLVE_SQL.map((s) => q(s, [sha]))])) as Array<Array<Record<string, unknown>>>;
  const row = results[0]?.[0] ?? {};
  return {
    run_id: Number(row.run_id),
    inserted: Number(row.inserted),
    n_windows: Number(row.n_windows),
    n_consults: Number(row.n_consults),
  };
}
