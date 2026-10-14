/**
 * lib/lab-v2/tools/observation.ts — the nine round-A2 observation tools (§17.2).
 *
 * All nine are synchronous, `effect: read`, `cost_class: free`, and none writes outside `lab_v2`
 * (`report_export` stores one artifact there; that is the only write any of them makes).
 *
 * WHY THE SCHEMAS LIVE HERE AND NOT IN contracts.ts. §17.2's file contract does not list
 * `lib/lab-v2/contracts.ts` among the edited files, and round 1 put `toolSchemas` there. Rather
 * than edit a file the contract froze, the nine input/output schemas are declared in this new
 * file and merged by `registry.ts` and `service.ts` — both of which the contract DOES list as
 * additively edited. One tool registry, two schema sources, no frozen file touched.
 *
 * ⚠️ NO OUTPUT EVER CARRIES NOTE TEXT OR A PATIENT FIELD. `opd_note_audits` holds neither a note
 * body nor a patient identifier, and every projection in lib/lab-v2/sources/audits.ts is a fixed
 * column list. The `preview` fields below are excerpts of the PUBLISHED CORPUS (mksap_chunks),
 * which is textbook and literature material, not clinical record. observation.test.ts greps every
 * tool's output for a synthetic note sentence to keep that true.
 */
import { z } from 'zod';
import {
  aggregateAudits, auditFilterSchema, auditFindings, GROUP_BY, METRICS, oneAudit, searchAudits,
} from '../sources/audits';
import { chunksById, corpusSearch, quarantinePrefix } from '../sources/corpus';
import { sourceFreshness } from '../sources/freshness';
import { LabError } from '../contracts';
import { getObject, getRun, itemsOf, putObject } from '../store';
import type { Db } from '../db';
import { retrieve } from '../../retrieve';

/** §17.2, verbatim. Round 1's own §16.9 note: recurrence is 0.58, so one run is a sample. */
export const REPORT_CAVEAT =
  'One run is one sample. Judged findings at temperature 0 recur at about 0.58 across same-config pairs.';

// ── schemas ──────────────────────────────────────────────────────────────────────────
const chunkOut = z.object({
  id: z.union([z.string(), z.number()]),
  book: z.string().nullable(),
  chapter: z.string().nullable(),
  source: z.string().nullable(),
  active: z.boolean(),
  quarantine_prefix: z.string().nullable(),
  preview: z.string().nullable(),
});

const auditRowOut = z.object({
  uid: z.string(),
  engine_version: z.string().nullable(),
  note_date: z.string().nullable(),
  band: z.string().nullable(),
  note_quality_index: z.number().nullable(),
  completeness_pct: z.number().nullable(),
  n_findings: z.number().nullable(),
  n_low_value: z.number().nullable(),
  finding_subjects: z.array(z.string()),
});

