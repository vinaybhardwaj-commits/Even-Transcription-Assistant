/**
 * tests/unit/route-metrics-truth.test.ts — "never heard" is not "heard nothing".
 *
 * The router reports three outcomes (no_engine / engine_no_text / engine_text). The app used to
 * store only the engine-output spans, so a window nobody transcribed and a window transcribed to
 * silence both arrived as an empty transcript with `span_count: 0`, and every reader that wanted
 * to know which had to guess from emptiness. Measured on the live corpus before this change: 112
 * route runs, 0 carrying any outcome key, and 20 of them with both zero spans and zero characters
 * — the exact rows the guess was wrong about.
 */
import { describe, it, expect } from "vitest";
import {
  buildRouteMetrics,
  buildRouteOutcome,
  readEngineOutcome,
  ROUTE_OUTCOME_KEY,
  ROUTE_STATUS_SKIPPED,
  type RouteOutcomeRecord,
} from "@/lib/stt/route-run";

const recordOf = (m: Record<string, unknown>) => m[ROUTE_OUTCOME_KEY] as RouteOutcomeRecord;

/** One engine span, the shape `language_timeline` carries. */
const SPAN = { start_s: 1, end_s: 4.5, lang: "en", engine: "whisper", chars: 42 };

describe("the three outcomes reach metrics_json", () => {
  it("NO_ENGINE: nothing ran, and the row says so rather than looking empty", () => {
    const m = buildRouteMetrics([], {}, {
      status: ROUTE_STATUS_SKIPPED,
      outcome: "no_engine",
      segmentation: { method: "silero-vad-no-speech", n_engine_segments: 0 },
    });
    expect(recordOf(m)).toEqual({
      outcome: "no_engine",
      status: "silent_skipped",
      n_engine_segments: 0,
      engines_skipped: true,
    });
    // and the timeline it sits beside is untouched
    expect((m.language_timeline as { span_count: number }).span_count).toBe(0);
  });

  it("ENGINE_NO_TEXT: an engine ran and heard nothing — NOT skipped, though the output is empty", () => {
    const m = buildRouteMetrics([], {}, {
      status: "ok",
      outcome: "engine_no_text",
      segmentation: { method: "silero-vad", n_engine_segments: 12 },
    });
    expect(recordOf(m).engines_skipped).toBe(false);
    expect(recordOf(m).n_engine_segments).toBe(12);
    // This is the pair the old corpus could not separate: identical emptiness, opposite meaning.
    const skipped = buildRouteMetrics([], {}, { status: ROUTE_STATUS_SKIPPED, outcome: "no_engine" });
    expect((m.language_timeline as { chars: number }).chars)
      .toBe((skipped.language_timeline as { chars: number }).chars);
    expect(recordOf(m).engines_skipped).not.toBe(recordOf(skipped).engines_skipped);
  });

  it("ENGINE_TEXT: an engine ran and produced words", () => {
    const m = buildRouteMetrics([SPAN], {}, {
      status: "ok",
      outcome: "engine_text",
      segmentation: { n_engine_segments: 3 },
    });
    expect(recordOf(m).engines_skipped).toBe(false);
    expect(recordOf(m).outcome).toBe("engine_text");
    expect((m.language_timeline as { chars: number }).chars).toBe(42);
  });
});

describe("engines_skipped is what the router SAID, never what the output looked like", () => {
  it("is true on either signal the router gives", () => {
    expect(recordOf(buildRouteMetrics([], {}, { status: ROUTE_STATUS_SKIPPED })).engines_skipped).toBe(true);
    expect(recordOf(buildRouteMetrics([], {}, { outcome: "no_engine" })).engines_skipped).toBe(true);
  });

  it("is NOT inferred from empty output, zero spans or zero spoken seconds", () => {
    const m = buildRouteMetrics([], {}, { status: "ok", outcome: "engine_no_text" });
    expect((m.language_timeline as { span_count: number; spoken_seconds: number; chars: number }))
      .toMatchObject({ span_count: 0, spoken_seconds: 0, chars: 0 });
    expect(recordOf(m).engines_skipped).toBe(false);
  });

  it("emits no key at all when the router said nothing, so nothing can be read as false", () => {
    expect(buildRouteOutcome(undefined)).toEqual({});
    expect(buildRouteOutcome({})).toEqual({});
    expect(buildRouteMetrics([SPAN])[ROUTE_OUTCOME_KEY]).toBeUndefined();
  });
});

describe("a legacy row reads UNKNOWN, and the unknown survives to the caller", () => {
  it("an older metrics_json — timeline only — is unknown, not clean", () => {
    const legacy = buildRouteMetrics([SPAN], { router_sec: 61 });
    const reading = readEngineOutcome(legacy);
    expect(reading.known).toBe(false);
    // There is no `skipped` to misread: the shape itself withholds the answer.
    expect("skipped" in reading).toBe(false);
  });

  it("is unknown for absent, malformed and wrongly-typed records alike", () => {
    expect(readEngineOutcome(null).known).toBe(false);
    expect(readEngineOutcome({}).known).toBe(false);
    expect(readEngineOutcome({ [ROUTE_OUTCOME_KEY]: "no_engine" }).known).toBe(false);
    expect(readEngineOutcome({ [ROUTE_OUTCOME_KEY]: { outcome: "no_engine" } }).known).toBe(false);
  });

  it("a written record reads back exactly, with its outcome and status intact", () => {
    const m = buildRouteMetrics([], {}, {
      status: ROUTE_STATUS_SKIPPED, outcome: "no_engine", segmentation: { n_engine_segments: 0 },
    });
    expect(readEngineOutcome(m)).toEqual({
      known: true, skipped: true, outcome: "no_engine", status: "silent_skipped", n_engine_segments: 0,
    });
  });
});

describe("a regenerated run re-derives the flag", () => {
  it("a stale record passed through `extra` cannot survive into the new row", () => {
    const stale = { [ROUTE_OUTCOME_KEY]: { outcome: "no_engine", status: ROUTE_STATUS_SKIPPED, n_engine_segments: 0, engines_skipped: true } };
    const m = buildRouteMetrics([SPAN], stale, { status: "ok", outcome: "engine_text", segmentation: { n_engine_segments: 3 } });
    expect(recordOf(m).engines_skipped).toBe(false);
    expect(recordOf(m).outcome).toBe("engine_text");
  });

  it("re-running with a changed reply changes the answer, and is otherwise additive", () => {
    const before = buildRouteMetrics([], {}, { status: ROUTE_STATUS_SKIPPED, outcome: "no_engine" });
    const after = buildRouteMetrics([SPAN], {}, { status: "ok", outcome: "engine_text" });
    expect(readEngineOutcome(before)).toMatchObject({ known: true, skipped: true });
    expect(readEngineOutcome(after)).toMatchObject({ known: true, skipped: false });
    // every pre-existing key of the timeline is still present and still named the same
    expect(Object.keys(after.language_timeline as object).sort())
      .toEqual(["chars", "engine_mix", "language_mix", "span_count", "spans", "spoken_seconds"]);
  });
});
