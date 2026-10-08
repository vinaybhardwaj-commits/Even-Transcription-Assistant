// Secret sniffing for bus_post subject + body.
//
// Fix round, 2026-09-23, ruling 10: specific, named patterns ONLY. The
// old generic "long hex run" / "long base64-ish run" heuristics are gone
// — they false-positived on git SHAs, UUIDs and embedding vectors, which
// must pass through untouched.

const PATTERNS = [
  // \b before "sk-" matters: without it this matched "sk-" inside ordinary
  // words like "risk-stratification", "task-breakdown-v2", "disk-usage-
  // report" (B5, CONFIRMED false positive — no word boundary). {20,} after
  // the optional vendor infix keeps short coincidental matches out too.
  { name: 'openai_or_anthropic_key', re: /\bsk-(?:ant|or|proj)?-?[A-Za-z0-9_-]{20,}/ },
  { name: 'github_token', re: /\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{10,}\b/ },
  { name: 'slack_token', re: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+)?/ },
  { name: 'bearer_token', re: /Bearer\s+[A-Za-z0-9._-]{8,}/i },
  { name: 'pem_block', re: /-----BEGIN [A-Z0-9 ]*-----/ },
  // scheme://user:password@host — credentials embedded in a URI.
  { name: 'uri_userinfo', re: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/ },
  // Fix round 3, ruling-10 gap: Google API keys and bare password= assignments
  // (VERDICT-2 O4 residual — ruling 10 omitted these from round 1).
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'bare_password_assignment', re: /\bpassword\s*=\s*\S{6,}/i },
];

export function looksLikeSecret(text) {
  if (!text) return false;
  return PATTERNS.some((p) => p.re.test(text));
}

// Which named pattern matched first, if any — used only for audit-log
// detail (never logs the matched text itself, just the pattern name).
export function secretMatchName(text) {
  if (!text) return null;
  const hit = PATTERNS.find((p) => p.re.test(text));
  return hit ? hit.name : null;
}

// eta-lab export (2026-09-23): same PATTERNS, but replacing instead of just
// detecting — bus_post already refuses secret-looking subject/body at post
// time, so this is defense in depth for the exported daily files
// specifically (any future insert path that doesn't go through bus_post's
// gate, or a pattern added later, still gets scrubbed here too).
export function redactSecrets(text) {
  if (!text) return text;
  let out = text;
  for (const p of PATTERNS) {
    const flags = p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`;
    out = out.replace(new RegExp(p.re.source, flags), `[REDACTED:${p.name}]`);
  }
  return out;
}
