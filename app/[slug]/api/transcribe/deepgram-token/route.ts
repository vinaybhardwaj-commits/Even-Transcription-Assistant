/**
 * POST /{slug}/api/transcribe/deepgram-token
 *
 * Mints a 10-minute Deepgram temp key scoped to usage:write so the
 * doctor's browser can open a WebSocket directly to Deepgram for live
 * transcription. Auth-gated by doctor cookie + slug match.
 *
 * Body: { encounter_id?: string }   (used in the key comment for audit)
 * Returns: { key, expires_at, ttl_seconds }
 */
import { NextRequest } from "next/server";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { mintLiveToken } from "@/lib/deepgram-token";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let claims;
  try {
    claims = await verifyDoctorJwt(cookie);
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }
  if (claims.slug !== slug) return respondError("FORBIDDEN", "Slug mismatch");

  let encounterId = "unknown";
  try {
    const body = (await req.json().catch(() => ({}))) as {
      encounter_id?: string;
    };
    if (typeof body.encounter_id === "string") {
      encounterId = body.encounter_id.slice(0, 40);
    }
  } catch {
    /* empty body fine */
  }

  try {
    const token = await mintLiveToken(
      `eta:${claims.doctor_id}:${encounterId}`,
    );
    return respondOk({
      key: token.key,
      expires_at: token.expires_at,
      ttl_seconds: token.ttl_seconds,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError(
      "UPSTREAM_UNAVAILABLE",
      `deepgram_token_mint_failed: ${msg.slice(0, 150)}`,
    );
  }
}
