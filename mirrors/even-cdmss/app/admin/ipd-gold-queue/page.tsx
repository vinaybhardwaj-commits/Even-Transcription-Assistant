// /admin/ipd-gold-queue — Consensus gold (#7), SL2. V's adjudication queue for upgrading the thin
// single-shot IPD gold (1.1) into a ratified union (2.0, frozen LATER at SL3). One row per deduped
// union candidate across the 25 gold cases, seeded by scripts/ipd-consensus-gold-harness.mjs.
// De-identified: finding titles + case link-back keys only — no PHI, no URLs. Access-controlled by
// the admin unlock. This is the bench upgrade, distinct from the live audit surface.
import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import ConsensusTriage from './consensus-triage';

export const dynamic = 'force-dynamic';

type Candidate = {
  id: string; case_id: string; ip_uid: string | null; finding_text: string;
  in_gold: boolean; k5_count: number; cluster_size: number; gold_version: string; ord: number;
};

function Locked({ configured }: { configured: boolean }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">
      This queue is access-controlled.{' '}
      {configured
        ? <Link href="/admin/ipd-audit" className="text-brand hover:underline">Unlock the admin surface</Link>
        : <span>Set <code>ADMIN_TOKEN</code> to enable admin access.</span>} first.
    </div>
  );
}

// K=5 provenance dot-meter — how many of the five runs surfaced this concern. The load-bearing
// context for V: a 5/5 is a robust finding, a 0/5 gold theme is a candidate single-shot fluke.
function K5Meter({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`${n} of 5 K-runs surfaced this`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={`h-1.5 w-1.5 rounded-full ${i < n ? 'bg-brand' : 'bg-slate-200'}`} />
      ))}
      <span className="ml-1 text-[10.5px] tabular-nums text-slate-400">{n}/5</span>
    </span>
  );
}

export default async function IpdGoldQueue() {
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} />;

  const [cands, verdicts] = await Promise.all([
    sql(`SELECT id, case_id, ip_uid, finding_text, in_gold, k5_count, cluster_size, gold_version, ord
         FROM ipd_gold_union_candidates ORDER BY case_id, ord`) as unknown as Promise<Candidate[]>,
    // latest verdict per candidate (mirrors the surface's DISTINCT ON latest-wins read)
    sql(`SELECT DISTINCT ON (candidate_id) candidate_id, verdict
         FROM ipd_gold_adjudication ORDER BY candidate_id, created_at DESC`) as unknown as Promise<Array<{ candidate_id: string; verdict: string }>>,
  ]);

  if (!cands.length) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center text-sm text-slate-500">
        <p className="font-medium text-slate-700">The union queue is empty.</p>
        <p className="mt-2">Seed it with <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[12px]">node --env-file=.env.local --import tsx scripts/ipd-consensus-gold-harness.mjs --apply</code></p>
      </div>
    );
  }

  const verdictOf = Object.fromEntries(verdicts.map((v) => [v.candidate_id, v.verdict]));
  const goldVersion = cands[0].gold_version;
  const adjudicated = cands.filter((c) => verdictOf[c.id]).length;
  const pct = Math.round((adjudicated / cands.length) * 100);

  // group by case, preserving the ORDER BY case_id, ord
  const byCase = new Map<string, Candidate[]>();
  for (const c of cands) {
    if (!byCase.has(c.case_id)) byCase.set(c.case_id, []);
    byCase.get(c.case_id)!.push(c);
  }

  return (
    <div className="mx-auto max-w-4xl px-5 py-8">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-slate-800">Consensus gold — union adjudication</h1>
        <Link href="/admin/ipd-audit" className="text-[12px] text-slate-400 hover:text-brand">← IPD audit surface</Link>
      </div>
      <p className="text-[13px] text-slate-500">
        The <strong>{cands.length}</strong> deduped union candidates (gold themes ∪ K=5 findings) across{' '}
        <strong>{byCase.size}</strong> gold cases, built against <code className="text-[12px]">{goldVersion}</code>.
        Label each: it upgrades the gold to 2.0 (frozen later, after adjudication). De-identified — no PHI, no source URLs.
      </p>

      <div className="mt-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-[12px] tabular-nums text-slate-500">{adjudicated}/{cands.length} adjudicated ({pct}%)</span>
      </div>

      <div className="mt-6 space-y-7">
        {[...byCase.entries()].map(([caseId, items]) => (
          <section key={caseId}>
            <div className="mb-2 flex items-baseline gap-2 border-b border-slate-100 pb-1">
              <h2 className="text-[13px] font-semibold text-slate-700">{caseId}</h2>
              <span className="text-[11px] text-slate-400">{items[0].ip_uid ?? '—'}</span>
              <span className="ml-auto text-[11px] text-slate-400">
                {items.filter((c) => verdictOf[c.id]).length}/{items.length} done
              </span>
            </div>
            <ul className="space-y-3">
              {items.map((c) => (
                <li key={c.id} className="rounded-lg border border-slate-100 bg-white px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {c.in_gold
                      ? <span className="rounded-full border border-amber-300 bg-amber-50 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-amber-700" title="Was in the 1.1 gold">in gold</span>
                      : <span className="rounded-full border border-sky-300 bg-sky-50 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-sky-700" title="Not in the 1.1 gold — a candidate extra">extra</span>}
                    <span className="text-[13.5px] text-slate-800">{c.finding_text}</span>
                    {c.cluster_size > 1 && (
                      <span className="text-[10.5px] text-slate-400" title="Near-duplicate phrasings folded into this candidate">+{c.cluster_size - 1} phrasing{c.cluster_size - 1 === 1 ? '' : 's'}</span>
                    )}
                    <span className="ml-auto"><K5Meter n={c.k5_count} /></span>
                  </div>
                  <ConsensusTriage candidateId={c.id} caseId={c.case_id} initial={verdictOf[c.id] ?? null} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
