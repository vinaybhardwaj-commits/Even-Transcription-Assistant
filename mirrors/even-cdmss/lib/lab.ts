/**
 * lib/lab.ts — the CDMSS "Lab": experimental sandbox for the mini pipeline, driven by
 * the remote MCP (/api/mcp). Two stores, both isolated from production:
 *
 *  1. lab_analyses — experimental analysis outputs (mini-pipeline runs over Metabase
 *     artifacts or pasted text), logically namespaced by `experiment` label. NEVER
 *     touches opd_note_audits / appropriateness_runs.
 *
 *  2. Corpus quarantine — new corpus material is inserted into mksap_chunks with a
 *     `labq:<label>` source and is INERT: retrieve.ts excludes `source LIKE 'labq:%'`,
 *     so quarantined chunks can't affect production retrieval (Ask/DDx/Right Care/audits)
 *     until activated (labq:<label> → lab:<label>), and are fully reversible (delete by source).
 *
 * Hard guarantees (enforced structurally, not by convention):
 *  - MINI ONLY: every embedding + LLM call here runs on the Mac-mini bridge (nomic /
 *    MINI_MODEL). No function in this file can reach Gemini.
 *  - NO ARCHITECTURE CHANGE: the MCP calls these data-in/data-out helpers; it cannot
 *    alter prompts, engines, weights, or any prod table.
 */
import { createHash } from 'crypto';
import { sql } from './db';
import { embedQuery, vectorLiteral } from './llm';
import { labLabel, chunkText } from './lab-core';
export { labLabel, chunkText } from './lab-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const approxTokens = (s: string) => Math.ceil(s.length / 4);

// ── migration (idempotent) ─────────────────────────────────────────────────────
export async function ensureLabTables(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS lab_analyses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment text NOT NULL,
    kind text NOT NULL,                 -- 'opd_note' | 'text' | …
    engine text NOT NULL,               -- the mini engine string used
    input_ref text,                     -- metabase uid / filename / null
    input_preview text,                 -- short, de-identified echo of what was analysed
    output jsonb NOT NULL,              -- the full mini result (scores/findings/etc.)
    model text,
    latency_ms int,
    created_at timestamptz NOT NULL DEFAULT now()
  )`, []);
  await run(`CREATE INDEX IF NOT EXISTS lab_analyses_experiment_idx ON lab_analyses (experiment, created_at DESC)`, []);
  // F11: record WHICH PROVIDER served a run alongside the model. Additive + idempotent. Without it
  // `model` alone is ambiguous — 'gemini-2.5-pro' could have come from Vertex or from OpenRouter,
  // and the paid ceiling needs to count non-ollama runs per experiment.
  await run(`ALTER TABLE lab_analyses ADD COLUMN IF NOT EXISTS provider text`, []).catch(() => {});
  await run(`CREATE INDEX IF NOT EXISTS lab_analyses_provider_idx ON lab_analyses (experiment, provider)`, []).catch(() => {});
}

// ── lab_analyses store ──────────────────────────────────────────────────────────
export interface LabAnalysisRow {
  experiment: string; kind: string; engine: string;
  inputRef?: string | null; inputPreview?: string | null;
  output: unknown; model?: string | null; latencyMs?: number | null;
  /** F11 — 'ollama' | 'openrouter' | 'vertex'. The RESOLVED provider, never the requested string. */
  provider?: string | null;
}
export async function saveLabAnalysis(r: LabAnalysisRow): Promise<string> {
  const rows = await run(
    `INSERT INTO lab_analyses (experiment, kind, engine, input_ref, input_preview, output, model, latency_ms, provider)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING id`,
    [r.experiment, r.kind, r.engine, r.inputRef ?? null, (r.inputPreview ?? '').slice(0, 500),
     JSON.stringify(r.output), r.model ?? null, r.latencyMs ?? null, r.provider ?? null],
  );
  return String(rows[0]?.id ?? '');
}

/** F11 — how many NON-OLLAMA (paid) runs this experiment has already made. The ceiling counts
 *  provider, not model: a free local run must never consume paid budget. Fail-safe ⇒ 0 would
 *  DISABLE the ceiling, so the caller treats a read failure as a refusal instead. */
export async function countPaidRuns(experiment: string): Promise<number | null> {
  try {
    const rows = await run(
      `SELECT count(*)::int AS n FROM lab_analyses
       WHERE experiment = $1 AND provider IS NOT NULL AND provider <> 'ollama'`, [experiment]);
    return Number(rows[0]?.n ?? 0) || 0;
  } catch { return null; }
}

export async function listLabAnalyses(experiment: string | null, limit: number): Promise<Record<string, unknown>[]> {
  const lim = Math.max(1, Math.min(200, limit));
  if (experiment) {
    return run(`SELECT id, experiment, kind, engine, input_ref, input_preview, model, latency_ms, created_at
                FROM lab_analyses WHERE experiment = $1 ORDER BY created_at DESC LIMIT ${lim}`, [experiment]);
  }
  return run(`SELECT experiment, count(*)::int AS runs, max(created_at) AS latest
              FROM lab_analyses GROUP BY experiment ORDER BY latest DESC LIMIT ${lim}`, []);
}

export async function getLabAnalysis(id: string): Promise<Record<string, unknown> | null> {
  const rows = await run(`SELECT * FROM lab_analyses WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ?? null;
}

