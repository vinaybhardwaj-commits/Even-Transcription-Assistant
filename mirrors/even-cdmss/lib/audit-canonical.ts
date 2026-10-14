/**
 * lib/audit-canonical.ts — ONE ROW PER AUDITED THING (PRD §1.2 for IPD; §12.3 FIX 0 for OPD).
 *
 * PURE, dependency-free, strip-types testable.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RULE, settled 27 Jul 2026; model tier added 31 Jul 2026 (addendum H); GRADER TIER added and
 * placed FIRST 2 Aug 2026 (GRADER-PROVENANCE PRD, V ruling D2):
 *
 *   Every read surface shows ONE row per identity: cloud-graded before local-model-graded
 *   (REGARDLESS of engine version); then the highest `engine_version`; then model tier
 *   (reference before candidate); then latest `audited_at`.
 *
 * The grader tier leads because a newer engine version does not make a local 14B model a better
 * grader than Gemini — and for a fortnight it did exactly that on the dashboard.
 *
 * Applied uniformly — list, calendar, doctor grouping, specialty counts, impact preview, and every
 * aggregate (mean, SD, band histogram, changing-band). Older re-audits remain STORED and reachable
 * from the report detail as history; they never contribute to a count, a mean or a histogram.
 *
 * THIS IS A READ FILTER. Nothing is updated, nothing is deleted.
 *
 * GENERALISED for Phase C. The rule is identical for both engines; only the IDENTITY COLUMN
 * differs — `document_id` for IPD discharge audits, `uid` for OPD note audits. `canonicalBy` takes
 * that key; `canonicalByDocument` and `canonicalByUid` are the two named bindings. There is exactly
 * one implementation, which is the entire point (see the note below).
 *
 * OPD is the worse case, MEASURED 27 Jul on live data: a 90-day window holds 25,128 audit rows over
 * 11,835 distinct notes — 52.9% duplicates. It bites hardest on the days an engine bump spans:
 * 2026-07-25 is 532 rows over 429 notes, and includes a `-mini` row.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY IT EXISTS. `ipd_discharge_audits` carries UNIQUE(document_id, engine_version) by design, so
 * one discharge summary can hold a 0.1 row AND a 0.2 row — and they disagree: IP-1253 is 95/C under
 * 0.1 and 88/D under 0.2. Counting both inflates every cohort statistic, and de-duplicating without
 * a stated rule silently picks one of two rows that contradict each other.
 *
 * ONE IMPLEMENTATION, DELIBERATELY. B-1 was two counts sitting side by side, each computed its own
 * way. The fix is not to make two implementations agree; it is to have one. Every surface calls
 * this function over rows it has already fetched — no surface writes its own DISTINCT ON.
 */

/** The minimum a row must carry to be ranked. Extra properties are preserved untouched. */
export interface CanonicalCandidate {
  /** IPD identity — one audit per discharge-summary document. */
  document_id?: unknown;
  /** OPD identity — one audit per db13 note uid. */
  uid?: unknown;
  engine_version?: unknown;
  /** Which model produced the row. Drives BOTH tiers: cloud-vs-local (first key, isLocalGrader) and
   *  reference-vs-candidate (after the version, isReferenceModel). They are different questions. */
  model?: unknown;
  audited_at?: unknown;
  id?: unknown;
}

/** Which column identifies "the same audited thing" for a given engine. */
export type IdentityKey = 'document_id' | 'uid';

/**
 * Mini/Qwen backfill rows share a document with the prod row, distinguished only by a `-mini`
 * engine-version suffix (lib/ipd-audit/store.ts IPD_MINI_ENGINE_VERSION). They are a different
 * MODEL of the same engine, not a newer version, and every prod read surface has always excluded
 * them. They must not win the ranking — note that lexicographically
 * `ipd-discharge-audit/0.2-mini` > `ipd-discharge-audit/0.2`, so a naive DESC sort would hand every
 * document to the backfill.
 */
export function isMiniEngine(engineVersion: unknown): boolean {
  return /-mini$/.test(String(engineVersion ?? ''));
}

