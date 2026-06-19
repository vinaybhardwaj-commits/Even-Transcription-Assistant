/**
 * PUT /{slug}/api/encounters/{id}/editor — autosave the typed-note draft.
 * Body: { editor_text, expansion?: { from, to } }. Only updates a 'draft' row.
 * Accepted rewrites are logged to expansion_log (lexicon growth).
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let claims;
  try { claims = await verifyDoctorJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  if (claims.slug !== slug) return respondError("FORBIDDEN", "Slug mismatch");
  if (!id.startsWith("enc_")) return respondError("VALIDATION_FAILED", "bad_encounter_id");

  let body: { editor_text?: string; expansion?: { from?: string; to?: string } };
  try { body = (await req.json()) as typeof body; } catch { return respondError("VALIDATION_FAILED", "body_not_json"); }
  const editorText = typeof body.editor_text === "string" ? body.editor_text : "";

  try {
    const rows = (await sql`
      UPDATE encounter SET editor_text = ${editorText}
       WHERE id = ${id} AND doctor_id = ${claims.doctor_id} AND status = 'draft'
       RETURNING id
    `) as Array<{ id: string }>;
    if (rows.length === 0) return respondError("NOT_FOUND", "draft_not_found");
  } catch (e) {
    return respondError("PIPELINE_FAILED", (e instanceof Error ? e.message : String(e)).slice(0, 150));
  }

  const ex = body.expansion;
  if (ex && typeof ex.from === "string" && typeof ex.to === "string" && ex.from && ex.to) {
    try {
      await sql`INSERT INTO expansion_log (encounter_id, note_type, from_text, to_text) VALUES (${id}, NULL, ${ex.from}, ${ex.to})`;
    } catch { /* best-effort lexicon log */ }
  }

  return respondOk({ ok: true });
}
