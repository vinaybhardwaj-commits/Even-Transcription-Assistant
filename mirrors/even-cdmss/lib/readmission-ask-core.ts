/**
 * lib/readmission-ask-core.ts — PURE decisions for R4.3 "ask the agent" (CDMSS-READMISSIONS-R4.3-PRD
 * v1.0, R43-1..R43-8): the case MATERIAL the model may see (stored artefacts only), the caps
 * (question length, history turns, history size), and the answer verdict (citations enforced by
 * the same validator that guards narratives). No DB, no model, no clock.
 *
 * THE FENCE (the memo's rule): the conversation's whole world is this case's STORED material — the
 * evidence ledger, the agent's account, the judgements, the coverage, the two bills. Nothing new
 * enters the case through the ask-box.
 *
 * R9 (CDMSS-READMISSIONS-R9-DUAL-CONTRACT PRD, GO 27 Aug 2026, D12/D13/D14 + O1/O2 + T6) moves ONE
 * half of that last clause. The fence against inventing KX facts STANDS, unchanged: an agent claim
 * about the record still dies without a resolvable ledger citation. The fence against storing the
 * REVIEWER goes: a care manager's own stated clinical judgement is now persisted, beside the agent's
 * `avoidable` and never on top of it.
 *   · Turns persist per (dedup_key, engine_version, turn_index) and the SERVER is the thread's truth
 *     (O1) — the model window is the last ASK_HISTORY_MAX_TURNS turns, then the same token trim.
 *   · `gateOverlay` (§12.4) is the ONLY door to a `clinical_review` write, and it is a pure function
 *     so it can be argued with in a test rather than in production: assertion turn, `stated === true`,
 *     a closed-set decision, a quote that is REALLY a substring of what he typed, every other enum in
 *     its closed set. Anything else persists the turn, skips the overlay, and never 500s (T6).
 *   · What the overlay may never do (D14): touch `avoidable` / `planned` / `same_condition` /
 *     `preventable_injury` / `negligence`, or reach the incidence aggregator. Incidence is identical
 *     with the overlay present or absent (acceptance #6).
 */
import { validateCitations, type CitationVerdict } from './readmission-narrative-core';

// ── caps (R43-4 / R43-7) ─────────────────────────────────────────────────────────────────

/** Question length cap (chars). O2 — 2,000: 500 was too small for real pushback. */
export const ASK_QUESTION_MAX_CHARS = 2_000;
/** O1 — the model window: the last N turns (a turn = one question + its answer), read from the DB. */
export const ASK_HISTORY_MAX_TURNS = 20;
/** Token cap on the history — chars/4 as the estimate; oldest turns drop first. Raised with the turn
 *  window (O1 says "raised cap" without a number; 12,000 is the builder's figure, flagged in the R9
 *  report): 20 turns cannot fit inside the R4.3 cap of 3,000, so leaving it would have trimmed the
 *  window straight back to a handful of turns and made the raise cosmetic. */
export const ASK_HISTORY_MAX_TOKENS = 12_000;
/** Per-page-load question limit. O1 keeps it CLIENT-side as a soft brake; server-side spend ceilings
 *  are a later ship. */
export const ASK_PER_LOAD_LIMIT = 8;
/** The model call: one try, low temperature, ~90 s (R43-2). */
export const ASK_BUDGET_MS = 90_000;
/** R10-B — the TOOL-LOOP call budget. Lower than ASK_BUDGET_MS on purpose: a question that fetches
 *  records makes up to RECORD_FETCH_MAX + 1 calls, and 6 × 90 s cannot fit any function box. */
export const ASK_TOOL_CALL_BUDGET_MS = 60_000;
/** R10-B — the wall for the WHOLE loop. Past it the next call is made WITHOUT tools, so the model
 *  must answer from what it holds; acceptance #5's "honest, not an error" is this constant plus
 *  `loopExhaustedCopy`. Sits inside the ask route's maxDuration with room for the storage writes. */
export const ASK_TOOL_TOTAL_BUDGET_MS = 240_000;
export const ASK_MAX_TRIES = 1;
export const ASK_TEMPERATURE = 0.1;
export const ASK_MAX_TOKENS = 1_500;

