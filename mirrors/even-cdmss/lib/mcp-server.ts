/**
 * lib/mcp-server.ts — transport-agnostic core of the CDMSS Lab MCP (JSON-RPC 2.0).
 * Shared by the header-auth route (/api/mcp) and the URL-key route (/api/mcp/[key]),
 * because Claude's custom-connector UI can't attach a static header — the key must be
 * embeddable in the connector URL. Auth is a timing-safe compare either way.
 */
import { timingSafeEqual } from 'crypto';
import { LAB_TOOLS, callLabTool } from './mcp-tools';

export const MCP_SERVER_INFO = { name: 'cdmss-lab', version: '1.0.0' };
export const MCP_PROTOCOL_VERSION = '2024-11-05';

export function labKeyConfigured(): boolean { return !!process.env.LAB_API_KEY; }

/** True if `presented` matches LAB_API_KEY (timing-safe). */
export function labKeyMatches(presented: string | null | undefined): boolean {
  const key = process.env.LAB_API_KEY;
  if (!key || !presented) return false;
  const a = Buffer.from(presented); const b = Buffer.from(key);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export type JsonRpc = { jsonrpc: '2.0'; id?: unknown; method?: string; params?: unknown };
export type McpReply = { status: number; body: unknown | null };

const result = (id: unknown, r: unknown): McpReply => ({ status: 200, body: { jsonrpc: '2.0', id, result: r } });
const rpcErr = (id: unknown, code: number, message: string): McpReply => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

/** Dispatch one JSON-RPC message (auth already checked by the caller). */
export async function dispatchMcp(body: JsonRpc): Promise<McpReply> {
  const id = body.id ?? null;
  const method = String(body.method || '');
  const params = (body.params && typeof body.params === 'object') ? body.params as Record<string, unknown> : {};

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: MCP_SERVER_INFO,
        capabilities: { tools: {} },
        instructions: 'CDMSS Lab — free mini-pipeline experimentation. mini_analyze (audit a Metabase note or pasted text → lab store), backfill_control, corpus_add + corpus_manage (quarantined until activated), lab_query. Nothing here uses Gemini or changes CDMSS analysis.',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { status: 202, body: null };
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: LAB_TOOLS });
    case 'tools/call': {
      const toolName = String(params.name || '');
      const args = (params.arguments && typeof params.arguments === 'object') ? params.arguments as Record<string, unknown> : {};
      if (!LAB_TOOLS.some((t) => t.name === toolName)) return rpcErr(id, -32602, `unknown tool: ${toolName}`);
      return result(id, await callLabTool(toolName, args));
    }
    default:
      return rpcErr(id, -32601, `method not found: ${method}`);
  }
}
