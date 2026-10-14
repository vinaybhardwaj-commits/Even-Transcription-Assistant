/**
 * lib/severity-tier-core.ts — severity tiers for OPD findings (U1-A; PRD
 * CDMSS-U1-REPORT-AND-CLASS-PRD v1.0 §1, table ratified in
 * CDMSS-SEVERITY-TIER-TABLE-v1.0-RATIFIED-1-AUG-2026.md).
 *
 * PURE AND DEPENDENCY-FREE — no ./db, no ./llm, no next/*. The tier is DERIVED AT READ TIME from
 * the finding's existing fields (signal_type, verdict, subject, rationale): no stored column, no
 * migration, recomputable for any historical finding. THE MODEL NEVER ASSIGNS A TIER (O1a) — the
 * escalation list below is deterministic regex over the finding's own text, in the manner of
 * SIGNAL_TYPE_RULES, and under V's control.
 *
 * Tiers: 1 = escalate now (possible active patient risk) · 2 = act this week · 3 = log only
 * (rendered as a COUNT, never as rows — that is the entire point). Praise (O1b) sits OUTSIDE the
 * tier list: stored exactly as before, excluded from the action list, shown as a count. An
 * unknown kind defaults to tier 2 and is counted (O1c) — production holds 61 kinds against 29
 * declared (the vocabulary leak, recorded separately in the ratified table §5), so a kind absent
 * from this table must never be dropped from a report.
 */

export interface TierableFinding {
  signal_type?: string;
  verdict?: string;
  domain?: string;
  confidence?: number;
  subject?: string;
  rationale?: string;
  informational?: boolean;
}

export type SeverityTier = 1 | 2 | 3;

export interface TierResult {
  tier: SeverityTier | 'praise';
  /** the escalation entry that promoted to tier 1, when one did */
  escalatedBy?: 'E-1' | 'E-2';
  /** O1c — the kind was not in the ratified table and took the tier-2 default */
  unlistedKind: boolean;
  reason: string;
}

// ── The ratified table (§2) — exact transcription, no additions ───────────────
const TIER2_KINDS = new Set([
  'drug_interaction', 'dose_ceiling_exceeded', 'dose_ceiling_sos', 'banned_fdc', 'lasa_pair',
  'duplicate_prescription', 'schedule_x',
  'low_value_care', 'appropriateness_review', 'appropriateness_low_value',
  'prescribing_review', 'prescribing_low_value',
  'longitudinal_missed_followup', 'longitudinal_med_reconciliation', 'longitudinal_repeat_test',
  'longitudinal_continuity', 'longitudinal_contradiction',
]);

const TIER3_KINDS = new Set([
  'unverified_brand', 'off_formulary', 'coding_completeness', 'high_alert_medication',
  'duplicate_molecule', 'muscle_relaxant_indication', 'vitamin_d_repletion_duration',
  'pregnancy_risk_verify', 'screening_context', 'metadata_accuracy',
  'contradicted_medication_present', 'contradicted_drug_class_absent',
  'contradicted_indication_present', 'contradicted_ratified_rule', 'contradicted_route',
  'contradicted_investigation_absent', 'contradicted_history',
  'incoherent_with_suggestion', 'pretest_niche',
  // DETERMINISM-TRIO PRD v1.0 D-3 (V ratified in that decisions log, 8 Aug 2026): a near-match to a
  // banned combination is a MEASUREMENT — informational, confidence 0, never scoring — so it is
  // tier 3, rendered as a count and never as an action row. Deliberately NOT in SAFETY_SIGNAL_TYPES:
  // the exact-match check (banned_fdc, tier 2) is the safety signal; this one is its instrument.
  'banned_fdc_near_miss',
]);

const PRAISE_KINDS = new Set(['appropriateness_high_value', 'prescribing_high_value']);

// ── The escalation list (§3) — TWO seed entries, from V's findings 36 and 49. ─────────────────
// Matched against subject + rationale. Grows FROM REAL CASES ONLY: when a finding should have been
// tier 1 and was not, it becomes an entry. Do not add speculative patterns.
//
// E-1 — a time-critical diagnosis routed anywhere other than emergency assessment (finding 36).
const E1_RE = /\bacute coronary syndrome\b|\bACS\b|\bunstable angina\b|\bmyocardial infarction\b|\bexertional chest (?:pain|heaviness)\b/i;