/** Overwrite a run's output + latency once its async pipeline finishes (async lab probes:
 *  a `pending` row is written first, then this fills it in from a post-response `after()` task). */
export async function updateLabAnalysis(id: string, output: unknown, latencyMs?: number | null): Promise<void> {
  await run(
    `UPDATE lab_analyses SET output = $2::jsonb, latency_ms = $3 WHERE id = $1`,
    [id, JSON.stringify(output), latencyMs ?? null],
  );
}

/**
 * F11 DEC-2 (7 Aug 2026) — rewrite a row's ATTRIBUTION COLUMNS to what actually served.
 *
 * Separate from `updateLabAnalysis` on purpose, and additive: every existing caller keeps writing
 * output alone, byte-identically. `provider`/`model` are the two columns a reader trusts — the
 * paid-run ceiling counts `provider`, `lab_query`/`audit_query` group by `model` — so correcting
 * them is what actually retires a false claim. Leaving the claim in place and appending a note
 * beside it would leave every aggregate still wrong.
 */
export async function correctLabAttribution(
  id: string, output: unknown, latencyMs: number | null, provider: string | null, model: string | null,
): Promise<void> {
  await run(
    `UPDATE lab_analyses SET output = $2::jsonb, latency_ms = $3, provider = $4, model = $5 WHERE id = $1`,
    [id, JSON.stringify(output), latencyMs ?? null, provider, model],
  );
}

// ── corpus quarantine ────────────────────────────────────────────────────────────
export interface CorpusAddInput {
  label: string;            // → source labq:<label>
  book: string;             // title / work name (dedup is per (book, text_hash))
  chapter?: string;
  section?: string;
  chunkType?: string;       // 'note' | 'guideline' | 'abstract' | …
  text: string;
  /** Optional stable internal anchor (e.g. a guideline section slug). Absent ⇒ the chunk INDEX
   *  (String(i+1)), byte-identical to prior behaviour. Never a DOI/PMID/URL. */
  itemNumber?: string;
  /** F13 provenance (LAB-MCP Phase 2). Validated by checkCitationFields BEFORE this is called —
   *  this interface carries the already-normalised values and performs no validation of its own. */
  citationUrl?: string | null;
  citationDoi?: string | null;
  citationPmid?: string | null;
  sourceReleaseYear?: number | null;
  licenseStatus?: string | null;
  provenance?: string | null;
}
export interface CorpusAddResult { source: string; chunks: number; inserted: number; skipped_dup: number }

/** Quarantine INSERT — D5 defence-in-depth: quarantined rows are `visible = false` so that even if
 *  the source guard were ever bypassed, the row stays invisible until activation flips it true.
 *  Exported so the SQL is unit-testable (§7 test 5) without a live DB. */
export const CORPUS_QUARANTINE_INSERT_SQL =
  `INSERT INTO mksap_chunks (source, book, chapter, section, item_number, chunk_type, text, text_hash, embedding, token_count, visible,
                             citation_url, citation_doi, citation_pmid, source_release_year, license_status, provenance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, false, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (book, text_hash) DO NOTHING RETURNING id`;

