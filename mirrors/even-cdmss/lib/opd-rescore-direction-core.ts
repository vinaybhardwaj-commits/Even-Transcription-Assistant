/**
 *   node --experimental-strip-types lib/opd-rescore-direction-core.ts
 *
 * The `direction` dead-path fix (PRD 29 Jul 2026) — PURE core for the watermarked re-score pass.
 *
 * WHY THIS PASS EXISTS: `concept_id` is written by the concept tick AFTER the audit row lands
 * (lib/even-concept.ts WRITEBACK_SQL), so on the fresh-LLM path `stampDirection` sees an empty
 * conceptId and can never fire. On the REUSE path the stored findings DO carry `concept_id`, so
 * `finalize()` stamps normally. This pass drives the reuse path over every note the concept coder
 * has touched more recently than the last re-score that observed it (D-2, eventual consistency).
 *
 * THE RACE GUARD (D-3): the watermark stores the `coded_at` READ DURING CANDIDATE SELECTION —
 * never now(), never a re-read after the update. If a concept tick lands mid-flight,
 * even_concept_state.coded_at advances past based_on_coded_at and the note is selected again on
 * the next pass. A clobbered `direction` self-heals within one pass; a re-read would record a
 * stamp the re-score never saw and make the clobber permanent and invisible. No locks (D-3 —
 * the 28 Jul lab-batch lock TTL defect is the precedent for why not).
 *
 * House convention: no lib/db, no next/*, no LLM imports — type-only cross-imports keep this
 * loadable under `node --experimental-strip-types`.
 */
import type { OpdFinding } from './opd-note-audit-core';
import type { Pdqi9Attr } from './opd-note-score-core';

export const RESCORE_LIMIT_DEFAULT = 800;

/** ?limit= — default 800, clamped 1..3000 (PRD §2.6). Junk (NaN, '', negative) lands on the default. */
export function clampRescoreLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return RESCORE_LIMIT_DEFAULT;
  return Math.max(1, Math.min(3000, Math.floor(n)));
}

/**
 * Candidate selection (PRD §2.2): a note is a candidate when the concept coder has touched it more
 * recently than the last re-score that observed it. BOUND PARAMETERS ONLY —
 *   $1 app_source · $2 engine-version list (OPD_ENGINE_VERSIONS_CURRENT) · $3 limit —
 * so an unknown version selects zero rows, never throws, never touches another version's rows.
 *
 * `withDisplayedBand` tolerates migration 0029 not having run (same pre-migration tolerance as
 * opd-audit-store): without the column, band_before/band_after fall back to the raw band.
 *
 * A-4 defect 1 — `date_trunc('milliseconds', s.coded_at)`: the watermark's based_on_coded_at
 * round-trips through a JS Date (millisecond precision) while timestamptz holds microseconds, so
 * without the trunc the stored value sits 800–940 µs BEHIND the value it observed and the note
 * re-selects forever (measured: a permanent no-op hot loop). NOT a tolerance — the trunc makes
 * the comparison exact against what was stored; a genuine new stamp is milliseconds later and
 * still re-selects, so the D-3 race guard keeps its meaning. Do NOT instead re-read coded_at
 * inside the watermark INSERT: that records write-time, not selection-time, and silently
 * reintroduces the clobber D-3 exists to survive.
 *
 * ⚠️ Every opd_note_audits / even_concept_state column here is INFERRED against production except
 * those confirmed in PRD §5 — validate live before any apply=1 run.
 */
export function rescoreCandidateSql(withDisplayedBand: boolean): string {
  return `SELECT a.uid, a.engine_version, s.coded_at,
       a.findings, a.pdqi9, a.suggestions, a.sources,
       a.note_quality_index, a.band${withDisplayedBand ? ', a.displayed_band' : ''}
  FROM opd_note_audits a
  JOIN even_concept_state s
    ON s.uid = a.uid AND s.engine_version = a.engine_version
  LEFT JOIN opd_rescore_state r
    ON r.uid = a.uid AND r.engine_version = a.engine_version
 WHERE a.app_source = $1
   AND a.excluded_reason IS NULL
   AND a.engine_version = ANY($2::text[])
   AND (r.uid IS NULL OR date_trunc('milliseconds', s.coded_at) > r.based_on_coded_at)
 ORDER BY a.note_date DESC
 LIMIT $3`;
}

