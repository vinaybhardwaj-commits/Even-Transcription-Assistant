/**
 * lib/lvp-operator-core.ts — Low-value patterns L2: the PURE core (CDMSS LVP-L2 kickoff, 20 Aug 2026;
 * Addendum C rulings O11–O15, V).
 *
 * L2 REPLACES COPY AND NOTHING ELSE (O11). The operator writes a `title` and a `why` per
 * `pattern_id`. Volume, doctor count, since-date, examples, pill, stable id, sort order and both
 * caps stay exactly where L1 computes them — on read, deterministically, untouched by this file.
 * A pattern with no decoration keeps `patternTitle()` / `whyText()` stub copy, which is why
 * lib/lvp-core.ts's stub functions are the fallback and are not deleted.
 *
 * Everything here is PURE: prompt assembly, output parsing, validation, the forbidden-strings
 * filter and the count rule. No IO, no env read at module scope, no model call — those live in
 * lib/lvp-operator.ts.
 *
 * ⚠️ MODEL TEXT NEVER REACHES THE PAGE UNFILTERED (§5). Every decoration passes length caps, the
 * forbidden-strings filter AND the count rule (L2.1) server-side BEFORE any write. A violation is
 * rejected ROW-WISE: that one pattern keeps its stub copy and the rest of the run proceeds. There is no "sanitise and keep"
 * path — a rewritten sentence is a sentence nobody wrote.
 */

// ── the model (O12) ──────────────────────────────────────────────────────────────────────────────
// Opus on Bedrock, reached through governedChat with `{ bedrock: … }`. NEVER OpenRouter, never
// Gemini, never the local mini — F11 makes an explicit Bedrock target that cannot be served throw.

/** `lib/bedrock-core.ts:35`. Overridable by LVP_OPERATOR_MODEL; an unlisted id is refused there. */
export const LVP_OPERATOR_MODEL_DEFAULT = 'global.anthropic.claude-opus-4-6-v1';

export function operatorModel(env: Record<string, string | undefined>): string {
  const override = (env.LVP_OPERATOR_MODEL ?? '').trim();
  return override || LVP_OPERATOR_MODEL_DEFAULT;
}

// ── validation (§5) ──────────────────────────────────────────────────────────────────────────────

export const LVP_TITLE_MAX = 90;
export const LVP_WHY_MAX = 400;

/**
 * The forbidden vocabulary, unchanged from L1 §4.6. These are the words that would turn a shelf
 * back into the adjudication queue the shelf replaced: a ratification workflow, a routing action,
 * a scoring claim, or the "metal detector" metaphor V rejected. Matched case-insensitively, because
 * a capitalised violation is the same violation.
 */
export const LVP_FORBIDDEN_STRINGS: readonly string[] = [
  'Ratify',
  'physician-ratified',
  'Even Adjudicated',
  'Route to doctor',
  'Valid signal',
  'Audit bug',
  'Generate candidates',
  'pending ratification',
  'will affect the score',
  'metal detector',
];

/** Every forbidden string present in `text`, in the canonical casing of the list. */
export function forbiddenHits(text: string): string[] {
  const haystack = String(text ?? '').toLowerCase();
  return LVP_FORBIDDEN_STRINGS.filter((f) => haystack.includes(f.toLowerCase()));
}

// ── the count rule (L2.1 §2.1) ───────────────────────────────────────────────────────────────────

/**
 * FROZEN NUMBERS. The card header renders `×N this week` and `N doctors` and RECOMPUTES both on
 * every read, from a rolling seven-day window. A number written into `title` or `why` froze at
 * generation time; the two drift apart inside a single day — the antibiotic kind moved ×101 → ×100
 * between two reads a few hours apart — and a care manager cannot tell which number is live.
 *
 * L2 stated this rule in the prompt only. Opus ignored it in 12 of 28 cards, 43%. The hard rules
 * that were VALIDATED here — forbidden strings, length caps — held perfectly, zero rejections.
 * A rule that matters gets a validator, not a sentence in a prompt.
 *
 * ⚠️ CLINICAL NUMBERS MUST SURVIVE. Dose ceilings, thresholds and strengths are the most valuable
 * content in this copy: `200 mg/day`, `120 mg`, `4 g/day`, `60,000 IU`, `25-OH-D`, `COX-2`. They
 * are numbers bound to a unit, a drug name or a dosing schedule — never to a count noun — and they
 * do not drift. maskClinicalNumbers() removes them before the count rule reads the text at all.
 */

