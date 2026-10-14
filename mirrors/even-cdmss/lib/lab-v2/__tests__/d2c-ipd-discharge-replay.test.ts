/**
 * LAB-MCP-V2 §17.10 round D2c — retrieval freeze and partial exact replay for `ipd_discharge`
 * (decisions 132, 133, 134, 135, 136; and 87, 99, 109, 111 throughout).
 *
 * ⚠️ THE FIXTURE IS MANUFACTURED, AND IT MUST BE, for the reason `d2b-ipd-discharge.test.ts` gives:
 * a real audit trace is one person's admission and this repository has had PHI history rewritten
 * once. So the trace below is production's SHAPE — the survey's measured shape, six analyze-family
 * pairs plus fifteen cite-gate pairs interleaved on one trace id — carrying invented clinical prose.
 *
 * ⚠️ AND THE CORPUS HITS CARRY EVERY `ChunkHitWithMeta` FIELD (`retrieve.ts:77-89` over
 * `db.ts:73-87`), including the five lab-only diagnostics, because decision 99's inventory over a
 * fixture that never held a field proves nothing about that field. That is decision 111's lesson,
 * applied to the shape D2c is the first round to store.
 *
 * ⚠️ DECISION 87. `trace_events` and its parent `traces` are created from the DDL at
 * `app/api/admin/migrate-v7/route.ts:30-39`, and `IPD_DISCHARGE_TRACE_SQL` is run against them once
 * with the interleaved fixture in place — which is the only way to show that the cite gate's fifteen
 * rows are excluded rather than merely unmentioned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedded, type Db } from '../db';
import { freshDb } from './helpers';
import { LabError, hash } from '../contracts';
import { dependencyHash } from '../gateway';
import { identifyingKeys, isIdentifyingKey } from '../sources/requests';
import { ensureBudget, getObject, itemsOf, submitRun } from '../store';
import { tick } from '../worker';
import { callTool } from '../service';
import { DOC_EXTRACT_VERSION } from '../../discharge-extract-store';
import { IPD_ENGINE_VERSION } from '../../ipd-audit/store';
import { TEXT_MODEL } from '../../llm';
import { parseVerdict } from '../../corpus-eval/verify-core';
import {
  CITE_GATE_KEEP_LITERAL, CONDITIONAL_STAGES, IPD_DISCHARGE_TRACE_SQL, REPLAYED_STAGES,
  freezeIpdDischargeDocument, recordIpdDischargeSteps, retrievalKey,
  type FrozenIpdDischarge, type IpdDischargeStep,
} from '../sources/ipd-discharge';
import {
  IPD_DISCHARGE_STAGES, LIVE_STAGES, makeIpdDischargeAdapter,
} from '../adapters/ipd-discharge';
import type { RetrieveOptions, RetrieveResult } from '../../retrieve';

const SALT = 'd2c-test-salt';
const DOC = 'DOCX-D2C-1';
const TRACE = 'TR-IPD-D2C-1';

// ─────────────────────────────────────────────────────────────────────────────────────
// The engine's own inputs
// ─────────────────────────────────────────────────────────────────────────────────────

/** `ExtractedCase`, the shape `d2b-ipd-discharge.test.ts` freezes, minus `verbatimSections`. */
const EXTRACTED = {
  docType: 'discharge_summary',
  detectedDocType: 'discharge_summary',
  confidence: 0.92,
  patient: { age: 61, sex: 'M' },
  diagnosis: 'Community-acquired pneumonia, right lower lobe',
  indication: null,
  procedure: null,
  investigations: ['Chest X-ray', 'CBC', 'CRP', 'Blood culture'],
  treatments: ['IV ceftriaxone', 'Nebulised salbutamol'],
  medications: ['Ceftriaxone 1 g IV BD', 'Azithromycin 500 mg OD'],
  courseSummary: 'Admitted with fever and productive cough; improved on IV antibiotics and stepped down to oral therapy on day 3.',
  disposition: 'Discharged home in stable condition',
  followUp: 'Review in chest clinic after one week with a repeat chest radiograph',
  rawNotes: 'De-identified extractor notes: afebrile 24 h before discharge.',
  completeness: [{ key: 'diagnosis', status: 'present', note: '' }],
  adminFacts: { lengthOfStayDays: 4, admissionType: 'emergency', careSetting: 'ward' },
  riskFactors: ['Type 2 diabetes'],
  aftercare: {
    instructions: ['Complete the full oral antibiotic course'],
    warning_signs: ['Breathlessness at rest'],
    follow_up_detail: 'Chest clinic in one week',
  },
} as const;

/** Production's analyze reply: two findings, each citing source [1], each with grounded evidence. */
const ANALYSIS = JSON.stringify({
  findings: [
    {
      subject: 'Repeat CRP on day 3', verdict: 'low-value', domain: 'efficiency',
      confidence: 'moderate', rationale: 'No documented change in management followed the repeat.',
      evidence: ['CRP repeated on day 3 with no documented action'], citation_ids: [1], order: 'CRP',
    },
    {
      subject: 'IV to oral switch at 72 h', verdict: 'appropriate', domain: 'appropriateness',
      confidence: 'high', rationale: 'Consistent with the cited guidance.',
      evidence: ['Switched to oral azithromycin at 72 hours'], citation_ids: [1],
    },
  ],
  idealisedSummary: 'Antibiotic stewardship with an early IV-to-oral switch.',
  diff: ['No documented review of the repeat inflammatory marker.'],
  suggestions: ['Record the indication for each repeat inflammatory marker.'],
});

/** `parseCritique` (`lvc-value-core.ts:222-231`) reads `needs_revision` as a boolean directly. */
const CRITIQUE = (needs: boolean) => JSON.stringify({
  needs_revision: needs, severity: needs ? 'minor' : 'none',
  wrong_or_missing_citations: needs ? ['finding 1 cites a source that does not carry the claim'] : [],
  unsupported_evidence: [], misfiled_estimates: [], missing_caveats: [], anchoring: [],
});

/** `parsePrognosis` (`prognosis-core.ts:273`) returns null unless one of its three blocks is present. */
const PROGNOSIS = JSON.stringify({
  complications: [{
    complication: 'Parapneumonic effusion', likelihood: 'uncommon', severity: 'moderate',
    incidence_note: 'reported in a minority of hospitalised CAP admissions',
    evidence: ['Effusion is a recognised complication of lobar pneumonia'], citation_ids: [1],
  }],
  safety_net: [{
    risk: 'Recurrent fever after discharge', expected_mitigation: 'Documented return precautions',
    found_in_document: 'Breathlessness at rest', status: 'partially_mitigated',
  }],
  summary: 'One uncommon complication with a partially mitigated safety net.',
});

