import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { getHospitalFilterId } from "@/lib/hospital-filter";
import {
  HEADLINE_SUMMARY_LABEL,
  ROW_SUMMARY_LABEL,
  SUMMARY_STATE_NONE,
  type FeedbackFeedItem,
  type FeedbackHomePayload,
  type FeedbackPhysicianRow,
  type NeedsAttentionItem,
} from "@/lib/feedback-home";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const EMPTY_UUID = "00000000-0000-0000-0000-000000000000";

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function iso(v: unknown): string | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * GET /api/incidents/home
 *
 * Grouped Patient Feedback home. Visibility matches GET /api/incidents
 * (super admin, submitter, or target physician). Hospital scope follows
 * the epi_hospital_filter cookie. Retracted rows stay out of headline
 * and physician totals; the chronological feed still includes them.
 * Summary fields are the empty state only.
 */
export async function GET() {
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

  const visible = sql;
  // Shared predicates are inlined in each statement because the neon
  // tagged template cannot reuse a SQL fragment. Keep them aligned with
  // GET /api/incidents.

  const [headlineRows, rosterRows, physicianRows, attentionRows, feedRows] = await Promise.all([
    visible`
      SELECT
        COUNT(*) FILTER (WHERE i.status <> 'retracted')::int AS total,
        COUNT(*) FILTER (WHERE i.status <> 'retracted' AND i.polarity = 'negative')::int AS negative,
        COUNT(*) FILTER (WHERE i.status <> 'retracted' AND i.polarity = 'positive')::int AS positive,
        COUNT(DISTINCT i.target_physician_id) FILTER (WHERE i.status <> 'retracted')::int AS physicians_with_feedback
      FROM incidents i
      WHERE (
        ${me.is_super_admin}
        OR i.submitter_user_id = ${actor.profileId}::uuid
        OR (${myPhysicianId} <> '' AND i.target_physician_id = ${myPhysicianId || EMPTY_UUID}::uuid)
      )
      AND (${hospitalId} = '' OR i.hospital_id = ${hospitalId || EMPTY_UUID}::uuid)
    ` as Promise<Array<Record<string, unknown>>>,
    visible`
      SELECT COUNT(DISTINCT p.id)::int AS n
      FROM physicians p
      WHERE p.current_status = 'active'
      AND (
        ${hospitalId} = ''
        OR EXISTS (
          SELECT 1 FROM physician_engagements pe
          WHERE pe.physician_id = p.id
            AND pe.status = 'active'
            AND pe.hospital_id = ${hospitalId || EMPTY_UUID}::uuid
        )
      )
    ` as Promise<Array<Record<string, unknown>>>,
    visible`
      SELECT
        ph.id::text AS physician_id,
        ph.full_name AS name,
        ph.primary_specialty AS specialty,
        COUNT(*) FILTER (WHERE i.status <> 'retracted' AND i.polarity = 'positive')::int AS positive,
        COUNT(*) FILTER (WHERE i.status <> 'retracted' AND i.polarity = 'negative')::int AS negative,
        COUNT(*) FILTER (WHERE i.status <> 'retracted')::int AS total,
        MAX(i.submitted_at) FILTER (WHERE i.status <> 'retracted') AS last_activity,
        COUNT(*) FILTER (WHERE i.status <> 'retracted' AND i.severity = 'critical')::int AS sev_critical,
        COUNT(*) FILTER (WHERE i.status <> 'retracted' AND i.severity = 'high')::int AS sev_high,
        COUNT(*) FILTER (WHERE i.status <> 'retracted' AND i.severity = 'medium')::int AS sev_medium,
        COUNT(*) FILTER (WHERE i.status <> 'retracted' AND i.severity = 'low')::int AS sev_low
      FROM incidents i
      JOIN physicians ph ON ph.id = i.target_physician_id
      WHERE (
        ${me.is_super_admin}
        OR i.submitter_user_id = ${actor.profileId}::uuid
        OR (${myPhysicianId} <> '' AND i.target_physician_id = ${myPhysicianId || EMPTY_UUID}::uuid)
      )
      AND (${hospitalId} = '' OR i.hospital_id = ${hospitalId || EMPTY_UUID}::uuid)
      GROUP BY ph.id, ph.full_name, ph.primary_specialty
      HAVING COUNT(*) FILTER (WHERE i.status <> 'retracted') > 0
      ORDER BY total DESC, last_activity DESC NULLS LAST, ph.full_name ASC
    ` as Promise<Array<Record<string, unknown>>>,
    visible`
      SELECT
        i.id::text AS id,
        ph.id::text AS physician_id,
        ph.full_name AS physician_name,
        COALESCE(NULLIF(trim(ph.primary_specialty), ''), '—') AS specialty,
        i.severity,
        i.category,
        i.submitted_at
      FROM incidents i
      JOIN physicians ph ON ph.id = i.target_physician_id
      WHERE (
        ${me.is_super_admin}
        OR i.submitter_user_id = ${actor.profileId}::uuid
        OR (${myPhysicianId} <> '' AND i.target_physician_id = ${myPhysicianId || EMPTY_UUID}::uuid)
      )
      AND (${hospitalId} = '' OR i.hospital_id = ${hospitalId || EMPTY_UUID}::uuid)
      AND i.status = 'open'
      AND i.polarity = 'negative'
      AND i.severity = 'critical'
      ORDER BY i.submitted_at DESC
      LIMIT 20
    ` as Promise<Array<Record<string, unknown>>>,
    visible`
      SELECT
        i.id::text AS id,
        i.target_physician_id::text AS target_physician_id,
        ph.full_name AS target_physician_name,
        COALESCE(NULLIF(trim(ph.primary_specialty), ''), '—') AS specialty,
        i.submitted_at,
        i.anonymous_flag,
        i.source,
        i.reporter_name,
        i.reporter_email,
        i.submitter_position_at_time,
        sp.email AS submitter_email,
        sp2.full_name AS submitter_physician_name,
        h.code AS hospital_code,
        i.category,
        i.severity,
        i.polarity,
        i.commendation_category,
        i.patient_rating,
        left(i.narrative, 240) AS narrative_preview,
        i.status,
        i.retracted_at,
        i.retraction_reason,
        (SELECT COUNT(*)::int FROM incident_replies r WHERE r.incident_id = i.id) AS reply_count
      FROM incidents i
      JOIN physicians ph ON ph.id = i.target_physician_id
      LEFT JOIN hospitals h ON h.id = i.hospital_id
      LEFT JOIN profiles sp ON sp.id = i.submitter_user_id
      LEFT JOIN physicians sp2 ON sp2.id = i.submitter_physician_id
      WHERE (
        ${me.is_super_admin}
        OR i.submitter_user_id = ${actor.profileId}::uuid
        OR (${myPhysicianId} <> '' AND i.target_physician_id = ${myPhysicianId || EMPTY_UUID}::uuid)
      )
      AND (${hospitalId} = '' OR i.hospital_id = ${hospitalId || EMPTY_UUID}::uuid)
      ORDER BY i.submitted_at DESC
      LIMIT 1000
    ` as Promise<Array<Record<string, unknown>>>,
  ]);

  const h = headlineRows[0] ?? {};
  const physicians: FeedbackPhysicianRow[] = physicianRows.map((r) => ({
    physician_id: String(r.physician_id),
    name: String(r.name ?? ""),
    specialty: String(r.specialty ?? "").trim() || "—",
    positive: num(r.positive),
    negative: num(r.negative),
    total: num(r.total),
    last_activity: iso(r.last_activity),
    severity_counts: {
      critical: num(r.sev_critical),
      high: num(r.sev_high),
      medium: num(r.sev_medium),
      low: num(r.sev_low),
    },
    summary_label: ROW_SUMMARY_LABEL,
  }));

  const needs_attention: NeedsAttentionItem[] = attentionRows.map((r) => ({
    id: String(r.id),
    physician_id: String(r.physician_id),
    physician_name: String(r.physician_name ?? ""),
    specialty: String(r.specialty ?? "—"),
    severity: String(r.severity ?? "critical"),
    category: (r.category as string | null) ?? null,
    submitted_at: iso(r.submitted_at) ?? "",
  }));

  const feed: FeedbackFeedItem[] = feedRows.map((r) => {
    const reporterName = r.source === "external_public"
      ? `${(r.reporter_name as string) || "External reporter"} · external (unverified)${r.reporter_email ? ` · ${r.reporter_email}` : ""}`
      : r.submitter_physician_name
      ? `${r.submitter_physician_name as string} (peer)`
      : `${(r.submitter_position_at_time as string) ?? ""}${r.submitter_email ? ` · ${r.submitter_email}` : ""}`;
    return {
      id: String(r.id),
      target_physician_id: String(r.target_physician_id),
      target_physician_name: String(r.target_physician_name ?? ""),
      specialty: String(r.specialty ?? "—"),
      submitted_at: iso(r.submitted_at) ?? "",
      anonymous_flag: Boolean(r.anonymous_flag),
      submitter_label: (reporterName.trim() || "Unknown") + (r.anonymous_flag ? " · anon to peers" : ""),
      hospital_code: (r.hospital_code as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      severity: (r.severity as string | null) ?? null,
      polarity: (r.polarity as string) ?? "negative",
      source: (r.source as string) ?? "peer",
      commendation_category: (r.commendation_category as string | null) ?? null,
      patient_rating: r.patient_rating == null ? null : num(r.patient_rating),
      narrative_preview: String(r.narrative_preview ?? ""),
      status: String(r.status ?? ""),
      retracted_at: iso(r.retracted_at),
      retraction_reason: (r.retraction_reason as string | null) ?? null,
      reply_count: num(r.reply_count),
    };
  });

  const body: FeedbackHomePayload = {
    ok: true,
    headline: {
      total: num(h.total),
      negative: num(h.negative),
      positive: num(h.positive),
      physicians_with_feedback: num(h.physicians_with_feedback),
      roster_size: num(rosterRows[0]?.n),
      summaries: SUMMARY_STATE_NONE,
      summaries_label: HEADLINE_SUMMARY_LABEL,
    },
    needs_attention,
    physicians,
    feed,
  };

  return NextResponse.json(body, { headers: NO_STORE });
}
