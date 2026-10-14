/**
 * lib/cognition/shadow-sweep.ts — WM1: the shadow agent's one moving part.
 *
 * Reads audit rows the shadow has not yet judged, decides for each whether the agent WOULD have
 * asked, and writes that decision down. Nothing else happens. No clinician is contacted, no surface
 * changes, no ask is queued — the entire deliverable is a table an admin can read to find out how
 * often the agent would have spoken, and why it stayed quiet the rest of the time.
 *
 * ── SHADOW ONLY ────────────────────────────────────────────────────────────────────────────────
 *
 * "Shadow" is a load-bearing word here, not a label. The sweep writes exactly one kind of row, to
 * one table, that no doctor-facing code path reads. If a future ship closes the loop, it does so by
 * ADDING a reader — never by changing what this writes, because the shadow numbers are only
 * trustworthy if they were produced by the same policy the live agent would run.
 *
 * ── WM0's PATTERN, INHERITED DELIBERATELY ──────────────────────────────────────────────────────
 *
 * Same shape as lib/world-model/walk-o.ts: the impure edges are injectable with real defaults, so
 * the whole sweep is provable offline; statuses are honest enums with a named value for every
 * outcome; and the top-level function never throws. A failed read makes the sweep REPORT and STOP
 * CLEANLY — it never returns a partial count dressed up as a complete one, and never a 500.
 *
 * ── IDEMPOTENCE ────────────────────────────────────────────────────────────────────────────────
 *
 * The table carries UNIQUE (trigger_kind, event_ref, policy_version) and every insert is
 * ON CONFLICT DO NOTHING, so re-running the sweep over the same backlog is a no-op. `policy_version`
 * is IN the key on purpose: bumping BURDEN_POLICY_VERSION re-shadows the backlog under the new rule
 * instead of leaving decisions made under the old one to be misread as current.
 *
 * ── ⚠️ INFERRED SQL ────────────────────────────────────────────────────────────────────────────
 *
 * This sandbox has no live Neon and no live db13. Every query below is listed VERBATIM in the ship
 * report for the orchestrator to validate before the cron is enabled. Each read is individually
 * fail-safe: on error the sweep stops with `ok: false` and a named error, having written nothing it
 * cannot account for.
 */

import { sql } from '../db';
import { compareEngineVersion } from '../audit-canonical';
import { individualUidForPresc, getMemberSnapshotAsOf } from '../member-state/member-state';
import { microworldOf, auditRowText, MATCH_RULE, type Microworld } from './microworld';
import { decideBurden, eligibilityOf, BURDEN_PER_ELIGIBLE, PER_DOCTOR_DAILY_CAP, type BurdenReason } from './burden-policy';
import { COGNITION_SCHEMA_VERSION, BURDEN_POLICY_VERSION, type DecisionEventKind, type CognitionObjective } from './schema';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const APP = process.env.APP_SOURCE || 'standalone';

/** Bounded batch. A shadow sweep is never urgent; a small bounded run that drains over many ticks is
 *  strictly safer than one long transaction against the audit table. */
export const SWEEP_BATCH = 200;

/** The one trigger kind reachable in v0 — see DecisionEventKind's note on `ipd_stay_extracted`. */
export const V0_TRIGGER_KIND: DecisionEventKind = 'opd_note_audited';

/**
 * The o_status annotation. Mirrors WM0's walk statuses exactly, and for the same reason: a throw and
 * a null are DIFFERENT answers and must never collapse.
 *
 * · ok                   — the spine reconstructed as of the note date.
 * · no_prior_history     — resolved, and there was genuinely nothing before that day.
 * · context_fetch_failed — db13 threw. We do NOT know what was there.
 * · unresolved_identity  — the presc uid did not resolve to an individual, so there was nobody to
 *                          reconstruct. Distinct from the three above: the failure is at identity,
 *                          before any spine question was asked.
 */
export type OStatus = 'ok' | 'no_prior_history' | 'context_fetch_failed' | 'unresolved_identity';

