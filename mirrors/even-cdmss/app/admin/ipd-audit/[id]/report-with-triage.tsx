'use client';
// Thin client wrapper (S3.2 fix): a server page cannot pass a function prop across the RSC
// boundary, so the findingActions render-prop is composed HERE — CaseAuditReport (shared,
// unchanged for other callers) gets the per-finding FindingTriage strip on EVERY finding.
//
// Phase B extends the same posture: the "Your review" panel (§6.4) and the weighted documentation
// number + its weights version (§6.5, §8.3) are passed through as OPTIONAL props, so every other
// caller of CaseAuditReport renders exactly as before.
import type { AuditReport, AuditFinding } from '@/lib/doc-audit-core';
import CaseAuditReport from '@/components/CaseAuditReport';
import FindingTriage from './finding-triage';
import ReviewPanel, { type ExistingReview } from './review-panel';

export default function ReportWithTriage({ report, auditId, triaged, analyzeTraceId, weightsVersion, weightedCompletenessPct, review }: {
  report: AuditReport;
  auditId: string;
  triaged: Record<string, string>;   // finding subject → latest adjudication verdict
  analyzeTraceId?: string;
  weightsVersion?: string | null;
  weightedCompletenessPct?: number | null;
  review?: ExistingReview | null;
}) {
  return (
    <CaseAuditReport
      report={report}
      analyzeTraceId={analyzeTraceId}
      weightsVersion={weightsVersion}
      weightedCompletenessPct={weightedCompletenessPct}
      reviewPanel={<ReviewPanel auditId={auditId} initial={review ?? null} />}
      findingActions={(f: AuditFinding) => (
        <FindingTriage auditId={auditId} findingRef={f.subject} initial={triaged[f.subject] ?? null} />
      )}
    />
  );
}
