/**
 * Doctor Findings projection of a triage stamp.
 *
 * `reason` and `policy_version` on triage_stamp_events are Care Management /
 * stamp-audit text (for example "jev:route conf=0.67 should_route=0.70; hard_bar_jev_route"
 * and "triage-shadow-policy/0.1.4"). They stay on the stamp row for the Action queue
 * and stamp inspection. The stamp has no separate clinician-safe triage field, so
 * the doctor-audits payload omits `triage`.
 */
export interface StampAuditText {
  reason?: string | null;
  policy_version?: string | null;
}

export function projectClinicianTriage(
  _stamp?: StampAuditText | null,
): null {
  return null;
}