/**
 * THE SPLIT (L2.2 §2.1). The card recomputes and displays exactly two quantities: volume of
 * findings and doctor spread. It never displays prescriptions, cases, encounters or notes.
 *
 * So a number beside `doctors` or `findings` restates a tally that DRIFTS, and rejects
 * unconditionally. A number beside the others describes CONTENT — "two NSAIDs on one prescription"
 * is clinical composition and is exactly what that card is about — and rejects only when a volume
 * marker sits in the window with it. L2.1 rejected all of them alike and cost three correct cards
 * their copy on the first live run.
 */
export const LVP_RECOMPUTED_COUNT_NOUNS: readonly string[] = [
  'doctor', 'doctors', 'finding', 'findings',
];

/** Nouns the card does NOT display. A number near one of these needs a volume marker to reject. */
export const LVP_CONTENT_NOUNS: readonly string[] = [
  'prescription', 'prescriptions', 'case', 'cases', 'encounter', 'encounters',
  'note', 'notes', 'time', 'times',
];

/** Both lists, in the L2.1 order. The mask guard uses the union: no mask may swallow any of them. */
export const LVP_COUNT_NOUNS: readonly string[] = [
  ...LVP_RECOMPUTED_COUNT_NOUNS, ...LVP_CONTENT_NOUNS,
];

/**
 * What turns a content noun back into a tally. "43 cases this week" is the card's own quantity
 * wearing a different noun; "two NSAIDs on one prescription" is not. Token sequences, matched on
 * the same masked token stream as everything else.
 */
export const LVP_VOLUME_MARKERS: ReadonlyArray<readonly string[]> = [
  ['this', 'week'], ['in', 'total'], ['so', 'far'], ['across'],
  ['last', 'seven', 'days'], ['per', 'week'],
];

/** Digits are not enough: the run produced "Forty-three findings" and "Ten findings". */
export const LVP_NUMBER_WORDS: readonly string[] = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety', 'hundred',
];

/**
 * How far apart a number and a count noun may sit and still be one claim, in tokens. `13 doctors`
 * is 1 and `43 similar findings` is 2; 3 leaves one token of slack and stops well short of joining
 * two sentences. Wider would start catching a dose in one clause and a noun in the next.
 */
export const LVP_COUNT_WINDOW = 3;

/**
 * Frozen RANKINGS. "the second-highest volume pattern this week" carries no digit but is a
 * position in an ordering that is recomputed on every read, so it drifts exactly like a count.
 */
export const LVP_RANKING_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'highest-volume', re: /\bhighest[\s-]+volume\b/gi },
  { label: 'second-highest', re: /\bsecond[\s-]+highest\b/gi },
  { label: 'most common this week', re: /\bmost[\s-]+common[\s-]+this[\s-]+week\b/gi },
  { label: 'largest', re: /\blargest\b/gi },
];

/**
 * A number, including a grouped one. A thousands separator may be a comma, a full stop, a space or
 * a non-breaking space — `60,000` and `60 000` are the same dose, and L2.1 matched only the first,
 * which is the leading hypothesis for the vitamin D rejection (§1). A separator must be followed by
 * EXACTLY three digits, so NUM can never swallow the word after it: `13 doctors` stays `13`.
 */
const NUM = String.raw`\d+(?:[.,\u00A0\u202F ]\d{3})*(?:[.,]\d+)?`;
const NUMBER_WORD_ALT = LVP_NUMBER_WORDS.join('|');
const ANY_NUMBER = String.raw`(?:${NUM}|\b(?:${NUMBER_WORD_ALT})\b)`;

/** A digit or a number word carrying `%`, `percent`, `per cent` or `percentage`. */
const PERCENTAGE_RE = new RegExp(String.raw`${ANY_NUMBER}\s*(?:%|per\s?cent\w*)`, 'gi');

/** Dose and measure units. Longest first — the alternation is first-match, and `mmol` must beat `mm`. */
const CLINICAL_UNITS = 'mmhg|mmol|kcal|units|unit|mcg|meq|mol|ml|mg|kg|dl|ng|cm|mm|iu|µg|ug|g|l|u';

