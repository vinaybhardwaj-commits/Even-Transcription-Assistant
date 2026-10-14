/**
 * lib/ipd-episode/judge-core.ts — the PURE half of the three Opus passes (PRD §3.4, §3.5, §3.6)
 * and ALL of this engine's arithmetic.
 *
 * NO db, NO model, NO Next.
 *
 * THE RULES BELOW ARE CODE, NOT PROMPT TEXT, AND THAT IS THE POINT. Each prompt states its rule;
 * each rule is then re-applied here to whatever actually came back:
 *
 *   · TIER C (§4.2) — a finding whose evidence_basis is empty, or names only Tier C sources,
 *     cannot carry `divergent`. It is rewritten to `unassessable` and counted. A verdict is a
 *     claim about the record; a claim the record cannot support is not downgraded politely, it is
 *     replaced.
 *   · THE UNCITED CAP (§4.4) — a divergence finding measured against a checkpoint entry that
 *     carried no citation is capped at severity `minor`, verdict `context_dependent`. An
 *     expectation nothing normative backs is a reasonable expectation, not a standard. NOT applied
 *     to fidelity findings: those are measured against the record, not against an expectation.
 *   · THE A2 DOMAIN DROP (§3.5) — a fidelity finding outside the `documentation` domain is
 *     DROPPED and counted in `n_dropped_invalid`, never quietly relabelled. A2 reads the discharge
 *     summary, so a clinical verdict from it would be an outcome-aware score wearing a blind one's
 *     name.
 *   · COMMENTARY (§3.6) — an output carrying a score field, or a finding_id that does not exist,
 *     is rejected outright. The caller retries once and then stores null.
 *
 * SCORING (§6.1): penalty = 8·major + 4·moderate + 1·minor over `divergent` findings from BOTH
 * passes, and `divergence_index = max(0, 100 − penalty)`. Fidelity findings share the divergence
 * penalty by V's decision 16, with the recorded trade-off that the headline number is therefore
 * not fully outcome-blind — which is why the UI labels every A2 finding as a fidelity finding, so
 * a reader can subtract them.
 */

import { extractJsonObject } from '../lvc-value-core';
import { LVC_CATEGORIES } from '../opd-lvc-classify-core';
import {
  COMPLETENESS_SOURCES, collapseSpaces, tierForTable, isDischargeEvent, dischargeIndicatesDeath,
  type EpisodeEvent, type EvidenceTier,
} from './assemble-core';
import { CHECKPOINT_ENTRY_SECTIONS, renderEvent, type CheckpointEntryRef, type ExpectedCourse } from './checkpoint-core';
import {
  ESCALATION_SECTION, SUBJECT_CONCEPTS, subjectWords,
  type Resolution, type ResolvableEntry, type ResolvedOutcome,
} from './resolve-core';
// Re-exported so the vocabulary has ONE definition and every existing caller keeps one import.
export { SUBJECT_CONCEPTS, subjectWords };

// ── enums (PRD §3.4.2) ───────────────────────────────────────────────────────────────────────

export const FINDING_TYPES = ['omission', 'commission', 'timing', 'sequencing'] as const;
export const VERDICTS = ['divergent', 'context_dependent', 'unassessable', 'concordant'] as const;
export const DOMAINS = ['diagnostics', 'therapeutics', 'monitoring', 'escalation', 'documentation', 'disposition'] as const;
export const SEVERITIES = ['minor', 'moderate', 'major'] as const;
export const EVIDENCE_TIERS = ['A', 'B', 'C'] as const;
export const PASSES = ['divergence', 'fidelity'] as const;

export type FindingType = (typeof FINDING_TYPES)[number];
export type Verdict = (typeof VERDICTS)[number];
export type Domain = (typeof DOMAINS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type AuditPass = (typeof PASSES)[number];

export interface EvidenceBasisItem { source_table: string; source_record_id: string; source_timestamp: string | null }

export const CITATION_PROVENANCES = ['normative', 'literature', 'mixed'] as const;
export type CitationProvenance = (typeof CITATION_PROVENANCES)[number];

export interface EpisodeFinding {
  finding_id: string;
  pass: AuditPass;
  finding_type: FindingType;
  verdict: Verdict;
  domain: Domain;
  day_index: number;
  checkpoint_ref: string | null;
  statement: string;
  severity: Severity;
  evidence_tier: EvidenceTier;
  evidence_basis: EvidenceBasisItem[];
  author_name: string | null;
  author_role: string | null;
  responsible_clinician_id: string | null;
  lvc_category: string | null;
  citation_ids: number[];
  /**
   * What KIND of source this finding stands on (V, 2026-09-02):
   *   normative  — every citation is a guideline/standard source
   *   literature — every citation is something else: a StatPearls chapter, a journal passage
   *   mixed      — both
   *   null       — no citations at all (every A2 finding, and any uncited A1 one)
   * Stored so the UI can show it and so the cohort can be asked, later, how much of the score
   * actually rests on guidelines rather than on literature that reads like one.
   */
  citation_provenance: CitationProvenance | null;
  /**
   * THE CAP, AUDITABLE FROM STORED DATA. `capped` is true when any cap touched this finding, and
   * the two `*_before_cap` fields hold what it said beforehand. Without these, "5 capped" is a
   * sentence in a response body that nobody can check against the row; with them a validator can
   * recount every cap from `findings` alone. `severity_before_cap` is carried as well as the
   * verdict because the literature cap moves severity WITHOUT moving the verdict, and a
   * verdict-only record would make those caps invisible.
   */
  verdict_before_cap: Verdict | null;
  severity_before_cap: Severity | null;
  capped: boolean;
  /**
   * HOW THIS FINDING WAS DECIDED (decision 33). Non-null on every finding the deterministic
   * resolver produced; null on the judged findings (commission / timing / sequencing) and on
   * fidelity findings, which no lookup can settle.
   */
  resolution: Resolution | null;
  /** The matcher that resolved it, and what it matched — so the lookup is re-runnable by hand. */
  matcher_kind: string | null;
  matcher_terms: string[] | null;
  matched_term: string | null;
  confound: string | null;
  /**
   * ROUND 12 ITEM 2 — GROUPING, NOT TRUNCATION. A daily checkpoint regenerates a similar expected
   * course every day, so one standing expectation ("daily CBC") becomes one resolver finding PER
   * DAY. IPNO-416 produced 79 resolver findings that way, 71% of its 112. Capping them by
   * truncation would drop real findings silently, so instead the members of one expectation class
   * collapse into ONE finding that says how often it recurred, and these three fields keep every
   * member addressable: nothing is discarded, only stated once.
   *
   * `group_size` is 1 and `grouped_refs` holds the single ref for an ungrouped finding, so the
   * shape is uniform and a reader never has to branch on "was this grouped".
   */
  group_size: number;
  grouped_refs: string[];
  grouped_days: number[];
}

const oneOf = <T extends string>(allowed: readonly T[], v: unknown): T | null =>
  (allowed as readonly string[]).includes(String(v)) ? (String(v) as T) : null;

/**
 * ⚠️ COERCION, NARROWLY. Measured on IP-1286: 5 of 15 A1 findings — a third of the divergence pass
 * — were discarded whole because ONE enum value was off. Throwing away a well-formed clinical
 * finding over a spelling is a worse error than the spelling, so a value that names exactly one
 * legal option is repaired. A value that names none, or more than one, is still dropped: the
 * alternative is deciding on the model's behalf what it meant, which manufactures a finding.
 *
 * Matching is deliberately dumb and total: exact, then case-insensitive, then singular/plural and
 * prefix. No fuzzy distance — "commission" and "omission" are one edit apart and mean opposite
 * things, and an edit-distance matcher would confidently swap them.
 */
function coerceEnum<T extends string>(allowed: readonly T[], v: unknown): { value: T | null; repaired: boolean } {
  const exact = oneOf(allowed, v);
  if (exact) return { value: exact, repaired: false };
  const raw = String(v ?? '').trim().toLowerCase();
  if (!raw) return { value: null, repaired: false };
  const hits = allowed.filter((a) => {
    const t = a.toLowerCase();
    if (t === raw) return true;
    // singular/plural and prefix, both directions: 'diagnostic' ↔ 'diagnostics', 'escalate' → 'escalation'
    if (t.startsWith(raw) && raw.length >= 4) return true;
    if (raw.startsWith(t) && t.length >= 4) return true;
    return false;
  });
  // exactly one legal option, or nothing — ambiguity is never resolved by guessing
  return hits.length === 1 ? { value: hits[0], repaired: true } : { value: null, repaired: false };
}

/**
 * ⚠️ `concordant` IS A VERDICT, NOT A FINDING TYPE, and confusing the two cost IP-1286 five real
 * findings — diet tolerated, vitals stable, dressing dry, glucose monitored, ambulating. Every one
 * was a correct observation that the course MET its expectation, and every one was discarded
 * because `concordant` is not in FINDING_TYPES.
 *
 * AN AUDIT THAT CANNOT RECORD WHAT WENT RIGHT IS NOT AN AUDIT. It is a defect list, and a defect
 * list read as an audit makes a well-run admission indistinguishable from an unexamined one. The
 * prompt now states the distinction outright; this repairs the responses that get it wrong anyway.
 *
 * The type is inferred from the statement, defaulting to `omission` as instructed. The inference
 * is deliberately low-stakes: a concordant finding is excluded from the four type counters
 * anyway (see countFindings), so this label decides presentation, not arithmetic.
 */
export function impliedFindingType(statement: string): FindingType {
  const t = (statement || '').toLowerCase();
  if (/\b(late|delay|delayed|overdue|promptly|on time|within \d|hours? after|days? after)\b/.test(t)) return 'timing';
  if (/\b(sequence|sequenced|order of|out of order|before starting|prior to)\b/.test(t)) return 'sequencing';
  if (/\b(given|administered|performed|started|ordered|prescribed|carried out|documented|monitored|tolerated|ambulat)\w*\b/.test(t)) return 'commission';
  return 'omission';
}

/** An unreadable severity becomes `moderate`: the middle of the scale, so a repair can neither
 *  inflate a finding to the 8-point band nor bury it in the 1-point one. */
const SEVERITY_FALLBACK: Severity = 'moderate';

/** An unreadable verdict becomes `unassessable`, NEVER a scoring one. A verdict IS the claim, and
 *  the honest reading of "we could not parse the claim" is that the record did not answer —
 *  which scores nothing. Coercing to `divergent` would manufacture a penalty out of a typo. */
const VERDICT_FALLBACK: Verdict = 'unassessable';

/**
 * `lvc_category` validation. PRD §3.4.2 names `asCategory()` in lib/opd-lvc-classify-core.ts, but
 * that helper is module-private there and that file is on the UNTOUCHED list — so this is the same
 * one-line membership test against the same exported `LVC_CATEGORIES` constant (12 values), which
 * keeps the enum single-sourced without editing a frozen file. Flagged in the build report.
 */
export const asLvcCategory = (v: unknown): string | null =>
  (LVC_CATEGORIES as readonly string[]).includes(String(v)) ? String(v) : null;

const asText = (v: unknown, cap = 1500): string => (v == null ? '' : collapseSpaces(String(v)).slice(0, cap));
const asInt = (v: unknown, fallback = 0): number => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback; };
const objOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

function parseEvidenceBasis(v: unknown): EvidenceBasisItem[] {
  if (!Array.isArray(v)) return [];
  const out: EvidenceBasisItem[] = [];
  for (const raw of v.slice(0, 20)) {
    const o = objOf(raw);
    const table = asText(o.source_table, 120);
    const id = asText(o.source_record_id, 200);
    if (!table || !id) continue;
    out.push({ source_table: table, source_record_id: id, source_timestamp: asText(o.source_timestamp, 60) || null });
  }
  return out;
}

// ── parsing (both scoring passes share one shape) ────────────────────────────────────────────

export interface ParseFindingsOptions {
  pass: AuditPass;
  /** Uniquifies model-supplied finding ids across passes. */
  idPrefix: string;
}

/** What was discarded and why. Persisted (`raw_judge_error`) and traced — see run.ts. */
export interface ParseFailure {
  /** The offending fragment, truncated. Enough to see what the model actually sent. */
  fragment: string;
  error: string;
}

export interface ParseFindingsResult {
  findings: EpisodeFinding[];
  /** Findings discarded outright, after the repair pass had its chance. */
  unparseable: number;
  /** Findings kept only because a coercion repaired them. */
  repaired: number;
  failures: ParseFailure[];
}

export const PARSE_FRAGMENT_CHARS = 1000;

/** One discarded fragment, capped. JSON so an object survives readably; never the whole response. */
function fragmentOf(raw: unknown): string {
  try {
    return (typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '').slice(0, PARSE_FRAGMENT_CHARS);
  } catch {
    return String(raw).slice(0, PARSE_FRAGMENT_CHARS);
  }
}

