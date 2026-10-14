/**
 * lib/opd-audit-store.ts — persist + read OPD note-quality audits (Neon `opd_note_audits`).
 *
 * Maps the in-memory OpdNoteAudit → one de-identified, uid-keyed row. Idempotent insert
 * (ON CONFLICT (uid, engine_version) DO NOTHING), so the worker re-runs safely — the audit
 * table itself is the worker's watermark. A manual force mode (saveOpdAudit opts.force)
 * upgrades the conflict to DO UPDATE for admin backfill overwrites.
 */

import { sql } from './db';
import type { OpdNoteAudit } from './opd-note-audit';
import { HYSTERESIS_G, type OpdDomain } from './opd-note-score-core';
import { OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT } from './opd-note-audit-core';
import { logEvent } from './trace';
import { auditShadowReport } from './clinical-state/audit-shadow-core';
import { runLongitudinalPass } from './opd-longitudinal';   // Stage 3 — dark unless OPD_LONGITUDINAL_ENABLED=1
import { canonicalByUid } from './audit-canonical';

function domainScore(audit: OpdNoteAudit, key: OpdDomain): number | null {
  const d = audit.scorecard.domains.find((x) => x.domain === key);
  return d ? Math.round(d.score) : null;
}

export interface SaveOpdAuditMeta {
  model?: string | null;
  /** Unit B — the PROVIDER that served the call ('vertex' | 'openrouter' | 'ollama' | 'bedrock').
   *  Must come from what actually answered, never a constant. Absent/null = not attributed. */
  provider?: string | null;
  latencyMs?: number | null;
}

/** Force-overwrite mode for saveOpdAudit (obstetric re-score backfill): when a row already exists
 *  at (uid, engine_version), DO UPDATE the scored columns instead of DO NOTHING. Off by default —
 *  the idempotent daily worker path is unchanged (byte-identical SQL). */
export interface SaveOpdAuditOptions {
  force?: boolean;
  /**
   * Fires when — and only when — a row actually landed, with the id it landed on (D12, §4.5 step 4).
   *
   * ⚠️ THIS FUNCTION NEVER RECEIVES THE HANDLE, DELIBERATELY. The closure holds it. `saveOpdAudit`
   * is a clinical write and must not acquire a telemetry parameter, a telemetry import or a reason
   * to care whether telemetry exists; what it owes the caller is the one fact only it knows, which
   * is the audit id.
   *
   * ⚠️ A CALLBACK EXCEPTION IS SWALLOWED AND THE SAVE RESULT PRESERVED. Constraint 1: an audit is
   * never failed because its telemetry could not be recorded.
   */
  onPersisted?: (result: { status: 'inserted' | 'updated'; auditId: string }) => Promise<void>;
}

/**
 * ClinicalState shadow (Platform B1) — DORMANT by default. Flag-gated, read-only w.r.t. the
 * audit, fail-open. When CLINICAL_STATE_AUDIT_SHADOW=1, round-trips the persisted findings
 * through the canonical model and traces the fidelity; when off (default) it is zero work and
 * the persisted audit output is byte-identical. Modelled on the DDx 1a in-pipeline pattern.
 * auditShadowReport never mutates `findings` (works on a JSON clone), so this can never affect
 * what was written above. Called AFTER the INSERT so it is provably out of the persist path.
 */
async function runAuditShadow(audit: OpdNoteAudit, findings: OpdNoteAudit['findings']): Promise<void> {
  if (process.env.CLINICAL_STATE_AUDIT_SHADOW !== '1' || !audit.traceId) return;
  try {
    await logEvent(audit.traceId, 'clinical_state_audit_shadow', 'expanding', auditShadowReport(findings ?? []));
  } catch (e) {
    try { await logEvent(audit.traceId, 'clinical_state_audit_shadow', 'expanding', { ok: false, error: String((e as Error)?.message ?? e) }); } catch { /* fail-open */ }
  }
}

// Quieting choreography tolerance: the code deploys BEFORE the migration adds
// opd_note_audits.quieting_gen, so the writers probe for the column (cached) and only include it
// once it exists. Fail-safe: probe error ⇒ treat as absent (the stamp is dropped, never the audit).
// GENERALISED (A.1): the same deploy-before-migrate tolerance now guards two columns —
// `quieting_gen` and `completeness_items` (0027). Semantics are UNCHANGED from the single-column
// version: cache a present result for 300s, re-probe an absent one after 60s so the first render
// after the migration picks it up, and treat a probe error as absent (drop the extra column, never
// the audit). The cache is keyed per column, so the two never interfere.
const _colProbe = new Map<string, { at: number; present: boolean }>();
async function opdColumnExists(column: string): Promise<boolean> {
  const now = Date.now();
  const hit = _colProbe.get(column);
  if (hit && now - hit.at < 300_000 && hit.present) return true;
  if (hit && now - hit.at < 60_000) return hit.present;   // re-probe absent faster post-migration
  try {
    const rows = (await sql(
      `SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'opd_note_audits' AND column_name = $1`,
      [column],
    )) as Array<{ ok: number }>;
    _colProbe.set(column, { at: now, present: rows.length > 0 });
  } catch { _colProbe.set(column, { at: now, present: false }); }
  return _colProbe.get(column)!.present;
}
async function quietingGenColumnExists(): Promise<boolean> { return opdColumnExists('quieting_gen'); }
/** 0027 — the per-field completeness array (item D-1). Absent until the migration runs. */
async function completenessItemsColumnExists(): Promise<boolean> { return opdColumnExists('completeness_items'); }
/** 0029 — the S1 hysteresis anchor. Absent until V runs the migration by hand (§8.1).
 *  EXPORTED because the DISPLAY READERS need the same deploy-before-migrate tolerance as the
 *  writers: a SELECT naming a missing column fails whole (rowsOf catches to []), which would blank
 *  the OPD list / doctor pages / PDF export for the entire deploy-to-migration window. Readers
 *  include the column only once it exists; until then they render the raw band, exactly as today. */
