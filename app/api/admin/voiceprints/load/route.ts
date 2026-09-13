/**
 * POST /api/admin/voiceprints/load — load CURATED clinician voiceprints. See lib/voiceprint-load.ts.
 *
 * AUTH: `Authorization: Bearer ${MIGRATION_SECRET}` — the existing secret, compared in constant time.
 * No new secret was minted for this.
 *
 * BODY: `{ "entries": LoadEntry[] }`. Each entry names an EXISTING clinician by `clinician_id`, or a
 * NEW one by `full_name` + `email` (+ optional `specialty`), and carries one `centroid_base64` and
 * its `provenance`. The vector travels in this body over HTTPS; it is never committed anywhere.
 *
 * RESPONSES — a failure is never success-shaped:
 *   200 { loaded: [...] }                   every entry written and round-tripped from the database
 *   400 VALIDATION_FAILED                   one or more entries refused; NOTHING was written
 *   401 AUTH_REQUIRED                       no or wrong secret
 *   500 PIPELINE_FAILED                     a write failed part-way; the message names how far it got
 *
 * Nothing here logs, returns or audits a vector.
 */
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { respondOk, respondError } from "@/lib/respond";
import { resolveEntries, writeEntries, redact, type LoadEntry } from "@/lib/voiceprint-load";

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

  let body: unknown;
  try { body = await req.json(); } catch { return respondError("VALIDATION_FAILED", "body_not_json"); }
  const entries = (body as { entries?: unknown })?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return respondError("VALIDATION_FAILED", "entries_required");
  if (entries.length > 50) return respondError("VALIDATION_FAILED", "too_many_entries");

  let phase1;
  try {
    phase1 = await resolveEntries(entries as LoadEntry[]);
  } catch (e) {
    return respondError("PIPELINE_FAILED", `validation read failed; nothing written: ${redact(String((e as Error)?.message ?? e)).slice(0, 160)}`);
  }
  if (!phase1.ok) {
    // Index, who and why — never the vector.
    return respondError("VALIDATION_FAILED", `refused, nothing written: ${JSON.stringify(phase1.refusals).slice(0, 900)}`);
  }

  try {
    const loaded = await writeEntries(phase1.resolved);
    return respondOk({ loaded });
  } catch (e) {
    const msg = redact(String((e as Error)?.message ?? e)).slice(0, 200);
    console.error("[voiceprint-load] write failed", JSON.stringify({ err: msg }));
    return respondError("PIPELINE_FAILED", `write failed part-way — re-run is safe (idempotent): ${msg}`);
  }
}
