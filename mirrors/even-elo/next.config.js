/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // google-auth-library reads Node builtins. Leave the Vertex SDK external
    // so the server health route can load it on Vercel.
    serverComponentsExternalPackages: ["@google/genai", "google-auth-library"],
  },
  async redirects() {
    return [
      { source: '/surgical-elo', destination: '/surgical-governance', permanent: true },
      { source: '/surgical-elo/:path*', destination: '/surgical-governance/:path*', permanent: true },
    ]
  },
}
module.exports = nextConfig
