/**
 * lib/mcp/oauth/metadata.ts — OAUTH-O1: the discovery documents and the shared route plumbing.
 * The endpoints named in the AS metadata do NOT exist yet (slice O2).
 */
import { NextResponse } from "next/server";
import { MCP_SCOPES, mcpIssuer, mcpResourceUrl, oauthEnabled } from "./config";

export function protectedResourceMetadata() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [mcpIssuer()],
    bearer_methods_supported: ["header"],
    scopes_supported: [...MCP_SCOPES],
  };
}

export function authorizationServerMetadata() {
  const iss = mcpIssuer();
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/api/oauth/authorize`,
    token_endpoint: `${iss}/api/oauth/token`,
    registration_endpoint: `${iss}/api/oauth/register`,
    revocation_endpoint: `${iss}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: [...MCP_SCOPES, "offline_access"],
    authorization_response_iss_parameter_supported: true,
  };
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-protocol-version",
};

const notFound = () => new NextResponse(null, { status: 404 });

/** GET: 404 when the flag is off, else the document with public caching and open CORS. */
export function metadataGet(body: () => unknown): NextResponse {
  if (!oauthEnabled()) return notFound();
  return NextResponse.json(body(), { status: 200, headers: { ...CORS, "cache-control": "public, max-age=300" } });
}

/** OPTIONS: 404 when the flag is off, else 204 with CORS allowing GET from any origin. */
export function metadataOptions(): NextResponse {
  if (!oauthEnabled()) return notFound();
  return new NextResponse(null, { status: 204, headers: { ...CORS, allow: "GET, OPTIONS" } });
}
