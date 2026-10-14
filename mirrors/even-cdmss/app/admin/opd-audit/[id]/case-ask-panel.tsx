/**
 * app/admin/opd-audit/[id]/case-ask-panel.tsx — the OPD note-audit case's Ask mount
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P1 / §7).
 *
 * This surface's half of the shared shell: which endpoint answers (O4 — OPD has its OWN admin-gated
 * route, not a shared multi-tenant one), which case type the chrome is dressing, and which audit row
 * the thread is keyed to (O6 — the OPD audit row id; the engine version is added server-side from
 * the row itself, so the key names the numbers the argument is actually about).
 *
 * The chrome lives once in components/case-ask/CaseAskPanel.tsx. Nothing here rescores: the panel has
 * no recompute control and the route it talks to writes only `case_ask_turns` (§3.3). The gold pills
 * on this page — true_positive / nitpick / false / contested — are untouched and stay the way a
 * reviewer adjudicates a finding.
 */
import CaseAskPanel from '@/components/case-ask/CaseAskPanel';

export default function OpdCaseAskPanel({ auditId }: { auditId: string }) {
  return <CaseAskPanel caseType="opd" query={{ audit_id: auditId }} endpoint="/api/admin/opd-audit-ask" />;
}
