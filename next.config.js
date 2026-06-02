/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // PWA: service worker is served from /public/sw.js; manifest from /public/manifest.webmanifest.
  // PRD §4.18 — full Node runtime for everything (no edge functions).
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb", // audio chunk fallback upload (PRD §7.1)
    },
  },
  // Ensure the bug log markdown is traced into the /buglog serverless function
  // so it can be read at request time (it is the source of truth — editing it +
  // pushing republishes /buglog with no separate sync step).
  outputFileTracingIncludes: {
    "/buglog": ["./content/ETA-BUG-LOG.md"],
  },
};

module.exports = nextConfig;
