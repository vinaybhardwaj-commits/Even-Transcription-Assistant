import { NextRequest, NextResponse } from 'next/server';
import { traceSkeleton } from '@/lib/pathway';
import { rightCareStateEnabled, rightCareGroundingEnabled, buildRightCareState, rightCareExtractInput, patientPictureBlock } from '@/lib/right-care-state';
import { clinicalStateResultField } from '@/lib/clinical-state/ui-view';
import { stateCounts } from '@/lib/clinical-state/schema';
import { logEvent, tracedChat } from '@/lib/trace';
import { geminiUtilityModel, TEXT_MODEL } from '@/lib/llm';
import type { ChatFn } from '@/lib/clinical-state/extract';

export const runtime = 'nodejs';
export const maxDuration = 800;

// POST /api/pathway/skeleton — fast Flash pass: classify stage + ordered care-path spine.
// Body: { scenario, proposedActions?: string[], patient?: { age?, sex? } }
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const scenario = typeof body.scenario === 'string' ? body.scenario.trim() : '';
  if (scenario.length < 3) {
    return NextResponse.json({ ok: false, error: 'scenario is required' }, { status: 400 });
  }

  const proposedActions = Array.isArray(body.proposedActions)
    ? (body.proposedActions as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
    : undefined;

  const patientIn = (body.patient ?? {}) as { age?: unknown; sex?: unknown };
  const age = Number(patientIn.age);
  const patient = {
    age: Number.isFinite(age) && age > 0 && age < 130 ? Math.round(age) : undefined,
    sex: typeof patientIn.sex === 'string' && patientIn.sex.trim() ? patientIn.sex.trim() : undefined,
  };
  const hasPatient = patient.age != null || patient.sex != null;

  try {
    // Slice 2 (RIGHT_CARE_CLINICAL_STATE_GROUND, requires the master flag): build the state
    // BEFORE the skeleton pass and thread the PATIENT PICTURE into BOTH pathway prompts
    // (skeleton here; the enrich route rebuilds identically for its pass). Deterministic
    // stage only (no trace exists yet). Flag off (the shipped default) → inert: build order
    // and every prompt are exactly Slice 1. Fail-open: build failure → ungrounded skeleton.
    let built: Awaited<ReturnType<typeof buildRightCareState>> = null;
    if (rightCareGroundingEnabled()) {
      built = await buildRightCareState(
        rightCareExtractInput('pathway', { scenario, age: patient.age, sex: patient.sex }));
    }

    const { skeleton, traceId } = await traceSkeleton({
      scenario,
      proposedActions: proposedActions && proposedActions.length ? proposedActions : undefined,
      patient: hasPatient ? patient : undefined,
      ...(built ? { clinicalStateText: patientPictureBlock(built.state) } : {}),
      forceOllama: body.providerOverride === 'ollama',   // lab probe: free mini
    });

    // Right Care × ClinicalState Slice 1 (mirrors DDx Phase-1a): construct the state from the
    // provided presentation at the point the SKELETON input is assembled. Feeds nothing (the
    // skeleton above ran on the raw input, unless Slice-2 grounding pre-built it), blocks
    // nothing (fail-open); flags off → this block is inert and the response is byte-identical.
    // Traced on the mode's existing pathway trace.
    if (rightCareStateEnabled()) {
      try {
        const grounded = !!built;   // Slice 2 pre-built it before the skeleton pass
        if (!built) {
          const chat: ChatFn | undefined = traceId
            ? async (system, user) => {
                const r = await tracedChat(traceId!, 'clinical_state_normalise', {
                  model: TEXT_MODEL,
                  messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                  temperature: 0.1,
                  max_tokens: 900,
                  ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
                }, { gemini: geminiUtilityModel(), promptRef: 'extract/NORMALISE_SYSTEM' });
                return r.choices?.[0]?.message?.content ?? '';
              }
            : undefined;
          built = await buildRightCareState(
            rightCareExtractInput('pathway', { scenario, age: patient.age, sex: patient.sex }), chat);
        }
        if (built && traceId) {
          await logEvent(traceId, 'clinical_state_extracted', null, {
            ok: true, grounded, counts: stateCounts(built.state), unstable: built.state.instability.unstable, state: built.state,
          }).catch(() => {});
        }
      } catch { built = null; }
    }

    return NextResponse.json({
      ok: true, skeleton, traceId,
      ...clinicalStateResultField(built?.state, built?.rejectedSpans ?? 0, process.env.CLINICAL_STATE_UI === '1'),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
