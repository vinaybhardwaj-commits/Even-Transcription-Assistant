export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { isCareUnlocked } from '@/lib/care-cookie';
import { sql } from '@/lib/db';
import { CCB_ENGINE_VERSION } from '@/lib/ccb-brief-core';
import { resolveMemberIdentities, type MemberIdentity } from '@/lib/ccb-search';
import { flaggedListSql, boundedRace, type Flagged } from '@/lib/ccb-worklist-core';
import PullMember from '@/components/care/PullMember';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** db13 identity is a label, not a dependency: a slow Metabase must not hold TTFB. */
const IDENTITY_TIMEOUT_MS = 3000;

const titleCase = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');
const clamp = (s: string | null, n = 130) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : (s || ''));

export default async function CareLanding() {
  if (process.env.CCB_ENABLED !== '1') notFound();
  if (!(await isCareUnlocked())) redirect('/care/login');

  // Members flagged for a conversation: one row per member (best-grounded flagged episode), with a
  // plain-language signal pulled from the stored brief (the cited surgical/specialist indication).
  const tNeon = Date.now();
  let rows: Flagged[] = [];
  try {
    rows = (await run(flaggedListSql(), [CCB_ENGINE_VERSION])) as Flagged[];
  } catch { rows = []; }
  const neon_ms = Date.now() - tNeon;

  // Identity is a display label. resolveMemberIdentities() already fail-safes to {} on error, but
  // it has no timeout — a stalled db13 read used to hold TTFB open indefinitely. Bound it.
  const tIdentity = Date.now();
  const identities = await boundedRace<Record<string, MemberIdentity>>(
    resolveMemberIdentities(rows.map((r) => r.individual_uid)),
    IDENTITY_TIMEOUT_MS,
    {},
  );
  const identity_ms = Date.now() - tIdentity;

  // Counts + milliseconds only — never member data. Grep `[ccb-briefs-timing]` in runtime logs.
  console.log('[ccb-briefs-timing]', JSON.stringify({
    neon_ms,
    identity_ms,
    rows: rows.length,
    identities: Object.keys(identities).length,
    deploy: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  }));

  return (
    <div className="mx-auto max-w-4xl px-5 py-8" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className="flex items-center gap-2">
        <h1 className="text-[20px] font-semibold text-slate-900">Care Conversation Brief</h1>
        <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] text-teal-700">Advisory · care management</span>
      </div>
      <p className="text-[12.5px] text-slate-500">Look up a member to prep a call, or work today’s flagged list.</p>

      <div className="mt-4"><PullMember /></div>

      <div className="mt-7 flex items-center justify-between">
        <h2 className="text-[12px] font-medium uppercase tracking-wide text-slate-400">Flagged for a conversation</h2>
        {rows.length > 0 && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800">{rows.length}</span>}
      </div>

      <div className="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-[13px] text-slate-400">No members flagged right now. Search a member above to open their record.</div>
        ) : (
          <ul>
            {rows.map((r) => {
              const id = identities[r.individual_uid];
              const meta = [id?.gender ? titleCase(id.gender)[0] : null, id?.age != null ? `${id.age}` : null].filter(Boolean).join('');
              return (
                <li key={r.individual_uid} className="border-t border-slate-100 first:border-t-0 hover:bg-slate-50">
                  <Link href={`/care/m/${encodeURIComponent(r.individual_uid)}`} className="flex items-center gap-3 px-3.5 py-3">
                    <div className="w-40 shrink-0">
                      <div className="text-[13.5px] font-medium text-slate-900">{id?.name || 'Member'}</div>
                      <div className="text-[11.5px] text-slate-400">{[meta || null, r.uhid].filter(Boolean).join(' · ') || '—'}</div>
                    </div>
                    <div className="min-w-0 flex-1 text-[12.5px] text-slate-700">
                      {clamp(r.signal) || <span className="text-slate-400">Flagged episode · {r.doctor_speciality || 'review'}</span>}
                    </div>
                    <div className="w-16 shrink-0 text-right text-[12.5px] text-slate-600">{r.citation_coverage_pct != null ? `${r.citation_coverage_pct}%` : '—'}</div>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="mt-2.5 text-[11.5px] text-slate-400">Advisory; not a clinician assessment. A member is flagged only on a corpus-cited surgical/specialist indication. “%” is the brief’s evidence-grounding.</p>
    </div>
  );
}