/** A-1 (D-8): narrow the candidate engine list to one version. WHITELIST, not passthrough: a value
 *  that is not a member of OPD_ENGINE_VERSIONS_CURRENT yields an EMPTY list, so the pass selects
 *  zero rows and reports empty. An arbitrary string can never widen scope or reach rows outside
 *  the family. Bare exact version only ('opd-note-audit/0.81.17') — no short forms, no prefixing:
 *  the exact-match whitelist is the safety property. */
export function resolveEngineFilter(
  raw: string | null,
  family: readonly string[],
): string[] {
  const v = (raw ?? '').trim();
  if (!v) return [...family];
  return family.includes(v) ? [v] : [];
}

/** Watermark upsert (migration 0030). `based_on_coded_at` = the concept stamp the re-score was
 *  COMPUTED FROM ($3, the coded_at read at selection); `rescored_at` = when it ran (now()). */
export const RESCORE_WATERMARK_UPSERT_SQL = `INSERT INTO opd_rescore_state
  (uid, engine_version, based_on_coded_at, rescored_at, index_before, index_after, band_before, band_after)
  VALUES ($1, $2, $3, now(), $4, $5, $6, $7)
  ON CONFLICT (uid, engine_version) DO UPDATE SET
    based_on_coded_at = EXCLUDED.based_on_coded_at, rescored_at = now(),
    index_before = EXCLUDED.index_before, index_after = EXCLUDED.index_after,
    band_before = EXCLUDED.band_before, band_after = EXCLUDED.band_after`;

export interface RescoreWatermarkInput {
  uid: string;
  engineVersion: string;
  /** The coded_at READ IN CANDIDATE SELECTION. The caller must pass the selected value verbatim. */
  observedCodedAt: unknown;
  indexBefore: number | null;
  indexAfter: number | null;
  bandBefore: string | null;
  bandAfter: string | null;
}

/** Parameter row for RESCORE_WATERMARK_UPSERT_SQL. Pure pass-through: the value written as
 *  based_on_coded_at IS the value read — asserted in tests by identity, not recency (D-3). */
export function buildWatermarkParams(w: RescoreWatermarkInput): unknown[] {
  return [w.uid, w.engineVersion, w.observedCodedAt, w.indexBefore, w.indexAfter, w.bandBefore, w.bandAfter];
}

/** Reconstruct computeOpdScore's pdqi9 OBJECT ({attr:value}) from the STORED rows-array form.
 *  (Same reconstruction the dosing backfill performs; extracted pure so it is testable.) */
export function pdqi9ObjFromStoredRows(v: unknown): Partial<Record<Pdqi9Attr, number>> | null {
  const rows = Array.isArray(v) ? v : [];
  if (!rows.length) return null;
  const o: Partial<Record<Pdqi9Attr, number>> = {};
  for (const r of rows) {
    const rr = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const attr = String(rr.attr || '') as Pdqi9Attr;
    const val = Number(rr.value);
    if (attr && Number.isFinite(val)) o[attr] = val;
  }
  return Object.keys(o).length ? o : null;
}

const hasDirection = (f: unknown): boolean => {
  const d = (f && typeof f === 'object' ? (f as { direction?: unknown }).direction : undefined);
  return d === 'overuse' || d === 'underuse';
};

/** Findings that GAINED a direction: count after minus count before, floored at 0 (a direction is
 *  never removed by the re-score — stampDirection only adds). */
export function directionGained(before: unknown, after: OpdFinding[]): number {
  const b = (Array.isArray(before) ? before : []).filter(hasDirection).length;
  const a = after.filter(hasDirection).length;
  return Math.max(0, a - b);
}

export function underuseCount(findings: OpdFinding[]): number {
  return findings.filter((f) => f.direction === 'underuse').length;
}

// ── the pass lock (A-4 defect 3) ──────────────────────────────────────────────────────────────
//
// Two overlapping invocations both select the same candidates (neither has watermarked at
// selection time); the later watermark write wins and overwrites index_before with post-update
// values — the audit trail then reads "nothing changed" on notes that did change. Scores are
// unaffected (the second write is idempotent); the trail is the casualty. ONE soft advisory lock
// for the whole pass — per-uid Postgres advisory locks were rejected in the PRD for the wedge
// risk. Pattern follows lab_batch (LB_KEYS.lock / labLockHeld), INCLUDING its TTL — the TTL's
// absence was the 28 Jul defect.

export const RESCORE_LOCK_KEY = 'opd_rescore_direction_lock';

