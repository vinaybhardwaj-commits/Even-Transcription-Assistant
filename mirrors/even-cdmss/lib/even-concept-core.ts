/**
 * lib/even-concept-core.ts — PURE core for the Concept Coder (Phase 1, CDMSS-CONCEPT-CODER-PRD v1.0).
 * No db / Next / LLM imports — `node --experimental-strip-types` loadable, per the house convention.
 *
 * Owns: subject normalisation, slot→concept_id composition, review_lane computation, extraction-response
 * validation, and the additive stamp. Nothing here reads or writes a verdict/score/band/lvc_category.
 *
 * SCORE-INVARIANCE (PRD §3). computeOpdScore reads only (verdict, confidence, domain). stampConcepts
 * writes ONLY concept_id + concept_context onto a finding object, so it is structurally incapable of
 * moving a score. Asserted in tests, not assumed.
 *
 * R-11 (PRD §7). Nothing here enters the audit model's context. The extractor reads a finding STRING,
 * never a note, and its output never returns to the audit model. The vocabulary below is STRUCTURAL —
 * `direction` carries no clinical position, and there is deliberately no enumerated target vocabulary
 * (a drug list would tell a model which drugs are low-value candidates, which is squarely R-11).
 */

// ── closed vocabularies (PRD §7 — structural, never clinical) ───────────────────
export const CONCEPT_DIRECTIONS = ['overuse', 'underuse', 'documentation', 'process'] as const;
export type ConceptDirection = (typeof CONCEPT_DIRECTIONS)[number];
export function isConceptDirection(d: unknown): d is ConceptDirection {
  return typeof d === 'string' && (CONCEPT_DIRECTIONS as readonly string[]).includes(d);
}

export type ReviewLane = 'clean' | 'context';
export type ConceptSource = 'seed' | 'extracted';

export interface ConceptSlots {
  direction: ConceptDirection;
  action: string;
  target: string;
  context: string | null;
}

// ── subject normalisation ───────────────────────────────────────────────────────
/**
 * The cache key for a finding subject. Byte-identical to `normalizeSubject` in even-lvc-core (lower,
 * collapse whitespace, strip trailing dots) — re-implemented rather than imported to keep this core
 * dependency-free. The equivalence is asserted in tests, and it is load-bearing: the Research Team's
 * 9,449 seeded `norm` values were produced by this same rule, so any divergence would make every
 * seeded row unreachable and turn a zero-cost lookup into 9,449 model calls.
 */
export function normalizeConceptSubject(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.+$/, '').trim();
}

// ── slot → concept_id composition (PRD §2 step 3) ───────────────────────────────
/** A slot value is blank if it is empty/whitespace or one of the model's usual null spellings. */
function blankSlot(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '' || s === 'null' || s === 'none' || s === 'n/a' || s === 'na' || s === 'undefined';
}
/** Slot text normalisation — same shape as the subject rule, plus inner-colon stripping so a slot can
 *  never inject an extra `:` segment and silently re-shape the composed id. */
