/**
 * lib/stt/adapters/gemini.ts — Gemini on Vertex as an STT engine (Build 3 §A, PRD §5).
 *
 * ─── THIS ADAPTER OWNS ITS OWN FETCH, AND THAT IS THE POINT ───────────────────────────────
 * It does NOT go through `routedChat()` or any helper in `lib/llm/gemini.ts`. Two independent
 * reasons, both load-bearing:
 *
 *   1. FAIL CLOSED. `routedChat()` soft-fails to local Ollama SILENTLY on any Gemini error. That
 *      is correct for note generation and CATASTROPHIC for a lab engine, whose entire purpose is
 *      to attribute quality to a NAMED engine. The precedent is written into this codebase in
 *      blood: `lib/brain/fuse/gemini-arms.ts` records 367 audits labelled `gemini-2.5-pro` that
 *      were actually served by `qwen2.5:14b` for four days, and nothing anywhere said so. There
 *      is no sensible fallback for an STT engine in any case — Whisper is a DIFFERENT ENGINE
 *      with its own row and its own leaderboard line, not a spare identity for this one.
 *
 *   2. `openaiChat()` reads `choices[0].message.content` and DISCARDS the usage block, so cost
 *      cannot be derived through it at all. Cost must come off the response of the call just
 *      made (PRD §5, room-drain §3.10), which means owning the response.
 *
 * Every failure path here returns the error state. There is no branch that returns a transcript
 * this adapter did not receive from Vertex.
 *
 * ─── WHAT THIS ENGINE IS NOT ──────────────────────────────────────────────────────────────
 * Gemini emits no structured segment or word timings. It competes on transcript TEXT only and
 * can never become the segmenter: the room drain builds turn cues from Whisper's `segments[]`
 * regardless of which engine is routed, and nothing here changes that. Anyone sizing future work
 * on the belief that this removes the Whisper dependency is mistaken.
 *
 * `language` and `english` are deliberately NULL. There is no language parameter on the API, so
 * any language value could only come from the hint we sent or from model-generated free text —
 * which is precisely the defect `adapters/sarvam.ts` documents, a wrong value sitting in a field
 * nothing downstream could tell was wrong. Returning null lets the existing authority stand:
 * `room-drain.ts` computes `decided = probeLanguage ?? full.language` and writes
 * `asr.language ?? decided`, so a null falls through to Whisper's answer cleanly and truthfully.
 */

import { getVertexAccessToken } from "@/lib/gcp-auth";
import type { SttAdapter, SttTranscribeResult } from "../types";

/** Set to exactly "1" to arm the adapter. Absent = inert even if a row and a routing cell exist. */
export const GEMINI_STT_GATE_ENV = "GEMINI_STT";
export const GEMINI_STT_MODEL_ENV = "GEMINI_STT_MODEL";

/**
 * Vertex bills audio input per token, so a rate is needed to turn usage into money. Held in env
 * as NAMES-only config, defaulting to null: a missing rate produces a NULL cost, never a guessed
 * one (PRD §5 — "never estimated inside the adapter").
 */
export const GEMINI_STT_AUDIO_RATE_ENV = "GEMINI_STT_USD_PER_1K_INPUT_TOKENS";
export const GEMINI_STT_OUTPUT_RATE_ENV = "GEMINI_STT_USD_PER_1K_OUTPUT_TOKENS";

/**
 * ═══ THE MIME VERDICT (PRD §5, Build 3 §A) ═══
 *
 * Gemini's documented audio containers are wav, mp3, aiff, aac, ogg and flac. `audio/webm` is
 * NOT among them — and `audio/webm` is exactly and only what the room drain sends
 * (`room-drain.ts`, hardcoded), because the joining service emits nothing else.
 *
 * So this adapter REFUSES a container it cannot honestly claim is supported, before spending a
 * paid call, and says which one it was. Sending WebM bytes under an `audio/ogg` label would be
 * the same class of lie as a typed provider version: WebM/Opus and Ogg/Opus share a codec and
 * not a container, so it would either fail opaquely or — far worse — half-decode.
 *
 * OVERRIDABLE WITHOUT A DEPLOY. The configured models (gemini-3.7-flash, gemini-3.1-pro-preview)
 * are newer than any contract that can be asserted from here, and the grounding is explicit that
 * this "must be probed, not assumed". One real probe call settles it; `GEMINI_STT_ALLOW_MIME`
 * lets that result be applied as an env edit rather than a code change.
 */
export const GEMINI_STT_ALLOW_MIME_ENV = "GEMINI_STT_ALLOW_MIME";
export const GEMINI_AUDIO_MIME_ALLOWLIST: readonly string[] = [
  "audio/wav", "audio/x-wav", "audio/mp3", "audio/mpeg", "audio/aiff",
  "audio/aac", "audio/ogg", "audio/flac",
];

/** 240 s, the house Vertex precedent (`lib/llm/gemini.ts`). A 900 s window is a large payload. */
const DEFAULT_TIMEOUT_MS = 240_000;

/**
 * The transcription instruction. Deliberately spare: it asks for the words and nothing else. Any
 * request for timestamps would yield model-generated text rather than decoder-aligned times, and
 * a request to name the language would produce a value this adapter is forbidden to trust.
 */
