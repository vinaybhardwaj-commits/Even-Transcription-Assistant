import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { neon } from "@neondatabase/serverless";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIER = new Set(["A", "B", "C", "Unknown"]);

/** PATCH /api/portal/qualifications/[qid] — edit OWN qualification, only while unverified (#8). */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ qid: string }> }) {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const { qid } = await ctx.params;
  if (!UUID_RE.test(qid)) return portalJson({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const cur = (await sql`SELECT physician_id::text AS physician_id, verified FROM qualifications WHERE id = ${qid}::uuid LIMIT 1`) as Array<{ physician_id: string; verified: boolean }>;
  if (cur.length === 0) return portalJson({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  if (cur[0].physician_id !== me.physicianId) return portalJson({ ok: false, error: "Forbidden" }, { status: 403, headers: NO_STORE });
  if (cur[0].verified) return portalJson({ ok: false, error: "This qualification has been verified and can no longer be edited. Ask an administrator." }, { status: 409, headers: NO_STORE });

  const body = await req.json().catch(() => ({}));
  const { degree, institution, institution_tier, year_completed, country } = body ?? {};
  if (degree !== undefined && (!degree || !String(degree).trim())) return portalJson({ ok: false, error: "degree cannot be empty" }, { status: 400, headers: NO_STORE });
  if (institution_tier && !TIER.has(institution_tier)) return portalJson({ ok: false, error: "invalid institution_tier" }, { status: 400, headers: NO_STORE });

  await sql`
    UPDATE qualifications SET
      degree           = COALESCE(${degree ?? null}, degree),
      institution      = ${institution ?? null},
      institution_tier = ${institution_tier ?? null},
      year_completed   = ${year_completed ?? null},
      country          = ${country ?? null}
    WHERE id = ${qid}::uuid
  `;
  await sql`INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
            VALUES ('update', 'qualification', ${qid}, ${JSON.stringify({ physician_id: me.physicianId, via: "portal" })}::jsonb)`;
  return portalJson({ ok: true }, { headers: NO_STORE });
}