/**
 * THE MODEL TIER (addendum H, 31 Jul 2026). `isMiniEngine` is not a defense against candidate-model
 * rows: the OPD mini backfill writes rows carrying the PLAIN production engine version
 * (`opd-note-audit/0.81.17`, `model = 'qwen2.5:14b'`), invisible to a `-mini` suffix check. Without
 * a tier, such a row written later in the day outranked a reference row at the same engine version
 * purely on the `audited_at` tiebreak — observed live on two notes, 31 Jul (kickoff §2).
 *
 * The tier is a TIEBREAK WITHIN an engine version, never across versions: a candidate row still
 * wins when it is the only row, or when it sits at a genuinely newer engine version. (Whether
 * reference should outrank candidate ACROSS versions affects 43% of the active corpus and is V's
 * call, recorded in the kickoff §6 — do not fold it in here.)
 *
 * A reference row is one whose model is a Gemini identifier — this list, not the engine version, is
 * the definition. Both spellings are live in the corpus: `google/gemini-2.5-pro` (via the
 * OpenRouter bridge, 31 Jul onward) and `gemini-2.5-pro` (pre-bridge Vertex). A future model name
 * is a one-line change HERE and nowhere else; `CANONICAL_RANK_SQL` below derives from this list.
 */
export const REFERENCE_MODELS = ['google/gemini-2.5-pro', 'gemini-2.5-pro'] as const;

/**
 * ══ THE BEDROCK GRADERS (Bedrock PRD §4.3.9, 7 Aug 2026) ═════════════════════════════════════
 *
 * The three Claude models the backfill runner may grade on. They are listed HERE, next to the two
 * predicates that classify them, because the classification was previously an ACCIDENT of two
 * negative checks — `isLocalGrader` is "not qwen and not -mini", `isReferenceModel` is "not in that
 * list" — and an accident is not a decision anyone can review or defend later.
 *
 * THE PLACEMENT, stated: a Bedrock row is a CLOUD grader (tier 0, key 1) and a CANDIDATE model
 * (tier 1, key 3). In words: it outranks a local qwen row regardless of engine version, and it
 * loses a same-version tie to a Gemini row.
 *
 *   · CLOUD, because the grader tier answers "is this grader competent to grade a doctor at all?"
 *     — a frontier model on Bedrock plainly is, and the tier exists to keep a local 14B from
 *     outranking Gemini, not to keep new cloud models out.
 *   · CANDIDATE, because Gemini remains the forward grader (PRD decision 6) and the reference for
 *     the distribution comparison. Backfill rows are the thing being compared, so they must not be
 *     able to win a tie against the thing they are compared to.
 *
 * ⚠️ NO NEW TIER, AND NO REORDERING. V refines the ordering after the first distribution comparison
 * (§4.3.9); until there is data, inventing a rank between "cloud reference" and "cloud candidate"
 * would be a guess wearing the costume of a rule.
 *
 * ⚠️ WHY THIS CANNOT COLLIDE IN PRACTICE TODAY, which is why no ordering change is urgent: the
 * store's primary key is (uid, engine_version) and the runner is fill-only, so a Bedrock row and a
 * Gemini row can never exist for the same note at the same engine version. Collisions are ACROSS
 * versions, where the version key decides — the accepted residual in PRD §4.3.8.
 *
 * ⚠️ NO CODE CHANGE WAS NEEDED, AND NO LIST LIVES HERE. The first cut of this added a
 * `BEDROCK_GRADER_MODELS` constant pulled in from lib/bedrock-core.ts — and the repo's own purity
 * test rejected it, on the raw text of this file: the module is dependency-free ON PURPOSE, and
 * taking a dependency is exactly how that stops being true. The existing predicates already classify a Bedrock row correctly (not qwen, not
 * `-mini` ⇒ cloud; not in REFERENCE_MODELS ⇒ candidate), including in CANONICAL_RANK_SQL, so a
 * second list would have added drift and bought nothing.
 *
 * WHAT PREVENTS DRIFT INSTEAD: lib/__tests__/backfill-runs-core.test.ts imports the transport's
 * catalogue AND these predicates and asserts, for EVERY id in that catalogue, cloud + candidate — and that a
 * bedrock row beats a qwen row while losing a same-version tie to Gemini. Adding a fourth model to
 * lib/bedrock-core.ts puts it under that assertion automatically. The invariant is pinned where
 * dependencies are free, and this file stays what its header claims.
 */

/** Reference-model predicate. Unknown/absent model ranks as candidate. */
export function isReferenceModel(model: unknown): boolean {
  return (REFERENCE_MODELS as readonly string[]).includes(String(model ?? ''));
}

