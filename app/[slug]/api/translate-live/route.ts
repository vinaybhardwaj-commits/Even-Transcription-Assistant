/**
 * POST /{slug}/api/translate-live
 *
 * On-demand LIVE English translation, powered by Gemini Flash. The doctor can
 * toggle the live transcript to an "English (AI)" view; the client sends the
 * accumulated as-spoken (code-mixed/native) text here on a rolling cadence and
 * we return a clean English translation. This REPLACES the old gibberish live
 * translation (Sarvam on tiny windows): Flash translates the whole accumulated
 * text with full context, so it's coherent.
 *
 * Body: { text: string }
 * Returns: { english: string, provider: string }  (english "" + provider "off"
 *          when Gemini isn't configured — the UI then just keeps the native view)
 *
 * Display-only: never touches the encounter/note. Soft-fail on every path.
 */
import { NextRequest } from "next/server";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { geminiChatIfOn } from "@/lib/llm/gemini";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_CHARS = 14000; // bound latency; translate the most recent window if longer

const SYSTEM = `You translate a LIVE, in-progress doctor–patient clinical conversation from India into clean, readable English. The input is code-mixed (English + an Indian language such as Hindi/Kannada/Tamil, often in native script) and may be mid-sentence. Produce a faithful English rendering of the whole input. Preserve clinical detail exactly: drug names, doses, units, frequencies, negations ("no fever"), durations, anatomy, vitals, numbers. Do NOT add commentary, headings, speaker labels, or preamble. If a span is already English, keep it. Output ONLY the English text.`;

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

  let body: { text?: string };
  try {
    body = (await req.json()) as { text?: string };
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  let text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0) return respondOk({ english: "", provider: "none" });
  if (text.length > MAX_CHARS) text = text.slice(text.length - MAX_CHARS);

  try {
    const res = await geminiChatIfOn(
      "live",
      "flash",
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
      { temperature: 0, responseJson: false, timeoutMs: 25_000 },
    );
    if (!res) return respondOk({ english: "", provider: "off" });
    if (!res.ok || !res.content) return respondOk({ english: "", provider: "error" });
    return respondOk({ english: res.content.trim(), provider: "gemini" });
  } catch {
    return respondOk({ english: "", provider: "error" });
  }
}
