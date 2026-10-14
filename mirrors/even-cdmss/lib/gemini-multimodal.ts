/**
 * lib/gemini-multimodal.ts — Vertex Gemini multimodal transport (DA.2).
 *
 * Thin wrapper over the NATIVE Vertex `:generateContent` endpoint so we can send
 * an uploaded clinical document (PDF / PNG / JPEG, base64 inlineData) straight to
 * Gemini 2.5 to read it — typed, scanned, or handwritten. Uses the SAME service-
 * account auth as the rest of CAT (getVertexAccessToken); **no new npm dependency**.
 *
 * PHI: the document only transits Vertex/Tokyo under V's BAA (same posture as the
 * OpenAI-compat chat path). Nothing is persisted here. Soft-fails to null so a
 * region/model/credential problem degrades to "couldn't read the document",
 * never a thrown request.
 */

import { getVertexAccessToken, vertexSaEmail } from './gcp-auth';
import { GEMINI_MODEL, geminiConfigured, openrouterGeminiSlug, openrouterConfigured, vertexRegion } from './llm';
import { logEvent, buildEnvelope } from './trace';
import { billableOutputTokens } from './llm-cost-core';
import { buildDocRequestBody, DOC_READ_TIMEOUT_MS } from './doc-transport-core';
import { providerErrorPayload, providerCallsInFlight, beginProviderCall, endProviderCall } from './provider-error-core';

const GCP_LOCATION = process.env.GCP_LOCATION || 'asia-south1';
const GCP_PROJECT = process.env.GCP_PROJECT || '';

export const SUPPORTED_DOC_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

export interface MultimodalOpts {
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  // Cost/observability: when a traceId is given, this call self-logs an `llm_response` event with
  // token usage (from Vertex's usageMetadata) so multimodal reads show up in the LLM cost tracker.
  // The call is the SINGLE logger of its own llm_response — callers must not double-log it.
  traceId?: string;
  label?: string;
}

function vertexHost(): string {
  return GCP_LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${GCP_LOCATION}-aiplatform.googleapis.com`;
}

/**
 * BRIDGE transport — the same document read against OpenRouter's /chat/completions.
 * PDFs ride the file-parser plugin pinned to `native` (engine settled by the 30 Jul measurement:
 * pdf-text is blind on 67% of radiology and 54% of diagnostic PDFs, and the ~₹44/day saving is
 * not worth a silent clinical-value loss). Google-only provider pin. Returns null on ANY failure
 * — the caller treats null as unreadable, which is the whole point of §2.1.
 */
async function generateFromDocumentViaOpenRouter(
  slug: string,
  systemPrompt: string,
  userPrompt: string,
  base64: string,
  mime: string,
  opts: MultimodalOpts,
): Promise<string | null> {
  const t0 = Date.now();
  const body = buildDocRequestBody({
    model: slug, systemPrompt, userPrompt, base64, mime,
    maxOutputTokens: opts.maxOutputTokens, temperature: opts.temperature,
  });

  // A TIMEOUT, which the Vertex path below has never had — that absence is why Record audit HUNG
  // (measured >399s at "Reading document", no trace, no fallback) instead of failing.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DOC_READ_TIMEOUT_MS);
  beginProviderCall('openrouter');
  try {
    const res = await fetch(`${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const j = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
      error?: { message?: string; code?: unknown };
    } | null;

    // A corrupt source (measured: two 20KB radiology PDFs fail on BOTH engines) surfaces HERE as
    // an error, and must reach the caller as unreadable — never as an empty extract (§3).
    if (!res.ok || j?.error) {
      const payload = providerErrorPayload({
        provider: 'openrouter', label: opts.label || 'multimodal_read', feature: null, fellBackTo: 'none',
        intendedModel: slug, fallbackModel: null, region: null, saIdentity: null,
        error: j?.error ?? { status: res.status, message: `document read ${res.status}` },
        inFlightAtError: providerCallsInFlight(),
      });
      console.error('[provider-fallback] openrouter document read failed → unreadable:', JSON.stringify(payload));
      if (opts.traceId) await logEvent(opts.traceId, 'provider_error', opts.label || 'multimodal_read', payload, Date.now() - t0).catch(() => {});
      return null;
    }

    const text = (j?.choices?.[0]?.message?.content || '').trim();
    if (opts.traceId) {
      const u = j?.usage ?? {};
      const usage = { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0, total_tokens: u.total_tokens ?? 0 };
      await logEvent(opts.traceId, 'llm_response', opts.label || 'multimodal_read', {
        model: slug, provider: 'openrouter', multimodal: true, pdf_engine: isPdf(mime) ? 'native' : null,
        char_count: text.length, finish_reason: j?.choices?.[0]?.finish_reason ?? null,
        usage, cost_usd: u.cost ?? null,
      }, Date.now() - t0,
        buildEnvelope(undefined, {
          model: slug, provider: 'openrouter',
          tokensIn: usage.prompt_tokens, tokensOut: billableOutputTokens(usage),
        })).catch(() => {});
    }
    return text || null;
  } catch (e) {
    // Includes the AbortError on timeout — a hung read is now a failed read.
    const payload = providerErrorPayload({
      provider: 'openrouter', label: opts.label || 'multimodal_read', feature: null, fellBackTo: 'none',
      intendedModel: slug, fallbackModel: null, region: null, saIdentity: null,
      error: e, inFlightAtError: providerCallsInFlight(),
    });
    console.error('[provider-fallback] openrouter document read threw → unreadable:', JSON.stringify(payload));
    if (opts.traceId) await logEvent(opts.traceId, 'provider_error', opts.label || 'multimodal_read', payload, Date.now() - t0).catch(() => {});
    return null;
  } finally {
    clearTimeout(timer);
    endProviderCall('openrouter');
  }
}