export const OBSERVATION_SCHEMAS = {
  source_freshness: {
    input: z.object({}),
    output: z.object({
      sources: z.array(z.object({
        source: z.string(), ok: z.boolean(), newest: z.string().nullable(),
        rows_last_24h: z.number().nullable(), error: z.string().nullable(),
      })),
    }),
  },
  audit_search: {
    input: auditFilterSchema.extend({
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }),
    output: z.object({ returned: z.number().int(), rows: z.array(auditRowOut) }),
  },
  audit_aggregate: {
    input: auditFilterSchema.extend({
      group_by: z.enum(GROUP_BY),
      metric: z.enum(METRICS),
    }),
    output: z.object({
      group_by: z.enum(GROUP_BY),
      metric: z.enum(METRICS),
      grain: z.string(),
      groups: z.array(z.object({
        group_key: z.string().nullable(),
        value: z.number().nullable(),
        n_audits: z.number().int(),
      })),
    }),
  },
  case_snapshot: {
    input: z.object({ uid: z.string().min(1).max(128) }),
    output: z.object({
      uid: z.string(),
      audit: auditRowOut.nullable(),
      datasets: z.array(z.object({ dataset_id: z.string(), hash: z.string(), created_at: z.string() })),
      runs: z.array(z.object({ run_id: z.string(), experiment_id: z.string().nullable(), state: z.string(), created_at: z.string() })),
    }),
  },
  audit_explain: {
    input: z.object({ uid: z.string().min(1).max(128), finding_index: z.number().int().min(0).max(500) }),
    output: z.object({
      uid: z.string(),
      engine_version: z.string().nullable(),
      finding_index: z.number().int(),
      finding: z.record(z.unknown()),
      citations: z.array(chunkOut),
      unresolved_citation_ids: z.array(z.union([z.string(), z.number()])),
    }),
  },
  retrieval_inspect: {
    input: z.object({ query: z.string().min(1).max(2000), k: z.number().int().min(1).max(30).default(10) }),
    output: z.object({
      query: z.string(),
      k: z.number().int(),
      reranked: z.boolean(),
      expanded: z.boolean(),
      elapsed_ms: z.number().int(),
      pools: z.record(z.unknown()),
      candidates: z.array(chunkOut.extend({ score: z.number().nullable() })),
    }),
  },
  citation_check: {
    input: z.object({
      citation_ids: z.array(z.union([z.string(), z.number()])).min(1).max(50),
      run_id: z.string().uuid().optional(),
      uid: z.string().min(1).max(128).optional(),
    }),
    output: z.object({
      checked_against: z.string(),
      results: z.array(z.object({
        citation_id: z.union([z.string(), z.number()]),
        exists: z.boolean(),
        active: z.boolean().nullable(),
        in_sources: z.boolean(),
      })),
    }),
  },
  corpus_search: {
    input: z.object({
      text: z.string().min(1).max(200),
      book: z.string().max(200).optional(),
      source: z.string().max(200).optional(),
      active: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).default(25),
    }),
    output: z.object({ returned: z.number().int(), rows: z.array(chunkOut) }),
  },
  report_export: {
    input: z.object({ run_id: z.string().uuid() }),
    output: z.object({
      artifact_id: z.string().uuid(),
      run_id: z.string().uuid(),
      caveat: z.string(),
      summary: z.object({
        items: z.number().int(),
        execution_status: z.record(z.number()),
        assessment_status: z.record(z.number()),
        attribution_status: z.record(z.number()),
        calls: z.number().int(),
        replay_exactness: z.string().nullable(),
      }),
    }),
  },
} as const;

export type ObservationToolName = keyof typeof OBSERVATION_SCHEMAS;

// ── handlers ─────────────────────────────────────────────────────────────────────────
export interface ObservationDeps { db: Db; principal: string }
type Handler = (deps: ObservationDeps, args: Record<string, unknown>) => Promise<unknown>;

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());

/** Map a source row into the shared chunk shape, adding the quarantine label §17.2 asks for. */
function toChunkOut(c: { id: string | number; book: string | null; chapter: string | null; source: string | null; active: boolean; preview: string | null }) {
  return {
    id: c.id, book: c.book, chapter: c.chapter, source: c.source,
    active: Boolean(c.active), quarantine_prefix: quarantinePrefix(c.source), preview: c.preview,
  };
}

const shapeAuditRow = (r: Awaited<ReturnType<typeof oneAudit>>) => (r ? {
  uid: r.uid,
  engine_version: r.engine_version ?? null,
  note_date: iso(r.note_date),
  band: r.band ?? null,
  note_quality_index: num(r.note_quality_index),
  completeness_pct: num(r.completeness_pct),
  n_findings: num(r.n_findings),
  n_low_value: num(r.n_low_value),
  finding_subjects: (r.finding_subjects ?? []).filter((s): s is string => typeof s === 'string'),
} : null);

