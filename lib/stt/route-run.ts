/**
 * lib/stt/route-run.ts — Slice C1 step 3. Where the router's per-span timeline is persisted.
 *
 * ─── ONE KEY, AND THE TEXT IS NOT IN IT ────────────────────────────────────────────────────────
 * `metrics_json` is jsonb and takes this with no migration. It is also a single blob rewritten by
 * several independent writers with `||` (scoring, translate-bakeoff, fanout), so everything added
 * here lands under ONE top-level key: a wide spread of new keys would make every unrelated merge
 * rewrite more of the document, and a key-per-span would be unbounded.
 *
 * The router's own span shape is `{start_s, end_s, lang, engine, chars}` — note `chars`, a COUNT.
 * The timeline carries no words, which is why it can be stored beside a run an operator may read
 * without identity rules applying. `buildRouteMetrics` enforces that: it copies the five fields it
 * knows and DROPS anything else the router might add later, including a `text` field if one ever
 * appears. A verbatim copy of a shape that may grow is not a safe place to be relaxed.
 *
 * "Verbatim" and "field-filtered" are not in tension here: every span value is copied unchanged and
 * never recomputed. What is dropped is only what the span should not be carrying.
 */

export const ROUTE_TIMELINE_KEY = "language_timeline";

/** The five fields a router span is defined to carry. Anything else is not copied. */
export type RouteSpan = {
  start_s: number;
  end_s: number;
  lang: string | null;
  engine: string | null;
  chars: number;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : null);

/**
 * PURE. One router span, reduced to the five fields and nothing else.
 *
 * Returns null for a span that is not an object or has no usable bounds — a malformed span is
 * dropped rather than stored as a row of nulls that later reads as a real span of unknown language.
 */
export function normaliseSpan(raw: unknown): RouteSpan | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const start_s = num(o.start_s);
  const end_s = num(o.end_s);
  if (start_s === null || end_s === null) return null;
  return { start_s, end_s, lang: str(o.lang), engine: str(o.engine), chars: num(o.chars) ?? 0 };
}

/**
 * PURE. The timeline as it goes into `metrics_json`, plus the counts the tripwires read.
 *
 * The per-span MIXES are precomputed here rather than derived at read time. That is deliberate: the
 * tripwires exist to answer "was the switch inert" across thousands of runs, and a reader that must
 * unnest every timeline to count engines pays for the whole history on every question. The spans
 * stay for the cases where the detail matters.
 */
export function buildRouteMetrics(
  timeline: unknown,
  extra: Record<string, unknown> = {},
  /**
   * The router's own account of WHETHER IT RAN, as opposed to what it heard. Optional so every
   * existing caller compiles and keeps writing exactly the keys it wrote before.
   */
  router?: RouterOutcomeInput,
): Record<string, unknown> {
  const spans = Array.isArray(timeline) ? timeline.map(normaliseSpan).filter((s): s is RouteSpan => s !== null) : [];
  const engineMix: Record<string, number> = {};
  const langMix: Record<string, number> = {};
  let spokenSeconds = 0;
  let chars = 0;
  for (const s of spans) {
    engineMix[s.engine ?? "unknown"] = (engineMix[s.engine ?? "unknown"] ?? 0) + 1;
    langMix[s.lang ?? "unknown"] = (langMix[s.lang ?? "unknown"] ?? 0) + 1;
    if (s.end_s > s.start_s) spokenSeconds += s.end_s - s.start_s;
    chars += s.chars;
  }
  return {
    [ROUTE_TIMELINE_KEY]: {
      spans,
      span_count: spans.length,
      engine_mix: engineMix,
      language_mix: langMix,
      spoken_seconds: Math.round(spokenSeconds * 100) / 100,
      chars,
      ...extra,
    },
    // SPREAD LAST, DELIBERATELY. A regenerated run must re-derive this from the reply in hand; a
    // stale record arriving through `extra` must never survive into the new row (requirement 4).
    ...buildRouteOutcome(router),
  };
}

// ---------------------------------------------------------------------------
// "Never heard" is not "heard nothing"
// ---------------------------------------------------------------------------

/**
 * The key `metrics_json` carries the router's outcome under. A SIBLING of `language_timeline`,
 * never a field inside it: `language_timeline` is read by the tripwires and by scribe_stt_runs, and
 * this change is additive by construction — no existing key is removed, renamed or re-typed.
 */