export const ASK_WITHHELD_COPY = "The agent's answer failed its citation check and was not shown — try rephrasing the question.";
export const ASK_WORKING_COPY = 'The agent is reading the case — this takes about half a minute';
export const ASK_SUGGESTIONS: readonly string[] = ['Why was this case flagged?', 'What does the operative note show?', 'Why is negligence unknown?'] as const;
/** R9 §12.3 flipped it once (the old sentence ended "nothing you ask changes the case", which had
 *  stopped being true the moment a stated judgement began to persist).
 *  R10-D12 — the advisory flips AGAIN, and for the same reason it flipped in R9: it had stopped
 *  being true. R9's sentence said the answers cite "this case's stored evidence", which is no longer
 *  the whole world the agent can reach — it can now pull this patient's OTHER records into the
 *  conversation. The sentence names that, names that what it pulls is labelled and cited, and keeps
 *  the two clauses that have not changed: a stated judgement is saved, and nothing moves incidence. */
export const ASK_ADVISORY = 'Advisory — the agent answers from this case\'s evidence and can fetch this patient\'s other records into the conversation; retrieved evidence is labelled and cited; your stated judgement is saved as clinical review; nothing here changes incidence.';
export const ASK_THREAD_UNAVAILABLE_COPY = 'the earlier conversation could not be loaded — ask again and this turn will still be saved';

// ── the material (R43-1 / R43-8) ─────────────────────────────────────────────────────────

export interface AskLedgerItem { id: string; source: string; side: string | null; at: string | null; weight: string; text: string }
export interface AskBill { ok: boolean; groups: Array<{ serviceType: string; netRs: number; lines: number }>; totalRs: number; lines: number }

/** What the model may see. Assembled by the route from STORED artefacts + the two bills the case
 *  page already reads. No patient name, no UHID, no encounter id (R43-8). */
export interface AskMaterial {
  ledger: AskLedgerItem[];
  /** The VALID stored account, or null (an invalid / absent account is not shown to the model either). */
  account: string | null;
  judgements: { planned: string | null; sameCondition: string | null; justification: string; preventableInjury: string; negligence: string; findingClass: string; lane: string; gapDays: number | null };
  coverage: Array<{ label: string; state: string }>;
  bills: { index: AskBill | null; readmit: AskBill | null; returnCell: string };
  refusals: Array<{ lookedFor: string; note?: string }>;
}

export interface AskTurn { question: string; answer: string }

/** PURE: trim, cap, reject empty / over-long / control-character questions. */
export function normaliseQuestion(raw: unknown): { ok: true; question: string } | { ok: false; error: string } {
  const q = typeof raw === 'string' ? raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!q) return { ok: false, error: 'question required' };
  if (q.length > ASK_QUESTION_MAX_CHARS) return { ok: false, error: `question too long — ${ASK_QUESTION_MAX_CHARS} characters at most` };
  return { ok: true, question: q };
}

/** PURE: the last ≤ ASK_HISTORY_MAX_TURNS well-formed turns, then oldest-first drop until the
 *  chars/4 estimate fits ASK_HISTORY_MAX_TOKENS. Junk turns are skipped, never a throw. */
export function capHistory(raw: unknown): AskTurn[] {
  const arr = Array.isArray(raw) ? raw : [];
  const turns: AskTurn[] = [];
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const q = typeof o.question === 'string' ? o.question.trim() : '';
    const a = typeof o.answer === 'string' ? o.answer.trim() : '';
    if (!q || !a) continue;
    turns.push({ question: q.slice(0, ASK_QUESTION_MAX_CHARS), answer: a.slice(0, 4_000) });
  }
  let kept = turns.slice(-ASK_HISTORY_MAX_TURNS);
  const tokens = (ts: AskTurn[]) => Math.ceil(ts.reduce((n, t) => n + t.question.length + t.answer.length, 0) / 4);
  while (kept.length && tokens(kept) > ASK_HISTORY_MAX_TOKENS) kept = kept.slice(1);
  return kept;
}

// ── the answer verdict (R43-3) ───────────────────────────────────────────────────────────

export interface AskParsed { answer: string; answerable: boolean }

/** PURE: parse the model's reply — strict JSON {answer, answerable} preferred; a bare-text reply is
 *  taken as the answer with answerable:true (so it must cite). Empty → null. */
