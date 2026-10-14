// /admin/ipd-audit/[id] — the IPD audit REPORT (S3.4): full-bleed split, the real GCS
// discharge PDF beside the findings (the CCB CareBriefSplit posture; Shell's fullBleed
// predicate covers this route). RIGHT column reuses the shipped CaseAuditReport renderer on
// the persisted de-identified report, plus the first-class Low-Value Care triage panel.
// PHI (patient name / UHID / consultant) is joined from db13 AT READ TIME for the header of
// this access-controlled view only — it is never stored on the audit row.
import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';

import type { AuditReport, AuditFinding, ExtractedCase } from '@/lib/doc-audit-core';
import { fetchIpdDoc, fetchIpdAdmissionHeader } from '@/lib/ipd-audit/db13';
import { reviewsForAudits, applyScoringPolicy } from '@/lib/ipd-audit/store';
import { fetchBillingEnvelope, reconcile, documentedFrom, peerBandForSpeciality } from '@/lib/ipd-audit/billing';
import { BandChip } from '../ui';
import ReportWithTriage from './report-with-triage';
import BillingPanel, { NoEnvelope } from './billing-panel';
import EpisodeCourse from './episode-course';
import { fetchEpisodeState } from '@/lib/episode-state/store';
import MedRecPanel from './med-rec-panel';
import { fetchMemberOpdRows } from '@/lib/ipd-audit/member-opd-fetch';
import { computeMedRecView } from '@/lib/member-state-adapters/med-rec-view';
import { admissionAdapterEnabled } from '@/lib/member-state-adapters/discharge-evidence';
import OutcomePanel, { type ComplicationOption, type OutcomeRowView } from './outcome-panel';
import { outcomesForSource } from '@/lib/prognosis-outcomes-store';
import { complicationHash, resolveComplicationHash } from '@/lib/prognosis-outcomes-core';

export const dynamic = 'force-dynamic';

function LockedMsg() {
  return (
    <div className="mx-auto max-w-md py-16 text-center text-sm text-slate-500">
      This report is access-controlled. <Link href="/admin/ipd-audit" className="text-brand hover:underline">Unlock the IPD audit surface</Link> first.
    </div>
  );
}

const pdfSrc = (u: string) => `${u}#toolbar=0&navpanes=0&view=FitH`;

