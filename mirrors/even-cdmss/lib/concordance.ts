// Concordance — non-core runner. Delegates all pure logic to concordance-core. P0
// single-shot: a CLEAN local call (no RAG, no retrieve, no critique/revise) — ₹0. This is
// deliberately NOT the ask-route pipeline, whose audit/revise pass hedges concordance
// verdicts.
//
// Stage 4 (fold into traces): every VERDICT run now creates a first-class trace
// ('concordance' feature — startTrace → tracedChat with the concordance-core/SYSTEM
// fingerprint → result event → guaranteed finalize), so concordance_runs is no longer a
// blind parallel store: the run record stays in concordance_runs for its own surface, and
// the reasoning/observability record lives in traces like every other feature. Interview
// helper calls (seed / next-question) route through the governed layer too.

import { TEXT_MODEL } from './llm';
import { startTrace, finishTrace, logEvent, governedChat, withTrace } from './trace';
import {
  buildConcordancePrompt, parseConcordance, type ParsedConcordance,
  buildSeedPrompt, parseSeed, buildNextQuestionPrompt, parseNextQuestion,
  initInterview, recordTurn, shouldStop, toVerdictContext,
  DEFAULT_INTERVIEW_OPTS,
  type BeliefItem, type InterviewState, type InterviewOpts, type NextQuestion,
} from './concordance-core';

export interface SingleShotResult {
  ok: boolean;
  model: string;
  ms: number;
  raw: string;
  parsed: ParsedConcordance;
  error?: string;
}

export async function runConcordanceSingleShot(result: string, context: string, model = TEXT_MODEL, traceId?: string): Promise<SingleShotResult> {
  const run = async (tid: string | undefined): Promise<SingleShotResult> => {
    const { system, user } = buildConcordancePrompt(result, context);
    const t0 = Date.now();
    const resp = await governedChat(tid, 'concordance_verdict', {
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }, { promptRef: 'concordance-core/SYSTEM' });
    const raw = resp.choices?.[0]?.message?.content ?? '';
    const out: SingleShotResult = {
      ok: true,
      model,
      ms: Date.now() - t0,
      raw,
      parsed: parseConcordance(raw),
    };
    if (tid) {
      await logEvent(tid, 'concordance_verdict_result', null, {
        ok: out.ok, ms: out.ms, verdict: (out.parsed as { verdict?: unknown })?.verdict ?? null,
      });
    }
    return out;
  };
  // Fold (Stage 4): a caller-supplied trace is reused; otherwise every verdict run gets its
  // own guaranteed-finalized trace. Same de-identified inputs the run store already keeps.
  if (traceId) return run(traceId);
  return withTrace('concordance', { model, resultChars: result.length, contextChars: context.length }, run);
}

// ── P1: adaptive interview (LLM wrappers + driver) ──

async function chat(system: string, user: string, model: string, traceId?: string, label = 'concordance_step'): Promise<string> {
  const resp = await governedChat(traceId, label, {
    model, temperature: 0.2,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  return resp.choices?.[0]?.message?.content ?? '';
}

/** Seed the cause-differential + prior belief from the result + minimal context. */
export async function seedBelief(result: string, context: string, model = TEXT_MODEL, traceId?: string): Promise<BeliefItem[]> {
  const { system, user } = buildSeedPrompt(result, context);
  return parseSeed(await chat(system, user, model, traceId, 'concordance_seed'));
}

/** Produce the single next discriminating question (or STOP) given the interview state. */
export async function askNextQuestion(state: InterviewState, model = TEXT_MODEL, traceId?: string): Promise<NextQuestion> {
  const { system, user } = buildNextQuestionPrompt(state);
  return parseNextQuestion(await chat(system, user, model, traceId, 'concordance_next_question'));
}

/** The clinician/report/lab answering a question. In the product this is the UI/user;
 *  in the P1 test harness it is a fixture-answerer. Returns "I don't have this" freely. */
export type Answerer = (q: NextQuestion) => Promise<string>;

export interface InterviewResult { state: InterviewState; verdict: SingleShotResult; }

/** Run the full adaptive interview, then hand the transcript to the P0 verdict engine. */
export async function runInterview(
  result: string, context: string, answerer: Answerer,
  opts: InterviewOpts = DEFAULT_INTERVIEW_OPTS, model = TEXT_MODEL,
): Promise<InterviewResult> {
  // Fold (Stage 4): one trace spans the whole interview — seed, every question, the verdict.
  const traceId = await startTrace('concordance', { model, mode: 'interview', resultChars: result.length });
  try {
    let state: InterviewState = { ...initInterview(result, context), belief: await seedBelief(result, context, model, traceId), status: 'asking' };
    while (state.askedCount < opts.cap) {
      const nq = await askNextQuestion(state, model, traceId);
      if (nq.stop) break;
      const answer = await answerer(nq);
      state = recordTurn(state, nq, answer);
      if (shouldStop(state, opts)) break;
    }
    state = { ...state, status: 'stopped' };
    const verdict = await runConcordanceSingleShot(result, toVerdictContext(state), model, traceId);
    await logEvent(traceId, 'concordance_interview_result', null, { asked: state.askedCount, ok: verdict.ok });
    await finishTrace(traceId, 'success');
    return { state, verdict };
  } catch (e) {
    await finishTrace(traceId, 'error', String((e as Error).message));
    throw e;
  }
}
