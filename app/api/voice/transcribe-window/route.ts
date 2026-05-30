/**
 * POST /api/voice/transcribe-window  (enrollment live-evidence transcription)
 *
 * Used by the voice-enrollment wizard (doctor self-serve AND admin kiosk) to
 * show live text while a fixed English sentence is read aloud. Accepts a short,
 * self-contained webm window and returns Deepgram (English) text. No DB writes;
 * low sensitivity — accepts either a valid doctor OR admin session so it works
 * in both /{slug}/onboarding/voice and /admin/doctors/[id]/voice contexts.
 *
 * Body: multipart/form-data { audio: Blob }
 * Returns: { text }
 */
import { NextRequest } from "next/server";
import { readDoctorCookie, readAdminCookie } from "@/lib/cookie";
import { verifyDoctorJwt, verifyAdminJwt } from "@/lib/auth";
import { transcribeAudio } from "@/lib/transcribe";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 30;

async function authed(): Promise<boolean> {
  const dc = await readDoctorCookie();
  if (dc) { try { await verifyDoctorJwt(dc); return true; } catch { /* fall through */ } }
  const ac = await readAdminCookie();
  if (ac) { try { await verifyAdminJwt(ac); return true; } catch { /* fall through */ } }
  return false;
}

export async function POST(req: NextRequest) {
  if (!(await authed())) return respondError("AUTH_REQUIRED", "Sign in required");
  let form: FormData;
  try { form = await req.formData(); } catch { return respondError("VALIDATION_FAILED", "expected_multipart"); }
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
