/**
 * lib/opd-triage-core.ts — Care-Manager OPD Audit Triage CORE (pure).
 *
 * Turns last night's exploded audit findings into the per-doctor, per-signal_type worklist the
 * care manager triages (governance spec v2.0 §3 / PRD §5), and validates the four-field decision.
 *
 * PURE + dependency-free (loads under `node --experimental-strip-types` for unit tests). All DB
 * reads/writes live in lib/opd-triage-store.ts; the endpoint hands us findings already carrying
 * signal_type + finding_ref (stamped by stampFindingIdentity, so legacy rows are covered too).
 *
 * Cardinal: this only RANKS and GROUPS — the audit is a high-sensitivity screen, the CM decides.
 * Ranking is advisory pre-sorting so the loudest + most serious pile sits on top; never a verdict.
 */

// ── Controlled decision vocab (spec §3.1) ─────────────────────────────────────
export const VALIDITY = ['valid_signal', 'audit_bug'] as const;
export const BUG_TYPES = ['process_bug', 'structural_bug'] as const;
export const IMPORTANCE = ['low', 'med', 'high'] as const;
export const RESPONSE_REQUIRED = ['none', 'explanation', 'acknowledgment', 'recommend_privilege_review'] as const;
export type Validity = (typeof VALIDITY)[number];
export type BugType = (typeof BUG_TYPES)[number];
export type Importance = (typeof IMPORTANCE)[number];
export type ResponseRequired = (typeof RESPONSE_REQUIRED)[number];

// ── Per-signal_type severity weight (advisory pre-ranking only) ───────────────
// 3 = most serious to review first, 1 = low. Distinct from the CM's L/M/H importance (the CM
// sets that) and from the clinical A–E harm scale (governance-owned). Unknown/slug types → 2.
export const SIGNAL_TYPE_SEVERITY: Record<string, number> = {
  drug_interaction: 3,
  dose_ceiling_exceeded: 3,
  schedule_x: 3,
  antibiotic_stewardship: 3,
  incomplete_dosing: 2,
  duplicate_prescription: 2,
  lasa_pair: 2,
  unverified_brand: 2,
  high_alert_medication: 2,
  prescribing_low_value: 2,
  prescribing_review: 2,
  appropriateness_low_value: 2,
  appropriateness_review: 2,
  appropriateness_general: 2,
  prescribing_general: 2,
  dose_ceiling_sos: 1,
  duplicate_molecule: 1,
  off_formulary: 1,
  appropriateness_high_value: 1,   // positive findings — lowest triage priority
  prescribing_high_value: 1,
  // Stage 3 longitudinal (D5e) — INFORMATIONAL, label-only. Never routes, never scores; they don't enter
  // the Action-queue ranking (buildQueue drops informational findings), so this weight is advisory only.
  longitudinal_repeat_test: 1,
  longitudinal_med_reconciliation: 1,
  longitudinal_missed_followup: 1,
  longitudinal_continuity: 1,
  longitudinal_contradiction: 1,
};

// ── Stage 3 (D5e) — routable partition + the 5 longitudinal (label-only) types ────────────────────────
/** The 5 Stage-3 longitudinal signal types. INFORMATIONAL + NON-routable: they earn promotion to the
 *  scored plane only through CM validity labels (never route/response). Kept in sync with
 *  opd-longitudinal-core's LONGITUDINAL_SIGNAL_TYPES (duplicated here to keep this core standalone). */
export const LONGITUDINAL_SIGNAL_TYPES = new Set<string>([
  'longitudinal_repeat_test', 'longitudinal_med_reconciliation', 'longitudinal_missed_followup',
  'longitudinal_continuity', 'longitudinal_contradiction',
]);
/** Additive routable flag per signal type (D5e). Longitudinal = false (label-only lane); all else route. */
export function isRoutable(signalType: string): boolean {
  return !LONGITUDINAL_SIGNAL_TYPES.has(signalType);
}
export function severityOf(signalType: string): number {
  return SIGNAL_TYPE_SEVERITY[signalType] ?? 2;
}
/** The severity weight → a Low/Med/High importance HINT the CM can accept or override. */
export function importanceHint(weight: number): Importance {
  return weight >= 3 ? 'high' : weight <= 1 ? 'low' : 'med';
}

