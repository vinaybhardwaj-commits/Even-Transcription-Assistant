/**
 * GET /{slug}/api/notegen/nabh-requirements?note_type=<eta_note_type>
 * Returns the deterministic NABH floor for the editor's coverage stream. Maps the
 * EvenScribe note_type onto the seed taxonomy; types without a floor return [].
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { respondError } from "@/lib/respond";
import { seedNoteType } from "@/lib/notegen/note-type-map";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let claims;
  try { claims = await verifyDoctorJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  if (claims.slug !== slug) return respondError("FORBIDDEN", "Slug mismatch");

  const etaType = req.nextUrl.searchParams.get("note_type");
  const seed = seedNoteType(etaType);
  if (!seed) return NextResponse.json({ note_type: etaType, seed_type: null, count: 0, fields: [] });

  try {
    const fields = (await sql`
      SELECT field_key, label, section, mandatory, conditional_on
        FROM nabh_requirements
       WHERE note_type = ${seed}
       ORDER BY sort_order
    `) as Array<{ field_key: string; label: string; section: string; mandatory: boolean; conditional_on: string | null }>;
    return NextResponse.json({ note_type: etaType, seed_type: seed, count: fields.length, fields });
  } catch (e) {
    return respondError("PIPELINE_FAILED", (e instanceof Error ? e.message : String(e)).slice(0, 150));
  }
}
