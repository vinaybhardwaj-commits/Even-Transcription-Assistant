/**
 * lib/jev/worker/drift.ts — the daily drift report (PRD §6.4, P1.7), one row per (IST day, use, question set, question).
 *
 *   answer distribution vs the reference week (PSI, alert > 0.2 PROVISIONAL); mean confidence; abstain share; act share; order-flip
 *   rate; agreement with gold labels where they exist (7 days); latency p95; cost per subject; error-class mix; and a MODEL-STRING
 *   CHANGE alert when any (non-mock) call returned a model other than the set's pin.
 * Ids and numbers only. `psi` and `driftAlerts` are PURE; the SQL only gathers.
 */
import { sql } from "@/lib/db";
import { JEV_MODEL_PIN } from "./sets";

export const PSI_ALERT = 0.2;
const EPS = 1e-4;

/** Population stability index of two count maps. 0 when either is empty (nothing to compare is not a drift). */
export function psi(ref: Record<string, number>, cur: Record<string, number>): number {
  const rt = Object.values(ref).reduce((a, b) => a + b, 0);
  const ct = Object.values(cur).reduce((a, b) => a + b, 0);
  if (rt === 0 || ct === 0) return 0;
  let s = 0;
  for (const k of new Set([...Object.keys(ref), ...Object.keys(cur)])) {
    const r = Math.max((ref[k] ?? 0) / rt, EPS);
    const c = Math.max((cur[k] ?? 0) / ct, EPS);
    s += (c - r) * Math.log(c / r);
  }
  return Math.round(s * 1e6) / 1e6;
}

export function driftAlerts(m: { psi: number; models_returned: string[]; model_pin: string }): string[] {
  const out: string[] = [];
  if (m.psi > PSI_ALERT) out.push("psi_high");
  for (const model of m.models_returned) if (model !== m.model_pin) out.push(`model_changed:${model}`);
  return out;
}

const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

export type DriftSummary = { use: string; ist_date: string; reports: number; alerts: number };

export async function runDrift(use: string, istDate: string): Promise<DriftSummary> {
  const agg = (await sql`
    SELECT d.question_set_sha256 AS sha, d.question_id, count(*)::int AS n, avg(d.confidence) AS mean_conf,
           count(*) FILTER (WHERE d.band = 'abstain')::int AS abstain, count(*) FILTER (WHERE d.band = 'act')::int AS act,
           count(*) FILTER (WHERE d.evidence->>'order_flip' = 'true')::int AS flips, count(*) FILTER (WHERE d.evidence->>'order_flip' IS NOT NULL)::int AS flip_n,
           s.model_pin AS model_pin
      FROM jev_decision d JOIN jev_question_set s ON s.content_sha256 = d.question_set_sha256
     WHERE s.use = ${use} AND d.order_variant = 'derived' AND d.mock = false AND d.outcome IN ('answered', 'gated_overwritten')
       AND (d.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date
     GROUP BY d.question_set_sha256, d.question_id, s.model_pin`) as Array<Record<string, unknown>>;
  if (agg.length === 0) return { use, ist_date: istDate, reports: 0, alerts: 0 };

  const dist = (await sql`
    SELECT d.question_set_sha256 AS sha, d.question_id, d.answer->>'choice' AS c,
           count(*) FILTER (WHERE (d.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date)::int AS cur,
           count(*) FILTER (WHERE (d.created_at AT TIME ZONE 'Asia/Kolkata')::date < ${istDate}::date)::int AS ref
      FROM jev_decision d JOIN jev_question_set s ON s.content_sha256 = d.question_set_sha256
     WHERE s.use = ${use} AND d.order_variant = 'derived' AND d.mock = false AND d.outcome IN ('answered', 'gated_overwritten') AND d.answer->>'choice' IS NOT NULL
       AND (d.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN (${istDate}::date - 7) AND ${istDate}::date
     GROUP BY 1, 2, 3`) as Array<Record<string, unknown>>;

  const calls = (await sql`
    SELECT question_set_sha256 AS sha, count(*)::int AS calls, coalesce(sum(cost_usd), 0) AS usd, coalesce(sum(subject_count), 0)::int AS subjects,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95, array_remove(array_agg(DISTINCT model_returned) FILTER (WHERE mock = false), NULL) AS models,
           jsonb_object_agg(coalesce(error_class, 'ok'), c) AS classes
      FROM (SELECT question_set_sha256, cost_usd, subject_count, latency_ms, model_returned, mock, error_class, count(*) OVER (PARTITION BY question_set_sha256, coalesce(error_class, 'ok')) AS c
              FROM jev_call WHERE use = ${use} AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date) t
     GROUP BY question_set_sha256`) as Array<Record<string, unknown>>;

  const gold = (await sql`
    SELECT d.question_set_sha256 AS sha, d.question_id, count(*)::int AS labelled, count(*) FILTER (WHERE (l.label #>> '{}') = d.answer->>'choice')::int AS agree
      FROM jev_decision d JOIN jev_gold_label l ON l.subject_type = d.subject_type AND l.subject_id = d.subject_id AND l.question_id = d.question_id
      JOIN jev_question_set s ON s.content_sha256 = d.question_set_sha256
     WHERE s.use = ${use} AND d.order_variant = 'derived' AND d.mock = false AND d.created_at >= (${istDate}::date - 7)
     GROUP BY 1, 2`) as Array<Record<string, unknown>>;

  let alertCount = 0;
  for (const a of agg) {
    const sha = String(a.sha); const qid = String(a.question_id); const total = n(a.n);
    const refMap: Record<string, number> = {}; const curMap: Record<string, number> = {};
    for (const d of dist) if (d.sha === sha && d.question_id === qid) { refMap[String(d.c)] = n(d.ref); curMap[String(d.c)] = n(d.cur); }
    const c = calls.find((x) => x.sha === sha);
    const g = gold.find((x) => x.sha === sha && x.question_id === qid);
    const models = ((c?.models as string[] | undefined) ?? []).filter(Boolean);
    const p = psi(refMap, curMap);
    const metrics = {
      n: total, psi: p, mean_confidence: r4(n(a.mean_conf)), abstain_share: r4(n(a.abstain) / total), act_share: r4(n(a.act) / total),
      order_flip_rate: n(a.flip_n) > 0 ? r4(n(a.flips) / n(a.flip_n)) : null,
      agreement: g && n(g.labelled) > 0 ? r4(n(g.agree) / n(g.labelled)) : null, labelled: g ? n(g.labelled) : 0,
      latency_p95_ms: c ? Math.round(n(c.p95)) : null, cost_per_subject_usd: c && n(c.subjects) > 0 ? Math.round((n(c.usd) / n(c.subjects)) * 1e8) / 1e8 : null,
      error_classes: (c?.classes as Record<string, number> | undefined) ?? {}, models_returned: models,
    };
    const alerts = driftAlerts({ psi: p, models_returned: models, model_pin: String(a.model_pin ?? JEV_MODEL_PIN) });
    alertCount += alerts.length;
    await sql`
      INSERT INTO jev_drift_report (ist_date, use, question_set_sha256, question_id, metrics, alerts)
      VALUES (${istDate}::date, ${use}, ${sha}, ${qid}, ${JSON.stringify(metrics)}::jsonb, ${alerts}::text[])
      ON CONFLICT (ist_date, use, question_set_sha256, question_id) DO UPDATE SET metrics = EXCLUDED.metrics, alerts = EXCLUDED.alerts, created_at = now()`;
  }
  return { use, ist_date: istDate, reports: agg.length, alerts: alertCount };
}