// ── Inputs ────────────────────────────────────────────────────────────────────
export interface TriageFinding {
  audit_id: string;
  doctor_uid: string;
  note_date: string;               // YYYY-MM-DD (IST) or ISO
  subject: string;
  rationale: string;
  verdict: string;
  domain: string;
  signal_type: string;             // stamped upstream (stampFindingIdentity)
  finding_ref: string;             // stamped upstream
  informational?: boolean;
  citation_ids?: number[];
  // Right Care routing context (decision 16) — passthrough only, never affects ranking/grouping.
  complexity_band?: string | null;         // NEW_TO_US | LOW | MODERATE | HIGH | null
  complexity_inputs?: Record<string, unknown> | null;   // {chronic_codes, abnormal_labs, enc_12m, ...}
  lvc_category?: string | null;            // antibiotic | imaging | supplement_polypharmacy | other
  // Quieting (demote) passthrough — set when the engine quieted this finding (informational:true +
  // quieted_by:<rule_id>). Display/badging only; never affects ranking or the scored queue.
  quieted_by?: string | null;
}

export interface TriageDecisionRow {
  scope: 'type' | 'instance';
  doctor_uid: string;
  signal_type: string;
  audit_id?: string | null;
  finding_ref?: string | null;
  validity: string;
  bug_type?: string | null;
  importance?: string | null;
  routed: boolean;
  response_required?: string | null;
  reason?: string | null;
  cm_user?: string | null;
  created_at: string;              // ISO; newest wins
}

// ── Outputs ─────────────────────────────────────────────────────────────────
export interface TypeDecisionState {
  validity: string;
  bug_type: string | null;
  importance: string | null;
  routed: boolean;
  response_required: string | null;
  reason: string | null;
  cm_user: string | null;
  decided_at: string;
}
export interface TriageRepresentative {
  audit_id: string; finding_ref: string; subject: string; verdict: string;
  rationale: string; note_date: string; citation_ids: number[];
  complexity_band?: string | null; complexity_inputs?: Record<string, unknown> | null; lvc_category?: string | null;
}
export interface TypeGroup {
  signal_type: string;
  label: string;
  count: number;                   // instances (findings) of this type for this doctor in the window
  notes: number;                   // distinct notes carrying it
  severity_weight: number;         // 1..3 (advisory)
  importance_hint: Importance;
  concentrated: boolean;           // this doctor holds a large share of the window's instances of the type
  noisiest: boolean;               // top-ranked type for this doctor
  routable: boolean;               // D5e — false for the 5 longitudinal (label-only) types; true otherwise
  representative: TriageRepresentative;
  triage: TypeDecisionState | null; // current type-level decision, else null (untriaged)
  rank: number;
  // Quieting (demote): present only when buildQueue ran with includeQuieted (the CM's filter toggle,
  // default off). quieted_only groups render as passive cards (no decision pipeline — nothing scores).
  quieted_count?: number;
  quieted_rule?: string | null;    // rule id of the first quieted finding (badge: "quieted · rule N")
  quieted_only?: boolean;
}
export interface DoctorGroup {
  doctor_uid: string;
  name?: string;
  speciality?: string;
  notes: number;                   // distinct notes for this doctor in the window
  instances: number;               // total non-informational findings
  untriaged_types: number;
  max_importance_hint: Importance;
  types: TypeGroup[];
}

