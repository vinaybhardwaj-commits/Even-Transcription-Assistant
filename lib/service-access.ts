/**
 * lib/service-access.ts — Cloudflare Access service-token headers for the service hostnames (TUNNEL-HARDENING P2(b),
 * Fable, 24 Sep 2026).
 *
 * WHY. whisper, diarize, embed, emotion, IndicConformer and the router are public, unauthenticated hostnames. Access will
 * be put in front of them, twins first. Enforcement is the LAST step and comes only after every server-side caller
 * already sends the headers, so this ships DARK: with the two env vars unset, no request changes by a byte.
 *
 *   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET   the service token, as Vercel env (build-time, like every env here)
 *   CF_ACCESS_HOST_SUFFIXES                         comma list of hostname suffixes the token may go to;
 *                                                   default ".llmvinayminihome.uk"
 *
 * THE TOKEN GOES ONLY WHERE IT BELONGS. It is attached when ALL of these hold, and never otherwise:
 *   - both variables are set and non-blank (a half-set pair sends NOTHING and is reported by name, never by value);
 *   - the URL is https (a secret is never put on cleartext);
 *   - the hostname is in a suffix's domain, matched on a dot boundary ("evil-llmvinayminihome.uk" does not match).
 * So a base URL that is mistyped, or pointed at another vendor, cannot receive the secret.
 *
 * NEVER LOG, RETURN OR THROW THE VALUES. This file returns them only as the header object handed to fetch. Nothing here
 * reads or writes them anywhere else.
 *
 * REDIRECTS: see `withServiceAccess`. When the token is attached the call refuses to follow a redirect.
 */

export const CF_ACCESS_ID_ENV = "CF_ACCESS_CLIENT_ID";
export const CF_ACCESS_SECRET_ENV = "CF_ACCESS_CLIENT_SECRET";
export const CF_ACCESS_HOST_SUFFIXES_ENV = "CF_ACCESS_HOST_SUFFIXES";
export const CF_ACCESS_DEFAULT_SUFFIXES = [".llmvinayminihome.uk"] as const;

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined) => (v ?? "").trim();

function suffixesOf(env: Env): string[] {
  const raw = clean(env[CF_ACCESS_HOST_SUFFIXES_ENV]);
  const list = raw ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [...CF_ACCESS_DEFAULT_SUFFIXES];
  return list.map((s) => (s.startsWith(".") ? s : `.${s}`));
}

/** PURE — does this URL's host fall inside a suffix's domain, on a dot boundary? https only. */
export function hostAllowedForAccess(url: string, env: Env = process.env): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return suffixesOf(env).some((s) => host.endsWith(s) && host.length > s.length);
}

/**
 * The headers to add to a request for `url`: `{}` unless the token is configured AND the host is an allowed service host.
 * Spread it into a fetch's `headers`; it never overrides a header the caller sets itself.
 */
export function serviceAccessHeaders(url: string, env: Env = process.env): Record<string, string> {
  const id = clean(env[CF_ACCESS_ID_ENV]);
  const secret = clean(env[CF_ACCESS_SECRET_ENV]);
  if (!id || !secret) return {};
  if (!hostAllowedForAccess(url, env)) return {};
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

/** Names of the Access settings that are wrong, for the health tool: a half-set pair. Names only, never values. */
export function serviceAccessProblems(env: Env = process.env): string[] {
  const hasId = clean(env[CF_ACCESS_ID_ENV]) !== "";
  const hasSecret = clean(env[CF_ACCESS_SECRET_ENV]) !== "";
  if (hasId && !hasSecret) return [CF_ACCESS_SECRET_ENV];
  if (hasSecret && !hasId) return [CF_ACCESS_ID_ENV];
  return [];
}

/** Whether a complete token is configured. A boolean for the health tool; nothing about the values. */
export function serviceAccessConfigured(env: Env = process.env): boolean {
  return clean(env[CF_ACCESS_ID_ENV]) !== "" && clean(env[CF_ACCESS_SECRET_ENV]) !== "";
}

/**
 * Wrap a fetch's init. With no token, or a host that may not receive it, the SAME object comes back untouched, so a call
 * with nothing configured is byte-for-byte the call it was. Otherwise the two headers are added; a header the caller
 * already set (case-insensitively) is never overridden.
 *
 * REDIRECTS ARE REFUSED WHEN THE TOKEN IS ATTACHED (`redirect: "error"`, unless the caller chose one). eta-refuter-2 measured
 * both halves on Node 22: fetch strips Authorization on a cross-origin redirect but FORWARDS the two Access headers to
 * the target; and an Access app that rejects a token answers 302 to its login page, which answers 200. A health probe that
 * treats "status < 500" as up (the whisper adapter, IndicConformer) would then show GREEN while every real call is refused,
 * exactly when a token is expired, rotated or mis-set. With the redirect refused the call throws, and every caller already
 * turns a thrown fetch into a failure. No token → no `redirect` key → nothing changes.
 */
export function withServiceAccess<T extends RequestInit>(url: string, init: T = {} as T, env: Env = process.env): T {
  const extra = serviceAccessHeaders(url, env);
  if (Object.keys(extra).length === 0) return init;
  const merged = new Headers(init.headers);
  for (const [k, v] of Object.entries(extra)) if (!merged.has(k)) merged.set(k, v);
  return { ...init, headers: merged, redirect: init.redirect ?? "error" };
}

/**
 * A drop-in `fetch` for an SDK that takes one (the OpenAI client in lib/llm.ts). Each request gets `withServiceAccess` for ITS
 * url, so the token still goes only to an allowed host. The global `fetch` is read at call time, not captured at load.
 */
export const serviceAccessFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const isRequest = typeof input !== "string" && !(input instanceof URL);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const wrapped = withServiceAccess(url, init ?? {});
  // fetch(Request, init-with-headers) REPLACES the Request's own headers with init's. The OpenAI SDK passes a string URL today, so
  // this is not reached, but the day something passes a Request its headers must survive: carry them across, init's winning.
  if (isRequest && wrapped.headers !== undefined && wrapped.headers !== init?.headers) {
    const merged = new Headers((input as Request).headers);
    new Headers(wrapped.headers).forEach((v, k) => merged.set(k, v));
    return fetch(input, { ...wrapped, headers: merged });
  }
  return fetch(input, wrapped);
};
