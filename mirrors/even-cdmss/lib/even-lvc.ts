/**
 * lib/even-lvc.ts — IMPURE orchestration for the Even LVC Adjudication System (Phase 1). Owns the DB
 * reads/writes, the embeddings, and the (governed) generation model call; all decision logic lives in
 * lib/even-lvc-core.ts. Every DB path is FAIL-SAFE: an error degrades to empty / no-op, never a 500 and
 * never wrong data. Grounding stays additive + score-invariant — this module never writes a finding
 * verdict/score/band/lvc_category (it only reads findings to build a de-identified digest, and writes
 * the assertion library + its embedded mksap_chunks).
 *
 * ⚠️ SQL HONESTY: this sandbox has NO live DB. Every query/DDL/insert below is INFERRED from the shapes
 * in migrate-even-lvc + migrate-opd-audits + seed-choosing-wisely, and listed verbatim in the build
 * report for validation against live Neon before users touch this.
 *
 * GOVERNANCE: the Kimi generation call routes through governedChat (lib/trace.ts → lib/llm.ts) — the
 * ONLY governed model path (reasoning:governance hard gate). governedChat with an `openrouter` slug uses
 * openrouterChatClient() under the hood; we then verify the SERVED model agrees with the intended slug
 * (modelsAgree) and treat any disagreement (a silent Ollama fallback, or OPENROUTER_API_KEY absent) as
 * an OpenRouter error → status='error', 0 candidates — NEVER trusting an Ollama-derived candidate.
 */
import { createHash } from 'crypto';
import { sql } from './db';
import { embedQuery, vectorLiteral, openrouterConfigured, modelsAgree, AUDIT_LLM_SEED } from './llm';
import { governedChat, startTrace, finishTraceIfRunning } from './trace';
import { OPD_ENGINE_VERSIONS_CURRENT } from './opd-note-audit-core';
import { EVEN_SOURCE, type EvenCategoryLookup } from './normative-grounding-core';
import {
  buildDigest, evenGenUserMessage, EVEN_GEN_SYSTEM, parseCandidatesJson, dedupeCandidates,
  assignAssertionIds, computeOwnCases, rollupContests, evenChunkSection, normalizeSubject,
  EVEN_GEN_MODEL_DEFAULT, EVEN_CHUNK_BOOK, LVC_GEN_SUBJECT_MIN, LVC_GEN_MAX_CANDIDATES, LVC_CONTEST_FLAG,
  type DigestRow, type ExistingAssertion, type AssertionStatus, type GenCandidate,
} from './even-lvc-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';
const ENGINES = [...OPD_ENGINE_VERSIONS_CURRENT];

// env-resolved knobs (defaults from the pure core)
const GEN_MODEL = process.env.LVC_GEN_MODEL || EVEN_GEN_MODEL_DEFAULT;
const MAX_CANDIDATES = Math.max(1, parseInt(process.env.LVC_GEN_MAX_CANDIDATES || String(LVC_GEN_MAX_CANDIDATES), 10) || LVC_GEN_MAX_CANDIDATES);
const CONTEST_FLAG = Math.max(1, parseInt(process.env.LVC_CONTEST_FLAG || String(LVC_CONTEST_FLAG), 10) || LVC_CONTEST_FLAG);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const approxTokens = (s: string) => Math.max(1, Math.floor(s.length / 4));

export interface EvenAssertionRow {
  id: string; artifact_type: string; lvc_category: string; assertion_text: string; rationale: string | null;
  supporting: Array<{ subject: string; count: number }>; status: AssertionStatus; version: number;
  generated_by: string | null; ratified_by: string | null; ratified_at: string | null; own_cases: boolean;
  contest_count: number; chunk_item_number: string | null; created_at: string; updated_at: string;
}