/**
 * Parse a findings response into well-formed findings. A finding missing a required enum value or
 * a statement is DROPPED here — an unparseable finding is not a finding, and inventing a default
 * verdict for it would manufacture a score.
 *
 * ⚠️ THESE DROPS ARE NOT `n_dropped_invalid`, AND CONFLATING THEM HID A REAL SIGNAL. That counter
 * means exactly one thing — "A2 wrote a finding outside the documentation domain", a fence being
 * tested — and it is read as a rate of that specific misbehaviour. An unparseable finding is a
 * different fact about a different actor: the model returned something this engine could not read,
 * which is an integration problem, not a blinding one. It is reported through the pass's own
 * `unparseable` count, onto a trace event and onto the audit row's `error_detail`.
 *
 * Citation ids are left as the ORDINALS the model wrote. They are resolved against the referencing
 * checkpoint's own excerpt list by `resolveFindingCitations`, which is the only place that knows
 * which list a given ordinal was numbered against.
 */
export function parseFindings(text: string, opts: ParseFindingsOptions): ParseFindingsResult {
  const o = extractJsonObject(text);
  const list = Array.isArray((objOf(o)).findings) ? (objOf(o).findings as unknown[]) : null;
  if (!list) {
    return {
      findings: [], unparseable: 0, repaired: 0,
      failures: text.trim() ? [{ fragment: fragmentOf(text), error: 'the response carried no findings array' }] : [],
    };
  }

  const findings: EpisodeFinding[] = [];
  const failures: ParseFailure[] = [];
  let unparseable = 0;
  let repaired = 0;
  list.slice(0, 120).forEach((raw, i) => {
    const f = objOf(raw);
    const statement = asText(f.statement);

    // A statement is the finding. There is nothing to repair a missing one into.
    if (!statement) {
      unparseable++;
      failures.push({ fragment: fragmentOf(raw), error: 'no statement — a finding without one is not a finding' });
      return;
    }

    // A finding_type naming a VERDICT is a category slip, not an unreadable value: the model put
    // the right word in the wrong field. Move it to the verdict and infer the type, rather than
    // discarding a finding whose content is fine.
    const rawType = String(f.finding_type ?? '').trim().toLowerCase();
    const typeIsVerdict = (VERDICTS as readonly string[]).includes(rawType);
    const typeRes = typeIsVerdict
      ? { value: impliedFindingType(statement), repaired: true }
      : coerceEnum(FINDING_TYPES, f.finding_type);
    const domainRes = coerceEnum(DOMAINS, f.domain);
    const sevRes = coerceEnum(SEVERITIES, f.severity);
    // when the type carried the verdict, THAT is the verdict — a `concordant` in the type field is
    // the model telling us the course matched, whatever it left in the verdict field
    const verdictRes = typeIsVerdict
      ? { value: rawType as Verdict, repaired: true }
      : coerceEnum(VERDICTS, f.verdict);

    // severity and verdict have safe fallbacks (see the consts): an unreadable severity lands
    // mid-scale, an unreadable verdict lands on `unassessable`, which scores nothing.
    const severity: Severity = sevRes.value ?? SEVERITY_FALLBACK;
    const verdict: Verdict = verdictRes.value ?? VERDICT_FALLBACK;
    const severityFallback = sevRes.value == null;
    const verdictFallback = verdictRes.value == null;

    // finding_type and domain have NO safe fallback — both change what the finding is about, and
    // domain decides whether A2's fence caught it. Ambiguous or absent ⇒ drop.
    if (!typeRes.value || !domainRes.value) {
      unparseable++;
      failures.push({
        fragment: fragmentOf(raw),
        error: !typeRes.value
          ? `finding_type ${JSON.stringify(f.finding_type)} matches no legal value unambiguously`
          : `domain ${JSON.stringify(f.domain)} matches no legal value unambiguously`,
      });
      return;
    }
    const finding_type = typeRes.value;
    const domain = domainRes.value;

    if (typeRes.repaired || domainRes.repaired || sevRes.repaired || verdictRes.repaired
        || severityFallback || verdictFallback) {
      repaired++;
    }

    const rawId = asText(f.finding_id, 80);
    // ORDINALS, unresolved. Only a positive-integer sanity filter here — the ceiling belongs to
    // whichever checkpoint this finding references, and this function does not know which that is.
    const citation_ids = Array.isArray(f.citation_ids)
      ? Array.from(new Set((f.citation_ids as unknown[]).map(Number)
          .filter((n) => Number.isInteger(n) && n >= 1))).slice(0, 16)
      : [];

    // lvc_category rides ONLY on a commission finding in therapeutics or diagnostics (§3.4.2);
    // anywhere else it is nulled whatever the model returned, and an unknown value is nulled too.
    const lvcEligible = finding_type === 'commission' && (domain === 'therapeutics' || domain === 'diagnostics');
    const lvc_category = lvcEligible ? asLvcCategory(f.lvc_category) : null;

    findings.push({
      // A judged finding is its own group of one: `group_size` 1 keeps the shape uniform so no
      // reader has to branch on which pass produced the finding (round 12 item 2).
      group_size: 1,
      grouped_refs: [],
      grouped_days: [],
      finding_id: `${opts.idPrefix}-${rawId || String(i + 1)}`,
      pass: opts.pass,
      finding_type,
      verdict,
      domain,
      day_index: asInt(f.day_index, 0),
      checkpoint_ref: asText(f.checkpoint_ref, 120) || null,
      statement,
      severity,
      evidence_tier: oneOf(EVIDENCE_TIERS, f.evidence_tier) ?? 'C',
      evidence_basis: parseEvidenceBasis(f.evidence_basis),
      author_name: null,
      author_role: null,
      responsible_clinician_id: null,
      lvc_category,
      citation_ids,
      // filled by classifyCitationProvenance once the chunk→source map is known (run.ts)
      citation_provenance: null,
      verdict_before_cap: verdict,
      severity_before_cap: severity,
      capped: false,
      resolution: null,
      matcher_kind: null, matcher_terms: null, matched_term: null, confound: null,
    });
  });
  return { findings, unparseable, repaired, failures };
}

/** The section segment of a `<checkpoint-id>/<section>/<n>` entry ref, or null if it has none. */
export function escalationSectionOf(ref: string | null): string | null {
  if (!ref) return null;
  const parts = ref.split('/');
  return parts.length >= 2 ? parts[1] : null;
}

/**
 * ROUND 18 ITEM 2 — THE RESIDUAL ESCALATION GAP, and it is the same argument twice.
 *
 * Round 17 closed the RESOLVER path: an escalation trigger is a conditional, this mirror carries no
 * vitals, so its antecedent cannot be evaluated and the resolver never calls one divergent.
 * `dropJudgedOmissions` closes a second path: the judge may not author omissions at all.
 *
 * BUT A THIRD PATH WAS STILL OPEN. The judge can author a `commission`, `timing` or `sequencing`
 * finding and point its `checkpoint_ref` at an escalation entry — "noradrenaline was started late"
 * against `cp-d2/escalation/1`. Nothing dropped it, nothing rewrote it, and it scored: 8 points if
 * major. The claim is unevaluable for exactly the reason the resolver's was. "Started late" against
 * "if SBP < 90" needs to know when, or whether, SBP fell below 90 — and nothing in this pipeline
 * knows that. A commission is no better: "this was given when no trigger warranted it" is a claim
 * about the trigger.
 *
 * So a divergence-pass finding measured against an escalation entry cannot carry `divergent`,
 * whatever its type. It is rewritten to `unassessable` — the verdict that means this pipeline
 * cannot answer — and counted. Verdicts other than `divergent` are left alone: they carry no
 * penalty, and `concordant` on an escalation entry is a note that something was handled, which is
 * worth keeping in an audit that is supposed to record what went right.
 *
 * RESOLVER FINDINGS ARE EXEMPT because they have already been through the gate in resolve-core;
 * `resolution != null` identifies them, the same marker `dropJudgedOmissions` uses.
 */
export function enforceEscalationConditional(f: EpisodeFinding): { finding: EpisodeFinding; rewritten: boolean } {
  if (f.resolution != null) return { finding: f, rewritten: false };
  if (f.pass !== 'divergence' || f.verdict !== 'divergent') return { finding: f, rewritten: false };
  if (escalationSectionOf(f.checkpoint_ref) !== ESCALATION_SECTION) return { finding: f, rewritten: false };
  return {
    finding: {
      ...f,
      verdict: 'unassessable',
      statement: `${f.statement} This is measured against an escalation trigger — a conditional whose antecedent (vitals, bedside observation) this pipeline does not carry — so whether the action was required cannot be established here.`,
    },
    rewritten: true,
  };
}

/**
 * §3.4 as amended by decision 33: the diff pass no longer decides omissions, so an `omission`
 * finding from A1 is a second answer to a question the resolver has already settled — and an
 * unstable one, which is the whole reason the resolver exists. Dropped and counted.
 *
 * Fidelity findings are untouched: A2 is normalised to `commission` by its own rule and never
 * produces omissions in the first place.
 */
export function dropJudgedOmissions(findings: EpisodeFinding[]): { kept: EpisodeFinding[]; dropped: number } {
  const kept: EpisodeFinding[] = [];
  let dropped = 0;
  for (const f of findings) {
    // ⚠️ ONLY THE JUDGED ONES. The resolver's findings are omissions too — that is precisely what
    // it decides — and they are identified by carrying a `resolution`. Dropping those would delete
    // the entire omission analysis the decision was made to create.
    const judged = f.resolution == null;
    if (judged && f.pass === 'divergence' && f.finding_type === 'omission') { dropped++; continue; }
    kept.push(f);
  }
  return { kept, dropped };
}

/**
 * §4.2 as a HARD POSTCONDITION, in the other direction (item 4).
 *
 * §4.2 already stops a `divergent` claim that rests on nothing. This stops the opposite abuse, and
 * it is the one that actually happened: across three runs of IP-1286 the judge returned 23
 * `unassessable` verdicts, and NOT ONE of them had an empty evidence_basis or rested on a Tier C
 * source — ten cited Tier A. `unassessable` was being used to mean "I would rather not say",
 * which silently zeroes a finding that the evidence could have supported.
 *
 * A finding may claim `unassessable` only if the record genuinely cannot answer: empty basis, or
 * every cited source Tier C. Anything else is rewritten to `context_dependent` — the verdict that
 * actually means "unclear" — and counted in `n_unassessable_rejected`.
 *
 * Resolver findings are exempt: `absent_class_missing` IS the honest gap, and it is established by
 * code rather than claimed by a model.
 */
export function enforceUnassessable(f: EpisodeFinding): { finding: EpisodeFinding; rejected: boolean } {
  if (f.verdict !== 'unassessable') return { finding: f, rejected: false };
  if (f.resolution === 'absent_class_missing') return { finding: f, rejected: false };
  // ⚠️ ROUND 18 ITEM 2, WITH ITS SCOPE STATED HONESTLY (round 19 item 3).
  //
  // EVERY divergence-pass finding measured against an escalation entry is exempt — not only the
  // ones this file's own gate rewrote. The first version of this comment claimed the narrower
  // thing ("a finding code has just gated"), and the predicate below has always been the broader
  // one, so a MODEL-asserted `unassessable` on an escalation ref was exempt too.
  //
  // THE COMMENT WAS CHANGED TO MATCH THE PREDICATE, NOT THE OTHER WAY ROUND, because the broad
  // behaviour is the correct one. The exemption is a property of the QUESTION, not of who answered
  // it: an escalation trigger is a conditional whose antecedent this mirror cannot supply, so
  // `unassessable` is the true verdict there no matter who reaches it. A model that says so is
  // agreeing with what code would have concluded anyway, and §4.2a — which exists to stop the model
  // using `unassessable` as "I would rather not say" — has nothing to correct in that case.
  //
  // Without the exemption in some form the escalation gate was silently undone one line later: the
  // gated finding carries a Tier A basis, so `genuinelyUnanswerable` was false and it came back as
  // `context_dependent`, still in the denominator and still in the band.
  if (escalationSectionOf(f.checkpoint_ref) === ESCALATION_SECTION && f.pass === 'divergence') {
    return { finding: f, rejected: false };
  }
  const tiers = f.evidence_basis.map((b) => tierForTable(b.source_table));
  const genuinelyUnanswerable = tiers.length === 0 || tiers.every((t) => t === 'C');
  if (genuinelyUnanswerable) return { finding: f, rejected: false };
  return { finding: { ...f, verdict: 'context_dependent' }, rejected: true };
}

