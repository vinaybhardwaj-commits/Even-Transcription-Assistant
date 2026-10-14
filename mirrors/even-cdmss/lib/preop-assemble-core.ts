/**
 * lib/preop-assemble-core.ts — turning many observations into ONE set of instrument
 * inputs, and one set of inputs into ONE snapshot (PRD v1.1-LOCKED §5, §7, §8;
 * Build Plan B1).
 *
 * NO database, NO fetch, NO clock, NO model. The clock is the caller's: `computedAt`
 * and `daysToSurgery` arrive as arguments so this file stays testable and so two
 * snapshots computed from the same evidence are byte-identical whenever they run.
 *
 * THREE JOBS
 *
 * 1 · SOURCE PRECEDENCE (mockup note 3). Several sources may back one input; the
 *     highest-precedence one SCORES it and the rest corroborate:
 *         LAB / PAC-mapped  >  BOOKING  >  EXTRACTED
 *     LAB and PAC tie deliberately — a mapped PAC field and an Eka lab value are both
 *     the primary record of what they describe, and they describe different things.
 *     Ties break on the most recent observation, then on input order, so the result is
 *     a pure function of the observation list.
 *
 * 2 · CONFLICT TAGGING. When a losing observation asserts the OPPOSITE status the input
 *     is tagged `conflict` and both chips render (mockup note 3). The conflict never
 *     changes the score — precedence already decided that — it changes what the reader
 *     is shown, which is the honest handling of two records that disagree.
 *
 * 3 · THE CONFIDENCE FLOOR (PRD §7). An EXTRACTED observation below the floor is
 *     DROPPED, not down-weighted, and the input falls back to whatever else backs it —
 *     usually nothing, i.e. UNKNOWN, which widens the instrument to a range. This is the
 *     PRD's "low-confidence extraction feeds the same §8 degradation machinery as a
 *     missing input. No new uncertainty concept."
 *
 * CLOSED WORLD, STATED OUT LOUD. A booking form ENUMERATES a patient's comorbidities,
 * so a comorbidity absent from a form that exists is `absent`, not `unknown` — that is
 * the only reason Lakshmamma's booking-only Charlson is a point score of 3 rather than a
 * range from 3 to 27. Inputs that no enumeration can close (creatinine, functional
 * status, the procedure's risk class, age) are `unknown` until something observes them.
 * If there is no booking form at all, nothing is closed and everything is unknown.
 */

import {
  charlsonCategories, computeCharlson, computeMfi5, computeRcri,
  CHARLSON_CATEGORIES, PREOP_INSTRUMENTS_VERSION,
  type CharlsonCategoryId, type InstrumentScore, type Tri,
} from './preop-instruments-core';
import {
  cardLines, computeTier,
  type EpisodeContext, type TierResult,
} from './preop-tier-core';

/**
 * Bumped when precedence, the floor, the closed-world set or the snapshot shape change.
 *
 * ⚠️ B5 (27 Aug 2026) CHANGED THE RESOLUTION AND DELIBERATELY DID NOT BUMP THIS. The rule
 * now resolves deterministic observations first and alone, and lets an extraction decide
 * only where they are silent. With PREOP_EXTRACT_ENABLED off — how Slice 1 ships — there
 * are no extracted observations to resolve, so the reading is byte-identical to
 * preop-assemble/1 as shipped, proven by the whole-snapshot equality assertion in
 * preop-d4-boundary.test.ts and by the four mockup patients reproducing unchanged.
 *
 * This constant is INSIDE the snapshot fingerprint. Bumping it for a change that provably
 * moves no reading would mint a version row for every episode on the board and put a step
 * into a clinical timeline that says nothing happened — the same trap B4 hit when the PAC
 * workflow status briefly entered the fingerprint. The flip of the extraction flag is
 * itself the A/B boundary, and the snapshots that re-mint on that day will re-mint for a
 * reason a reader can see.
 */
export const PREOP_ASSEMBLE_RULE_VERSION = 'preop-assemble/1';

// ── sources and precedence ──────────────────────────────────────────────────────

export type PreopSource = 'HUMAN' | 'LAB' | 'PAC' | 'RX' | 'BOOKING' | 'OPD' | 'EXTRACTED';

/**
 * Lower rank wins. LAB and PAC tie at the top on purpose (see the header); BOOKING and
 * OPD tie one below, because both are "the record says so" — a form the patient filled
 * and an ICD code a doctor coded — and neither is a measurement. A disagreement between
 * them raises the conflict tag rather than being silently resolved by fiat.
 *
 * ⚠️ OPD is a FIFTH source, and the approved mockup's provenance legend draws four
 * chips. Flagged for V at B4: the PRD's own data registry (§4) names "OPD visits /
 * ClinicalState — history corroboration, diagnoses" as a source, and its diagnoses
 * arrive as STRUCTURED ICD codes on individuals-prescriptions — deterministic, no model
 * anywhere near them, so labelling them EXTRACTED would be a lie about where they came
 * from and would wrongly hide them when the extraction flag is off.
 */
export const SOURCE_RANK: Record<PreopSource, number> = {
  HUMAN: -1, LAB: 0, PAC: 0, RX: 0, BOOKING: 1, OPD: 1, EXTRACTED: 2,
};

