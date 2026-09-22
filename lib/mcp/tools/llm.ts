/**
 * lib/mcp/tools/llm.ts — provider truth, behind the MCP token.
 *
 * scribe_llm_health — for each LLM surface, fire ONE trivial routedChat() and report which
 *                     provider actually answered. Read scope. Writes nothing: no trace, no
 *                     encounter, no cue, no row of any kind.
 *
 * WHY THIS EXISTS. routedChat() has always returned the truth — `gemini:<model>` |
 * `openrouter:<model>` | `none` (it returned `ollama` until qwen left ETA on 22 Sep) — and until now that value was read in exactly two places, neither of which the
 * orchestrator can reach: lib/use-flash-translate.ts (a hook) and GET /api/admin/llm-selftest,
 * which is bearer-gated on MIGRATION_SECRET. So nobody had checked in two months, and the
 * traces were recording a hardcoded literal. This tool puts the same answer behind the MCP
 * token, which the orchestrator does have.
 *
 * `provider` is rc.provider VERBATIM. It is not normalised, prettified or mapped. If a surface
 * that is configured and flagged for Gemini answers `openrouter:…`, that IS the finding, and the row
 * names it itself with warning:"silent_fallback" rather than leaving a reader to spot it.
 *
 * NO SECRETS. Model ids are returned because they are not secrets and they are the thing you
 * need to see; GCP_SA_KEY, the MCP token and the Vertex access token are never read here, and
 * neither the probe prompt nor the model's reply is returned. A test asserts that against the
 * serialised output rather than trusting this paragraph.
 */

import { geminiConfigured, pickGemini, routedChat, GEMINI_MODEL, GEMINI_FLASH_MODEL, firstRoute } from "@/lib/llm/gemini";
import { failSafe, type McpTool } from "../registry";

/**
 * Every surface the router knows, with the tier its real caller uses:
 *   note             lib/note-generation.ts             flash
 *   cds              lib/cdmss-pipeline.ts              pro
 *   native           lib/stt/indic-comprehension.ts     flash
 *   fusion           lib/stt/fuse-transcript.ts         pro
 *   live             app/[slug]/api/translate-live      flash
 *   notegen_analyze  app/[slug]/api/notegen/analyze     flash
 */
export const LLM_SURFACES: ReadonlyArray<{ surface: string; tier: "pro" | "flash" }> = [
  { surface: "note", tier: "flash" },
  { surface: "cds", tier: "pro" },
  { surface: "native", tier: "flash" },
  { surface: "fusion", tier: "pro" },
  { surface: "live", tier: "flash" },
  { surface: "notegen_analyze", tier: "flash" },
];

/** Six words. Nothing clinical, nothing identifying, and never echoed back in the answer. */
const PROBE_MESSAGES = [
  { role: "system", content: "You are a connectivity probe. Reply with exactly one word." },
  { role: "user", content: "Reply with the single word: ok" },
];


/**
 * Hard per-surface budget. routedChat's own timeoutMs bounds each HTTP hop, but a Gemini
 * timeout is FOLLOWED by up to two OpenRouter attempts, so the inner bound alone would allow ~3×
 * per surface. This races the whole call so a wedged surface costs 10 s and no more — six
 * surfaces, sequential, is a worst case of about a minute. This tool must never be the thing
 * that hangs.
 */
const SURFACE_TIMEOUT_MS = 10_000;

/**
 * Bounded, but not tiny, and this is deliberate. max_tokens is a CEILING, not a spend — a
 * one-word reply costs one word whatever the cap. Setting it to ~8 would risk a 2.5-series
 * model spending its budget on thinking tokens and returning EMPTY, which openaiChat reports
 * as empty_response, which makes routedChat fall back to OpenRouter, which would make this tool
 * report a silent_fallback that never happened. A probe that lies in exactly the way it exists
 * to detect is worse than a slightly larger cap.
 */
const PROBE_MAX_TOKENS = 2048;

export type LlmSurfaceHealth = {
  surface: string;
  tier: "pro" | "flash";
  configured: boolean;
  flag_on: boolean;
  provider: string;
  model: string;
  ok: boolean;
  latency_ms: number;
  error?: string;
  warning?: "silent_fallback";
};