/**
 * ⚠️ THE JUDGE'S OUTPUT IS BOUNDED, FOR THE SAME REASON THE CHECKPOINT COURSE IS (item 3).
 *
 * Round 8 capped the expected course at four entries per category because output length was both a
 * cost channel and a variance channel — the marginal expectation is the one that appears in one
 * reading and not the next. The judge side had no such bound, and IPNO-416's diff pass ran to
 * 22,677 characters and was cut off mid-answer, losing the whole pass.
 *
 * ⚠️ DECISION 47 (V, 2026-09-05) — 30 BECAME 80, BECAUSE THE CAP HAD STARTED BITING ON REAL
 * EPISODES AND WAS DISCARDING THE ONLY REMAINING SOURCE OF DIVERGENT FINDINGS. 30 was chosen
 * against a measured 10–15 diff findings on IP-1286 and 10 on IP-1313, "comfortably above anything
 * observed". Two rounds later that was no longer true: on round 24 the A1 pass lost 18 findings on
 * IP-1483, 10 on IPNO-486 and 6 on IPNO-495. Decision 44 had meanwhile made A1 the ONLY pass that
 * can produce a divergent verdict — the resolver cannot — so a cap biting A1 was silently deciding
 * how much of an admission the audit was allowed to charge for.
 *
 * ⚠️ THIS CAP DOES NOT BOUND GENERATION, AND RAISING IT COSTS NO TOKENS. `capFindings` runs on the
 * PARSED list, after the model has already written its answer; `JUDGE_MAX_TOKENS` is what bounds
 * the call. At ~260 output tokens per finding, 16000 tokens can carry roughly 61 findings — so at
 * 80 this cap sits ABOVE what the ceiling can emit and should stop binding altogether. The
 * consequence is that the observable moves: `n_findings_truncated` will read 0, and the limiter to
 * watch becomes the pass's own `finish_reason`. A pass cut off at the ceiling is a truncation
 * failure, not a cap, and it is handled elsewhere.
 *
 * The prompt asks for most-consequential-first, so truncation drops the least consequential — the
 * same ordering contract the expected-course cap relies on.
 */
export const MAX_FINDINGS_PER_PASS = 80;

export function capFindings(findings: EpisodeFinding[]): { kept: EpisodeFinding[]; dropped: number } {
  if (findings.length <= MAX_FINDINGS_PER_PASS) return { kept: findings, dropped: 0 };
  return { kept: findings.slice(0, MAX_FINDINGS_PER_PASS), dropped: findings.length - MAX_FINDINGS_PER_PASS };
}

// ── the code-enforced rules ──────────────────────────────────────────────────────────────────

/**
 * §4.2, the grading rule. A finding whose evidence_basis is EMPTY, or whose every basis item
 * names a Tier C source, cannot carry `divergent`. Rewritten to `unassessable`.
 *
 * The tier is derived from the SOURCE TABLE, not from the model's own `evidence_tier` claim —
 * the model is being checked here, so its self-assessment is not the input.
 */
export function applyTierCRule(f: EpisodeFinding): { finding: EpisodeFinding; rewritten: boolean } {
  if (f.verdict !== 'divergent') return { finding: f, rewritten: false };
  // ⚠️ RESOLVER FINDINGS ARE EXEMPT (decision 33). This rule exists to stop a MODEL asserting a
  // divergence it cannot evidence. A resolver `absent_class_present` is the opposite: code looked,
  // the class was represented, nothing matched — and an absence has nothing to cite BY DEFINITION,
  // so an empty evidence_basis is the correct and only honest shape for it. Without this exemption
  // §4.2 would rewrite every code-established omission to `unassessable` and delete the entire
  // signal the decision was made to produce.
  if (f.resolution != null) return { finding: f, rewritten: false };
  const tiers = f.evidence_basis.map((b) => tierForTable(b.source_table));
  const onlyC = tiers.length === 0 || tiers.every((t) => t === 'C');
  if (!onlyC) return { finding: f, rewritten: false };
  return { finding: { ...f, verdict: 'unassessable' }, rewritten: true };
}

/**
 * §4.4, the uncited cap, as V ruled on 2026-09-02:
 *
 *   AN UNCITED FINDING MAY HOLD ANY VERDICT, INCLUDING `divergent`. The cap touches SEVERITY only,
 *   and its ceiling is `moderate` — never `major`. It is grounded when BOTH the finding and the
 *   checkpoint entry it is measured against carry a citation.
 *
 * ⚠️ WHY THE VERDICT OVERRIDE HAD TO GO. Rewriting the verdict to `context_dependent` did not make
 * a weak finding weaker, it DELETED findings: on IP-1286 nine of thirteen concordant findings were
 * erased, because "the course matched the expectation" is a conclusion about the RECORD, and an
 * expectation's citations say nothing about whether it matched. The cap was answering a question
 * nobody asked it. A citation bears on how much WEIGHT a divergence should carry, which is
 * severity, and on nothing else.
 *
 * ⚠️ THE TWO CEILINGS ARE ONE CEILING. This cap and the literature cap (round 4 item 8) both cap at
 * `moderate`, and a finding subject to both is capped at `moderate` — NOT stacked down to `minor`.
 * Stacking would invent a third severity band nobody defined and would punish a finding twice for
 * one property of its evidence.
 */
export const CAP_SEVERITY_CEILING: Severity = 'moderate';

/** Apply a severity ceiling. Idempotent, and it can only ever lower — applying two ceilings of the
 *  same height changes nothing the second time, which is what "do not stack them" means in code. */
export function capSeverityAt(severity: Severity, ceiling: Severity): Severity {
  const order: Severity[] = ['minor', 'moderate', 'major'];
  return order.indexOf(severity) > order.indexOf(ceiling) ? ceiling : severity;
}

/**
 * ROUND 14 ITEM 10 — ONE CAP, NARROWED, AND WHY THE OLD PAIR HAD TO GO (V, 2026-09-03; amends the
 * round 6 item 1 and round 4 item 8 rules).
 *
 * ⚠️ ON IPNO-416 ALL 58 MAJOR FINDINGS WERE CAPPED. Two caps stacked on the same ceiling — the
 * uncited-expectation cap took 19, the literature-only cap took 39 — and between them the `major`
 * grade became unreachable. That is not a strict scale, it is a broken one: with the 8-point term
 * dead, `divergence_index` degenerates to 100 − 4 × (divergent count), severity stops carrying any
 * information, and any duplication defect maps one-for-one onto the headline number. The engine
 * had, in effect, stopped measuring severity while continuing to report it.
 *
 * And it was capping the RIGHT findings hardest. The two strongest things this audit found on that
 * episode — no stent assessment in any of seven progress notes, and no note at all on the
 * discharge day — rest on the record itself and cite no guideline, because no guideline is needed
 * to say a note is missing. Both were capped to moderate for want of a citation.
 *
 * THE RULE NOW: a finding keeps the severity proposed while the checkpoint was still blinded —
 * `major` included — if it has EITHER of two kinds of support:
 *
 *   · AT LEAST ONE CITATION. Literature counts. A passage that says what is known is support for
 *     an expectation; the provenance is still classified and stored (`citation_provenance`), so a
 *     reader can tell normative from literature, but it no longer silences the finding.
 *   · CORROBORATING TIER A EVIDENCE. An `evidence_basis` entry naming a Tier A source — the
 *     admission record, progress notes, orders, labs, the discharge summary — is the record
 *     speaking for itself, which is the strongest thing this pipeline has.
 *
 * Only a finding with NEITHER is capped to moderate: it asserts serious harm on no citation and no
 * record. `severity_before_cap`, `capped` and `capped_count` are unchanged and still carry the
 * audit trail.
 */
export function findingHasTierAEvidence(f: EpisodeFinding): boolean {
  return f.evidence_basis.some((b) => tierForTable(b.source_table) === 'A');
}

export function applySeverityCap(f: EpisodeFinding): { finding: EpisodeFinding; capped: boolean } {
  if (f.citation_ids.length > 0 || findingHasTierAEvidence(f)) return { finding: f, capped: false };
  const severity = capSeverityAt(f.severity, CAP_SEVERITY_CEILING);
  if (severity === f.severity) return { finding: f, capped: false };
  // VERDICT UNTOUCHED, deliberately. See the note above.
  return { finding: { ...f, severity }, capped: true };
}

/**
 * Whether the expectation a finding was measured against carried a citation of its own.
 *
 * NOT DEPRECATED, and not a cap: round 14 item 10 folded both caps into `applySeverityCap`, and
 * this survived that as a MEASUREMENT. It feeds `n_uncited_entries`, which is how "how much of
 * this episode rests on expectations nothing normative backed" stays answerable now that the
 * answer no longer silences anything.
 */
export function entryWasUncited(f: EpisodeFinding, entryRefs: Map<string, CheckpointEntryRef>): boolean {
  if (f.pass !== 'divergence') return false;
  const entry = f.checkpoint_ref ? entryRefs.get(f.checkpoint_ref) : undefined;
  return !entry || entry.citation_ids.length === 0;
}

/**
 * §3.5, in two halves that are deliberately NOT the same operation.
 *
 * DOMAIN → DROP. A fidelity finding outside `documentation` is a clinical verdict written with the
 * discharge summary in view. There is no honest way to keep it: it is the thing A2 is fenced away
 * from, and relabelling it `documentation` would launder an outcome-aware judgement into the
 * blinded set. It is dropped and counted in `n_dropped_invalid`, which means this and nothing else.
 *
 * SHAPE → NORMALISE. `finding_type` and `checkpoint_ref` are different: §3.5 FIXES them for this
 * pass — every A2 finding is a `commission` against the record with no checkpoint behind it — so a
 * model returning `omission`, or a stray ref copied from the schema, has not made a different
 * claim, it has mislabelled the one claim this pass can make. Dropping those would throw away real
 * findings over a field the spec already determines. They are set to the only values they can have.
 */
export function normalizeFidelityFindings(findings: EpisodeFinding[]): { kept: EpisodeFinding[]; dropped: number; normalized: number } {
  const kept: EpisodeFinding[] = [];
  let dropped = 0;
  let normalized = 0;
  for (const f of findings) {
    if (f.pass !== 'fidelity') { kept.push(f); continue; }
    if (f.domain !== 'documentation') { dropped++; continue; }

    // ⚠️ A CONCORDANT FINDING IS NOT A COMMISSION. §3.5 fixes finding_type for this pass because
    // every A2 finding is a claim the record does not support — but a `concordant` A2 finding says
    // the opposite: the summary's claim IS supported, and it was worth recording that. Forcing it
    // to `commission` asserted an unsupported claim that the same row denies, and inflated
    // n_commission with confirmations. Its checkpoint_ref is still normalised — A2 has no
    // checkpoints either way.
    const wantsCommission = f.verdict !== 'concordant';
    const typeWrong = wantsCommission && f.finding_type !== 'commission';
    if (typeWrong || f.checkpoint_ref !== null) {
      normalized++;
      kept.push({ ...f, finding_type: wantsCommission ? 'commission' : f.finding_type, checkpoint_ref: null });
      continue;
    }
    kept.push(f);
  }
  return { kept, dropped, normalized };
}

/**
 * Resolve each divergence finding's citation ORDINALS against THE CHECKPOINT IT REFERENCES, and
 * map them to that checkpoint's real `mksap_chunks` ids.
 *
 * ⚠️ WHY PER CHECKPOINT AND NOT ONE GLOBAL CEILING. Every checkpoint retrieves its own excerpts:
 * day 0 may get 8 and day 3 may get 2, and each was numbered [1]…[k] against its OWN list. Clamping
 * to the largest k across the episode let a "[6]" written against the two-excerpt checkpoint
 * survive and then resolve against nothing — or worse, be read later as a chunk id. Resolving
 * against the referencing checkpoint's own list is the only reading under which the number the
 * model wrote and the passage it meant are the same thing.
 *
 * A finding whose ref names no known checkpoint loses its citations entirely, which is correct: it
 * has nothing to have cited against. The uncited cap then catches the finding itself.
 *
 * Fidelity findings carry no citations — A2 is shown no excerpts — so they are emptied here too.
 */
