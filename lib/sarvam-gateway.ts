/**
 * lib/sarvam-gateway.ts — S8A (8 Oct 2026): Sarvam through the Even AWS API gateway. node:crypto + fetch only, NO new npm dependency
 * (the same discipline as lib/gcp-auth.ts).
 *
 * THE CHAIN (proven by backfill-lead; minting an ID token straight from the key FAILS because the audience is numeric):
 *   1. SARVAM_GCP_SA_KEY_JSON (service-account key) -> Google OAuth ACCESS token (JWT bearer, scope cloud-platform)
 *   2. IAM Credentials generateIdToken ON THE SA ITSELF (audience = SARVAM_GW_AUDIENCE, includeEmail true) -> Google ID token
 *   3. STS AssumeRoleWithWebIdentity (unsigned, regional endpoint for SARVAM_GW_REGION, RoleArn = SARVAM_GW_ROLE_ARN, 1 h) -> AWS creds
 *   4. SigV4 (service execute-api, region SARVAM_GW_REGION) to SARVAM_GW_BASE_URL + route.
 * The gateway injects Sarvam's own key: NO `api-subscription-key` is ever sent on this path (gatewayFetch strips one if a caller passes it).
 *
 * ENV (names only; values are sensitive and are never read anywhere else): SARVAM_GCP_SA_KEY_JSON, SARVAM_GW_AUDIENCE, SARVAM_GW_ROLE_ARN,
 * SARVAM_GW_BASE_URL, SARVAM_GW_REGION.
 *
 * NEVER LOGGED OR RETURNED: the key, the access / ID tokens, the AWS credentials, the signature. Error messages carry HTTP status codes and
 * Google / AWS error codes ONLY (`gatewayError`), never a response body.
 *
 * Only the AWS credentials are cached (module scope, until 5 minutes before they expire); the Google tokens are used once per mint.
 */
import { createHash, createHmac, createSign } from "node:crypto";

export const GATEWAY_ENV = ["SARVAM_GCP_SA_KEY_JSON", "SARVAM_GW_AUDIENCE", "SARVAM_GW_ROLE_ARN", "SARVAM_GW_BASE_URL", "SARVAM_GW_REGION"] as const;
export type GatewayEnvName = (typeof GATEWAY_ENV)[number];

export type GatewayErrorCode =
  | "sarvam_gateway_not_configured"
  | "sarvam_gateway_key_invalid"
  | "sarvam_gateway_google_token"
  | "sarvam_gateway_id_token"
  | "sarvam_gateway_sts"
  | "sarvam_gateway_http"
  | "sarvam_gateway_network";

/** Typed, secret-free. `detail` is a status code or a vendor error CODE, never a body or a token. */
export class SarvamGatewayError extends Error {
  constructor(public code: GatewayErrorCode, public detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SarvamGatewayError";
  }
}

const TOKEN_TIMEOUT_MS = 10_000;
const CRED_REFRESH_MARGIN_MS = 5 * 60_000;

export type AwsCreds = { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAtMs: number };

const env = (n: GatewayEnvName): string => (process.env[n] ?? "").trim();

