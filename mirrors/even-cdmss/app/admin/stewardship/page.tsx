/**
 * /admin/stewardship — the internal medical-superintendent room
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, S2; spec §3, §4, §12.2).
 *
 * WHAT CHANGED, AND WHAT DID NOT. The 90-day OPD numbers are the same numbers this page has always
 * shown, on the same canonical one-row-per-note basis — the SQL moved into lib/stewardship-board.ts
 * (composed from the one fragment in lib/stewardship-canonical.ts) so that the board and the Ask box
 * beside it cannot answer the same question two ways. Nothing about how a note is scored changed;
 * no engine moved; this page still writes nothing.
 *
 * WHAT IS NEW is what the room is FOR. Three board columns — open dangerous, OPD Avg NQI, IPD — a
 * danger queue, and named clinicians as the default view. The old copy said this was "not a
 * standalone clinician score". On this page, for this audience, that clause is gone (acceptance #3):
 * V's ruling is that NABH B3 still binds the INSTRUMENT and does not veto an internal MS
 * adjudication room. The honesty line now says the true thing instead — internal, named, never shown
 * to the reviewed clinician or to any patient, advisory rule and model output rather than a
 * disciplinary conclusion.
 *
 * THREE COLUMNS, NEVER A COMPOSITE (D-no-composite). The sort is lexicographic — open dangerous
 * desc, then Avg NQI ascending, then IPD — and lives in one pure function that cannot become a
 * weighting by accident. The IPD cell reads `IPD unjoined` on every row this ship: A1 joins the
 * inpatient side through a practitioner id in S3, and until that lands an inpatient number attached
 * to a named clinician would be a claim nobody has measured.
 *
 * ⚠️ INFERRED SQL: every query behind this page lives in lib/stewardship-board.ts and is listed
 * verbatim in the S2 slice report. Every section is fail-safe — a failed read degrades to empty with
 * a visible note, never a 500.
 */
import { Suspense } from 'react';
import Link from 'next/link';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fetchLvcCells, readRightCareExclusions, fetchRightCareCoverage } from '@/lib/opd-audit-doctor';
import { computeDoctorOE, FUNNEL_MIN_N, type DoctorOE } from '@/lib/opd-funnel-core';
import {
  fetchBoardTotals, fetchDangerQueue, fetchDeptBoard, fetchDoctorBoard, fetchIpdSlice,
  BOARD_WINDOW_DAYS, type BoardDeptRow, type BoardDoctorRow, type DangerRow,
} from '@/lib/stewardship-board';
import { hopCoverageLine } from '@/lib/ipd-doctor-hop';
import OpsSection, { OpsSectionFallback } from './ops-section';
import { currentStandings } from '@/lib/physician-standing-store';
import { STANDING_ADVISORY, STANDING_HELP, STANDING_LABEL, type PhysicianStanding } from '@/lib/physician-standing-core';
import {
  DANGER_QUEUE_UNIT, IPD_SPLIT_BANNER, IPD_UNJOINED_CELL, STEWARDSHIP_HONESTY,
} from '@/lib/stewardship-danger-core';
import { PhysicianAskPanel } from './stewardship-ask-panel';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Stewardship · Admin · CAT' };

function scoreClass(v: number): string {
  if (v >= 80) return 'text-emerald-700';
  if (v >= 60) return 'text-amber-600';
  return 'text-red-600';
}
function riskClass(pct: number): string {
  if (pct >= 40) return 'text-red-600 font-medium';
  if (pct >= 20) return 'text-amber-600';
  return 'text-slate-600';
}

function Locked() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">Stewardship</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock an admin surface</Link> first.</p>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 font-serif text-[24px] font-semibold text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-slate-500">{sub}</div>}
    </div>
  );
}

/** The three board columns, in sort order, followed by the drill context the page already showed.
 *  The context cells are NOT rank columns and nothing sorts on them (D-no-composite). */
