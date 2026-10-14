/**
 * lib/physician-standing-core.ts — the MS standing overlay's PURE gate
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, S4; spec §6.3 and §12.3, D-overlay).
 *
 * PURE AND DEPENDENCY-FREE. No ./db, no ./llm, no next/*. Every function takes what it needs.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT AN OVERLAY IS, AND THE FOUR THINGS IT IS NOT.
 *
 * It is the medical superintendent's own adjudication of a physician, STATED, stored beside the
 * numbers rather than inside them. §6.3: "Show BOTH the stored NQI/CVI and the human standing.
 * Human wins the standing chip. Scores do not move."
 *
 *   · NOT A RESCORE. Nothing on this path writes `note_quality_index`, `care_value_index`, a band,
 *     `avoidable`, or a feedback pill. A test asserts the absence rather than trusting it.
 *   · NOT AN INFERENCE. `stated` is the whole gate. A question is not an assertion, and an
 *     assertion the model merely deduced from tone is not the MS's statement. Where the model is
 *     unsure, the overlay is null and the turn is still stored.
 *   · NOT A GOLD PILL. Adjudicating one FINDING is the existing pill API on that note or stay. This
 *     is a judgement about a clinician, not about a finding, and the two must not be confused.
 *   · NOT READABLE BY AN AGGREGATOR. No mean, band, index or rollup may read this blob (§6.3). It
 *     is shown beside the numbers and never folded into them.
 *
 * THE GATE IS FIVE CONDITIONS AND ALL FIVE MUST HOLD (§12.3). The fourth is the load-bearing one:
 * the quote must be a SUBSTRING OF THE USER'S OWN TURN. A model that paraphrases what it thinks the
 * auditor meant produces no overlay at all — which is exactly right, because an overlay is a record
 * of what a named person said about a named clinician, and a paraphrase is not that.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** The overlay's own version. NOT an engine version: nothing here scores anything. */
export const PHYSICIAN_STANDING_VERSION = 'physician_standing/1';

/** §6.3, verbatim and closed. `null` is unreviewed — a question, or a turn the gate refused. */
export const PHYSICIAN_STANDINGS = ['standing', 'concern', 'restricted-review', 'insufficient'] as const;
export type PhysicianStanding = (typeof PHYSICIAN_STANDINGS)[number];

export function isPhysicianStanding(v: unknown): v is PhysicianStanding {
  return typeof v === 'string' && (PHYSICIAN_STANDINGS as readonly string[]).includes(v);
}

/** What the MS sees on the chip, and what it means. Plain clinical English, no system vocabulary. */
export const STANDING_LABEL: Readonly<Record<PhysicianStanding, string>> = Object.freeze({
  standing: 'In good standing',
  concern: 'Concern',
  'restricted-review': 'Restricted — under review',
  insufficient: 'Not enough to judge',
});

export const STANDING_HELP: Readonly<Record<PhysicianStanding, string>> = Object.freeze({
  standing: 'A medical superintendent reviewed this clinician’s audited work and recorded no concern.',
  concern: 'A medical superintendent recorded a concern about this clinician’s audited work.',
  'restricted-review': 'A medical superintendent placed this clinician under restricted review.',
  insufficient: 'A medical superintendent looked and judged the record too thin, or too contradictory, to support a standing.',
});

/** The sentence the board carries wherever a standing is shown. It is the whole point of the
 *  overlay, so it is not optional chrome. */
export const STANDING_ADVISORY =
  'A medical superintendent’s stated judgement, recorded beside the numbers. It does not change the note-quality index, the Care-Value Index, any band, or any finding’s verdict — those are exactly what they were before the conversation.';

/** The cap on the stored quote. A quote is evidence of what was said, not a transcript. */
export const STANDING_QUOTE_MAX_CHARS = 400;

// ── the model's half of the reply ─────────────────────────────────────────────────────────

/** What the model may report about the auditor's turn. Every field is untrusted until the gate. */
export interface StandingOverlayClaim {
  standing?: unknown;
  quote?: unknown;
  stated?: unknown;
}

export type StandingRejection =
  | 'no_overlay'          // the model reported nothing
  | 'not_stated'          // `stated` is not true — a question, or an inference
  | 'unknown_standing'    // outside the closed set
  | 'quote_missing'       // empty quote
  | 'quote_not_in_turn';  // the quote is not the auditor's own words

export interface StandingDecision {
  write: boolean;
  standing: PhysicianStanding | null;
  quote: string;
  reason: StandingRejection | 'ok';
}

/**
 * PURE — §12.3's five conditions, in the order that makes each refusal nameable.
 *
 * ⚠️ THE SUBSTRING TEST IS DELIBERATELY LOOSE ABOUT WHITESPACE AND CASE AND STRICT ABOUT EVERYTHING
 * ELSE. The auditor's turn has already been through `deidentify` and whitespace collapsing, and a
 * model that re-types a quote will re-type spacing before it re-types words. Normalising those two
 * things prevents a false refusal; normalising anything more would start accepting paraphrases,
 * which is the failure this test exists to catch.
 *
 * A refusal is never an error. The turn is still stored, the answer is still shown, and the overlay
 * is simply absent — because "the MS asked a question" and "the MS made no judgement" are the same
 * state and both of them are `null`.
 */
