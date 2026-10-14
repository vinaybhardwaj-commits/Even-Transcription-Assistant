import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { neon } from "@neondatabase/serverless";
import { randomInt } from "crypto";
import { hashPortalPin } from "@/lib/physician-auth";
import { sendEmail, wrapHtml } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

// Anti-abuse: max 3 PIN requests / 15 min / email (per serverless instance).
const rl = new Map<string, { count: number; resetAt: number }>();
function rateOk(key: string): boolean {
  const now = Date.now();
  const e = rl.get(key);
  if (!e || now > e.resetAt) { rl.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 }); return true; }
  e.count++;
  return e.count <= 3;
}

// Generic response — never reveals whether an email maps to a real physician.
const GENERIC = { ok: true, message: "If an account exists for that email, a PIN has been sent to it." };

/**
 * POST /api/portal/auth/request-pin { email }
 * Self-service PIN issuance for the Doctor Portal. Covers BOTH first-time sign-in
 * and forgot-PIN: any ACTIVE physician with a matching email is mailed a fresh,
 * permanent 4-digit PIN (no forced change). Requesting also enables portal access.
 * Always returns a generic success to prevent email enumeration. Gated by
 * EMAIL_SENDING_ENABLED (the PIN can't be delivered while sending is off).
 */
export async function POST(req: NextRequest) {
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  const clean = typeof email === "string" ? email.toLowerCase().trim() : "";
  if (!clean || !clean.includes("@")) {
    return portalJson({ ok: false, error: "A valid email is required." }, { status: 400, headers: NO_STORE });
  }
  // Rate-limit silently (still return generic success to avoid leaking timing/state).
  if (!rateOk(clean)) return portalJson(GENERIC, { headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const rows = (await sql`
    SELECT id::text AS id, full_name, email
    FROM physicians WHERE lower(email) = ${clean} AND current_status = 'active' LIMIT 1
  `) as Array<{ id: string; full_name: string; email: string }>;

  if (rows.length > 0) {
    const ph = rows[0];
    const pin = String(randomInt(1000, 10000)); // permanent 4-digit
    const hash = await hashPortalPin(pin);
    await sql`
      UPDATE physicians
      SET portal_pin_hash = ${hash}, portal_access = true, portal_must_change_pin = false
      WHERE id = ${ph.id}::uuid
    `;
    await sql`INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
              VALUES ('portal_pin_self_issued', 'physician', ${ph.id},
              ${JSON.stringify({ email: ph.email, portal_access: true, must_change_pin: false })}::jsonb)`;

    const appUrl = process.env.NEXT_PUBLIC_PORTAL_URL || "https://doctors.evenos.app";
    void sendEmail({
      to: ph.email,
      subject: "Your Even Physician Portal PIN",
      html: wrapHtml("Your portal PIN", `
        <p>Hi ${ph.full_name},</p>
        <p>Here is your PIN for the Even Physician Portal. It stays valid until you request a new one.</p>
        <p style="margin:16px 0;padding:12px 16px;background:#f5f5f4;border-radius:8px;">
          <strong>Sign in:</strong> <a href="${appUrl}/portal/login" style="color:#0f766e;">${appUrl}/portal/login</a><br>
          <strong>Email:</strong> ${ph.email}<br>
          <strong>PIN:</strong> <code style="font-size:18px;letter-spacing:2px;">${pin}</code>
        </p>
        <p>If you didn't request this, you can ignore this email — your previous PIN (if any) has been replaced, so contact an administrator if that's a concern.</p>`),
    }).catch(() => undefined);
  }

  return portalJson(GENERIC, { headers: NO_STORE });
}
