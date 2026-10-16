/**
 * lib/mcp/oauth/clients.ts — O2 (+FIX1 SSRF): resolve a client_id to its allowed redirect URIs.
 *   - an https URL is a Client ID Metadata Document: resolved and checked, then fetched pinned (5 s, 64 KB, no redirects), client_id inside must equal the URL, cached in mcp_oauth_client for 24 h
 *   - anything else is a DCR id we issued (looked up in the table)
 * Redirect URIs in a document are filtered through the same allowlist as DCR (lib/mcp/oauth/redirects): a self-hosted document cannot name any other destination.
 */
import { CIMD_MAX_BYTES, CIMD_TIMEOUT_MS, CIMD_TTL_MS } from "./config";
import { isAllowedRedirect } from "./redirects";
import { fetchPinned, resolvePublic } from "./ssrf";
import { getClient, upsertClient, touchClient } from "./store";

export type ResolvedClient = { client_id: string; redirect_uris: string[] };
export type ClientResult = { ok: true; client: ResolvedClient } | { ok: false; reason: string };

/** An https URL with a path, no credentials, a DNS name (no IP literal, no localhost, no single-label host). Names that RESOLVE to a forbidden address are refused by resolvePublic before the fetch. */
export function cimdUrlOk(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || u.port || raw.length > 512) return null;
  if (u.pathname === "" || u.pathname === "/") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return null;
  if (!h.includes(".") || h.startsWith("[") || /^[0-9.]+$/.test(h)) return null;
  return u;
}

async function readCapped(res: Response): Promise<string | null> {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > CIMD_MAX_BYTES) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CIMD_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchCimd(url: URL): Promise<{ redirect_uris: string[]; client_name: string | null } | null> {
  try {
    // SSRF: resolve first, refuse a host with ANY forbidden address, then connect pinned to the checked address (lib/mcp/oauth/ssrf)
    const addrs = await resolvePublic(url.hostname);
    if (!addrs) return null;
    const res = await fetchPinned(url, addrs[0]!, AbortSignal.timeout(CIMD_TIMEOUT_MS));
    if (!res.ok) return null;
    const text = await readCapped(res);
    if (text === null) return null;
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
    if (doc.client_id !== url.toString()) return null;
    if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") return null;
    if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0 || doc.redirect_uris.length > 10) return null;
    const uris = doc.redirect_uris.filter((r): r is string => typeof r === "string" && isAllowedRedirect(r));
    if (uris.length !== doc.redirect_uris.length) return null;
    const name = typeof doc.client_name === "string" ? doc.client_name.replace(/[^\w .\-]/g, "").slice(0, 100) : null;
    return { redirect_uris: uris, client_name: name };
  } catch {
    return null;
  }
}

export async function resolveClient(clientId: string): Promise<ClientResult> {
  if (!clientId || clientId.length > 512) return { ok: false, reason: "invalid_client" };
  const cached = await getClient(clientId);
  if (clientId.startsWith("https://")) {
    const url = cimdUrlOk(clientId);
    if (!url) return { ok: false, reason: "invalid_client" };
    if (cached && cached.kind === "cimd" && Date.now() - new Date(cached.created_at).getTime() < CIMD_TTL_MS) {
      await touchClient(clientId).catch(() => {});
      return { ok: true, client: { client_id: clientId, redirect_uris: cached.redirect_uris } };
    }
    const doc = await fetchCimd(url);
    if (!doc) return { ok: false, reason: "invalid_client_metadata" };
    await upsertClient({ client_id: clientId, kind: "cimd", redirect_uris: doc.redirect_uris, metadata_url: clientId, client_name: doc.client_name });
    await touchClient(clientId).catch(() => {});
    return { ok: true, client: { client_id: clientId, redirect_uris: doc.redirect_uris } };
  }
  if (cached && cached.kind === "dcr") {
    await touchClient(clientId).catch(() => {});
    return { ok: true, client: { client_id: clientId, redirect_uris: cached.redirect_uris } };
  }
  return { ok: false, reason: "invalid_client" };
}
