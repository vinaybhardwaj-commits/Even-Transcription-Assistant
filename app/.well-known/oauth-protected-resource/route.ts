/** GET /.well-known/oauth-protected-resource — RFC 9728 root form (OAUTH-O1). Same body as the /api/mcp form. 404 while SCRIBE_MCP_OAUTH is off. */
import { metadataGet, metadataOptions, protectedResourceMetadata } from "@/lib/mcp/oauth/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return metadataGet(protectedResourceMetadata);
}

export async function OPTIONS() {
  return metadataOptions();
}
