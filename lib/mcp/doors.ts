/**
 * lib/mcp/doors.ts — S3: the pieces the four MCP routes share (header /api/mcp, path-key
 * /api/mcp/<key>, and their /lab twins), so the twins cannot drift from the originals.
 *
 * ⚠️ The path-key routes' URLs contain a secret. Nothing here logs a path, URL or key.
 */
import { NextResponse } from "next/server";
import { checkMcpBearer } from "@/lib/mcp/auth";

export const ALLOW = "POST, OPTIONS";

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, x-scribe-profile",
};

/** The existing auth, fed the path key as a synthetic Bearer header — one comparison, one
 *  401/503 mapping, zero new token handling. An empty/missing key fails the Bearer shape.
 *  A key with header-illegal bytes cannot be a real token: the Request constructor throws,
 *  and the check re-runs with no header at all, which yields the same 503 (env unset) or
 *  401 (env set) mapping from the same code — never a 500, never a pass. */
export function checkPathKey(key: string) {
  try {
    return checkMcpBearer(new Request("https://mcp.internal/", { headers: { authorization: `Bearer ${key}` } }));
  } catch {
    return checkMcpBearer(new Request("https://mcp.internal/"));
  }
}

export function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}

/** S3.4 — explicit OPTIONS: 204, Allow: POST, OPTIONS. The path-key doors add their CORS headers. */
export function optionsResponse(cors: boolean): NextResponse {
  return new NextResponse(null, { status: 204, headers: { ...(cors ? CORS : {}), allow: ALLOW } });
}