export function parseAskReply(text: string | null | undefined): AskParsed | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start >= 0) {
    for (let end = cleaned.lastIndexOf('}'); end > start; end = cleaned.lastIndexOf('}', end - 1)) {
      try {
        const o = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          // A JSON object IS the reply: an empty / missing answer is an empty reply, never bare text.
          const ans = typeof o.answer === 'string' ? o.answer.trim() : '';
          return ans ? { answer: ans, answerable: o.answerable !== false } : null;
        }
        break;
      } catch { /* keep shrinking */ }
    }
  }
  const t = cleaned.trim();
  return t ? { answer: t, answerable: true } : null;
}

export interface AskVerdict { ok: boolean; answer: string; citedIds: string[]; invalidIds: string[]; reason: CitationVerdict['reason'] }

/**
 * PURE — CODE DECIDES (R43-3): every marker in the answer must resolve to a stored ledger id — or,
 * since R10-D6, to a PERSISTED retrieved-artefact id (`X…`) — via the SAME validator that guards
 * narratives. The one deliberate difference from the narrative rule
 * (flagged in the R4.3 report): an answer the model marked `answerable:false` — "the case record
 * does not show this" — may carry NO markers, because there is no fact to cite; it must still
 * carry no UNRESOLVED marker. Everything else: unresolved id → withheld; no markers on an
 * answerable answer → withheld; empty → withheld.
 */
export function askVerdict(parsed: AskParsed | null, ledgerIds: Iterable<string>, recordIds: Iterable<string> = []): AskVerdict {
  if (!parsed) return { ok: false, answer: '', citedIds: [], invalidIds: [], reason: 'empty' };
  // R10-D6 — TWO NAMESPACES, ONE GATE. Chat-retrieved artefacts cite as `X…` and resolve against the
  // PERSISTED retrieved-artefact store, never against the audited ledger, which chat never mutates.
  // They are merged here rather than in the validator so the narrative path (one namespace, always)
  // is untouched, and so an uncited whole-record claim dies exactly like an uncited ledger claim.
  const v = validateCitations(parsed.answer, [...ledgerIds, ...recordIds]);
  if (v.valid) return { ok: true, answer: parsed.answer, citedIds: v.citedIds, invalidIds: [], reason: 'none' };
  if (v.reason === 'no_citations' && parsed.answerable === false) return { ok: true, answer: parsed.answer, citedIds: [], invalidIds: [], reason: 'none' };
  return { ok: false, answer: parsed.answer, citedIds: v.citedIds, invalidIds: v.invalidIds, reason: v.reason };
}

// ── R9 — the clinical_review overlay (§6, D13, D14, §12.4 / T6) ──────────────────────────

export const CLINICAL_REVIEW_VERSION = 'clinical_review/1';
/** The reviewer's verdict. `null` = unreviewed / question-only, and it is NOT a member of this set:
 *  a decision the gate did not accept never becomes a stored `null`, it becomes no write at all. */
export const CLINICAL_REVIEW_DECISIONS = ['justified', 'not_justified', 'insufficient'] as const;
export type ClinicalReviewDecision = (typeof CLINICAL_REVIEW_DECISIONS)[number];
export const CLINICAL_REVIEW_CLOCK_CLASSES = ['lt24h', 'd1_30', 'd31_90'] as const;
export type ClinicalReviewClockClass = (typeof CLINICAL_REVIEW_CLOCK_CLASSES)[number];
export const CLINICAL_REVIEW_LT24H_KINDS = ['paper_admin', 'deferred_staged', 'medical'] as const;
export type ClinicalReviewLt24hKind = (typeof CLINICAL_REVIEW_LT24H_KINDS)[number];
export const CLINICAL_REVIEW_EXCLUSION_CLAIMS = ['none', 'onco', 'obgyn', 'neonate', 'ophthal'] as const;
export type ClinicalReviewExclusionClaim = (typeof CLINICAL_REVIEW_EXCLUSION_CLAIMS)[number];
/** §6 — the quote is capped in the same place it is validated, so no caller can store a long one. */
export const CLINICAL_REVIEW_QUOTE_MAX_CHARS = 400;

/** The plain-words label for each decision — the case-page chip and the board filter share it. */
export const CLINICAL_REVIEW_DECISION_LABEL: Readonly<Record<ClinicalReviewDecision, string>> = {
  justified: 'Reviewer: justified',
  not_justified: 'Reviewer: not justified',
  insufficient: 'Reviewer: not enough to say',
};
/** D14 — shown BESIDE the agent's proposal, never instead of it. */
export const CLINICAL_REVIEW_CHIP_NOTE = 'clinical review by a care manager · the agent proposal above is unchanged';

