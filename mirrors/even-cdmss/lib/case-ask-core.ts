/**
 * lib/case-ask-core.ts — the PURE half of the shared case Ask shell
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P1 / §3, O3 / O5 / O6 / O7).
 *
 * WHAT THIS IS. Readmissions already has a persisted, citation-gated conversation on its case page
 * (R9, live: lib/readmission-ask-core.ts + lib/readmission/ask-store.ts). The OPD audit case and the
 * parked IPD audit case have none. P1 puts the SAME shell on those two surfaces — and, per O3, it
 * does so by EXTRACTING the pattern rather than importing it:
 *
 *   ⚠️ DEPENDENCY DIRECTION IS ONE-WAY AND ENFORCED BY A TEST. Nothing under lib/case-ask* imports
 *   any lib/readmission* file. Readmissions is a LIVE surface; a shared import would make every
 *   future edit here a regression risk there. The citation gate below is therefore a deliberate,
 *   accepted duplicate of readmission-narrative-core.validateCitations (O3 names the duplication and
 *   defers convergence to a later ship). The two must stay behaviourally identical; the test file
 *   pins the grammar and the three refusal reasons so a silent fork is loud.
 *
 * THE FENCE (§3.1 / §3.3). The conversation's whole world is what THIS case already stored: the
 * findings the engine wrote, and the numbers it already scored. Nothing new enters a case through
 * the ask-box. An agent claim about the record dies without a resolvable citation. And — unlike R9,
 * which stores the reviewer's stated judgement as a clinical_review overlay — O5 gives OPD and IPD
 * NO overlay this ship: nothing said in this box writes NQI, CVI, band, verdict, feedback or
 * MemberState. There is no write path here to argue about, and a test asserts its absence.
 *
 * WHAT IS NEW HERE, beyond the R9 pattern (O7, closing carryover debt 3 for the new surfaces): a
 * SERVER-SIDE daily ceiling of CASE_ASK_DAILY_TURN_LIMIT agent turns per thread per IST calendar
 * day. Over the ceiling the route stores a polite refusal as a WITHHELD agent turn and makes no
 * model call — a spend brake that is a stored fact rather than a 500.
 *
 * No DB, no model, no clock: every function takes what it needs as an argument.
 */

// ── identity of the shell ────────────────────────────────────────────────────────────────

/** The shared shell's own version. It is NOT an engine version: nothing here scores anything. */
export const CASE_ASK_VERSION = 'case-ask/1';

/**
 * §3.3 / acceptance #4 — the model pin. The literal is repeated here rather than imported from
 * lib/readmission-narrative-core (O3 forbids that edge) and rather than from lib/bedrock-core (which
 * exports the allowlist MAP, not this id). The test asserts this string is a key of BEDROCK_MODELS,
 * so the pin cannot drift away from the frozen allowlist without failing the suite. No fallback
 * (F11): unserved means withhold.
 */
export const CASE_ASK_MODEL_ID = 'global.anthropic.claude-opus-4-6-v1';
export const CASE_ASK_PROVIDER = 'bedrock';

/**
 * O6 — the case types this shell serves. Readmissions is NOT one of them: it keeps its own route,
 * its own table and its own core, untouched by this ship.
 *
 * STEWARDSHIP A2 (kickoff v2, 29 Aug 2026) added `physician` and `dept`. They are a DIFFERENT SHAPE
 * of case from `opd` / `ipd` and the difference is worth naming: the first two are ONE audited
 * artefact (one note, one stay), and these two are a 90-day AGGREGATE over many of them. Everything
 * the shell guarantees still holds — the citation gate, the caps, the daily ceiling, the de-id
 * fence, the withheld discipline — because none of them knows or cares what a case is; they know
 * only that code minted the ids the answer must cite. What changes is the material builder, and
 * that lives in ONE new file (lib/case-ask/stewardship-material.ts), not in a fork of this shell.
 *
 * This union is the runtime boundary as well as the type: `isCaseAskType` below is what the
 * stewardship route uses to refuse an unknown case_type with a 400 BEFORE anything is persisted
 * (kickoff acceptance #19). The three exhaustive records keyed on it — CASE_ASK_SUGGESTIONS,
 * CASE_LABEL, and any future one — make TypeScript force an entry for every member, so a fifth
 * case type cannot be added and then silently render or prompt as nothing.
 */
