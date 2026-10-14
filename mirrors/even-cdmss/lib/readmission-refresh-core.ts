/**
 * lib/readmission-refresh-core.ts — PURE decisions for the R4.1 TEMPLATE-REFRESH run
 * (CDMSS-READMISSIONS-R4.1-PRD v1.0, R41-4 / R41-5 / R41-7): which audited findings are
 * refresh-pending (their stays NOW have final OT / PAC / progress rows on db13 that the stored
 * templateCoverage does not reflect), the probe gate's record + prompt fingerprints, and the
 * run type's constants. No DB, no model, no clock.
 *
 * The refresh re-analyzes a case END TO END on Opus 4.6 on Bedrock — full re-assemble (templates
 * included) → the SAME recon sequence (lib/readmission/run.ts runReconSequence, prompts byte-
 * identical) → judgements re-derived by the untouched rules (deriveJudgements inside
 * saveAuditResult) → narrative rewritten → saved IN PLACE at (dedup_key, engine 0.2). The only
 * thing that differs from the Vertex audit is who answers the legs.
 */
import { createHash } from 'node:crypto';
import { buildFullReconPrompt, buildSecondAvoidablePrompt, buildConditionPassPrompt, buildOonPrompt, buildNarrativePrompt } from './readmission-prompts';
import type { EvidenceCatalog } from './readmission-reconcile-core';
import type { TemplateCoverage, TemplateCoverageStatus } from './readmission-template-core';

// ── constants (R41-7) ───────────────────────────────────────────────────────────────────

export const REFRESH_WORKER = 'readmission_refresh' as const;
/** One case per tick: up to 3 recon legs + 1 narrative on Opus. */
export const REFRESH_N_PER_TICK = 1;
/** Per recon LEG budget on the refresh path (Opus, one try). Sized so a whole case — assemble
 *  (≤ ~30 s with templates) + 3 legs + narrative — stays inside the 300 s runner box AND the
 *  210 s soft-lock TTL: 30 + 3×40 + 50 = 200 s worst case. Opus measured ~25 s per ~1k-token
 *  JSON leg (18 Aug), so this is ~1.5× headroom; a slower leg fails THIS tick and the case is
 *  re-offered (attempt-capped) rather than overrunning the box. */
export const REFRESH_LEG_BUDGET_MS = 40_000;
export const REFRESH_LEG_MAX_TRIES = 1;
/** The narrative leg on the refresh path (measured 22–25 s; the audit path keeps 80 s). */
export const REFRESH_NARRATIVE_BUDGET_MS = 50_000;
/** A case that has failed refresh this many times is parked (`refresh_stuck`), not re-offered
 *  every tick — the sweep must self-drain, not spin on one bad case. */
export const REFRESH_MAX_ATTEMPTS = 3;
/** app_settings key holding the last PASSED probe record (R41-5). */
export const REFRESH_PROBE_KEY = 'readmit_refresh_probe';

// ── prompt fingerprints (the probe gate binds to these) ────────────────────────────────────

/** A fixed, de-identified fixture catalog. The fingerprints are the sha of what the four recon
 *  builders + the narrative builder emit for it — so ANY edit to a builder's text changes them,
 *  and a probe passed against old prompts no longer unlocks the run. */
const FIXTURE_CATALOG: EvidenceCatalog = { items: [
  { id: 'S1', source: 'index_summary', side: 'index', text: 'diagnosis: fracture neck of femur' },
  { id: 'R1', source: 'readmit_summary', side: 'readmit', text: 'diagnosis: superficial surgical site infection' },
  { id: 'L1', source: 'lab', side: 'index', text: 'Hb: 9.1 g/dL (ref 13-17)', abnormal: true, at: '2026-06-01' },
  { id: 'OT1', source: 'ot_note', side: 'index', text: 'OT note (Doctor: OT Notes), index stay · surgery: hemiarthroplasty · note: calcar crack, cerclage wire' },
] };

export function reconPromptFingerprints(): string {
  const h = (o: unknown) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
  return [
    h(buildFullReconPrompt(FIXTURE_CATALOG, { gapDays: 4, lane: 'tight_bounce', indexDepartment: 'Orthopaedics', readmitDepartment: 'Orthopaedics', sameDoctor: true, labProfile: 'has_late_labs' })),
    h(buildSecondAvoidablePrompt(FIXTURE_CATALOG, { gapDays: 4, labProfile: 'has_late_labs' })),
    h(buildConditionPassPrompt(FIXTURE_CATALOG, { gapDays: 4 })),
    h(buildOonPrompt(FIXTURE_CATALOG, { reportedReadmitDate: '2026-06-05', labProfile: 'has_late_labs' })),
    h(buildNarrativePrompt(FIXTURE_CATALOG, { findingClass: 'even_even', lane: 'tight_bounce', gapDays: 4, indexDepartment: 'Orthopaedics', readmitDepartment: 'Orthopaedics', planned: 'unplanned', sameCondition: 'same', avoidable: 'needs_adjudication', omissions: [], exculpatory: [], weakestStep: null, refusalRecord: [] }, { audited: 0, totalNotes: 0, candidates: [], joinFailed: false })),
  ].join('.');
}

// ── the probe record (R41-5) ────────────────────────────────────────────────────────────