/** Which of the five variables are set (names only — never a value). */
export function gatewayEnvStatus(): Record<GatewayEnvName, boolean> {
  return Object.fromEntries(GATEWAY_ENV.map((n) => [n, env(n) !== ""])) as Record<GatewayEnvName, boolean>;
}
export function gatewayConfigured(): boolean {
  return GATEWAY_ENV.every((n) => env(n) !== "");
}
function requireConfigured(): void {
  if (!gatewayConfigured()) throw new SarvamGatewayError("sarvam_gateway_not_configured");
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

function loadServiceAccount(): ServiceAccount {
  const raw = env("SARVAM_GCP_SA_KEY_JSON");
  let sa: ServiceAccount;
  try {
    const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    sa = JSON.parse(text) as ServiceAccount;
  } catch {
    throw new SarvamGatewayError("sarvam_gateway_key_invalid", "not_json");
  }
  if (!sa || typeof sa.client_email !== "string" || typeof sa.private_key !== "string" || !sa.client_email || !sa.private_key) {
    throw new SarvamGatewayError("sarvam_gateway_key_invalid", "missing_fields");
  }
  return { client_email: sa.client_email, private_key: sa.private_key.replace(/\\n/g, "\n"), ...(sa.token_uri ? { token_uri: sa.token_uri } : {}) };
}

/** The vendor's own error CODE from a JSON error body (Google `error.status`, AWS `__type` / `Error.Code`), or null. Never the message. */
function vendorCode(body: string): string | null {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const g = (j.error as Record<string, unknown> | string | undefined);
    const cands: unknown[] = [
      typeof g === "object" && g ? g.status : undefined,
      typeof g === "string" ? g : undefined,
      j.__type,
      (j.Error as Record<string, unknown> | undefined)?.Code,
      (j.ErrorResponse as { Error?: { Code?: unknown } } | undefined)?.Error?.Code,
      j.code,
    ];
    for (const c of cands) if (typeof c === "string" && /^[A-Za-z0-9_.#:-]{1,80}$/.test(c)) return c;
  } catch {
    /* not JSON */
  }
  const m = /<Code>([A-Za-z0-9_.-]{1,80})<\/Code>/.exec(body);
  return m ? m[1]! : null;
}
const gatewayError = (code: GatewayErrorCode, status: number, body: string): SarvamGatewayError =>
  new SarvamGatewayError(code, `${status}${vendorCode(body) ? ` ${vendorCode(body)}` : ""}`);

async function timedFetch(url: string, init: RequestInit, timeoutMs: number, code: GatewayErrorCode, signal?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  } catch (e) {
    // the message of a fetch failure can name the URL; only its kind is kept
    throw new SarvamGatewayError(code === "sarvam_gateway_http" ? "sarvam_gateway_network" : code, ctrl.signal.aborted ? "timeout" : (e as { name?: string })?.name ?? "network");
  } finally {
    clearTimeout(timer);
  }
}

// --- step 1: Google access token from the key ---------------------------------------------------------------------------------------------
async function googleAccessToken(sa: ServiceAccount, nowMs: number): Promise<string> {
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: tokenUri, iat, exp: iat + 3600 }));
  let signature: string;
  try {
    signature = b64url(createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key));
  } catch {
    throw new SarvamGatewayError("sarvam_gateway_key_invalid", "cannot_sign");
  }
  const res = await timedFetch(
    tokenUri,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` }).toString() },
    TOKEN_TIMEOUT_MS,
    "sarvam_gateway_google_token",
  );
  const text = await res.text().catch(() => "");
  if (!res.ok) throw gatewayError("sarvam_gateway_google_token", res.status, text);
  try {
    const tok = (JSON.parse(text) as { access_token?: string }).access_token;
    if (tok) return tok;
  } catch {
    /* fallthrough */
  }
  throw new SarvamGatewayError("sarvam_gateway_google_token", "no_access_token");
}

// --- step 2: ID token, minted BY the SA FOR itself ----------------------------------------------------------------------------------------
async function googleIdToken(sa: ServiceAccount, accessToken: string): Promise<string> {
  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa.client_email)}:generateIdToken`;
  const res = await timedFetch(
    url,
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ audience: env("SARVAM_GW_AUDIENCE"), includeEmail: true }) },
    TOKEN_TIMEOUT_MS,
    "sarvam_gateway_id_token",
  );
  const text = await res.text().catch(() => "");
  if (!res.ok) throw gatewayError("sarvam_gateway_id_token", res.status, text);
  try {
    const tok = (JSON.parse(text) as { token?: string }).token;
    if (tok) return tok;
  } catch {
    /* fallthrough */
  }
  throw new SarvamGatewayError("sarvam_gateway_id_token", "no_token");
}

