/**
 * Gemini (Vertex AI) router — every ETA chat completion goes through here.
 *
 * ORDER: Vertex Gemini for the surface (when configured + flagged) → a SECOND Vertex model and/or
 * region (LLM_FALLBACK_MODELS, entries `model[@region]`; default gemini-2.5-flash then
 * gemini-2.5-flash-lite, in GCP_FALLBACK_LOCATION or else GCP_LOCATION). V, 23 Oct: nothing in ETA
 * calls OpenRouter any more, so the fallback is Vertex too; same auth (lib/gcp-auth.ts), same
 * deadline discipline.
 *
 * THERE IS NO OLLAMA IN ANY CHAIN (V, 22 Sep: qwen out of ETA entirely). qwen2.5:14b was the
 * local default and the fallback; it cost 11.55 GB on a 24 GB Mini and was reached from Vercel
 * through the Cloudflare tunnel. Embeddings still use nomic on Ollama — a separate concern, and
 * the KB corpus is nomic-768 — but nothing in this file talks to Ollama at all.
 *
 * THE PROVIDER COMES FROM THE CALL. routedChat returns `gemini:<model>` or
 * `gemini:<model>@<region>` for a fallback stage — what actually answered, never a literal. In August this router swallowed
 * Gemini errors and served qwen for two months while traces said Gemini; scribe_llm_health now
 * reads this value verbatim and names a fallback on a Gemini-flagged surface `silent_fallback`.
 *
 * Vertex env: GCP_SA_KEY, GCP_PROJECT, GCP_LOCATION, and a flag — GEMINI_ALL=1 or GEMINI_<SURFACE>=1.
 * Fallback env: LLM_FALLBACK_MODELS (comma list of `model[@region]`), GCP_FALLBACK_LOCATION (default
 * region of an entry without one; else GCP_LOCATION). No OpenRouter key is read anywhere here.
 */
import { getVertexAccessToken, MINT_TIMEOUT_MS } from "../gcp-auth";

const GCP_LOCATION = process.env.GCP_LOCATION || "asia-south1";
const GCP_PROJECT = process.env.GCP_PROJECT || "";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-pro";
export const GEMINI_FLASH_MODEL = process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";

export function geminiConfigured(): boolean {
  return Boolean(GCP_PROJECT && process.env.GCP_SA_KEY);
}

