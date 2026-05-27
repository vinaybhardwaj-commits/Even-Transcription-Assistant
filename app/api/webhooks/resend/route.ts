/**
 * POST /api/webhooks/resend
 *
 * Resend sends delivery / bounce / complaint / open events here. We
 * verify the signature with svix-style verification (Resend uses svix
 * webhooks under the hood — secret stored as RESEND_WEBHOOK_SECRET).
 *
 * For now we use a lightweight HMAC-SHA256 verification compatible
 * with Resend's webhook signature format (svix). If the secret starts
 * with "whsec_" we strip that prefix for the HMAC key.
 *
 * Lives at /api/webhooks/resend (not under /[slug]) because Resend
 * doesn't know about doctor slugs — webhook URL is global per project.
 *
 * Events handled: email.delivered, email.bounced, email.complained,
 * email.opened. Lookup by resend_message_id, update status/timestamp.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { createHmac, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";

function verify(req: NextRequest, raw: string): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;
  const sigHeader =
    req.headers.get("svix-signature") ?? req.headers.get("resend-signature") ?? "";
  const idHeader = req.headers.get("svix-id") ?? "";
  const tsHeader = req.headers.get("svix-timestamp") ?? "";
  if (!sigHeader || !idHeader || !tsHeader) return false;

  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret, "utf8");

  const signed = `${idHeader}.${tsHeader}.${raw}`;
  const expected = createHmac("sha256", key).update(signed).digest("base64");

  // Resend signature header format: "v1,<sig> v1,<sig> ..." (space separated)
  const provided = sigHeader
    .split(" ")
    .map((p) => p.trim())
    .filter((p) => p.startsWith("v1,"))
    .map((p) => p.slice(3));

  for (const p of provided) {
    try {
      const a = Buffer.from(expected, "base64");
      const b = Buffer.from(p, "base64");
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

const STATUS_MAP: Record<string, { status: string; field: string | null }> = {
  "email.delivered": { status: "delivered", field: null },
  "email.opened": { status: "opened", field: "opened_at" },
  "email.bounced": { status: "bounced", field: "bounced_at" },
  "email.complained": { status: "complained", field: "complained_at" },
  "email.failed": { status: "failed", field: null },
};

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verify(req, raw)) {
    return new Response(JSON.stringify({ error: "invalid_signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: { type?: string; data?: { email_id?: string } };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return new Response("bad_json", { status: 400 });
  }

  const type = payload.type ?? "";
  const messageId = payload.data?.email_id ?? "";
  const mapping = STATUS_MAP[type];
  if (!mapping || !messageId) {
    // Silently 200 — Resend doesn't retry on 2xx and we don't want
    // to handle event types we don't care about as failures.
    return new Response(JSON.stringify({ ok: true, skipped: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    if (mapping.field) {
      // dynamic field write — guarded list ensures no injection
      if (mapping.field === "opened_at") {
        await sql`
          UPDATE send_event
             SET status = ${mapping.status}, opened_at = NOW()
           WHERE resend_message_id = ${messageId}
        `;
      } else if (mapping.field === "bounced_at") {
        await sql`
          UPDATE send_event
             SET status = ${mapping.status}, bounced_at = NOW()
           WHERE resend_message_id = ${messageId}
        `;
      } else if (mapping.field === "complained_at") {
        await sql`
          UPDATE send_event
             SET status = ${mapping.status}, complained_at = NOW()
           WHERE resend_message_id = ${messageId}
        `;
      }
    } else {
      await sql`
        UPDATE send_event SET status = ${mapping.status}
         WHERE resend_message_id = ${messageId}
      `;
    }
  } catch {
    // best-effort — webhook will retry on 5xx
    return new Response("db_error", { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
