/**
 * lib/guardrails-r3-fixtures.ts — the suite's fixtures, seeds and statistics (PURE).
 *
 * ⚠️ SYNTHETIC AND TEXT-FREE, AND "TEXT-FREE" IS A PROVEN PROPERTY RATHER THAN A HABIT.
 * `lib/__tests__/guardrails-r3-fixtures.test.ts` walks every string that any fixture can produce
 * and requires each to match one of the declared shapes below — an enum member, a UUID, an ISO
 * instant, a hex digest, a bare identifier. Free text cannot match any of them, so a fixture that
 * later grew a `note` or a `snippet` fails the test rather than travelling to a measurement.
 *
 * The reason is PRD §6.4: the manifest carries no field that could hold clinical text, and the
 * assertion "must fail when such a field is added, and must not be able to pass on an empty slice".
 * Both halves are honoured — the walk asserts a non-zero string count before it judges any of them.
 *
 * ⚠️ ZERO OUTBOUND IMPORTS, for the same reason as the core: the telemetry modules these fixtures
 * describe do not exist on this branch, so the fixtures describe the SHAPE without importing the
 * types. At integration the shape is checked against the real types by construction — the payload
 * builder will reject anything it does not recognise.
 */

/** Every enum-ish literal any fixture may emit. The text-free proof matches against this set. */
export const FIXTURE_ENUMS = [
  'primary', 'normative_channel', 'lab_multi_query', 'lvc_recall',
  'script', 'manual', 'preview',
  'started', 'retrieval_complete',
  'success', 'zero_hits', 'retrieval_failure',
  'expanded', 'skipped',
  'vertex', 'openrouter', 'ollama', 'local', 'unattributed', 'not_served',
  'http_429', 'http_other', 'timeout', 'transport_error', 'bad_response',
  'guardrails-r3',
] as const;

/**
 * THE SEEDS. Declared, not generated.
 *
 * ⚠️ A MEASUREMENT THAT CANNOT BE RE-RUN IS AN ANECDOTE. Every runner in this suite derives all of
 * its randomness from one of these through `mulberry32` below, so a qualifying run and a dry run
 * differ only in where they execute. The seeds are approved with the fixtures, as Rep 41 requires,
 * and changing one is a change to the instrument — not a knob.
 */
export const SEEDS = {
  /** Guardrail 1-3: which fixture shape each iteration writes. */
  manifestShape: 0x5eed_0001,
  /** Guardrail 4: the paired retrieval-wall-time runner's query and corpus selection. */
  pairedRetrieval: 0x5eed_0004,
  /** Guardrail 5: the synthetic-audit runner's per-audit outcome plan. */
  syntheticAudit: 0x5eed_0005,
} as const;

/**
 * A seeded PRNG — mulberry32, 32-bit state, no dependency.
 *
 * ⚠️ NOT `Math.random()`, ANYWHERE IN THIS SUITE. A guardrail is a number a later run has to be
 * comparable with. An unseeded source makes every comparison an argument about whether the
 * difference was the change or the draw.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic UUIDv4-shaped id. Seeded, so a re-run produces the same ids. */