const PROMPT =
  "Transcribe this clinical consultation audio verbatim. Output only the transcript text, " +
  "with no preamble, no speaker labels, no timestamps and no commentary. " +
  "Preserve the original languages exactly as spoken; do not translate.";

export type GeminiSttConfig = {
  gateOn: boolean;
  model: string | null;
  project: string;
  location: string;
  allowedMime: readonly string[];
};

/** PURE — read the adapter's configuration out of an environment. */
export function readConfig(env: Record<string, string | undefined> = process.env): GeminiSttConfig {
  const raw = env[GEMINI_STT_ALLOW_MIME_ENV];
  const allowed = raw && raw.trim()
    ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : GEMINI_AUDIO_MIME_ALLOWLIST;
  const model = (env[GEMINI_STT_MODEL_ENV] ?? "").trim();
  return {
    gateOn: env[GEMINI_STT_GATE_ENV] === "1",
    // NO DEFAULT MODEL. A code default would silently pick a model, and every number this engine
    // produces would then be attributed to whatever the default happened to be that week — the
    // same class of failure as a typed provider label. Unset with the gate ON is a LOUD config
    // error (Build 3 §A), not a quiet substitution.
    model: model === "" ? null : model,
    project: env.GCP_PROJECT ?? "",
    location: env.GCP_LOCATION || "asia-south1",
    allowedMime: allowed,
  };
}

/** PURE — the native `:generateContent` URL. Not the OpenAI-compat endpoint: that one discards usage. */
export function generateContentUrl(cfg: Pick<GeminiSttConfig, "project" | "location" | "model">): string {
  const host = cfg.location === "global" ? "aiplatform.googleapis.com" : `${cfg.location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${cfg.project}/locations/${cfg.location}/publishers/google/models/${cfg.model}:generateContent`;
}

/** PURE — the base content type, without codec/charset parameters. */
export function baseMime(contentType: string): string {
  return (contentType || "").split(";")[0]!.trim().toLowerCase();
}

export function isMimeAllowed(contentType: string, allowed: readonly string[]): boolean {
  return allowed.includes(baseMime(contentType));
}

/**
 * PURE — money from the usage block of the call just made, or NULL.
 *
 * NULL IS NOT ZERO AND IS NOT A GUESS. PRD §5: "If the response carries no usage, `costUsd` stays
 * null and the run is flagged COST_UNREPORTED — never estimated inside the adapter." A zero here
 * would tell the daily budget cap that a paid call was free; a duration-derived estimate would
 * put a number that nobody measured into a column the spend ledger audits.
 *
 * The rates live in the environment rather than in code so a price change is a config edit. A
 * missing rate yields null for the same reason: an unpriced token count is not a cost.
 */
export function deriveCostUsd(
  usage: unknown,
  env: Record<string, string | undefined> = process.env,
): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const promptTokens = Number(u.promptTokenCount);
  const outputTokens = Number(u.candidatesTokenCount);
  if (!Number.isFinite(promptTokens) && !Number.isFinite(outputTokens)) return null;

  const inRate = Number(env[GEMINI_STT_AUDIO_RATE_ENV]);
  const outRate = Number(env[GEMINI_STT_OUTPUT_RATE_ENV]);
  if (!Number.isFinite(inRate) && !Number.isFinite(outRate)) return null;

  const inCost = Number.isFinite(promptTokens) && Number.isFinite(inRate) ? (promptTokens / 1000) * inRate : 0;
  const outCost = Number.isFinite(outputTokens) && Number.isFinite(outRate) ? (outputTokens / 1000) * outRate : 0;
  return Math.round((inCost + outCost) * 1e6) / 1e6;
}

/**
 * PURE — the model string THE RESPONSE reported, or null.
 *
 * Verbatim from the response body, never from `GEMINI_STT_MODEL`. The whole reason
 * `engineVersion` was added to the contract (PRD §5 amendment) is that a receipt naming a model
 * the provider never confirmed is worse than an absent one — it refuses loudly instead of lying
 * quietly. If Vertex stops echoing `modelVersion`, this returns null and `receipt_complete` goes
 * false, which is the correct and visible outcome.
 */
