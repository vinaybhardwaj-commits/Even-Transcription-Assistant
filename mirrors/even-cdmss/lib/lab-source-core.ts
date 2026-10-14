/**
 * lib/lab-source-core.ts — PURE path policy for the F12b `lab_source` read-only code seam.
 * No fs, no db, no Next imports — the impure runner (lib/mcp-tools.ts) does the reading; this module
 * decides ONLY whether a path may be read, and normalises it.
 *
 * THREAT MODEL. `lab_source` exists so the orchestrator can read the code it is reasoning about
 * instead of inferring it. That is a file-read primitive exposed to an agent, so the policy is
 * allowlist-first and denylist-second, and every rejection states which rule fired.
 *
 * Order matters: NORMALISE (resolve . and .. lexically, reject absolute and escaping paths) BEFORE
 * matching, or `lib/../.env` would pass an allowlist check on its `lib/` prefix. Traversal is
 * resolved lexically rather than by the filesystem so a symlink cannot smuggle a path past this core.
 */

/** F12b: the ONLY readable prefixes. Source code, nothing else — no data/, no scripts/, no dotfiles. */
export const LAB_SOURCE_ALLOW_PREFIXES: readonly string[] = ['lib/', 'app/api/'];

/**
 * Denylist applied AFTER the allowlist, on the normalised path's basename AND full text. A secret
 * committed under lib/ would otherwise be readable purely because of where it sits.
 */
export const LAB_SOURCE_DENY_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.|$)/i,     // .env, .env.local, .env.production
  /secret/i,
  /credential/i,
  /(^|[^a-z])key([^a-z]|$)/i,   // "key" as a word — not "keyboard", not "monkey"
  /token/i,
];

export type SourceDecision =
  | { ok: true; path: string }
  | { ok: false; reason: 'empty' | 'absolute' | 'traversal' | 'not_allowlisted' | 'denylisted' | 'not_source_file'; detail: string };

/** Lexically resolve "." and ".." without touching the filesystem. Returns null if it escapes root. */
export function normalizeRepoPath(raw: string): string | null {
  const s = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!s) return null;
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length === 0) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

/** Only real source files are readable — not a directory listing, not a binary, not a dotfile. */
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|sql|json|md)$/i;

/**
 * Decide whether `raw` may be read. Pure; never throws. A rejection names the rule that fired so a
 * caller can tell "outside the seam" from "deliberately withheld".
 */
export function decideLabSource(raw: string): SourceDecision {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: 'empty', detail: 'path is required' };
  if (s.startsWith('/') || /^[a-z]:/i.test(s)) {
    return { ok: false, reason: 'absolute', detail: 'absolute paths are never readable; pass a repo-relative path' };
  }
  const norm = normalizeRepoPath(s);
  if (!norm) return { ok: false, reason: 'traversal', detail: 'path escapes the repository root' };

  // Denylist FIRST on the normalised form — a secret is unreadable wherever it sits.
  for (const rx of LAB_SOURCE_DENY_PATTERNS) {
    if (rx.test(norm)) return { ok: false, reason: 'denylisted', detail: `matches the secrets denylist (${rx})` };
  }
  if (!LAB_SOURCE_ALLOW_PREFIXES.some((p) => norm.startsWith(p))) {
    return { ok: false, reason: 'not_allowlisted', detail: `outside the read seam; allowed prefixes: ${LAB_SOURCE_ALLOW_PREFIXES.join(', ')}` };
  }
  if (!SOURCE_EXT_RE.test(norm)) {
    return { ok: false, reason: 'not_source_file', detail: 'only source files are readable (.ts/.tsx/.js/.jsx/.mjs/.cjs/.sql/.json/.md)' };
  }
  return { ok: true, path: norm };
}