/**
 * B8 added two sources at the ends of that scale, and both deserve a sentence.
 *
 * HUMAN (-1) outranks everything. It is not "a model, but trusted": it is a named clinician
 * who was shown a verbatim span on the case page and pressed Confirm, with their identity
 * and the moment recorded in `preop_suggestion_decisions`. Nothing else in this module has
 * a person's name attached to it, and if a person who has read the note disagrees with the
 * record, the person wins. The audit trail is what makes that safe.
 *
 * RX (0) ties with LAB and PAC. A medication line is a primary record of what the patient
 * is actually taking, and the only inputs it may establish are the ones whose published
 * definition IS a treatment (RX_DEFINITIONAL_INPUTS) — so an RX observation and a mapped
 * PAC field are two primary records of two different things, exactly like the LAB/PAC tie
 * above. What RX may never do is name a diagnosis; that ban is a category, enforced in
 * lib/preop-harvest-core.ts and pinned by test.
 */

/**
 * Below this, an EXTRACTED observation is dropped and its input reverts to UNKNOWN.
 * 0.80 is a STARTING floor, not a measured one — B5 measures the extraction rail on the
 * golden set and V moves it by PRD amendment if the measurement says so. Flagged.
 */
export const EXTRACT_CONFIDENCE_FLOOR = 0.8;

// ── the canonical input space ───────────────────────────────────────────────────
//
// The union of the three instruments' inputs. Ids are SHARED where the clinical fact is
// shared: one `congestive_heart_failure` observation feeds RCRI, mFI-5 and Charlson at
// once. That sharing is exactly why the mockup insists mFI-5 and Charlson are read as
// two correlated lenses and not as independent confirmation (PRD §3).

export type PreopInputId =
  | 'high_risk_surgery' | 'ischaemic_heart_disease' | 'congestive_heart_failure'
  | 'cerebrovascular_disease' | 'insulin_treated_diabetes' | 'creatinine_over_2'
  | 'functional_status_dependent' | 'diabetes_mellitus' | 'copd_or_pneumonia'
  | 'hypertension_on_medication'
  | CharlsonCategoryId
  | 'age';

/**
 * Inputs a booking comorbidity enumeration can close the world over. Everything NOT in
 * this set stays UNKNOWN until something actually observes it.
 */
export const ENUMERATED_INPUTS: ReadonlySet<PreopInputId> = new Set<PreopInputId>([
  'ischaemic_heart_disease', 'congestive_heart_failure', 'cerebrovascular_disease',
  'insulin_treated_diabetes', 'diabetes_mellitus', 'copd_or_pneumonia',
  'hypertension_on_medication',
  ...CHARLSON_CATEGORIES.map((c) => c.id),
]);

/** Never closed by an enumeration — a form that lists comorbidities says nothing here. */
export const NEVER_ENUMERATED: ReadonlySet<PreopInputId> = new Set<PreopInputId>([
  'high_risk_surgery', 'creatinine_over_2', 'functional_status_dependent', 'age',
]);

// ── observations in, resolved inputs out ────────────────────────────────────────

/** One source's assertion about one input. An observation always asserts something —
 *  "unknown" is the ABSENCE of an observation, never an observation of its own. */
export interface Observation {
  inputId: PreopInputId;
  status: 'present' | 'absent';
  /** short evidence text the card prints in parentheses, e.g. 'MI 2019' */
  detail?: string | null;
  /** the underlying value where there is one, e.g. 1.4 for creatinine */
  value?: string | number | null;
  source: PreopSource;
  /** the row/document this came from — the provenance chip's link-back */
  provenanceRef?: string | null;
  /** ISO timestamp of the observation (not of the read) — breaks precedence ties */
  observedAt?: string | null;
  /** EXTRACTED only; compared against the floor */
  confidence?: number | null;
  /** EXTRACTED only; the DERIVED model label, never a typed one (house rule) */
  extractedBy?: string | null;
  /** EXTRACTED only (B5); the VERBATIM source span the model copied. Displayed on the
   *  factor row; deliberately NOT part of the snapshot fingerprint, so a re-worded
   *  quotation that carries the same answer mints no version. */
  sourceSpan?: string | null;
  /** EXTRACTED only (B5); a re-extraction of UNCHANGED text disagreed with the stored
   *  reading. The stored reading still stands — this says it is not reproducible. */
  unstable?: boolean;
  /** EXTRACTED only (B5); the span reads as a negation while the status says present.
   *  MARKED, never removed — see lib/preop-extract-core.ts. */
  polaritySuspect?: boolean;
}

export interface ResolvedInput {
  inputId: PreopInputId;
  status: Tri;
  detail: string | null;
  value: string | number | null;
  /** null when the status is 'unknown' or came from the closed-world rule */
  source: PreopSource | null;
  provenanceRef: string | null;
  observedAt: string | null;
  confidence: number | null;
  extractedBy: string | null;
  /** the losing observations that AGREE — they corroborate, they do not score */
  corroborating: Observation[];
  /** a losing observation asserts the opposite status */
  conflict: boolean;
  /** EXTRACTED observations dropped below the floor — shown so the drop is not silent */
  droppedBelowFloor: Observation[];
  /** true when 'absent' came from the closed-world rule rather than from an observation */
  closedWorld: boolean;
  /** B5: the winning observation's verbatim source span (EXTRACTED only) */
  sourceSpan: string | null;
  /** B5: the winning EXTRACTED reading is not reproducible on unchanged text */
  unstable: boolean;
  /** B5: the winning EXTRACTED span reads as a negation while asserting presence */
  polaritySuspect: boolean;
  /**
   * B5: EXTRACTED observations that cleared the floor and were still NOT allowed to score,
   * because a DETERMINISTIC SOURCE had already answered this input — a lab, a mapped PAC
   * field, an ICD code, or a booking form that positively asserted something. They are
   * shown, with their spans, and they move nothing. The precedence rule made visible
   * rather than silent.
   */
  extractionOverruled: Observation[];
  /**
   * B5: this input was ABSENT only because a booking form that enumerated comorbidities
   * did not list it — Amendment A1-6's "weak form-negative" — and an above-floor
   * extraction with a verbatim citation asserted it after all. The extraction wins, the
   * conflict flag is raised, and the card shows both. See resolveInputs for why this is
   * the ONE thing a model may overturn.
   */
  overturnedFormNegative: boolean;
}

