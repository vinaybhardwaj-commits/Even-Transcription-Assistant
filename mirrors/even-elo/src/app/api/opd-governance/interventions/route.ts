import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KINDS = new Set(["huddle_briefing", "supportive_1to1", "spot_audit", "emr_ask", "other"]);

/**
 * gov_interventions (PRD §6.4) — EPI's system of record for governance action
 * on OPD signals. Any active user may log (V ruling: SGO full access).
 * Plain HTML form POST → insert → redirect back to /opd-governance.
 */
export async function POST(req: NextRequest) {
  const u = await getCurrentUser();
  if (!u || u.status !== "active") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const form = await req.formData();
  const signalKey = String(form.get("signal_key") || "").slice(0, 80);
  const signalLabel = String(form.get("signal_label") || "").slice(0, 120) || null;
  const kind = String(form.get("kind") || "");
  const note = String(form.get("note") || "").slice(0, 2000) || null;
  const physicianId = String(form.get("physician_id") || "") || null;
  if (!signalKey || !KINDS.has(kind)) {
    return NextResponse.json({ ok: false, error: "signal_key and a valid kind are required" }, { status: 400 });
  }
  await sql`
    INSERT INTO gov_interventions (signal_key, signal_label, kind, note, physician_id, actor_email)
    VALUES (${signalKey}, ${signalLabel}, ${kind}, ${note}, ${physicianId ? physicianId : null}::uuid, ${u.email})`;
  return NextResponse.redirect(new URL("/opd-governance?logged=1", req.url), 303);
}

export async function GET(req: NextRequest) {
  const u = await getCurrentUser();
  if (!u || u.status !== "active") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const key = req.nextUrl.searchParams.get("signal_key");
  // Governance rulings CDMSS has not confirmed (pending) or refused are not interventions that happened:
  // they are left out. Before migration 037 there is no sync column, so fall back to the plain list.
  let rows: unknown[];
  try {
    rows = key
      ? await sql`SELECT i.*, p.full_name FROM gov_interventions i LEFT JOIN physicians p ON p.id=i.physician_id WHERE i.signal_key=${key} AND (i.cdmss_sync_state IS NULL OR i.cdmss_sync_state = 'synced') ORDER BY i.done_on DESC LIMIT 50`
      : await sql`SELECT i.*, p.full_name FROM gov_interventions i LEFT JOIN physicians p ON p.id=i.physician_id WHERE i.cdmss_sync_state IS NULL OR i.cdmss_sync_state = 'synced' ORDER BY i.done_on DESC LIMIT 50`;
  } catch {
    rows = key
      ? await sql`SELECT i.*, p.full_name FROM gov_interventions i LEFT JOIN physicians p ON p.id=i.physician_id WHERE i.signal_key=${key} ORDER BY i.done_on DESC LIMIT 50`
      : await sql`SELECT i.*, p.full_name FROM gov_interventions i LEFT JOIN physicians p ON p.id=i.physician_id ORDER BY i.done_on DESC LIMIT 50`;
  }
  return NextResponse.json({ ok: true, interventions: rows });
}
