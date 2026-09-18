/**
 * STT Engine Lab — composite leaderboard (L4).
 * Aggregates per-engine batch ASR runs (accuracy on gold + judge + agreement +
 * speed + reliability + cost) and blends them into a 0-100 composite using
 * configurable weights (stt_lab_config.weights_json, defaults below).
 */
import { sql } from "@/lib/db";
import { reliabilityBasisFor, type ReliabilityBasis } from "./reliability-label";

/**
 * E31 C6/C7 — THE DATE FROM WHICH EVERY ATTEMPT IS KEPT. Before it, each retry deleted the failed attempt before it
 * (lib/stt/fanout.ts), so a per-attempt figure over earlier runs would be computed over a history missing its
 * failures — more flattering than the old figure, and silently so. It is the production deploy of that change, which
 * cannot be known when the code is written, so it is configuration: STT_PER_ATTEMPT_SINCE, an ISO timestamp. Unset or
 * unparseable, the per-attempt figure is WITHHELD (null) and the page says why; it is never guessed.
 */
export function perAttemptSince(): string | null {
  const raw = process.env.STT_PER_ATTEMPT_SINCE?.trim();
  if (!raw) return null;
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export const DEFAULT_WEIGHTS = {
  accuracy: 0.30,   // 1 - WER (gold)
  term: 0.20,       // medical-term recall (gold)
  judge: 0.20,      // LLM judge / 10
  agreement: 0.10,  // inter-engine agreement
  speed: 0.10,      // normalized latency (lower better)
  reliability: 0.05,// success rate
  cost: 0.05,       // normalized cost/min (lower better)
} as const;

export type LeaderRow = {
  engine: string;
  display_name: string | null;
  runs: number; ok: number;
  /** The HEADLINE reliability, on reliability_basis: per attempt for encounters, final outcome for room windows,
   *  null for a mixed board or while the per-attempt start date is unset. It is what the composite uses. */
  success_rate: number | null;
  /** Per attempt: runs from per_attempt_since only. Null when that date is unset or there are no such runs. */
  attempts: number; attempts_ok: number; attempt_rate: number | null;
  /** Final outcome: subjects in the selected period with at least one successful run, over subjects attempted. */
  subjects: number; subjects_ok: number; outcome_rate: number | null;
  avg_latency_ms: number | null; p95_latency_ms: number | null;
  avg_judge: number | null; avg_agreement: number | null;
  gold_n: number; avg_wer: number | null; avg_cer: number | null; avg_term_recall: number | null;
  wins: number; cost_per_min: number | null;
  composite: number | null;
  components: Record<string, number | null>;
};

/**
 * K4b — SUBJECT KIND IS A FILTER, NOT A BLEND.
 *
 * A transcription_run can now be a run over an ENCOUNTER (one consultation, a patient, a gold
 * reference) or over a BENCH_WINDOW (fifteen minutes of a room, no patient, no gold). Averaging
 * their latency, judge score and win rate into one composite produces a number that looks like a
 * comparison and is not one — lib/stt/subject.ts says exactly this, and the first drained day
 * proved it: sarvam's row read `runs=55`, being 46 consultations and 9 windows of a podcast.
 *
 * The default is 'encounter', which is what every row in this table meant before bench windows
 * existed, so the leaderboard keeps the meaning it has always had. 'bench_window' is selectable.
 * 'all' exists but is a deliberate opt-in to a mixed population, not a default anyone lands on.
 */
export type SubjectKindFilter = "encounter" | "bench_window" | "all";

export type LeaderFilters = { languageBucket?: "all" | "english" | "indic"; sinceDays?: number | null; tier?: "asr" | "scribe"; subjectKind?: SubjectKindFilter };

export async function computeLeaderboard(filters: LeaderFilters = {}): Promise<{ engines: LeaderRow[]; weights: typeof DEFAULT_WEIGHTS; total_runs: number; subject_kind: SubjectKindFilter; reliability_basis: ReliabilityBasis; per_attempt_since: string | null }> {
  const bucket = filters.languageBucket ?? "all";
  // Default ENCOUNTER, never "all": a caller that says nothing gets the population this
  // leaderboard has always described, not a silently widened one.
  const subjectKind: SubjectKindFilter = filters.subjectKind === "bench_window" || filters.subjectKind === "all" ? filters.subjectKind : "encounter";
  const since = filters.sinceDays && filters.sinceDays > 0 ? filters.sinceDays : null;
  const tier = filters.tier === "scribe" ? "scribe" : "asr";

  const sinceVal = since ?? null;
  const attemptsFrom = perAttemptSince();
  const basis = reliabilityBasisFor(subjectKind);

  const rows = (await sql`
    SELECT tr.engine,
           MAX(eng.display_name) AS display_name,
           COUNT(*)::int AS runs,
           COUNT(*) FILTER (WHERE tr.error IS NULL)::int AS ok,
           -- E31 C6/C7: per attempt, clamped to the date every attempt started being kept (null → none counted).
           COUNT(*) FILTER (WHERE ${attemptsFrom}::timestamptz IS NOT NULL AND tr.created_at >= ${attemptsFrom}::timestamptz)::int AS attempts,
           COUNT(*) FILTER (WHERE ${attemptsFrom}::timestamptz IS NOT NULL AND tr.created_at >= ${attemptsFrom}::timestamptz AND tr.error IS NULL)::int AS attempts_ok,
           -- Final outcome: honest over the whole period, because a subject's last row always survived the old delete.
           COUNT(DISTINCT tr.subject_id)::int AS subjects,
           COUNT(DISTINCT tr.subject_id) FILTER (WHERE tr.error IS NULL)::int AS subjects_ok,
           ROUND(AVG(tr.latency_ms) FILTER (WHERE tr.error IS NULL))::int AS avg_latency_ms,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY tr.latency_ms) FILTER (WHERE tr.error IS NULL) AS p95_latency_ms,
           ROUND(AVG(tr.judge_score)::numeric, 2)::float8 AS avg_judge,
           ROUND(AVG(tr.agreement_score)::numeric, 3)::float8 AS avg_agreement,
           COUNT(*) FILTER (WHERE tr.wer IS NOT NULL)::int AS gold_n,
           ROUND(AVG(tr.wer)::numeric, 3)::float8 AS avg_wer,
           ROUND(AVG(tr.cer)::numeric, 3)::float8 AS avg_cer,
           ROUND(AVG(tr.med_term_recall)::numeric, 3)::float8 AS avg_term_recall,
           COUNT(*) FILTER (WHERE tr.is_winner)::int AS wins,
           MAX(eng.cost_per_min_usd)::float8 AS cost_per_min
      FROM transcription_run tr
      -- K4a C1 — LEFT, not INNER. An inner join here would silently DROP every run whose
      -- subject is not an encounter: not wrong numbers, ABSENT ones, which is the failure
      -- nobody notices. With no bench_window runs in existence the totals are identical to
      -- before, and R2 checks exactly that.
      LEFT JOIN encounter e ON e.id = tr.encounter_id
      LEFT JOIN stt_engine eng ON eng.id = tr.engine
     WHERE tr.mode = 'batch' AND tr.tier = ${tier}
       -- One population per leaderboard. See SubjectKindFilter above.
       AND ( ${subjectKind} = 'all' OR tr.subject_type = ${subjectKind} )
       -- The language buckets are an ENCOUNTER property. A room window has no detected
       -- language, so it belongs to 'all' and to neither of the two language buckets — it is
       -- excluded from them explicitly rather than by a NULL comparison quietly being false.
       AND ( ${bucket} = 'all'
             OR (${bucket} = 'english' AND e.detected_language ILIKE 'en%')
             OR (${bucket} = 'indic' AND e.detected_language IS NOT NULL AND e.detected_language NOT ILIKE 'en%') )
       AND ( ${sinceVal}::int IS NULL OR tr.created_at >= NOW() - ((${sinceVal})::int || ' days')::interval )
     GROUP BY tr.engine
     ORDER BY tr.engine
  `) as Array<Omit<LeaderRow, "success_rate" | "attempt_rate" | "outcome_rate" | "composite" | "components" | "p95_latency_ms"> & { p95_latency_ms: number | null }>;

  // config weights
  const cfg = (await sql`SELECT weights_json FROM stt_lab_config WHERE id = 1`) as Array<{ weights_json: Record<string, number> }>;
  const cfgW = cfg[0]?.weights_json && Object.keys(cfg[0].weights_json).length > 0 ? cfg[0].weights_json : null;
  const weights = { ...DEFAULT_WEIGHTS, ...(cfgW ?? {}) } as typeof DEFAULT_WEIGHTS;

  // normalization bounds for speed + cost across engines
  const lats = rows.map((r) => r.avg_latency_ms).filter((v): v is number => v !== null);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const costs = rows.map((r) => r.cost_per_min).filter((v): v is number => v !== null);
  const minCost = costs.length ? Math.min(...costs) : 0, maxCost = costs.length ? Math.max(...costs) : 0;

  const engines: LeaderRow[] = rows.map((r) => {
    const round3 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
    const attemptRate = attemptsFrom && r.attempts > 0 ? r.attempts_ok / r.attempts : null;
    const outcomeRate = r.subjects > 0 ? r.subjects_ok / r.subjects : null;
    // The headline is one figure on one stated basis — never per-outcome passed off as per-attempt.
    const success = basis === "per_attempt" ? attemptRate : basis === "final_outcome" ? outcomeRate : null;
    const comp: Record<string, number | null> = {
      accuracy: r.avg_wer === null ? null : Math.max(0, 1 - Math.min(r.avg_wer, 1)),
      term: r.avg_term_recall === null ? null : r.avg_term_recall,
      judge: r.avg_judge === null ? null : r.avg_judge / 10,
      agreement: r.avg_agreement === null ? null : r.avg_agreement,
      speed: r.avg_latency_ms === null || maxLat === minLat ? (r.avg_latency_ms === null ? null : 1) : 1 - (r.avg_latency_ms - minLat) / (maxLat - minLat),
      reliability: success,
      cost: r.cost_per_min === null || maxCost === minCost ? (r.cost_per_min === null ? null : 1) : 1 - (r.cost_per_min - minCost) / (maxCost - minCost),
    };
    let wsum = 0, vsum = 0;
    for (const k of Object.keys(weights) as (keyof typeof weights)[]) {
      const v = comp[k];
      if (v === null || v === undefined) continue;
      wsum += weights[k]; vsum += weights[k] * v;
    }
    const composite = wsum > 0 ? Math.round((vsum / wsum) * 1000) / 10 : null; // 0-100, 1dp
    return { ...r, success_rate: round3(success), attempt_rate: round3(attemptRate), outcome_rate: round3(outcomeRate), composite, components: comp };
  });

  engines.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));
  const total_runs = rows.reduce((s, r) => s + r.runs, 0);
  // Echoed so a reader of the JSON can never mistake WHICH population these numbers describe.
  return { engines, weights, total_runs, subject_kind: subjectKind, reliability_basis: basis, per_attempt_since: attemptsFrom };
}