export interface ResolveOptions {
  /** PREOP_EXTRACT_ENABLED. Off ⇒ EXTRACTED observations never enter the resolution. */
  includeExtracted: boolean;
  /** A booking form exists and enumerated this patient's comorbidities. */
  bookingEnumerated: boolean;
  /**
   * Inputs the enumeration explicitly DECLINES to close, even though it exists. The
   * booking form's HEART_DISEASE says there is cardiac disease without saying which, so
   * it can close neither ischaemic heart disease nor heart failure — both stay unknown,
   * the instruments widen, and the missing line names them. Silence would have been
   * scored as absence.
   */
  notClosedBy?: PreopInputId[];
  confidenceFloor?: number;
}

function rank(o: Observation): number { return SOURCE_RANK[o.source]; }

function newer(a: Observation, b: Observation): boolean {
  const ta = a.observedAt ? Date.parse(a.observedAt) : NaN;
  const tb = b.observedAt ? Date.parse(b.observedAt) : NaN;
  if (Number.isNaN(ta) && Number.isNaN(tb)) return false;
  if (Number.isNaN(tb)) return true;
  if (Number.isNaN(ta)) return false;
  return ta > tb;
}

/**
 * Every input the module knows about, in factor-table order, DEDUPED: two ids —
 * congestive_heart_failure and cerebrovascular_disease — are both an RCRI/mFI-5 factor
 * and a Charlson category, and they are ONE clinical fact with one observation and one
 * resolution. That sharing is precisely why the mockup insists mFI-5 and Charlson be
 * read as two correlated lenses rather than as independent confirmation (PRD §3).
 */
export const ALL_INPUT_IDS: PreopInputId[] = [...new Set<PreopInputId>([
  'high_risk_surgery', 'ischaemic_heart_disease', 'congestive_heart_failure',
  'cerebrovascular_disease', 'insulin_treated_diabetes', 'creatinine_over_2',
  'functional_status_dependent', 'diabetes_mellitus', 'copd_or_pneumonia',
  'hypertension_on_medication',
  ...CHARLSON_CATEGORIES.map((c) => c.id),
  'age',
])];

/**
 * Resolve every input in the canonical space. The output is a complete record: an input
 * nothing observed appears with status 'unknown' (or 'absent' by the closed-world rule),
 * never missing from the map — a snapshot must be able to say what it does not know.
 */
