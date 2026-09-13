/**
 * lib/voiceprint-load.ts — enrol CURATED voiceprints for EXISTING clinicians, over HTTPS, never
 * through git.
 *
 * WHY THIS EXISTS. The curated centroids were built from clean enrolment audio with confirmed
 * windows and validated against holdouts. The only other ways to get a voiceprint in are (a) the
 * admin enrol routes, which take AUDIO and re-embed it, discarding exactly that validation, or
 * (b) a migration, which would put doctors' biometric vectors into a PUBLIC repo. This is the third
 * way: the vector travels in a request body from an operator's machine, is checked here, and is
 * written.
 *
 * ─── WHAT IT DOES NOT DO ────────────────────────────────────────────────────────────────────────
 * IT NEVER CREATES A CLINICIAN. It once could, from any name and email, which let a holder of the
 * migration secret mint an active doctor without the admin cookie the doctors route requires. That
 * capability is removed, not validated: an entry names an existing, ACTIVE clinician by id, and
 * `full_name` / `email` / `specialty` are unknown fields like any other. Doctors are created by an
 * admin, in the admin UI.
 *
 * ─── WHAT IT GUARANTEES ─────────────────────────────────────────────────────────────────────────
 *   STRICT     — every field has a type and a length cap; anything else, including a field this
 *                file does not know, is a 400 with a named reason. See LIMITS.
 *   EXACT      — a centroid is 192 float32 and re-encodes byte-identically to what was sent.
 *   A VOICE    — a centroid with no direction (zero or near-zero L2 norm) is refused.
 *   ACTIVE     — the clinician must exist and be active by the SAME predicate room matching uses
 *                (status = 'active' AND deleted_at IS NULL, lib/stt/diarize-window.ts). Else 404.
 *   UNAVERAGED — voice_print is written once per clinician by one atomic statement decided by its
 *                primary key; a concurrent load of a different vector is refused, never blended.
 *   IDEMPOTENT — the sample id is derived from (clinician, vector); a re-run writes nothing new.
 *   NO ROOM    — nothing here accepts one. "Any doctor can work in any room."
 *
 * ─── THE VECTOR IS NEVER LOGGED ─────────────────────────────────────────────────────────────────
 * Not at debug, not on error, not in an audit row. Error text is passed through `redact`.
 */
import { createHash } from "node:crypto";
import { sql } from "@/lib/db";

export const VOICEPRINT_DIM = 192;
const BYTES = VOICEPRINT_DIM * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The smallest L2 norm accepted for a centroid.
 *
 * These are UNNORMALISED ECAPA (speechbrain spkrec-ecapa-voxceleb) vectors. The five curated
 * centroids loaded on 13 Sep 2026 measure 220.9 to 258.7. The two older app-enrolled voiceprints
 * are means of six samples and were not readable from the Builder's machine; a mean of six vectors
 * shrinks by at most 1/sqrt(6) (about 0.41x) even if the samples were orthogonal, which puts the
 * worst case near 90. A floor of 20 sits more than 4x under that and 11x under the smallest measured
 * value, while an all-zero or near-zero vector — no direction, cosine undefined — lands far below it.
 */
export const MIN_CENTROID_L2 = 20;

/**
 * Every string has a ceiling, so a 5 MB value cannot be stored or audited. Generous against the
 * real values, small against abuse:
 *   clinician_id    64 chars   ids are `doc_` + 8 today; room for a format change, not a document
 *   centroid_base64 4096 chars a real one is exactly 1024; the cap only stops a huge string being
 *                              decoded before the dimension check names the real problem
 *   source_file     200 chars  a file name, not a path dump
 *   centroid_id     100 chars
 *   enroll_seconds  (0, 3600]  an hour of enrolment audio is already absurd
 *   entries         1..50 per request; body 256 KB (both enforced by the route)
 */
export const LIMITS = {
  clinician_id: 64,
  centroid_base64: 4096,
  source_file: 200,
  centroid_id: 100,
  enroll_seconds_max: 3600,
  entries: 50,
  body_bytes: 256 * 1024,
} as const;

/** Strip anything that looks like a base64 blob. The only defence a log line needs. */
export function redact(text: string): string {
  return text.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[redacted]");
}

export type CentroidCheck = { ok: true; bytes: Buffer } | { ok: false; reason: string };

