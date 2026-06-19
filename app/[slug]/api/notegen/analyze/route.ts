/**
 * POST /{slug}/api/notegen/analyze — live writing assistant for the typed-note
 * editor (R3/R4). Body: { text, note_type, gaps?[] } -> { inline, chips, rewrites }.
 *
 * Lives under [slug] so the path-scoped doctor cookie reaches it. Grounding: may
 * add structure / standard phrasing / prompts for MISSING items, but never invents
 * a specific clinical value — unknown specifics become "___". Runs on Gemini flash
 * (Ollama fallback) via routedChat; throttled + cached so a typing burst is ~1 call.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { routedChat } from "@/lib/llm/gemini";
import { respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const maxDuration = 30;

const TAIL = 800;
// Generous output cap so 2.5-flash "thinking" cannot starve the small JSON body
// (the MedNoteGen empty-response trap). A true thinking-off cost-harden via the
// Vertex OpenAI-compat param is a later pass; the throttle + cache keep volume low.
const MAX_OUTPUT_TOKENS = 2048;

type AnalyzeResult = { inline: string; chips: string[]; rewrites: { from: string; to: string }[] };
const CACHE = new Map<string, { v: AnalyzeResult; at: number }>();
const CACHE_MAX = 200;
const CACHE_TTL = 5 * 60 * 1000;
function cacheGet(k: string): AnalyzeResult | null {
  const hit = CACHE.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) { CACHE.delete(k); return null; }
  CACHE.delete(k); CACHE.set(k, hit);
  return hit.v;
}
function cacheSet(k: string, v: AnalyzeResult) {
  CACHE.set(k, { v, at: Date.now() });
  if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string);
}

const SYSTEM = `You are a writing assistant helping a doctor compose a clinical note. You suggest how to CONTINUE or COMPLETE the note, and propose faithful wording REWRITES.
HARD RULES:
1. Build only on what the doctor has written. NEVER invent a specific clinical value, finding, name, dose, count, time or number. For any specific the doctor must supply, write a blank "___".
2. Keep suggestions short and in standard clinical phrasing.
3. Prioritise the still-missing items provided.
4. REWRITES: faithfully expand medical shorthand/abbreviations (e.g. "NAD" -> "no abnormality detected", "EBL" -> "estimated blood loss", "pt" -> "patient") or tidy obviously rough wording — WITHOUT changing clinical meaning and WITHOUT inventing detail. Each rewrite "from" must be copied VERBATIM from the note.
Return STRICT JSON only.`;

function stripFences(s: string): string {
  const t = (s || "").trim();
  if (t.startsWith("```")) return t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return t;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  let claims;
  try { claims = await verifyDoctorJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }
  if (claims.slug !== slug) return respondError("FORBIDDEN", "Slug mismatch");

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const text = String((body as { text?: unknown }).text ?? "").trim().slice(-TAIL);
  const noteType = String((body as { note_type?: unknown }).note_type ?? "operative_procedure");
  const gapsRaw = (body as { gaps?: unknown }).gaps;
  const gaps = Array.isArray(gapsRaw) ? gapsRaw.slice(0, 6).map(String) : [];

  if (text.length < 8) return NextResponse.json({ inline: "", chips: [], rewrites: [] });

  const key = createHash("sha1").update(`${noteType}${text}${gaps.join("|")}`).digest("hex");
  const cached = cacheGet(key);
  if (cached) return NextResponse.json({ ...cached, cached: true });

  const prompt = `NOTE TYPE: ${noteType}
STILL-MISSING items (prioritise these): ${gaps.join(", ") || "none"}

CURRENT NOTE:
"""${text}"""

Return JSON:
{
  "inline": "ONLY the NEW words to append at the very end — do NOT repeat any words already written. <=14 words. Use ___ for unknown specifics. Empty string if nothing sensible to add.",
  "chips": ["up to 3 short phrases (<=10 words each) the doctor could insert to cover the missing items, each using ___ for unknown values"],
  "rewrites": [{ "from": "<exact substring copied verbatim from the note>", "to": "<faithful expansion or tidy>" }]
}`;

  try {
    const r = await routedChat({
      surface: "notegen_analyze", tier: "flash",
      ollamaModel: process.env.NOTE_MODEL || "qwen2.5:14b",
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      temperature: 0, responseJson: true, maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: 25_000, signal: req.signal,
    });
    if (!r.ok) return NextResponse.json({ inline: "", chips: [], rewrites: [] });
    const parsed = JSON.parse(stripFences(r.content)) as {
      inline?: unknown; chips?: unknown; rewrites?: unknown;
    };
    const inline = typeof parsed.inline === "string" ? parsed.inline.slice(0, 160) : "";
    const chips = Array.isArray(parsed.chips)
      ? parsed.chips.filter((c) => typeof c === "string" && (c as string).trim()).slice(0, 3).map((c) => (c as string).trim().slice(0, 90))
      : [];
    const rewrites = Array.isArray(parsed.rewrites)
      ? (parsed.rewrites as Array<{ from?: unknown; to?: unknown }>)
          .filter((rw) => rw && typeof rw.from === "string" && typeof rw.to === "string" && (rw.from as string).trim() && rw.from !== rw.to && text.includes(rw.from as string))
          .slice(0, 4)
          .map((rw) => ({ from: rw.from as string, to: (rw.to as string).slice(0, 120) }))
      : [];
    const result: AnalyzeResult = { inline, chips, rewrites };
    cacheSet(key, result);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ inline: "", chips: [], rewrites: [] });
  }
}