/** 0 = reference, 1 = candidate — the reference tiebreak, applied WITHIN a grader tier. */
function modelTier(model: unknown): number {
  return isReferenceModel(model) ? 0 : 1;
}

/**
 * THE GRADER TIER (GRADER-PROVENANCE PRD, V ruled D2, 2 Aug 2026) — cloud before local, and it
 * outranks the engine version.
 *
 * ⚠️ THIS IS A DIFFERENT QUESTION FROM `REFERENCE_MODELS`, and the two must not be conflated.
 * `isReferenceModel` answers "reference or candidate?" — a bake-off question between CLOUD models,
 * and it stays where it was, breaking cloud-vs-cloud ties after the version. This predicate answers
 * "was this graded in the cloud, or by the local 14B?" — a provenance question about who is
 * competent to grade a doctor at all. Overloading one list to answer both would mislead the next
 * reader and silently re-tier every future model added for bake-off reasons.
 *
 * WHY IT SITS AHEAD OF THE VERSION: the mini backfill wrote `qwen2.5:14b` rows under the PLAIN
 * production engine label, so they carried a newer version than the Gemini rows they displaced and
 * won the ranking outright. Measured 1 Aug: 4 of 4 sampled notes scored LOWER on qwen and dropped a
 * band, with the disagreeing cloud judgment sitting one row away where nobody looks. A newer engine
 * version does not make a 14B local model a better grader than Gemini, so version can no longer
 * promote it. Prod mode is deleted too (D1), but deletion alone would not have re-ranked the ~500
 * rows already written — the tier is the guard, the deletion is the cause removed.
 *
 * A row is LOCAL when its model is a qwen identifier OR its engine version carries the `-mini`
 * suffix. Either signal alone is sufficient: the suffix catches correctly-labelled mini rows whose
 * model string is unknown, and the model check catches the prod-labelled contamination the suffix
 * misses — which is exactly the hole this PRD closes.
 */
export function isLocalGrader(model: unknown, engineVersion?: unknown): boolean {
  return /^qwen/i.test(String(model ?? '')) || isMiniEngine(engineVersion);
}

/** 0 = cloud, 1 = local — the FIRST key of THE RULE's ordering (D2). */
function graderTier(model: unknown, engineVersion: unknown): number {
  return isLocalGrader(model, engineVersion) ? 1 : 0;
}

/**
 * Compare two engine versions. Returns >0 when `a` is NEWER than `b`.
 *
 * The numeric tail (`ipd-discharge-audit/0.2` → [0, 2]) is compared component-wise when BOTH sides
 * parse, so a future `0.10` correctly beats `0.2` — the trap a plain lexicographic sort walks into.
 * Anything unparseable falls back to a string compare rather than throwing, so an unexpected tag
 * degrades to a defined order instead of taking a page down.
 */
export function compareEngineVersion(a: unknown, b: unknown): number {
  const sa = String(a ?? ''), sb = String(b ?? '');
  if (sa === sb) return 0;
  const parts = (s: string): number[] | null => {
    const tail = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
    if (!/^\d+(\.\d+)*$/.test(tail)) return null;
    return tail.split('.').map(Number);
  };
  const pa = parts(sa), pb = parts(sb);
  if (pa && pb) {
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  }
  return sa < sb ? -1 : 1;
}