const isPdf = (m: string): boolean => m === 'application/pdf';

/**
 * Send a system + user prompt plus one inline document to Gemini and return the
 * model's text. Returns null on any failure (caller treats null as "unreadable").
 */
export async function generateFromDocument(
  systemPrompt: string,
  userPrompt: string,
  base64: string,
  mimeType: string,
  opts: MultimodalOpts = {},
): Promise<string | null> {
  const model = opts.model || GEMINI_MODEL;
  // Normalise a couple of common mime variants Gemini expects.
  const mime = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;

  // BRIDGE (30 Jul 2026) — with GEMINI_VIA_OPENROUTER=1 the document read goes to OpenRouter,
  // because Vertex's native :generateContent endpoint below is 403 SERVICE_DISABLED on
  // clinical-infra. Flag unset ⇒ the Vertex path runs UNCHANGED (it must work byte-identically
  // the moment aiplatform.googleapis.com is re-enabled).
  const orSlug = openrouterGeminiSlug(model);
  if (orSlug && openrouterConfigured()) {
    return generateFromDocumentViaOpenRouter(orSlug, systemPrompt, userPrompt, base64, mime, opts);
  }

  if (!geminiConfigured()) {
    console.warn('[multimodal] gemini not configured — cannot read documents');
    return null;
  }

  let token: string;
  try {
    token = await getVertexAccessToken();
  } catch (e) {
    // Unit V-a1: a token-mint failure was a bare console.warn nothing reads. It is a Vertex
    // credential/IAM event and it names its region and service identity — exactly the diagnostic
    // the OpenRouter path cannot give us, and the reason Vertex is becoming primary.
    const payload = providerErrorPayload({
      provider: 'gemini', label: opts.label || 'multimodal_read', feature: null, fellBackTo: 'none',
      intendedModel: model, fallbackModel: null,
      region: vertexRegion(), saIdentity: vertexSaEmail(),
      error: e, inFlightAtError: providerCallsInFlight(),
    });
    console.error('[provider-fallback] vertex document read token mint failed → unreadable:', JSON.stringify(payload));
    if (opts.traceId) await logEvent(opts.traceId, 'provider_error', opts.label || 'multimodal_read', payload).catch(() => {});
    return null;
  }

  const url = `https://${vertexHost()}/v1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${model}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }, { inlineData: { mimeType: mime, data: base64 } }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.1,
      // 2.5-Pro is a thinking model — give it ample room so the JSON answer isn't truncated.
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    },
  };

  const t0 = Date.now();
  // ══ UNIT V-a1 (3 Aug 2026): THE READ THAT COULD HANG FOREVER IS NOW BOUNDED ═══════════════════
  // This fetch had NO signal, NO timeout and NO retry — the absence recorded a few lines above as
  // the reason Record audit HUNG (measured 30 Jul: >399 s at "Reading document", no trace, no
  // fallback) instead of failing. The OpenRouter transport directly above has had all three since
  // then; this one did not, and it is the path about to become primary.
  //
  // ⚠️ maxTries STAYS 1 — THERE IS NO RETRY IN THIS UNIT, and that is arithmetic, not caution.
  // The route budget is per DOCUMENT, and one IPD document is one doc_read plus IPD_ANALYZE_LEGS
  // analyze legs:
  //     1 try   180,000 + 3 × 200,000 =  780,000  in an 800,000 ms box   fits
  //     2 tries 360,750 + 3 × 200,000 =  960,750  in an 800,000 ms box   OVER by 160,750
  // The PRD's V-4 checked a retry against the per-CALL budget rather than the route total. The
  // BOUNDING is the safety fix and it is free, so it ships here; the RETRY moves to V-a2, where the
  // budgets are re-derived on clean post-Unit-D data with the prognosis legs counted.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DOC_READ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Structured, and NAMING THE REGION AND SERVICE IDENTITY. A per-region quota denial and a
      // global IAM denial read identically without them, and the old console.warn carried neither.
      const payload = providerErrorPayload({
        provider: 'gemini', label: opts.label || 'multimodal_read', feature: null, fellBackTo: 'none',
        intendedModel: model, fallbackModel: null,
        region: vertexRegion(), saIdentity: vertexSaEmail(),
        error: { status: res.status, message: `document read ${res.status}: ${detail.slice(0, 300)}` },
        inFlightAtError: providerCallsInFlight(),
      });
      console.error('[provider-fallback] vertex document read failed → unreadable:', JSON.stringify(payload));
      if (opts.traceId) await logEvent(opts.traceId, 'provider_error', opts.label || 'multimodal_read', payload, Date.now() - t0).catch(() => {});
      return null;
    }
    const j = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      promptFeedback?: { blockReason?: string };
      // thoughtsTokenCount: Gemini 2.5 returns the thinking-token count here when the model
      // reasons. It is billed at the OUTPUT rate but is NOT in candidatesTokenCount.
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; thoughtsTokenCount?: number };
    };
    if (j.promptFeedback?.blockReason) {
      console.warn('[multimodal] blocked:', j.promptFeedback.blockReason);
      return null;
    }
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p?.text || '').join('').trim();

    // Self-log the call for the cost tracker. usageMetadata.promptTokenCount INCLUDES the image/PDF
    // tokens, so this captures the (Pro-priced) multimodal cost that a text-only tracer misses.
    //
    // ONE event, two readers — and this stays exactly ONE logEvent (callers must never also log
    // this call, or the read would be double-counted):
    //   • payload.usage — UNCHANGED. The $ dashboard (lib/llm-cost.ts) reads it and was already
    //     billing-accurate; touching it would risk breaking a correct surface.
    //   • the ENVELOPE columns — NEW. Previously this call passed no envelope, so call_model /
    //     tokens_in / tokens_out were NULL on every PDF read and any column-based reader priced
    //     the entire multimodal read at ₹0 (measured: ₹10.54 vs the dashboard's ₹31.97 on the
    //     same doc — the gap that made S6 report ₹11.30/doc). tokens_out is reasoning-inclusive.
    // No promptRef is passed: this transport is generic (doc-audit, ccb-brief), so the caller owns
    // the prompt fingerprint — the fingerprint columns stay null here and only the call facts land.
    if (opts.traceId) {
      const u = j.usageMetadata ?? {};
      const usage = {
        prompt_tokens: u.promptTokenCount ?? 0,
        completion_tokens: u.candidatesTokenCount ?? 0,
        total_tokens: u.totalTokenCount ?? 0,
      };
      await logEvent(opts.traceId, 'llm_response', opts.label || 'multimodal_read', {
        model, provider: 'vertex-multimodal', multimodal: true, char_count: text.length,
        usage,
        // additive sibling of `usage` (never inside it — the dashboard's reader stays untouched)
        thoughts_tokens: u.thoughtsTokenCount ?? null,
      }, Date.now() - t0,
        buildEnvelope(undefined, {
          model, provider: 'vertex-multimodal',
          tokensIn: usage.prompt_tokens, tokensOut: billableOutputTokens(usage),
        })).catch(() => {});
    }
    return text || null;
  } catch (e) {
    // Includes the AbortError on timeout — a hung read is now a failed read, exactly as on the
    // OpenRouter transport above. Still returns null: the caller's "null means unreadable"
    // contract is unchanged, and this unit does not touch it.
    const payload = providerErrorPayload({
      provider: 'gemini', label: opts.label || 'multimodal_read', feature: null, fellBackTo: 'none',
      intendedModel: model, fallbackModel: null,
      region: vertexRegion(), saIdentity: vertexSaEmail(),
      error: e, inFlightAtError: providerCallsInFlight(),
    });
    console.error('[provider-fallback] vertex document read threw → unreadable:', JSON.stringify(payload));
    if (opts.traceId) await logEvent(opts.traceId, 'provider_error', opts.label || 'multimodal_read', payload, Date.now() - t0).catch(() => {});
    return null;
  } finally {
    clearTimeout(timer);
  }
}