/**
 * §17.7 C3 item 3 — the release and review sections of a run report.
 *
 * ⚠️ ABSENT SECTIONS ARE ABSENT KEYS, NEVER EMPTY ARRAYS. A run with no release must produce
 * byte-identically the report body it produced before C3, because `putObject` is content-addressed:
 * an empty `releases: []` would change the hash of every stored `run_report` in the platform and
 * every reference to one would then name an object that no longer exists at that hash. So this
 * returns `{}` when there is nothing to say, and the spread adds nothing.
 *
 * ⚠️ WHAT LINKS A RELEASE TO A RUN IS ITS `impact_ref`, AND ONLY ONE OF THE TWO TARGETS CAN BE
 * LINKED TODAY. Measured on `4224e152`: a rules release's `impact_ref` is a `rule_simulate`
 * artifact, which carries `baseline_run_id` and resolves precisely. A corpus release's `impact_ref`
 * is documented as "a corpus_diff artifact id" — but `corpus_diff` PERSISTS NOTHING (`tools/corpus.ts`
 * writes exactly one object, the staged set), so that id resolves to nothing and no corpus release
 * can appear in this section yet. The resolution below is written for both and finds what exists;
 * the day `corpus_diff` stores its artifact with a dataset id, corpus releases join with no change
 * here. Reported rather than papered over.
 */
async function releaseSections(db: Db, runId: string, datasetId: string | null): Promise<Record<string, unknown>> {
  const releases = await db.query<{ id: string; owner: string; hash: string; body: unknown; created_at: string }>(
    RELEASE_OBJECTS_SQL,
  ).catch(() => []);
  if (!releases.length) return {};

  const matched: { id: string; hash: string; body: Record<string, unknown> }[] = [];
  for (const r of releases) {
    const body = (r.body ?? {}) as Record<string, unknown>;
    const ref = body.impact_ref == null ? '' : String(body.impact_ref);
    if (!ref) continue;
    const impact = await getObject(db, ref).catch(() => null);
    const ib = (impact?.body ?? {}) as { kind?: string; baseline_run_id?: string; dataset_id?: string };
    const onThisRun = ib.baseline_run_id != null && String(ib.baseline_run_id) === runId;
    const onThisDataset = datasetId != null && ib.dataset_id != null && String(ib.dataset_id) === datasetId;
    if (!onThisRun && !onThisDataset) continue;
    matched.push({ id: r.id, hash: r.hash, body: { ...body, __owner: r.owner, __created_at: r.created_at } });
  }
  if (!matched.length) return {};

  const out: Record<string, unknown> = {};
  const releaseRows = [];
  const reviewRows = [];
  for (const m of matched) {
    const receipts = await db.query<{ id: string; kind: string; revision: string | number; body: unknown; created_at: string }>(
      RECEIPTS_FOR_RELEASE_SQL, [m.id],
    ).catch(() => []);
    releaseRows.push({
      release_id: m.id,
      target: m.body.target == null ? null : String(m.body.target),
      label: m.body.label == null ? null : String(m.body.label),
      artifact_hash: m.hash,
      impact_ref: m.body.impact_ref == null ? null : String(m.body.impact_ref),
      prepared_by: String(m.body.__owner),
      prepared_at: String(m.body.__created_at),
      // The state a reader cares about is what actually happened to it, which is on the receipts.
      state: receipts.some((x) => x.kind === 'rollback') ? 'rolled_back'
        : receipts.some((x) => x.kind === 'apply') ? 'applied'
        : 'prepared',
      receipts: receipts.map((x) => ({
        receipt_id: x.id, kind: x.kind, revision: Number(x.revision),
        outcome: String((x.body as { outcome?: unknown } | null)?.outcome ?? x.kind),
        created_at: String(x.created_at),
      })),
    });
    for (const rev of await db.query<{ id: string; reviewer: string; artifact_hash: string; decision: string; rationale: string; created_at: string; expires_at: string }>(
      REVIEWS_FOR_RELEASE_SQL, [m.id],
    ).catch(() => [])) {
      reviewRows.push({
        release_id: m.id, review_id: rev.id, reviewer: rev.reviewer,
        decision: rev.decision, rationale: rev.rationale,
        // The hash the approval BOUND, which is the whole of decision 81 — a review of a different
        // artifact is not a review of this one, and the report must let a reader see that.
        artifact_hash: rev.artifact_hash,
        bound_to_current: rev.artifact_hash === m.hash,
        created_at: String(rev.created_at), expires_at: String(rev.expires_at),
      });
    }
  }
  out.releases = releaseRows;
  // Reviews are their own section, and an unreviewed release simply has none — again a missing key
  // rather than an empty list, for the same hash reason.
  if (reviewRows.length) out.reviews = reviewRows;
  return out;
}