function vertexBaseURL(region: string = GCP_LOCATION): string {
  const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1beta1/projects/${GCP_PROJECT}/locations/${region}/endpoints/openapi`;
}
function vertexModelName(model: string): string {
  return model.startsWith("google/") ? model : `google/${model}`;
}

/** The Gemini model to use for `surface`, or undefined to go straight to the Vertex fallback chain. */
export function pickGemini(surface: string, tier: "pro" | "flash" = "pro"): string | undefined {
  if (!geminiConfigured()) return undefined;
  const on = process.env.GEMINI_ALL === "1" || process.env[`GEMINI_${surface.toUpperCase()}`] === "1";
  if (!on) return undefined;
  return tier === "flash" ? GEMINI_FLASH_MODEL : GEMINI_MODEL;
}

type Msg = { role: string; content: string };
type ChatOut = { ok: boolean; content: string; error?: string; status?: number };

/** openaiChat's own per-call ceiling when a caller passes none. Named so routedChat's overall
 * deadline default (below) can reference the same number instead of a second magic constant. */
const GEMINI_DEFAULT_TIMEOUT_MS = 240_000;

async function openaiChat(p: {
  url: string; authToken: string; model: string; messages: Msg[];
  temperature?: number; responseJson?: boolean; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal;
}): Promise<ChatOut> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), p.timeoutMs ?? GEMINI_DEFAULT_TIMEOUT_MS);
  if (p.signal) {
    if (p.signal.aborted) controller.abort();
    else p.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const body: Record<string, unknown> = { model: p.model, messages: p.messages, temperature: p.temperature ?? 0, stream: false };
    if (p.responseJson) body.response_format = { type: "json_object" };
    if (p.maxTokens) body.max_tokens = p.maxTokens;
    const res = await fetch(`${p.url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.authToken}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) { const t = await res.text().catch(() => ""); return { ok: false, content: "", error: `http_${res.status}: ${t.slice(0, 160)}`, status: res.status }; }
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = (j.choices?.[0]?.message?.content ?? "").trim();
    if (!content) return { ok: false, content: "", error: "empty_response", status: res.status };
    return { ok: true, content, status: res.status };
  } catch (e) {
    return { ok: false, content: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Gemini-only attempt for `surface`. Returns null when Gemini is off/unconfigured, or a ChatOut when
 * it tried. For callers that are Gemini-ONLY BY DESIGN (fusion, live translate), which report
 * `off`/`error` rather than fall back. A caller that wants a fallback uses routedChat instead.
 */
export async function geminiChatIfOn(
  surface: string, tier: "pro" | "flash", messages: Msg[],
  opts: { temperature?: number; responseJson?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ChatOut | null> {
  const gModel = pickGemini(surface, tier);
  if (!gModel) return null;
  try {
    // opts.signal already existed on this function's own contract; it simply never reached the
    // token mint before getVertexAccessToken had a signal to accept. Passing it through here is
    // the same fix applied to the sibling call site in routedChat, for this caller's own signal.
    const token = await getVertexAccessToken(opts.signal, MINT_TIMEOUT_MS);
    return await openaiChat({
      url: vertexBaseURL(), authToken: token, model: vertexModelName(gModel),
      messages, temperature: opts.temperature, responseJson: opts.responseJson,
      maxTokens: 8192, timeoutMs: opts.timeoutMs, signal: opts.signal,
    });
  } catch (e) {
    console.warn(`[llm] gemini (${surface}) threw: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    return { ok: false, content: "", error: "gemini_threw" };
  }
}

/** One Vertex model in one region. `model` is bare (no `google/`). */
export type VertexTarget = { model: string; region: string };

/** The label of what answered, derived from the target that was called — never a literal. */
export function vertexLabel(t: VertexTarget): string {
  return `gemini:${t.model}@${t.region}`;
}

/**
 * PURE. Parse a comma list of `model[@region]`. An entry that is not a Vertex model name (an old
 * OpenRouter slug such as `meta-llama/llama-4-scout`, or a region that is not [a-z0-9-]) is dropped,
 * so a stale env value can never send a non-Gemini slug to Vertex.
 */
export function parseVertexTargets(raw: string, defaultRegion: string): VertexTarget[] {
  const out: VertexTarget[] = [];
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [name, reg] = entry.split("@");
    const model = (name ?? "").trim().replace(/^google\//, "");
    const region = (reg ?? "").trim() || defaultRegion;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model) || !/^[a-z0-9-]+$/.test(region)) continue;
    out.push({ model, region });
  }
  return out;
}

/** The Vertex fallback chain, in order. Only the env can change it; never Ollama, never OpenRouter. */
export const LLM_FALLBACK_DEFAULT = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
export function llmFallbackTargets(env: Record<string, string | undefined> = process.env): VertexTarget[] {
  const region = (env.GCP_FALLBACK_LOCATION ?? "").trim() || (env.GCP_LOCATION ?? "").trim() || "asia-south1";
  const parsed = parseVertexTargets((env.LLM_FALLBACK_MODELS ?? "").trim(), region);
  return parsed.length > 0 ? parsed : parseVertexTargets(LLM_FALLBACK_DEFAULT.join(","), region);
}
/** The same chain as `model@region` strings. */
export function llmFallbackModels(env: Record<string, string | undefined> = process.env): string[] {
  return llmFallbackTargets(env).map((t) => `${t.model}@${t.region}`);
}

/**
 * What routedChat will TRY FIRST for `surface`: a prediction, for labels shown BEFORE a call (a stage
 * "start" event, a health probe's configured model). The answer that counts is the `provider`
 * routedChat returns afterwards — record that, never this.
 */
export function firstRoute(surface: string, tier: "pro" | "flash" = "pro"): string {
  const g = pickGemini(surface, tier);
  return g ? `gemini:${g}` : vertexLabel(llmFallbackTargets()[0]!);
}

/** A Vertex failure with a closed code. Safe to store on a row and to log: never a message, header or token. */
export class VertexError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "VertexError"; this.code = code; }
}
export type VertexChatResult = { content: string; model: string; latency_ms: number };

/**
 * One chat completion on Vertex (OpenAI-compatible endpoint), for callers that hold their own
 * model chain (lib/jev/translate.ts, lib/rubrics/llm.ts). Same auth and same abort discipline as
 * routedChat. `model` in the result is the label of the target that answered (`gemini:<m>@<region>`).
 * Throws VertexError with a closed code: vertex_not_configured, vertex_auth_failed, vertex_timeout,
 * vertex_abort, vertex_unreachable, vertex_http_<n>, vertex_empty.
 */
export async function vertexChat(args: {
  model: string; region?: string;
  messages?: Msg[]; system?: string; user?: string;
  temperature?: number; responseJson?: boolean; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}): Promise<VertexChatResult> {
  if (!geminiConfigured()) throw new VertexError("vertex_not_configured");
  const [target] = parseVertexTargets(
    args.region ? `${args.model}@${args.region}` : args.model,
    (args.env?.GCP_FALLBACK_LOCATION ?? "").trim() || GCP_LOCATION,
  );
  if (!target) throw new VertexError("vertex_bad_model");
  const messages: Msg[] = args.messages ?? [
    { role: "system", content: args.system ?? "" },
    { role: "user", content: args.user ?? "" },
  ];
  const t0 = Date.now();
  let token: string;
  try {
    token = await getVertexAccessToken(args.signal, Math.min(MINT_TIMEOUT_MS, args.timeoutMs ?? MINT_TIMEOUT_MS));
  } catch {
    if (args.signal?.aborted) throw new VertexError("vertex_abort");
    throw new VertexError("vertex_auth_failed");
  }
  const r = await openaiChat({
    url: vertexBaseURL(target.region), authToken: token, model: vertexModelName(target.model),
    messages, temperature: args.temperature, responseJson: args.responseJson,
    maxTokens: args.maxTokens, timeoutMs: args.timeoutMs ?? FALLBACK_STAGE_CAP_MS, signal: args.signal,
  });
  if (r.ok) return { content: r.content, model: vertexLabel(target), latency_ms: Date.now() - t0 };
  if (r.status && r.status !== 200) throw new VertexError(`vertex_http_${r.status}`);
  if (r.error === "empty_response") throw new VertexError("vertex_empty");
  if (args.signal?.aborted) throw new VertexError("vertex_abort");
  if (/abort/i.test(r.error ?? "")) throw new VertexError("vertex_timeout");
  throw new VertexError("vertex_unreachable");
}

export type RoutedChatResult = { ok: boolean; content: string; error?: string; latency_ms: number; provider: string };

// ---------------------------------------------------------------------------
// F1 — an OVERALL deadline, on top of each stage's own per-call timeout
// ---------------------------------------------------------------------------
//
// routedChat is the Vertex primary once, then up to two more Vertex targets — each already bounded by its own
// `timeoutMs` (or GEMINI_DEFAULT_TIMEOUT_MS / the 60_000 fallback-stage cap when none is
// passed). Nothing bounded the SUM: a caller with a generous per-call timeout could wait 3x it if
// every stage stalled to its own ceiling. This is that missing outer bound — it changes nothing
// for the ordinary case where one stage answers within its own timeout.

export const ROUTED_CHAT_DEADLINE_ENV = "ETA_ROUTED_CHAT_DEADLINE_MS";

/** Ceiling on a single fallback stage's OWN slice of the deadline — the former OpenRouter client's
 * default per-call timeout, kept as is, so a fallback stage is never budgeted more than it would use unprompted.
 * Exported so routedChat's own fallback call can hand each stage this SAME number rather
 * than a second, independently-maintained copy of it (round 2 fix, below). */
export const FALLBACK_STAGE_CAP_MS = 60_000;

/**
 * A fallback stage's own budget: never more than FALLBACK_STAGE_CAP_MS, and never more than the
 * caller's own timeoutMs when that is smaller. ONE place, used by both the deadline sum and the
 * actual fallback call (round-3 Refuter trivia: the expression used to be duplicated
 * textually in both places, which made "the same number" a claim rather than something the code
 * enforced).
 */
function fallbackBudgetMs(perCallTimeoutMs: number | undefined): number {
  return Math.min(perCallTimeoutMs ?? FALLBACK_STAGE_CAP_MS, FALLBACK_STAGE_CAP_MS);
}

/**
 * The mint's own budget: getVertexAccessToken's RSA-sign (synchronous, effectively free) plus its
 * OAuth token-exchange fetch. Round-3 Refuter note, promoted to a fix: this used to have no timer
 * of its own at all, so it was paid entirely out of the overall deadline's 10% slack — and because
 * the slack scales with the CALLER's budget, the smallest callers were the tightest (llm-cleanup's
 * 8 s timeout left only 2.4 s of slack to cover both clock skew and a cold OAuth exchange). Now
 * counted in the sum below AND passed to getVertexAccessToken as its own timeout, so the two agree.
 *
 * Defined in lib/gcp-auth.ts (the file that actually does the minting, and the one that needs this
 * value as its own internal default) and re-exported here so every existing importer of it from
 * this module keeps working unchanged — one mint budget, not two, per Fable's ruling, 23 Sep,
 * closing the round-4 Refuter calibration note. See that file's comment for the PROVISIONAL note on
 * the value itself and where the calibration data will come from.
 */
export { MINT_TIMEOUT_MS };

/**
 * PURE. The overall wall-clock budget for one routedChat call.
 *
 * `ETA_ROUTED_CHAT_DEADLINE_MS` overrides outright, when it parses as a positive number.
 *
 * RULING (Fable, 22 Sep, on the Refuter's PASS-with-flag): the previous rule — 1.5x the per-call
 * timeout applied uniformly to every stage — collapsed for the case nearly every real caller is
 * in: an explicit `timeoutMs` shared by all three stages. There, 1.5x gave a hung primary stage
 * its own full timeout and left only HALF a timeout for the first fallback, with the second
 * fallback unreachable — the exact failure this deadline exists to prevent, just moved one stage
 * later. Measured by the Refuter: timeoutMs=200ms, deadline=300ms, a fallback that would have
 * answered at 150ms (inside its own 200ms budget) was killed at 300ms instead.
 *
 * THE RULE budgets each KIND of step separately instead of scaling one number three ways:
 *   mint budget      = MINT_TIMEOUT_MS — always counted, even on a call where Gemini turns out to
 *                       be off for this surface: a token that is never minted costs nothing at
 *                       runtime, and a few extra seconds of headroom on that path is harmless;
 *   primary budget   = the caller's timeoutMs, or GEMINI_DEFAULT_TIMEOUT_MS (240 s) when none given
 *                       — Vertex's OWN default, unchanged from before;
 *   fallback budget  = fallbackBudgetMs(timeoutMs) = min(caller's timeoutMs, FALLBACK_STAGE_CAP_MS)
 *                       — a fallback stage never inherits a giant primary timeout, and never
 *                       needs more than its own default would give it unprompted;
 *   fallback count   = `fallbackCount`, the caller's resolved chain length when routedChat passes
 *                       one (so this and the loop that actually iterates the chain are PROVABLY
 *                       reading the same list, not two separately-resolved calls to
 *                       llmFallbackModels that happen to agree today — round-3 Refuter trivia), or
 *                       llmFallbackTargets(env).length when called standalone (round-2 fix: a fixed
 *                       2 silently mis-summed the moment `LLM_FALLBACK_MODELS` configured a
 *                       different-length chain);
 *   deadline         = (mint + primary + fallback count x fallback budget) x 1.10.
 * The 10% slack absorbs `Date.now()` skew between this timer and each stage's own internal one; it
 * is not meant to cover a step the sum did not already count.
 *
 * This is still NEVER TIGHTER than the primary stage's own timeout (the sum only adds to it), and
 * a call that succeeds within its own stage's timeout — the normal case — is unaffected either way.
 *
 * THE SUM IS ONLY HONEST IF THE RUNTIME MATCHES IT — see routedChat below, which calls each
 * fallback stage with EXACTLY `fallbackBudgetMs(timeoutMs)`, never the caller's raw `timeoutMs`
 * (round-2 fix), and now calls getVertexAccessToken with EXACTLY `MINT_TIMEOUT_MS` (round-3 fix).
 */
export function routedChatDeadlineMs(
  perCallTimeoutMs: number | undefined,
  env: Record<string, string | undefined> = process.env,
  fallbackCount: number = llmFallbackTargets(env).length,
): number {
  const raw = env[ROUTED_CHAT_DEADLINE_ENV];
  const override = raw !== undefined ? Number(raw) : NaN;
  if (Number.isFinite(override) && override > 0) return override;
  const primaryBudget = perCallTimeoutMs ?? GEMINI_DEFAULT_TIMEOUT_MS;
  const fallbackBudget = fallbackBudgetMs(perCallTimeoutMs);
  return Math.round((MINT_TIMEOUT_MS + primaryBudget + fallbackCount * fallbackBudget) * 1.10);
}

/** Thrown internally when the overall deadline (or the caller's own signal) fires while something
 * is awaited that does not itself accept an AbortSignal (getVertexAccessToken). Never escapes
 * routedChat — caught and turned into the same RoutedChatResult shape every other failure returns. */
class RoutedChatDeadline extends Error {
  constructor() { super("deadline_exceeded"); this.name = "RoutedChatDeadline"; }
}

/**
 * Reject with RoutedChatDeadline as soon as `signal` aborts, whichever settles first.
 *
 * getVertexAccessToken now takes its OWN `signal` (fixed below — the FORMER limitation this
 * existed to work around), so the token-exchange fetch is genuinely cancelled, not merely
 * abandoned. This wrapper stays as the SAME kind of redundant second guard the Refuter's round-1
 * review already found and accepted for D6/D7 ("removing either individually leaves the others; a
 * gap only shows if both are removed together") — it costs nothing and protects the same call
 * against a FUTURE getVertexAccessToken (or a test double) that does not honour its signal.
 */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RoutedChatDeadline());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RoutedChatDeadline());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

/**
 * Run a chat completion: Vertex Gemini for `surface` when flagged + configured, then the Vertex
 * fallback chain. `provider` names whichever call answered — `gemini:<model>` (primary) or
 * `gemini:<model>@<region>` (a fallback stage) — and
 * `none` only when nothing did. A Gemini failure is logged by name before the fallback runs, so a
 * fallback is never silent in the logs either.
 *
 * OVERALL DEADLINE (F1, ETA_ROUTED_CHAT_DEADLINE_MS / routedChatDeadlineMs): a single AbortSignal
 * — `deadline.signal` below — is passed to every stage's `signal` argument INSTEAD OF `p.signal`
 * directly (it still fires on `p.signal` too; the two are combined). When it fires mid-stage,
 * openaiChat aborts their own in-flight fetch immediately, exactly as they already
 * do for `p.signal` today — nothing new was needed there. The stage running when it fires is
 * logged by name. `error` on a deadline is `deadline_exceeded:<stage>`, distinct from `aborted`
 * (the caller's own signal) and from `all_failed: ...` (every stage ran to its own conclusion).
 *
 * FORMER LIMITATION, NOW FIXED: `getVertexAccessToken()` takes an optional `signal`
 * (lib/gcp-auth.ts) wired straight into its own token-exchange `fetch`. The deadline no longer
 * just stops routedChat WAITING on it (raceSignal) — it cancels the fetch itself, the same as
 * every other in-flight call this deadline aborts.
 */
export async function routedChat(p: {
  surface: string; tier?: "pro" | "flash"; messages: Msg[];
  temperature?: number; responseJson?: boolean; timeoutMs?: number; signal?: AbortSignal; maxTokens?: number;
}): Promise<RoutedChatResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  // Resolved ONCE and reused for both the sum below and the loop that actually iterates it, so the
  // two are provably the same list rather than two separate calls to llmFallbackTargets that happen
  // to agree today (round-3 Refuter trivia: budgeting one chain and running another was possible
  // only in theory, since both read plain `process.env` here, but nothing enforced it).
  const fallbackTargets = llmFallbackTargets();
  const deadlineMs = routedChatDeadlineMs(p.timeoutMs, process.env, fallbackTargets.length);
  const deadline = new AbortController();
  let deadlineFired = false;
  let stage = "start";
  const deadlineTimer = setTimeout(() => { deadlineFired = true; deadline.abort(); }, deadlineMs);
  if (p.signal) {
    if (p.signal.aborted) deadline.abort();
    else p.signal.addEventListener("abort", () => deadline.abort(), { once: true });
  }
  const signal = deadline.signal;
  // ONE mint per call, shared by every stage: the deadline sum counts a single MINT_TIMEOUT_MS.
  let token: string | undefined;
  let mintFailed = false;
  const onDeadline = (): RoutedChatResult => {
    console.warn(`[llm] routedChat (${p.surface}) deadline exceeded after ${deadlineMs}ms during ${stage}`);
    return { ok: false, content: "", error: `deadline_exceeded:${stage}`, latency_ms: Date.now() - t0, provider: "none" };
  };

  try {
    const gModel = pickGemini(p.surface, p.tier ?? "pro");
    if (gModel) {
      stage = `gemini:${gModel}`;
      try {
        token = await raceSignal(getVertexAccessToken(signal, MINT_TIMEOUT_MS), signal);
        const r = await openaiChat({
          url: vertexBaseURL(), authToken: token, model: vertexModelName(gModel),
          messages: p.messages, temperature: p.temperature, responseJson: p.responseJson,
          maxTokens: p.maxTokens ?? 8192, timeoutMs: p.timeoutMs, signal,
        });
        if (r.ok) return { ok: true, content: r.content, latency_ms: Date.now() - t0, provider: `gemini:${gModel}` };
        if (deadlineFired) return onDeadline();
        errors.push(`gemini:${r.status ? `http_${r.status}` : "failed"}`);
        console.warn(`[llm] gemini ${gModel} (${p.surface}) ${r.error ?? "empty"} -> vertex fallback`);
      } catch (e) {
        if (!(p.signal?.aborted && !deadlineFired) && (e instanceof RoutedChatDeadline || deadlineFired)) return onDeadline();
        if (!token) mintFailed = true; // the credential itself failed: the fallback stages share it
        errors.push("gemini:threw");
        console.warn(`[llm] gemini (${p.surface}) threw -> vertex fallback: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
      }
    }
    if (p.signal?.aborted) return { ok: false, content: "", error: "aborted", latency_ms: Date.now() - t0, provider: "none" };
    if (deadlineFired) return onDeadline();

    // Round-2 fix: the SAME cap routedChatDeadlineMs assumed when it summed the deadline — never
    // the caller's raw timeoutMs. Handing a fallback the primary's own (possibly 240 s) budget was
    // the bug: the arithmetic capped it, the runtime didn't, so a merely-slow fallback (not even
    // hung) could consume the whole remaining deadline and leave the next stage unreachable.
    const fallbackTimeoutMs = fallbackBudgetMs(p.timeoutMs);
    if (!geminiConfigured()) {
      // No Vertex credential at all: there is nowhere left to go (no OpenRouter, no Ollama).
      return { ok: false, content: "", error: "all_failed: vertex_not_configured", latency_ms: Date.now() - t0, provider: "none" };
    }
    if (mintFailed) {
      return { ok: false, content: "", error: `all_failed: ${errors.join("; ")}`.slice(0, 300), latency_ms: Date.now() - t0, provider: "none" };
    }
    for (const target of fallbackTargets) {
      // Do not spend a stage re-asking the exact model+region that just failed as the primary.
      if (gModel && target.model === gModel.replace(/^google\//, "") && target.region === GCP_LOCATION) continue;
      const label = vertexLabel(target);
      stage = label;
      try {
        token ??= await raceSignal(getVertexAccessToken(signal, MINT_TIMEOUT_MS), signal);
        const r = await openaiChat({
          url: vertexBaseURL(target.region), authToken: token, model: vertexModelName(target.model),
          messages: p.messages, temperature: p.temperature, responseJson: p.responseJson,
          maxTokens: p.maxTokens ?? 8192, timeoutMs: fallbackTimeoutMs, signal,
        });
        if (r.ok) return { ok: true, content: r.content, latency_ms: Date.now() - t0, provider: label };
        if (deadlineFired) return onDeadline();
        // A closed code only: a status number or a word, never the response text.
        errors.push(`${label}=${r.status && r.status !== 200 ? `http_${r.status}` : r.error === "empty_response" ? "empty" : "failed"}`);
        if (p.signal?.aborted) break;
      } catch (e) {
        if (p.signal?.aborted && !deadlineFired) break; // the caller aborted: reported as `aborted` below
        if (e instanceof RoutedChatDeadline || deadlineFired) return onDeadline();
        errors.push(`${label}=threw`);
        if (p.signal?.aborted) break;
      }
    }
    // PRE-EXISTING GAP, fixed in passing (F1): the caller-abort check existed BEFORE this loop but
    // not after it, so a signal that aborted mid-loop fell through to `all_failed` instead of the
    // `aborted` shape every other abort path already returns.
    if (p.signal?.aborted) return { ok: false, content: "", error: "aborted", latency_ms: Date.now() - t0, provider: "none" };
    return { ok: false, content: "", error: `all_failed: ${errors.join("; ")}`.slice(0, 300), latency_ms: Date.now() - t0, provider: "none" };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * routedChat in JSON mode, parsed. `json` is null when the call failed OR the content did not parse,
 * and `error` says which — a parse failure is not dressed up as an answer.
 */
export async function routedChatJson<T = unknown>(p: Parameters<typeof routedChat>[0]): Promise<{
  ok: boolean; json: T | null; provider: string; latency_ms: number; error?: string;
}> {
  const rc = await routedChat({ ...p, responseJson: true });
  if (!rc.ok) return { ok: false, json: null, provider: rc.provider, latency_ms: rc.latency_ms, error: rc.error };
  try {
    return { ok: true, json: JSON.parse(rc.content) as T, provider: rc.provider, latency_ms: rc.latency_ms };
  } catch {
    return { ok: false, json: null, provider: rc.provider, latency_ms: rc.latency_ms, error: "json_parse_failed" };
  }
}
