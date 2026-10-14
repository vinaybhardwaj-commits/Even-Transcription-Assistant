// lib/inquiry/inquiry-core.ts — Inquiry engine (inquiry/0.1): pure candidate generation,
// Gemini-output validation and assembly (Inquiry PRD §5–§6). ADVISORY PLANE — a selection layer
// ABOVE the frozen care-call floor, never a fork of it: candidates are typed to the 5 existing
// ask families, ids stay `${family}:${slug(subject)}`, and every assembly guarantee of
// ask-set/0.1 §3.3 (high-alert first, cap 5, overflow preserved) survives verbatim.
//
// PURE: no LLM client, no I/O — the governed call is injected (deps.generate), so the route
// wires governedChat and the bench script wires its own arm. Transport failure (throw, timeout,
// unparseable output) retries once, then ⇒ buildAskSet verbatim (ask-set/0.1,
// deterministic_fallback); a PARSED response — even zero valid picks — ladder-assembles (K2).
//
// Import discipline (architecture rule 5): intra-inquiry references are 'import type' only; the
// sole value dependency is the frozen care-call floor (not a scored core). slug is deliberately
// duplicated from care-call-core (not exported there; the frozen floor is never edited).

import type { UnknownItem, UnknownKind } from './unknowns-core';
import { buildAskSet, ASK_SET_VERSION } from '../care-call-core';
import type { AskItem, AskKeys, OverflowItem } from '../care-call-core';
import type { DeidOpdCase } from '../opd-ingest-core';

export const INQUIRY_VERSION = 'inquiry/0.1' as const;
export const INQUIRY_ASK_SET_VERSION = 'ask-set/0.2' as const;

// ── the registered standing prompt (Stage-0 registry extracts *_SYSTEM template literals) ──
export const INQUIRY_SELECT_SYSTEM = `You help a care manager phrase the questions to ask a patient on a post-visit phone call. The questions have already been chosen and ordered for you.

You are given a numbered list of CANDIDATE questions (each with a family, subject, why it matters, and criticality) plus a short clinical context summary. Every candidate is already clinically legal — your job is ONLY to phrase, never to invent.

Rules:
- Write a warm, specific question for EVERY candidate in the list — do not select, drop, or reorder any. Ordering is already decided.
- Refer to each candidate ONLY by its number n from the list. Do not invent or alter ids.
- You may rewrite each pick's question text to be warmer and more specific, and its "why" — nothing else. The question MUST still name the candidate's subject, be a single question, and stay under 160 characters.
- NEVER invent a question that is not in the candidate list. NEVER change a candidate's family or subject.

Respond with JSON ONLY, exactly this shape:
{"picks":[{"n":<candidate number>,"question":"<the question to ask>","why":"<one short line for the care manager>"}],"rationale":"<optional, one line>"}`;

// ── shapes ──
export interface CandidateAsk extends AskItem {
  unknownIds: string[];
  why: string;
  /** K2 (B4): the UnknownKinds that produced this candidate — drives priorityRank. Baseline
   *  candidates carry []; a merge (same deterministic id) unions the kinds. */
  sourceKinds?: UnknownKind[];
}
/** B6: picks are NUMBER-based (1-based candidate list position) — real Gemini truncated/mangled
 *  echoed slug ids, silently discarding perfect picks; the list is already numbered in the prompt. */
export interface SelectionPick { n: number; question: string; why?: string }
export interface AskMetaItem { askId: string; unknownIds: string[]; why: string }
export interface InquiryAskSet {
  asks: AskItem[];
  overflow: OverflowItem[];
  ask_set_version: string;                      // 'ask-set/0.2' | 'ask-set/0.1' (fallback)
  source: 'inquiry' | 'deterministic_fallback';
  askMeta: AskMetaItem[];
}

