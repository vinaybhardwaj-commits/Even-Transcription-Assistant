/**
 * lib/voiceprint-load.ts — load CURATED clinician voiceprints, over HTTPS, never through git.
 *
 * WHY THIS EXISTS. The curated centroids were built from clean enrolment audio with confirmed
 * windows and validated against holdouts. The only other ways to get a voiceprint in are (a) the
 * admin enrol routes, which take AUDIO and re-embed it, discarding exactly that validation, or
 * (b) a migration, which would put doctors' names, emails and biometric vectors into a PUBLIC repo.
 * This is the third way: the vector travels in a request body from an operator's machine, is
 * checked here, and is written. It is also how the multi-centroid slice will enrol later.
 *
 * ─── WHAT IT GUARANTEES ─────────────────────────────────────────────────────────────────────────
 *   EXACT      — a centroid is 192 float32 and re-encodes byte-identically to what was sent. It is
 *                refused otherwise; nothing is ever truncated or padded to fit.
 *   A VOICE    — a centroid with no direction (zero, near-zero, or not finite once normalised) is
 *                refused. Being 192 finite float32 is a check on the TYPE; cosine matching needs a
 *                direction, and an all-zero vector has none.
 *   UNAVERAGED — voice_print is written ONCE per clinician, in the shape recomputeCentroid gives a
 *                single sample, by one atomic statement that inserts it only if the clinician has no
 *                voiceprint (or has exactly this one). Two concurrent loads of different vectors
 *                cannot both land and be averaged: the primary key on voice_print.doctor_id decides,
 *                and the loser is refused. A clinician who already HAS other samples is refused too.
 *   IDEMPOTENT — the sample id is derived from (clinician, vector), so a second run inserts nothing
 *                new and creates no second clinician. A new clinician is an upsert on the UNIQUE
 *                email, so two concurrent creates produce one row.
 *   NOT A BACKDOOR — an existing clinician is NEVER modified and NEVER duplicated. A new-clinician
 *                request whose email already exists is REUSED only if the stored name is the same
 *                person; any other name is REJECTED. Identity fields are never updated here.
 *   ALL OR NOTHING AT VALIDATION — every entry is validated and resolved (reads only) before any
 *                write. One bad entry refuses the batch and nothing is written.
 *   NO ROOM    — voice_print and voice_sample have no room column, and nothing here accepts one.
 *                "Any doctor can work in any room."
 *
 * ─── THE VECTOR IS NEVER LOGGED ─────────────────────────────────────────────────────────────────
 * Not at debug, not on error, not in an audit row. Error text from the database is passed through
 * `redact` before it goes anywhere, in case a driver ever echoes a bound value.
 */
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "@/lib/db";
import { buildDoctorSlug } from "@/lib/doctor-slug";
import { mintClinicianId, generatePin } from "@/lib/clinician-mint";

export const VOICEPRINT_DIM = 192;

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
const BYTES = VOICEPRINT_DIM * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strip anything that looks like a base64 blob. The only defence a log line needs. */
export function redact(text: string): string {
  return text.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[redacted]");
}

export type CentroidCheck = { ok: true; bytes: Buffer } | { ok: false; reason: string };

/**
 * PURE. Is this exactly one 192-float32 voiceprint, byte for byte?
 *
 * The round-trip is the real test: base64 has more than one spelling for some byte strings
 * (non-zero padding bits), and a vector that does not re-encode to the string that was sent is not
 * provably the vector that was validated upstream. Non-finite values are refused too — a NaN is a
 * float32, and it is also not a voice.
 */
export function checkCentroid(b64: unknown): CentroidCheck {
  if (typeof b64 !== "string" || b64.length === 0) return { ok: false, reason: "centroid_missing" };
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
  /** An EXISTING clinician. When given, nothing about the clinician is created or changed. */
  clinician_id?: string;
  /** For a NEW clinician: minted through the app's own functions. */
  full_name?: string;
  email?: string;
  specialty?: string;
  centroid_base64: string;
  /** Recorded on the sample. File names and ids only — never the vector, never a room. */
  provenance: { source_file: string; centroid_id?: string; enroll_seconds?: number; probe_only?: boolean };
};

