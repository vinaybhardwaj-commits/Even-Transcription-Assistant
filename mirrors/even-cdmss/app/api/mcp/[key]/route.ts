export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * /api/mcp/<LAB_API_KEY> — the URL-embedded-key form of the Lab MCP, for Claude's
 * custom-connector UI (which accepts only a URL, no header field). The key is the last
 * path segment; everything else delegates to the shared JSON-RPC core. Same guarantees
 * as /api/mcp (mini-only, no prod writes, corpus quarantine, dark until LAB_API_KEY set).
 */
import { NextRequest, NextResponse } from 'next/server';
import { MCP_SERVER_INFO, labKeyConfigured, labKeyMatches, dispatchMcp, type JsonRpc } from '@/lib/mcp-server';
import { telemetryContextFor } from '@/lib/retrieval-telemetry-core';
import { LAB_TOOLS } from '@/lib/mcp-tools';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  if (!labKeyConfigured()) return NextResponse.json({ ok: false, error: 'LAB_API_KEY not set — MCP disabled' }, { status: 503 });
  const { key } = await ctx.params;
  if (!labKeyMatches(key)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ ok: true, server: MCP_SERVER_INFO, transport: 'jsonrpc-http', authed: true, tools: LAB_TOOLS.map((t) => t.name) });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  if (!labKeyConfigured()) return NextResponse.json({ error: 'LAB_API_KEY not set — MCP disabled' }, { status: 503 });
  const { key } = await ctx.params;
  if (!labKeyMatches(key)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: JsonRpc;
  try { body = (await req.json()) as JsonRpc; } catch { return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  // One invocation per MCP request, made HERE — the boundary — and carried down (D11).
  const reply = await dispatchMcp(body, telemetryContextFor('mcp_tools', req.headers));
  if (reply.body === null) return new NextResponse(null, { status: reply.status });
  return NextResponse.json(reply.body, { status: reply.status });
}
