/**
 * POST /{slug}/api/transcribe/cleanup
 *
 * Body: { utterance_id: string, raw: string }
 * Returns:
 *   - { utterance_id, cleaned, raw, latency_ms, model, fallback: false }
 *   - { utterance_id, cleaned: raw, raw, latency_ms, error, fallback: true } on soft-fail
 *
 * Soft-fail philosophy: cleanup is a polish — never block transcription
 * on it. If the LLM fails, return the raw text as the "cleaned" version
 * with fallback=true so the client just keeps what Deepgram gave us.
 */
import { NextRequest } from "next/server";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { cleanUtterance } from "@/lib/llm-cleanup";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 15;

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

  let body: { utterance_id?: string; raw?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const utterance_id =
    typeof body.utterance_id === "string"
      ? body.utterance_id.slice(0, 64)
      : "anon";
  const raw =
    typeof body.raw === "string" ? body.raw.slice(0, 4_000).trim() : "";
  if (raw.length === 0) {
    return respondError("VALIDATION_FAILED", "raw_empty");
  }

  const result = await cleanUtterance(raw, { signal: req.signal });
  if (!result.ok) {
    return respondOk({
      utterance_id,
      cleaned: raw,
      raw,
      latency_ms: result.latency_ms,
      error: result.error,
      fallback: true,
    });
  }
  return respondOk({
    utterance_id,
    cleaned: result.cleaned,
    raw,
    latency_ms: result.latency_ms,
    model: result.model,
    fallback: false,
  });
}
