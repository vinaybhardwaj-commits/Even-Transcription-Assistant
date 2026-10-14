// POST /api/service/observations — server-to-server intake for the EHRC
// Daily Dash governance module (GV.3).
//
// HOD morning-form answers about physicians (OT conduct, late starts,
// anaesthesia issues, commendations…) are auto-filed here as incidents /
// positive observations. Bearer-gated by SERVICE_OBSERVATIONS_SECRET and
// recorded under the dedicated service actor "Daily Dash (system)"
// (daily-dash@even.in) with a full audit_log_v2 trail — same pattern as the
// Claude (MCP) actor. Allowlisted in middleware (does its own auth).

import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = Record<string, unknown>;
type Sql = ReturnType<typeof neon>;
type Json = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(["clinical","patient_safety","medical_error","professionalism","documentation","etiquette","vendor_compliance","other"]);
const SEVERITIES = new Set(["low","medium","high","critical"]);
const POLARITIES = new Set(["positive","negative"]);
const COMMENDATIONS = new Set(["Clinical Excellence","Patient Experience","Teamwork & Collaboration","Teaching & Mentorship","Going Above & Beyond"]);

function db(): Sql {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL not configured");
  return neon(url);
}

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

async function ensureDailyDashActor(sql: Sql): Promise<{ id: string; position_label: string }> {
  const h = (await sql`SELECT id::text AS id FROM hospitals WHERE code='EHRC' AND is_active=true LIMIT 1`) as Row[];
  const hosp = h[0] ?? ((await sql`SELECT id::text AS id FROM hospitals WHERE is_active=true ORDER BY code LIMIT 1`) as Row[])[0];
  if (!hosp) throw new Error("no active hospital to anchor the service actor");
  const p = (await sql`SELECT id::text AS id, position_name FROM positions WHERE position_name='Committee Admin' LIMIT 1`) as Row[];
  const pos = p[0] ?? ((await sql`SELECT id::text AS id, position_name FROM positions WHERE active=true ORDER BY position_name LIMIT 1`) as Row[])[0];
  if (!pos) throw new Error("no position to anchor the service actor");
  await sql`
    INSERT INTO profiles (email, full_name, password_hash, position_id, hospital_id, status, is_super_admin)
    VALUES ('daily-dash@even.in', 'Daily Dash (system)', 'service-no-login', ${pos.id as string}::uuid, ${hosp.id as string}::uuid, 'active', false)
    ON CONFLICT (email) DO UPDATE SET status='active', updated_at=now()
  `;
  const me = (await sql`SELECT id::text AS id FROM profiles WHERE email='daily-dash@even.in' LIMIT 1`) as Row[];
  return { id: me[0].id as string, position_label: pos.position_name as string };
}

async function audit(sql: Sql, actorId: string, action: string, entity: string, entityId: string | null, after: Json): Promise<void> {
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (${actorId}::uuid, ${action}, ${entity}, ${entityId}, ${JSON.stringify(after)}::jsonb)
  `;
}

export async function POST(req: NextRequest) {
  const secret = process.env.SERVICE_OBSERVATIONS_SECRET;
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!secret || got !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Json;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 }); }

  try {
    const sql = db();
    const target = s(body.physician_id);
    if (!UUID_RE.test(target)) return NextResponse.json({ ok: false, error: "valid physician_id required" }, { status: 400 });

    // kind:'note' — append a dated digest line to the physician's notes
    // (used by the Daily Dash nightly per-physician digest; no incident row)
    if (s(body.kind) === "note") {
      const line = s(body.narrative);
      if (!line) return NextResponse.json({ ok: false, error: "narrative required" }, { status: 400 });
      const ph = (await sql`SELECT full_name FROM physicians WHERE id=${target}::uuid`) as Row[];
      if (ph.length === 0) return NextResponse.json({ ok: false, error: "physician not found" }, { status: 404 });
      await sql`UPDATE physicians SET notes = COALESCE(notes, '') || ${"\n" + line}, updated_at = now() WHERE id=${target}::uuid`;
      const actor = await ensureDailyDashActor(sql);
      await audit(sql, actor.id, "update", "physician", target, { via: "daily_dash_gv", note_appended: line.slice(0, 200) });
      return NextResponse.json({ ok: true, kind: "note" });
    }

    const polarity = POLARITIES.has(s(body.polarity)) ? s(body.polarity) : "negative";
    const narrative = s(body.narrative);
    if (!narrative) return NextResponse.json({ ok: false, error: "narrative required" }, { status: 400 });

    let categoryValue: string | null = null, severityValue: string | null = null, commendationValue: string | null = null;
    if (polarity === "negative") {
      const c = s(body.category), sev = s(body.severity);
      categoryValue = CATEGORIES.has(c) ? c : "professionalism";
      severityValue = SEVERITIES.has(sev) ? sev : "low";
    } else {
      const cc = s(body.commendation_category);
      commendationValue = COMMENDATIONS.has(cc) ? cc : "Going Above & Beyond";
    }

    const phys = (await sql`
      SELECT p.full_name,
        COALESCE((SELECT json_agg(json_build_object('hospital_id', e.hospital_id::text, 'code', h.code) ORDER BY e.start_date DESC)
          FROM physician_engagements e JOIN hospitals h ON h.id=e.hospital_id
          WHERE e.physician_id=p.id AND e.status='active'), '[]'::json) AS hospitals
      FROM physicians p WHERE p.id=${target}::uuid`) as Row[];
    if (phys.length === 0) return NextResponse.json({ ok: false, error: "physician not found" }, { status: 404 });
    let hospitals = (phys[0].hospitals as Array<{ hospital_id: string; code: string }>) ?? [];
    if (hospitals.length === 0) {
      // physician without an active engagement: anchor on the requested/EHRC hospital
      const code = (s(body.hospital_code) || "EHRC").toUpperCase();
      const hh = (await sql`SELECT id::text AS id, code FROM hospitals WHERE code=${code} AND is_active=true LIMIT 1`) as Row[];
      if (hh.length === 0) return NextResponse.json({ ok: false, error: "physician has no active engagement and hospital_code unknown" }, { status: 422 });
      hospitals = [{ hospital_id: hh[0].id as string, code: hh[0].code as string }];
    }
    const wantCode = s(body.hospital_code).toUpperCase();
    const chosen = (wantCode && hospitals.find((x) => x.code === wantCode)) || hospitals[0];

    const actor = await ensureDailyDashActor(sql);
    const ins = (await sql`
      INSERT INTO incidents (target_physician_id, submitter_user_id, submitter_position_at_time, anonymous_flag, hospital_id, polarity, source, category, severity, commendation_category, narrative)
      VALUES (${target}::uuid, ${actor.id}::uuid, ${actor.position_label}, false, ${chosen.hospital_id}::uuid, ${polarity}, ${'governance'}, ${categoryValue}, ${severityValue}, ${commendationValue}, ${narrative})
      RETURNING id::text AS id, submitted_at`) as Row[];

    await audit(sql, actor.id, "create", "incident", ins[0].id as string, {
      via: "daily_dash_gv",
      target_physician: phys[0].full_name,
      polarity, category: categoryValue, severity: severityValue, commendation_category: commendationValue,
      context: (body.context as Json) ?? null,
      dedup_key: s(body.dedup_key) || null,
    });

    return NextResponse.json({ ok: true, incident_id: ins[0].id, hospital_code: chosen.code, polarity });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
