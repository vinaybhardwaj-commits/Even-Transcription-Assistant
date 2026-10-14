import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { neon } from "@neondatabase/serverless";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { sendEmail, wrapHtml } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(["clinical","patient_safety","medical_error","professionalism","documentation","etiquette","vendor_compliance","other"]);
const SEVERITIES = new Set(["low","medium","high","critical"]);
const COMMENDATIONS = new Set(["Clinical Excellence","Patient Experience","Teamwork & Collaboration","Teaching & Mentorship","Going Above & Beyond"]);

// OP6 — basic abuse guardrail on network-wide reporting: max 10 submissions / 10 min / physician (per serverless instance).
const rl = new Map<string, { count: number; resetAt: number }>();
function rateOk(key: string): boolean {
  const now = Date.now(); const e = rl.get(key);
  if (!e || now > e.resetAt) { rl.set(key, { count: 1, resetAt: now + 10 * 60 * 1000 }); return true; }
  e.count++; return e.count <= 10;
}

/**
 * POST /api/portal/feedback — a physician files PEER feedback on another physician.
 * Network-wide (#5). Positive is always named; negative may be anonymous to the
 * target + peers but admins always see the reporter (#6/#8): submitter_physician_id
 * is always stored; anonymous_flag only controls non-admin display.
 */
export async function POST(req: NextRequest) {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  if (!rateOk(me.physicianId)) return portalJson({ ok: false, error: "You're submitting feedback too quickly — please slow down." }, { status: 429, headers: NO_STORE });

  const body = await req.json().catch(() => ({}));
  const { target_physician_id, polarity, category, severity, commendation_category, narrative, anonymous_flag, evidence_urls } = body ?? {};

  if (!target_physician_id || !UUID_RE.test(target_physician_id)) return portalJson({ ok: false, error: "valid target_physician_id required" }, { status: 400, headers: NO_STORE });
  if (target_physician_id === me.physicianId) return portalJson({ ok: false, error: "You can't file feedback on yourself." }, { status: 400, headers: NO_STORE });
  if (polarity !== "positive" && polarity !== "negative") return portalJson({ ok: false, error: "polarity must be positive|negative" }, { status: 400, headers: NO_STORE });
  if (!narrative || typeof narrative !== "string" || !narrative.trim()) return portalJson({ ok: false, error: "narrative required" }, { status: 400, headers: NO_STORE });

  let sevVal: string | null = null, catVal: string | null = null, commVal: string | null = null;
  let anon = false;
  if (polarity === "negative") {
    if (!category || !CATEGORIES.has(category)) return portalJson({ ok: false, error: "category required" }, { status: 400, headers: NO_STORE });
    if (!severity || !SEVERITIES.has(severity)) return portalJson({ ok: false, error: "severity required" }, { status: 400, headers: NO_STORE });
    sevVal = severity; catVal = category; anon = Boolean(anonymous_flag);
  } else {
    if (!commendation_category || !COMMENDATIONS.has(commendation_category)) return portalJson({ ok: false, error: "commendation_category required for positive feedback" }, { status: 400, headers: NO_STORE });
    commVal = commendation_category; anon = false; // positives are always named
  }
  const urls: string[] = Array.isArray(evidence_urls) ? evidence_urls.filter((u: unknown) => typeof u === "string" && (u as string).trim()).slice(0, 10) : [];

  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const tgt = (await sql`
    SELECT p.id::text AS id, p.full_name, p.email,
      COALESCE((SELECT json_agg(e.hospital_id::text ORDER BY e.start_date DESC) FROM physician_engagements e WHERE e.physician_id = p.id AND e.status='active'), '[]'::json) AS active_hospital_ids
    FROM physicians p WHERE p.id = ${target_physician_id}::uuid AND p.current_status = 'active'
  `) as Array<{ id: string; full_name: string; email: string | null; active_hospital_ids: string[] }>;
  if (tgt.length === 0) return portalJson({ ok: false, error: "Target physician not found or not active." }, { status: 404, headers: NO_STORE });
  const hospIds = Array.isArray(tgt[0].active_hospital_ids) ? tgt[0].active_hospital_ids : [];
  if (hospIds.length === 0) return portalJson({ ok: false, error: "Target physician has no active engagement to attach this to." }, { status: 400, headers: NO_STORE });
  const hospitalId = hospIds[0];

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;

  const inserted = (await sql`
    INSERT INTO incidents (
      target_physician_id, submitted_from_ip, submitter_physician_id, submitter_position_at_time,
      anonymous_flag, hospital_id, polarity, source, category, severity,
      commendation_category, narrative, evidence_urls
    ) VALUES (
      ${target_physician_id}::uuid, ${ip}, ${me.physicianId}::uuid, ${"Physician (peer)"},
      ${anon}, ${hospitalId}::uuid, ${polarity}, ${"peer"}, ${catVal}, ${sevVal},
      ${commVal}, ${narrative.trim()}, ${urls.length > 0 ? urls : null}
    )
    RETURNING id::text AS id, polarity, source, anonymous_flag
  `) as Array<Record<string, unknown>>;

  await sql`INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
            VALUES ('create', 'incident', ${inserted[0].id as string},
            ${JSON.stringify({ via: "portal_peer", source: "peer", polarity, anonymous_flag: anon, target_physician_id, submitter_physician_id: me.physicianId, submitter_name: me.full_name })}::jsonb)`;

  // N.2 — notify the target physician of new peer feedback. Anonymity-safe: never
  // names the reporter or includes the narrative (the doctor signs in for details).
  // Best-effort, gated by EMAIL_SENDING_ENABLED.
  if (tgt[0].email) {
    void sendEmail({
      to: tgt[0].email as string,
      subject: `New ${polarity === "positive" ? "feedback" : "report"} on your Even profile`,
      html: wrapHtml("New feedback recorded", `<p>${polarity === "positive" ? "Positive feedback" : "A report"} has been recorded on your physician profile by a colleague.</p><p>Sign in to your physician portal to view the details.</p>`),
    }).catch(() => undefined);
  }

  return portalJson({ ok: true, incident: inserted[0] }, { headers: NO_STORE });
}
