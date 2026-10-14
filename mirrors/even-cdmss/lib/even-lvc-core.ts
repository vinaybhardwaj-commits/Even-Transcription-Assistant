/**
 * lib/even-lvc-core.ts — PURE core for the Even LLM-Provenance LVC Adjudication System
 * (CDMSS-EVEN-LVC-ADJUDICATION-SYSTEM-PRD-v1.0, Phase 1). No db / Next / LLM imports, so it
 * strip-types and unit-tests standalone; every impure step (DB, OpenRouter, embeddings) lives in
 * lib/even-lvc.ts and delegates its logic here.
 *
 * What this core owns:
 *  - the de-identified generation DIGEST builder (subject + lvc_category + count only — NO PHI),
 *  - candidate JSON parsing + same-category dedup (text-equality OR cosine ≥ 0.90, incl. vs rejected),
 *  - the generation prompt,
 *  - id-ordinal minting (elv-<category>-<ordinal>),
 *  - own_cases computation, contest roll-up + the active→contested flip (NO auto-retire),
 *  - the embedded-chunk section string + provenance display constants.
 *
 * INVARIANT: nothing here reads or writes a finding verdict/score/band/lvc_category. Grounding stays
 * additive (citation_ids only) — that lives in lib/normative-grounding-core.ts, unchanged.
 */

// ── constants (PRD §2, §5, §6) — env overrides applied in the impure layer ──────
export const EVEN_ARTIFACT_TYPE = 'opd_note';
export const EVEN_GEN_MODEL_DEFAULT = 'moonshotai/kimi-k3';
// Digest grain (PRD §1.1 — evidence-driven fix). LVC volume is FRAGMENTED across many distinct subject
// phrasings, so qualification is at the CATEGORY grain, not the exact-subject grain, over all lvc-tagged
// engine history. (The old subject-level floor `LVC_GEN_MIN_FREQ=20` cleared ~1 cluster against live data.)
export const LVC_GEN_CAT_MIN = 50;          // a lvc_category qualifies iff its TOTAL low-value findings ≥ 50
export const LVC_GEN_TOPK = 80;             // max exemplar subjects passed per qualifying category (top count first)
export const LVC_GEN_SUBJECT_MIN = 2;       // drop pure singletons (count < 2) as noise BEFORE topK
export const LVC_GEN_MAX_CANDIDATES = 25;   // per-run insert cap
export const LVC_CONTEST_FLAG = 5;          // ≥5 contests ⇒ active flips to 'contested' (still grounds)
export const EVEN_DEDUP_COSINE = 0.90;      // same-category near-dup threshold for generation dedup
export const LVC_RUN_STALE_MIN = 10;        // a 'running' gen-run older than this (minutes) is dead → expire it

/** A 'running' generation run is STALE — its serverless function was killed or the operator navigated
 *  away, so it will never close itself — once it is older than LVC_RUN_STALE_MIN minutes. Pure; a
 *  malformed/absent timestamp ⇒ NOT stale (fail-safe false, so a parse glitch never expires a live run). */
export function isRunStale(startedAtISO: string | null | undefined, nowMs: number): boolean {
  const t = Date.parse(String(startedAtISO ?? ''));
  if (!Number.isFinite(t)) return false;
  return nowMs - t > LVC_RUN_STALE_MIN * 60_000;
}
/** The internal-consensus tier display strings (mirrors provenance-tier-core.citationSourceTier). */
export const EVEN_DISPLAY_LABEL = 'Even Adjudicated LVC';
export const EVEN_PROVENANCE_LABEL = 'Even Adjudicated LVC (physician-ratified)';
/** The embedded chunk's constant `book` (mksap_chunks.book) — same for every assertion (dedup key is
 *  (book, text_hash), and text differs per assertion, so this constant never causes a false conflict). */
export const EVEN_CHUNK_BOOK = 'Even Adjudicated LVC';

export type AssertionStatus = 'pending' | 'active' | 'contested' | 'retired' | 'rejected';

// ── de-identified digest (PRD §5.1) ────────────────────────────────────────────
/** One aggregated, DE-IDENTIFIED finding-cluster row (the ONLY fields that may feed generation). */
export interface DigestRow { lvc_category: string; subject: string; n: number }
export interface DigestExemplar { subject: string; count: number }
export interface DigestCluster { lvc_category: string; subjects: DigestExemplar[]; total: number }

