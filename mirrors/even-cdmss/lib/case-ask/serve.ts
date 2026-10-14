/**
 * lib/case-ask/serve.ts — the request half both case-Ask routes share
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P1 / O4 / O7).
 *
 * O4 says there is NO shared multi-tenant ROUTE: OPD and IPD each get their own admin-gated
 * endpoint, so each can be found, authorised and revoked on its own. That is about HTTP surfaces,
 * not about copy-pasting a spend ceiling twice — the two endpoints therefore hand the same logic
 * here, differing only in the `load` callback that turns an id into that surface's material. The
 * ceiling, the citation gate, the withheld-turn discipline and the de-id fence exist ONCE, which is
 * the only way "turn 41 is refused" can be true of both surfaces rather than of whichever one was
 * edited last.
 *
 * Imports no readmission file (O3). Writes nothing but turns (O5).
 */
import {
  agentTurnsOnIstDay, overDailyCeiling, threadToHistory,
  CASE_ASK_CEILING_COPY, CASE_ASK_DAILY_TURN_LIMIT, CASE_ASK_WITHHELD_COPY,
  type CaseAskMaterial, type CaseAskThreadTurn, type CaseAskType,
} from '../case-ask-core';
import { appendTurn, readThread } from './store';
import { answerCaseAsk } from './ask';

/** What a surface's loader returns: the engine version this case was scored under (which is half
 *  the thread key, per O6) and the material the model may see. */
export type CaseAskLoad =
  | { ok: true; engineVersion: string; material: CaseAskMaterial }
  | { ok: false; status: number; error: string };

export interface CaseAskServeArgs {
  caseType: CaseAskType;
  caseKey: string;
  /** The role the request proved. O8 — role-only, never a person. */
  actor: string;
  load: () => Promise<CaseAskLoad>;
  /**
   * S4 — an optional hook for a surface whose reviewer may state a judgement that gets stored.
   * Called ONCE, after the answer has been stored, and only on an ANSWERED turn.
   *
   * The shell does not know what an overlay is and does not decide whether one is written: it hands
   * over the raw claim, the auditor's own words and the turn they were said in, and the surface's
   * gate does the rest. O5 stays true for OPD and IPD by construction — those two routes pass no
   * hook, so there is no path for one of their turns to write anything but a turn.
   *
   * It is awaited inside a try/catch: an overlay fault must never cost the auditor the answer.
   */
  onStatedOverlay?: (a: {
    overlay: unknown;
    question: string;
    userTurnId: string | null;
    engineVersion: string;
  }) => Promise<void>;
}

export interface CaseAskThreadPayload {
  ok: true;
  turns: CaseAskThreadTurn[];
  threadError: string | null;
  engineVersion: string;
  /** How many agent answers are still available on this thread today (O7). */
  remainingToday: number;
  /** The ids code minted for this case's stored material — the exact set an answer's markers are
   *  checked against. Sent to the surface so the chrome never re-derives the minting rule and can
   *  never drift from it. */
  itemIds: string[];
}

/** GET — the persisted thread, so a reload resumes the conversation instead of forgetting it
 *  (acceptance #1). The row is loaded first so a made-up case id cannot open a thread, and so the
 *  engine version in the key is the one the case was actually scored under. */
export async function serveCaseAskThread(
  a: CaseAskServeArgs,
): Promise<{ status: number; body: CaseAskThreadPayload | { ok: false; error: string } }> {
  const loaded = await a.load();
  if (!loaded.ok) return { status: loaded.status, body: { ok: false, error: loaded.error } };
  const key = { caseType: a.caseType, caseKey: a.caseKey, engineVersion: loaded.engineVersion };
  // Fail-safe: before migration 0046 has run this is an empty thread, which renders exactly as a
  // case nobody has asked about yet.
  const thread = await readThread(key);
  return {
    status: 200,
    body: {
      ok: true,
      turns: thread.turns,
      threadError: thread.error,
      engineVersion: loaded.engineVersion,
      remainingToday: remainingToday(thread.turns),
      itemIds: loaded.material.items.map((i) => i.id),
    },
  };
}

export interface CaseAskAnswerPayload {
  ok: true;
  withheld?: boolean;
  answer?: string;
  citedIds?: string[];
  answerable?: boolean;
  copy?: string;
  reason?: string;
  invalidIds?: string[];
  cost?: unknown;
  persisted: boolean;
  engineVersion: string;
  remainingToday: number;
}

