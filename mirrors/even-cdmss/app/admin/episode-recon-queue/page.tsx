// /admin/episode-recon-queue — EpisodeState (#4) SL5: the reconstruction-fidelity rating queue.
//
// Side-by-side per sampled admission: the SOURCE documented course (the discharge PDF, shown
// READ-TIME, admin-gated — PHI stays on the surface, never in the bench) beside the ASSEMBLED
// EpisodeState (the persisted v0.2 phased facts + provenance, reusing the report's EpisodeCourse).
// V rates each phase (pre / intra / post): faithful / missed-material-fact / mis-phased /
// over-included. READ-ONLY on EpisodeState (reads the persisted object; never re-builds). The
// ratings land in the dedicated episode_recon_ratings store. Measures builder fidelity —
// completeness + phase-correctness — NOT fabrication (mkFact already guarantees that), and NOT the
// audit's recall/precision.
import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fetchIpdDoc } from '@/lib/ipd-audit/db13';
import type { EpisodeState } from '@/lib/episode-state/schema';
import { EPISODE_STATE_VERSION } from '@/lib/episode-state/schema';
import EpisodeCourse from '../ipd-audit/[id]/episode-course';
import ReconTriage from './recon-triage';

export const dynamic = 'force-dynamic';

const pdfSrc = (u: string) => `${u}#toolbar=0&navpanes=0&view=FitH`;
const PHASES: Array<{ key: string; label: string }> = [
  { key: 'pre', label: 'Pre-admission' }, { key: 'intra', label: 'In-hospital' }, { key: 'post', label: 'Post-discharge' },
];

function Locked({ configured }: { configured: boolean }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">
      This bench is access-controlled.{' '}
      {configured ? <Link href="/admin/ipd-audit" className="text-brand hover:underline">Unlock the admin surface</Link>
        : <span>Set <code>ADMIN_TOKEN</code> to enable admin access.</span>} first.
    </div>
  );
}

export default async function EpisodeReconQueue() {
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} />;

  const [eps, ratings] = await Promise.all([
    sql(`SELECT document_id, ip_uid, state FROM episode_states WHERE version = $1 ORDER BY ip_uid`, [EPISODE_STATE_VERSION]) as unknown as Promise<Array<{ document_id: string; ip_uid: string | null; state: unknown }>>,
    sql(`SELECT DISTINCT ON (document_id, phase) document_id, phase, verdict
         FROM episode_recon_ratings WHERE fact_ref IS NULL ORDER BY document_id, phase, created_at DESC`) as unknown as Promise<Array<{ document_id: string; phase: string; verdict: string }>>,
  ]);

  if (!eps.length) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center text-sm text-slate-500">
        <p className="font-medium text-slate-700">The reconstruction-fidelity queue is empty.</p>
        <p className="mt-2">Populate it with <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[12px]">node --env-file=.env.local --import tsx scripts/episode-recon-sample.mjs</code></p>
      </div>
    );
  }

  const cases = eps.map((e) => ({
    documentId: e.document_id, ipUid: e.ip_uid,
    state: (typeof e.state === 'string' ? JSON.parse(e.state) : e.state) as EpisodeState,
  }));
  const docs = await Promise.all(cases.map((c) => fetchIpdDoc(c.documentId).catch(() => null)));
  const ratingOf = Object.fromEntries(ratings.map((r) => [`${r.document_id}|${r.phase}`, r.verdict]));

  const totalPhases = cases.length * PHASES.length;
  const ratedPhases = cases.reduce((n, c) => n + PHASES.filter((p) => ratingOf[`${c.documentId}|${p.key}`]).length, 0);
  const pct = Math.round((ratedPhases / totalPhases) * 100);
  const linkedCount = cases.filter((c) => c.state.pre.priorConditions.length || c.state.pre.homeMedications.length || c.state.post.followUpPlan.length).length;

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <div className="mb-1 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-slate-800">EpisodeState — reconstruction-fidelity bench</h1>
        <Link href="/admin/ipd-audit" className="text-[12px] text-slate-400 hover:text-brand">← IPD audit surface</Link>
      </div>
      <p className="text-[13px] text-slate-500">
        <strong>{cases.length}</strong> sampled admissions ({linkedCount} OPD-linked · {cases.length - linkedCount} intra-only), built at <code className="text-[12px]">{EPISODE_STATE_VERSION}</code>.
        For each, rate whether the assembled phases faithfully represent the source discharge summary — <strong>completeness</strong> (did it miss a material fact) and <strong>phase-correctness</strong>. Builder fidelity only — not the audit’s score.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} /></div>
        <span className="text-[12px] tabular-nums text-slate-500">{ratedPhases}/{totalPhases} phases rated ({pct}%)</span>
      </div>

      <div className="mt-6 space-y-8">
        {cases.map((c, i) => {
          const doc = docs[i];
          const spec = c.state.intra.admission.speciality?.value ?? '—';
          return (
            <section key={c.documentId} className="rounded-2xl border border-slate-200 bg-white p-3">
              <div className="mb-2 flex items-baseline gap-2 border-b border-slate-100 pb-1.5">
                <h2 className="text-[13px] font-semibold text-slate-700">{c.ipUid ?? c.documentId}</h2>
                <span className="text-[11px] text-slate-400">{spec}</span>
                <Link href={`/admin/ipd-audit`} className="ml-auto text-[10.5px] text-slate-300">recon case</Link>
              </div>
              <div className="flex flex-col gap-3 lg:flex-row">
                {/* SOURCE — the discharge PDF, read-time (PHI stays here, never in the bench) */}
                <div className="flex-1 overflow-hidden rounded-xl border border-slate-200 bg-[#525659] lg:sticky lg:top-4 lg:self-start">
                  {doc?.pdfUrl
                    ? <iframe src={pdfSrc(doc.pdfUrl)} title={`source ${c.ipUid}`} loading="lazy" className="block aspect-[210/297] w-full" />
                    : <div className="flex aspect-[210/297] items-center justify-center p-6 text-[12.5px] text-slate-300">Source PDF unavailable (read-time).</div>}
                </div>
                {/* ASSEMBLED — the persisted EpisodeState (read-only) */}
                <div className="flex-1">
                  <EpisodeCourse state={c.state} />
                </div>
              </div>
              {/* phase-level ratings */}
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {PHASES.map((p) => (
                  <div key={p.key} className="rounded-lg border border-slate-100 bg-slate-50/50 px-2.5 py-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-slate-500">{p.label}</div>
                    <ReconTriage documentId={c.documentId} ipUid={c.ipUid} version={EPISODE_STATE_VERSION}
                      phase={p.key} initial={ratingOf[`${c.documentId}|${p.key}`] ?? null} />
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
