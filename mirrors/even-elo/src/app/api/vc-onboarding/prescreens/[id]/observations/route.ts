import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCORE_DIMENSIONS = [
  "teamwork", "emr_documentation", "ot_etiquette",
  "protocol_adherence", "outcome", "demeanor",
] as const;
const FLAG_SEVERITIES = new Set(["none", "concern", "immediate_termination_recommended"]);

// CR.2: FPPE trigger enum (PRD §C.5, decision #6). The default keeps VC behaviour identical.
const TRIGGERS = new Set([
  "new_visiting_consultant",
  "new_employed_provisional",
  "special_privilege_request",
  "concern_raised",
]);
// Cases-required threshold per trigger (PRD §C.5). After N cases the prescreen
// auto-advances to 'decision'. Trigger comes from this body OR from the first
// case already on the prescreen if this is case 2+.
const CASES_REQUIRED: Record<string, number> = {
  new_visiting_consultant: 3,
  new_employed_provisional: 5,
  special_privilege_request: 3,
  concern_raised: 5,
};
const OBSERVER_ROLES = [
  "OT Coordinator", "Anesthesia Coordinator", "ICN Lead",
  "Nurse-in-Charge", "Medical Superintendent", "Site Medical Head",
];

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT
      c.id::text AS id,
      c.case_number,
      c.case_date,
      c.procedure,
      c.observer_role,
      c.observer_name,
      c.scores,
      c.narrative_notes,
      c.flag_severity,
      c.trigger,
      p.email AS observer_email,
      c.created_at
    FROM vc_observation_cases c
    JOIN profiles p ON p.id = c.observer_user_id
    WHERE c.prescreen_id = ${id}::uuid
    ORDER BY c.case_number ASC
  `) as Array<Record<string, unknown>>;
  return NextResponse.json({ ok: true, rows, allowed_roles: OBSERVER_ROLES }, { headers: NO_STORE });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const { case_date, procedure, observer_role, scores, narrative_notes, flag_severity, hospital_id, trigger } = body ?? {};

  if (!case_date || !procedure || !observer_role) {
    return NextResponse.json({ ok: false, error: "case_date, procedure, observer_role required" }, { status: 400, headers: NO_STORE });
  }
  if (!hospital_id || typeof hospital_id !== "string") {
    return NextResponse.json({ ok: false, error: "hospital_id required (pick the hospital this case happened at)" }, { status: 400, headers: NO_STORE });
  }
  if (!scores || typeof scores !== "object") {
    return NextResponse.json({ ok: false, error: "scores object required" }, { status: 400, headers: NO_STORE });
  }
  const cleanScores: Record<string, number> = {};
  for (const dim of SCORE_DIMENSIONS) {
    const v = Number((scores as Record<string, unknown>)[dim]);
    if (!Number.isFinite(v) || v < 1 || v > 5) {
      return NextResponse.json({ ok: false, error: `scores.${dim} must be 1-5` }, { status: 400, headers: NO_STORE });
    }
    cleanScores[dim] = Math.round(v);
  }
  const finalFlag = flag_severity && FLAG_SEVERITIES.has(flag_severity) ? flag_severity : "none";

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Verify prescreen exists + is in observation stage
  const psRows = (await sql`
    SELECT id::text AS id, stage, prospective_full_name, prospective_email FROM vc_prescreens WHERE id = ${id}::uuid
  `) as Array<{ id: string; stage: string; prospective_full_name: string; prospective_email: string }>;
  if (psRows.length === 0) return NextResponse.json({ ok: false, error: "prescreen not found" }, { status: 404, headers: NO_STORE });
  const ps = psRows[0];
  if (!["observation", "decision"].includes(ps.stage)) {
    return NextResponse.json({ ok: false, error: `Cannot add observation in stage '${ps.stage}'` }, { status: 409, headers: NO_STORE });
  }
  const hospOk = (await sql`
    SELECT 1 FROM vc_prescreen_hospitals WHERE prescreen_id = ${id}::uuid AND hospital_id = ${hospital_id}::uuid LIMIT 1
  `) as Array<unknown>;
  if (hospOk.length === 0) {
    return NextResponse.json({ ok: false, error: "hospital_id is not one of the prescreen's hospitals" }, { status: 400, headers: NO_STORE });
  }

  // Auto-assign case_number = max + 1 (cap 5)
  const cnt = (await sql`SELECT COALESCE(MAX(case_number), 0) + 1 AS next FROM vc_observation_cases WHERE prescreen_id = ${id}::uuid`) as Array<{ next: number }>;
  const caseNumber = cnt[0].next;

  // CR.2: settle the trigger. Priority order:
  //   1. existing observation case on this prescreen (uniform per prescreen)
  //   2. trigger from POST body (when the AddObservationModal passes it)
  //   3. prescreen.commitments_acknowledged.trigger (set by
  //      /api/physicians/[id]/fppe when triggered from the profile)
  //   4. default 'new_visiting_consultant' for back-compat
  const existingTrig = (await sql`
    SELECT trigger FROM vc_observation_cases WHERE prescreen_id = ${id}::uuid LIMIT 1
  `) as Array<{ trigger: string }>;
  const psMetaRows = (await sql`
    SELECT commitments_acknowledged FROM vc_prescreens WHERE id = ${id}::uuid LIMIT 1
  `) as Array<{ commitments_acknowledged: Record<string, unknown> | null }>;
  const psMetaTrig = (psMetaRows[0]?.commitments_acknowledged as { trigger?: unknown } | null)?.trigger;
  const fromPrescreenMeta =
    typeof psMetaTrig === "string" && TRIGGERS.has(psMetaTrig) ? psMetaTrig : null;
  const incomingTrigger =
    typeof trigger === "string" && TRIGGERS.has(trigger) ? trigger : null;
  const effectiveTrigger =
    existingTrig.length > 0
      ? existingTrig[0].trigger
      : incomingTrigger ?? fromPrescreenMeta ?? "new_visiting_consultant";
  const minRequired = CASES_REQUIRED[effectiveTrigger] ?? 3;
  if (caseNumber > 5) {
    return NextResponse.json({ ok: false, error: "Maximum 5 observation cases reached" }, { status: 409, headers: NO_STORE });
  }

  // Fetch observer profile name (snapshot)
  const me = (await sql`SELECT full_name FROM profiles WHERE id = ${actor.profileId}::uuid`) as Array<{ full_name: string }>;
  const observerName = me[0]?.full_name ?? actor.email;

  const inserted = (await sql`
    INSERT INTO vc_observation_cases (
      prescreen_id, case_number, case_date, procedure,
      observer_role, observer_user_id, observer_name,
      scores, narrative_notes, flag_severity, hospital_id, trigger
    ) VALUES (
      ${id}::uuid, ${caseNumber}, ${case_date}, ${String(procedure).trim()},
      ${String(observer_role).trim()}, ${actor.profileId}::uuid, ${observerName},
      ${JSON.stringify(cleanScores)}::jsonb, ${narrative_notes ?? null}, ${finalFlag}, ${hospital_id}::uuid, ${effectiveTrigger}
    )
    RETURNING id::text AS id, case_number, case_date, procedure, observer_role, observer_name, scores, flag_severity, hospital_id::text AS hospital_id, trigger, created_at
  `) as Array<Record<string, unknown>>;

  // Auto-advance to 'decision' stage:
  //   - after the per-trigger minimum (VC=3, new_employed_provisional=5,
  //     special_privilege_request=3, concern_raised=5 — PRD §C.5)
  //   - OR immediately if flag_severity='immediate_termination_recommended'
  let advancedTo: string | null = null;
  if (caseNumber >= minRequired || finalFlag === "immediate_termination_recommended") {
    if (ps.stage !== "decision") {
      await sql`UPDATE vc_prescreens SET stage = 'decision', updated_at = NOW() WHERE id = ${id}::uuid`;
      advancedTo = "decision";
    }
  }

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      ${finalFlag === "immediate_termination_recommended" ? "flag" : "create"},
      'vc_observation',
      ${inserted[0].id as string},
      ${JSON.stringify({
        prescreen_id: id,
        case_number: caseNumber,
        observer_role,
        flag_severity: finalFlag,
        trigger: effectiveTrigger,
        cases_required: minRequired,
        avg_score: Object.values(cleanScores).reduce((a, b) => a + b, 0) / SCORE_DIMENSIONS.length,
        advanced_to: advancedTo,
      })}::jsonb
    )
  `;

  // Email stub for immediate-termination flag (Resend deferred)
  if (finalFlag === "immediate_termination_recommended") {
    console.log(JSON.stringify({
      epi_email_stub: "vc_immediate_termination_flag",
      prescreen_id: id,
      prospective_email: ps.prospective_email,
      prospective_full_name: ps.prospective_full_name,
      case_number: caseNumber,
      observer_user_id: actor.profileId,
      observer_role,
      escalated_at: new Date().toISOString(),
    }));
  }

  return NextResponse.json(
    { ok: true, observation: inserted[0], advanced_to: advancedTo, trigger: effectiveTrigger, cases_required: minRequired },
    { headers: NO_STORE },
  );
}
