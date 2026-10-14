import Link from 'next/link';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Literature engine · Admin' };

type Topic = { id: number; topic: string; query_terms: string; enabled: boolean; last_run_at: string | null };
type RunRow = { id: number; kind: string; started_at: string; found: number; inserted: number; skipped_dup: number; rejected: number; topic: string | null; detail: { added?: string[] } | null };
type Article = { pmid: string; title: string | null; journal: string | null; year: number | null; evidence_tier: number | null; citation_count: number | null; status: string; topic: string | null };
type DayRow = { d: string; n: number };

const TABS: [string, string][] = [['overview', 'Overview'], ['topics', 'Topics'], ['runs', 'Runs'], ['library', 'Library'], ['retractions', 'Retractions']];
const TIER: Record<number, string> = { 1: 'Guideline', 2: 'Review', 3: 'RCT', 4: 'Study' };

async function count(p: unknown): Promise<number> {
  try { const r = (await (p as Promise<Array<{ n: number }>>)); return Number(r[0]?.n ?? 0); } catch { return 0; }
}
async function rows<T>(p: unknown): Promise<T[]> {
  try { return (await (p as Promise<T[]>)); } catch { return []; }
}
function timeAgo(iso: string): string {
  const d = new Date(iso); const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return d.toLocaleDateString();
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="rounded-md bg-slate-100 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold text-slate-900">{value}</div>
      {sub && <div className={`text-xs ${accent ? 'text-emerald-600' : 'text-slate-400'}`}>{sub}</div>}
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">{text}</div>;
}

