export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/lab/ml-label-trial — ML Phase 1 retrospective validation. DRY-RUN BY DEFAULT.
 *
 *   { }                                    → dry run: set sizes, call plan, cap check, rendered
 *                                            prompt EXAMPLE (contains clinical text — admin eyes)
 *   { action:'chunk', model, experiment,
 *     offset, limit }                      → run BOTH passes over rows [offset, offset+limit),
 *                                            store the chunk artefact in lab_analyses
 *   { action:'summary', experiment }       → merge all stored chunks → the §7 report. The summary
 *                                            block contains NO verbatim clinical text (PHI §6.5).
 *
 * D8 — the trial writes ONLY lab_analyses (kind 'ml_label_trial'), never opd_audit_feedback.
 * Chunked because 1,634 provider calls do not fit one serverless invocation; chunks are
 * deterministic (stable ORDER BY) and idempotent per (experiment, offset, limit) — a re-run
 * overwrites its own chunk artefact and nothing else.
 *
 * ⚠️ INFERRED SQL (no live DB in the build sandbox; opd_audit_feedback is blocked from read-only
 * tooling). Every column here is inferred from lib/opd-feedback-rollup-core.ts, which reads the
 * same table in production. Both queries are listed verbatim in the build report for validation.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { saveLabAnalysis } from '@/lib/lab';
import { fetchOpdNoteByUid } from '@/lib/metabase';
import { rowToOpdCase, opdCaseText } from '@/lib/opd-ingest-core';
import {
  renderLabelPrompt, parseLabelResponse, planTrial, computeTrialReport, dedupStoredRows,
  crossInvocationAgreement, applyCohort, TRIAL_PROMPT_VERSION,
  type TrialFinding, type TrialRow, type StoredTrialRow, type CohortEntry,
} from '@/lib/ml-label-trial/core';
import { trialLabelCall } from '@/lib/ml-label-trial/client';

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const KIND = 'ml_label_trial';

/** The current-state human-labelled set (D4): one row per (audit_id, finding_ref), latest wins —
 *  the same current-state rule the rollup core uses. Deterministic outer order for chunking. */
const TRIAL_SET_SQL = `
  SELECT * FROM (
    SELECT DISTINCT ON (f.audit_id, f.finding_ref)
           f.audit_id, f.finding_ref, f.verdict AS human_verdict,
           f.signal_type AS human_signal_type,
           a.engine_version, a.uid, a.findings
      FROM opd_audit_feedback f
      JOIN opd_note_audits a ON a.id = f.audit_id
     WHERE f.scope = 'finding' AND f.finding_ref IS NOT NULL AND f.app_source = $1
       AND f.study IS NOT DISTINCT FROM $2
     ORDER BY f.audit_id, f.finding_ref, f.created_at DESC, f.id DESC
  ) t ORDER BY audit_id, finding_ref`;

/** D11 — findings with ≥2 distinct non-blank authors across current AND superseded rows. */
const OVERLAP_SQL = `
  SELECT f.audit_id, f.finding_ref, count(DISTINCT btrim(f.author))::int AS n_authors
    FROM opd_audit_feedback f
   WHERE f.scope = 'finding' AND f.finding_ref IS NOT NULL AND f.app_source = $1
     AND f.study IS NOT DISTINCT FROM $2
     AND f.author IS NOT NULL AND btrim(f.author) <> ''
   GROUP BY f.audit_id, f.finding_ref
  HAVING count(DISTINCT btrim(f.author)) >= 2`;

/** Human storage vocabulary → the model's class names. 'true_positive' IS 'tp' under its storage
 *  name — the same class, not an invented mapping. 'contested' is preserved and held out (D5). */
function humanClass(v: unknown): string {
  const s = String(v ?? '');
  return s === 'true_positive' ? 'tp' : s;
}

type SetRow = {
  audit_id: string; finding_ref: string; human_verdict: string; human_signal_type: string | null;
  engine_version: string; uid: string; findings: unknown;
};

function findingFromRow(r: SetRow): TrialFinding | null {
  try {
    const arr = (typeof r.findings === 'string' ? JSON.parse(r.findings) : r.findings) as Record<string, unknown>[];
    const f = Array.isArray(arr) ? arr.find((x) => String(x.finding_ref ?? '') === r.finding_ref) : null;
    if (!f) return null;
    return {
      subject: String(f.subject ?? ''), verdict: String(f.verdict ?? ''), domain: String(f.domain ?? ''),
      signal_type: f.signal_type == null ? null : String(f.signal_type),
      rationale: String(f.rationale ?? ''), confidence: Number(f.confidence) || 0,
    };
  } catch { return null; }
}

