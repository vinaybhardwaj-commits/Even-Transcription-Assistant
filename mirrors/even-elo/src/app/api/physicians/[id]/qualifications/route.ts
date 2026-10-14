import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIER = new Set(["A", "B", "C", "Unknown"]);
const ALLOWED_MIME = new Set(["application/pdf", "image/png", "image/jpeg"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface FileBlob {
  filename: string;
  mime: string;
  size_bytes: number;
  data: string; // base64
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT
      q.id::text AS id,
      q.physician_id::text AS physician_id,
      q.degree, q.institution, q.institution_tier,
      q.year_completed, q.country,
      q.verified, q.verified_at,
      vp.email AS verified_by_email,
      (q.file_data IS NOT NULL) AS has_file,
      (q.file_data->>'filename') AS file_filename,
      (q.file_data->>'mime') AS file_mime,
      ((q.file_data->>'size_bytes')::int) AS file_size_bytes,
      q.created_at
    FROM qualifications q
    LEFT JOIN profiles vp ON vp.id = q.verified_by
    WHERE q.physician_id = ${id}::uuid
    ORDER BY q.year_completed DESC NULLS LAST, q.created_at DESC
  `) as Array<Record<string, unknown>>;
  return NextResponse.json({ ok: true, rows }, { headers: NO_STORE });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const { degree, institution, institution_tier, year_completed, country, file } = body ?? {};
  if (!degree || typeof degree !== "string") return NextResponse.json({ ok: false, error: "degree required" }, { status: 400, headers: NO_STORE });
  if (institution_tier && !TIER.has(institution_tier)) return NextResponse.json({ ok: false, error: "invalid institution_tier" }, { status: 400, headers: NO_STORE });

  // Validate optional file blob
  let fileBlob: FileBlob | null = null;
  if (file && typeof file === "object") {
    const f = file as Partial<FileBlob>;
    if (!f.filename || !f.mime || !f.data || typeof f.size_bytes !== "number") {
      return NextResponse.json({ ok: false, error: "file must include filename, mime, size_bytes, data" }, { status: 400, headers: NO_STORE });
    }
    if (!ALLOWED_MIME.has(f.mime)) {
      return NextResponse.json({ ok: false, error: "Only PDF, PNG, JPEG allowed" }, { status: 400, headers: NO_STORE });
    }
    if (f.size_bytes > MAX_FILE_BYTES) {
      return NextResponse.json({ ok: false, error: `File exceeds 2 MB cap` }, { status: 413, headers: NO_STORE });
    }
    // include physician_id inside file_data for audit jsonb match symmetry
    fileBlob = {
      filename: String(f.filename).slice(0, 200),
      mime: f.mime,
      size_bytes: f.size_bytes,
      data: f.data,
    };
  }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const inserted = (await sql`
    INSERT INTO qualifications (
      physician_id, degree, institution, institution_tier, year_completed, country, file_data
    ) VALUES (
      ${id}::uuid,
      ${degree.trim()},
      ${institution ?? null},
      ${institution_tier ?? null},
      ${year_completed ?? null},
      ${country ?? null},
      ${fileBlob ? JSON.stringify({ ...fileBlob, uploaded_at: new Date().toISOString(), uploaded_by: actor.profileId }) : null}::jsonb
    )
    RETURNING id::text AS id, degree, institution, institution_tier, year_completed, created_at
  `) as Array<Record<string, unknown>>;

  // Audit row — store physician_id in after_json so the audit feed query matches
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (
      ${actor.profileId}::uuid, 'create', 'qualification', ${inserted[0].id as string},
      ${JSON.stringify({ ...inserted[0], physician_id: id, has_file: !!fileBlob, file_filename: fileBlob?.filename ?? null })}::jsonb
    )
  `;
  return NextResponse.json({ ok: true, qualification: inserted[0] }, { headers: NO_STORE });
}
