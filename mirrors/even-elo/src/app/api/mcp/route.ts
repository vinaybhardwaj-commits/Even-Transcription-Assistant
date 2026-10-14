import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { verifyAccess } from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/**
 * Even Governance MCP server (Streamable-HTTP, stateless).
 *
 * A remote Model-Context-Protocol endpoint that lets an MCP client (Claude)
 * read and write the EPI / Surgical-Governance system directly. Hand-rolled
 * JSON-RPC over a single POST — no SDK, no session state, serverless-safe.
 *
 * Auth: a single secret bearer token (MCP_BEARER_TOKEN). Fail-closed: if the
 * env var is unset, every call is rejected. The token is a crown-jewel secret —
 * anyone holding it has full governance DB access.
 *
 * Identity: every write is attributed to a dedicated super_admin service
 * profile "Claude (MCP)" (claude-mcp@even.in) and recorded in audit_log_v2,
 * so changes made through this channel are always traceable + revertible.
 *
 * Allowlisted in middleware PUBLIC_API_ROUTES (it does its own bearer auth).
 */

const SERVER_INFO = { name: "even-governance", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2024-11-05";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

type Json = Record<string, unknown>;
type Row = Record<string, unknown>;
type Sql = any;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(["clinical","patient_safety","medical_error","professionalism","documentation","etiquette","vendor_compliance","other"]);
const SEVERITIES = new Set(["low","medium","high","critical"]);
const SOURCES = new Set(["patient","peer","governance"]);
const POLARITIES = new Set(["positive","negative"]);
const COMMENDATIONS = new Set(["Clinical Excellence","Patient Experience","Teamwork & Collaboration","Teaching & Mentorship","Going Above & Beyond"]);
const ENG_CATEGORIES = new Set(["provisional","active","visiting_consultant","locum_tenens","affiliate"]);

async function authOk(req: NextRequest): Promise<boolean> {
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!got) return false;
  const want = process.env.MCP_BEARER_TOKEN;
  if (want && got === want) return true;          // static secret (curl / fallback)
  return (await verifyAccess(got)) !== null;       // OAuth access token
}

function getSql(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not configured");
  return neon(url);
}

/** Lazily ensure the dedicated super_admin service actor exists; return its ids. */
async function ensureServiceActor(sql: Sql): Promise<{ id: string; position_label: string; hospital_id: string; hospital_code: string }> {
  const h = (await sql`SELECT id::text AS id, code FROM hospitals WHERE code='EHRC' AND is_active=true LIMIT 1`) as Row[];
  const hosp = h[0] ?? ((await sql`SELECT id::text AS id, code FROM hospitals WHERE is_active=true ORDER BY code LIMIT 1`) as Row[])[0];
  if (!hosp) throw new Error("no active hospital to anchor the service actor");
  const p = (await sql`SELECT id::text AS id, position_name FROM positions WHERE position_name='Committee Admin' LIMIT 1`) as Row[];
  const pos = p[0] ?? ((await sql`SELECT id::text AS id, position_name FROM positions WHERE active=true ORDER BY position_name LIMIT 1`) as Row[])[0];
  if (!pos) throw new Error("no position to anchor the service actor");
  await sql`
    INSERT INTO profiles (email, full_name, password_hash, position_id, hospital_id, status, is_super_admin)
    VALUES ('claude-mcp@even.in', 'Claude (MCP)', 'mcp-no-login', ${pos.id as string}::uuid, ${hosp.id as string}::uuid, 'active', true)
    ON CONFLICT (email) DO UPDATE SET is_super_admin=true, status='active', updated_at=now()
  `;
  const me = (await sql`SELECT id::text AS id FROM profiles WHERE email='claude-mcp@even.in' LIMIT 1`) as Row[];
  return { id: me[0].id as string, position_label: pos.position_name as string, hospital_id: hosp.id as string, hospital_code: hosp.code as string };
}

