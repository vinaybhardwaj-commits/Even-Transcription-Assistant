export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * One-click, idempotent: (re)create the DE-IDENTIFIED summary views the Lab MCP `audit_query`
 * tool reads instead of the PHI-bearing base tables. Admin or ?token=ADMIN_TOKEN.
 *
 * v_trace_summary          — pipeline behaviour WITHOUT the clinical text: feature, status,
 *                            severity, timings, model_summary, error_message. NO input /
 *                            question_preview / final_answer_text / meta / trace_events.payload.
 * v_appropriateness_summary — Right-Care run structure WITHOUT the pasted case: mode, scenario,
 *                            doc_type, source/finding counts, de_identified flag, timestamp.
 *                            NO input / output / summary free-text.
 * v_stage_latency          — PER-LEG wall time by stage, provider and model (Unit D, DEC-B7,
 *                            3 Aug 2026), so a provider budget can be MEASURED instead of derived.
 *                            NO payload.
 *
 * WHY v_stage_latency EXISTS. Every latency figure in this system was a subtraction of two
 * whole-trace percentiles, because per-leg latency was not observable: v_trace_summary carries only
 * `total_ms`, its `model_summary` is null on every row sampled, and trace_events is PHI-blocked by
 * lib/sql-guard-core.ts. That is how "the OPD audit runs p50 267 s" survived unchallenged for a
 * week while the real p50 was 52–93 s, and how a route budget came to be sized against one LLM leg
 * when the audit makes two or three. trace_events already stores what is needed — lib/trace.ts
 * passes `Date.now() - t0` as latency_ms on the llm_response event and `stage` carries the leg
 * label — so this is an exposure, not new instrumentation.
 *
 * ⚠️ `payload` IS EXCLUDED AND MUST STAY EXCLUDED. It is the only PHI-bearing column on the table
 * and it holds BOTH the prompt messages and the model's output text.
 *
 * ⚠️ `call_model` and `call_provider` are REAL COLUMNS, promoted out of the JSONB by
 * migrations/0012_reasoning_fingerprint.sql and stamped by buildEnvelope at the tracedChat choke
 * point. They must be read as columns, never out of payload. Without them the view averages a
 * Gemini leg together with a qwen fallback leg into one number — which is precisely the class of
 * error this whole build exists to correct. A model slug and a provider name carry nothing
 * clinical, and both are already exposed in aggregate on opd_note_audits.model and .provider.
 *
 * ⚠️ `tokens_out` IS THE POINT, not a bonus column (V, 3 Aug 2026, after the build began).
 * CDMSS-DETERMINISM-MECHANISM-EVIDENCE-3-AUG-2026.md — 24 live calls on clinical-infra and
 * OpenRouter — found that output is a DETERMINISTIC FUNCTION OF THINKING-TOKEN SPEND: two runs with
 * the same reasoning tokens returned byte-identical output, two runs with different spend did not,
 * zero exceptions. `tokens_out` here is REASONING-INCLUSIVE (lib/trace.ts records it as
 * total − prompt), so run-to-run variance in it on identical input is the observable that PREDICTS
 * A BAND FLIP. Without it this view measures latency and misses the thing latency is a symptom of.
 * From migrations/0012_reasoning_fingerprint.sql:17, the same migration as call_model/call_provider.
 *
 * ⚠️ THE NAME deliberately contains neither `traces` nor `trace_events` as whole words, so it
 * passes BLOCKED_RELATIONS in lib/sql-guard-core.ts WITHOUT that file changing — that file's own
 * comment says to widen access by adding a view, never by editing the list.
 */