export function resolveFindingCitations(
  findings: EpisodeFinding[], checkpointChunkIds: Map<string, readonly number[]>,
  entryRefs?: Map<string, CheckpointEntryRef>,
): EpisodeFinding[] {
  return findings.map((f) => {
    if (f.pass !== 'divergence' || !f.checkpoint_ref) return { ...f, citation_ids: [] };
    const checkpointId = f.checkpoint_ref.split('/')[0];
    const chunkIds = checkpointChunkIds.get(checkpointId);
    const out: number[] = [];
    if (chunkIds && chunkIds.length) {
      for (const ordinal of f.citation_ids) {
        if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > chunkIds.length) continue;
        const chunkId = chunkIds[ordinal - 1];
        if (Number.isFinite(chunkId) && !out.includes(chunkId)) out.push(chunkId);
      }
    }
    // ⚠️ INHERIT FROM THE ENTRY — THIS IS WHERE THE CITATION WAS BEING LOST (item 8). 26 of 30
    // findings were uncited while every checkpoint carried 8 chunk ids, and the reason is that
    // NOTHING CARRIED THEM ACROSS. The prompt asks the model to repeat the entry's citation
    // numbers onto the finding, and models mostly do not bother; the entry itself was cited all
    // along. A finding measured against an entry stands on that entry's evidence by construction,
    // so when it names no citation of its own it inherits the entry's.
    if (!out.length) {
      const entry = entryRefs?.get(f.checkpoint_ref);
      if (entry) for (const id of entry.citation_ids) if (!out.includes(id)) out.push(id);
    }
    return { ...f, citation_ids: out };
  });
}

/**
 * Classify a finding's citations by the KIND of source they stand on, and cap what literature
 * alone may claim.
 *
 * ⚠️ WHY THIS EXISTS AT ALL. V widened retrieval on 2026-09-02: this engine may now cite anything
 * the corpus returns, not only the normative allowlist. That is a real gain — most of what a
 * physician would call the standard of care for a given admission is not in Choosing Wisely — but
 * it changes what a citation MEANS. A guideline says "this is what should be done". A StatPearls
 * chapter or a journal passage says "this is what is known", which is evidence for an expectation
 * and not the same thing as a standard against which a clinician can be found to have diverged.
 *
 * So the difference is recorded per finding, and priced: a finding standing ONLY on literature may
 * still be `divergent` — the record can genuinely show the course left the expected one — but it
 * cannot be `major`, because major asserts plausible serious harm against a standard, and
 * literature is not one. A single normative citation lifts the cap; that is what `mixed` is for.
 */
export function classifyCitationProvenance(
  citationIds: readonly number[], sourceById: Map<number, string>, normativeSources: readonly string[],
): CitationProvenance | null {
  if (!citationIds.length) return null;
  const normative = new Set(normativeSources.map((x) => x.trim()).filter(Boolean));
  let n = 0;
  let lit = 0;
  for (const id of citationIds) {
    const src = (sourceById.get(id) ?? '').trim();
    // An id whose source we never recorded counts as literature: the conservative reading, since
    // treating an unknown source as normative would lift a cap on no evidence at all.
    if (src && normative.has(src)) n++; else lit++;
  }
  if (n > 0 && lit > 0) return 'mixed';
  return n > 0 ? 'normative' : 'literature';
}


/**
 * ROUND 14 ITEM 1 — BILLING RECORDS DISPENSING, NOT ADMINISTRATION, AND CODE MUST HOLD THE LINE.
 *
 * IPNO-416's finding a1-F15 read a 15-line pharmacy batch posted on the discharge morning — a
 * batch that also contained syringes, an enema, nebulisers and thiamine — as "possible septic
 * shock with arrhythmia". The patient went home normally four hours later. Nothing in the notes of
 * that day suggested deterioration; the entire claim was built on billing lines.
 *
 * A billing row says a pharmacy issued an item against this admission. It does not say the item
 * reached the patient, when, at what dose, or whether it was returned. Building a clinical
 * narrative out of dispensing lines is the single richest source of invented findings this
 * substrate offers, because the lines are numerous, precise-looking and completely silent about
 * the thing the narrative asserts.
 *
 * THE RULE: a `commission` finding whose evidence is BILLING ONLY, on a day whose progress notes
 * say nothing that corroborates it, cannot exceed `minor`, and it must carry the caveat in its own
 * statement — so the ceiling is visible to a reader, not just to the arithmetic.
 *
 * CORROBORATION IS DELIBERATELY WEAK: any note-class record on that day is enough. Code is not
 * being asked whether the note supports the claim — that is a judgement, and this is the layer that
 * refuses to make judgements. It asks only whether a clinician wrote anything that day against
 * which the claim could have been checked. If nobody did, the claim stands on dispensing alone.
 */
export const BILLING_TABLE = 'kx_billing_records';
export const BILLING_ONLY_CEILING: Severity = 'minor';

export const BILLING_ONLY_CAVEAT =
  'Billing records dispensing, not administration: this rests only on pharmacy billing lines, '
  + 'with nothing in that day’s notes to corroborate it.';

/** Does any note-class event exist on this day? The weak corroboration test described above. */
export function notesOnDay(events: readonly EpisodeEvent[], dayIndex: number): boolean {
  return events.some((e) => e.day_index === dayIndex
    && (e.event_type === 'note' || e.event_type === 'initial_assessment'
      || e.event_type === 'handover' || e.event_type === 'ot_note'));
}

export function applyBillingOnlyCap(
  f: EpisodeFinding, events: readonly EpisodeEvent[],
): { finding: EpisodeFinding; capped: boolean } {
  if (f.finding_type !== 'commission') return { finding: f, capped: false };
  if (!f.evidence_basis.length) return { finding: f, capped: false };
  const billingOnly = f.evidence_basis.every((b) => b.source_table === BILLING_TABLE);
  if (!billingOnly) return { finding: f, capped: false };
  if (notesOnDay(events, f.day_index)) return { finding: f, capped: false };
  const severity = capSeverityAt(f.severity, BILLING_ONLY_CEILING);
  const statement = f.statement.includes(BILLING_ONLY_CAVEAT)
    ? f.statement
    : `${f.statement} ${BILLING_ONLY_CAVEAT}`;
  return { finding: { ...f, severity, statement }, capped: severity !== f.severity };
}

/**
 * DECISION 49 (V, 2026-09-05) — THE DISCHARGE-NOTE GAP FINDING IS WITHDRAWN.
 *
 * ⚠️ IT WAS ASKING FOR THE WRONG DOCUMENT. Round 14 raised `d-1` whenever the discharge day carried
 * no PROGRESS NOTE, at `major`, on the reasoning that "the decision to send the patient home was
 * taken without a same-day clinical entry". The document that must exist at discharge is the
 * DISCHARGE SUMMARY, and it existed on every episode this ever fired on — selection requires one
 * (§3.1). On Step C it fired on three of thirteen episodes (IP-1362, IP-1497, IPNO-629), identically
 * worded, at major severity, against admissions whose discharge documentation was present. A
 * finding that reliably reports a gap that is not there is worse than no finding at all.
 *
 * ⚠️ WHAT DECISION 49 PUTS IN ITS PLACE NEEDS A TIMESTAMP THIS ENGINE CANNOT SEE. The replacement
 * is "discharge summary finalised N hours after discharge" — context_dependent, minor, zero
 * penalty, report only. No finalisation time exists in anything the engine reads:
 *
 *   · `kx_discharge_summary_records` yields `discharge_date_time` and `_create_time`, and
 *     `_create_time` is the MIRROR'S INGEST TIME. The contract test "`_create_time` appears ONLY in
 *     the discharge-summary tiebreak" exists precisely because it is not a clinical time.
 *   · `discharge_extracted_cases.extracted_json` carries no signing, finalisation or document date
 *     at any nesting level — 954 rows, zero occurrences of any such key.
 *
 * Ingest time as a proxy would measure the mirror's pipeline and read as a statement about the
 * ward, so only the WITHDRAWAL is implemented. The id is kept reserved so a future replacement does
 * not silently reuse `d-1` for a different claim, and so this note stays where the next reader of
 * that id will look.
 */
export const MISSING_DISCHARGE_NOTE_ID = 'd-1';

/**
 * ROUND 23 ITEM 6 — TWO FINDINGS THAT CONTRADICT EACH OTHER ON ONE FACT MUST NOT BOTH SHIP.
 *
 * IPNO-495's report contained, in the same list, "chest X-ray does not exist anywhere in this
 * admission" and "chest X-ray was ordered on day 3". Both were produced by this engine, from the
 * same event list, and both went to the same reader. Whichever is right, shipping the pair costs
 * more than shipping neither: it tells a clinician the audit does not know what is in the record.
 *
 * The check is deliberately narrow, because a broad one would start adjudicating clinical
 * disagreement. It fires only on the case above: one finding SAYS SOMETHING WAS FOUND (it carries a
 * matched event or a non-empty evidence_basis) while another ASSERTS THE SAME SUBJECT IS ABSENT.
 * The subject comparison reuses the item-4 vocabulary, so it is the same notion of "same thing"
 * that grouping uses.
 *
 * ⚠️ THE EVIDENCED FINDING WINS AND THE ASSERTION IS DOWNGRADED, never the reverse, and never
 * dropped. A finding standing on a real event outranks one standing on a matcher that did not fire
 * — that is decision 44's principle applied between passes rather than within one. The downgraded
 * finding stays in the report, marked, because a reader who disagrees needs to see it.
 */
export function findingSubject(f: EpisodeFinding): string {
  const words = subjectWords(f.statement.split('.')[0] ?? f.statement);
  return words.join('+');
}

export interface ContradictionResult { findings: EpisodeFinding[]; downgraded: number }

export function resolveContradictions(findings: EpisodeFinding[]): ContradictionResult {
  const evidenced = new Map<string, EpisodeFinding>();
  for (const f of findings) {
    const hasEvidence = f.evidence_basis.length > 0 || !!f.matched_term;
    if (!hasEvidence) continue;
    const subj = findingSubject(f);
    if (subj && !evidenced.has(subj)) evidenced.set(subj, f);
  }

  let downgraded = 0;
  const out = findings.map((f) => {
    // only an ASSERTED absence can be contradicted: it claims something is not there
    const assertsAbsence = f.resolution === 'absent_class_present'
      || /\b(no matching|not detected|does not exist|was not (ordered|done|performed)|never (ordered|done))\b/i.test(f.statement);
    if (!assertsAbsence) return f;
    if (f.evidence_basis.length > 0 || f.matched_term) return f;
    const subj = findingSubject(f);
    const other = subj ? evidenced.get(subj) : undefined;
    if (!other || other.finding_id === f.finding_id) return f;
    downgraded++;
    return {
      ...f,
      verdict: 'context_dependent' as Verdict,
      statement: `${f.statement} ⚠️ Another finding in this same audit (${other.finding_id}) reports this on the record, so this absence is contradicted by the engine's own evidence and is not asserted.`,
    };
  });
  return { findings: out, downgraded };
}

// ── attribution (PRD §5) ─────────────────────────────────────────────────────────────────────

/**
 * Attach the author and the responsible clinician from the events a finding actually cites.
 * Every note-derived finding carries BOTH — which is the accountable party is a separate question,
 * answered by `attributedParty` below.
 */
export function attachAttribution(f: EpisodeFinding, events: EpisodeEvent[]): EpisodeFinding {
  const byRecord = new Map<string, EpisodeEvent>();
  for (const e of events) byRecord.set(`${e.provenance.source_table}::${e.provenance.source_record_id}`, e);
  for (const b of f.evidence_basis) {
    const e = byRecord.get(`${b.source_table}::${b.source_record_id}`);
    if (!e) continue;
    if (e.author_name || e.responsible_clinician_id) {
      return {
        ...f,
        author_name: e.author_name,
        author_role: e.author_role,
        responsible_clinician_id: e.responsible_clinician_id,
      };
    }
  }
  return f;
}

/**
 * Who this finding is attributed to (§5): a `documentation` finding is the AUTHOR's — they wrote
 * the note or the summary — and every other domain is the RESPONSIBLE CLINICIAN's, because the
 * decision was theirs whoever typed it up. Returns null when the record does not name one; an
 * unattributed finding is reported unattributed, never assigned to the nearest name.
 */
export function attributedParty(f: EpisodeFinding): { kind: 'author' | 'responsible_clinician'; value: string } | null {
  if (f.domain === 'documentation') {
    return f.author_name ? { kind: 'author', value: f.author_name } : null;
  }
  return f.responsible_clinician_id ? { kind: 'responsible_clinician', value: f.responsible_clinician_id } : null;
}

// ── scoring (PRD §6) ─────────────────────────────────────────────────────────────────────────

export const SEVERITY_PENALTY: Record<Severity, number> = { major: 8, moderate: 4, minor: 1 };

/** §6.1. Only `divergent` findings contribute, from BOTH passes (decision 16). Floors at zero. */
export function penaltyTotal(findings: readonly EpisodeFinding[]): number {
  let penalty = 0;
  for (const f of findings) {
    if (f.verdict !== 'divergent') continue;
    penalty += SEVERITY_PENALTY[f.severity];
  }
  return penalty;
}

