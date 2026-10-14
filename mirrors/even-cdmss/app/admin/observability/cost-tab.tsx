import Link from 'next/link';
import { sql } from '@/lib/db';
import { featureMeta } from '@/lib/observability-meta';
import { fmtInr, costInr } from '@/lib/llm-cost-core';
import { costKpis, costByBucket, costByFeature, costByModel, costByType, costDuplicates, costLog, costLogFeatures, MULTIMODAL_METERED_SINCE, PRICING, type Scale } from '@/lib/llm-cost';
import { groupPromptVersionCost, promptVersionChanges, type PromptVersionCostRow, type PromptVersionCostGroup, type VersionChange } from '@/lib/reasoning/registry-core';

const APP = process.env.APP_SOURCE || 'standalone';
const runQ = sql as unknown as (t: string, p?: unknown[]) => Promise<Record<string, unknown>[]>;

// ── Stage 2: by-prompt-version spend (the 4th breakdown) + rollout attribution ──────────────────
// INFERRED reads of the Stage-1 envelope columns (0012), in their own soft queries: pre-migration
// they throw → catch → the card renders '—' and the attribution line stays absent. Never a 500.
// The token expressions mirror lib/llm-cost.ts (IN_TOK/OUT_TOK) — kept verbatim so pricing agrees.
const PV_IN_TOK = `coalesce((e.payload->'usage'->>'prompt_tokens')::int, 0)`;
const PV_OUT_TOK = `greatest(
    coalesce((e.payload->'usage'->>'completion_tokens')::int, 0),
    coalesce((e.payload->'usage'->>'total_tokens')::int, 0) - coalesce((e.payload->'usage'->>'prompt_tokens')::int, 0)
  )`;

async function costByPromptVersion(days = 7): Promise<PromptVersionCostGroup[]> {
  try {
    const rows = await runQ(
      `SELECT e.prompt_id, e.prompt_version, e.payload->>'model' AS model, (${PV_IN_TOK} > 200000) AS hi,
              sum(${PV_IN_TOK})::bigint AS in_tok, sum(${PV_OUT_TOK})::bigint AS out_tok, count(*)::int AS calls
       FROM trace_events e
       WHERE e.kind IN ('llm_response', 'llm_stream_usage') AND e.app_source = $1
         AND (e.payload->>'model') ILIKE '%gemini%' AND e.prompt_id IS NOT NULL
         AND e.ts > now() - interval '${Math.max(1, Math.min(90, days))} days'
       GROUP BY 1, 2, 3, 4`,
      [APP],
    );
    const shaped: PromptVersionCostRow[] = rows.map((r) => ({
      promptId: String(r.prompt_id), promptVersion: String(r.prompt_version ?? ''),
      model: String(r.model), hi: r.hi === true,
      inTok: Number(r.in_tok) || 0, outTok: Number(r.out_tok) || 0, calls: Number(r.calls) || 0,
    }));
    return groupPromptVersionCost(shaped, (model, inTok, outTok, hi) => costInr(model, inTok, outTok, hi, PRICING));
  } catch { return []; }
}

async function recentVersionChanges(hours = 48): Promise<VersionChange[]> {
  try {
    const rows = await runQ(
      `SELECT prompt_id, prompt_version, (extract(epoch FROM min(ts)) * 1000)::bigint AS first_seen_ms
       FROM trace_events
       WHERE app_source = $1 AND prompt_id IS NOT NULL AND prompt_version IS NOT NULL
       GROUP BY 1, 2`,
      [APP],
    );
    return promptVersionChanges(
      rows.map((r) => ({ promptId: String(r.prompt_id), promptVersion: String(r.prompt_version), firstSeenMs: Number(r.first_seen_ms) })),
      Date.now() - hours * 3600_000,
    );
  } catch { return []; }
}

const SCALES: { k: Scale; l: string }[] = [{ k: 'hour', l: 'Hour' }, { k: 'day', l: 'Day' }, { k: 'week', l: 'Week' }, { k: 'month', l: 'Month' }];

function Kpi({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 px-4 py-3">
      <div className="text-[12px] text-slate-500">{label}</div>
      <div className={`text-[22px] font-medium ${danger ? 'text-red-600' : 'text-slate-900'}`}>{value}</div>
      {sub && <div className={`text-[11px] ${danger ? 'text-red-500' : 'text-slate-400'}`}>{sub}</div>}
    </div>
  );
}