// ── INFERRED SQL (validate verbatim against live Neon) ──────────────────────────
// PRD §1.1 — span ALL lvc-tagged engine history (NO engine_version predicate; pre-0.81.8 rows are
// null-category and self-exclude via the lvc_category-not-null filter). The floor here strips only
// singletons ($2 = LVC_GEN_SUBJECT_MIN); category-grain qualification (≥ LVC_GEN_CAT_MIN) + topK live
// in buildDigest. Fail-safe: a query error returns a logged no-op run (see runGeneration).
const DIGEST_SQL = `SELECT f->>'lvc_category' AS lvc_category, lower(btrim(f->>'subject')) AS subject, count(*)::int AS n
  FROM opd_note_audits a, jsonb_array_elements(a.findings) f
  WHERE a.app_source = $1 AND a.excluded_reason IS NULL
    AND f->>'verdict' = 'low-value'
    AND coalesce((f->>'informational')::boolean, false) = false
    AND f->>'subject' IS NOT NULL AND btrim(f->>'subject') <> ''
    AND f->>'lvc_category' IS NOT NULL
  GROUP BY 1, 2
  HAVING count(*) >= $2`;

// own_cases computed across the SAME full history (no engine_version predicate). $2=lvc_category, $3=subjects.
const OWN_CASES_DOCTORS_SQL = `SELECT DISTINCT a.doctor_uid
  FROM opd_note_audits a, jsonb_array_elements(a.findings) f
  WHERE a.app_source = $1 AND a.excluded_reason IS NULL
    AND f->>'verdict' = 'low-value' AND f->>'lvc_category' = $2
    AND lower(btrim(f->>'subject')) = ANY($3) AND a.doctor_uid IS NOT NULL`;

const EMBED_INSERT_SQL = `INSERT INTO mksap_chunks (source, book, chapter, section, item_number, chunk_type, text, text_hash, embedding, token_count)
  VALUES ('even-lvc', $1, $2, $3, $4, 'assertion', $5, $6, $7::vector, $8)
  ON CONFLICT (book, text_hash) DO NOTHING`;

const CHUNK_HIDE_SQL = `UPDATE mksap_chunks SET visible = false WHERE source = 'even-lvc' AND item_number = $1`;

// Self-heal dead 'running' rows (a killed / navigated-away serverless fn) so the ?auto=1 cron is not
// blocked forever by the in-progress guard. Interval mirrors LVC_RUN_STALE_MIN (10 min). Best-effort.
const EXPIRE_STALE_RUNS_SQL = `UPDATE even_lvc_gen_runs SET status = 'error', finished_at = now(), error = 'expired (stale running)'
  WHERE status = 'running' AND started_at < now() - interval '10 minutes'`;

// ── generation (PRD §5, §5.2) ───────────────────────────────────────────────────
export interface GenerationResult { ok: boolean; status: 'ok' | 'error' | 'skipped'; n_candidates: number; run_id?: string; reason?: string }

/** Idempotency guards (PRD §3.2): skip when a fresh 'running' run exists OR (for ?auto=1) no new
 *  low-value findings since the last 'ok' run. Fail-safe: any probe error ⇒ do NOT skip (better to run
 *  the idempotent, dedup-guarded generation than to silently stall). */
async function shouldSkipAuto(): Promise<string | null> {
  try {
    const running = await run(`SELECT 1 FROM even_lvc_gen_runs WHERE status = 'running' AND started_at > now() - interval '10 minutes' LIMIT 1`, []);
    if (running.length) return 'a generation run is already in progress';
  } catch { /* probe failed ⇒ don't block */ }
  try {
    const lastOk = await run(`SELECT started_at FROM even_lvc_gen_runs WHERE status = 'ok' ORDER BY started_at DESC LIMIT 1`, []);
    const since = lastOk[0]?.started_at as string | undefined;
    if (since) {
      const fresh = await run(`SELECT 1 FROM opd_note_audits
        WHERE app_source = $1 AND engine_version = ANY($2) AND excluded_reason IS NULL
          AND audited_at > $3 AND findings @> '[{"verdict":"low-value"}]' LIMIT 1`, [APP, ENGINES, since]);
      if (!fresh.length) return 'no new low-value findings since the last successful run';
    }
  } catch { /* probe failed ⇒ don't block */ }
  return null;
}