/** Add vetted material to the corpus, QUARANTINED (labq:<label>). Embeds on nomic (mini). */
export async function corpusAddQuarantined(input: CorpusAddInput): Promise<CorpusAddResult> {
  const label = labLabel(input.label);
  const source = `labq:${label}`;
  const chunks = chunkText(input.text);
  let inserted = 0, skipped = 0;
  for (const [i, text] of chunks.entries()) {
    const hash = sha256(text);
    const emb = vectorLiteral(await embedQuery(text)); // nomic on the mini — ₹0
    const ins = await run(
      CORPUS_QUARANTINE_INSERT_SQL,
      [source, input.book, input.chapter ?? null, input.section ?? 'lab', input.itemNumber ?? String(i + 1),
       input.chunkType ?? 'note', text, hash, emb, approxTokens(text),
       // F13 — every chunk of one corpus_add call carries the same provenance.
       input.citationUrl ?? null, input.citationDoi ?? null, input.citationPmid ?? null,
       input.sourceReleaseYear ?? null, input.licenseStatus ?? null, input.provenance ?? null],
    );
    if (ins.length) inserted++; else skipped++;
  }
  return { source, chunks: chunks.length, inserted, skipped_dup: skipped };
}

/** Activate a quarantined batch → visible to production retrieval.
 *  Default target is `lab:<label>` (generic Lab material). A connector may pass `targetSource` to
 *  activate to a FIRST-CLASS source name (e.g. 'bookshelf') so citations render with a real handler
 *  instead of a generic `lab:` chip — the corpus-connector activation path (GC-CX SL1). The target
 *  is slug-sanitised the same way labels are, so it can never collide with the `labq:`/`lab:` guards. */
export const CORPUS_ACTIVATE_SQL = `UPDATE mksap_chunks SET source = $1, visible = true WHERE source = $2 RETURNING id`;
export async function corpusActivate(label: string, targetSource?: string): Promise<{ source: string; activated: number }> {
  const l = labLabel(label);
  const target = targetSource ? labLabel(targetSource) : `lab:${l}`;
  // D5: activation must ALSO flip `visible = true`. Quarantine sets rows invisible (see
  // CORPUS_QUARANTINE_INSERT_SQL); flipping only `source` would activate into invisibility.
  const rows = await run(CORPUS_ACTIVATE_SQL, [target, `labq:${l}`]);
  return { source: target, activated: rows.length };
}

/** Delete a lab corpus batch entirely (quarantined OR active) — fully reversible cleanup. */
export async function corpusDelete(label: string, which: 'quarantined' | 'active' | 'both' = 'both'): Promise<{ deleted: number }> {
  const l = labLabel(label);
  const srcs = which === 'quarantined' ? [`labq:${l}`] : which === 'active' ? [`lab:${l}`] : [`labq:${l}`, `lab:${l}`];
  const rows = await run(`DELETE FROM mksap_chunks WHERE source = ANY($1) RETURNING id`, [srcs]);
  return { deleted: rows.length };
}

/** All lab corpus batches with counts + status. */
export async function corpusLabList(): Promise<Record<string, unknown>[]> {
  return run(
    `SELECT source, count(*)::int AS chunks, min(book) AS book,
            CASE WHEN source LIKE 'labq:%' THEN 'quarantined' ELSE 'active' END AS status
     FROM mksap_chunks WHERE source LIKE 'labq:%' OR source LIKE 'lab:%'
     GROUP BY source ORDER BY status, source`, []);
}

/** Storage snapshot for the MCP (lab tables + corpus lab footprint). */
export async function labStorage(): Promise<Record<string, unknown>> {
  const [an, corp] = await Promise.all([
    run(`SELECT count(*)::int AS runs, count(DISTINCT experiment)::int AS experiments FROM lab_analyses`, []).catch(() => [{}]),
    run(`SELECT count(*)::int AS lab_chunks,
                count(*) FILTER (WHERE source LIKE 'labq:%')::int AS quarantined,
                count(*) FILTER (WHERE source LIKE 'lab:%')::int AS active
         FROM mksap_chunks WHERE source LIKE 'labq:%' OR source LIKE 'lab:%'`, []).catch(() => [{}]),
  ]);
  return { lab_analyses: an[0] ?? {}, corpus_lab: corp[0] ?? {} };
}
