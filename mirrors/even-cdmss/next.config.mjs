// ⚠️ THE TELEMETRY HMAC KEY IS A DEPLOY PRECONDITION, NOT A RUNTIME DEGRADATION.
// Rerank telemetry HMACs every patient-derived value it records (PRD v2.1 §4.3). Without a key the
// build would still run and would simply write explicit nulls with `telemetry_error:
// 'hmac_key_absent'` — honest, but it would make every production row partial and quietly waste a
// canary window. So a PRODUCTION build fails here instead.
//
// This condition is INLINED because next.config.mjs cannot import a .ts. Its typed twin is
// `telemetryKeyMissingInProduction` in lib/telemetry-key-guard.ts, and a source pin asserts the two
// express the same three clauses — VERCEL === '1', VERCEL_ENV === 'production', and a TRIMMED key.
// The trim matters: a key of three spaces is not a key, and lib/retrieval-telemetry-core.ts's
// `telemetryHmac` trims too, so the two cannot disagree about whether production is configured.
if (process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production'
  && !String(process.env.CDMSS_TELEMETRY_HMAC_KEY ?? '').trim()) {
  throw new Error(
    'CDMSS_TELEMETRY_HMAC_KEY is required for a production build. Rerank telemetry keys every '
    + 'patient-derived value it records; an unkeyed digest of clinical text is not acceptable (§4.3). '
    + 'Set it in Vercel Production before deploying.',
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true };
export default nextConfig;