export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }
  try {
    await run(`CREATE OR REPLACE VIEW v_trace_summary AS
      SELECT trace_id, feature, status, severity, started_at, finished_at, total_ms,
             model_summary, error_message, parent_trace_id, app_source
        FROM traces`, []);
    await run(`CREATE OR REPLACE VIEW v_appropriateness_summary AS
      SELECT id, created_at, mode, app_source, doc_type, n_sources, n_findings, de_identified
        FROM appropriateness_runs`, []);
    await run(`CREATE OR REPLACE VIEW v_stage_latency AS
      SELECT e.trace_id, t.feature, e.stage, e.kind, e.ts, e.latency_ms, e.app_source,
             e.call_model, e.call_provider, e.tokens_out
        FROM trace_events e
        JOIN traces t ON t.trace_id = e.trace_id`, []);
    // Unit V-a2 (4 Aug 2026) — the IPD failure ledger. PURELY OBSERVATIONAL: a failed IPD audit
    // writes nothing to ipd_discharge_audits (that is what keeps resumability working — the sweep
    // retries anything unwritten), so failures were invisible. One row per failed attempt.
    // NO PHI: `error` is a provider message, truncated to IPD_FAILURE_ERROR_CAP (2000) at the
    // writer (lib/ipd-audit/store.ts recordIpdAuditFailure) — never clinical text. The table name
    // deliberately contains neither `traces` nor `trace_events` as whole words, so it passes
    // BLOCKED_RELATIONS in lib/sql-guard-core.ts and audit_query can read it WITHOUT that file
    // changing. Additive + idempotent, same discipline as the views above.
    await run(`CREATE TABLE IF NOT EXISTS ipd_audit_failures (
      id            BIGSERIAL PRIMARY KEY,
      document_id   TEXT NOT NULL,
      engine_version TEXT,
      stage         TEXT,
      provider      TEXT,
      error         TEXT,
      trace_id      TEXT,
      failed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )`, []);
    // ── PX Phase 2 (outcome linkage, 4 Aug 2026) — the outcomes table + the calibration view ──
    //
    // The table mirrors migrations/0033_prognosis_outcomes.sql EXACTLY (this route is how V runs
    // numbered migrations from a browser — the ipd_audit_failures precedent above). It must exist
    // BEFORE the view that reads it. Per P-8 it is NOT in BLOCKED_RELATIONS: readable by design,
    // with the P-6 UI warning as the only PHI control — the revisit trigger is recorded in the PRD.
    await run(`CREATE TABLE IF NOT EXISTS prognosis_outcomes (
      id                  BIGSERIAL PRIMARY KEY,
      source_table        TEXT NOT NULL,
      source_id           TEXT NOT NULL,
      source_engine       TEXT,
      app_source          TEXT,
      source              TEXT NOT NULL,
      observed_outcome    TEXT NOT NULL,
      observed_at         DATE,
      horizon_days        INT,
      matched_complication      INT,
      matched_complication_hash TEXT,
      classification      TEXT NOT NULL,
      reviewed_by_name    TEXT,
      notes               TEXT,
      supersedes_id       BIGINT REFERENCES prognosis_outcomes(id),
      superseded          BOOLEAN NOT NULL DEFAULT FALSE,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )`, []);
    await run(`CREATE INDEX IF NOT EXISTS prognosis_outcomes_source_idx
      ON prognosis_outcomes (source_table, source_id) WHERE superseded = FALSE`, []);
    // v_prognosis_calibration (§5.5) — the three headline metrics, per source document, reading
    // ONLY non-superseded rows.
    //
    // THE DENOMINATOR IS THE POINT: `follow_up_bucket` says out loud whether anyone looked.
    // A document with NO current outcome row is `not_followed_up` — its over-warning columns are
    // NULL, never zero, so it sits OUTSIDE the rate instead of silently inflating it (the
    // survivor-counting error that let a 15.5% OPD loss read as healthy on 3 Aug). "Anticipated
    // and never occurred" is counted ONLY where a no_adverse_outcome row exists for the document —
    // an event row proves someone looked at ONE outcome, not that the rest were checked.
    //
    // THE HASH IS RECOMPUTED IN SQL and must match lib/prognosis-outcomes-core.ts exactly:
    // sha256(normalize), hex, first 16. ⚠️ ADDENDUM A §1 (hash parity, MEASURED on live Neon):
    // the normalization is COLLAPSE FIRST, THEN TRIM — `btrim(regexp_replace(...), ' ')`. The
    // first cut trimmed first, and `btrim` with no second argument strips ASCII spaces ONLY, so a
    // leading tab or trailing newline survived, was collapsed into a literal edge space, and
    // hashed differently from Node — the outcome silently fell into `unresolved` and inflated
    // over_warning_rate. Collapsing first turns every \s run (tabs, newlines, NBSP — Postgres \s
    // matches it) into a plain space; trimming ' ' then matches JS .trim() exactly. Ten vectors
    // validated Node-vs-SQL 4 Aug (zero divergent); they are pinned Node-side in
    // lib/__tests__/prognosis-outcomes-core.test.ts and re-validated against live Neon by the
    // orchestrator after any change to either side. `matched_complication` (the integer) is never
    // consulted (P-2); a stored hash matching nothing counts as n_unresolved.
    //
    // One row per document (A-1): the row with the greatest audited_at carrying a NON-EMPTY
    // prognosis.complications array. 60 of 363 prognosis documents have two engine versions, so
    // the choice is live — and `engine_drift` makes the mixture legible: TRUE when any current
    // outcome was linked at a different engine than the canonical row, NULL when the document has
    // no outcome rows (absence of outcomes is not absence of drift — never FALSE by default).
    // No '%-mini' filter (A-3): it matches zero rows in this table — the mini path writes to
    // lab_analyses. An inert guard reads as a rule someone verified.
    //
    // DROP + CREATE rather than CREATE OR REPLACE: idempotent as a pair, and survives column-shape
    // changes on re-run (OR REPLACE cannot drop or retype a column). Also keeps the three lab
    // views above as exactly the set their tests pin.
    await run(`DROP VIEW IF EXISTS v_prognosis_calibration`, []);
    await run(`CREATE VIEW v_prognosis_calibration AS
      WITH blocks AS (
        SELECT DISTINCT ON (document_id)
               document_id, engine_version, audited_at,
               report->'prognosis'->'complications' AS complications
          FROM ipd_discharge_audits
         WHERE report->'prognosis' IS NOT NULL
           AND jsonb_typeof(report->'prognosis'->'complications') = 'array'
           AND jsonb_array_length(report->'prognosis'->'complications') > 0
         ORDER BY document_id, audited_at DESC
      ),
      comp_hashes AS (
        SELECT b.document_id,
               substr(encode(sha256(convert_to(
                 btrim(regexp_replace(lower(c.value->>'complication'), '\\s+', ' ', 'g'), ' '),
               'UTF8')), 'hex'), 1, 16) AS comp_hash
          FROM blocks b
          CROSS JOIN LATERAL jsonb_array_elements(b.complications) AS c(value)
         WHERE c.value->>'complication' IS NOT NULL
      ),
      anticipated AS (
        SELECT document_id, count(*)::int AS n_anticipated FROM comp_hashes GROUP BY document_id
      ),
      o AS (
        SELECT source_id AS document_id,
               count(*)::int AS n_outcome_rows,
               (count(*) FILTER (WHERE classification = 'unpredicted_occurred'))::int AS n_unpredicted_occurred,
               (count(*) FILTER (WHERE classification = 'benefit_failure'))::int AS n_benefit_failure,
               (count(*) FILTER (WHERE classification = 'no_adverse_outcome'))::int AS n_no_adverse_outcome
          FROM prognosis_outcomes
         WHERE source_table = 'ipd_discharge_audits' AND superseded = FALSE
         GROUP BY source_id
      ),
      matched AS (
        SELECT po.source_id AS document_id,
               count(*)::int AS n_predicted_occurred,
               count(DISTINCT po.matched_complication_hash)::int AS n_complications_confirmed
          FROM prognosis_outcomes po
          JOIN comp_hashes ch
            ON ch.document_id = po.source_id AND ch.comp_hash = po.matched_complication_hash
         WHERE po.source_table = 'ipd_discharge_audits' AND po.superseded = FALSE
           AND po.classification = 'predicted_occurred'
         GROUP BY po.source_id
      ),
      unresolved AS (
        SELECT po.source_id AS document_id, count(*)::int AS n_unresolved
          FROM prognosis_outcomes po
         WHERE po.source_table = 'ipd_discharge_audits' AND po.superseded = FALSE
           AND po.matched_complication_hash IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM comp_hashes ch
              WHERE ch.document_id = po.source_id AND ch.comp_hash = po.matched_complication_hash)
         GROUP BY po.source_id
      )
      SELECT b.document_id,
             b.engine_version,
             COALESCE(a.n_anticipated, 0) AS n_anticipated,
             COALESCE(o.n_outcome_rows, 0) AS n_outcome_rows,
             COALESCE(m.n_predicted_occurred, 0) AS n_predicted_occurred,
             COALESCE(o.n_unpredicted_occurred, 0) AS n_unpredicted_occurred,
             COALESCE(o.n_benefit_failure, 0) AS n_benefit_failure,
             COALESCE(o.n_no_adverse_outcome, 0) AS n_no_adverse_outcome,
             COALESCE(u.n_unresolved, 0) AS n_unresolved,
             CASE WHEN COALESCE(o.n_outcome_rows, 0) > 0 THEN 'followed_up' ELSE 'not_followed_up' END AS follow_up_bucket,
             CASE WHEN COALESCE(o.n_no_adverse_outcome, 0) > 0
                  THEN GREATEST(COALESCE(a.n_anticipated, 0) - COALESCE(m.n_complications_confirmed, 0), 0)
                  ELSE NULL END AS n_anticipated_never_occurred,
             CASE WHEN COALESCE(o.n_no_adverse_outcome, 0) > 0 AND COALESCE(a.n_anticipated, 0) > 0
                  THEN round((COALESCE(a.n_anticipated, 0) - COALESCE(m.n_complications_confirmed, 0))::numeric / a.n_anticipated, 3)
                  ELSE NULL END AS over_warning_rate,
             CASE WHEN COALESCE(m.n_predicted_occurred, 0) + COALESCE(o.n_unpredicted_occurred, 0) > 0
                  THEN round(COALESCE(m.n_predicted_occurred, 0)::numeric
                             / (COALESCE(m.n_predicted_occurred, 0) + COALESCE(o.n_unpredicted_occurred, 0)), 3)
                  ELSE NULL END AS recall_of_foreseeable,
             CASE WHEN COALESCE(o.n_outcome_rows, 0) > 0
                  THEN EXISTS (
                    SELECT 1 FROM prognosis_outcomes po
                     WHERE po.source_table = 'ipd_discharge_audits' AND po.source_id = b.document_id
                       AND po.superseded = FALSE
                       AND po.source_engine IS DISTINCT FROM b.engine_version)
                  ELSE NULL END AS engine_drift
        FROM blocks b
        LEFT JOIN anticipated a ON a.document_id = b.document_id
        LEFT JOIN o ON o.document_id = b.document_id
        LEFT JOIN matched m ON m.document_id = b.document_id
        LEFT JOIN unresolved u ON u.document_id = b.document_id`, []);
    return NextResponse.json({ ok: true, migrated: ['v_trace_summary', 'v_appropriateness_summary', 'v_stage_latency'], tables: ['ipd_audit_failures'], calibration: ['prognosis_outcomes', 'prognosis_outcomes_source_idx', 'v_prognosis_calibration'] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