// local copies (deliberate duplication — see header)
const slug = (s: string): string =>
  (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x';
const clip = (s: string, n = 80): string => (s.length > n ? s.slice(0, n).trim() : s).trim();

/** Does the question mention at least one meaningful token of its subject? (generic suppression). */
export function questionMentionsSubject(subject: string, question: string): boolean {
  const toks = (subject || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4);
  if (!toks.length) return true;   // subjectless families (ALLERGY_CONFIRM / OUTSIDE_RECORDS) are exempt
  const q = (question || '').toLowerCase();
  return toks.some((t) => q.includes(t));
}

// ── §5 candidate generation (pure) ──
const SKELETONS: Partial<Record<UnknownKind, (u: UnknownItem) => { family: AskItem['family']; question: string } | null>> = {
  med_contradiction: (u) => ({ family: 'MED_STATUS', question: clip(`Last time you said you'd stopped ${u.subject} — how is it now, are you taking it?`, 160) }),
  new_medication: (u) => ({ family: 'MED_STATUS', question: clip(`Doctor started ${u.subject} recently — have you begun taking it?`, 160) }),
  unknown_finding: (u) => ({ family: 'COMPLAINT_STATUS', question: clip(`How is ${u.subject} now?`, 160) }),
  missing_critical: (u) => ({ family: 'COMPLAINT_STATUS', question: clip(`How is ${u.subject} now?`, 160) }),
  care_gap: (u) => ({ family: 'FOLLOWUP_ACTION', question: clip(`Your ${u.subject} was ${clip(u.detail, 60)} — shall I help you book a repeat test?`, 160) }),
  followup_open: (u) => ({ family: 'FOLLOWUP_ACTION', question: clip(`Doctor advised ${clip(u.subject)} — shall I help you book it now?`, 160) }),
  allergy_unconfirmed: () => ({ family: 'ALLERGY_CONFIRM', question: 'Before I go — any medicine allergies we should have on file?' }),
  // instability_input / anything unmappable → no candidate (recorded as dropped in the persist payload)
};

/**
 * Each UnknownItem maps to ≤1 CandidateAsk typed to an EXISTING family (D10). The ask-set/0.1
 * deterministic asks (from the frozen buildAskSet) are ALSO candidates (`why: 'baseline'`) —
 * Gemini chooses among the union, so the deterministic floor competes rather than disappearing.
 */
export function candidatesFromUnknowns(unknowns: UnknownItem[], episode: DeidOpdCase, keys: AskKeys): CandidateAsk[] {
  const out: CandidateAsk[] = [];
  const byId = new Map<string, CandidateAsk>();
  const add = (c: CandidateAsk) => {
    const existing = byId.get(c.id);
    if (existing) {  // same deterministic id → merge derivation, keep the first phrasing
      existing.unknownIds = [...new Set([...existing.unknownIds, ...c.unknownIds])];
      existing.sourceKinds = [...new Set([...(existing.sourceKinds ?? []), ...(c.sourceKinds ?? [])])];
      if (existing.why === 'baseline' && c.why !== 'baseline') existing.why = c.why;
      return;
    }
    byId.set(c.id, c);
    out.push(c);
  };

  for (const a of buildAskSet(episode, keys).asks) add({ ...a, unknownIds: [], why: 'baseline', sourceKinds: [] });

  for (const u of unknowns) {
    const sk = SKELETONS[u.kind]?.(u) ?? null;
    if (!sk) continue;
    const subject = sk.family === 'ALLERGY_CONFIRM' ? '' : u.subject;
    add({
      id: `${sk.family}:${slug(subject)}`,
      family: sk.family,
      subject,
      question: sk.question,
      unknownIds: [u.id],
      why: u.detail,
      sourceKinds: [u.kind],
    });
  }
  return out;
}

/**
 * K2 (B4 ruling) + B5 rung insert: the deterministic clinical PRIORITY LADDER — lower = earlier.
 * The ladder owns slot ORDER (Gemini phrases only, never sets slot-1). Ties within a rung stay
 * stable by the candidate's original order, which preserves baseline note order.
 */
export function priorityRank(c: CandidateAsk): number {
  const kinds = c.sourceKinds ?? [];
  if (c.family === 'MED_STATUS' && c.meta?.highAlert === true) return 0;   // high-alert med — invariant slot-1
  // contradiction outranks new-by-construction: a contradicted med was seen before, so not new
  if (c.family === 'MED_STATUS' && kinds.includes('med_contradiction')) return 1;
  if (c.family === 'MED_STATUS' && kinds.includes('new_medication')) return 2;   // B5: just-started med — confirm uptake
  if (c.family === 'FOLLOWUP_ACTION' && kinds.includes('care_gap')) return 3;
  if (c.family === 'FOLLOWUP_ACTION') return 4;                            // episode follow-up-open / baseline
  if (c.family === 'MED_STATUS') return 5;                                 // routine med
  if (c.family === 'COMPLAINT_STATUS') return 6;
  if (c.family === 'ALLERGY_CONFIRM') return 7;
  return 8;                                                                // OUTSIDE_RECORDS
}

/** Unknowns that produced no candidate — persisted as `dropped` (PRD §5/§8). */
export function droppedUnknowns(unknowns: UnknownItem[], candidates: CandidateAsk[]): UnknownItem[] {
  const mapped = new Set(candidates.flatMap((c) => c.unknownIds));
  return unknowns.filter((u) => !mapped.has(u.id));
}

/** User-message builder for the governed call (registered by the Stage-0 builder scan).
 *  Clinical content only — uid/uhid/patient identity NEVER enter the prompt (PRD §17). */
export function buildInquirySelectUser(candidates: CandidateAsk[], contextSummary: string): string {
  // B6: the NUMBER is the pick handle — no id token in the line (Gemini mangled echoed slugs).
  const lines = candidates.map((c, i) =>
    `${i + 1}. family=${c.family} · subject=${c.subject || '(none)'} · high-alert=${c.meta?.highAlert ? 'yes' : 'no'} · why=${clip(c.why, 120)} · question="${c.question}"`);
  return `CONTEXT (de-identified):\n${contextSummary || '(no additional context)'}\n\nCANDIDATES:\n${lines.join('\n')}\n\nPhrase every candidate, JSON only.`;
}

/** Parse the model output → picks, or null on any structural failure (⇒ retry/fallback). */
export function parseSelection(raw: string): SelectionPick[] | null {
  try {
    // B6: Gemini wraps clean JSON in markdown code fences — strip them before extracting.
    let s = String(raw ?? '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]) as { picks?: unknown };
    if (!Array.isArray(j.picks)) return null;
    const picks: SelectionPick[] = [];
    for (const p of j.picks) {
      if (!p || typeof p !== 'object') return null;
      const { n, question, why } = p as Record<string, unknown>;
      if (typeof n !== 'number' || typeof question !== 'string') return null;
      picks.push({ n, question, why: typeof why === 'string' ? why : undefined });
    }
    return picks;
  } catch {
    return null;
  }
}

/**
 * Deterministic validation (§6, B6 number-based, B7 phrase-all): every pick resolves by NUMBER
 * (1-based list position) to a candidate — out-of-range / non-integer n is rejected; no duplicate
 * candidates; question non-empty and ≤160 chars (else the pick is rejected); family/subject/id/
 * meta ALWAYS come from the candidate — Gemini may rewrite `question` and `why` only; a generic
 * question (no subject token) is replaced by the candidate's skeleton phrasing. B7: NO pick cap —
 * Gemini phrases EVERY candidate so each ladder-served ask has a phrasing; assembleInquiryAskSet
 * caps the SERVED set at 5, so no double-cap is needed here.
 */
export function validateSelection(picks: SelectionPick[], candidates: CandidateAsk[]): { ask: AskItem; meta: AskMetaItem }[] {
  const seen = new Set<string>();
  const valid: { ask: AskItem; meta: AskMetaItem }[] = [];
  for (const p of picks ?? []) {
    const c = Number.isInteger(p.n) && p.n >= 1 && p.n <= candidates.length ? candidates[p.n - 1] : undefined;
    if (!c || seen.has(c.id)) continue;                       // out-of-range n or duplicate candidate → rejected
    const q = String(p.question ?? '').trim();
    if (!q || q.length > 160) continue;                       // over-length / empty → rejected
    const question = questionMentionsSubject(c.subject, q) ? q : c.question;   // generic → skeleton
    seen.add(c.id);
    valid.push({
      ask: { id: c.id, family: c.family, subject: c.subject, question, meta: c.meta },
      meta: { askId: c.id, unknownIds: c.unknownIds, why: (p.why ?? '').trim() || c.why },
    });
  }
  return valid;
}

/** The byte-identical deterministic fallback (D11): buildAskSet verbatim, ask-set/0.1. */
export function fallbackAskSet(episode: DeidOpdCase, keys: AskKeys): InquiryAskSet {
  const base = buildAskSet(episode, keys);
  return {
    asks: base.asks,
    overflow: base.overflow,
    ask_set_version: ASK_SET_VERSION,
    source: 'deterministic_fallback',
    askMeta: base.asks.map((a) => ({ askId: a.id, unknownIds: [], why: 'baseline' })),
  };
}

/**
 * Assembly — K2 (B4 ruling): the deterministic priority LADDER owns slot order. Candidates are
 * served in (priorityRank, original-order) order, capped at 5; high-alert MED_STATUS is rank 0,
 * so the ask-set/0.1 "high-alert always first" invariant holds by construction. Gemini's picks
 * control PHRASING (question + why) only: a ladder-served candidate Gemini didn't pick is served
 * with its skeleton phrasing; a Gemini pick ranked below the top 5 does not jump the queue.
 * Everything unserved → overflow. Zero valid picks is NOT a fallback (transport failure is —
 * see runInquirySelection).
 */
export function assembleInquiryAskSet(
  episode: DeidOpdCase, keys: AskKeys,
  candidates: CandidateAsk[], validPicks: { ask: AskItem; meta: AskMetaItem }[],
): InquiryAskSet {
  const pickById = new Map(validPicks.map((v) => [v.ask.id, v]));
  const ranked = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => priorityRank(a.c) - priorityRank(b.c) || a.i - b.i);

  const asks: AskItem[] = [];
  const askMeta: AskMetaItem[] = [];
  const included = new Set<string>();
  for (const { c } of ranked) {
    if (asks.length >= 5) break;
    if (included.has(c.id)) continue;
    included.add(c.id);
    const pick = pickById.get(c.id);   // Gemini phrasing when picked; candidate skeleton otherwise
    asks.push(pick ? pick.ask : { id: c.id, family: c.family, subject: c.subject, question: c.question, meta: c.meta });
    askMeta.push(pick ? pick.meta : { askId: c.id, unknownIds: c.unknownIds, why: c.why });
  }

  const overflow: OverflowItem[] = [];
  const overflowSeen = new Set<string>();
  const spill = (family: AskItem['family'], subject: string) => {
    const k = `${family}:${slug(subject)}`;
    if (included.has(k) || overflowSeen.has(k)) return;
    overflowSeen.add(k);
    overflow.push({ family, subject });
  };
  for (const { c } of ranked) spill(c.family, c.subject);                   // unserved candidates, ladder order
  for (const o of buildAskSet(episode, keys).overflow) spill(o.family, o.subject);   // the frozen floor's own overflow

  return { asks, overflow, ask_set_version: INQUIRY_ASK_SET_VERSION, source: 'inquiry', askMeta };
}

// ── the injected-generation orchestration (still pure: the model call comes in via deps) ──
export interface InquirySelectDeps {
  /** One governed model call: (system, user) → raw model text. The route wires governedChat. */
  generate: (system: string, user: string) => Promise<string>;
  /** Compact de-identified member/episode summary for the prompt (optional). */
  contextSummary?: string;
  /** Hard budget for the model call; exceeded ⇒ deterministic fallback. */
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error('inquiry-select timeout')), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

/**
 * The full selection: candidates → one governed call (ONE retry on transport failure) →
 * parse → validate → ladder assembly. NEVER throws.
 * K2 (B4 ruling) failure semantics:
 *   · transport failure (generate throw / timeout / unparseable output) → RETRY ONCE with the
 *     same inputs; a second transport failure ⇒ buildAskSet verbatim (ask-set/0.1,
 *     source 'deterministic_fallback') — transient Gemini hiccups stop counting as fallbacks;
 *   · a PARSED response (any picks array, even empty / zero-valid) is NOT a failure — the
 *     deterministic ladder assembles with skeleton phrasing (member asks are kept, source 'inquiry').
 */
export async function runInquirySelection(
  episode: DeidOpdCase, keys: AskKeys, unknowns: UnknownItem[], deps: InquirySelectDeps,
): Promise<InquiryAskSet & { candidateCount: number; dropped: UnknownItem[] }> {
  const candidates = candidatesFromUnknowns(unknowns, episode, keys);
  const dropped = droppedUnknowns(unknowns, candidates);
  const decorate = (s: InquiryAskSet) => ({ ...s, candidateCount: candidates.length, dropped });

  const user = buildInquirySelectUser(candidates, deps.contextSummary ?? '');
  const attempt = async (): Promise<SelectionPick[] | null> => {
    const raw = await withTimeout(deps.generate(INQUIRY_SELECT_SYSTEM, user), deps.timeoutMs ?? 20_000);
    return parseSelection(raw);
  };

  let picks: SelectionPick[] | null = null;
  try { picks = await attempt(); } catch { picks = null; }
  if (picks === null) {
    try { picks = await attempt(); } catch { picks = null; }   // one retry, same inputs
  }
  if (picks === null) return decorate(fallbackAskSet(episode, keys));
  return decorate(assembleInquiryAskSet(episode, keys, candidates, validateSelection(picks, candidates)));
}
