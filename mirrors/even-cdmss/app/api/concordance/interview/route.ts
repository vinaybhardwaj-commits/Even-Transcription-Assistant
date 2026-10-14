import { NextRequest, NextResponse } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { seedBelief, askNextQuestion, runConcordanceSingleShot } from '@/lib/concordance';
import {
  initInterview, recordTurn, shouldStop, toVerdictContext, buildRunRecord,
  type InterviewState, type NextQuestion,
} from '@/lib/concordance-core';
import { insertConcordanceRun } from '@/lib/concordance-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

// Turn-by-turn adaptive interview. STATELESS: the client holds InterviewState and echoes
// it (+ the pending question) each turn. Care-or-admin gated, dark behind CONCORDANCE_ENABLED.
// On completion the walled de-identified run is stored; there is NO read path here (the wall).
async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

async function finish(state: InterviewState, result: string, context: string) {
  const stopped: InterviewState = { ...state, status: 'stopped' };
  const verdict = await runConcordanceSingleShot(result, toVerdictContext(stopped));
  try {
    await insertConcordanceRun(buildRunRecord(result, context, verdict.parsed, 'interview', stopped));
  } catch (e) {
    console.warn('[concordance] walled run insert failed:', String((e as Error).message).slice(0, 160));
  }
  return NextResponse.json({ ok: true, done: true, state: stopped, verdict });
}

export async function POST(req: NextRequest) {
  if (process.env.CONCORDANCE_ENABLED !== '1') return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: { result?: string; context?: string; state?: InterviewState; question?: NextQuestion; answer?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  try {
    // CONTINUE — an answered turn comes back with the prior state + the question it answered.
    if (body.state && body.question && typeof body.answer === 'string') {
      const result = body.state.result;
      const context = body.state.context0;
      let state = recordTurn(body.state, body.question, body.answer);
      if (shouldStop(state)) return await finish(state, result, context);
      const nq = await askNextQuestion(state);
      if (nq.stop) return await finish(state, result, context);
      return NextResponse.json({ ok: true, done: false, state, question: nq });
    }

    // START — first turn from a fresh result + context.
    const result = (body.result ?? '').trim();
    const context = (body.context ?? '').trim();
    if (!result) return NextResponse.json({ ok: false, error: 'body must include { result, context } to start, or { state, question, answer } to continue' }, { status: 400 });
    const belief = await seedBelief(result, context);
    const state: InterviewState = { ...initInterview(result, context), belief, status: 'asking' };
    const nq = await askNextQuestion(state);
    if (nq.stop) return await finish(state, result, context);
    return NextResponse.json({ ok: true, done: false, state, question: nq });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