export const ROUTE_OUTCOME_KEY = "route_outcome";

/** The router's three distinct answers. Anything else it says is carried verbatim and not mapped. */
export type RouteOutcome = "no_engine" | "engine_no_text" | "engine_text";

/** The one status string that means the router declined to call any engine at all. */
export const ROUTE_STATUS_SKIPPED = "silent_skipped";

export type RouterOutcomeInput = {
  /** The router's `status`, verbatim. */
  status?: unknown;
  /** The router's `segmentation` block, verbatim — `n_engine_segments` is read from it. */
  segmentation?: unknown;
  /** The router's `outcome`, verbatim. */
  outcome?: unknown;
};

export type RouteOutcomeRecord = {
  outcome: RouteOutcome | null;
  status: string | null;
  n_engine_segments: number | null;
  /**
   * TRUE only when the router SAYS no engine ran — `status === "silent_skipped"` or
   * `outcome === "no_engine"`. It is NEVER derived from an empty transcript, a zero span count or
   * zero spoken seconds, because those are equally what a room that was genuinely quiet produces,
   * and conflating them is the whole defect this key exists to end.
   */
  engines_skipped: boolean;
};

const isOutcome = (v: unknown): v is RouteOutcome =>
  v === "no_engine" || v === "engine_no_text" || v === "engine_text";

/**
 * PURE. The outcome record, or NOTHING AT ALL when the router said nothing.
 *
 * Emitting no key is what makes an older row readable as "unknown" rather than as a confident
 * `false`. A run by any other engine, and every row written before this change, therefore carries
 * no `route_outcome` and reads as unknown for ever — which is the honest answer about them.
 */
export function buildRouteOutcome(router?: RouterOutcomeInput): Record<string, unknown> {
  if (!router) return {};
  const status = typeof router.status === "string" && router.status.trim() !== "" ? router.status.trim() : null;
  const outcome = isOutcome(router.outcome) ? router.outcome : null;
  const seg = router.segmentation && typeof router.segmentation === "object" && !Array.isArray(router.segmentation)
    ? (router.segmentation as Record<string, unknown>)
    : null;
  const nEngineSegments = num(seg?.n_engine_segments);
  if (status === null && outcome === null && nEngineSegments === null) return {};
  const record: RouteOutcomeRecord = {
    outcome,
    status,
    n_engine_segments: nEngineSegments,
    engines_skipped: status === ROUTE_STATUS_SKIPPED || outcome === "no_engine",
  };
  return { [ROUTE_OUTCOME_KEY]: record };
}

/**
 * What a reader gets back. THE UNKNOWN IS A SHAPE, NOT A FALSE — a caller cannot accidentally treat
 * "we have no idea" as "engines ran", because there is no `skipped` field to read until `known` is
 * true. That is requirement 3, enforced by the type rather than by everyone remembering it.
 */
export type EngineOutcomeReading =
  | { known: true; skipped: boolean; outcome: RouteOutcome | null; status: string | null; n_engine_segments: number | null }
  | { known: false };

/** PURE. Read a stored `metrics_json`. Absent or malformed record => unknown, never a guess. */
export function readEngineOutcome(metrics: unknown): EngineOutcomeReading {
  const m = metrics && typeof metrics === "object" && !Array.isArray(metrics)
    ? (metrics as Record<string, unknown>)
    : null;
  const raw = m?.[ROUTE_OUTCOME_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { known: false };
  const r = raw as Record<string, unknown>;
  if (typeof r.engines_skipped !== "boolean") return { known: false };
  return {
    known: true,
    skipped: r.engines_skipped,
    outcome: isOutcome(r.outcome) ? r.outcome : null,
    status: typeof r.status === "string" ? r.status : null,
    n_engine_segments: num(r.n_engine_segments),
  };
}

/**
 * PURE. Characters per audio-second — tripwire 4.
 *
 * Null, never zero, when there is no audio to divide by: a yield of 0.0 on a window with no
 * duration reads as a catastrophic regression on every dashboard that averages it, and "we do not
 * know" is the honest answer. Zero characters over real audio IS 0 and is reported as such.
 */
export function charsPerAudioSecond(chars: number, audioSeconds: number | null): number | null {
  if (audioSeconds === null || !Number.isFinite(audioSeconds) || audioSeconds <= 0) return null;
  return Math.round((chars / audioSeconds) * 1000) / 1000;
}
