import { NextRequest, NextResponse } from 'next/server';
import { retrieve } from '@/lib/retrieve';
import { startTrace, logEvent, finishTrace, tracedChat } from '@/lib/trace';
import { sql } from '@/lib/db';
import { applySafetyRedaction } from '@/lib/calculators/safety-regex';
import { SYNTHESIS_FALLBACKS } from '@/lib/calculators/static-fallbacks';

export const runtime = 'nodejs';
export const maxDuration = 60;
const MODEL = 'qwen2.5:14b';

const NEGATIVE_INSTRUCTIONS = `
NEGATIVE INSTRUCTIONS (do not violate):
- Never recommend specific drug doses (mg, mcg, units, g per dose).
- Never recommend specific fluid volumes (mL, L) or rates (mL/hr, cc/hr, drops/min).
- You MAY name a fluid TYPE when indicated (e.g. "isotonic crystalloid").
- Never invent a clinical entity not supported by the inputs provided.
- Never recommend specific antibiotic regimens or specific antimicrobial agents.
- Never use first-person ("I think", "in my opinion").
`.trim();

// PRD Appendix A.3 system envelope.
const SIDEBAR_SYSTEM = `You are Even-CDMSS, providing an educational sidebar on the Surviving Sepsis
Campaign 1-hour bundle to a junior doctor who clicked "Teach me the evidence"
while managing a patient mid-bundle. The doctor's CURRENT bundle state is
provided. Tailor the sidebar's emphasis lightly to what they're missing.

Output is plain markdown (NOT NDJSON). Four paragraphs in this order:
1. The mortality data behind the 1-hour window (Seymour NEJM 2017, Liu CHEST 2017).
2. Why blood cultures must be drawn BEFORE first antibiotic dose (sterilization rate).
3. Why crystalloid resuscitation matters and the 30 mL/kg figure nuance (phenotype-tailoring).
4. What NOT to do (over-resuscitation, delaying vasopressors, abx-before-cultures shortcut).

Length budget per paragraph: 200-300 tokens (total 800-1200).

Cite retrieved chunks with [N] markers. Never name a specific antibiotic class
or agent. Never name a specific fluid volume or rate (volume nuance in paragraph
3 should reference "the 30 mL/kg figure" without recommending it as a dose).

${NEGATIVE_INSTRUCTIONS}`;

type Body = {
  user_id?: number;     // defaults to 1 (single-user app for now)
  bundle_state?: {
    elapsed_min?: number;
    compliance_pct?: number;
    missing?: string[];
  };
  parent_trace_id?: string;
  force_refresh?: boolean;
};

export async function GET(req: NextRequest) {
  const userId = Number(req.nextUrl.searchParams.get('user_id') || '1');
  const force = req.nextUrl.searchParams.get('force') === '1';

  // Cache lookup (7-day TTL, per locked decision #13)
  if (!force) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<{ content: string; generated_at: string; trace_id: string | null }[]>;
      const rows = await sqlFn(
        `SELECT content, generated_at, trace_id FROM sidebar_cache
         WHERE user_id = $1 AND calculator = 'sepsis_bundle' AND expires_at > NOW()
         LIMIT 1`,
        [userId],
      );
      if (rows && rows.length > 0) {
        return NextResponse.json({
          cached: true,
          content: rows[0].content,
          generated_at: rows[0].generated_at,
          trace_id: rows[0].trace_id,
        });
      }
    } catch {}
  }

  // Cache miss → generate
  return NextResponse.json({ cached: false, hint: 'POST to /api/calculators/sepsis-bundle/sidebar with bundle_state to generate' });
}

