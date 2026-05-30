/**
 * POST /{slug}/api/voice/transcribe-window  (enrollment live-evidence transcription)
 *
 * Slug-scoped twin of /api/voice/transcribe-window for the DOCTOR self-serve
 * enrollment wizard. The doctor cookie `rounds_session` is path-scoped to
 * `/{slug}` (lib/cookie.ts), so the BARE /api/voice/transcribe-window never
 * receives it and 401s for doctors (same class as the streaming no_token
 * cookie-path bug). This route lives under /{slug} so the cookie is sent.
 * The admin kiosk keeps using the bare route (admin cookie is path `/`).
 *
 * Returns Deepgram (English) text for a short read-aloud window. No DB writes;
 * low sensitivity. Body: multipart/form-data { audio: Blob }  Returns: { text }
 */
import { NextRequest } from "next/server";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { transcribeAudio } from "@/lib/transcribe";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try {
    const claims = await verifyDoctorJwt(cookie);
    if (claims.slug !== slug) return respondError("FORBIDDEN", "Slug mismatch");
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return respondError("VALIDATION_FAILED", "expected_multipart");
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return respondOk({ text: "" });
  try {
    const buf = Buffer.from(await audio.arrayBuffer());
    const r = await transcribeAudio(buf, audio.type || "audio/webm");
    return respondOk({ text: r.ok ? r.transcript : "" });
  } catch {
    return respondOk({ text: "" });
  }
}
