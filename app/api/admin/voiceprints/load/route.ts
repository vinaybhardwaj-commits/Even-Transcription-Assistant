/**
 * POST /api/admin/voiceprints/load — enrol CURATED voiceprints for EXISTING clinicians. See
 * lib/voiceprint-load.ts. It never creates a clinician.
 *
 * AUTH: `Authorization: Bearer ${MIGRATION_SECRET}` — the existing secret, compared in constant time.
 *
 * BODY: `{ "entries": [{ clinician_id, centroid_base64, provenance: { source_file, centroid_id?,
 * enroll_seconds?, probe_only? } }] }`, 1..50 entries, at most 256 KB. Any other field, anywhere,
 * is refused. The vector travels in this body over HTTPS; it is never committed anywhere.
 *
 * RESPONSES — a failure is never success-shaped, and nothing is written unless every entry passes:
 *   200 { loaded: [...] }          every entry written and round-tripped from the database
 *   400 VALIDATION_FAILED          a wrong type, a field too long, an unknown field, a bad centroid,
 *                                  or a state that would blend — each with a named reason
 *   400 VALIDATION_FAILED          "refused at write": a concurrent load changed the state after
 *                                  validation; the message lists what WAS written before it
 *   401 AUTH_REQUIRED              no or wrong secret
 *   404 NOT_FOUND                  every refusal is "no such active clinician"
 *   500 PIPELINE_FAILED            a database failure; the message names how far it got
 *
 * Nothing here logs, returns or audits a vector.
 */
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { respondOk, respondError } from "@/lib/respond";
import { resolveEntries, writeEntries, redact, WriteRefusal, LIMITS } from "@/lib/voiceprint-load";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = process.env.MIGRATION_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "", "utf8");
  const want = Buffer.from(`Bearer ${secret}`, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function POST(req: NextRequest) {
  if (!authorised(req)) return respondError("AUTH_REQUIRED", "migration secret required");

  const text = await req.text().catch(() => null);
  if (text === null) return respondError("VALIDATION_FAILED", "body_unreadable");
  if (Buffer.byteLength(text, "utf8") > LIMITS.body_bytes) return respondError("VALIDATION_FAILED", `body_larger_than_${LIMITS.body_bytes}_bytes`);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return respondError("VALIDATION_FAILED", "body_not_json"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return respondError("VALIDATION_FAILED", "body_must_be_an_object");
  const unknown = Object.keys(body).filter((k) => k !== "entries");
  if (unknown.length) {
    const k = unknown[0]!;
    return respondError("VALIDATION_FAILED", `unknown_field_${/^[A-Za-z0-9_.-]{1,40}$/.test(k) ? k : "(unprintable)"}`);
  }
  const entries = (body as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length === 0) return respondError("VALIDATION_FAILED", "entries_required");
  if (entries.length > LIMITS.entries) return respondError("VALIDATION_FAILED", "too_many_entries");

  let phase1;
  try {
    phase1 = await resolveEntries(entries);
  } catch (e) {
    return respondError("PIPELINE_FAILED", `validation read failed; nothing written: ${redact(String((e as Error)?.message ?? e)).slice(0, 160)}`);
  }
  if (!phase1.ok) {
    // Index, id and why — never the vector.
    const list = JSON.stringify(phase1.refusals.map(({ index, clinician_id, reason }) => ({ index, clinician_id, reason }))).slice(0, 900);
    return phase1.refusals.every((r) => r.status === 404)
      ? respondError("NOT_FOUND", `no such active clinician, nothing written: ${list}`)
      : respondError("VALIDATION_FAILED", `refused, nothing written: ${list}`);
  }

  try {
    const loaded = await writeEntries(phase1.resolved);
    return respondOk({ loaded });
  } catch (e) {
    if (e instanceof WriteRefusal) {
      const written = e.written.map((w) => ({ index: w.index, clinician_id: w.clinician_id, sample: w.sample }));
      return respondError("VALIDATION_FAILED", `refused at write: entry ${e.index} ${e.reason}; written before it: ${JSON.stringify(written)}`);
    }
    const msg = redact(String((e as Error)?.message ?? e)).slice(0, 200);
    console.error("[voiceprint-load] write failed", JSON.stringify({ err: msg }));
    return respondError("PIPELINE_FAILED", `write failed part-way — re-run is safe (idempotent): ${msg}`);
  }
}