/** One audit row as the sweep reads it. */
export interface TriggerRow {
  uid: string;
  doctor_uid: string | null;
  engine_version: string | null;
  audited_at: string | null;
  note_date: string | null;
  findings: unknown;
  suggestions: unknown;
}

/** One decided event, exactly as it is written. */
export interface ShadowRow {
  triggerKind: DecisionEventKind;
  eventRef: string;
  eventAt: string | null;
  doctorUid: string | null;
  engineVersion: string | null;
  microworld: Microworld;
  matchRule: typeof MATCH_RULE;
  eligible: boolean;
  wouldAsk: boolean;
  objective: CognitionObjective | null;
  reason: BurdenReason;
  oStatus: OStatus | null;
}

export interface SweepResult {
  ok: boolean;
  /** Named failure when ok is false. The sweep stops cleanly rather than half-reporting. */
  error: string | null;
  scanned: number;
  written: number;
  eligible: number;
  wouldAsk: number;
  /** True when there was nothing left to judge — the drained steady state. */
  drained: boolean;
  currentEra: string | null;
  policyVersion: typeof BURDEN_POLICY_VERSION;
  schemaVersion: typeof COGNITION_SCHEMA_VERSION;
  budgets: { perEligible: number; perDoctorDaily: number };
}

/** Injectable impure edges — real defaults, fakes in tests. WM0's `WalkDeps` pattern. */
export interface SweepDeps {
  query?: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  /** presc uid → individual_uid. Defaults to the frozen bridge. */
  resolveIndividual?: (prescUid: string) => Promise<string | null>;
  /** The frozen as-of reconstruct. MUST be getMemberSnapshotAsOf in production. */
  reconstruct?: (individualUid: string, asOfDate: string, computedAt: string) => Promise<unknown | null>;
  batch?: number;
  appSource?: string;
}

// ── SQL (all four strings are listed verbatim in the ship report) ──────────────────────────────

/**
 * (1) THE CURRENT ERA PROBE. The distinct engine versions that produced audits in the last 14 days.
 * The winner is computed in JS by `compareEngineVersion` — NOT by SQL `max()`, which is a
 * lexicographic string compare and would rank `0.81.9` above `0.81.17`. Computed, never hardcoded.
 */
export const ERA_SQL =
  `SELECT DISTINCT engine_version
     FROM opd_note_audits
    WHERE app_source = $1
      AND excluded_reason IS NULL
      AND audited_at > NOW() - INTERVAL '14 days'`;

/**
 * (2) THE TRIGGER READ. Audit rows the shadow has not yet judged under this policy version.
 *
 * Deduped by `uid` keeping the latest `audited_at` (DISTINCT ON in the inner query), then ordered
 * OLDEST-FIRST and bounded, so the shadow accumulates in the order the world happened rather than
 * in uid order. `excluded_reason IS NOT NULL` rows are excluded — a note the audit engine itself
 * disowned is not an occasion for the agent to think.
 */
export const TRIGGER_SQL =
  `SELECT t.uid, t.doctor_uid, t.engine_version, t.audited_at, t.note_date, t.findings, t.suggestions
     FROM (
       SELECT DISTINCT ON (a.uid)
              a.uid, a.doctor_uid, a.engine_version, a.audited_at, a.note_date, a.findings, a.suggestions
         FROM opd_note_audits a
        WHERE a.app_source = $1
          AND a.excluded_reason IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM cognition_shadow_events s
                 WHERE s.trigger_kind = $2 AND s.event_ref = a.uid AND s.policy_version = $3
              )
        ORDER BY a.uid, a.audited_at DESC
     ) t
    ORDER BY t.audited_at ASC
    LIMIT $4`;

/**
 * (3) THE GLOBAL BUDGET SEED. Eligible shadow rows recorded since the last would-ask row, under this
 * policy version. `-infinity` when no ask has ever happened, so the very first run counts the whole
 * eligible history — which is what makes the first ask land at the tenth eligible event rather than
 * the first.
 */