// --- step 3: STS ---------------------------------------------------------------------------------------------------------------------------
async function stsAssume(idToken: string, nowMs: number): Promise<AwsCreds> {
  const region = env("SARVAM_GW_REGION");
  const res = await timedFetch(
    `https://sts.${region}.amazonaws.com/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        Action: "AssumeRoleWithWebIdentity",
        Version: "2011-06-15",
        RoleArn: env("SARVAM_GW_ROLE_ARN"),
        RoleSessionName: "scribe-mcp-sarvam",
        WebIdentityToken: idToken,
        DurationSeconds: "3600",
      }).toString(),
    },
    TOKEN_TIMEOUT_MS,
    "sarvam_gateway_sts",
  );
  const text = await res.text().catch(() => "");
  if (!res.ok) throw gatewayError("sarvam_gateway_sts", res.status, text);
  try {
    const c = (JSON.parse(text) as { AssumeRoleWithWebIdentityResponse?: { AssumeRoleWithWebIdentityResult?: { Credentials?: Record<string, unknown> } } }).AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult?.Credentials;
    if (c && typeof c.AccessKeyId === "string" && typeof c.SecretAccessKey === "string" && typeof c.SessionToken === "string") {
      const exp = typeof c.Expiration === "number" ? c.Expiration * 1000 : Date.parse(String(c.Expiration));
      return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiresAtMs: Number.isFinite(exp) ? exp : nowMs + 3_600_000 };
    }
  } catch {
    /* fallthrough */
  }
  throw new SarvamGatewayError("sarvam_gateway_sts", "no_credentials");
}

let cached: AwsCreds | null = null;
/** SINGLE-FLIGHT: concurrent callers after expiry share ONE Google -> IAM -> STS mint instead of each running the chain. */
let inflight: Promise<AwsCreds> | null = null;
/** Test hook: forget the cached AWS credentials. */
export function resetGatewayCredsForTests(): void {
  cached = null;
  inflight = null;
}

/** AWS credentials for the gateway: cached until 5 min before expiry, else the whole chain (once, however many callers wait). Throws SarvamGatewayError, never leaks. */
export async function gatewayCreds(nowMs: number = Date.now()): Promise<AwsCreds> {
  requireConfigured();
  if (cached && cached.expiresAtMs - CRED_REFRESH_MARGIN_MS > nowMs) return cached;
  if (inflight) return inflight;
  const mint = (async () => {
    const sa = loadServiceAccount();
    const access = await googleAccessToken(sa, nowMs);
    const idToken = await googleIdToken(sa, access);
    cached = await stsAssume(idToken, nowMs);
    return cached;
  })();
  inflight = mint;
  try {
    return await mint;
  } finally {
    if (inflight === mint) inflight = null; // success or failure, the next caller starts fresh (a failure is never cached)
  }
}

// --- step 4: SigV4 -------------------------------------------------------------------------------------------------------------------------
const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it (everything but A-Z a-z 0-9 - _ . ~). */
const rfc3986 = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Canonical URI for a non-S3 service: each path segment URI-encoded, then encoded once more. */
function canonicalPath(pathname: string): string {
  const segs = pathname.split("/").map((s) => {
    let decoded = s;
    try { decoded = decodeURIComponent(s); } catch { /* keep as sent */ }
    return rfc3986(rfc3986(decoded));
  });
  const out = segs.join("/");
  return out === "" ? "/" : out;
}

function canonicalQuery(search: string): string {
  const params = new URLSearchParams(search);
  const pairs: Array<[string, string]> = [];
  params.forEach((v, k) => pairs.push([rfc3986(k), rfc3986(v)]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export type SigV4Input = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | null;
  region: string;
  service: string;
  creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string | null };
  now?: Date;
};
export type SigV4Output = { headers: Record<string, string>; signature: string; canonicalRequest: string; stringToSign: string };

/**
 * PURE — sign a request. Returns the headers to send (the input headers + host-less x-amz-date, x-amz-security-token when a session token is
 * given, x-amz-content-sha256 is NOT added: execute-api does not require it) and the Authorization value. Signed headers: host, x-amz-date,
 * x-amz-security-token, plus content-type when the caller set one.
 */
export function signSigV4(input: SigV4Input): SigV4Output {
  const u = new URL(input.url);
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body ?? "");

  const toSign: Record<string, string> = { host: u.host, "x-amz-date": amzDate };
  if (input.creds.sessionToken) toSign["x-amz-security-token"] = input.creds.sessionToken;
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    const lk = k.toLowerCase();
    if (lk === "content-type") toSign["content-type"] = v.trim().replace(/\s+/g, " ");
  }
  const names = Object.keys(toSign).sort();
  const canonicalHeaders = names.map((n) => `${n}:${toSign[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [input.method.toUpperCase(), canonicalPath(u.pathname), canonicalQuery(u.search), canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const headers: Record<string, string> = { ...(input.headers ?? {}), "x-amz-date": amzDate };
  if (input.creds.sessionToken) headers["x-amz-security-token"] = input.creds.sessionToken;
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${input.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, signature, canonicalRequest, stringToSign };
}

export type GatewayInit = { method?: string; headers?: Record<string, string>; body?: string | Uint8Array | null; signal?: AbortSignal; timeoutMs?: number };

/**
 * A SigV4-signed request to SARVAM_GW_BASE_URL + route. Returns the raw Response; a network failure or a missing configuration throws a typed
 * SarvamGatewayError. `api-subscription-key` is removed from any caller-supplied headers: the gateway injects it.
 */
export async function gatewayFetch(route: string, init: GatewayInit = {}): Promise<Response> {
  requireConfigured();
  const base = env("SARVAM_GW_BASE_URL").replace(/\/+$/, "");
  const url = `${base}${route.startsWith("/") ? route : `/${route}`}`;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) if (k.toLowerCase() !== "api-subscription-key") headers[k] = v;
  const method = (init.method ?? "GET").toUpperCase();
  const creds = await gatewayCreds();
  const signed = signSigV4({ method, url, headers, body: init.body ?? null, region: env("SARVAM_GW_REGION"), service: "execute-api", creds });
  return timedFetch(url, { method, headers: signed.headers, ...(init.body !== undefined && init.body !== null ? { body: init.body as BodyInit } : {}) }, init.timeoutMs ?? 20_000, "sarvam_gateway_http", init.signal);
}

/** Health: run the chain to STS and no further. Never calls Sarvam. Values are never returned. */
export async function gatewayHealth(): Promise<{ configured: Record<GatewayEnvName, boolean>; creds_ok: boolean; sts_expires_at: string | null; error?: string }> {
  const configured = gatewayEnvStatus();
  if (!gatewayConfigured()) return { configured, creds_ok: false, sts_expires_at: null, error: "sarvam_gateway_not_configured" };
  try {
    const c = await gatewayCreds();
    return { configured, creds_ok: true, sts_expires_at: new Date(c.expiresAtMs).toISOString() };
  } catch (e) {
    return { configured, creds_ok: false, sts_expires_at: null, error: e instanceof SarvamGatewayError ? e.message : "sarvam_gateway_unknown" };
  }
}
