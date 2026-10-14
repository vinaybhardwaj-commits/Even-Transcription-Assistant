/**
 * lib/cognition/schema.ts — WM1 the shadow agent: the vocabulary (cognition/0.1).
 *
 * PURE. No db, no LLM, no I/O — types and version constants only.
 *
 * ⚠️ SHADOW ONLY. Nothing in this module, or in anything that imports it, is or becomes doctor-
 * visible in v0. The shadow agent decides what it WOULD have asked and writes that decision to a
 * table nobody but an admin reads. There is no ask, no notification, no surface a clinician can
 * reach. Every type below is named for what it would mean IF the loop were closed, which it is not.
 */

/**
 * What happened in the world that gives the agent an occasion to think.
 *
 * ⚠️ TWO OF THE THREE ARE REACHABLE. `opd_note_audited` is the shadow agent's trigger: an audit row
 * the agent judged. `opd_note_matched` (WM3 fix 3, N8) is the join's SECOND trigger and reads a
 * different world — a RAW OPD note on db13 that the `headache-raw/1` rule matched, whether or not
 * the audit engine ever saw it. The two are kept apart deliberately: a triple opened from an audit
 * row was judged by a policy, and a triple opened from a raw note was not, and collapsing them
 * would let the never-audited backlog be read as shadow-agent output.
 *
 * ⚠️ `ipd_stay_extracted` REMAINS UNREACHABLE. It is declared because it is the trigger the
 * programme intends next, but no kickoff has yet specified a table, an identity column or a text
 * field to read for it — so this repo emits ZERO rows of that kind rather than guessing a read.
 * (This mirrors CognitionObjective below, where three of four members are likewise unreachable.)
 */
export type DecisionEventKind = 'opd_note_audited' | 'opd_note_matched' | 'ipd_stay_extracted';

/**
 * WHICH BACKLOG A TRIPLE CAME OUT OF, and therefore what its presence is evidence of.
 *
 *   · `current`    opened from an ELIGIBLE shadow event — the engine version that produced the
 *                  audit was the current era at the time the shadow judged it. Every triple written
 *                  before WM3 fix 3 is one of these, which is why it is the column default.
 *   · `stale`      opened from a shadow event the burden policy refused with `stale_era`: the note
 *                  WAS audited, by an engine version that is no longer current. The refusal was
 *                  about whether the agent should speak, never about whether the note happened.
 *   · `unaudited`  opened by the raw-note trigger from a db13 note that has no audit row at all.
 *
 * The three are never collapsed. A rate computed over `current` alone is a rate over the audited,
 * current-era slice, and a rate computed over all three is a rate over the headache pool — two
 * different denominators, and a reader who cannot tell them apart will believe the wrong one.
 */
export type EraStatus = 'current' | 'stale' | 'unaudited';

/**
 * What the agent would be trying to accomplish by asking.
 *
 * ⚠️ ONLY `close_snapshot` IS REACHABLE IN v0 — the burden policy emits that objective or null, and
 * nothing else. The other three are declared so the vocabulary is stable before the behaviour
 * exists, not because any code path can produce them.
 */
export type CognitionObjective = 'test_intent' | 'result_update' | 'close_snapshot' | 'signal_reaction';

/**
 * WHERE A CLAIM CAME FROM, and therefore how much it may be trusted.
 *
 * This axis maps onto the vocabulary that already exists in lib/clinical-state/schema.ts
 * (`Reporter` = who said it, `Trust` = how trustworthy the channel is). It is a COARSER,
 * cognition-facing rollup of those two, not a replacement: clinical-state stays the fine-grained
 * per-finding record, and this names the four kinds of thing the agent must never confuse.
 *
 * The distinction that matters most is the last two. A CDMSS inference and a later outcome can look
 * identical on a screen and mean opposite things — one is the machine's guess, the other is what
 * actually happened. Collapsing them would let the system grade itself against its own opinion.
 */
export type ProvenanceClass =
  /**
   * Something true of the patient, recorded from a structured system of record.
   * clinical-state correspondence: Reporter 'system' (or 'clinician' where the field is structured),
   * Trust 'structured_db'. A lab value, a dispensed drug, an admission date.
   */
  | 'PATIENT_FACT'
  /**
   * What a clinician SAID they believe — a documented opinion, not a verified fact.
   * clinical-state correspondence: Reporter 'clinician', Trust 'clinician_documented'.
   * An impression, a working diagnosis, a stated intent. True as a record of belief, and only that.
   */
  | 'CLINICIAN_REPORTED_BELIEF'
  /**
   * Something CDMSS derived itself. Never evidence about the patient — evidence about the model.
   * clinical-state correspondence: Reporter 'system', Trust 'inferred'.
   */
  | 'CDMSS_INFERENCE'
  /**
   * What actually happened afterwards, known only in hindsight.
   * clinical-state correspondence: Reporter 'system' | 'clinician', Trust 'structured_db', and
   * ALWAYS dated after the decision it is used to judge. This is the only class that can settle
   * whether an inference was right, which is exactly why it must never be mixed into one.
   */
  | 'LATER_OUTCOME';

