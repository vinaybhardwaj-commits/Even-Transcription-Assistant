export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * /api/mcp/v2/<key> — the URL-embedded-key form of the v2 endpoint (§3.1, §14.1).
 *
 * It exists for the same reason v1's does: Claude's custom-connector UI accepts a URL and
 * nothing else, so a key that can only travel in a header cannot be configured there. The
 * key is the last path segment; everything after that is the shared handler, so the two
 * entry points cannot drift in what they authorise.
 */
import { NextRequest } from 'next/server';
import { serveMcpRequest, mcpHealth } from '@/lib/mcp-v2/server';

export async function GET() {
  return mcpHealth();
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  return serveMcpRequest(req, key);
}