export async function displayedBandColumnExists(): Promise<boolean> { return opdColumnExists('displayed_band'); }
/**
 * PROVIDER-SWITCH Unit B (§5, 2 Aug 2026) — WHICH PROVIDER SERVED THE GRADING CALL.
 *
 * `model` alone cannot answer "who graded this": the SAME model id arrives by more than one route.
 * `google/gemini-2.5-pro` is Gemini via the OpenRouter bridge; `gemini-2.5-pro` is Gemini via
 * Vertex. When Vertex was disabled on 26 July, and again when the bridge's 110 s ceiling silently
 * degraded every median-or-slower audit to the local model from 30 July, the stored rows could not
 * say which path had been taken — the column that should have shouted "served somewhere else" was
 * carrying a model name that looked perfectly normal. THAT AMBIGUITY IS A LARGE PART OF WHY A
 * THREE-DAY OUTAGE WENT UNNOTICED.
 *
 * Probed, like quieting_gen / completeness_items / displayed_band, so the deploy is safe BEFORE
 * migration 0032 runs: absent ⇒ the column is omitted from the INSERT and nothing fails.
 */
async function providerColumnExists(): Promise<boolean> { return opdColumnExists('provider'); }

/**
 * S1 — the hysteresis conditional AS SQL, built from the same HYSTERESIS_G the pure function uses
 * so the two can never disagree on g. `ON CONFLICT DO UPDATE` (and plain UPDATE) can read the
 * existing row, so the anchor logic needs no read-modify-write in application code:
 *   prior NULL (first score at this version)  ⇒ take the fresh raw band (sets the anchor);
 *   decisive crossing (index leaves the held band's range by ≥ g) ⇒ take the fresh raw band —
 *     the band the raw index implies, NOT one step;
 *   otherwise ⇒ HOLD the prior displayed band.
 * `priorCol` names the existing row's column (qualified on the conflict path), `newBand`/`newIndex`
 * name the incoming values (EXCLUDED.* on conflict; $-params in updateOpdAudit).
 */
function hysteresisCaseSql(priorCol: string, newBand: string, newIndex: string): string {
  const g = HYSTERESIS_G;
  return `CASE
           WHEN ${priorCol} IS NULL THEN ${newBand}
           WHEN (${priorCol} = 'A' AND ${newIndex} < ${85 - g})
             OR (${priorCol} = 'B' AND (${newIndex} >= ${85 + g} OR ${newIndex} < ${70 - g}))
             OR (${priorCol} = 'C' AND (${newIndex} >= ${70 + g} OR ${newIndex} < ${55 - g}))
             OR (${priorCol} = 'D' AND (${newIndex} >= ${55 + g} OR ${newIndex} < ${40 - g}))
             OR (${priorCol} = 'E' AND ${newIndex} >= ${40 + g})
           THEN ${newBand}
           ELSE ${priorCol}
         END`;
}

/**
 * The array to persist, or null. Returns null rather than `[]` when the engine produced nothing:
 * NULL means "no per-field detail was recorded", and the read path treats that as "fall back to the
 * stored flat completeness_pct". An empty array would mean "we looked and there were no fields",
 * which weighted completeness scores as 100. The two must never be conflated.
 */
function completenessItemsJson(audit: OpdNoteAudit): string | null {
  const items = audit.completeness?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  try { return JSON.stringify(items); } catch { return null; }
}

/** Insert one audit. Returns 'inserted' | 'exists' (a SUCCESSFUL row already holds this
 *  (uid, engine_version)) | 'updated' (the slot held a 'llm_leg_failed' row and the retry landed
 *  in place — addendum F v2 task 2) | 'skipped' (no uid).
 *  With opts.force, ANY existing (uid, engine_version) row is overwritten (scored columns +
 *  model/trace/latency/sources, audited_at = now()) and 'updated' is returned. */
/**
 * PHASE 1 (NQI coverage) — serialise the scorecard AS COMPUTED, unmodified: headline, band,
 * domains[] (domain/label/score/weight/n/basis), pdqi9[], confidence, flags[], caveat. Nothing is
 * pruned, reshaped or renamed; jsonb exists precisely so a question nobody has asked yet is still
 * answerable. The load-bearing field is domains[].weight — a note_quality entry with weight 0 and
 * basis "PDQI-9 not assessed" is what can finally contradict a high note_quality_index.
 *
 * FAIL-SAFE (PRD §5): returns null if serialisation throws for ANY reason, so the audit row is still
 * written exactly as it is today with scorecard NULL. A scorecard-persistence fault must never cost
 * an audit — the audit is the product, this column is instrumentation.
 */
function scorecardJson(sc: unknown): string | null {
  try {
    if (sc == null) return null;
    return JSON.stringify(sc);
  } catch { return null; }
}

