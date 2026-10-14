/**
 * lib/audit-suppression-core.ts — Tier 1 self-healing: suppression matcher CORE (pure).
 *
 * A human-approved `audit_suppression` narrows a recurring false-positive class out of the audit:
 * a finding matching an ACTIVE suppression is dropped, or downgraded to informational (kept for
 * awareness, removed from the triage queue + score). Narrowly scoped, reversible.
 *
 * The CARDINAL safety rule (PRD §7.2 dual-label invariant / P17): a suppression may only remove
 * flagged FPs if it removes NOTHING a care manager marked `valid_signal`. `previewCollateral` is the
 * pure check the activation endpoint runs against the valid-label set before a suppression goes live.
 * Pure → unit-testable.
 */

export type SuppressionAction = 'drop' | 'downgrade' | 'demote';
export type SuppressionMatch = 'type_only' | 'subject_contains' | 'lvc_category';
export type SuppressionScope = 'all' | 'doctor';
export type SuppressionStatus = 'proposed' | 'active' | 'retired';

export interface Suppression {
  id?: string;
  signal_type: string;
  discriminator: string | null;     // narrowing: substring (subject_contains) or exact category (lvc_category); null = whole type
  match_kind: SuppressionMatch;
  scope: SuppressionScope;
  doctor_uid: string | null;        // when scope='doctor'
  action: SuppressionAction;
  active: boolean;
  status?: SuppressionStatus;       // quieting workflow (Q5); legacy drop/downgrade rows key on `active` alone
}

export interface SuppressibleFinding {
  signal_type?: string;
  subject: string;
  finding_ref?: string;
  informational?: boolean;
  lvc_category?: string;            // quieting: lvc_category match kind reads this (stamped by stampLvcMetadata)
}

// ── Quieting severity floor (PRD §2.3) ─────────────────────────────────────────
// The deterministic patient-safety signal types configuration can NEVER quiet — enumerated from
// SIGNAL_TYPE_RULES in lib/opd-note-audit-core.ts (the deterministic prescribing-safety checks whose
// miss is a harm risk, not a documentation/formulary nit). Enforced twice: the store refuses to
// WRITE a demote rule scoped to any of these, and applyDemotes SKIPS such findings regardless of
// what the rules table says.
export const SAFETY_SIGNAL_TYPES: readonly string[] = [
  'drug_interaction',        // DDI (deterministic + LLM-keyword routed)
  'high_alert_medication',
  'dose_ceiling_exceeded',   // dose-limit breach
  'dose_ceiling_sos',        // dose-limit breach contingent on SOS dosing
  'schedule_x',
  'lasa_pair',               // look-alike / sound-alike
  'duplicate_molecule',      // same molecule in N products — overdose route
  'duplicate_prescription',
  'banned_fdc',              // CDSCO-banned FDC (C4) — a Section-26A legal prohibition is never quietable
] as const;
export function isSafetySignalType(t: string | undefined): boolean {
  return !!t && (SAFETY_SIGNAL_TYPES as string[]).includes(t);
}

/** Does this finding (for this doctor) match the suppression? */
export function findingMatchesSuppression(f: SuppressibleFinding, doctorUid: string | null, s: Suppression): boolean {
  if (!s.active) return false;
  if (!f.signal_type || f.signal_type !== s.signal_type) return false;
  if (s.scope === 'doctor' && s.doctor_uid && s.doctor_uid !== doctorUid) return false;
  if (s.match_kind === 'subject_contains' && s.discriminator) {
    return f.subject.toLowerCase().includes(s.discriminator.toLowerCase());
  }
  if (s.match_kind === 'lvc_category') {
    // exact category match, case-insensitive; a rule with no category can never match
    if (!s.discriminator) return false;
    return (f.lvc_category || '').toLowerCase() === s.discriminator.toLowerCase();
  }
  return true; // type_only, or no discriminator
}

export interface SuppressionOutcome<T> {
  findings: T[];
  suppressed: { finding_ref: string | undefined; signal_type: string | undefined; action: SuppressionAction }[];
}

/**
 * Apply active suppressions to one note's findings. First matching suppression wins.
 * `drop` removes the finding; `downgrade` sets informational (kept, but out of the queue + score).
 * Never touches an already-informational finding's presence (only real findings are suppressed).
 *
 * SEVERITY FLOOR, engine-side half for drop/downgrade (V ruling, 26 Jul 2026): a finding whose
 * signal_type is in SAFETY_SIGNAL_TYPES is skipped regardless of what the suppressions table says —
 * mirroring applyDemotes. Belt and braces: the store-side half now refuses to write such a rule for
 * ANY action, so this can only fire on a row written before the floor was generalised.
 */
