/**
 * lib/opd-finding-identity-core.ts — PURE core for durable finding identity (LAB-MCP Phase 1, F1).
 *
 * ZERO IMPORTS BY DESIGN. lib/opd-note-audit-core.ts documents itself as "Pure + dependency-free
 * (own SHA-1) so this file stays strip-types testable and client-safe", and stampFindingIdentity now
 * calls into this module. Importing `node:crypto` here would transitively make that file server-only
 * and could break any client bundle that imports OPD_SIGNAL_TYPES. So the SHA-1 below is the same
 * pure implementation style already proven in that file, verified here against the standard test
 * vector. "No new dependencies" is satisfied either way; this choice additionally preserves an
 * existing, documented architectural property.
 *
 * ADDENDUM A1: uid is NOT in the hash — stable_ref is a finding-KIND token, unique within a note.
 * Note scoping lives in resolveLabel, where uid is a REQUIRED parameter.
 *
 * THE ONE-FUNCTION INVARIANT (F1): computeStableRef has exactly TWO call sites — stampFindingIdentity
 * (forward) and the backfill route (history). A second implementation anywhere is a defect: the two
 * paths MUST produce byte-identical refs for the same input, which is asserted in the tests.
 */

// ── pure SHA-1 (no imports; full 40-char lowercase hex) ────────────────────────
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const ml = bytes.length;
  const padded = new Uint8Array(Math.ceil((ml + 9) / 64) * 64);
  padded.set(bytes);
  padded[ml] = 0x80;
  const dv = new DataView(padded.buffer);
  const bitLen = ml * 8;
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) { const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]; w[j] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('');
}

// ── normalisation ─────────────────────────────────────────────────────────────
/**
 * NFKC → lowercase → collapse whitespace runs to a single space → trim → strip trailing
 * . , ; : ! ? and quotes.
 *
 * DELIBERATELY NOT CLEVER (F1): no stemming, no stopword removal, no synonym mapping. Every one of
 * those merges texts that a reviewer would read as different findings, and a merge here is a
 * COLLISION — two distinct findings resolving to one label. Under-normalising costs a missed match
 * (recoverable, falls back to finding_ref); over-normalising costs a wrong label (not recoverable).
 */
export function normStableText(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?'"`‘’“”]+$/u, '')
    .trim();
}

/**
 * The field delimiter. U+0001 (START OF HEADING), NOT "|", because "|" occurs inside real finding
 * subjects (drug combinations, dosing strings) and would let one field's content impersonate a field
 * boundary — e.g. signal "a|b" + subject "c" colliding with signal "a" + subject "b|c".
 */
export const STABLE_REF_DELIM = '\u0001';

/**
 * stable_ref = sha1(signal_type ␁ norm(subject)), full 40-char lowercase hex.
 *
 * PRD ADDENDUM A1 (decision 15, V, 26 Jul 2026): `uid` is NOT in the hash. stampFindingIdentity has
 * no uid in scope and all 9 non-test call sites pass findings alone, so a uid-bearing hash was
 * unbuildable without threading uid through nine call sites or adding a second stamping path — and
 * making uid optional would have shipped F1 as a silent no-op (addendum A4).
 *
 * stable_ref is therefore a FINDING-KIND token: unique WITHIN a note, NOT globally. The same
 * (signal_type, subject) on two different notes deliberately produces the SAME ref. Note scoping
 * happens at RESOLUTION, where `uid` is a required parameter of resolveLabel — a bare stable_ref
 * lookup unscoped by uid is a bug.
 *
 * Returns NULL — never a hash of the empty string — when signalType or subject is missing or
 * normalises to empty. A hash of "" would be one value shared by every degenerate finding in the
 * corpus: a mass collision presented as an identity. Null is honest and falls back to finding_ref.
 */
export function computeStableRef(
  signalType: string | null | undefined,
  subject: string | null | undefined,
): string | null {
  const st = String(signalType ?? '').trim();
  const sub = normStableText(subject);
  if (!st || !sub) return null;
  return sha1Hex(`${st}${STABLE_REF_DELIM}${sub}`);
}

// ── label resolution (F1 / normative detail 4) ─────────────────────────────────
export interface IdentifiableFinding {
  stable_ref?: string | null;
  finding_ref?: string | null;
}
export interface ResolveArgs<T extends IdentifiableFinding> {
  /** REQUIRED (addendum A1). stable_ref is unique only WITHIN a note, so resolution must be
   *  note-scoped. Required in the signature precisely so it cannot be omitted by accident. */
  uid: string;
  /** The stored label's stable_ref, if it has one. */
  stableRef?: string | null;
  /** The stored label's finding_ref — the fallback for history stamped before F1. */
  findingRef?: string | null;
  /** The CURRENT findings of the note identified by `uid`. The caller performs the uid→findings
   *  lookup; passing another note's findings here is the bug this signature exists to prevent. */
  findings: T[];
}
export interface ResolveResult<T> {
  finding: T | null;
  matched_by: 'stable_ref' | 'finding_ref' | null;
  ambiguous: boolean;
}

/**
 * Resolve a stored clinician label to the finding it refers to, WITHIN one note.
 *
 * stable_ref is tried FIRST — it survives a re-audit, which is the whole point of F1; finding_ref
 * does not (it is a positional, collision-suffixed hash that an engine bump re-derives). finding_ref
 * remains the fallback so every label stamped before F1 still resolves.
 *
 * COLLISIONS RESOLVE TO NULL, never to a guess: if more than one current finding on the note shares
 * the stable_ref, this returns { finding: null, ambiguous: true }. Picking the first would silently
 * attach a reviewer's verdict to the wrong finding — worse than losing the link, because the link is
 * recoverable while a mis-attributed verdict corrupts the precision measurement it feeds.
 *
 * A blank uid resolves to nothing rather than falling back to an unscoped search (addendum A1).
 * Pure; never throws.
 */
export function resolveLabel<T extends IdentifiableFinding>(args: ResolveArgs<T>): ResolveResult<T> {
  const miss: ResolveResult<T> = { finding: null, matched_by: null, ambiguous: false };
  if (!args || !String(args.uid ?? '').trim()) return miss;   // never an unscoped lookup
  const list = Array.isArray(args.findings) ? args.findings.filter((f) => f && typeof f === 'object') : [];
  const wantStable = args.stableRef == null ? '' : String(args.stableRef).trim();
  const wantFinding = args.findingRef == null ? '' : String(args.findingRef).trim();

  if (wantStable) {
    const hits = list.filter((f) => f.stable_ref != null && String(f.stable_ref) === wantStable);
    if (hits.length > 1) return { finding: null, matched_by: null, ambiguous: true };
    if (hits.length === 1) return { finding: hits[0], matched_by: 'stable_ref', ambiguous: false };
  }
  if (wantFinding) {
    const hits = list.filter((f) => f.finding_ref != null && String(f.finding_ref) === wantFinding);
    if (hits.length > 1) return { finding: null, matched_by: null, ambiguous: true };
    if (hits.length === 1) return { finding: hits[0], matched_by: 'finding_ref', ambiguous: false };
  }
  return miss;
}

// ── cluster_key normalisation (F2/F4 support — normative detail 5) ─────────────
/**
 * The cluster_key convention becomes a bare "<signal_type>"; engine version is metadata, not identity.
 * The ledger is APPEND-ONLY, so historical "<signal>@<version>" rows are NOT rewritten — they are
 * normalised ON READ. Strips a single trailing "@..." segment; a bare key passes through unchanged.
 */
export function normalizeClusterKey(k: string | null | undefined): string {
  const s = String(k ?? '').trim();
  if (!s) return s;
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}
