/**
 * lib/readmission-ask-core.ts — PURE decisions for R4.3 "ask the agent" (CDMSS-READMISSIONS-R4.3-PRD
 * v1.0, R43-1..R43-8): the case MATERIAL the model may see (stored artefacts only), the caps
 * (question length, history turns, history size), and the answer verdict (citations enforced by
 * the same validator that guards narratives). No DB, no model, no clock.
 *
 * THE FENCE (the memo's rule): the conversation's whole world is this case's STORED material — the
 * evidence ledger, the agent's account, the judgements, the coverage, the two bills. Nothing new
 * enters the case through the ask-box; nothing the conversation says is stored on the finding.
 */
import { validateCitations, type CitationVerdict } from './readmission-narrative-core';

// ── caps (R43-4 / R43-7) ─────────────────────────────────────────────────────────────────

/** Question length cap (chars). */
export const ASK_QUESTION_MAX_CHARS = 500;
/** The last N turns passed back as context (a turn = one question + its answer). */
export const ASK_HISTORY_MAX_TURNS = 6;
/** Token cap on the history — chars/4 as the estimate; oldest turns drop first. */
export const ASK_HISTORY_MAX_TOKENS = 3_000;
/** Per-page-load question limit (client-enforced; the route enforces the per-request caps).
 *  Builder's proposal, flagged in the R4.3 report: enough for a real review, not a chat toy. */
export const ASK_PER_LOAD_LIMIT = 8;
/** The model call: one try, low temperature, ~90 s (R43-2). */
export const ASK_BUDGET_MS = 90_000;
export const ASK_MAX_TRIES = 1;
export const ASK_TEMPERATURE = 0.1;
export const ASK_MAX_TOKENS = 1_500;

export const ASK_WITHHELD_COPY = "The agent's answer failed its citation check and was not shown — try rephrasing the question.";
export const ASK_WORKING_COPY = 'The agent is reading the case — this takes about half a minute';
export const ASK_SUGGESTIONS: readonly string[] = ['Why was this case flagged?', 'What does the operative note show?', 'Why is negligence unknown?'] as const;
export const ASK_ADVISORY = 'Advisory — the agent answers only from this case\'s stored evidence and account; every citation is checked by code before it is shown; nothing you ask changes the case.';

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
 * PURE — CODE DECIDES (R43-3): every marker in the answer must resolve to a stored ledger id, via
 * the SAME validator that guards narratives. The one deliberate difference from the narrative rule
 * (flagged in the R4.3 report): an answer the model marked `answerable:false` — "the case record
 * does not show this" — may carry NO markers, because there is no fact to cite; it must still
 * carry no UNRESOLVED marker. Everything else: unresolved id → withheld; no markers on an
 * answerable answer → withheld; empty → withheld.
 */
export function askVerdict(parsed: AskParsed | null, ledgerIds: Iterable<string>): AskVerdict {
  if (!parsed) return { ok: false, answer: '', citedIds: [], invalidIds: [], reason: 'empty' };
  const v = validateCitations(parsed.answer, ledgerIds);
  if (v.valid) return { ok: true, answer: parsed.answer, citedIds: v.citedIds, invalidIds: [], reason: 'none' };
  if (v.reason === 'no_citations' && parsed.answerable === false) return { ok: true, answer: parsed.answer, citedIds: [], invalidIds: [], reason: 'none' };
  return { ok: false, answer: parsed.answer, citedIds: v.citedIds, invalidIds: v.invalidIds, reason: v.reason };
}