/**
 * ROUND 15 ITEM 1 — THE DENOMINATOR, AND WHY IT IS THIS ONE.
 *
 * V's instruction names `expectations_evaluated` and defines the ceiling as "the score an episode
 * would get if every expectation it was measured against had diverged at major severity", and
 * invited a different denominator with reasoning. This is that reasoning; the name is kept.
 *
 * IT COUNTS EVERY FINDING THIS ENGINE COULD ANSWER — every verdict except `unassessable`.
 *
 *   · NOT the ungrouped expectation entries. Round 12 collapses a standing expectation restated on
 *     six days into ONE finding; counting the six would divide by work the episode did not do and
 *     flatter every long stay, which is the defect this whole item exists to remove.
 *   · NOT the resolver's classes alone. Penalty comes from the diff and fidelity passes too — a
 *     fidelity finding is measured against the record rather than against an expectation — so a
 *     resolver-only denominator can be smaller than the population generating the numerator, and
 *     a rate whose numerator outruns its denominator is not a rate.
 *   · NOT every finding either. An `unassessable` finding is one this pipeline COULD NOT measure:
 *     no lab data in the window, no vitals in the mirror at all. Counting those in the denominator
 *     pays an episode for the questions it failed to answer, and rewards a thin record with a high
 *     score — the "confident 100" failure `scoring_status` already exists to prevent.
 *
 * What remains is exactly V's phrase: the things it WAS measured against. Every one of them could
 * have been a major divergence, and none of them was excused.
 *
 * ⚠️ AND THE RATE IS BOUNDED BY CONSTRUCTION. Penalty only accrues on `divergent` findings, each
 * at most 8, and every divergent finding is assessable — so penalty ≤ 8 × expectationsEvaluated
 * and the index cannot leave 0…100. `Math.max(0, …)` below is therefore a belt on a fastened belt,
 * kept only so a future change to SEVERITY_PENALTY cannot produce a negative score silently.
 */
export function expectationsEvaluated(findings: readonly EpisodeFinding[]): number {
  return findings.filter((f) => f.verdict !== 'unassessable').length;
}

/**
 * §6.1, AS A RATE (round 15 item 1, V 2026-09-03).
 *
 * ⚠️ THE TOTAL COULD NOT TRIAGE A LONG STAY, AND THE MEASUREMENTS SAY SO PLAINLY. Penalty was
 * subtracted from 100 outright, so IP-1483 (LOS 7, penalty 113) and IPNO-495 (LOS 11, penalty 198)
 * both floored at 0 and reported the same "substantial divergence" — a 76% difference in absolute
 * penalty rendered as one indistinguishable number. Every stay of about a week or more was going
 * to read identically, which is the opposite of a triage instrument: the longer the admission, the
 * less the score could say about it.
 *
 * A rate divides that out. An episode with 120 expectations and twelve divergences is not worse
 * than one with 20 expectations and eight, and the total said it was.
 *
 * THE ABSOLUTE FIGURES DO NOT DISAPPEAR. `penalty_total`, `expectations_evaluated` and
 * `n_divergent` are stored beside the index and shown beside the band, because the rate says how
 * this episode compares and the counts say how much there is to read, and a worklist needs both.
 */
export function divergenceIndex(findings: EpisodeFinding[]): number | null {
  const evaluated = expectationsEvaluated(findings);
  // Nothing was measured, so there is no rate. NOT zero, and not 100: both are claims about care.
  if (evaluated === 0) return null;
  const maxPenalty = SEVERITY_PENALTY.major * evaluated;
  return Math.max(0, Math.round(100 - (100 * penaltyTotal(findings)) / maxPenalty));
}

/** §6.2. Nine sources; the floor is 33 because selection already requires three of them. */
export function completenessPct(sourcesPresent: readonly string[]): number {
  const known = new Set<string>(COMPLETENESS_SOURCES as readonly string[]);
  const present = new Set(sourcesPresent.filter((t) => known.has(t)));
  return Math.round((100 * present.size) / COMPLETENESS_SOURCES.length);
}

export interface FindingCounters {
  n_findings: number;
  n_divergence_pass: number;
  n_fidelity_pass: number;
  n_omission: number;
  n_commission: number;
  n_timing: number;
  n_sequencing: number;
  n_divergent: number;
  n_context_dependent: number;
  n_unassessable: number;
  n_concordant: number;
  n_low_value: number;
  /** EVERY discarded finding: A2 domain drops PLUS parse failures. No discard leaves it at 0. */
  n_dropped_invalid: number;
  /** The parse-failure half of the above, kept separately so the two causes stay distinguishable. */
  n_parse_failed: number;
  /** `unassessable` verdicts the postcondition rewrote to context_dependent (item 4). */
  n_unassessable_rejected: number;
  /** Omission findings the diff pass emitted anyway, dropped under decision 33 (item 3). */
  n_judged_omissions_dropped: number;
  /** Findings dropped by the per-pass output cap. */
  n_findings_truncated: number;
  /**
   * ROUND 12 ITEM 2 — BOTH COUNTS, ALWAYS. `n_resolver_grouped` is how many resolver findings are
   * actually presented; `n_resolver_ungrouped` is how many expected-course entries they stand for.
   * Reporting only the first would hide the collapse, and reporting only the second would describe
   * an episode nobody is shown. On IPNO-416 these read 79 ungrouped against whatever the classes
   * collapse to — the ratio IS the measurement this item exists to produce.
   */
  n_resolver_grouped: number;
  n_resolver_ungrouped: number;
}

/**
 * `domainDropped` is the A2 domain-drop count; `parseFailed` is the number of findings the parser
 * discarded after its repair pass. BOTH land in `n_dropped_invalid` (item 5: no discard may leave
 * every counter at 0), and `n_parse_failed` keeps the second cause separately readable.
 *
 * ⚠️ THIS REVERSES round 2's item 7, deliberately and on the orchestrator's instruction. That round
 * separated them so `n_dropped_invalid` would mean only "A2 broke its fence"; IP-1286 then lost 5
 * findings with every counter reading 0, which is the worse failure. Two columns give both
 * readings: the total discard rate, and its breakdown.
 */
export function countFindings(findings: EpisodeFinding[], domainDropped: number, parseFailed = 0): FindingCounters {
  const c: FindingCounters = {
    n_findings: findings.length,
    n_divergence_pass: 0, n_fidelity_pass: 0,
    n_omission: 0, n_commission: 0, n_timing: 0, n_sequencing: 0,
    n_divergent: 0, n_context_dependent: 0, n_unassessable: 0, n_concordant: 0,
    n_low_value: 0,
    n_dropped_invalid: domainDropped + parseFailed,
    n_parse_failed: parseFailed,
    n_unassessable_rejected: 0,
    n_judged_omissions_dropped: 0,
    n_findings_truncated: 0,
    // Derived from the findings themselves: a resolver finding is one with a `resolution`, and it
    // carries the size of the class it stands for. Nothing has to be plumbed in beside them, so
    // the two counts cannot drift from the list they describe.
    n_resolver_grouped: findings.filter((f) => f.resolution != null).length,
    n_resolver_ungrouped: findings.filter((f) => f.resolution != null)
      .reduce((n, f) => n + Math.max(1, f.group_size), 0),
  };
  for (const f of findings) {
    if (f.pass === 'divergence') c.n_divergence_pass++; else c.n_fidelity_pass++;
    // ⚠️ THE TYPE COUNTERS EXCLUDE `concordant` FINDINGS (item 6). A concordant finding records
    // that expectation and course AGREE — it is not an omission, a commission, a timing error or a
    // sequencing error, and counting it as one inflated n_commission with confirmations. So
    // n_omission + n_commission + n_timing + n_sequencing = n_findings − n_concordant, by design.
    if (f.verdict !== 'concordant') {
      if (f.finding_type === 'omission') c.n_omission++;
      else if (f.finding_type === 'commission') c.n_commission++;
      else if (f.finding_type === 'timing') c.n_timing++;
      else c.n_sequencing++;
    }
    if (f.verdict === 'divergent') c.n_divergent++;
    else if (f.verdict === 'context_dependent') c.n_context_dependent++;
    else if (f.verdict === 'unassessable') c.n_unassessable++;
    else c.n_concordant++;
    if (f.lvc_category) c.n_low_value++;
  }
  return c;
}

/** `evidence_tiers` for the audit row: which source tables actually appeared, by tier. */
export function evidenceTiersOf(sourcesPresent: readonly string[]): { A: string[]; B: string[]; C: string[] } {
  const out: { A: string[]; B: string[]; C: string[] } = { A: [], B: [], C: [] };
  for (const t of sourcesPresent) out[tierForTable(t)].push(t);
  return { A: out.A.sort(), B: out.B.sort(), C: out.C.sort() };
}

/**
 * The whole post-model pipeline for one episode's findings, in the order the PRD specifies:
 * drop invalid A2 domains, apply the Tier C rewrite, apply the uncited cap, attach attribution,
 * then count and score. One function so the order cannot drift between callers.
 */
export interface FinalizeResult {
  findings: EpisodeFinding[];
  counters: FindingCounters;
  /** Null when nothing assessable was measured — see `divergenceIndex` (round 15 item 1). */
  divergence_index: number | null;
  /** The absolute figure the rate divides. Stored and shown beside the band. */
  penalty_total: number;
  /** The denominator: findings this engine could answer. Stored and shown beside the band. */
  expectations_evaluated: number;
  n_tier_c_rewritten: number;
  n_uncited_capped: number;
  /** Findings measured against an expectation that carried no citation (report-only since item 10). */
  n_uncited_entries: number;
  /** Commission findings held to `minor` because they stand on billing alone (item 1). */
  n_billing_only_capped: number;
  /** Judged findings rewritten to `unassessable` for naming an escalation entry (round 18 item 2). */
  n_escalation_unassessable: number;
  /** Asserted absences another finding in the same audit contradicted (round 23 item 6). */
  n_contradictions_downgraded: number;
  n_fidelity_normalized: number;
  /** Findings whose severity was cut from major because only literature backed them. */
  n_literature_capped: number;
  n_unassessable_rejected: number;
  n_judged_omissions_dropped: number;
  /** Ids of findings that ANY cap touched — the input to `scoringStatusFor`, and the source of
   *  `capped_count` on the audit row. */
  capped_finding_ids: Set<string>;
  /** How the surviving findings' citations break down — the measurement V asked for. */
  provenance_counts: Record<string, number>;
}

/** `parseFailed` is the count of findings the parser discarded; it joins the A2 domain drops in
 *  `n_dropped_invalid` and is also reported alone in `n_parse_failed`. */
