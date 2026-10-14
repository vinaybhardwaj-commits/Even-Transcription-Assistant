import { NextRequest, NextResponse } from 'next/server';
import { governedChat } from '@/lib/trace';
import { TOOLTIP_FALLBACKS } from '@/lib/calculators/static-fallbacks';
import type { CalculatorName } from '@/lib/calculators/types';

export const runtime = 'nodejs';
export const maxDuration = 15;

// Per PRD §5.3 + §3.14. On-demand llama 8b generation of a clinical tooltip.
// Client caches indefinitely under `tooltip:{calc}:{field}` (no SHA in key).
// Invalidation via /api/health's tooltip_cache_version sentinel.
// Static fallback on bridge error.
export async function GET(req: NextRequest) {
  const calc = req.nextUrl.searchParams.get('calc') as CalculatorName | null;
  const field = req.nextUrl.searchParams.get('field');

  if (!calc || !field) {
    return NextResponse.json({ error: 'calc and field required' }, { status: 400 });
  }

  const fallback = TOOLTIP_FALLBACKS[calc]?.[field];
  if (!fallback) {
    return NextResponse.json({ error: `unknown calc/field: ${calc}/${field}` }, { status: 404 });
  }

  // Try llama 8b for a fresh, contextual tooltip.
  try {
    const sys = `Explain this clinical input field to a junior doctor (RMO / registrar) in 2-3 sentences. Mention the unit, the typical normal range, and one practical pitfall. No drug doses, no fluid rates. No first person. Terse, peer-to-peer tone.`;
    const user = `Calculator: ${calc}\nField: ${field}\nStatic fallback for reference: "${fallback}"\n\nWrite a tighter, more clinically useful tooltip. Keep it 2-3 sentences.`;

    const resp = await Promise.race([
      // Governed envelope (Stage 4): traceless + no gemini → byte-identical local call.
      governedChat(undefined, 'calc_tooltip', {
        model: 'llama3.1:8b',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 150,
        options: { num_ctx: 2048 },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('tooltip timeout')), 8000)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ]) as any;

    const text = resp?.choices?.[0]?.message?.content?.trim();
    if (text && text.length > 20) {
      return NextResponse.json({ text, source: 'llm' });
    }
  } catch {
    // fall through to static
  }

  return NextResponse.json({ text: fallback, source: 'fallback' });
}