/**
 * The shapes a clinical number takes. Everything these match is removed before the count
 * rule runs, which is why `200 mg/day` and `COX-2` survive and `13 doctors` does not.
 */
const CLINICAL_MASKS: ReadonlyArray<{ re: RegExp; guard: boolean }> = [
  // bound to a unit, with or without a per-something tail: 200 mg/day · 120 mg · 4 g/day · 60,000 IU
  { re: new RegExp(String.raw`${ANY_NUMBER}\s*(?:${CLINICAL_UNITS})\b(?:\s*\/\s*[a-z]+)?`, 'gi'), guard: true },
  // welded into a term: COX-2 · 25-OH-D · B12 · omega-3
  { re: /[a-z][a-z0-9]*-?\d+(?:[.,]\d+)*[a-z0-9-]*|\d+(?:[.,]\d+)*-[a-z][a-z0-9-]*/gi, guard: true },
  // a dosing SCHEDULE: "three times a day" is a frequency, not a volume, and it does not drift.
  // UNGUARDED, and it has to be: the phrase contains `times`, which is itself a count noun. The
  // narrowness is the safety — "a day", "per week", "daily" is a rate; "43 times this week" is a
  // volume, matches nothing here, and is still rejected.
  { re: new RegExp(String.raw`${ANY_NUMBER}[\s-]+times?[\s-]+(?:a|per)[\s-]+(?:day|week|month|dose)\b`, 'gi'), guard: false },
  { re: new RegExp(String.raw`${ANY_NUMBER}[\s-]+times?[\s-]+(?:daily|weekly|monthly)\b`, 'gi'), guard: false },
];

const COUNT_NOUN_RE = new RegExp(String.raw`\b(?:${LVP_COUNT_NOUNS.join('|')})\b`, 'i');
const TOKEN_RE = new RegExp(String.raw`[a-z]+|${NUM}`, 'g');

/**
 * Blank out every clinical number, preserving offsets so a hit can still be quoted from the
 * original. On the two GUARDED masks a match that would swallow a count noun is refused — a
 * `13-doctor spread` must not buy its way out of the rule by hyphenating itself into a compound
 * term. The two schedule masks are unguarded by necessity; see the note on them.
 */
function maskClinicalNumbers(lower: string): string {
  let out = lower;
  for (const { re, guard } of CLINICAL_MASKS) {
    out = out.replace(re, (m) => (guard && COUNT_NOUN_RE.test(m) ? m : '#'.repeat(m.length)));
  }
  return out;
}

export interface FrozenNumberHit {
  kind: 'count' | 'percentage' | 'ranking';
  /** The offending span, quoted from the text as written. */
  text: string;
}

/**
 * Every frozen number in `text`. [] means the copy may be written.
 *
 * Percentages and rankings are read from the raw text; counts are read from the MASKED text, so a
 * dose can never be mistaken for a volume. Deduplicated by kind+span, because one sentence
 * repeating "13 doctors" is one violation to report, not two.
 */
