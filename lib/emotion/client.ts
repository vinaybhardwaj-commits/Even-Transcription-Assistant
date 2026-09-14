/**
 * lib/emotion/client.ts — the Mini's emotion service, as the room pipeline uses it.
 *
 * Two calls only: GET /health (the cap and whether the model is loaded) and
 * POST /inference/wavlm/segments (one presigned audio URL, up to SEGMENTS_PER_CALL segments, one
 * result per segment in request order). The single-clip endpoints are not used from here, and
 * emotion2vec is never selected — the Mini has RAM for one model.
 *
 * WHAT THE MODEL OUTPUTS, AND NOTHING MORE. Seven general-affect labels from a model trained
 * elsewhere and not validated on this audio: anger, disgust, enthusiasm, fear, happiness, neutral,
 * sadness. The parse checks they are all present and are probabilities. What they might indicate is
 * for queries built on top, not for this file.
 *
 * BRANCH ON `ok`. The service answers inference errors with HTTP 200 and ok:false.
 */
export const EMOTION_MODEL_ID = "Aniemore/wavlm-emotion-v1-crosslingual";
export const EMOTION_MODEL_KEY = "wavlm";
export const EMOTION_LABELS = ["anger", "disgust", "enthusiasm", "fear", "happiness", "neutral", "sadness"] as const;
export type EmotionLabel = (typeof EMOTION_LABELS)[number];

/** Env first, literal behind it — the idiom every Mini tunnel adapter uses. */
const BASE = () => (process.env.EMOTION_BASE_URL || "https://emotion.llmvinayminihome.uk").replace(/\/+$/, "");

/**
 * THE PLAUSIBLE CAP. The service is configured for 60 s (EMOTION_MAX_DURATION_S in its launchd
 * plist); without that setting its code falls back to 120 s, which scored 61 s and 90 s segments.
 * Below 10 s the chunk target falls under 9 s and a window fragments (a cap of 1.5 s produced 154
 * segments over 11 calls). A cap outside [10, 60] is a misconfigured or misbehaving service, and the
 * window fails by name rather than planning around it.
 */
export const EMOTION_CAP_MIN_S = 10;
export const EMOTION_CAP_MAX_S = 60;

/** The shared secret the Mini's batch endpoint requires. Without it no call is made. */
export const EMOTION_SECRET_ENV = "EMOTION_SEGMENTS_SECRET";
export const emotionSecretConfigured = (env: Record<string, string | undefined> = process.env) => Boolean((env[EMOTION_SECRET_ENV] ?? "").trim());

/** Under the 100 s the tunnel allows a request. */
export const EMOTION_CALL_TIMEOUT_MS = 90_000;
export const EMOTION_HEALTH_TIMEOUT_MS = 10_000;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export type EmotionHealth =
  | { ok: true; cap_s: number; min_speech_s: number; loaded: boolean | "unknown"; model: string | null; subfolder: string | null }
  | { ok: false; error: string };

/** The service's health field for the least speech it will score, spelled as the service spells it. */
export const HEALTH_MIN_SPEECH_KEY = "min_speech_s";

/**
 * The cap AND the service's minimum speech come from here, at run time, every job. There is no
 * constant to fall back to for either: a planner that hard-coded 1.5 s would drift silently the day
 * the service's EMOTION_MIN_SPEECH_S changes (E14 §4.3).
 */
export async function emotionHealth(fetchImpl: Fetcher = fetch): Promise<EmotionHealth> {
  try {
    const res = await fetchImpl(`${BASE()}/health`, { signal: AbortSignal.timeout(EMOTION_HEALTH_TIMEOUT_MS), cache: "no-store" });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // TRUST NOTHING FROM AN UNHEALTHY ANSWER. A 500 with ok:false can still carry a max_duration_s;
    // a cap that arrives alongside a failure is not a cap.
    if (!res.ok) return { ok: false, error: `health_http_${res.status}` };
    if (!body || typeof body !== "object") return { ok: false, error: "health_unparseable" };
    if (body.ok !== true) return { ok: false, error: "health_not_ok" };
    const cap = body.max_duration_s;
    if (typeof cap !== "number" || !Number.isFinite(cap)) return { ok: false, error: "health_cap_unreadable" };
    if (cap < EMOTION_CAP_MIN_S || cap > EMOTION_CAP_MAX_S) return { ok: false, error: `health_cap_out_of_range: ${cap}s not in [${EMOTION_CAP_MIN_S}, ${EMOTION_CAP_MAX_S}]` };
    // A minimum that is missing, non-finite, not positive or not under the cap is not a minimum: every
    // span would be planned, or none could be. Refused by name, like a bad cap.
    const minSpeech = body[HEALTH_MIN_SPEECH_KEY];
    if (typeof minSpeech !== "number" || !Number.isFinite(minSpeech) || minSpeech <= 0 || minSpeech >= cap) {
      return { ok: false, error: "health_min_speech_unreadable" };
    }
    const models = body.models as Record<string, Record<string, unknown>> | undefined;
    const wavlm = models?.wavlm;
    const loadedRaw = wavlm && typeof wavlm.loaded === "boolean" ? wavlm.loaded : typeof body.loaded === "boolean" ? body.loaded : null;
    return {
      ok: true,
      cap_s: cap,
      min_speech_s: minSpeech,
      loaded: loadedRaw === null ? "unknown" : loadedRaw,
      model: typeof body.model === "string" ? body.model : null,
      subfolder: wavlm && typeof wavlm.subfolder === "string" ? wavlm.subfolder : null,
    };
  } catch (e) {
    return { ok: false, error: `health_unreachable: ${String((e as Error)?.name ?? e).slice(0, 40)}` };
  }
}