export async function runGeneration(opts: { trigger: 'manual' | 'cron'; auto?: boolean }): Promise<GenerationResult> {
  const trigger = opts.trigger;
  // Expire dead 'running' rows first (both manual + auto) so a stale row self-heals and never blocks the
  // in-progress guard beyond LVC_RUN_STALE_MIN. Best-effort: an error here must never fail generation.
  try { await run(EXPIRE_STALE_RUNS_SQL, []); } catch { /* best-effort self-heal */ }
  if (opts.auto) {
    const skip = await shouldSkipAuto();
    if (skip) { try { await run(`INSERT INTO even_lvc_gen_runs (status, trigger, finished_at, n_candidates) VALUES ('skipped', $1, now(), 0)`, [trigger]); } catch { /* best-effort log */ } return { ok: true, status: 'skipped', n_candidates: 0, reason: skip }; }
  }

  // open the run
  let runId: string | undefined;
  try {
    const r = await run(`INSERT INTO even_lvc_gen_runs (status, trigger) VALUES ('running', $1) RETURNING id`, [trigger]);
    runId = String(r[0]?.id ?? '');
  } catch (e) {
    return { ok: false, status: 'error', n_candidates: 0, reason: `could not open run: ${String((e as Error).message).slice(0, 120)}` };
  }

  const fail = async (reason: string): Promise<GenerationResult> => {
    try { await run(`UPDATE even_lvc_gen_runs SET status = 'error', finished_at = now(), n_candidates = 0, error = $2 WHERE id = $1`, [runId, reason.slice(0, 500)]); } catch { /* best-effort */ }
    return { ok: false, status: 'error', n_candidates: 0, run_id: runId, reason };
  };
  const done = async (n: number): Promise<GenerationResult> => {
    try { await run(`UPDATE even_lvc_gen_runs SET status = 'ok', finished_at = now(), n_candidates = $2 WHERE id = $1`, [runId, n]); } catch { /* best-effort */ }
    return { ok: true, status: 'ok', n_candidates: n, run_id: runId };
  };

  // 1) de-identified digest
  let digestRows: DigestRow[];
  try {
    const rows = await run(DIGEST_SQL, [APP, LVC_GEN_SUBJECT_MIN]);
    digestRows = rows.map((r) => ({ lvc_category: String(r.lvc_category ?? ''), subject: String(r.subject ?? ''), n: Number(r.n) || 0 }));
  } catch (e) { return fail(`digest query failed: ${String((e as Error).message).slice(0, 160)}`); }
  const clusters = buildDigest(digestRows);   // category-grain qualification + topK (PRD §1.1 defaults)
  if (!clusters.length) return done(0);
  const allowedCategories = clusters.map((c) => c.lvc_category);

  // 2) GOVERNED generation call (OpenRouter/Kimi) — never fall back to Ollama for a clinical candidate
  let served = '';
  let content = '';
  // Addendum A §4 (register A-12): open a trace and pass a REAL traceId, so the generation run's
  // provider_fallback / llm_request / llm_response events are written to trace_events (governedChat with
  // a real traceId routes through tracedChat; with `undefined` it used the untraced chatWithFallback, so
  // the fallback was invisible in v_trace_summary for 36h). Fail-safe: tracing never blocks generation.
  let genTraceId: string | undefined;
  try { genTraceId = await startTrace('lvc-generate', { model: GEN_MODEL, clusters: clusters.length, max_candidates: MAX_CANDIDATES }); } catch { genTraceId = undefined; }
  try {
    const completion = await governedChat(
      genTraceId, 'lvc-generate',
      // Audit-Score-Determinism PRD §8d (Phase 2): pin the LVC/Kimi adjudication generation too —
      // greedy + fixed seed + canonical top_p + OpenRouter provider-pin (no cross-backend fallback,
      // seed-honoring provider only). These ride governedChat→...rest to the OpenRouter client.
      // Addendum A §2 (the actual bug): request reasoning EXPLICITLY so tracedChat's `'reasoning' in rest`
      // check finds it and STOPS injecting reasoning:{enabled:false} — which every modern reasoning model
      // rejects with a 400 ("Reasoning is mandatory and cannot be disabled"), the real root cause of A-12.
      { model: GEN_MODEL, messages: [{ role: 'system', content: EVEN_GEN_SYSTEM }, { role: 'user', content: evenGenUserMessage(clusters, MAX_CANDIDATES) }], temperature: 0, top_p: 1, seed: AUDIT_LLM_SEED, max_tokens: 4000, reasoning: { max_tokens: 2000 }, provider: { allow_fallbacks: false, require_parameters: true } },
      { openrouter: GEN_MODEL },
    ) as { model?: string; choices?: Array<{ message?: { content?: string } }> };
    served = String(completion?.model ?? '');
    content = String(completion?.choices?.[0]?.message?.content ?? '');
    if (genTraceId) await finishTraceIfRunning(genTraceId, 'success').catch(() => {});
  } catch (e) {
    if (genTraceId) await finishTraceIfRunning(genTraceId, 'error', String((e as Error).message).slice(0, 200)).catch(() => {});
    return fail(`OpenRouter generation error: ${String((e as Error).message).slice(0, 160)}`);
  }
  // integrity: if OpenRouter isn't configured or the served model is not the intended one (a silent
  // Ollama fallback happened inside chatWithFallback), reject the output — PRD §1.3 "never Ollama".
  if (!openrouterConfigured() || !modelsAgree(served, GEN_MODEL)) {
    return fail(`served model '${served || 'none'}' != intended '${GEN_MODEL}' (OpenRouter unavailable) — refusing Ollama-derived candidates`);
  }

  // 3) parse + dedup
  const parsed = parseCandidatesJson(content, allowedCategories);
  if (!parsed.length) return done(0);

  // dedup needs cosine over assertion texts + existing library. Fail-safe: any embed error ⇒ text-eq only.
  let existing: ExistingAssertion[] = [];
  try {
    const rows = await run(`SELECT id, lvc_category, assertion_text, status FROM even_lvc_assertions`, []);
    existing = rows.map((r) => ({ id: String(r.id), lvc_category: String(r.lvc_category), assertion_text: String(r.assertion_text), status: String(r.status) as AssertionStatus }));
  } catch { existing = []; }
  const simFn = await buildTextSimilarity([...parsed.map((c) => c.assertion_text), ...existing.map((e) => e.assertion_text)]);
  const survivors = dedupeCandidates(parsed, existing, simFn, MAX_CANDIDATES);
  if (!survivors.length) return done(0);

  // 4) insert survivors as pending
  const existingIds = existing.map((e) => e.id);
  const withIds = assignAssertionIds(survivors, existingIds);
  let inserted = 0;
  for (const { id, candidate } of withIds) {
    try {
      await run(`INSERT INTO even_lvc_assertions (id, artifact_type, lvc_category, assertion_text, rationale, supporting, status, generated_by)
        VALUES ($1, 'opd_note', $2, $3, $4, $5::jsonb, 'pending', $6) ON CONFLICT (id) DO NOTHING`,
        [id, candidate.lvc_category, candidate.assertion_text, candidate.rationale, JSON.stringify(candidate.supporting ?? []), GEN_MODEL]);
      inserted++;
    } catch (e) { console.warn('[even-lvc] insert candidate failed', id, String((e as Error).message).slice(0, 100)); }
  }
  return done(inserted);
}