/** What the gate accepts and what the store writes. `stated` is always true by construction: an
 *  inferred overlay never survives the gate, so it is never a stored value. */
export interface ClinicalReview {
  decision: ClinicalReviewDecision;
  clockClass: ClinicalReviewClockClass | null;
  lt24hKind: ClinicalReviewLt24hKind | null;
  exclusionClaim: ClinicalReviewExclusionClaim | null;
  quote: string;
}
/** The overlay as it is READ back (the stored columns plus their provenance). */
export interface StoredClinicalReview extends ClinicalReview {
  actor: string | null;
  at: string | null;
  turnId: string | null;
  model: string | null;
}

/**
 * PURE — is the user's turn an ASSERTION rather than a lone question (§12.4 rule 1)?
 *
 * Code decides, not the model: a lone question must never be able to write a clinical judgement just
 * because the model felt one was implied. The rule is deliberately conservative — a turn is an
 * assertion when it contains at least one sentence that does NOT end in a question mark. "Why was
 * this flagged?" is not an assertion; "Why was this flagged? It was a planned staged stent." is.
 */
export function isAssertionTurn(text: string | null | undefined): boolean {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return false;
  const sentences = t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  if (!sentences.length) return false;
  return sentences.some((x) => !x.endsWith('?'));
}

/** Whitespace-insensitive substring test — the model re-types a quote with its own spacing far more
 *  often than it invents one, and rejecting on a double space would only teach it to quote less. */
function containsQuote(haystack: string, needle: string): boolean {
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase();
  const h = norm(haystack), n = norm(needle);
  return n !== '' && h.includes(n);
}

export type OverlayGate =
  | { ok: true; overlay: ClinicalReview }
  | { ok: false; reason: 'absent' | 'not_an_assertion' | 'not_stated' | 'bad_decision' | 'bad_quote' | 'bad_enum' };

/**
 * PURE — §12.4 / T6: the ONLY door to a `clinical_review` write. Every failure mode is the same
 * outcome for the caller: persist the turn, skip the overlay, answer 200.
 *
 *   1. the user turn is an assertion, not a lone question   (code, not the model — isAssertionTurn)
 *   2. `stated === true`                                    (D13: inferred never writes)
 *   3. `decision` is in the closed set                      (null / unknown → no write)
 *   4. `quote` is really a substring of the user turn       (empty ⇒ reject; this is the anchor that
 *                                                            keeps the stored words HIS words)
 *   5. every other enum is null or in its closed set        (a junk enum fails the whole overlay
 *                                                            rather than being silently nulled —
 *                                                            a half-read judgement is not a judgement)
 */
export function gateOverlay(raw: unknown, userTurn: string): OverlayGate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'absent' };
  const o = raw as Record<string, unknown>;
  if (!isAssertionTurn(userTurn)) return { ok: false, reason: 'not_an_assertion' };
  if (o.stated !== true) return { ok: false, reason: 'not_stated' };
  const decision = typeof o.decision === 'string' ? o.decision.trim() : '';
  if (!(CLINICAL_REVIEW_DECISIONS as readonly string[]).includes(decision)) return { ok: false, reason: 'bad_decision' };
  const quote = typeof o.quote === 'string' ? o.quote.trim() : '';
  if (!quote || !containsQuote(userTurn, quote)) return { ok: false, reason: 'bad_quote' };
  const closed = <T extends string>(v: unknown, set: readonly T[]): T | null | undefined => {
    if (v == null || v === '') return null;
    const x = typeof v === 'string' ? v.trim() : '';
    return (set as readonly string[]).includes(x) ? (x as T) : undefined;   // undefined = out of set
  };
  const clockClass = closed(o.clock_class ?? o.clockClass, CLINICAL_REVIEW_CLOCK_CLASSES);
  const lt24hKind = closed(o.lt24h_kind ?? o.lt24hKind, CLINICAL_REVIEW_LT24H_KINDS);
  const exclusionClaim = closed(o.exclusion_claim ?? o.exclusionClaim, CLINICAL_REVIEW_EXCLUSION_CLAIMS);
  if (clockClass === undefined || lt24hKind === undefined || exclusionClaim === undefined) return { ok: false, reason: 'bad_enum' };
  return {
    ok: true,
    overlay: { decision: decision as ClinicalReviewDecision, clockClass, lt24hKind, exclusionClaim, quote: quote.slice(0, CLINICAL_REVIEW_QUOTE_MAX_CHARS) },
  };
}