export const CASE_ASK_TYPES = ['opd', 'ipd', 'physician', 'dept'] as const;
export type CaseAskType = (typeof CASE_ASK_TYPES)[number];

/**
 * PURE — the runtime half of the union (A2). `badKey()` in the store rejects an EMPTY case type;
 * it cannot reject an UNKNOWN one, because at the store the value has already been typed as a
 * CaseAskType by a cast somewhere upstream. A route that reads a case type off a query string is
 * exactly such an upstream, so the check has to exist as a value, not only as a type.
 */
export function isCaseAskType(v: unknown): v is CaseAskType {
  return typeof v === 'string' && (CASE_ASK_TYPES as readonly string[]).includes(v);
}

// ── caps (O7 — the R9 numbers, plus the new ceiling) ─────────────────────────────────────

/** Question length cap (chars). The R9 figure: 500 was too small for real pushback. */
export const ASK_QUESTION_MAX_CHARS = 2_000;
/** The model window: the last N turns (a turn = one question + its answer), read from the DB. */
export const CASE_ASK_HISTORY_MAX_TURNS = 20;
/** Token cap on the history — chars/4 as the estimate; oldest turns drop first. */
export const CASE_ASK_HISTORY_MAX_TOKENS = 12_000;
/** Per-page-load question limit — a CLIENT-side soft brake, exactly as R9 has it. */
export const ASK_PER_LOAD_LIMIT = 8;
/**
 * O7 — the SERVER-side ceiling, and the one thing P1 adds to the R9 caps: at most this many AGENT
 * turns per thread per IST calendar day. Counted on agent turns, not user turns, because the agent
 * turn is what costs a model call; a care manager who types four questions into a dead thread has
 * spent nothing. Over the ceiling: a stored withheld refusal, no model call, HTTP 200.
 */
export const CASE_ASK_DAILY_TURN_LIMIT = 40;

/** The model call: one try, low temperature, ~90 s. */
export const CASE_ASK_BUDGET_MS = 90_000;
export const CASE_ASK_MAX_TRIES = 1;
export const CASE_ASK_TEMPERATURE = 0.1;
export const CASE_ASK_MAX_TOKENS = 1_500;

// ── copy (§3.4 — the advisory is VERBATIM from the PRD; do not reword it) ────────────────

/** §3.4, verbatim. Both new surfaces show exactly this sentence. */
export const CASE_ASK_ADVISORY =
  "Answers cite this case's stored evidence. Your questions do not change scores or the member record.";
export const CASE_ASK_WITHHELD_COPY =
  "The agent's answer failed its citation check and was not shown — try rephrasing the question.";
export const CASE_ASK_WORKING_COPY = 'The agent is reading the case — this takes about half a minute';
export const CASE_ASK_THREAD_UNAVAILABLE_COPY =
  'the earlier conversation could not be loaded — ask again and this turn will still be saved';
/** O7 — what the ceiling stores. Plain, and it says when the box reopens. */
export const CASE_ASK_CEILING_COPY =
  `This conversation has reached its daily limit of ${CASE_ASK_DAILY_TURN_LIMIT} agent answers on this case. It opens again after midnight IST — the thread above is kept.`;

export const CASE_ASK_SUGGESTIONS: Readonly<Record<CaseAskType, readonly string[]>> = Object.freeze({
  opd: ['Why did this finding fire?', 'Which findings are informational?', 'What lowered the score most?'],
  ipd: ['Why is the Care-Value Index where it is?', 'What is missing from the summary?', 'Which findings are low-value?'],
  // A2 — the stewardship grains. Deliberately about PATTERNS over the 90-day window rather than
  // about one artefact, because that is the only thing the aggregate material can honestly answer.
  physician: ['What recurs across this clinician\'s notes?', 'Which findings are still open?', 'How does this clinician read against the department?'],
  dept: ['What recurs across this department?', 'Where are this department\'s open dangerous findings?', 'What is pulling this department\'s note quality down?'],
});