export function normalizeSlot(v: string | null | undefined): string {
  return normalizeConceptSubject(v).replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The empty-target sentinel (PRD §3.1, V ruling 26 Jul). An otherwise-valid slot triple whose TARGET
 * is empty composes against `regimen` — "the prescription taken as a whole". Polypharmacy has no drug
 * target because its target IS the whole prescription, and `overuse:polypharmacy:regimen` is a
 * genuinely rulable proposition ("is this prescription over-loaded?").
 *
 * IT IS NOT A CATCH-ALL, and that is the point of the rule. ONLY an empty target qualifies. A triple
 * failing for any OTHER reason — a direction outside the closed vocabulary, `exclude_test_note`, a
 * blank ACTION — is still rejected and must never be swept in here. Letting the sentinel absorb those
 * would convert a fail-safe into a silent accept-all, which is strictly worse than dropping the row.
 */
export const EMPTY_TARGET_SENTINEL = 'regimen';

/**
 * Compose `direction:action:target`. The CONTEXT IS DELIBERATELY NOT PART OF THE ID — it is stored
 * alongside it (PRD §3: `lvc_concept_strings` carries `concept_id` and `context` as separate columns),
 * because §4's two-lane review rules at `direction:action:target` and drills into contexts separately.
 *
 * Returns null when the DIRECTION is outside the closed vocabulary or the ACTION is blank — the caller
 * must then NOT stamp (§7 fail-safe: an unstamped finding behaves exactly as it does today). A blank
 * TARGET is the one recoverable case: it composes against the sentinel (§3.1).
 */
export function composeConceptId(slots: Pick<ConceptSlots, 'direction' | 'action' | 'target'>): string | null {
  if (!isConceptDirection(slots.direction)) return null;   // never sentinel-recoverable
  const action = normalizeSlot(slots.action);
  if (blankSlot(action)) return null;                      // never sentinel-recoverable
  const target = normalizeSlot(slots.target);
  const finalTarget = blankSlot(target) ? EMPTY_TARGET_SENTINEL : target;   // §3.1 — empty target ONLY
  return `${slots.direction}:${action}:${finalTarget}`;
}

/** Did this concept_id take the sentinel path? Useful for reporting and for the Phase 2 review sheet,
 *  which should show a reviewer that the target was absent rather than named. */
export function usesEmptyTargetSentinel(conceptId: string | null | undefined): boolean {
  return baseConceptId(conceptId).split(':')[2] === EMPTY_TARGET_SENTINEL;
}

/** The base (context-free) concept of a possibly-context-qualified id — `a:b:c:ctx` → `a:b:c`. The seed
 *  dictionary stores both shapes, so the lane computation must fold them onto the base. */
export function baseConceptId(conceptId: string | null | undefined): string {
  const parts = String(conceptId ?? '').split(':');
  return parts.length >= 3 ? parts.slice(0, 3).join(':') : String(conceptId ?? '');
}

// ── target resolution (PRD §7 — formulary + the load-bearing stage order) ────────
/** What a formulary resolver reports back. `tier` mirrors the Research Team's `form_tier` column. */
export type TargetTier = 'none' | 'brand-exact' | 'brand-token' | 'combo-member';
export interface TargetResolution { target: string; tier: TargetTier }
export type TargetResolver = (rawTarget: string) => TargetResolution | null;

/**
 * PRD §7 formulary guard. Four ordinary-word brand families resolve to a single unrelated molecule in
 * the live resolver (`cbc`→Pralidoxime, `anti`→Antivenom, `skin`→Skin Brightening Cream,
 * `calcium`→Calcium Carbonate+Cholecalciferol). A brand-TOKEN match on one of these is refused and the
 * literal target is kept: "unindicated cbc" is a blood count, not an organophosphate antidote.
 * brand-EXACT matches are untouched — the guard is specifically about single ordinary-word tokens.
 */
export const ORDINARY_WORD_BRAND_TOKENS: readonly string[] = ['cbc', 'anti', 'skin', 'calcium'];
export function isGuardedBrandToken(rawTarget: string, tier: TargetTier): boolean {
  if (tier !== 'brand-token') return false;
  const t = normalizeSlot(rawTarget);
  return ORDINARY_WORD_BRAND_TOKENS.some((w) => t === w || t.split(/[\s+/-]+/).includes(w));
}

/**
 * Collapse rules run AFTER formulary resolution. PRD §7: "resolving 'montek lc' to bare montelukast
 * broke the known-answer test until the collapse rule was moved to run after formulary resolution."
 * Preserve that order — collapsing first would turn every montelukast combination into bare
 * montelukast and the 175 seeded montelukast strings would stop agreeing on one concept.
 */
export function applyCollapseRules(target: string): string {
  const t = normalizeSlot(target);
  if (!t) return t;
  if (/\bmontelukast\b/.test(t)) return 'montelukast_containing';
  return t;
}

/** Full target pipeline, in the load-bearing order: resolve (guarded) → collapse. Pure; the formulary
 *  itself is INJECTED so this core stays dependency-free and the resolver is testable in isolation. */
export function resolveTarget(rawTarget: string, resolve?: TargetResolver | null): string {
  const raw = normalizeSlot(rawTarget);
  if (!raw) return raw;
  let resolved = raw;
  if (resolve) {
    try {
      const r = resolve(raw);
      if (r && r.target && !isGuardedBrandToken(raw, r.tier)) resolved = normalizeSlot(r.target);
    } catch { resolved = raw; }   // a resolver failure must never lose the literal target
  }
  return applyCollapseRules(resolved);   // STAGE ORDER: collapse LAST
}

// ── review_lane (PRD §4) ────────────────────────────────────────────────────────
/** Clean lane iff ≥80% of the concept's VOLUME carries no context; everything else is the context lane.
 *  Deterministic from the volume share and stored, so the assignment is inspectable and re-derivable.
 *  A concept with no volume at all is `clean` (nothing to drill into). */
export const CLEAN_LANE_MIN_CONTEXT_FREE_SHARE = 0.80;
export function computeReviewLane(totalVolume: number, contextFreeVolume: number): ReviewLane {
  const total = Number(totalVolume) || 0;
  if (total <= 0) return 'clean';
  const share = (Number(contextFreeVolume) || 0) / total;
  return share >= CLEAN_LANE_MIN_CONTEXT_FREE_SHARE ? 'clean' : 'context';
}

// ── extraction-response validation (PRD §9) ─────────────────────────────────────
export type ExtractionReject =
  | 'empty' | 'not_json' | 'not_object' | 'bad_direction' | 'missing_slot' | 'compose_failed';
export type ExtractionResult =
  | { ok: true; slots: ConceptSlots; conceptId: string }
  | { ok: false; reason: ExtractionReject; detail?: string };

/** Strip a ```json fence if the model wrapped its object in one. Nothing else is repaired — a response
 *  we cannot read is a REJECT, never a guess (PRD §5: "Never a fallback that guesses"). */
function stripFence(raw: string): string {
  const s = String(raw ?? '').trim();
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (m ? m[1] : s).trim();
}

/**
 * Validate a raw extraction response into slots + a composed concept_id. Every failure path returns
 * ok:false with a reason — the worker then logs, skips, and leaves the finding UNSTAMPED. There is no
 * partial stamp and no default direction: a direction outside the closed vocabulary is a reject (§9),
 * not a coercion to `overuse`.
 */
export function validateExtraction(raw: string | null | undefined, resolve?: TargetResolver | null): ExtractionResult {
  const text = stripFence(String(raw ?? ''));
  if (!text) return { ok: false, reason: 'empty' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, reason: 'not_json', detail: text.slice(0, 120) }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'not_object' };

  const o = parsed as Record<string, unknown>;
  if (!isConceptDirection(o.direction)) {
    return { ok: false, reason: 'bad_direction', detail: String(o.direction ?? '').slice(0, 60) };
  }
  // A blank ACTION is unrecoverable. A blank TARGET is NOT a reject — it takes the §3.1 sentinel.
  if (blankSlot(o.action)) return { ok: false, reason: 'missing_slot' };

  const resolved = resolveTarget(blankSlot(o.target) ? '' : String(o.target), resolve);
  const target = blankSlot(resolved) ? EMPTY_TARGET_SENTINEL : resolved;
  const slots: ConceptSlots = {
    direction: o.direction,
    action: normalizeSlot(String(o.action)),
    target,
    context: blankSlot(o.context) ? null : normalizeSlot(String(o.context)),
  };
  const conceptId = composeConceptId(slots);
  if (!conceptId) return { ok: false, reason: 'compose_failed' };
  return { ok: true, slots, conceptId };
}