export function standingDecision(userTurn: string, claim: StandingOverlayClaim | null | undefined): StandingDecision {
  const none = (reason: StandingRejection): StandingDecision => ({ write: false, standing: null, quote: '', reason });
  if (!claim || typeof claim !== 'object') return none('no_overlay');

  // 1 + 2 — the turn must be a STATED assertion. `stated` is strictly true; a truthy string is not
  // a claim that the auditor asserted anything, it is a model being loose with JSON.
  if (claim.stated !== true) return none('not_stated');

  // 3 + 5 — the enum is closed. Anything else, including a plausible-sounding new word, is refused.
  if (!isPhysicianStanding(claim.standing)) return none('unknown_standing');

  // 4 — the quote must be the auditor's OWN words.
  const quote = typeof claim.quote === 'string' ? claim.quote.trim() : '';
  if (!quote) return none('quote_missing');
  if (!containsQuote(userTurn, quote)) return none('quote_not_in_turn');

  return { write: true, standing: claim.standing, quote: quote.slice(0, STANDING_QUOTE_MAX_CHARS), reason: 'ok' };
}

/** Whitespace- and case-insensitive substring containment. Nothing else is normalised. */
export function containsQuote(turn: unknown, quote: unknown): boolean {
  const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const t = norm(turn);
  const q = norm(quote);
  return !!t && !!q && t.includes(q);
}

// ── the stored row (§6.3's blob, as columns) ──────────────────────────────────────────────

export interface PhysicianStandingRow {
  /** `physician` | `dept` — the same two case types the Ask serves. */
  caseType: string;
  /** doctor_uid, or the dept key. Identical to the Ask thread's key (A3). */
  caseKey: string;
  /** The thread's engine string (A3) — the standing belongs to the numbers it was said about. */
  engineVersion: string;
  standing: PhysicianStanding;
  quote: string;
  /** O8 — the ROLE the request proved. There is no per-person identity in this app. */
  actor: string;
  turnId: string;
  /** Always the pinned Opus id: the overlay is only ever produced from a served call. */
  model: string;
  windowDays: number;
  /** §6.3 — who is allowed to make this judgement at all. */
  authority: 'medical_superintendent';
  /** §6.3 — inferred never writes. Stored so the row itself carries its own gate. */
  stated: true;
  at?: string | null;
}

/** §6.3, verbatim. Stored on every row so a reader of the table alone knows what it is. */
export const STANDING_AUTHORITY = 'medical_superintendent';

/** PURE — the row a passing decision produces. Nothing here reads a score or a clock. */
export function standingRow(a: {
  caseType: string; caseKey: string; engineVersion: string;
  decision: StandingDecision; actor: string; turnId: string; model: string; windowDays: number;
}): PhysicianStandingRow | null {
  if (!a.decision.write || !a.decision.standing) return null;
  if (!a.caseType || !a.caseKey || !a.engineVersion || !a.turnId) return null;
  return {
    caseType: a.caseType, caseKey: a.caseKey, engineVersion: a.engineVersion,
    standing: a.decision.standing, quote: a.decision.quote,
    actor: a.actor || 'admin', turnId: a.turnId, model: a.model,
    windowDays: a.windowDays, authority: STANDING_AUTHORITY, stated: true,
  };
}

/**
 * The clause the stewardship prompt adds, and ONLY the stewardship prompt (a test pins that the OPD
 * and IPD prompts do not move a byte). It asks the model to report what the AUDITOR said, never what
 * the model concludes — the distinction the whole gate rests on.
 */
export const STANDING_PROMPT_CLAUSE = `THE AUDITOR'S OWN JUDGEMENT. This reviewer is a medical superintendent and may state a standing for the clinician or department under discussion. If, and only if, THIS turn contains such a statement as his own assertion, add to your JSON: "overlay": {"stated": true, "standing": "standing"|"concern"|"restricted-review"|"insufficient", "quote": "<the exact words he used, copied character for character from his turn>"}. Rules you must not bend: report only what he ASSERTED, never what you conclude from the numbers or from his tone; a question is never a statement; copy his words rather than paraphrasing them, because a paraphrase is discarded; and if he stated nothing, omit "overlay" entirely. You never propose a standing and you never argue for one.`;

/** The reply shape the stewardship prompt asks for, replacing the shared one for these two cases. */
export const STANDING_REPLY_SCHEMA =
  `Return STRICT JSON only: {"answer": "<your answer with [id] markers>", "answerable": true|false, "overlay": {"stated": true, "standing": "…", "quote": "…"}} — the "overlay" key only when he stated one, nothing before or after the JSON.`;