export async function saveOpdAudit(
  audit: OpdNoteAudit,
  meta: SaveOpdAuditMeta = {},
  opts: SaveOpdAuditOptions = {},
): Promise<'inserted' | 'exists' | 'skipped' | 'updated'> {
  const k = audit.keys;
  if (!k.uid) return 'skipped';
  const force = opts.force === true;
  const sc = audit.scorecard;
  const findings = audit.findings || [];
  const nLow = findings.filter((f) => f.verdict === 'low-value').length;
  const nCtx = findings.filter((f) => f.verdict === 'context-dependent').length;
  const nInteraction = findings.filter((f) => /interaction|contraindicat|\bddi\b/i.test(`${f.subject} ${f.rationale}`)).length;
  const missing = audit.completeness?.missing ?? [];
  const withGen = await quietingGenColumnExists();
  // 0027 — persist the per-field array the core already emits. Appended AFTER quieting_gen so every
  // existing placeholder index is untouched.
  const withItems = await completenessItemsColumnExists();
  const itemsJson = completenessItemsJson(audit);
  // 0029 (S1) — the hysteresis anchor, tolerated pre-migration like the two columns above.
  const withBand = await displayedBandColumnExists();
  const withProvider = await providerColumnExists();
  // ═══ S0 invalid-marking (PRD 28 Jul, D3/D4) ═══
  // Model-agnostic: the signal comes from auditOpdNote (the LLM leg failed after its one retry),
  // and the belt-and-braces pdqi9 check keeps the mark honest — a row is marked only when the
  // STORED pdqi9 will actually be empty. `sc.pdqi9` is the scorecard's provided-attributes array,
  // exactly what is serialised below as `$15::jsonb`.
  const scPdqi9 = (sc as { pdqi9?: unknown }).pdqi9;
  const emptyPdqi9 = scPdqi9 == null || (Array.isArray(scPdqi9) && scPdqi9.length === 0);
  const excludedReason = audit.llmLegFailed === true && emptyPdqi9 ? 'llm_leg_failed' : null;

  // The overwrite SET list, shared by force mode and the failed-row retry below (addendum F v2
  // task 2 — the retry clause is force's clause NARROWED by a WHERE, not a second copy). It
  // rewrites the scored columns from the fresh audit (EXCLUDED.*) and re-stamps audited_at;
  // complexity_band/complexity_inputs are left as-is (same as updateOpdAudit). displayed_band is
  // the one per-mode difference, so it is the parameter.
  const overwriteSet = (displayedBandSql: string) => `
         note_quality_index = EXCLUDED.note_quality_index, band = EXCLUDED.band,
         score_documentation = EXCLUDED.score_documentation, score_note_quality = EXCLUDED.score_note_quality,
         score_appropriateness = EXCLUDED.score_appropriateness, score_prescribing_safety = EXCLUDED.score_prescribing_safety,
         score_patient_centred = EXCLUDED.score_patient_centred,
         pdqi9 = EXCLUDED.pdqi9, completeness_pct = EXCLUDED.completeness_pct, n_missing_mandatory = EXCLUDED.n_missing_mandatory,
         n_findings = EXCLUDED.n_findings, n_low_value = EXCLUDED.n_low_value, n_context_dependent = EXCLUDED.n_context_dependent,
         n_interaction_alerts = EXCLUDED.n_interaction_alerts,
         findings = EXCLUDED.findings, suggestions = EXCLUDED.suggestions, missing_fields = EXCLUDED.missing_fields,
         model = EXCLUDED.model, trace_id = EXCLUDED.trace_id, latency_ms = EXCLUDED.latency_ms, sources = EXCLUDED.sources,
         scorecard = EXCLUDED.scorecard,
         excluded_reason = COALESCE(EXCLUDED.excluded_reason,
           CASE WHEN opd_note_audits.excluded_reason = 'llm_leg_failed' THEN NULL ELSE opd_note_audits.excluded_reason END),
         ${withProvider ? 'provider = EXCLUDED.provider, ' : ''}${withBand ? `displayed_band = ${displayedBandSql}, ` : ''}${withItems ? 'completeness_items = EXCLUDED.completeness_items, ' : ''}${withGen ? 'quieting_gen = EXCLUDED.quieting_gen, ' : ''}audited_at = now()`;
  // ═══ Addendum F v2 task 2 — a FAILED row no longer consumes its (uid, engine_version) slot ═══
  // The default clause was DO NOTHING, so a row marked 'llm_leg_failed' blocked every retry at the
  // same version forever — each retry round needed a freshly minted carrier version (why 0.81.18
  // exists). The default is now force's DO UPDATE narrowed by a WHERE that admits ONLY failed rows:
  //   · a SUCCESSFUL row is never overwritten — the WHERE excludes it (the save returns 'exists',
  //     exactly as under DO NOTHING);
  //   · the experiment cohort cannot be touched — its filter admits only excluded_reason IS NULL
  //     or 'vertex_outage_mislabel_2026_07', so no 'llm_leg_failed' row is ever in it;
  //   · audited_at moves only on rows that were failures, which no read surface counts.
  // displayed_band per mode: FORCE keeps the S1 hysteresis (EXCLUDED.displayed_band is the fresh
  // RAW band, taken only on NULL prior or a decisive crossing; otherwise the anchor HOLDS). The
  // RETRY path instead takes the fresh band UNCONDITIONALLY: the prior row was a failed,
  // det-only-scored row (typically ~95/A — "failure scored as excellence") that no surface ever
  // displayed, so holding its band would anchor the first REAL audit to an artifact.
  const conflictClause = force
    ? `DO UPDATE SET ${overwriteSet(hysteresisCaseSql('opd_note_audits.displayed_band', 'EXCLUDED.displayed_band', 'EXCLUDED.note_quality_index'))}`
    : `DO UPDATE SET ${overwriteSet('EXCLUDED.displayed_band')}
       WHERE opd_note_audits.excluded_reason = 'llm_leg_failed'`;
  // ^ S0 excluded_reason semantics on a re-audit (both modes): a fresh failure re-marks; a
  //   SUCCESSFUL re-audit clears a stale 'llm_leg_failed'; any OTHER mark — house_account,
  //   vertex_outage_mislabel_2026_07 — is preserved verbatim (and on the default path the WHERE
  //   never even reaches such a row). Never clobber a human's exclusion.

  const rows = (await sql(
    `INSERT INTO opd_note_audits
      (uid, consult_uid, doctor_uid, kx_encounter_id, note_date, prescription_type, consult_type,
       note_quality_index, band,
       score_documentation, score_note_quality, score_appropriateness, score_prescribing_safety, score_patient_centred,
       pdqi9, completeness_pct, n_missing_mandatory,
       n_findings, n_low_value, n_context_dependent, n_interaction_alerts,
       findings, suggestions, engine_version, model, trace_id, latency_ms, missing_fields, sources,
       complexity_band, complexity_inputs, scorecard, excluded_reason${withGen ? ', quieting_gen' : ''}${withItems ? ', completeness_items' : ''}${withBand ? ', displayed_band' : ''}${withProvider ? ', provider' : ''})
     VALUES ($1,$2,$3,$4,$5,$6,$7, $8,$9, $10,$11,$12,$13,$14,
       $15::jsonb,$16,$17, $18,$19,$20,$21, $22::jsonb,$23::jsonb,$24,$25,$26,$27, $28::jsonb, $29::jsonb,
       $30, $31::jsonb, $32::jsonb, $33${withGen ? ', $34' : ''}${withItems ? `, $${withGen ? 35 : 34}::jsonb` : ''}${withBand ? `, $${34 + (withGen ? 1 : 0) + (withItems ? 1 : 0)}` : ''}${withProvider ? `, $${34 + (withGen ? 1 : 0) + (withItems ? 1 : 0) + (withBand ? 1 : 0)}` : ''})
     ON CONFLICT (uid, engine_version) ${conflictClause}
     RETURNING id, (xmax = 0) AS inserted`,
    [
      k.uid, k.consultUid, k.doctorUid, k.kxEncounterId, k.noteDate, k.prescriptionType, k.consultType,
      sc.headline, sc.band,
      domainScore(audit, 'documentation'), domainScore(audit, 'note_quality'), domainScore(audit, 'appropriateness'),
      domainScore(audit, 'prescribing_safety'), domainScore(audit, 'patient_centred'),
      JSON.stringify(sc.pdqi9 ?? []), Math.round((audit.completeness?.coverage ?? 0) * 100), missing.length,
      findings.length, nLow, nCtx, nInteraction,
      JSON.stringify(findings), JSON.stringify(audit.suggestions ?? []),
      audit.engineVersion, meta.model ?? null, audit.traceId ?? null, meta.latencyMs ?? null,
      JSON.stringify(missing), JSON.stringify(audit.sources ?? []),
      audit.complexity?.band ?? null, audit.complexity?.inputs ? JSON.stringify(audit.complexity.inputs) : null,
      scorecardJson(sc),
      excludedReason,
      ...(withGen ? [audit.quietingGen ?? 0] : []),
      ...(withItems ? [itemsJson] : []),
      // S1 — the fresh RAW band. On a first insert it IS the anchor (first score at this version
      // bands normally); on conflict it is EXCLUDED.displayed_band, taken only per the CASE above.
      ...(withBand ? [sc.band] : []),
      // Unit B — the SERVED provider, beside the served model. Never a constant: that is the D-D
      // defect and it has now bitten twice (the OPD run route, and lib/ipd-audit/run.ts:99).
      // Null is a legitimate stored value meaning "not attributed", NOT the string 'null'.
      ...(withProvider ? [meta.provider ?? null] : []),
    ],
  )) as Array<{ id: string; inserted?: boolean }>;
  // DO UPDATE returns the row it landed on; (xmax = 0) distinguishes fresh insert from overwrite.
  // Zero rows now means the conflict target was a SUCCESSFUL row the default WHERE refused to
  // touch — 'exists', exactly the DO NOTHING outcome. A retry that landed on a failed row is
  // 'updated'.
  const freshInsert = rows.length > 0 && rows[0].inserted === true;
  await runAuditShadow(audit, findings); // B1 shadow — dormant unless CLINICAL_STATE_AUDIT_SHADOW=1; read-only, fail-open
  // Stage 3 longitudinal pass (opd-longitudinal/0.1) — AFTER the INSERT, flag-gated + fail-open, so it can
  // never affect the base row. Only for a fresh insert (idempotent worker re-runs never re-charge it; the
  // replay endpoint recomputes on demand — and a force overwrite never re-charges it either). Dark unless
  // OPD_LONGITUDINAL_ENABLED=1.
  if (freshInsert) await runLongitudinalPass(audit).catch(() => { /* fail-open — base audit already persisted */ });
  if (!rows.length) return 'exists';
  const landed = freshInsert ? 'inserted' as const : 'updated' as const;
  // §4.5 step 4: the link happens only AFTER the persistence result is known, and only on the two
  // results that produced a row. `exists` and `skipped` never reach here, and their owners settle
  // them by their own outcome — a losing race is not a link.
  if (opts.onPersisted && rows[0].id) {
    await opts.onPersisted({ status: landed, auditId: String(rows[0].id) })
      .catch((e) => console.warn('[opd-audit] onPersisted threw; the save stands', (e as Error).message));
  }
  return landed;
}

