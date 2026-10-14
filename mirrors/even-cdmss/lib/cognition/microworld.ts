/**
 * lib/cognition/microworld.ts — WM1: is this event inside the one world the agent knows?
 *
 * PURE, dependency-free, never throws.
 *
 * WHY A MICROWORLD AT ALL. The shadow agent is not competent everywhere, and pretending otherwise
 * is how a "helpful" system becomes noise. v0 knows exactly one clinical world — headache — and
 * every event outside it is a NAMED silence (`not_microworld`), never a quiet drop.
 *
 * WHY THE RULE IS DELIBERATELY CRUDE. `headache-strict/1` is a case-insensitive substring match over
 * four spellings. It will miss a headache described only as "throbbing frontal pain", and it will
 * catch a note that merely mentions migraine in a family history. Both are ACCEPTABLE in a shadow
 * ship whose entire purpose is to measure how often the agent would speak: a fancier matcher would
 * make the burden numbers a measurement of the matcher rather than of the policy. The rule string is
 * stored on every row so a future rule can be compared against this one rather than silently
 * replacing it.
 */

/** The one world v0 knows, plus the honest label for everything else. */
export type Microworld = 'headache' | 'none';

/** Stored on EVERY shadow row, so a later rule change is visible in the data rather than implied. */
export const MATCH_RULE = 'headache-strict/1' as const;

/**
 * The four spellings, case-insensitive. `migraine` is included because it is the headache term
 * clinicians actually write; `cephalgia`/`cephalalgia` because both spellings appear in Indian
 * discharge and OPD documentation.
 */
const HEADACHE_RE = /headache|cephalgia|cephalalgia|migraine/i;

/**
 * Classify free text into the microworld. Anything non-string, empty, or unmatched is 'none' —
 * never a throw, and never an optimistic default.
 */
export function microworldOf(text: unknown): Microworld {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  return HEADACHE_RE.test(s) ? 'headache' : 'none';
}

/**
 * Flatten an audit row's findings + suggestions jsonb into the single string `microworldOf` reads.
 *
 * ⚠️ TEXT FIELDS ONLY, and that is a decision rather than an oversight. It would be easier to
 * `JSON.stringify` the whole blob, but that would match on keys, enum values and citation payloads —
 * so a schema change could silently move the microworld boundary. The fields read here are the
 * text-bearing ones on OpdFinding (`subject`, `rationale`, `evidence[]`, `estimates[]`) and on
 * OpdSuggestion (`text`).
 *
 * Fail-safe: a malformed blob contributes nothing rather than throwing. A shadow sweep must not die
 * on one bad row.
 */
export function auditRowText(findings: unknown, suggestions: unknown): string {
  const parts: string[] = [];
  const push = (v: unknown) => { if (typeof v === 'string' && v) parts.push(v); };

  const asArray = (v: unknown): unknown[] => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
    return [];
  };

  for (const f of asArray(findings)) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    push(o.subject);
    push(o.rationale);
    for (const e of asArray(o.evidence)) push(e);
    for (const e of asArray(o.estimates)) push(e);
  }
  for (const s of asArray(suggestions)) {
    if (!s || typeof s !== 'object') continue;
    push((s as Record<string, unknown>).text);
  }
  return parts.join('\n');
}