/** 600s. The route's maxDuration is 300s (Vercel kills harder runs), so 600s covers any possible
 *  run with 100% headroom and a crashed run self-heals in ten minutes instead of wedging. */
export const RESCORE_LOCK_TTL_MS = 600 * 1000;

/** Semantics byte-for-byte those of labLockHeld / mini-backfill.lockHeld: absent/empty ⇒ false,
 *  unparseable ⇒ false, otherwise `now - t < TTL` — differing only in which TTL is read. */
export function rescoreLockHeld(lockTs: string | null, now: Date = new Date()): boolean {
  if (!lockTs) return false;
  const t = Date.parse(lockTs);
  return Number.isFinite(t) && now.getTime() - t < RESCORE_LOCK_TTL_MS;
}

// ── report reducer ────────────────────────────────────────────────────────────────────────────

export interface RescoreOutcome {
  uid: string;
  fetched: boolean;
  directionGained: number;
  indexBefore: number | null;
  indexAfter: number | null;
  bandBefore: string | null;
  bandAfter: string | null;
  nUnderuse: number;
  applied: boolean;
  /** A-2: what updateOpdAudit actually did — 'skipped' and a discarded throw were previously
   *  indistinguishable from outside (a fail-safe that reports nothing is invisible, not safe).
   *  Undefined on dry runs. */
  applyOutcome?: 'updated' | 'skipped' | 'error';
  /** A-2: driver MESSAGE TEXT only — never note content. */
  applyError?: string;
  /** A-2: audit.keys.uid as the apply path saw it — separates `if (!k.uid) return 'skipped'`
   *  from "the UPDATE matched no row" without another round trip. */
  auditUid?: string | null;
}

export interface RescoreReport {
  considered: number;
  not_fetched: number;
  /** Findings that gained a `direction` — the success metric. rows_changed is NOT acceptable
   *  here (PRD §2.6): this pass must count index and band movement directly. */
  direction_stamped: number;
  index_changed: number;
  band_changed: number;
  applied: number;
  /** A-2: updateOpdAudit returned 'skipped' — two causes, disambiguated by missing_audit_uid. */
  apply_skipped: number;
  /** A-2: updateOpdAudit threw; the throw is still swallowed (the fail-safe continues) but counted. */
  apply_error: number;
  /** A-2: the FIRST non-empty applyError seen, truncated to 300 chars. Null when none occurred. */
  first_apply_error: string | null;
  /** A-2: apply-path candidates whose audit.keys.uid was null/empty — the `if (!k.uid)` skip cause. */
  missing_audit_uid: number;
  sample: { uid: string; index_before: number | null; index_after: number | null; band_before: string | null; band_after: string | null; n_underuse: number }[];
}

export function reduceRescoreReport(outcomes: RescoreOutcome[]): RescoreReport {
  const r: RescoreReport = { considered: 0, not_fetched: 0, direction_stamped: 0, index_changed: 0, band_changed: 0, applied: 0, apply_skipped: 0, apply_error: 0, first_apply_error: null, missing_audit_uid: 0, sample: [] };
  for (const o of outcomes) {
    if (!o.fetched) { r.not_fetched++; continue; }
    r.considered++;
    r.direction_stamped += o.directionGained;
    const indexMoved = o.indexBefore !== o.indexAfter;
    const bandMoved = o.bandBefore !== o.bandAfter;
    if (indexMoved) r.index_changed++;
    if (bandMoved) r.band_changed++;
    if (o.applied) r.applied++;
    // A-2 — apply-path diagnostics. Purely additive: the fail-safe behaviour is unchanged.
    if (o.applyOutcome === 'skipped') r.apply_skipped++;
    if (o.applyOutcome === 'error') {
      r.apply_error++;
      if (r.first_apply_error == null && o.applyError) r.first_apply_error = o.applyError.slice(0, 300);
    }
    if (o.applyOutcome !== undefined && !o.auditUid) r.missing_audit_uid++;
    if ((o.directionGained > 0 || indexMoved || bandMoved) && r.sample.length < 20) {
      r.sample.push({ uid: o.uid, index_before: o.indexBefore, index_after: o.indexAfter, band_before: o.bandBefore, band_after: o.bandAfter, n_underuse: o.nUnderuse });
    }
  }
  return r;
}

/** The empty report — what the route returns when a query fails or the watermark table does not
 *  exist yet (fail safe: never a 500, never a partial write, never wrong data). */
export function emptyRescoreReport(): RescoreReport {
  return reduceRescoreReport([]);
}