export type EntryRefusal = { index: number; who: string; reason: string };
export type EntryLoaded = {
  index: number;
  clinician_id: string;
  clinician: "created" | "existing";
  sample: "inserted" | "already_present";
  dim: number;
  roundtrip: true;
};

type Resolved = { index: number; entry: LoadEntry; bytesOk: Buffer; clinicianId: string | null; create: null | { fullName: string; email: string; specialty: string | null } };

const who = (e: LoadEntry) => e.clinician_id ?? e.email ?? "(unidentified)";
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const sampleIdFor = (clinicianId: string, b64: string) =>
  `vs_curated_${createHash("sha256").update(`${clinicianId}:${b64}`).digest("hex").slice(0, 24)}`;

/** Phase 1 — validate and resolve every entry. READS ONLY. */
export async function resolveEntries(entries: LoadEntry[]): Promise<{ ok: true; resolved: Resolved[] } | { ok: false; refusals: EntryRefusal[] }> {
  const refusals: EntryRefusal[] = [];
  const resolved: Resolved[] = [];
  const seenClinicians = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    const c = checkCentroid(entry?.centroid_base64);
    if (!c.ok) { refusals.push({ index, who: who(entry ?? ({} as LoadEntry)), reason: c.reason }); continue; }
    if (!entry.provenance || typeof entry.provenance.source_file !== "string" || !entry.provenance.source_file.trim()) {
      refusals.push({ index, who: who(entry), reason: "provenance_source_file_required" }); continue;
    }
    if ("room" in (entry as object) || "room" in (entry.provenance as object)) {
      refusals.push({ index, who: who(entry), reason: "room_not_accepted_voiceprints_are_not_room_scoped" }); continue;
    }

    if (entry.clinician_id) {
      const rows = (await sql`SELECT id FROM clinician WHERE id = ${entry.clinician_id} LIMIT 1`) as Array<{ id: string }>;
      if (!rows[0]) { refusals.push({ index, who: who(entry), reason: "clinician_not_found" }); continue; }
      resolved.push({ index, entry, bytesOk: c.bytes, clinicianId: rows[0].id, create: null });
    } else {
      const fullName = (entry.full_name ?? "").trim();
      const email = (entry.email ?? "").trim().toLowerCase();
      if (fullName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        refusals.push({ index, who: who(entry), reason: "new_clinician_needs_full_name_and_email" }); continue;
      }
      const existing = (await sql`SELECT id, full_name FROM clinician WHERE email = ${email} LIMIT 1`) as Array<{ id: string; full_name: string }>;
      if (existing[0]) {
        // REUSE ONLY THE SAME PERSON. Same email and same name is a re-run; same email and a
        // different name is someone else's account, and attaching a voiceprint to it is refused.
        if (norm(existing[0].full_name) !== norm(fullName)) {
          refusals.push({ index, who: who(entry), reason: "email_exists_with_a_different_name" }); continue;
        }
        resolved.push({ index, entry, bytesOk: c.bytes, clinicianId: existing[0].id, create: null });
      } else {
        resolved.push({ index, entry, bytesOk: c.bytes, clinicianId: null, create: { fullName, email, specialty: entry.specialty?.trim() || null } });
      }
    }

    const key = resolved[resolved.length - 1]!.clinicianId ?? resolved[resolved.length - 1]!.create!.email;
    if (seenClinicians.has(key)) {
      resolved.pop();
      refusals.push({ index, who: who(entry), reason: "one_centroid_per_clinician_in_a_batch" });
      continue;
    }
    seenClinicians.add(key);
  }

  // An existing clinician with samples already would have them averaged in. Refuse, do not blend.
  for (const r of resolved) {
    if (!r.clinicianId) continue;
    const mine = sampleIdFor(r.clinicianId, r.entry.centroid_base64);
    const others = (await sql`
      SELECT count(*)::int AS n FROM voice_sample
       WHERE clinician_id = ${r.clinicianId} AND included = true AND id <> ${mine}
    `) as Array<{ n: number }>;
    if (Number(others[0]?.n ?? 0) > 0) {
      refusals.push({ index: r.index, who: who(r.entry), reason: "clinician_has_other_samples_loading_would_average" });
    }
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
 * guarantee nothing by the time we get here. Correctness therefore does not rest on them: each
 * statement below is atomic on its own and decided by a unique constraint —
 *   clinician  UNIQUE (email)          two creates of one email produce one row
 *   voice_print PRIMARY KEY (doctor_id) two different vectors for one clinician cannot both land
 * No lock, no retry.
 */
export async function writeEntries(resolved: Resolved[]): Promise<EntryLoaded[]> {
  const out: EntryLoaded[] = [];
  for (const r of resolved) {
    let clinicianId = r.clinicianId;
    let clinician: EntryLoaded["clinician"] = "existing";

    if (!clinicianId && r.create) {
      // THE APP'S OWN MINTING: id, slug, token and PIN exactly as the admin create path makes them.
      // The PIN is stored the way that path stores it and is never returned or logged here.
      const built = buildDoctorSlug(r.create.fullName);
      const pin = generatePin();
      const pinHash = await bcrypt.hash(pin, 12);
      const mintedId = mintClinicianId();
      // UPSERT ON THE UNIQUE EMAIL, audit in the same statement. On conflict the no-op SET makes
      // Postgres RETURN the row that won (DO NOTHING would return nothing, and a follow-up SELECT
      // would be a second transaction again). `xmax = 0` is true only for a row this statement
      // inserted. The audit row is written only for that row, atomically with it.
      const rows = (await sql`
        WITH c AS (
          INSERT INTO clinician (
            id, legacy_doctor_id, clinician_type, full_name, email, phone, url_slug,
            url_token, pin_hash, pin_plaintext, pin_set_at, status, created_by, specialty
          ) VALUES (
            ${mintedId}, NULL, 'physician'::clinician_type, ${r.create.fullName}, ${r.create.email}, NULL, ${built.full},
            ${built.token}, ${pinHash}, ${pin}, NOW(), 'active', NULL, ${r.create.specialty}
          )
          ON CONFLICT (email) DO UPDATE SET email = clinician.email
          RETURNING id, full_name, (xmax = 0) AS inserted
        ), a AS (
          INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
          SELECT 'system', 'voiceprint_load', 'doctor.create', 'doctor', c.id,
                 ${JSON.stringify({ full_name: r.create.fullName, email: r.create.email, url_slug: built.full, via: "voiceprint_load" })}::jsonb
            FROM c WHERE c.inserted
        )
        SELECT id, full_name, inserted FROM c
      `) as Array<{ id: string; full_name: string; inserted: boolean }>;
      const row = rows[0];
      if (!row) throw new Error(`clinician upsert for entry ${r.index} returned no row`);
      // The same email may have been created by a concurrent load between validation and now. Reuse
      // it only if it is the same person — the rule phase 1 applies, applied again to the row that won.
      if (!row.inserted && norm(row.full_name) !== norm(r.create.fullName)) {
        throw new WriteRefusal(r.index, "email_exists_with_a_different_name", out);
      }
      clinicianId = row.id;
      clinician = row.inserted ? "created" : "existing";
    }

    const b64 = r.entry.centroid_base64;
    const id = sampleIdFor(clinicianId!, b64);
    const p = r.entry.provenance;
    // session_id carries the provenance the schema has room for: which curated centroid this was,
    // and whether it came from a probe-only artefact. No column is invented for it.
    const sessionId = `curated:${(p.centroid_id ?? p.source_file).slice(0, 80)}${p.probe_only ? ":probe_only" : ""}`;
    const durationMs = typeof p.enroll_seconds === "number" && Number.isFinite(p.enroll_seconds) ? Math.round(p.enroll_seconds * 1000) : null;

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
    out.push({ index: r.index, clinician_id: clinicianId!, clinician, sample, dim: VOICEPRINT_DIM, roundtrip: true });
  }
  return out;
}