// ── the material the model may see (§3.1) ────────────────────────────────────────────────

/**
 * One citable thing on the case. `id` is MINTED BY CODE from the stored row (F1, F2, … for findings;
 * C1, C2, … for the case's already-scored numbers), never by the model, and the answer's markers are
 * checked back against exactly this set.
 */
export interface CaseAskItem {
  id: string;
  /** What kind of stored thing this is, in plain words for the prompt ('finding', 'score', 'gap'). */
  kind: string;
  /** The short label — a finding's subject, or the name of the number. */
  label: string;
  /** The stored detail — a finding's rationale, or the number and its band. */
  text: string;
}

/**
 * Everything the model may see. Assembled by the route from the audit ROW's stored artefacts and
 * nothing else — no Metabase note text, no db13 join, no PDF, no identity (§3.3). The material is
 * de-identified BY CONSTRUCTION: the OPD audit stores a de-identified case and the IPD audit stores
 * a de-identified report, and neither the patient's name nor the UHID nor the encounter id is read
 * into this object at all.
 */
export interface CaseAskMaterial {
  caseType: CaseAskType;
  /** The engine version the case was scored under — shown to the model as context, never as a fact. */
  engineVersion: string;
  /** The case's stored findings and already-scored numbers. Cited by id. */
  items: CaseAskItem[];
  /** Honest holes: what the audit looked for and did not find. */
  gaps: string[];
  /**
   * P3.1 — one sentence about HOW this reading read the case, when the reading needs one. Optional
   * and surface-agnostic: OPD never sets it, so the OPD prompt is byte-identical with and without
   * this field (a test pins that). The IPD stay-level reading sets it to the stay auditor's own
   * absence instruction, so the chat box reads a NOT AVAILABLE class exactly the way the engine
   * that wrote the row was told to read one — the same words, not a paraphrase of them.
   */
  readingNote?: string;
  /**
   * S4 — the OVERLAY CLAUSE, for a surface whose reviewer is allowed to state a judgement that gets
   * stored. Optional and surface-agnostic in exactly the way `readingNote` is: OPD and IPD never set
   * it, so their prompts do not move a byte (a test pins that), and O5's "no overlay on those two
   * surfaces this ship" stays true by construction rather than by review.
   *
   * The shell renders what it is handed and knows nothing about standings: `clause` becomes an extra
   * rule and `schema` replaces the reply shape. The words, the closed enum and the gate that decides
   * whether anything is written all live with the surface that owns them
   * (lib/physician-standing-core.ts), which is why this field is two strings rather than a concept.
   */
  overlay?: { clause: string; schema: string };
}

export interface CaseAskTurn { question: string; answer: string }

// ── the de-identification fence (§3.3) ───────────────────────────────────────────────────

/**
 * PURE — strip identifier-SHAPED tokens out of a string before it becomes model material or a stored
 * turn. Applied to the auditor's own typed question, which is the ONLY text on this path the system
 * did not itself assemble.
 *
 * ⚠️ HONEST LIMIT, stated rather than papered over: this catches SHAPES (long digit runs, IP/UHID-
 * style ids, UUIDs, e-mail addresses), not NAMES. No pure function can recognise a patient's name in
 * free text, and one that guessed would redact clinical words. The real fence against a name is
 * structural and holds regardless: the material carries none, so a name typed into the box has
 * nothing to attach to and no downstream reader that resolves it. The system prompt also tells the
 * model never to repeat one. What this function guarantees is the narrower, checkable thing — that
 * an MRN / UHID / IP number pasted into the box does not reach the model or the turns table.
 */