export function finalizeFindings(
  raw: EpisodeFinding[], entryRefs: Map<string, CheckpointEntryRef>, events: EpisodeEvent[],
  parseFailed = 0,
  sourceById: Map<number, string> = new Map(),
  normativeSources: readonly string[] = [],
): FinalizeResult {
  const omissionDrop = dropJudgedOmissions(raw);
  const { kept, dropped, normalized } = normalizeFidelityFindings(omissionDrop.kept);
  let rewritten = 0;
  let unassessableRejected = 0;
  let capped = 0;
  let litCapped = 0;
  let uncitedEntries = 0;
  let billingCapped = 0;
  let escalationRewritten = 0;
  const capped_finding_ids = new Set<string>();
  const provenance_counts: Record<string, number> = { normative: 0, literature: 0, mixed: 0, none: 0 };
  const findings = kept.map((f0) => {
    // Cap BEFORE the Tier C rewrite: the cap can move a divergent finding to context_dependent,
    // at which point the Tier C rule no longer applies to it — which is correct, since the rule
    // exists to stop an unsupported DIVERGENT claim, and a capped finding no longer makes one.
    // ITEM 10: ONE cap, and it asks for citation OR Tier A record evidence — not both, and not a
    // guideline specifically. The uncited-ENTRY count is still taken, for the report, but it no
    // longer caps on its own.
    if (entryWasUncited(f0, entryRefs)) uncitedEntries++;
    // ITEM 1 FIRST, and the order matters: the billing ceiling is `minor`, below the severity
    // cap's `moderate`, so applying it first means a billing-only claim cannot be lifted back up
    // by having a citation. A dispensing line is not made into an administration record by a
    // guideline that says the drug should have been given.
    const billRes = applyBillingOnlyCap(f0, events);
    if (billRes.capped) { billingCapped++; capped_finding_ids.add(f0.finding_id); }
    const capRes = applySeverityCap(billRes.finding);
    if (capRes.capped) { capped++; capped_finding_ids.add(f0.finding_id); }
    const provenance = classifyCitationProvenance(capRes.finding.citation_ids, sourceById, normativeSources);
    const withProv: EpisodeFinding = { ...capRes.finding, citation_provenance: provenance };
    provenance_counts[provenance ?? 'none']++;
    if (provenance === 'literature') litCapped++;

    // ITEM 2: before the Tier C rule, because both rewrite a verdict and this one is about what
    // the finding is MEASURED AGAINST rather than what it rests on. A finding gated here is
    // already unassessable, so the Tier C rule then has nothing to do to it.
    const escRes = enforceEscalationConditional(withProv);
    if (escRes.rewritten) escalationRewritten++;

    const tierRes = applyTierCRule(escRes.finding);
    if (tierRes.rewritten) rewritten++;

    // §4.2 in the other direction: `unassessable` must be earned, not asserted (item 4).
    const unRes = enforceUnassessable(tierRes.finding);
    if (unRes.rejected) unassessableRejected++;

    // Stamp the audit trail from what the MODEL said, before any of the three rules ran, so the
    // caps can be recounted from the stored row rather than trusted from a log line.
    const stamped: EpisodeFinding = {
      ...unRes.finding,
      verdict_before_cap: f0.verdict,
      severity_before_cap: f0.severity,
      capped: capRes.capped || billRes.capped,
    };
    return attachAttribution(stamped, events);
  });

  // ITEM 6: the last gate before emission, and the only one that reads findings against EACH OTHER.
  const contradiction = resolveContradictions(findings);
  const emitted = contradiction.findings;
  // ⚠️ EVERY NUMBER BELOW READS `emitted`, NOT `findings`. A contradiction that is downgraded in the
  // report but still counted as divergent in the score would make item 6 cosmetic — the reader
  // would see the caveat and the arithmetic would ignore it.
  return {
    findings: emitted,
    counters: {
      ...countFindings(emitted, dropped, parseFailed),
      n_unassessable_rejected: unassessableRejected,
      n_judged_omissions_dropped: omissionDrop.dropped,
    },
    divergence_index: divergenceIndex(emitted),
    penalty_total: penaltyTotal(emitted),
    expectations_evaluated: expectationsEvaluated(emitted),
    n_tier_c_rewritten: rewritten,
    n_uncited_capped: capped,
    n_fidelity_normalized: normalized,
    // No longer a CAP count: how many findings stand only on literature, and how many were
    // measured against an expectation that carried no citation. Both are still worth reporting;
    // neither silences a finding any more (item 10).
    n_literature_capped: litCapped,
    n_uncited_entries: uncitedEntries,
    n_billing_only_capped: billingCapped,
    n_escalation_unassessable: escalationRewritten,
    /** ROUND 23 ITEM 6: absences the engine's own evidence contradicted. */
    n_contradictions_downgraded: contradiction.downgraded,
    n_unassessable_rejected: unassessableRejected,
    n_judged_omissions_dropped: omissionDrop.dropped,
    capped_finding_ids,
    provenance_counts,
  };
}

// ── the band (V, 2026-09-02) ─────────────────────────────────────────────────────────────────

/**
 * ⚠️ THE POINT SCORE IS NOT SHOWN. A BAND IS. AND THE REASON IS MEASURED, NOT AESTHETIC.
 *
 * `divergence_index` has a REPEAT-RUN SPREAD OF ±5 POINTS ON IDENTICAL INPUT. Five consecutive
 * runs of IP-1286 — same admission, same events, same engine, same deployment
 * (334ed090 / dpl_2FVKBmbCcxcMQncNWCAmYMn6ijN9, 2026-09-03) — scored:
 *
 *     40, 37, 36, 41, 36
 *
 * with the resolver breakdown near-frozen across all five (present 9/8/8/9/8,
 * absent_class_present 18/17/19/16/19, absent_class_missing 19/20/19/19/19,
 * ambiguous_confounded 7/7/7/7/7) and divergent findings 17–19. The remaining movement is the
 * checkpoint model's choice of WHICH expectations to state — day 2 produced five distinct expected
 * courses in five runs at a constant 15 entries.
 *
 * ⚠️ THE NEXT PERSON TO READ THIS MUST NOT MISTAKE THE BAND FOR COARSENESS OF AMBITION. It is not
 * a decision to report less than we could. It is a refusal to report more than we can support:
 * showing "38" implies a precision the engine does not have, and two admissions five points apart
 * are not distinguishable by this instrument. The band is the honest resolution of the measurement.
 * If the spread is ever measured smaller, on more than one episode, the bands can narrow — and
 * that is the only thing that should ever narrow them.
 *
 * ⚠️ NOT THE DISCHARGE ENGINE'S A–E LETTERS, deliberately. `ipd_discharge_audits.band` uses A–E and
 * appears on the SAME SCREEN as this one (decision 14). Reusing those letters for a different
 * quantity, on a different scale, measured by a different engine, would produce two "B"s on one row
 * that mean unrelated things. These bands are named in words for that reason.
 */
export const DIVERGENCE_BANDS = [
  'no divergence found', 'minor divergence', 'moderate divergence', 'substantial divergence',
] as const;
export type DivergenceBand = (typeof DIVERGENCE_BANDS)[number];

/**
 * DECISION 37 — THE BANDS, SETTLED (V, 2026-09-03) against the rate of decision 38.
 *
 * The old thresholds (90 / 70 / 45) were set against a TOTAL, where 45 meant "55 penalty points"
 * and any episode with seven major findings could reach it. Against a rate the same numbers mean
 * something else entirely: 45 would require 55% of every expectation evaluated to have diverged at
 * major severity, which no real admission will do. Left unchanged, `substantial divergence` would
 * have become unreachable — the mirror image of the defect decision 38 exists to fix.
 *
 *   ≥ 95  no divergence found     under a twentieth of expectations diverged
 *   88-94 minor divergence        up to about a tenth
 *   80-87 moderate divergence     up to a fifth
 *   < 80  substantial divergence  more than a fifth
 *
 * ⚠️ ANCHORED TO WHAT A PROPORTION MEANS, NOT FITTED TO THE FIVE EPISODES MEASURED. Five cases
 * cannot support a fitted scale, and fitting one would be the same error the band itself was
 * introduced to avoid — reading precision into an instrument that does not have it. Each boundary
 * is a plain fraction of the worst an episode could have scored, and it should be argued in those
 * terms or not at all.
 *
 * The one number the data DID settle is the top boundary. It was proposed at 97 and moved to 95
 * because nothing measured reached 97: the best episode of the five (IPNO-416) sat at 92, so a
 * 97 threshold would have made `no divergence found` as unreachable as `substantial` had been.
 * 95 leaves a genuinely clean admission somewhere to land.
 *
 * ⚠️ AND IP-1286 SITS AT 79, ONE POINT INSIDE `substantial`, WITH band_uncertain TRUE. That is the
 * mechanism working, not a boundary to tune away. Its penalty is 95 across 56 evaluated
 * expectations; the measured repeat spread of 5 penalty points moves it to 80, across the line.
 * The flag exists to say exactly that, and moving the threshold to quiet it would replace a
 * reported uncertainty with a hidden one.
 */
export const BAND_THRESHOLDS = { minor: 95, moderate: 88, substantial: 80 } as const;

/**
 * The measured repeat-run spread, IN PENALTY POINTS — which is what was actually measured, and
 * round 15 is the round in which that distinction starts to matter.
 *
 * ⚠️ IT IS NOT FIVE INDEX POINTS ANY MORE. IP-1286's five runs scored 40/37/36/41/36 on the old
 * TOTAL, a spread of 5. The index is a rate now, so the same 5 penalty points are worth
 * 100 × 5 / (8 × evaluated) index points — about 1.2 on IP-1286's 51 evaluated expectations, and
 * less on a longer episode. Restating "±5" against the new scale would have quadrupled the claimed
 * noise and marked almost everything as near a boundary.
 *
 * So the constant keeps the units it was measured in, and `bandIsUncertain` converts.
 */
export const PENALTY_REPEAT_SPREAD = 5;


export function divergenceBandFor(index: number | null): DivergenceBand | null {
  if (index == null || !Number.isFinite(index)) return null;
  if (index >= BAND_THRESHOLDS.minor) return 'no divergence found';
  if (index >= BAND_THRESHOLDS.moderate) return 'minor divergence';
  if (index >= BAND_THRESHOLDS.substantial) return 'moderate divergence';
  return 'substantial divergence';
}

/**
 * True when this episode's own penalty, moved by the repeat-run spread measured on identical
 * input, would put it in a DIFFERENT band — i.e. a re-run could plausibly land it either side of a
 * line. The UI says "(near boundary)" and means it.
 *
 * ⚠️ THE DOC HERE USED TO CITE A 45 THRESHOLD, which has not existed since decision 37 re-banded
 * against the rate (95 / 88 / 80). It also described a fixed index window, which decision 38
 * replaced: the spread was measured in PENALTY points, so its worth in index points depends on the
 * denominator and differs on every episode.
 *
 * The live example is IP-1286: index 79, penalty 95 across 56 evaluated expectations, one point
 * inside `substantial`. Five penalty points move it to 80 and across the line, so it reports
 * uncertain — which is the mechanism working, not a threshold to tune away.
 */
export function bandIsUncertain(
  index: number | null, penalty?: number | null, evaluated?: number | null,
): boolean {
  if (index == null || !Number.isFinite(index)) return false;
  const band = divergenceBandFor(index);
  if (!band) return false;
  // ⚠️ COMPUTED FROM THE MEASUREMENT, NOT FROM A RESTATED CONSTANT. Move the penalty by the spread
  // that was actually observed and ask whether the BAND changes. On a rate the same wobble matters
  // less on a long episode than on a short one — which is true, and a fixed index window cannot
  // express it.
  if (penalty != null && evaluated != null && evaluated > 0) {
    const at = (p: number) => Math.max(0, Math.round(100 - (100 * Math.max(0, p)) / (SEVERITY_PENALTY.major * evaluated)));
    for (const p of [penalty - PENALTY_REPEAT_SPREAD, penalty + PENALTY_REPEAT_SPREAD]) {
      if (divergenceBandFor(at(p)) !== band) return true;
    }
    return false;
  }
  // No denominator to convert with (a stored row from before round 15): fall back to the widest
  // honest reading — the old fixed window — rather than claiming a precision we cannot compute.
  return Object.values(BAND_THRESHOLDS).some((t) => Math.abs(index - t) <= PENALTY_REPEAT_SPREAD);
}

// ── scoring status (item 5) ──────────────────────────────────────────────────────────────────

export const SCORING_STATUSES = ['ok', 'no_expectations', 'nothing_evaluable', 'all_capped', 'incomplete_checkpoints'] as const;
export type ScoringStatus = (typeof SCORING_STATUSES)[number];

/**
 * ⚠️ THE MOST DANGEROUS OUTPUT THIS ENGINE CAN PRODUCE IS A CONFIDENT 100.
 *
 * `divergence_index` starts at 100 and subtracts penalties. That arithmetic cannot distinguish
 * "this admission ran exactly as expected" from "no expectation was ever formed, so nothing could
 * be found to diverge from" — and IP-1286 produced the second while looking like the first. An
 * episode with real omissions displaying a perfect score is worse than an episode displaying
 * nothing, because a number invites a clinician to trust it.
 *
 *   incomplete_checkpoints — a checkpoint errored or produced no entries, so part of the expected
 *                     course does not exist. `divergence_index` is stored NULL.
 *   no_expectations — no checkpoint produced a single entry. There was no standard to measure
 *                     against, so there is no score. `divergence_index` is stored NULL and the UI
 *                     says "not scorable" rather than rendering a number.
 *   all_capped      — findings exist, and EVERY one of them was capped (uncited expectation, or
 *                     literature-only evidence). The arithmetic still yields a high number, but
 *                     nothing in it survived at full weight, so the number means less than it
 *                     looks. Recorded so the UI can say so.
 *   ok              — a real score.
 */
export function scoringStatusFor(a: {
  totalExpectedEntries: number;
  findings: readonly EpisodeFinding[];
  cappedFindingIds: ReadonlySet<string>;
  /** Checkpoints that errored or produced no entries at all (item 2). */
  incompleteCheckpoints?: number;
}): ScoringStatus {
  // ⚠️ FIRST, BEFORE ANY OTHER TEST. On IP-1286 the day-2 checkpoint failed on all five runs — a
  // max_tokens truncation — and the episode scored `ok` on the remaining three quarters, five
  // times, with a number a clinician could read. A score computed against an expected course that
  // is missing a whole day is not a low score or a high score, it is not a score, and presenting
  // one is the most dangerous thing this engine has done.
  if ((a.incompleteCheckpoints ?? 0) > 0) return 'incomplete_checkpoints';
  // ⚠️ ROUND 23 ITEM 8 — NOTHING EVALUABLE IS A FAILURE, NOT A ZERO.
  //
  // IPNO-495's first run stored `divergence_index 0` with `scoring_status ok` on
  // `expectations_evaluated = 0`. A rate with an empty denominator is not a score of zero; it is
  // the absence of a score, and zero is the WORST value on this scale — the arithmetic silently
  // reported the most alarming possible reading of an episode nothing had been measured on.
  //
  // Every finding unassessable means the denominator is empty. `divergenceIndex` already returns
  // null there; this makes the row SAY so rather than leaving a null beside an `ok`.
  if (a.findings.length > 0 && a.findings.every((f) => f.verdict === 'unassessable')) return 'nothing_evaluable';
  if (a.totalExpectedEntries === 0) return 'no_expectations';
  if (a.findings.length > 0 && a.findings.every((f) => a.cappedFindingIds.has(f.finding_id))) return 'all_capped';
  return 'ok';
}