export default async function IpdAuditReport({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isAdminUnlocked())) return <LockedMsg />;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return <div className="p-8 text-sm text-slate-500">Bad audit id.</div>;

  const rows = (await sql(`SELECT * FROM ipd_discharge_audits WHERE id = $1 LIMIT 1`, [id])) as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return <div className="p-8 text-sm text-slate-500">Audit not found. <Link href="/admin/ipd-audit" className="text-brand hover:underline">Back to overview</Link></div>;

  const documentId = String(r.document_id);
  const ipUid = r.ip_uid ? String(r.ip_uid) : null;
  const [doc, header, feedback] = await Promise.all([
    fetchIpdDoc(documentId).catch(() => null),
    ipUid ? fetchIpdAdmissionHeader(ipUid).catch(() => null) : Promise.resolve(null),
    sql(
      `SELECT DISTINCT ON (finding_ref) finding_ref, verdict FROM ipd_audit_feedback
       WHERE audit_id = $1 AND finding_ref IS NOT NULL ORDER BY finding_ref, created_at DESC`,
      [id],
    ) as unknown as Promise<Array<{ finding_ref: string; verdict: string }>>,
  ]);
  const triaged = Object.fromEntries(feedback.map((f) => [f.finding_ref, f.verdict]));

  // Phase B — this audit's existing review (§6.4) and its weighted documentation number + weights
  // version (§6.5, §8.3). Both fail soft: no review ⇒ an empty panel; no policy ⇒ the stored,
  // unweighted number and no version chip, i.e. exactly today's render.
  const [reviewMap, weighted] = await Promise.all([
    reviewsForAudits([id]),
    applyScoringPolicy([r as Record<string, unknown>]),
  ]);
  const review = reviewMap[id] ?? null;
  const w = weighted[0];

  const report = (typeof r.report === 'string' ? JSON.parse(r.report) : r.report) as AuditReport | null;
  const findings = (report?.findings ?? (typeof r.findings === 'string' ? JSON.parse(String(r.findings)) : r.findings) ?? []) as AuditFinding[];
  const lvcFindings = findings.filter((f) => f.verdict === 'low-value' || f.verdict === 'context-dependent');
  const band = String(r.band);
  const pdfUrl = doc?.pdfUrl ?? null;
  const exportBase = `/api/admin/ipd-audit-export?id=${id}`;

  // S7 — the billing envelope: a read-time db13 join like the PHI header, never persisted beyond
  // the billed_total scalar. Both reads are best-effort: a billing outage costs us the ₹ panel,
  // never the audit above it.
  const speciality = header?.speciality ?? (r.speciality ? String(r.speciality) : null);
  const [envelope, peer] = await Promise.all([
    ipUid ? fetchBillingEnvelope(ipUid).catch(() => null) : Promise.resolve(null),
    peerBandForSpeciality(speciality).catch(() => null),
  ]);
  const recon = envelope
    ? reconcile(envelope.categories, documentedFrom(report), findings, envelope.pharmacyItems, envelope.pharmacyClasses)
    : null;

  // EpisodeState (#4 SL3) — READ-ONLY render of the persisted phased course. Best-effort: a read
  // failure or an un-built admission just hides the element, never affects the audit above.
  const episode = await fetchEpisodeState(documentId).catch(() => null);

  // PX Phase 2 (§5.3) — outcomes against the prognosis block. Server-side because the stable
  // binding needs Node crypto: each complication's hash and each stored row's resolution
  // (BY HASH, never by the advisory index — P-2) are computed here and passed down. Best-effort:
  // an unreadable outcomes table renders "temporarily unavailable" inside the panel, never a 500
  // and never a lost report (§6). The panel renders ONLY when report.prognosis is present.
  const prognosis = report?.prognosis ?? null;
  let outcomeComplications: ComplicationOption[] = [];
  let outcomeRows: OutcomeRowView[] = [];
  let outcomesUnavailable = false;
  if (prognosis) {
    const lookup = await outcomesForSource('ipd_discharge_audits', documentId).catch(() => ({ rows: [], unavailable: true }));
    outcomesUnavailable = lookup.unavailable;
    outcomeComplications = (prognosis.complications ?? [])
      .filter((c) => typeof c?.complication === 'string' && c.complication)
      .map((c, i) => ({ name: c.complication, hash: complicationHash(c.complication), index: i }));
    outcomeRows = lookup.rows.map((row) => {
      const res = resolveComplicationHash(row.matched_complication_hash, prognosis.complications ?? []);
      return {
        id: row.id,
        source: row.source,
        observed_outcome: row.observed_outcome,
        observed_at: row.observed_at,
        classification: row.classification,
        reviewed_by_name: row.reviewed_by_name,
        notes: row.notes,
        superseded: row.superseded,
        supersedes_id: row.supersedes_id,
        created_at: row.created_at,
        resolution: res.status === 'matched' ? { status: 'matched', complication: res.complication } : { status: res.status },
      };
    });
  }

  // Medication reconciliation (admission) — #5 SL3. The ONE flag (MEMBERSTATE_ADMISSION_ADAPTER)
  // gates BOTH the compose path AND this surface: with it off, medRec stays null and production is
  // byte-unchanged. Read-time only (no new persisted artifact); best-effort — an OPD-fetch miss
  // degrades to the admission-list-only banner, never breaks the report. Med-rec ONLY (Gate D scope).
  let medRec = null;
  if (admissionAdapterEnabled() && episode) {
    const admitDate = episode.intra.admission.admitDate?.value ?? null;
    const opd = await fetchMemberOpdRows(header?.uhid ?? null, admitDate).catch(() => null);
    const computedAt = String(r.audited_at ?? episode.intra.admission.dischargeDate?.value ?? '');
    try {
      medRec = computeMedRecView(
        {
          memberRef: opd?.memberRef ?? '',
          generatedAt: computedAt,
          computedAt,
          linked: opd?.linked ?? false,
          prescriptionRows: opd?.prescriptionRows ?? [],
          labRows: opd?.labRows ?? [],
        },
        episode,
      );
    } catch { medRec = null; }   // best-effort: a compose/reconcile failure never breaks the report

  }

  return (
    <div className="flex h-screen flex-col">
      {/* corner bar — pl-14 clears the floating ☰ the full-bleed shell shows */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white py-2 pl-14 pr-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/admin/ipd-audit" className="whitespace-nowrap text-xs text-slate-500 hover:text-brand">← IPD audits</Link>
          <span className="truncate text-[13px]">
            <b className="text-slate-800">{header?.patientName ?? 'Patient'}</b>
            {header?.uhid && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{header.uhid}</span>}
            {header?.ageGender && <span className="ml-1.5 text-[11px] text-slate-500">{header.ageGender}</span>}
            <span className="ml-1.5 text-[11px] text-slate-500">{ipUid} · {header?.speciality ?? String(r.speciality ?? '—')}{header?.team ? ` · ${header.team}` : ''}{header?.ward ? ` · ${header.ward}` : ''}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-slate-800 px-2 py-0.5 text-[10.5px] font-semibold text-white" title="Identifiers joined from db13 at read time; never stored with the audit">Access-controlled · PHI read-time</span>
          <BandChip band={band} cvi={Number(r.care_value_index)} />
          {pdfUrl && <a href={pdfUrl} target="_blank" className="text-xs text-brand hover:underline">Discharge PDF ↗</a>}
          <a href={`${exportBase}&mode=report`} className="text-xs text-brand hover:underline">Audit report ↓</a>
          <a href={`${exportBase}&mode=combined`} className="text-xs text-brand hover:underline">Combined ↓</a>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* LEFT — the real discharge PDF */}
        <div className="flex min-h-[40vh] flex-col bg-[#525659] md:min-h-0 md:flex-[1.05]">
          {pdfUrl ? (
            <iframe src={pdfSrc(pdfUrl)} key={pdfUrl} title="Discharge summary PDF" className="h-full w-full border-0 bg-white" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-300">Discharge PDF unavailable (db13 link lost)</div>
          )}
        </div>

        {/* RIGHT — findings */}
        <div className="min-h-0 flex-1 overflow-auto bg-white">
          <div className="mx-auto max-w-3xl px-5 py-6">
            {/* PRIMARY SIGNALS (S4 decision, option b): completeness + the low-value THEMES lead
                the hierarchy — S4 measured them stable; the CVI/band is a noisy single-run draw
                and is demoted to the uncertainty-marked chip in the corner bar. The adjudicable
                finding list itself lives ONCE, inside CaseAuditReport below. */}
            <div className="rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-100 px-4 py-2.5 text-[13px] font-semibold text-slate-800">Primary signals</div>
              <div className="flex flex-wrap items-baseline gap-x-2 px-4 py-2.5">
                <span className="text-[12px] font-semibold text-slate-600">Documentation completeness</span>
                <span className="font-serif text-[22px] font-semibold leading-none text-slate-900">{r.completeness_pct == null ? '—' : `${Number(r.completeness_pct)}%`}</span>
                {report?.completeness?.missingMandatory?.length ? (
                  <span className="text-[11px] text-slate-500">missing: {report.completeness.missingMandatory.join('; ')}</span>
                ) : <span className="text-[11px] text-slate-500">no mandatory gaps</span>}
              </div>
              <div className="border-t border-slate-100 px-4 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold text-slate-600">Low-Value Care check</span>
                  <span className="text-[11px] text-slate-500">runs on every summary · adjudicate each finding below</span>
                </div>
                {lvcFindings.length === 0 ? (
                  <div className="mt-1 text-[12px] text-slate-500">no low-value / context-dependent findings</div>
                ) : (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {lvcFindings.map((f) => (
                      <span key={f.subject} className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${f.verdict === 'low-value' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>{f.subject}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* the shipped Case-Audit renderer — ONE finding list, every finding adjudicable.
                The Care-Value Index it opens with is a single-run estimate (±1 band noise). */}
            <div className="mt-2 text-right text-[10.5px] text-slate-400">Care-Value Index below is a single-run estimate — ±1 band noise (S4-measured)</div>
            <div className="mt-1">
              {report ? (
                <ReportWithTriage
                  report={report}
                  auditId={id}
                  triaged={triaged}
                  analyzeTraceId={r.trace_id ? String(r.trace_id) : undefined}
                  weightsVersion={w?.weights_version ?? null}
                  weightedCompletenessPct={w?.completeness_pct ?? null}
                  review={review}
                />
              ) : (
                <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
                  This row predates the full-report column (0014) — re-run “Audit now” on the document to render the complete report.
                </div>
              )}
            </div>

            {/* billing panel — S7 */}
            {envelope && recon ? <BillingPanel envelope={envelope} recon={recon} peer={peer} /> : <NoEnvelope />}

            {/* EpisodeState phased course — #4 SL3 (facts-only, read from episode_states; hidden when un-built) */}
            {episode && <EpisodeCourse state={episode} />}

            {/* Medication reconciliation (admission) — #5 SL3 (behind MEMBERSTATE_ADMISSION_ADAPTER;
                null ⇒ flag off ⇒ nothing rendered ⇒ production unchanged) */}
            {medRec && <MedRecPanel view={medRec} />}

            {/* PX Phase 2 — outcomes against the prognosis block (renders only when one exists) */}
            {prognosis && (
              <OutcomePanel
                documentId={documentId}
                engineVersion={String(r.engine_version)}
                complications={outcomeComplications}
                initialRows={outcomeRows}
                unavailable={outcomesUnavailable}
              />
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
              <span>engine {String(r.engine_version)}</span>
              {r.model != null && <span>model {String(r.model)}</span>}
              {r.trace_id != null && <Link href={`/admin/observability/${r.trace_id}`} className="text-brand hover:underline">trace {String(r.trace_id).slice(0, 8)}…</Link>}
              <span>audited {String(r.audited_at).slice(0, 16)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
