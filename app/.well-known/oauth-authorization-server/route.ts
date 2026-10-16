/** GET /.well-known/oauth-authorization-server — RFC 8414 (OAUTH-O1). Advertises endpoints that arrive in slice O2. 404 while SCRIBE_MCP_OAUTH is off. */
import { authorizationServerMetadata, metadataGet, metadataOptions } from "@/lib/mcp/oauth/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return metadataGet(authorizationServerMetadata);
}

export async function OPTIONS() {
  return metadataOptions();
}
