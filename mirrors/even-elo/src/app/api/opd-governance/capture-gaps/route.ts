import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Capture-gap register status updates (PRD §6.6). super_admin only. Form POST → redirect. */
export async function POST(req: NextRequest) {
  const u = await getCurrentUser();
  if (!u || u.status !== "active" || !u.is_super_admin) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }
  const form = await req.formData();
  const id = String(form.get("id") || "");
  const status = String(form.get("status") || "");
  if (!id || !["open", "with_design", "shipped"].includes(status)) {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
  await sql`
    UPDATE gov_capture_gaps
    SET status=${status}, shipped_at=${status === "shipped" ? new Date().toISOString().slice(0, 10) : null}::date
    WHERE id=${id}::uuid`;
  return NextResponse.redirect(new URL("/opd-governance#capture-gaps", req.url), 303);
}
