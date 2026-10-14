/**
 * lib/lab-v2/tools/corpus.ts — `corpus_stage`, `corpus_validate`, `corpus_diff`
 * (LAB-MCP-V2-PRD-v1.0 §17.7, decisions 79a and 83).
 *
 * ⚠️ NOTHING IN THIS FILE WRITES TO `mksap_chunks`. Staging new text goes through v1's own
 * `corpusAddQuarantined` (`lib/lab.ts:157`), imported and called; everything else here is a
 * SELECT. `c1-release.test.ts` greps this file and `lib/lab-v2/releases/**` for INSERT, UPDATE or
 * DELETE against `mksap_chunks` or `lvc_*` and fails on any hit but the one statement decision 80a
 * puts in `releases/corpus-writer.ts`.
 *
 * ⚠️ THE STAGED SET IS A LABEL, NOT AN ID LIST — DECISION 79a. v1's activation is keyed on the
 * source label (`UPDATE … WHERE source = 'labq:<label>'`), not on ids, so the unit that can
 * actually be activated is one `labq:<label>`. `corpus_stage` therefore pins a label AND records
 * the exact ids under it at that moment; `release_apply` re-reads them and refuses
 * `STAGED_SET_CHANGED` if they differ. The id list is not what gets activated — it is what makes
 * an activation checkable.
 *
 * ⚠️ EVERY READ HERE IS INFERRED and is listed verbatim in the build report. The `mksap_chunks`
 * columns were read live from `information_schema` on 06 Sep 2026 — 23 of them, `id` is **bigint**,
 * `visible` is NOT NULL, `embedding` is a USER-DEFINED (vector) type — before this file was
 * written. Every read goes through `boundedRead`: the v1 read-only guard and decision 31's 15 s
 * deadline. Ids are coerced at the boundary (decision 72): bigint arrives as a string.
 */
import { z } from 'zod';
import { LabError, hash } from '../contracts';
import { boundedRead } from '../sources/read';
import { corpusAddQuarantined, labLabel } from '../../lab';
import { QUARANTINE_PREFIX } from '../releases/corpus-writer';
import { buildFilterClauses, defaultBm25Sql, renderFilterSql } from '../../retrieve';
import { embedQuery, vectorLiteral } from '../../llm';
import { fuse, rankCorrelation } from './retrieval-compare';
import { freezeQueryFor } from '../sources/opd';
import { getObject } from '../store';
import type { Db } from '../db';

const SOURCE = 'mksap_chunks';

/** A slug, refused rather than escaped. `labLabel` is v1's own sanitiser; this is the gate before it. */
/**
 * DECISION 86 — the quarantined source a label names, validated and then BOUND.
 *
 * ⚠️ WHAT WENT WRONG ON `8110b22f`, AND IT WAS FOUND IN PRODUCTION. Every label-keyed read built
 * `WHERE source = '<label>'`. The rows live under `source = 'labq:<label>'`, so the reader matched
 * NOTHING: `corpus_stage` wrote chunk 4145293 under `labq:lab-v2-c1-verify` through v1's own
 * ingest — visible false, embedding and tsvector present, confirmed in Neon — and then returned
 * `CASE_NOT_FOUND` for the label it had just written. `corpus_validate` did the same on that label
 * and on the pre-existing `labq:guidelines-lvc-22jul`, 15 real rows. The predicate had never been
 * exercised: every test injected its read, and the one assertion about the string encoded the bug.
 *
 * ⚠️ AND THE SOURCE IS NOW A BOUND PARAMETER, not an interpolated literal. Decision 86 says
 * `WHERE source = $1` with `$1 = 'labq:' || slug`. The slug is still validated — v1's `labLabel`
 * is a sanitiser, not a gate, and `''` slugs to `default` — but the value reaches the statement as
 * a parameter, so the statement itself has no interpolation to get wrong.
 *
 * ⚠️ AND NO VISIBILITY PREDICATE. A quarantined row is `visible = false` by construction (v1's
 * `CORPUS_QUARANTINE_INSERT_SQL`), so a reader carrying `visible IS NOT FALSE` — the SERVABLE
 * predicate — would match none of them. Servability is what `corpus_diff` asks about the corpus;
 * it is the wrong question to ask about a staged batch, and asking it is the other way this reader
 * could have returned nothing.
 */
