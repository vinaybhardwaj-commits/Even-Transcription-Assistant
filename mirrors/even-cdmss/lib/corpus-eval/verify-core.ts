// lib/corpus-eval/verify-core.ts — Brainstem PR 0 baseline benchmark: the PURE verifier core + the
// metric math. No db, no model, no io — unit-testable under `node --experimental-strip-types`.
//
// The verifier's atomic job (P0-C): given ONE claim + the cited excerpt(s) + source metadata, judge
// whether the source actually SUPPORTS the claim. Consumer-agnostic — every surface (OPD/IPD/CCB
// as-served, Ask/DDx fresh-run) normalises to (claim, cited-excerpt, meta). The prompt is SEEDED from
// AUDIT_REVISE's already-trusted support-judgment language (lib/doc-audit-core.ts:476), NOT verbatim
// (that is shaped to the audit finding schema). It receives ONLY claim + excerpt + meta — never the
// clinical prompt, never the patient record (no new PHI path; the eval pack is de-identified).
//
// Fail-safe (P0): any unparseable / invalid output ⇒ `not_assessable` — never crash, never guess a
// support. `not_assessable` is a first-class reported bucket, never hidden.

export const CORPUS_EVAL_VERSION = 'corpus-eval/1.0';

export type SupportVerdict =
  | 'directly_supports'
  | 'partially_supports'
  | 'not_supported'
  | 'contradicts'
  | 'not_assessable';

export const SUPPORT_VERDICTS: ReadonlySet<string> = new Set<SupportVerdict>([
  'directly_supports', 'partially_supports', 'not_supported', 'contradicts', 'not_assessable',
]);

// The support-rate convention (PRD §2.1, verbatim): support = directly_supports over the ASSESSABLE
// denominator (directly + partial + not_supported + contradicts); not_assessable excluded from both.
// A secondary inclusive rate (directly+partial) is reported alongside — partial is real support, and
// the strict rate alone understates it.
export const SUPPORT_NUMERATOR: ReadonlySet<SupportVerdict> = new Set<SupportVerdict>(['directly_supports']);
export const SUPPORT_NUMERATOR_INCL_PARTIAL: ReadonlySet<SupportVerdict> = new Set<SupportVerdict>(['directly_supports', 'partially_supports']);
export const SUPPORT_DENOMINATOR: ReadonlySet<SupportVerdict> = new Set<SupportVerdict>(['directly_supports', 'partially_supports', 'not_supported', 'contradicts']);

// ── the verifier prompt (registry-scanned: name ends in _SYSTEM) ────────────────────────────────
export const VERIFY_SYSTEM = `You are a clinical citation-support verifier. You are given ONE claim from an AI clinical tool and the NUMBERED source excerpt(s) [1..n] the tool cited for that claim, with each source's bibliographic metadata. Judge ONLY whether the cited excerpt(s) actually support the claim — as the AUDIT_REVISE discipline demands: a citation must point to an excerpt that TRULY supports the point it is attached to, not merely one that exists or is topically related.

You are NOT auditing the claim's correctness against your own knowledge, and you have NO access to the patient record or the original prompt — judge support using the excerpts ALONE. If the excerpts are insufficient to judge (empty, unrelated boilerplate, or off-topic), say so rather than guessing.

Return a verdict:
- "directly_supports": an excerpt states or clearly entails the claim.
- "partially_supports": an excerpt supports part of the claim, or supports it with weaker/adjacent evidence.
- "not_supported": the excerpts are on-topic but do not establish the claim.
- "contradicts": an excerpt asserts the opposite of the claim.
- "not_assessable": the excerpts are missing/unusable, or the claim is not the kind of statement a source can support (e.g. a pure administrative/patient-specific fact).

Output ONLY JSON, no prose:
{"verdict":"directly_supports|partially_supports|not_supported|contradicts|not_assessable","supporting_span":"<shortest verbatim span from an excerpt that backs the claim, or null>","why":"<one clause>"}`;

export interface SourceMeta {
  n?: number;
  book?: string | null;
  chapter?: string | null;
  source?: string | null;
  page_start?: number | null;
  item_number?: string | null;
}

/** Build the user message: the claim + the numbered cited excerpt(s) + metadata. The excerpt is the
 *  cited source text (full chunk when resolved, else the as-served preview — the caller decides and
 *  records which). Multiple cited sources for one claim are numbered [1..n] (the sources-bundle grain,
 *  PRD §5). */