/** PURE: lift the `overlay` object out of the model's reply, if it sent one. Deliberately separate
 *  from `parseAskReply` so the R4.3 answer path is byte-for-byte what it was: an overlay that cannot
 *  be found or cannot be parsed is simply absent, and absent fails the gate harmlessly. */
export function parseAskOverlay(text: string | null | undefined): unknown {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  for (let end = cleaned.lastIndexOf('}'); end > start; end = cleaned.lastIndexOf('}', end - 1)) {
    try {
      const o = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        const ov = o.overlay;
        return ov && typeof ov === 'object' && !Array.isArray(ov) ? ov : null;
      }
      break;
    } catch { /* keep shrinking */ }
  }
  return null;
}

// ── R9 — the persisted thread (O1 / D12) ─────────────────────────────────────────────────

export const ASK_TURN_ROLES = ['user', 'agent'] as const;
export type AskTurnRole = (typeof ASK_TURN_ROLES)[number];

/** One stored turn, as the thread reads back. `content` is already de-identified (R43-8 stands: the
 *  de-id rule now covers STORED turn content as well as model material). */
export interface AskThreadTurn {
  turnIndex: number;
  role: AskTurnRole;
  content: string;
  actor: string | null;
  withheld: boolean;
  at: string | null;
}

/**
 * PURE — fold the stored thread into the {question, answer} pairs the prompt builder takes. A user
 * turn opens a pair; the next agent turn closes it. A WITHHELD agent turn closes the pair and the
 * pair is DROPPED: the model must not be shown an answer that failed its own citation check, and it
 * must not be shown a dangling question either. Then the existing cap applies (last N turns, token
 * trim, oldest first) — one code path for the window, exactly as R4.3 had it.
 */
export function threadToHistory(turns: readonly AskThreadTurn[]): AskTurn[] {
  const pairs: AskTurn[] = [];
  let open: string | null = null;
  for (const t of [...turns].sort((a, b) => a.turnIndex - b.turnIndex)) {
    if (t.role === 'user') { open = typeof t.content === 'string' ? t.content.trim() : ''; continue; }
    if (open) {
      const answer = typeof t.content === 'string' ? t.content.trim() : '';
      if (!t.withheld && answer) pairs.push({ question: open, answer });
      open = null;
    }
  }
  return capHistory(pairs);
}

// ── R10-B — the record index and the second citation namespace ────────────────────────────────
//
// (CDMSS-READMISSIONS-R10-RECORD-REACH-PRD-27-AUG-2026-GO §4, R10-D4..R10-D8.)
//
// R4.3 fenced the conversation to ONE case's stored material, and that fence did real work: it is
// why an agent claim about the record cannot be invented. R10-B moves the fence rather than removing
// it. The agent may now reach the PATIENT — prior IP stays, prior OPD notes, labs, the MemberState
// snapshot, care-manager interactions — and every one of those artefacts arrives de-identified,
// labelled, persisted, and CITABLE. What it still may not do is assert anything it cannot cite.
//
// THREE PROPERTIES THIS FILE OWNS.
//   1. THE INDEX IS METADATA ONLY (R10-D8). `{id, kind, date, label}` — a type, a date, an opaque id.
//      No free text reaches the prompt until the model asks for a specific artefact, which is what
//      makes "the whole record" affordable and what keeps the default prompt small.
//   2. THE IDS ARE STABLE (R10-D7). An id, once bound to an artefact, stays bound: `mintRecordIndex`
//      takes the bindings already persisted for the thread and reuses them, minting fresh ids only
//      for artefacts nobody has fetched. Without this a citation would silently re-point on reload —
//      the one failure mode a persisted-evidence design exists to make impossible.
//   3. THE CAP IS HONEST (R10-D5). Truncation is REPORTED, per kind, in the index the model reads.
//      "The 20 most recent" is a fact about the index; letting the model believe it saw everything
//      would be a lie told by omission, which is the family of defect this whole ship is about.