export type SegmentScore =
  | { index: number; ok: true; labels: Record<EmotionLabel, number>; top_label: EmotionLabel; top_score: number; duration_s: number; inference_s: number }
  /** E16 — the service read the span and would not score it. Not a failure. */
  | { index: number; ok: false; unscorable: true; reason: string; service_speech_s: number | null; duration_s: number | null }
  | { index: number; ok: false; unscorable?: undefined; reason: string };

/** The service's reason when it refuses without naming one. */
export const UNSCORABLE_UNNAMED = "unscorable_unnamed";

const isEmptyObject = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0;
const finiteOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export type SegmentsResponse =
  | { ok: true; model: string; model_key: string; subfolder: string | null; device: string | null; cap_s: number; results: SegmentScore[]; fetch_s: number | null; decode_s: number | null }
  | { ok: false; error: string; retryable: boolean };

const reasonText = (v: unknown) => String(v ?? "unknown").replace(/[^\x20-\x7e]/g, "?").slice(0, 120);

/** PURE. The whole response contract, checked. Anything short of it is a named failure, never a partial read. */
export function parseSegmentsResponse(body: unknown, sent: number): SegmentsResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "emotion_response_not_an_object", retryable: false };
  const b = body as Record<string, unknown>;
  if (b.ok !== true) return { ok: false, error: `emotion_service_refused: ${reasonText(b.error)}`, retryable: false };
  if (b.model !== EMOTION_MODEL_ID || b.model_key !== EMOTION_MODEL_KEY) return { ok: false, error: "emotion_unexpected_model", retryable: false };
  const cap = b.max_duration_s;
  if (typeof cap !== "number" || !Number.isFinite(cap)) return { ok: false, error: "emotion_response_missing_cap", retryable: false };
  if (!Array.isArray(b.results) || b.results.length !== sent) return { ok: false, error: "emotion_result_count_mismatch", retryable: false };
  const results: SegmentScore[] = [];
  for (const [i, raw] of (b.results as unknown[]).entries()) {
    const r = raw as Record<string, unknown>;
    if (!r || r.index !== i) return { ok: false, error: "emotion_result_order_mismatch", retryable: false };
    if (r.ok !== true) { results.push({ index: i, ok: false, reason: reasonText(r.error) }); continue; }
    // E16 — UNSCORABLE, NOT MALFORMED. Since 11:46 on 14 Sep the service answers a span its gate refuses
    // with `ok: true, unscorable: true, labels: {}` (app.py score_segments). Read as "ok:true without seven
    // labels" that became `malformed_scores` — a failure — for every quiet span (E14 cause 1).
    // Exactly two shapes mean unscorable: the explicit flag, or ok:true with an EMPTY labels object.
    // Labels that are present but partial or out of range are still malformed: that is a model fault,
    // and catching it here would hide one.
    if (r.unscorable === true || isEmptyObject(r.labels)) {
      results.push({
        index: i, ok: false, unscorable: true,
        reason: typeof r.skip_reason === "string" && r.skip_reason ? reasonText(r.skip_reason) : UNSCORABLE_UNNAMED,
        service_speech_s: finiteOrNull(r.speech_s_est),
        duration_s: finiteOrNull(r.duration_s),
      });
      continue;
    }
    const labels = r.labels as Record<string, unknown> | undefined;
    const scores = {} as Record<EmotionLabel, number>;
    let bad = !labels || typeof labels !== "object";
    for (const l of EMOTION_LABELS) {
      const v = labels?.[l];
      // Softmax output is a probability; allow float rounding a hair past 1, and clamp only that.
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1 + 1e-6) { bad = true; break; }
      scores[l] = Math.min(1, v);
    }
    if (bad || typeof r.duration_s !== "number" || typeof r.inference_s !== "number") {
      results.push({ index: i, ok: false, reason: "malformed_scores" });
      continue;
    }
    const top = EMOTION_LABELS.reduce((a, l) => (scores[l] > scores[a] ? l : a), EMOTION_LABELS[0]);
    results.push({ index: i, ok: true, labels: scores, top_label: top, top_score: scores[top], duration_s: r.duration_s, inference_s: r.inference_s });
  }
  return {
    ok: true,
    model: b.model as string,
    model_key: b.model_key as string,
    subfolder: typeof b.subfolder === "string" ? b.subfolder : null,
    device: typeof b.device === "string" ? b.device : null,
    cap_s: cap,
    results,
    fetch_s: typeof b.fetch_s === "number" ? b.fetch_s : null,
    decode_s: typeof b.decode_s === "number" ? b.decode_s : null,
  };
}

/** One call. `audioUrl` is a presigned GET — a credential for its lifetime, so it is never logged. */
export async function scoreSegments(
  audioUrl: string,
  segments: Array<{ start_s: number; end_s: number }>,
  fetchImpl: Fetcher = fetch,
): Promise<SegmentsResponse> {
  const secret = (process.env[EMOTION_SECRET_ENV] ?? "").trim();
  if (!secret) return { ok: false, error: "emotion_secret_not_configured", retryable: false };
  let res: Response;
  try {
    res = await fetchImpl(`${BASE()}/inference/wavlm/segments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ audio_url: audioUrl, segments }),
      signal: AbortSignal.timeout(EMOTION_CALL_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, error: `emotion_unreachable: ${String((e as Error)?.name ?? e).slice(0, 40)}`, retryable: true };
  }
  const body = await res.json().catch(() => null);
  if (res.status >= 500) return { ok: false, error: `emotion_http_${res.status}: ${reasonText((body as Record<string, unknown> | null)?.error)}`, retryable: true };
  return parseSegmentsResponse(body, segments.length);
}