function BoardCells({ r }: { r: BoardDoctorRow | BoardDeptRow }) {
  return (
    <>
      <td className="px-3 py-2.5 text-right">
        <span className={r.openDangerous > 0 ? 'font-semibold text-red-600' : 'text-slate-400'}>{r.openDangerous}</span>
        {r.confirmedDangerous > 0 && (
          <span className="ml-1 text-[10.5px] text-slate-400" title="confirmed by a reviewer — not counted as open">+{r.confirmedDangerous} conf.</span>
        )}
      </td>
      <td className={`px-3 py-2.5 text-right font-medium ${scoreClass(r.avgNqi)}`}>{r.avgNqi}</td>
      <td className="px-3 py-2.5 text-right" title={r.ipdCvi == null ? IPD_SPLIT_BANNER : `mean CVI over ${r.ipdStays} stay(s) the practitioner-id hop resolved to this clinician`}>
        {r.ipdCvi == null
          ? <span className="text-[11px] text-slate-400">{IPD_UNJOINED_CELL}</span>
          : <><span className={`font-medium ${scoreClass(r.ipdCvi)}`}>{r.ipdCvi}</span><span className="ml-1 text-[10.5px] text-slate-400">n={r.ipdStays}</span></>}
      </td>
      <td className="px-3 py-2.5 text-right text-slate-600">{r.nNotes.toLocaleString()}</td>
      <td className="px-3 py-2.5 text-right text-slate-600">{r.pctAb}%</td>
      <td className={`px-3 py-2.5 text-right ${scoreClass(r.avgAppr)}`}>{r.avgAppr}</td>
      <td className={`px-3 py-2.5 text-right ${scoreClass(r.avgPresc)}`}>{r.avgPresc}</td>
      <td className={`px-3 py-2.5 text-right ${scoreClass(r.avgComplete)}`}>{r.avgComplete}%</td>
      <td className={`px-3 py-2.5 text-right ${riskClass(r.pctLow)}`}>{r.pctLow}%</td>
      <td className={`px-3 py-2.5 text-right ${r.sumInteractions > 0 ? 'text-amber-600' : 'text-slate-400'}`}>{r.sumInteractions}</td>
    </>
  );
}

const BOARD_HEADERS = (
  <>
    <th className="px-3 py-2.5 text-right font-medium" title="tier-1 escalations and unresolved contested findings, still open">Open dangerous</th>
    <th className="px-3 py-2.5 text-right font-medium">Avg NQI</th>
    <th className="px-3 py-2.5 text-right font-medium" title={IPD_SPLIT_BANNER}>IPD</th>
    <th className="px-3 py-2.5 text-right font-medium">Notes</th>
    <th className="px-3 py-2.5 text-right font-medium">% A–B</th>
    <th className="px-3 py-2.5 text-right font-medium">Appropriate&shy;ness</th>
    <th className="px-3 py-2.5 text-right font-medium">Prescribing safety</th>
    <th className="px-3 py-2.5 text-right font-medium">Complete&shy;ness</th>
    <th className="px-3 py-2.5 text-right font-medium">Low-value %</th>
    <th className="px-3 py-2.5 text-right font-medium">Interaction alerts</th>
  </>
);

/**
 * S4 — the MS standing chip. §6.3: show BOTH the stored numbers and the human judgement, and the
 * human wins the CHIP. It wins nothing else: it is not in the sort, not in any mean, and the scores
 * beside it are exactly what they were before the conversation that produced it.
 */
const STANDING_TONE: Record<PhysicianStanding, string> = {
  standing: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  concern: 'border-amber-200 bg-amber-50 text-amber-900',
  'restricted-review': 'border-red-200 bg-red-50 text-red-800',
  insufficient: 'border-slate-200 bg-slate-50 text-slate-600',
};