/** The score to STORE. Null under `no_expectations` — an absent standard yields no number, and a
 *  null is the only honest way to say that in an integer column. */
export function storedDivergenceIndex(index: number | null, status: ScoringStatus): number | null {
  // Both of these mean "there is no number here": no expectation was formed at all, or part of the
  // expected course is missing. `all_capped` keeps its number — that arithmetic is real, it is just
  // weakly evidenced, and the status says so.
  if (status === 'no_expectations' || status === 'incomplete_checkpoints' || status === 'nothing_evaluable') return null;
  // Round 15: the rate is itself null when nothing assessable was measured, and that null means
  // the same thing — there is no number here — so it passes straight through.
  return index;
}

// ── resolver findings (decision 33) ─────────────────────────────────────────────────────────

/**
 * Turn the deterministic resolver's output into findings, in the §3.4.2 shape.
 *
 * These carry `pass = 'divergence'` because that is what they are — a divergence between the
 * expected course and the record — but nothing in them was judged. Verdict, severity and statement
 * all come from the resolver; `resolution` records which of its four paths produced them; the
 * matcher and matched term are stored so any reader can re-run the lookup by hand.
 *
 * `evidence_basis` is the matched event when there was one. On an ABSENCE there is deliberately
 * nothing to cite — the claim is that no such record exists, and citing an unrelated row to dress
 * it up would be worse than an empty basis. §4.2's Tier C rule does not fire on these because
 * their verdicts are set by lookup, not asserted from evidence.
 */
const SEVERITY_RANK: Record<Severity, number> = { minor: 0, moderate: 1, major: 2 };
const TIER_RANK: Record<EvidenceTier, number> = { A: 0, B: 1, C: 2 };

/**
 * ROUND 14 ITEM 4 — THE SUBJECT OF AN EXPECTATION, NOT ITS SEARCH TERMS.
 *
 * ⚠️ THE TERM LIST WAS THE WRONG KEY, and IPNO-416 showed it twice over. Six stent-monitoring
 * expectations across four days stayed six separate findings because each day's checkpoint wrote a
 * slightly different term list for the same thing. The round-13 digest hit the same wall from the
 * other side: 111 entries deduplicated to 110, because the model rewords an expectation every time
 * it restates it ("Serum creatinine and electrolytes (K, Na) to assess acute-on-chronic kidney
 * function" one day, "Renal function test (creatinine, urea, electrolytes including potassium) to
 * assess trend" the next). Two keys, one defect: both asked whether the WORDS matched.
 *
 * The subject is what survives when the purpose clause and the qualifiers are removed. Three
 * deterministic steps, in this order:
 *
 *   1. CUT THE PURPOSE CLAUSE. Everything from "to assess / to evaluate / to guide / to monitor /
 *      to detect / to rule out / for …" onward states WHY, not WHAT. Two expectations that differ
 *      only in their reason are one expectation.
 *   2. DROP QUALIFIERS AND FILLER — "repeat", "serial", "daily", "consider", "if indicated",
 *      parentheticals, and a stopword list. A repeat CBC and a CBC are the same subject; whether
 *      it is a repeat is a matter for the day window, which item 3 now handles.
 *   3. CANONICALISE what remains through a small synonym map, then take the SET of surviving
 *      words. A set, so word order cannot split a class; canonicalised, so "kft" and "renal
 *      function test" land together.
 *
 * The matcher's terms are folded in as canonical words too, which is what pulls the six stent
 * findings together: whatever each day's phrasing, they all reduce to {stent}.
 *
 * `resolution` STAYS IN THE KEY (decision 45), for round 12's reason: a day the thing happened must
 * never merge into a group saying it did not. `verdict` does not — it is a function of the
 * resolution and the evidence, so keying on both split classes that resolved identically without
 * ever preventing a merge that `resolution` alone would have allowed.
 */
export function expectationSubject(entry: ResolvableEntry): string {
  // The matcher terms are folded in ONLY when the item text yielded no concept of its own —
  // otherwise a four-term matcher would re-introduce exactly the term-list brittleness this
  // replaces, by adding a word one day's phrasing happened to include.
  const fromItem = subjectWords(entry.item);
  const hasConcept = fromItem.some((w) => SUBJECT_CONCEPTS.has(w));
  const words = new Set(fromItem);
  if (!hasConcept) {
    for (const t of entry.matcher?.terms ?? []) for (const w of subjectWords(t)) words.add(w);
  }
  const sorted = [...words].sort();
  // A subject that canonicalises to nothing falls back to the raw text, which can only ever group
  // with text identical to itself — the same conservative fallback round 12 used for a missing
  // matcher. Never group on emptiness.
  return sorted.length ? sorted.join('+') : `text:${entry.item.trim().toLowerCase()}`;
}

/**
 * ROUND 23 ITEM 5, AS CORRECTED BY DECISION 45 — STANDING EXPECTATIONS DEDUPLICATE ACROSS
 * CHECKPOINTS, BUT NEVER ACROSS RESOLUTIONS.
 *
 * The half of round 23 that was right: on IPNO-495, 27 of 29 divergent findings were `group_size`
 * 1, and one standing concern raised at six checkpoints was charged six times. THE DAY LEAVES THE
 * KEY, so an expectation restated every day is one finding.
 *
 * ⚠️ DECISION 45 (V, 2026-09-05) — RESOLUTION COMES BACK INTO THE KEY, AND THE TERM-OVERLAP MERGE
 * IS GONE. Round 23 took both out together and the result was findings that said something false:
 *
 *   · IPNO-495 r-16, `group_size` 8, read "The record shows it: lab_order on day 5 matching cbc" —
 *     TWO BLOOD-CULTURE DIVERGENCES merged into a CBC match, because their matcher terms overlapped
 *     enough for the second pass to call them one class. The finding then reported the CBC as the
 *     evidence for the cultures.
 *   · IPNO-495 r-29, `group_size` 5, let ONE day-5 note ("peripheral pulses present") speak for
 *     days 5, 6, 7, 8 and 10 — four days on which nothing was checked at all.
 *
 * Both are the round-12 defect returning by a new route: a day the thing happened absorbing days it
 * did not. Round 12 called that concordant-erasure and fixed it by putting `resolution` in the key.
 * The key is `section | subject | resolution` again, and there is no second pass: two expectations
 * are one class when their SUBJECTS canonicalise alike, never because their term lists resemble
 * each other. Wording similarity is not identity, and this engine does not infer from resemblance.
 *
 * The best-evidenced-member rank stays. It is no longer load-bearing for correctness — every member
 * of a group now shares a resolution — but it still picks the member carrying an actual matched
 * event to speak for the group, which is the one whose statement can be checked.
 */
export function resolverGroupKey(entry: ResolvableEntry, outcome: ResolvedOutcome): string {
  return `${entry.section}|${expectationSubject(entry)}|${outcome.resolution}`;
}

/**
 * One finding per expectation CLASS, not per checkpoint-day. Order is the order the classes first
 * appear, so the output is as deterministic as the resolver that fed it.
 */
export function findingsFromResolved(
  resolved: readonly { entry: ResolvableEntry; outcome: ResolvedOutcome }[],
  domainForSection: (section: string) => Domain,
): EpisodeFinding[] {
  const groups = new Map<string, { entry: ResolvableEntry; outcome: ResolvedOutcome }[]>();
  for (const r of resolved) {
    const k = resolverGroupKey(r.entry, r.outcome);
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }

  return [...groups.values()].map((members, i) => {
    // THE BEST-EVIDENCED MEMBER SPEAKS FOR THE GROUP. Under decision 45 every member shares a
    // resolution, so this can no longer let a found day absorb a missed one — it picks, among days
    // that resolved alike, the one carrying a matched event, whose statement a reader can check.
    const rank = (m: { outcome: ResolvedOutcome }) =>
      (m.outcome.matchedEvent ? 4 : 0) + (m.outcome.resolution === 'present' ? 2 : 0)
      + (m.outcome.verdict === 'concordant' ? 1 : 0);
    const withEvent = [...members].sort((a, b) => rank(b) - rank(a))[0];
    const { entry, outcome } = withEvent;
    const days = [...new Set(members.map((m) => m.entry.dayIndex))].sort((a, b) => a - b);
    const refs = members.map((m) => m.entry.ref);
    // The worst severity any member proposed. Taking the first would let a major day hide behind a
    // minor one purely because of checkpoint order.
    const severity = members.reduce<Severity>((worst, m) =>
      SEVERITY_RANK[m.outcome.severity] > SEVERITY_RANK[worst] ? m.outcome.severity : worst, members[0].outcome.severity);
    const tier = members.reduce<EvidenceTier>((best, m) => {
      const t: EvidenceTier = m.outcome.matchedEvent ? m.outcome.matchedEvent.evidence_tier : 'C';
      return TIER_RANK[t] < TIER_RANK[best] ? t : best;
    }, 'C');
    const basis: EvidenceBasisItem[] = outcome.matchedEvent
      ? [{
          source_table: outcome.matchedEvent.provenance.source_table,
          source_record_id: outcome.matchedEvent.provenance.source_record_id,
          source_timestamp: outcome.matchedEvent.provenance.source_timestamp,
        }]
      : [];
    // The recurrence is part of the statement, because "expected on four days" and "expected once"
    // are different clinical claims and the reader must not have to open a field to tell them apart.
    const statement = members.length > 1
      ? `${outcome.statement} (expected at ${members.length} checkpoints, day${days.length === 1 ? '' : 's'} ${days.join(', ')})`
      : outcome.statement;
    return {
      finding_id: `r-${i + 1}`,
      pass: 'divergence',
      // The resolver answers "did the expected thing happen", so every finding it makes is an
      // omission question — including the ones where the answer is "yes".
      finding_type: 'omission',
      verdict: outcome.verdict,
      domain: domainForSection(entry.section),
      // The EARLIEST day the class was expected — the day the question was first asked.
      day_index: days[0],
      checkpoint_ref: entry.ref,
      statement,
      severity,
      evidence_tier: tier,
      evidence_basis: basis,
      author_name: null, author_role: null, responsible_clinician_id: null,
      lvc_category: null,
      // Every member's citations, deduplicated: a group is grounded if ANY member was.
      citation_ids: [...new Set(members.flatMap((m) => m.entry.citationIds))].sort((a, b) => a - b),
      citation_provenance: null,
      verdict_before_cap: outcome.verdict,
      severity_before_cap: severity,
      capped: false,
      resolution: outcome.resolution,
      matcher_kind: entry.matcher?.kind ?? null,
      matcher_terms: entry.matcher?.terms ?? null,
      matched_term: outcome.matchedTerm,
      confound: outcome.confound,
      group_size: members.length,
      grouped_refs: refs,
      grouped_days: days,
    };
  });
}

/** Checkpoint section → finding domain. The four sections map one-to-one onto §3.4.2's domains. */
export function domainForSection(section: string): Domain {
  switch (section) {
    case 'diagnostics': return 'diagnostics';
    case 'therapeutics': return 'therapeutics';
    case 'monitoring': return 'monitoring';
    case 'escalation': return 'escalation';
    default: return 'documentation';
  }
}

/**
 * The outcome line handed to pass B and to NOBODY else. It is built here, at the last stage, from
 * the discharge event — deliberately not carried through the pipeline in a variable that an
 * earlier pass could read.
 *
 * ROUND 12 / DECISION 35: it lives here, not in run.ts, because pass B now runs on demand from
 * the commentary route, long after the pipeline has exited. Both callers must build the same line
 * from the same events, so there is exactly one of it.
 */
export function outcomeLineFrom(events: EpisodeEvent[], losDays: number | null): string {
  const d = events.find(isDischargeEvent);
  if (!d) return 'The record carries no discharge event for this admission.';
  const type = (d.detail as Record<string, unknown>)?.discharge_type;
  return [
    `Discharged ${d.occurred_at ?? 'at a time the record does not give'}`,
    type ? `discharge type: ${String(type)}` : 'discharge type not recorded',
    losDays == null ? 'length of stay not computable' : `length of stay ${losDays} day(s)`,
  ].join(' · ');
}

// ── commentary (PRD §3.6) ────────────────────────────────────────────────────────────────────

export interface Commentary {
  narrative: string;
  outcome_context: string;
  findings_context: { finding_id: string; note: string }[];
}