async function authed(req: NextRequest): Promise<boolean> {
  const denied = requireAdmin(req);
  return !denied || (await isAdminUnlocked().catch(() => false));
}

export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ ok: false, error: 'admin required' }, { status: 401 });
  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { body = {}; }
  const action = typeof body.action === 'string' ? body.action : 'dry';

  try {
    const set = (await run(TRIAL_SET_SQL, [APP, null])) as SetRow[];
    const contestedN = set.filter((r) => humanClass(r.human_verdict) === 'contested').length;
    const scoredN = set.length - contestedN;
    const plan = planTrial(scoredN, contestedN);

    if (action === 'dry') {
      // The rendered example (D1/D2, §9.2 — checked by eye). Uses the FIRST row; contains
      // clinical text, which is why the DRY response is admin-gated and never a shared doc.
      const first = set[0];
      const finding = first ? findingFromRow(first) : null;
      const note = first ? await fetchOpdNoteByUid(first.uid).catch(() => null) : null;
      const ctx = note ? opdCaseText(rowToOpdCase(note).case) : null;
      return NextResponse.json({
        ok: true, dryRun: true,
        set: { total: set.length, scored: scoredN, contested: contestedN },
        plan,
        overlap: (await run(OVERLAP_SQL, [APP, null])).length,
        promptVersion: TRIAL_PROMPT_VERSION,
        renderedExample: finding ? renderLabelPrompt(finding, ctx) : null,
      });
    }

    if (action === 'chunk') {
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      if (!model) return NextResponse.json({ ok: false, error: 'model is required — it is a runtime parameter with no default (D7)' }, { status: 400 });
      const experiment = String(body.experiment ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 48);
      if (!experiment) return NextResponse.json({ ok: false, error: 'experiment label required' }, { status: 400 });

      // C3 (in-flight correction) — KEYED TOP-UP MODE: an explicit list of finding keys
      // ("<audit_id>:<finding_ref>") instead of offset/limit. A keyed request cannot drift when
      // the underlying set grows mid-run (MEASURED: 817 → 820 while the first run drained), which
      // is what left offset windows non-partitioning. Exempt from the D9 plan refusal — the cap
      // sized the OFFSET run; blocking the top-up would leave the set permanently short. Bounded
      // instead by its own per-invocation limit; the TRUE cumulative call count is reported by
      // the summary.
      const keyList = Array.isArray(body.keys) ? body.keys.map((k) => String(k)).slice(0, 100) : null;
      let slice: SetRow[];
      let chunkRef: string;
      if (keyList && keyList.length) {
        const wanted = new Set(keyList);
        slice = set.filter((r) => wanted.has(`${r.audit_id}:${r.finding_ref}`));
        chunkRef = `keys:${keyList.length}`;
      } else {
        if (!plan.ok) return NextResponse.json({ ok: false, error: plan.reason }, { status: 400 });   // D9 — before the first call
        const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
        const limit = Math.max(1, Math.min(60, Math.floor(Number(body.limit) || 40)));
        slice = set.slice(offset, offset + limit);
        chunkRef = `chunk:${offset}:${limit}`;
      }

      const noteCache = new Map<string, string | null>();
      const results: Record<string, unknown>[] = [];
      let calls = 0;
      for (const r of slice) {
        const finding = findingFromRow(r);
        if (!finding) {
          results.push({ key: `${r.audit_id}:${r.finding_ref}`, status: 'finding_unmatched', human: humanClass(r.human_verdict), engine: r.engine_version });
          continue;
        }
        if (!noteCache.has(r.uid)) {
          const note = await fetchOpdNoteByUid(r.uid).catch(() => null);
          noteCache.set(r.uid, note ? opdCaseText(rowToOpdCase(note).case) : null);
        }
        const ctx = noteCache.get(r.uid) ?? null;
        const { system, user } = renderLabelPrompt(finding, ctx);
        const out: Record<string, unknown> = {
          key: `${r.audit_id}:${r.finding_ref}`, human: humanClass(r.human_verdict),
          engine: r.engine_version, signalType: r.human_signal_type,
          contested: humanClass(r.human_verdict) === 'contested',
          contextIncluded: ctx != null,
        };
        for (const pass of [1, 2] as const) {
          const call = await trialLabelCall(model, system, user);
          calls++;
          const parsed = call.error ? { cls: 'unparseable' as const, rationale: '', raw: `CALL_ERROR: ${call.error}` } : parseLabelResponse(call.raw);
          out[`pass${pass}`] = parsed.cls;
          out[`pass${pass}_rationale`] = parsed.rationale;
          out[`pass${pass}_raw`] = parsed.raw.slice(0, 1200);
          out[`pass${pass}_source`] = call.labelSource;
          out[`pass${pass}_usage`] = call.usage;
        }
        results.push(out);
      }

      const id = await saveLabAnalysis({
        experiment, kind: KIND, engine: TRIAL_PROMPT_VERSION, inputRef: chunkRef,
        inputPreview: `ml-label-trial ${chunkRef}`,
        output: { rows: results, model_requested: model, calls, ref: chunkRef },
        model, latencyMs: null, provider: 'openrouter',
      });
      return NextResponse.json({ ok: true, stored: id, chunk: { ref: chunkRef, rows: results.length, calls }, setTotal: set.length });
    }

    // ═══ COHORT FREEZE (addendum 28 Jul) ═══ Snapshot the CURRENT label key set with the frozen
    // human labels; the frozen list IS the Phase 1 cohort — the top-up targets it, any second
    // model targets it, any re-run targets it. Refuses to overwrite an existing cohort id.
    if (action === 'freeze') {
      const cohortId = String(body.cohortId ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
      if (!cohortId) return NextResponse.json({ ok: false, error: 'cohortId required' }, { status: 400 });
      const experiment = String(body.experiment ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 48) || 'ml_label_trial_p1';
      const exists = await run(`SELECT id FROM lab_analyses WHERE kind = 'ml_label_cohort' AND input_ref = $1 LIMIT 1`, [cohortId]);
      if (exists.length) return NextResponse.json({ ok: false, error: `cohort ${cohortId} is already frozen — a cohort is immutable` }, { status: 409 });
      const entries: CohortEntry[] = set.map((r) => ({
        key: `${r.audit_id}:${r.finding_ref}`, human: String(r.human_verdict),
        signalType: r.human_signal_type == null ? null : String(r.human_signal_type),
        engine: r.engine_version,
      }));
      const id = await saveLabAnalysis({
        experiment, kind: 'ml_label_cohort', engine: TRIAL_PROMPT_VERSION,
        inputRef: cohortId, inputPreview: `frozen Phase-1 cohort · ${entries.length} keys`,
        output: { cohortId, size: entries.length, entries },
        model: null, latencyMs: null, provider: null,
      });
      return NextResponse.json({ ok: true, cohortId, size: entries.length, stored: id });
    }

    if (action === 'summary') {
      const experiment = String(body.experiment ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 48);
      // Direct read: listLabAnalyses omits the output jsonb, which is the artefact itself.
      const stored = await run(
        `SELECT output, input_ref, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS created_at
           FROM lab_analyses WHERE experiment = $1 AND kind = $2 ORDER BY created_at ASC LIMIT 500`,
        [experiment, KIND]);
      const all: StoredTrialRow[] = [];
      const sources = new Set<string>();
      let calls = 0; let cost = 0; let promptTokens = 0; let completionTokens = 0;
      for (const s of stored) {
        const raw = (s as { output?: unknown }).output;
        const o = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { rows?: Record<string, unknown>[]; calls?: number } | null;
        for (const r of o?.rows ?? []) {
          all.push({ key: String(r.key), chunk: String((s as { input_ref?: unknown }).input_ref ?? ''), storedAt: String((s as { created_at?: unknown }).created_at ?? ''), row: r });
          for (const p of ['pass1', 'pass2']) {
            const src = r[`${p}_source`]; if (typeof src === 'string') sources.add(src);
            const u = r[`${p}_usage`] as { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null;
            if (u) { promptTokens += u.prompt_tokens ?? 0; completionTokens += u.completion_tokens ?? 0; cost += u.cost ?? 0; }
          }
        }
        calls += o?.calls ?? 0;   // the TRUE cumulative call count, duplicates and failures included
      }
      // C1 — dedup by key, latest artefact wins (stated tie-break; see dedupStoredRows).
      const { winners, overlap } = dedupStoredRows(all);

      // ═══ COHORT VIEW (addendum) ═══ metrics are computed over the FROZEN cohort when one exists:
      // frozen human labels (a post-freeze revision cannot silently move a reproducible number —
      // it is counted), extra-cohort labelled keys kept and reported separately, missing = the
      // keyed-top-up target, and the post-freeze set named (size only — it accrues as held-out).
      const cohortIdReq = String(body.cohort ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
      const cohortRow = (await run(
        cohortIdReq
          ? `SELECT output FROM lab_analyses WHERE kind = 'ml_label_cohort' AND input_ref = $1 LIMIT 1`
          : `SELECT output FROM lab_analyses WHERE kind = 'ml_label_cohort' AND experiment = $1 ORDER BY created_at DESC LIMIT 1`,
        [cohortIdReq || experiment]))[0];
      const cohortOut = cohortRow
        ? (typeof cohortRow.output === 'string' ? JSON.parse(String(cohortRow.output)) : cohortRow.output) as { cohortId?: string; entries?: CohortEntry[] }
        : null;
      const cohort = Array.isArray(cohortOut?.entries) ? cohortOut!.entries! : null;

      const setKeys = new Set(set.map((r) => `${r.audit_id}:${r.finding_ref}`));
      const unmatched = [...winners.values()].filter((w) => w.row.status === 'finding_unmatched').length;

      let rows: TrialRow[];
      let cohortBlock: Record<string, unknown>;
      let missingKeys: string[];
      if (cohort) {
        const applied = applyCohort(winners, cohort);
        rows = applied.cohortRows;
        missingKeys = applied.missingKeys;
        const postFreeze = [...setKeys].filter((k) => !cohort.some((e) => e.key === k)).length;
        cohortBlock = {
          cohortId: cohortOut?.cohortId ?? 'unknown', cohortSize: cohort.length,
          labelledInCohort: rows.length, missingFromCohort: missingKeys.length,
          extraCohortLabelled: applied.extraKeys.length, extraCohortKeys: applied.extraKeys,
          labelRevisedSinceFreeze: applied.revisedSinceFreeze,
          postFreezeCohortSize: postFreeze,
          postFreezeNote: 'labels arrived after the freeze — a held-out set the labeller has never seen; NAMED, not yet measured',
        };
      } else {
        rows = [...winners.values()].filter((w) => w.row.status !== 'finding_unmatched').map(({ row: r }) => ({
          key: String(r.key), human: String(r.human), engine: String(r.engine),
          signalType: r.signalType == null ? null : String(r.signalType),
          pass1: String(r.pass1 ?? 'missing'), pass2: String(r.pass2 ?? 'missing'),
          contested: r.contested === true,
        }));
        missingKeys = [...setKeys].filter((k) => !winners.has(k)).sort();
        cohortBlock = { cohortId: null, note: 'NO FROZEN COHORT — metrics computed over the live set; freeze before any second-model comparison' };
      }
      const report = computeTrialReport(rows);
      // §4 — cross-invocation agreement, its own figure, never pooled with within-invocation.
      const cross = crossInvocationAgreement(overlap);
      // PHI (§6.5): this summary carries counts, rates, ids and KEYS only — no clinical text.
      return NextResponse.json({
        ok: true, experiment, promptVersion: TRIAL_PROMPT_VERSION,
        cohort: cohortBlock,   // beside EVERY metric — no number reads without its denominator
        labelSources: [...sources],
        trueCallCount: { calls, capForOffsetRun: plan.calls, note: 'duplicates, failed shakedown and keyed top-ups included — the D9 plan sized only one clean offset pass' },
        usage: { promptTokens, completionTokens, cost: Math.round(cost * 1e6) / 1e6 },
        reconciliation: {
          distinctKeysLabelled: winners.size,
          currentInputSet: set.length,
          missing: missingKeys.length,
          missingKeys,
          storedRowsTotal: all.length,
          duplicateRows: all.length - winners.size,
          dedupRule: 'one row per key; LATEST artefact created_at wins (then chunk ref desc) — a re-run of a failed window supersedes its failures',
        },
        crossInvocation: { ...cross, note: 'same model, same finding, separate process invocations — NOT pooled with within-invocation self-agreement' },
        setCoverage: { labelled: winners.size, ofSet: set.length, findingUnmatched: unmatched },
        interHumanOverlap: (await run(OVERLAP_SQL, [APP, null])).length,
        report,
      });
    }

    return NextResponse.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