export function resolveInputs(observations: Observation[], opts: ResolveOptions): Record<PreopInputId, ResolvedInput> {
  const floor = opts.confidenceFloor ?? EXTRACT_CONFIDENCE_FLOOR;
  const byInput = new Map<PreopInputId, Observation[]>();
  const dropped = new Map<PreopInputId, Observation[]>();

  for (const o of observations) {
    if (o.source === 'EXTRACTED') {
      if (!opts.includeExtracted) continue;                       // flag off: never entered
      if ((o.confidence ?? 0) < floor) {                          // below floor: dropped, shown
        const d = dropped.get(o.inputId) ?? []; d.push(o); dropped.set(o.inputId, d);
        continue;
      }
    }
    const list = byInput.get(o.inputId) ?? []; list.push(o); byInput.set(o.inputId, list);
  }

  const out = {} as Record<PreopInputId, ResolvedInput>;
  for (const id of ALL_INPUT_IDS) {
    const list = byInput.get(id) ?? [];
    const droppedHere = dropped.get(id) ?? [];

    // ── B5, THE PRECEDENCE RULE, ENFORCED STRUCTURALLY ──────────────────────────
    //
    // The deterministic observations are resolved FIRST and ALONE. Only if they say
    // nothing at all does an extraction get to decide the input. SOURCE_RANK would put
    // EXTRACTED last among competing observations anyway; splitting the passes makes the
    // rule a property of the code rather than of the ranking table, and — more to the
    // point — makes it survivable when someone adds a source.
    const det = list.filter((o) => o.source !== 'EXTRACTED');
    const ext = list.filter((o) => o.source === 'EXTRACTED');

    // The closed world: a booking form that ENUMERATES comorbidities and does not list
    // this one is asserting its absence by omission.
    const closed = opts.bookingEnumerated && ENUMERATED_INPUTS.has(id) && !NEVER_ENUMERATED.has(id)
      && !(opts.notClosedBy ?? []).includes(id);

    // ⚠️ THE ONE PLACE A MODEL MAY OVERTURN AN ABSENCE — and it is a reading of two
    // ratified sentences against each other, so it is written out here rather than left
    // to be inferred from behaviour.
    //
    // The B5 kickoff says "an extraction may only fill an input that is UNKNOWN after the
    // deterministic pass", citing the mockup's precedence note (LAB/PAC > BOOKING >
    // EXTRACTED). Amendment A1-6, ratified in the same kickoff, calls a closed-world
    // absence "a WEAK form-negative with its basis on display".
    //
    // Read strictly, the first sentence makes a form's SILENCE unbeatable — and the
    // binding mockup's own worked example breaks on it: Shobha K's ischaemic heart disease
    // ("MI 2019") and her hypertension ("Telmisartan 40") are both drawn as pink EXTRACTED
    // chips against a booking form that enumerated neither. Applied strictly, this module
    // would score her RCRI 1 where the approved mockup says 2.
    //
    // So the rule implemented here distinguishes an ASSERTION from a SILENCE:
    //   · a lab, a mapped PAC field, an ICD code, or a booking form's POSITIVE assertion
    //     is a deterministic source and outranks any extraction, always;
    //   · a weak form-negative — an absence inferred from an enumeration's silence — is
    //     the one thing an above-floor extraction with a verbatim citation may overturn,
    //     and when it does, the conflict flag is raised and BOTH are shown on the card.
    // A medication list naming telmisartan beats a form that was never asked the question.
    // FLAGGED FOR V: if the strict reading was meant, the change is one line — make
    // `deciding` fall back to [] rather than to `ext` when the world is closed — and the
    // mockup fixture then needs `notClosedBy` for Shobha's two pink chips.
    //
    // ⚠️ AND ONLY WHEN IT DISAGREES. An extraction that AGREES with the form's silence
    // has nothing to overturn, so it corroborates and the closed world keeps the input.
    // Letting it take over would move no score and still change the PROVENANCE — which is
    // inside the snapshot fingerprint — so flipping the flag would mint a version row on
    // every case where an anaesthetist wrote "NO KNOWN COMORBIDITIES", a timeline step
    // that says nothing happened. Measured on the golden set before this clause existed:
    // one "NO KNOWN COMORBIDITIES" span produced twelve such takeovers on a single case.
    const extDeciding = closed ? ext.filter((o) => o.status !== 'absent') : ext;
    const extAgreeing = closed ? ext.filter((o) => o.status === 'absent') : [];

    // A weak form-negative therefore stands whenever nothing else speaks: `deciding` is
    // empty exactly when there is neither a deterministic observation nor a DISSENTING
    // extraction, and that is the branch the closed world lives in.
    const deciding = det.length ? det : extDeciding;
    // Only a deterministic ANSWER overrules an extraction. A silence does not.
    const overruled = det.length ? ext : [];

    if (!deciding.length) {
      out[id] = {
        inputId: id, status: closed ? 'absent' : 'unknown', detail: null, value: null,
        source: closed ? 'BOOKING' : null, provenanceRef: null, observedAt: null,
        confidence: null, extractedBy: null,
        corroborating: extAgreeing, conflict: false,
        droppedBelowFloor: droppedHere, closedWorld: closed,
        sourceSpan: null, unstable: false, polaritySuspect: false,
        extractionOverruled: overruled, overturnedFormNegative: false,
      };
      continue;
    }
    let win = deciding[0];
    for (const o of deciding.slice(1)) {
      if (rank(o) < rank(win)) { win = o; continue; }
      if (rank(o) === rank(win) && newer(o, win)) win = o;
    }
    const rest = [...deciding.filter((o) => o !== win), ...overruled, ...extAgreeing];
    // A form-negative the extraction has just overturned is itself a dissenting source:
    // the card must say the booking form disagrees, not merely print the model's answer.
    const overturned = closed && !det.length && win.source === 'EXTRACTED' && win.status !== 'absent';
    out[id] = {
      inputId: id, status: win.status, detail: win.detail ?? null, value: win.value ?? null,
      source: win.source, provenanceRef: win.provenanceRef ?? null, observedAt: win.observedAt ?? null,
      confidence: win.confidence ?? null, extractedBy: win.extractedBy ?? null,
      corroborating: rest.filter((o) => o.status === win.status),
      conflict: overturned || rest.some((o) => o.status !== win.status),
      droppedBelowFloor: droppedHere, closedWorld: false,
      sourceSpan: win.sourceSpan ?? null,
      unstable: win.unstable === true,
      polaritySuspect: win.polaritySuspect === true,
      extractionOverruled: overruled,
      overturnedFormNegative: overturned,
    };
  }
  return out;
}

// ── the procedure's RCRI risk class ─────────────────────────────────────────────

/**
 * RCRI's "high-risk surgery" is intraperitoneal, intrathoracic or suprainguinal-vascular
 * surgery (Lee). This classifier reads the procedure text and returns tri-state — and
 * it returns UNKNOWN for anything it does not recognise, which widens RCRI to a range
 * rather than quietly scoring a 0. An unrecognised procedure is a data gap, and the
 * card says so.
 *
 * The approved mockup's own arithmetic settles the minimal-access question: Farhan's
 * laparoscopic cholecystectomy and Divya's laparoscopic appendectomy both score RCRI
 * high-risk-surgery ABSENT even though the peritoneum is entered. B3 revisits this
 * against real procedure text with the PAC's `za` (planned procedure) field.
 */