/** Build a cosine-similarity fn over a fixed text set (nomic embeddings, cached). Fail-safe: on any
 *  embed error the text is treated as orthogonal (sim 0) so dedup degrades to exact text-equality only. */
async function buildTextSimilarity(texts: string[]): Promise<(a: string, b: string) => number> {
  const vecs = new Map<string, number[] | null>();
  for (const t of [...new Set(texts)]) {
    try { vecs.set(t, await embedQuery(t)); } catch { vecs.set(t, null); }
  }
  return (a: string, b: string): number => {
    const va = vecs.get(a); const vb = vecs.get(b);
    if (!va || !vb || va.length !== vb.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < va.length; i++) { dot += va[i] * vb[i]; na += va[i] * va[i]; nb += vb[i] * vb[i]; }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  };
}

// ── ratify / reject / retire (PRD §6) ────────────────────────────────────────────
export interface RatifyResult { ok: boolean; error?: string; id?: string; status?: string; version?: number; own_cases?: boolean; embedded?: boolean }

/** Ratify (or edit-and-ratify) an assertion → active, embed into mksap_chunks. Fail-safe; never a 500. */
export async function ratifyAssertion(input: { id: string; ratified_by: string; assertion_text?: string }): Promise<RatifyResult> {
  const id = String(input.id ?? '').trim();
  const ratified_by = String(input.ratified_by ?? '').trim();
  if (!id) return { ok: false, error: 'id required' };
  if (!ratified_by) return { ok: false, error: 'ratified_by (roster identity) required' };

  let row: EvenAssertionRow | undefined;
  try {
    const rows = await run(`SELECT id, lvc_category, assertion_text, rationale, supporting, status, version FROM even_lvc_assertions WHERE id = $1`, [id]);
    row = rows[0] as unknown as EvenAssertionRow;
  } catch (e) { return { ok: false, error: `lookup failed: ${String((e as Error).message).slice(0, 120)}` }; }
  if (!row) return { ok: false, error: 'assertion not found' };

  const prevStatus = String(row.status) as AssertionStatus;
  const prevVersion = Math.max(1, Number(row.version) || 1);
  const editText = typeof input.assertion_text === 'string' && input.assertion_text.trim() ? input.assertion_text.trim() : null;
  const newText = editText ?? String(row.assertion_text);
  const newVersion = (prevStatus === 'active' || prevStatus === 'contested') ? prevVersion + 1 : prevVersion;

  // own_cases (rarely true; roster reviewers ≠ audited doctors). Fail-safe ⇒ no doctors ⇒ false.
  let ownCases = false;
  try {
    const supporting = Array.isArray(row.supporting) ? row.supporting : JSON.parse((row.supporting as unknown as string) || '[]');
    const subjects = (supporting as Array<{ subject?: string }>).map((s) => normalizeSubject(s?.subject)).filter(Boolean);
    if (subjects.length) {
      const docs = await run(OWN_CASES_DOCTORS_SQL, [APP, row.lvc_category, subjects]);
      ownCases = computeOwnCases(ratified_by, docs.map((d) => String(d.doctor_uid ?? '')));
    }
  } catch { ownCases = false; }

  try {
    await run(`UPDATE even_lvc_assertions
      SET status = 'active', assertion_text = $2, ratified_by = $3, ratified_at = now(), own_cases = $4,
          version = $5, chunk_item_number = $1, updated_at = now()
      WHERE id = $1`, [id, newText, ratified_by, ownCases, newVersion]);
  } catch (e) { return { ok: false, error: `ratify update failed: ${String((e as Error).message).slice(0, 120)}` }; }

  // embed into mksap_chunks (supersede any prior version's chunk first so only the current text grounds)
  let embedded = false;
  try {
    await run(CHUNK_HIDE_SQL, [id]);                                   // hide prior versions (visible=false)
    const chunkText = row.rationale ? `${newText}\n\nWhy: ${row.rationale}` : newText;
    const emb = vectorLiteral(await embedQuery(chunkText));
    await run(EMBED_INSERT_SQL, [EVEN_CHUNK_BOOK, row.lvc_category, evenChunkSection('active', newVersion), id, chunkText, sha256(`${id}:${chunkText}`), emb, approxTokens(chunkText)]);
    // ensure the freshly-inserted current chunk is visible (a superseded-then-reinserted id may have been hidden)
    await run(`UPDATE mksap_chunks SET visible = true WHERE source = 'even-lvc' AND item_number = $1 AND text_hash = $2`, [id, sha256(`${id}:${chunkText}`)]);
    embedded = true;
  } catch (e) { console.warn('[even-lvc] embed-on-ratify failed', id, String((e as Error).message).slice(0, 120)); }

  return { ok: true, id, status: 'active', version: newVersion, own_cases: ownCases, embedded };
}