/**
 * POST — one question, one answer, both stored.
 *
 * Order matters and is deliberate:
 *   1. load the case (a bad id never reaches the model or the store);
 *   2. read the thread from Neon — the SERVER is the thread's truth; no `history` is read off the
 *      request at all, so a client cannot rewrite what was said;
 *   3. O7 — if the day's agent-turn ceiling is already reached, store the auditor's question, store
 *      the polite refusal as a WITHHELD agent turn, and return 200 WITHOUT a model call;
 *   4. otherwise store his words FIRST (a model fault must lose the answer, never the question),
 *      then one Opus call, then code's citation verdict, then the agent turn.
 *
 * Nothing on this path writes a score, a band, a verdict, a feedback row or MemberState (§3.3).
 */
export async function serveCaseAskAnswer(
  a: CaseAskServeArgs & { question: string; now?: Date },
): Promise<{ status: number; body: CaseAskAnswerPayload | { ok: false; error: string } }> {
  const loaded = await a.load();
  if (!loaded.ok) return { status: loaded.status, body: { ok: false, error: loaded.error } };
  const key = { caseType: a.caseType, caseKey: a.caseKey, engineVersion: loaded.engineVersion };

  const thread = await readThread(key);
  const now = a.now ?? new Date();

  if (overDailyCeiling(thread.turns, now)) {
    const userTurn = await appendTurn({ ...key, role: 'user', content: a.question, actor: a.actor });
    const agentTurn = await appendTurn({ ...key, role: 'agent', content: CASE_ASK_CEILING_COPY, withheld: true });
    return {
      status: 200,
      body: {
        ok: true, withheld: true, reason: 'daily_ceiling', copy: CASE_ASK_CEILING_COPY, answerable: false,
        persisted: !!(userTurn && agentTurn), engineVersion: loaded.engineVersion, remainingToday: 0,
      },
    };
  }

  const history = threadToHistory(thread.turns);
  const userTurn = await appendTurn({ ...key, role: 'user', content: a.question, actor: a.actor });
  const answered = await answerCaseAsk({ caseKey: a.caseKey, material: loaded.material, history, question: a.question });

  if (answered.outcome === 'withheld') {
    const agentTurn = await appendTurn({ ...key, role: 'agent', content: CASE_ASK_WITHHELD_COPY, withheld: true });
    return {
      status: 200,
      body: {
        ok: true, withheld: true, reason: answered.reason ?? 'unresolved',
        invalidIds: answered.verdict?.invalidIds ?? [], copy: CASE_ASK_WITHHELD_COPY, answerable: false,
        cost: answered.cost, persisted: !!(userTurn && agentTurn), engineVersion: loaded.engineVersion,
        // The refused answer still cost a model call, so it still spends the day's budget.
        remainingToday: remainingAfter(thread.turns, now),
      },
    };
  }

  const agentTurn = await appendTurn({ ...key, role: 'agent', content: answered.verdict!.answer });

  // S4 — the overlay, last and fenced. The turn is already stored and the answer is already earned;
  // whatever happens here, neither is lost.
  if (a.onStatedOverlay) {
    try {
      await a.onStatedOverlay({
        overlay: answered.overlay,
        question: a.question,
        userTurnId: userTurn?.id ?? null,
        engineVersion: loaded.engineVersion,
      });
    } catch { /* an overlay is never worth a 500 (§12.3) */ }
  }

  return {
    status: 200,
    body: {
      ok: true, answer: answered.verdict!.answer, citedIds: answered.verdict!.citedIds,
      answerable: answered.answerable !== false, cost: answered.cost,
      persisted: !!(userTurn && agentTurn), engineVersion: loaded.engineVersion,
      remainingToday: remainingAfter(thread.turns, now),
    },
  };
}

/** How many agent answers this thread has left today, floored at zero (O7). */
function remainingToday(turns: readonly CaseAskThreadTurn[], now: Date = new Date()): number {
  return Math.max(0, CASE_ASK_DAILY_TURN_LIMIT - agentTurnsOnIstDay(turns, now));
}
/** The same, one turn later — the answer just stored is not in `turns` yet. */
function remainingAfter(turns: readonly CaseAskThreadTurn[], now: Date): number {
  return Math.max(0, remainingToday(turns, now) - 1);
}
