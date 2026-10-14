import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req); if (denied) return denied;
  const base = process.env.OLLAMA_BASE_URL || '';
  if (!base) return NextResponse.json({ error: 'OLLAMA_BASE_URL not set' }, { status: 500 });

  const out: Record<string, unknown> = {};
  try {
    const [psR, verR] = await Promise.all([
      fetch(`${base}/api/ps`, { cache: 'no-store' }),
      fetch(`${base}/api/version`, { cache: 'no-store' }),
    ]);
    out.ps = psR.ok ? await psR.json() : { error: `HTTP ${psR.status}` };
    out.version = verR.ok ? await verR.json() : { error: `HTTP ${verR.status}` };
  } catch (e) {
    out.error = String((e as Error).message);
  }
  return NextResponse.json(out);
}