async function audit(sql: Sql, actorId: string, action: string, entity: string, entityId: string | null, after: Json): Promise<void> {
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (${actorId}::uuid, ${action}, ${entity}, ${entityId}, ${JSON.stringify(after)}::jsonb)
  `;
}

// ---- tool catalogue -------------------------------------------------------

const TOOLS = [
  { name: "search_physicians", description: "Search the physician roster by name/email/registration. Returns id, name, specialty, status, active hospitals.",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "search text (name/email/reg)" }, hospital_code: { type: "string" }, specialty: { type: "string" }, status: { type: "string", enum: ["active","terminated"] }, limit: { type: "number" } } } },
  { name: "get_physician", description: "Full record for one physician: core fields + engagements + privileges + recent incidents.",
    inputSchema: { type: "object", properties: { physician_id: { type: "string" } }, required: ["physician_id"] } },
  { name: "list_incidents", description: "List incidents/feedback, newest first. Optional filters.",
    inputSchema: { type: "object", properties: { physician_id: { type: "string" }, status: { type: "string", enum: ["open","closed","retracted"] }, severity: { type: "string", enum: ["low","medium","high","critical"] }, polarity: { type: "string", enum: ["positive","negative"] }, source: { type: "string" }, limit: { type: "number" } } } },
  { name: "list_hospitals", description: "List hospitals (code + name + active).", inputSchema: { type: "object", properties: {} } },
  { name: "list_positions", description: "List reporter positions (name + team).", inputSchema: { type: "object", properties: {} } },
  { name: "file_doctor_feedback", description: "File feedback/an incident on a physician via the governance feedback system. polarity 'negative' needs category+severity; 'positive' needs commendation_category. source 'patient' may include patient_rating 1-5. Recorded under the Claude (MCP) service actor.",
    inputSchema: { type: "object", properties: {
      target_physician_id: { type: "string" }, polarity: { type: "string", enum: ["positive","negative"] }, source: { type: "string", enum: ["patient","peer","governance"] },
      category: { type: "string", enum: ["clinical","patient_safety","medical_error","professionalism","documentation","etiquette","vendor_compliance","other"] },
      severity: { type: "string", enum: ["low","medium","high","critical"] },
      commendation_category: { type: "string", enum: ["Clinical Excellence","Patient Experience","Teamwork & Collaboration","Teaching & Mentorship","Going Above & Beyond"] },
      patient_rating: { type: "number" }, narrative: { type: "string" }, anonymous: { type: "boolean" }, hospital_code: { type: "string" } },
      required: ["target_physician_id","polarity","narrative"] } },
  { name: "add_physician", description: "Create a new physician (optionally engage at hospitals).",
    inputSchema: { type: "object", properties: { full_name: { type: "string" }, primary_specialty: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, registration_number: { type: "string" }, registration_council: { type: "string" }, hospital_codes: { type: "array", items: { type: "string" } }, category: { type: "string" } }, required: ["full_name"] } },
  { name: "add_engagement", description: "Add an active engagement for an existing physician at a hospital.",
    inputSchema: { type: "object", properties: { physician_id: { type: "string" }, hospital_code: { type: "string" }, category: { type: "string" } }, required: ["physician_id","hospital_code"] } },
  { name: "reply_to_incident", description: "Add a reply to an incident.",
    inputSchema: { type: "object", properties: { incident_id: { type: "string" }, reply_text: { type: "string" } }, required: ["incident_id","reply_text"] } },
  { name: "retract_incident", description: "Retract an incident with a reason.",
    inputSchema: { type: "object", properties: { incident_id: { type: "string" }, reason: { type: "string" } }, required: ["incident_id","reason"] } },
  { name: "list_incident_reports", description: "EHRC Incident Reporting system (incident.evenos.app — RCA/CAPA pipeline, ALL departments/staff; NOT the physician-feedback 'incidents' domain). List recent incident reports, newest first, with optional filters applied server-side in this tool.",
    inputSchema: { type: "object", properties: { status: { type: "string", description: "open|under_investigation|capa_assigned|closed|verified" }, severity: { type: "string", description: "negligible|minor|moderate|major|catastrophic" }, department: { type: "string", description: "substring match on department name" }, type: { type: "string", description: "substring match on incident type name" }, near_miss: { type: "boolean" }, limit: { type: "number" } } } },
  { name: "get_incident_report", description: "Full record for one incident report (<UNIT>-INC-YYYY-NNNN, e.g. EHRC-INC-2026-1166 or EHBR-INC-2026-0001): narrative, classification, lifecycle, RCA/CAPA, recurrence cluster context.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "incident_report_stats", description: "Incident-system dashboard stats: totals (open/near-miss/high-sev/with-RCA), CAPA counts, breakdowns by severity/status/type/department/impact, weekly series.",
    inputSchema: { type: "object", properties: {} } },
  { name: "list_incident_clusters", description: "Recurrence clusters (embedding-detected repeat incidents) — the 'keeps happening' leaderboard, highest recurrence first.",
    inputSchema: { type: "object", properties: {} } },
  { name: "update_incident_report", description: "Update an incident report's lifecycle status and/or owner. Audited. status one of open|under_investigation|capa_assigned|closed|verified.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, status: { type: "string" }, owner_name: { type: "string" } }, required: ["id"] } },
  { name: "list_rca_patterns", description: "Recurring ROOT-CAUSE patterns mined across RCA outputs (incident system) + the weak-CAPA signature (training/PPE-only share by department). The structural-governance signal layer: patterns that must be fixed structurally, not per-incident.",
    inputSchema: { type: "object", properties: {} } },
  { name: "scan_rca_patterns", description: "Run the RCA pattern miner now (embeds un-patterned RCAs, clusters into patterns). Safe to re-run; processes up to 200.",
    inputSchema: { type: "object", properties: {} } },
  { name: "delete_incident_report", description: "PERMANENTLY delete an incident report (<UNIT>-INC-YYYY-NNNN) with full cascade: RCAs, CAPAs, audit rows, cluster repair. For test/smoke rows — deliberately has NO UI. Requires confirm=true. Irreversible; audited on both sides.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, confirm: { type: "boolean" } }, required: ["id","confirm"] } },
  { name: "list_portal_announcements", description: "List Doctor-Portal What's-new / Coming-soon announcements (portal_announcements). Shows active + inactive with ids.",
    inputSchema: { type: "object", properties: { include_inactive: { type: "boolean" } } } },
  { name: "add_portal_announcement", description: "Publish an announcement to the Doctor Portal home. kind 'whats_new' or 'coming_soon'; active defaults true; optional starts_on/ends_on (YYYY-MM-DD) and sort.",
    inputSchema: { type: "object", properties: { kind: { type: "string" }, title: { type: "string" }, body: { type: "string" }, active: { type: "boolean" }, starts_on: { type: "string" }, ends_on: { type: "string" }, sort: { type: "number" } }, required: ["kind","title"] } },
  { name: "retire_portal_announcement", description: "Deactivate (retire) a portal announcement by id, or reactivate with active=true.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, active: { type: "boolean" } }, required: ["id"] } },
  { name: "sql_query", description: "Run a read-only SELECT/WITH query against the governance DB. Auto-capped to 500 rows. Use for any read the typed tools don't cover.",
    inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
  { name: "sql_execute", description: "FULL POWER: run an arbitrary write/DDL SQL statement (INSERT/UPDATE/DELETE/ALTER/...). Requires confirm=true. Logged to audit_log_v2. Use with care — this bypasses app validation.",
    inputSchema: { type: "object", properties: { sql: { type: "string" }, confirm: { type: "boolean" } }, required: ["sql","confirm"] } },
];

// ---- tool implementations -------------------------------------------------

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
function rowsOf(r: unknown): Row[] { if (Array.isArray(r)) return r as Row[]; const o = r as { rows?: Row[] }; return o?.rows ?? []; }

async function runTool(name: string, args: Json, sql: Sql): Promise<unknown> {
  const actor = await ensureServiceActor(sql);

  switch (name) {
    case "search_physicians": {
      const q = s(args.q); const hc = s(args.hospital_code).toUpperCase(); const sp = s(args.specialty); const st = s(args.status);
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
      const rows = (await sql`
        WITH eng AS (
          SELECT e.physician_id, STRING_AGG(DISTINCT h.code, ', ' ORDER BY h.code) AS hospitals_active
          FROM physician_engagements e JOIN hospitals h ON h.id=e.hospital_id WHERE e.status='active' GROUP BY e.physician_id)
        SELECT p.id::text AS id, p.full_name, p.primary_specialty, p.current_status, p.email, eng.hospitals_active
        FROM physicians p LEFT JOIN eng ON eng.physician_id=p.id
        WHERE (${q}='' OR p.full_name ILIKE ${'%'+q+'%'} OR p.email ILIKE ${'%'+q+'%'} OR p.registration_number ILIKE ${'%'+q+'%'})
          AND (${sp}='' OR p.primary_specialty=${sp})
          AND (${st}='' OR p.current_status=${st})
          AND (${hc}='' OR ${hc}=ANY(STRING_TO_ARRAY(eng.hospitals_active, ', ')))
        ORDER BY p.full_name ASC LIMIT ${limit}`) as Row[];
      return { count: rows.length, physicians: rows };
    }
    case "get_physician": {
      const id = s(args.physician_id);
      if (!UUID_RE.test(id)) throw new Error("valid physician_id required");
      const phys = (await sql`SELECT id::text AS id, full_name, preferred_name, primary_specialty, registration_number, registration_council, registration_expiry, indemnity_expiry, email, phone, current_status, date_joined_network, notes FROM physicians WHERE id=${id}::uuid`) as Row[];
      if (phys.length === 0) throw new Error("physician not found");
      const engagements = (await sql`SELECT e.id::text AS id, h.code AS hospital_code, e.category, e.status, e.status_reason, e.start_date, e.specialty FROM physician_engagements e JOIN hospitals h ON h.id=e.hospital_id WHERE e.physician_id=${id}::uuid ORDER BY e.start_date DESC`) as Row[];
      const privileges = (await sql`SELECT pr.id::text AS id, h.code AS hospital_code, pr.procedure_or_specialty, pr.is_core, pr.expires_at, pr.withdrawn_date FROM privileges pr JOIN hospitals h ON h.id=pr.hospital_id WHERE pr.physician_id=${id}::uuid ORDER BY pr.granted_date DESC`) as Row[];
      const incidents = (await sql`SELECT id::text AS id, polarity, source, category, severity, status, LEFT(narrative,160) AS narrative_preview, submitted_at FROM incidents WHERE target_physician_id=${id}::uuid ORDER BY submitted_at DESC LIMIT 25`) as Row[];
      return { physician: phys[0], engagements, privileges, recent_incidents: incidents };
    }
    case "list_incidents": {
      const pid = s(args.physician_id); const st = s(args.status); const sev = s(args.severity); const pol = s(args.polarity); const src = s(args.source);
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
      const rows = (await sql`
        SELECT i.id::text AS id, ph.full_name AS physician_name, i.polarity, i.source, i.category, i.severity, i.status,
               i.anonymous_flag, i.reporter_name, i.reporter_email, i.submitter_position_at_time, LEFT(i.narrative,200) AS narrative_preview, i.submitted_at
        FROM incidents i JOIN physicians ph ON ph.id=i.target_physician_id
        WHERE (${pid}='' OR i.target_physician_id=${pid || '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${st}='' OR i.status=${st}) AND (${sev}='' OR i.severity=${sev})
          AND (${pol}='' OR i.polarity=${pol}) AND (${src}='' OR i.source=${src})
        ORDER BY i.submitted_at DESC LIMIT ${limit}`) as Row[];
      return { count: rows.length, incidents: rows };
    }
    case "list_hospitals":
      return { hospitals: (await sql`SELECT code, name, is_active FROM hospitals ORDER BY code`) as Row[] };
    case "list_positions":
      return { positions: (await sql`SELECT position_name, team, active FROM positions ORDER BY position_name`) as Row[] };

    case "file_doctor_feedback": {
      const target = s(args.target_physician_id);
      if (!UUID_RE.test(target)) throw new Error("valid target_physician_id required");
      const polarity = POLARITIES.has(s(args.polarity)) ? s(args.polarity) : "negative";
      const source = SOURCES.has(s(args.source)) ? s(args.source) : "peer";
      const narrative = s(args.narrative);
      if (!narrative) throw new Error("narrative required");
      let categoryValue: string | null = null, severityValue: string | null = null, commendationValue: string | null = null;
      if (polarity === "negative") {
        const c = s(args.category), sev = s(args.severity);
        if (!CATEGORIES.has(c)) throw new Error("category must be one of: " + Array.from(CATEGORIES).join(", "));
        if (!SEVERITIES.has(sev)) throw new Error("severity must be low|medium|high|critical");
        categoryValue = c; severityValue = sev;
      } else {
        const cc = s(args.commendation_category);
        if (!COMMENDATIONS.has(cc)) throw new Error("commendation_category required for positive feedback");
        commendationValue = cc;
      }
      let ratingValue: number | null = null;
      if (source === "patient" && args.patient_rating != null && args.patient_rating !== "") {
        const n = Number(args.patient_rating);
        if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error("patient_rating must be an integer 1-5");
        ratingValue = n;
      }
      // resolve hospital from the physician's active engagements (or explicit code)
      const phys = (await sql`SELECT p.full_name, COALESCE((SELECT json_agg(json_build_object('hospital_id', e.hospital_id::text, 'code', h.code) ORDER BY e.start_date DESC) FROM physician_engagements e JOIN hospitals h ON h.id=e.hospital_id WHERE e.physician_id=p.id AND e.status='active'), '[]'::json) AS hospitals FROM physicians p WHERE p.id=${target}::uuid`) as Row[];
      if (phys.length === 0) throw new Error("target physician not found");
      const hospitals = (phys[0].hospitals as Array<{ hospital_id: string; code: string }>) ?? [];
      if (hospitals.length === 0) throw new Error("target physician has no active engagement to anchor the hospital");
      const wantCode = s(args.hospital_code).toUpperCase();
      const chosen = (wantCode && hospitals.find((h) => h.code === wantCode)) || hospitals[0];
      const ins = (await sql`
        INSERT INTO incidents (target_physician_id, submitter_user_id, submitter_position_at_time, anonymous_flag, hospital_id, polarity, source, category, severity, commendation_category, patient_rating, narrative)
        VALUES (${target}::uuid, ${actor.id}::uuid, ${actor.position_label}, ${Boolean(args.anonymous)}, ${chosen.hospital_id}::uuid, ${polarity}, ${source}, ${categoryValue}, ${severityValue}, ${commendationValue}, ${ratingValue}, ${narrative})
        RETURNING id::text AS id, submitted_at`) as Row[];
      await audit(sql, actor.id, "create", "incident", ins[0].id as string, { via: "mcp", target_physician: phys[0].full_name, polarity, source, category: categoryValue, severity: severityValue, commendation_category: commendationValue });
      return { ok: true, incident_id: ins[0].id, hospital_code: chosen.code, polarity, source };
    }

    case "add_physician": {
      const full_name = s(args.full_name);
      if (!full_name) throw new Error("full_name required");
      const rawCat = s(args.category); const cat = ENG_CATEGORIES.has(rawCat) ? rawCat : "active";
      const email = s(args.email).toLowerCase() || null;
      const ins = (await sql`
        INSERT INTO physicians (full_name, primary_specialty, registration_number, registration_council, email, phone, date_joined_network, current_status)
        VALUES (${full_name}, ${s(args.primary_specialty) || null}, ${s(args.registration_number) || null}, ${s(args.registration_council) || null}, ${email}, ${s(args.phone) || null}, ${new Date().toISOString().slice(0,10)}, 'active')
        RETURNING id::text AS id, full_name`) as Row[];
      const physicianId = ins[0].id as string;
      await audit(sql, actor.id, "create", "physician", physicianId, { via: "mcp", full_name });
      const codes = Array.isArray(args.hospital_codes) ? (args.hospital_codes as unknown[]).map((c) => String(c).toUpperCase()) : [];
      const engaged: string[] = [];
      for (const code of codes) {
        const h = (await sql`SELECT id::text AS id FROM hospitals WHERE code=${code} AND is_active=true LIMIT 1`) as Row[];
        if (h.length === 0) continue;
        await sql`INSERT INTO physician_engagements (physician_id, hospital_id, category, start_date, specialty, status) VALUES (${physicianId}::uuid, ${h[0].id as string}::uuid, ${cat}, ${new Date().toISOString().slice(0,10)}, ${s(args.primary_specialty) || null}, 'active')`;
        engaged.push(code);
        await audit(sql, actor.id, "create", "physician_engagement", physicianId, { via: "mcp", hospital_code: code, category: cat });
      }
      return { ok: true, physician_id: physicianId, engaged_hospitals: engaged };
    }
    case "add_engagement": {
      const pid = s(args.physician_id); const code = s(args.hospital_code).toUpperCase();
      if (!UUID_RE.test(pid)) throw new Error("valid physician_id required");
      const cat = ENG_CATEGORIES.has(s(args.category)) ? s(args.category) : "active";
      const h = (await sql`SELECT id::text AS id FROM hospitals WHERE code=${code} AND is_active=true LIMIT 1`) as Row[];
      if (h.length === 0) throw new Error("unknown/inactive hospital: " + code);
      const exists = (await sql`SELECT 1 FROM physician_engagements WHERE physician_id=${pid}::uuid AND hospital_id=${h[0].id as string}::uuid AND status='active' LIMIT 1`) as Row[];
      if (exists.length > 0) return { ok: true, already_engaged: true, hospital_code: code };
      await sql`INSERT INTO physician_engagements (physician_id, hospital_id, category, start_date, status) VALUES (${pid}::uuid, ${h[0].id as string}::uuid, ${cat}, ${new Date().toISOString().slice(0,10)}, 'active')`;
      await audit(sql, actor.id, "create", "physician_engagement", pid, { via: "mcp", hospital_code: code, category: cat });
      return { ok: true, hospital_code: code, category: cat };
    }
    case "reply_to_incident": {
      const iid = s(args.incident_id); const text = s(args.reply_text);
      if (!UUID_RE.test(iid)) throw new Error("valid incident_id required");
      if (!text) throw new Error("reply_text required");
      const r = (await sql`INSERT INTO incident_replies (incident_id, replied_by_profile_id, reply_text) VALUES (${iid}::uuid, ${actor.id}::uuid, ${text}) RETURNING id::text AS id`) as Row[];
      await audit(sql, actor.id, "create", "incident_reply", r[0].id as string, { via: "mcp", incident_id: iid });
      return { ok: true, reply_id: r[0].id };
    }
    case "retract_incident": {
      const iid = s(args.incident_id); const reason = s(args.reason);
      if (!UUID_RE.test(iid)) throw new Error("valid incident_id required");
      if (!reason) throw new Error("reason required");
      const r = (await sql`UPDATE incidents SET status='retracted', retracted_by=${actor.id}::uuid, retracted_at=now(), retraction_reason=${reason}, updated_at=now() WHERE id=${iid}::uuid RETURNING id::text AS id`) as Row[];
      if (r.length === 0) throw new Error("incident not found");
      await audit(sql, actor.id, "retract", "incident", iid, { via: "mcp", reason });
      return { ok: true, incident_id: iid, status: "retracted" };
    }

    case "list_incident_reports":
    case "get_incident_report":
    case "incident_report_stats":
    case "list_incident_clusters":
    case "update_incident_report":
    case "list_rca_patterns":
    case "scan_rca_patterns":
    case "delete_incident_report": {
      // Incident system lives in its OWN Neon DB (even-incident) — all access via
      // its API with the cross-app service token (never via this DB).
      const IBASE = process.env.INCIDENT_API_BASE;
      const ITOK = process.env.INCIDENT_API_TOKEN;
      if (!IBASE || !ITOK) throw new Error("Incident API not configured (INCIDENT_API_BASE/TOKEN)");
      const ifetch = async (path: string, init?: RequestInit) => {
        const res = await fetch(`${IBASE}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${ITOK}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        });
        const j = (await res.json()) as Record<string, unknown>;
        if (!res.ok || j.ok === false) throw new Error(`incident API ${res.status}: ${String(j.error ?? "")}`.trim());
        return j;
      };

      if (name === "incident_report_stats") return await ifetch("/api/office/stats");
      if (name === "list_rca_patterns") return await ifetch("/api/office/rca-patterns");
      if (name === "scan_rca_patterns") return await ifetch("/api/office/rca-patterns/scan", { method: "POST" });
      if (name === "delete_incident_report") {
        const id = s(args.id).toUpperCase();
        if (!/^[A-Z]{4}-INC-\d{4}-\d{1,6}$/.test(id)) throw new Error("id must look like EHRC-INC-2026-0001 (any 4-letter unit prefix: EHRC, EHBR, EHIN, EHBO, EHSB)");
        if (args.confirm !== true) throw new Error("Refusing: irreversible delete requires confirm=true");
        const r = await ifetch(`/api/office/incidents/${encodeURIComponent(id)}`, { method: "DELETE" });
        await audit(sql, actor.id, "delete", "incident_report", id, { via: "mcp", cascade: r });
        return r;
      }
      if (name === "list_incident_clusters") return await ifetch("/api/office/clusters");
      if (name === "get_incident_report") {
        const id = s(args.id).toUpperCase();
        if (!/^[A-Z]{4}-INC-\d{4}-\d{1,6}$/.test(id)) throw new Error("id must look like EHRC-INC-2026-0001 (any 4-letter unit prefix: EHRC, EHBR, EHIN, EHBO, EHSB)");
        return await ifetch(`/api/office/incidents/${encodeURIComponent(id)}`);
      }
      if (name === "update_incident_report") {
        const id = s(args.id).toUpperCase();
        if (!/^[A-Z]{4}-INC-\d{4}-\d{1,6}$/.test(id)) throw new Error("id must look like EHRC-INC-2026-0001 (any 4-letter unit prefix: EHRC, EHBR, EHIN, EHBO, EHSB)");
        const body: Record<string, unknown> = {};
        if (s(args.status)) body.status = s(args.status);
        if (args.owner_name !== undefined) body.owner_name = s(args.owner_name) || null;
        if (Object.keys(body).length === 0) throw new Error("provide status and/or owner_name");
        const r = await ifetch(`/api/office/incidents/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
        await audit(sql, actor.id, "update", "incident_report", id, { via: "mcp", ...body });
        return r;
      }
      // list_incident_reports — upstream returns newest 300; filter here
      const j = await ifetch("/api/office/incidents");
      let rows = (j.incidents as Array<Record<string, unknown>>) ?? [];
      const fStatus = s(args.status); const fSev = s(args.severity);
      const fDept = s(args.department).toLowerCase(); const fType = s(args.type).toLowerCase();
      if (fStatus) rows = rows.filter((r) => r.status === fStatus);
      if (fSev) rows = rows.filter((r) => r.severity === fSev);
      if (fDept) rows = rows.filter((r) => String(r.dept_name ?? "").toLowerCase().includes(fDept));
      if (fType) rows = rows.filter((r) => String(r.type_name ?? "").toLowerCase().includes(fType));
      if (typeof args.near_miss === "boolean") rows = rows.filter((r) => r.near_miss === args.near_miss);
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));
      return { ok: true, count: rows.length, incidents: rows.slice(0, limit) };
    }

    case "list_portal_announcements": {
      const inactive = args.include_inactive === true;
      const rows = (await sql`
        SELECT id::text AS id, kind, title, body, active, starts_on::text AS starts_on, ends_on::text AS ends_on, sort, created_by, created_at
        FROM portal_announcements
        WHERE (${inactive} OR active = true)
        ORDER BY kind, sort ASC, created_at DESC LIMIT 100`) as Row[];
      return { ok: true, announcements: rows };
    }

    case "add_portal_announcement": {
      const kind = s(args.kind);
      if (kind !== "whats_new" && kind !== "coming_soon") throw new Error("kind must be 'whats_new' or 'coming_soon'");
      const title = s(args.title);
      if (!title) throw new Error("title required");
      const body = s(args.body) || null;
      const active = args.active !== false;
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      const startsOn = DATE_RE.test(s(args.starts_on)) ? s(args.starts_on) : null;
      const endsOn = DATE_RE.test(s(args.ends_on)) ? s(args.ends_on) : null;
      const sort = Number.isFinite(Number(args.sort)) ? Number(args.sort) : 0;
      const ins = (await sql`
        INSERT INTO portal_announcements (kind, title, body, active, starts_on, ends_on, sort, created_by)
        VALUES (${kind}, ${title}, ${body}, ${active}, ${startsOn}::date, ${endsOn}::date, ${sort}, 'claude-mcp@even.in')
        RETURNING id::text AS id`) as Row[];
      await audit(sql, actor.id, "create", "portal_announcement", ins[0].id as string, { via: "mcp", kind, title, active });
      return { ok: true, id: ins[0].id, kind, title, active };
    }

    case "retire_portal_announcement": {
      const id = s(args.id);
      if (!UUID_RE.test(id)) throw new Error("valid id required (from list_portal_announcements)");
      const active = args.active === true;
      const r = (await sql`UPDATE portal_announcements SET active=${active} WHERE id=${id}::uuid RETURNING id::text AS id, title, active`) as Row[];
      if (r.length === 0) throw new Error("announcement not found");
      await audit(sql, actor.id, "update", "portal_announcement", id, { via: "mcp", active });
      return { ok: true, ...r[0] };
    }

    case "sql_query": {
      let q = s(args.sql);
      if (!q) throw new Error("sql required");
      const head = q.replace(/^[\s(]+/, "").slice(0, 6).toLowerCase();
      if (!(head.startsWith("select") || head.startsWith("with"))) throw new Error("sql_query is read-only — use SELECT/WITH (use sql_execute for writes)");
      if (/;\s*\S/.test(q.replace(/;\s*$/, ""))) throw new Error("single statement only");
      if (/\b(insert|update|delete|drop|alter|truncate|grant|revoke|create)\b/i.test(q)) throw new Error("write keyword detected — use sql_execute");
      if (!/\blimit\b/i.test(q)) q = q.replace(/;?\s*$/, "") + " LIMIT 500";
      const rows = rowsOf(await sql(q));
      return { row_count: rows.length, rows };
    }
    case "sql_execute": {
      const q = s(args.sql);
      if (!q) throw new Error("sql required");
      if (args.confirm !== true) throw new Error("refusing to run a write without confirm=true");
      const res = await sql(q);
      const rows = rowsOf(res);
      await audit(sql, actor.id, "sql_execute", "raw_sql", null, { via: "mcp", sql: q.slice(0, 2000) });
      return { ok: true, row_count: rows.length, rows: rows.slice(0, 200) };
    }

    default:
      throw new Error("unknown tool: " + name);
  }
}

// ---- JSON-RPC plumbing ----------------------------------------------------

interface RpcMsg { jsonrpc?: string; id?: unknown; method?: string; params?: Json; }

async function handleMessage(msg: RpcMsg, sql: Sql): Promise<Json | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (payload: Json): Json => ({ jsonrpc: "2.0", id: msg.id ?? null, ...payload });

  try {
    switch (msg.method) {
      case "initialize": {
        const pv = (msg.params?.protocolVersion as string) || DEFAULT_PROTOCOL;
        return reply({ result: { protocolVersion: pv, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO } });
      }
      case "ping":
        return reply({ result: {} });
      case "tools/list":
        return reply({ result: { tools: TOOLS } });
      case "tools/call": {
        const toolName = String(msg.params?.name ?? "");
        const toolArgs = (msg.params?.arguments as Json) ?? {};
        try {
          const out = await runTool(toolName, toolArgs, sql);
          return reply({ result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: false } });
        } catch (e) {
          return reply({ result: { content: [{ type: "text", text: "Error: " + (e instanceof Error ? e.message : String(e)) }], isError: true } });
        }
      }
      default:
        if (isNotification) return null; // notifications/initialized, notifications/cancelled, etc.
        return reply({ error: { code: -32601, message: "Method not found: " + msg.method } });
    }
  } catch (e) {
    if (isNotification) return null;
    return reply({ error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
}

export async function POST(req: NextRequest) {
  if (!(await authOk(req))) {
    const rm = `https://${req.headers.get("host")}/.well-known/oauth-protected-resource`;
    return new NextResponse(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${rm}"`, ...NO_STORE } });
  }
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: NO_STORE }); }

  let sql: Sql;
  try { sql = getSql(); }
  catch (e) { return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: e instanceof Error ? e.message : "db error" } }, { status: 500, headers: NO_STORE }); }

  if (Array.isArray(body)) {
    const out: Json[] = [];
    for (const m of body) { const r = await handleMessage(m as RpcMsg, sql); if (r) out.push(r); }
    if (out.length === 0) return new NextResponse(null, { status: 202, headers: NO_STORE });
    return NextResponse.json(out, { headers: NO_STORE });
  }
  const r = await handleMessage(body as RpcMsg, sql);
  if (!r) return new NextResponse(null, { status: 202, headers: NO_STORE });
  return NextResponse.json(r, { headers: NO_STORE });
}

export async function GET() {
  return new NextResponse(JSON.stringify({ ok: true, server: SERVER_INFO, transport: "streamable-http", note: "POST JSON-RPC with Authorization: Bearer <token>" }), { status: 200, headers: { "Content-Type": "application/json", ...NO_STORE } });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type" } });
}
