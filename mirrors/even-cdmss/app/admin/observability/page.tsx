import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { featureMeta, normalizeFeature, FEATURE_FILTERS } from '@/lib/observability-meta';
import RunsBrowser, { type RunRow } from '@/app/admin/appropriateness-runs/runs-browser';
import type { ExportRun } from '@/lib/runs-export';
import CostTab from './cost-tab';
import ReasoningTab from './reasoning-tab';
import { shortPromptRef } from '@/lib/reasoning/registry-core';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Observability · Admin' };

type ListRow = { trace_id: string; feature: string; status: string; started_at: string; total_ms: number | null; question_preview: string | null; severity: string | null };
type ModRow = { feature: string; n: number; p50: number | null; errs: number };
type VolRow = { d: string; feature: string; n: number };

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const CALC_LIST = ['egfr', 'news2', 'abg', 'hyponatremia', 'sepsis_bundle', 'nihss', 'abcd2', 'curb65', 'wells_dvt', 'wells_pe', 'heart', 'timi', 'sofa', 'qtc', 'alvarado', 'calc_sidebar'];

function Badge({ feature }: { feature: string }) {
  const m = featureMeta(feature);
  return <span className="rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ background: m.color + '1f', color: m.color }}>{m.label}</span>;
}
function timeAgo(iso: string): string {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(t)) return '—';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const ms = (v: number | null | undefined) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);

async function num(text: string, params: unknown[]): Promise<number> {
  try { const r = await run(text, params); return Number((r[0] as { n?: number })?.n ?? 0); } catch { return 0; }
}
async function rowsOf<T>(text: string, params: unknown[]): Promise<T[]> {
  try { return (await run(text, params)) as T[]; } catch { return []; }
}

function Locked({ configured, bad }: { configured: boolean; bad: boolean }) {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">Observability</h1>
      <p className="mt-1.5 text-sm text-slate-500">Internal usage &amp; pipeline audit. This surface shows raw clinical queries, so it is access-controlled.</p>
      <div className="mt-8 max-w-sm rounded-xl border border-slate-200 bg-white p-5">
        {!configured ? (
          <p className="text-sm text-red-700">Locked. Set the <code className="rounded bg-slate-100 px-1">ADMIN_TOKEN</code> environment variable to enable this surface.</p>
        ) : (
          <form method="POST" action="/api/admin/unlock">
            <label className="block text-sm font-medium text-slate-700">Admin token</label>
            <input type="password" name="token" autoFocus className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Enter admin token" />
            {bad && <p className="mt-2 text-xs text-red-600">Incorrect token.</p>}
            <button type="submit" className="mt-3 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark">Unlock</button>
          </form>
        )}
      </div>
    </div>
  );
}