/**
 * Is the surface's flag set? Read directly rather than inferred from pickGemini(), which
 * returns undefined for BOTH "no flag" and "not configured". Keeping them apart is the point:
 * `configured:false, flag_on:true` is a real and very likely misconfiguration, and it is
 * invisible if the two are collapsed into one boolean.
 */
function flagOn(surface: string): boolean {
  return process.env.GEMINI_ALL === "1" || process.env[`GEMINI_${surface.toUpperCase()}`] === "1";
}

/** One surface, one call, never throws. */
export async function probeLlmSurface(s: { surface: string; tier: "pro" | "flash" }): Promise<LlmSurfaceHealth> {
  const configured = geminiConfigured();
  const flag_on = flagOn(s.surface);
  // What the router will try FIRST — Gemini when flagged, else the head of the OpenRouter chain.
  // A configuration fact for the row, not the answer: `provider` below is the answer.
  const model = firstRoute(s.surface, s.tier);
  const t0 = Date.now();

  let provider = "unknown";
  let ok = false;
  let error: string | undefined;
  let latency_ms = 0;

  try {
    const rc = await Promise.race([
      routedChat({
        surface: s.surface,
        tier: s.tier,
        messages: PROBE_MESSAGES,
        temperature: 0,
        responseJson: false,
        maxTokens: PROBE_MAX_TOKENS,
        timeoutMs: SURFACE_TIMEOUT_MS,
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`surface_timeout_${SURFACE_TIMEOUT_MS}ms`)), SURFACE_TIMEOUT_MS)),
    ]);
    provider = rc.provider; // VERBATIM — the whole point of the tool
    ok = rc.ok;
    error = rc.error;
    latency_ms = rc.latency_ms;
  } catch (e) {
    // A throw is a fault in the probe, not an answer from a provider: `unknown`, never a guess.
    provider = "unknown";
    ok = false;
    error = String((e as Error)?.message ?? e).slice(0, 200);
    latency_ms = Date.now() - t0;
  }

  const row: LlmSurfaceHealth = { surface: s.surface, tier: s.tier, configured, flag_on, provider, model, ok, latency_ms };
  if (error) row.error = error;
  // The CDMSS failure, naming itself: we asked for Gemini, we were told Gemini was on, and
  // something else answered. Nothing errors when this happens, which is exactly why it needs
  // to be a field rather than something a reader is expected to notice.
  if (configured && flag_on && !provider.startsWith("gemini:")) row.warning = "silent_fallback";
  return row;
}

const llmHealth: McpTool = {
  name: "scribe_llm_health",
  description:
    "Which LLM provider actually serves each surface (note, cds, native, fusion, live, notegen_analyze). Fires ONE trivial one-word probe per surface through routedChat and reports { surface, tier, configured, flag_on, provider, model, ok, latency_ms, error? }. `provider` is verbatim: 'gemini:<model>' | 'openrouter:<model>' | 'none' — there is no Ollama in the chain. A surface that is configured AND flagged but answers anything other than gemini: gets warning:'silent_fallback' — that is the failure this tool exists to catch. Sequential, 10s hard cap per surface. Writes NOTHING: no trace, no encounter, no cue. Returns no secret, no token and no prompt or model text.",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () =>
    failSafe({ surfaces: [] as unknown[] }, async () => {
      // SEQUENTIAL on purpose: six concurrent Vertex calls from a probe is a burst nobody
      // asked for, and the point here is truth, not speed.
      const surfaces: LlmSurfaceHealth[] = [];
      for (const s of LLM_SURFACES) surfaces.push(await probeLlmSurface(s));

      return {
        gemini_configured: geminiConfigured(),
        gcp_project_set: Boolean(process.env.GCP_PROJECT),
        // Same default the router applies, so this reads as what the router will actually use.
        gcp_location: process.env.GCP_LOCATION || "asia-south1",
        gemini_all: process.env.GEMINI_ALL === "1",
        flash_model: GEMINI_FLASH_MODEL,
        pro_model: GEMINI_MODEL,
        surfaces,
      };
    }),
};

export const LLM_TOOLS: McpTool[] = [llmHealth];