export function deidentify(raw: string | null | undefined): string {
  let t = typeof raw === 'string' ? raw : '';
  if (!t) return '';
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]');   // uuid
  t = t.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]');               // e-mail
  t = t.replace(/\b(?:UHID|MRN|IPNO|IP\s?NO|OPNO|OP\s?NO)\s*[:#-]?\s*[A-Za-z0-9-]{3,}\b/gi, '[id]');
  t = t.replace(/\b[A-Za-z]{2,5}[-/]?\d{5,}\b/g, '[id]');                                        // ABC-123456
  t = t.replace(/\b\d{6,}\b/g, '[id]');                                                          // bare long numbers
  return t;
}

/** PURE: trim, scrub identifiers, cap, reject empty / over-long / control-character questions. */
export function normaliseQuestion(raw: unknown): { ok: true; question: string } | { ok: false; error: string } {
  const cleaned = typeof raw === 'string'
    ? raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim()
    : '';
  if (!cleaned) return { ok: false, error: 'question required' };
  if (cleaned.length > ASK_QUESTION_MAX_CHARS) return { ok: false, error: `question too long — ${ASK_QUESTION_MAX_CHARS} characters at most` };
  const q = deidentify(cleaned).trim();
  if (!q) return { ok: false, error: 'question required' };
  return { ok: true, question: q };
}

// ── the citation gate (O3 — this shell's OWN, deliberately duplicated) ───────────────────

/** The marker grammar: 1–4 upper-case letters then digits, inside square brackets, optionally a
 *  list. Prose in brackets ("[unknown]", "[id]") is NOT a marker and is ignored, never counted
 *  invalid — which matters here because `deidentify` writes exactly that shape. */
const MARKER_RE = /\[([A-Z]{1,4}\d{1,4}(?:\s*[,;/]\s*[A-Z]{1,4}\d{1,4})*)\]/g;

/** PURE: every id named by every marker, deduped, in order of first appearance. */
export function extractCitedIds(text: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(MARKER_RE)) {
    for (const raw of m[1].split(/\s*[,;/]\s*/)) {
      const id = raw.trim();
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}

export type CaseAskCitationReason = 'none' | 'empty' | 'no_citations' | 'unresolved_ids';

export interface CaseAskParsed {
  answer: string;
  answerable: boolean;
  /**
   * S4 — whatever the model put under "overlay", UNVALIDATED and untyped on purpose. This shell
   * does not know what an overlay means; it carries the claim to the surface that asked for one,
   * and that surface's gate decides whether it becomes a stored row. Absent on every reply that
   * did not ask for one.
   */
  overlay?: unknown;
}

/** PURE: parse the model's reply — strict JSON {answer, answerable} preferred; a bare-text reply is
 *  taken as the answer with answerable:true (so it must cite). Empty → null. */
export function parseAskReply(text: string | null | undefined): CaseAskParsed | null {
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
          if (!ans) return null;
          // The overlay rides along untouched. A reply with no overlay key produces a parsed object
          // with no overlay key, so a surface that never asked for one cannot receive one.
          return o.overlay !== undefined
            ? { answer: ans, answerable: o.answerable !== false, overlay: o.overlay }
            : { answer: ans, answerable: o.answerable !== false };
        }
        break;
      } catch { /* keep shrinking */ }
    }
  }
  const t = cleaned.trim();
  return t ? { answer: t, answerable: true } : null;
}

export interface CaseAskVerdict {
  ok: boolean;
  answer: string;
  citedIds: string[];
  invalidIds: string[];
  reason: CaseAskCitationReason;
}

/**
 * PURE — CODE DECIDES (§3.1, acceptance #5): every marker in the answer must resolve to an id the
 * route minted from this case's stored material. The one deliberate exception, identical to R9's:
 * an answer the model marked `answerable:false` — "the case record does not show this" — may carry
 * NO markers, because there is no fact to cite; it must still carry no UNRESOLVED marker. Everything
 * else: unresolved id → withheld; no markers on an answerable answer → withheld; empty → withheld.
 */
