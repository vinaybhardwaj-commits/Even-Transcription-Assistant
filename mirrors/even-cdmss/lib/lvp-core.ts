/**
 * lib/lvp-core.ts — Low-value patterns L1: the PURE core (CDMSS LVP-L1 kickoff, 20 Aug 2026).
 *
 * Everything deterministic about the shelf lives here, unit-tested, with NO IO: concept-id
 * parsing, the stub title table (§4.3 — exact, do not invent titles beyond it), the stub "why"
 * sentence, the two-block shelving rule (O3 as amended by Addendum B, V ruled 20 Aug 2026:
 * overuse by volume capped at 23, then non-overuse by volume capped at 8 — measured 40 overuse
 * vs 5 non-overuse kinds above the floor, so a single cap starved the non-overuse block and the
 * `probably not overuse` pill never rendered; floor 5 unchanged for both), the belt-and-braces
 * de-id strip for example snippets (O10 — the audit findings are already de-identified; this is
 * a second net for mobile numbers, UHID shapes and emails), and IST date display.
 *
 * The L1 Suggested list is COMPUTED ON READ from concept stamps (O4/O7) — there is no pattern
 * row store; the only persistent state is lvp_hidden (lib/lvp-store.ts). Nothing here touches
 * a score, Triage, or any audit table.
 */

export const LVP_FLOOR = 5;            // minimum volume_week for a Suggested card (both blocks)
export const LVP_CAP = 23;             // maximum OVERUSE cards (Addendum B: the cap is per-block)
export const LVP_NON_OVERUSE_CAP = 8;  // maximum non-overuse cards, appended after the overuse block

export type LvpDirection = 'overuse' | 'documentation' | 'process' | 'underuse' | string;

export interface ConceptParts {
  direction: string;
  action: string;
  target: string;
}

/** `pattern:{concept_id}` — verbatim, even when the concept_id contains spaces. */
export function patternIdFor(conceptId: string): string {
  return `pattern:${conceptId}`;
}

/** Inverse of patternIdFor. Returns null for a string that is not a pattern id. */
export function conceptIdFromPatternId(patternId: string): string | null {
  return patternId.startsWith('pattern:') ? patternId.slice('pattern:'.length) : null;
}

/**
 * Split a concept_id (`direction:action:target`) into parts. The target may itself contain
 * ':' or spaces — everything after the second ':' is the target, verbatim. The lvc_concepts
 * join is authoritative when both exist (§4.3); this parse is the fallback.
 */
export function parseConceptId(conceptId: string): ConceptParts {
  const first = conceptId.indexOf(':');
  if (first < 0) return { direction: conceptId, action: '', target: '' };
  const second = conceptId.indexOf(':', first + 1);
  if (second < 0) return { direction: conceptId.slice(0, first), action: conceptId.slice(first + 1), target: '' };
  return {
    direction: conceptId.slice(0, first),
    action: conceptId.slice(first + 1, second),
    target: conceptId.slice(second + 1),
  };
}

function sentenceCase(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * The exact stub title table (§4.3). Sentence-cased; targets rendered verbatim.
 * Fallback: `{action}: {target}`.
 */
export function patternTitle(parts: ConceptParts): string {
  const d = parts.direction.trim().toLowerCase();
  const a = parts.action.trim().toLowerCase();
  const t = parts.target;
  let title: string;
  if (d === 'overuse') {
    if (a === 'rx') title = `Possible overuse: ${t} prescriptions`;
    else if (a === 'duplication') title = `Duplicate therapy: ${t}`;
    else if (a === 'investigation' || a === 'investigations') title = `Low-value investigation: ${t}`;
    else if (a === 'combo_rx') title = `Fixed-dose combination: ${t}`;
    else if (a === 'polypharmacy') title = `Polypharmacy: ${t}`;
    else title = `${parts.action}: ${t}`;
  } else if (d === 'documentation') title = `Not documented: ${t}`;
  else if (d === 'process') title = `Not recorded: ${t}`;
  else if (d === 'underuse') title = `Possible underuse: ${t}`;
  else title = `${parts.action}: ${t}`;
  return sentenceCase(title);
}

/** The stub "why" sentence (§4.3) — operator voice; a count, not an argument. */
export function whyText(volumeWeek: number, conceptId: string): string {
  return `The operator grouped ${volumeWeek} similar low-value findings stamped \`${conceptId}\` this week. ` +
    `This is a count, not an argument. The full argument arrives with the L2 operator.`;
}

/** Status pill (§4.3): overuse → "not a ding"; every other direction → "probably not overuse". */
export function statusPill(direction: string): string {
  return direction.trim().toLowerCase() === 'overuse' ? 'not a ding' : 'probably not overuse';
}

// ── de-id strip (O10) ────────────────────────────────────────────────────────────────────────────
// Belt-and-braces only: the audit DB findings are already de-identified. Deliberately NOT the
// readmission deidText (readmission-scoped, takes identity args). Order matters: emails first
// (their local part can contain digit runs), then mobiles, then UHID shapes.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Indian mobile shapes: optional +91/91/0 prefix, then a 10-digit run starting 6–9 — and any
// bare 10-digit run (conservative: a 10-digit number in a clinical snippet is more likely an
// identifier than a clinical value).
const MOBILE_RE = /(?:\+?91[-\s]?)?[6-9]\d{9}\b|\b\d{10}\b/g;
// UHID shapes: UH / UHID prefix, optional separator, then an alphanumeric run containing a digit.
const UHID_RE = /\bUH(?:ID)?[-/ ]?[A-Za-z0-9-]*\d[A-Za-z0-9-]*\b/gi;

/** Strip mobile numbers, UHID-shaped ids and emails from an example snippet. */
export function stripIdentifiers(text: string): string {
  return text
    .replace(EMAIL_RE, '[email]')
    .replace(UHID_RE, '[id]')
    .replace(MOBILE_RE, '[number]')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── shelving: overuse-first sort + floor + cap (O3, §4.3) ───────────────────────────────────────

export interface ShelvableCard {
  direction: string;
  volume_week: number;
}

/**
 * The Suggested shelf order (O3 as amended by Addendum B, V ruled 20 Aug 2026): overuse cards
 * by volume desc, capped at 23 — then every other direction (documentation / process / underuse)
 * by volume desc, capped at 8, appended after. One list; floor volume_week ≥ 5 applies to both
 * blocks; stable within ties. (The pre-amendment single cap let a heavy overuse week fill all
 * 23 slots and starve the non-overuse block entirely.)
 */
export function shelveSuggestions<T extends ShelvableCard>(
  cards: T[], floor = LVP_FLOOR, cap = LVP_CAP, nonOveruseCap = LVP_NON_OVERUSE_CAP,
): T[] {
  const eligible = cards.filter((c) => c.volume_week >= floor);
  const overuse = eligible.filter((c) => c.direction.trim().toLowerCase() === 'overuse');
  const rest = eligible.filter((c) => c.direction.trim().toLowerCase() !== 'overuse');
  const byVolume = (a: T, b: T) => b.volume_week - a.volume_week;
  return [...overuse.sort(byVolume).slice(0, cap), ...rest.sort(byVolume).slice(0, nonOveruseCap)];
}

// ── IST date display ────────────────────────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' → '12 Jul 2026' (plain clinical English dates, R4.2 convention). */
export function formatDisplayDate(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return null;
  return `${Number(m[3])} ${month} ${m[1]}`;
}