// ── the stamp (PRD §3 — concept_id + concept_context ONLY) ──────────────────────
/** Structural minimum (NO index signature) so the real OpdFinding satisfies it and the helper returns
 *  that exact type unchanged. */
export interface StampableFinding {
  subject?: string;
  verdict?: string;
  informational?: boolean;
  concept_id?: string | null;
  concept_context?: string | null;
}
export interface ConceptAssignment { concept_id: string; context: string | null }
/** norm → assignment. Returning null/undefined for a norm leaves that finding untouched. */
export type ConceptLookup = (norm: string) => ConceptAssignment | null | undefined;

/** Which findings the coder considers. Low-value verdict only (the governable volume §0 describes);
 *  informational findings are already out of the score and out of the queue. */
export function isCodableFinding(f: StampableFinding): boolean {
  return f?.verdict === 'low-value' && f?.informational !== true && !!normalizeConceptSubject(f?.subject);
}

/**
 * Stamp concept_id + concept_context onto findings. ADDITIVE and SCORE-INVARIANT by construction:
 * it spreads the original finding and sets exactly two keys, so verdict/confidence/domain — the only
 * fields computeOpdScore reads — are carried through untouched and are never even referenced here.
 * A finding already carrying a concept_id is left alone (a string is extracted once, ever).
 * Pure; never throws. Returns the findings plus how many were newly stamped.
 */
export function stampConcepts<T extends StampableFinding>(
  findings: T[], lookup: ConceptLookup,
): { findings: T[]; stamped: number } {
  if (!Array.isArray(findings) || findings.length === 0) return { findings: findings ?? [], stamped: 0 };
  let stamped = 0;
  const out = findings.map((f) => {
    if (!f || typeof f !== 'object') return f;
    if (f.concept_id) return f;                       // already coded — never re-stamp
    if (!isCodableFinding(f)) return f;
    let hit: ConceptAssignment | null | undefined;
    try { hit = lookup(normalizeConceptSubject(f.subject)); } catch { hit = null; }
    if (!hit || !hit.concept_id) return f;            // miss ⇒ unstamped, unchanged (§7 fail-safe)
    stamped++;
    return { ...f, concept_id: hit.concept_id, concept_context: hit.context ?? null };
  });
  return { findings: out, stamped };
}