export interface ProbeLeg { label: string; ms: number; jsonClosed: boolean; verdicts: Record<string, unknown> }
export interface ProbeRecord {
  passed: boolean;
  fingerprints: string;
  dedupKey: string;
  at: string;
  model: string;
  legs: ProbeLeg[];
  narrativeValid: boolean | null;
  saved: boolean;
}

/** PURE: a probe passes when EVERY recon leg closed valid JSON (parsePassClaims non-null) — the
 *  narrative's validity is reported but does not gate (the narrative has its own fail-closed
 *  rule; the recon prompts are what the S2 discipline is about). */
export function probePassed(legs: readonly ProbeLeg[]): boolean {
  return legs.length > 0 && legs.every((l) => l.jsonClosed);
}

/** PURE: does this stored record unlock a run under the CURRENT fingerprints? Any mismatch, any
 *  malformed record, any not-passed → false. Prompts changed ⇒ probe again. */
export function probeUnlocksRun(raw: unknown, currentFingerprints: string): { ok: true; record: ProbeRecord } | { ok: false; reason: string } {
  let rec: unknown = raw;
  if (raw == null || raw === '') return { ok: false, reason: 'no probe recorded — run action:probe on an OT-bearing case first' };
  if (typeof raw === 'string') { try { rec = JSON.parse(raw); } catch { return { ok: false, reason: 'no valid probe record — run action:probe on an OT-bearing case first' }; } }
  if (!rec || typeof rec !== 'object') return { ok: false, reason: 'no probe recorded — run action:probe on an OT-bearing case first' };
  const r = rec as Partial<ProbeRecord>;
  if (r.passed !== true) return { ok: false, reason: 'the last probe did not pass — every recon leg must close valid JSON on Opus before the run may start' };
  if (typeof r.fingerprints !== 'string' || r.fingerprints !== currentFingerprints) {
    return { ok: false, reason: 'the passed probe was recorded against different prompt fingerprints — the prompts changed since; probe again' };
  }
  return { ok: true, record: r as ProbeRecord };
}

// ── the delta detector (R41-4) ──────────────────────────────────────────────────────────

export type TemplateKey = keyof TemplateCoverage;   // 'ot' | 'pac' | 'progress'
export const TEMPLATE_KEYS: readonly TemplateKey[] = ['ot', 'pac', 'progress'] as const;

/** Final template rows that exist NOW on db13 for a stay's encounters, per source. */
export type TemplateCounts = Record<TemplateKey, number>;

/** What the finding was audited WITH (its stored templateCoverage; undefined/null = never looked). */
export type StoredCoverage = Partial<Record<TemplateKey, { status?: TemplateCoverageStatus | string | null; count?: number } | null>> | null | undefined;

/**
 * PURE — is this finding refresh-pending, and for which sources? A source is pending when rows
 * exist NOW and the stored coverage says the audit looked and found NONE (status `absent`) or
 * never looked (no entry). NOT pending: `present` / `empty` (rows were read; `empty` = rows without
 * usable text — whether NEW usable rows have since landed is deliberately not chased, flagged) and
 * `fetch_failed` (Addendum A1: a fetch_failed-only delta does not count — a refresh whose own
 * template fetch fails would otherwise land fetch_failed, reset, and re-pend forever; the fault is
 * an infrastructure fact for the operator, not a case to re-analyze). Attempt-capped cases are
 * parked as `stuck`.
 */
export function refreshDelta(coverage: StoredCoverage, counts: TemplateCounts, attempts = 0): { pending: boolean; stuck: boolean; sources: TemplateKey[] } {
  const sources: TemplateKey[] = [];
  for (const k of TEMPLATE_KEYS) {
    if (!(Number(counts[k]) > 0)) continue;
    const st = coverage?.[k]?.status ?? null;
    if (st === 'present' || st === 'empty' || st === 'fetch_failed') continue;
    sources.push(k);
  }
  const stuck = attempts >= REFRESH_MAX_ATTEMPTS && sources.length > 0;
  return { pending: sources.length > 0 && !stuck, stuck, sources };
}

/** Sum the per-encounter counts for a stay's encounters (index; + readmit for Even–Even). */
/** PURE (Addendum A1): did a refresh actually LAND rows for the sources it targeted? A refresh whose
 *  coverage for every targeted source came back `fetch_failed` read nothing new — it counts as an
 *  ATTEMPT (attempts increment, no reset), never as a success that resets the counter. */
export function refreshLanded(coverage: StoredCoverage, sources: readonly TemplateKey[]): boolean {
  if (!sources.length) return true;
  return sources.some((k) => { const st = coverage?.[k]?.status ?? null; return st === 'present' || st === 'empty'; });
}

export function countsForStay(byEncounter: ReadonlyMap<string, Partial<TemplateCounts>>, encounterIds: ReadonlyArray<string | null | undefined>): TemplateCounts {
  const out: TemplateCounts = { ot: 0, pac: 0, progress: 0 };
  for (const id of encounterIds) {
    if (!id) continue;
    const c = byEncounter.get(id);
    if (!c) continue;
    for (const k of TEMPLATE_KEYS) out[k] += Number(c[k] ?? 0) || 0;
  }
  return out;
}