const LABELS: Record<string, string> = {
  drug_interaction: 'Drug interaction', incomplete_dosing: 'Incomplete dosing',
  duplicate_prescription: 'Duplicate prescription', unverified_brand: 'Unverified brand',
  lasa_pair: 'LASA pair co-prescribed', dose_ceiling_exceeded: 'Daily dose exceeds ceiling',
  dose_ceiling_sos: 'Dose may exceed ceiling if all SOS taken', duplicate_molecule: 'Same molecule in multiple products',
  high_alert_medication: 'High-alert medication', schedule_x: 'Schedule X drug', off_formulary: 'Off-formulary items',
  antibiotic_stewardship: 'Antibiotic stewardship',
  appropriateness_low_value: 'Low-value / inappropriate care', appropriateness_review: 'Appropriateness — needs review',
  appropriateness_high_value: 'High-value care (positive)',
  prescribing_low_value: 'Low-value / unsafe prescribing', prescribing_review: 'Prescribing — needs review',
  prescribing_high_value: 'Sound prescribing (positive)',
  appropriateness_general: 'Appropriateness (other)', prescribing_general: 'Prescribing safety (other)',
  // Stage 3 longitudinal (label-only lane).
  longitudinal_repeat_test: 'Redundant repeat test', longitudinal_med_reconciliation: 'Medication reconciliation',
  longitudinal_missed_followup: 'Unaddressed follow-up', longitudinal_continuity: 'Continuity of care',
  longitudinal_contradiction: 'Note contradicts the record',
};
function labelFor(signalType: string, subject: string): string {
  if (LABELS[signalType]) return LABELS[signalType];
  const head = (subject.split(':')[0] || signalType).replace(/\(.*?\)/g, '').trim();
  return head ? head.charAt(0).toUpperCase() + head.slice(1) : signalType;
}

const day = (d: string): string => (d || '').slice(0, 10);
const impRank = (i: Importance): number => (i === 'high' ? 3 : i === 'med' ? 2 : 1);

/** Newest type-level decision per (doctor_uid, signal_type). Instance overrides resolve at drill. */
function latestTypeDecisions(decisions: TriageDecisionRow[]): Map<string, TriageDecisionRow> {
  const out = new Map<string, TriageDecisionRow>();
  for (const d of decisions) {
    if (d.scope !== 'type') continue;
    const key = `${d.doctor_uid} ${d.signal_type}`;
    const prev = out.get(key);
    if (!prev || d.created_at > prev.created_at) out.set(key, d);
  }
  return out;
}
function toState(d: TriageDecisionRow): TypeDecisionState {
  return {
    validity: d.validity, bug_type: d.bug_type ?? null, importance: d.importance ?? null,
    routed: !!d.routed, response_required: d.response_required ?? null,
    reason: d.reason ?? null, cm_user: d.cm_user ?? null, decided_at: d.created_at,
  };
}

export interface BuildQueueOpts {
  names?: Record<string, string>;
  specialities?: Record<string, string>;
  /** 'untriaged' (default) hides types already decided; 'all' keeps them (collapsed receipts). */
  status?: 'untriaged' | 'all';
  /** Quieting filter toggle (default false): surface quieted (informational + quieted_by) findings
   *  as passive, badge-only groups/counts. Never changes the scored queue's grouping or ranking. */
  includeQuieted?: boolean;
}

/**
 * Group non-informational findings by doctor → signal_type, overlay the current triage decision,
 * and rank (severity × frequency; concentrated flagged). Returns doctors ranked by attention.
 */
