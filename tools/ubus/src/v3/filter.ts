import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { filterPath, filterText } from "../filter.js";

export const DEFAULT_ALLOWLIST_PATH = "config/v3-allowlist.json";

/** Terms carried when no config file exists yet (spec §5 is not in this repo; see the lane report). */
export const DEFAULT_TERMS = [
  "Human RAG",
  "Encounter Buddy",
  "newcat",
  "T28b",
  "ubus",
  "eta-bus",
  "ubus-bridge",
  "ext-evenscribe-kiosk-bot",
  "fable",
  "count",
  "path",
];

/** A term below this many characters can never cover a whole name match. */
export const MIN_TERM_CHARS = 4;

/**
 * Clinical vocabulary an operator may not allow-list: listing one of these
 * would switch off the very words the name rule keys on. Honorifics included.
 */
export const CLINICAL_BLOCKLIST = [
  "patient",
  "patients",
  "doctor",
  "doctors",
  "dr",
  "clinician",
  "diagnosis",
  "diagnosed",
  "admitted",
  "admission",
  "prescription",
  "prescribed",
  "symptom",
  "symptoms",
  "medicine",
  "medicines",
  "complaint",
  "dosage",
  "tablet",
  "fever",
  "nurse",
  "hospital",
  "mr",
  "mrs",
  "ms",
  "prof",
  "pt",
  "sr",
];

const BLOCKED = new Set(CLINICAL_BLOCKLIST);

/** Terms the allow-list refuses to load: clinical words and anything under 4 chars. */
export function acceptableTerm(term: string): boolean {
  const t = term.trim().toLowerCase();
  if (t.length < MIN_TERM_CHARS) return false;
  if (BLOCKED.has(t)) return false;
  // A phrase is only as clean as its words: "patient Asha Verma" is not a term.
  if (t.split(/[^a-z0-9]+/).some((w) => BLOCKED.has(w))) return false;
  return true;
}

export interface FilterOk {
  ok: true;
  allow_terms: string[];
}

export interface FilterNo {
  ok: false;
  reason: `phi_filter:${string}`;
  rule_id: string;
  /** [start, end) offsets into the text that was checked. Never the matched text. */
  spans: Array<[number, number]>;
}

export type FilterVerdict = FilterOk | FilterNo;

/** A term as a whole word/phrase: alphanumerics may not butt against either end. */
function termPattern(term: string): RegExp | null {
  const needle = term.trim();
  if (!needle) return null;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi");
}

/**
 * Allow-list of internal terms, reloaded when the config file's mtime changes.
 * Terms match whole words/phrases only (case-insensitively) and are loaded
 * only when they pass acceptableTerm(). F3/R3-F1: an allow-listed term exempts
 * the soft name-like rule for a name match that lies ENTIRELY inside term
 * spans; hard rules (phone, uid, MRN, secrets, transcripts) are looked up
 * before any of this and are never exempted. Registered agent ids (and
 * aliases) are unioned in at query time, under the same load rules.
 */
export class AllowList {
  private cache: { mtimeMs: number; terms: string[] } | null = null;

  constructor(
    readonly path: string,
    private extra: () => string[] = () => [],
  ) {}

  static resolvePath(explicit?: string): string {
    const raw = explicit || process.env.UBUS_V3_ALLOWLIST || DEFAULT_ALLOWLIST_PATH;
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  }

  private fileTerms(): string[] {
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      this.cache = null;
      return [...DEFAULT_TERMS];
    }
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.terms;
    let terms: string[] = [...DEFAULT_TERMS];
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
      if (Array.isArray(raw.terms)) terms = raw.terms.map(String).filter((t) => t.trim().length > 0);
    } catch {
      terms = [...DEFAULT_TERMS];
    }
    this.cache = { mtimeMs, terms };
    return terms;
  }

  /** File terms plus live agent ids/aliases, deduplicated and load-checked. */
  terms(): string[] {
    return [...new Set([...this.fileTerms(), ...this.extra()])].filter(acceptableTerm).sort();
  }

  /** Allow-listed terms that appear in the text as whole words/phrases, longest first. */
  matches(text: string): string[] {
    const hit = this.terms().filter((t) => termPattern(t)?.test(text) ?? false);
    return hit.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  }

  /** Every span of the text an allow-listed whole word/phrase covers. */
  spans(text: string): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const term of this.terms()) {
      const re = termPattern(term);
      if (!re) continue;
      for (const m of text.matchAll(re)) {
        if (m[0].length === 0) continue;
        out.push([m.index, m.index + m[0].length]);
      }
    }
    return out;
  }
}

/**
 * The only rule an allow-listed term can exempt: the soft name-like heuristic,
 * and only for a name match that lies entirely inside term spans. Everything
 * else (phone, uid, MRN, dates of birth, secrets, transcripts) is hard and
 * stays enforced whatever the allow-list holds.
 */
const SOFT_RULES = new Set(["phi.patient_name"]);

type SpanRule = { id: string; re: RegExp };

/**
 * Span locators, one per rule id src/filter.ts can report. Accept/reject is
 * decided by src/filter.ts alone; these only say where the hit was, so a
 * rejection can carry spans without echoing the matched text.
 */