function auditedAtMs(v: unknown): number {
  if (v == null) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

export interface CanonicalOptions {
  /** Default true — mini/Qwen backfill rows are dropped before ranking. */
  excludeMini?: boolean;
}

/**
 * Reduce a fetched row set to one row per identity, per THE RULE.
 *
 * · Input order does NOT affect the result (the comparator is total on the ranking keys).
 * · Rows with no identity value are PASSED THROUGH rather than dropped — losing a row because a
 *   column was null would be a silent data loss, and the caller asked for these rows.
 * · Relative order of the surviving rows is preserved, so an ORDER BY applied in SQL still holds.
 * · Never throws.
 */
export function canonicalBy<T extends CanonicalCandidate>(rows: T[], key: IdentityKey, opts: CanonicalOptions = {}): T[] {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return [];
  const excludeMini = opts.excludeMini !== false;

  const eligible = excludeMini ? list.filter((r) => !isMiniEngine(r.engine_version)) : list;
  // If excluding mini would empty the set, keep what we had: showing a backfill row is better than
  // showing nothing, and this can only happen on a document prod has never audited.
  const source = eligible.length ? eligible : list;

  const winner = new Map<string, T>();
  const passthrough: T[] = [];
  for (const r of source) {
    const raw = (r as Record<string, unknown>)[key];
    const identity = raw == null ? '' : String(raw);
    if (!identity) { passthrough.push(r); continue; }
    const cur = winner.get(identity);
    if (!cur) { winner.set(identity, r); continue; }
    // D2 (2 Aug 2026): grader tier FIRST — a cloud audit outranks a local-model audit regardless of
    // engine version. Ahead of the version compare on purpose; see isLocalGrader.
    const byGrader = graderTier(cur.model, cur.engine_version) - graderTier(r.model, r.engine_version);
    if (byGrader > 0) { winner.set(identity, r); continue; }
    if (byGrader < 0) continue;
    const byEngine = compareEngineVersion(r.engine_version, cur.engine_version);
    if (byEngine > 0) { winner.set(identity, r); continue; }
    if (byEngine < 0) continue;
    // Tie on engine version → reference model outranks candidate (addendum H)…
    const byTier = modelTier(cur.model) - modelTier(r.model);
    if (byTier > 0) { winner.set(identity, r); continue; }
    if (byTier < 0) continue;
    // …then latest audited_at wins.
    if (auditedAtMs(r.audited_at) > auditedAtMs(cur.audited_at)) winner.set(identity, r);
  }

  const kept = new Set<T>([...winner.values(), ...passthrough]);
  return source.filter((r) => kept.has(r));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE SQL TWIN (31 Jul 2026, addendum C)
//
// "Every surface calls this function over rows it has already fetched" holds only for surfaces that
// FETCH rows. Four doctor aggregates compute their answer in SQL — count(*), avg(), GROUP BY — and
// never return the rows, so a TypeScript filter cannot deduplicate what was never sent. Those need
// the rule expressed in SQL.
//
// ONE RULE, TWO EXPRESSIONS, and the same reasoning as ONE IMPLEMENTATION above: they are declared
// adjacent, and a test feeds the SAME fixture to both and asserts they pick the same row. Editing
// one without the other fails that test rather than silently creating a sixth posture.
//
// TWO TRAPS THE ORDERING MUST HANDLE — both are the SQL form of what compareEngineVersion and
// isMiniEngine already handle above:
//
//   1. LEXICOGRAPHIC ORDERING IS WRONG. `ORDER BY engine_version DESC` ranks
//      `opd-note-audit/0.81.9` ABOVE `opd-note-audit/0.81.17`, because '9' > '1'. The numeric tail
//      must be compared component-wise, which `string_to_array(...)::int[]` does natively — int[]
//      comparison in Postgres is element-wise, exactly like compareEngineVersion's loop.
//
//   2. `-mini` SORTS ABOVE ITS BASE VERSION, and its tail does not cast to int[]
//      ('14-mini' is not an integer), so the cast would RAISE rather than mis-rank.
//      ⚠️ DEPENDENCY, DELIBERATE: the int[] CAST is still made safe only by the caller's
//      `engine_version = ANY(OPD_ENGINE_VERSIONS_CURRENT)` filter — no family entry carries a
//      `-mini` suffix, so every surviving tail casts cleanly. Adding a `-mini` entry to
//      OPD_ENGINE_VERSIONS_CURRENT breaks this cast; the family filter is what makes the bare cast
//      safe, and the two must still be changed together.
//
//      ⚠️ WHAT CHANGED, 2 Aug 2026 (GRADER-PROVENANCE PRD, D2). This comment used to assert that
//      mini rows were excluded before ranking and that no guard was therefore needed here.
//      THAT ASSUMPTION WAS FALSE and the missing guard was doctor-facing. The mini backfill wrote
//      `qwen2.5:14b` rows under the PLAIN production engine label: no `-mini` suffix, so the family
//      filter passed them straight through to the ranking, where their newer version beat the real
//      Gemini rows. Measured: 4 of 4 sampled notes scored lower on qwen and dropped a band.
//      THE GUARD NOW EXISTS AND IS THE GRADER TIER — the first key below, cloud before local, ahead
//      of the version. Prod mode is deleted (D1) so the label can no longer be forged, but the tier
//      is what protects the ranking, including for the rows already written. The suffix filter is
//      no longer the only thing standing between a local 14B model and a doctor's band.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The ranking tail of THE RULE as SQL, in four keys (D2, 2 Aug 2026):
 *   1. GRADER TIER — cloud (0) before local qwen/-mini (1). Ahead of the version on purpose.
 *   2. highest engine version (component-wise numeric tail).
 *   3. reference model before candidate — REFERENCE_MODELS, the single definition. A DIFFERENT
 *      question from key 1 (cloud bake-off, not cloud-vs-local); see isLocalGrader.
 *   4. latest `audited_at`.
 * Goes after `ORDER BY <identity>,` in a DISTINCT ON, or use `canonicalDistinctOnSql`. The caller's
 * engine-family filter is still what makes the int[] cast safe — see trap 2 above.
 *
 * Both CASEs read the base table's `model` column. It does NOT need to appear in the caller's
 * select list: with DISTINCT ON, Postgres permits ORDER BY on unselected base-table columns
 * (verified live, 31 Jul 2026) — the plain-DISTINCT restriction does not apply.
 */
export const CANONICAL_RANK_SQL =
  `CASE WHEN model LIKE 'qwen%' OR engine_version LIKE '%-mini' THEN 1 ELSE 0 END, ` +
  `string_to_array(split_part(engine_version, '/', 2), '.')::int[] DESC, ` +
  `CASE WHEN model IN (${REFERENCE_MODELS.map((m) => `'${m}'`).join(', ')}) THEN 0 ELSE 1 END, ` +
  `audited_at DESC`;

/**
 * A DISTINCT ON subquery selecting the canonical row per identity — the SQL twin of `canonicalBy`.
 * Wrap an aggregate around this so `count(*)`/`avg()` see one row per note, and so a LIMIT counts
 * canonical rows rather than duplicates.
 *
 * `table` and `where` are composed by the caller (this module stays table-agnostic and takes no
 * imports); `where` must already carry the engine-family filter that makes the cast safe.
 */
export function canonicalDistinctOnSql(
  opts: { table: string; identity: IdentityKey; cols: string; where: string },
): string {
  return `SELECT DISTINCT ON (${opts.identity}) ${opts.identity}, ${opts.cols}
          FROM ${opts.table}
          WHERE ${opts.where}
          ORDER BY ${opts.identity}, ${CANONICAL_RANK_SQL}`;
}

/** IPD: one row per discharge-summary document. */
export function canonicalByDocument<T extends CanonicalCandidate>(rows: T[], opts: CanonicalOptions = {}): T[] {
  return canonicalBy(rows, 'document_id', opts);
}

/** OPD: one row per db13 note uid. Same rule, same code — only the identity column differs. */
export function canonicalByUid<T extends CanonicalCandidate>(rows: T[], opts: CanonicalOptions = {}): T[] {
  return canonicalBy(rows, 'uid', opts);
}

/**
 * Count canonical rows per speciality — the source of the filter chips.
 *
 * Takes the SAME canonical rows the list renders, so the chip and the list cannot disagree by
 * construction. That structural guarantee is the whole point of B-1: two numbers on one screen must
 * not be computed two ways.
 *
 * `unassignedLabel` is the option that selects rows whose speciality is null/blank.
 */
export function specialityCounts<T extends CanonicalCandidate & { speciality?: unknown }>(
  rows: T[],
  unassignedLabel: string,
): { speciality: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const raw = r?.speciality == null ? '' : String(r.speciality).trim();
    const key = raw === '' ? unassignedLabel : raw;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([speciality, n]) => ({ speciality, n }))
    .sort((a, b) => b.n - a.n || a.speciality.localeCompare(b.speciality));
}

/** Apply the speciality filter to canonical rows, mirroring the chip's own bucketing exactly. */
export function filterBySpeciality<T extends CanonicalCandidate & { speciality?: unknown }>(
  rows: T[],
  speciality: string | null | undefined,
  unassignedLabel: string,
): T[] {
  const want = String(speciality ?? '').trim();
  if (!want || want === 'all') return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    const raw = r?.speciality == null ? '' : String(r.speciality).trim();
    return (raw === '' ? unassignedLabel : raw) === want;
  });
}