/** The second namespace's prefix. `X` + digits, so it matches the citation marker grammar already. */
export const RECORD_ID_PREFIX = 'X';
/** R10-D4 — the v1 source list. Nothing else. */
export const RECORD_KINDS = ['ip_stay', 'opd_note', 'lab', 'member_state', 'cm_interaction'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
/** Most recent N per kind (kickoff, normative). Truncation beyond it is stated, not hidden. */
export const RECORD_MAX_PER_KIND = 20;
/** R10-D5 — at most this many `fetch_record` calls answer ONE question. */
export const RECORD_FETCH_MAX = 5;
/** One retrieved artefact's text cap, applied before storage and before the model sees it. */
export const RECORD_ARTEFACT_MAX_CHARS = 6_000;
/**
 * How many ALREADY-FETCHED artefacts are re-shown in full on a later turn.
 *
 * ⚠️ THIS CAP IS NOT COSMETIC. A thread may accumulate up to 200 stored artefacts; re-injecting all
 * of them at RECORD_ARTEFACT_MAX_CHARS each would put over a megabyte of prompt on turn six and the
 * call would fail — a conversation that got slowly, silently worse the longer it went on. The most
 * recent 8 are re-shown; EVERY held id still resolves for citation, so an answer that refers back to
 * an older artefact is still valid, and the prompt says how many are not shown so the model never
 * reads the cut as "those records are gone".
 */
export const RECORD_HELD_IN_PROMPT_MAX = 8;

/** Plain clinical English for each kind (R4.2's language rule: no system vocabulary on a surface). */
export const RECORD_KIND_LABEL: Readonly<Record<RecordKind, string>> = {
  ip_stay: 'earlier hospital stay',
  opd_note: 'clinic note',
  lab: 'lab results',
  member_state: 'this patient\'s combined record',
  cm_interaction: 'care-manager call',
};

export interface RecordIndexEntry {
  /** `X<n>`. The citable id, and the argument `fetch_record` takes. */
  id: string;
  kind: RecordKind;
  /** ISO date as the source stated it, or null when the source carries none. */
  date: string | null;
  /** De-identified, metadata-shaped. NEVER free clinical text (R10-D8). */
  label: string;
  /** The artefact's own stable key (kind + native uid). NOT shown to the model — it is what binds
   *  an `X<n>` to a real artefact across page loads. */
  sourceKey: string;
}
export interface RecordIndexTruncation { kind: RecordKind; shown: number; total: number }
export interface RecordIndex {
  entries: RecordIndexEntry[];
  truncated: RecordIndexTruncation[];
  /** A source that could not be read at all. Reported to the model as an ABSENCE, never omitted:
   *  "we could not read this patient's labs" and "this patient has no labs" are different facts. */
  unavailable: RecordKind[];
}

export const EMPTY_RECORD_INDEX: RecordIndex = { entries: [], truncated: [], unavailable: [] };

/** `X<n>` and nothing else. */
export function isRecordId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^X\d{1,4}$/.test(id);
}

export interface RecordCandidate { kind: RecordKind; date: string | null; label: string; sourceKey: string }
export interface RecordSourceResult { kind: RecordKind; ok: boolean; items: RecordCandidate[] }

/**
 * PURE — mint the index.
 *
 * `bound` is sourceKey → id for every artefact already persisted against this thread (R10-D7). Those
 * ids are REUSED verbatim; fresh ids continue from the highest number already in use, so a new
 * artefact can never take an id a stored citation already points at.
 *
 * Per kind: newest first (a null date sorts last — undated is not recent), capped at
 * RECORD_MAX_PER_KIND, with the overflow reported rather than dropped silently. A source that failed
 * to read is listed in `unavailable`, distinct from a source that read and returned nothing.
 */