/** §17.7 C3 — the three lab_v2 reads report_export's new sections make. */
export const RELEASE_OBJECTS_SQL = `SELECT id::text AS id, owner, hash, body, created_at
FROM lab_v2.objects WHERE kind = 'release' ORDER BY created_at DESC LIMIT 200`;
export const RECEIPTS_FOR_RELEASE_SQL = `SELECT id::text AS id, kind, revision, body, created_at
FROM lab_v2.receipts WHERE release_id = $1 ORDER BY created_at`;
export const REVIEWS_FOR_RELEASE_SQL = `SELECT id::text AS id, reviewer, artifact_hash, decision, rationale, created_at, expires_at
FROM lab_v2.reviews WHERE release_id = $1 ORDER BY created_at`;

export const OBSERVATION_HANDLERS: Record<ObservationToolName, Handler> = {
  async source_freshness({ db }) {
    return { sources: await sourceFreshness(db) };
  },

  async audit_search(_deps, args) {
    const { limit, offset, ...filter } = args as Record<string, never>;
    const rows = await searchAudits(filter, Number(limit ?? 50), Number(offset ?? 0));
    const shaped = rows.map((r) => shapeAuditRow(r)!);
    return { returned: shaped.length, rows: shaped };
  },

  async audit_aggregate(_deps, args) {
    const { group_by, metric, ...filter } = args as Record<string, never>;
    const groups = await aggregateAudits(filter, group_by as never, metric as never, 500);
    return {
      group_by, metric,
      // The lvc_category grouping unnests findings; the CTE reduces to DISTINCT (audit, category)
      // first, so a metric is over AUDITS either way. Stated so a reader never has to guess.
      grain: 'audit',
      groups: groups.map((g) => ({
        group_key: g.group_key == null ? null : String(g.group_key),
        value: g.value == null ? null : Number(g.value),
        n_audits: Number(g.n_audits),
      })),
    };
  },

  async case_snapshot({ db }, args) {
    const uid = String(args.uid);
    const audit = shapeAuditRow(await oneAudit(uid));
    // Which v2 datasets froze this case, and which runs consumed them.
    const datasets = await db.query<{ id: string; hash: string; created_at: string }>(
      `SELECT id, hash, created_at FROM lab_v2.objects
       WHERE kind = 'dataset' AND body->'cases' @> $1::jsonb ORDER BY created_at DESC LIMIT 50`,
      [JSON.stringify([{ case_key: uid }])],
    ).catch(() => []);
    const ids = datasets.map((d) => d.id);
    const runs = ids.length
      ? await db.query<{ id: string; experiment_id: string | null; state: string; created_at: string }>(
        `SELECT r.id, r.experiment_id, r.state, r.created_at FROM lab_v2.runs r
         JOIN lab_v2.objects o ON o.id = r.experiment_id
         WHERE o.body->>'dataset_id' = ANY($1) ORDER BY r.created_at DESC LIMIT 50`,
        [ids],
      ).catch(() => [])
      : [];
    return {
      uid,
      audit,
      datasets: datasets.map((d) => ({ dataset_id: d.id, hash: d.hash, created_at: iso(d.created_at)! })),
      runs: runs.map((r) => ({ run_id: r.id, experiment_id: r.experiment_id, state: r.state, created_at: iso(r.created_at)! })),
    };
  },

  async audit_explain(_deps, args) {
    const uid = String(args.uid);
    const index = Number(args.finding_index);
    const row = await auditFindings(uid);
    if (!row) throw new LabError('NOT_FOUND', `no audit row for uid ${uid}`);
    const findings = row.findings ?? [];
    const finding = findings[index];
    if (!finding) throw new LabError('NOT_FOUND', `audit ${uid} has no finding at index ${index} (it has ${findings.length})`);
    const rawIds = Array.isArray(finding.citation_ids) ? finding.citation_ids : [];
    // The audit's own `sources` array maps the finding's 1-based citation numbers to chunk ids.
    const sources = Array.isArray(row.sources) ? row.sources as { n?: number; id?: string }[] : [];
    const chunkIds = rawIds
      .map((n) => sources.find((s) => Number(s.n) === Number(n))?.id)
      .filter((v): v is string => typeof v === 'string')
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v));
    const resolved = chunkIds.length ? await chunksById(chunkIds) : [];
    const got = new Set(resolved.map((c) => String(c.id)));
    // §17.2: unresolvable ids are LISTED, never dropped.
    const unresolved = rawIds.filter((n) => {
      const cid = sources.find((s) => Number(s.n) === Number(n))?.id;
      return !cid || !got.has(String(cid));
    });
    return {
      uid, engine_version: row.engine_version ?? null, finding_index: index,
      finding, citations: resolved.map(toChunkOut),
      unresolved_citation_ids: unresolved as (string | number)[],
    };
  },

  /**
   * Decision 27 — the candidate stage only, and ZERO chat model calls.
   *
   * `retrieve()` already had both switches, so no new option was added:
   *   · `useReranker` defaults to FALSE (`opts.useReranker === true`, lib/retrieve.ts:397), so the
   *     rerank judge — a governedChat call — never runs unless asked.
   *   · `skipExpand` must be passed TRUE. This is the one that matters: `expandQuery` IS a
   *     governedChat call (lib/expand.ts:24) and runs by default. Without this flag
   *     `retrieval_inspect` would have made a model call outside the gateway, which is exactly
   *     what decision 27 forbids.
   * Embedding still runs, and is meant to: decision 27 defines the candidate stage as
   * "embedding and lexical". It is an embeddings call, not a chat call.
   */
  async retrieval_inspect(_deps, args) {
    const query = String(args.query);
    const k = Number(args.k ?? 10);
    const started = Date.now();
    let out;
    try {
      out = await retrieve(query, { topK: k, skipExpand: true, useReranker: false });
    } catch (e) {
      throw new LabError('SOURCE_UNAVAILABLE', `retrieval unavailable: ${(e as Error).message}`);
    }
    const elapsed = Date.now() - started;
    return {
      query, k,
      reranked: Boolean(out.meta?.reranked),
      expanded: false,
      elapsed_ms: elapsed,
      // lib/retrieve.ts's meta carries pool sizes, not per-stage timings, so the tool reports the
      // pools it does have plus its own measured wall time rather than inventing a breakdown.
      pools: (out.meta ?? {}) as Record<string, unknown>,
      candidates: out.hits.map((h) => ({
        // Everything retrieve() returns is active by construction: its own clause list filters
        // `visible IS NOT FALSE AND source NOT LIKE 'labq:%'` before scoring.
        ...toChunkOut({ id: h.id, book: h.book, chapter: h.chapter, source: h.source, active: true, preview: (h.text ?? '').slice(0, 400) }),
        score: typeof h.similarity === 'number' ? h.similarity : null,
      })),
    };
  },

  async citation_check({ db }, args) {
    const ids = (args.citation_ids as (string | number)[]).map((v) => Number(v)).filter((v) => Number.isFinite(v));
    const runId = args.run_id ? String(args.run_id) : null;
    const uid = args.uid ? String(args.uid) : null;
    if (!runId && !uid) throw new LabError('INVALID_INPUT', 'one of run_id or uid is required');

    const rows = await chunksById(ids);
    const byId = new Map(rows.map((r) => [String(r.id), r]));

    // The id set the named run or audit actually cited.
    const cited = new Set<string>();
    if (uid) {
      const row = await auditFindings(uid);
      const sources = Array.isArray(row?.sources) ? row!.sources as { id?: string }[] : [];
      for (const s of sources) if (s.id) cited.add(String(s.id));
    } else if (runId) {
      const items = await itemsOf(db, runId, 20, 0);
      for (const it of items) {
        const stored = it.result as { artifact_id?: string } | null;
        if (!stored?.artifact_id) continue;
        const art = await getObject(db, stored.artifact_id);
        const srcs = (art?.body as { sources?: { id?: string | number }[] } | undefined)?.sources ?? [];
        for (const s of srcs) if (s.id != null) cited.add(String(s.id));
      }
    }
    return {
      checked_against: uid ? `audit:${uid}` : `run:${runId}`,
      results: ids.map((id) => {
        const hit = byId.get(String(id));
        return {
          citation_id: id,
          exists: !!hit,
          active: hit ? Boolean(hit.active) : null,
          in_sources: cited.has(String(id)),
        };
      }),
    };
  },

  async corpus_search(_deps, args) {
    const rows = await corpusSearch({
      text: String(args.text),
      book: args.book ? String(args.book) : undefined,
      source: args.source ? String(args.source) : undefined,
      active: typeof args.active === 'boolean' ? args.active : undefined,
      limit: Number(args.limit ?? 25),
    });
    return { returned: rows.length, rows: rows.map(toChunkOut) };
  },

  async report_export({ db, principal }, args) {
    const runId = String(args.run_id);
    const run = await getRun(db, runId);
    if (!run) throw new LabError('NOT_FOUND', `no run ${runId}`);
    const items = await itemsOf(db, runId, 1000, 0);
    const experiment = run.experiment_id ? await getObject(db, run.experiment_id) : null;
    const expBody = (experiment?.body ?? {}) as { dataset_id?: string; arm_ids?: string[] };
    const dataset = expBody.dataset_id ? await getObject(db, expBody.dataset_id) : null;
    const dsBody = (dataset?.body ?? {}) as { engine?: string; cases?: { case_key: string }[]; replay_exactness?: string; snapshot_policy?: string; source_versions?: unknown };
    const arms = [];
    for (const armId of expBody.arm_ids ?? []) {
      const a = await getObject(db, armId);
      if (a) arms.push({ arm_id: a.id, hash: a.hash, body: a.body });
    }
    const calls = await db.query<Record<string, unknown>>(
      `SELECT c.id, c.item_id, c.stage, c.state, c.requested, c.served, c.reserved_microusd, c.actual_microusd, c.pricing_version, c.created_at, c.settled_at
       FROM lab_v2.calls c JOIN lab_v2.items i ON i.id = c.item_id WHERE i.run_id = $1 ORDER BY c.created_at`,
      [runId],
    ).catch(() => []);

    const tally = (field: 'execution_status' | 'assessment_status' | 'attribution_status') => {
      const out: Record<string, number> = {};
      for (const i of items) { const key = i[field] ?? 'not_set'; out[key] = (out[key] ?? 0) + 1; }
      return out;
    };

    const body = {
      kind: 'run_report',
      run: { run_id: run.id, owner: run.owner, operation: run.operation, state: run.state, created_at: iso(run.created_at), deadline_at: iso(run.deadline_at) },
      experiment: experiment ? { experiment_id: experiment.id, hash: experiment.hash, body: experiment.body } : null,
      // Dataset METADATA only — the frozen note text is deliberately not in an exportable report.
      dataset: dataset ? {
        dataset_id: dataset.id, hash: dataset.hash, engine: dsBody.engine ?? null,
        case_keys: (dsBody.cases ?? []).map((c) => c.case_key),
        snapshot_policy: dsBody.snapshot_policy ?? null,
        source_versions: dsBody.source_versions ?? null,
        replay_exactness: dsBody.replay_exactness ?? null,
      } : null,
      arms,
      items: items.map((i) => ({
        item_id: i.id, case_key: i.case_key, arm_hash: i.arm_hash, repetition: i.repetition,
        state: i.state, attempts: i.attempts,
        execution_status: i.execution_status, assessment_status: i.assessment_status, attribution_status: i.attribution_status,
        summary: (i.result as { summary?: unknown } | null)?.summary ?? null,
        error: i.error,
      })),
      calls,
      replay_exactness: dsBody.replay_exactness ?? null,
      // §17.7 C3 item 3 — release and review provenance, present only when it exists.
      ...(await releaseSections(db, run.id, expBody.dataset_id ?? null)),
      caveat: REPORT_CAVEAT,
    };

    const { object } = await putObject(db, principal, 'report', body, 'deidentified', `report:${runId}`);
    return {
      artifact_id: object.id,
      run_id: runId,
      caveat: REPORT_CAVEAT,
      summary: {
        items: items.length,
        execution_status: tally('execution_status'),
        assessment_status: tally('assessment_status'),
        attribution_status: tally('attribution_status'),
        calls: calls.length,
        replay_exactness: dsBody.replay_exactness ?? null,
      },
    };
  },
};