export default async function CostTab({ sp }: { sp: Record<string, string | undefined> }) {
  const scale: Scale = (['hour', 'day', 'week', 'month'] as const).includes(sp.scale as Scale) ? (sp.scale as Scale) : 'day';
  const model = (sp.cmodel === 'pro' || sp.cmodel === 'flash') ? sp.cmodel : 'all';
  const ctype = (sp.ctype === 'text' || sp.ctype === 'pdf-ocr') ? sp.ctype : 'all';
  const from = sp.from || undefined;
  const to = sp.to || undefined;
  const feature = sp.cfeat || undefined;
  const page = Math.max(0, Number(sp.cpage) || 0);

  const [kpis, chart, byFeat, byModel, byType, dupes, log, logFeatures, byPromptVer, verChanges] = await Promise.all([
    costKpis(), costByBucket(scale), costByFeature(7), costByModel(7), costByType(7), costDuplicates(24),
    costLog({ from, to, feature, model, ctype, page, pageSize: 100 }), costLogFeatures(),
    costByPromptVersion(7), recentVersionChanges(48),
  ]);

  const full = chart.buckets.slice(0, -1);
  const mean = full.length ? full.reduce((s, b) => s + b.totalInr, 0) / full.length : 0;
  const spikeAt = mean * 1.8;
  const max = Math.max(1, ...chart.buckets.map((b) => b.totalInr));

  // Preserve the current filter/scale in pagination links.
  const pageHref = (p: number) => {
    const u = new URLSearchParams({ tab: 'cost', scale });
    if (from) u.set('from', from); if (to) u.set('to', to);
    if (feature) u.set('cfeat', feature); if (model !== 'all') u.set('cmodel', model);
    if (ctype !== 'all') u.set('ctype', ctype);
    if (p > 0) u.set('cpage', String(p));
    return `/admin/observability?${u.toString()}`;
  };

  return (
    <div>
      <p className="mb-4 max-w-3xl text-sm text-slate-500">
        Rupee cost of every Gemini call, computed from the tokens logged on each run (Vertex list price · Pro $1.25/$10, Flash $0.30/$2.50 per 1M in/out · ₹ at {fxLabel()}). Embeddings run on self-hosted Ollama (₹0 marginal). Advisory estimate for spotting spikes and accidental reruns — reconcile against the Vertex invoice.
      </p>

      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-[12px] leading-snug text-slate-700">
        <b className="text-amber-700">Metering note</b> · <b>PDF-OCR reads</b> (multimodal document reads — case-audit uploads + CCB result PDFs, on Gemini 2.5 Pro, with large image-token inputs) began being metered on <b>{MULTIMODAL_METERED_SINCE}</b>. Days before then show <i>text-only</i> spend, so the step-up in the daily total from that date is <b>newly-visible existing cost, not a usage regression</b> — see the “By call type” split below and the <b>PDF-OCR</b> tag in the call log.
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Today (so far)" value={fmtInr(kpis.today)} sub={kpis.spikePct != null ? `${kpis.spikePct >= 0 ? '+' : ''}${kpis.spikePct}% vs 7-day avg` : undefined} danger={kpis.spikePct != null && kpis.spikePct >= 80} />
        <Kpi label="Yesterday" value={fmtInr(kpis.yesterday)} />
        <Kpi label="Last 7 days" value={fmtInr(kpis.last7)} />
        <Kpi label="Last 30 days" value={fmtInr(kpis.last30)} />
      </div>

      {/* spend chart */}
      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-slate-800">Spend over time · {chart.label}</span>
          <div className="flex gap-1 text-[11px]">
            {SCALES.map((s) => (
              <Link key={s.k} href={`/admin/observability?tab=cost&scale=${s.k}`}
                className={`rounded px-2 py-0.5 ${scale === s.k ? 'bg-brand text-white' : 'text-slate-500 hover:bg-slate-100'}`}>{s.l}</Link>
            ))}
          </div>
        </div>
        {chart.buckets.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">No Gemini calls in this window.</div>
        ) : (
          <>
            <div className="flex items-end gap-1.5" style={{ height: 120 }}>
              {chart.buckets.map((b) => {
                const spike = mean > 0 && b !== chart.buckets[chart.buckets.length - 1] && b.totalInr > spikeAt;
                return (
                  <div key={b.bucket} className="flex-1" title={`${b.bucket} · ${fmtInr(b.totalInr)} · ${b.calls} calls`}>
                    <div className="w-full rounded-t" style={{ height: `${Math.max(2, (b.totalInr / max) * 108)}px`, background: spike ? '#E24B4A' : '#1D9E75' }} />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex justify-between text-[9.5px] text-slate-400">
              <span>{chart.buckets[0]?.bucket}</span>
              <span>{chart.buckets[chart.buckets.length - 1]?.bucket}</span>
            </div>
          </>
        )}
      </div>

      {/* regression watch — now prompt-version aware (Stage 2) */}
      {(dupes.groups.length > 0 || (kpis.spikePct != null && kpis.spikePct >= 80) || verChanges.length > 0) && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50/60 p-4">
          <div className="text-sm font-medium text-red-700">Regression watch</div>
          <ul className="mt-1.5 space-y-1 text-[12.5px] text-slate-700">
            {kpis.spikePct != null && kpis.spikePct >= 80 && (
              <li>Today's spend is <b>{kpis.spikePct >= 0 ? '+' : ''}{kpis.spikePct}%</b> vs the 7-day daily average ({fmtInr(kpis.today)} vs ~{fmtInr(kpis.last7 / 7)}/day).</li>
            )}
            {verChanges.length > 0 && (
              <li className="text-indigo-700">
                <b>Attribution:</b> prompt-version rollout{verChanges.length > 1 ? 's' : ''} in the last 48h — {verChanges.slice(0, 3).map((c) => `${c.shortId} ${c.fromVersion}→${c.toVersion}`).join(' · ')}. If a cost step-up starts here, it likely tracks the rollout, not a leak (check the by-prompt-version card below).
              </li>
            )}
            {dupes.groups.length > 0 && (
              <li><b>~{fmtInr(dupes.totalWastedInr)}</b> likely wasted in the last 24h on {dupes.groups.length} set(s) of identical repeated calls (same feature + token counts):</li>
            )}
          </ul>
          {dupes.groups.length > 0 && (
            <div className="mt-2 space-y-1">
              {dupes.groups.slice(0, 5).map((g, i) => (
                <div key={i} className="flex items-center justify-between rounded bg-white/70 px-2.5 py-1 text-[12px]">
                  <span className="text-slate-700">{featureMeta(g.feature).label} · {g.model} · {g.inTok.toLocaleString()}→{g.outTok.toLocaleString()} tok</span>
                  <span className="tabular-nums text-slate-600">×{g.n} · ~{fmtInr(g.wastedInr, { paise: true })} wasted</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* breakdowns — existing 3 + the by-prompt-version 4th (Stage 2) */}
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.05em] text-slate-400">By feature · last 7 days</div>
          {byFeat.length === 0 ? <div className="text-[12px] text-slate-400">—</div> : byFeat.slice(0, 8).map((g) => (
            <div key={g.key} className="flex items-center justify-between border-t border-slate-100 py-1.5 text-[12.5px] first:border-t-0">
              <span className="text-slate-700">{featureMeta(g.key).label}</span>
              <span className="tabular-nums text-slate-500">{fmtInr(g.inr)} · {g.calls.toLocaleString()} calls</span>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.05em] text-slate-400">By model · last 7 days</div>
          {byModel.length === 0 ? <div className="text-[12px] text-slate-400">—</div> : byModel.map((g) => (
            <div key={g.key} className="flex items-center justify-between border-t border-slate-100 py-1.5 text-[12.5px] first:border-t-0">
              <span className="text-slate-700">{g.key}</span>
              <span className="tabular-nums text-slate-500">{fmtInr(g.inr)} · {g.calls.toLocaleString()} calls</span>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.05em] text-slate-400">By call type · last 7 days</div>
          {byType.length === 0 ? <div className="text-[12px] text-slate-400">—</div> : byType.map((g) => (
            <div key={g.key} className="flex items-center justify-between border-t border-slate-100 py-1.5 text-[12.5px] first:border-t-0">
              <span className="text-slate-700">{g.key}</span>
              <span className="tabular-nums text-slate-500">{fmtInr(g.inr)} · {g.calls.toLocaleString()} calls</span>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.05em] text-indigo-500">By prompt version · last 7 days</div>
          {byPromptVer.length === 0 ? <div className="text-[12px] text-slate-400">— (populates once migration 0012 + tagged runs exist)</div> : byPromptVer.slice(0, 8).map((g) => (
            <div key={g.key} className="flex items-center justify-between border-t border-indigo-100 py-1.5 text-[12.5px] first:border-t-0">
              <span className="font-mono text-[11.5px] text-slate-700">{g.label}</span>
              <span className="tabular-nums text-slate-500">{fmtInr(g.inr)} · {g.calls.toLocaleString()} calls</span>
            </div>
          ))}
        </div>
      </div>

      {/* full call log — every call, filterable + paginated */}
      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 text-[10px] font-medium uppercase tracking-[0.05em] text-slate-400">Call log · every Gemini call</div>
        <form method="get" action="/admin/observability" className="mb-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="cost" />
          <input type="hidden" name="scale" value={scale} />
          <label className="text-[11px] text-slate-500">From<br /><input type="date" name="from" defaultValue={from} className="mt-0.5 rounded border border-slate-300 px-2 py-1 text-[12px]" /></label>
          <label className="text-[11px] text-slate-500">To<br /><input type="date" name="to" defaultValue={to} className="mt-0.5 rounded border border-slate-300 px-2 py-1 text-[12px]" /></label>
          <label className="text-[11px] text-slate-500">Feature<br />
            <select name="cfeat" defaultValue={feature ?? ''} className="mt-0.5 rounded border border-slate-300 px-2 py-1 text-[12px]">
              <option value="">All</option>
              {logFeatures.map((f) => <option key={f} value={f}>{featureMeta(f).label}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-slate-500">Model<br />
            <select name="cmodel" defaultValue={model} className="mt-0.5 rounded border border-slate-300 px-2 py-1 text-[12px]">
              <option value="all">All</option><option value="pro">Gemini 2.5 Pro</option><option value="flash">Gemini 2.5 Flash</option>
            </select>
          </label>
          <label className="text-[11px] text-slate-500">Call type<br />
            <select name="ctype" defaultValue={ctype} className="mt-0.5 rounded border border-slate-300 px-2 py-1 text-[12px]">
              <option value="all">All</option><option value="text">Text</option><option value="pdf-ocr">PDF-OCR read</option>
            </select>
          </label>
          <button type="submit" className="rounded-lg bg-brand px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-dark">Apply</button>
          {(from || to || feature || model !== 'all' || ctype !== 'all') && <Link href="/admin/observability?tab=cost&scale=day" className="py-1.5 text-[12px] text-slate-500 hover:text-brand">Clear</Link>}
        </form>

        <div className="mb-2 text-[12px] text-slate-600">
          Filter total: <b className="text-slate-900">{log.total.toLocaleString()} calls · {fmtInr(log.totalInr)}</b>
          <span className="text-slate-400"> · {log.totalInTok.toLocaleString()} in / {log.totalOutTok.toLocaleString()} out tokens</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="text-[10.5px] uppercase tracking-wide text-slate-400">
              <tr><th className="py-1 pr-3 font-medium">Date · time (IST)</th><th className="py-1 pr-3 font-medium">Feature</th><th className="py-1 pr-3 font-medium">Model</th><th className="py-1 pr-3 text-right font-medium">In</th><th className="py-1 pr-3 text-right font-medium">Out</th><th className="py-1 text-right font-medium">₹</th></tr>
            </thead>
            <tbody>
              {log.items.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-slate-400">No calls match this filter.</td></tr>}
              {log.items.map((it, i) => (
                <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="py-1.5 pr-3 tabular-nums text-slate-500">{it.ts}</td>
                  <td className="py-1.5 pr-3"><Link href={`/admin/observability/${it.traceId}`} className="text-slate-700 hover:text-brand">{featureMeta(it.feature).label}</Link>{it.type === 'pdf-ocr' && (it.inTok === 0 && it.outTok === 0
                    ? <span className="ml-1.5 rounded bg-slate-100 px-1 py-0.5 text-[9.5px] text-slate-500" title={`Read before multimodal metering began (${MULTIMODAL_METERED_SINCE}); no token usage was logged, so its ₹ is not counted.`}>PDF-OCR · unmetered</span>
                    : <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[9.5px] text-amber-700">PDF-OCR</span>)}</td>
                  <td className="py-1.5 pr-3 text-slate-600">{it.model}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600">{it.inTok.toLocaleString()}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-600">{it.outTok.toLocaleString()}</td>
                  <td className="py-1.5 text-right tabular-nums font-medium text-slate-800">{fmtInr(it.inr, { paise: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between text-[12px] text-slate-500">
          <span>Showing {log.total === 0 ? 0 : page * log.pageSize + 1}–{Math.min((page + 1) * log.pageSize, log.total)} of {log.total.toLocaleString()}</span>
          <span className="flex items-center gap-2">
            {page > 0 ? <Link href={pageHref(page - 1)} className="rounded border border-slate-300 px-2.5 py-1 hover:border-brand">‹ Prev</Link> : <span className="rounded border border-slate-100 px-2.5 py-1 text-slate-300">‹ Prev</span>}
            <span>Page {page + 1} / {log.pages}</span>
            {page + 1 < log.pages ? <Link href={pageHref(page + 1)} className="rounded border border-slate-300 px-2.5 py-1 hover:border-brand">Next ›</Link> : <span className="rounded border border-slate-100 px-2.5 py-1 text-slate-300">Next ›</span>}
          </span>
        </div>
      </div>
    </div>
  );
}

function fxLabel(): string {
  const fx = Number(process.env.LLM_FX_USD_INR) || 94.7;
  return `$1 = ₹${fx}`;
}
