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
 * ⚠️ ONLY `opd_note_audited` IS REACHABLE IN v0. `ipd_stay_extracted` is declared because it is the
 * second trigger the programme intends, but the kickoff specifies no table, no identity column and
 * no text field to read for it — so this ship emits ZERO rows of that kind rather than guessing a
 * read. The Shadow page's per-kind breakdown will therefore show one kind. Flagged in the report.
 * (This mirrors CognitionObjective below, where three of four members are likewise unreachable.)
 */
export type DecisionEventKind = 'opd_note_audited' | 'ipd_stay_extracted';

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
 * ⚠️ TYPE ONLY. There is NO table, NO migration, NO writer, and NO reader for this in v0, and this
 * ship adds none. It is declared so the shape is settled before anything can write it — and so that
 * the note below has somewhere to live.
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
  /** What they said back, in the programme's controlled vocabulary (not yet defined — v0 writes none). */
  reaction: string;
  /** Whether the reaction was recorded AFTER the clinician saw the CDMSS output. */
  afterCdmss: boolean;
  /** ISO timestamp of the reaction. */
  at: string;
}

/** The cognition vocabulary's version. Bump when any type above changes shape. */
export const COGNITION_SCHEMA_VERSION = 'cognition/0.1' as const;

/** The burden policy's version. Bump when the thresholds or the decision rule change — it is part
 *  of the shadow table's unique key, so a bump deliberately re-shadows the backlog under the new
 *  rule rather than leaving old decisions to be misread as current ones. */
export const BURDEN_POLICY_VERSION = 'burden-policy/0.1' as const;
