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
};

module.exports = nextConfig;