export function buildVerifyUser(claim: string, excerpts: Array<{ text: string; meta: SourceMeta }>): string {
  const block = excerpts.length
    ? excerpts.map((e, i) => {
        const label = [e.meta.book, e.meta.chapter, e.meta.page_start != null ? `p.${e.meta.page_start}` : '', e.meta.item_number ? `Item ${e.meta.item_number}` : '']
          .map((x) => (x == null ? '' : String(x))).filter(Boolean).join(' · ');
        const body = String(e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1400);
        return `[${i + 1}] ${label || 'source'}\n${body || '(empty excerpt)'}`;
      }).join('\n\n')
    : '(no cited excerpt available)';
  return `CLAIM:\n${String(claim ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200)}\n\nCITED SOURCE EXCERPT(S):\n${block}\n\nOutput the JSON verdict now.`;
}

export interface VerifyResult { verdict: SupportVerdict; supportingSpan: string | null; why: string }

/** Parse the model output → a verdict. Fail-safe: anything unparseable/invalid ⇒ not_assessable. */
export function parseVerdict(raw: string | null | undefined): VerifyResult {
  const fail = (why: string): VerifyResult => ({ verdict: 'not_assessable', supportingSpan: null, why });
  if (!raw || typeof raw !== 'string') return fail('empty model output');
  let obj: Record<string, unknown> | null = null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);   // tolerate prose/code-fence wrapping
    obj = m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
  } catch { return fail('unparseable JSON'); }
  if (!obj || typeof obj !== 'object') return fail('no JSON object');
  const v = String(obj.verdict ?? '').trim();
  if (!SUPPORT_VERDICTS.has(v)) return fail(`verdict '${v.slice(0, 24)}' outside enum`);
  const span = obj.supporting_span == null ? null : String(obj.supporting_span).slice(0, 400);
  const why = String(obj.why ?? '').slice(0, 300);
  return { verdict: v as SupportVerdict, supportingSpan: span || null, why };
}

// ── metrics ──────────────────────────────────────────────────────────────────────────────────────

/** Wilson score interval for a binomial proportion — robust at small n (PRD: never a bare rate). */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 0];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface SupportStats {
  n_total: number;                    // all scored units (incl. not_assessable)
  directly_supports: number;
  partially_supports: number;
  not_supported: number;
  contradicts: number;
  not_assessable: number;
  n_assessable: number;               // the support-rate denominator
  support_rate: number | null;        // directly / assessable (PRD §2.1, strict)
  support_rate_ci: [number, number] | null;
  support_rate_incl_partial: number | null;   // (directly+partial) / assessable (secondary)
  unsupported_rate: number | null;    // not_supported / assessable
  contradicts_rate: number | null;    // contradicts / assessable
  not_assessable_rate: number | null; // not_assessable / n_total
}

export function supportStats(verdicts: SupportVerdict[]): SupportStats {
  const c = { directly_supports: 0, partially_supports: 0, not_supported: 0, contradicts: 0, not_assessable: 0 };
  for (const v of verdicts) c[v]++;
  const nTotal = verdicts.length;
  const nAssessable = c.directly_supports + c.partially_supports + c.not_supported + c.contradicts;
  const rate = (k: number) => (nAssessable > 0 ? k / nAssessable : null);
  return {
    n_total: nTotal,
    ...c,
    n_assessable: nAssessable,
    support_rate: rate(c.directly_supports),
    support_rate_ci: nAssessable > 0 ? wilson(c.directly_supports, nAssessable) : null,
    support_rate_incl_partial: rate(c.directly_supports + c.partially_supports),
    unsupported_rate: rate(c.not_supported),
    contradicts_rate: rate(c.contradicts),
    not_assessable_rate: nTotal > 0 ? c.not_assessable / nTotal : null,
  };
}

// ── cite-or-label (PRD §2.2) ──────────────────────────────────────────────────────────────────────
export interface CiteOrLabel { n_claims: number; cited: number; uncited: number; cited_fraction: number | null }
export function citeOrLabel(claims: Array<{ cited: boolean }>): CiteOrLabel {
  const n = claims.length;
  const cited = claims.filter((x) => x.cited).length;
  return { n_claims: n, cited, uncited: n - cited, cited_fraction: n > 0 ? cited / n : null };
}

// ── coverage-deficit histogram (PRD §2.3) — deficit = 1 − top-hit similarity, pure ────────────────
export interface DeficitHistogram {
  n: number;
  median: number | null;
  p90: number | null;
  mean: number | null;
  bins: Array<{ lo: number; hi: number; count: number }>;   // deciles [0,0.1)…[0.9,1.0]
}
function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
export function deficitHistogram(deficits: number[]): DeficitHistogram {
  const xs = deficits.filter((d) => Number.isFinite(d)).map((d) => Math.min(1, Math.max(0, d))).sort((a, b) => a - b);
  const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, count: 0 }));
  for (const d of xs) { const i = Math.min(9, Math.floor(d * 10)); bins[i].count++; }
  return {
    n: xs.length,
    median: quantile(xs, 0.5),
    p90: quantile(xs, 0.9),
    mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
    bins,
  };
}