export const GLOBAL_BUDGET_SQL =
  `SELECT count(*)::int AS n
     FROM cognition_shadow_events
    WHERE policy_version = $1
      AND eligible = TRUE
      AND created_at > COALESCE(
            (SELECT max(created_at) FROM cognition_shadow_events
              WHERE policy_version = $1 AND would_ask = TRUE),
            '-infinity'::timestamptz)`;

/** (4) THE PER-DOCTOR SEED. Asks already spent today, per clinician, in IST — the day boundary the
 *  rest of this repo uses for anything a doctor experiences. */
export const DOCTOR_BUDGET_SQL =
  `SELECT doctor_uid, count(*)::int AS n
     FROM cognition_shadow_events
    WHERE policy_version = $1
      AND would_ask = TRUE
      AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
    GROUP BY doctor_uid`;

/** (5) THE INSERT. Idempotent by the table's UNIQUE (trigger_kind, event_ref, policy_version). */
export const INSERT_SQL =
  `INSERT INTO cognition_shadow_events
     (app_source, trigger_kind, event_ref, event_at, doctor_uid, engine_version,
      microworld, match_rule, eligible, would_ask, objective, reason, o_status,
      policy_version, schema_version)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
   ON CONFLICT (trigger_kind, event_ref, policy_version) DO NOTHING`;

// ── the sweep ─────────────────────────────────────────────────────────────────────────────────

/** The newest engine version in the window, by numeric-tail comparison. Null when the window is
 *  empty — which `eligibilityOf` treats as fail-closed (`stale_era`), never as "everything current". */
export function newestEra(versions: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of versions) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    if (best === null || compareEngineVersion(s, best) > 0) best = s;
  }
  return best;
}

/**
 * Annotate one would-ask event with the spine's status as of the note date.
 *
 * ⚠️ THIS MUST NEVER FAIL THE SWEEP. Every path returns an OStatus; the caller writes the row and
 * moves on. An annotation is a nice-to-have on a shadow row, and losing the whole batch because one
 * member's db13 read timed out would trade something valuable for something cosmetic.
 *
 * Runs for would-ask rows ONLY — this is the one place the sweep touches db13, and doing it for
 * every scanned row would put a live query behind an event the agent has already decided to ignore.
 */
export async function annotateOStatus(
  prescUid: string,
  asOfDate: string,
  computedAt: string,
  deps: SweepDeps = {},
): Promise<OStatus> {
  const resolveIndividual = deps.resolveIndividual ?? individualUidForPresc;
  const reconstruct = deps.reconstruct ?? getMemberSnapshotAsOf;
  try {
    const individualUid = await resolveIndividual(prescUid);
    if (!individualUid) return 'unresolved_identity';
    try {
      const snap = await reconstruct(individualUid, asOfDate, computedAt);
      return snap ? 'ok' : 'no_prior_history';   // null and throw stay different answers
    } catch {
      return 'context_fetch_failed';
    }
  } catch {
    // A throw from the identity bridge is still an identity failure, not a spine failure.
    return 'unresolved_identity';
  }
}

/**
 * Run one bounded shadow sweep. NEVER THROWS.
 *
 * Sequential by construction: each decision depends on the budget counters left by the previous
 * one, so the loop cannot be parallelised without changing what the policy means.
 */