export function reportedModel(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  for (const k of ["modelVersion", "model"]) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * PURE — pull the transcript out of a `:generateContent` body, or say why not.
 *
 * A 200 IS NOT A SUCCESS. A truncated response returns HTTP 200 carrying plausible text, and a
 * transcript cut off at the token ceiling would be scored as a bad engine rather than as a failed
 * call — the likeliest silent failure mode for a 15-minute code-mixed window in Devanagari or
 * Kannada, where tokens-per-character is far worse than English. `finishReason` is therefore
 * inspected before the text is trusted, and anything but a clean stop is an ERROR.
 */
export function parseGenerateContent(body: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "malformed_response" };
  const b = body as Record<string, unknown>;

  const promptFeedback = b.promptFeedback as Record<string, unknown> | undefined;
  if (promptFeedback && typeof promptFeedback.blockReason === "string") {
    return { ok: false, error: `blocked:${promptFeedback.blockReason}` };
  }

  const candidates = b.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return { ok: false, error: "empty_candidates" };

  const c0 = candidates[0] as Record<string, unknown>;
  const finish = typeof c0.finishReason === "string" ? c0.finishReason : null;
  if (finish && finish !== "STOP") {
    // MAX_TOKENS, SAFETY, RECITATION, … — all of them mean the text below is not the whole
    // answer. Named rather than swallowed so it is legible in the runs table.
    return { ok: false, error: `finish_${finish.toLowerCase()}` };
  }

  const content = c0.content as Record<string, unknown> | undefined;
  const parts = content?.parts;
  if (!Array.isArray(parts)) return { ok: false, error: "no_content_parts" };

  const text = parts
    .map((p) => (typeof p === "object" && p !== null ? (p as Record<string, unknown>).text : null))
    .filter((t): t is string => typeof t === "string")
    .join("")
    .trim();

  if (!text) return { ok: false, error: "empty_transcript" };
  return { ok: true, text };
}

const fail = (error: string, latencyMs = 0): SttTranscribeResult => ({
  original: null, english: null, language: null, latencyMs, costUsd: null, engineVersion: null, error,
});

export const geminiAdapter: SttAdapter = {
  key: "gemini",
  capabilities: {
    tiers: ["asr"],
    stages: ["room", "note"],
    languages: ["multi", "indic"],
    streaming: false,
    // NOT a translator. `translates: true` would advertise an English output this adapter never
    // produces — it returns `english: null` on every branch, because a translate call was never
    // made. The Sarvam post-mortem is the precedent for not claiming a product you did not run.
    translates: false,
    async: false,
  },

  async transcribe(audio, opts): Promise<SttTranscribeResult> {
    const cfg = readConfig();

    // ── Gate first, so a disabled engine makes NO network call and costs nothing. ───────────
    if (!cfg.gateOn) return fail("gemini_stt_disabled");

    // ── A LOUD config error, never a silently-chosen model. ────────────────────────────────
    if (!cfg.model) return fail("gemini_stt_model_unset");
    if (!cfg.project) return fail("gcp_project_unset");
    if (!process.env.GCP_SA_KEY) return fail("gcp_sa_key_unset");

    // ── The container guard, BEFORE the paid call. ─────────────────────────────────────────
    if (!isMimeAllowed(opts.contentType, cfg.allowedMime)) {
      return fail(`unsupported_audio_mime:${baseMime(opts.contentType)}`);
    }

    const t0 = Date.now();
    let token: string;
    try {
      // getVertexAccessToken THROWS on a bad or absent key. Caught here and converted into the
      // error state: an adapter that throws would surface as an unhandled drain exception rather
      // than as a named engine failure on the run row.
      token = await getVertexAccessToken();
    } catch (e) {
      return fail(`auth_failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`, Date.now() - t0);
    }

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(generateContentUrl(cfg), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: PROMPT },
              { inlineData: { mimeType: baseMime(opts.contentType), data: Buffer.from(audio).toString("base64") } },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(tid);
      const latencyMs = Date.now() - t0;

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // 429 / RESOURCE_EXHAUSTED is called out by name: the CDMSS incident established that
        // Vertex 403/429s there were a CONCURRENCY QUOTA, not an IAM fault, and an opaque
        // `http_429` in the runs table sends the next reader down the permissions path.
        const kind = res.status === 429 ? "rate_limited" : `http_${res.status}`;
        return fail(`${kind}: ${body.slice(0, 200)}`, latencyMs);
      }

      const body = (await res.json().catch(() => null)) as unknown;
      const parsed = parseGenerateContent(body);
      if (!parsed.ok) return fail(parsed.error, latencyMs);

      return {
        original: parsed.text,
        // No translate call was made, so there is no English to claim.
        english: null,
        // No language parameter exists on this API; see the header.
        language: null,
        latencyMs,
        costUsd: deriveCostUsd((body as Record<string, unknown>)?.usageMetadata),
        engineVersion: reportedModel(body),
        error: null,
      };
    } catch (e) {
      clearTimeout(tid);
      const latencyMs = Date.now() - t0;
      if (controller.signal.aborted) return fail(`timeout_${DEFAULT_TIMEOUT_MS}ms`, latencyMs);
      return fail(`network: ${String((e as Error)?.message ?? e).slice(0, 160)}`, latencyMs);
    }
  },

  /**
   * Health without spending anything. A real `:generateContent` probe would cost money on every
   * health-page render, so this checks that the engine COULD run — gate, model, project, key and
   * a token exchange — and says which piece is missing when it could not.
   */
  async health() {
    const cfg = readConfig();
    const t0 = Date.now();
    if (!cfg.gateOn) return { ok: false, latencyMs: 0, error: "gemini_stt_disabled" };
    if (!cfg.model) return { ok: false, latencyMs: 0, error: "gemini_stt_model_unset" };
    if (!cfg.project) return { ok: false, latencyMs: 0, error: "gcp_project_unset" };
    try {
      await getVertexAccessToken();
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, error: String((e as Error)?.message ?? e).slice(0, 120) };
    }
  },
};
