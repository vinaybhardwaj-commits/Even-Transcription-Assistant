/**
 * lib/ipd-episode/model-call.ts — THE ONE PLACE THIS ENGINE CALLS A MODEL.
 *
 * ⚠️ WHY THIS FILE EXISTS: THE SAME DEFECT, THREE TIMES IN FOUR ROUNDS.
 *
 *   round 8   the day-2 checkpoint returned finish_reason `length` on every attempt of every run
 *             for five consecutive runs. The checkpoint was recorded `status: error` with zero
 *             entries and the episode scored `ok` on the remaining three quarters.
 *   round 10  the same truncation, unnoticed, was the reason a whole day of expected course was
 *             missing from every score above.
 *   round 11  IPNO-416's DIFF pass: `finish_reason=length`, content_length 22677, episode skipped.
 *
 * Every occurrence had the same shape and a separate retry loop that handled it slightly
 * differently, and each fix raised one ceiling without re-deriving the others. So there is now ONE
 * helper, used by every call site, and truncation is a FIRST-CLASS FAILURE inside it:
 *
 *   · a `length` finish is never accepted as an answer, however much content came back — a
 *     truncated JSON body is not a short answer, it is an unparseable one;
 *   · it is retried ONCE with an instruction to emit only the most consequential items, because a
 *     model asked for less usually gives less, and that is a cheaper fix than a bigger ceiling;
 *   · a second truncation FAILS THE CALL with a reason naming the call and the character count, so
 *     the next person sees which call and how big rather than a generic provider error.
 *
 * ⚠️ ROUND 13 — AND THE LADDER THAT MADE A TIMEOUT FATAL TO THE WHOLE INVOCATION.
 *
 * IP-1483's diff pass timed out three times and killed the function. The arithmetic:
 * `governedChat` on Bedrock already runs its own ladder — PROVIDER_BUDGETS.bedrock.utility, 110 s
 * per attempt × 3, which is 332,250 ms of worst case in ONE call to it. This helper then wrapped
 * that in THREE more attempts of its own. Nine provider attempts, ~996 s, inside an 800 s box: the
 * invocation died at the third, having written no audit row and no skip row.
 *
 * TWO THINGS FOLLOW, and they are items 1 and 2 of round 13.
 *
 * · ONE ATTEMPT HERE (`TRANSPORT_ATTEMPTS = 1`). The reasoning this file already applies to
 *   truncation applies unchanged to a timeout: a retry at the same size gets the same timeout.
 *   The provider ladder inside `governedChat` is the retry; a second ladder around it is not
 *   resilience, it is the same failure three times at triple the price.
 *
 * · NO ATTEMPT IS STARTED THAT THE BUDGET CANNOT FINISH. The caller passes `deadlineAt` — the
 *   wall-clock moment the invocation must be done by — and this helper refuses to begin a call
 *   when less than one worst case remains. A refusal is a returned `error`, so the episode lands
 *   as a recorded `diff_failed` skip (PRD §8) instead of a killed invocation that leaves nothing
 *   behind. The deadline and the budget remaining are recorded at every attempt.
 *
 * THE WORST CASE IS DERIVED, NEVER TYPED. `ONE_CALL_WORST_CASE_MS` comes from the same
 * PROVIDER_BUDGETS table the transport reads. A number copied by hand here would have to be
 * edited in step with a table it cannot see — which is the defect one level up, and round 12
 * already paid for that lesson once with the cast gate.
 */

import { governedChat } from '../trace';
import { PROVIDER_BUDGETS, totalBudgetMs, type CallClass } from '../lab-provider-core';

export interface ModelCallInput {
  traceId: string | undefined;
  /** Trace label, e.g. `ipd_episode_diff`. Also names the call in a truncation failure. */
  label: string;
  system: string;
  user: string;
  model: string;
  maxTokens: number;
  temperature: number;
  promptRef: string;
  /**
   * Appended to the user message on the ONE truncation retry. Must ask for less output — a retry
   * that asks for the same thing gets the same length.
   */
  truncationRetryInstruction: string;
  /**
   * ROUND 14 ITEM 11 — THE CALL CLASS THIS ENGINE DECLARES.
   *
   * Until now it declared none, so `bedrockGenerate` defaulted it to `utility`: 110 s per attempt,
   * the class lib/lab-provider-core.ts documents as "a short bounded call (critic, classifier,
   * expansion). Seconds." The two judge passes are not that. IPNO-416's diff generated for
   * 212,402 ms; IPNO-495 (146,583-char prompt) and IP-1483 (214,094) each timed out on all three
   * 110 s attempts. Every 7-day episode tried was unauditable, and the one that passed did so
   * because a first attempt timed out and a second happened to come in under the wire.
   *
   * This is a MISCLASSIFICATION FIX, not a new ceiling. lib/bedrock.ts already says "an audit-class
   * caller passes its own, exactly as it does for Vertex and OpenRouter"; this engine simply never
   * did. Nothing in PROVIDER_BUDGETS changes.
   */
  callClass?: CallClass;
  /**
   * ROUND 13 ITEM 1. Epoch ms by which the INVOCATION — not this call — must be finished. No
   * attempt begins unless a whole `ONE_CALL_WORST_CASE_MS` still fits before it.
   *
   * `null` or absent means unbudgeted, and that is deliberate rather than an oversight: a unit
   * test calling a stub has no box to fit in. Every production call site passes one.
   */
  deadlineAt?: number | null;
}

