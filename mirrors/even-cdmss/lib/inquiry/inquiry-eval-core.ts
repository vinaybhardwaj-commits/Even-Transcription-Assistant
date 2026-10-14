// lib/inquiry/inquiry-eval-core.ts — the FROZEN-evaluator core for the inquiry bench
// (Inquiry PRD §12, D13; ddx-eval pattern). PURE: no I/O, no LLM — scripts/inquiry-gold.mjs
// loads the gold JSON and runs the arms; this module only parses gold cases and scores served
// ask-sets deterministically. The evaluator freezes when V ratifies inquiry-gold/1.0; the
// INQUIRY_ENABLED prod flip is gated on the frozen floor (recorded as PRD addendum A1).
//
// Import discipline (architecture rule 5): intra-inquiry imports are TYPE-ONLY.

import type { AskItem, AskFamily } from '../care-call-core';

export const INQUIRY_GOLD_VERSION = 'inquiry-gold/1.0' as const;
export const INQUIRY_EVAL_VERSION = 'inquiry-eval/1.0' as const;

const FAMILIES: ReadonlySet<string> = new Set<AskFamily>(['MED_STATUS', 'FOLLOWUP_ACTION', 'COMPLAINT_STATUS', 'ALLERGY_CONFIRM', 'OUTSIDE_RECORDS']);

// ── gold shapes (fixture inputs frozen in the file; expectations scored here) ──
export interface GoldExpectation {
  first: { family: AskFamily; subject: string };            // the expected FIRST ask
  legalSlots23?: { family: AskFamily; subject?: string }[]; // legal set for slots 2–3 (empty/absent ⇒ any legal family)
  forbiddenGeneric?: string[];                              // marker phrases that flag a generic question
}
export interface GoldCase {
  id: string;
  placeholder?: boolean;
  note?: string;
  fixture: {
    episode: Record<string, unknown>;                        // DeidOpdCase-shaped (frozen in the file)
    snapshot?: Record<string, unknown> | null;               // MemberStateSnapshot-shaped evidence, or null
    now: string;                                             // the deterministic `now` for deriveUnknowns
    keys: { presc_uid: string; individual_uid: string; uhid?: string | null; note_date?: string | null };
  };
  expected: GoldExpectation;
}
export interface GoldBank { version: string; cases: GoldCase[] }

/** Parse + structurally validate a gold bank (throws on malformed gold — the bank is frozen input). */
export function parseGold(json: unknown): GoldBank {
  const j = json as { version?: unknown; cases?: unknown };
  if (!j || j.version !== INQUIRY_GOLD_VERSION) throw new Error(`gold version mismatch — expected ${INQUIRY_GOLD_VERSION}`);
  if (!Array.isArray(j.cases) || !j.cases.length) throw new Error('gold has no cases');
  for (const c of j.cases as GoldCase[]) {
    if (!c.id || !c.fixture?.episode || !c.fixture?.now || !c.fixture?.keys || !c.expected?.first?.family || typeof c.expected.first.subject !== 'string') {
      throw new Error(`malformed gold case ${String((c as { id?: string })?.id ?? '?')}`);
    }
    if (!FAMILIES.has(c.expected.first.family)) throw new Error(`illegal expected family in ${c.id}`);
  }
  return { version: String(j.version), cases: j.cases as GoldCase[] };
}