const PX_CRITIQUE = (needs: boolean) => JSON.stringify({
  needs_revision: needs, severity: needs ? 'minor' : 'none',
  missing_complications: needs ? ['empyema'] : [],
  unsupported_evidence: [], unmarked_estimates: [], wrong_net_status: [], vague_failure_signature: [],
});

/** The six labels a trace answers, with the reply production stored at each. */
const REPLIES: Record<string, string> = {
  doc_audit_analyze: ANALYSIS,
  doc_audit_critique_llm: CRITIQUE(true),
  doc_audit_revise: ANALYSIS,
  doc_audit_prognosis: PROGNOSIS,
  doc_audit_prognosis_critique: PX_CRITIQUE(true),
  doc_audit_prognosis_revise: PROGNOSIS,
};

// ─────────────────────────────────────────────────────────────────────────────────────
// The corpus: every ChunkHitWithMeta field, so decision 99's inventory means something
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ ALL TWENTY FIELDS OF `ChunkHitWithMeta` — `Chunk` (`db.ts:73-85`) + `similarity` (`:87`) + the
 * three rerank fields and the five lab-only diagnostics (`retrieve.ts:78-88`). The text is a
 * TEXTBOOK's, which is the whole of decision 99's answer here: a corpus chunk is corpus text, named
 * by `book` and `chapter`, and carries no patient.
 */
function chunk(n: number) {
  return {
    id: 1000 + n,
    source: 'mksap',
    book: 'MKSAP 19 Pulmonary and Critical Care Medicine',
    chapter: 'Community-Acquired Pneumonia',
    section: 'Management',
    page_start: 40 + n,
    page_end: 41 + n,
    item_number: `PCCM-${n}`,
    chunk_type: 'narrative',
    text: `Corpus excerpt ${n}: patients hospitalised with community-acquired pneumonia should be `
      + 'switched from intravenous to oral therapy once clinically stable, and repeat inflammatory '
      + 'markers are not recommended in the absence of a change in clinical course.',
    token_count: 64,
    similarity: 0.81 - n * 0.01,
    source_quality_weight: 1.2,
    rerank_score: 0.77 - n * 0.01,
    rerank_backend: 'judge',
    vector_rank: n,
    bm25_rank: n + 1,
    normative_rank: null,
    rrf_score: 0.031,
    final_rank: n,
  };
}