/** UPDATE an existing audit row in place (deterministic backfill — same engine version). Rewrites
 *  the completeness/findings/score columns from a recomputed audit; leaves model/trace/sources as-is. */
export async function updateOpdAudit(audit: OpdNoteAudit): Promise<'updated' | 'skipped'> {
  const k = audit.keys;
  if (!k.uid) return 'skipped';
  const sc = audit.scorecard;
  const findings = audit.findings || [];
  const nLow = findings.filter((f) => f.verdict === 'low-value').length;
  const nCtx = findings.filter((f) => f.verdict === 'context-dependent').length;
  const nInteraction = findings.filter((f) => /interaction|contraindicat|\bddi\b/i.test(`${f.subject} ${f.rationale}`)).length;
  const missing = audit.completeness?.missing ?? [];
  const withGen = await quietingGenColumnExists();
  const withItems = await completenessItemsColumnExists();
  const itemsJson = completenessItemsJson(audit);
  // 0029 (S1) — same pre-migration tolerance as saveOpdAudit. In the statement below $2 appears
  // both as the note_quality_index SET value (deduces integer) and inside the hysteresis CASE's
  // comparisons — the CASE site must cast ($2::int, A-3): one deduced type per parameter per
  // statement, or Postgres rejects the whole UPDATE with "inconsistent types deduced for $2".
  // saveOpdAudit is unaffected — its CASE reads EXCLUDED.note_quality_index, a column reference.
  const withBand = await displayedBandColumnExists();
  // S0 invalid-marking — same predicate as saveOpdAudit.
  const updScPdqi9 = (sc as { pdqi9?: unknown }).pdqi9;
  const updEmptyPdqi9 = updScPdqi9 == null || (Array.isArray(updScPdqi9) && updScPdqi9.length === 0);
  const updExcludedReason = audit.llmLegFailed === true && updEmptyPdqi9 ? 'llm_leg_failed' : null;

  const rows = (await sql(
    `UPDATE opd_note_audits SET
       note_quality_index = $2, band = $3,
       score_documentation = $4, score_note_quality = $5, score_appropriateness = $6,
       score_prescribing_safety = $7, score_patient_centred = $8,
       pdqi9 = $9::jsonb, completeness_pct = $10, n_missing_mandatory = $11,
       n_findings = $12, n_low_value = $13, n_context_dependent = $14, n_interaction_alerts = $15,
       findings = $16::jsonb, suggestions = $17::jsonb, missing_fields = $18::jsonb,
       scorecard = $20::jsonb,
       excluded_reason = COALESCE($21,
         CASE WHEN excluded_reason = 'llm_leg_failed' THEN NULL ELSE excluded_reason END)${withBand ? `,
       displayed_band = ${hysteresisCaseSql('displayed_band', '$3', '$2::int')}` : ''}${withGen ? ', quieting_gen = $22' : ''}${withItems ? `, completeness_items = $${withGen ? 23 : 22}::jsonb` : ''}
     WHERE uid = $1 AND engine_version = $19
     RETURNING id`,
    [
      k.uid, sc.headline, sc.band,
      domainScore(audit, 'documentation'), domainScore(audit, 'note_quality'), domainScore(audit, 'appropriateness'),
      domainScore(audit, 'prescribing_safety'), domainScore(audit, 'patient_centred'),
      JSON.stringify(sc.pdqi9 ?? []), Math.round((audit.completeness?.coverage ?? 0) * 100), missing.length,
      findings.length, nLow, nCtx, nInteraction,
      JSON.stringify(findings), JSON.stringify(audit.suggestions ?? []), JSON.stringify(missing),
      audit.engineVersion,
      scorecardJson(sc),
      // S0 — same semantics as saveOpdAudit's conflict clause: mark on failure, clear a stale
      // 'llm_leg_failed' on a successful re-audit, preserve any other mark (house_account) verbatim.
      updExcludedReason,
      ...(withGen ? [audit.quietingGen ?? 0] : []),
      ...(withItems ? [itemsJson] : []),
    ],
  )) as Array<{ id: string }>;
  return rows.length ? 'updated' : 'skipped';
}

