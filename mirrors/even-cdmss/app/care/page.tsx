export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { ArrowRight, ClipboardCheck, ListChecks, Layers, Repeat } from 'lucide-react';
import { isCareUnlocked } from '@/lib/care-cookie';
import { sql } from '@/lib/db';
import { reviewCountForChooser } from '@/lib/readmission/store';
import { OPD_ENGINE_VERSIONS_CURRENT } from '@/lib/opd-note-audit-core';
import { getSettings } from '@/lib/mini-backfill';
import { parseGoal, computeReviewStats, FALLBACK_ROSTER, type LabelRow } from '@/lib/review-stats-core';
import EscalationsToday from '@/components/care/EscalationsToday';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';

/**
 * Managed Care — the chooser home for the /care surface (PRD §4). Two purpose-built sub-modules
 * that share the care-manager auth + CAT shell. The member-centric Care Conversation Briefs card
 * was retired 30 Jul 2026 (see Phase 1.1) — its route stays reachable and its mechanics are
 * preserved for the Patient Summary API. Doctor-centric OPD Audit Triage is unchanged.
 */
export default async function ManagedCareHome() {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');

  // Live "needs attention" counts (best-effort; each independently soft-fails to null).
  // The ccb_briefs count query was REMOVED 30 Jul 2026 with the card: it was a live PHI read
  // running on every page load for a retired surface.
  const [triageR] = await Promise.all([
    run(`SELECT count(DISTINCT doctor_uid)::int n FROM opd_note_audits
         WHERE app_source = $1 AND engine_version = ANY($2) AND excluded_reason IS NULL
           AND (note_date AT TIME ZONE 'Asia/Kolkata')::date =
               (SELECT max((note_date AT TIME ZONE 'Asia/Kolkata')::date) FROM opd_note_audits WHERE app_source = $1 AND engine_version = ANY($2) AND excluded_reason IS NULL)`,
      [APP, [...OPD_ENGINE_VERSIONS_CURRENT]]).catch(() => []),
  ]);
  const triageCount = Number((triageR as Record<string, unknown>[])[0]?.n ?? 0);

  // Low-value patterns (LVP-L1 kickoff, 20 Aug 2026) — the ONE shelf that destined both LVC rooms
  // (Concept coder + Even Adjudicated LVC cards removed per §4.1; /care/concepts stays reachable
  // by direct URL, /care/lvc redirects). Behind LVC_PATTERNS_ENABLED (O2 — a NEW flag). NEVER a
  // count badge (a count would read as a queue; the shelf is not a queue), so no DB read here.
  const lvpEnabled = process.env.LVC_PATTERNS_ENABLED === '1';

  // Readmissions (CDMSS-READMISSION-PHASE-2-CARE-SURFACE-PRD §3) — 5th card, behind
  // READMISSIONS_SURFACE_ENABLED (ships OFF). Badge = findings needing review, which is
  // the SAME predicate the page's own count uses (lib/readmission/store.ts) so the badge
  // and the page can never disagree. Best-effort: soft-fails to 0 like its peers.
  const readmissionsEnabled = process.env.READMISSIONS_SURFACE_ENABLED === '1';
  const readmissionCount = readmissionsEnabled ? await reviewCountForChooser().catch(() => 0) : 0;

  // Review Mode team-progress strip (§2.4) — best-effort; omitted entirely on any error. Reuses the
  // gamification core over the same counted-label rows the stats route reads (identical basis).
  let reviewStrip: string | null = null;
  try {
    const s = await getSettings(['review_goal', 'review_roster']).catch(() => ({} as Record<string, string>));
    const goal = parseGoal(s.review_goal);
    let roster: string[] = FALLBACK_ROSTER;
    try { const j = JSON.parse(s.review_roster || ''); if (Array.isArray(j)) { const l = j.map((x) => String(x).trim()).filter(Boolean); if (l.length) roster = l; } } catch { /* fallback */ }
    // study-filter-exempt (D12): the team-goal page reads UNFILTERED by design — study labels are
    // counted work; this read and review-stats share one basis and must agree.
    const rows = (await run(
      `SELECT author, scope, audit_id::text AS audit_id, finding_ref, verdict,
              to_char((created_at AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS day
       FROM opd_audit_feedback
       WHERE app_source = $1 AND scope IN ('finding','missed') AND author = ANY($2) AND author IS NOT NULL
       ORDER BY created_at ASC`, [APP, roster]).catch(() => [])) as Array<Record<string, unknown>>;
    const labelRows: LabelRow[] = rows.map((r) => ({
      author: String(r.author), scope: String(r.scope), audit_id: r.audit_id == null ? '' : String(r.audit_id),
      finding_ref: r.finding_ref == null ? null : String(r.finding_ref), verdict: r.verdict == null ? null : String(r.verdict), day: String(r.day || ''),
    }));
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const st = computeReviewStats({ rows: labelRows, roster, today, goal });
    reviewStrip = `${goal.label}: ${st.team.total}/${goal.target} · this week ${st.team.week}/${goal.weekly_target}`;
  } catch { reviewStrip = null; }

  // Care Conversation Briefs card REMOVED 30 Jul 2026 (CCB retirement, Phase 1.1). The surface is
  // retired — non-use, not malfunction — and its mechanics are preserved for the Patient Summary
  // API. `/care/briefs` stays REACHABLE by direct URL (V's decision); it is only off the chooser.
  const cards = [
    {
      href: '/care/triage',
      icon: ClipboardCheck,
      title: 'OPD Audit Triage',
      desc: 'Clear last night’s audit signals doctor-by-doctor: kill the noise, decide what matters, route the real ones. Doctor-centric.',
      count: triageCount, countLabel: 'doctors audited', tint: 'sky',
    },
    {
      href: '/care/review',
      icon: ListChecks,
      title: 'Review Mode',
      desc: 'Keyboard-first gold-label triage — adjudicate audit findings fast to build the reviewed standard. Pick your reviewer identity to start.',
      count: 0, countLabel: '', tint: 'emerald',
    },
    ...(lvpEnabled ? [{
      href: '/care/patterns',
      icon: Layers,
      title: 'Low-value patterns',
      desc: 'What the operator is suggesting, and what you’ve hidden. Not a queue. Nothing here can be routed.',
      count: 0, countLabel: '', tint: 'amber',
    }] : []),
    ...(readmissionsEnabled ? [{
      href: '/care/readmissions',
      icon: Repeat,
      title: 'Readmissions',
      desc: 'Find the unplanned readmissions that did not need to happen — a premature discharge, an admission that missed the threshold. Patient-centric.',
      count: readmissionCount, countLabel: 'to review', tint: 'rose',
    }] : []),
  ];

  const tintClasses: Record<string, { badge: string; icon: string }> = {
    violet: { badge: 'bg-violet-100 text-violet-800', icon: 'text-violet-500' },
    sky: { badge: 'bg-sky-100 text-sky-800', icon: 'text-sky-500' },
    emerald: { badge: 'bg-emerald-100 text-emerald-800', icon: 'text-emerald-500' },
    amber: { badge: 'bg-amber-100 text-amber-800', icon: 'text-amber-500' },
    rose: { badge: 'bg-rose-100 text-rose-800', icon: 'text-rose-500' },
    slate: { badge: 'bg-slate-100 text-slate-700', icon: 'text-slate-500' },
  };

  return (
    <div className="mx-auto max-w-3xl px-5 py-8" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className="flex items-center gap-2">
        <h1 className="text-[20px] font-semibold text-slate-900">Managed Care</h1>
        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] text-teal-700">Advisory · care management</span>
      </div>
      <p className="mt-0.5 text-[12.5px] text-slate-500">Last night’s notes. Kill the noise, route the real ones.</p>

      <div className="mt-5 grid gap-3.5 sm:grid-cols-2">
        {cards.map((c) => {
          const Icon = c.icon;
          const t = tintClasses[c.tint];
          return (
            <Link key={c.href} href={c.href}
              className="group flex flex-col rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-sm">
              <div className="flex items-center justify-between">
                <Icon className={`h-5 w-5 ${t.icon}`} />
                {c.count > 0 && (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${t.badge}`}>
                    {c.count} {c.countLabel}
                  </span>
                )}
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-[15px] font-semibold text-slate-900">
                {c.title}
                <ArrowRight className="h-3.5 w-3.5 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" />
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-slate-500">{c.desc}</p>
              {c.href === '/care/review' && reviewStrip && (
                <p className="mt-1 text-[11.5px] font-medium text-emerald-700">{reviewStrip}</p>
              )}
            </Link>
          );
        })}
      </div>

      {/* Care-Call escalations (DARK behind CARE_CALL_ENABLED; the card self-gates + soft-fails). */}
      <EscalationsToday />

      {process.env.CONCORDANCE_ENABLED === '1' && (
        <Link href="/concordance"
          className="mt-3.5 flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4 text-[13px] text-slate-600 transition hover:border-slate-300 hover:shadow-sm">
          <span className="font-semibold text-slate-900">Concordance</span>
          <span className="text-slate-400">— sanity-check a member's lab result before a call.</span>
          <ArrowRight className="ml-auto h-3.5 w-3.5 text-slate-300" />
        </Link>
      )}

      <p className="mt-5 text-[11.5px] text-slate-400">
        Was two rooms: Concept coder + Even Adjudicated LVC. Now one shelf. The work stays in Triage.
      </p>
      <p className="mt-1.5 text-[11.5px] text-slate-400">
        Advisory throughout — never a clinician score. Audit signals are a high-sensitivity screen; nothing reaches a doctor until a care manager validates and routes it.
      </p>
    </div>
  );
}