export function applySuppressions<T extends SuppressibleFinding>(
  findings: T[], doctorUid: string | null, suppressions: Suppression[],
): SuppressionOutcome<T> {
  const active = suppressions.filter((s) => s.active);
  if (active.length === 0) return { findings, suppressed: [] };

  const kept: T[] = [];
  const suppressed: SuppressionOutcome<T>['suppressed'] = [];
  for (const f of findings) {
    if (isSafetySignalType(f.signal_type)) { kept.push(f); continue; }   // severity floor — belt and braces
    const hit = active.find((s) => findingMatchesSuppression(f, doctorUid, s));
    if (!hit) { kept.push(f); continue; }
    suppressed.push({ finding_ref: f.finding_ref, signal_type: f.signal_type, action: hit.action });
    if (hit.action === 'drop') continue;           // remove entirely
    kept.push({ ...f, informational: true });       // downgrade — kept for awareness, out of queue/score
  }
  return { findings: kept, suppressed };
}

// ── Quieting (demote) — PRD CDMSS-QUIETING-DEMOTE-SYSTEM Q1 ───────────────────
export interface DemoteOutcome<T> {
  findings: T[];
  quieted: { finding_ref: string | undefined; signal_type: string | undefined; rule_id: string | undefined }[];
}

/**
 * Apply ACTIVE demote rules to one note's finalised findings (the quieting seam, called immediately
 * before scoring). A matching finding becomes `informational: true` + `quieted_by: <rule_id>` —
 * stored intact, out of the score and doctor-facing display via the existing informational
 * mechanism. Already-informational findings are left alone (nothing to quiet). SAFETY FLOOR,
 * engine-side half: findings whose signal_type is in SAFETY_SIGNAL_TYPES are skipped regardless of
 * what the rules table says (the store-side half refuses to write such rules at all).
 * First matching rule wins. Pure; never throws.
 */
export function applyDemotes<T extends SuppressibleFinding>(
  findings: T[], doctorUid: string | null, rules: Suppression[],
): DemoteOutcome<T> {
  const active = rules.filter((r) => r.action === 'demote' && r.active && (r.status === undefined || r.status === 'active'));
  if (active.length === 0) return { findings, quieted: [] };
  const out: T[] = [];
  const quieted: DemoteOutcome<T>['quieted'] = [];
  for (const f of findings) {
    if (f.informational || isSafetySignalType(f.signal_type)) { out.push(f); continue; }
    const hit = active.find((r) => findingMatchesSuppression(f, doctorUid, r));
    if (!hit) { out.push(f); continue; }
    quieted.push({ finding_ref: f.finding_ref, signal_type: f.signal_type, rule_id: hit.id });
    out.push({ ...f, informational: true, quieted_by: hit.id ?? null });
  }
  return { findings: out, quieted };
}

/** Store-side half of the severity floor: is this rule one the store must refuse to write?
 *  ALL actions (V ruling, 26 Jul 2026) — a drop or downgrade removes a safety finding just as
 *  effectively as a demote, and the previous demote-only scope was a hole, not a design. The rule
 *  (not a bare signal_type) stays the parameter deliberately: the call sites read better, and a
 *  future action-specific exception has somewhere to live. */
export function ruleViolatesSeverityFloor(rule: Pick<Suppression, 'action' | 'signal_type'>): boolean {
  return isSafetySignalType(rule.signal_type);
}

// ── Dual-label safety (PRD §7.2) ──────────────────────────────────────────────
export interface ValidLabelInstance {
  doctor_uid: string;
  signal_type: string;
  subject: string;                  // the finding subject a CM's valid_signal decision covers
}

export interface CollateralPreview {
  would_suppress: number;           // findings the suppression matches in the sample
  collateral: number;               // of those, ones a CM validated (valid_signal) — MUST be 0 to activate
  safe: boolean;
  collateral_examples: { doctor_uid: string; subject: string }[];
}

/**
 * The dual-label check: over the valid-label set (findings whose (doctor, signal_type) a CM marked
 * `valid_signal`), how many would this proposed suppression remove? Any > 0 means it would blind the
 * audit to a confirmed-real signal → unsafe. `sample` = recent findings for the signal_type with the
 * doctor's latest validity label attached.
 */
export function previewCollateral(proposed: Suppression, validLabelSet: ValidLabelInstance[]): CollateralPreview {
  const matched = validLabelSet.filter((v) =>
    findingMatchesSuppression({ signal_type: v.signal_type, subject: v.subject }, v.doctor_uid, proposed));
  return {
    would_suppress: matched.length,
    collateral: matched.length,     // every item in the valid-label set is, by definition, validated
    safe: matched.length === 0,
    collateral_examples: matched.slice(0, 5).map((v) => ({ doctor_uid: v.doctor_uid, subject: v.subject })),
  };
}
