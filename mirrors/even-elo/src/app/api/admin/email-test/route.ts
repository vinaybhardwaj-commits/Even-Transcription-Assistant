import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { sendEmail, wrapHtml, emailEnabled } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** POST /api/admin/email-test { to } — super_admin sends a test email (or sees skipped status while disabled). */
export async function POST(req: NextRequest) {
  let actor;
  try { actor = await actorFromRequest(); } catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const me = (await sql`SELECT is_super_admin FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean }>;
  if (me.length === 0 || !me[0].is_super_admin) return NextResponse.json({ ok: false, error: "Super admin only" }, { status: 403, headers: NO_STORE });

  const { to } = (await req.json().catch(() => ({}))) as { to?: string };
  if (!to) return NextResponse.json({ ok: false, error: "to required" }, { status: 400, headers: NO_STORE });

  const result = await sendEmail({ to, subject: "Even Physician Index — test email", html: wrapHtml("Test email", "<p>If you can read this, Resend sending is configured correctly.</p>") });
  return NextResponse.json({ ok: result.ok, enabled: emailEnabled(), result }, { headers: NO_STORE });
}