/** What the budget did on this call, recorded whether it helped or refused (round 13 item 1). */
export interface ModelCallBudget {
  deadlineAt: number | null;
  /** Budget remaining at the moment each attempt was CONSIDERED, in order. */
  remainingMsAtAttempt: number[];
  /** True when an attempt was refused because less than one worst case remained. */
  refusedForBudget: boolean;
  /** The worst case one call was measured against, so a reader need not re-derive it. */
  worstCaseMs: number;
  /** The PROVIDER_BUDGETS class this call declared (item 11). */
  callClass: CallClass;
  /** The per-attempt ceiling actually sent to the transport, null if no attempt was made. */
  perAttemptMs: number | null;
  /** The class ladder did not fit, so ONE attempt was ceilinged at what was left. */
  shrunkToFit: boolean;
}

export interface ModelCallResult {
  text: string;
  /** The provider's finish_reason from the last attempt, recorded whether or not it succeeded. */
  finishReason: string | null;
  attempts: number;
  /** True when the call ended in a truncation that the retry did not fix. */
  truncated: boolean;
  /** Non-null when the call produced nothing usable. Names the call and, on truncation, the size. */
  error: string | null;
  budget: ModelCallBudget;
}

/**
 * Does this error mean the provider stopped because it ran out of room?
 *
 * The transport throws a ProviderResponseError whose message carries the finish_reason (see
 * lib/provider-error-core.ts). `length` is Converse's `max_tokens` mapped through
 * lib/bedrock-core.ts's mapStopReason. Matching on the message is unlovely, but the alternative is
 * reaching into a typed error the UNTOUCHED transport does not export.
 */
export function isTruncation(message: string): boolean {
  return /finish_reason=length|\(length\)/.test(message);
}

/** The character count the provider managed before being cut off, when the message reports one. */
export function truncatedAt(message: string): number | null {
  const m = /content_length=(\d+)/.exec(message);
  return m ? Number(m[1]) : null;
}

const finishReasonOf = (res: unknown): string | null =>
  String((res as { choices?: { finish_reason?: unknown }[] })?.choices?.[0]?.finish_reason ?? '') || null;