/**
 * PURE. Is this exactly one 192-float32 voiceprint, byte for byte, with a direction?
 *
 * The round-trip is the real test: a vector that does not re-encode to the string that was sent is
 * not provably the vector that was validated upstream. Non-finite values are refused — a NaN is a
 * float32, and it is also not a voice.
 */
export function checkCentroid(b64: unknown): CentroidCheck {
  if (typeof b64 !== "string" || b64.length === 0) return { ok: false, reason: "centroid_missing" };
  if (b64.length > LIMITS.centroid_base64) return { ok: false, reason: `centroid_base64_longer_than_${LIMITS.centroid_base64}` };
  if (b64.length % 4 !== 0 || !BASE64.test(b64)) return { ok: false, reason: "centroid_not_base64" };
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length % 4 !== 0) return { ok: false, reason: `centroid_not_float32_bytes_${bytes.length}` };
  if (bytes.length !== BYTES) return { ok: false, reason: `centroid_dim_${bytes.length / 4}_not_${VOICEPRINT_DIM}` };
  if (bytes.toString("base64") !== b64) return { ok: false, reason: "centroid_roundtrip_mismatch" };
  let sumSq = 0;
  for (let i = 0; i < VOICEPRINT_DIM; i += 1) {
    const x = bytes.readFloatLE(i * 4);
    if (!Number.isFinite(x)) return { ok: false, reason: "centroid_non_finite_value" };
    sumSq += x * x;
  }
  // A VALIDITY CHECK ON THE TYPE IS NOT A VALIDITY CHECK ON THE THING. 192 finite floats can be all
  // zeros; the matcher divides by this norm.
  //
  // "Non-finite after normalisation" needs no loop of its own: every component is already finite,
  // a float32 squared cannot overflow a float64 sum of 192 terms, and l2 >= the floor, so x / l2 is
  // finite for every x. The floor check IS that check.
  const l2 = Math.sqrt(sumSq);
  if (!Number.isFinite(l2) || l2 < MIN_CENTROID_L2) return { ok: false, reason: "centroid_norm_below_floor" };
  return { ok: true, bytes };
}

export type LoadEntry = {
  /** An EXISTING, ACTIVE clinician. Nothing about the clinician is created or changed. */
  clinician_id: string;
  centroid_base64: string;
  /** Recorded on the sample. File names and ids only — never the vector, never a room. */
  provenance: { source_file: string; centroid_id?: string; enroll_seconds?: number; probe_only?: boolean };
};

/** `status` is the HTTP answer this refusal calls for: 404 for "no such active clinician", else 400. */
export type EntryRefusal = { index: number; clinician_id: string | null; reason: string; status: 400 | 404 };
export type EntryLoaded = {
  index: number;
  clinician_id: string;
  sample: "inserted" | "already_present";
  dim: number;
  roundtrip: true;
};

type Resolved = { index: number; entry: LoadEntry };

const ENTRY_KEYS = new Set(["clinician_id", "centroid_base64", "provenance"]);
const PROVENANCE_KEYS = new Set(["source_file", "centroid_id", "enroll_seconds", "probe_only"]);
const CLINICIAN_ID = /^[A-Za-z0-9_-]+$/;
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const sampleIdFor = (clinicianId: string, b64: string) =>
  `vs_curated_${createHash("sha256").update(`${clinicianId}:${b64}`).digest("hex").slice(0, 24)}`;

/**
 * PURE. The shape of one entry: every field typed, every string capped, no unknown field anywhere.
 * Returns the first problem as a named reason, or null. Runs before the centroid is decoded and
 * before any database read, so a wrong type is a 400 and never reaches code that assumes the type.
 */
