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

/** The one email domain that may sign in (V ruling, 16 Oct). */
export const MCP_OAUTH_DOMAIN = "even.in";
/** Test-only override of the domain. Honoured ONLY when NODE_ENV is "test"; in production it is ignored. */
export const MCP_OAUTH_DOMAIN_TEST_ENV = "SCRIBE_MCP_OAUTH_DOMAIN_TEST";
export const mcpOauthDomain = (): string => {
  const v = process.env[MCP_OAUTH_DOMAIN_TEST_ENV]?.trim().toLowerCase();
  return process.env.NODE_ENV === "test" && v ? v : MCP_OAUTH_DOMAIN;
};

/** Secret, read-only. Peppers every stored hash. Absent or short = every OAuth endpoint answers 503 server_error. */
export const MCP_OAUTH_PEPPER_ENV = "MCP_OAUTH_TOKEN_PEPPER";
/** Secrets, read-only (the same two the rest of EvenScribe already uses for Resend). Needed by authorize, email/start and email/verify only. */
export const RESEND_API_KEY_ENV = "RESEND_API_KEY";
export const RESEND_FROM_ENV = "RESEND_FROM_EMAIL";

export const ACCESS_TOKEN_TTL_S = 3600;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
export const CODE_TTL_S = 60;
export const CIMD_TTL_MS = 24 * 3600 * 1000;
export const CIMD_TIMEOUT_MS = 5000;
export const CIMD_MAX_BYTES = 64 * 1024;
export const PENDING_TTL_S = 600;
/** R2 F2: the consent step. After the email code, the pending cookie is re-signed under CONSENT_PURPOSE (a pre-code blob cannot pass the consent POST) and lives 5 min. */
export const CONSENT_PURPOSE = "consent";
export const CONSENT_TTL_S = 300;
/** R2 F3: a refresh family is refused this long after its FIRST token (mcp_oauth_token.created_at), however often it rotates. */
export const REFRESH_FAMILY_MAX_AGE_S = 30 * 24 * 3600;

export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
export const PENDING_COOKIE = "mcp_oauth_pending";
export const PENDING_PURPOSE = "pending";
/** The sign-in pages. The pending/consent cookie is path-scoped to this prefix, so it reaches email/start, email/verify and email/consent and nothing else. */
export const EMAIL_PATH = "/api/oauth/email";
/** Email-code sign-in (V ruling 18 Oct: no Google). A 6-digit code, 10 min, 5 wrong tries per pending flow, 3 codes per address and 10 starts per IP in 15 min. */
export const EMAIL_CODE_TTL_S = 600;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_RATE_WINDOW_S = 900;
export const EMAIL_RATE_PER_EMAIL = 3;
export const EMAIL_RATE_PER_IP = 10;

// ─── own login + per-user audit (Fable spec 18 Oct 2026) ─────────────────────────────────────────────────────────────────────────────────────────────

/** V's address. The ONLY recipient of an email sign-in code, of the daily digest and of the key/sign-in alerts; also "V" for the /admin/mcp-* views and the owner exemption of a signed-in person. */
export const MCP_OAUTH_APPROVER_ENV = "SCRIBE_MCP_OAUTH_APPROVER";
/** Comma list of token actors (the `actor` of a token-map entry, or operator-v1) that are V's own keys. Their calls write ONLY to mcp_owner_seclog. */
export const MCP_OWNER_ACTORS_ENV = "SCRIBE_MCP_OWNER_ACTORS";
/** SCRIBE_MCP_IDENTITY: "on" makes every key resolve to exactly one active email and every non-owner call write a fail-closed audit row. Off = the pre-18-Oct behaviour. */
export const MCP_IDENTITY_FLAG_ENV = "SCRIBE_MCP_IDENTITY";
/** 5 wrong tries lock the ADDRESS (not just the pending flow) for 15 minutes. */
export const EMAIL_LOCK_S = 900;
/** The owner security log keeps 30 days. */
export const SECLOG_RETENTION_DAYS = 30;

const EMAIL_SHAPE = /^[^\s@,;<>"]{1,64}@[^\s@,;<>"]{1,190}$/;

/** The approver address, lowercased, or null when unset or not an address. */
export function approverEmail(): string | null {
  const v = process.env[MCP_OAUTH_APPROVER_ENV]?.trim().toLowerCase();
  return v && EMAIL_SHAPE.test(v) ? v : null;
}

export function ownerActors(): ReadonlySet<string> {
  return new Set((process.env[MCP_OWNER_ACTORS_ENV] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

export function identityEnforced(): boolean {
  return process.env[MCP_IDENTITY_FLAG_ENV]?.trim().toLowerCase() === "on";
}

/**
 * SCRIBE_MCP_CODE_ROUTE (spec addendum 1): "approver" (default; any other value, blank or unset) = V receives every sign-in code.
 * "self_after_approval" = V approves an address ONCE in /admin/mcp-keys; later codes go to that person's own address. V still gets the sign-in alert either way.
 */
export const MCP_CODE_ROUTE_ENV = "SCRIBE_MCP_CODE_ROUTE";
export const codeRoute = (): "approver" | "self_after_approval" => (process.env[MCP_CODE_ROUTE_ENV]?.trim().toLowerCase() === "self_after_approval" ? "self_after_approval" : "approver");
/** A sign-in session lasts 30 days from the code sign-in and is NEVER extended (no sliding): the same cap as a refresh family. */
export const SESSION_MAX_AGE_S = REFRESH_FAMILY_MAX_AGE_S;