/** uids already audited (at this engine version) for an IST calendar day — the worker's exclude set. */
export async function auditedUidsForDay(day: string, engineVersion: string): Promise<string[]> {
  const rows = (await sql(
    `SELECT uid FROM opd_note_audits
     WHERE engine_version = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
    [engineVersion, day],
  )) as Array<{ uid: string }>;
  return rows.map((r) => r.uid).filter(Boolean);
}

/**
 * The engine LINE of a stored version string: the version with any RUN TAG removed.
 *
 * Strips everything from the first hyphen that FOLLOWS the version number, so
 * `opd-note-audit/0.81.20-mini` and `opd-note-audit/0.81.20-verify` both reduce to
 * `opd-note-audit/0.81.20`. An untagged string is returned unchanged.
 *
 * ⚠️ The engine NAME contains hyphens too (`opd-note-audit`), so a split on '-' is wrong. The
 * pattern anchors on the slash-then-version-number, which is the only place a tag can follow.
 * Pure and total — never throws, and a string that matches nothing comes back as it went in.
 */
export function engineLineOf(engineVersion: unknown): string {
  return String(engineVersion ?? '').replace(/^(.*\/\d+(?:\.\d+)*)-.*$/, '$1');
}

/** Is this stored version part of the CURRENT engine line (tag ignored)? */
export function isInCurrentEngineLine(engineVersion: unknown): boolean {
  return (OPD_ENGINE_VERSIONS_CURRENT as readonly string[]).includes(engineLineOf(engineVersion));
}

/**
 * uids on an IST calendar day already audited ANYWHERE IN THE CURRENT ENGINE LINE — the mini
 * backfill's skip set (BACKFILL-SKIP-RULE PRD, V ruled DEC-1/DEC-2, 2 Aug 2026).
 *
 * WHY THIS EXISTS. The mini backfill skipped a note only if it held a row at the EXACT engine
 * version string running at that moment, so every change to that string made a whole day look
 * untouched and the worker started the day over. Three strings changed across 1–2 August
 * (0.81.19 → 0.81.20 → 0.81.20-mini, the last of them a side effect of deleting prod mode in
 * 4f055c3). MEASURED on 1 August's 412 notes: 13 notes were audited FOUR times while 306 were
 * never audited at all. Under this rule the same day skips 106 and works 306, every one ungraded.
 *
 * WHY THE TAG IS STRIPPED. The tag says which PIPELINE ran; the version says which ENGINE ran.
 * The skip rule is about the engine, so the tag is not part of the test. Any tag is stripped, not
 * just `-mini` — opdMiniEngine() accepts an arbitrary 24-char tag (DEC-4). Consequence, stated
 * plainly: a note audited only under the `verify` tag now counts as done. Two rows table-wide.
 *
 * ⚠️ STANDING CONSEQUENCE — EVERY FUTURE ENGINE BUMP MUST ADD ITS VERSION STRING TO
 * OPD_ENGINE_VERSIONS_CURRENT. If a bump ships without that edit, the new version is outside the
 * line, every day looks untouched again, and the 2 August reset repeats. That list is now
 * load-bearing for COVERAGE, not only for reads. It belongs on the engine-bump checklist.
 *
 * ⚠️ The warning at `AUDITED_HAVING` below argues AGAINST the family form and FOR the single
 * write-target version. It governs the re-audit SPEND GUARD, not this function, and the goals are
 * opposite: there the aim is to FREE stranded notes (where the family form frees zero and no-ops),
 * here the aim is to STOP re-auditing (where the family form is exactly right). Measured both ways.
 *
 * NOT filtered on `excluded_reason`, deliberately — this is a generalisation of the version
 * predicate in `auditedUidsForDay` and nothing else. Adding an exclusion clause would be a new
 * decision, not this one.
 *
 * FAIL-CLOSED BY PROPAGATION: this does NOT catch. An empty skip list would mean "re-audit the
 * whole day", which is the very defect this replaces, so a query failure must abort the batch.
 * All four call sites already sit inside a try/catch that returns an error and runs no audits.
 */
export async function auditedUidsForDayInLine(day: string): Promise<string[]> {
  const rows = (await sql(
    `SELECT uid, engine_version FROM opd_note_audits
     WHERE (note_date AT TIME ZONE 'Asia/Kolkata')::date = $1::date`,
    [day],
  )) as Array<{ uid: string; engine_version: string }>;
  return [...new Set(
    rows.filter((r) => r.uid && isInCurrentEngineLine(r.engine_version)).map((r) => r.uid),
  )];
}

/**
 * D4 (GRADER-PROVENANCE PRD, 2 Aug 2026) — uids on this IST day the CLOUD has already graded at the
 * CURRENT engine version, so the mini backfill can skip them instead of re-grading what Gemini has
 * done and racing the nightly worker. `model NOT LIKE 'qwen%'` is the cloud test, matching
 * isLocalGrader in lib/audit-canonical.ts; excluded rows do not count as done.
 *
 * EFFICIENCY ONLY. The safety guarantee is the grader tier in the canonical ranking — a mini row
 * that slips through here still cannot outrank a cloud row.
 */
export async function cloudAuditedUidsForDay(day: string): Promise<string[]> {
  const rows = (await sql(
    `SELECT uid FROM opd_note_audits
     WHERE engine_version = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2::date
       AND excluded_reason IS NULL
       AND (model IS NULL OR model NOT LIKE 'qwen%')`,
    [OPD_ENGINE_VERSION, day],
  )) as Array<{ uid: string }>;
  return rows.map((r) => r.uid).filter(Boolean);
}

/** Count audited (at this engine version) for an IST calendar day. */
export async function auditedCountForDay(day: string, engineVersion: string): Promise<number> {
  const rows = (await sql(
    `SELECT count(*)::int AS n FROM opd_note_audits
     WHERE engine_version = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,
    [engineVersion, day],
  )) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Exclusion reasons a note can RECOVER from — an incident marked the row, not the note (31 Jul
 * 2026, addendum B). Everything NOT listed here is PERMANENT and keeps the note out of the fetch
 * loop forever; `house_account` is the original such reason and stays that way. Adding a reason
 * here is a deliberate act: a new exclusion reason defaults to permanent by omission.
 */
const RE_AUDITABLE_EXCLUSIONS = [
  'vertex_outage_mislabel_2026_07',
  'llm_leg_failed',
] as const;

/**
 * The "counts as already audited" predicate, shared by the two reads below so the worker's sweep
 * gate and its fetch-exclusion list can never disagree (they are compared against each other in
 * `worker/route.ts`, so a divergence would loop a day forever).
 *
 * A uid counts as AUDITED when EITHER:
 *   · it holds a row that is active, or excluded for a reason OUTSIDE the allowlist (permanent); OR
 *   · ⚠️ THE SPEND GUARD — it already holds a row at the version the worker would WRITE.
 *
 * WHY THE GUARD EXISTS. `saveOpdAudit` wrote `ON CONFLICT (uid, engine_version) DO NOTHING`, so a
 * re-audit of a note that already holds a row at the SAME engine version was SILENTLY DISCARDED.
 * Without this condition the 301 stranded notes that already held an OPD_ENGINE_VERSION row would
 * be re-fetched and re-audited on the paid reference model every single night, for a result the
 * insert throws away — a permanent recurring spend loop that never clears the note. Deletion would
 * at least terminate.
 *
 * ⚠️ IT MUST BE `OPD_ENGINE_VERSION`, NOT `OPD_ENGINE_VERSIONS_CURRENT`. Addendum B §3 specified
 * the read FAMILY, but the family spans 0.81.3 → 0.81.17 and EVERY stranded note holds a row
 * somewhere in it — so the family form frees ZERO notes and silently makes this whole change a
 * no-op (measured). The collision is per (uid, engine_version) against the ONE version the worker
 * writes, so the write target is the only correct key: it frees the 192 whose rows sit at older
 * family versions (0.81.14 ×106, 0.81.15 ×85, 0.81.8 ×1), where an insert at 0.81.17 cannot
 * collide, and holds exactly the 301 that would loop. None of the 192 is in the experiment cohort.
 *
 * ⚠️ NARROWED (addendum F v2 task 2): a write-target row marked 'llm_leg_failed' no longer holds
 * the note, because the save it was protecting against no longer discards — saveOpdAudit's default
 * conflict clause is now `DO UPDATE ... WHERE excluded_reason = 'llm_leg_failed'`, so a retry
 * LANDS in place (success clears the mark and branch 1 counts the note audited; a repeat failure
 * re-marks and the note is retried on a later sweep — recurring, but every attempt can land, which
 * is the opposite of the discard loop this guard exists to prevent). A write-target row that is
 * ACTIVE or carries any OTHER exclusion still holds the note: for those the WHERE refuses the
 * update and a re-audit would still be paid-and-discarded.
 */
const AUDITED_HAVING = `HAVING bool_or(excluded_reason IS NULL OR excluded_reason <> ALL($2::text[]))
        OR bool_or(engine_version = $3 AND excluded_reason IS DISTINCT FROM 'llm_leg_failed')`;
const AUDITED_PARAMS = (day: string): unknown[] => [
  day, RE_AUDITABLE_EXCLUSIONS as unknown as string[], OPD_ENGINE_VERSION,
];

/** uids that count as audited for a day — the set the Gemini worker keeps OUT of its fetch loop.
 *
 *  ⚠️ DATA-QUALITY §1 EXCEPTION (still in force): this read does NOT simply filter
 *  `excluded_reason IS NULL`. If it did, the 167 excluded house-account audits would look
 *  un-audited → the worker would try to re-admit them each night. `house_account` is not in
 *  RE_AUDITABLE_EXCLUSIONS, so it still reads as audited. (The intake filter also excludes those
 *  at db13-fetch time; this is belt-and-braces.) What CHANGED on 31 Jul is narrower: a note whose
 *  only rows are `llm_leg_failed` / `vertex_outage_mislabel_2026_07` — an incident, not a verdict
 *  — no longer counts as audited forever, provided it holds no current-family row. */
export async function auditedUidsForDayAnyVersion(day: string): Promise<string[]> {
  const rows = (await sql(
    `SELECT uid FROM opd_note_audits
     WHERE (note_date AT TIME ZONE 'Asia/Kolkata')::date = $1::date
     GROUP BY uid
     ${AUDITED_HAVING}`,
    AUDITED_PARAMS(day),
  )) as Array<{ uid: string }>;
  return rows.map((r) => r.uid).filter(Boolean);
}

/** Re-audit support (Fix B / decision 2) — delete ALL rows for a note uid so the fresh 0.81.7 audit
 *  is the single current row (chosen mechanism: DELETE-then-INSERT — see the build report's flag).
 *  Feedback rows live in a separate append-only table and are untouched. */
export async function deleteOpdAuditsForUid(uid: string): Promise<number> {
  if (!uid) return 0;
  const rows = (await sql(`DELETE FROM opd_note_audits WHERE uid = $1 RETURNING id`, [uid])) as Array<{ id: string }>;
  return rows.length;
}

/** Count of DISTINCT notes that count as audited for a day. MUST use the same predicate as
 *  `auditedUidsForDayAnyVersion` — the worker compares this count against the day's eligible total
 *  to decide whether to process the day at all, then excludes that uid list from the fetch. If the
 *  two disagreed, a day could look incomplete forever while the fetch returned nothing. */
export async function auditedCountForDayAnyVersion(day: string): Promise<number> {
  const rows = (await sql(
    `SELECT count(*)::int AS n FROM (
       SELECT uid FROM opd_note_audits
       WHERE (note_date AT TIME ZONE 'Asia/Kolkata')::date = $1::date
       GROUP BY uid
       ${AUDITED_HAVING}
     ) audited`,
    AUDITED_PARAMS(day),
  )) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/** Earliest IST day that has any audit — the floor for the gap-fill sweep (never audit
 *  days before the system started). Null if nothing audited yet. */
export async function earliestAuditedDay(): Promise<string | null> {
  const rows = (await sql(
    `SELECT to_char(min((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') AS d FROM opd_note_audits`,
  )) as Array<{ d: string | null }>;
  return rows[0]?.d ?? null;
}

// ── ONE ROW PER NOTE (Phase C FIX 0) ─────────────────────────────────────────────────────────────
//
// The OPD surface filters on an engine FAMILY (`engine_version = ANY(OPD_ENGINE_VERSIONS_CURRENT)`),
// so a note audited at 0.81.13 AND 0.81.14 is counted twice by every aggregate on the page.
// MEASURED 27 Jul: a 90-day window holds 25,128 rows over 11,835 notes — 52.9% duplicates — and it
// bites hardest on the days an engine bump spans (2026-07-25: 532 rows, 429 notes, plus a -mini row).
//
// THE RULE IS NOT RE-IMPLEMENTED HERE. `canonicalByUid` is the same function the IPD surface uses
// (lib/audit-canonical.ts), keyed on `uid` instead of `document_id`. This helper returns the winning
// AUDIT IDS for a window; the page's existing aggregates then add `AND id = ANY($n::uuid[])`. That
// keeps one implementation of the rule and leaves the (correct, tuned) SQL alone.
//
// READ FILTER ONLY — nothing is written, nothing is deleted.

const OPD_CANONICAL_SCAN_CAP = 20000;

/**
 * The canonical audit ids for an IST day range — one per note uid, highest engine version,
 * `-mini` excluded before ranking, ties by model tier (reference before candidate, addendum H)
 * then latest audited_at. `model` is fetched because the tier ranks on it — dropping it from the
 * select silently degrades the tier to a no-op.
 *
 * Never throws: on any failure it returns `null`, which callers MUST treat as "do not filter"
 * rather than "no rows". Degrading to today's inflated-but-present numbers beats an empty page.
 *
 * INFERRED SQL — columns from migrations/0007.
 *   SELECT id, uid, engine_version, audited_at FROM opd_note_audits
 *    WHERE app_source = $1 AND excluded_reason IS NULL
 *      AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3
 */
export async function canonicalOpdAuditIds(appSource: string, from: string, to: string): Promise<string[] | null> {
  try {
    const rows = (await sql(
      `SELECT id, uid, engine_version, model,
              to_char(audited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS audited_at
         FROM opd_note_audits
        WHERE app_source = $1 AND excluded_reason IS NULL
          AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3
        LIMIT ${OPD_CANONICAL_SCAN_CAP}`,
      [appSource, from, to],
    )) as Array<Record<string, unknown>>;
    return canonicalByUid(rows).map((r) => String(r.id)).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The acceptance number for FIX 0: how many DISTINCT NOTES a day holds, versus how many audit rows.
 * Exposed so the count can be checked directly rather than inferred from a rendered page.
 */
export async function opdCanonicalDayCount(appSource: string, day: string): Promise<{ rows: number; notes: number }> {
  try {
    const raw = (await sql(
      `SELECT id, uid, engine_version, model,
              to_char(audited_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS audited_at
         FROM opd_note_audits
        WHERE app_source = $1 AND excluded_reason IS NULL
          AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2
        LIMIT ${OPD_CANONICAL_SCAN_CAP}`,
      [appSource, day],
    )) as Array<Record<string, unknown>>;
    return { rows: raw.length, notes: canonicalByUid(raw).length };
  } catch {
    return { rows: 0, notes: 0 };
  }
}

// ── recompute-on-read (Scoring policy Phase A, decision §1.1 / §1.5) ─────────────────────────────
//
// ⚠️ OPD IS NEW-AUDITS-ONLY, AND THIS FUNCTION CANNOT CHANGE THAT. Decision §1.5: `opd_note_audits`
// stores `missing_fields` (display LABELS) and `completeness_pct`, but NO per-field status array —
// so its 25,130-note history cannot be re-weighted, and this wrapper deliberately does not try.
// It attaches the active weights version for display (PRD §8.3, "every surface showing a band must
// also show the weights version that produced it") and mirrors the stored values, but leaves the
// scores alone. Re-weighting begins only once the engine's structured emission is persisted.
//
// It is written as a wrapper anyway, rather than omitted, so that the moment the structured array
// IS persisted the change is a single `extractOpdItems` implementation here — not a new read path.

export interface WeightedOpdRow extends Record<string, unknown> {
  stored_completeness_pct: number | null;
  stored_note_quality_index: number | null;
  stored_band: string | null;
  weights_version: string | null;
  /** TRUE when THIS ROW has no stored per-field detail, so nothing could be re-weighted. */
  weights_not_applicable: boolean;
}

/**
 * Parse `opd_note_audits.completeness_items` (0027). Returns [] for NULL, a non-array, or unparseable
 * JSON — the caller distinguishes "no items" from "items" and never scores an empty array.
 */
export function parseOpdCompletenessItems(raw: unknown): { key: string; status?: unknown; label?: string; section?: string }[] {
  let v: unknown = raw;
  if (v == null) return [];
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(v)) return [];
  return v.filter((i): i is { key: string } => !!i && typeof i === 'object' && typeof (i as { key?: unknown }).key === 'string');
}

/**
 * Apply the active OPD weights to already-fetched rows (A.1 / item D-1).
 *
 * ═══ THE FALLBACK RULE — THE LOAD-BEARING PART OF THIS FUNCTION ═══
 * A row whose `completeness_items` is NULL — every one of the 25,130 historical rows, and every row
 * written before migration 0027 runs — KEEPS ITS STORED FLAT `completeness_pct`, `note_quality_index`
 * and `band`, untouched. It is marked `weights_not_applicable: true`.
 *
 * It must NEVER be scored from the absent array. `weightedCompleteness([], …)` returns 100 ("no
 * applicable fields ⇒ nothing missing"), which is correct for a document whose fields are all `na`
 * and CATASTROPHICALLY wrong for a row we simply never recorded detail for: it would silently
 * promote 25,130 historical audits to 100% documentation. Equally, a missing array must never read
 * as "all fields missing" (0%). Hence the explicit `items.length === 0 ⇒ return stored` guard below,
 * which has its own test.
 *
 * Decision §1.5 stands: OPD weighting is NEW-AUDITS-ONLY. There is no backfill and this function
 * does not simulate one.
 *
 * Only the DOCUMENTATION fields are weighted: the three continuity items (advice_given,
 * advice_instructions, follow_up) are scored in the Continuity domain and are excluded from the
 * completeness denominator by the engine, so they are filtered out here too. With v1 all-Standard
 * that makes the weighted value reproduce the engine's own `coverage` exactly.
 *
 * NEVER THROWS: on any failure the rows come back stored-as-is with `weights_version: null`.
 */
export async function applyOpdScoringPolicy<T extends Record<string, unknown>>(rows: T[]): Promise<(T & WeightedOpdRow)[]> {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];

  const stored = (r: T) => ({
    ...r,
    stored_completeness_pct: r.completeness_pct == null ? null : Number(r.completeness_pct),
    stored_note_quality_index: r.note_quality_index == null ? null : Number(r.note_quality_index),
    stored_band: r.band == null ? null : String(r.band),
  });

  try {
    const { getActivePolicy } = await import('./scoring-policy/store');
    const { weightedCompleteness, OPD_RX_COND_KEYS } = await import('./scoring-policy/completeness');
    const { recomputeOpdIndex } = await import('./scoring-policy/recompute');
    const { weightedKeysFor } = await import('./scoring-policy/weights');
    const policy = await getActivePolicy('opd_rx');
    const versionString = policy.fallback ? null : policy.versionString;
    const weightable = new Set(weightedKeysFor('opd_rx'));

    return list.map((r) => {
      const base = { ...stored(r), weights_version: versionString };
      const items = parseOpdCompletenessItems(r.completeness_items).filter((i) => weightable.has(i.key));
      // ── THE GUARD. No stored detail ⇒ stored values, verbatim. ──
      if (items.length === 0) return { ...base, weights_not_applicable: true } as T & WeightedOpdRow;

      const c = weightedCompleteness(items, policy.vector, { condKeys: OPD_RX_COND_KEYS });
      const idx = recomputeOpdIndex(
        {
          documentation: c.pct,
          note_quality: numOrNull(r.score_note_quality),
          appropriateness: numOrNull(r.score_appropriateness),
          prescribing_safety: numOrNull(r.score_prescribing_safety),
          patient_centred: numOrNull(r.score_patient_centred),
        },
        c.pct,
      );
      return {
        ...base,
        completeness_pct: c.pct,
        score_documentation: c.pct,
        note_quality_index: idx.index,
        band: idx.band,
        weights_not_applicable: false,
      } as T & WeightedOpdRow;
    });
  } catch {
    return list.map((r) => ({ ...stored(r), weights_version: null, weights_not_applicable: true })) as (T & WeightedOpdRow)[];
  }
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