/** Normalise a finding subject for clustering/dedup: lowercase, collapse whitespace, trim, drop a
 *  trailing period. Deterministic + pure. */
export function normalizeSubject(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.+$/, '').trim();
}

/**
 * Build the generation digest from aggregated rows (PRD §1.1 — CATEGORY-grain qualification). Groups
 * by lvc_category, sums count per normalized subject, and:
 *  - drops a category entirely if its TOTAL low-value findings (Σ over ALL its subjects) < catMin;
 *  - within a qualifying category, drops pure singletons (count < subjectMin), then keeps the top `topK`
 *    subjects by count (tie-break subject asc).
 * Emits `{ lvc_category, subjects: [{subject,count}], total }` where `total` is the full category sum
 * (pre-singleton-cut) — the volume signal Kimi abstracts over. De-identification guarantee: only
 * {subject, count} + the aggregate total are emitted; any extra input-row field (doctor_uid/uid/note
 * text) is structurally dropped (we read exactly {lvc_category, subject, n}). Clusters sorted by
 * category asc. Pure.
 */
export function buildDigest(
  rows: DigestRow[],
  { catMin = LVC_GEN_CAT_MIN, topK = LVC_GEN_TOPK, subjectMin = LVC_GEN_SUBJECT_MIN }: { catMin?: number; topK?: number; subjectMin?: number } = {},
): DigestCluster[] {
  const byCat = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const cat = String(r?.lvc_category ?? '').trim();
    const subj = normalizeSubject(r?.subject);
    const n = Math.floor(Number(r?.n));
    if (!cat || !subj || !Number.isFinite(n) || n <= 0) continue;
    const m = byCat.get(cat) ?? new Map<string, number>();
    m.set(subj, (m.get(subj) ?? 0) + n);
    byCat.set(cat, m);
  }
  const out: DigestCluster[] = [];
  for (const [lvc_category, m] of byCat) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);   // full category volume (pre-singleton-cut)
    if (total < catMin) continue;                                // category-grain qualification
    const subjects = [...m.entries()]
      .filter(([, count]) => count >= subjectMin)                // drop singletons as noise
      .map(([subject, count]) => ({ subject, count }))
      .sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject))
      .slice(0, topK);                                           // top-K exemplars by count
    if (subjects.length) out.push({ lvc_category, subjects, total });
  }
  return out.sort((a, b) => a.lvc_category.localeCompare(b.lvc_category));
}

// ── generation prompt (PRD §5.2) ────────────────────────────────────────────────
// NB: EVEN_GEN_SYSTEM is ASSEMBLED (array .join), not a standing template-literal `_SYSTEM` const, so
// the reasoning-registry generator (which extracts backtick-initialised *_SYSTEM consts + build*Prompt
// builders) does NOT auto-register it. The generation model CALL is still fully governed — it routes
// through governedChat (lib/trace.ts). Registering this prompt into the research export is a flagged
// follow-up (it would touch the generated registry artifact + manifest, outside this PRD's file contract).
export const EVEN_GEN_SYSTEM = [
  'You are a clinical appropriateness analyst for Even, an Indian primary-care provider.',
  'You are shown DE-IDENTIFIED clusters of low-value-care findings that Even\'s own audits have',
  'repeatedly flagged, grouped by category. Propose concise, testable "Even Adjudicated LVC"',
  'appropriateness assertions — each states that a specific pattern is low-value in Even\'s',
  'India/primary-care context, phrased so a future audit finding of the SAME category can be matched',
  'to it. Ground each assertion ONLY in the clusters shown; do not invent categories or cite external',
  'guidelines. These are CANDIDATES for a human clinician to ratify — propose, never assert authority.',
  'Return ONLY a JSON array; no prose, no code fences.',
].join(' ');

/** Assemble the per-run user message from the digest, capped. Deterministic string; pure.
 *  (Named OUTSIDE the `build*Prompt` registry-builder convention on purpose — see EVEN_GEN_SYSTEM note.) */
export function evenGenUserMessage(clusters: DigestCluster[], maxCandidates: number = LVC_GEN_MAX_CANDIDATES): string {
  const body = clusters.map((c) => {
    // ≤40 exemplars per category in the prompt (bounded size; the cluster already holds ≤LVC_GEN_TOPK).
    const lines = c.subjects.slice(0, 40).map((s) => `    - ${s.subject} (seen ${s.count}×)`).join('\n');
    return `  category: ${c.lvc_category} — ${c.total} low-value findings total\n${lines}`;   // §1.1: pass the category total
  }).join('\n');
  return [
    `Propose up to ${maxCandidates} candidate LVC assertions across these categories.`,
    'For each, return an object: {"lvc_category": <one of the categories below, verbatim>,',
    '"assertion_text": <the appropriateness statement>, "rationale": <one sentence, display-only>,',
    '"supporting": [{"subject": <a cluster subject you used>, "count": <its count>}]}.',
    'Only use categories and subjects that appear below.',
    '',
    'Clusters:',
    body,
  ].join('\n');
}