export async function POST(req: NextRequest) {
  let body: Body;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }
  const userId = body.user_id ?? 1;

  // If a fresh-enough cached entry exists and not forced, return it
  if (!body.force_refresh) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<{ content: string; generated_at: string; trace_id: string | null }[]>;
      const rows = await sqlFn(
        `SELECT content, generated_at, trace_id FROM sidebar_cache
         WHERE user_id = $1 AND calculator = 'sepsis_bundle' AND expires_at > NOW()
         LIMIT 1`,
        [userId],
      );
      if (rows && rows.length > 0) {
        return NextResponse.json({
          cached: true,
          content: rows[0].content,
          generated_at: rows[0].generated_at,
          trace_id: rows[0].trace_id,
        });
      }
    } catch {}
  }

  // Generate fresh
  const traceId = await startTrace('calc_sidebar', { calculator: 'sepsis_bundle', bundle_state: body.bundle_state ?? null }, userId, {
    calculator: 'sepsis_bundle',
    served_from_cache: false,
    bundle_compliance_pct_at_open: body.bundle_state?.compliance_pct ?? null,
    bundle_elapsed_at_open: body.bundle_state?.elapsed_min ?? null,
  });

  if (body.parent_trace_id) {
    try {
      const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
      await sqlFn(`UPDATE traces SET parent_trace_id = $1 WHERE trace_id = $2`,
        [body.parent_trace_id, traceId]);
    } catch {}
  }

  let outcome: 'success' | 'error' | 'partial' = 'success';
  let outcomeMsg: string | undefined;
  let content = '';

  try {
    const fullQuery = `surviving sepsis campaign one hour bundle mortality evidence`;
    const bm25Query = 'sepsis bundle one hour mortality';
    const result = await retrieve(fullQuery, { topK: 12, bm25Query });
    const hits = result.hits;
    await logEvent(traceId, 'retrieve', 'rag', {
      full_query: fullQuery, bm25_query: bm25Query, n_hits: hits.length, meta: result.meta,
    });

    if (hits.length === 0) {
      content = SYNTHESIS_FALLBACKS.sepsis_bundle.sidebar;
      outcome = 'partial';
      outcomeMsg = 'empty retrieval';
    } else {
      const grounding = hits.map((h) => `[${h.id}] ${h.book}${h.chapter ? ' · ' + h.chapter : ''}\n${h.text.slice(0, 600)}`).join('\n\n');
      const state = body.bundle_state ?? {};
      const stateBlock = `BUNDLE STATE:\n  elapsed: ${state.elapsed_min ?? '?'} min\n  compliance: ${state.compliance_pct ?? '?'}%\n  missing: ${(state.missing ?? []).join(', ') || 'none'}\n`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await tracedChat(traceId, 'sidebar', {
        model: MODEL,
        messages: [
          { role: 'system', content: SIDEBAR_SYSTEM },
          { role: 'user', content: `${stateBlock}\nGROUNDING (cite by [chunk_id], use only these):\n${grounding}\n\nNow write the 4-paragraph educational sidebar.` },
        ],
        temperature: 0.3,
        max_tokens: 1500,
        ...({ options: { num_ctx: 16384 }, keep_alive: '15m' } as Record<string, unknown>),
      });
      content = r?.choices?.[0]?.message?.content?.trim() ?? '';

      // Safety regex (PRD §5.4)
      if (content) {
        const { redacted, matches } = applySafetyRedaction(content);
        if (matches.length > 0) {
          await logEvent(traceId, 'safety_redact', 'sidebar', { matches });
          content = redacted;
        }
      }

      if (!content) {
        content = SYNTHESIS_FALLBACKS.sepsis_bundle.sidebar;
        outcome = 'partial';
        outcomeMsg = 'empty llm response';
      }
    }

    // Persist to cache (7-day TTL per locked decision #13)
    if (outcome === 'success') {
      try {
        const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;
        await sqlFn(
          `INSERT INTO sidebar_cache (user_id, calculator, content, trace_id, expires_at)
           VALUES ($1, 'sepsis_bundle', $2, $3, NOW() + INTERVAL '7 days')
           ON CONFLICT (user_id, calculator) DO UPDATE
             SET content = EXCLUDED.content,
                 trace_id = EXCLUDED.trace_id,
                 generated_at = NOW(),
                 expires_at = NOW() + INTERVAL '7 days'`,
          [userId, content, traceId],
        );
      } catch {}
    }
  } catch (e) {
    outcome = 'error';
    outcomeMsg = String((e as Error).message);
    content = SYNTHESIS_FALLBACKS.sepsis_bundle.sidebar;
  } finally {
    await finishTrace(traceId, outcome, outcomeMsg);
  }

  return NextResponse.json({
    cached: false,
    content,
    generated_at: new Date().toISOString(),
    trace_id: traceId,
  });
}