export function mintRecordIndex(
  sources: readonly RecordSourceResult[],
  bound: ReadonlyMap<string, string> = new Map(),
): RecordIndex {
  const entries: RecordIndexEntry[] = [];
  const truncated: RecordIndexTruncation[] = [];
  const unavailable: RecordKind[] = [];
  const used = new Set<string>(bound.values());
  let next = 1;
  const mint = (sourceKey: string): string => {
    const existing = bound.get(sourceKey);
    if (existing) return existing;
    let id = `${RECORD_ID_PREFIX}${next}`;
    while (used.has(id)) { next += 1; id = `${RECORD_ID_PREFIX}${next}`; }
    used.add(id);
    next += 1;
    return id;
  };
  for (const kind of RECORD_KINDS) {
    const src = sources.find((s) => s.kind === kind);
    if (!src) continue;
    if (!src.ok) { unavailable.push(kind); continue; }
    const sorted = [...src.items].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    const shown = sorted.slice(0, RECORD_MAX_PER_KIND);
    if (sorted.length > shown.length) truncated.push({ kind, shown: shown.length, total: sorted.length });
    for (const it of shown) {
      entries.push({ id: mint(it.sourceKey), kind, date: it.date, label: it.label, sourceKey: it.sourceKey });
    }
  }
  return { entries, truncated, unavailable };
}

/**
 * PURE — the index as the model reads it. Ids, kinds, dates, labels; the truncation stated in words;
 * an unreadable source named as unreadable. Empty index ⇒ one honest sentence, never an empty block
 * the model could read as "this patient has no other records".
 */
export function renderRecordIndex(idx: RecordIndex): string {
  const lines: string[] = [];
  if (!idx.entries.length) {
    lines.push('No other records for this patient could be listed, so there is nothing to fetch. Answer from the case material alone.');
  } else {
    for (const kind of RECORD_KINDS) {
      const rows = idx.entries.filter((e) => e.kind === kind);
      if (!rows.length) continue;
      lines.push(`${RECORD_KIND_LABEL[kind]}:`);
      for (const r of rows) lines.push(`  [${r.id}] ${r.date ?? 'date not stated'} — ${r.label}`);
    }
  }
  for (const t of idx.truncated) {
    lines.push(`Only the ${t.shown} most recent of ${t.total} ${RECORD_KIND_LABEL[t.kind]} entries are listed; older ones exist and are not shown.`);
  }
  for (const k of idx.unavailable) {
    lines.push(`This patient's ${RECORD_KIND_LABEL[k]} could not be read just now — that is an unknown, not an absence.`);
  }
  return lines.join('\n');
}

/** One artefact as the tool hands it back and the store keeps it. `text` is ALREADY de-identified. */
export interface RetrievedArtefact {
  id: string;
  kind: RecordKind;
  date: string | null;
  label: string;
  sourceKey: string;
  text: string;
}

/** The chip the thread renders above a retrieved artefact (§4.4). Plain English, no system words. */
export function retrievedChipLabel(a: Pick<RetrievedArtefact, 'kind' | 'date'>): string {
  return `from the patient's record · ${RECORD_KIND_LABEL[a.kind]}${a.date ? ` · ${a.date}` : ''}`;
}

/** What a `fetch_record` for an id the index does not carry says back. An honest refusal, in the
 *  tool's own channel, so the model can correct itself inside the same turn rather than guessing. */
export function unknownRecordCopy(id: string): string {
  return `No record with id ${id} is in this patient's index. Only the ids listed there can be fetched; do not answer from an id you were not given.`;
}

/** R10-D5 / acceptance #5 — the loop is EXHAUSTED, not broken. Said in the tool channel so the model
 *  answers from what it holds, and said in plain words so the answer it writes can repeat it. */
export function loopExhaustedCopy(fetched: number): string {
  return `The limit of ${RECORD_FETCH_MAX} record fetches for one question has been reached — ${fetched} artefact(s) were retrieved. Answer now from those and from the case material, and say plainly that you stopped after ${fetched}.`;
}

/** The one Converse tool, as a JSON Schema. Named here (pure) so a test can read the contract
 *  without an AWS credential, and so the prompt and the schema cannot drift apart. */
export const FETCH_RECORD_TOOL_NAME = 'fetch_record';
export const FETCH_RECORD_TOOL_DESCRIPTION =
  "Fetch one of this patient's other records by the id shown in the record index. Returns the record's de-identified text. Only ids from the index can be fetched.";
export const FETCH_RECORD_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string', description: "The record id from the index, e.g. 'X3'." },
  },
  required: ['id'],
};

/** PURE — read the `id` argument off a tool call's JSON arguments. Anything unparseable or
 *  wrong-shaped yields null, which the caller answers with `unknownRecordCopy` rather than a throw. */
export function parseFetchRecordArgs(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const id = typeof o?.id === 'string' ? o.id.trim() : '';
    return isRecordId(id) ? id : null;
  } catch {
    return null;
  }
}
