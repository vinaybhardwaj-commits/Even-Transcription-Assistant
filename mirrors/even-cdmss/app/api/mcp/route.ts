export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * /api/mcp — the CDMSS "Lab" remote MCP server (Streamable-HTTP / JSON-RPC 2.0).
 *
 * MINI ONLY: no tool can reach Gemini, alter the engine/prompts, or write a production
 * table (corpus writes are inert `labq:` until activated). Dark until LAB_API_KEY is set.
 *
 * Auth (any one): header `x-api-key: <LAB_API_KEY>` · `Authorization: Bearer <LAB_API_KEY>`
 * · `?key=<LAB_API_KEY>` · OR use the path form /api/mcp/<LAB_API_KEY> (see [key]/route.ts) —
 * needed because Claude's custom-connector UI takes only a URL, not a header.
 */
import { NextRequest, NextResponse } from 'next/server';
import { MCP_SERVER_INFO, labKeyConfigured, labKeyMatches, dispatchMcp, type JsonRpc } from '@/lib/mcp-server';
import { LAB_TOOLS } from '@/lib/mcp-tools';

function presentedKey(req: NextRequest): string {
  const hdr = req.headers.get('x-api-key') || '';
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return hdr || bearer || req.nextUrl.searchParams.get('key') || '';
}

export async function GET(req: NextRequest) {
  if (!labKeyConfigured()) return NextResponse.json({ ok: false, error: 'LAB_API_KEY not set — MCP disabled' }, { status: 503 });
  return NextResponse.json({ ok: true, server: MCP_SERVER_INFO, transport: 'jsonrpc-http', authed: labKeyMatches(presentedKey(req)), tools: LAB_TOOLS.map((t) => t.name) });
}

export async function POST(req: NextRequest) {
  if (!labKeyConfigured()) return NextResponse.json({ error: 'LAB_API_KEY not set — MCP disabled' }, { status: 503 });
  if (!labKeyMatches(presentedKey(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: JsonRpc;
  try { body = (await req.json()) as JsonRpc; } catch { return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  const reply = await dispatchMcp(body);
  if (reply.body === null) return new NextResponse(null, { status: reply.status });
  return NextResponse.json(reply.body, { status: reply.status });
}
