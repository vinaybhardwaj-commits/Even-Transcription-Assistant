/**
 * app/admin/stewardship/stewardship-ask-panel.tsx — the internal MS room's Ask mount
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A2 / A3; spec §12.1 S1).
 *
 * This surface's half of the shared shell: which endpoint answers, which grain the chrome is
 * dressing, and — per A3 — the exact thread key, minted HERE on the server and handed to the chrome
 * rather than assembled in the browser. The engine half of the key is added server-side by the
 * route, from the one constant that owns it.
 *
 * The chrome lives once in components/case-ask/CaseAskPanel.tsx. Nothing here rescores: the panel
 * carries no recompute control and the route it talks to writes only `case_ask_turns`. The MS
 * standing overlay (`physician_standing`) is S4 and does not exist on this path yet; when it does it
 * will be stated-only and will still not move an NQI or a CVI.
 */
import CaseAskPanel from '@/components/case-ask/CaseAskPanel';
import { deptCaseKey, type DeptVocab } from '@/lib/case-ask/stewardship-material';

const ENDPOINT = '/api/admin/stewardship/ask';

/** A3 — `case_type = 'physician'`, `case_key = <doctor_uid>`. */
export function PhysicianAskPanel({ doctorUid }: { doctorUid: string }) {
  return <CaseAskPanel caseType="physician" query={{ case: 'physician', key: doctorUid }} endpoint={ENDPOINT} />;
}

/** A3 — `case_type = 'dept'`, `case_key = '<vocab>:<label>'`. The vocabulary tag travels with the
 *  label because the OPD and inpatient department vocabularies are two different lists of strings
 *  and a bare label would silently merge them. */
export function DeptAskPanel({ vocab, label }: { vocab: DeptVocab; label: string }) {
  return <CaseAskPanel caseType="dept" query={{ case: 'dept', key: deptCaseKey(vocab, label) }} endpoint={ENDPOINT} />;
}
