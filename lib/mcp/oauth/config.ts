/**
 * lib/mcp/oauth/config.ts — OAUTH-O1: the constants and the feature flag for MCP discovery (RFC 9728 / RFC 8414).
 *
 * This slice issues no tokens and admits nobody new. It publishes discovery documents and adds the 401 challenge header.
 * Every env here is read-only, read at call time, and holds no secret.
 */

/** The one canonical resource URL: exactly what a person types into Claude. */
export const MCP_RESOURCE_URL = "https://www.evenscribe.app/api/mcp";
/** The authorization server issuer (this app is its own AS from slice O2). */
export const MCP_OAUTH_ISSUER = "https://www.evenscribe.app";

export const MCP_RESOURCE_URL_ENV = "SCRIBE_MCP_RESOURCE_URL";
export const MCP_OAUTH_ISSUER_ENV = "SCRIBE_MCP_OAUTH_ISSUER";
export const MCP_OAUTH_FLAG_ENV = "SCRIBE_MCP_OAUTH";

export const PRM_PATH = "/.well-known/oauth-protected-resource/api/mcp";
export const MCP_SCOPES = ["read", "invoke", "write", "admin"] as const;

/**
 * An override must be an absolute https URL. Rejected (the default is used instead): raw text containing ? # @ whitespace, quotes or a backslash; a URL with a username or password;
 * any non-https scheme. The result is the lowercase origin plus the pathname with trailing slashes stripped, so it is always a clean base.
 */
function override(envName: string, fallback: string): string {
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;
  if (/[?#@\s"'`\\]/.test(raw)) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return fallback;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

export const mcpResourceUrl = (): string => override(MCP_RESOURCE_URL_ENV, MCP_RESOURCE_URL);
export const mcpIssuer = (): string => override(MCP_OAUTH_ISSUER_ENV, MCP_OAUTH_ISSUER);

let warnedUnknownFlag = false;
export function resetOauthFlagWarningForTests(): void {
  warnedUnknownFlag = false;
}

/** SCRIBE_MCP_OAUTH: "on" enables; unset, blank or "off" disables; any other value counts as off, with ONE count-only log line per process (never the value). */
export function oauthEnabled(): boolean {
  const raw = process.env[MCP_OAUTH_FLAG_ENV];
  const v = raw?.trim().toLowerCase();
  if (v === "on") return true;
  if (v === undefined || v === "" || v === "off") return false;
  if (!warnedUnknownFlag) {
    warnedUnknownFlag = true;
    console.warn(`mcp-oauth: ${MCP_OAUTH_FLAG_ENV} has an unrecognised value; treated as off (count=1)`);
  }
  return false;
}

/** The challenge header value for a 401 on the header doors. */
export function mcpChallengeHeader(): string {
  return `Bearer resource_metadata="${new URL(mcpResourceUrl()).origin}${PRM_PATH}"`;
}

// ─── O2: the authorization server ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The one Workspace domain that may sign in (V ruling, 16 Oct). */
export const MCP_OAUTH_DOMAIN = "even.in";
/** Test-only override of the domain. Honoured ONLY when NODE_ENV is "test"; in production it is ignored. */
export const MCP_OAUTH_DOMAIN_TEST_ENV = "SCRIBE_MCP_OAUTH_DOMAIN_TEST";
export const mcpOauthDomain = (): string => {
  const v = process.env[MCP_OAUTH_DOMAIN_TEST_ENV]?.trim().toLowerCase();
  return process.env.NODE_ENV === "test" && v ? v : MCP_OAUTH_DOMAIN;
};

/** Secret, read-only. Peppers every stored hash. Absent or short = every OAuth endpoint answers 503 server_error. */
export const MCP_OAUTH_PEPPER_ENV = "MCP_OAUTH_TOKEN_PEPPER";
/** Secrets, read-only. Needed by authorize and the Google callback only. */
export const GOOGLE_CLIENT_ID_ENV = "GOOGLE_OAUTH_CLIENT_ID";
export const GOOGLE_CLIENT_SECRET_ENV = "GOOGLE_OAUTH_CLIENT_SECRET";

export const ACCESS_TOKEN_TTL_S = 3600;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
export const CODE_TTL_S = 60;
export const CIMD_TTL_MS = 24 * 3600 * 1000;
export const CIMD_TIMEOUT_MS = 5000;
export const CIMD_MAX_BYTES = 64 * 1024;
export const PENDING_TTL_S = 600;

export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
export const PENDING_COOKIE = "mcp_oauth_pending";
export const PENDING_PURPOSE = "pending";