// ── deterministic matching primitives ──
const norm = (s: string): string => (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Subject match: any ≥4-char token shared, or one normalized subject containing the other. */
export function subjectMatches(expected: string, actual: string): boolean {
  const e = norm(expected); const a = norm(actual);
  if (!e) return !a;                    // subjectless expectation matches subjectless ask
  if (!a) return false;
  if (a.includes(e) || e.includes(a)) return true;
  const toks = new Set(e.split(' ').filter((t) => t.length >= 4));
  return a.split(' ').some((t) => t.length >= 4 && toks.has(t));
}

/** Generic question: fails to mention its subject, or carries a forbidden marker phrase. */
export function isGenericQuestion(ask: Pick<AskItem, 'subject' | 'question'>, forbidden: string[] = []): boolean {
  const q = (ask.question || '').toLowerCase();
  for (const f of forbidden) if (f && q.includes(f.toLowerCase())) return true;
  const toks = norm(ask.subject).split(' ').filter((t) => t.length >= 4);
  if (!toks.length) return false;       // subjectless families are exempt
  return !toks.some((t) => q.includes(t));
}

// ── per-case scoring (PRD §12 + addendum A1 metric ruling: family-legality is the SAFETY gate
// (vocabulary-only, must be 100%); slot-appropriateness (legalSlots23) is REPORTED, not a gate) ──
export interface ServedResult { asks: Pick<AskItem, 'id' | 'family' | 'subject' | 'question'>[]; source?: string }
export interface CaseScore {
  caseId: string;
  rightFirst: boolean;      // slot-1 family+subject match
  familyLegal: boolean;     // THE GATE: every served ask's family ∈ the 5 legal families — nothing else
  slotAppropriate: boolean; // REPORTED: slots 2–3 fall inside the case's legalSlots23 allow-list (when given)
  askCount: number;
  genericCount: number;
  fallback: boolean;        // served via deterministic_fallback
}

export function scoreCase(c: GoldCase, served: ServedResult): CaseScore {
  const asks = served.asks ?? [];
  const first = asks[0];
  const rightFirst = !!first && first.family === c.expected.first.family && subjectMatches(c.expected.first.subject, first.subject);

  // A1 ruling: legality = vocabulary ONLY — an out-of-band family would break capture (D10).
  const familyLegal = asks.every((a) => FAMILIES.has(a.family));

  // The former slots-2/3 allow-list check, MOVED here verbatim and non-gating. Absent/empty ⇒ true.
  let slotAppropriate = true;
  const legal = c.expected.legalSlots23;
  if (legal && legal.length) {
    for (const a of asks.slice(1, 3)) {
      const ok = legal.some((l) => l.family === a.family && (l.subject === undefined || subjectMatches(l.subject, a.subject)));
      if (!ok) { slotAppropriate = false; break; }
    }
  }

  const genericCount = asks.filter((a) => isGenericQuestion(a, c.expected.forbiddenGeneric ?? [])).length;
  return {
    caseId: c.id, rightFirst, familyLegal, slotAppropriate,
    askCount: asks.length, genericCount,
    fallback: served.source === 'deterministic_fallback',
  };
}

// ── aggregation over cases × repeats ──
export interface BenchAggregate {
  runs: number;
  rightFirstRate: number;      // 0..1
  familyLegalityRate: number;  // must be 1.0 to clear the gate (vocabulary-only, A1 ruling)
  slotAppropriateRate: number; // reported, NOT a gate (legalSlots23 allow-list)
  genericRate: number;         // generic asks / total asks
  fallbackRate: number;        // fallback runs / total runs
}

export function aggregateScores(scores: CaseScore[]): BenchAggregate {
  const runs = scores.length;
  if (!runs) return { runs: 0, rightFirstRate: 0, familyLegalityRate: 0, slotAppropriateRate: 0, genericRate: 0, fallbackRate: 0 };
  const asks = scores.reduce((n, s) => n + s.askCount, 0);
  const generics = scores.reduce((n, s) => n + s.genericCount, 0);
  return {
    runs,
    rightFirstRate: scores.filter((s) => s.rightFirst).length / runs,
    familyLegalityRate: scores.filter((s) => s.familyLegal).length / runs,
    slotAppropriateRate: scores.filter((s) => s.slotAppropriate).length / runs,
    genericRate: asks ? generics / asks : 0,
    fallbackRate: scores.filter((s) => s.fallback).length / runs,
  };
}