// ── status shaping (worker page) — pure, mirrors buildGroundStatus ──────────────
/**
 * The worker's cron cadence in minutes — MUST match the schedule in vercel.json for
 * `/api/care/concept/code`. Display-only: it drives the "next tick ~mm:ss" countdown and the
 * zero-state's "runs every N minutes" line. It lives in the PURE core so the client panel can import
 * it without pulling db/trace into the bundle, and so the number has ONE home rather than being
 * hardcoded at each use site (it was, in two places, until the every-2-minutes change).
 *
 * 26 Jul: 10 → 2. Extraction saturated at 1-14 calls/tick against a 40 budget, so the extraction
 * budget stopped being the constraint and the idle between ticks became the whole of it.
 */
export const CONCEPT_CRON_MIN = 2;

export interface ConceptTickRow {
  ts: string; status: string; processed: number; stamped: number; extracted: number; rejected: number;
  epoch: number | null; note: string | null;
}
export interface ConceptStatusRaw {
  enabled: boolean; paused: boolean; epoch: number;
  coded: number | null; candidates: number | null; notYetCoded: number | null;
  stringsExtracted7d: number | null; concepts: number | null; stringsSeed: number | null;
  lastTick: ConceptTickRow | null; recentTicks: ConceptTickRow[];
}
export type ConceptState = 'draining' | 'idle' | 'paused' | 'disabled';
export interface ConceptStatus {
  state: ConceptState; epoch: number; paused: boolean;
  coded: number | null; candidates: number | null; not_yet_coded: number | null;
  cache_hit_pct: number | null; strings_extracted_7d: number | null; rejected_recent: number;
  concepts: number | null; strings_seed: number | null;
  last_tick: ConceptTickRow | null; recent_ticks: ConceptTickRow[]; coded_pct: number | null;
}

/** Flag off ⇒ 'disabled' (the panel explains itself rather than 404ing). Paused outranks pending work.
 *  'idle' once nothing eligible remains unreached; otherwise 'draining'. Pure. */
export function deriveConceptState(raw: Pick<ConceptStatusRaw, 'enabled' | 'paused' | 'notYetCoded'>): ConceptState {
  if (!raw.enabled) return 'disabled';
  if (raw.paused) return 'paused';
  return (raw.notYetCoded ?? 0) > 0 ? 'draining' : 'idle';
}

/** Percent of eligible findings that carry a concept. Null when the denominator is unknown/zero. */
export function codedPct(coded: number | null, candidates: number | null): number | null {
  if (coded == null || candidates == null || candidates <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((coded / candidates) * 1000) / 10));
}

/**
 * Share of recent STAMPS that needed no model call — the cost line. Defined over recent ticks as
 * `1 − extracted/stamped`, i.e. of the findings stamped, how many were resolved from the cache
 * rather than costing an extraction. Extraction is per unique STRING while stamping is per FINDING,
 * so this is a stamps-per-call efficiency, not a per-string hit rate — the panel labels it as such.
 * Null when nothing has been stamped yet (a zero-state must not read as 0% and look broken).
 * Clamped to [0,100]: a tick may extract strings whose findings land on a later tick.
 */
export function cacheHitPct(ticks: readonly ConceptTickRow[]): number | null {
  const stamped = ticks.reduce((n, t) => n + (Number(t.stamped) || 0), 0);
  const extracted = ticks.reduce((n, t) => n + (Number(t.extracted) || 0), 0);
  if (stamped <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - extracted / stamped) * 1000) / 10));
}

/** Extraction failures across the recent ticks — the number that must not hide behind the backlog. */
export function rejectedRecent(ticks: readonly ConceptTickRow[]): number {
  return ticks.reduce((n, t) => n + (Number(t.rejected) || 0), 0);
}

export function buildConceptStatus(raw: ConceptStatusRaw): ConceptStatus {
  const ticks = raw.recentTicks ?? [];
  return {
    state: deriveConceptState(raw),
    epoch: raw.epoch, paused: raw.paused,
    coded: raw.coded, candidates: raw.candidates, not_yet_coded: raw.notYetCoded,
    cache_hit_pct: cacheHitPct(ticks),
    strings_extracted_7d: raw.stringsExtracted7d,
    rejected_recent: rejectedRecent(ticks),
    concepts: raw.concepts, strings_seed: raw.stringsSeed,
    last_tick: raw.lastTick, recent_ticks: ticks,
    coded_pct: codedPct(raw.coded, raw.candidates),
  };
}

/** The distinct un-coded subjects in a batch of findings — the extraction work-list. Deduped, ordered
 *  by first appearance so a tick is deterministic. */
export function pendingSubjects<T extends StampableFinding>(findings: T[], known: (norm: string) => boolean): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of findings ?? []) {
    if (!f || f.concept_id || !isCodableFinding(f)) continue;
    const n = normalizeConceptSubject(f.subject);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    try { if (known(n)) continue; } catch { /* unknown ⇒ treat as pending */ }
    out.push(n);
  }
  return out;
}
