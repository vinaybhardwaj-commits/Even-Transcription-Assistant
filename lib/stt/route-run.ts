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
export function buildRouteMetrics(timeline: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
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