/**
 * Any key that would make commentary a SCORE. Pass B is the only pass that knows the outcome, so
 * a number from it would be an outcome-aware grade sitting beside blind ones with nothing to tell
 * them apart. Checked over the whole object graph, not just the top level.
 */
export const COMMENTARY_FORBIDDEN_KEYS = [
  'score', 'scores', 'severity', 'verdict', 'verdicts', 'divergence_index', 'index', 'band',
  'grade', 'rating', 'rank', 'penalty', 'points', 'completeness_pct', 'care_value_index',
] as const;

function hasForbiddenKey(v: unknown, depth = 0): string | null {
  if (depth > 6 || !v || typeof v !== 'object') return null;
  if (Array.isArray(v)) {
    for (const e of v) { const hit = hasForbiddenKey(e, depth + 1); if (hit) return hit; }
    return null;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if ((COMMENTARY_FORBIDDEN_KEYS as readonly string[]).includes(k.toLowerCase())) return k;
    const hit = hasForbiddenKey(val, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export type CommentaryRejection = { ok: false; reason: string };
export type CommentaryAccepted = { ok: true; commentary: Commentary };

/**
 * Validate a commentary response against the known finding ids. REJECTS — never repairs — on a
 * score field or a finding_id that does not exist. The caller retries once and then stores null,
 * because commentary that invents a finding to annotate is worse than no commentary.
 */
export function validateCommentary(text: string, knownFindingIds: readonly string[]): CommentaryAccepted | CommentaryRejection {
  const o = extractJsonObject(text);
  if (!o || typeof o !== 'object') return { ok: false, reason: 'no JSON object in the response' };
  const forbidden = hasForbiddenKey(o);
  if (forbidden) return { ok: false, reason: `commentary carried a scoring field '${forbidden}'` };

  const r = o as Record<string, unknown>;
  const narrative = asText(r.narrative, 8000);
  const outcome_context = asText(r.outcome_context, 4000);
  if (!narrative && !outcome_context) return { ok: false, reason: 'commentary carried no prose' };

  const known = new Set(knownFindingIds);
  const ctxRaw = Array.isArray(r.findings_context) ? r.findings_context.slice(0, 80) : [];
  const findings_context: { finding_id: string; note: string }[] = [];
  for (const raw of ctxRaw) {
    const e = objOf(raw);
    const id = asText(e.finding_id, 80);
    const note = asText(e.note, 2000);
    if (!id && !note) continue;
    if (!known.has(id)) return { ok: false, reason: `commentary annotated an unknown finding_id '${id}'` };
    findings_context.push({ finding_id: id, note });
  }
  return { ok: true, commentary: { narrative, outcome_context, findings_context } };
}

// ── user messages for the three Opus passes ──────────────────────────────────────────────────

/**
 * ROUND 13 ITEM 3 — THE EXPECTATION DIGEST, and why it can be cut this hard.
 *
 * The diff pass used to receive every expected course in full: each entry with its rationale, its
 * matcher, its proposed severity and its citation ordinals, repeated for every checkpoint that
 * stated it. On IP-1483 (LOS 7, 8 checkpoints) that was 50,978 characters of the prompt.
 *
 * SINCE DECISION 33 THE DIFF PASS EMITS NO OMISSIONS. Whether an expected thing happened is a
 * lookup, answered deterministically by the resolver; A1 judges commission, timing and sequencing.
 * So it does not need the apparatus of checking an expectation off — it needs to know WHAT WAS
 * ANTICIPATED, closely enough to recognise something that was not.
 *
 *   · the RATIONALE argued for the expectation; A1 is not being asked to agree with it.
 *   · the MATCHER is the resolver's machine-checkable definition; A1 does not run the resolver.
 *   · the PROPOSED SEVERITY is a blinded pre-judgement about an omission A1 may not report.
 *   · the CITATIONS need not be repeated, because a finding INHERITS its entry's citation ids in
 *     `resolveFindingCitations` (round 11 item 8) whenever it names none of its own — which is
 *     what actually carries them today, models having mostly declined to copy them across.
 *
 * WHAT SURVIVES, and each for a reason that is not taste:
 *   · the ITEM TEXT — the expectation itself;
 *   · the EARLIEST `by_day` across the entries that state it, because "by day 1" and "by day 4"
 *     are different expectations of the same action and the earlier one is the one a timing
 *     finding is measured against;
 *   · ONE ENTRY REF. §3.4 requires `checkpoint_ref` non-null on every divergence finding, the
 *     uncited cap resolves that ref against `entryRefs` to decide whether the expectation was
 *     grounded, and citation inheritance uses the same lookup. A digest line with no ref would
 *     break all three. This is the one field kept beyond "item text only".
 *
 * DEDUPLICATION IS ACROSS CHECKPOINTS, and the key is section + normalised item text — the same
 * text-fallback normalisation round 12 uses for a matcher-less entry, so the two groupings cannot
 * drift apart. A daily checkpoint restates its standing expectations every day; sending seven
 * copies of "monitor urine output hourly" tells the judge nothing the first copy did not.
 *
 * THE REPRESENTATIVE REF IS THE EARLIEST MEMBER THAT CARRIES CITATIONS, and only when no member
 * carries any is it simply the earliest. Picking the earliest unconditionally would hand the cap
 * an uncited ref while a later checkpoint had cited the very same expectation — throwing away
 * evidence that exists, which is the defect round 11 item 8 was written to end.
 */
export interface DigestSource {
  checkpointId: string;
  dayIndex: number;
  course: ExpectedCourse | null;
}

export interface DigestEntry {
  section: (typeof CHECKPOINT_ENTRY_SECTIONS)[number];
  /** The representative entry ref, resolvable in `entryRefs`. */
  ref: string;
  item: string;
  /** Earliest `by_day` any member stated; null where the section carries none. */
  byDay: number | null;
  /** Every entry ref this line stands for, the representative included. Nothing is discarded. */
  memberRefs: string[];
}

export interface ExpectationDigest {
  entries: DigestEntry[];
  /** How many expected-course entries the digest stands for — the denominator of the reduction. */
  ungroupedCount: number;
  /** The rendered block, section by section. */
  text: string;
}

/**
 * ROUND 14 ITEM 4 REACHES THE DIGEST TOO. Round 13 keyed on normalised item text and collapsed
 * 111 entries to 110 on IP-1483 — no merging at all, because the checkpoint model rewords an
 * expectation each time it restates it. The digest now uses the SAME canonical subject the
 * resolver groups on, so the two cannot drift apart and one fix serves both.
 */
const digestKey = (section: string, item: string): string => {
  const words = subjectWords(item);
  return `${section}|${words.length ? words.join('+') : item.trim().toLowerCase()}`;
};

const SECTION_HEADINGS: Record<(typeof CHECKPOINT_ENTRY_SECTIONS)[number], string> = {
  diagnostics: 'DIAGNOSTICS', therapeutics: 'THERAPEUTICS',
  monitoring: 'MONITORING', escalation: 'ESCALATION TRIGGERS',
};

export function buildExpectationDigest(sources: readonly DigestSource[]): ExpectationDigest {
  interface Member { ref: string; dayIndex: number; byDay: number | null; cited: boolean }
  const groups = new Map<string, { section: DigestEntry['section']; item: string; members: Member[] }>();
  let ungroupedCount = 0;

  // Ordered by the checkpoint that stated it first: `sources` arrives in plan order, which is day
  // order, and within a course the entries keep the order the ref numbering already assumes.
  for (const src of sources) {
    const course = src.course;
    if (!course) continue;
    const add = (
      section: DigestEntry['section'], i: number, item: string, byDay: number | null, citationIds: number[],
    ) => {
      const text = collapseSpaces(item);
      if (!text) return;
      ungroupedCount++;
      const key = digestKey(section, text);
      const member: Member = {
        ref: `${src.checkpointId}/${section}/${i + 1}`,
        dayIndex: src.dayIndex, byDay, cited: citationIds.length > 0,
      };
      const g = groups.get(key);
      if (g) g.members.push(member);
      else groups.set(key, { section, item: text, members: [member] });
    };
    course.expected_diagnostics.forEach((e, i) => add('diagnostics', i, e.item, e.by_day, e.citation_ids));
    course.expected_therapeutics.forEach((e, i) => add('therapeutics', i, e.item, e.by_day, e.citation_ids));
    course.expected_monitoring.forEach((e, i) => add('monitoring', i, e.item, null, e.citation_ids));
    course.escalation_triggers.forEach((e, i) => add('escalation', i, `${e.trigger} → ${e.action}`, null, e.citation_ids));
  }

  const entries: DigestEntry[] = [...groups.values()].map((g) => {
    const byDays = g.members.map((m) => m.byDay).filter((d): d is number => typeof d === 'number');
    const representative = g.members.find((m) => m.cited) ?? g.members[0];
    return {
      section: g.section,
      ref: representative.ref,
      item: g.item,
      byDay: byDays.length ? Math.min(...byDays) : null,
      memberRefs: g.members.map((m) => m.ref),
    };
  });

  const lines: string[] = [];
  for (const section of CHECKPOINT_ENTRY_SECTIONS) {
    const inSection = entries.filter((e) => e.section === section);
    if (!inSection.length) continue;
    lines.push(SECTION_HEADINGS[section]);
    for (const e of inSection) {
      const day = e.byDay == null ? '' : ` · by day ${e.byDay}`;
      lines.push(`  ${e.ref}${day} · ${e.item}`);
    }
  }

  return { entries, ungroupedCount, text: lines.join('\n') };
}

export interface DiffUserInput {
  admissionContext: string;
  /** ALREADY filtered by diffPassEvents — no discharge event reaches here. */
  events: EpisodeEvent[];
  /** The deduplicated expectation digest (round 13 item 3), NOT the checkpoint JSON. */
  digest: ExpectationDigest;
}

export function buildDiffUser(input: DiffUserInput): string {
  const d = input.digest;
  const stated = d.entries.length === d.ungroupedCount
    ? `${d.entries.length} expectation${d.entries.length === 1 ? '' : 's'}`
    : `${d.entries.length} distinct expectation${d.entries.length === 1 ? '' : 's'}, stated ${d.ungroupedCount} times across the checkpoints`;
  return `ADMISSION CONTEXT
${input.admissionContext}

THE REAL COURSE (${input.events.length} event${input.events.length === 1 ? '' : 's'}; the discharge event is deliberately absent)
${input.events.length ? input.events.map(renderEvent).join('\n') : '(no events were assembled)'}

WHAT WAS EXPECTED (${stated})
${d.entries.length ? d.text : '(no checkpoint produced an expected course)'}

Report the divergences as the JSON object described in your instructions.`;
}

export interface FidelityUserInput {
  admissionContext: string;
  /** ALREADY filtered by fidelityPassEvents — the discharge event IS present here. */
  events: EpisodeEvent[];
  extractedCase: unknown;
  extractionVersion: string | null;
}

export function buildFidelityUser(input: FidelityUserInput): string {
  return `ADMISSION CONTEXT
${input.admissionContext}

THE REAL COURSE (${input.events.length} event${input.events.length === 1 ? '' : 's'}, including the discharge event)
${input.events.length ? input.events.map(renderEvent).join('\n') : '(no events were assembled)'}

THE EXTRACTED DISCHARGE SUMMARY (${input.extractionVersion ?? 'version not recorded'})
${JSON.stringify(input.extractedCase ?? null, null, 1).slice(0, 60000)}

Report the unsupported claims as the JSON object described in your instructions.`;
}

export interface CommentaryUserInput {
  admissionContext: string;
  events: EpisodeEvent[];
  findings: EpisodeFinding[];
  outcomeLine: string;
  expectedCourses: string[];
}

export function buildCommentaryUser(input: CommentaryUserInput): string {
  return `ADMISSION CONTEXT
${input.admissionContext}

HOW THIS ADMISSION ENDED
${input.outcomeLine}

THE REAL COURSE (${input.events.length} event${input.events.length === 1 ? '' : 's'})
${input.events.length ? input.events.map(renderEvent).join('\n') : '(no events were assembled)'}

THE CHECKPOINTS
${input.expectedCourses.length ? input.expectedCourses.join('\n\n') : '(no checkpoint produced an expected course)'}

THE FINDINGS (annotate by finding_id; you may not add to this list)
${input.findings.length
    ? input.findings.map((f) => `- ${f.finding_id} · ${f.pass} · ${f.finding_type} · ${f.domain} · day ${f.day_index} · ${f.severity} · ${f.verdict} · ${f.statement}`).join('\n')
    : '(no findings were produced)'}

Write the commentary as the JSON object described in your instructions.`;
}

/** Re-export so the checkpoint type travels with the findings pipeline that consumes it. */
export type { ExpectedCourse };