export function caseAskVerdict(parsed: CaseAskParsed | null, knownIds: Iterable<string>): CaseAskVerdict {
  if (!parsed) return { ok: false, answer: '', citedIds: [], invalidIds: [], reason: 'empty' };
  const text = (parsed.answer ?? '').trim();
  if (!text) return { ok: false, answer: '', citedIds: [], invalidIds: [], reason: 'empty' };
  const cited = extractCitedIds(text);
  if (!cited.length) {
    return parsed.answerable === false
      ? { ok: true, answer: text, citedIds: [], invalidIds: [], reason: 'none' }
      : { ok: false, answer: text, citedIds: [], invalidIds: [], reason: 'no_citations' };
  }
  const known = new Set(knownIds);
  const invalid = cited.filter((id) => !known.has(id));
  if (invalid.length) return { ok: false, answer: text, citedIds: cited, invalidIds: invalid, reason: 'unresolved_ids' };
  return { ok: true, answer: text, citedIds: cited, invalidIds: [], reason: 'none' };
}

// ── the persisted thread (§3.2, O5) ──────────────────────────────────────────────────────

export const CASE_ASK_TURN_ROLES = ['user', 'agent'] as const;
export type CaseAskTurnRole = (typeof CASE_ASK_TURN_ROLES)[number];

/** One stored turn as the thread reads back. `content` is already de-identified (§3.3 covers STORED
 *  turn content as well as model material). */
export interface CaseAskThreadTurn {
  turnIndex: number;
  role: CaseAskTurnRole;
  content: string;
  actor: string | null;
  withheld: boolean;
  /** UTC ISO instant the turn was stored, or null when the row could not report one. */
  at: string | null;
}

/** PURE: the last ≤ CASE_ASK_HISTORY_MAX_TURNS well-formed turns, then oldest-first drop until the
 *  chars/4 estimate fits the token cap. Junk turns are skipped, never a throw. */
export function capHistory(raw: unknown): CaseAskTurn[] {
  const arr = Array.isArray(raw) ? raw : [];
  const turns: CaseAskTurn[] = [];
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const q = typeof o.question === 'string' ? o.question.trim() : '';
    const a = typeof o.answer === 'string' ? o.answer.trim() : '';
    if (!q || !a) continue;
    turns.push({ question: q.slice(0, ASK_QUESTION_MAX_CHARS), answer: a.slice(0, 4_000) });
  }
  let kept = turns.slice(-CASE_ASK_HISTORY_MAX_TURNS);
  const tokens = (ts: CaseAskTurn[]) => Math.ceil(ts.reduce((n, t) => n + t.question.length + t.answer.length, 0) / 4);
  while (kept.length && tokens(kept) > CASE_ASK_HISTORY_MAX_TOKENS) kept = kept.slice(1);
  return kept;
}

/**
 * PURE — fold the stored thread into the {question, answer} pairs the prompt builder takes. A user
 * turn opens a pair; the next agent turn closes it. A WITHHELD agent turn closes the pair and the
 * pair is DROPPED (§3.2): the model must not be shown an answer that failed its own citation check,
 * or a refusal it did not write, and it must not be shown a dangling question either. Then the cap
 * applies — one code path for the window.
 */
