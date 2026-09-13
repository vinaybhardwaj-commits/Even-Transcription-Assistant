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
 *   UNAVERAGED — the stored centroid is computed by the app's own writer (recomputeCentroid), as the
 *                mean of the clinician's included samples. A clinician who already HAS samples is
 *                refused, because loading would silently average the curated vector with them.
 *   IDEMPOTENT — the sample id is derived from (clinician, vector), so a second run inserts nothing
 *                new, recomputes the same centroid, and creates no second clinician.
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
import { recomputeCentroid } from "@/lib/voice-samples";

export const VOICEPRINT_DIM = 192;
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
  for (let i = 0; i < VOICEPRINT_DIM; i += 1) {
    if (!Number.isFinite(bytes.readFloatLE(i * 4))) return { ok: false, reason: "centroid_non_finite_value" };
  }
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

/** Phase 2 — write. Only ever reached with a fully validated, fully resolved batch. */
export async function writeEntries(resolved: Resolved[]): Promise<EntryLoaded[]> {
  const out: EntryLoaded[] = [];
  for (const r of resolved) {
    let clinicianId = r.clinicianId;
    let clinician: EntryLoaded["clinician"] = "existing";

    if (!clinicianId && r.create) {
      // THE APP'S OWN MINTING: id, slug, token and PIN exactly as the admin create path makes them.
      // The PIN is stored the way that path stores it and is never returned or logged here — an
      // operator reads or resets it through the admin UI.
      const built = buildDoctorSlug(r.create.fullName);
      const pin = generatePin();
      const pinHash = await bcrypt.hash(pin, 12);
      clinicianId = mintClinicianId();
      await sql`
        INSERT INTO clinician (
          id, legacy_doctor_id, clinician_type, full_name, email, phone, url_slug,
          url_token, pin_hash, pin_plaintext, pin_set_at, status, created_by, specialty
        ) VALUES (
          ${clinicianId}, NULL, 'physician'::clinician_type, ${r.create.fullName}, ${r.create.email}, NULL, ${built.full},
          ${built.token}, ${pinHash}, ${pin}, NOW(), 'active', NULL, ${r.create.specialty}
        )
      `;
      clinician = "created";
      await sql`
        INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
        VALUES ('system', 'voiceprint_load', 'doctor.create', 'doctor', ${clinicianId},
                ${JSON.stringify({ full_name: r.create.fullName, email: r.create.email, url_slug: built.full, via: "voiceprint_load" })}::jsonb)
      `;
    }

    const id = sampleIdFor(clinicianId!, r.entry.centroid_base64);
    const p = r.entry.provenance;
    // session_id carries the provenance the schema has room for: which curated centroid this was,
    // and whether it came from a probe-only artefact. No column is invented for it.
    const sessionId = `curated:${(p.centroid_id ?? p.source_file).slice(0, 80)}${p.probe_only ? ":probe_only" : ""}`;
    const durationMs = typeof p.enroll_seconds === "number" && Number.isFinite(p.enroll_seconds) ? Math.round(p.enroll_seconds * 1000) : null;
    const inserted = (await sql`
      INSERT INTO voice_sample
        (id, clinician_id, source, embedding, audio_r2_key, content_type,
         duration_ms, session_id, sample_index, captured_by_admin_id, included, created_at)
      VALUES
        (${id}, ${clinicianId}, 'enrollment', decode(${r.entry.centroid_base64}, 'base64'), NULL, NULL,
         ${durationMs}, ${sessionId}, 0, NULL, true, NOW())
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `) as Array<{ id: string }>;

    await recomputeCentroid(clinicianId!);

    // THE ROUND-TRIP, ON WHAT WAS ACTUALLY STORED. Not on the request — on the database's answer.
    const stored = (await sql`SELECT encode(centroid, 'base64') AS c, sample_count FROM voice_print WHERE doctor_id = ${clinicianId} LIMIT 1`) as Array<{ c: string; sample_count: number }>;
    const back = (stored[0]?.c ?? "").replace(/\s+/g, "");
    if (back !== r.entry.centroid_base64) {
      throw new Error(`stored centroid for entry ${r.index} does not round-trip (sample_count=${stored[0]?.sample_count ?? "none"})`);
    }

    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('system', 'voiceprint_load', 'voiceprint.load', 'doctor', ${clinicianId},
              ${JSON.stringify({ source_file: p.source_file, centroid_id: p.centroid_id ?? null, dim: VOICEPRINT_DIM, sample: inserted.length ? "inserted" : "already_present", probe_only: p.probe_only === true })}::jsonb)
    `;
    out.push({ index: r.index, clinician_id: clinicianId!, clinician, sample: inserted.length ? "inserted" : "already_present", dim: VOICEPRINT_DIM, roundtrip: true });
  }
  return out;
}