export async function rejectAssertion(id: string): Promise<{ ok: boolean; error?: string }> {
  const key = String(id ?? '').trim();
  if (!key) return { ok: false, error: 'id required' };
  try {
    await run(`UPDATE even_lvc_assertions SET status = 'rejected', updated_at = now() WHERE id = $1`, [key]);
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 120) }; }
}

/** Retire → status='retired' + hide the embedded chunk (visible=false stops grounding, keeps provenance). */
export async function retireAssertion(id: string): Promise<{ ok: boolean; error?: string }> {
  const key = String(id ?? '').trim();
  if (!key) return { ok: false, error: 'id required' };
  try {
    await run(`UPDATE even_lvc_assertions SET status = 'retired', updated_at = now() WHERE id = $1`, [key]);
    try { await run(CHUNK_HIDE_SQL, [key]); } catch (e) { console.warn('[even-lvc] retire hide-chunk failed', key, String((e as Error).message).slice(0, 120)); }
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 120) }; }
}

// ── board load + contest rollup (PRD §6 list) ────────────────────────────────────
export interface Board { pending: EvenAssertionRow[]; active: EvenAssertionRow[]; contested: EvenAssertionRow[]; retired: EvenAssertionRow[]; rejected: EvenAssertionRow[]; pendingCount: number }