const SPAN_RULES: SpanRule[] = [
  { id: "secret.private_key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { id: "secret.aws_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "secret.github_token", re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { id: "secret.github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: "secret.slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: "secret.openai", re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { id: "secret.stripe", re: /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { id: "secret.assignment", re: /\b(?:api[_-]?key|secret|token|passwd|password|pwd)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=]{12,}/gi },
  { id: "secret.bearer", re: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}/g },
  { id: "secret.connection_uri", re: /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s:]+:[^\s@]+@/gi },
  { id: "secret.jwt", re: /\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g },
  { id: "phi.uhid_mrn", re: /\b(?:uhid|mrn|patient[\s_-]*id|pid)\b\s*[#:=-]?\s*[A-Z0-9][A-Z0-9-]{3,}/gi },
  { id: "phi.phone_in", re: /(?<!\d)(?:\+91[\s-]?)?[6-9]\d{9}\b/g },
  { id: "phi.phone_us", re: /\b\d{3}[-.]\d{3}[-.]\d{4}\b/g },
  { id: "phi.aadhaar", re: /\b\d{4}\s\d{4}\s\d{4}\b/g },
  { id: "phi.email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { id: "phi.long_digit_run", re: /(?<![A-Za-z0-9])\d{8,}(?![A-Za-z0-9])/g },
  { id: "transcript.devanagari", re: /[\u0900-\u097F]{30,}/g },
  { id: "transcript.speakers", re: /(?:^|\n)\s*(?:doctor|patient|speaker|pt|dr)\s*:/gi },
];

const CLINICAL_WORDS =
  /\b(?:patient|patients|clinician|doctor|diagnosis|diagnosed|admitted|admission|prescription|prescribed|symptom|symptoms|medicine|medicines|complaint|dosage|tablet|fever)\b/i;
const NAME_RE = /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2}\b/g;
const LONG_SENTENCE_MIN_WORDS = 8;

function regexSpans(re: RegExp, text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const scan = new RegExp(re.source, re.flags.replace("g", "") + "g");
  for (const m of text.matchAll(scan)) {
    if (m[0].length === 0) continue;
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

function patientNameSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  // Case-sensitive on purpose: only a capitalised name counts as a name span,
  // so "patient flow" is not a span that has to be covered to exempt a hit.
  const lead = /\b(?:patient|pt\.?)\s+(?:name\s*[:=]\s*)?[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2}\b/g;
  out.push(...regexSpans(lead, text));
  for (const m of text.matchAll(NAME_RE)) {
    const at = m.index ?? 0;
    const window = text.slice(Math.max(0, at - 60), Math.min(text.length, at + m[0].length + 60));
    if (CLINICAL_WORDS.test(window)) out.push([at, at + m[0].length]);
  }
  return out;
}

/** Sentences of 8+ words, split exactly as src/filter.ts counts them. */
function longSentenceSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /[.!?]+/g;
  let start = 0;
  const push = (end: number) => {
    const words = text.slice(start, end).trim().split(/\s+/).filter(Boolean).length;
    if (words >= LONG_SENTENCE_MIN_WORDS && start < end) out.push([start, end]);
    start = end;
  };
  for (const m of text.matchAll(re)) push((m.index ?? 0) + m[0].length);
  push(text.length);
  return out;
}

function sortSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const key = `${s}:${e}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([s, e]);
  }
  return out;
}

export function locateSpans(ruleId: string, text: string): Array<[number, number]> {
  if (ruleId === "phi.patient_name") return sortSpans(patientNameSpans(text));
  if (ruleId === "transcript.clinical_prose" || ruleId === "transcript.long_prose") return sortSpans(longSentenceSpans(text));
  const rule = SPAN_RULES.find((r) => r.id === ruleId);
  if (!rule) return [];
  return sortSpans(regexSpans(rule.re, text));
}

/**
 * The transcript rules, evaluated in src/filter.ts order. filterText stops at
 * the first hit, so once a name hit is exempted this says whether the rules
 * after it still fire — on the original text, always.
 */
function transcriptRuleId(text: string): string | null {
  if (locateSpans("transcript.devanagari", text).length) return "transcript.devanagari";
  if (locateSpans("transcript.speakers", text).length >= 2) return "transcript.speakers";
  const long = longSentenceSpans(text).length;
  if (long >= 4 && CLINICAL_WORDS.test(text)) return "transcript.clinical_prose";
  if (long >= 8) return "transcript.long_prose";
  return null;
}

function reject(ruleId: string, spans: Array<[number, number]>): FilterVerdict {
  return { ok: false, reason: `phi_filter:${ruleId}`, rule_id: ruleId, spans };
}

/**
 * The v3 filter. Accept/reject and the rule id come from src/filter.ts (the
 * hard blocks are never overridden); this adds the allow-list and the spans of
 * the hit. A rejection carries the rule id and spans, never the matched text.
 *
 * F1: the name rule always runs on the ORIGINAL text. It is exempted only
 * when every name span lies entirely inside allow-listed whole word/phrase
 * spans; after an exemption the rules that follow it (transcript) still run on
 * the original text. Nothing is ever evaluated on a masked string.
 */
export function checkFilter(text: string, allow: AllowList): FilterVerdict {
  const verdict = filterText(text);
  if (verdict.ok) return { ok: true, allow_terms: allow.matches(text) };
  if (SOFT_RULES.has(verdict.rule)) {
    const nameSpans = locateSpans(verdict.rule, text);
    const allowSpans = allow.spans(text);
    const covered =
      nameSpans.length > 0 && nameSpans.every(([s, e]) => allowSpans.some(([as, ae]) => as <= s && e <= ae));
    if (!covered) return reject(verdict.rule, nameSpans);
    const later = transcriptRuleId(text);
    if (later) return reject(later, locateSpans(later, text));
    return { ok: true, allow_terms: allow.matches(text) };
  }
  return reject(verdict.rule, locateSpans(verdict.rule, text));
}

/** body_ref and artifact paths go through the path rules; the rule id is reported, never the path. */
export function checkPath(input: string): FilterVerdict {
  const verdict = filterPath(input);
  if (verdict.ok) return { ok: true, allow_terms: [] };
  return reject(verdict.rule, [[0, input.length]]);
}
