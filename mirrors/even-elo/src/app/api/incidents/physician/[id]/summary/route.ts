import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { isVertexSummariesEnabled } from "@/lib/vertex/env";
import { generateRcaCapaSummary } from "@/lib/physician-summary/generate";
import {
  getSummaryResponse,
  loadFeedbackScope,
  PHYSICIAN_UUID_RE,
  requireSummaryStaff,
  SummaryAccessError,
  upsertSummary,
} from "@/lib/physician-summary/access";
import { aggregateFeedback } from "@/lib/physician-summary/aggregate";
import {
  SUMMARY_ERROR_GENERIC,
  SUMMARY_ERROR_UNCONFIGURED,
} from "@/lib/physician-summary/view";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";
/** Two-pass RCA/CAPA may issue several Vertex calls (batched Pass A + Pass B). */
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function accessError(err: unknown): NextResponse | null {
  if (!(err instanceof SummaryAccessError)) return null;
  return NextResponse.json(
    { ok: false, error: err.message },
    { status: err.status, headers: NO_STORE },
  );
}

/**
 * GET /api/incidents/physician/:id/summary
 *
 * Current summary for the physician feedback detail aside.
 * Authz provisional B7.5: super_admin or SGC (same staff who can open the page).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!PHYSICIAN_UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  }
  const sql = neon(url);

  try {
    const body = await getSummaryResponse(sql, id);
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    const mapped = accessError(err);
    if (mapped) return mapped;
    console.error(JSON.stringify({ physician_summary: "get_failed" }));
    return NextResponse.json({ ok: false, error: SUMMARY_ERROR_GENERIC }, { status: 500, headers: NO_STORE });
  }
}

/**
 * POST /api/incidents/physician/:id/summary
 *
 * On-demand generate / regenerate (Sprint 3.3 RCA/CAPA with narratives).
 * Overwrites the current row. Requires FEATURE_VERTEX_SUMMARIES === "true".
 * AuthZ (SGC / super) is the control — prompts may include full narratives.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!PHYSICIAN_UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  }

  if (!isVertexSummariesEnabled(process.env)) {
    return NextResponse.json(
      { ok: false, error: "Summary generation is off", code: "flag_off" },
      { status: 403, headers: NO_STORE },
    );
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  }
  const sql = neon(url);

  try {
    const caller = await requireSummaryStaff(sql);
    const scope = await loadFeedbackScope(sql, caller, id);
    const aggregate = aggregateFeedback(scope.rows);
    if (aggregate.feedback_count < 1) {
      return NextResponse.json(
        { ok: false, error: "No feedback to summarise", code: "no_feedback" },
        { status: 400, headers: NO_STORE },
      );
    }

    const generated = await generateRcaCapaSummary(scope.rows, scope.specialty);
    if (!generated.ok) {
      if (generated.code === "flag_off") {
        return NextResponse.json(
          { ok: false, error: "Summary generation is off", code: "flag_off" },
          { status: 403, headers: NO_STORE },
        );
      }
      if (generated.code === "not_configured") {
        return NextResponse.json(
          { ok: false, error: SUMMARY_ERROR_UNCONFIGURED, code: "not_configured" },
          { status: 503, headers: NO_STORE },
        );
      }
      return NextResponse.json(
        { ok: false, error: SUMMARY_ERROR_GENERIC, code: generated.code },
        { status: 502, headers: NO_STORE },
      );
    }

    const summary = await upsertSummary(sql, {
      physicianId: id,
      body: generated.text,
      modelId: generated.model,
      location: generated.location,
      project: generated.project,
      feedbackCount: aggregate.feedback_count,
      profileId: caller.profileId,
    });

    await sql`
      INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
      VALUES (
        ${caller.profileId}::uuid,
        'physician_feedback_summary_generate',
        'physician',
        ${id},
        ${JSON.stringify({
          model_id: summary.model_id,
          vertex_location: summary.vertex_location,
          feedback_count_at_gen: summary.feedback_count_at_gen,
          generated_at: summary.generated_at,
        })}::jsonb
      )
    `;

    const body = await getSummaryResponse(sql, id);
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    const mapped = accessError(err);
    if (mapped) return mapped;
    console.error(JSON.stringify({ physician_summary: "post_failed" }));
    return NextResponse.json({ ok: false, error: SUMMARY_ERROR_GENERIC }, { status: 500, headers: NO_STORE });
  }
}