/** The retrieve stub: production's own result shape, distinct per query. */
function retrieveStub(seen: { query: string; opts: RetrieveOptions }[]) {
  return (async (query: string, opts: RetrieveOptions): Promise<RetrieveResult> => {
    seen.push({ query, opts });
    return {
      hits: [chunk(1), chunk(2)] as unknown as RetrieveResult['hits'],
      expandedQuery: `${query} (expanded)`,
      meta: { vector_pool: 40, bm25_pool: 25, fused: 12, reranked: opts.useReranker === true, source_weighted: true },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The fixture database: production's two trace tables, from their own DDL
// ─────────────────────────────────────────────────────────────────────────────────────

async function traceDb(): Promise<Db> {
  const db = await embedded();
  await db.exec(`CREATE TABLE discharge_extracted_cases (
    document_id         TEXT NOT NULL,
    extraction_version  TEXT NOT NULL DEFAULT 'doc-extract/1',
    ip_uid              TEXT,
    member_id           TEXT,
    extracted_json      JSONB NOT NULL,
    extracted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    trace_id            TEXT,
    PRIMARY KEY (document_id, extraction_version)
  )`);
  await db.exec(`CREATE TABLE ipd_discharge_audits (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    document_id text NOT NULL, ip_uid text, member_id text, care_value_index int, band text,
    engine_version text NOT NULL, model text, provider text, trace_id text,
    audited_at timestamptz DEFAULT NOW(), UNIQUE (document_id, engine_version))`);
  await db.exec(`CREATE TABLE traces (
    id BIGSERIAL PRIMARY KEY, trace_id TEXT NOT NULL UNIQUE, feature TEXT NOT NULL, input JSONB,
    started_at TIMESTAMPTZ DEFAULT NOW(), finished_at TIMESTAMPTZ, total_ms INT,
    status TEXT DEFAULT 'running', error_message TEXT, meta JSONB)`);
  await db.exec(`CREATE TABLE trace_events (
    id BIGSERIAL PRIMARY KEY,
    trace_id TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
    seq INT NOT NULL, ts TIMESTAMPTZ DEFAULT NOW(), kind TEXT NOT NULL, stage TEXT,
    payload JSONB, latency_ms INT)`);
  return db;
}

/**
 * ⚠️ THE INTERLEAVED SHAPE, WHICH IS THE POINT OF THE FIXTURE. V's console read measured one
 * request/response pair at each of the six analyze-family stages and FIFTEEN at
 * `doc_audit_cite_gate`, whose calls fire concurrently (`doc-audit.ts:345`) and whose rows therefore
 * land between the others in `seq` order with no correlation key. The cite-gate rows are seeded
 * BETWEEN the six so that a statement which merely ordered by `seq` would pick them up.
 */
async function seedTrace(
  db: Db, o: { traceId?: string; stages?: readonly string[]; replies?: Record<string, string>; citeGatePairs?: number } = {},
) {
  const traceId = o.traceId ?? TRACE;
  const stages = o.stages ?? Object.keys(REPLIES);
  const replies = o.replies ?? REPLIES;
  const pairs = o.citeGatePairs ?? 15;
  await db.query(`INSERT INTO traces (trace_id, feature, status) VALUES ($1, 'doc_audit', 'ok')
                  ON CONFLICT (trace_id) DO NOTHING`, [traceId]);
  let seq = 0;
  const put = async (kind: string, stage: string, payload: unknown) => {
    seq += 1;
    await db.query(
      `INSERT INTO trace_events (trace_id, seq, kind, stage, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [traceId, seq, kind, stage, JSON.stringify(payload)]);
  };
  let gateLeft = pairs;
  const someGate = async (n: number) => {
    for (let i = 0; i < n && gateLeft > 0; i += 1, gateLeft -= 1) {
      // ⚠️ THE SERVED MODEL, NOT `params.model` — `trace.ts:348-352` substitutes it on the request
      // row, which is exactly why a stored request cannot be re-hashed.
      await put('llm_request', 'doc_audit_cite_gate', {
        messages: [{ role: 'system', content: 'verify' }, { role: 'user', content: `claim ${gateLeft}` }],
        model: 'gemini-2.5-flash', provider: 'gemini', temperature: 0, max_tokens: 300, stream: false,
      });
      await put('llm_response', 'doc_audit_cite_gate', {
        content: '{"verdict":"partially_supports","supporting_span":null,"why":"adjacent"}',
        model: 'gemini-2.5-flash', provider: 'gemini', finish_reason: 'stop',
      });
    }
  };
  for (const stage of stages) {
    await put('llm_request', stage, {
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      model: 'gemini-2.5-pro', provider: 'vertex', temperature: 0.2, max_tokens: 2800, stream: false,
    });
    await put('llm_response', stage, {
      content: replies[stage] ?? '{}', model: 'gemini-2.5-pro', provider: 'vertex',
      finish_reason: 'stop', usage: { input_tokens: 1800, output_tokens: 600 },
    });
    await someGate(3);
  }
  await someGate(pairs);
  // The non-model rows that share every trace and are not legs.
  await put('doc_audit_sources', 'doc_audit_sources', { count: 2 });
  return traceId;
}

async function seedExtract(db: Db, o: { documentId?: string } = {}) {
  await db.query(
    `INSERT INTO discharge_extracted_cases (document_id, extraction_version, ip_uid, member_id, extracted_json, trace_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [o.documentId ?? DOC, DOC_EXTRACT_VERSION, 'IP-D2C-1', 'MEM-D2C-1', JSON.stringify(EXTRACTED), 'TR-EXTRACT-1']);
}

async function seedAudit(db: Db, o: { documentId?: string; traceId?: string | null } = {}) {
  await db.query(
    `INSERT INTO ipd_discharge_audits (document_id, ip_uid, member_id, care_value_index, band,
       engine_version, model, provider, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [o.documentId ?? DOC, 'IP-D2C-1', 'MEM-D2C-1', 68, 'C', IPD_ENGINE_VERSION,
      'gemini-2.5-pro', 'vertex', o.traceId === undefined ? TRACE : o.traceId]);
}

const runner = (db: Db) => (async (statement: string, params: unknown[]) => db.query(statement, params)) as never;

/** `readExtractedCaseAcrossVersions`' contract, answered from the PGlite table (as D2b's does). */
function storeRead(db: Db) {
  return (async (documentId: string, versions: readonly string[]) => {
    const rows = await db.query<Record<string, unknown>>(
      `SELECT document_id, extraction_version, ip_uid, member_id, extracted_json, trace_id
         FROM discharge_extracted_cases WHERE document_id = $1 AND extraction_version = ANY($2::text[])`,
      [documentId, [...versions]]);
    const r = rows[0];
    if (!r) return { outcome: 'absent' as const };
    return {
      outcome: 'found' as const, version: String(r.extraction_version),
      stored: {
        documentId: String(r.document_id), extractionVersion: String(r.extraction_version),
        ipUid: r.ip_uid == null ? null : String(r.ip_uid),
        memberId: r.member_id == null ? null : String(r.member_id),
        extracted: r.extracted_json, extractedAt: '2026-09-01T00:00:00+05:30',
        traceId: r.trace_id == null ? null : String(r.trace_id),
      },
    };
  }) as never;
}

/**
 * ⚠️ THE THREE ENV READS `analyzeCase:486-488` MAKES, SET AROUND THE PASS. Decision 123 is explicit
 * that the flags come from the deployment and not from the arm, and `lib/doc-audit.ts` is not edited
 * this round, so the only way to exercise the prognosis chain and the cite gate is to set what
 * production has set. Restored afterwards, always.
 */
async function withFlags<T>(flags: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(flags)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const ALL_ON = { DOC_AUDIT_AUDIT: undefined, PROGNOSIS_AUDIT: '1', DOC_AUDIT_CITE_GATE: '1' };

/** The freeze with every read answered from the fixture, the recording pass REAL. */
function freeze(db: Db, seen: { query: string; opts: RetrieveOptions }[], over: Record<string, unknown> = {}) {
  return freezeIpdDischargeDocument(DOC, {
    run: runner(db),
    readExtract: storeRead(db),
    fetchHeader: (async () => ({ speciality: 'Pulmonology', dischargeType: 'Discharged', losDays: 4, dischargeDate: '2026-08-14' })) as never,
    fetchBilling: (async () => null) as never,
    fetchTotal: (async () => 84250) as never,
    retrieve: retrieveStub(seen) as never,
    salt: SALT,
    ...over,
  });
}

/** A recorded case, ready for the adapter. */
async function recordedCase(o: { citeGatePairs?: number } = {}) {
  const db = await traceDb();
  await seedExtract(db);
  await seedAudit(db);
  await seedTrace(db, { citeGatePairs: o.citeGatePairs });
  const seen: { query: string; opts: RetrieveOptions }[] = [];
  const c = await withFlags(ALL_ON, () => freeze(db, seen));
  await db.close();
  return { frozen: c.frozen as FrozenIpdDischarge, case_key: c.case_key, source_versions: c.source_versions, seen };
}

// ═════════════════════════════════════════════════════════════════════════════════════
// ITEM 1 — the trace statement (decision 87)
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.10 item 1: IPD_DISCHARGE_TRACE_SQL is a bounded SELECT that writes nothing', () => {
  assert.match(IPD_DISCHARGE_TRACE_SQL, /^SELECT/);
  assert.match(IPD_DISCHARGE_TRACE_SQL, /WHERE trace_id = \$1/, 'the trace id is bound, never interpolated');
  assert.match(IPD_DISCHARGE_TRACE_SQL, /kind = 'llm_response'/, 'responses only — a stored request cannot be re-hashed');
  assert.match(IPD_DISCHARGE_TRACE_SQL, /stage <> 'doc_audit_cite_gate'/, 'decision 132: the cite gate is unpairable');
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'TRUNCATE']) {
    assert.ok(!new RegExp(`\\b${verb}\\b`).test(IPD_DISCHARGE_TRACE_SQL), `it contains ${verb}`);
  }
  assert.ok(!/SELECT \*/.test(IPD_DISCHARGE_TRACE_SQL), 'it names its five columns');
});

test('§17.10 decision 87: the trace read runs against a real trace_events and skips the cite gate', async () => {
  const db = await traceDb();
  await seedTrace(db);
  const rows = await db.query<Record<string, unknown>>(IPD_DISCHARGE_TRACE_SQL, [TRACE]);

  // ⚠️ SIX ROWS OUT OF A TRACE THAT HOLDS 21 RESPONSE ROWS. The fifteen cite-gate replies are
  // present, interleaved, and excluded — which is the claim, and it cannot be made by reading a
  // fixture that never had them.
  const allResponses = await db.query<Record<string, unknown>>(
    `SELECT stage FROM trace_events WHERE trace_id = $1 AND kind = 'llm_response'`, [TRACE]);
  assert.equal(allResponses.length, 21, 'six legs plus fifteen cite-gate replies');
  assert.deepEqual(rows.map((r) => r.stage).sort(), [...REPLAYED_STAGES].sort());
  assert.equal(rows.length, 6);
  for (const r of rows) {
    assert.equal(r.model, 'gemini-2.5-pro');
    assert.equal(r.provider, 'vertex');
    assert.ok(String(r.content).length > 10, 'the stored reply comes back whole');
  }
  // Ordered by seq, so the newest row per stage is the last one a reader sees.
  const seqs = rows.map((r) => Number(r.seq));
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  // Another audit's trace is not this one.
  assert.deepEqual(await db.query(IPD_DISCHARGE_TRACE_SQL, ['TR-SOMEONE-ELSE']), []);
  await db.close();
});

test('§17.10 item 1: the newest seq per stage wins', async () => {
  const db = await traceDb();
  await seedTrace(db, { citeGatePairs: 0 });
  await db.query(
    `INSERT INTO trace_events (trace_id, seq, kind, stage, payload) VALUES ($1, 999, 'llm_response', 'doc_audit_analyze', $2::jsonb)`,
    [TRACE, JSON.stringify({ content: 'THE RETRY', model: 'gemini-2.5-pro', provider: 'vertex' })]);
  const rec = await withFlags(ALL_ON, () => recordIpdDischargeSteps({
    traceId: TRACE, extracted: EXTRACTED as never, run: runner(db), retrieve: retrieveStub([]) as never,
  })).catch((e: LabError) => e);
  // The retry reply is not parseable analysis, so the pass refuses — which IS the proof that the
  // newest row won: the first row's valid analysis was overwritten by the last one.
  assert.ok(rec instanceof LabError, 'the newest reply decided the pass');
  assert.equal((rec as LabError).code, 'SOURCE_UNAVAILABLE');
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// ITEM 2 — the recording pass
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.10 item 2: the keep literal is what verify-core parses as KEEP, and it is not a fallback', () => {
  /**
   * ⚠️ THE PARSE LINE, QUOTED AND THEN RUN. `verifyCitation` (`doc-audit.ts:311-318`) is:
   *     const verdict = parseVerdict(res?.choices?.[0]?.message?.content ?? null).verdict;
   *     return (verdict === 'not_supported' || verdict === 'contradicts') ? 'drop' : 'keep';
   * so the literal must parse to a verdict inside the enum that is neither of those two.
   */
  const verdict: string = parseVerdict(CITE_GATE_KEEP_LITERAL).verdict;
  // The drop condition, run rather than described.
  assert.ok(verdict !== 'not_supported' && verdict !== 'contradicts', 'therefore a keep');
  // ⚠️ AND NOT `not_assessable`, which is what parseVerdict returns for ANYTHING unparseable. A
  // literal that failed to parse would also read as a keep and would prove nothing.
  assert.ok(verdict !== 'not_assessable', 'the keep is the parser\'s, not the fail-safe\'s');
  assert.equal(verdict, 'directly_supports');
  assert.equal(parseVerdict('not json at all').verdict, 'not_assessable', 'the fail-safe, for contrast');
  // The reply the recording edge returns carries no `model`, so verifyCitation:313-315 is skipped.
  assert.ok(!/"model"/.test(CITE_GATE_KEEP_LITERAL));
});

test('§17.10 item 2: the recording pass yields one step per stage and a retrieval map, at zero model cost', async () => {
  const { frozen, seen, source_versions } = await recordedCase();

  const steps = frozen.steps ?? {};
  const stages = Object.values(steps).map((s) => s.stage).sort();
  assert.deepEqual(stages, [...REPLAYED_STAGES].sort(), 'six steps, one per stage');
  for (const key of Object.keys(steps)) {
    assert.match(key, /^[0-9a-f]{64}$/, 'keyed by the request hash the pass was asked for');
    assert.equal(steps[key].request_hash, key);
    assert.equal(steps[key].served.model, 'gemini-2.5-pro');
    assert.equal(steps[key].served.provider, 'vertex');
  }
  assert.equal(steps[Object.keys(steps).find((k) => steps[k].stage === 'doc_audit_analyze')!].text, ANALYSIS);

  // ⚠️ THE RETRIEVAL MAP: pooled, prognosis and at least one per-finding enrichment.
  const retrieval = frozen.retrieval ?? {};
  assert.ok(Object.keys(retrieval).length >= 3, `three or more retrievals, saw ${Object.keys(retrieval).length}`);
  for (const [key, r] of Object.entries(retrieval)) {
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(r.hits.length, 2);
    assert.ok(String(r.expandedQuery).length > 0);
    assert.equal(r.query_hash.length, 64);
  }
  /**
   * ⚠️ KEYED BY THE QUERY **AND** THE OPTIONS, recomputed from what the stub actually saw. The two
   * option sets differ only in `topK`, `useReranker` and `skipExpand`, so a key built from the query
   * alone would collide the pooled read with an enrichment read that asked a different question of
   * the corpus — and a replay would then serve eight reranked chunks where the engine wanted four.
   */
  for (const s of seen) {
    assert.ok(retrieval[retrievalKey(s.query, s.opts)], `no frozen entry for ${s.query.slice(0, 40)}…`);
  }
  assert.notEqual(retrievalKey('q', { topK: 8 }), retrievalKey('q', { topK: 4 }), 'the options are in the key');
  // DECISION 136 — production's OWN options, both sets, untouched by the freeze.
  const optsSeen = seen.map((s) => JSON.stringify(s.opts));
  assert.ok(optsSeen.some((o) => o.includes('"useReranker":true')), 'the pooled read kept the reranker on');
  assert.ok(optsSeen.some((o) => o.includes('"skipExpand":true')), 'and enrichment kept its light options');

  assert.equal(frozen.text_model, TEXT_MODEL, 'params.model as the recording edge saw it');
  assert.deepEqual(Object.keys(frozen.flags ?? {}).sort(),
    ['DOC_AUDIT_AUDIT', 'DOC_AUDIT_CITE_GATE', 'PROGNOSIS_AUDIT']);
  assert.equal(source_versions.recorded_steps, 6);
  assert.equal(source_versions.text_model, TEXT_MODEL);
  assert.deepEqual(source_versions.recorded_stages, [...REPLAYED_STAGES].sort());
});

test('§17.10 item 1: the refusals — no trace, no analyze leg, and a read fault', async () => {
  const db = await traceDb();
  await seedTrace(db);

  await assert.rejects(
    () => recordIpdDischargeSteps({ traceId: null, extracted: EXTRACTED as never, run: runner(db), reason: 'no audit row at this engine version' }),
    (e: LabError) => e.code === 'SOURCE_UNAVAILABLE' && /no audit row at this engine version/.test(e.message));

  // ⚠️ THE STAGES FOUND ARE NAMED. An operator told only "unavailable" cannot tell a trace that is
  // the wrong audit's from one whose analyze row was never written.
  const noAnalyze = await traceDb();
  await seedTrace(noAnalyze, {
    traceId: 'TR-NO-ANALYZE',
    stages: ['doc_audit_critique_llm', 'doc_audit_prognosis'],
    citeGatePairs: 4,
  });
  await assert.rejects(
    () => recordIpdDischargeSteps({ traceId: 'TR-NO-ANALYZE', extracted: EXTRACTED as never, run: runner(noAnalyze) }),
    (e: LabError) => {
      assert.equal(e.code, 'SOURCE_UNAVAILABLE');
      assert.match(e.message, /no stored reply at doc_audit_analyze/);
      assert.match(e.message, /doc_audit_critique_llm, doc_audit_prognosis/, 'the stages it DOES hold');
      return true;
    });
  await noAnalyze.close();

  // ⚠️ FAIL-SAFE. A read fault is SOURCE_UNAVAILABLE, never a frozen case without steps.
  await assert.rejects(
    () => recordIpdDischargeSteps({
      traceId: TRACE, extracted: EXTRACTED as never,
      run: (async () => { throw new Error('connection reset by peer'); }) as never,
    }),
    (e: LabError) => e.code === 'SOURCE_UNAVAILABLE' && /connection reset by peer/.test(e.message));
  await db.close();
});

test('§17.10 item 1: a trace with no revise leg is NOT a refusal — the conditional stages fire on needs_revision', async () => {
  const db = await traceDb();
  await seedExtract(db);
  await seedAudit(db, { traceId: 'TR-NO-REVISION' });
  // The healthy outcome: both critiques satisfied, so neither revise leg was ever asked for.
  await seedTrace(db, {
    traceId: 'TR-NO-REVISION',
    stages: ['doc_audit_analyze', 'doc_audit_critique_llm', 'doc_audit_prognosis', 'doc_audit_prognosis_critique'],
    replies: { ...REPLIES, doc_audit_critique_llm: CRITIQUE(false), doc_audit_prognosis_critique: PX_CRITIQUE(false) },
  });
  const c = await withFlags(ALL_ON, () => freeze(db, []));
  const stages = Object.values(c.frozen.steps ?? {}).map((s) => s.stage).sort();
  assert.deepEqual(stages, ['doc_audit_analyze', 'doc_audit_critique_llm', 'doc_audit_prognosis', 'doc_audit_prognosis_critique']);
  for (const conditional of CONDITIONAL_STAGES) {
    assert.ok(!stages.includes(conditional), `${conditional} fires only on needs_revision`);
  }
  await db.close();
});

test('§17.10 item 1: a leg the engine ASKS for and the trace lacks refuses, naming it', async () => {
  const db = await traceDb();
  await seedExtract(db);
  await seedAudit(db, { traceId: 'TR-TORN' });
  // The critique asks for a revise and the trace carries no revise row — a torn trace, not a
  // satisfied critique, and the difference is exactly what the message has to say.
  await seedTrace(db, {
    traceId: 'TR-TORN',
    stages: ['doc_audit_analyze', 'doc_audit_critique_llm'],
    replies: { ...REPLIES, doc_audit_critique_llm: CRITIQUE(true) },
  });
  await assert.rejects(
    () => withFlags({ ...ALL_ON, PROGNOSIS_AUDIT: undefined }, () => freeze(db, [])),
    (e: LabError) => {
      assert.equal(e.code, 'SOURCE_UNAVAILABLE');
      assert.match(e.message, /asked for leg 'doc_audit_revise'/);
      assert.match(e.message, /doc_audit_analyze, doc_audit_critique_llm/, 'and what it does carry');
      return true;
    });
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// DECISIONS 99 AND 111 — the walk and the inventory over the new keys
// ═════════════════════════════════════════════════════════════════════════════════════

/** Every key in a body, at every depth, sorted and de-duplicated. */
function keyInventory(v: unknown, out = new Set<string>(), depth = 0): string[] {
  if (depth > 14 || v === null || typeof v !== 'object') return [...out].sort();
  if (Array.isArray(v)) { for (const x of v) keyInventory(x, out, depth + 1); return [...out].sort(); }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) { out.add(k); keyInventory(val, out, depth + 1); }
  return [...out].sort();
}

test('§17.10 item 6: decision 99 walks the recorded body — steps text and retrieval hits included', async () => {
  const { frozen } = await recordedCase();
  assert.deepEqual(identifyingKeys(frozen), [], 'the recorded body carries no denylist key');
  const text = JSON.stringify(frozen);
  for (const secret of ['IP-D2C-1', 'MEM-D2C-1', DOC, TRACE]) {
    assert.ok(!text.includes(secret), `${secret} must not survive the freeze`);
  }
  // ⚠️ CHUNK TEXT IS CORPUS TEXT, and it is asserted as such rather than assumed: named by book and
  // chapter, and it is what the six prompts will be rebuilt from.
  const first = Object.values(frozen.retrieval ?? {})[0];
  const hit = (first.hits as Record<string, unknown>[])[0];
  assert.equal(hit.book, 'MKSAP 19 Pulmonary and Critical Care Medicine');
  assert.equal(hit.chapter, 'Community-Acquired Pneumonia');
  assert.ok(String(hit.text).includes('community-acquired pneumonia'));
  assert.ok(String(hit.text).length > 200, 'FULL text, not B1\'s 400-character preview');
});

test('§17.10 item 6: the recorded body carries exactly these keys, and no others', async () => {
  const { frozen } = await recordedCase();
  /**
   * ⚠️ THE HASH KEYS ARE FILTERED, AND ONLY THEM. `steps` and `retrieval` are maps keyed by a
   * 64-hex digest, so their keys are DATA and not field names; every one of them is asserted by
   * SHAPE in the recording-pass test above. Everything else in the body must be a name somebody
   * classified — decision 111's question, over the shape D2c is the first round to store.
   */
  const inventory = keyInventory(frozen).filter((k) => !/^[0-9a-f]{64}$/.test(k));
  assert.deepEqual(inventory, [
    // the body itself — D2b's six, plus decision 134's four
    'billing', 'engine', 'extracted', 'extraction_version', 'envelope', 'stripped',
    'steps', 'retrieval', 'text_model', 'flags',
    // frozen.extracted — ExtractedCase minus verbatimSections
    'adminFacts', 'aftercare', 'completeness', 'confidence', 'courseSummary', 'detectedDocType',
    'diagnosis', 'disposition', 'docType', 'followUp', 'indication', 'investigations',
    'medications', 'patient', 'procedure', 'rawNotes', 'riskFactors', 'treatments',
    'age', 'sex', 'key', 'status', 'note',
    'admissionType', 'careSetting', 'lengthOfStayDays',
    'follow_up_detail', 'instructions', 'warning_signs',
    // frozen.envelope and frozen.billing
    'dischargeDate', 'dischargeType', 'losDays', 'speciality',
    'billCount', 'billedTotal', 'categories', 'lineCount', 'netTotal', 'pharmacyClasses',
    'pharmacyItems', 'refundTotal', 'saleTotal', 'wardClasses',
    // frozen.flags — the three process.env reads analyzeCase:486-488 makes
    'DOC_AUDIT_AUDIT', 'PROGNOSIS_AUDIT', 'DOC_AUDIT_CITE_GATE',
    // frozen.steps[hash] — one replayed leg
    'stage', 'request_hash', 'text', 'served', 'model', 'provider',
    // frozen.retrieval[hash] — one frozen retrieval
    'query_hash', 'opts', 'hits', 'expandedQuery', 'meta',
    // …its opts — the two option sets doc-audit.ts:244 and :259 pass
    'topK', 'useReranker', 'useSourceWeights', 'hybrid', 'skipExpand',
    // …its meta — RetrieveResult['meta'] (retrieve.ts:94-101)
    'vector_pool', 'bm25_pool', 'fused', 'reranked', 'source_weighted',
    // ⚠️ …AND EVERY ChunkHitWithMeta FIELD: Chunk (db.ts:73-85) + similarity (:87) + the three
    // rerank fields and the five lab-only diagnostics (retrieve.ts:78-88). Twenty names.
    'id', 'source', 'book', 'chapter', 'section', 'page_start', 'page_end', 'item_number',
    'chunk_type', 'token_count', 'similarity',
    'source_quality_weight', 'rerank_score', 'rerank_backend',
    'vector_rank', 'bm25_rank', 'normative_rank', 'rrf_score', 'final_rank',
  ].sort());
  // Every key in the inventory passes the denylist — the two checks agree.
  assert.deepEqual(inventory.filter(isIdentifyingKey), []);
  // And the hash keys are asserted BY SHAPE, since a digest is data and not a field name.
  for (const k of [...Object.keys(frozen.steps ?? {}), ...Object.keys(frozen.retrieval ?? {})]) {
    assert.match(k, /^[0-9a-f]{64}$/);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════
// ITEMS 3, 4 AND 5 — the replay, through tick
// ═════════════════════════════════════════════════════════════════════════════════════

const armStages = (labels: readonly string[]) => Object.fromEntries(
  labels.map((s) => [s, { provider: 'ollama', model: 'local-model', max_cost_microusd: 20_000 }]),
);

async function runFrozen(
  db: Db, frozen: Record<string, unknown>, key: string,
  o: { labels?: readonly string[]; retrieve?: unknown } = {},
) {
  const budget = await ensureBudget(db, 'research', 'default', 50_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, key, 'armhash', 86_400_000, [
    {
      case_key: 'ipddoc:d2c', arm_hash: 'armhash', repetition: 1,
      payload: { engine: 'ipd_discharge', frozen, arm: { stages: armStages(o.labels ?? LIVE_STAGES) }, budget_id: budget.id },
    },
  ]);
  await tick({
    db,
    transport: (async () => ({
      completion: { choices: [{ message: { content: ANALYSIS } }] },
      text: ANALYSIS,
      served: { provider: 'ollama', model: 'local-model' },
      usage: { input_tokens: 900, output_tokens: 300 },
    })) as never,
    adapters: {
      ipd_discharge: makeIpdDischargeAdapter({
        retrieve: (o.retrieve ?? (async () => { throw new Error('the retrieve edge must not be reached on a full hit'); })) as never,
      }),
    },
  });
  const [item] = await itemsOf(db, run.id);
  const calls = await db.query<{ stage: string; n: string }>(
    `SELECT stage, count(*)::text AS n FROM lab_v2.calls GROUP BY stage ORDER BY stage`);
  return { item, calls };
}

test('§17.10 items 3 and 8: an exact run replays the six and sends ONLY the cite gate and the skeleton live', async () => {
  const { frozen } = await recordedCase();
  const db = await freshDb();
  const { item, calls } = await withFlags(ALL_ON, () => runFrozen(db, frozen as unknown as Record<string, unknown>, 'd2c-exact'));

  assert.equal(item.state, 'succeeded', `the item failed: ${JSON.stringify(item.error)}`);
  const summary = (item.result as { summary: Record<string, unknown> }).summary;

  /**
   * ⚠️ THE ARM PRICES TWO STAGES AND THE ITEM SUCCEEDS, which is the claim in its strongest form.
   * The gateway refuses an unpriced label BY NAME (`gateway.ts:124`) and this adapter holds and
   * re-throws that refusal, so if ANY of the six analyze-family legs had reached the gateway the
   * item would have failed `MODEL_UNSUPPORTED` naming it. Six replies came from the case.
   */
  assert.equal(summary.exact_replay, true);
  assert.equal(summary.replayed_stages, 6);
  assert.deepEqual(Object.keys(summary.live_stages as object).sort(), [...LIVE_STAGES].sort());
  console.log('D2c REPLAY', JSON.stringify({
    legs: summary.legs, replayed: summary.replayed_stages, live: summary.live_stages,
    retrieval: summary.retrieval, prompt_drift: summary.prompt_drift,
  }));

  // And the ledger agrees: the only metered stages are the two that are live by ruling.
  assert.deepEqual(calls.map((c) => c.stage).sort(), [...LIVE_STAGES].sort());

  // ⚠️ DECISION 132 — RETRIEVAL IS ALL HITS, so no expand and no rerank judge left the fence.
  assert.deepEqual(summary.retrieval, { hits: Number((summary.retrieval as { hits: number }).hits), misses: 0 });
  assert.ok(Number((summary.retrieval as { hits: number }).hits) >= 3);
  assert.equal(summary.prompt_drift, 0, 'the freeze rebuilt the same prompts a run builds');
  assert.equal(summary.text_model, TEXT_MODEL);

  // The engine still produced a scored audit out of production's own replies.
  assert.equal(item.assessment_status, 'assessed');
  assert.equal(typeof summary.care_value_index, 'number');
  // Decision 132 — attribution is the GATEWAY's; the adapter declares none.
  assert.equal(item.attribution_status, 'verified');
  assert.deepEqual(identifyingKeys(summary), []);
  await db.close();
});

test('§17.10 item 4: a retrieval MISS runs live with skipExpand and useReranker FORCED', async () => {
  const { frozen } = await recordedCase();
  // Drop one entry so exactly one query misses; the rest still hit.
  const retrieval = { ...(frozen.retrieval ?? {}) };
  const dropped = Object.keys(retrieval)[0];
  const droppedOpts = retrieval[dropped].opts;
  delete retrieval[dropped];
  const body = { ...frozen, retrieval } as unknown as Record<string, unknown>;

  const seen: { query: string; opts: RetrieveOptions }[] = [];
  const db = await freshDb();
  const { item } = await withFlags(ALL_ON, () => runFrozen(db, body, 'd2c-miss', { retrieve: retrieveStub(seen) }));
  assert.equal(item.state, 'succeeded', `the item failed: ${JSON.stringify(item.error)}`);
  const summary = (item.result as { summary: Record<string, unknown> }).summary;

  assert.ok(Number((summary.retrieval as { misses: number }).misses) >= 1, 'the dropped query missed');
  assert.ok(seen.length >= 1, 'and reached retrieveImpl');
  /**
   * ⚠️ DECISION 133 — THE FENCE HOLE, CLOSED BY TWO OPTIONS. `expandQuery` (`retrieve.ts:405`) and
   * the rerank judge (`rerank.ts:311`) are the two model calls that ride out through the retrieve
   * edge's exit; forcing these two options kills both, so the only egress left on a lab run is the
   * embedding read, which decision 133 accepts and names.
   */
  for (const s of seen) {
    assert.equal(s.opts.skipExpand, true, 'skipExpand FORCED — no expand call leaves the fence');
    assert.equal(s.opts.useReranker, false, 'useReranker FORCED off — no rerank judge either');
  }
  // ⚠️ AND THE FORCING IS AN OVERRIDE, not a coincidence: the frozen entry's own options had the
  // reranker on or expansion allowed, and the miss ran with neither.
  assert.ok(droppedOpts.useReranker === true || droppedOpts.skipExpand !== true,
    'the dropped query was frozen at options the miss deliberately did not reuse');
  await db.close();
});

test('§17.10 item 3: a text_model mismatch is REPLAY_DIVERGED, naming it', async () => {
  const { frozen } = await recordedCase();
  const body = { ...frozen, text_model: 'a-different-text-model' } as unknown as Record<string, unknown>;
  const db = await freshDb();
  const { item } = await withFlags(ALL_ON, () => runFrozen(db, body, 'd2c-model'));
  assert.equal(item.state, 'failed');
  assert.equal((item.error as { code?: string }).code, 'REPLAY_DIVERGED');
  assert.match(String((item.error as { message?: string }).message), /a-different-text-model/);
  assert.match(String((item.error as { message?: string }).message), new RegExp(TEXT_MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await db.close();
});

test('§17.10 item 3: a conditional stage the engine asks for and the case lacks is REPLAY_DIVERGED', async () => {
  const { frozen } = await recordedCase();
  const steps = { ...(frozen.steps ?? {}) } as Record<string, IpdDischargeStep>;
  const reviseKey = Object.keys(steps).find((k) => steps[k].stage === 'doc_audit_revise')!;
  delete steps[reviseKey];
  const db = await freshDb();
  const { item } = await withFlags(ALL_ON, () => runFrozen(db, { ...frozen, steps } as unknown as Record<string, unknown>, 'd2c-torn'));
  assert.equal(item.state, 'failed');
  assert.equal((item.error as { code?: string }).code, 'REPLAY_DIVERGED');
  assert.match(String((item.error as { message?: string }).message), /doc_audit_revise/, 'the stage is named');
  await db.close();
});

test('§17.10 item 3: prompt_drift COUNTS a changed frozen input and does not fail the item', async () => {
  const { frozen } = await recordedCase();
  /**
   * ⚠️ DECISION 135 IN ONE ASSERTION. Production's prompts embed retrieved text production never
   * stored, so a hash mismatch is a statement about the prompt and NOT a reason to refuse the item:
   * it is counted and reported. Here the mismatch is manufactured by moving one stored hash.
   */
  const steps = { ...(frozen.steps ?? {}) } as Record<string, IpdDischargeStep>;
  const analyzeKey = Object.keys(steps).find((k) => steps[k].stage === 'doc_audit_analyze')!;
  steps[analyzeKey] = { ...steps[analyzeKey], request_hash: hash('a prompt this run will not build') };
  const db = await freshDb();
  const { item } = await withFlags(ALL_ON, () => runFrozen(db, { ...frozen, steps } as unknown as Record<string, unknown>, 'd2c-drift'));
  assert.equal(item.state, 'succeeded', `drift must never fail an item: ${JSON.stringify(item.error)}`);
  const summary = (item.result as { summary: Record<string, unknown> }).summary;
  assert.equal(summary.prompt_drift, 1, 'counted, once');
  assert.equal(summary.replayed_stages, 6, 'and the leg still replayed');
  await db.close();
});

test('§17.10 item 3: a D2b case with no steps still runs FRESH, unchanged', async () => {
  const { frozen } = await recordedCase();
  // Exactly what a dataset frozen by D2b carries: the four D2c keys absent.
  const body = {
    engine: frozen.engine, extracted: frozen.extracted, stripped: frozen.stripped,
    extraction_version: frozen.extraction_version, envelope: frozen.envelope, billing: frozen.billing,
  } as unknown as Record<string, unknown>;
  const db = await freshDb();
  const { item, calls } = await withFlags(ALL_ON, () => runFrozen(db, body, 'd2c-fresh', {
    labels: IPD_DISCHARGE_STAGES,
    retrieve: (async () => ({ hits: [chunk(1)], expandedQuery: 'q', meta: {} })),
  }));
  assert.equal(item.state, 'succeeded', `the item failed: ${JSON.stringify(item.error)}`);
  const summary = (item.result as { summary: Record<string, unknown> }).summary;
  assert.equal(summary.exact_replay, false);
  assert.equal(summary.replayed_stages, 0);
  assert.deepEqual(summary.retrieval, { hits: 0, misses: 0 }, 'no frozen retrieval, so neither counter moves');
  // Every leg was metered, which is exactly D2b's behaviour.
  assert.ok(calls.some((c) => c.stage === 'doc_audit_analyze'), 'the analyze leg reached the gateway');
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// ITEMS 7 AND 8 — through service dispatch (decision 109)
// ═════════════════════════════════════════════════════════════════════════════════════

const deps = (db: Db, principal: 'research' | 'operator' = 'operator') =>
  ({ db, principal, protocolVersion: 'test', sdkVersion: 'test' }) as never;

test('§17.10 item 7: engine_describe still offers only mutable_source, and the split is six live-two', async () => {
  const db = await freshDb();
  const out = await callTool(deps(db), 'engine_describe', { engine: 'ipd_discharge' }) as {
    replay_exactness_available: string[]; frozen_inputs: string[]; stages: { name: string }[];
  };
  /**
   * ⚠️ DECISION 132 — `mutable_source`, AND THE CITE GATE IS WHY. Six of eight stages replay from
   * production's stored replies at zero cost, but `doc_audit_cite_gate` and `pathway_skeleton` run
   * LIVE at the arm's own model, so a run of this engine is not reproducible from the case alone
   * and must not claim to be.
   *
   * ⚠️ FLAGGED IN THE ROUND REPORT: §17.10 item 7 also asks for a `note` on this output naming the
   * six and the two, and `engine_describe` builds its object inline in `service.ts:416-435` with no
   * per-adapter hook — and `service.ts` is on this round's HARD untouched list. The split is
   * asserted here from the two exported constants instead of being described in a field this round
   * may not add.
   */
  assert.deepEqual(out.replay_exactness_available, ['mutable_source']);
  assert.deepEqual(out.frozen_inputs,
    ['extracted', 'envelope', 'billing', 'extraction_version', 'steps', 'retrieval']);
  assert.deepEqual(out.stages.map((s) => s.name), [...IPD_DISCHARGE_STAGES]);
  // The six and the two are disjoint and together are the eight the engine declares.
  assert.deepEqual([...REPLAYED_STAGES, ...LIVE_STAGES].sort(), [...IPD_DISCHARGE_STAGES].sort());
  assert.equal(REPLAYED_STAGES.length, 6);
  assert.equal(LIVE_STAGES.length, 2);
  for (const s of LIVE_STAGES) {
    assert.ok(!(REPLAYED_STAGES as readonly string[]).includes(s), `${s} is live, never replayed`);
  }
  await db.close();
});

test('§17.10 item 8: dataset_create still reaches the freeze, and run_diff is unchanged', async () => {
  const db = await freshDb();
  const { IDENTIFYING_PRINCIPALS_ENV } = await import('../contracts');
  await withFlags({ [IDENTIFYING_PRINCIPALS_ENV]: 'operator', LAB_V2_MEMBER_SALT: SALT }, async () => {
    /**
     * ⚠️ RULE 1a, §17.11 DECISION 144 — THE CALL NO LONGER REFUSES; IT QUEUES. Same edit and same
     * reason as `d2b-ipd-discharge.test.ts`: until D3 the freeze ran inside the tool call and this
     * sandbox has no production database, so the assertion was a `SOURCE_UNAVAILABLE`. The freeze
     * is now a run, the refusal has moved to the item, and what this test is for — that
     * dataset_create REACHES the freeze path for this engine and echoes no identifier — is proved
     * by the run it returns. Not a mechanical pin; the round report says so.
     */
    const queued = await callTool(deps(db), 'dataset_create', {
      engine: 'ipd_discharge', body: { documentId: DOC }, idempotency_key: 'd2c-1',
    }) as { freeze_run_id: string; state: string; requested: number };
    assert.equal(queued.state, 'freezing');
    assert.equal(queued.requested, 1);
    assert.ok(!JSON.stringify(queued).includes(DOC), 'the identifier is not echoed back');
  });

  // run_diff: D2a's six fields and D2b's headline, untouched by this round.
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const seed = async (key: string, cvi: number, band: string) => {
    const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, key, 'h', 86_400_000,
      [{ case_key: 'c1', arm_hash: 'armA', repetition: 1, payload: {} }]);
    const [it] = await itemsOf(db, run.id);
    await db.query(
      `UPDATE lab_v2.items SET state = 'succeeded', execution_status = 'succeeded',
         assessment_status = 'assessed', attribution_status = 'verified', result = $2::jsonb WHERE id = $1`,
      [it.id, JSON.stringify({ result_hash: key, summary: { engine: 'ipd_discharge', care_value_index: cvi, band } })]);
    return run;
  };
  const a = await seed('d2c-diff-a', 68, 'C');
  const b = await seed('d2c-diff-b', 74, 'B');
  const out = await callTool(deps(db), 'run_diff', { run_a: a.id, run_b: b.id }) as {
    cases: { care_value_index_before: number | null; care_value_index_after: number | null; band_after: string | null }[];
  };
  assert.equal(out.cases[0].care_value_index_before, 68);
  assert.equal(out.cases[0].care_value_index_after, 74);
  assert.equal(out.cases[0].band_after, 'B');
  await db.close();
});

test('§17.10: a recorded case hashes stably, so two freezes of one document are one dataset', async () => {
  const db = await traceDb();
  await seedExtract(db);
  await seedAudit(db);
  await seedTrace(db);
  const a = await withFlags(ALL_ON, () => freeze(db, []));
  const b = await withFlags(ALL_ON, () => freeze(db, []));
  assert.equal(a.case_key, b.case_key);
  assert.equal(hash(a.frozen), hash(b.frozen), 'the recorded body is deterministic, steps and all');
  await db.close();
});

test('§17.10 item 3: the stored result never carries a production identifier', async () => {
  const { frozen } = await recordedCase();
  const db = await freshDb();
  const { item } = await withFlags(ALL_ON, () => runFrozen(db, frozen as unknown as Record<string, unknown>, 'd2c-clean'));
  const artifactId = (item.result as { artifact_id: string }).artifact_id;
  const row = (await getObject(db, artifactId))!.body as Record<string, unknown>;
  assert.deepEqual(identifyingKeys(row), []);
  const text = JSON.stringify(item.result);
  for (const secret of [DOC, TRACE, 'IP-D2C-1', 'MEM-D2C-1']) {
    assert.ok(!text.includes(secret), `${secret} must not reach the result`);
  }
  await db.close();
});
