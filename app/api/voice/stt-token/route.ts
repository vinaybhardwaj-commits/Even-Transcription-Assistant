/**
 * GET /api/voice/stt-token  — mint a short-lived token for the STT relay.
 *
 * The browser can't hold the Sarvam key and can't set WS headers, so live
 * streaming goes browser → Mac Mini relay → Sarvam. The relay authorizes the
 * browser with this HMAC token (signed with STT_RELAY_SECRET, shared with the
 * relay). Doctor-authed; 120s TTL. If STT_RELAY_SECRET/URL are unset the
 * feature is simply off (client falls back to the REST refine trace).
 *
 * token = base64url(JSON{slug,exp}) + "." + base64url(HMAC_SHA256(payload))
 */
import crypto from "node:crypto";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const secret = process.env.STT_RELAY_SECRET;
  const relayUrl = process.env.NEXT_PUBLIC_STT_RELAY_URL || process.env.STT_RELAY_URL || "";
  if (!secret || !relayUrl) return respondError("UNAVAILABLE", "streaming_not_configured");

  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let slug = "";
  try { slug = String((await verifyDoctorJwt(cookie)).slug ?? ""); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }

  const payload = Buffer.from(JSON.stringify({ slug, exp: Math.floor(Date.now() / 1000) + 120 })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return respondOk({ token: `${payload}.${sig}`, relay_url: relayUrl });
}
