export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * /api/mcp/v2 — the CDMSS Lab MCP v2 endpoint (LAB-MCP-V2-PRD-v1.0 §14.1).
 *
 * Header-auth form: `Authorization: Bearer <one of the four keys in §3.1>`. The key a
 * caller holds is its authority (decision 5) — there is no role header. The path-key form
 * for Claude's connector UI lives in ./[key]/route.ts.
 *
 * DARK UNTIL CONFIGURED. With no v2 keys set, or no LAB_V2_DATABASE_URL, this returns 503
 * and touches nothing. It ships that way: §14.4 has V set the keys, and there is no cron
 * entry for the tick until §16 passes.
 *
 * V1 (/api/mcp) is untouched by this slice and shares no secret with it (§12).
 */
import { NextRequest } from 'next/server';
import { serveMcpRequest, mcpHealth } from '@/lib/mcp-v2/server';

function bearer(req: NextRequest): string | null {
  const auth = req.headers.get('authorization') || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
}

export async function GET() {
  return mcpHealth();
}

export async function POST(req: NextRequest) {
  return serveMcpRequest(req, bearer(req));
}
