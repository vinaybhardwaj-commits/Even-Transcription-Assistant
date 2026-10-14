import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { sendEmail, wrapHtml, emailEnabled } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

const PORTAL_URL = process.env.NEXT_PUBLIC_PORTAL_URL || "https://doctors.evenos.app";

/**
 * POST /api/admin/portal-welcome
 * Sends a first-login WELCOME email to an existing active portal physician:
 * "you're in the system, sign in with your email + temporary PIN 0000 (you'll
 * set your own on first login)". Reusable for onboarding / rollout comms.
 *
 * Auth: ?token=<MCP_BEARER_TOKEN> or Authorization: Bearer <MCP_BEARER_TOKEN>.
 * Body: { email: string, send?: boolean }. Default send=false → PREVIEW ONLY
 * (returns the exact subject + HTML, sends nothing). send=true → sends via Resend
 * (gated by EMAIL_SENDING_ENABLED) and writes an audit_log_v2 row.
 * Does NOT change the PIN — assumes the 0000 + must-change bootstrap is already set.
 */
function welcomeHtml(name: string, email: string): string {
  return wrapHtml("You're set up on the Even Physician Portal", `
    <p>Hi ${name},</p>
    <p>Your account on the <strong>Even Physician Portal</strong> is ready. Sign in to view your profile and privileges, upload your qualifications, see your performance, and report or respond to feedback.</p>
    <p style="margin:16px 0;padding:12px 16px;background:#f5f5f4;border-radius:8px;">
      <strong>Sign in:</strong> <a href="${PORTAL_URL}/portal/login" style="color:#0f766e;">${PORTAL_URL}/portal/login</a><br>
      <strong>Email:</strong> ${email}<br>
      <strong>Temporary PIN:</strong> <code style="font-size:18px;letter-spacing:2px;">0000</code>
    </p>
    <p>For your security, you'll be asked to set your own 4-digit PIN the first time you sign in.</p>
    <p style="color:#78716c;font-size:12px;">If you weren't expecting this, please contact the Even governance team.</p>`);
}

export async function POST(req: NextRequest) {
  const want = process.env.MCP_BEARER_TOKEN;
  const token = new URL(req.url).searchParams.get("token") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!want || token !== want) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const { email, send } = (await req.json().catch(() => ({}))) as { email?: string; send?: boolean };
  const clean = typeof email === "string" ? email.toLowerCase().trim() : "";
  if (!clean || !clean.includes("@")) return NextResponse.json({ ok: false, error: "A valid email is required." }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const rows = (await sql`
    SELECT id::text AS id, full_name, email
    FROM physicians WHERE lower(email) = ${clean} AND current_status = 'active' AND portal_access = true LIMIT 1
  `) as Array<{ id: string; full_name: string; email: string }>;
  if (rows.length === 0) return NextResponse.json({ ok: false, error: "No active portal physician found with that email." }, { status: 404, headers: NO_STORE });

  const ph = rows[0];
  const subject = "Welcome to the Even Physician Portal";
  const html = welcomeHtml(ph.full_name, ph.email);

  if (!send) {
    return NextResponse.json({ ok: true, preview: true, to: ph.email, full_name: ph.full_name, subject, html, email_enabled: emailEnabled() }, { headers: NO_STORE });
  }

  const res = await sendEmail({ to: ph.email, subject, html });
  await sql`INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
            VALUES ('portal_welcome_sent', 'physician', ${ph.id}, ${JSON.stringify({ to: ph.email, result: res })}::jsonb)`;
  return NextResponse.json({ ok: true, to: ph.email, sent: !!res.ok && !res.skipped, skipped: !!res.skipped, id: res.id, error: res.error }, { headers: NO_STORE });
}