export function frozenNumberHits(text: string): FrozenNumberHit[] {
  const original = String(text ?? '');
  const lower = original.toLowerCase();
  const hits: FrozenNumberHit[] = [];
  const push = (kind: FrozenNumberHit['kind'], start: number, end: number) => {
    const snippet = original.slice(start, end).trim();
    if (!snippet) return;
    if (hits.some((h) => h.kind === kind && h.text === snippet)) return;
    hits.push({ kind, text: snippet });
  };

  for (const m of lower.matchAll(PERCENTAGE_RE)) push('percentage', m.index, m.index + m[0].length);
  for (const { re } of LVP_RANKING_PATTERNS) {
    for (const m of lower.matchAll(re)) push('ranking', m.index, m.index + m[0].length);
  }

  const tokens = [...maskClinicalNumbers(lower).matchAll(TOKEN_RE)]
    .map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
  const numberWords = new Set(LVP_NUMBER_WORDS);
  const recomputed = new Set(LVP_RECOMPUTED_COUNT_NOUNS);
  const content = new Set(LVP_CONTENT_NOUNS);

  /** Does a volume marker sit within the window of the number/noun pair at [lo, hi]? */
  const markerNear = (lo: number, hi: number): boolean => {
    const from = Math.max(0, lo - LVP_COUNT_WINDOW);
    const to = Math.min(tokens.length - 1, hi + LVP_COUNT_WINDOW);
    for (let k = from; k <= to; k++) {
      for (const phrase of LVP_VOLUME_MARKERS) {
        if (phrase.every((w, n) => tokens[k + n]?.text === w)) return true;
      }
    }
    return false;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!/^\d/.test(t.text) && !numberWords.has(t.text)) continue;
    const from = Math.max(0, i - LVP_COUNT_WINDOW);
    const to = Math.min(tokens.length - 1, i + LVP_COUNT_WINDOW);
    for (let j = from; j <= to; j++) {
      if (j === i) continue;
      const noun = tokens[j].text;
      // A recomputed noun rejects on sight; a content noun needs a volume marker with it.
      if (!recomputed.has(noun) && !(content.has(noun) && markerNear(Math.min(i, j), Math.max(i, j)))) continue;
      push('count', Math.min(t.start, tokens[j].start), Math.max(t.end, tokens[j].end));
      break;
    }
  }
  return hits;
}

// ── rejection logging (L2.2 §2.4) ───────────────────────────────────────────────────────────────

/**
 * The rule a problem message names. A rejection currently vanishes on a cron run — the caller is a
 * cron nobody reads — which is why §1's vitamin D row is a hypothesis and not a fact. Classifying
 * the rule makes the warn line greppable, so the next surprise is answered from the logs.
 *
 * This reads the message vocabulary rather than a parallel structured field, deliberately: the
 * `problems: string[]` shape is returned in the route's JSON and is not worth breaking for a log.
 */
export function problemRule(problem: string): string {
  const p = String(problem ?? '');
  if (/the card recomputes this on every read/.test(p)) {
    const kind = /— (count|percentage|ranking) "/.exec(p);
    return kind ? kind[1] : 'frozen-number';
  }
  if (/forbidden on this page/.test(p)) return 'forbidden-string';
  if (/exceeds the \d+-character cap/.test(p)) return 'length-cap';
  if (/: required$/.test(p)) return 'required';
  if (/must be an object/.test(p)) return 'shape';
  return 'unknown';
}

/**
 * One warn line per rejected problem: pattern id, the rule that fired, and the span it fired on.
 *
 * ⚠️ THE SPAN ONLY, NEVER THE WHOLE DECORATION. The quoted span already sits inside the problem
 * message; nothing here reaches for `title` or `why` in full. Rejected text is unvalidated model
 * output — it is not persisted to any table (§2.4) and it does not belong in a log either.
 */
export function rejectionLogLines(
  rejections: ReadonlyArray<{ pattern_id: string; problems: readonly string[] }>,
): string[] {
  const lines: string[] = [];
  for (const r of rejections) {
    for (const problem of r.problems) {
      lines.push(`[lvp-operator] rejected ${r.pattern_id} · rule=${problemRule(problem)} · ${problem}`);
    }
  }
  return lines;
}

export interface Decoration {
  pattern_id: string;
  title: string;
  why: string;
}

export type DecorationProblem = string;

/**
 * Row-wise validation. Returns [] when the decoration may be written.
 *
 * Length is measured on the TRIMMED string, because that is what the card renders. Emptiness is a
 * rejection and not a silent stub fallback: a model that returned an empty title did not decline,
 * it failed, and the two must not read the same in the run counts.
 *
 * Three checks per field, in the order a reader would apply them: length, forbidden vocabulary,
 * then frozen numbers (L2.1). All three report, so one rejection names every reason for it.
 */
export function validateDecoration(raw: unknown): DecorationProblem[] {
  const problems: DecorationProblem[] = [];
  if (raw == null || typeof raw !== 'object') return ['decoration: must be an object'];
  const d = raw as Record<string, unknown>;

  const patternId = typeof d.pattern_id === 'string' ? d.pattern_id.trim() : '';
  if (!patternId) problems.push('pattern_id: required');

  for (const [field, max] of [['title', LVP_TITLE_MAX], ['why', LVP_WHY_MAX]] as const) {
    const v = typeof d[field] === 'string' ? (d[field] as string).trim() : '';
    if (!v) { problems.push(`${field}: required`); continue; }
    if (v.length > max) problems.push(`${field}: ${v.length} characters exceeds the ${max}-character cap`);
    const hits = forbiddenHits(v);
    if (hits.length) problems.push(`${field}: forbidden on this page — ${hits.join(', ')}`);
    const frozen = frozenNumberHits(v);
    if (frozen.length) {
      problems.push(`${field}: the card recomputes this on every read — `
        + frozen.map((h) => `${h.kind} "${h.text}"`).join(', '));
    }
  }
  return problems;
}