export function buildQueue(
  findings: TriageFinding[],
  decisions: TriageDecisionRow[],
  opts: BuildQueueOpts = {},
): { doctors: DoctorGroup[] } {
  const status = opts.status ?? 'untriaged';
  const decisionByKey = latestTypeDecisions(decisions);

  // Window-wide instance count per signal_type → concentration (this doctor's share).
  const typeTotals = new Map<string, number>();
  for (const f of findings) if (!f.informational) typeTotals.set(f.signal_type, (typeTotals.get(f.signal_type) || 0) + 1);

  // doctor_uid → signal_type → findings
  const byDoc = new Map<string, Map<string, TriageFinding[]>>();
  // Quieting toggle: doctor_uid → signal_type → QUIETED findings (informational + quieted_by).
  // Collected only when includeQuieted; other informational findings stay invisible as always.
  const byDocQuieted = new Map<string, Map<string, TriageFinding[]>>();
  for (const f of findings) {
    if (f.informational) {
      if (opts.includeQuieted && f.quieted_by && f.doctor_uid) {
        const q = byDocQuieted.get(f.doctor_uid) || byDocQuieted.set(f.doctor_uid, new Map()).get(f.doctor_uid)!;
        (q.get(f.signal_type) || q.set(f.signal_type, []).get(f.signal_type)!).push(f);
      }
      continue;
    }
    if (!f.doctor_uid) continue;
    const byType = byDoc.get(f.doctor_uid) || byDoc.set(f.doctor_uid, new Map()).get(f.doctor_uid)!;
    (byType.get(f.signal_type) || byType.set(f.signal_type, []).get(f.signal_type)!).push(f);
  }

  const doctors: DoctorGroup[] = [];
  for (const [doctor_uid, byType] of byDoc.entries()) {
    const noteSet = new Set<string>();
    let instances = 0;
    let types: TypeGroup[] = [];

    for (const [signal_type, fs] of byType.entries()) {
      const weight = severityOf(signal_type);
      const notes = new Set(fs.map((f) => f.audit_id));
      for (const f of fs) noteSet.add(f.audit_id);
      instances += fs.length;
      const share = (typeTotals.get(signal_type) || fs.length) > 0 ? fs.length / (typeTotals.get(signal_type) || fs.length) : 0;
      const rep = fs[0];
      const decision = decisionByKey.get(`${doctor_uid} ${signal_type}`) || null;
      types.push({
        signal_type,
        label: labelFor(signal_type, rep.subject),
        count: fs.length,
        notes: notes.size,
        severity_weight: weight,
        importance_hint: importanceHint(weight),
        concentrated: share >= 0.5 && fs.length >= 3,
        noisiest: false,
        routable: isRoutable(signal_type),
        representative: {
          audit_id: rep.audit_id, finding_ref: rep.finding_ref, subject: rep.subject,
          verdict: rep.verdict, rationale: rep.rationale, note_date: day(rep.note_date),
          citation_ids: rep.citation_ids ?? [],
          complexity_band: rep.complexity_band ?? null, complexity_inputs: rep.complexity_inputs ?? null, lvc_category: rep.lvc_category ?? null,
        },
        triage: decision ? toState(decision) : null,
        rank: weight * 1000 + fs.length,
      });
    }

    // Quieting toggle: overlay quieted counts on existing groups; types where EVERY finding was
    // quieted become passive quieted_only cards (no decision pipeline — they score nothing).
    const quietedTypes = byDocQuieted.get(doctor_uid);
    if (opts.includeQuieted && quietedTypes) {
      for (const [signal_type, qfs] of quietedTypes.entries()) {
        const existing = types.find((t) => t.signal_type === signal_type);
        if (existing) { existing.quieted_count = qfs.length; existing.quieted_rule = qfs[0].quieted_by ?? null; continue; }
        const rep = qfs[0];
        types.push({
          signal_type, label: labelFor(signal_type, rep.subject), count: qfs.length,
          notes: new Set(qfs.map((f) => f.audit_id)).size,
          severity_weight: 1, importance_hint: 'low', concentrated: false, noisiest: false,
          routable: false,
          representative: {
            audit_id: rep.audit_id, finding_ref: rep.finding_ref, subject: rep.subject,
            verdict: rep.verdict, rationale: rep.rationale, note_date: day(rep.note_date),
            citation_ids: rep.citation_ids ?? [],
            complexity_band: rep.complexity_band ?? null, complexity_inputs: rep.complexity_inputs ?? null, lvc_category: rep.lvc_category ?? null,
          },
          triage: null, rank: 0,
          quieted_count: qfs.length, quieted_rule: rep.quieted_by ?? null, quieted_only: true,
        });
      }
    }

    // rank types: severity × frequency (rank desc), untriaged first within equal rank
    types.sort((a, b) => (b.rank - a.rank) || (Number(!!a.triage) - Number(!!b.triage)));
    if (types.length) types[0].noisiest = true;

    const untriagedTypes = types.filter((t) => !t.triage);
    if (status === 'untriaged') types = untriagedTypes;
    if (types.length === 0) continue; // nothing left to show for this doctor under this filter

    const maxHint: Importance = untriagedTypes.reduce<Importance>(
      (acc, t) => (impRank(t.importance_hint) > impRank(acc) ? t.importance_hint : acc), 'low');

    doctors.push({
      doctor_uid,
      name: opts.names?.[doctor_uid],
      speciality: opts.specialities?.[doctor_uid],
      notes: noteSet.size,
      instances,
      untriaged_types: untriagedTypes.length,
      max_importance_hint: maxHint,
      types,
    });
  }

  // rank doctors by attention: most untriaged types of the highest severity, then volume
  doctors.sort((a, b) => {
    const ai = impRank(a.max_importance_hint), bi = impRank(b.max_importance_hint);
    if (ai !== bi) return bi - ai;
    if (a.untriaged_types !== b.untriaged_types) return b.untriaged_types - a.untriaged_types;
    return b.instances - a.instances;
  });

  return { doctors };
}

