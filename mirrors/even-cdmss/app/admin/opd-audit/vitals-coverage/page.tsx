// app/admin/opd-audit/vitals-coverage/page.tsx — U4-B C7, vitals coverage on GP visits
// (PRD CDMSS-U4B-C7-PRD-v2.0-2-AUG-2026, V ruled 2 Aug 2026).
//
// C7 IS A PANEL COUNT. NO ENGINE CHANGE. v1.0 specified a deterministic finding carrying
// `domain: 'documentation'`; that domain does not exist on a finding (`OpdFindingDomain` has two
// members and v1.0 confused it with the scorecard's `OpdDomain`). Rather than widen a scoring type
// inside a feature, V ruled the deliverable is the count and its trend — which is what the parent
// PRD asked for in the first place. Nothing here touches the engine, a finding or a score, and the
// diff makes that trivially checkable.
//
// FAIL-SAFE: the whole read is wrapped. A Metabase error renders an empty section with a note —
// this page never 500s, and never shows a partial count as if it were the whole window.
//
// ⚠️ SHELL CONVENTION, flagged (the same finding as app/admin/observability/engine-health/page.tsx
// and app/admin/scoring-policy/page.tsx): older PRDs mandate `AdminLayout` with a `breadcrumbs`
// prop. There is NO AdminLayout in this repository — every admin page is a plain server component
// gating on isAdminUnlocked() with its own header + back-link. This page follows the repo's actual
// convention.
import Link from 'next/link';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { metabaseQuery } from '@/lib/metabase';
import {
  VITALS_SOURCE_START, WINDOW_DAYS, coverageWindow, buildVitalsCoverageSql, shapeCoverage, istDay,
  type CoverageReport, type CoverageWindow,
} from '@/lib/vitals-coverage-core';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Vitals coverage · OPD Audit' };

const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });

export default async function VitalsCoveragePage() {
  if (!(await isAdminUnlocked())) {
    return (
      <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">
        Access-controlled. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock the admin console</Link> first.
      </div>
    );
  }

  const win: CoverageWindow | null = coverageWindow(istDay(new Date()), WINDOW_DAYS);
  let report: CoverageReport | null = null;
  let error: string | null = null;

  if (!win) {
    error = 'The reporting window could not be computed.';
  } else {
    try {
      const rows = await metabaseQuery(buildVitalsCoverageSql(win.start, win.end));
      report = shapeCoverage(rows, win);
    } catch (e) {
      // Soft-fail (§4): degrade to an empty section. Never a 500, never a partial number.
      error = (e as Error).message.slice(0, 300);
    }
  }

  return (
    <div>
      <Link href="/admin/opd-audit" className="text-sm text-brand hover:underline">← OPD Audit</Link>

      <div className="mt-3">
        <h1 className="font-serif text-[26px] font-semibold leading-tight text-slate-900 sm:text-[30px]">Vitals coverage</h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-slate-500">
          How often an <b className="text-slate-700">in-hospital GP visit</b> has no vitals record captured against the
          consultation — no blood pressure, pulse, temperature or SpO<sub>2</sub> filed for that visit at all.
          {' '}<b className="text-slate-700">This is an observation about records, not a judgement about a doctor.</b>
          {' '}Vitals are usually recorded by a nurse before the consultation, so a gap here can mean the measurement
          was never taken, or was taken and filed somewhere this system cannot see. Nothing on this page affects any
          score, band or finding.
        </p>
      </div>

      {/* Scope + provenance — stated before any number, so a reader cannot take the figure for more than it is. */}
      <section className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-slate-500">What is counted</h2>
        <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-slate-600">
          <li>
            <b className="text-slate-700">In-hospital GP visits only.</b> Teleconsults are excluded — a remote
            consultation has no one present to take a measurement. Paediatrics, the gynaecology templates and allied
            health are excluded too: each has a different vitals expectation, and none of them has been measured.
          </li>
          <li>
            <b className="text-slate-700">The vitals source begins {fmtDay(VITALS_SOURCE_START)} 2026.</b> Earlier
            dates are not shown. Before that date the records simply do not exist, so every visit would read as a gap —
            that is a data-availability artefact, and showing it as a documentation gap would be false.
          </li>
          <li>
            <b className="text-slate-700">A visit counts as covered if any vitals record exists</b> for its
            consultation, even when individual measurements within it are blank. &ldquo;No record at all&rdquo; and
            &ldquo;a record with an empty field&rdquo; are different things, and only the first is counted here.
          </li>
          <li>
            <b className="text-slate-700">A visit with no consultation ID is excluded from the share.</b> Vitals are
            matched to a visit by that ID, so without one the system cannot tell whether vitals were taken — that is
            not evidence of a gap, and not evidence of coverage. Those visits are counted and shown separately rather
            than being folded into either side.
          </li>
          <li>The most recent day is still in progress, so its counts will rise during the day.</li>
        </ul>
      </section>

      {error || !win || !report ? (
        <section className="mt-6">
          <p className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            Coverage could not be read{error ? ` (${error})` : ''} — no figures are shown rather than partial ones.
            Nothing else on this page depends on it; reload to retry.
          </p>
        </section>
      ) : (
        <>
          {/* ── Headline ── */}
          <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-serif text-[34px] font-semibold leading-none text-slate-900">{report.pct}%</span>
              <span className="text-sm text-slate-600">
                of in-hospital GP visits had no vitals record
              </span>
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              {report.totalNoVitals.toLocaleString('en-IN')} of {report.answerable.toLocaleString('en-IN')} visits,
              {' '}{fmtDay(win.start)} to {fmtDay(win.lastDay)} ({win.days} {win.days === 1 ? 'day' : 'days'}).
              {report.totalNoConsultId > 0 && (
                <>
                  {' '}A further <b className="text-slate-700">{report.totalNoConsultId.toLocaleString('en-IN')} visit
                  {report.totalNoConsultId === 1 ? '' : 's'} carried no consultation ID</b> and {report.totalNoConsultId === 1 ? 'is' : 'are'} not
                  counted either way, so the {report.totalGpNotes.toLocaleString('en-IN')} visits in the window
                  become {report.answerable.toLocaleString('en-IN')} we can answer for.
                </>
              )}
              {win.clamped && (
                <>
                  {' '}<b className="text-amber-700">Window shortened:</b> the last {WINDOW_DAYS} days would reach
                  before {fmtDay(VITALS_SOURCE_START)} 2026, when the vitals source begins, so it starts there instead.
                </>
              )}
            </p>
          </section>

          {/* ── Daily table ── */}
          <section className="mt-6">
            <h2 className="text-sm font-semibold text-slate-900">By day</h2>
            {report.days.length === 0 ? (
              <p className="mt-2 text-xs text-slate-400">No in-hospital GP visits in this window.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-400">
                      <th className="py-1.5 pr-3 font-medium">Date</th>
                      <th className="py-1.5 pr-3 text-right font-medium">GP visits</th>
                      <th className="py-1.5 pr-3 text-right font-medium">No consultation ID</th>
                      <th className="py-1.5 pr-3 text-right font-medium">No vitals record</th>
                      <th className="py-1.5 text-right font-medium">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.days.map((d) => (
                      <tr key={d.date} className="border-b border-slate-100">
                        <td className="py-1.5 pr-3 whitespace-nowrap font-medium text-slate-700">{fmtDay(d.date)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">{d.gpNotes.toLocaleString('en-IN')}</td>
                        <td className={`py-1.5 pr-3 text-right tabular-nums ${d.noConsultId > 0 ? 'text-amber-700' : 'text-slate-300'}`}>{d.noConsultId.toLocaleString('en-IN')}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-slate-700">{d.noVitals.toLocaleString('en-IN')}</td>
                        <td className="py-1.5 text-right tabular-nums text-slate-500">{d.pct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