export function checkEntryShape(entry: unknown): string | null {
  if (!isPlainObject(entry)) return "entry_must_be_an_object";
  for (const k of Object.keys(entry)) if (!ENTRY_KEYS.has(k)) return `unknown_field_${k.slice(0, 40)}`;

  const id = entry.clinician_id;
  if (id === undefined || id === null) return "clinician_id_required";
  if (typeof id !== "string") return "clinician_id_must_be_a_string";
  if (id.length === 0 || id.length > LIMITS.clinician_id) return `clinician_id_length_must_be_1_to_${LIMITS.clinician_id}`;
  if (!CLINICIAN_ID.test(id)) return "clinician_id_has_invalid_characters";

  if (entry.centroid_base64 !== undefined && entry.centroid_base64 !== null && typeof entry.centroid_base64 !== "string") {
    return "centroid_base64_must_be_a_string";
  }

  const p = entry.provenance;
  if (p === undefined || p === null) return "provenance_required";
  if (!isPlainObject(p)) return "provenance_must_be_an_object";
  for (const k of Object.keys(p)) if (!PROVENANCE_KEYS.has(k)) return `unknown_field_provenance.${k.slice(0, 40)}`;
  if (typeof p.source_file !== "string") return "provenance.source_file_must_be_a_string";
  if (p.source_file.trim().length === 0 || p.source_file.length > LIMITS.source_file) return `provenance.source_file_length_must_be_1_to_${LIMITS.source_file}`;
  if (p.centroid_id !== undefined) {
    if (typeof p.centroid_id !== "string") return "provenance.centroid_id_must_be_a_string";
    if (p.centroid_id.trim().length === 0 || p.centroid_id.length > LIMITS.centroid_id) return `provenance.centroid_id_length_must_be_1_to_${LIMITS.centroid_id}`;
  }
  if (p.enroll_seconds !== undefined) {
    if (typeof p.enroll_seconds !== "number" || !Number.isFinite(p.enroll_seconds)) return "provenance.enroll_seconds_must_be_a_finite_number";
    if (p.enroll_seconds <= 0 || p.enroll_seconds > LIMITS.enroll_seconds_max) return `provenance.enroll_seconds_must_be_in_(0,${LIMITS.enroll_seconds_max}]`;
  }
  if (p.probe_only !== undefined && typeof p.probe_only !== "boolean") return "provenance.probe_only_must_be_a_boolean";
  return null;
}

/** Phase 1 — validate and resolve every entry. READS ONLY. */
export async function resolveEntries(entries: unknown[]): Promise<{ ok: true; resolved: Resolved[] } | { ok: false; refusals: EntryRefusal[] }> {
  const refusals: EntryRefusal[] = [];
  const resolved: Resolved[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of entries.entries()) {
    const rawId = isPlainObject(raw) && typeof raw.clinician_id === "string" ? raw.clinician_id.slice(0, LIMITS.clinician_id) : null;
    const shape = checkEntryShape(raw);
    if (shape) { refusals.push({ index, clinician_id: rawId, reason: shape, status: 400 }); continue; }
    const entry = raw as LoadEntry;

    const c = checkCentroid(entry.centroid_base64);
    if (!c.ok) { refusals.push({ index, clinician_id: entry.clinician_id, reason: c.reason, status: 400 }); continue; }

    if (seen.has(entry.clinician_id)) {
      refusals.push({ index, clinician_id: entry.clinician_id, reason: "one_centroid_per_clinician_in_a_batch", status: 400 });
      continue;
    }
    seen.add(entry.clinician_id);

    // EXISTING AND ACTIVE, by the predicate room matching uses. A clinician the matcher will never
    // offer to /diarize gets no voiceprint here either.
    const rows = (await sql`
      SELECT id, (status = 'active' AND deleted_at IS NULL) AS active
        FROM clinician WHERE id = ${entry.clinician_id} LIMIT 1
    `) as Array<{ id: string; active: boolean }>;
    if (!rows[0]) { refusals.push({ index, clinician_id: entry.clinician_id, reason: "clinician_not_found", status: 404 }); continue; }
    if (!rows[0].active) { refusals.push({ index, clinician_id: entry.clinician_id, reason: "clinician_not_active", status: 404 }); continue; }

    // A clinician who already has other samples would have them averaged in. Refuse, do not blend.
    const others = (await sql`
      SELECT count(*)::int AS n FROM voice_sample
       WHERE clinician_id = ${entry.clinician_id} AND included = true AND id <> ${sampleIdFor(entry.clinician_id, entry.centroid_base64)}
    `) as Array<{ n: number }>;
    if (Number(others[0]?.n ?? 0) > 0) {
      refusals.push({ index, clinician_id: entry.clinician_id, reason: "clinician_has_other_samples_loading_would_average", status: 400 });
      continue;
    }
    resolved.push({ index, entry });
  }

  return refusals.length ? { ok: false, refusals } : { ok: true, resolved };
}

/**
 * A write-time refusal: the state changed between validation and write (another load got there
 * first). Carries the index and reason only — never a vector. The route answers it with a non-2xx.
 */
