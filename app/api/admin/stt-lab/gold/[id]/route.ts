/**
 * GET  /api/admin/stt-lab/gold/[id] — engine transcripts + existing gold for labeling.
 * PUT  /api/admin/stt-lab/gold/[id] — save a verbatim reference, extract terms, score WER.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { saveGold } from "@/lib/stt/scoring";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }

  const enc = (await sql`SELECT id, patient_label_raw, recorded_at, detected_language FROM encounter WHERE id = ${id} LIMIT 1`) as Array<Record<string, unknown>>;
  if (!enc[0]) return respondError("NOT_FOUND", "encounter_not_found");

  const runs = (await sql`
    SELECT engine, transcript_english, transcript_original, wer, cer, med_term_recall, error
      FROM transcription_run
     WHERE encounter_id = ${id} AND mode = 'batch' AND tier = 'asr'
     ORDER BY engine
  `) as unknown[];

  const gold = (await sql`
    SELECT reference_original, reference_english, reference_language, critical_terms_json, terms_model, labeled_at
      FROM stt_gold WHERE encounter_id = ${id} LIMIT 1
  `) as unknown[];

  return respondOk({ encounter: enc[0], runs, gold: gold[0] ?? null });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let adminId = "";
  try { adminId = String((await verifyAdminJwt(cookie)).admin_id ?? ""); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  const ar = (await sql`SELECT role FROM admin_user WHERE id = ${adminId}::uuid LIMIT 1`) as Array<{ role: string }>;
  if (ar[0]?.role === "viewer") return respondError("FORBIDDEN", "Read-only admins cannot label gold");

  let body: { referenceOriginal?: string; referenceEnglish?: string; referenceLanguage?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { return respondError("VALIDATION_FAILED", "body_not_json"); }
  if (!(body.referenceOriginal || body.referenceEnglish)) return respondError("VALIDATION_FAILED", "reference_required");

  const enc = (await sql`SELECT id FROM encounter WHERE id = ${id} LIMIT 1`) as Array<{ id: string }>;
  if (!enc[0]) return respondError("NOT_FOUND", "encounter_not_found");

  const res = await saveGold({
    encounterId: id,
    referenceOriginal: body.referenceOriginal ?? null,
    referenceEnglish: body.referenceEnglish ?? null,
    referenceLanguage: body.referenceLanguage ?? null,
    adminId: adminId || null,
  });
  if (!res.ok) return respondError("VALIDATION_FAILED", "empty_reference");
  try {
    await sql`INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
              VALUES ('admin', ${adminId || null}, 'stt_gold.label', 'encounter', ${id}, ${JSON.stringify({ terms: res.terms, terms_model: res.terms_model, engines: res.engines })}::jsonb)`;
  } catch { /* best-effort */ }
  return respondOk(res);
}
