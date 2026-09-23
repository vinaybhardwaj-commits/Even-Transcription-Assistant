/**
 * Vertex AI access-token minting — pure Node `crypto`, NO new npm dependency.
 * Google service-account 2-legged OAuth (JWT-bearer): RS256-sign a JWT scoped to
 * cloud-platform, exchange for a ~1h access token, cache + refresh ~5 min early.
 * Credentials: env GCP_SA_KEY = the full service-account JSON (raw or base64).
 * Ported from Even-CDMSS (CAT), unchanged. Absent/bad key throws → callers fall
 * back to local Ollama, so "no credential" degrades to "Gemini off".
 */
import { createSign } from "crypto";

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };
let cached: { token: string; expiresAt: number } | null = null;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function loadServiceAccount(): ServiceAccount {
  const raw = process.env.GCP_SA_KEY;
  if (!raw) throw new Error("GCP_SA_KEY not set");
  let sa: ServiceAccount;
  try {
    const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    sa = JSON.parse(text);
  } catch {
    throw new Error("GCP_SA_KEY is not valid JSON (or base64 JSON)");
  }
  if (!sa.client_email || !sa.private_key) throw new Error("GCP_SA_KEY missing client_email/private_key");
  sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  return sa;
}

/**
 * The mint's own budget: RSA-sign (synchronous, effectively free) plus the OAuth token-exchange
 * fetch. This function's own fallback when no `timeoutMs` is given at all, AND the single value
 * lib/llm/gemini.ts imports and counts in routedChatDeadlineMs's sum — one mint budget, not two
 * (Fable's ruling, 23 Sep, closing the round-4 Refuter calibration note: this file used to default
 * to its own uncoordinated 30 s literal here while gemini.ts separately budgeted 10 s for the exact
 * same call).
 *
 * PROVISIONAL: 10 s is a guess, generous for a single HTTPS POST (typically sub-second) but not
 * calibrated from real timings, because none existed yet. `mintElapsedMs` below logs the elapsed
 * time of every actual (non-cached) mint so a real production distribution can replace this guess
 * once enough of them have accumulated.
 */
export const MINT_TIMEOUT_MS = 10_000;

/**
 * `signal` and `timeoutMs` are both OPTIONAL and additive — every existing caller that passes
 * neither behaves exactly as before, bounded only by `MINT_TIMEOUT_MS`. Builds its OWN
 * `AbortController` and combines it with a caller's `signal`, the same pattern openaiChat and
 * openrouterChat already use, so this fetch can be bounded by ITS OWN timer as well as cancelled
 * from outside — previously it had neither: routedChat's deadline could stop WAITING on it (F1
 * round 2, raceSignal) but never actually cancel the fetch, and there was no timeout of its own at
 * all (round-3 Refuter note: the mint was paid entirely out of the overall deadline's 10% slack,
 * which the smallest callers do not have much of). The cached-token fast path never reaches
 * `fetch`, so neither a signal nor a timer that fires after a cache hit does anything — there is
 * nothing left to cancel by then, and it logs nothing (there is no real mint elapsed time to log).
 */
export async function getVertexAccessToken(signal?: AbortSignal, timeoutMs?: number): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt - 5 * 60_000 > now) return cached.token;
  const mintStart = Date.now();
  const sa = loadServiceAccount();
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: tokenUri, iat, exp: iat + 3600 }));
  const signingInput = `${header}.${claims}`;
  const signature = b64url(createSign("RSA-SHA256").update(signingInput).sign(sa.private_key));
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs ?? MINT_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${signingInput}.${signature}` }),
      signal: controller.signal,
    });
    if (!res.ok) { const d = await res.text().catch(() => ""); throw new Error(`Vertex token exchange failed (${res.status}): ${d.slice(0, 300)}`); }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("Vertex token exchange returned no access_token");
    cached = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
    return cached.token;
  } finally {
    clearTimeout(tid);
    // Bare number only, no other detail — calibration input for MINT_TIMEOUT_MS above, not a debug
    // trace. Runs on every non-cached mint regardless of outcome (success, HTTP failure, or abort):
    // a mint that got aborted near the cap is itself useful signal about whether the cap is right.
    console.log("[gcp-auth] mint_elapsed_ms", Date.now() - mintStart);
  }
}