export async function runShadowSweep(deps: SweepDeps = {}): Promise<SweepResult> {
  const query = deps.query ?? run;
  const batch = deps.batch ?? SWEEP_BATCH;
  const app = deps.appSource ?? APP;
  const computedAt = new Date().toISOString();

  const base: SweepResult = {
    ok: true, error: null, scanned: 0, written: 0, eligible: 0, wouldAsk: 0, drained: false,
    currentEra: null,
    policyVersion: BURDEN_POLICY_VERSION,
    schemaVersion: COGNITION_SCHEMA_VERSION,
    budgets: { perEligible: BURDEN_PER_ELIGIBLE, perDoctorDaily: PER_DOCTOR_DAILY_CAP },
  };

  // (1) current era — computed from the last 14 days, never hardcoded.
  let currentEra: string | null;
  try {
    const rows = await query(ERA_SQL, [app]);
    currentEra = newestEra(rows.map((r) => r.engine_version as string | null));
  } catch (e) {
    return { ...base, ok: false, error: `era_probe_failed: ${String((e as Error).message).slice(0, 200)}` };
  }

  // (2) the backlog.
  let triggers: TriggerRow[];
  try {
    triggers = (await query(TRIGGER_SQL, [app, V0_TRIGGER_KIND, BURDEN_POLICY_VERSION, batch])) as unknown as TriggerRow[];
  } catch (e) {
    return { ...base, currentEra, ok: false, error: `trigger_read_failed: ${String((e as Error).message).slice(0, 200)}` };
  }
  if (!triggers.length) return { ...base, currentEra, drained: true };

  // (3) + (4) budget seeds. A failed seed is NOT recoverable by guessing zero: zero would mean
  // "nothing spent", which would let the sweep ask far more than the policy allows. Stop cleanly.
  let globalSinceLastAsk: number;
  const doctorAsks = new Map<string, number>();
  try {
    const g = await query(GLOBAL_BUDGET_SQL, [BURDEN_POLICY_VERSION]);
    globalSinceLastAsk = Number(g[0]?.n ?? 0);
    const d = await query(DOCTOR_BUDGET_SQL, [BURDEN_POLICY_VERSION]);
    for (const r of d) doctorAsks.set(String(r.doctor_uid ?? ''), Number(r.n ?? 0));
  } catch (e) {
    return { ...base, currentEra, ok: false, error: `budget_seed_failed: ${String((e as Error).message).slice(0, 200)}` };
  }

  let scanned = 0, written = 0, eligibleCount = 0, wouldAskCount = 0;

  for (const t of triggers) {
    scanned++;
    const microworld = microworldOf(auditRowText(t.findings, t.suggestions));
    const doctorUid = String(t.doctor_uid ?? '').trim() || null;
    const { eligible, reason: ineligibleReason } = eligibilityOf({
      microworld, doctorUid, engineVersion: t.engine_version, currentEra,
    });
    if (eligible) { eligibleCount++; globalSinceLastAsk++; }

    const decision = decideBurden({
      eligible,
      globalEligibleSinceLastAsk: globalSinceLastAsk,
      doctorAsksToday: doctorUid ? (doctorAsks.get(doctorUid) ?? 0) : 0,
      ineligibleReason,
    });

    // Spend the budgets the moment the decision is made, so the NEXT row in this same batch sees
    // the cost. Seeding from the DB alone would let one batch fire ten asks at once.
    let oStatus: OStatus | null = null;
    if (decision.wouldAsk) {
      wouldAskCount++;
      globalSinceLastAsk = 0;
      if (doctorUid) doctorAsks.set(doctorUid, (doctorAsks.get(doctorUid) ?? 0) + 1);
      const asOf = String(t.note_date ?? t.audited_at ?? '').slice(0, 10);
      oStatus = asOf
        ? await annotateOStatus(t.uid, asOf, computedAt, deps)
        : 'context_fetch_failed';   // no date to cut at — we cannot claim to know
    }

    try {
      await query(INSERT_SQL, [
        app, V0_TRIGGER_KIND, t.uid, t.note_date ?? t.audited_at ?? null, doctorUid, t.engine_version ?? null,
        microworld, MATCH_RULE, eligible, decision.wouldAsk, decision.objective, decision.reason, oStatus,
        BURDEN_POLICY_VERSION, COGNITION_SCHEMA_VERSION,
      ]);
      written++;
    } catch (e) {
      // A write failure is the one thing that must stop the sweep: the budget counters have already
      // moved in memory, so continuing would decide later rows against a spend that was never
      // recorded. Report what was actually written and stop.
      return {
        ...base, currentEra, ok: false,
        error: `insert_failed at ${t.uid}: ${String((e as Error).message).slice(0, 200)}`,
        scanned, written, eligible: eligibleCount, wouldAsk: wouldAskCount,
      };
    }
  }

  return { ...base, currentEra, scanned, written, eligible: eligibleCount, wouldAsk: wouldAskCount, drained: false };
}
