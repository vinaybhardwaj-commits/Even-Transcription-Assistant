/**
 * v1.6 P4: Auto-derived per-chunk source quality weight.
 *
 * Multiplier (typically 0.6–1.1) applied at fusion time to bias the
 * retrieval pool toward higher-quality material. Precomputed once at
 * reindex time into mksap_chunks.source_quality_weight, read at retrieve
 * time (no LLM call, no extra DB hop).
 *
 * Signals available on every chunk row:
 *   - book        : "MKSAP 19", "StatPearls", etc. — primary tier signal
 *   - source      : raw source label (sometimes useful)
 *   - chunk_type  : 'narrative' | 'explanation' | other — explanations
 *                   tend to be more focused, denser per-token
 *   - token_count : penalize tiny chunks (<50 toks, often citations or
 *                   page-break noise) and very-long chunks (>1500 toks,
 *                   often boilerplate appendices)
 *
 * We deliberately AVOID:
 *   - text-content sniffing (slow, can be gamed by injection)
 *   - external API calls (latency)
 *   - publish-year recency (we don't have year on textbook chunks —
 *     PLOS hits in v1.4 are already 5-yr-filtered at query time)
 *
 * Formula:
 *   weight = bookTier * chunkTypeBonus * tokenLengthFactor
 *
 * Final range clamped to [0.5, 1.15].
 */

export type SourceQualityInputs = {
  book: string | null;
  source: string | null;
  chunk_type: string | null;
  token_count: number | null;
};

/**
 * Book-tier lookup. Substring match (case-insensitive) — defaults to 0.85
 * for unknown books so we don't downweight the corpus catastrophically.
 *
 * Tiers (rationale):
 *   1.00 : board-review textbooks (MKSAP, Harrison's, NMS, Kaplan) — vetted,
 *          peer-reviewed, written to teach the marrow of the topic.
 *   0.90 : clinical reference (StatPearls, Medscape, UpToDate, AAFP) —
 *          high quality but more update-driven, sometimes less concise.
 *   0.80 : general/unknown — default for books we haven't classified.
 *   0.70 : noisy sources (case-report compilations, lecture transcripts).
 */
const BOOK_TIERS: { match: string; tier: number }[] = [
  { match: 'mksap',       tier: 1.00 },
  { match: 'harrison',    tier: 1.00 },
  { match: 'cecil',       tier: 1.00 },
  { match: 'kaplan',      tier: 1.00 },
  { match: 'nms',         tier: 1.00 },
  { match: 'oxford handbook', tier: 1.00 },
  { match: 'statpearls',  tier: 0.90 },
  { match: 'uptodate',    tier: 0.90 },
  { match: 'medscape',    tier: 0.90 },
  { match: 'aafp',        tier: 0.90 },
  { match: 'guidelines',  tier: 0.95 },
  // Society-endorsed appropriateness / low-value-care recommendations (Choosing Wisely
  // module). source='choosing-wisely', book='CW-<society>' — both land in `hay`.
  { match: 'choosing-wisely', tier: 0.95 },
  // Specialty refs (slightly above default)
  { match: 'tintinalli',  tier: 0.95 },
  { match: 'goldman',     tier: 1.00 },
];

function bookTier(book: string | null, source: string | null): number {
  const hay = `${book ?? ''} ${source ?? ''}`.toLowerCase();
  for (const t of BOOK_TIERS) {
    if (hay.includes(t.match)) return t.tier;
  }
  return 0.80;  // unknown-book default
}

/**
 * chunk_type bonus.
 *   explanation : 1.05 — explanations are typically dense, focused, on-topic
 *   narrative   : 1.00 — neutral
 *   other/null  : 0.95 — unknown shape, slight conservative pull
 */
function chunkTypeBonus(chunk_type: string | null): number {
  if (!chunk_type) return 0.95;
  const ct = chunk_type.toLowerCase();
  if (ct === 'explanation') return 1.05;
  if (ct === 'narrative') return 1.00;
  if (ct === 'recommendation') return 1.00; // Choosing Wisely recs are short but high-signal; don't penalize as "other"
  return 0.95;
}

/**
 * Token-count factor.
 *   <50    : 0.70 — tiny / fragment / citation-only
 *   50-149 : 0.85 — short, often section header without body
 *   150-1200 : 1.00 — sweet spot (paragraph-to-section sized)
 *   1201-2000 : 0.95 — long, sometimes boilerplate-heavy
 *   >2000  : 0.85 — very long, usually whole-chapter dumps
 */
function tokenLengthFactor(token_count: number | null): number {
  if (token_count == null || token_count <= 0) return 0.95;
  if (token_count < 50)    return 0.70;
  if (token_count < 150)   return 0.85;
  if (token_count <= 1200) return 1.00;
  if (token_count <= 2000) return 0.95;
  return 0.85;
}

export function computeSourceQualityWeight(input: SourceQualityInputs): number {
  const w = bookTier(input.book, input.source)
          * chunkTypeBonus(input.chunk_type)
          * tokenLengthFactor(input.token_count);
  // Clamp to a sane range so a single bad signal can't tank a chunk to 0
  return Math.max(0.50, Math.min(1.15, Number(w.toFixed(4))));
}
