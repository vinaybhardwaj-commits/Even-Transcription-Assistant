// Heuristic secret sniffing for bus_post bodies.

const PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/, // OpenAI/Anthropic-style API keys
  /Bearer\s+[A-Za-z0-9._-]{8,}/i, // Authorization headers
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
  /-----BEGIN [A-Z ]*CERTIFICATE-----/,
  /\b[A-Fa-f0-9]{40,}\b/, // long hex run
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/, // long base64-ish run
];

export function looksLikeSecret(text) {
  if (!text) return false;
  return PATTERNS.some((re) => re.test(text));
}