// ── candidate parsing + dedup (PRD §5.3) ────────────────────────────────────────
export interface GenCandidate {
  lvc_category: string;
  assertion_text: string;
  rationale: string | null;
  supporting: DigestExemplar[];
}

/** Normalise assertion text for equality dedup: lowercased, whitespace-collapsed, trailing-punct dropped. */
export function normalizeAssertionText(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '').trim();
}

/**
 * Tolerantly parse the model's reply → validated GenCandidate[]. Accepts a bare JSON array or an
 * object wrapping it ({candidates|assertions: [...]}), strips ```json fences, and drops any element
 * missing a non-empty lvc_category + assertion_text. `allowedCategories` (when provided) filters out
 * hallucinated categories. Never throws — a malformed reply yields []. Pure.
 */
export function parseCandidatesJson(raw: string, allowedCategories?: string[]): GenCandidate[] {
  const allow = allowedCategories && allowedCategories.length ? new Set(allowedCategories) : null;
  let text = String(raw ?? '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // If the reply has leading/trailing prose, grab the outermost [ ... ] or { ... }.
  if (!/^[[{]/.test(text)) {
    const arr = text.indexOf('['); const obj = text.indexOf('{');
    const start = arr >= 0 && (obj < 0 || arr < obj) ? arr : obj;
    if (start > 0) text = text.slice(start).trim();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object')
      ? ((parsed as Record<string, unknown>).candidates ?? (parsed as Record<string, unknown>).assertions ?? []) as unknown[]
      : [];
  if (!Array.isArray(arr)) return [];
  const out: GenCandidate[] = [];
  for (const el of arr) {
    if (!el || typeof el !== 'object') continue;
    const o = el as Record<string, unknown>;
    const lvc_category = String(o.lvc_category ?? '').trim();
    const assertion_text = String(o.assertion_text ?? '').trim();
    if (!lvc_category || !assertion_text) continue;
    if (allow && !allow.has(lvc_category)) continue;
    const rationale = o.rationale == null ? null : String(o.rationale).trim() || null;
    const supporting: DigestExemplar[] = Array.isArray(o.supporting)
      ? (o.supporting as unknown[]).map((s) => {
          const so = (s && typeof s === 'object') ? (s as Record<string, unknown>) : {};
          return { subject: normalizeSubject(so.subject as string), count: Math.max(0, Math.floor(Number(so.count)) || 0) };
        }).filter((s) => s.subject)
      : [];
    out.push({ lvc_category, assertion_text, rationale, supporting });
  }
  return out;
}

export interface ExistingAssertion { id: string; lvc_category: string; assertion_text: string; status: AssertionStatus }
/** Injected similarity: cosine of two assertion texts' embeddings ∈ [-1,1]. The impure layer supplies it. */
export type TextSimilarity = (a: string, b: string) => number;

/** Is `cand` a same-category near-duplicate of any existing (pending|active|contested|rejected)
 *  assertion? True on normalized-text equality OR cosine ≥ `cosineThreshold`. Pure (simFn injected). */
export function isDuplicateCandidate(
  cand: GenCandidate,
  existing: ExistingAssertion[],
  simFn: TextSimilarity,
  cosineThreshold: number = EVEN_DEDUP_COSINE,
): boolean {
  const candNorm = normalizeAssertionText(cand.assertion_text);
  for (const e of existing) {
    if (e.lvc_category !== cand.lvc_category) continue;
    if (!(['pending', 'active', 'contested', 'rejected'] as AssertionStatus[]).includes(e.status)) continue;
    if (normalizeAssertionText(e.assertion_text) === candNorm) return true;
    if (simFn(cand.assertion_text, e.assertion_text) >= cosineThreshold) return true;
  }
  return false;
}

/**
 * Drop candidates that duplicate an existing assertion (isDuplicateCandidate) OR an earlier survivor
 * in THIS batch (same-category text-eq / cosine), then cap. Preserves input order. Pure.
 */
export function dedupeCandidates(
  cands: GenCandidate[],
  existing: ExistingAssertion[],
  simFn: TextSimilarity,
  cap: number = LVC_GEN_MAX_CANDIDATES,
  cosineThreshold: number = EVEN_DEDUP_COSINE,
): GenCandidate[] {
  const survivors: GenCandidate[] = [];
  for (const c of cands) {
    if (survivors.length >= cap) break;
    if (isDuplicateCandidate(c, existing, simFn, cosineThreshold)) continue;
    const asExisting: ExistingAssertion[] = survivors.map((s, i) => ({ id: `batch-${i}`, lvc_category: s.lvc_category, assertion_text: s.assertion_text, status: 'pending' }));
    if (isDuplicateCandidate(c, asExisting, simFn, cosineThreshold)) continue;
    survivors.push(c);
  }
  return survivors;
}

// ── id-ordinal (PRD §5.4) ───────────────────────────────────────────────────────
/** Highest ordinal already used for `category` among `existingIds` (elv-<category>-<ordinal>), else 0. */
export function maxOrdinalForCategory(category: string, existingIds: string[]): number {
  const prefix = `elv-${category}-`;
  let max = 0;
  for (const id of existingIds) {
    if (!String(id).startsWith(prefix)) continue;
    const n = parseInt(String(id).slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** Mint the next assertion id for a category: elv-<category>-<zero-padded 3-digit ordinal>. Pure. */
export function nextAssertionId(category: string, existingIds: string[]): string {
  const ord = maxOrdinalForCategory(category, existingIds) + 1;
  return `elv-${category}-${String(ord).padStart(3, '0')}`;
}

/** Assign ids to a survivor batch, threading each new id back into the pool so intra-batch ordinals
 *  don't collide. Returns candidates paired with their fresh id. Pure. */
export function assignAssertionIds(cands: GenCandidate[], existingIds: string[]): Array<{ id: string; candidate: GenCandidate }> {
  const pool = [...existingIds];
  return cands.map((candidate) => {
    const id = nextAssertionId(candidate.lvc_category, pool);
    pool.push(id);
    return { id, candidate };
  });
}

// ── own_cases (PRD §6) ──────────────────────────────────────────────────────────
/** True iff the ratifier's roster name equals a doctor_uid behind the assertion's supporting cluster.
 *  Structurally rare (roster reviewers ≠ audited doctors) — a measurable health signal, not a block. */
export function computeOwnCases(ratifierName: string | null | undefined, supportingDoctorUids: string[]): boolean {
  const r = String(ratifierName ?? '').trim();
  if (!r) return false;
  return supportingDoctorUids.some((d) => String(d).trim() === r);
}

// ── embedded-chunk section (PRD §3.4) ────────────────────────────────────────────
/** The mksap_chunks.section string for an embedded assertion — a compact status/version tag. Pure. */
export function evenChunkSection(status: AssertionStatus, version: number): string {
  return `${status}/v${Math.max(1, Math.floor(Number(version) || 1))}`;
}

// ── contest roll-up + flip (PRD §6) ─────────────────────────────────────────────
export interface RollupAssertion { id: string; status: AssertionStatus; contest_count?: number }
export interface ContestRollupResult { id: string; contest_count: number; status: AssertionStatus; changed: boolean }

/**
 * Recompute each assertion's contest_count from raw contest feedback rows (grouped by assertion_id)
 * and apply the active→contested flip at ≥ `flag`. NEVER auto-retires and never un-contests: only an
 * 'active' assertion at/above the threshold changes (to 'contested'); pending/retired/rejected and
 * already-'contested' rows keep their status. `changed` marks rows whose (status, contest_count)
 * differs from the input, so the caller can persist a minimal update set. Pure.
 */
export function rollupContests(
  assertions: RollupAssertion[],
  contestRows: Array<{ assertion_id: string | null | undefined }>,
  flag: number = LVC_CONTEST_FLAG,
): ContestRollupResult[] {
  const counts = new Map<string, number>();
  for (const row of contestRows) {
    const id = String(row?.assertion_id ?? '').trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return assertions.map((a) => {
    const contest_count = counts.get(a.id) ?? 0;
    let status: AssertionStatus = a.status;
    if (a.status === 'active' && contest_count >= flag) status = 'contested';
    const changed = status !== a.status || contest_count !== (a.contest_count ?? 0);
    return { id: a.id, contest_count, status, changed };
  });
}
