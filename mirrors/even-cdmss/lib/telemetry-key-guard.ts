/**
 * lib/telemetry-key-guard.ts — the build-time assertion that production has an HMAC key.
 * On-path kickoff D8. PRD v2.1 §4.3.
 *
 * ⚠️ A `.ts` FILE, NOT A `.mjs`. tsconfig.json includes only `.ts` and `.tsx`, and `strict` implies
 * `noImplicitAny`, so a `.ts` test importing a `lib/*.mjs` fails `tsc --noEmit` with TS7016. The
 * guard needs a test, so it has to be typed.
 *
 * `next.config.mjs` cannot import a `.ts`, so it INLINES the same three-clause condition and
 * throws. A source pin asserts the two express the same three clauses — one of them silently
 * diverging is how a deploy check stops checking.
 */

/**
 * True when this is a production Vercel build with no usable telemetry HMAC key.
 *
 * ⚠️ THE `.trim()` IS LOAD-BEARING, AND IT IS THE HALF OF D8 THAT WAS MISSING ON THE OTHER SIDE.
 * This guard always trimmed; `telemetryHmac` tested `secret.length === 0` and did not. A key of
 * three spaces was therefore ABSENT to this check and USABLE to the HMAC — production would have
 * been unconfigured and configured at the same time, and the disagreement would only have surfaced
 * as a digest nobody could reproduce. Both sides trim now. A whitespace key is not a key.
 */
export function telemetryKeyMissingInProduction(env: Record<string, string | undefined>): boolean {
  return env.VERCEL === '1' && env.VERCEL_ENV === 'production'
    && !String(env.CDMSS_TELEMETRY_HMAC_KEY ?? '').trim();
}

/** The env var the guard reads. Named once so the pin and the inline copy cannot drift on spelling. */
export const TELEMETRY_HMAC_KEY_ENV = 'CDMSS_TELEMETRY_HMAC_KEY';