export function classifyProcedureRisk(procedure: string | null | undefined): { status: Tri; reason: string } {
  const p = (procedure ?? '').toLowerCase().trim();
  if (!p) return { status: 'unknown', reason: 'no procedure text on the episode' };

  const MINIMAL_ACCESS = /\b(lap|laparoscop\w*|endoscop\w*|arthroscop\w*|percutaneous|robotic)\b/;
  const INTRAPERITONEAL = /\b(hemicolectomy|colectomy|colostomy|gastrectomy|laparotomy|whipple|pancreatic\w*|hepatectomy|splenectomy|nephrectomy|cystectomy|hysterectomy|bowel resection|small bowel|ileostomy|oesophagectomy|esophagectomy|open cholecystectomy|open appendicectomy|open appendectomy)\b/;
  const INTRATHORACIC = /\b(thoracotomy|lobectomy|pneumonectomy|cabg|coronary artery bypass|valve replacement|thymectomy|decortication)\b/;
  const SUPRAINGUINAL_VASCULAR = /\b(aortic|aorto\w*|infrarenal|supra-?renal|iliac|aneurysm repair|evar)\b/;

  if (MINIMAL_ACCESS.test(p)) {
    return { status: 'absent', reason: `${procedure} — minimal-access, not an RCRI high-risk approach` };
  }
  if (INTRAPERITONEAL.test(p)) return { status: 'present', reason: `${procedure} — intraperitoneal` };
  if (INTRATHORACIC.test(p)) return { status: 'present', reason: `${procedure} — intrathoracic` };
  if (SUPRAINGUINAL_VASCULAR.test(p)) return { status: 'present', reason: `${procedure} — suprainguinal vascular` };

  const KNOWN_LOW = /\b(knee|hip|shoulder|acl|tkr|thr|arthroplasty|replacement|cataract|phaco\w*|lens|hernia|herniorrhaphy|hernioplasty|tonsill\w*|septoplasty|cystoscopy|tur\w*|circumcision|fistul\w*|haemorrhoid\w*|hemorrhoid\w*|carpal|ganglion|excision biopsy|lipoma|skin|dental|cochlear|mastoid|thyroidectomy|breast|lumpectomy|mastectomy|spine|discectomy|laminectomy|fixation|orif|amputation below)\b/;
  if (KNOWN_LOW.test(p)) {
    return { status: 'absent', reason: `${procedure} — not intraperitoneal / intrathoracic / suprainguinal-vascular` };
  }
  return { status: 'unknown', reason: `${procedure} — procedure not in the risk-class list; class unconfirmed` };
}

// ── inputs -> the three instruments ─────────────────────────────────────────────

type Inputs = Record<PreopInputId, ResolvedInput>;
const st = (m: Inputs, id: PreopInputId): Tri => m[id]?.status ?? 'unknown';

export function rcriFrom(m: Inputs): InstrumentScore {
  return computeRcri({
    highRiskSurgery: st(m, 'high_risk_surgery'),
    ischaemicHeartDisease: st(m, 'ischaemic_heart_disease'),
    congestiveHeartFailure: st(m, 'congestive_heart_failure'),
    cerebrovascularDisease: st(m, 'cerebrovascular_disease'),
    insulinTreatedDiabetes: st(m, 'insulin_treated_diabetes'),
    creatinineOver2: st(m, 'creatinine_over_2'),
  });
}

export function mfi5From(m: Inputs): InstrumentScore {
  return computeMfi5({
    functionalStatusDependent: st(m, 'functional_status_dependent'),
    diabetesMellitus: st(m, 'diabetes_mellitus'),
    copdOrPneumonia: st(m, 'copd_or_pneumonia'),
    congestiveHeartFailure: st(m, 'congestive_heart_failure'),
    hypertensionOnMedication: st(m, 'hypertension_on_medication'),
  });
}

/** Age rides in the resolved-input map like every other input, so it carries provenance
 *  and appears in the missing list when nothing observed it. */
