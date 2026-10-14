// Shared server-safe chrome for the IPD Discharge Audit surface (S3): the unlock wall,
// the sub-tab row, the uncertainty-marked band chip, small formatters. No 'use client' —
// everything here renders on the server.
import Link from 'next/link';
import { bandColor } from '@/lib/opd-audit-ui';

/**
 * The HONEST band chip (S4 decision, option b): a single-run band is one noisy draw —
 * S4 measured ±1-band noise (1/25 band-stable at K=5) — so every per-row band carries an
 * explicit "±1 · provisional" marker. When a row someday has K runs (S5/S6), pass `range`
 * (e.g. "B–C") and the marker shows the observed range instead.
 */
export function BandChip({ band, cvi, range }: { band: string; cvi: number; range?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1" title={range ? `observed band range ${range} across repeats` : 'single-run estimate; ±1 band noise (S4-measured)'}>
      <span className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ background: bandColor(band) }}>{band} · {cvi}</span>
      <span className="text-[9.5px] font-medium text-slate-400">{range ? range : '±1 · provisional'}</span>
    </span>
  );
}

// ── Phase B — review + filter chrome (PRD §6.1, §6.2, §6.4) ─────────────────────────────────────

/** The Reviewed marker (§6.4). Existence of a kind='review' row IS the marker; the reviewer's name
 *  is on hover, so the chip stays quiet in a dense table. */
export function ReviewedChip({ by, at }: { by?: string | null; at?: string | null }) {
  const who = by || 'a reviewer';
  const when = at ? ` on ${String(at).slice(0, 10)}` : '';
  return (
    <span
      title={`Reviewed by ${who}${when}`}
      className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-700"
    >
      Reviewed
    </span>
  );
}

/** The single non-blocking notice when db13 cannot be reached (§6.3 fail-soft). Never blocks. */
export function DoctorUnavailableNotice() {
  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
      Doctor names are temporarily unavailable. Every other column is unaffected.
    </div>
  );
}

/**
 * The filter bar: speciality · date range · reviewed · group-by-doctor. Server-rendered as plain
 * links (GET), so it works with JS off and every filter state is a shareable URL — the same posture
 * as the day/period switcher already on this surface.
 */
export function IpdFilterBar({ basePath, sp, specialities }: {
  basePath: string;
  sp: Record<string, string | undefined>;
  specialities: { speciality: string; n: number }[];
}) {
  const q = (patch: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = { ...sp, ...patch };
    const parts = Object.entries(merged)
      .filter(([, v]) => v != null && v !== '' && v !== 'all')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    return parts.length ? `${basePath}?${parts.join('&')}` : basePath;
  };
  const pill = (href: string, active: boolean, label: string) => (
    <Link key={label} href={href} className={`rounded-md px-2 py-1 text-[11.5px] font-medium ${active ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{label}</Link>
  );
  const range = sp.range || 'last_3_months';
  const reviewed = sp.reviewed || 'all';
  const spec = sp.speciality || 'all';

  return (
    <div className="mt-4 space-y-2 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Discharged</span>
        <span className="flex overflow-hidden rounded-lg border border-slate-200">
          {([['this_month', 'This month'], ['last_month', 'Last month'], ['last_3_months', 'Last 3 months']] as const)
            .map(([k, label]) => pill(q({ range: k }), range === k, label))}
        </span>

        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Reviewed</span>
        <span className="flex overflow-hidden rounded-lg border border-slate-200">
          {([['all', 'All'], ['reviewed', 'Reviewed'], ['not_reviewed', 'Not reviewed']] as const)
            .map(([k, label]) => pill(q({ reviewed: k }), reviewed === k, label))}
        </span>

        <Link
          href={q({ group: sp.group === 'doctor' ? undefined : 'doctor' })}
          className={`rounded-lg border px-2.5 py-1 text-[11.5px] font-semibold ${sp.group === 'doctor' ? 'border-brand bg-brand text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
        >
          Group by doctor
        </Link>
      </div>

      {/* Speciality — raw db13 values, count desc, NO normalisation in v1 (§6.1). */}
      {specialities.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Speciality</span>
          {pill(q({ speciality: undefined }), spec === 'all', 'All')}
          {specialities.map((s) => pill(q({ speciality: s.speciality }), spec === s.speciality, `${s.speciality} · ${s.n}`))}
        </div>
      )}
    </div>
  );
}

/** The admin unlock wall (mirrors the OPD-audit inline Locked idiom). */
export function Locked({ configured, bad }: { configured: boolean; bad?: boolean }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">IPD Discharge Audit</h1>
      <p className="mt-2 text-sm text-slate-500">
        {configured ? 'This surface is access-controlled. Enter the admin token to continue.' : 'ADMIN_TOKEN is not configured on this deployment.'}
      </p>
      {bad && <p className="mt-2 text-xs text-red-600">That token didn’t match — try again.</p>}
      {configured && (
        <form method="POST" action="/api/admin/unlock" className="mt-5 flex justify-center gap-2">
          <input type="hidden" name="next" value="/admin/ipd-audit" />
          <input name="token" type="password" placeholder="Admin token" className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white">Unlock</button>
        </form>
      )}
    </div>
  );
}

/** Sub-tab row: Overview · Search · Calendar. */
export function IpdTabs({ active }: { active: 'overview' | 'search' | 'calendar' }) {
  const tab = (href: string, key: string, label: string) => (
    <Link href={href} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${active === key ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200'}`}>{label}</Link>
  );
  return (
    <div className="mt-4 flex items-center gap-2">
      {tab('/admin/ipd-audit', 'overview', 'Overview')}
      {tab('/admin/ipd-audit/search', 'search', 'Search')}
      {tab('/admin/ipd-audit/calendar', 'calendar', 'Calendar')}
    </div>
  );
}

/** The 7-stage pipeline strip — LVC is stage 3 and runs on EVERY summary by construction. */
export const PIPELINE_STAGES = [
  { n: 1, label: 'Fetch PDF', note: 'GCS, service account' },
  { n: 2, label: 'Extract', note: 'de-identified read' },
  { n: 3, label: 'Low-Value Care', note: 'every summary, intrinsic' },
  { n: 4, label: 'Idealised course', note: 'diff vs actual' },
  { n: 5, label: 'Care-Value score', note: 'deterministic, 6 domains' },
  { n: 6, label: 'Billing envelope', note: 'db13 join · coarse recon' },
  { n: 7, label: 'Persist', note: 'de-identified + link-back keys' },
] as const;

export function PipelineStrip() {
  return (
    <div className="mt-4 overflow-x-auto">
      <div className="flex min-w-[720px] items-stretch gap-1.5">
        {PIPELINE_STAGES.map((s) => (
          <div key={s.n} className={`flex-1 rounded-lg border px-2.5 py-2 ${s.n === 3 ? 'border-brand/40 bg-brand/5' : 'border-slate-200 bg-white'}`}>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Stage {s.n}</div>
            <div className={`text-[12.5px] font-semibold ${s.n === 3 ? 'text-brand' : 'text-slate-800'}`}>{s.label}</div>
            <div className="text-[10.5px] text-slate-500">{s.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