const EMPTY_BOARD: Board = { pending: [], active: [], contested: [], retired: [], rejected: [], pendingCount: 0 };

export async function loadBoard(): Promise<Board> {
  let rows: EvenAssertionRow[];
  try {
    const r = await run(`SELECT id, artifact_type, lvc_category, assertion_text, rationale, supporting, status, version,
      generated_by, ratified_by, ratified_at, own_cases, contest_count, chunk_item_number, created_at, updated_at
      FROM even_lvc_assertions ORDER BY updated_at DESC`, []);
    rows = r as unknown as EvenAssertionRow[];
  } catch { return EMPTY_BOARD; }

  // recompute contest counts from the feedback channel + apply the active→contested flip (fail-safe)
  try {
    // D-E (2 Aug 2026): app_source was the ONE predicate missing here — every other read of
    // opd_audit_feedback in the tree filters it (admin/opd-audit/[id], admin/opd-audit, the doctor
    // page, care). Without it the contest count on the assertion board summed rows written by any
    // app sharing the table. Shape copied from app/admin/opd-audit/[id]/page.tsx:537.
    // scope / assertion_id / study are UNCHANGED; the enclosing try still returns the raw board.
    const contestRows = await run(`SELECT assertion_id FROM opd_audit_feedback WHERE scope = 'assertion_contest' AND app_source = $1 AND assertion_id IS NOT NULL AND study IS NOT DISTINCT FROM $2`, [APP, null]);
    const updates = rollupContests(
      rows.map((r) => ({ id: r.id, status: r.status, contest_count: Number(r.contest_count) || 0 })),
      contestRows.map((c) => ({ assertion_id: c.assertion_id as string })),
      CONTEST_FLAG,
    );
    const byId = new Map(updates.map((u) => [u.id, u]));
    for (const u of updates) {
      if (!u.changed) continue;
      try { await run(`UPDATE even_lvc_assertions SET contest_count = $2, status = $3, updated_at = now() WHERE id = $1`, [u.id, u.contest_count, u.status]); } catch { /* best-effort */ }
    }
    // reflect the recomputed values in the returned rows
    for (const r of rows) { const u = byId.get(r.id); if (u) { r.contest_count = u.contest_count; r.status = u.status; } }
  } catch { /* rollup is advisory; the raw board still renders */ }

  const board: Board = { ...EMPTY_BOARD, pending: [], active: [], contested: [], retired: [], rejected: [] };
  for (const r of rows) {
    if (r.status === 'pending') board.pending.push(r);
    else if (r.status === 'active') board.active.push(r);
    else if (r.status === 'contested') board.contested.push(r);
    else if (r.status === 'retired') board.retired.push(r);
    else if (r.status === 'rejected') board.rejected.push(r);
  }
  board.pendingCount = board.pending.length;
  return board;
}

/** Load the id→category lookup for ACTIVE/CONTESTED assertions (the even grounding leg's dynamic gate,
 *  PRD §4). Fail-safe ⇒ a lookup that grounds nothing. For the Phase-2 grounding runner / verification. */
export async function loadEvenCategoryLookup(): Promise<EvenCategoryLookup> {
  const map = new Map<string, string>();
  try {
    const rows = await run(`SELECT id, lvc_category FROM even_lvc_assertions WHERE status IN ('active','contested')`, []);
    for (const r of rows) map.set(String(r.id), String(r.lvc_category));
  } catch { /* fail-safe: empty map ⇒ leg grounds nothing */ }
  return (itemNumber) => map.get(String(itemNumber ?? '')) ?? null;
}

// re-export for the count badge on /care (pending-candidate count)
export type { GenCandidate };
export { EVEN_SOURCE };