export function quarantinedSource(value: string): string {
  const l = labLabel(value);
  /**
   * v1's `labLabel` SLUGS rather than refuses, and one of its outputs is a trap.
   * `labLabel('')`, `labLabel('  ')` and `labLabel('!!!')` all return **`default`** — so a blank or
   * unusable label would silently address the batch named `default`. Measured 06 Sep 2026.
   *
   * Everything else it does is a genuine sanitisation and is trusted: `x'; DROP TABLE mksap_chunks --`
   * comes back as `x-drop-table-mksap_chunks`. The charset below is v1's own output alphabet.
   */
  if (l === 'default' && labLabel(String(value).trim()) !== String(value).trim().toLowerCase()) {
    throw new LabError('INVALID_INPUT', `label '${value}' slugs to 'default'; name the batch explicitly`);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(l)) {
    throw new LabError('INVALID_INPUT', `label '${value}' is not a corpus batch label`);
  }
  return `${QUARANTINE_PREFIX}${l}`;
}

/** §17.7 — the ceiling every corpus read shares. A batch at the ceiling is REFUSED at staging
 *  rather than silently truncated, because a truncated id set would make decision 79a's
 *  before/after comparison compare two truncations and call them equal. */
export const CORPUS_READ_LIMIT = 500;

/** ⚠️ bigint. `Number()` at the boundary, and a value that will not parse is refused, not floored. */
function idList(ids: readonly (number | string)[]): string {
  const clean = ids.map((v) => Number(v));
  if (!clean.length) throw new LabError('INVALID_INPUT', 'no chunk ids');
  for (const n of clean) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new LabError('INVALID_INPUT', `'${n}' is not a chunk id`);
  }
  return clean.join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The inferred reads
// ─────────────────────────────────────────────────────────────────────────────────────

/** The staged batch, with everything `corpus_validate` needs to judge it. Never the embedding
 *  itself — a 768-float vector in a tool response is noise; whether it EXISTS is the question. */
export const STAGED_CHUNKS_SQL = `SELECT
  id, book, chapter, section, source, chunk_type, token_count, visible,
  length(text) AS text_chars,
  left(text, 240) AS preview,
  (embedding IS NOT NULL) AS has_embedding,
  (text_tsv IS NOT NULL) AS has_tsv,
  text_hash
FROM mksap_chunks
WHERE source = $1
ORDER BY id
LIMIT 500`;

/**
 * Just the ids. Deliberately its own statement: the check that decides whether a production write
 * may proceed should not depend on a projection someone might widen later.
 *
 * ⚠️ NO PREDICATE BUT THE SOURCE. Decision 86: every row under the label, whatever its visibility.
 */
export const STAGED_IDS_SQL = `SELECT id FROM mksap_chunks WHERE source = $1 ORDER BY id LIMIT 500`;

/**
 * DECISION 88, AND A CORRECTION TO IT — measured against production Neon, 06 Sep 2026, before a
 * line was changed:
 *
 *     max(id) alone                       178 ms
 *     count(*) over the servable set   14,223 ms
 *     count(DISTINCT source)           30,527 ms
 *     the two counts together          29,451 ms
 *     the OVERLAP read                     57 ms
 *
 * Decision 88 attributes `corpus_diff`'s timeout to the overlap read. It is not the overlap read.
 * It is THIS statement: `count(DISTINCT source)` over 2,247,994 servable rows takes twice the 15 s
 * deadline on its own, and `count(*)` is already at it. The overlap read is two orders of magnitude
 * cheaper. Both are treated below, and the misattribution is flagged in the build report.
 *
 * ⚠️ SO THE SNAPSHOT IS ITS OWN STATEMENT. `max(id)` is what the impact estimate REQUIRES — it pins
 * both candidate sides to one corpus — and it is served by the primary key in 178 ms. Bundling it
 * with two counts that nothing depends on meant the whole tool died for a number that is decoration.
 */
export const MAX_CHUNK_ID_SQL = `SELECT max(id) AS max_chunk_id FROM mksap_chunks`;

/**
 * The servable set, exactly as `lib/retrieve.ts:167` defines it. REPORTING ONLY — nothing computed
 * from it feeds the impact estimate, which is why it is allowed to be skipped rather than fatal.
 */