// E-2 — a possible malignancy with no follow-through (finding 49): persistent/unexplained
// mass · lymphadenopathy · swelling, WITH a documented duration ≥ 4 weeks, AND no investigation or
// follow-up in the same finding. E-2 reads the RATIONALE and is stated in the ratified table to be
// less reliable than E-1 — an escalation whose seriousness never reaches the finding text will not
// be caught; that is the accepted cost of keeping tier 1 out of the model's hands.
const E2_ENTITY_RE = /\b(?:persistent|unexplained)\b[\s\S]{0,80}?\b(?:mass|lymphadenopathy|swelling)\b|\b(?:mass|lymphadenopathy|swelling)\b[\s\S]{0,80}?\b(?:persistent|unexplained)\b/i;
const E2_WEEKS_RE = /\b(\d+(?:\.\d+)?)\s*(?:weeks?|wks?)\b/i;
const E2_MONTHS_RE = /\b(\d+(?:\.\d+)?)\s*months?\b/i;
const E2_WORD_DURATION_RE = /\b(?:four|five|six|seven|eight|nine|ten|eleven|twelve)\s+weeks?\b|\b(?:a|one|two|three|four|five|six)\s+months?\b/i;
// "…in the same finding": an investigation/follow-up counts only when the text says one WAS
// ordered/planned — a NEGATED mention ("no investigation ordered") must not count, so negated
// spans are removed before the presence test.
const E2_NEGATION_STRIP_RE = /\b(?:no|not|without|never|lacks?|lacking|absen(?:t|ce of))\b[^.;]{0,80}/gi;
const E2_FOLLOWTHROUGH_RE = /\b(?:investigation|ultrasound|usg|imaging|biopsy|fnac|work[\s-]?up|referr(?:al|ed))\b[\s\S]{0,50}?\b(?:ordered|done|advised|planned|requested|arranged|completed)\b|\b(?:ordered|advised|planned|arranged)\b[\s\S]{0,50}?\b(?:investigation|ultrasound|usg|imaging|biopsy|fnac|work[\s-]?up|referral)\b|\bfollow[\s-]?up\b[\s\S]{0,40}?\b(?:date|advised|planned|scheduled|booked|in \d)/i;

function e2DurationAtLeast4Weeks(text: string): boolean {
  const w = text.match(E2_WEEKS_RE);
  if (w && parseFloat(w[1]) >= 4) return true;
  const mo = text.match(E2_MONTHS_RE);
  if (mo && parseFloat(mo[1]) >= 1) return true;
  return E2_WORD_DURATION_RE.test(text);
}

/** The escalation entry (if any) matching this finding's own text. Exported for the panel/tests. */
export function escalationMatch(f: TierableFinding): 'E-1' | 'E-2' | undefined {
  const text = `${f.subject || ''} ${f.rationale || ''}`;
  if (E1_RE.test(text)) return 'E-1';
  if (E2_ENTITY_RE.test(text) && e2DurationAtLeast4Weeks(text)) {
    const deNegated = text.replace(E2_NEGATION_STRIP_RE, ' ');
    if (!E2_FOLLOWTHROUGH_RE.test(deNegated)) return 'E-2';
  }
  return undefined;
}