export function threadToHistory(turns: readonly CaseAskThreadTurn[]): CaseAskTurn[] {
  const pairs: CaseAskTurn[] = [];
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

// ── the daily ceiling (O7) ───────────────────────────────────────────────────────────────

/** PURE given its argument: the IST calendar day containing `at`. en-CA renders YYYY-MM-DD; the
 *  timeZone does the shift. An unparseable instant returns '' and is counted against no day. */
export function istDayOf(at: string | Date | null | undefined): string {
  if (at == null || at === '') return '';
  const d = at instanceof Date ? at : new Date(String(at));
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '';
}

/** PURE: how many AGENT turns this thread already stored on the IST day containing `now`. A turn
 *  whose stored instant is unreadable counts against no day — it cannot be proved to be today's, and
 *  refusing on unreadable evidence would silently shrink a real ceiling. */
export function agentTurnsOnIstDay(turns: readonly CaseAskThreadTurn[], now: string | Date): number {
  const day = istDayOf(now);
  if (!day) return 0;
  let n = 0;
  for (const t of turns) if (t.role === 'agent' && istDayOf(t.at) === day) n++;
  return n;
}

/**
 * PURE — O7 / acceptance #3. True when the NEXT agent turn would exceed the day's ceiling, so the
 * route stores the refusal instead of calling the model. Deliberately `>=`: with the limit at 40, the
 * 41st agent turn of an IST day is the one refused.
 */
export function overDailyCeiling(turns: readonly CaseAskThreadTurn[], now: string | Date): boolean {
  return agentTurnsOnIstDay(turns, now) >= CASE_ASK_DAILY_TURN_LIMIT;
}

// ── the prompt (§3.1 / §3.3) ─────────────────────────────────────────────────────────────

const CASE_LABEL: Readonly<Record<CaseAskType, string>> = Object.freeze({
  opd: "an OPD consultation note's audit",
  ipd: "an inpatient stay's discharge-summary audit",
  // A2 — the two stewardship grains. The surrounding sentence says "ONE clinical case", which reads
  // a little oddly over an aggregate; it is left byte-identical on purpose, because the OPD and IPD
  // prompts are pinned by test and a reworded shared sentence would move them for no gain. Flagged
  // in the S1 slice report.
  physician: "one named clinician's own audited work over the last 90 days",
  dept: "one department's audited work over the last 90 days",
});

/**
 * PURE — the one prompt both new surfaces send. It differs from the readmission Ask prompt in the
 * two ways the PRD requires and in no other: the material is an AUDIT's stored findings and numbers
 * rather than a readmission ledger, and there is NO overlay clause at all (O5 — OPD and IPD get no
 * clinical_review this ship, so the model is never asked to report one and the reply schema has no
 * slot for one to arrive in).
 */
export function buildCaseAskPrompt(
  material: CaseAskMaterial,
  history: readonly CaseAskTurn[],
  question: string,
): { system: string; user: string } {
  return {
    system: `You are answering an auditor's question about ONE clinical case — ${CASE_LABEL[material.caseType]} — in a review room. Your entire world is the case material below: the findings this audit already wrote and the numbers it already scored. Rules, in order:
1. Answer ONLY from that material. If the material does not answer the question, say plainly that the case record does not show it — never fill the gap from general medical knowledge, never guess.
2. Every factual sentence you write must carry a citation marker naming ids in square brackets — [F3], [C1], or a list [F3, C1]. You may cite NOTHING that is not in the material; a single invented id discards the whole answer. When you say the record does not show something, set "answerable": false and cite nothing.
3. A missing document or an absent finding is UNKNOWN, never a clean result. Never say the audit found a case clean because a check has no finding.
4. No diagnosis and no treatment advice for the patient. The audit's findings and its score are advisory rule and model outputs, not a peer-review or disciplinary conclusion — say so if asked what they mean.
5. Never write a patient name, a UHID, an IP or OP number, or any other identifier. None is in the material; if the auditor types one, do not repeat it.
6. Nothing said in this conversation changes the audit. You cannot rescore, re-run, or re-verdict anything, and you must not offer to.
7. Plain clinical English. Never internal system vocabulary (engine ids, column names, "signal_type", tier names). Be brief: two to six sentences, or a short list if the question asks for one. Plain text only — no markdown (no **bold**, no headings, no bullet characters); a list is plain numbered lines.${material.overlay ? `\n8. ${material.overlay.clause}` : ''}
${material.overlay ? material.overlay.schema : 'Return STRICT JSON only: {"answer": "<your answer with [id] markers>", "answerable": true|false} — nothing before or after it.'}`,
    user: `THIS CASE was audited by the ${material.engineVersion} engine.

CASE MATERIAL (cite ONLY these ids):
${material.items.map((i) => `[${i.id}] (${i.kind}) ${i.label}${i.text ? ` — ${i.text}` : ''}`).join('\n') || '(nothing stored for this case)'}
${material.gaps.length ? `\nLOOKED FOR AND NOT FOUND: ${material.gaps.join('; ')}.` : ''}${material.readingNote ? `\n\n${material.readingNote}` : ''}
${history.length ? `\nEARLIER IN THIS CONVERSATION (context only — do not repeat). Anything the auditor asserts here is HIS OWN statement: you may use it as his account, always labelled as his, and you may never write it as though the record said it:\n${history.map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`).join('\n')}\n` : ''}
AUDITOR'S TURN: ${question}`,
  };
}