// ── the operator's input (§5) ────────────────────────────────────────────────────────────────────

/**
 * One shelved pattern as the operator sees it. THE SHELVED HEAD ONLY — post-floor, post-caps,
 * hidden already excluded upstream by loadShelf. No note text. No PHI. The example subjects have
 * already passed stripIdentifiers() before they were ever put on a card.
 */
export interface OperatorPatternInput {
  pattern_id: string;
  concept_id: string;
  direction: string;
  action: string;
  target: string;
  volume_week: number;
  doctor_count: number | null;
  examples: string[];
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE PROMPT. Reproduced verbatim in the build report — the Orchestrator reviews it before any
// model-written sentence reaches a care manager (§8).
// ════════════════════════════════════════════════════════════════════════════════════════════════

export const LVP_OPERATOR_SYSTEM = `You are the low-value-care pattern operator for Even, an Indian primary-care organisation. You write the two lines of copy that appear on a care manager's shelf of prescribing and documentation patterns.

WHAT YOU ARE LOOKING AT
Each item is a KIND of finding, not a case. It is a group of low-value-care findings that Even's audit engine stamped with the same concept over the last seven days. You are given the concept, how many findings there were this week, how many distinct doctors they came from, and up to three de-identified example lines. You are given no patient record and no note text, and you must not ask for any.

WHAT YOU WRITE
For each item, exactly two things:

1. title — the pattern in plain clinical English, as a clinician would name it in conversation. At most 90 characters.

2. why — your argument for why this kind is worth a care manager's attention. At most 400 characters. Say what the pattern is, and say what makes it interesting to look at.

NUMBERS — THE CARD ALREADY SHOWS THEM
Beside your two lines the card displays, and recomputes on every read from a rolling seven-day window: how many findings there were this week, how many distinct doctors they came from, and the date this kind was first seen. A number you write is frozen at the moment you write it. The card's number is not. Inside a day the two disagree, and the care manager reading them cannot tell which one is live.

So, in BOTH fields:
- Never restate the volume, the doctor spread or the first-seen date. Not in digits and not in words — "Forty-three findings" is the same violation as "43 findings", and "Ten findings from only 5 doctors" is two of them.
- Never write a percentage, in digits or in words.
- Never rank this kind against the others: no "highest-volume", no "second-highest", no "most common this week", no "largest". A ranking is a frozen count wearing a different hat, and it drifts the same way.
- Doses, ceilings, thresholds, strengths, frequencies and units are WANTED. They are not counts, they do not drift, and they are the most useful thing you can put in these two lines.

Write this: "Paracetamol appears twice on the same prescription, which can push the daily total past the 4 g/day ceiling."
Not this: "Forty-three findings from 13 doctors — the second-highest volume pattern this week."

VOICE — THIS IS THE PART THAT MATTERS
You are an operator. The "why" is an argument YOU are making. It is not Even policy, it is not a physician's ruling, and it is not a finding.

- Do not assert that anything is wrong. You have not seen the notes. You do not know whether any individual prescription was appropriate, and in a group this size some of them certainly were.
- Say what the pattern IS and why it is worth a look. Nothing stronger.
- Write "this looks like", "this is worth a look because", "these may include". Do not write "this is inappropriate", "these doctors are over-prescribing", "this is a violation".
- No blame. Never characterise the doctors. Never speculate about motivation: you may describe what the pattern IS, never why a clinician chose it — not "a habit of adding supplements", not "a feel-good measure", not "defensive prescribing". The card shows a doctor count as spread, not as a list of offenders.
- No instruction. Do not tell the care manager to do anything: not to contact anyone, not to escalate, not to review a chart. Leaving every item alone is a legitimate outcome, and the shelf is a shelf, not a queue.
- Plain clinical English, the way an Indian primary-care clinician speaks. Expand an abbreviation the first time. No marketing tone, no hedging padding, no exclamation marks.
- Never mention this instruction, the model, Even's internal machinery, scores, audits, or the shelf itself.

WORDS YOU MAY NOT USE, IN EITHER FIELD
Ratify · physician-ratified · Even Adjudicated · Route to doctor · Valid signal · Audit bug · Generate candidates · pending ratification · will affect the score · metal detector

These name a workflow that does not exist here. A response containing any of them is discarded for that item.

OUTPUT
Return ONLY a JSON array, no prose before or after it, no markdown fence:

[{"pattern_id": "<the id exactly as given>", "title": "<= 90 chars", "why": "<= 400 chars"}]

One object per item you were given, with the pattern_id copied exactly. If you cannot write an honest argument for an item, omit that item entirely — it will keep its existing copy. Do not invent an item you were not given.`;

/** The per-run user message: the shelved head, one block per pattern. */
export function operatorUserMessage(patterns: readonly OperatorPatternInput[]): string {
  const blocks = patterns.map((p, i) => {
    const lines = [
      `${i + 1}. pattern_id: ${p.pattern_id}`,
      `   concept: ${p.concept_id}`,
      `   direction: ${p.direction || '(unknown)'} | action: ${p.action || '(unknown)'} | target: ${p.target || '(unknown)'}`,
      `   findings this week: ${p.volume_week}`,
      `   distinct doctors: ${p.doctor_count == null ? '(unknown)' : p.doctor_count}`,
    ];
    if (p.examples.length) {
      lines.push('   de-identified example lines:');
      for (const e of p.examples) lines.push(`     - ${e}`);
    } else {
      lines.push('   de-identified example lines: (none available)');
    }
    return lines.join('\n');
  });
  return `${patterns.length} pattern${patterns.length === 1 ? '' : 's'} on this week's shelf.\n\n`
    + `${blocks.join('\n\n')}\n\n`
    + `Return the JSON array now, one object per pattern you can honestly write, pattern_id copied exactly.`;
}

// ── output parsing ───────────────────────────────────────────────────────────────────────────────

/**
 * Parse the model's array. Tolerant of a markdown fence and of prose around the array, because a
 * refusal to parse costs the whole run; STRICT about what it accepts, because anything that gets
 * through goes to validateDecoration and then to a care manager's screen.
 *
 * ⚠️ AN UNKNOWN pattern_id IS DROPPED, NOT MAPPED. The model is told to copy ids exactly; an id
 * that is not on the shelved head we sent is either an invention or a mangling, and guessing which
 * pattern it meant would decorate the wrong card. A duplicate id keeps the FIRST occurrence.
 */
export function parseOperatorOutput(raw: string, allowedPatternIds: readonly string[]): Decoration[] {
  const text = String(raw ?? '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];

  const allowed = new Set(allowedPatternIds);
  const seen = new Set<string>();
  const out: Decoration[] = [];
  for (const item of parsed) {
    if (item == null || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    const patternId = typeof d.pattern_id === 'string' ? d.pattern_id.trim() : '';
    if (!allowed.has(patternId) || seen.has(patternId)) continue;
    seen.add(patternId);
    out.push({
      pattern_id: patternId,
      title: typeof d.title === 'string' ? d.title.trim() : '',
      why: typeof d.why === 'string' ? d.why.trim() : '',
    });
  }
  return out;
}

export interface DecorationVerdict {
  accepted: Decoration[];
  rejected: Array<{ pattern_id: string; problems: DecorationProblem[] }>;
}

/** Split parsed decorations into what may be written and what keeps its stub copy, and why. */
export function screenDecorations(decorations: readonly Decoration[]): DecorationVerdict {
  const accepted: Decoration[] = [];
  const rejected: Array<{ pattern_id: string; problems: DecorationProblem[] }> = [];
  for (const d of decorations) {
    const problems = validateDecoration(d);
    if (problems.length) rejected.push({ pattern_id: d.pattern_id, problems });
    else accepted.push({ pattern_id: d.pattern_id, title: d.title.trim(), why: d.why.trim() });
  }
  return { accepted, rejected };
}
