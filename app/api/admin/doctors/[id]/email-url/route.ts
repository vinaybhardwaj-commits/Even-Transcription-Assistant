/**
 * POST /api/admin/doctors/{id}/email-url
 *
 * Emails the doctor their personal login URL via Resend. Useful after a
 * URL rotation or new-doctor onboarding. The email is intentionally
 * plain — subject 'Your Even Encounter Assistant URL', body with the
 * URL + a one-line reminder of their PIN reset path.
 *
 * Audit log: 'doctor.email_url'.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 30;

function canonicalAppUrl(): string {
  const raw = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw || /eta\.even\.in/i.test(raw)) return "https://evenscribe.app";
  return raw;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let adminId = "";
  try {
    const claims = await verifyAdminJwt(cookie);
    adminId = String(claims.admin_id ?? "");
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }

  const { id } = await params;
  if (!id.startsWith("doc_")) return respondError("VALIDATION_FAILED", "bad_doctor_id");

  const rows = (await sql`
    SELECT id, full_name, email, url_slug
      FROM clinician WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
  `) as Array<{ id: string; full_name: string; email: string; url_slug: string }>;
  if (rows.length === 0) return respondError("NOT_FOUND", "doctor_not_found");
  const doc = rows[0]!;

  const loginUrl = `${canonicalAppUrl()}/${doc.url_slug}`;
  const fromAddress = process.env.RESEND_FROM_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  if (!fromAddress || !apiKey) {
    return respondError("UPSTREAM_UNAVAILABLE", "resend_not_configured");
  }

  const subject = "Your Even Encounter Assistant URL";
  const text = [
    `Hi ${doc.full_name.split(" ")[0]},`,
    "",
    "Here's your personal URL for the Even Encounter Assistant:",
    "",
    loginUrl,
    "",
    "Open this on your phone and tap 'Add to Home Screen' (Safari) or",
    "'Install' (Chrome) to keep it handy. Then enter your 4-digit PIN.",
    "",
    "If you've forgotten your PIN, ask your admin to reset it.",
    "",
    "— Even Hospital admin",
  ].join("\n");
  const html = `
    <p>Hi ${doc.full_name.split(" ")[0]},</p>
    <p>Here's your personal URL for the Even Encounter Assistant:</p>
    <p style="font-family:monospace;font-size:14px;background:#f4f4f5;padding:12px;border-radius:6px;"><a href="${loginUrl}">${loginUrl}</a></p>
    <p>Open this on your phone and tap <strong>Add to Home Screen</strong> (Safari) or <strong>Install</strong> (Chrome) to keep it handy. Then enter your 4-digit PIN.</p>
    <p style="color:#666;font-size:13px;">If you've forgotten your PIN, ask your admin to reset it.</p>
    <p style="color:#666;font-size:13px;">— Even Hospital admin</p>
  `;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: fromAddress, to: [doc.email], subject, html, text }),
      cache: "no-store",
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      return respondError("UPSTREAM_UNAVAILABLE", `resend_${r.status}: ${errText.slice(0, 200)}`);
    }
    const j = (await r.json()) as { id?: string };
    await sql`
      INSERT INTO audit_log
        (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES
        ('admin', ${adminId}, 'doctor.email_url', 'doctor', ${id},
         ${JSON.stringify({ to: doc.email, resend_message_id: j.id ?? null })}::jsonb)
    `.catch(() => { /* intentional: best-effort audit write */ });
    return respondOk({ ok: true, sent_to: doc.email, resend_message_id: j.id ?? null });
  } catch (e) {
    return respondError("PIPELINE_FAILED", e instanceof Error ? e.message.slice(0, 200) : String(e));
  }
}