export function resolvedAge(m: Inputs): number | null {
  const v = m.age?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function charlsonFrom(m: Inputs): InstrumentScore {
  const overrides: Partial<Record<CharlsonCategoryId, Tri>> = {};
  for (const c of CHARLSON_CATEGORIES) overrides[c.id] = st(m, c.id);
  return computeCharlson({ age: resolvedAge(m), categories: charlsonCategories(overrides, 'unknown') });
}

// ── the snapshot ────────────────────────────────────────────────────────────────

export interface PacState {
  /** a bridged KareXpert PAC REPORT exists for this patient */
  onFile: boolean;
  status: string | null;
  /** the anaesthetist's conclusion, quoted VERBATIM — never paraphrased, never replaced */
  verdict: string | null;
  reportUid: string | null;
  finalizedAt: string | null;
  /**
   * Amendment A1-3 — the OTHER fact. `surgery_cases.pac__status` is the BOOKING WORKFLOW's
   * own state (PENDING / SCHEDULED_WITH_ANAESTHETIST / COMPLETED / POST_ADMISSION). It is
   * not the report and the report is not it: measured 26 Aug, 8 of the 19 upcoming
   * episodes read COMPLETED while 1 has a report. Both are carried, the UI shows both,
   * and neither is ever allowed to stand in for the other.
   */
  workflowStatus: string | null;
  /** when the surgery_cases row was last written — the closest thing to "when the
   *  workflow status was logged"; the table has no PAC-specific timestamp. */
  workflowLoggedAt: string | null;
}

export const PAC_NONE: PacState = {
  onFile: false, status: null, verdict: null, reportUid: null, finalizedAt: null,
  workflowStatus: null, workflowLoggedAt: null,
};

export interface EpisodeFacts {
  episodeKey: string;
  individualUid: string | null;
  uhid: string | null;
  patientName: string | null;
  age: number | null;
  sex: string | null;
  procedure: string | null;
  hospital: string | null;
  surgeryDate: string | null;
  surgeon: string | null;
  department: string | null;
}

export interface SnapshotInput {
  engineVersion: string;
  episode: EpisodeFacts;
  observations: Observation[];
  pac: PacState;
  /** whole days from today to surgeryDate — the CALLER's clock, IST (this core has none) */
  daysToSurgery: number | null;
  /** a human marked the CURRENT stored version reviewed */
  reviewed: boolean;
  includeExtracted: boolean;
  bookingEnumerated: boolean;
  notClosedBy?: PreopInputId[];
  /**
   * The episode has NO document beyond the booking form — no OPD visit, no lab row, no
   * PAC (PRD §4: 28 of 105 patients). A document-level fact only the assembler can know,
   * so it is passed in rather than guessed from which source happened to win an input.
   */
  bookingOnly: boolean;
  /** the CALLER's clock again — excluded from the fingerprint by construction */
  computedAt: string;
  confidenceFloor?: number;
}

export interface PreopSnapshot {
  episodeKey: string;
  engineVersion: string;
  computedAt: string;
  rules: { instruments: string; tier: string; assemble: string };
  episode: EpisodeFacts;
  pac: PacState;
  context: EpisodeContext;
  inputs: ResolvedInput[];
  rcri: InstrumentScore;
  mfi5: InstrumentScore;
  charlson: InstrumentScore;
  tier: TierResult;
  lines: { why: string; missing: string; situation: string };
  /** true when BOOKING is the only source backing any input (mockup note 3) */
  bookingOnly: boolean;
  /** the evidence+arithmetic fingerprint — see snapshotFingerprint */
  fingerprint: string;
}

/**
 * Compose one snapshot. Pure: same arguments in, byte-identical snapshot out, every time.
 * This is the function the worker calls per episode and the function the tests call with
 * the mockup's four synthetic patients.
 */
export function composeSnapshot(inp: SnapshotInput): PreopSnapshot {
  // Age rides in the input map. If the caller did not observe it, take it off the episode
  // record (the booking/ADT row it came from) so Charlson has provenance for it too.
  const observations = inp.observations.some((o) => o.inputId === 'age') || inp.episode.age == null
    ? inp.observations
    : [...inp.observations, { inputId: 'age' as const, status: 'present' as const, value: inp.episode.age, source: 'BOOKING' as const }];

  const inputs = resolveInputs(observations, {
    includeExtracted: inp.includeExtracted,
    bookingEnumerated: inp.bookingEnumerated,
    notClosedBy: inp.notClosedBy,
    confidenceFloor: inp.confidenceFloor,
  });
  const rcri = rcriFrom(inputs);
  const mfi5 = mfi5From(inputs);
  const charlson = charlsonFrom(inputs);

  const context: EpisodeContext = {
    pacFinalized: inp.pac.onFile && (inp.pac.status ?? '').toLowerCase() === 'final',
    daysToSurgery: inp.daysToSurgery,
    reviewed: inp.reviewed,
  };
  const tier = computeTier({ rcri, mfi5, charlson, context });

  const inputList = ALL_INPUT_IDS.map((id) => inputs[id]);
  const bookingOnly = inp.bookingOnly;
  const evidence: Record<string, { detail?: string | null }> = {};
  for (const r of inputList) if (r.detail) evidence[r.inputId] = { detail: r.detail };

  const lines = cardLines({ rcri, mfi5, charlson, tier, context, evidence, bookingOnly, age: resolvedAge(inputs) });

  const snap: Omit<PreopSnapshot, 'fingerprint'> = {
    episodeKey: inp.episode.episodeKey,
    engineVersion: inp.engineVersion,
    computedAt: inp.computedAt,
    rules: { instruments: PREOP_INSTRUMENTS_VERSION, tier: tier.ruleVersion, assemble: PREOP_ASSEMBLE_RULE_VERSION },
    episode: inp.episode,
    pac: inp.pac,
    context,
    inputs: inputList,
    rcri, mfi5, charlson, tier, lines, bookingOnly,
  };
  return { ...snap, fingerprint: snapshotFingerprint(snap) };
}

// ── the fingerprint (what "changed" means) ──────────────────────────────────────

/** Stable-key JSON, so a fingerprint depends on values and never on key insertion order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** FNV-1a, 32-bit, hex — a short stable digest with no crypto import in a pure core. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * WHAT COUNTS AS A CHANGE — the single decision the whole versions rail turns on.
 *
 * IN: the resolved evidence (each input's status, winning source, value, detail and
 * conflict flag), the three instrument bounds, the composite tier and its escalations.
 * A new lab, a finalized PAC, a corrected comorbidity or a tier that escalates because
 * surgery came inside 72 h — all of these mint a version, and the timeline is exactly
 * the story the case page is built to tell.
 *
 * OUT, deliberately: `computedAt` (a sweep is not a change), `daysToSurgery` (it decays
 * every single day and would churn the rail into noise), and `needsReview` (a board
 * predicate recomputed at every sweep on the live row, not a fact about the snapshot).
 * The tier IS in, so the moment a decaying countdown actually changes the answer, the
 * change is recorded.
 */
export function snapshotFingerprint(s: Omit<PreopSnapshot, 'fingerprint'>): string {
  const material = {
    engine: s.engineVersion,
    rules: s.rules,
    // The REPORT is in the fingerprint; the booking WORKFLOW status is not. The versions
    // rail answers "how did this score ripen", and a workflow moving PENDING → COMPLETED
    // changes no instrument input — recording it as a snapshot version would put
    // operational noise into a clinical timeline. It is displayed from its own live-row
    // column instead, refreshed by the store on every tick (see lib/preop/store.ts).
    pac: { onFile: s.pac.onFile, status: s.pac.status, reportUid: s.pac.reportUid, verdict: s.pac.verdict },
    inputs: s.inputs.map((i) => ({
      id: i.inputId, status: i.status, source: i.source, value: i.value ?? null,
      detail: i.detail ?? null, conflict: i.conflict,
    })),
    rcri: { kind: s.rcri.kind, lo: s.rcri.lo, hi: s.rcri.hi },
    mfi5: { kind: s.mfi5.kind, lo: s.mfi5.lo, hi: s.mfi5.hi },
    charlson: { kind: s.charlson.kind, lo: s.charlson.lo, hi: s.charlson.hi },
    tier: s.tier.tier,
    escalations: [...s.tier.escalations].sort(),
  };
  return fnv1a(canonicalJson(material));
}

// ── the structured sources, mapped (B2; all deterministic, no model anywhere) ────
//
// Each mapper turns ONE db13 fact into observations. They only ever assert PRESENT (or,
// for a measured lab, absent-because-measured). None of them asserts absence from
// silence: an ICD code that is not there means the visit did not code it, which is not
// the same as the patient not having it. Only the booking enumeration closes a world,
// and only over the inputs it actually enumerates.

/**
 * `surgery_cases.clinical__comorbidities` — a CLOSED five-value enum on production
 * (measured 26 Aug 2026: NO_KNOWN_CONDITION 305 · DIABETES 14 · HYPOTHYROID 5 ·
 * HYPERTENSION 2 · HEART_DISEASE 2 across 342 cases).
 *
 * ⚠️ FLAGGED FOR V — the PRD §3 coverage table does not survive contact with this
 * field. It promises "5/6 RCRI factors from booking comorbidities + OPD history" and
 * "4/5 mFI-5 items from booking comorbidities (~90%)". What the form can actually say is
 * diabetes, hypertension, hypothyroidism, or unspecified heart disease. In particular:
 *   · DIABETES cannot distinguish INSULIN-TREATED diabetes, which is what RCRI scores —
 *     so it feeds mFI-5 and Charlson and leaves RCRI's factor UNKNOWN.
 *   · HEART_DISEASE cannot distinguish ischaemic heart disease from heart failure — so
 *     it asserts neither and OPENS both (they stay unknown rather than being closed to
 *     absent). It is the one value that widens rather than narrows.
 *   · HYPOTHYROID maps to no input in any of the three instruments. Recorded as
 *     unmapped so the coverage report can count it rather than lose it.
 */
export interface BookingComorbidityMap {
  observations: Observation[];
  /** the form exists and enumerated something — the closed world stands on this */
  enumerated: boolean;
  /** inputs the enumeration explicitly cannot close (see HEART_DISEASE) */
  notClosedBy: PreopInputId[];
  /** values with no instrument input, kept for the coverage report */
  unmapped: string[];
}

export function bookingComorbidityObservations(
  values: readonly string[] | null | undefined,
  ref: string | null = null,
  observedAt: string | null = null,
): BookingComorbidityMap {
  const list = (values ?? []).map((v) => String(v).trim().toUpperCase()).filter(Boolean);
  const out: BookingComorbidityMap = { observations: [], enumerated: list.length > 0, notClosedBy: [], unmapped: [] };
  const add = (inputId: PreopInputId, detail: string) =>
    out.observations.push({ inputId, status: 'present', source: 'BOOKING', detail, provenanceRef: ref, observedAt });

  for (const v of list) {
    switch (v) {
      case 'NO_KNOWN_CONDITION':
        break;                                     // the enumeration itself is the assertion
      case 'DIABETES':
        add('diabetes_mellitus', 'booking: diabetes');
        add('diabetes_uncomplicated', 'booking: diabetes');
        // RCRI scores INSULIN-treated diabetes; the form does not say. Leave it unknown.
        out.notClosedBy.push('insulin_treated_diabetes');
        break;
      case 'HYPERTENSION':
        // ⚠️ mFI-5's item is hypertension REQUIRING MEDICATION and the form says only
        // that hypertension exists. Treated as on-medication, because in this cohort a
        // declared hypertension is a treated one and the alternative — unknown —
        // widens every frailty score to a range on the commonest comorbidity there is.
        // Flagged for V; B5's extraction of the medication list can settle it properly.
        add('hypertension_on_medication', 'booking: hypertension');
        break;
      case 'HEART_DISEASE':
        out.notClosedBy.push('ischaemic_heart_disease', 'congestive_heart_failure');
        break;
      default:
        out.unmapped.push(v);
        break;
    }
  }
  return out;
}

/**
 * ICD-10 diagnosis / impression codes off `individuals-prescriptions` (OPD). Structured,
 * doctor-coded, no model. Prefix matching on the code's alphanumeric head, so 'I25.10'
 * and 'I25' both reach the ischaemic-heart-disease rule.
 *
 * v1 covers the codes that reach an instrument input and nothing else. A code outside
 * the map is silence, never absence.
 */
type IcdRule = { test: RegExp; inputs: PreopInputId[]; label: string };

export const ICD_RULES: IcdRule[] = [
  { test: /^I2[1-2]/, inputs: ['ischaemic_heart_disease', 'myocardial_infarction'], label: 'myocardial infarction' },
  { test: /^I25\.2/, inputs: ['ischaemic_heart_disease', 'myocardial_infarction'], label: 'old myocardial infarction' },
  { test: /^I2[0345]/, inputs: ['ischaemic_heart_disease'], label: 'ischaemic heart disease' },
  { test: /^I50/, inputs: ['congestive_heart_failure'], label: 'heart failure' },
  { test: /^(I6[0-9]|G45)/, inputs: ['cerebrovascular_disease'], label: 'cerebrovascular disease' },
  { test: /^E1[0-4]\.[2-5]/, inputs: ['diabetes_mellitus', 'diabetes_end_organ_damage'], label: 'diabetes with end-organ damage' },
  { test: /^E1[0-4]/, inputs: ['diabetes_mellitus', 'diabetes_uncomplicated'], label: 'diabetes mellitus' },
  { test: /^I1[0-5]/, inputs: ['hypertension_on_medication'], label: 'hypertension' },
  { test: /^J4[0-7]/, inputs: ['copd_or_pneumonia', 'chronic_pulmonary_disease'], label: 'chronic lower respiratory disease' },
  { test: /^J1[2-8]/, inputs: ['copd_or_pneumonia'], label: 'pneumonia' },
  { test: /^(N18\.[3-6]|N19)/, inputs: ['moderate_severe_renal_disease'], label: 'moderate or severe renal disease' },
  { test: /^(K72|K76\.6|K76\.7|I85\.0)/, inputs: ['moderate_severe_liver_disease'], label: 'moderate or severe liver disease' },
  { test: /^(K7[034]|B18)/, inputs: ['mild_liver_disease'], label: 'chronic liver disease' },
  { test: /^(C7[789]|C80)/, inputs: ['metastatic_solid_tumour'], label: 'metastatic solid tumour' },
  { test: /^C9[1-5]/, inputs: ['leukaemia'], label: 'leukaemia' },
  { test: /^(C8[1-8]|C96)/, inputs: ['lymphoma'], label: 'lymphoma' },
  { test: /^C[0-7]/, inputs: ['any_tumour'], label: 'malignancy' },
  { test: /^G8[12]/, inputs: ['hemiplegia'], label: 'hemiplegia' },
  { test: /^(F0[0-3]|G30)/, inputs: ['dementia'], label: 'dementia' },
  { test: /^(I7[0-4]|I77)/, inputs: ['peripheral_vascular_disease'], label: 'peripheral vascular disease' },
  { test: /^(M0[56]|M3[234]|M35\.3)/, inputs: ['connective_tissue_disease'], label: 'connective tissue disease' },
  { test: /^K2[5-8]/, inputs: ['peptic_ulcer_disease'], label: 'peptic ulcer disease' },
  { test: /^B2[0-4]/, inputs: ['aids'], label: 'AIDS' },
];

export function icdObservations(
  codes: readonly string[] | null | undefined,
  observedAt: string | null = null,
  ref: string | null = null,
): { observations: Observation[]; matched: string[]; unmatched: string[] } {
  const observations: Observation[] = [];
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const raw of codes ?? []) {
    const code = String(raw).trim().toUpperCase();
    if (!code) continue;
    const rule = ICD_RULES.find((r) => r.test.test(code));
    if (!rule) { unmatched.push(code); continue; }
    matched.push(code);
    for (const inputId of rule.inputs) {
      observations.push({
        inputId, status: 'present', source: 'OPD',
        detail: `${rule.label} (ICD ${code})`, provenanceRef: ref, observedAt,
      });
    }
  }
  return { observations, matched, unmatched };
}

