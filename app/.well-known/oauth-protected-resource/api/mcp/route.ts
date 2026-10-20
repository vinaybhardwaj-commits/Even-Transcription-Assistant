/** GET /.well-known/oauth-protected-resource/api/mcp — RFC 9728 path form (OAUTH-O1). Same body as the root form. 404 while SCRIBE_MCP_OAUTH is off. */
import { metadataGet, metadataOptions, protectedResourceMetadata } from "@/lib/mcp/oauth/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return metadataGet(protectedResourceMetadata);
}

export async function OPTIONS() {
  return metadataOptions();
}
