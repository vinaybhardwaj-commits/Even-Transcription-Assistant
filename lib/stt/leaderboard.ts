/**
 * STT Engine Lab — composite leaderboard (L4).
 * Aggregates per-engine batch ASR runs (accuracy on gold + judge + agreement +
 * speed + reliability + cost) and blends them into a 0-100 composite using
 * configurable weights (stt_lab_config.weights_json, defaults below).
 */
import { sql } from "@/lib/db";

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
  runs: number; ok: number; success_rate: number;
  avg_latency_ms: number | null; p95_latency_ms: number | null;
  avg_judge: number | null; avg_agreement: number | null;
  gold_n: number; avg_wer: number | null; avg_cer: number | null; avg_term_recall: number | null;
  wins: number; cost_per_min: number | null;
  composite: number | null;
  components: Record<string, number | null>;
};

export type LeaderFilters = { languageBucket?: "all" | "english" | "indic"; sinceDays?: number | null; tier?: "asr" | "scribe" };

export async function computeLeaderboard(filters: LeaderFilters = {}): Promise<{ engines: LeaderRow[]; weights: typeof DEFAULT_WEIGHTS; total_runs: number }> {
  const bucket = filters.languageBucket ?? "all";
  const since = filters.sinceDays && filters.sinceDays > 0 ? filters.sinceDays : null;
  const tier = filters.tier === "scribe" ? "scribe" : "asr";

  const sinceVal = since ?? null;

  const rows = (await sql`
    SELECT tr.engine,
           MAX(eng.display_name) AS display_name,
           COUNT(*)::int AS runs,
           COUNT(*) FILTER (WHERE tr.error IS NULL)::int AS ok,
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
      JOIN encounter e ON e.id = tr.encounter_id
      LEFT JOIN stt_engine eng ON eng.id = tr.engine
     WHERE tr.mode = 'batch' AND tr.tier = ${tier}
       AND ( ${bucket} = 'all'
             OR (${bucket} = 'english' AND e.detected_language ILIKE 'en%')
             OR (${bucket} = 'indic' AND e.detected_language IS NOT NULL AND e.detected_language NOT ILIKE 'en%') )
       AND ( ${sinceVal}::int IS NULL OR tr.created_at >= NOW() - ((${sinceVal})::int || ' days')::interval )
     GROUP BY tr.engine
     ORDER BY tr.engine
  `) as Array<Omit<LeaderRow, "success_rate" | "composite" | "components" | "p95_latency_ms"> & { p95_latency_ms: number | null }>;

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
    const success = r.runs > 0 ? r.ok / r.runs : 0;
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
    return { ...r, success_rate: Math.round(success * 1000) / 1000, composite, components: comp };
  });

  engines.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));
  const total_runs = rows.reduce((s, r) => s + r.runs, 0);
  return { engines, weights, total_runs };
}
