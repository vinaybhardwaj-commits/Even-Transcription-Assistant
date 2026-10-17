/**
 * lib/mcp/oauth/redirects.ts — O2: which redirect URIs a client may register or use, and how a presented one is matched.
 *
 * Allowed shapes, for CIMD and DCR clients alike (a self-hosted client document must not be able to name any other destination, because there is no consent screen):
 *   - exactly https://claude.ai/api/mcp/auth_callback
 *   - a loopback callback: http://localhost | http://127.0.0.1 | http://[::1], any port, path exactly /callback, no query or fragment
 * Matching: exact string, except that for a loopback entry the port is ignored (RFC 8252 §7.3).
 */
import { CLAUDE_CALLBACK } from "./config";

type Loop = { host: string };

function loopback(uri: string): Loop | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || u.username || u.password || u.search || u.hash || u.pathname !== "/callback") return null;
  if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1" && u.hostname !== "[::1]") return null;
  return { host: u.hostname };
}

export function isAllowedRedirect(uri: string): boolean {
  return uri === CLAUDE_CALLBACK || loopback(uri) !== null;
}

/**
 * localhost, 127.0.0.1 and [::1] are ONE loopback class (O2-FIX1 SHOULD-2): Next rewrites a 127.0.0.1 inside a query value to localhost before the route sees it, so the stored URI and the
 * one the client later presents at the token endpoint can differ only by that host. A presented loopback URI matches ANY registered loopback entry; port ignored, path exactly /callback, scheme http.
 */
export function redirectMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented) && isAllowedRedirect(presented)) return true;
  if (!loopback(presented)) return false;
  return registered.some((r) => loopback(r) !== null);
}

/** Token-endpoint comparison of the redirect_uri stored with the code and the one presented: exact, or both in the loopback class. */
export function redirectsEquivalent(stored: string, presented: string): boolean {
  if (stored === presented) return true;
  return loopback(stored) !== null && loopback(presented) !== null;
}