export function seededUuid(rnd: () => number): string {
  const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(rnd() * 4)]}${hex(3)}-${hex(12)}`;
}

/** A fixed instant. The suite never reads the wall clock for fixture content — only for latency. */
export const FIXTURE_INSTANT = '2026-09-01T00:00:00.000Z';

export interface FixtureAttempt {
  tier: string; attempt: number; outcome: string; status: number | null;
}
export interface FixtureBatch {
  batch_index: number; candidate_start: number; candidate_end: number;
  intended_provider: string; served_route_class: string;
  attempts: FixtureAttempt[]; outcome: string;
  expected_score_keys: number; finite_score_keys: number;
}
export interface ManifestFixture {
  retrieval_role: string;
  route: string;
  route_class: string;
  invocation_id: string;
  retrieval_run_id: string;
  started_at: string;
  completed_at: string;
  expansion_status: string;
  expansion_route_class: string;
  expansion_attempts: FixtureAttempt[];
  batches: FixtureBatch[];
  fused_candidate_count: number;
  hydrated_candidate_count: number;
  /** A hex digest, never a context. The HMAC of an EMPTY scorer context — see the note below. */
  context_hmac: string | null;
  retrieval_outcome: string;
}

/**
 * The manifest shapes the size guardrail measures.
 *
 * ⚠️ SIZE IS DRIVEN BY BATCH AND ATTEMPT COUNT, WHICH IS THE WHOLE POINT. Guardrail 3 asks how
 * large a manifest gets, and the answer is a function of how many rerank batches a retrieval
 * planned and how many provider attempts each one took. The three shapes below bracket the range
 * seen in the 11 August census: a clean single-batch success, a multi-batch success, and a
 * throttled run whose attempts dominate the row.
 *
 * ⚠️ `context_hmac` IS A DIGEST OF THE EMPTY STRING, NOT OF A DOCUMENT. The real field is keyed
 * with `CDMSS_TELEMETRY_HMAC_KEY` over the assembled scorer context, and that context is clinical
 * text. A fixture must never contain one, so the fixture carries a digest-SHAPED constant. It is
 * the right LENGTH, which is all guardrail 3 needs, and it is not a hash of anything.
 */
export const FIXTURE_HMAC = 'f'.repeat(64);

const attempt = (tier: string, n: number, outcome: string, status: number | null): FixtureAttempt =>
  ({ tier, attempt: n, outcome, status });

function batch(i: number, attempts: FixtureAttempt[], served: string): FixtureBatch {
  return {
    batch_index: i, candidate_start: i * 8, candidate_end: i * 8 + 8,
    intended_provider: 'vertex', served_route_class: served,
    attempts, outcome: 'success', expected_score_keys: 8, finite_score_keys: 8,
  };
}

export type FixtureShape = 'single_batch' | 'multi_batch' | 'throttled';
export const FIXTURE_SHAPES: FixtureShape[] = ['single_batch', 'multi_batch', 'throttled'];

/** Build one manifest fixture of the named shape, with seeded ids. */
export function manifestFixture(shape: FixtureShape, rnd: () => number): ManifestFixture {
  const ok = [attempt('vertex', 1, 'success', 200)];
  const throttled = [
    attempt('vertex', 1, 'http_429', 429),
    attempt('vertex', 2, 'http_429', 429),
    attempt('vertex', 3, 'timeout', null),
    attempt('openrouter', 1, 'success', 200),
  ];
  const batches =
    shape === 'single_batch' ? [batch(0, ok, 'vertex')]
    : shape === 'multi_batch' ? Array.from({ length: 6 }, (_, i) => batch(i, ok, 'vertex'))
    : Array.from({ length: 6 }, (_, i) => batch(i, throttled, 'openrouter'));
  return {
    retrieval_role: 'primary', route: 'script', route_class: 'manual',
    invocation_id: seededUuid(rnd), retrieval_run_id: seededUuid(rnd),
    started_at: FIXTURE_INSTANT, completed_at: FIXTURE_INSTANT,
    expansion_status: 'expanded', expansion_route_class: 'local',
    expansion_attempts: [attempt('ollama', 1, 'success', 200)],
    batches,
    fused_candidate_count: batches.length * 8,
    hydrated_candidate_count: batches.length * 8,
    context_hmac: FIXTURE_HMAC,
    retrieval_outcome: 'success',
  };
}

/**
 * Percentile with an explicit minimum n, and a WITHHELD reason when it is not met.
 *
 * ⚠️ A p95 OVER TWELVE SAMPLES IS THE MAXIMUM WEARING A PERCENTILE'S NAME. The predecessor learned
 * this and the behaviour is kept: below the minimum the field is null and a sibling field says why,
 * so a report cannot quote a number that was never a percentile.
 */
export const P95_MIN_N = 20;
export const P99_MIN_N = 100;

export interface SampleSummary {
  n: number; min: number | null; median: number | null;
  p95: number | null; p95_withheld: string | null;
  p99: number | null; p99_withheld: string | null;
  max: number | null;
}

export function summariseSamples(samples: number[]): SampleSummary {
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const pct = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.ceil((p / 100) * arr.length) - 1)];
  const p95ok = s.length >= P95_MIN_N;
  const p99ok = s.length >= P99_MIN_N;
  return {
    n: s.length,
    min: s[0] ?? null,
    median: s.length ? (s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) : null,
    p95: p95ok ? pct(s, 95) : null,
    p95_withheld: p95ok ? null : `needs n >= ${P95_MIN_N}, have ${s.length} — a p95 here would be the maximum`,
    p99: p99ok ? pct(s, 99) : null,
    p99_withheld: p99ok ? null : `needs n >= ${P99_MIN_N}, have ${s.length} — a p99 here would be the maximum`,
    max: s[s.length - 1] ?? null,
  };
}

/**
 * PAIRED difference statistics — guardrail 4's reporting shape.
 *
 * ⚠️ PAIRED, NOT TWO INDEPENDENT SUMMARIES. Guardrail 4 asks what INSTRUMENTATION COSTS, and the
 * run-to-run variance of a retrieval is far larger than the overhead being looked for. Comparing
 * two medians would mostly report the draw. Each pair runs the identical seeded input through both
 * arms, and the statistic is over the per-pair DIFFERENCES — which is also why the runner alternates
 * arm order between pairs, so a warm-cache drift cannot land entirely on one arm.
 */
export interface PairedSummary extends SampleSummary {
  pairs: number;
  meanDelta: number | null;
  /** Pairs where the instrumented arm was SLOWER. A count, not a rate — n is small by design. */
  instrumentedSlower: number;
}

export function summarisePaired(deltas: number[]): PairedSummary {
  const base = summariseSamples(deltas);
  return {
    ...base,
    pairs: deltas.length,
    meanDelta: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
    instrumentedSlower: deltas.filter((d) => d > 0).length,
  };
}
