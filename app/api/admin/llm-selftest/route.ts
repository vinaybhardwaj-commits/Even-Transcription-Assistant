/**
 * Admin LLM self-test — confirms WHICH backend serves each LLM surface.
 *
 * Fires a trivial routedChat()/geminiChatIfOn() pass per surface (note→flash,
 * cds→pro, native→flash) and reports the resolved provider ("gemini:<model>" or
 * "ollama"), so we can verify the Vertex/Gemini hybrid is actually live after the
 * env is set — WITHOUT touching any encounter or clinical data.
 *
 * Auth: Bearer MIGRATION_SECRET (same gate as resume-processing). Read-only.
 */
import { NextRequest } from "next/server";
import { respondError, respondOk } from "@/lib/respond";
import {
  geminiConfigured, pickGemini, routedChat,
  GEMINI_MODEL, GEMINI_FLASH_MODEL,
} from "@/lib/llm/gemini";

export const runtime = "nodejs";
export const maxDuration = 60;

const PING = [
  { role: "system", content: "You are a connectivity probe. Reply with exactly one word." },
  { role: "user", content: "Reply with the single word: pong" },
];

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const secretOk = !!process.env.MIGRATION_SECRET && auth === `Bearer ${process.env.MIGRATION_SECRET}`;
  if (!secretOk) return respondError("AUTH_REQUIRED", "migration secret required");

  const surfaces: Array<{ surface: string; tier: "pro" | "flash" }> = [
    { surface: "note", tier: "flash" },
    { surface: "cds", tier: "pro" },
    { surface: "native", tier: "flash" },
  ];

  const results = [];
  for (const s of surfaces) {
    const wouldUse = pickGemini(s.surface, s.tier); // undefined => Ollama
    const t0 = Date.now();
    try {
      const rc = await routedChat({
        surface: s.surface, tier: s.tier, ollamaModel: "qwen2.5:14b",
        messages: PING, temperature: 0, responseJson: false, timeoutMs: 45_000,
      });
      results.push({
        surface: s.surface, tier: s.tier,
        flag_on: Boolean(wouldUse), would_use: wouldUse ?? "ollama",
        provider: rc.provider, ok: rc.ok,
        sample: (rc.content || "").slice(0, 40), error: rc.error,
        latency_ms: rc.latency_ms,
      });
    } catch (e) {
      results.push({
        surface: s.surface, tier: s.tier, flag_on: Boolean(wouldUse),
        provider: "error", ok: false,
        error: e instanceof Error ? e.message : String(e), latency_ms: Date.now() - t0,
      });
    }
  }

  return respondOk({
    gemini_configured: geminiConfigured(),
    gemini_all: process.env.GEMINI_ALL === "1",
    models: { pro: GEMINI_MODEL, flash: GEMINI_FLASH_MODEL },
    gcp: { project_set: Boolean(process.env.GCP_PROJECT), location: process.env.GCP_LOCATION || "asia-south1(default)" },
    results,
  });
}