// ── Decision validation (spec §3.2) ───────────────────────────────────────────
export interface DecisionInput {
  scope?: string;
  doctor_uid?: string;
  signal_type?: string;
  audit_id?: string | null;
  finding_ref?: string | null;
  window_from?: string | null;
  window_to?: string | null;
  validity?: string;
  bug_type?: string | null;
  importance?: string | null;
  routed?: boolean;
  response_required?: string | null;
  reason?: string | null;
  cm_user?: string | null;
}
export interface NormalizedDecision {
  scope: 'type' | 'instance';
  doctor_uid: string;
  signal_type: string;
  audit_id: string | null;
  finding_ref: string | null;
  window_from: string | null;
  window_to: string | null;
  validity: Validity;
  bug_type: BugType | null;
  importance: Importance | null;
  routed: boolean;
  response_required: ResponseRequired | null;
  reason: string | null;
  cm_user: string | null;
}
const inSet = <T extends string>(arr: readonly T[], v: unknown): v is T => typeof v === 'string' && (arr as readonly string[]).includes(v);
const dstr = (v: unknown, cap = 500): string | null => (v == null || v === '' ? null : String(v).slice(0, cap));

/**
 * Validate + normalize one CM decision. Enforces (spec §3.2):
 *  - scope ∈ {type, instance}; instance requires audit_id + finding_ref
 *  - validity ∈ {valid_signal, audit_bug}
 *  - audit_bug ⇒ bug_type required, routed forced false, no importance/response
 *  - valid_signal ⇒ importance required
 *  - routed ⇒ response_required required (and valid); not routed ⇒ response_required cleared
 */
export function validateDecision(input: DecisionInput): { ok: true; value: NormalizedDecision } | { ok: false; error: string } {
  const scope = input.scope === 'instance' ? 'instance' : input.scope === 'type' ? 'type' : null;
  if (!scope) return { ok: false, error: 'scope must be "type" or "instance"' };
  const doctor_uid = dstr(input.doctor_uid, 64);
  if (!doctor_uid) return { ok: false, error: 'doctor_uid required' };
  const signal_type = dstr(input.signal_type, 80);
  if (!signal_type) return { ok: false, error: 'signal_type required' };
  if (!inSet(VALIDITY, input.validity)) return { ok: false, error: 'validity must be valid_signal or audit_bug' };

  let audit_id: string | null = dstr(input.audit_id, 64);
  let finding_ref: string | null = dstr(input.finding_ref, 32);
  if (scope === 'instance') {
    if (!audit_id || !finding_ref) return { ok: false, error: 'instance scope requires audit_id and finding_ref' };
  } else { audit_id = null; finding_ref = null; }

  let bug_type: BugType | null = null;
  let importance: Importance | null = null;
  let routed = false;
  let response_required: ResponseRequired | null = null;

  if (input.validity === 'audit_bug') {
    if (!inSet(BUG_TYPES, input.bug_type)) return { ok: false, error: 'audit_bug requires bug_type (process_bug|structural_bug)' };
    bug_type = input.bug_type;
    routed = false;                       // an audit bug is never routed to a doctor
  } else {
    if (!inSet(IMPORTANCE, input.importance)) return { ok: false, error: 'valid_signal requires importance (low|med|high)' };
    importance = input.importance;
    routed = input.routed === true;
    if (routed) {
      if (!inSet(RESPONSE_REQUIRED, input.response_required)) {
        return { ok: false, error: 'routed=true requires response_required (none|explanation|acknowledgment|recommend_privilege_review)' };
      }
      response_required = input.response_required;
    }
  }

  return {
    ok: true,
    value: {
      scope, doctor_uid, signal_type, audit_id, finding_ref,
      window_from: dstr(input.window_from, 10), window_to: dstr(input.window_to, 10),
      validity: input.validity, bug_type, importance, routed, response_required,
      reason: dstr(input.reason, 1000), cm_user: dstr(input.cm_user, 64),
    },
  };
}