/**
 * The RCRI renal factor off a measured creatinine. A measurement can assert ABSENT —
 * that is exactly what makes it collapse the range — but only when the units are the
 * mg/dL the threshold is written in. An unrecognised unit observes nothing rather than
 * comparing a number against the wrong scale.
 */
export function creatinineObservation(
  value: number | null,
  unit: string | null,
  observedAt: string | null,
  ref: string | null = null,
): Observation | null {
  if (value == null || !Number.isFinite(value)) return null;
  const u = (unit ?? '').toLowerCase().replace(/\s/g, '');
  if (u && !/^mg\/?d?l$/.test(u) && u !== 'mg%') return null;
  return {
    inputId: 'creatinine_over_2',
    status: value > 2.0 ? 'present' : 'absent',
    value,
    detail: `${value}${unit ? ` ${unit}` : ' mg/dL'}${observedAt ? ` · ${observedAt.slice(0, 10)}` : ''}`,
    source: 'LAB', provenanceRef: ref, observedAt,
  };
}

/** The procedure's RCRI risk class as an observation (BOOKING — it is the booking's own
 *  procedure text). Unknown classifications observe nothing, so the input stays unknown. */
export function procedureObservation(procedure: string | null, ref: string | null = null): Observation | null {
  const c = classifyProcedureRisk(procedure);
  if (c.status === 'unknown') return null;
  return { inputId: 'high_risk_surgery', status: c.status, source: 'BOOKING', detail: c.reason, provenanceRef: ref };
}