export default async function LiteratureAdmin({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = 'overview' } = await searchParams;
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Literature engine</h1>
      <p className="mt-1 text-sm text-slate-500">
        Daily PubMed harvest into the CDMSS corpus, with continuous retraction screening. Internal admin surface — not shown to clinicians.
      </p>
      <div className="mt-6 flex gap-5 border-b border-slate-200">
        {TABS.map(([key, label]) => (
          <Link key={key} href={`/admin/literature?tab=${key}`}
            className={`-mb-px pb-2 text-sm ${tab === key ? 'border-b-2 border-slate-900 font-medium text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}>
            {label}
          </Link>
        ))}
      </div>
      <div className="mt-5">
        {tab === 'overview' && <OverviewTab />}
        {tab === 'topics' && <TopicsTab />}
        {tab === 'runs' && <RunsTab />}
        {tab === 'library' && <LibraryTab />}
        {tab === 'retractions' && <RetractionsTab />}
      </div>
    </div>
  );
}

async function OverviewTab() {
  const corpus = await count(sql`SELECT count(*)::int AS n FROM mksap_chunks`);
  const pubmed = await count(sql`SELECT count(*)::int AS n FROM mksap_chunks WHERE source = 'pubmed'`);
  const week = await count(sql`SELECT COALESCE(SUM(inserted),0)::int AS n FROM ingest_runs WHERE kind='harvest' AND started_at > now() - interval '7 days'`);
  const today = await count(sql`SELECT COALESCE(SUM(inserted),0)::int AS n FROM ingest_runs WHERE kind='harvest' AND started_at::date = current_date`);
  const todayTopics = await count(sql`SELECT count(DISTINCT topic_id)::int AS n FROM ingest_runs WHERE kind='harvest' AND inserted>0 AND started_at::date = current_date`);
  const activeTopics = await count(sql`SELECT count(*)::int AS n FROM ingest_topics WHERE enabled`);
  const newTopics = await count(sql`SELECT COALESCE(SUM(inserted),0)::int AS n FROM ingest_runs WHERE kind='curator' AND started_at > now() - interval '7 days'`);

  const days = await rows<DayRow>(sql`
    SELECT to_char(started_at::date,'Dy') AS d, SUM(inserted)::int AS n
    FROM ingest_runs WHERE started_at > now() - interval '6 days'
    GROUP BY started_at::date ORDER BY started_at::date`);
  const maxN = Math.max(1, ...days.map((x) => x.n));

  const acts = await rows<RunRow>(sql`
    SELECT r.id, r.kind, r.started_at::text AS started_at, r.found, r.inserted, r.skipped_dup, r.rejected, t.topic, r.detail
    FROM ingest_runs r LEFT JOIN ingest_topics t ON t.id = r.topic_id
    WHERE r.inserted > 0 OR r.kind='curator'
    ORDER BY r.started_at DESC LIMIT 12`);

  const latest = await rows<Article>(sql`
    SELECT a.pmid, a.title, a.journal, a.year, a.evidence_tier, a.citation_count, a.status, t.topic
    FROM ingested_articles a LEFT JOIN ingest_topics t ON t.id = a.topic_id
    ORDER BY a.first_ingested_at DESC LIMIT 8`);

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Corpus chunks" value={corpus.toLocaleString()} sub={week > 0 ? `+${week.toLocaleString()} this week` : 'no growth this week'} accent={week > 0} />
        <Kpi label="Abstracts today" value={today.toLocaleString()} sub={today > 0 ? `across ${todayTopics} topic${todayTopics === 1 ? '' : 's'}` : '—'} />
        <Kpi label="Active topics" value={String(activeTopics)} sub={`${pubmed.toLocaleString()} PubMed chunks`} />
        <Kpi label="New topics (Curator)" value={String(newTopics)} sub="last 7 days" />
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm font-medium text-slate-800">Corpus growth · last 7 days</span>
          <span className="text-xs text-slate-400">abstracts/day</span>
        </div>
        {days.length === 0 ? (
          <p className="text-sm text-slate-400">No ingestion in the last 7 days.</p>
        ) : (
          <div className="flex items-end gap-3" style={{ height: 80 }}>
            {days.map((x, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[11px] text-slate-500">{x.n}</span>
                <div className="w-full rounded bg-blue-500" style={{ height: `${Math.round((x.n / maxN) * 56) + 4}px` }} />
                <span className="text-[11px] text-slate-400">{x.d}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div>
          <div className="mb-2 text-sm font-medium text-slate-800">Recent ingestion activity</div>
          {acts.length === 0 ? <Empty text="No ingestion runs yet." /> : (
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              {acts.map((r) => {
                const curator = r.kind === 'curator';
                const added = r.detail?.added;
                return (
                  <div key={r.id} className="flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 last:border-0">
                    <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${curator ? 'bg-violet-50 text-violet-700' : 'bg-blue-50 text-blue-700'}`}>{r.kind}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-slate-800">
                        {curator ? `Discovered ${r.inserted} new topic${r.inserted === 1 ? '' : 's'}` : (r.topic ?? 'harvest')}
                      </div>
                      <div className="truncate text-[11px] text-slate-400">
                        {timeAgo(r.started_at)}
                        {curator && added && added.length > 0 ? ` · ${added.slice(0, 3).join(', ')}` : ''}
                        {!curator ? ` · ${r.found} found · ${r.skipped_dup} deduped` : ''}
                      </div>
                    </div>
                    <span className={`shrink-0 text-sm font-medium ${curator ? 'text-violet-700' : 'text-emerald-600'}`}>+{r.inserted}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 text-sm font-medium text-slate-800">Latest abstracts</div>
          {latest.length === 0 ? <Empty text="Nothing ingested yet." /> : (
            <div className="space-y-2">
              {latest.map((a) => (
                <div key={a.pmid} className="rounded-lg border border-slate-200 bg-white p-2.5">
                  <div className="text-[13px] leading-snug text-slate-800">{a.title ?? a.pmid}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                    <span>{a.journal}{a.year ? ` · ${a.year}` : ''}</span>
                    {a.evidence_tier && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{TIER[a.evidence_tier] ?? 'Study'}</span>}
                    {a.topic && <span className="rounded bg-slate-50 px-1.5 py-0.5 text-slate-500">{a.topic}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

async function TopicsTab() {
  const list = await rows<Topic>(sql`SELECT id, topic, query_terms, enabled, last_run_at::text AS last_run_at FROM ingest_topics ORDER BY enabled DESC, last_run_at ASC NULLS FIRST, id`);
  if (list.length === 0) return <Empty text="No topics yet." />;
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
        <thead><tr className="text-left text-slate-500">
          <th className="px-4 py-2 font-normal" style={{ width: '34%' }}>Topic ({list.length})</th>
          <th className="px-2 py-2 font-normal" style={{ width: '38%' }}>Query terms</th>
          <th className="px-2 py-2 font-normal" style={{ width: '14%' }}>Status</th>
          <th className="px-4 py-2 font-normal" style={{ width: '14%' }}>Last run</th>
        </tr></thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id} className="border-t border-slate-100 align-top">
              <td className="px-4 py-2.5 text-slate-800">{t.topic}</td>
              <td className="px-2 py-2.5 font-mono text-xs text-slate-500">{t.query_terms}</td>
              <td className="px-2 py-2.5"><span className={`rounded px-2 py-0.5 text-xs ${t.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{t.enabled ? 'enabled' : 'paused'}</span></td>
              <td className="px-4 py-2.5 text-slate-500">{t.last_run_at ? timeAgo(t.last_run_at) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function RunsTab() {
  const list = await rows<RunRow>(sql`
    SELECT r.id, r.kind, r.started_at::text AS started_at, r.found, r.inserted, r.skipped_dup, r.rejected, t.topic, r.detail
    FROM ingest_runs r LEFT JOIN ingest_topics t ON t.id=r.topic_id ORDER BY r.started_at DESC LIMIT 60`);
  if (list.length === 0) return <Empty text="No runs yet." />;
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-slate-500">
          <th className="px-4 py-2 font-normal">When</th><th className="px-2 py-2 font-normal">Kind</th><th className="px-2 py-2 font-normal">Topic</th>
          <th className="px-2 py-2 font-normal">Found</th><th className="px-2 py-2 font-normal">Added</th><th className="px-2 py-2 font-normal">Deduped</th>
        </tr></thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id} className="border-t border-slate-100">
              <td className="px-4 py-2.5 text-slate-500">{timeAgo(r.started_at)}</td>
              <td className="px-2 py-2.5">{r.kind}</td>
              <td className="px-2 py-2.5 text-slate-700">{r.topic ?? (r.kind === 'curator' ? '(curator)' : '—')}</td>
              <td className="px-2 py-2.5">{r.found}</td>
              <td className="px-2 py-2.5 text-emerald-700">{r.inserted}</td>
              <td className="px-2 py-2.5 text-slate-500">{r.skipped_dup}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function LibraryTab() {
  const list = await rows<Article>(sql`
    SELECT a.pmid, a.title, a.journal, a.year, a.evidence_tier, a.citation_count, a.status, t.topic
    FROM ingested_articles a LEFT JOIN ingest_topics t ON t.id=a.topic_id ORDER BY a.first_ingested_at DESC LIMIT 60`);
  if (list.length === 0) return <Empty text="No articles ingested yet." />;
  return (
    <div className="space-y-2">
      {list.map((a) => (
        <div key={a.pmid} className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-sm text-slate-800">{a.title ?? a.pmid}</div>
          <div className="mt-0.5 text-xs text-slate-500">
            {a.journal}{a.year ? ` · ${a.year}` : ''} · PMID {a.pmid}{a.topic ? ` · ${a.topic}` : ''}{a.status !== 'active' ? ` · ${a.status}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

async function RetractionsTab() {
  const list = await rows<Article>(sql`
    SELECT a.pmid, a.title, a.journal, a.year, a.evidence_tier, a.citation_count, a.status, t.topic
    FROM ingested_articles a LEFT JOIN ingest_topics t ON t.id=a.topic_id WHERE a.status='retracted' ORDER BY a.first_ingested_at DESC LIMIT 60`);
  if (list.length === 0) return <Empty text="No retractions detected. The sentinel auto-hides any retracted article from retrieval and lists it here." />;
  return (
    <div className="space-y-2">
      {list.map((a) => (
        <div key={a.pmid} className="rounded-lg border border-rose-200 bg-rose-50 p-3">
          <div className="text-sm text-rose-900">{a.title ?? a.pmid}</div>
          <div className="mt-0.5 text-xs text-rose-700">{a.journal}{a.year ? ` · ${a.year}` : ''} · PMID {a.pmid} · hidden from retrieval</div>
        </div>
      ))}
    </div>
  );
}
