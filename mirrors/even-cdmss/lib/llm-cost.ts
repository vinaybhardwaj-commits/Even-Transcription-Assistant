/**
 * lib/llm-cost.ts — LLM cost tracker data layer (WIRED, Neon).
 *
 * Reads the tokens already logged on every Gemini call (`trace_events.kind='llm_response'`,
 * `payload.usage.{prompt_tokens,completion_tokens}`, `payload.model`), joins to `traces.feature`,
 * and prices them in rupees via lib/llm-cost-core + data/llm-pricing.json. Gemini-only: embeddings
 * run on self-hosted Ollama (₹0 marginal). No new instrumentation — pure read + price. Soft-fails.
 */

import { sql } from './db';
import pricingJson from '@/data/llm-pricing.json';
import { costInr, perCallInr, modelLabel, type Pricing, type ModelPrice } from './llm-cost-core';

const run = sql as unknown as (t: string, p?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

/** Live pricing: file rates, with fx overridable via env for quick FX updates without a code edit. */
export const PRICING: Pricing = {
  fxUsdInr: Number(process.env.LLM_FX_USD_INR) || (pricingJson as { fxUsdInr: number }).fxUsdInr,
  models: (pricingJson as unknown as { models: ModelPrice[] }).models,
  fallback: (pricingJson as unknown as { fallback: Pricing['fallback'] }).fallback,
};

// Every Gemini call logs its token usage: non-streaming as `llm_response`, streaming as
// `llm_stream_usage` (from the final include_usage chunk — see lib/trace.ts wrapStreamUsage).
// Both must be counted or streamed spend (/ask, /ddx, /topics) is invisible.
const LLM_KINDS = `e.kind IN ('llm_response', 'llm_stream_usage')`;
// Priced providers: Vertex Gemini + OpenRouter Qwen (the migrated citation critic) + Bedrock Claude.
// A model that is none of the three is not a paid call we meter (local Ollama). Broadened from
// gemini-only so Qwen spend is visible in the cost tab (provider migration §4).
//
// ⚠️ THE FILTER IS PART OF "ADD A PROVIDER", NOT AN AFTERTHOUGHT (Bedrock S1, 7 Aug 2026). Pricing
// ROWS in data/llm-pricing.json are necessary but NOT sufficient: a model that fails this predicate
// never reaches the pricing code at all, so a fully-priced Bedrock call would have shown ₹0 across
// every panel — spend invisible while the config looked complete. Tracked usage is V's condition on
// this build, so the '%claude%' arm is as load-bearing as the rates themselves.
const PRICED_MODEL = `((e.payload->>'model') ILIKE '%gemini%' OR (e.payload->>'model') ILIKE '%qwen%' OR (e.payload->>'model') ILIKE '%claude%')`;
const FROM_WHERE =
  `FROM trace_events e JOIN traces t ON t.trace_id = e.trace_id
   WHERE ${LLM_KINDS} AND e.app_source = $1 AND ${PRICED_MODEL}`;
const IN_TOK = `coalesce((e.payload->'usage'->>'prompt_tokens')::int, 0)`;
// Output tokens = max(completion, total − prompt). Gemini 2.5 is a THINKING model: on the native
// path `completion_tokens` excludes the (billed) thinking tokens while `total_tokens` includes
// them, so total − prompt recovers visible + thinking output. When total is absent this reduces to
// completion, so it never under- or over-counts vs. the raw completion count.
const OUT_TOK = `greatest(
    coalesce((e.payload->'usage'->>'completion_tokens')::int, 0),
    coalesce((e.payload->'usage'->>'total_tokens')::int, 0) - coalesce((e.payload->'usage'->>'prompt_tokens')::int, 0)
  )`;
// A multimodal (PDF/image OCR) read vs a plain text chat call — the multimodal path logs
// provider 'vertex-multimodal' + multimodal:true. Used to break out and label PDF-OCR spend.
const IS_MM = `((e.payload->>'provider') ILIKE '%multimodal%' OR (e.payload->>'multimodal') = 'true')`;

/** Date (IST) from which multimodal PDF-OCR reads began being metered. Before this, only text calls
 *  were counted, so the daily total steps UP here — newly-visible existing cost, not a usage spike. */
export const MULTIMODAL_METERED_SINCE = '2026-07-01';

async function rowsOf(text: string, params: unknown[] = [APP]): Promise<Record<string, unknown>[]> {
  try { return await run(text, params); } catch { return []; }
}
const n = (v: unknown) => Number(v) || 0;

export type Scale = 'hour' | 'day' | 'week' | 'month';
const SCALES: Record<Scale, { trunc: string; fmt: string; interval: string; label: string }> = {
  hour:  { trunc: `date_trunc('hour', e.ts AT TIME ZONE 'Asia/Kolkata')`, fmt: 'MM-DD HH24:00', interval: '48 hours', label: 'Hourly · last 48h' },
  day:   { trunc: `(e.ts AT TIME ZONE 'Asia/Kolkata')::date`,             fmt: 'YYYY-MM-DD',    interval: '31 days',  label: 'Daily · last 31d' },
  week:  { trunc: `date_trunc('week', e.ts AT TIME ZONE 'Asia/Kolkata')`, fmt: 'YYYY-MM-DD',    interval: '12 weeks', label: 'Weekly · last 12w' },
  month: { trunc: `date_trunc('month', e.ts AT TIME ZONE 'Asia/Kolkata')`,fmt: 'YYYY-MM',       interval: '12 months',label: 'Monthly · last 12m' },
};

export interface CostBucket { bucket: string; totalInr: number; calls: number; byLabel: Record<string, number> }

/** Priced, chronologically-ordered buckets for a time scale (stacked by model label). */
export async function costByBucket(scale: Scale): Promise<{ label: string; buckets: CostBucket[] }> {
  const c = SCALES[scale];
  const rows = await rowsOf(
    `SELECT to_char(${c.trunc}, '${c.fmt}') AS bucket, e.payload->>'model' AS model,
            (${IN_TOK} > 200000) AS hi, sum(${IN_TOK})::bigint AS in_tok, sum(${OUT_TOK})::bigint AS out_tok, count(*)::int AS calls
     ${FROM_WHERE} AND e.ts > now() - interval '${c.interval}'
     GROUP BY 1, 2, 3 ORDER BY 1`,
  );
  const map = new Map<string, CostBucket>();
  for (const r of rows) {
    const bucket = String(r.bucket);
    const inr = costInr(String(r.model), n(r.in_tok), n(r.out_tok), r.hi === true, PRICING);
    const label = modelLabel(String(r.model), PRICING);
    const b = map.get(bucket) ?? { bucket, totalInr: 0, calls: 0, byLabel: {} };
    b.totalInr += inr; b.calls += n(r.calls); b.byLabel[label] = (b.byLabel[label] ?? 0) + inr;
    map.set(bucket, b);
  }
  return { label: c.label, buckets: Array.from(map.values()) };
}

export interface CostKpis { today: number; yesterday: number; last7: number; last30: number; spikePct: number | null; daily: { d: string; inr: number }[] }

/** Headline spend (IST day buckets) + a spike % of today vs the trailing-7-day daily average. */
export async function costKpis(): Promise<CostKpis> {
  const rows = await rowsOf(
    `SELECT to_char((e.ts AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS d, e.payload->>'model' AS model,
            (${IN_TOK} > 200000) AS hi, sum(${IN_TOK})::bigint AS in_tok, sum(${OUT_TOK})::bigint AS out_tok
     ${FROM_WHERE} AND e.ts > now() - interval '30 days' GROUP BY 1, 2, 3 ORDER BY 1`,
  );
  const perDay = new Map<string, number>();
  for (const r of rows) perDay.set(String(r.d), (perDay.get(String(r.d)) ?? 0) + costInr(String(r.model), n(r.in_tok), n(r.out_tok), r.hi === true, PRICING));
  const daily = Array.from(perDay.entries()).map(([d, inr]) => ({ d, inr })).sort((a, b) => a.d.localeCompare(b.d));

  const istToday = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const istYest = new Date(Date.now() + 5.5 * 3600_000 - 86400_000).toISOString().slice(0, 10);
  const today = perDay.get(istToday) ?? 0;
  const yesterday = perDay.get(istYest) ?? 0;
  const cutoff7 = new Date(Date.now() + 5.5 * 3600_000 - 7 * 86400_000).toISOString().slice(0, 10);
  const cutoff30 = new Date(Date.now() + 5.5 * 3600_000 - 30 * 86400_000).toISOString().slice(0, 10);
  const last7 = daily.filter((x) => x.d > cutoff7).reduce((s, x) => s + x.inr, 0);
  const last30 = daily.filter((x) => x.d > cutoff30).reduce((s, x) => s + x.inr, 0);

  // spike: today vs the average of the 7 full prior days (exclude today).
  const prior = daily.filter((x) => x.d < istToday).slice(-7);
  const avg = prior.length ? prior.reduce((s, x) => s + x.inr, 0) / prior.length : 0;
  const spikePct = avg > 0 ? Math.round(((today - avg) / avg) * 100) : null;
  return { today, yesterday, last7, last30, spikePct, daily };
}

export interface CostGroup { key: string; inr: number; calls: number }

/** Spend by feature over the last N days (priced, top-first). */
export async function costByFeature(days = 7): Promise<CostGroup[]> {
  const rows = await rowsOf(
    `SELECT t.feature AS feature, e.payload->>'model' AS model, (${IN_TOK} > 200000) AS hi,
            sum(${IN_TOK})::bigint AS in_tok, sum(${OUT_TOK})::bigint AS out_tok, count(*)::int AS calls
     ${FROM_WHERE} AND e.ts > now() - interval '${Math.max(1, Math.min(90, days))} days'
     GROUP BY 1, 2, 3`,
  );
  const map = new Map<string, CostGroup>();
  for (const r of rows) {
    const key = String(r.feature || '(unknown)');
    const g = map.get(key) ?? { key, inr: 0, calls: 0 };
    g.inr += costInr(String(r.model), n(r.in_tok), n(r.out_tok), r.hi === true, PRICING); g.calls += n(r.calls);
    map.set(key, g);
  }
  return Array.from(map.values()).sort((a, b) => b.inr - a.inr);
}

/** Spend by model over the last N days. */
export async function costByModel(days = 7): Promise<CostGroup[]> {
  const rows = await rowsOf(
    `SELECT e.payload->>'model' AS model, (${IN_TOK} > 200000) AS hi,
            sum(${IN_TOK})::bigint AS in_tok, sum(${OUT_TOK})::bigint AS out_tok, count(*)::int AS calls
     ${FROM_WHERE} AND e.ts > now() - interval '${Math.max(1, Math.min(90, days))} days' GROUP BY 1, 2`,
  );
  const map = new Map<string, CostGroup>();
  for (const r of rows) {
    const key = modelLabel(String(r.model), PRICING);
    const g = map.get(key) ?? { key, inr: 0, calls: 0 };
    g.inr += costInr(String(r.model), n(r.in_tok), n(r.out_tok), r.hi === true, PRICING); g.calls += n(r.calls);
    map.set(key, g);
  }
  return Array.from(map.values()).sort((a, b) => b.inr - a.inr);
}

export interface CostItem { ts: string; feature: string; traceId: string; model: string; inTok: number; outTok: number; inr: number; type: 'text' | 'pdf-ocr' }

/** Spend split by call TYPE (text chat vs PDF-OCR multimodal read) over the last N days. */
export async function costByType(days = 7): Promise<CostGroup[]> {
  const rows = await rowsOf(
    `SELECT ${IS_MM} AS mm, e.payload->>'model' AS model, (${IN_TOK} > 200000) AS hi,
            sum(${IN_TOK})::bigint AS in_tok, sum(${OUT_TOK})::bigint AS out_tok, count(*)::int AS calls
     ${FROM_WHERE} AND e.ts > now() - interval '${Math.max(1, Math.min(90, days))} days' GROUP BY 1, 2, 3`,
  );
  const map = new Map<string, CostGroup>();
  for (const r of rows) {
    const key = r.mm === true ? 'PDF-OCR read (multimodal)' : 'Text';
    const g = map.get(key) ?? { key, inr: 0, calls: 0 };
    g.inr += costInr(String(r.model), n(r.in_tok), n(r.out_tok), r.hi === true, PRICING); g.calls += n(r.calls);
    map.set(key, g);
  }
  return Array.from(map.values()).sort((a, b) => b.inr - a.inr);
}

/** Most-recent priced calls (itemized). */
export async function costItemized(limit = 60): Promise<CostItem[]> {
  const lim = Math.max(1, Math.min(500, limit));
  const rows = await rowsOf(
    `SELECT to_char(e.ts AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS ts, t.feature AS feature, t.trace_id AS trace_id,
            e.payload->>'model' AS model, ${IN_TOK} AS in_tok, ${OUT_TOK} AS out_tok, ${IS_MM} AS mm
     ${FROM_WHERE} ORDER BY e.ts DESC LIMIT ${lim}`,
  );
  return rows.map((r) => ({
    ts: String(r.ts), feature: String(r.feature || ''), traceId: String(r.trace_id || ''),
    model: modelLabel(String(r.model), PRICING), inTok: n(r.in_tok), outTok: n(r.out_tok),
    inr: perCallInr(String(r.model), n(r.in_tok), n(r.out_tok), PRICING),
    type: r.mm === true ? 'pdf-ocr' : 'text',
  }));
}

const isDay = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export interface CostLogQuery { from?: string; to?: string; feature?: string; model?: 'all' | 'pro' | 'flash'; ctype?: 'all' | 'text' | 'pdf-ocr'; page?: number; pageSize?: number }
export interface CostLog {
  items: CostItem[]; total: number; totalInr: number; totalInTok: number; totalOutTok: number;
  page: number; pages: number; pageSize: number;
}

/** Distinct features that have Gemini calls — for the audit browser's filter dropdown. */
export async function costLogFeatures(): Promise<string[]> {
  const rows = await rowsOf(`SELECT DISTINCT t.feature AS feature ${FROM_WHERE} ORDER BY 1`);
  return rows.map((r) => String(r.feature || '')).filter(Boolean);
}

/** Paginated, date/feature/model-filtered view of EVERY Gemini call (not just the latest N).
 *  Reads trace_events (which retains all calls from day one); priced per call. */
export async function costLog(q: CostLogQuery): Promise<CostLog> {
  const pageSize = Math.max(10, Math.min(200, q.pageSize ?? 100));
  const page = Math.max(0, q.page ?? 0);
  const where = [LLM_KINDS, `e.app_source = $1`, PRICED_MODEL];
  const params: unknown[] = [APP];
  if (isDay(q.from)) { params.push(q.from); where.push(`(e.ts AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}::date`); }
  if (isDay(q.to)) { params.push(q.to); where.push(`(e.ts AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}::date`); }
  if (q.feature) { params.push(q.feature); where.push(`t.feature = $${params.length}`); }
  if (q.model === 'pro') where.push(`(e.payload->>'model') ILIKE '%pro%'`);
  else if (q.model === 'flash') where.push(`(e.payload->>'model') ILIKE '%flash%'`);
  if (q.ctype === 'pdf-ocr') where.push(IS_MM);
  else if (q.ctype === 'text') where.push(`NOT ${IS_MM}`);
  const W = where.join(' AND ');

  // Filter totals (priced in JS from per model/tier sums so the config drives pricing).
  const agg = await rowsOf(
    `SELECT e.payload->>'model' AS model, (${IN_TOK} > 200000) AS hi,
            sum(${IN_TOK})::bigint AS in_tok, sum(${OUT_TOK})::bigint AS out_tok, count(*)::int AS calls
     FROM trace_events e JOIN traces t ON t.trace_id = e.trace_id WHERE ${W} GROUP BY 1, 2`, params);
  let total = 0, totalInr = 0, totalInTok = 0, totalOutTok = 0;
  for (const r of agg) {
    total += n(r.calls); totalInTok += n(r.in_tok); totalOutTok += n(r.out_tok);
    totalInr += costInr(String(r.model), n(r.in_tok), n(r.out_tok), r.hi === true, PRICING);
  }

  const pageRows = await rowsOf(
    `SELECT to_char(e.ts AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS ts, t.feature AS feature, t.trace_id AS trace_id,
            e.payload->>'model' AS model, ${IN_TOK} AS in_tok, ${OUT_TOK} AS out_tok, ${IS_MM} AS mm
     FROM trace_events e JOIN traces t ON t.trace_id = e.trace_id WHERE ${W}
     ORDER BY e.ts DESC LIMIT ${pageSize} OFFSET ${page * pageSize}`, params);
  const items: CostItem[] = pageRows.map((r) => ({
    ts: String(r.ts), feature: String(r.feature || ''), traceId: String(r.trace_id || ''),
    model: modelLabel(String(r.model), PRICING), inTok: n(r.in_tok), outTok: n(r.out_tok),
    inr: perCallInr(String(r.model), n(r.in_tok), n(r.out_tok), PRICING),
    type: r.mm === true ? 'pdf-ocr' : 'text',
  }));
  return { items, total, totalInr, totalInTok, totalOutTok, page, pages: Math.max(1, Math.ceil(total / pageSize)), pageSize };
}

export interface DuplicateGroup { feature: string; model: string; inTok: number; outTok: number; n: number; wastedInr: number }

/** Likely accidental reruns: identical (feature, model, in/out token) calls repeated in a window.
 *  Identical token counts for the same call type ≈ the same input processed again. */
export async function costDuplicates(hours = 24): Promise<{ groups: DuplicateGroup[]; totalWastedInr: number }> {
  const rows = await rowsOf(
    `SELECT t.feature AS feature, e.payload->>'model' AS model, ${IN_TOK} AS in_tok, ${OUT_TOK} AS out_tok, count(*)::int AS n
     ${FROM_WHERE} AND e.ts > now() - interval '${Math.max(1, Math.min(720, hours))} hours' AND ${IN_TOK} > 0
     GROUP BY 1, 2, 3, 4 HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 50`,
  );
  let totalWastedInr = 0;
  const groups = rows.map((r) => {
    const cnt = n(r.n);
    const wastedInr = (cnt - 1) * perCallInr(String(r.model), n(r.in_tok), n(r.out_tok), PRICING);
    totalWastedInr += wastedInr;
    return { feature: String(r.feature || ''), model: modelLabel(String(r.model), PRICING), inTok: n(r.in_tok), outTok: n(r.out_tok), n: cnt, wastedInr };
  }).sort((a, b) => b.wastedInr - a.wastedInr);
  return { groups, totalWastedInr };
}
