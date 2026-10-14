import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { neon } from "@neondatabase/serverless";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const TIER = new Set(["A", "B", "C", "Unknown"]);
const ALLOWED_MIME = new Set(["application/pdf", "image/png", "image/jpeg"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export async function GET() {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT q.id::text AS id, q.degree, q.institution, q.institution_tier, q.year_completed, q.country,
           q.verified, q.verified_at, (q.file_data IS NOT NULL) AS has_file,
           (q.file_data->>'filename') AS file_filename, q.created_at
    FROM qualifications q WHERE q.physician_id = ${me.physicianId}::uuid
    ORDER BY q.year_completed DESC NULLS LAST, q.created_at DESC
  `) as Array<Record<string, unknown>>;
  return portalJson({ ok: true, rows }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const body = await req.json().catch(() => ({}));
  const { degree, institution, institution_tier, year_completed, country, file } = body ?? {};
  if (!degree || typeof degree !== "string" || !degree.trim()) return portalJson({ ok: false, error: "degree required" }, { status: 400, headers: NO_STORE });
  if (institution_tier && !TIER.has(institution_tier)) return portalJson({ ok: false, error: "invalid institution_tier" }, { status: 400, headers: NO_STORE });

  let fileBlob: { filename: string; mime: string; size_bytes: number; data: string } | null = null;
  if (file && typeof file === "object") {
    const f = file as { filename?: string; mime?: string; size_bytes?: number; data?: string };
    if (!f.filename || !f.mime || !f.data || typeof f.size_bytes !== "number") return portalJson({ ok: false, error: "file must include filename, mime, size_bytes, data" }, { status: 400, headers: NO_STORE });
    if (!ALLOWED_MIME.has(f.mime)) return portalJson({ ok: false, error: "Only PDF, PNG, JPEG allowed" }, { status: 400, headers: NO_STORE });
    if (f.size_bytes > MAX_FILE_BYTES) return portalJson({ ok: false, error: "File exceeds 2 MB cap" }, { status: 413, headers: NO_STORE });
    fileBlob = { filename: String(f.filename).slice(0, 200), mime: f.mime, size_bytes: f.size_bytes, data: f.data };
  }

  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  // Self-added qualifications start UNVERIFIED (admin verifies).
  const inserted = (await sql`
    INSERT INTO qualifications (physician_id, degree, institution, institution_tier, year_completed, country, verified, file_data)
    VALUES (${me.physicianId}::uuid, ${degree.trim()}, ${institution ?? null}, ${institution_tier ?? null}, ${year_completed ?? null}, ${country ?? null}, false,
            ${fileBlob ? JSON.stringify({ ...fileBlob, uploaded_at: new Date().toISOString(), uploaded_by_physician: me.physicianId }) : null}::jsonb)
    RETURNING id::text AS id, degree, verified, created_at
  `) as Array<Record<string, unknown>>;
  await sql`INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
            VALUES ('create', 'qualification', ${inserted[0].id as string}, ${JSON.stringify({ physician_id: me.physicianId, degree: degree.trim(), via: "portal", has_file: !!fileBlob })}::jsonb)`;
  return portalJson({ ok: true, qualification: inserted[0] }, { headers: NO_STORE });
}