export default async function ObservabilityAdmin({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;
  const tab = sp.tab === 'queries' ? 'queries' : sp.tab === 'reasoning' ? 'reasoning' : sp.tab === 'rightcare' ? 'rightcare' : sp.tab === 'cost' ? 'cost' : 'overview';
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-[26px] font-semibold leading-tight text-slate-900 sm:text-[30px]">Observability</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-slate-500">One forensic surface for every run — Ask, Differential, Drugs, Calculators, Right Care, and Medication Audit. Usage, latency, and a full event-level audit trail. Internal; shows raw clinical queries.</p>
        </div>
        <div className="flex items-center gap-4">
          {/* Reasoning Observability Stage 0: the research export (prompts + rubrics, no clinical data) */}
          <Link href="/admin/observability/adjudications" className="whitespace-nowrap text-xs font-medium text-brand hover:underline">Adjudication Ledger →</Link>
          <Link href="/admin/observability/reconstruction-fidelity" className="whitespace-nowrap text-xs font-medium text-brand hover:underline">Reconstruction Fidelity →</Link>
          <a href="/api/admin/reasoning-registry?format=json" className="whitespace-nowrap text-xs text-slate-400 hover:text-brand">Download reasoning registry</a>
          <form method="POST" action="/api/admin/unlock?action=logout"><button className="whitespace-nowrap text-xs text-slate-400 hover:text-brand">Lock</button></form>
        </div>
      </div>
      <div className="mt-6 flex gap-5 border-b border-slate-200">
        {[['overview', 'Overview'], ['queries', 'Runs'], ['reasoning', 'Reasoning'], ['rightcare', 'Right Care runs'], ['cost', 'LLM cost']].map(([k, l]) => (
          <Link key={k} href={`/admin/observability?tab=${k}`} className={`-mb-px pb-2 text-sm ${tab === k ? 'border-b-2 border-brand font-medium text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}>{l}</Link>
        ))}
      </div>
      <div className="mt-5">
        {tab === 'overview' ? <OverviewTab /> : tab === 'reasoning' ? <ReasoningTab /> : tab === 'rightcare' ? <RightCareRunsTab /> : tab === 'cost' ? <CostTab sp={sp} /> : <QueriesTab sp={sp} />}
      </div>
    </div>
  );
}

function parseOutput(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; } }
  return {};
}

async function RightCareRunsTab() {
  const rows = await rowsOf<Record<string, unknown>>(
    `SELECT id, mode, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') created_at,
            scenario, doc_type, summary, n_sources, n_findings, output
     FROM appropriateness_runs WHERE app_source = $1 ORDER BY created_at DESC LIMIT 200`,
    [APP],
  );
  const runs: RunRow[] = rows.map((r) => ({
    id: String(r.id),
    mode: String(r.mode) as ExportRun['mode'],
    created_at: String(r.created_at),
    scenario: r.scenario == null ? null : String(r.scenario),
    docType: r.doc_type == null ? null : String(r.doc_type),
    summary: r.summary == null ? '' : String(r.summary),
    nSources: Number(r.n_sources ?? 0),
    nFindings: Number(r.n_findings ?? 0),
    output: parseOutput(r.output),
  }));
  return (
    <div>
      <p className="mb-3 text-sm text-slate-500">De-identified output retention for every Right Care run (Order check / Care pathway / Record audit). Download any run, or the whole corpus stacked, as Excel. Showing the latest {runs.length}. For the step-by-step pipeline of a run, use the <Link href="/admin/observability?tab=queries&feature=appropriateness_value" className="text-brand hover:underline">Runs</Link> tab.</p>
      <RunsBrowser runs={runs} />
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-4 py-3">
      <div className="text-[12px] text-slate-500">{label}</div>
      <div className="text-[22px] font-medium text-slate-900">{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

async function OverviewTab() {
  const today = await num(`SELECT count(*)::int n FROM traces WHERE app_source=$1 AND started_at::date=current_date`, [APP]);
  const week = await num(`SELECT count(*)::int n FROM traces WHERE app_source=$1 AND started_at > now()-interval '7 days'`, [APP]);
  const er = (await rowsOf<{ errs: number; total: number }>(`SELECT count(*) FILTER (WHERE status='error')::int errs, count(*)::int total FROM traces WHERE app_source=$1 AND started_at > now()-interval '7 days'`, [APP]))[0] || { errs: 0, total: 0 };
  const lat = (await rowsOf<{ p50: number | null; p95: number | null }>(`SELECT percentile_cont(0.5) within group (order by total_ms)::int p50, percentile_cont(0.95) within group (order by total_ms)::int p95 FROM traces WHERE app_source=$1 AND status='success' AND total_ms IS NOT NULL AND started_at > now()-interval '7 days'`, [APP]))[0] || { p50: null, p95: null };
  const vol = await rowsOf<VolRow>(`SELECT to_char(started_at::date,'YYYY-MM-DD') d, feature, count(*)::int n FROM traces WHERE app_source=$1 AND started_at > now()-interval '13 days' GROUP BY 1,2 ORDER BY 1`, [APP]);
  const perModRaw = await rowsOf<ModRow>(`SELECT feature, count(*)::int n, percentile_cont(0.5) within group (order by total_ms)::int p50, count(*) FILTER (WHERE status='error')::int errs FROM traces WHERE app_source=$1 AND started_at > now()-interval '7 days' GROUP BY 1 ORDER BY n DESC`, [APP]);
  const recent = await rowsOf<ListRow>(`SELECT trace_id, feature, status, to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') started_at, total_ms, question_preview, severity FROM traces WHERE app_source=$1 ORDER BY started_at DESC LIMIT 8`, [APP]);

  const errRate = er.total > 0 ? ((er.errs / er.total) * 100).toFixed(1) + '%' : '0%';

  // Aggregate by normalized feature (collapses coach_* / the 15 calculators).
  const perMod = new Map<string, { n: number; errs: number; p50sum: number; p50n: number }>();
  for (const r of perModRaw) {
    const k = normalizeFeature(r.feature);
    const cur = perMod.get(k) || { n: 0, errs: 0, p50sum: 0, p50n: 0 };
    cur.n += r.n; cur.errs += r.errs;
    if (r.p50 != null) { cur.p50sum += r.p50 * r.n; cur.p50n += r.n; }
    perMod.set(k, cur);
  }
  const perModList = [...perMod.entries()].map(([k, v]) => ({ key: k, n: v.n, errs: v.errs, p50: v.p50n ? Math.round(v.p50sum / v.p50n) : null })).sort((a, b) => b.n - a.n);

  // 14-day stacked volume by normalized feature
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(); d.setUTCDate(d.getUTCDate() - i); days.push(d.toISOString().slice(0, 10)); }
  const modules = Array.from(new Set(vol.map((v) => normalizeFeature(v.feature))));
  const byDay = new Map<string, Record<string, number>>();
  for (const d of days) byDay.set(d, {});
  for (const v of vol) { const rec = byDay.get(v.d); if (rec) { const k = normalizeFeature(v.feature); rec[k] = (rec[k] || 0) + v.n; } }
  let maxTotal = 1;
  for (const d of days) { const rec = byDay.get(d)!; const t = Object.values(rec).reduce((a, b) => a + b, 0); if (t > maxTotal) maxTotal = t; }

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <Kpi label="Runs today" value={today.toLocaleString()} />
        <Kpi label="Last 7 days" value={week.toLocaleString()} />
        <Kpi label="Error rate (7d)" value={errRate} sub={`${er.errs} of ${er.total}`} />
        <Kpi label="p50 latency" value={ms(lat.p50)} />
        <Kpi label="p95 latency" value={ms(lat.p95)} />
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-slate-800">Run volume · last 14 days</span>
          <div className="flex flex-wrap gap-2 text-[11px] text-slate-500">
            {modules.map((m) => (<span key={m} className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: featureMeta(m).color }} />{featureMeta(m).label}</span>))}
          </div>
        </div>
        <div className="flex items-end gap-1.5" style={{ height: 96 }}>
          {days.map((d) => {
            const rec = byDay.get(d)!;
            const total = Object.values(rec).reduce((a, b) => a + b, 0);
            const present = modules.filter((m) => rec[m]);
            return (
              <div key={d} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${d}: ${total}`}>
                <div className="flex w-full flex-col justify-end overflow-hidden rounded-sm" style={{ height: 78 }}>
                  {present.map((m) => (<div key={m} style={{ background: featureMeta(m).color, height: `${Math.max(2, Math.round((rec[m] / maxTotal) * 78))}px` }} />))}
                </div>
                <span className="text-[10px] text-slate-400">{d.slice(8, 10)}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-1 text-[11px] text-slate-400">peak {maxTotal}/day</div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-medium text-slate-800">By module · last 7 days</div>
          {perModList.length === 0 ? <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">No runs in the last 7 days.</div> : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white text-sm">
              <div className="flex px-3 py-2 text-xs text-slate-500"><span className="flex-1">module</span><span className="w-14 text-right">runs</span><span className="w-16 text-right">p50</span><span className="w-14 text-right">errors</span></div>
              {perModList.map((r) => (
                <div key={r.key} className="flex border-t border-slate-100 px-3 py-2"><span className="flex-1"><Badge feature={r.key} /></span><span className="w-14 text-right text-slate-700">{r.n}</span><span className="w-16 text-right text-slate-500">{ms(r.p50)}</span><span className={`w-14 text-right ${r.errs ? 'text-red-600' : 'text-slate-500'}`}>{r.errs}</span></div>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="mb-2 text-sm font-medium text-slate-800">Recent runs</div>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {recent.length === 0 ? <div className="p-6 text-center text-sm text-slate-500">No runs yet.</div> : recent.map((r) => (
              <Link key={r.trace_id} href={`/admin/observability/${r.trace_id}`} className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-0 hover:bg-slate-50">
                <Badge feature={r.feature} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-slate-700">{r.question_preview || '(no preview)'}</span>
                {r.status === 'error' ? <span className="text-[11px] text-red-600">error</span> : <span className="text-[11px] text-slate-400">{ms(r.total_ms)}</span>}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function featureWhere(val: string, params: unknown[]): string {
  if (val === 'coach') return `feature LIKE 'coach%'`;
  if (val === 'calculators') {
    const ph = CALC_LIST.map((c) => { params.push(c); return `$${params.length}`; });
    return `feature IN (${ph.join(',')})`;
  }
  params.push(val);
  return `feature = $${params.length}`;
}

async function QueriesTab({ sp }: { sp: { q?: string; feature?: string; status?: string; pver?: string } }) {
  const params: unknown[] = [APP];
  let where = `app_source=$1`;
  if (sp.feature) where += ` AND ${featureWhere(sp.feature, params)}`;
  if (sp.status) { params.push(sp.status); where += ` AND status=$${params.length}`; }
  if (sp.q) { params.push(`%${sp.q}%`); where += ` AND question_preview ILIKE $${params.length}`; }
  // Stage 2: prompt filter over traces.prompt_ids (Stage-1 column). Only added when the user
  // picks one, so pre-migration the default list query is untouched.
  if (sp.pver) { params.push(sp.pver); where += ` AND prompt_ids ? $${params.length}`; }
  const list = await rowsOf<ListRow>(`SELECT trace_id, feature, status, to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') started_at, total_ms, question_preview, severity FROM traces WHERE ${where} ORDER BY started_at DESC LIMIT 100`, params);

  // Stage 2 (INFERRED, soft): prompt·version per listed run + the filter's option list — both
  // read the Stage-1 prompt_ids column in SEPARATE queries so a pre-migration DB degrades these
  // to '—'/an empty dropdown while the run list itself stays intact. rowsOf swallows the error.
  const ids = list.map((r) => r.trace_id);
  const pidRows = ids.length
    ? await rowsOf<{ trace_id: string; prompt_ids: unknown }>(`SELECT trace_id, prompt_ids FROM traces WHERE trace_id = ANY($1) AND prompt_ids IS NOT NULL`, [ids])
    : [];
  const promptsByTrace = new Map<string, string[]>();
  for (const r of pidRows) {
    const arr = Array.isArray(r.prompt_ids) ? (r.prompt_ids as unknown[]).map(String) : [];
    if (arr.length) promptsByTrace.set(r.trace_id, arr);
  }
  const pverOptions = (await rowsOf<{ pid: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(prompt_ids) AS pid FROM traces WHERE app_source=$1 AND prompt_ids IS NOT NULL ORDER BY 1 LIMIT 50`, [APP],
  )).map((r) => String(r.pid));

  const groups = Array.from(new Set(FEATURE_FILTERS.map((f) => f.group)));

  return (
    <div>
      <form method="GET" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="queries" />
        <div><label className="block text-[11px] text-slate-500">Search</label><input name="q" defaultValue={sp.q || ''} placeholder="question text…" className="rounded-lg border border-slate-300 px-2 py-1 text-sm" /></div>
        <div><label className="block text-[11px] text-slate-500">Module</label>
          <select name="feature" defaultValue={sp.feature || ''} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
            <option value="">all modules</option>
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {FEATURE_FILTERS.filter((f) => f.group === g).map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div><label className="block text-[11px] text-slate-500">Status</label>
          <select name="status" defaultValue={sp.status || ''} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
            <option value="">all</option><option value="success">success</option><option value="error">error</option><option value="running">running</option>
          </select>
        </div>
        {pverOptions.length > 0 && (
          <div><label className="block text-[11px] text-slate-500">Prompt</label>
            <select name="pver" defaultValue={sp.pver || ''} className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
              <option value="">any</option>
              {pverOptions.map((p) => <option key={p} value={p}>{shortPromptRef(p)}</option>)}
            </select>
          </div>
        )}
        <button className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark">Filter</button>
        <Link href="/admin/observability?tab=queries" className="px-2 py-1.5 text-sm text-slate-500 hover:text-brand">Reset</Link>
      </form>

      {list.length === 0 ? <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">No matching runs.</div> : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex px-3 py-2 text-xs text-slate-500"><span className="w-20">when</span><span className="w-44">module</span><span className="flex-1">query</span><span className="hidden w-44 text-right sm:block">prompt</span><span className="w-20 text-right">latency</span><span className="w-20 text-right">status</span></div>
          {list.map((r) => {
            const prompts = promptsByTrace.get(r.trace_id) ?? [];
            return (
            <Link key={r.trace_id} href={`/admin/observability/${r.trace_id}`} className="flex items-center border-t border-slate-100 px-3 py-2 text-sm hover:bg-slate-50">
              <span className="w-20 text-xs text-slate-500">{timeAgo(r.started_at)}</span>
              <span className="w-44 shrink-0"><Badge feature={r.feature} /></span>
              <span className="min-w-0 flex-1 truncate text-slate-700">{r.question_preview || '(no preview)'}</span>
              <span className="hidden w-44 shrink-0 truncate text-right font-mono text-[11px] text-slate-500 sm:block" title={prompts.join(', ')}>
                {prompts.length === 0 ? '—' : prompts.length === 1 ? shortPromptRef(prompts[0]) : `${shortPromptRef(prompts[0])} +${prompts.length - 1}`}
              </span>
              <span className="w-20 text-right text-xs text-slate-500">{ms(r.total_ms)}</span>
              <span className="w-20 text-right text-xs">{r.status === 'error' ? <span className="text-red-600">error</span> : r.status === 'running' ? <span className="text-amber-600">running</span> : <span className="text-teal-600">success</span>}</span>
            </Link>
            );
          })}
        </div>
      )}
      <p className="mt-2 text-xs text-slate-400">Showing latest {list.length} (max 100). Click a row for the full pipeline audit trail.</p>
    </div>
  );
}
