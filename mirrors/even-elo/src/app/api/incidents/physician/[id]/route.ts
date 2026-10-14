import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { getHospitalFilterId } from "@/lib/hospital-filter";
import {
  negativeActivityHint,
  positiveSourceHint,
  type FeedbackDetailPayload,
  type FeedbackTimelineItem,
} from "@/lib/feedback-detail";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(v: unknown): string | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * GET /api/incidents/physician/:id
 *
 * Physician-scoped feedback detail. Join is incidents.target_physician_id.
 * Visibility matches GET /api/incidents. The payload has no free text.
 * Summary state is loaded from GET /api/incidents/physician/:id/summary.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  }

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const meRows = (await sql`
    SELECT email, is_super_admin FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid
  `) as Array<{ email: string; is_super_admin: boolean }>;
  if (meRows.length === 0) return NextResponse.json({ ok: false, error: "no profile" }, { status: 401, headers: NO_STORE });
  const me = meRows[0];

  const myPhys = (await sql`SELECT id::text AS id FROM physicians WHERE lower(email) = ${me.email.toLowerCase()} LIMIT 1`) as Array<{ id: string }>;
  const myPhysicianId = myPhys[0]?.id ?? "";
  const hospitalId = (await getHospitalFilterId()) ?? "";

  const physicianRows = (await sql`
    SELECT id::text AS id, full_name AS name, primary_specialty AS specialty
    FROM physicians
    WHERE id = ${id}::uuid
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  if (physicianRows.length === 0) {
    return NextResponse.json({ ok: false, error: "Physician not found" }, { status: 404, headers: NO_STORE });
  }
  const physician = physicianRows[0];

  const rows = (await sql`
    SELECT
      i.id::text AS id,
      i.submitted_at,
      i.polarity,
      i.category,
      i.commendation_category,
      i.severity,
      i.status,
      i.source,
      h.code AS hospital_code
    FROM incidents i
    LEFT JOIN hospitals h ON h.id = i.hospital_id
    WHERE i.target_physician_id = ${id}::uuid
      AND (
        ${me.is_super_admin}
        OR i.submitter_user_id = ${actor.profileId}::uuid
        OR (${myPhysicianId} <> '' AND i.target_physician_id = ${myPhysicianId || EMPTY_UUID}::uuid)
      )
      AND (${hospitalId} = '' OR i.hospital_id = ${hospitalId || EMPTY_UUID}::uuid)
    ORDER BY i.submitted_at DESC
    LIMIT 1000
  `) as Array<Record<string, unknown>>;

  const timeline: FeedbackTimelineItem[] = rows.map((row) => ({
    id: String(row.id),
    submitted_at: iso(row.submitted_at) ?? "",
    polarity: String(row.polarity ?? "negative"),
    category: (row.category as string | null) ?? null,
    commendation_category: (row.commendation_category as string | null) ?? null,
    severity: (row.severity as string | null) ?? null,
    status: String(row.status ?? ""),
    source: String(row.source ?? "peer"),
  }));

  const counted = timeline.filter((row) => row.status !== "retracted");
  const hospitalCodes = Array.from(new Set(
    rows
      .map((row) => (row.hospital_code as string | null) ?? "")
      .map((code) => code.trim())
      .filter(Boolean),
  )).sort();

  const body: FeedbackDetailPayload = {
    ok: true,
    physician: {
      id: String(physician.id),
      name: String(physician.name ?? ""),
      specialty: String(physician.specialty ?? "").trim() || "—",
      hospital_codes: hospitalCodes,
    },
    headline: {
      total: counted.length,
      negative: counted.filter((row) => row.polarity === "negative").length,
      positive: counted.filter((row) => row.polarity === "positive").length,
      last_activity: counted.reduce<string | null>((latest, row) => {
        if (!row.submitted_at) return latest;
        if (!latest || row.submitted_at > latest) return row.submitted_at;
        return latest;
      }, null),
      negative_hint: negativeActivityHint(timeline),
      positive_hint: positiveSourceHint(timeline),
    },
    timeline,
  };

  return NextResponse.json(body, { headers: NO_STORE });
}
