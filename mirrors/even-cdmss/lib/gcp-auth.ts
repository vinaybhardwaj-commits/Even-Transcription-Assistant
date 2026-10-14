/**
 * Vertex AI access-token minting — pure Node `crypto`, NO new npm dependency.
 *
 * Implements the Google service-account 2-legged OAuth (JWT-bearer) flow:
 *   1. Build an RS256-signed JWT asserting the service account identity, scoped
 *      to cloud-platform.
 *   2. Exchange it at the token endpoint for a short-lived (1h) access token.
 *   3. Cache the token in module scope and refresh ~5 min before expiry.
 *
 * Credentials come from env `GCP_SA_KEY` = the full service-account JSON key
 * (the object Google hands you when you create the key), set in Vercel. The
 * secret is never logged. If GCP_SA_KEY is absent/malformed this throws, and the
 * caller (tracedChat) falls back to the local Ollama path — so a missing
 * credential degrades to "Gemini off", never to a broken request.
 */
import { createSign } from 'crypto';

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

let cached: { token: string; expiresAt: number } | null = null;
/** ID-token cache, keyed by audience (§3.1 of the Bedrock reference). Separate from `cached`
 *  above: an ID token and an access token are different credentials for different callees, and
 *  one map per audience means a second audience can never be served a token minted for the first. */
const idTokenCache = new Map<string, { token: string; expiresAt: number }>();

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function loadServiceAccount(): ServiceAccount {
  const raw = process.env.GCP_SA_KEY;
  if (!raw) throw new Error('GCP_SA_KEY not set');
  let sa: ServiceAccount;
  try {
    // Accept either raw JSON or base64-encoded JSON (Vercel env values with
    // embedded newlines are fiddly — base64 is the safe way to paste a key).
    const text = raw.trim().startsWith('{')
      ? raw
      : Buffer.from(raw, 'base64').toString('utf8');
    sa = JSON.parse(text);
  } catch {
    throw new Error('GCP_SA_KEY is not valid JSON (or base64 JSON)');
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('GCP_SA_KEY missing client_email/private_key');
  }
  // PEM keys pasted into env often arrive with literal "\n" — normalise.
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

/**
 * The SA identity in use — client_email ONLY, never key material (403-diagnosis kickoff §4.1:
 * a provider_error record must name WHICH identity Vertex refused). Null when GCP_SA_KEY is
 * absent or unparseable; never throws.
 */
export function vertexSaEmail(): string | null {
  try { return loadServiceAccount().client_email || null; } catch { return null; }
}

/**
 * Returns a valid cloud-platform access token, minting+caching a fresh one when
 * needed. Throws if credentials are missing/invalid or the token exchange fails.
 */
export async function getVertexAccessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt - 5 * 60_000 > now) {
    return cached.token;
  }

  const sa = loadServiceAccount();
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: tokenUri,
      iat,
      exp,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = b64url(
    createSign('RSA-SHA256').update(signingInput).sign(sa.private_key),
  );
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Vertex token exchange failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Vertex token exchange returned no access_token');

  cached = {
    token: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/** The IAM Credentials `generateIdToken` endpoint. `projects/-` is the documented wildcard: the
 *  project is inferred from the service-account email, so no project id is needed here. */
export function generateIdTokenUrl(saEmail: string): string {
  return `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail)}:generateIdToken`;
}

/** Nominal ID-token lifetime. Google issues 1 hour; the shared 5-minute skew below makes the
 *  USABLE life 55 minutes, which is the number to reason about (and the one the S1 warm-instance
 *  refresh test is written against). The token's own `exp` is not decoded — see `getGcpIdToken`. */
const ID_TOKEN_TTL_MS = 3600_000;

/**
 * A Google **ID token** for `audience` — the first leg of the Bedrock chain (AWS STS
 * `AssumeRoleWithWebIdentity` trusts this token; see lib/bedrock.ts).
 *
 * ══ TWO STEPS, AND THE FIRST ONE IS THE FUNCTION ABOVE ═══════════════════════════════════════
 *   1. a cloud-platform ACCESS token, via `getVertexAccessToken` (the existing JWT-bearer flow);
 *   2. POST that as a bearer to IAM Credentials `:generateIdToken` with {audience, includeEmail},
 *      and read the `token` field of the response.
 *
 * ⚠️ WHY NOT THE JWT-BEARER FLOW, WHICH THIS FUNCTION USED UNTIL 7 AUG 2026. It looked like the
 * natural extension of the exchange above — same assertion, `target_audience` in place of `scope`,
 * `id_token` in place of `access_token` — and every reference for it says so. IT DOES NOT WORK FOR
 * THIS AUDIENCE. Reproduced live against the real SA key: the token endpoint answers
 * **HTTP 400 `invalid_scope`** for audience `588427270277`. A numeric AWS-style audience is not
 * something that endpoint will mint for, full stop, and no amount of claim-shape tuning changes it.
 *
 * The IAM Credentials path is what the source artifact's Go version actually used
 * (`impersonate.IDTokenSource`), and it is proven end to end on this account: the minted token is
 * accepted by STS (trust policy bound to sub 104742817559128344276), and Converse answered from all
 * three models with usage reported. Everything downstream of this mint was already correct — the
 * mint was the only broken link.
 *
 * PREREQUISITES, both verified live and neither in this repo: `iamcredentials.googleapis.com`
 * enabled, and the SA holding `roles/iam.serviceAccountTokenCreator` ON ITSELF. A 403 here means
 * one of those, and the error body says which — which is why the body travels with the error.
 *
 * Cached per audience, refreshed 5 minutes before expiry — same discipline and the same numbers as
 * the access-token cache above. The token is never logged. Its `exp` claim is deliberately NOT
 * decoded: a fixed 60-minute nominal life minus the shared skew is exactly as safe (Google issues
 * one hour) and costs no JWT parsing on a path where a parse bug would be an outage.
 *
 * `getVertexAccessToken` is unchanged — this now DEPENDS on it rather than duplicating it.
 */
export async function getGcpIdToken(audience: string): Promise<string> {
  const aud = String(audience ?? '').trim();
  if (!aud) throw new Error('getGcpIdToken: audience is required');

  const now = Date.now();
  const hit = idTokenCache.get(aud);
  if (hit && hit.expiresAt - 5 * 60_000 > now) return hit.token;

  const sa = loadServiceAccount();
  // Step 1 — the cloud-platform access token that authorises the impersonation call. Its own cache
  // and refresh discipline apply, so a warm instance usually spends no network here.
  const accessToken = await getVertexAccessToken();

  // Step 2 — impersonate ourselves to mint an ID token for the AWS audience.
  const res = await fetch(generateIdTokenUrl(sa.client_email), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ audience: aud, includeEmail: true }),
  });

  if (!res.ok) {
    // The BODY is the diagnosis (403-diagnosis §4.1): a missing serviceAccountTokenCreator, a
    // disabled iamcredentials API and a wrong audience read identically without it. It carries no
    // token material — the request body holds only the audience, and the bearer is in a header.
    const detail = await res.text().catch(() => '');
    throw new Error(
      `IAM Credentials generateIdToken failed for audience ${aud} as ${sa.client_email} (${res.status}): ${detail.slice(0, 300)}`,
    );
  }

  // ⚠️ THE RESPONSE FIELD IS `token`, not `id_token` — this endpoint is not the OAuth token
  // endpoint and does not speak its dialect.
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error(`IAM Credentials generateIdToken returned no token for audience ${aud}`);

  idTokenCache.set(aud, { token: json.token, expiresAt: now + ID_TOKEN_TTL_MS });
  return json.token;
}
