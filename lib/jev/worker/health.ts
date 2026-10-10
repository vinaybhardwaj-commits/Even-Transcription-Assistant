/**
 * lib/jev/worker/health.ts — one read of the worker's state, per use (PRD §9.4, §11). The MCP tools scribe_jev_health and
 * scribe_usage include:"jev", and the Bench /admin/jev page all read THIS, so the three cannot disagree. Ids, flag states (booleans), closed
 * error classes and numbers only: never text, never an env value.
 */
import { sql } from "@/lib/db";
import { dailyCapUsd, dailySoftUsd, liveFlagOn, REAL_USES, useFlagOn, workerEnabled, textLaneOn, USE_SENDS_TEXT, type RealUse } from "./flags";
import { getBreaker, isDue, type BreakerRow } from "./breaker";

const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const safeFlag = (f: () => boolean): boolean | "invalid" => { try { return f(); } catch { return "invalid"; } };


export type UseHealth = {
  use: RealUse;
  flags: { worker: boolean | "invalid"; use: boolean | "invalid"; text_lane: boolean | "invalid" | null; live: boolean | "invalid" };
  sets: Array<{ id: string; version: string; status: string; sha8: string }>;
  breaker: { state: string; reason_class: string | null; consecutive_failures: number; opened_at: string | null; probe_due: boolean };
  today: { calls: number; tokens_in: number; usd: number; errors: number; p50_ms: number | null; p95_ms: number | null; mock_calls: number };
  mock_share: number;
  last_error_class: string | null;
  queue: { queued: number; running: number };
  last_success_at: string | null;
  band_mix: Record<string, number>;
  error_classes_24h: Record<string, number>;
  drift_alerts: string[];
};
export type JevHealth = { ist_date: string; budget: { spent_usd: number; cap_usd: number; soft_usd: number; left_usd: number }; sweeper_last_job_at: string | null; uses: UseHealth[] };

export async function jevHealth(): Promise<JevHealth> {
  const [spentRows, sets, calls, lastErr, queue, lastOk, bands, classes, drift, sweeper] = await Promise.all([
    sql`SELECT coalesce(sum(cost_usd), 0) AS usd FROM jev_call WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`,
    sql`SELECT use, id, version, status, left(content_sha256, 8) AS sha8 FROM jev_question_set WHERE use <> 'legacy' AND status <> 'retired' ORDER BY use, created_at DESC`,
    sql`SELECT use, count(*)::int AS calls, coalesce(sum(input_tokens), 0)::bigint AS tokens_in, coalesce(sum(cost_usd), 0) AS usd,
               count(*) FILTER (WHERE error_class IS NOT NULL)::int AS errors, count(*) FILTER (WHERE mock)::int AS mock_calls,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
          FROM jev_call WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') GROUP BY use`,
    sql`SELECT DISTINCT ON (use) use, error_class FROM jev_call WHERE error_class IS NOT NULL ORDER BY use, created_at DESC`,
    sql`SELECT args->>'use' AS use, count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'running')::int AS running
          FROM scribe_job WHERE kind = 'jev_ask' AND status IN ('queued', 'running') GROUP BY 1`,
    sql`SELECT use, max(created_at) AS at FROM jev_call WHERE error_class IS NULL GROUP BY use`,
    sql`SELECT s.use, d.band, count(*)::int AS c FROM jev_decision d JOIN jev_question_set s ON s.content_sha256 = d.question_set_sha256
         WHERE d.order_variant = 'derived' AND d.mock = false AND d.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') AND d.band IS NOT NULL GROUP BY 1, 2`,
    sql`SELECT use, error_class, count(*)::int AS c FROM jev_call WHERE error_class IS NOT NULL AND created_at >= now() - interval '24 hours' GROUP BY 1, 2`,
    sql`SELECT DISTINCT ON (use) use, alerts FROM jev_drift_report WHERE cardinality(alerts) > 0 ORDER BY use, ist_date DESC, created_at DESC`,
    sql`SELECT max(created_at) AS at FROM scribe_job WHERE kind = 'jev_ask' AND actor LIKE 'cron:jev_sweep%'`,
  ]) as unknown as Array<Array<Record<string, unknown>>>;

  const spent = n(spentRows[0]?.usd);
  const cap = dailyCapUsd();
  const uses: UseHealth[] = [];
  for (const use of REAL_USES) {
    const br: BreakerRow = await getBreaker(use);
    const c = calls.find((x) => x.use === use);
    const total = n(c?.calls);
    const bandMix: Record<string, number> = {};
    for (const b of bands) if (b.use === use) bandMix[String(b.band)] = n(b.c);
    const cls: Record<string, number> = {};
    for (const x of classes) if (x.use === use) cls[String(x.error_class)] = n(x.c);
    const q = queue.find((x) => x.use === use);
    uses.push({
      use,
      flags: { worker: safeFlag(workerEnabled), use: safeFlag(() => useFlagOn(use)), text_lane: USE_SENDS_TEXT[use] ? safeFlag(textLaneOn) : null, live: safeFlag(() => liveFlagOn(use)) },
      sets: sets.filter((s) => s.use === use).map((s) => ({ id: String(s.id), version: String(s.version), status: String(s.status), sha8: String(s.sha8) })),
      breaker: { state: br.state, reason_class: br.reason_class, consecutive_failures: br.consecutive_failures, opened_at: br.opened_at, probe_due: isDue(br, new Date()) },
      today: { calls: total, tokens_in: n(c?.tokens_in), usd: n(c?.usd), errors: n(c?.errors), p50_ms: c?.p50 == null ? null : Math.round(n(c.p50)), p95_ms: c?.p95 == null ? null : Math.round(n(c.p95)), mock_calls: n(c?.mock_calls) },
      mock_share: total > 0 ? Math.round((n(c?.mock_calls) / total) * 1e4) / 1e4 : 0,
      last_error_class: (lastErr.find((x) => x.use === use)?.error_class as string | undefined) ?? null,
      queue: { queued: n(q?.queued), running: n(q?.running) },
      last_success_at: lastOk.find((x) => x.use === use)?.at ? new Date(lastOk.find((x) => x.use === use)!.at as string).toISOString() : null,
      band_mix: bandMix,
      error_classes_24h: cls,
      drift_alerts: ((drift.find((x) => x.use === use)?.alerts as string[] | undefined) ?? []),
    });
  }
  return {
    ist_date: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
    budget: { spent_usd: spent, cap_usd: cap, soft_usd: dailySoftUsd(), left_usd: Math.max(0, Math.round((cap - spent) * 1e8) / 1e8) },
    sweeper_last_job_at: sweeper[0]?.at ? new Date(sweeper[0].at as string).toISOString() : null,
    uses,
  };
}
