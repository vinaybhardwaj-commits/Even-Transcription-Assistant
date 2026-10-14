import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Portal incident submission (R5 PRD §3) → even-incident Ask A.
 * Contract: EVEN-INCIDENT-PORTAL-INTAKE-CONTRACT-v1.0.md. Physician-session
 * authed; identity is built SERVER-SIDE from the session (the client only
 * sends the tier) so a doctor cannot submit as someone else. Token never
 * reaches the browser. channel is pinned to "doctor_portal".
 */
const BASE = process.env.INCIDENT_API_BASE;
const TOK = process.env.INCIDENT_API_TOKEN;
const ENABLED = () => process.env.PORTAL_INCIDENTS === "1";

const SEVERITIES = new Set(["negligible", "minor", "moderate", "major", "catastrophic"]);
const IMPACTS = new Set(["patient", "staff", "visitor", "property_asset", "operations", "data_privacy", "environment", "none"]);
const TIERS = new Set(["named", "confidential", "anonymous"]);

export async function POST(req: NextRequest) {
  const p = await getCurrentPhysician();
  if (!p) return portalJson({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!ENABLED() || !BASE || !TOK) {
    return portalJson({ ok: false, error: "Incident reporting is not enabled yet" }, { status: 404 });
  }
  let body: {
    tier?: string;
    incident?: {
      narrative?: string; class?: string; department?: string; location?: string;
      occurred_at?: string; severity?: string; potential_severity?: string;
      near_miss?: boolean; impact_domain?: string; immediate_action?: string;
    };
  };
  try {
    body = await req.json();
  } catch {
    return portalJson({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const tier = TIERS.has(body.tier ?? "") ? (body.tier as string) : "named";
  const inc = body.incident ?? {};
  if (!inc.narrative || inc.narrative.trim().length < 10) {
    return portalJson({ ok: false, error: "Please describe what happened (at least 10 characters)." }, { status: 400 });
  }
  const reporter =
    tier === "anonymous"
      ? { tier }
      : {
          tier,
          name: p.full_name,
          external_ref: `epi:${p.physicianId}`,
          ...(tier === "confidential" && p.email ? { email: p.email } : {}),
        };
  const payload = {
    channel: "doctor_portal",
    reporter,
    incident: {
      narrative: inc.narrative.trim().slice(0, 8000),
      class: inc.class || undefined,
      department: inc.department || undefined,
      location: inc.location || undefined,
      occurred_at: inc.occurred_at || undefined,
      severity: SEVERITIES.has(inc.severity ?? "") ? inc.severity : undefined,
      potential_severity: SEVERITIES.has(inc.potential_severity ?? "") ? inc.potential_severity : undefined,
      near_miss: inc.near_miss === true,
      impact_domain: IMPACTS.has(inc.impact_domain ?? "") ? inc.impact_domain : undefined,
      immediate_action: inc.immediate_action ? String(inc.immediate_action).slice(0, 2000) : undefined,
    },
  };
  try {
    const res = await fetch(`${BASE}/api/intake/portal`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    const j = await res.json();
    return portalJson(j, { status: res.status });
  } catch {
    return portalJson({ ok: false, error: "Incident system unreachable — please try again." }, { status: 502 });
  }
}