// ── Feature C — CM instrumentation events (Gold-Label Review-Mode §5, §1.5) ─────
//
// ⚠️ GROUNDED DEVIATION / SEMANTIC NOTE (flagged in the build report): the /care/triage board is a
// batch validity→importance→route decision surface, NOT a per-item open→dismiss/resolve lifecycle.
// Review-Mode §5 assumes a status lifecycle with "dismiss" and "resolution" transitions. We map the
// board's terminal dispositions to those transitions:
//   · audit_bug ("Junk all N")      → to_status='dismissed'  (kind 'dismiss'    → dismiss reason chip)
//   · valid_signal + NOT routed     → to_status='dismissed'  (kind 'dismiss'    → dismiss reason chip)
//   · valid_signal + routed         → to_status='routed'     (kind 'resolution' → resolution outcome chip)
// The 'unable_to_contact'/'resolved_with_doctor' outcomes presume post-routing doctor engagement the
// board doesn't model, so the resolution-outcome mapping is the genuinely-stretched part — see report.
// Events are WORKFLOW TELEMETRY (append-only opd_triage_events), never clinical labels; no decision
// behavior changes. This pure core only classifies + validates; the row is written best-effort.

export const DISMISS_REASONS = ['not_clinically_relevant', 'already_addressed', 'patient_constraint', 'other'] as const;
export const RESOLUTION_OUTCOMES = ['resolved_with_doctor', 'resolved_no_action_needed', 'unable_to_contact', 'other'] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];
export type TransitionKind = 'dismiss' | 'resolution';

export interface TransitionClass { to_status: string; kind: TransitionKind }

/** Map a decision's disposition to the transition it represents + the chip it requires (§5). */
export function classifyTransition(d: { validity?: string; routed?: boolean }): TransitionClass {
  if (d.validity === 'audit_bug') return { to_status: 'dismissed', kind: 'dismiss' };
  if (!d.routed) return { to_status: 'dismissed', kind: 'dismiss' };
  return { to_status: 'routed', kind: 'resolution' };
}

/** The controlled chip vocabulary for a transition kind. */
export function chipVocab(kind: TransitionKind): readonly string[] {
  return kind === 'dismiss' ? DISMISS_REASONS : RESOLUTION_OUTCOMES;
}

/** §1.5 friction cap: dismiss requires a reason chip, resolution requires an outcome chip; the chip
 *  must be in the kind's vocabulary. Free text is validated separately and is ALWAYS optional. */
export function requireChip(kind: TransitionKind, chip: unknown): { ok: true; chip: string } | { ok: false; error: string } {
  const v = chip == null ? '' : String(chip);
  const vocab = chipVocab(kind);
  if (!v) return { ok: false, error: `${kind === 'dismiss' ? 'dismiss' : 'resolution'} requires a ${kind === 'dismiss' ? 'reason' : 'outcome'} chip` };
  if (!(vocab as readonly string[]).includes(v)) return { ok: false, error: `chip must be one of ${vocab.join(', ')}` };
  return { ok: true, chip: v };
}

export interface TriageEventInput {
  app_source?: string | null;
  triage_id?: string | null;    // the opd_audit_triage row this event annotates
  audit_id?: string | null;
  uid?: string | null;
  actor?: string | null;
  from_status?: string | null;
  validity?: string;
  routed?: boolean;
  chip?: string | null;         // the required dismiss-reason / resolution-outcome chip
  note?: string | null;         // optional free text (never required)
}
export interface TriageEventRow {
  app_source: string;
  triage_id: string | null;
  audit_id: string | null;
  uid: string | null;
  actor: string | null;
  from_status: string | null;
  to_status: string;
  reason: string;               // the chip value
  note: string | null;
}

/** Validate + normalize one telemetry event row (append-only opd_triage_events). Enforces the chip
 *  requirement for the transition kind; free text optional. Returns row-ready columns or an error. */
export function buildTriageEvent(input: TriageEventInput): { ok: true; value: TriageEventRow } | { ok: false; error: string } {
  const { to_status, kind } = classifyTransition({ validity: input.validity, routed: input.routed });
  const chip = requireChip(kind, input.chip);
  if (!chip.ok) return { ok: false, error: chip.error };
  return {
    ok: true,
    value: {
      app_source: dstr(input.app_source, 64) || 'standalone',
      triage_id: dstr(input.triage_id, 64),
      audit_id: dstr(input.audit_id, 64),
      uid: dstr(input.uid, 64),
      actor: dstr(input.actor, 64),
      from_status: dstr(input.from_status, 40),
      to_status,
      reason: chip.chip,
      note: dstr(input.note, 2000),
    },
  };
}

