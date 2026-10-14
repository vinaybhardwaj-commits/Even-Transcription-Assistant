/**
 * lib/mcp-v2/server.ts — the SDK server for one principal (LAB-MCP-V2-PRD-v1.0 §14.1).
 *
 * A FRESH SERVER PER REQUEST, built from the principal the key resolved to. The scope
 * filter is applied at construction, so a tool a principal cannot use is never registered
 * on the instance serving it — `tools/list` filtering is a property of the object rather
 * than a step someone could forget. `tools/call` is checked AGAIN inside
 * lib/lab-v2/service.ts, because visibility is usability and authorisation is the check.
 *
 * Annotations are generated from each tool's `effect` (§3.2.4). They describe; they do
 * not authorise. Input schemas go through the Zod-3 bridge — see schema-bridge.ts for why
 * that is required at zod 3.25.76 with SDK 2.0.0.
 */
import { McpServer, ResourceTemplate, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { LabError, type Principal } from '../lab-v2/contracts';
import { visibleTools } from '../lab-v2/registry';
import { annotationsFor } from '../lab-v2/registry';
import { callTool, type ServiceDeps } from '../lab-v2/service';
import { readArtifact } from '../lab-v2/worker';
import { scopesFor } from './auth';
import { sdkSchema } from './schema-bridge';
import type { Db } from '../lab-v2/db';

export const MCP_V2_SERVER_INFO = { name: 'cdmss-lab-v2', version: '2.0.0' } as const;

/** The SDK's own advertised revision, reported by system_capabilities. */
export const MCP_V2_PROTOCOL_VERSION: string = LATEST_PROTOCOL_VERSION;
export const MCP_V2_SDK_VERSION = '@modelcontextprotocol/server@2.0.0';

export interface BuildOptions { db: Db; principal: Principal }

/** A tool error crosses the wire as its CODE, so a client can branch on it (§13). */
function toolError(e: unknown) {
  const err = e as LabError;
  const code = err?.code ?? 'STORE_UNAVAILABLE';
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message: String(err?.message ?? e) }) }],
  };
}

export function buildServer({ db, principal }: BuildOptions): McpServer {
  const server = new McpServer(MCP_V2_SERVER_INFO);
  const scopes = scopesFor(principal);
  const deps: ServiceDeps = {
    db, principal,
    protocolVersion: MCP_V2_PROTOCOL_VERSION,
    sdkVersion: MCP_V2_SDK_VERSION,
  };

  for (const spec of visibleTools(scopes)) {
    server.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: sdkSchema(spec.inputSchema),
        annotations: annotationsFor(spec.effect),
      },
      async (args: unknown) => {
        try {
          const out = await callTool(deps, spec.name, args);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(out) }],
            structuredContent: out as Record<string, unknown>,
          };
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // §8 — large outputs are a summary plus an artifact resource. The body is de-identified
  // by construction (Slice A stores nothing else), and it is addressable only by the id
  // the owning run already returned.
  server.registerResource(
    'artifact',
    new ResourceTemplate('lab://artifacts/{id}', { list: undefined }),
    { description: 'A stored Lab v2 result body, addressed by object id.' },
    async (uri: URL, vars: Record<string, string | string[]>) => {
      const id = Array.isArray(vars.id) ? vars.id[0] : vars.id;
      const body = await readArtifact(db, String(id));
      if (body == null) throw new LabError('NOT_FOUND', `no artifact ${id}`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body) }] };
    },
  );

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The HTTP face, shared by /api/mcp/v2 and /api/mcp/v2/[key].
//
// It lives here rather than being written twice in the two route files because the two
// routes differ ONLY in where the key comes from. V1 duplicates its auth across its own
// pair of routes; that is survivable for one shared secret and a flat tool list, but v2's
// check decides which of four authorities a caller holds, and a fix applied to one copy
// and not the other would silently widen a scope on one URL. One implementation, two
// entry points.
// ─────────────────────────────────────────────────────────────────────────────────────
import { createMcpHandler } from '@modelcontextprotocol/server';
import { labV2Configured, postgres } from '../lab-v2/db';
import { labV2KeysConfigured, principalFor } from './auth';

/** 1 MiB. A JSON-RPC envelope for these fifteen tools is kilobytes; anything near this is abuse. */
const MAX_BODY_BYTES = 1024 * 1024;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Serve one MCP request.
 *
 * `presentedKey` is the Bearer header value for /api/mcp/v2, or the path segment for
 * /api/mcp/v2/[key]. A key in the QUERY STRING is not merely unsupported, it is a 400:
 * v1 accepted `?key=` and query strings land in access logs and browser history, so v2
 * refuses the whole shape rather than quietly ignoring the parameter (§3.1).
 */
export async function serveMcpRequest(request: Request, presentedKey: string | null): Promise<Response> {
  const url = new URL(request.url);
  if (url.search && url.search !== '?') {
    return json({ error: 'query string not accepted — present the key as a Bearer header or in the URL path' }, 400);
  }
  // Dark until V configures it (§3.1, §13). Both halves must be present: keys without a
  // store, or a store without keys, is a half-deployed endpoint and answers 503 either way.
  if (!labV2KeysConfigured() || !labV2Configured()) return json({ error: 'lab v2 not configured' }, 503);

  const principal = principalFor(presentedKey);
  if (!principal) return json({ error: 'unauthorized' }, 401);

  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return json({ error: 'request body too large' }, 413);
  let parsedBody: unknown;
  try { parsedBody = raw ? JSON.parse(raw) : undefined; }
  catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 200); }

  const db = await postgres();
  const handler = createMcpHandler(() => buildServer({ db, principal }));
  try {
    return await handler.fetch(
      new Request(url.toString(), { method: request.method, headers: request.headers, body: raw }),
      { parsedBody },
    );
  } finally {
    await handler.close().catch(() => { /* teardown must not mask the response */ });
  }
}

/** GET health for both routes: `{ok, configured, protocol_version}` (§14.1). */
export function mcpHealth(): Response {
  const configured = labV2KeysConfigured() && labV2Configured();
  return json(
    { ok: configured, configured, server: MCP_V2_SERVER_INFO, protocol_version: MCP_V2_PROTOCOL_VERSION },
    configured ? 200 : 503,
  );
}
