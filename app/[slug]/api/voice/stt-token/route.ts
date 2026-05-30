/**
 * GET /{slug}/api/voice/stt-token — mint a short-lived token for the STT relay.
 *
 * MUST live under /{slug}/ : the doctor cookie (rounds_session) is path-scoped
 * to /{slug}, so a bare /api/... route never receives it (401). Mirrors the
 * other /{slug}/api/voice/* routes. HMAC-signed with STT_RELAY_SECRET (shared
 * with the Mac Mini relay), 120s TTL. If the relay env is unset, returns
 * UPSTREAM_UNAVAILABLE and the client keeps the REST refine trace.
 */
import crypto from "node:crypto";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const secret = process.env.STT_RELAY_SECRET;
  const relayUrl = process.env.NEXT_PUBLIC_STT_RELAY_URL || process.env.STT_RELAY_URL || "";
  if (!secret || !relayUrl) return respondError("UPSTREAM_UNAVAILABLE", "streaming_not_configured");

  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let claimSlug = "";
  try { claimSlug = String((await verifyDoctorJwt(cookie)).slug ?? ""); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  if (claimSlug !== slug) return respondError("FORBIDDEN", "Slug mismatch");

  const payload = Buffer.from(JSON.stringify({ slug: claimSlug, exp: Math.floor(Date.now() / 1000) + 120 })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return respondOk({ token: `${payload}.${sig}`, relay_url: relayUrl });
}
