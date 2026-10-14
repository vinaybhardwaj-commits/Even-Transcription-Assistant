/**
 * app/admin/ipd-audit/[id]/case-ask-panel.tsx — the IPD discharge-audit case's Ask mount
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P1 / §7).
 *
 * This surface's half of the shared shell: its OWN admin-gated endpoint (O4), the `ipd` case type,
 * and the audit row id the thread is keyed to (O6 — the parked audit row; the engine version is
 * added server-side from the row, which is 'ipd-discharge-audit/0.2' today and stays that after P3
 * appends its own rows under a new version).
 *
 * The chrome lives once in components/case-ask/CaseAskPanel.tsx. Nothing here rescores: the panel has
 * no recompute control, the route writes only `case_ask_turns`, and no chat turn can move
 * `care_value_index`, the band, or a row in `ipd_audit_feedback` (§3.3). The gold pills on this page
 * stay the way a reviewer adjudicates a finding.
 */
import CaseAskPanel from '@/components/case-ask/CaseAskPanel';

export default function IpdCaseAskPanel({ auditId }: { auditId: string }) {
  return <CaseAskPanel caseType="ipd" query={{ audit_id: auditId }} endpoint="/api/admin/ipd-audit-ask" />;
}