export class WriteRefusal extends Error {
  constructor(public readonly index: number, public readonly reason: string, public readonly written: EntryLoaded[]) {
    super(`entry ${index} refused at write: ${reason}`);
  }
}

/**
 * Phase 2 — write. Only ever reached with a fully validated, fully resolved batch.
 *
 * EVERY WRITE IS ONE STATEMENT. The Neon HTTP driver autocommits each statement, so phase 1's reads
 * guarantee nothing by the time we get here. The voiceprint statement is atomic on its own and
 * decided by the primary key on voice_print.doctor_id: two different vectors for one clinician
 * cannot both land. No lock, no retry.
 */
export async function writeEntries(resolved: Resolved[]): Promise<EntryLoaded[]> {
  const out: EntryLoaded[] = [];
  for (const r of resolved) {
    const clinicianId = r.entry.clinician_id;
    const b64 = r.entry.centroid_base64;
    const id = sampleIdFor(clinicianId, b64);
    const p = r.entry.provenance;
    // session_id carries the provenance the schema has room for: which curated centroid this was,
    // and whether it came from a probe-only artefact. No column is invented for it.
    const sessionId = `curated:${(p.centroid_id ?? p.source_file).slice(0, 80)}${p.probe_only ? ":probe_only" : ""}`;
    const durationMs = typeof p.enroll_seconds === "number" ? Math.round(p.enroll_seconds * 1000) : null;

    // ONE STATEMENT: the voiceprint and its sample land together or not at all.
    //   vp — insert the voiceprint in exactly the row shape recomputeCentroid writes for one sample.
    //        On conflict it is kept, and RETURNED, only if it already IS this vector from one sample
    //        (the idempotent re-run). Any other existing voiceprint returns no row.
    //   vs — the sample, only when vp returned a row.
    const res = (await sql`
      WITH vp AS (
        INSERT INTO voice_print
          (doctor_id, centroid, sample_count, samples_json, enrolled_at, last_sample_at, needs_reenrollment)
        SELECT ${clinicianId}, decode(${b64}, 'base64'), 1, ${JSON.stringify([b64])}::jsonb, NOW(), NOW(), FALSE
         WHERE NOT EXISTS (
           SELECT 1 FROM voice_sample
            WHERE clinician_id = ${clinicianId} AND included = true AND id <> ${id}
         )
        ON CONFLICT (doctor_id) DO UPDATE SET doctor_id = voice_print.doctor_id
          WHERE voice_print.centroid = EXCLUDED.centroid AND voice_print.sample_count = 1
        RETURNING doctor_id, encode(centroid, 'base64') AS c
      ), vs AS (
        INSERT INTO voice_sample
          (id, clinician_id, source, embedding, audio_r2_key, content_type,
           duration_ms, session_id, sample_index, captured_by_admin_id, included, created_at)
        SELECT ${id}, vp.doctor_id, 'enrollment', decode(${b64}, 'base64'), NULL, NULL,
               ${durationMs}, ${sessionId}, 0, NULL, true, NOW()
          FROM vp
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      )
      SELECT (SELECT c FROM vp) AS c, (SELECT count(*)::int FROM vs) AS inserted
    `) as Array<{ c: string | null; inserted: number }>;

    const back = (res[0]?.c ?? "").replace(/\s+/g, "");
    if (!back) {
      // Someone else's voiceprint is there — a different vector, or samples of its own. Refused, and
      // this statement wrote nothing.
      throw new WriteRefusal(r.index, "clinician_already_has_a_different_voiceprint_or_samples", out);
    }
    // THE ROUND-TRIP, ON WHAT WAS ACTUALLY STORED — the statement's own RETURNING, not the request.
    if (back !== b64) {
      throw new Error(`stored centroid for entry ${r.index} does not round-trip`);
    }
    const sample: EntryLoaded["sample"] = Number(res[0]?.inserted ?? 0) > 0 ? "inserted" : "already_present";

    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('system', 'voiceprint_load', 'voiceprint.load', 'doctor', ${clinicianId},
              ${JSON.stringify({ source_file: p.source_file, centroid_id: p.centroid_id ?? null, dim: VOICEPRINT_DIM, sample, probe_only: p.probe_only === true })}::jsonb)
    `;
    out.push({ index: r.index, clinician_id: clinicianId, sample, dim: VOICEPRINT_DIM, roundtrip: true });
  }
  return out;
}