export const VISIBLE_SUMMARY_SQL = `SELECT
  count(*) AS visible_chunks,
  count(DISTINCT source) AS visible_sources
FROM mksap_chunks
WHERE text IS NOT NULL AND visible IS NOT FALSE AND source NOT LIKE 'labq:%'`;

/**
 * Book/chapter overlap between the staged batch and what is already servable.
 *
 * ⚠️ KEYED TO THE STAGED SET'S BOOKS, BOUND — decision 88. The first shape was a row-comparison
 * `IN` subquery over `(book, COALESCE(chapter, ''))`, which no index can serve: `mksap_chunks` has
 * a btree on `book` and nothing on the pair. It measured 57 ms only because neither quarantined
 * batch on production has a book with a servable twin, so the nested loop had nothing to walk. A
 * batch staged into a book that already has a hundred thousand servable chunks would have found
 * that out the hard way. `book = ANY($1)` uses `mksap_chunks_book_idx` and is a bitmap heap scan.
 *
 * ⚠️ THE BOOKS ARE THE KEY, THE PAIRS ARE THE FILTER. Binding books alone would report a
 * (book, chapter) pair the staged set does not have — the same book, a different chapter. The
 * caller intersects the result with the staged pairs, so the SQL is indexable and the answer is
 * exact. Doing the pair match in SQL would need a VALUES join built by interpolation, which is a
 * worse trade than four lines of set arithmetic.
 */
export const OVERLAP_SQL = `SELECT
  c.book, c.chapter,
  count(*) AS visible_chunks
FROM mksap_chunks c
WHERE c.text IS NOT NULL AND c.visible IS NOT FALSE AND c.source NOT LIKE 'labq:%'
  AND c.book = ANY($1)
GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 100`;

/**
 * DECISION 83 — the near-duplicate check, and the reason it is a separate statement.
 *
 * `similarity()` is `pg_trgm`. The extension is NOT installed on production Neon (measured
 * 06 Sep 2026), so this statement cannot run there and `corpus_validate` reports the check as
 * **skipped**, with the reason. It is never reported as passed: "we did not look" and "we looked
 * and found nothing" are different claims, and only one of them is safe to act on.
 */
export const NEAR_DUPLICATE_SQL = (threshold: number) => `SELECT
  s.id AS staged_id,
  v.id AS visible_id,
  v.source AS visible_source,
  round(similarity(s.text, v.text)::numeric, 3) AS similarity
FROM mksap_chunks s
JOIN mksap_chunks v
  ON v.text IS NOT NULL AND v.visible IS NOT FALSE AND v.source NOT LIKE 'labq:%'
 AND v.book = s.book
 AND similarity(s.text, v.text) > ${Number(threshold)}
WHERE s.source = $1
ORDER BY 4 DESC LIMIT 100`;

/** Is `pg_trgm` there at all? Asked before the check, so a missing extension is a reported SKIP
 *  rather than a caught exception that could be mistaken for "no duplicates". */
export const PG_TRGM_SQL = `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS installed`;

/** The current `(id, source, visible)` of a set — the predecessor state a release records. */
export const CHUNK_STATE_SQL = (ids: readonly (number | string)[]) =>
  `SELECT id, source, visible FROM mksap_chunks WHERE id IN (${idList(ids)}) ORDER BY id LIMIT 500`;

// ── the two candidate legs for corpus_diff's impact estimate ──────────────────────────
/**
 * ⚠️ THE LEGS ARE PRODUCTION'S OWN BUILDERS, AND SIDE B USES PRODUCTION'S OWN QUARANTINE SEAM.
 *
 * `buildFilterClauses({ includeQuarantined: label })` is the lab measurement seam `lib/retrieve.ts`
 * already ships (`corpus_retrieve`'s `includeQuarantined`): it relaxes BOTH quarantine guards for
 * ONE named batch, by a bound parameter, and can never widen further. Side A omits it. So the only
 * difference between the two sides is the staged batch — which is what an impact estimate is.
 *
 * Both sides are pinned to the same `max_chunk_id`, so a concurrent ingest cannot move one side
 * under the other while the comparison runs.
 */