// ── The two kinds that split (§4) ─────────────────────────────────────────────
// incomplete_dosing keys on WHICH FIELD is missing. The finding's rationale carries the exact
// list ("Missing dose/strength, duration — …", prescribingChecks). Ratified rows: missing strength
// on a single-strength product → 3; missing duration on a chronic continuation → 3. The two
// ratified tier-2 conditions (missing SOS daily cap · missing wash-off instructions) are emitted
// by OTHER kinds (dose_ceiling_sos's assumed-cap advisory; free-text) — both already tier 2. A
// missing FREQUENCY or ROUTE changes what the patient physically does with the drug, so those
// take tier 2; a rationale whose missing-list cannot be parsed also takes tier 2 (the
// conservative direction, consistent with O1c).
function incompleteDosingTier(f: TierableFinding): { tier: SeverityTier; reason: string } {
  const m = (f.rationale || '').match(/^Missing ([^—]+?)(?:—|$)/i);
  if (!m) return { tier: 2, reason: 'incomplete_dosing — missing-field list unparseable, conservative tier 2' };
  const fields = m[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const logOnly = fields.every((x) => x === 'dose/strength' || x === 'duration');
  return logOnly
    ? { tier: 3, reason: `incomplete_dosing — missing ${fields.join(', ')} (does not change what the patient does; ratified §4)` }
    : { tier: 2, reason: `incomplete_dosing — missing ${fields.join(', ')} (changes what the patient does)` };
}

// ── tierFor — the one derivation ──────────────────────────────────────────────
export function tierFor(f: TierableFinding): TierResult {
  const kind = String(f.signal_type || '').trim();

  // Praise first (O1b + §4: key on the VERDICT, not the kind — antibiotic_stewardship praise
  // routes here; so does every *_high_value bucket). Praise never escalates: a finding praising
  // an appropriate ACS referral must not land in tier 1.
  if (f.verdict === 'high-value' || PRAISE_KINDS.has(kind)) {
    return { tier: 'praise', unlistedKind: false, reason: 'praise — excluded from the tiered action list, counted (O1b)' };
  }

  // Escalation (§3) — promotes ANY non-praise finding whose own text names the pattern.
  const esc = escalationMatch(f);
  if (esc) return { tier: 1, escalatedBy: esc, unlistedKind: false, reason: `escalated by ${esc}` };

  // The two splits (§4).
  if (kind === 'incomplete_dosing') { const r = incompleteDosingTier(f); return { ...r, unlistedKind: false }; }
  if (kind === 'antibiotic_stewardship') {
    return { tier: 2, unlistedKind: false, reason: 'antibiotic_stewardship — non-praise verdict is a violation (§4)' };
  }

  // The ratified lookup (§2).
  if (TIER3_KINDS.has(kind)) return { tier: 3, unlistedKind: false, reason: `${kind} — ratified tier 3 (log only)` };
  if (TIER2_KINDS.has(kind)) return { tier: 2, unlistedKind: false, reason: `${kind} — ratified tier 2` };

  // O1c — unknown kind: tier 2, counted, never dropped.
  return { tier: 2, unlistedKind: true, reason: `${kind || '(no signal_type)'} — not in the ratified table; tier-2 default (O1c)` };
}

// ── Report helpers (shared by the surface and any future rollup) ──────────────
export interface TierBuckets<T> {
  tier1: T[]; tier2: T[];
  tier3: T[]; praise: T[];
  /** O1c counter — how many landed in tier 2 because their kind was not in the table */
  unlisted: number;
}

export function bucketByTier<T extends TierableFinding>(findings: T[]): TierBuckets<T> {
  const out: TierBuckets<T> = { tier1: [], tier2: [], tier3: [], praise: [], unlisted: 0 };
  for (const f of findings) {
    const r = tierFor(f);
    if (r.unlistedKind) out.unlisted += 1;
    if (r.tier === 'praise') out.praise.push(f);
    else if (r.tier === 1) out.tier1.push(f);
    else if (r.tier === 3) out.tier3.push(f);
    else out.tier2.push(f);
  }
  return out;
}

// ── C17 — twin deduplication (PRD §1.4) ───────────────────────────────────────
// TWINS: the same clinical decision surfacing as two rows — same finding_ref, same clinician,
// same calendar day (V's findings 11 + 14: identical template, three minutes apart). Collapsed to
// one row with an occurrence count. TWO FINDINGS ON ONE NOTE ARE NOT DUPLICATES and are left
// alone — finding_ref is collision-suffixed within a note, so within-note refs never collide.
// The reporting unit MUST be stated on any surface using this (PRD §1.4). Pure; the caller
// supplies (doctorUid, noteDate) per row because a bare finding does not carry them. NOTE: no
// current surface renders cross-note finding rows, so this ships as the canonical helper for the
// first one that does (flagged in the build report).
export interface TwinKeyedRow<T> { finding: T; findingRef: string | null | undefined; doctorUid: string | null | undefined; noteDate: string | null | undefined }
export interface DedupedRow<T> { finding: T; occurrences: number }

export function dedupeTwins<T>(rows: TwinKeyedRow<T>[]): DedupedRow<T>[] {
  const seen = new Map<string, DedupedRow<T>>();
  const out: DedupedRow<T>[] = [];
  for (const r of rows) {
    const day = String(r.noteDate || '').slice(0, 10);   // note_date::date
    const key = r.findingRef && r.doctorUid && day ? `${r.findingRef}|${r.doctorUid}|${day}` : null;
    if (!key) { out.push({ finding: r.finding, occurrences: 1 }); continue; }   // unkeyable rows never merge
    const prev = seen.get(key);
    if (prev) { prev.occurrences += 1; continue; }
    const row: DedupedRow<T> = { finding: r.finding, occurrences: 1 };
    seen.set(key, row);
    out.push(row);
  }
  return out;
}