// ── Stage 3 (D5) — the label-only lane + promotion-gate meter (the normative triage mockup) ───────────
export type PromotionStatus = 'eligible' | 'collecting' | 'failing';
export const PROMOTION_FP_CEILING = 0.20;      // gate ceiling: FP-rate must be < 20%
export const PROMOTION_MIN_LABELLED = 50;      // gate floor: ≥ 50 CM-labelled instances
export interface PromotionGate {
  labelled: number;      // corpus-wide labelled instances of the type
  fpRate: number;        // 0..1 false-positive (audit_bug) rate over the labelled set
  threshold: number; minLabelled: number;
  status: PromotionStatus; eligible: boolean;
}
/** The gate a longitudinal type must clear to become score-eligible (a future 0.9 step): FP-rate < 20%
 *  over ≥ 50 CM-labelled instances. Reads the SAME signal-health FP-rate machinery already tracking
 *  scored signals — a failing type renders "not eligible → signal-health review", NEVER auto-promotes. */
export function promotionGate(labelled: number, fpRate: number): PromotionGate {
  const n = Math.max(0, Math.floor(Number(labelled) || 0));
  const fp = Number.isFinite(fpRate) ? Math.max(0, Math.min(1, fpRate)) : 1;
  const status: PromotionStatus = n < PROMOTION_MIN_LABELLED ? 'collecting' : (fp < PROMOTION_FP_CEILING ? 'eligible' : 'failing');
  return { labelled: n, fpRate: fp, threshold: PROMOTION_FP_CEILING, minLabelled: PROMOTION_MIN_LABELLED, status, eligible: status === 'eligible' };
}

export interface LabelLaneInstance { audit_id: string; finding_ref: string; subject: string; rationale: string; note_date: string }
export interface LabelLaneType {
  signal_type: string; label: string; count: number; notes: number;
  gate: PromotionGate | null;            // null until a signal-health FP-rate is supplied for the type
  triage: TypeDecisionState | null;      // current type-level validity label (valid_signal | audit_bug)
  instances: LabelLaneInstance[];
}
export interface BuildLabelLaneOpts { gates?: Record<string, { labelled: number; fpRate: number }> }
/**
 * Build the /care/triage LABEL-ONLY lane (PRD §6 / normative mockup). Partitions the INFORMATIONAL,
 * non-routable longitudinal findings by signal_type, overlays the current type validity label + the
 * promotion-gate meter (fed from the existing signal-health FP-rate). Label-only — no route/response.
 */
export function buildLabelLane(findings: TriageFinding[], decisions: TriageDecisionRow[], opts: BuildLabelLaneOpts = {}): { types: LabelLaneType[] } {
  const decisionByKey = latestTypeDecisions(decisions);
  const byType = new Map<string, TriageFinding[]>();
  for (const f of findings) {
    if (!f.signal_type || isRoutable(f.signal_type)) continue;   // longitudinal (non-routable) only
    (byType.get(f.signal_type) || byType.set(f.signal_type, []).get(f.signal_type)!).push(f);
  }
  const types: LabelLaneType[] = [];
  for (const [signal_type, fs] of byType.entries()) {
    const notes = new Set(fs.map((f) => f.audit_id));
    const g = opts.gates?.[signal_type];
    const dec = decisionByKey.get(`${(fs[0]?.doctor_uid) || ''} ${signal_type}`) || null;
    types.push({
      signal_type, label: LABELS[signal_type] || signal_type, count: fs.length, notes: notes.size,
      gate: g ? promotionGate(g.labelled, g.fpRate) : null,
      triage: dec ? toState(dec) : null,
      instances: fs.map((f) => ({ audit_id: f.audit_id, finding_ref: f.finding_ref, subject: f.subject, rationale: f.rationale, note_date: day(f.note_date) })),
    });
  }
  types.sort((a, b) => (b.count - a.count) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));   // loudest first
  return { types };
}
