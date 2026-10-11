/**
 * lib/freescript/store.ts — validate and load one eta2freescript result (migration 0157).
 *
 * The box posts this. Validation is structural and refuses transcript-shaped fields (a code, never the value).
 * Writes through the APP connection (@/lib/db), never brain_svc. Idempotent on consult_uid + input_sha256.
 */
import { sql } from "@/lib/db";
import { INGEST_SQL } from "./ingest-sql";

export const PAYLOAD_VERSION = "freescript-store-v1";
const HEX64 = /^[0-9a-f]{64}$/;
const UID = /^[A-Za-z0-9_.:@-]{4,128}$/;
const RX = /^[A-Za-z0-9_.:@-]{1,80}$/;
const UID8 = /^[A-Za-z0-9]{8}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROOM = /^[A-Za-z0-9_.\- ]{1,96}$/;
const JOB = /^job_[A-Za-z0-9_-]{4,80}$/;
const SCHEMAS = new Set(["eta.freescript.v0.1", "eta.freescript.v0.2"]);
const TRANSCRIPT_KEYS = new Set([
  "segments", "english_segments", "native_segments", "transcript_text", "audio", "audio_path", "clip_url",
  "r2_key", "presigned_url", "patient_name", "patient_label",
]);
const TRANSCRIPT_KEEP = new Set(["segment_count", "diarised", "english_source", "speaker_source", "role_track"]);

export type Validation = { ok: true; payload: FreescriptPayload } | { ok: false; error: string };
export type FreescriptPayload = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function transcriptField(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(transcriptField);
  if (!isObj(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    if (TRANSCRIPT_KEYS.has(k)) return true;
    if (k === "transcript") {
      if (typeof val === "string" || Array.isArray(val) || !isObj(val)) return true;
      if (Object.keys(val).some((sk) => !TRANSCRIPT_KEEP.has(sk))) return true;
    }
    if (transcriptField(val)) return true;
  }
  return false;
}

export function validatePayload(body: unknown): Validation {
  if (!isObj(body)) return { ok: false, error: "body_not_object" };
  if (body.version !== PAYLOAD_VERSION) return { ok: false, error: "bad_version" };
  if (typeof body.consult_uid !== "string" || !UID.test(body.consult_uid)) return { ok: false, error: "bad_consult_uid" };
  if (body.prescription_uid != null && (typeof body.prescription_uid !== "string" || !RX.test(body.prescription_uid)))
    return { ok: false, error: "bad_prescription_uid" };
  if (typeof body.schema_version !== "string" || !SCHEMAS.has(body.schema_version)) return { ok: false, error: "bad_schema" };
  if (typeof body.ist_date !== "string" || !DATE.test(body.ist_date)) return { ok: false, error: "bad_date" };
  if (body.room_slug != null && (typeof body.room_slug !== "string" || !ROOM.test(body.room_slug))) return { ok: false, error: "bad_room" };
  if (body.room_id != null && (typeof body.room_id !== "string" || !ROOM.test(body.room_id))) return { ok: false, error: "bad_room" };
  if (body.doctor_uid8 != null && (typeof body.doctor_uid8 !== "string" || !UID8.test(body.doctor_uid8)))
    return { ok: false, error: "bad_doctor_uid8" };
  if (typeof body.input_sha256 !== "string" || !HEX64.test(body.input_sha256)) return { ok: false, error: "bad_input_sha" };
  if (body.job_id != null && (typeof body.job_id !== "string" || !JOB.test(body.job_id))) return { ok: false, error: "bad_job_id" };
  if (body.cost_usd != null && (typeof body.cost_usd !== "number" || !Number.isFinite(body.cost_usd) || body.cost_usd < 0 || body.cost_usd > 50))
    return { ok: false, error: "bad_cost" };
  const gen = body.generator;
  if (!isObj(gen) || typeof gen.code_sha256 !== "string" || !HEX64.test(gen.code_sha256) || typeof gen.prompt_sha256 !== "string" || !HEX64.test(gen.prompt_sha256))
    return { ok: false, error: "bad_generator" };
  if (gen.model != null && (typeof gen.model !== "string" || gen.model.length > 160 || /sk-|api[_-]?key/i.test(gen.model)))
    return { ok: false, error: "bad_model" };
  const validator = body.validator;
  if (!isObj(validator) || typeof validator.ok !== "boolean" || !Array.isArray(validator.errors) || validator.errors.length > 30)
    return { ok: false, error: "bad_validator" };
  if (!validator.errors.every((e) => typeof e === "string" && e.length <= 240)) return { ok: false, error: "bad_validator" };
  if (!isObj(body.artifact)) return { ok: false, error: "bad_artifact" };
  if (!Array.isArray(body.completion_required) || body.completion_required.length > 100 || !body.completion_required.every(isObj))
    return { ok: false, error: "bad_completion" };
  if (transcriptField(body.artifact) || transcriptField(body.completion_required)) return { ok: false, error: "transcript_field" };
  if (JSON.stringify(body.artifact).length > 1_500_000) return { ok: false, error: "artifact_too_large" };
  return { ok: true, payload: body };
}

export type IngestResult = { run_id: number; inserted: number };

export async function ingestFreescriptPayload(payload: FreescriptPayload): Promise<IngestResult> {
  const q = sql as unknown as (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
  const rows = await q(INGEST_SQL, [JSON.stringify(payload)]);
  const row = rows[0] ?? {};
  return { run_id: Number(row.run_id), inserted: Number(row.inserted) };
}