export function candidateLegs(label: string | null, maxChunkId: number) {
  const snapshot = ` AND id <= ${Math.floor(maxChunkId)}`;
  const { clauses, params } = buildFilterClauses(label ? { includeQuarantined: labLabel(label) } : {});
  return {
    vector: {
      sql: `SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
FROM mksap_chunks
WHERE 1 - (embedding <=> $1::vector) > $2
  AND embedding IS NOT NULL
  AND ${renderFilterSql(clauses, 3)}${snapshot}
ORDER BY embedding <=> $1::vector
LIMIT 60`,
      params,
    },
    bm25: { sql: defaultBm25Sql(`${renderFilterSql(clauses, 2)}${snapshot}`, 60), params },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────────────

const stagedChunk = z.object({
  id: z.number().int(),
  book: z.string().nullable(),
  chapter: z.string().nullable(),
  source: z.string().nullable(),
  chunk_type: z.string().nullable(),
  text_chars: z.number().int(),
  preview: z.string(),
  has_embedding: z.boolean(),
  has_tsv: z.boolean(),
  visible: z.boolean(),
});

export const CORPUS_SCHEMAS = {
  corpus_stage: {
    input: z.object({
      label: z.string().min(1).max(64),
      /** Optional: add new material through v1's own quarantined-insert path first. */
      add: z.object({
        book: z.string().min(1).max(200),
        text: z.string().min(20).max(200_000),
        chapter: z.string().max(200).optional(),
        section: z.string().max(200).optional(),
        citation_url: z.string().max(500).optional(),
        provenance: z.string().max(500).optional(),
      }).optional(),
      idempotency_key: z.string().min(1),
    }),
    output: z.object({
      staged_set_id: z.string().uuid(),
      label: z.string(),
      source: z.string(),
      hash: z.string(),
      deduplicated: z.boolean(),
      chunk_ids: z.array(z.number().int()),
      added: z.object({ chunks: z.number().int(), inserted: z.number().int(), skipped_dup: z.number().int() }).nullable(),
    }),
  },
  corpus_validate: {
    input: z.object({ staged_set_id: z.string().uuid().optional(), label: z.string().min(1).max(64).optional() }),
    output: z.object({
      label: z.string(),
      chunks: z.number().int(),
      ok: z.boolean(),
      checks: z.array(z.object({
        name: z.string(),
        status: z.enum(['passed', 'failed', 'skipped']),
        /** Present on skipped and failed. A skipped check ALWAYS says why. */
        detail: z.string().nullable(),
        offenders: z.array(z.union([z.number().int(), z.string()])),
      })),
      near_duplicates: z.array(z.object({
        staged_id: z.number().int(), visible_id: z.number().int(),
        visible_source: z.string().nullable(), similarity: z.number(),
      })),
      sample: z.array(stagedChunk),
    }),
  },
  corpus_diff: {
    input: z.object({
      label: z.string().min(1).max(64),
      /** A B1 cohort dataset. Its cases' freeze queries are what the impact is measured on. */
      dataset_id: z.string().uuid().optional(),
      queries: z.array(z.string().min(3).max(2000)).max(20).optional(),
      k: z.number().int().min(1).max(50).default(10),
    }),
    output: z.object({
      label: z.string(),
      staged: z.object({ chunks: z.number().int(), books: z.array(z.string()), chunk_ids: z.array(z.number().int()) }),
      visible: z.object({
        /** Null when the count exceeded the read deadline — see `visible_status`. */
        chunks: z.number().int().nullable(),
        sources: z.number().int().nullable(),
        /** Always present: it is the snapshot both impact sides are pinned to. */
        max_chunk_id: z.number().int(),
      }),
      /** DECISION 88 — `skipped` never means zero, and never means the tool failed. */
      visible_status: z.enum(['ok', 'skipped']),
      overlap_status: z.enum(['ok', 'skipped']),
      skipped_detail: z.record(z.string()).nullable(),
      overlap: z.array(z.object({ book: z.string().nullable(), chapter: z.string().nullable(), visible_chunks: z.number().int() })),
      impact: z.object({
        /** Structurally zero: no chat model and no reranker is reachable from this tool. */
        model_calls: z.number().int(),
        embeddings: z.number().int(),
        queries: z.number().int(),
        snapshot_max_chunk_id: z.number().int(),
        /** How many of the sampled queries would surface a staged chunk in their top k. */
        queries_affected: z.number().int(),
        mean_overlap_at_k: z.number().nullable(),
        mean_rank_correlation: z.number().nullable(),
        per_query: z.array(z.object({
          query_hash: z.string(),
          staged_in_top_k: z.array(z.number().int()),
          overlap_at_k: z.number().int(),
          rank_correlation: z.number().nullable(),
        })),
      }),
    }),
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────────────

export interface CorpusDeps {
  read?: <T>(source: string, statement: string, params?: unknown[]) => Promise<T[]>;
  add?: typeof corpusAddQuarantined;
  embed?: (text: string) => Promise<number[]>;
}

const liveRead = <T>(source: string, statement: string, params: unknown[] = []) => boundedRead<T>(source, statement, params, 500);

/** bigint → number, at the boundary, once (decision 72). */
const asIds = (rows: Record<string, unknown>[]): number[] =>
  rows.map((r) => Number(r.id)).filter((n) => Number.isSafeInteger(n) && n > 0);

export async function readStagedIds(label: string, deps: CorpusDeps = {}): Promise<number[]> {
  const read = deps.read ?? liveRead;
  return asIds(await read<Record<string, unknown>>(SOURCE, STAGED_IDS_SQL, [quarantinedSource(label)]));
}

export async function corpusStage(
  db: Db, principal: string, args: { label: string; add?: Record<string, unknown>; idempotency_key: string },
  deps: CorpusDeps = {},
) {
  const read = deps.read ?? liveRead;
  const label = labLabel(args.label);
  let added: { chunks: number; inserted: number; skipped_dup: number } | null = null;
  if (args.add) {
    // v1's OWN path. The quarantine INSERT, the nomic embed and the (book, text_hash) conflict
    // rule are all its business, and copying any of them here would be a second ingest.
    const out = await (deps.add ?? corpusAddQuarantined)({
      label,
      book: String(args.add.book),
      text: String(args.add.text),
      chapter: args.add.chapter == null ? undefined : String(args.add.chapter),
      section: args.add.section == null ? undefined : String(args.add.section),
      citationUrl: args.add.citation_url == null ? undefined : String(args.add.citation_url),
      provenance: args.add.provenance == null ? undefined : String(args.add.provenance),
    } as Parameters<typeof corpusAddQuarantined>[0]);
    added = { chunks: out.chunks, inserted: out.inserted, skipped_dup: out.skipped_dup };
  }

  const chunk_ids = asIds(await read<Record<string, unknown>>(SOURCE, STAGED_IDS_SQL, [quarantinedSource(label)]));
  if (!chunk_ids.length) {
    throw new LabError('CASE_NOT_FOUND', `no quarantined chunks under labq:${label} — stage some text, or check the label`);
  }
  if (chunk_ids.length >= CORPUS_READ_LIMIT) {
    // At the ceiling the id list may be truncated, and a truncated set compared against another
    // truncated set at apply time would look unchanged. Refuse rather than record a set that
    // cannot be verified.
    throw new LabError('INVALID_INPUT',
      `labq:${label} holds ${chunk_ids.length} chunks, at or over the ${CORPUS_READ_LIMIT} read ceiling; split the batch so the staged set can be verified at apply`);
  }
  const body = { kind: 'staged_set', target: 'corpus', label, source: `labq:${label}`, chunk_ids, staged_at: new Date().toISOString() };
  // ⚠️ The object is content-addressed, so the SAME label with the SAME ids is the same staged set.
  // `staged_at` would break that, so it is excluded from the hash by hashing the stable part.
  const stableHash = hash({ label, chunk_ids });
  const { putObject } = await import('../store');
  const { object, deduplicated } = await putObject(db, principal, 'staged_set', { ...body, stable_hash: stableHash }, 'deidentified', args.idempotency_key);
  return {
    staged_set_id: object.id, label, source: `labq:${label}`, hash: object.hash,
    deduplicated, chunk_ids, added,
  };
}

export async function corpusValidate(
  db: Db, args: { staged_set_id?: string; label?: string }, deps: CorpusDeps = {},
) {
  const read = deps.read ?? liveRead;
  const label = await labelFor(db, args);
  const rows = await read<Record<string, unknown>>(SOURCE, STAGED_CHUNKS_SQL, [quarantinedSource(label)]);
  if (!rows.length) throw new LabError('CASE_NOT_FOUND', `no quarantined chunks under labq:${label}`);

  const chunks = rows.map((r) => ({
    id: Number(r.id),
    book: r.book == null ? null : String(r.book),
    chapter: r.chapter == null ? null : String(r.chapter),
    source: r.source == null ? null : String(r.source),
    chunk_type: r.chunk_type == null ? null : String(r.chunk_type),
    text_chars: Number(r.text_chars ?? 0),
    preview: String(r.preview ?? ''),
    has_embedding: r.has_embedding === true,
    has_tsv: r.has_tsv === true,
    visible: r.visible === true,
  }));

  const checks: { name: string; status: 'passed' | 'failed' | 'skipped'; detail: string | null; offenders: (number | string)[] }[] = [];
  const check = (name: string, offenders: (number | string)[], detail: string | null = null) =>
    checks.push({ name, status: offenders.length ? 'failed' : 'passed', detail: offenders.length ? detail : null, offenders });

  check('text_present', chunks.filter((c) => c.text_chars < 20).map((c) => c.id), 'a chunk under 20 characters is not a passage');
  check('has_embedding', chunks.filter((c) => !c.has_embedding).map((c) => c.id), 'retrieval cannot reach a chunk with no vector');
  check('has_tsv', chunks.filter((c) => !c.has_tsv).map((c) => c.id), 'the BM25 leg cannot reach a chunk with no tsvector');
  check('has_book', chunks.filter((c) => !c.book).map((c) => c.id), 'a citation with no book renders as an anonymous chip');
  check('has_chapter', chunks.filter((c) => !c.chapter).map((c) => c.id), 'a chapter is what a reader follows back to the source');
  check('has_source', chunks.filter((c) => !c.source).map((c) => c.id), null);
  // ⚠️ Quarantine means invisible (v1's CORPUS_QUARANTINE_INSERT_SQL writes visible = false). A
  // staged chunk that is already visible was activated by something else and is not stageable.
  check('still_quarantined', chunks.filter((c) => c.visible || !String(c.source).startsWith('labq:')).map((c) => c.id),
    'this chunk is already live; it cannot be staged for activation');

  // ── decision 83 — the near-duplicate check, skipped where it cannot run ──────────────
  let near: { staged_id: number; visible_id: number; visible_source: string | null; similarity: number }[] = [];
  const trgm = await read<{ installed: unknown }>(SOURCE, PG_TRGM_SQL).catch(() => []);
  const installed = trgm[0]?.installed === true;
  if (!installed) {
    checks.push({
      name: 'near_duplicate',
      // ⚠️ SKIPPED, NEVER PASSED. "We did not look" and "we looked and found nothing" are different
      // claims and only one of them is safe to act on.
      status: 'skipped',
      detail: 'skipped: pg_trgm not installed — similarity() is unavailable on this database, so near-duplicate detection did not run. This is NOT a pass.',
      offenders: [],
    });
  } else {
    const dups = await read<Record<string, unknown>>(SOURCE, NEAR_DUPLICATE_SQL(0.9), [quarantinedSource(label)]);
    near = dups.map((d) => ({
      staged_id: Number(d.staged_id), visible_id: Number(d.visible_id),
      visible_source: d.visible_source == null ? null : String(d.visible_source),
      similarity: Number(d.similarity),
    }));
    check('near_duplicate', near.map((d) => d.staged_id), 'trigram similarity above 0.9 against a chunk that is already servable');
  }

  return {
    label,
    chunks: chunks.length,
    // ⚠️ A SKIPPED CHECK DOES NOT MAKE `ok` FALSE, and it does not make it true either — `ok` is
    // "nothing FAILED", and the checks array is what a reader must actually read.
    ok: checks.every((c) => c.status !== 'failed'),
    checks,
    near_duplicates: near,
    sample: chunks.slice(0, 25),
  };
}

async function labelFor(db: Db, args: { staged_set_id?: string; label?: string }): Promise<string> {
  if (args.label) return labLabel(args.label);
  if (!args.staged_set_id) throw new LabError('INVALID_INPUT', 'one of staged_set_id or label is required');
  const obj = await getObject(db, args.staged_set_id);
  const body = (obj?.body ?? {}) as { label?: string; kind?: string };
  if (!obj || body.kind !== 'staged_set' || !body.label) {
    throw new LabError('NOT_FOUND', `no staged set ${args.staged_set_id}`);
  }
  return labLabel(body.label);
}

export async function corpusDiff(
  db: Db, args: { label: string; dataset_id?: string; queries?: string[]; k?: number }, deps: CorpusDeps = {},
) {
  const read = deps.read ?? liveRead;
  const embed = deps.embed ?? embedQuery;
  const label = labLabel(args.label);
  const k = Math.floor(args.k ?? 10);

  const staged = await read<Record<string, unknown>>(SOURCE, STAGED_CHUNKS_SQL, [quarantinedSource(label)]);
  if (!staged.length) throw new LabError('CASE_NOT_FOUND', `no quarantined chunks under labq:${label}`);
  const stagedIds = asIds(staged);
  const stagedSet = new Set(stagedIds);

  /**
   * DECISION 88 — REQUIRED, THEN BEST-EFFORT, IN THAT ORDER.
   *
   * The snapshot is required: the impact estimate cannot pin its two sides without it, and it costs
   * 178 ms. The two counts and the overlap are DECORATION on an impact estimate — useful, and not
   * worth failing the tool for. Each is attempted under the same 15 s deadline and each degrades to
   * `skipped` on its own, with the reason, so a reader is never shown a zero that means "we could
   * not count".
   */
  const maxRow = (await read<Record<string, unknown>>(SOURCE, MAX_CHUNK_ID_SQL))[0] ?? {};
  const maxChunkId = Number(maxRow.max_chunk_id ?? 0);
  if (!maxChunkId) throw new LabError('SOURCE_UNAVAILABLE', 'the corpus reported no max chunk id; the impact estimate cannot be pinned to a snapshot');

  const skipped: Record<string, string> = {};
  /** A read whose failure is reportable rather than fatal. Only SOURCE_UNAVAILABLE degrades —
   *  anything else is a bug in the statement and must still surface. */
  const optional = async <T,>(name: string, statement: string, params: unknown[] = []): Promise<T[] | null> => {
    try {
      return await read<T>(SOURCE, statement, params);
    } catch (e) {
      const err = e as LabError;
      if (err.code !== 'SOURCE_UNAVAILABLE') throw err;
      skipped[name] = `skipped: ${String(err.message).slice(0, 200)}`;
      return null;
    }
  };

  const visRows = await optional<Record<string, unknown>>('visible', VISIBLE_SUMMARY_SQL);
  const vis = visRows?.[0] ?? null;

  // The books the staged batch touches — the key the overlap read is bound to.
  const stagedBooks = [...new Set(staged.map((x) => (x.book == null ? '' : String(x.book))).filter(Boolean))];
  // The exact (book, chapter) pairs, which is what the caller actually asked about.
  const stagedPairs = new Set(staged.map((x) => `${String(x.book ?? '')}\u0000${String(x.chapter ?? '')}`));
  const overlapRows = stagedBooks.length
    ? await optional<Record<string, unknown>>('overlap', OVERLAP_SQL, [stagedBooks])
    : [];

  // ── the queries the impact is measured on ────────────────────────────────────────────
  const queries = args.queries?.length ? args.queries : await freezeQueriesOf(db, args.dataset_id);
  const legsA = candidateLegs(null, maxChunkId);
  const legsB = candidateLegs(label, maxChunkId);

  const per_query: { query_hash: string; staged_in_top_k: number[]; overlap_at_k: number; rank_correlation: number | null }[] = [];
  const overlaps: number[] = [];
  const correlations: number[] = [];
  let embeddings = 0;

  for (const q of queries.slice(0, 20)) {
    // ONE embedding, shared by both sides — a difference between two configurations must not be
    // able to come from two embeddings of the same words.
    embeddings += 1;
    const vlit = vectorLiteral(await embed(q));
    const run = async (legs: ReturnType<typeof candidateLegs>) => {
      const [v, b] = await Promise.all([
        read<{ id: unknown; rank: unknown }>(SOURCE, legs.vector.sql, [vlit, 0.3, ...legs.vector.params]).catch(() => []),
        read<{ id: unknown; rank: unknown }>(SOURCE, legs.bm25.sql, [q, ...legs.bm25.params]).catch(() => []),
      ]);
      const coerce = (rows: { id: unknown; rank: unknown }[]) => rows
        .map((r) => ({ id: Number(r.id), rank: Number(r.rank) }))
        .filter((r) => Number.isFinite(r.id) && Number.isFinite(r.rank));
      return fuse([coerce(v), coerce(b)], k);
    };
    const [a, b] = [await run(legsA), await run(legsB)];
    const setA = new Set(a);
    const shared = b.filter((id) => setA.has(id)).length;
    const denom = Math.max(a.length, b.length);
    const pct = denom > 0 ? Math.round((100 * shared) / denom) : null;
    const rho = rankCorrelation(a, b);
    if (pct != null) overlaps.push(pct);
    if (rho != null) correlations.push(rho);
    per_query.push({
      query_hash: hash(q),
      staged_in_top_k: b.filter((id) => stagedSet.has(id)),
      overlap_at_k: shared,
      rank_correlation: rho,
    });
  }

  const mean = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((x, y) => x + y, 0) / xs.length) * 100) / 100 : null);

  return {
    label,
    staged: {
      chunks: staged.length,
      books: [...new Set(staged.map((s) => String(s.book ?? '')).filter(Boolean))].sort(),
      chunk_ids: stagedIds,
    },
    visible: {
      // ⚠️ NULL, NEVER ZERO, when the count did not run. Zero would read as "the corpus is empty".
      chunks: vis ? Number(vis.visible_chunks ?? 0) : null,
      sources: vis ? Number(vis.visible_sources ?? 0) : null,
      max_chunk_id: maxChunkId,
    },
    visible_status: vis ? 'ok' as const : 'skipped' as const,
    overlap_status: overlapRows ? 'ok' as const : 'skipped' as const,
    skipped_detail: Object.keys(skipped).length ? skipped : null,
    // Bound by BOOK in SQL, intersected to the exact staged PAIRS here — see OVERLAP_SQL's header.
    overlap: (overlapRows ?? [])
      .filter((r) => stagedPairs.has(`${String(r.book ?? '')}\u0000${String(r.chapter ?? '')}`))
      .map((r) => ({
        book: r.book == null ? null : String(r.book),
        chapter: r.chapter == null ? null : String(r.chapter),
        visible_chunks: Number(r.visible_chunks ?? 0),
      })),
    impact: {
      // Structural: nothing in this module can reach `governedChat` or a reranker.
      model_calls: 0,
      embeddings,
      queries: per_query.length,
      snapshot_max_chunk_id: maxChunkId,
      queries_affected: per_query.filter((p) => p.staged_in_top_k.length > 0).length,
      mean_overlap_at_k: mean(overlaps),
      mean_rank_correlation: mean(correlations),
      per_query,
    },
  };
}

/**
 * A cohort dataset's freeze queries — the same query `sources/opd.ts` retrieved on when it froze
 * each case, rebuilt from the frozen note by the engine's own builder. Not stored on the case, so
 * it is derived rather than guessed at.
 */
async function freezeQueriesOf(db: Db, datasetId: string | undefined): Promise<string[]> {
  if (!datasetId) throw new LabError('INVALID_INPUT', 'corpus_diff needs a dataset_id (a frozen cohort) or an explicit queries list');
  const obj = await getObject(db, datasetId);
  const body = (obj?.body ?? {}) as { engine?: string; cases?: { frozen?: { note?: Record<string, unknown> } }[] };
  if (!obj || body.engine !== 'opd_note_audit') {
    throw new LabError('INVALID_INPUT', `dataset ${datasetId} is not an opd_note_audit cohort; corpus_diff measures impact on the queries a cohort froze`);
  }
  const out: string[] = [];
  for (const c of body.cases ?? []) {
    if (!c.frozen?.note) continue;
    const q = freezeQueryFor(c.frozen.note).trim();
    if (q) out.push(q);
  }
  if (!out.length) throw new LabError('INVALID_INPUT', `dataset ${datasetId} produced no freeze queries`);
  return out;
}