function StandingChip({ s }: { s: { standing: PhysicianStanding; quote: string; at: string | null } | undefined }) {
  if (!s) return <span className="text-[11px] text-slate-300" title="no medical superintendent has recorded a standing">—</span>;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${STANDING_TONE[s.standing]}`}
      title={`${STANDING_HELP[s.standing]}${s.quote ? ` — “${s.quote}”` : ''}${s.at ? ` (${s.at.slice(0, 10)})` : ''}`}
    >{STANDING_LABEL[s.standing]}</span>
  );
}

/** One danger row. Opening it stays inside /admin/* — the OPD note case or the IPD stay case. */
function DangerLine({ r }: { r: DangerRow }) {
  const tone = r.open ? 'border-red-200 bg-red-50' : r.state === 'confirmed' ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50';
  return (
    <li className={`rounded-lg border px-3 py-2 ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href={r.href} className="text-[12.5px] font-medium text-slate-800 hover:text-brand hover:underline">
          {r.subject}{r.occurrences > 1 && <span className="ml-1 text-[11px] font-normal text-slate-500">×{r.occurrences}</span>}
        </Link>
        <span className="text-[11px] text-slate-500">
          {r.surface === 'opd' ? (r.doctorName || '(unknown)') : `${r.dept} · ${IPD_UNJOINED_CELL}`}
          {r.day && ` · ${r.day}`}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
        <span className={`rounded-full border px-1.5 py-0.5 ${r.open ? 'border-red-200 text-red-700' : r.state === 'confirmed' ? 'border-emerald-200 text-emerald-700' : 'border-slate-200 text-slate-500'}`}>
          {r.open ? 'open' : r.state === 'confirmed' ? 'confirmed' : 'closed'}
        </span>
        {r.escalatedBy && <span className="rounded-full border border-amber-200 px-1.5 py-0.5 text-amber-700">{r.escalatedBy}</span>}
        {r.surface === 'ipd' && <span className="rounded-full border border-slate-200 px-1.5 py-0.5 text-slate-500">inpatient · {r.domain || 'safety'}</span>}
        {r.signalType && <span className="text-slate-400">{r.signalType}</span>}
        <span className="text-slate-400">· {r.reason}</span>
      </div>
    </li>
  );
}