const contentOf = (res: unknown): string =>
  String((res as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content ?? '');

/**
 * ONE. See the round-13 note in the header: `governedChat` already runs the provider ladder, and
 * wrapping it in a second one turned a 332 s failure into a 996 s one that killed the invocation.
 *
 * A named constant rather than an inlined 1, because every reader who has looked at this file has
 * come to it asking how many times a call is retried, and the answer should be findable.
 */
export const TRANSPORT_ATTEMPTS = 1;

/**
 * The worst case ONE call to `governedChat` can cost on Bedrock, sleeps included.
 *
 * READ FROM THE TABLE THE TRANSPORT ITSELF READS. `bedrockGenerate` defaults an un-budgeted caller
 * to `PROVIDER_BUDGETS.bedrock.utility` (lib/bedrock.ts), so that is the class this engine's calls
 * belong to until someone rules otherwise, and `totalBudgetMs` is the same arithmetic the route
 * budget guard applies to every other worker: perAttemptMs × maxTries + the backoff allowance.
 *
 * It evaluates to 332,250 ms, and IP-1483 measured 332,735 ms and 331,818 ms on two consecutive
 * diff attempts — so this is the real number, not a modelled one.
 *
 * The fallback exists only so a missing table entry cannot make this NaN and disable the guard
 * silently; it is the same arithmetic on the same documented defaults.
 */
export const ONE_CALL_WORST_CASE_MS = totalBudgetMs('bedrock', 'utility') ?? 332_250;

/**
 * ROUND 14 ITEM 11. The default class stays `utility` — every existing caller keeps the budget it
 * has — and a call site that is audit-class says so.
 *
 * ⚠️ CHECKPOINTS STAY `utility`, DELIBERATELY. They are Haiku calls that generate in 15-35 s
 * (IPNO-416: 15.1, 23.9, 20.2, 21.7, 19.3 s; IP-1483's slowest 40.2 s), so 110 s is roughly 3×
 * their worst observed time — a ceiling that fits — and `utility`'s three tries are the right
 * resilience posture for a call cheap enough to repeat. Giving them 380 s × 1 would trade three
 * chances at a 35 s call for one, and lengthen the checkpoint stage's worst case from 332 s to
 * 380 s for no gain.
 *
 * ⚠️ AND `audit` RATHER THAN `audit_ipd`, for two reasons beyond the number. (1) 200 s is BELOW
 * IPNO-416's measured 212,402 ms diff, so `audit_ipd` would still have failed the one episode that
 * passed. (2) `audit_ipd` is named for, and sized against, the sibling IPD document analyze —
 * `IPD_ANALYZE_LEGS` in route-budget-guard.test.ts prices that engine's legs against it. Sharing
 * it would couple this engine's ceiling to changes made for the discharge engine's reasons, and a
 * future edit there would move a number here silently. `audit` is the looser coupling and the
 * safer figure.
 */
export const DEFAULT_CALL_CLASS: CallClass = 'utility';

/** The worst case for ONE call of a given class, sleeps included — the same arithmetic, per class. */
export function worstCaseMsFor(callClass: CallClass): number {
  return totalBudgetMs('bedrock', callClass) ?? ONE_CALL_WORST_CASE_MS;
}

/**
 * ⚠️ SHRINK TO FIT, RATHER THAN REFUSE ON PRINCIPLE — and this corrects round 13.
 *
 * Round 13 read "never begin an attempt the remaining budget cannot finish" as "refuse whenever a
 * whole class worst case does not fit". That is wrong in both directions, and it had already
 * broken something: the commentary route's box is 300 s, one utility call's worst case is 332 s,
 * so pass B would have been refused on EVERY episode — a route made unreachable by its own guard.
 * Item 11's 380 s class would have made it worse.
 *
 * The guarantee that actually matters is that a call cannot outlive the box. That is better kept
 * by BOUNDING the call to the time available than by declining to make it: `governedChat` accepts
 * a per-attempt ceiling, so a call given 250 s of a 250 s remainder cannot overrun, and an episode
 * whose fidelity pass takes 33 s (IPNO-416) still completes instead of being thrown away.
 *
 * A refusal is still the right answer when what remains is too small to finish anything — below
 * this floor a judge pass on a 150-200 KB prompt has no realistic chance, and spending the last
 * seconds of the box proving it is worse than recording the skip and moving on.
 */
export const MIN_VIABLE_ATTEMPT_MS = 60_000;

/** A margin between the call's own ceiling and the deadline, for the round trip that returns it. */
const CALL_RETURN_MARGIN_MS = 5_000;

export interface AttemptPlan { perAttemptMs: number; maxTries: number; shrunk: boolean }

/**
 * What this attempt may spend. `remainingMs` null means unbudgeted — the class default stands.
 * Returns null when the budget cannot fund an attempt worth making.
 */
export function planAttempt(callClass: CallClass, remainingMs: number | null): AttemptPlan | null {
  const b = PROVIDER_BUDGETS.bedrock?.[callClass];
  const perAttemptMs = b?.perAttemptMs ?? 110_000;
  const maxTries = b?.maxTries ?? 1;
  if (remainingMs == null) return { perAttemptMs, maxTries, shrunk: false };
  if (remainingMs < MIN_VIABLE_ATTEMPT_MS) return null;
  const full = worstCaseMsFor(callClass);
  if (remainingMs >= full) return { perAttemptMs, maxTries, shrunk: false };
  // Not enough for the class's full ladder: ONE attempt, ceilinged at what is actually left.
  return { perAttemptMs: Math.max(0, remainingMs - CALL_RETURN_MARGIN_MS), maxTries: 1, shrunk: true };
}

/**
 * Call the model. Never throws — every failure comes back as `error`, because an audit that dies on
 * a provider hiccup is worse than one that records the hiccup.
 */
export async function callModel(input: ModelCallInput): Promise<ModelCallResult> {
  let attempts = 0;
  let finishReason: string | null = null;
  let lastError = 'no attempt was made';
  let truncationsSeen = 0;

  const deadlineAt = input.deadlineAt ?? null;
  const callClass = input.callClass ?? DEFAULT_CALL_CLASS;
  // The guard measures against THIS call's class, not a single global figure: an audit-class call
  // needs 380 s of room and a utility one 332 s, and refusing the wrong one is how a budget guard
  // becomes either useless or an obstacle.
  const worstCaseMs = worstCaseMsFor(callClass);
  const budget: ModelCallBudget = {
    deadlineAt, remainingMsAtAttempt: [], refusedForBudget: false, worstCaseMs, callClass,
    perAttemptMs: null, shrunkToFit: false,
  };
  const done = (r: Omit<ModelCallResult, 'budget'>): ModelCallResult => ({ ...r, budget });

  // Up to one EXTRA pass beyond the transport ladder, spent only on a truncation retry.
  for (let round = 0; round < 2 && !budget.refusedForBudget; round++) {
    const extra = round === 0 ? '' : `\n\n${input.truncationRetryInstruction}`;

    for (let attempt = 0; attempt < TRANSPORT_ATTEMPTS; attempt++) {
      // ⚠️ THE BUDGET CHECK COMES BEFORE THE ATTEMPT COUNTER, so a refused attempt is not counted
      // as one that was made. `attempts` is read downstream as "how many times did we ask the
      // provider", and a call we declined to place is not an ask.
      const remainingMs = deadlineAt == null ? null : deadlineAt - Date.now();
      if (remainingMs != null) budget.remainingMsAtAttempt.push(remainingMs);
      const plan = planAttempt(callClass, remainingMs);
      if (!plan) {
        budget.refusedForBudget = true;
        lastError = `${input.label}: not started — ${Math.max(0, remainingMs ?? 0)} ms of the invocation budget remained, below the ${MIN_VIABLE_ATTEMPT_MS} ms floor for a ${callClass}-class call`;
        break;
      }
      budget.perAttemptMs = plan.perAttemptMs;
      budget.shrunkToFit = plan.shrunk;
      attempts++;
      if (attempt > 0) await new Promise((r) => setTimeout(r, 750 * Math.pow(2, attempt - 1)));
      try {
        const res = await governedChat(input.traceId, input.label, {
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: `${input.user}${extra}` },
          ],
          temperature: input.temperature,
          max_tokens: input.maxTokens,
          // ⚠️ THE BUDGET IS PASSED, NOT INHERITED (item 11). Absent these two the transport falls
          // back to `utility` inside bedrockGenerate, which is exactly how an audit workload ended
          // up on a ceiling documented in seconds.
        }, {
          bedrock: input.model, promptRef: input.promptRef,
          timeoutMs: plan.perAttemptMs, maxTries: plan.maxTries,
        });

        finishReason = finishReasonOf(res);
        const text = contentOf(res);

        // A `length` finish that did NOT throw: accept nothing from it either. The transport
        // usually throws first, but a provider that returns 200 with a truncated body and a clean
        // status would otherwise slip a half-written JSON object into the parser.
        if (finishReason === 'length') { truncationsSeen++; lastError = `${input.label}: truncated (finish_reason=length, ${text.length} chars)`; break; }
        if (!text.trim()) { lastError = `${input.label}: the response was empty`; continue; }
        return done({ text, finishReason, attempts, truncated: false, error: null });
      } catch (e) {
        const msg = String((e as Error).message);
        lastError = msg.slice(0, 400);
        if (isTruncation(msg)) {
          truncationsSeen++;
          finishReason = 'length';
          const at = truncatedAt(msg);
          lastError = `${input.label}: truncated (finish_reason=length${at ? `, ${at} chars` : ''}) on model ${input.model}`;
          break;   // leave the transport ladder; a retry at the same size gets the same length
        }
      }
    }

    // Only a truncation earns the second round. Anything else has already spent its ladder.
    if (truncationsSeen === 0) break;
    if (round === 1) break;
  }

  // A budget refusal is reported as ITSELF, never dressed up as a truncation: the two ask
  // different things of the next person. One says the prompt is too big for the ceiling; the other
  // says there was no room left in the box to try at all.
  if (budget.refusedForBudget) {
    return done({ text: '', finishReason, attempts, truncated: false, error: lastError });
  }
  if (truncationsSeen > 0) {
    return done({
      text: '', finishReason: 'length', attempts, truncated: true,
      error: `${lastError} — retried once asking for fewer items and it truncated again; the call's max_tokens or its output cap needs re-deriving`,
    });
  }
  return done({ text: '', finishReason, attempts, truncated: false, error: lastError });
}