/**
 * A clinician's reaction to a CDMSS output, as the programme would eventually record it.
 *
 * Written by two paths: the signal-reaction route (reaction/0.1, cognition_reactions, after_cdmss
 * true) and the sequential review route (review/0.1, cognition_belief_updates, after_cdmss false).
 * The BeliefItem warning below still holds.
 *
 * ⚠️ THIS IS NOT concordance's `BeliefItem`. That type (lib/concordance-core.ts) is
 * `{ cause, branch, weight }` — an LLM-generated PRIOR over candidate causes inside the adaptive
 * interview loop, i.e. the machine's own guess, normalised to sum to 1. This is the opposite thing:
 * a REAL CLINICIAN's stated reaction, attributed to a real physician id, with a timestamp. One is
 * CDMSS_INFERENCE, the other is CLINICIAN_REPORTED_BELIEF. They must never be joined, averaged or
 * stored in the same column.
 */
export interface BeliefUpdate {
  /** The ClinicalState this reaction is about. */
  clinicalStateRef: string;
  /** The CDMSS-side doctor identity (opd_note_audits.doctor_uid). */
  cdmssDoctorUid: string;
  /** The physician-directory identity, kept separate because the two namespaces are not the same. */
  physicianId: string;
  /** Fixed by construction: a person's stated reaction is a reported belief and nothing else. */
  provenance: 'CLINICIAN_REPORTED_BELIEF';
  /** The programme's controlled vocabulary: ReactionVerb. Written by the signal-reaction route from reaction/0.1. */
  reaction: string;
  /** Whether the reaction was recorded AFTER the clinician saw the CDMSS output. */
  afterCdmss: boolean;
  /** ISO timestamp of the reaction. */
  at: string;
}

/** The three non-escalating things a doctor can press on a Findings card. Controlled vocabulary:
 *  a reaction is one of exactly these, and nothing widens it but a version bump. */
export const REACTION_VERBS = ['already_knew', 'surprised', 'dismiss'] as const;
export type ReactionVerb = typeof REACTION_VERBS[number];

/** The reaction vocabulary's version, stamped on every cognition_reactions row. Separate from
 *  COGNITION_SCHEMA_VERSION on purpose: the two move independently. */
export const REACTION_SCHEMA_VERSION = 'reaction/0.1' as const;

// ── WM6 sequential review (review/0.1) ────────────────────────────────────────
/** The review vocabulary's version, stamped on every session and every belief row. */
export const REVIEW_SCHEMA_VERSION = 'review/0.1' as const;

/** The join's version, stamped on every snapshot and every triple. It is part of the triple's
 *  identity key, so bumping it re-opens the backlog under the new shape rather than leaving rows
 *  built by an older rule to be read as current ones. */
export const JOIN_SCHEMA_VERSION = 'cognition-join/0.1' as const;

/** The perturbation catalogue's ids, in the order they are offered and recorded. The overlay text
 *  for each lives in lib/review/perturbations.ts — one id, one sentence, nothing generated. */
export const REVIEW_VARIANT_IDS = ['fever_39_5', 'ct_done_normal', 'age_plus_30'] as const;
export type ReviewVariantId = typeof REVIEW_VARIANT_IDS[number];

/** The controlled answer set for "what would you do next". `other` carries free text. */
export const NEXT_INVESTIGATIONS = ['ct_head', 'mri_brain', 'lumbar_puncture', 'blood_tests', 'esr_crp', 'none', 'other'] as const;

/**
 * The four fields a reviewer records at each step. This is a BELIEF, not an answer: nothing grades
 * it, nothing compares it to an outcome in this ship, and no correctness column exists to hold one.
 */
export interface ReviewBeliefPayload {
  leading_diagnosis: string;
  confidence: number;
  next_investigation: typeof NEXT_INVESTIGATIONS[number];
  other_text: string | null;
  unsafe_to_wait: boolean;
}

/** The cognition vocabulary's version. Bump when any type above changes shape. */
export const COGNITION_SCHEMA_VERSION = 'cognition/0.1' as const;

/** The burden policy's version. Bump when the thresholds or the decision rule change — it is part
 *  of the shadow table's unique key, so a bump deliberately re-shadows the backlog under the new
 *  rule rather than leaving old decisions to be misread as current ones. */
export const BURDEN_POLICY_VERSION = 'burden-policy/0.1' as const;