export default async function StewardshipPage({ searchParams }: { searchParams: Promise<{ view?: string; doctor?: string }> }) {
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <Locked />; }
  const sp = await searchParams;
  // D-case — named doctors are the DEFAULT view this ship. The department roll-up is the other
  // composer target, not the landing page.
  const view = sp.view === 'dept' ? 'dept' : 'doctor';
  // S1 (A2 / A3) — which physician case the composer is open on, if any. The uid shape is checked
  // here so a hand-typed query string cannot mount a panel against a key the route will refuse.
  const askDoctor = /^[A-Za-z0-9_-]{6,64}$/.test(String(sp.doctor ?? '')) ? String(sp.doctor) : null;

  // Read order is a dependency chain, not a preference. The inpatient slice resolves the
  // practitioner-id hop ONCE (A1); the danger queue uses it to attribute the stays it can and the
  // board uses it for the inpatient column, so the column, the queue and the slice are one
  // resolution seen three times rather than three that can disagree.
  const ipd = await fetchIpdSlice();
  const queue = await fetchDangerQueue(ipd);
  const [doctorRows, deptRows, totals, lvcCells, rcExclusions, rcCoverage, standings] = await Promise.all([
    view === 'doctor' ? fetchDoctorBoard(queue, ipd) : Promise.resolve([] as BoardDoctorRow[]),
    view === 'dept' ? fetchDeptBoard(queue) : Promise.resolve([] as BoardDeptRow[]),
    fetchBoardTotals(),
    fetchLvcCells(), readRightCareExclusions(), fetchRightCareCoverage(),
    // S4 — the MS standing. Read HERE, in the page, and deliberately NOT inside
    // lib/stewardship-board.ts: §6.3 forbids an aggregator reading this blob, and the surest way to
    // keep that true is that the module which computes means and sorts rows cannot see it at all.
    currentStandings(view === 'doctor' ? 'physician' : 'dept'),
  ]);
  const rowsCount = view === 'doctor' ? doctorRows.length : deptRows.length;

  // Right Care "vs expected" — SAME O/E fn as the doctors index (decision 18: single implementation).
  const exclSet = new Set(rcExclusions);
  const oeMap = new Map<string, DoctorOE>(computeDoctorOE(lvcCells, exclSet).map((d) => [d.doctor_uid, d]));
  const vsExpected = (uid: string): { txt: string; tone: string; title: string } => {
    if (exclSet.has(uid)) return { txt: '—', tone: 'text-slate-300', title: 'excluded (house/non-clinician account)' };
    const oe = oeMap.get(uid);
    if (!oe || oe.n < FUNNEL_MIN_N) return { txt: '—', tone: 'text-slate-300', title: `building history (n<${FUNNEL_MIN_N} banded notes)` };
    const pts = Math.round((oe.raw_rate - oe.expected_rate) * 100);
    const txt = pts > 0 ? `+${pts}` : `${pts}`;
    const tone = pts >= 3 ? 'text-amber-700 font-medium' : pts <= -3 ? 'text-emerald-700' : 'text-slate-500';
    return { txt, tone, title: `observed ${Math.round(oe.raw_rate * 100)}% vs case-mix expected ${Math.round(oe.expected_rate * 100)}% (n=${oe.n} banded)` };
  };

  // ⚠️ From the queue's UNCAPPED count, not from the rendered rows. The 29 Aug validation found the
  // inpatient leg reporting 500 of 1,248 dangerous findings because the headline number was counted
  // over the display slice. A number on a board must not be a function of a display limit.
  const openTotal = queue.openTotal;

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand">STEWARDSHIP · INTERNAL MS</div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">{view === 'doctor' ? 'Clinician stewardship' : 'Department stewardship'}</h1>

      {/* Acceptance #3 — the honesty line. This is the page where the "not a clinician scorecard"
          clause is deliberately gone; what replaces it says what the room is and who never sees it. */}
      <p className="mt-1 max-w-3xl text-sm text-slate-600">{STEWARDSHIP_HONESTY}</p>
      <p className="mt-1 max-w-3xl text-[12px] text-slate-500">
        Last {BOARD_WINDOW_DAYS} IST days · live ceiling · one row per note. Sorted by open dangerous, then average
        note-quality (worst first), then inpatient. There is no combined index and there will not be one.
      </p>

      {/* A1 / D-identity — the split, stated once at the top of the room, WITH its measured size.
          A partial join that does not say how partial is worse than no join at all. */}
      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
        {IPD_SPLIT_BANNER} The inpatient column is filled only where a KarExpert practitioner id resolves to exactly
        one clinician; a shared or unknown id stays “{IPD_UNJOINED_CELL}”, and no clinician is ever joined on a
        display name. {hopCoverageLine(ipd.coverage)}
        {ipd.ambiguousIds.length > 0 && ` ${ipd.ambiguousIds.length} practitioner id(s) are claimed by two clinicians and resolve to neither.`}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {([['doctor', 'By doctor'], ['dept', 'By department']] as const).map(([v, label]) => (
          <Link key={v} href={`/admin/stewardship?view=${v}`}
            className={`rounded-full border px-2.5 py-1 text-[11.5px] ${view === v ? 'border-brand/40 bg-brand-faint text-brand' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
            {label}
          </Link>
        ))}
      </div>

      {rowsCount === 0 ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-6 text-center text-[13px] text-slate-500">
          No audits in the window yet.
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Open dangerous" value={openTotal.toLocaleString()} sub={`${queue.rows.length} row(s) in the queue`} />
            <Stat label="Notes audited" value={totals.nNotes.toLocaleString()} sub={view === 'doctor' ? `${rowsCount} clinicians` : `${rowsCount} departments`} />
            <Stat label="Avg note-quality" value={String(totals.avgNqi)} sub={`${totals.pctAb}% in band A–B`} />
            <Stat label="Notes w/ low-value" value={`${totals.pctLow}%`} sub={`${totals.sumLow.toLocaleString()} findings total`} />
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[10.5px] uppercase tracking-wide text-slate-400">
                  {view === 'doctor' ? (
                    <>
                      <th className="px-3 py-2.5 font-medium">Clinician</th>
                      <th className="px-3 py-2.5 font-medium">Speciality</th>
                    </>
                  ) : (
                    <>
                      <th className="px-3 py-2.5 font-medium">Department</th>
                      <th className="px-3 py-2.5 text-right font-medium">Clinicians</th>
                    </>
                  )}
                  <th className="px-3 py-2.5 font-medium" title={STANDING_ADVISORY}>MS standing</th>
                  {BOARD_HEADERS}
                  {view === 'doctor' && <th className="px-3 py-2.5 text-right font-medium" title="observed minus case-mix-expected LVC rate, in points">vs expected</th>}
                </tr>
              </thead>
              <tbody>
                {view === 'doctor'
                  ? doctorRows.map((r) => (
                    <tr key={r.doctorUid || r.doctorName} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-3 py-2.5 font-medium text-slate-800">
                        {r.doctorUid ? <Link href={`/admin/opd-audit/doctor/${r.doctorUid}`} className="hover:text-brand hover:underline">{r.doctorName}</Link> : r.doctorName}
                        {r.doctorUid && (
                          <Link href={`/admin/stewardship?view=doctor&doctor=${encodeURIComponent(r.doctorUid)}#ask`}
                            className="ml-2 text-[11px] font-normal text-slate-400 hover:text-brand hover:underline">ask</Link>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-slate-500">{r.speciality}</td>
                      <td className="px-3 py-2.5"><StandingChip s={standings[r.doctorUid]} /></td>
                      <BoardCells r={r} />
                      {(() => { const v = vsExpected(r.doctorUid); return <td className={`px-3 py-2.5 text-right tabular-nums ${v.tone}`} title={v.title}>{v.txt}</td>; })()}
                    </tr>
                  ))
                  : deptRows.map((r) => (
                    <tr key={r.dept} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="px-3 py-2.5 font-medium text-slate-800">
                        <Link href={`/admin/stewardship/dept/${encodeURIComponent(r.dept)}`} className="hover:text-brand hover:underline">{r.dept}</Link>
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-500">{r.nDoctors}</td>
                      <td className="px-3 py-2.5"><StandingChip s={standings[`opd_speciality:${r.dept}`]} /></td>
                      <BoardCells r={r} />
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {/* A1 — THE INPATIENT SLICE, in the inpatient vocabulary and in no other. This is the
              "IPD-only slice with the split banner for the unresolved remainder": every stay in the
              window appears here, joined or not, under the department label the discharge audit
              stored. It is deliberately NOT merged into the department roll-up above — that table's
              labels come from the OPD speciality vocabulary, and the two lists overlap on two
              strings out of fourteen. A department that reads the same in both is a coincidence of
              spelling, not a fact about the hospital. */}
          <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-serif text-[15px] font-semibold text-slate-900">Inpatient stays</h2>
              <span className="text-[11px] text-slate-500">{ipd.coverage.resolved} of {ipd.coverage.asked} joined to a clinician</span>
            </div>
            <p className="mt-0.5 text-[11.5px] text-slate-500">
              Departments as the discharge audits label them — a different vocabulary from the table above, never
              merged with it. Discharge-summary audits only; the stay-level reading of the same stays is drill
              context on the case page and is not in these numbers.
            </p>
            {ipd.unavailable && (
              <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
                The inpatient audits could not be read just now. This is not a statement that there were no stays.
              </p>
            )}
            {ipd.coverage.unavailable && !ipd.unavailable && (
              <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
                The clinician hop could not be read just now, so every stay below is unjoined. The stays themselves
                are real; only the attribution is missing.
              </p>
            )}
            {ipd.rows.length === 0
              ? <p className="mt-3 text-[12px] text-slate-500">No audited inpatient stays in the window.</p>
              : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-[10.5px] uppercase tracking-wide text-slate-400">
                        <th className="px-3 py-2 font-medium">Department (inpatient vocabulary)</th>
                        <th className="px-3 py-2 text-right font-medium">Stays</th>
                        <th className="px-3 py-2 text-right font-medium" title="stays whose practitioner id resolved to exactly one clinician">Joined</th>
                        <th className="px-3 py-2 text-right font-medium">Mean CVI</th>
                        <th className="px-3 py-2 text-right font-medium">% A–B</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ipd.rows.map((r) => (
                        <tr key={r.dept} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                          <td className="px-3 py-2 font-medium text-slate-800">{r.dept}</td>
                          <td className="px-3 py-2 text-right text-slate-600">{r.stays}</td>
                          <td className={`px-3 py-2 text-right ${r.joined === 0 ? 'text-slate-400' : 'text-slate-600'}`}>
                            {r.joined}<span className="ml-1 text-[10.5px] text-slate-400">of {r.stays}</span>
                          </td>
                          <td className={`px-3 py-2 text-right ${r.avgCvi == null ? 'text-slate-400' : scoreClass(r.avgCvi)}`}>{r.avgCvi ?? '—'}</td>
                          <td className="px-3 py-2 text-right text-slate-600">{r.pctAb}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </div>

          {/* D-escalate — the danger queue, on the same page. Opening a row never leaves /admin/*. */}
          <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-serif text-[15px] font-semibold text-slate-900">Danger queue</h2>
              <span className="text-[11px] text-slate-500">
                {openTotal} open ({queue.opdOpen} OPD · {queue.ipdOpen} inpatient) · {queue.rows.length} shown
              </span>
            </div>
            <p className="mt-0.5 text-[11.5px] text-slate-500">
              Tier-1 escalations from the ratified severity table, safety-domain inpatient findings, and findings a
              reviewer contested and nobody has resolved. Praise never appears here, and tier-3 findings are logged
              rather than queued. {DANGER_QUEUE_UNIT}
            </p>
            {queue.unavailable && (
              <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900">
                Part of the queue could not be read just now, so this list is incomplete. It is not a statement that
                there is nothing to see.
              </p>
            )}
            {queue.capped && (
              <p className="mt-2 text-[11px] italic text-amber-800">
                More rows matched than one page load renders — this is the newest slice of the queue, not all of it.
                {queue.ipdShown < queue.ipdEligible && ` Inpatient: showing ${queue.ipdShown} of ${queue.ipdEligible} eligible findings, newest audit first.`}
                {' '}The open counts above are over every eligible finding, not over this list.
              </p>
            )}
            {queue.rows.length === 0
              ? (
                <p className="mt-3 text-[12px] text-slate-500">
                  {queue.unavailable
                    ? 'Nothing could be read.'
                    : 'No escalated or contested finding in the window. That is an absence of queued findings, not a clean window.'}
                </p>
              )
              : <ul className="mt-3 space-y-1.5">{queue.rows.slice(0, 100).map((r, i) => <DangerLine key={`${r.surface}-${r.auditId}-${r.subject}-${i}`} r={r} />)}</ul>}
          </div>

          {/* D-ops — the ops pane. Same room, same gate, second pane. Never a rank column.
              It awaits its own six db13 reads behind a Suspense boundary so the audit pane above —
              the board, the danger queue, the inpatient slice — does not wait on a consult-ops
              number. Unscoped here: the whole room's ops. The department route passes its own. */}
          <Suspense fallback={<OpsSectionFallback />}>
            <OpsSection scope="all clinicians" />
          </Suspense>

          {/* S1 (A2 / A3) — the persisted MS conversation, keyed to ONE named physician. */}
          {askDoctor && (
            <div id="ask" className="mt-5 scroll-mt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-serif text-[15px] font-semibold text-slate-900">Ask about this clinician</h2>
                <Link href={`/admin/stewardship?view=${view}`} className="text-[12px] text-brand hover:underline">close</Link>
              </div>
              <p className="mt-0.5 text-[11.5px] text-slate-500">
                Answers cite what the audits already stored for this clinician over the window. The inpatient side is
                not joined to this key yet, so nothing here describes their inpatient stays. Nothing said in the box
                changes a number in the table above.
              </p>
              <PhysicianAskPanel doctorUid={askDoctor} />
            </div>
          )}

          <p className="mt-4 text-[11px] text-slate-400">
            Scores 0–100; green ≥80, amber 60–79, red &lt;60. {view === 'doctor' ? 'Clinicians' : 'Departments'} with few audited
            notes read noisily until volume builds. Open dangerous counts a finding with no reviewer pill, a contested one,
            or one a reviewer marked as still needing action; a finding confirmed by a reviewer is shown as confirmed and is
            not counted open. That column counts OPD findings only — inpatient findings appear in the queue with a clinician's
            name where the hop resolved the stay, but they do not enter the sort, because the hop resolves about two in five
            audited stays and a clinician must not rank safer for having an ambiguous practitioner id. “vs expected” = observed minus
            case-mix-expected LVC rate (points); em-dash when n&lt;{FUNNEL_MIN_N} or excluded. {STANDING_ADVISORY}
            {' '}Right Care banded coverage {rcCoverage.banded.toLocaleString()}/{rcCoverage.total.toLocaleString()}.
            {rcExclusions.length > 0 && ` ${rcExclusions.length} house/non-clinician account(s) excluded from vs-expected.`}
          </p>
        </>
      )}
    </div>
  );
}
