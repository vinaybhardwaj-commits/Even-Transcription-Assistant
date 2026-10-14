/**
 * lib/opd-note-audit.ts — OPD note-quality audit ORCHESTRATOR (server).
 *
 * One de-identified OPD note → grounded LLM analyze (findings + PDQI-9 + suggestions)
 * + deterministic completeness + prescribing checks → OPD Note-Quality scorecard.
 * Traced ('opd_note_audit') so model/provider/tokens/latency land in observability.
 * Soft-fails. The full PHI record stays in db13; only de-identified content reaches the LLM.
 */

import { randomUUID } from 'node:crypto';
import { retrieve, resolveNormativeSources, type RetrieveOptions } from './retrieve';
import { hitsToSources, buildCitedContext, type CiteHit, type Source } from './citations-core';
// ── Retrieval telemetry (Stage 0a on-path) ──────────────────────────────────────────────────────
import { createTelemetryCapture, buildRetrievalPayload, errorClassOf, type TelemetryCapture } from './retrieval-capture';
import {
  declareRetrievals, writeRetrievalTerminal, attachRetrievalTelemetry,
  type LifecycleHandle, type PredeclaredTelemetryRuns, type ManifestDefectsByRole,
} from './retrieval-telemetry-store';
import { startInvocation } from './retrieval-invocation-store';
import { routeClassOf, validateManifest } from './retrieval-telemetry-core';
import type {
  TelemetryRequestContext, RetrievalRoute, OperationalTelemetry, BackfillActivity,
} from './retrieval-telemetry-core';
import { activeRun } from './backfill-runs';
import { startTrace, logEvent, finishTrace, governedChat, setTraceQuestionPreview } from './trace';
import { geminiModelFor, geminiUtilityModel, TEXT_MODEL, MINI_MODEL, AUDIT_LLM_SEED, LLM_AUDIT_TIMEOUT_MS } from './llm';
import { rowToOpdCase, opdCaseText, type OpdKeys, type OpdMed, type DeidOpdCase } from './opd-ingest-core';
import {
  opdCompleteness, prescribingChecks, parseOpdAnalysis, stampFindingIdentity,
  consolidateDecisions, neutralizeMetadataFindings, resolveMedRoute,
  neutralizeScreeningContext, isHealthCheckEncounter, stampDirection, opdSignalType,
  NSAID_MOLECULES, MUSCLE_RELAXANT_MOLECULES, medHasMoleculeFrom,
  OPD_AUDIT_SYSTEM, buildOpdAuditUser, OPD_ENGINE_VERSION,
  type OpdFinding, type OpdCompleteness, type OpdSuggestion,
} from './opd-note-audit-core';
import { computeOpdScore, type OpdScorecard, type NetValue, type Pdqi9Attr } from './opd-note-score-core';
// Phase 3b — ratified clinical bands + the vitamin-D dose matrix (code, per the file's own header).
import {
  vitaminDBand, parseVitaminDLevel, vitaminDConcordance,
  VITAMIN_D_STANDARD, VITAMIN_D_UNITS, VITAMIN_D_DEFICIENT_BELOW, VITAMIN_D_SUFFICIENT_AT_OR_ABOVE,
  type VitaminDBand,
} from './clinical-bands';
import { enrichOpdMeds } from './formulary';
import { doseFindings } from './dose-limits';
import { parseDurationDays, moleculesOf, parseFrequency, unitsPerDose, isVolumetric, type DoseLimitsTable } from './dose-aggregation-core';
// Unit A (PRD §2) reads the SAME ceilings table lib/dose-limits.ts binds — moleculesOf needs it to
// canonicalise a composition fragment. Imported here (the orchestrator is impure by design) rather
// than re-exported, so lib/dose-limits.ts keeps its single, pre-bound surface.
import DOSE_LIMITS_JSON from '@/data/dose-limits.json';
import { tagInteractions, DDI_MECHANISM_CITATIONS } from './ddi-tags';
import type { FindingProvenance } from './provenance-tier-core';
import { curatedInteractions, mergeRank, type DrugClass } from './ddi';
import type { DdiPair } from './rxlabelguard';
import { applySuppressions, applyDemotes, type Suppression } from './audit-suppression-core';
import { loadActiveSuppressions, loadQuietingConfig } from './audit-suppression-store';
import { stampLvcMetadata, type LvcRuleLite } from './opd-lvc-classify-core';
import { bandFor, type ComplexityBand, type ComplexityInputs } from './opd-complexity-core';
import { bannedFdcFindings, bannedFdcNearMisses } from './cdsco-banned-fdc';
import { fetchPatientHistoryBundle } from './metabase';
import { PROVIDER_BUDGETS } from './lab-provider-core';
import { sql } from './db';
import { buildLongitudinalInput, type LongitudinalNoteInput } from './opd-longitudinal-core';   // Stage 3 (opd-longitudinal/0.1)
// Pure, dependency-free helper (lab-batch-core imports nothing, so this cannot form a cycle).
import { remainingBudgetMs } from './lab-batch-core';

// Best-effort cache of active suppressions (Tier-1 self-heal) so the per-note audit doesn't re-read
// the table each time. Short TTL; a fresh suppression takes effect within a minute. Empty = no-op.
let _suppCache: { at: number; list: Suppression[] } | null = null;
async function getActiveSuppressions(): Promise<Suppression[]> {
  const now = Date.now();
  if (_suppCache && now - _suppCache.at < 60_000) return _suppCache.list;
  try { const list = await loadActiveSuppressions(); _suppCache = { at: now, list }; return list; }
  catch { return _suppCache?.list ?? []; }
}

// Quieting (demote) config — PRD CDMSS-QUIETING-DEMOTE-SYSTEM. Same discipline as getLvcRules:
// 5-min cache + 2s-timeout race. FAIL-SAFE IS LOAD-BEARING (PRD §4): any error ⇒ { rules: [], gen: 0 }
// — the audit scores UN-quieted with gen 0 and a logged warning; quieting config can never block,
// fail, or over-quiet an audit.
export interface QuietingConfig { rules: Suppression[]; gen: number }
let _quietCache: { at: number; cfg: QuietingConfig } | null = null;
async function getQuietingConfig(): Promise<QuietingConfig> {
  const now = Date.now();
  if (_quietCache && now - _quietCache.at < 300_000) return _quietCache.cfg;
  try {
    const cfg = await Promise.race([
      loadQuietingConfig(),
      new Promise<QuietingConfig>((_, rej) => setTimeout(() => rej(new Error('quieting config timeout')), 2000)),
    ]);
    _quietCache = { at: now, cfg };
    return cfg;
  } catch (e) {
    console.warn('[opd-audit] quieting config unavailable — scoring un-quieted at gen 0', (e as Error).message);
    return _quietCache?.cfg ?? { rules: [], gen: 0 };
  }
}

// B4 — the treating clinician's real specialty (doctor_directory), so a specialist's note is judged
// against that specialty's standards, not GP defaults. Small table → cache the whole map (60s TTL).
const _dirRun = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
let _specCache: { at: number; map: Record<string, string> } | null = null;
async function doctorSpecialtyFor(doctorUid: string | null): Promise<string | null> {
  if (!doctorUid) return null;
  const now = Date.now();
  if (!_specCache || now - _specCache.at >= 60_000) {
    try {
      const rows = await _dirRun(`SELECT doctor_uid, speciality FROM doctor_directory WHERE speciality IS NOT NULL`, []);
      const map: Record<string, string> = {};
      for (const r of rows) map[String(r.doctor_uid)] = String(r.speciality);
      _specCache = { at: now, map };
    } catch { if (!_specCache) return null; }
  }
  return _specCache.map[doctorUid] || null;
}

// 0.81.4 (decision 14): the LVC keyword matcher needs the active lvc_recommendations (id, keywords,
// category) at stamp time. The LLM prompt doesn't load them, so this is the ONE audit-path read the
// PRD §7b authorises — cached (5m) + 2s-timeout fail-safe; no rules → stamp rule_ref:null, never block.
let _lvcRulesCache: { at: number; rules: LvcRuleLite[] } | null = null;
function parseKeywords(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string') {
    try { const j = JSON.parse(v); if (Array.isArray(j)) return j.map((x) => String(x)); } catch { /* not json */ }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
async function getLvcRules(): Promise<LvcRuleLite[]> {
  const now = Date.now();
  if (_lvcRulesCache && now - _lvcRulesCache.at < 300_000) return _lvcRulesCache.rules;
  try {
    const rows = await Promise.race([
      _dirRun(`SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'`, []),
      new Promise<Record<string, unknown>[]>((_, rej) => setTimeout(() => rej(new Error('lvc rules timeout')), 2000)),
    ]);
    const rules: LvcRuleLite[] = (rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), keywords: parseKeywords(r.keywords), category: r.category == null ? null : String(r.category),
    }));
    _lvcRulesCache = { at: now, rules };
    return rules;
  } catch { return _lvcRulesCache?.rules ?? []; }
}

// Formulary match types reliable enough to drive a deterministic safety alert (an approximate
// brand-prefix match can drop a molecule from a combination, so it informs display only).
const CONFIDENT_MATCH = new Set(['source-generic', 'brand-exact', 'embedded-generic', 'brand-token']);

// ── Unit A — dose-aware aspirin class (DETERMINISM-TRIO PRD v1.0 §2, engine 0.81.21) ─────────────
const DOSE_LIMITS_TABLE = DOSE_LIMITS_JSON as unknown as DoseLimitsTable;
/** The molecule tokens that make a med line an aspirin line (the same two `NSAID_MOLECULES` carries). */
const ASPIRIN_MOLECULES = ['aspirin', 'acetylsalicylic'];
/**
 * D-1 — the antiplatelet cutoff: TOTAL DAILY DOSE ≤ 100 mg is antiplatelet therapy, not analgesia.
 * ACCEPTED CONSEQUENCE, stated to V in the PRD: aspirin 150 mg OD — a common Indian antiplatelet
 * dose — sits ABOVE this cutoff and stays NSAID-classed.
 */
export const ASPIRIN_ANTIPLATELET_MAX_MG = 100;

/**
 * The MAXIMUM possible daily aspirin mg as prescribed, summed across every aspirin-carrying line:
 * `perUnitMg × units × (scheduled + sosCap)` (D-1a — 75 mg OD compares as 75; 650 mg SOS up to
 * 3/day compares as 1950, which is analgesic intent).
 *
 * ONE DOSE MACHINERY, REUSED (PRD kickoff: "writing a second dose parser is forbidden"): every
 * number below comes from lib/dose-aggregation-core.ts — moleculesOf (composition → molecule +
 * per-unit mg), unitsPerDose (the `dose` field, "1 tablet"), parseFrequency (grid · OD/BD/TDS ·
 * SOS as a CEILING), isVolumetric (liquids by concentration, outside the tablet model), bound to
 * the same data/dose-limits.json the aggregation findings use.
 *
 * Returns NULL — and D-2 then treats the med as antiplatelet-only — when any CONTRIBUTING line is
 * volumetric, has an unparseable frequency, or has no parseable per-unit mg. ABSENCE OF DATA NEVER
 * ACCUSES; `incomplete_dosing` flags the missing field independently. Null is also the answer when
 * there is no aspirin on the script at all (no dose to compare), which no caller can misread: the
 * value is consulted only for a line that carries aspirin.
 */
export function aspirinMaxDailyMg(meds: OpdMed[]): number | null {
  const limits = DOSE_LIMITS_TABLE.limits;
  let total = 0;
  let sawAspirin = false;
  for (const m of meds) {
    const contributing = moleculesOf(m, limits).filter((mm) => ASPIRIN_MOLECULES.some((a) => mm.molecule.includes(a)));
    if (!contributing.length) continue;
    sawAspirin = true;
    if (isVolumetric(m)) return null;
    const fp = parseFrequency(m.frequency, DOSE_LIMITS_TABLE.default_sos_cap_per_day);
    if (fp.unknown) return null;
    const units = unitsPerDose(m.dose);
    for (const mm of contributing) {
      if (mm.perUnitMg == null) return null;
      total += mm.perUnitMg * units * (fp.scheduled + fp.sosCap);
    }
  }
  return sawAspirin ? total : null;
}

/** D-1/D-2 — is the aspirin on this script antiplatelet-only (no NSAID promotion, no `nsaid` tag)? */
function aspirinIsAntiplateletOnly(meds: OpdMed[]): boolean {
  const mg = aspirinMaxDailyMg(meds);
  return mg == null || mg <= ASPIRIN_ANTIPLATELET_MAX_MG;
}
/** The NSAID molecules that are NOT aspirin — a combination line carrying one of them is an NSAID
 *  line whatever its aspirin dose, so it is never de-classed (the PRD's subject is aspirin alone). */
const NON_ASPIRIN_NSAID_MOLECULES = NSAID_MOLECULES.filter((n) => !ASPIRIN_MOLECULES.includes(n));

function ddiToFinding(p: DdiPair, topical?: Set<string>): OpdFinding {
  const sev = p.severity;
  // BUG-0.8-12 route-awareness: a TOPICAL NSAID has low systemic absorption, so an "additive
  // systemic toxicity" overlap with an oral drug is materially milder — never escalate it.
  const involvesTopical = !!topical && (topical.has(p.drug_a.toLowerCase()) || topical.has(p.drug_b.toLowerCase()));
  const verdict: NetValue = involvesTopical
    ? 'context-dependent'
    : (sev === 'contraindicated' || sev === 'major' ? 'low-value' : 'context-dependent');
  const confidence = involvesTopical ? 0.5
    : (sev === 'contraindicated' ? 0.9 : sev === 'major' ? 0.8 : sev === 'moderate' ? 0.6 : 0.4);
  const topicalNote = involvesTopical ? ' A topically-applied NSAID has low systemic absorption, so the additive systemic (GI/renal) risk is minimal.' : '';
  // Deterministic-Citations (§7 / V3): the MECHANISM is corpus-verified where the rule is a
  // Stage-1-verified class rule; severity is never cited. A mechanism not in the map (curated pair)
  // is marked internally-derived. Additive metadata — never enters scoring.
  const cite = DDI_MECHANISM_CITATIONS[p.mechanism];
  const provenance: FindingProvenance = cite ? { citation: cite, derivation: 'external' } : { citation: null, derivation: 'llm' };
  return {
    subject: `Interaction (${sev}): ${p.drug_a} + ${p.drug_b}`,
    verdict, confidence, domain: 'prescribing_safety',
    rationale: `${p.mechanism} ${p.recommendation}${topicalNote}`.trim(),
    evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
    provenance,
  };
}

/** Formulary-scoped, deterministic DDIs over the CONFIDENTLY-resolved drugs on the script. */
export function ddiFindings(meds: OpdMed[]): OpdFinding[] {
  // BUG-0.8-10 (Q): include a med if it is confidently formulary-matched OR it carries an NSAID
  // ingredient anywhere in its composition (formulary-independent) — so a combination/topical whose
  // parsed primary is a non-NSAID (e.g. Methyl Salicylate) still counts as an NSAID for the overlap.
  // Unit A (PRD §2.2 steps 1–2, D-1/D-2): the aspirin on this script is classed ONCE, from the
  // whole meds[] (a molecule's daily total is a property of the prescription, not of one line), so
  // the class cannot depend on which aspirin line is being mapped. Antiplatelet-only ⇒ the med is
  // NOT promoted to major 'NSAID' — its real formulary class passes through — and it carries
  // suppressNsaid, which tagInteractions honours by dropping the `nsaid` tag after tagsFor.
  const antiplateletAspirin = aspirinIsAntiplateletOnly(meds);
  const items: DrugClass[] = meds
    .filter((m) => (m.resolvedGeneric && m.formularyMatch && CONFIDENT_MATCH.has(m.formularyMatch)) || medHasMoleculeFrom(m, NSAID_MOLECULES))
    .map((m) => {
      const antiplateletOnly = antiplateletAspirin
        && medHasMoleculeFrom(m, ASPIRIN_MOLECULES)
        && !medHasMoleculeFrom(m, NON_ASPIRIN_NSAID_MOLECULES);
      return {
        name: m.resolvedGeneric || m.generic || m.brand || 'medication',
        major: (!antiplateletOnly && medHasMoleculeFrom(m, NSAID_MOLECULES)) ? 'NSAID' : (m.therapeuticClass || ''),
        minor: m.subClass || '',
        ...(antiplateletOnly ? { suppressNsaid: true } : {}),
      };
    });
  if (items.length < 2) return [];
  // route-aware: molecules applied topically on THIS script (low systemic absorption).
  //
  // ⚠️ TWO SOURCES, BECAUSE ONE OF THEM HAS A BLIND SPOT (DDI-TOPICAL-ROUTE-LEAK PRD, V ruled
  // DEC-1/DEC-3, 2 Aug 2026). resolveMedRoute returns m.route when the EMR set it, and otherwise
  // INFERS the route by running ROUTE_RULES over the drug NAME, dose and INSTRUCTION — so it needs
  // a dosage-form word (cream · ointment · gel · lotion · topical · patch · transderm · ung · apply
  // · local) to appear in that text. `Diclofenac + Linseed Oil + Menthol + Methyl Salicylate`
  // contains none of them, so its route resolved to NULL, it never entered this set, and Ruling 1
  // below never fired on it. The suppression only worked when a clinician's instruction happened to
  // carry a matching word, which is why the leak was partial rather than total.
  //
  // m.dosageForm does NOT have that blind spot: it is set at lib/formulary.ts:139 from the
  // FORMULARY ROW's own `form` column via normalizeDosageForm — never parsed from clinician text.
  //
  // MEASURED COST OF THE BLIND SPOT: 62 findings leaked AFTER the suppression shipped at 0.81.14 —
  // 17 at 0.81.14, 6 at 0.81.15, 1 at 0.81.16, 28 at 0.81.17, 10 at 0.81.18. Ten clinician reviews
  // of oral-NSAID-plus-topical-gel returned ZERO true positives; on one occasion the engine's own
  // rationale said the systemic risk was minimal and it fired anyway.
  //
  // ONLY 'topical' is added. Not drops, not inhaler, not injection: no evidence supports them and
  // each carries its own systemic argument (DEC-4 keeps this narrow).
  const topical = new Set(
    meds.filter((m) => (resolveMedRoute(m) === 'topical' || m.dosageForm === 'topical') && (m.resolvedGeneric || m.generic))
        .map((m) => (m.resolvedGeneric || m.generic as string).toLowerCase()));
  // Ruling 1 (0.81.14, CLINICAL-RULINGS §2.1): an NSAID–NSAID additive-toxicity overlap where ANY
  // member resolves to a topical route is routine practice (topical diclofenac ~6% oral systemic
  // bioavailability; we capture neither quantity nor BSA, so the at-risk group is unidentifiable) —
  // SUPPRESS ENTIRELY (was de-escalated to context-dependent, BUG-0.8-12). Restricted to NSAID–NSAID:
  // a topical NSAID + an oral non-NSAID (e.g. an anticoagulant) is a real interaction and still fires.
  const nsaidNames = new Set(items.filter((i) => i.major === 'NSAID').map((i) => i.name.toLowerCase()));
  const pairs = mergeRank([...tagInteractions(items), ...curatedInteractions(items.map((i) => i.name))]);
  return pairs
    .filter((p) => {
      const involvesTopical = topical.has(p.drug_a.toLowerCase()) || topical.has(p.drug_b.toLowerCase());
      const bothNsaid = nsaidNames.has(p.drug_a.toLowerCase()) && nsaidNames.has(p.drug_b.toLowerCase());
      return !(involvesTopical && bothNsaid);
    })
    .map((p) => ddiToFinding(p, topical));
}

/** BUG-0.8-11 (R): the muscle-relaxant-FDC appropriateness objection was LLM-generated, so its
 *  presence and tier swung run-to-run on identical scripts. Determinise it into a fixed-tier
 *  (context-dependent) advisory; the prompt tells the LLM not to raise its own volatile version,
 *  and consolidateDecisions drops any LLM muscle-relaxant finding that slips through. */
export function muscleRelaxantFindings(meds: OpdMed[], ctx?: { mskDocumented?: boolean }): OpdFinding[] {
  // Ruling 4 (0.81.14, CLINICAL-RULINGS §2.3): a muscle relaxant WITH documented musculoskeletal
  // context is a legitimate prescription — fire only when NONE is documented. MEASURED: 598/658
  // (90.9%) already document it. ctx is OPTIONAL; omitting it reproduces prior behaviour exactly
  // (undefined !== true → fires). Same ctx-threading pattern as isGout (0.81.13).
  if (ctx?.mskDocumented === true) return [];
  const mr = meds.filter((m) => medHasMoleculeFrom(m, MUSCLE_RELAXANT_MOLECULES));
  if (!mr.length) return [];
  const names = Array.from(new Set(mr.map((m) => m.resolvedGeneric || m.generic || m.brand || 'muscle relaxant')));
  return [{
    subject: 'Muscle relaxant prescribed — document the indication',
    verdict: 'context-dependent', confidence: 0.5, domain: 'appropriateness',
    rationale: `A muscle relaxant (${names.join(', ')}) has limited evidence as first-line therapy for most musculoskeletal pain / tendinopathy; it is reasonable when muscle spasm is documented. Fixed-tier deterministic finding (replaces the run-to-run-inconsistent LLM objection).`,
    evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
    // 0.81.10 (SIGNAL-TYPE-COLLAPSE S1): this is a documentation-completeness PROMPT, not a
    // care-quality judgement. Surfaced but NON-SCORING (informational) — it must not penalise the
    // note-quality index — and classified deterministic_completeness (signal_type muscle_relaxant_indication).
    informational: true,
  }];
}

// ── 0.81.8 bug 1 — unindicated XANTHINE bronchodilator for an ACUTE URTI ──────────────────────────────
// Deterministic appropriateness backstop, context-GUARDED: fires only for a clear acute upper-respiratory
// presentation and NEVER for a chronic-airways patient (J40–J47 / asthma / COPD), where a xanthine is
// legitimate maintenance. A miss the LLM made inconsistently → determinised (↓appropriateness).
// 0.81.13 (PRD CDMSS-PHARMACY-ROUND1): the antihistamine+montelukast leg was RETIRED (Decision 11 — it
// fired on allergic-rhinitis maintenance, standard care) and the xanthine subject/rationale relabelled
// (Decision 3 — the "mucolytic" claim misdescribed the trigger list, which is xanthines only).
// 0.81.14 (Ruling 12, CLINICAL-RULINGS §2.4): 'acebrophylline' REMOVED — it reads as a secretolytic/
// mucokinetic (covered by the round-1 mucolytic endorsement), and 100% of this rule's output was
// Acebrophylline + Acetylcysteine. The rule becomes DORMANT, not dead: the true xanthine bronchodilators
// remain and would fire if genuinely prescribed for an acute URTI. ACUTE_URTI_RE is unchanged.
const XANTHINE_MOLECULES = ['theophylline', 'doxophylline', 'doxofylline', 'bamifylline', 'etofylline', 'aminophylline', 'choline theophyllinate', 'deriphyllin'];
// ANTIHISTAMINE_MOLECULES was deleted with the montelukast rule (PRD CDMSS-PHARMACY-ROUND1 Decision 11
// — RETIRED entirely; it fired on allergic-rhinitis maintenance, standard care). No live reference remains.
const ACUTE_URTI_RE = /\b(urti|upper respiratory|common cold|coryza|nasopharyngitis|rhinitis|rhinorrho?ea|running nose|sore throat|throat pain|pharyngitis|tonsillitis|viral fever|viral (?:uri|illness)|cough and cold|acute (?:cough|cold))\b/i;
const ACUTE_URTI_ICD = /^J0[0-6]|^J1[01]/i;
const CHRONIC_RESP_RE = /\b(asthma|copd|chronic obstructive|chronic bronchitis|emphysema|bronchiectasis|interstitial lung|reactive airway|\bild\b)\b/i;
const CHRONIC_RESP_ICD = /^J4[0-7]/i;
const uniq = (a: string[]): string[] => Array.from(new Set(a));

function detAppr(subject: string, confidence: number, rationale: string): OpdFinding {
  return { subject, verdict: 'low-value', confidence, domain: 'appropriateness', rationale, evidence: [], estimates: [], citation_ids: [], source: 'deterministic' };
}

export function unindicatedRespFindings(oc: DeidOpdCase): OpdFinding[] {
  const hay = [oc.reasonForConsult || '', ...oc.presentingComplaints, ...oc.impressions, ...oc.history].join(' ');
  const codes = [...oc.diagnosisCodes, ...oc.impressionCodes].map((c) => c.trim());
  const isAcuteUrti = ACUTE_URTI_RE.test(hay) || codes.some((c) => ACUTE_URTI_ICD.test(c));
  const isChronicResp = CHRONIC_RESP_RE.test(hay) || codes.some((c) => CHRONIC_RESP_ICD.test(c));
  if (!isAcuteUrti || isChronicResp) return [];                          // context guard (Decision 4)
  const out: OpdFinding[] = [];
  const xanthines = oc.medications.filter((m) => medHasMoleculeFrom(m, XANTHINE_MOLECULES));
  if (xanthines.length) {
    const names = uniq(xanthines.map((m) => m.resolvedGeneric || m.generic || m.brand || 'xanthine bronchodilator'));
    out.push(detAppr(`Xanthine bronchodilator not indicated for an acute URTI: ${names.join(', ')}`, 0.6,
      `A xanthine bronchodilator (${names.join(', ')}) has no established role in an uncomplicated acute upper-respiratory infection (a self-limiting viral illness) — reserve it for obstructive airways disease. Deterministic appropriateness backstop; a chronic-airways context (asthma/COPD, J40–J47) is excluded.`));
  }
  // Decision 11 — the antihistamine+montelukast leg is RETIRED (not thresholded): it fired on
  // allergic-rhinitis maintenance (standard care), and ACUTE_URTI_RE captures `rhinitis`. The LLM leg
  // covers antihistamine_allergy (~150/wk). No finding is emitted for that combination at any duration.
  return out;
}

// ── 0.81.8 bug 3 — topical nasal decongestant used too long (rhinitis medicamentosa) ──────────────────
// Ingredient-level (catches FDCs / brand-only lines via the resolved composition); duration parsed from
// the med line by the shared parseDurationDays. 0.81.13 (Decision 4, Khatija Q14): two tiers — >15 days
// (higher severity: septal thinning / dependence) and >7 && <=15 days (rebound congestion); <=7 days or
// an unparseable duration emits NOTHING (was >5). The prior "3–5 day cap" wording is superseded here.
const NASAL_DECONGESTANT_MOLECULES = ['oxymetazoline', 'xylometazoline', 'naphazoline', 'xylometazolin', 'oxymetazolin'];
// parseDurationDays is the single shared parser (defined in the pure dose core, PRD §3.1); re-exported
// here so its existing export surface and importers are preserved.
export { parseDurationDays };
export function decongestantDurationFindings(meds: OpdMed[]): OpdFinding[] {
  const out: OpdFinding[] = [];
  for (const m of meds) {
    if (!medHasMoleculeFrom(m, NASAL_DECONGESTANT_MOLECULES)) continue;
    const days = parseDurationDays(m.duration);
    if (days === null || days <= 7) continue;                        // Decision 4: <=7 days or unparseable → no finding
    const name = m.resolvedGeneric || m.generic || m.brand || 'topical nasal decongestant';
    const highSeverity = days > 15;
    out.push({
      subject: `Topical nasal decongestant prescribed for ${days} days: ${name}`,
      verdict: 'low-value', confidence: highSeverity ? 0.85 : 0.7, domain: 'prescribing_safety',
      rationale: highSeverity
        ? `An imidazoline nasal decongestant (${name}) used for ${days} days — beyond 15 days risks nasal septal thinning and dependence. Ingredient-level deterministic check.`
        : `An imidazoline nasal decongestant (${name}) used for ${days} days exceeds the 7-day cap — prolonged use causes rebound congestion (rhinitis medicamentosa). Ingredient-level deterministic check.`,
      evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
    });
  }
  return out;
}

// ── 0.81.14 Ruling 13 (CLINICAL-RULINGS §2.5) — Vitamin D weekly-repletion duration ───────────────────
// INFORMATIONAL prompt (non-scoring) when weekly 60,000 IU runs beyond 8 weeks — the standard repletion
// course. NOT a dose ceiling (0 of 1,199 60k prescriptions were on a daily grid) and NOT a frequency
// rule. Fires ONLY when composition is vitamin D3/cholecalciferol AND strength is 60,000/60k AND weekly
// is stated AND parseDurationDays(duration) > 56 (8 weeks). LOAD-BEARING FAIL-SAFE: an unparseable
// duration emits NOTHING — several clinicians write the correct extended protocol as free text
// ("8 weeks followed by once a month for 4 months") which does not parse; they stay silent by design.
// Do NOT extend parseDurationDays to capture them.
// ═══ Citation support check (phase 3b, register bug 9a) ════════════════════════════════════════
//
// A HIGH-VALUE finding praised cholecalciferol after cranioplasty citing Rae et al.'s wound-healing
// protocol — whose components are vitamin A, ascorbic acid and zinc, and which names NO vitamin D.
// The excerpt said "vitamin and mineral supplementation"; the model saw cholecalciferol on the
// prescription and concluded the study endorsed it. The card then rendered it as grounded.
//
// ⚠️ GENERATION TIME, NOT POST-HOC. MEASURED: the model reads 700 chars per excerpt
// (buildCitedContext perChunkChars) but only 600 are stored (hitsToSources .slice(0, 600)). A check
// against the stored preview would strip citations whose supporting sentence sits in chars 601–700
// — text the model legitimately read. Stripping a GOOD citation is worse than leaving a bad one,
// because it makes an honest finding look ungrounded. So this runs where the full h.text is live.
//
// DISPLAY AND PROVENANCE ONLY. It cannot move a score: findingPenalty is a function of verdict,
// confidence and direction. A stripped finding falls to `no_source` through the EXISTING
// groundingKind, which is not touched.

/** Molecule vocabulary a finding may name, with the alternates a cited excerpt might use instead. */
const MOLECULE_ALIASES: { re: RegExp; alts: RegExp }[] = [
  { re: /cholecalciferol|vitamin ?d3?\b|calciferol/i, alts: /cholecalciferol|vitamin ?d3?\b|calciferol|25[- ]?\(?oh\)?[- ]?d/i },
  { re: /\bvitamin ?c\b|ascorbic acid/i, alts: /\bvitamin ?c\b|ascorbic acid/i },
  { re: /\bvitamin ?a\b|retinol/i, alts: /\bvitamin ?a\b|retinol/i },
  { re: /\bzinc\b/i, alts: /\bzinc\b/i },
  { re: /methylcobalamin|vitamin ?b ?12|cyanocobalamin/i, alts: /methylcobalamin|vitamin ?b ?12|cyanocobalamin|cobalamin/i },
];

/**
 * Strip citations that no cited excerpt supports. PURE.
 *
 * CONSERVATIVE BY CONSTRUCTION — it does nothing unless it is sure:
 *   · no hits (the reuse path) ⇒ untouched;
 *   · finding names no molecule this vocabulary knows ⇒ untouched;
 *   · a cited excerpt has no text ⇒ untouched (never strip on missing data);
 *   · any cited excerpt naming the molecule, its generic, or its class ⇒ untouched.
 * Only when EVERY cited excerpt is readable and NONE names the molecule are citation_ids cleared
 * and the affected points moved from `evidence` to `estimates`.
 */
export function stripUnsupportedCitations(
  findings: OpdFinding[],
  hits: { id: number; text?: string | null }[],
  medHay = '',
): OpdFinding[] {
  if (!Array.isArray(hits) || hits.length === 0) return findings;   // reuse path / no retrieval
  const byId = new Map(hits.map((h) => [Number(h.id), String(h.text ?? '')]));
  return findings.map((f) => {
    if (f.source !== 'llm') return f;
    const ids = Array.isArray(f.citation_ids) ? f.citation_ids : [];
    if (ids.length === 0) return f;
    const hay = `${f.subject} ${f.rationale || ''} ${(f.evidence || []).join(' ')}`;
    const molecule = MOLECULE_ALIASES.find((m) => m.re.test(hay));
    if (!molecule) return f;                                        // molecule undeterminable ⇒ do nothing
    const texts = ids.map((id) => byId.get(Number(id)));
    if (texts.some((t) => t == null || t === '')) return f;          // missing excerpt text ⇒ do nothing
    // Class-level support counts too: an excerpt naming the drug's own class supports it.
    if (texts.some((t) => molecule.alts.test(String(t)))) return f;
    if (medHay && molecule.alts.test(medHay) && texts.some((t) => molecule.alts.test(String(t)))) return f;
    return {
      ...f,
      citation_ids: [],
      evidence: [],
      estimates: [...(f.estimates || []), ...(f.evidence || [])],
    };
  });
}

const VITAMIN_D_RE = /(vitamin ?d3?|cholecalciferol|calciferol)/i;
/**
 * Ruling 13 (informational retest prompt) + phase 3b (the ratified dose matrix).
 *
 * `band` is the note's 25(OH)D band when one could be read, else null. FAIL-SAFE THROUGHOUT, and
 * deliberately so: a null band, an unparseable duration, or a (band, regimen) pair the matrix does
 * not hold ALL emit nothing. Silence is the designed default — the matrix ships with exactly two
 * ratified rows, both "concordant, emit no finding", so this rule NEVER produces a scoring
 * discordance finding. What it does produce is the Ruling 13 retest prompt, informational and
 * non-scoring, and its presence is what lets phase-2 arm 7 take the vitamin-D dose topic away from
 * the LLM (bug 8: 1,450 scoring LLM vitamin-D findings, only 101 of which stated their threshold).
 */
export function vitaminDRepletionFindings(meds: OpdMed[], band: VitaminDBand | null = null): OpdFinding[] {
  const out: OpdFinding[] = [];
  for (const m of meds) {
    const comp = `${m.resolvedGeneric || ''} ${m.generic || ''} ${m.brand || ''}`;
    if (!VITAMIN_D_RE.test(comp)) continue;                                            // (1) vitamin D composition
    const strengthHay = `${m.strength || ''} ${m.dose || ''} ${comp}`;
    if (!/60[ ,]?000|60k/i.test(strengthHay)) continue;                                // (2) 60,000 IU strength
    if (!/week/i.test(`${m.frequency || ''} ${m.instruction || ''}`)) continue;        // (3) weekly dosing stated
    const days = parseDurationDays(m.duration);
    if (days === null) continue;                                                       // unparseable → silent, always
    const weeks = Math.round(days / 7);

    if (days > 56) {                                                                   // (4a) > 8 weeks — Ruling 13, unchanged
      out.push({
        subject: `Vitamin D 60,000 IU weekly prescribed for ${weeks} weeks — document retest of levels`,
        verdict: 'uncertain', confidence: 0, domain: 'prescribing_safety',
        rationale: `Weekly 60,000 IU for 8 weeks is standard repletion once low levels are established, followed by a retest. This course runs ${weeks} weeks. Confirm levels were rechecked or that extended/maintenance dosing is intended. Informational — non-scoring.`,
        evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
        informational: true,
      });
      continue;
    }

    // (4b) phase 3b — the RATIFIED 8-week course. The matrix verdict is "concordant, emit no
    // finding", so no scoring finding is produced either way; what fires is the SAME Ruling 13
    // retest prompt, now extended to the `insufficient` band as well as `deficient` per Dr Zaki's
    // 29 Jul ratification ("the test should be repeated after 8 weeks"). A documentation-
    // completeness prompt, not a concordance verdict — only the latter would belong in the score.
    const regimen = { iu: 60000, weekly: true, weeks };
    if (vitaminDConcordance(band, regimen) !== 'concordant') continue;                 // no ratified row → silent
    out.push({
      subject: `Vitamin D 60,000 IU weekly for ${weeks} weeks — document retest of levels`,
      verdict: 'uncertain', confidence: 0, domain: 'prescribing_safety',
      rationale: `Weekly 60,000 IU for ${weeks} weeks is the ratified repletion course for a ${band} 25(OH)D level (${VITAMIN_D_STANDARD} bands: deficient below ${VITAMIN_D_DEFICIENT_BELOW} ${VITAMIN_D_UNITS}, insufficient below ${VITAMIN_D_SUFFICIENT_AT_OR_ABOVE}). The regimen is concordant; confirm the level is retested after the course. Informational — non-scoring.`,
      evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
      informational: true,
    });
  }
  return out;
}

// ── 0.81.14 Rulings 5–8 (CLINICAL-RULINGS §2.7) — Possible-pregnancy verification advisory ────────────
// The system's first pregnancy-safety capability (register A-9). INFORMATIONAL (non-scoring), framed as
// VERIFY — never as an assertion that a pregnant patient was harmed. Fires when the LMP interval is in
// [36, 90] days AND a trigger molecule is present. NSAIDs are deliberately EXCLUDED (third-trimester-
// specific risk; a recorded LMP cannot establish trimester). No age gate. FAIL-SAFE: no LMP / unparseable
// LMP / interval outside 36–90 → nothing (absence of data must never accuse). ctx (the pre-computed LMP
// interval) is OPTIONAL and threaded from the orchestrator — same pattern as isGout / mskDocumented.
const PREGNANCY_CONTRA_MOLECULES = ['isotretinoin', 'acitretin', 'tretinoin', 'methotrexate', 'misoprostol', 'warfarin', 'valproate', 'divalproex'];
const PREGNANCY_CAUTION_MOLECULES = ['doxycycline', 'minocycline', 'tetracycline', 'ofloxacin', 'levofloxacin', 'ciprofloxacin', 'norfloxacin', 'moxifloxacin', 'enalapril', 'ramipril', 'lisinopril', 'telmisartan', 'losartan', 'olmesartan', 'valsartan', 'fluconazole'];
/** Days between an LMP string and the visit date; null when either is absent/unparseable (fail-safe → no
 *  finding). Parses ISO-like dates only; an unrecognised format degrades to silence, never a wrong flag. */
export function lmpIntervalDays(lmp: string | null | undefined, visitDate: string | null | undefined): number | null {
  if (!lmp || !visitDate) return null;
  const l = new Date(lmp), v = new Date(visitDate);
  if (isNaN(l.getTime()) || isNaN(v.getTime())) return null;
  const days = Math.floor((v.getTime() - l.getTime()) / 86_400_000);
  return isFinite(days) ? days : null;
}
export function pregnancyRiskFindings(meds: OpdMed[], ctx?: { lmpIntervalDays?: number | null }): OpdFinding[] {
  const interval = ctx?.lmpIntervalDays;
  if (interval == null || interval < 36 || interval > 90) return [];                   // possible-pregnancy window only
  const out: OpdFinding[] = [];
  for (const m of meds) {
    const contra = PREGNANCY_CONTRA_MOLECULES.find((n) => medHasMoleculeFrom(m, [n]));
    const caution = contra ? null : PREGNANCY_CAUTION_MOLECULES.find((n) => medHasMoleculeFrom(m, [n]));
    if (!contra && !caution) continue;
    const drug = m.resolvedGeneric || m.generic || m.brand || (contra || caution)!;
    const phrase = contra ? 'contraindicated in' : 'used with caution in';
    out.push({
      subject: `Possible pregnancy — verify status before ${drug}`,
      verdict: 'uncertain', confidence: 0, domain: 'prescribing_safety',
      rationale: `LMP was ${interval} days before this visit, so pregnancy cannot be excluded. ${drug} is ${phrase} pregnancy. Confirm pregnancy status was established before prescribing. Informational — non-scoring.`,
      evidence: [], estimates: [], citation_ids: [], source: 'deterministic',
      informational: true,
    });
  }
  return out;
}

// ── 0.81.14 Ruling 4 (CLINICAL-RULINGS §2.3) — musculoskeletal-context predicate (for muscle relaxant) ─
// Computed in the orchestrator over the SAME haystack unindicatedRespFindings builds; an M-code (any
// musculoskeletal ICD) also counts. Exported for testability.
const MSK_CONTEXT_RE = /\b(back pain|neck pain|spasm|myalgia|muscle|sprain|strain|lumbar|cervical|spondyl|sciatic|shoulder|knee pain|joint pain|stiff|musculoskeletal|body ?ache)\b/i;
export function mskContextDocumented(oc: DeidOpdCase): boolean {
  const hay = [oc.reasonForConsult || '', ...oc.presentingComplaints, ...oc.impressions, ...oc.history].join(' ');
  const codes = [...oc.diagnosisCodes, ...oc.impressionCodes].map((c) => c.trim());
  return MSK_CONTEXT_RE.test(hay) || codes.some((c) => /^M/i.test(c));
}

// ── 0.81.8 bug 8 — route/formulation-aware duplication ───────────────────────────────────────────────
// Two products sharing a molecule are NOT a therapeutic duplicate when they are applied differently: a
// wash-off cleanser + a leave-on gel (e.g. benzoyl peroxide face wash + gel), or a topical + a systemic
// form. Drop the deterministic duplicate finding in those cases (the co-prescription is intentional).
const WASHOFF_RE = /\b(face\s?wash|cleanser|cleansing bar|shampoo|\bsoap\b|body wash|\bwash\b)\b/i;
const LEAVEON_RE = /\b(cream|ointment|\bgel\b|lotion|serum|emollient|paste|patch|\bung\b)\b/i;
function applicationForm(m: OpdMed): 'washoff' | 'leaveon' | null {
  const hay = `${m.brand || ''} ${m.generic || ''} ${m.instruction || ''} ${m.dose || ''}`;
  if (WASHOFF_RE.test(hay)) return 'washoff';
  if (LEAVEON_RE.test(hay)) return 'leaveon';
  return null;
}
export function dedupeRouteAware(findings: OpdFinding[], meds: OpdMed[]): OpdFinding[] {
  const molOf = (m: OpdMed) => (m.resolvedGeneric || m.generic || '').toLowerCase();
  return findings.filter((f) => {
    if (f.source !== 'deterministic') return true;
    let mol: string | null = null;
    if (/^duplicate prescription:/i.test(f.subject)) mol = f.subject.replace(/^duplicate prescription:\s*/i, '').trim().toLowerCase();
    else if (/^same molecule in \d+ products?/i.test(f.subject)) { const c = f.subject.lastIndexOf(':'); mol = c >= 0 ? f.subject.slice(c + 1).trim().toLowerCase() : null; }
    if (!mol) return true;
    const sharing = meds.filter((m) => { const g = molOf(m); if (!g) return false; return g === mol || g.split(/[+/,]/).map((t) => t.trim()).includes(mol); });
    if (sharing.length < 2) return true;                                  // can't resolve the products → keep the finding
    const routes = new Set(sharing.map((m) => resolveMedRoute(m) || 'unknown'));
    if (routes.has('topical') && (routes.has('oral') || routes.has('parenteral'))) return false;   // topical + systemic → intentional
    const forms = new Set(sharing.map(applicationForm).filter(Boolean));
    if (forms.has('washoff') && forms.has('leaveon')) return false;       // wash-off + leave-on → not a duplicate
    return true;
  });
}

export interface OpdNoteAudit {
  keys: OpdKeys;
  scorecard: OpdScorecard;
  completeness: OpdCompleteness;
  findings: OpdFinding[];
  suggestions: OpdSuggestion[];
  sources: Source[];
  engineVersion: string;
  traceId?: string;
  /** Quieting policy generation this audit was scored under (Q1). 0 = no quieting policy (also the
   *  fail-safe when config is unreachable). Persisted on the audit row (quieting_gen). */
  quietingGen?: number;
  /** S0 invalid-marking (PRD 28 Jul, D1/D2): true when the PRODUCTION LLM leg failed — content
   *  empty or pdqi9 unparseable — after the one bounded retry. The audit still completes and still
   *  persists (fail-soft, D1); the store uses this signal to stamp
   *  `excluded_reason = 'llm_leg_failed'` so a failure to measure is never scored as excellence.
   *  ABSENT on every successful audit and on the whole eval path (which fail-louds instead). */
  llmLegFailed?: boolean;
  // Right Care case-mix complexity (0.81.3). Computed at audit time from db13 history; NULL band on
  // any fetch failure (never blocks the audit). Persisted on the audit row; excluded from O/E when null.
  complexity?: { band: ComplexityBand | null; inputs: ComplexityInputs | null } | null;
  // Stage 3 (opd-longitudinal/0.1) — the de-identified note projection the post-persistence longitudinal
  // pass consumes. NOT persisted by saveOpdAudit (ignored by its fixed column list); attached only when
  // OPD_LONGITUDINAL_ENABLED=1 (or opts.longitudinal for replay) and never for the mini pipeline, so
  // flag-off the returned audit is byte-identical to today.
  longitudinalInput?: LongitudinalNoteInput | null;
}

/**
 * The retrieve() opts for the OPD audit citation retrieval. R-11 Stage 2 (DORMANT): the normative
 * leg is added ONLY when OPD_NORMATIVE_LEG_ENABLED === '1' AND this is not the mini path — otherwise
 * the `useNormativeLeg` key is ABSENT, so the opts are byte-identical to today and no stored
 * note_quality_index can move. The flag is off in every environment until Phase 0/2 clear it.
 * Pure (env injectable) so the flag-off byte-identity is unit-testable without a DB.
 */
export function opdRetrieveOpts(mini: boolean, env: Record<string, string | undefined> = process.env, evalNormativeLeg?: boolean, rerankBackend?: 'judge' | 'cohere'): RetrieveOptions {
  // Lab eval override (Phase 2): evalNormativeLeg forces the leg ON regardless of env/mini. Absent/false
  // ⇒ today's gate exactly (env==='1' && !mini), so with NO eval config the opts are byte-identical.
  const useNormativeLeg = evalNormativeLeg === true || (env.OPD_NORMATIVE_LEG_ENABLED === '1' && !mini);
  // Rerank-flip-prep (31 Jul): an explicit backend is added ONLY when set — the guarded spread keeps
  // the unset shape deep-equal to today's (no `rerankBackend: undefined` key ever reaches retrieve()).
  return {
    topK: 8, useReranker: true, useSourceWeights: true, hybrid: true,
    ...(useNormativeLeg ? { useNormativeLeg: true } : {}),
    ...(rerankBackend ? { rerankBackend } : {}),
  };
}

async function defaultRetrieve(q: string, mini = false, evalNormativeLeg?: boolean, rerankBackend?: 'judge' | 'cohere', capture?: TelemetryCapture): Promise<CiteHit[]> {
  try {
    const r = await retrieve(q, opdRetrieveOpts(mini, process.env, evalNormativeLeg, rerankBackend), capture);
    return r.hits.map((h) => ({
      id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section,
      page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
      chunk_type: h.chunk_type, similarity: h.similarity, text: h.text,
    }));
  } catch (e) {
    console.warn('[opd-audit] retrieve failed', (e as Error).message);
    // ONE OF THE FOUR SITES THAT SWALLOW A RETRIEVAL EXCEPTION INTO AN EMPTY HIT LIST. The audit
    // then proceeds on no evidence and scores a note as if the corpus had nothing to say. That is
    // survivable and deliberate — but it must not be INVISIBLE, and until now it was: a failed
    // retrieval and a retrieval that found nothing produced the same `[]`.
    if (capture) {
      capture.retrievalOutcome = 'retrieval_failure';
      capture.retrievalErrorClass = errorClassOf(e);
    }
    return [];
  }
}

// ── R-11 fix candidate: ADDITIVE normative channel (LAB EVAL ONLY) ────────────────
// Phase 2 proved the normative LEG (union) is harmful on the scoring path: ~4 CW chunks evict the
// literature excerpts the audit substantiates low-value findings with (S1 low-value 67→7, NQI +15).
// The CHANNEL keeps the 8 literature excerpts BYTE-IDENTICAL and appends the CW statements as a
// separate labelled block [9+] the model can cite — additive, never by eviction.

/** Statements the channel appends (kept small; the block adds context, it must not crowd it). */
export const NORMATIVE_CHANNEL_K = 4;

/** The channel's standalone CW-only retrieve opts — the shipped restrictSources shape (source =
 *  ANY(normativeSources), min-sim floor via retrieve's default, LIMIT K). skipExpand: the note query
 *  is already a keyword bundle and the lit retrieve pays the expansion; the CW search is exact +
 *  deterministic (matches the REV-5 measurement rig). Pure — exported for tests. */
export function normativeChannelOpts(env: Record<string, string | undefined> = process.env): RetrieveOptions {
  return {
    topK: NORMATIVE_CHANNEL_K,
    restrictSources: resolveNormativeSources(undefined, env.NORMATIVE_LEG_SOURCES),
    useReranker: false, useSourceWeights: false, hybrid: false, skipExpand: true,
  };
}

/** Standalone normative retrieve for the channel. Fail-safe: any error ⇒ [] (the audit proceeds on
 *  literature alone — the channel can only ADD, never degrade). */
async function normativeChannelRetrieve(q: string, capture?: TelemetryCapture): Promise<CiteHit[]> {
  try {
    const r = await retrieve(q, normativeChannelOpts(), capture);
    return r.hits.map((h) => ({
      id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section,
      page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
      chunk_type: h.chunk_type, similarity: h.similarity, text: h.text,
    }));
  } catch (e) {
    console.warn('[opd-audit] normative channel retrieve failed', (e as Error).message);
    if (capture) {
      capture.retrievalOutcome = 'retrieval_failure';
      capture.retrievalErrorClass = errorClassOf(e);
    }
    return [];
  }
}

/**
 * Read the ACTIVE provider-backfill state for the OPD worker, fail-open (D2).
 *
 * ⚠️ THE FAIL-OPEN WRAP IS REQUIRED, NOT CAUTIOUS. `activeRun` awaits `ensureRunsTable()` first,
 * whose `CREATE TABLE IF NOT EXISTS` has NO `.catch` — unlike its two index statements. A throw
 * from that call would turn an audit that would have completed into one that never ran, which
 * constraint 1 forbids. All three fields are nullable in D17 for exactly this reason.
 *
 * ⚠️ AND IT IS NOT ONE ROUND TRIP. On a cold invocation it issues a CREATE TABLE and two CREATE
 * INDEX before the SELECT — four statements — and one on every later retrieval. Both are measured
 * separately in the overhead numbers rather than described as small.
 *
 * `lib/backfill-runs.ts` is NOT on this build's edit list, so the guard lives here rather than as
 * a `.catch` added to that file.
 */
async function readBackfillActivity(): Promise<{ runId: string | null; target: string | null; state: BackfillActivity | null }> {
  try {
    // 'opd' is required — BackfillWorker is 'opd' | 'ipd', and this is the OPD audit path.
    const run = await activeRun('opd');
    // ⚠️ `target` IS THE RUN'S MODEL. `BackfillRun` has no field called `target`; what a backfill
    // run targets is the `bedrock:<id>` / `vertex:<id>` string it is grading against, and that is
    // the value an overlap analysis needs — "which backfill was running" is answered by the model,
    // not by the day cursor. Named as an inference rather than presented as a schema field.
    return run
      ? { runId: String(run.id), target: run.model ?? null, state: 'active' }
      // ⚠️ `idle` IS A MEASUREMENT, NOT AN ABSENCE. §2 forbids twice reporting a cron tick as a
      // workload; without this value an overlap analysis cannot tell 360 route invocations from
      // 360 backfills, which is the exact error the evidence boundary names.
      : { runId: null, target: null, state: 'idle' };
  } catch {
    return { runId: null, target: null, state: null };
  }
}

/** Write both role terminals in D11's order, publishing the handle after each. Never throws — a
 *  telemetry write must not fail an audit (constraint 1).
 *
 *  Returns the manifest's own validation verdict, which the OWNER needs and cannot compute: D17
 *  makes a persisted row `persisted_partial` when `validateManifest` returned anything, and the
 *  manifest never leaves this function. Until this build `validateManifest` had no production
 *  caller at all, so no row could ever have been classified partial for the reason D17 gives. */
async function writeRetrievalTerminals(args: {
  tele: NonNullable<AuditOpdOpts['telemetry']>;
  handle: LifecycleHandle;
  /** Trailing optional map (v10 requirement 1). Terminal publications pass a SNAPSHOT; see :792. */
  publishHandle: (h: LifecycleHandle, manifestDefectsByRole?: ManifestDefectsByRole) => void;
  traceId: string | null;
  startedAt: string;
  citedContext: string;
  primaryCapture: TelemetryCapture;
  normativeCapture?: TelemetryCapture;
}): Promise<ManifestDefectsByRole> {
  const { tele, publishHandle, traceId, startedAt, citedContext } = args;
  let handle = args.handle;
  // ⚠️ KEYED BY ROLE, NOT MERGED (pass 0b). This was one flat array that both roles pushed into,
  // and `outcomeForOwnedSave` then marked the WHOLE save dirty if it was non-empty — so a
  // normative-channel defect made the primary row `persisted_partial`, and the reverse held. Each
  // role's verdict now stays attached to the role that produced it, and settlement applies each
  // run's own. A role that never ran has no key at all, which is a different statement from a role
  // whose manifest validated clean.
  const defectsByRole: { primary?: readonly string[]; normative_channel?: readonly string[] } = {};
  try {
    const hmacKey = process.env.CDMSS_TELEMETRY_HMAC_KEY ?? null;
    const backfill = await readBackfillActivity();
    const operationalFor = (role: 'primary' | 'normative_channel'): OperationalTelemetry => ({
      route: tele.route, route_class: routeClassOf(tele.route), retrieval_role: role,
      invocation_id: tele.ctx.invocationId, trace_id: traceId,
      deployment_sha: tele.ctx.deploymentSha, started_at: startedAt,
      completed_at: new Date().toISOString(), routing_flags: tele.ctx.routingFlags,
      active_backfill_run_id: backfill.runId, active_backfill_target: backfill.target,
      active_backfill_state: backfill.state,
      active_lab_experiment_id: tele.ctx.labExperimentId ?? null,
    });

    // PRIMARY carries the scorer-context HMAC, computed over the EXACT rendered citedContext bytes.
    // With zero candidates that string is empty, and the HMAC of the empty string is a defined
    // value — never null because reranking was skipped or failed (A2).
    const primaryPayload = buildRetrievalPayload(args.primaryCapture, { hmacKey, scorerContext: citedContext });
    const primaryOperational = operationalFor('primary');
    defectsByRole.primary = validateManifest({ ...primaryPayload, operational: primaryOperational });
    handle = await writeRetrievalTerminal(handle, 'primary', {
      payload: primaryPayload,
      operational: primaryOperational,
      traceId, completedAt: new Date().toISOString(),
    });
    // ⚠️ A SHALLOW SNAPSHOT, NEVER THE LIVE OBJECT (v10 requirement 3). `defectsByRole` is mutated
    // below — the normative verdict lands at :803 — and passing the object itself would let an
    // owner observe a later mutation of something it was told at an earlier moment. What the owner
    // is handed here is what was known here.
    publishHandle(handle, { ...defectsByRole });

    if (args.normativeCapture) {
      // NORMATIVE carries null: the combined-context HMAC lives on the primary row, and duplicating
      // it here would imply this leg produced a context of its own. Its expansion stage is also
      // always `skipped` (normativeChannelOpts sets skipExpand unconditionally), which is why the
      // validator accepts a null served class on a skipped stage — otherwise every one of these
      // rows would be partial by construction.
      const normPayload = buildRetrievalPayload(args.normativeCapture, { hmacKey, scorerContext: null });
      const normOperational = operationalFor('normative_channel');
      defectsByRole.normative_channel = validateManifest({ ...normPayload, operational: normOperational });
      handle = await writeRetrievalTerminal(handle, 'normative_channel', {
        payload: normPayload,
        operational: normOperational,
        traceId, completedAt: new Date().toISOString(),
      });
      publishHandle(handle, { ...defectsByRole });   // snapshot, as above
    }
  } catch (e) {
    console.warn('[opd-audit] retrieval telemetry terminal write failed', (e as Error).message);
  }
  return defectsByRole;
}

/**
 * ⚠️ TEST SEAM — NARROW AND DEFAULT-PRESERVING (addendum v26 §3.6; Saul review 37 finding 2; the shape
 * addendum v11 §8 authorized in principle). `writeRetrievalTerminals` above is module-private and its
 * only caller, `auditOpdNote`, cannot be driven in-process (it needs a note row, retrieval, embeddings,
 * a live LLM leg and the audit store). Proof 47 must EXECUTE the terminal-payload path with real
 * `assembleAuditContext` output, not pin its source. This object hands a test the SAME function —
 * unchanged, unwrapped, the one production calls at step 13. No production caller consults it,
 * nothing on the default path reads it, `auditOpdNote` and every call site are byte-identical to
 * before it existed, and it exists only so a test can drive what production drives.
 */
export const retrievalTerminalsSeam: { readonly writeRetrievalTerminals: typeof writeRetrievalTerminals } = { writeRetrievalTerminals };

/** The additive block's framing. Lives in the USER-message context only — OPD_AUDIT_SYSTEM is frozen. */
export const NORMATIVE_CHANNEL_HEADER =
  'NORMATIVE REFERENCES — professional-society recommendations (Choosing Wisely / guidelines). ' +
  'Advisory "avoid/don\'t" statements to CITE when a finding matches. They ADD to the evidence above ' +
  'and do not replace it. Do NOT withhold or downgrade a finding because a normative reference is ' +
  'terse or because guidance exists.';

/** Render the normative block, numbering continuing from the literature excerpts. Pure. */
export function buildNormativeBlock(normHits: CiteHit[], startN: number, perChunkChars = 700): string {
  if (!normHits.length) return '';
  const lines = normHits.map((h, i) => {
    const society = String(h.book ?? h.source ?? 'guideline').trim() || 'guideline';
    const body = String(h.text ?? '').replace(/\s+/g, ' ').trim().slice(0, perChunkChars);
    return `[${startN + i}] ${body} — ${society}`;
  });
  return `${NORMATIVE_CHANNEL_HEADER}\n${lines.join('\n')}`;
}

/** Assemble the audit context. No normative hits ⇒ EXACTLY today's assembly (byte-identical).
 *  With normative hits ⇒ literature [1..n] UNCHANGED, then the labelled block [n+1..] appended, and
 *  the sources list extended so citation_ids into the block resolve for display. Pure. */
export function assembleAuditContext(litHits: CiteHit[], normHits: CiteHit[]): { sources: Source[]; citedContext: string } {
  if (!normHits.length) {
    return { sources: hitsToSources(litHits), citedContext: buildCitedContext(litHits) };
  }
  const litN = Math.min(litHits.length, 8);   // buildCitedContext/hitsToSources cap the lit block at 8
  return {
    sources: hitsToSources([...litHits.slice(0, litN), ...normHits], litN + normHits.length),
    citedContext: `${buildCitedContext(litHits)}\n\n${buildNormativeBlock(normHits, litN + 1)}`,
  };
}

/** Fixed thinking/reasoning budget for the eval body (Audit-Determinism §8d, lever 3): Gemini 2.5's
 *  VARIABLE thinking is a hidden variance source, so the OpenRouter reasoning budget is pinned to a
 *  constant. Eval-only. Env-overridable for the A/B sweep. */
export const AUDIT_EVAL_THINKING_BUDGET = Number(process.env.AUDIT_EVAL_THINKING_BUDGET) || 4096;

/** EVAL-ONLY (lab): the OpenRouter chat body. Determinism config (Audit-Score-Determinism PRD §8d —
 *  LAB/EVAL PATH ONLY; the production defaultGenerate params are untouched this phase):
 *   - temperature 0 + top_p 1 + a fixed `seed` (AUDIT_LLM_SEED) — greedy, canonical, seed-pinned so
 *     re-runs are reproducible IF Gemini honors the seed (exactly what Phase 1 measures).
 *   - `reasoning.max_tokens` fixed (lever 3) — pin 2.5's variable thinking budget.
 *   - `provider: { allow_fallbacks:false, require_parameters:true }` (lever 4) — no cross-backend
 *     fallback, and route ONLY to a provider that honors the passed params (seed/top_p), so A/B
 *     re-runs hit one seed-respecting backend.
 *  Pure — exported for tests. */
export function buildOpenRouterBody(model: string, system: string, user: string): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    top_p: 1,
    seed: AUDIT_LLM_SEED,
    reasoning: { max_tokens: AUDIT_EVAL_THINKING_BUDGET },
    provider: { allow_fallbacks: false, require_parameters: true },
  };
}

/** Bounded retry + fetch deadline: the POLICY now lives in lib/openrouter-retry.ts (bridge-
 *  reliability addendum F v2 task 1) so the production bridge transport shares it — one copy of
 *  tries/retryable-statuses/backoff/deadline for both loops. Moved VERBATIM; imported and
 *  re-exported here so every lab call site and test is unchanged. The D4 rationale (110s fits
 *  three attempts inside the 240s tick) travelled with the constants. `openRouterGenerate` below
 *  keeps its own loop: its error strings are normative instrumentation pinned by test, it reads
 *  the envelope off every attempt, and it clamps to the tick deadline — obligations the SDK
 *  transport does not have. */
import { OPENROUTER_MAX_TRIES, openRouterRetryable, openRouterBackoffMs, OPENROUTER_TIMEOUT_MS } from './openrouter-retry';
export { OPENROUTER_MAX_TRIES, openRouterRetryable, openRouterBackoffMs, OPENROUTER_TIMEOUT_MS };

/**
 * The response envelope OpenRouter already returns and this code has always discarded (§R2).
 * `finish_reason` is the discriminator the 20-note probe reads: 'length' ⇒ the pinned reasoning
 * budget consumed the output and an explicit completion `max_tokens` is the fix; anything else ⇒ a
 * different fault and the request shape is not the cause.
 */
export interface LlmEnvelope {
  finish_reason?: string | null;
  native_finish_reason?: string | null;
  provider?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number } | null;
  content_length: number;
  attempt: number;
  /** Eval-hardening D6 (Q3 overruled — ships now): the response body's error taxonomy, read from
   *  the top-level `error` object or `error.metadata` (per-choice `error` as fallback). Absent ⇒
   *  null. The tombstone is its consumer — without it a week of tombstones records prose instead
   *  of taxonomy. */
  error_type?: string | null;
}

/** Errors thrown on the eval path carry the envelope (Eval-hardening D5/O2). `lastEnvelope` was a
 *  LOCAL in `runMiniOpdToLab` and died with the stack frame on the throw path, so `drainOne` only
 *  ever saw `(e as Error).message` truncated to 300 chars — the tombstone could never carry a real
 *  envelope. v1.0 specified something unbuildable; this is the fix. */
export interface EvalPathError extends Error {
  envelope?: LlmEnvelope | null;
  error_type?: string | null;
}

/** Attach the envelope to an error about to be thrown on the eval path (D5/O2). */
export function withEnvelope(err: Error, env: LlmEnvelope | null): EvalPathError {
  return Object.assign(err, { envelope: env ?? null, error_type: env?.error_type ?? null });
}

/**
 * The empty-content failure message. NORMATIVE (PRD §4) — this string IS the instrumentation.
 *
 * It must carry the whole envelope because on failure NO `lab_analyses` ROW EXISTS: the tick summary
 * in `app_settings.lab_batch_last` is the only surviving record of what went wrong. Exported so the
 * shape is asserted by test rather than trusted.
 */
export function emptyContentErrorMessage(env: LlmEnvelope, maxTries: number = OPENROUTER_MAX_TRIES): string {
  const v = (x: unknown) => (x == null || x === '' ? 'null' : String(x));
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? String(x) : 'null');
  return `OpenRouter returned EMPTY CONTENT (HTTP 200) — treated as failure, not as an unassessed note.
finish_reason=${v(env.finish_reason)} native_finish_reason=${v(env.native_finish_reason)} provider=${v(env.provider)} attempt=${env.attempt}/${maxTries}
usage: prompt=${n(env.usage?.prompt_tokens)} completion=${n(env.usage?.completion_tokens)} reasoning=${n(env.usage?.reasoning_tokens)} content_length=${env.content_length}`;
}

/**
 * The tick-deadline failure message. NORMATIVE (Eval-tick-deadline PRD §4) — like
 * `emptyContentErrorMessage`, this string IS the instrumentation: no `lab_analyses` row is written
 * for a deadline-hit note, so the tick summary in `app_settings.lab_batch_last` is the only record.
 *
 * `env` is the LAST envelope seen on this note, or null when the deadline was already blown before
 * attempt 1 (nothing has come back off the wire yet) — every field then reads `null`, which is
 * itself the signal that the note never got a response.
 */
export function deadlineErrorMessage(attempt: number, maxTries: number, env: LlmEnvelope | null): string {
  const v = (x: unknown) => (x == null || x === '' ? 'null' : String(x));
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? String(x) : 'null');
  return `TICK DEADLINE reached before attempt ${attempt}/${maxTries} — abandoning this note so the tick can report.
The uid is NOT marked done and will be retried next tick.
last envelope: finish_reason=${v(env?.finish_reason)} native_finish_reason=${v(env?.native_finish_reason)} provider=${v(env?.provider)} content_length=${n(env?.content_length)}`;
}

/** The stable prefix of `deadlineErrorMessage`. The tick counts `deadline_hits` with it, so it is
 *  defined ONCE here beside the builder rather than duplicated as a literal in `lab-batch.ts`. */
export const DEADLINE_ERROR_PREFIX = 'TICK DEADLINE reached before attempt ';

/** True when a per-note error string came from the tick deadline. Pure and total. */
export function isDeadlineErrorMessage(msg: unknown): boolean {
  return typeof msg === 'string' && msg.startsWith(DEADLINE_ERROR_PREFIX);
}

/**
 * Eval-path parse-guard messages — NORMATIVE (Eval-hardening §4), exported so the exact strings are
 * asserted by test rather than trusted. They deliberately say "retried next tick", not "retryable"
 * (O1): empty content retries WITHIN the call, seconds apart, because the 3-try budget lives inside
 * `openRouterGenerate`; a parse-null throw happens AFTER it has already returned successfully and
 * cannot re-enter that loop, so its retry is the NEXT TICK, minutes apart. Both end in the same
 * tombstone. Nobody should later find this asymmetry and call it a bug — it is D1, intended.
 */
export const evalGuardMessage = {
  parseNull: (contentLength: number) =>
    `eval: parseOpdAnalysis returned null (content_length=${contentLength}) — retried next tick`,
  pdqi9Absent: () =>
    'eval: parsed response has no pdqi9 object — retried next tick',
  pdqi9Partial: (rated: number) =>
    `eval: pdqi9 has ${rated}/9 attributes, require 9 — retried next tick`,
};

/**
 * S0 (production invalid-marking, PRD 28 Jul) — the leg-failed predicate, PURE and shared by the
 * retry trigger and the final signal so they can never disagree. True when the parse produced
 * nothing PDQI-9-usable: parse returned null, `pdqi9` is null/absent, or it is an empty object
 * (an empty object survives `== null` but scores as `pq.rows = []` — the same empty stored array
 * the S0 gate counts). This is deliberately WEAKER than the lab's 9-attribute guard: production is
 * fail-soft (D1) and a partial PDQI-9 still carries signal for a clinician; the lab needs schema
 * compliance, production needs "did the instrument read at all".
 */
export function llmLegFailedAfterParse(parsed: { pdqi9?: unknown } | null): boolean {
  if (parsed === null || parsed.pdqi9 == null) return true;
  const p = parsed.pdqi9;
  return typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0;
}

/**
 * Read the envelope off a parsed OpenRouter response. PURE and TOTAL — any shape yields a defined
 * envelope, so capture can never be the thing that fails.
 *
 * ⚠️ INFERRED SHAPE, FLAGGED: OpenRouter documents reasoning tokens as
 * `usage.completion_tokens_details.reasoning_tokens`, but some providers surface a flat
 * `usage.reasoning_tokens`. BOTH are read, flat first. If the probe comes back with
 * `reasoning=null` while `completion` is populated, this is the line to check — not the model.
 */
export function readLlmEnvelope(j: unknown, attempt: number, contentLength: number): LlmEnvelope {
  const o = (j ?? {}) as {
    choices?: { finish_reason?: unknown; native_finish_reason?: unknown; error?: unknown }[];
    provider?: unknown;
    error?: unknown;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; reasoning_tokens?: unknown;
              completion_tokens_details?: { reasoning_tokens?: unknown } };
  };
  const c0 = Array.isArray(o.choices) ? o.choices[0] : undefined;
  const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const u = o.usage;
  // D6 — the error taxonomy, TOTAL like everything else here: any shape yields a string or null.
  // Top-level `error` first (the HTTP-failure body), per-choice `error` as fallback (some providers
  // report a 200 whose failed choice carries its own error object). `type` beats `code` beats
  // `metadata`, because `type` is the taxonomy and `code` is usually just the HTTP status again.
  const errorType = (e: unknown): string | null => {
    if (e == null || typeof e !== 'object') return null;
    const x = e as { type?: unknown; code?: unknown; metadata?: { type?: unknown; raw?: unknown } | null };
    const v = x.type ?? x.code ?? (x.metadata && typeof x.metadata === 'object' ? x.metadata.type ?? x.metadata.raw : null);
    return v == null ? null : String(v).slice(0, 120);
  };
  return {
    finish_reason: c0?.finish_reason == null ? null : String(c0.finish_reason),
    native_finish_reason: c0?.native_finish_reason == null ? null : String(c0.native_finish_reason),
    provider: o.provider == null ? null : String(o.provider),
    usage: u
      ? {
        prompt_tokens: num(u.prompt_tokens),
        completion_tokens: num(u.completion_tokens),
        reasoning_tokens: num(u.reasoning_tokens) ?? num(u.completion_tokens_details?.reasoning_tokens),
      }
      : null,
    content_length: contentLength,
    attempt,
    error_type: errorType(o.error) ?? errorType(c0?.error),
  };
}

/** EVAL-ONLY (lab): generate one audit via OpenRouter's OpenAI-compatible endpoint. Any model id is
 *  accepted (the orchestrator passes it). Key from env OPENROUTER_API_KEY. Direct fetch — no new dep;
 *  this is the lab dry-run path and NEVER production generation. Transient 429/5xx are retried
 *  (bounded, jittered); ultimate failure throws. fetchImpl/sleepFn injectable for tests.
 *
 *  ═══ FAIL LOUD (PDQI-9 Phase 1) ═══
 *  EMPTY CONTENT NOW THROWS. A 200 with `choices: []`, a missing `message`, `content: ""` or
 *  `content: null` used to return '' on the same statement as a full response — `parseOpdAnalysis('')`
 *  → null → `pdqi9Score(null)` → weight 0, which RAISES the index because note_quality is the
 *  lowest-scoring domain. Measured: notes the engine could not assess average 95.21 NQI (52% exactly
 *  100) against 78.36 for assessed notes. A failure to measure was being scored as excellence.
 *
 *  Empty content is RETRYABLE on the EXISTING 3-try budget — only the final attempt throws, and
 *  OPENROUTER_MAX_TRIES is deliberately NOT raised.
 *
 *  `onEnvelope` is APPENDED and optional, so every existing call site is unchanged. It fires on
 *  EVERY attempt — success, HTTP failure, empty content and transport failure alike — and is wrapped
 *  so instrumentation can never be the thing that breaks a run.
 *
 *  ═══ TICK DEADLINE (Eval-tick-deadline PRD D1/D2) ═══
 *  `deadlineAt` is APPENDED and optional (absolute epoch ms), so every existing call site — every
 *  production path included — is byte-identical when it is absent. When present it bounds this
 *  note's TOTAL time, not one attempt:
 *    · before EACH attempt, an exhausted budget throws immediately — no sleep, no fetch;
 *    · before sleeping between retries, a backoff that would cross the deadline throws instead;
 *    · the AbortController timeout is clamped to the remaining budget.
 *  So the pool always resolves normally and the tick reaches the line that writes its summary and
 *  clears the lock. Deliberately NOT `Promise.race` on the pool (D3): racing returns partial results
 *  while in-flight calls keep running, and those calls write `lab_analyses` rows AFTER the lock is
 *  released — the next tick would re-run the same uid, recreating the duplicate-row defect `bed1449`
 *  fixed.
 */
export async function openRouterGenerate(
  model: string, system: string, user: string,
  fetchImpl: typeof fetch = fetch,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  onEnvelope: (e: LlmEnvelope) => void = () => {},
  deadlineAt?: number,
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw withEnvelope(new Error('OPENROUTER_API_KEY is not set — required for eval generation (evalModel)'), null);
  // The last envelope seen on this note, carried into the deadline message. Assignment only.
  let lastEnv: LlmEnvelope | null = null;
  // Envelope capture must NEVER throw and NEVER block a real result (PRD §4 fail-safe direction).
  const emit = (e: LlmEnvelope) => { lastEnv = e; try { onEnvelope(e); } catch { /* instrumentation is never fatal */ } };
  // D1 — backoff that would cross the deadline throws NOW rather than sleeping through it. With no
  // deadline this is exactly `await sleepFn(openRouterBackoffMs(attempt))`, one `rand()` draw and all.
  const sleepOrThrow = async (attempt: number): Promise<void> => {
    const backoff = openRouterBackoffMs(attempt);
    if (deadlineAt != null && remainingBudgetMs(deadlineAt) <= backoff) {
      throw withEnvelope(new Error(deadlineErrorMessage(attempt + 1, OPENROUTER_MAX_TRIES, lastEnv)), lastEnv);
    }
    await sleepFn(backoff);
  };
  let lastErr: Error = new Error('OpenRouter: no attempt made');
  for (let attempt = 1; attempt <= OPENROUTER_MAX_TRIES; attempt++) {
    // D1 — before EACH attempt. An exhausted budget throws immediately: no sleep, no fetch.
    if (deadlineAt != null && remainingBudgetMs(deadlineAt) <= 0) {
      throw withEnvelope(new Error(deadlineErrorMessage(attempt, OPENROUTER_MAX_TRIES, lastEnv)), lastEnv);
    }
    // D4 — a per-attempt deadline. Cleared in `finally` so a completed request never leaves a timer.
    // D2 — clamped to the remaining tick budget when there is one, so a fetch can never outlive the
    // tick. With no deadline this is OPENROUTER_TIMEOUT_MS exactly, as before.
    const ctrl = new AbortController();
    const timeoutMs = deadlineAt == null
      ? OPENROUTER_TIMEOUT_MS
      : Math.min(OPENROUTER_TIMEOUT_MS, remainingBudgetMs(deadlineAt));
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(buildOpenRouterBody(model, system, user)),
        signal: ctrl.signal,
      });
    } catch (e) {
      // A timeout surfaces here as an AbortError, as does any transport failure (DNS/socket/reset).
      // Both are treated as normal retryable failures on the SAME bounded budget: an abort that was
      // not retryable would make the deadline strictly worse than no deadline.
      emit({ finish_reason: null, native_finish_reason: null, provider: null, usage: null, content_length: 0, attempt, error_type: null });
      const aborted = ctrl.signal.aborted;
      lastErr = withEnvelope(new Error(aborted
        ? `OpenRouter TIMEOUT after ${timeoutMs}ms (attempt ${attempt}/${OPENROUTER_MAX_TRIES})`
        : `OpenRouter transport error (attempt ${attempt}/${OPENROUTER_MAX_TRIES}): ${String((e as Error)?.message ?? e).slice(0, 200)}`), lastEnv);
      if (attempt === OPENROUTER_MAX_TRIES) throw lastErr;
      await sleepOrThrow(attempt);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      // Widened cast: the envelope fields have always been on the wire and have always been discarded.
      const j = (await res.json().catch(() => null)) as {
        choices?: { message?: { content?: string } }[];
      } | null;
      const content = j?.choices?.[0]?.message?.content || '';
      const env = readLlmEnvelope(j, attempt, content.length);
      emit(env);
      if (content) return content;
      // EMPTY CONTENT — a failure, not an unassessed note. Retryable on the existing budget.
      lastErr = withEnvelope(new Error(emptyContentErrorMessage(env, OPENROUTER_MAX_TRIES)), env);
      if (attempt === OPENROUTER_MAX_TRIES) throw lastErr;
      await sleepOrThrow(attempt);
      continue;
    }
    // HTTP failure — the body IS the error object (D6), so the envelope is read from it rather than
    // emitted empty: `error_type` and any provider fields it carries survive into the tombstone.
    // Same message as before (the raw text, sliced to 200); only the envelope got richer.
    const errText = await res.text().catch(() => '');
    let errBody: unknown = null;
    try { errBody = JSON.parse(errText); } catch { errBody = null; }
    const errEnv = readLlmEnvelope(errBody, attempt, 0);
    emit(errEnv);
    lastErr = withEnvelope(new Error(`OpenRouter HTTP ${res.status}: ${errText.slice(0, 200)}`), errEnv);
    if (!openRouterRetryable(res.status) || attempt === OPENROUTER_MAX_TRIES) throw lastErr;
    await sleepOrThrow(attempt);
  }
  throw lastErr;
}

/**
 * ⚠️ THE PRODUCTION LLM LEG RUNS UP TO **TWICE** PER NOTE, not once: the normal call, plus ONE
 * bounded S0 retry — taken either when the first attempt THREW or when it parsed to nothing usable.
 * `legRetried` caps it at one retry, so there are three `generateLeg()` call sites but only two
 * possible executions (the throw-retry and the normal call are mutually exclusive arms of the same
 * try/catch).
 *
 * A ROUTE SIZING ITSELF AGAINST ONE LEG WILL BLOW ITS BOX — the first cut of this unit did exactly
 * that and was out by 2× on OPD. Guard-tested against the source call sites by
 * lib/__tests__/route-budget-guard.test.ts; adding a third executable leg fails that test.
 */
export const OPD_AUDIT_LEGS = 2;

/**
 * The per-leg transport budget for the OPD audit, READ FROM THE TABLE rather than restated here.
 * The provider is a constant in this build; `?provider=` resolution is behind
 * PROVIDER_SWITCH_ENABLED and every cloud provider currently carries the same `audit` numbers.
 * A null budget means the provider cannot serve the class — refuse rather than substitute a default.
 */
function opdAuditBudget(provider: 'openrouter' | 'bedrock' = 'openrouter'): { perAttemptMs: number; maxTries: number } {
  const b = PROVIDER_BUDGETS[provider].audit;
  if (!b) throw new Error(`no audit budget for ${provider} — this provider cannot serve the OPD audit leg`);
  return b;
}

async function defaultGenerate(traceId: string | undefined, system: string, user: string, mini = false, evalModel?: string, onEnvelope?: (e: LlmEnvelope) => void, deadlineAt?: number, bedrockModel?: string): Promise<string> {
  // EVAL-ONLY (lab): route to OpenRouter when an eval model is named. evalModel unset ⇒ the Gemini/mini
  // path below is byte-identical to today (no production audit ever passes evalModel).
  // `onEnvelope` and `deadlineAt` are threaded ONLY here, on the eval branch. The production path
  // below — its params, its governedChat call and its `content || ''` — is untouched (D1).
  if (evalModel) return openRouterGenerate(evalModel, system, user, fetch, undefined, onEnvelope, deadlineAt);
  // mini=true forces the Mac-mini Ollama bridge (no Gemini) with MINI_MODEL — the
  // scoped mini pipeline (OPD mini backfill). Default path is byte-identical to before.
  // BACKFILL RUNNER (S2, 7 Aug 2026): an explicit bedrock target outranks BOTH — it is not a
  // preference, it is what the run row will be attributed to. Gemini is cleared for the same reason
  // labRoutingOpts clears it on an override: leaving a Gemini model beside a bedrock target makes
  // the record ambiguous about what was asked for. Absent ⇒ every line below is byte-identical.
  const onBedrock = !!bedrockModel;
  const geminiModel = (mini || onBedrock) ? undefined : (geminiModelFor('doc_audit') ?? geminiUtilityModel());
  // Reasoning-class local models (DeepSeek-R1 / QwQ) emit a long <think> block before the
  // JSON, so they need greedy decoding (eval determinism), a bigger output budget (the JSON
  // must survive the reasoning tokens) and the full context window. Gated on the mini path +
  // model name, so qwen2.5:14b backfill and the Gemini path are byte-for-byte unchanged.
  const isReasoning = mini && /(?:^|[:/_-])(?:r1|qwq|deepseek-r1|reason|think)/i.test(MINI_MODEL);
  // Audit-Score-Determinism PRD §8d (Phase 2): the PRODUCTION Vertex-Gemini scorer runs greedy +
  // seed-pinned + canonical + fixed-thinking — the exact levers the Phase-1 OpenRouter A/B proved
  // (100/100 byte-identical index+band). Gated on `onGemini` (a resolved Gemini model ⇒ Vertex is
  // configured), so the mini/qwen backfill and any Gemini-unconfigured Ollama fallback are BYTE-
  // IDENTICAL to today (temperature isReasoning ? 0 : 0.2, no seed/top_p/thinking).
  const onGemini = !!geminiModel;
  const params = {
    model: mini ? MINI_MODEL : TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    // GREEDY ON EVERY CLOUD GRADER, including bedrock. The Audit-Score-Determinism programme made
    // the production Vertex scorer greedy because run-to-run drift moves bands; a NEW grader has no
    // legacy behaviour to preserve, so it starts where the measured one ended up. (No seed and no
    // top_p on this path: Converse has no seed parameter, so asking for one would be a claim the
    // transport cannot keep.)
    temperature: (onGemini || onBedrock) ? 0 : (isReasoning ? 0 : 0.2),
    max_tokens: isReasoning ? 8192 : 2200,
    ...({ options: { num_ctx: isReasoning ? 16384 : 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    // seed/top_p flow through governedChat→tracedChat's `...rest` to the Vertex OpenAI-compat client;
    // `google.thinking_config.thinking_budget` is the ONLY thinking form Vertex honors (trace.ts note)
    // — a FIXED positive budget (Pro rejects 0). NOT sent on the mini/Ollama path (out of scope).
    ...(onGemini ? { seed: AUDIT_LLM_SEED, top_p: 1, google: { thinking_config: { thinking_budget: AUDIT_EVAL_THINKING_BUDGET } } } : {}),
  };
  // Governed envelope (Stage 4): OPD-audit vertical fingerprint — the system prompt here is
  // always OPD_AUDIT_SYSTEM (see the single call site).
  // D-1 (31 Jul 2026): the audit's provider call carries ITS OWN ceiling rather than inheriting the
  // 90 s LLM_CALL_TIMEOUT_MS client default — a 90 s cap here would break the engine. Per-request
  // { timeout } via governedChat's timeoutMs.
  //
  // ⚠️ CORRECTION (3 Aug 2026). This note used to justify the ceiling with "the audit runs p50
  // 267 s / p75 425 s per note". That figure was carried between documents and never re-measured.
  // MEASURED on v_trace_summary, `opd_note_audit` successes: 2 Aug n=869 p50 51,713 · p75 89,650 ·
  // p95 382,195 · max 450,874; 1 Aug n=857 p50 65,578 · p95 393,147 · max 623,385; 31 Jul n=1,702
  // p50 69,521 · p95 309,419 · max 908,045; 30 Jul n=939 p50 68,147 · p95 338,404 · max 763,927.
  // So p50 is 52–93 s and p95 is ~310–393 s. 31 July's max of 908,045 ms outran the worker's own
  // 800,000 ms box and is unexplained — recorded as owed, not fixed here.
  //
  // Unit D (3 Aug 2026): BOTH bounds now come from PROVIDER_BUDGETS — one source, not two.
  //
  // ⚠️ DEC-B9 (V, 3 Aug 2026, 13:00 IST). This call used to send `timeoutMs: LLM_AUDIT_TIMEOUT_MS`
  // (600,000). Once tracedChat began forwarding the caller's ceiling into openrouterCreateWithRetry,
  // that value and `PROVIDER_BUDGETS.<p>.audit.perAttemptMs` became THE SAME SLOT holding two
  // different numbers — and the larger one put the route over its box: this leg runs up to
  // OPD_AUDIT_LEGS times, so 2 × 600,000 = 1,200,000 ms inside an 800,000 ms maxDuration.
  //
  // 600,000 was set on 31 July against "p50 267 s / p75 425 s" — a figure this unit MEASURED and
  // disproved (real p50 is 52–93 s; see the correction above) — and before anyone had counted that
  // OPD runs two legs. It was a legacy number resting on a retracted measurement. 380,000 is
  // DEC-B4, derived from the real leg count: 380,000 × 1 × 2 = 760,000 in an 800,000 box.
  //
  // It is also the SAFER FAILURE. At 380,000 a slow note times out and degrades, costing one note.
  // At 600,000 the invocation outruns its box and every note in the wave is lost.
  //
  // ⚠️ LLM_AUDIT_TIMEOUT_MS IS NOT DEAD. It is still exported from lib/llm.ts, still env-overridable,
  // and still the default ceiling for any audit-class caller that has no entry in the budget table.
  // It is simply no longer the source on THIS path.
  //
  // ⚠️ UNIT V-a2 (4 Aug 2026): `noLocalFallback: !mini`. A cloud audit whose ladder (Vertex, then
  // OpenRouter) fails end-to-end now THROWS instead of being graded by the local model — the throw
  // lands in auditOpdNote's outer catch, which marks the row `llmLegFailed`, the store writes
  // `excluded_reason='llm_leg_failed'`, and AUDITED_HAVING keeps the note un-audited so the next
  // sweep retries it. The MINI path passes false: the mini backfill is a deliberate free pipeline
  // (MINI_MODEL is params.model, the PRIMARY route there), not a fallback, and it must keep working.
  // The budget is read from the row of the provider that will actually serve the call — one fact,
  // one place, and bedrock's numbers are its own even though they currently match openrouter's.
  const budget = opdAuditBudget(onBedrock ? 'bedrock' : 'openrouter');
  const r = await governedChat(traceId, 'opd_audit_analyze', params, { gemini: geminiModel, bedrock: bedrockModel, promptRef: 'opd-note-audit-core/OPD_AUDIT_SYSTEM', timeoutMs: budget.perAttemptMs, maxTries: budget.maxTries, noLocalFallback: !mini });
  return r.choices?.[0]?.message?.content || '';
}

/** Reuse the stored LLM half of an audit so a deterministic-only rule change (e.g. the 0.5 dosing
 *  calibration) can refresh a stored row WITHOUT re-running retrieval/LLM. */
export interface AuditReuse {
  llmFindings: OpdFinding[];
  pdqi9: Partial<Record<Pdqi9Attr, number>> | null;
  suggestions: OpdSuggestion[];
  sources: Source[];
}
export interface AuditOpdOpts {
  /**
   * RETRIEVAL TELEMETRY (D11). Present ⇒ this audit declares, instruments and settles its retrieval
   * runs. Absent ⇒ `unknown_route` is recorded for nothing at all, because no capture is created
   * and no telemetry statement executes.
   */
  telemetry?: {
    ctx: TelemetryRequestContext;
    route: RetrievalRoute;
    /** Declared UP FRONT, not inferred from the role: the run route's POST arm audits and never
     *  saves, and no property of `primary` could have told us that. Default `will_persist`. */
    persistenceIntent?: 'will_persist' | 'never_persists';
  };
  /**
   * Run ids the WORKER allocated before this function was entered (D10). ADOPTED, never
   * reallocated — a second `started` row for the same execution would double the denominator every
   * coverage percentage divides by.
   */
  predeclaredTelemetry?: PredeclaredTelemetryRuns;
  /**
   * Fires after declaration and after every successful lifecycle transition (D11).
   *
   * ⚠️ WHY A CALLBACK AND NOT ONLY THE RETURNED AUDIT. `auditOpdNote` can throw after declaration,
   * after either retrieval, during context assembly, or during audit generation. On every one of
   * those paths there is no returned audit — so a caller that could only read the handle off the
   * result would hold nothing, and could not settle the rows it is responsible for.
   *
   * ⚠️ THE SECOND ARGUMENT IS THE ROLE-KEYED MANIFEST VERDICT, AND IT IS WHY THIS EXISTS AT ALL
   * (v10 requirement 1). The success path attaches the map to the audit; every throwing path has no
   * audit, so before this the deterministic fallback delivered the handle and LOST the map, and the
   * owner settled clean whatever the manifests said.
   *
   * ABSENT ON DECLARATION, PRESENT ON EACH TERMINAL WRITE (requirement 2). A declaration knows no
   * verdict yet, and passing `{}` there would be a claim — under requirement 6 an empty PROVIDED map
   * says "every declared role has no verdict". Undefined says "nothing to say", which is the truth.
   * A receiver must therefore keep the last map it was GIVEN and not overwrite it with undefined.
   *
   * The map is a shallow snapshot taken at the moment of the call (requirement 3), never the live
   * object the producer keeps mutating.
   */
  onLifecycleHandleUpdated?: (handle: LifecycleHandle, manifestDefectsByRole?: ManifestDefectsByRole) => void;
  trace?: boolean;
  /** EVAL-ONLY (PDQI-9 fail-loud Phase 1). Fires on every OpenRouter attempt with the response
   *  envelope. Only reached when `evalModel` is set; production never passes it. Never throws. */
  onEnvelope?: (e: LlmEnvelope) => void;
  reuse?: AuditReuse;
  /** 'mini' = run the audit LLM pass on the Mac-mini bridge (MINI_MODEL, no Gemini) and tag
   *  the row with the '-<tag>' engine version — invisible to all prod dashboards/APIs, which
   *  filter on the exact prod engine version. Rows coexist per uid (PK uid+engine_version). */
  pipeline?: 'mini';
  /** Engine suffix for mini rows (default 'mini'). A NEW tag (e.g. 'mini2') re-audits the same
   *  notes as a fresh run — the uid+engine PK treats it as a distinct generation. */
  engineTag?: string;
  /** Active Tier-1 suppressions to apply (defaults to the cached active set). Pass [] to disable. */
  suppressions?: Suppression[];
  /** Quieting config override (tests / replay). Omitted → cached store read with gen-0 fail-safe. */
  quieting?: QuietingConfig;
  /** Stage 3 — force-attach the de-identified longitudinal note projection regardless of the env flag
   *  (the replay endpoint sets this so it can recompute a note's longitudinal block on demand). */
  longitudinal?: boolean;
  /** LAB EVAL ONLY (R-11 Stage 2, Phase 2): force the normative retrieval leg ON regardless of env/mini.
   *  Absent ⇒ today's gate exactly. Set only by the lab eval batch; never by any production caller. */
  evalNormativeLeg?: boolean;
  /** LAB EVAL ONLY: route audit generation to this OpenRouter model id. Absent ⇒ Gemini/mini as today. */
  evalModel?: string;
  /** LAB EVAL ONLY (rerank-flip-prep, 31 Jul 2026): run this audit's citation retrieval under a NAMED
   *  rerank backend, so the flip A/B can produce full paired audits per backend. Explicit 'cohere'
   *  inherits rerank()'s strict per-call behaviour — health-probed, typed errors PROPAGATE, never a
   *  silent fallback (measurement honesty). ABSENT ⇒ the retrieve options object is deep-equal to
   *  today's (guarded spread in opdRetrieveOpts) and production is byte-identical. Set only by the
   *  lab; never by any production caller. This is the instrument for the flip, not the flip. */
  rerankBackend?: 'judge' | 'cohere';
  /** LAB EVAL ONLY (R-11 fix candidate): ADDITIVE normative channel — the 8 literature excerpts stay
   *  byte-identical and the CW statements are appended as a separate citable block [9+]. Independent
   *  of evalNormativeLeg (the harmful union); absent ⇒ today's context assembly exactly. */
  evalNormativeChannel?: boolean;
  /** LAB EVAL ONLY (Eval-tick-deadline PRD D1): absolute epoch-ms deadline for the tick this note is
   *  being audited in. Reaches the LLM only via `defaultGenerate`'s evalModel branch, so it is inert
   *  unless `evalModel` is also set. ABSENT ⇒ every existing call site, production included, is
   *  byte-identical. Set ONLY by `batchTick`'s eval branch; never by any production caller. */
  deadlineAt?: number;
  /** Phase 3a / A-8 — re-score an EXISTING row in place under its OWN engine version. Set only by
   *  a backfill route: the recomputed audit carries this version, so `updateOpdAudit`'s
   *  `WHERE engine_version = $19` matches the stored row instead of silently returning 'skipped'.
   *  The row keeps its original label (engine_version is never in that UPDATE's SET list) — a
   *  second row would be counted TWICE by every doctor aggregate, which has no per-uid dedup.
   *  ABSENT ⇒ OPD_ENGINE_VERSION, exactly as before. Production path only; the mini path is
   *  unaffected. */
  engineVersion?: string;
  /** BACKFILL RUNNER ONLY (Bedrock S2, 7 Aug 2026): grade this note on a Bedrock model — the full
   *  modelId, e.g. `global.anthropic.claude-haiku-4-5-20251001-v1:0`. Reaches the LLM leg through
   *  `defaultGenerate`, exactly the way an F11 lab override reaches the ask/ddx legs, and dispatches
   *  with NO ladder and NO local fallback behind it (tracedChat's bedrock branch). The row must then
   *  be stamped with this same model — see the runner route. ABSENT ⇒ every existing call site,
   *  production included, is byte-identical. */
  bedrockModel?: string;
}

/** Engine tag for mini-pipeline rows (default run). */
export const OPD_MINI_ENGINE_VERSION = `${OPD_ENGINE_VERSION}-mini`;
/** Engine string for an arbitrary mini run tag. */
export function opdMiniEngine(tag?: string): string {
  const t = (tag || 'mini').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'mini';
  return `${OPD_ENGINE_VERSION}-${t}`;
}

export async function auditOpdNote(row: Record<string, unknown>, opts: AuditOpdOpts = {}): Promise<OpdNoteAudit> {
  const mini = opts.pipeline === 'mini';
  // A MINI RUN ALWAYS WRITES '-<tag>' (GRADER-PROVENANCE PRD D1, 2 Aug 2026). The former prod-tag
  // option let a mini run write the PLAIN production engine version so its rows appeared on the
  // dashboards; those qwen2.5:14b rows then outranked the real Gemini audits and marked doctors
  // down. That option is DELETED — a local-model row can no longer be labelled as production.
  // Phase 3a / A-8 — the backfill override, PRODUCTION PATH ONLY. updateOpdAudit keys its WHERE on
  // engineVersion, so re-scoring a stored 0.81.15 row with a fresh 0.81.16 audit matched nothing and
  // returned 'skipped' SILENTLY. Passing the SOURCE version lets the UPDATE find its row; the row
  // keeps its own 0.81.15 label because engine_version is in that WHERE and never in the SET list.
  const engineVersion = mini
    ? opdMiniEngine(opts.engineTag)
    : (opts.engineVersion ?? OPD_ENGINE_VERSION);
  const { case: oc, keys } = rowToOpdCase(row);
  enrichOpdMeds(oc.medications);   // brand→generic + class/schedule/high-alert/LASA/VED from the formulary

  // Decision 6 — etoricoxib's 120 mg/day ceiling applies ONLY under a documented gout diagnosis; else
  // the tighter 90 mg default. Same haystack unindicatedRespFindings builds, plus an M10/M1A ICD code.
  // Absent context → isGout false → 90 mg applies (fail-safe conservative).
  const goutHay = [oc.reasonForConsult || '', ...oc.presentingComplaints, ...oc.impressions, ...oc.history].join(' ');
  const goutCodes = [...oc.diagnosisCodes, ...oc.impressionCodes].map((c) => c.trim());
  const isGout = /\bgout\b|\bgouty\b|\btophus\b|\btophi\b/i.test(goutHay) || goutCodes.some((c) => /^M1[0A]/i.test(c));
  // 0.81.14 case context threaded into the meds[] checks (Rulings 4 + 5–8; same pattern as isGout).
  const mskDocumented = mskContextDocumented(oc);                                   // Ruling 4 — muscle relaxant gate
  const lmpDays = lmpIntervalDays(oc.lmp, oc.noteDate);                             // Rulings 5–8 — possible-pregnancy window (visit_date proxied by oc.noteDate)
  // Phase 3b — the note's 25(OH)D band, read from the documented text. FAIL-SAFE: unreadable ⇒
  // null ⇒ the dose matrix stays silent (bug 8's cutoff came from model recall, never from data).
  const vitDBand: VitaminDBand | null = (() => {
    const hay = [...oc.history, ...oc.investigations, ...oc.impressions, ...oc.presentingComplaints, ...oc.examination].join(' · ');
    const lvl = parseVitaminDLevel(hay);
    return lvl == null ? null : vitaminDBand(lvl);
  })();
  const det = [...prescribingChecks(oc), ...doseFindings(oc.medications, { isGout }), ...ddiFindings(oc.medications), ...muscleRelaxantFindings(oc.medications, { mskDocumented }),
    ...unindicatedRespFindings(oc), ...decongestantDurationFindings(oc.medications),   // 0.81.8 bugs 1, 3
    ...vitaminDRepletionFindings(oc.medications, vitDBand),                          // Ruling 13 + phase 3b matrix (informational)
    ...pregnancyRiskFindings(oc.medications, { lmpIntervalDays: lmpDays }),          // 0.81.14 Rulings 5–8 (informational)
    ...bannedFdcFindings(oc.medications),   // CDSCO banned-FDC (C1) — seed live at v1.0 (5 entries); zero match current prescribing
    ...bannedFdcNearMisses(oc.medications)];   // 0.81.21 Unit B — informational near-miss COUNT against the same seed (never scores)
  const completeness = opdCompleteness(oc);
  const healthCheck = isHealthCheckEncounter(oc);   // 0.81.8 bug 2 — institutional screening context

  // Tier-1 self-heal: apply human-approved active suppressions to the final (identity-stamped)
  // findings — drop, or downgrade to informational (out of the triage queue + score). No-op when
  // none are active. Applied AFTER stampFindingIdentity so it matches on signal_type + subject.
  const supps = opts.suppressions ?? await getActiveSuppressions();
  const lvcRules = await getLvcRules();   // 0.81.4 matcher input (cached, 2s-timeout fail-safe → [])
  // Quieting config (demote rules + policy gen) — fail-safe to { rules: [], gen: 0 } (never blocks).
  const quietCfg = opts.quieting ?? await getQuietingConfig();
  const noMeds = oc.medications.length === 0;
  // Phase 3b — the retrieval hits with their FULL text, set on the generation path only. Empty on
  // the reuse path (which carries stored 600-char previews), which is the explicit guard that keeps
  // the citation check off it: stripUnsupportedCitations returns early on an empty hits array.
  let latestHits: { id: number; text?: string | null }[] = [];
  const finalize = (fs: OpdFinding[]): OpdFinding[] => {
    let out = stampFindingIdentity(fs);
    // B1 — nothing was prescribed this encounter → there is no prescription to fault. Deterministic
    // prescribing checks can't fire with 0 meds, so any prescribing_safety finding here is an LLM
    // ghost (typically read out of the patient's history). Drop it. (Interaction/duplication with a
    // history drug is only valid when a CURRENT med exists — which requires meds.length > 0.)
    if (noMeds) out = out.filter((f) => f.domain !== 'prescribing_safety');
    out = dedupeRouteAware(out, oc.medications);   // 0.81.8 bug 8: wash-off + leave-on / topical + systemic is not a duplicate
    out = consolidateDecisions(out);   // BUG-0.8-12: one decision → one finding, across sources
    out = neutralizeMetadataFindings(out);   // BUG-0.8-16: don't penalise the doctor for our metadata
    out = neutralizeScreeningContext(out, healthCheck);   // 0.81.8 bug 2: don't penalise a health-check package's protocol panel
    // The contradicted-by-structure neutraliser once sat here — REMOVED in 0.81.19 (V, 1 Aug 2026:
    // 400 live findings suppressed, zero correctly). Those findings now score.
    // Phase 3a (R-5) — direction BEFORE stampLvcMetadata (which the underuse gate below keys on).
    out = stampDirection(out, oc);
    // Phase 3b — display/provenance only; cannot move a score (findingPenalty reads verdict,
    // confidence, direction). No-ops when latestHits is empty, i.e. on the reuse path.
    out = stripUnsupportedCitations(out, latestHits, oc.medications.map((m) => `${m.resolvedGeneric || ''} ${m.generic || ''} ${m.brand || ''}`).join(' '));
    // 0.81.4 (RIGHT-CARE §5 / decision 14): stamp rule_ref/lvc_category on the SURVIVING,
    // non-informational low-value findings (after neutralisation) — keyword-matched against the active
    // lvc_recommendations. Additive metadata — never changes verdict/domain/score.
    // Phase 3a taxonomy gate (§1.4): an UNDERUSE finding is not low-value care. It receives no
    // lvc_category, and if stampFindingIdentity collapsed it into the generic `low_value_care`
    // bucket that label is restored to the finding's own specific type (recomputed with the same
    // pure opdSignalType the stamper used — never invented). MEASURED expectation: ~1,180 findings
    // leave the low-value-care count and 78 leave antibiotic overuse.
    // 1:1 map, so finding ORDER is preserved exactly (the report numbers findings by position).
    const stamped = stampLvcMetadata(out, lvcRules);
    out = out.map((f, i) => {
      if (f.direction !== 'underuse') return stamped[i];
      // A-4: an underuse finding is not low-value care. Withholding a NEW stamp is not enough on
      // the reuse path — the stored finding arrives carrying lvc_category from its original audit.
      const { lvc_category: _dropped, ...rest } = f as typeof f & { lvc_category?: string };
      return rest.signal_type === 'low_value_care'
        ? { ...rest, signal_type: opdSignalType(rest.subject, rest.domain, { verdict: rest.verdict }) }
        : rest;
    });
    out = applySuppressions(out, keys.doctorUid, supps).findings;
    // QUIETING SEAM (PRD Q1 — the one engine touch-point): active demote rules mark matching
    // findings informational + quieted_by, via the exact mechanism scoring already excludes
    // upstream (findings.filter(f => !f.informational) below). Safety signal types are skipped
    // in applyDemotes regardless of rules (engine-side half of the severity floor).
    return applyDemotes(out, keys.doctorUid, quietCfg.rules).findings;
  };

  // Right Care complexity — computed once per audit from db13 history (0.81.3). Fully guarded: a bad
  // individual_uid, a db13 error, or a 3s timeout yields a null band and NEVER blocks/fails the audit.
  const complexityFor = async (): Promise<OpdNoteAudit['complexity']> => {
    // The note uid resolves the patient (individual_uid) inside the fetcher — "individuals-prescriptions"
    // has no individual_uid (live-validated 8 Jul). keys.noteDate is the as-of hint (index timestamp).
    const noteUid = keys.uid ? String(keys.uid) : '';
    if (!noteUid) return { band: null, inputs: null };
    try {
      const inputs = await fetchPatientHistoryBundle(noteUid, keys.noteDate ? String(keys.noteDate) : undefined);
      return inputs ? { band: bandFor(inputs), inputs } : { band: null, inputs: null };
    } catch {
      return { band: null, inputs: null };
    }
  };

  // Deterministic REUSE path (backfill): recompute the deterministic findings + completeness, KEEP
  // the stored LLM findings + PDQI-9, re-score. No retrieval, no LLM, no trace — so a completeness/
  // prescribing rule change refreshes stored rows at ~zero cost.
  if (opts.reuse) {
    // stampFindingIdentity: signal_type + finding_ref on every finding (governance spec v2.0 §2);
    // deterministic, so re-stamping stored LLM findings reproduces their refs.
    const findings: OpdFinding[] = finalize([...det, ...opts.reuse.llmFindings]);
    const scorecard = computeOpdScore({
      findings: findings.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain, direction: f.direction })),
      completenessCoverage: completeness.coverage,
      pdqi9: opts.reuse.pdqi9,
      patientCentred: completeness.patientCentred,
    });
    return { keys, scorecard, completeness, findings, suggestions: opts.reuse.suggestions, sources: opts.reuse.sources, engineVersion: engineVersion, traceId: undefined, quietingGen: quietCfg.gen };
  }

  const doTrace = opts.trace !== false;
  // Non-identifying trace input (the uid lives only on the returned audit / the audit row).
  const traceId = doTrace
    ? await startTrace('opd_note_audit', {
        consultType: keys.consultType, prescriptionType: keys.prescriptionType,
        nMeds: oc.medications.length, nDx: oc.diagnosisCodes.length, nInvestigations: oc.investigations.length,
        ...(mini ? { pipeline: 'mini' } : {}),
      }).catch(() => undefined as string | undefined)
    : undefined;

  // ══ RETRIEVAL TELEMETRY, STEPS 3-6 OF D11's FOURTEEN ══════════════════════════════════════════
  // We are past the reuse guard (step 1) and past startTrace (step 2), so `traceId` exists where it
  // exists at all. Now: determine the expected role set, create or adopt the invocation, declare
  // the rows, and PUBLISH THE HANDLE — all before any fallible work.
  const tele = opts.telemetry;
  const wantsNormative = opts.evalNormativeChannel === true;
  const primaryCapture = tele ? createTelemetryCapture('primary') : undefined;
  const normativeCapture = tele && wantsNormative ? createTelemetryCapture('normative_channel') : undefined;
  const telemetryStartedAt = new Date().toISOString();
  let handle: LifecycleHandle | null = null;
  let manifestDefectsByRole: ManifestDefectsByRole = {};
  const publishHandle = (h: LifecycleHandle, defects?: ManifestDefectsByRole) => {
    handle = h;
    opts.onLifecycleHandleUpdated?.(h, defects);
  };
  /** D11: the non-enumerable property on the audit object, for the SUCCESS path. The callback above
   *  is what covers every throwing path, where there is no returned audit to carry anything. */
  const withHandle = <T extends object>(audit: T): T =>
    (tele ? attachRetrievalTelemetry(audit, { handle, manifestDefectsByRole }) : audit);

  if (tele) {
    await startInvocation(tele.ctx);
    const pre = opts.predeclaredTelemetry;
    const runs = [
      { role: 'primary' as const, runId: pre?.primary.runId ?? randomUUID(), uid: keys.uid ?? null, engineVersion },
      ...(wantsNormative
        ? [{ role: 'normative_channel' as const, runId: pre?.normativeChannel?.runId ?? randomUUID(), uid: keys.uid ?? null, engineVersion }]
        : []),
    ];
    if (pre) {
      // ADOPT. The worker already inserted these rows and already counted them onto the invocation;
      // re-declaring would insert nothing (ON CONFLICT DO NOTHING) but would count them twice.
      handle = {
        invocationId: tele.ctx.invocationId,
        runs: runs.map((r) => ({ role: r.role, runId: r.runId, expectedRevision: 0 })),
        persistenceIntent: tele.persistenceIntent ?? 'will_persist',
      };
      publishHandle(handle);
    } else {
      try {
        publishHandle(await declareRetrievals(tele.ctx, runs, tele.persistenceIntent ?? 'will_persist'));
      } catch (e) {
        // Fail-open for a NON-WORKER caller. The worker's own declaration is fail-closed and
        // happens before this function is entered (D10) — that is the path where a missing durable
        // start actually matters, and it is guarded there.
        console.warn('[opd-audit] telemetry declaration failed, continuing uninstrumented', (e as Error).message);
      }
    }
  }

  try {
    // Richer retrieval query so the corpus is hit on the actual clinical content (readable dx
    // names + reason + complaints + resolved molecules), not just ICD codes — improves grounding.
    const query = [
      ...oc.impressions,
      ...oc.diagnosisCodes,
      oc.reasonForConsult || '',
      ...oc.presentingComplaints.slice(0, 4),
      ...oc.medications.map((m) => m.resolvedGeneric || m.generic || m.brand || '').filter(Boolean),
      'outpatient appropriateness rational prescribing evidence-based management guideline',
    ].filter(Boolean).join('. ');

    // STEPS 7 AND 8 — capture both retrievals IN MEMORY. No terminal write yet, deliberately.
    const hits = await defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend, primaryCapture);
    // R-11 additive channel (lab eval only): a SEPARATE CW-only retrieve appended as [9+] — the 8
    // literature excerpts above are untouched. No channel ⇒ assembleAuditContext is byte-identical
    // to the previous hitsToSources(hits) + buildCitedContext(hits).
    const normHits = opts.evalNormativeChannel === true ? await normativeChannelRetrieve(query, normativeCapture) : [];
    // STEP 9 — the combined context. ⚠️ THIS IS WHY THE PRIMARY TERMINAL WRITE CANNOT HAPPEN AT
    // STEP 7. `assembleAuditContext` runs over BOTH hit sets and is the only place the exact bytes
    // that reach the scorer exist; inside either retrieval call they do not exist yet, so a
    // scorer-context HMAC written there would be a hash of something the scorer never saw.
    const { sources, citedContext } = assembleAuditContext(hits, normHits);
    // STEPS 10-13 — HMAC the combined context, build both payloads, write both terminals, and
    // publish the handle after each so a throw below still leaves the caller holding the latest.
    if (tele && handle) {
      manifestDefectsByRole = await writeRetrievalTerminals({
        tele, handle, publishHandle, traceId: traceId ?? null,
        startedAt: telemetryStartedAt, citedContext,
        primaryCapture: primaryCapture!, normativeCapture,
      });
    }
    if (traceId) await logEvent(traceId, 'opd_audit_sources', null, { count: sources.length });

    const specialty = await doctorSpecialtyFor(keys.doctorUid);
    // Eval-hardening D5/O2 — keep the last envelope HERE too, so the parse guards below can attach
    // it to their throws. Wrapped ONLY when evalModel is set; absent ⇒ opts.onEnvelope passes
    // through untouched and production is byte-identical.
    let evalEnv: LlmEnvelope | null = null;
    const onEnvelope = opts.evalModel
      ? (e: LlmEnvelope) => { evalEnv = e; opts.onEnvelope?.(e); }
      : opts.onEnvelope;
    const generateLeg = () => defaultGenerate(traceId, OPD_AUDIT_SYSTEM, buildOpdAuditUser(opdCaseText(oc, { specialty }), citedContext), mini, opts.evalModel, onEnvelope, opts.deadlineAt, opts.bedrockModel);

    // ═══ S0 — ONE bounded retry on the PRODUCTION LLM leg (invalid-marking PRD D2) ═══
    // Lab evidence: 2 of 20 notes needed a second attempt, none needed a third — one retry converts
    // most would-be-invalid rows into valid ones at trivial cost. ONE total, whether the first
    // attempt THREW or parsed to nothing usable; never on the eval path (the lab fail-louds and has
    // its own in-call budget). Latency cost on the failure path: exactly one extra model call.
    let raw: string;
    let legRetried = false;
    try {
      raw = await generateLeg();
    } catch (e) {
      if (opts.evalModel) throw e;   // eval propagation unchanged — drainOne records, next tick retries
      legRetried = true;
      raw = await generateLeg();     // a second throw lands in the outer catch: det-only + marked, as today
    }
    let parsed = parseOpdAnalysis(raw, sources.length);
    if (!opts.evalModel && !legRetried && llmLegFailedAfterParse(parsed)) {
      legRetried = true;
      try {
        const raw2 = await generateLeg();
        const parsed2 = parseOpdAnalysis(raw2, sources.length);
        // Keep the retry only if it actually helped — attempt 1's partial parse beats a worse attempt 2.
        if (!llmLegFailedAfterParse(parsed2)) { raw = raw2; parsed = parsed2; }
      } catch { /* retry failing changes nothing — fail-soft below (D1) */ }
    }
    // The signal the store turns into `excluded_reason = 'llm_leg_failed'`. NEVER set on the eval
    // path — the lab throws instead of persisting, and this flag must not leak into lab rows.
    const llmLegFailed = !opts.evalModel && llmLegFailedAfterParse(parsed);

    // ═══ EVAL-PATH PARSE GUARDS (Eval-hardening D1/D2) ═══
    // `openRouterGenerate` throws on EMPTY content, but non-empty content that fails to parse — or
    // parses without pdqi9 — used to reach `pdqi9: parsed?.pdqi9 ?? null` below and persist a row
    // with note_quality weight 0: the original defect one layer up (95.21 NQI for unassessed vs
    // 78.36 for assessed, across 25,103 production rows).
    //
    // The guard sits at the CALL SITE, not inside parseOpdAnalysis: production RELIES on the
    // parser's leniency — a partially parseable audit beats none for a clinician. The instrument
    // needs the opposite. Same split as 6b12652.
    //
    // Retry is TICK-LEVEL, not call-level (D1/O1): the 3-try budget lives inside openRouterGenerate
    // and these throws happen AFTER it returned successfully. No retry loop here — the throw
    // propagates to drainOne, the uid stays un-done, and the NEXT TICK retries it, minutes later,
    // with fresh provider state. Fewer than 9 rated attributes is schema noncompliance, not
    // clinical nuance (D2/Q4: measured 0-or-9 with zero notes at 1–8 across 200 runs).
    if (opts.evalModel) {
      if (parsed === null) throw withEnvelope(new Error(evalGuardMessage.parseNull(raw.length)), evalEnv);
      if (parsed.pdqi9 == null) throw withEnvelope(new Error(evalGuardMessage.pdqi9Absent()), evalEnv);
      const rated = Object.keys(parsed.pdqi9).length;
      if (rated !== 9) throw withEnvelope(new Error(evalGuardMessage.pdqi9Partial(rated)), evalEnv);
    }

    latestHits = hits;   // phase 3b — FULL excerpt text, generation path only
    const findings: OpdFinding[] = finalize([...det, ...(parsed?.findings ?? [])]);
    const scorecard = computeOpdScore({
      findings: findings.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain, direction: f.direction })),
      completenessCoverage: completeness.coverage,
      pdqi9: parsed?.pdqi9 ?? null,
      patientCentred: completeness.patientCentred,
    });

    if (traceId) {
      const nLow = findings.filter((f) => f.verdict === 'low-value').length;
      await setTraceQuestionPreview(traceId, `OPD audit · index ${scorecard.headline} (Band ${scorecard.band}) · ${findings.length} finding(s)`).catch(() => {});
      await logEvent(traceId, 'opd_audit_result', null, {
        index: scorecard.headline, band: scorecard.band, coverage: Math.round(completeness.coverage * 100),
        n_findings: findings.length, n_low_value: nLow, pdqi9_assessed: !!parsed?.pdqi9,
      });
      await finishTrace(traceId, 'success');
    }

    // Stage 3 — attach the de-identified projection the post-persistence longitudinal pass consumes.
    // Pure extraction (no I/O, no LLM), so it never blocks or delays base persistence; gated so flag-off
    // (and every mini row) is byte-identical to today.
    const longitudinalInput = ((process.env.OPD_LONGITUDINAL_ENABLED === '1' || opts.longitudinal) && !mini)
      ? buildLongitudinalInput(oc, keys, engineVersion, opdCaseText(oc, { specialty }))
      : null;

    return withHandle({
      keys, scorecard, completeness,
      findings, suggestions: parsed?.suggestions ?? [],
      sources, engineVersion: engineVersion, traceId,
      quietingGen: quietCfg.gen,
      complexity: await complexityFor(),
      longitudinalInput,
      // S0 — absent on every successful audit, so the common-path shape is unchanged.
      ...(llmLegFailed ? { llmLegFailed: true } : {}),
    });
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message)).catch(() => {});
    // ═══ FAIL LOUD, EVAL PATH ONLY (D1 + D2) ═══
    // Without this rethrow the whole build is inert: the throw added in openRouterGenerate lands
    // HERE, and this block would swallow it and return a deterministic-only audit that is then
    // persisted and scores ~95 — exactly the defect, one level up. (This is the second site the
    // response document's R3 missed; §2.4 of the PRD.)
    //
    // On rethrow: drainOne's per-note catch records the error, NO lab_analyses row is written, the
    // uid stays un-done, and the next tick retries it. Coverage becomes a visible gap instead of a 95.
    //
    // PRODUCTION IS BYTE-IDENTICAL BELOW THIS LINE. The production defect (a failed LLM leg scored as
    // a deterministic-only ~95) is real and STAYS LIVE by decision — it gets its own PRD. Fix the
    // instrument first; changing a live clinical surface follows evidence rather than preceding it.
    if (opts.evalModel) throw e;
    // Even on LLM failure, return the deterministic-only audit (completeness + prescribing).
    const scorecard = computeOpdScore({
      findings: det.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain, direction: f.direction })),
      completenessCoverage: completeness.coverage,
      pdqi9: null,
      patientCentred: completeness.patientCentred,
    });
    // S0 — EVERY det-only fallback is a failed measurement (pdqi9 was never assessed), whatever
    // threw: LLM leg, retrieval, or anything else inside the try. Marking unconditionally here is
    // what makes the S0 gate ("zero unmarked rows with empty pdqi9") hold for every fallback row.
    // ⚠️ NO HANDLE IS ATTACHED HERE, AND THAT IS D11's RULE, NOT AN OMISSION. The non-enumerable
    // property is "for the SUCCESS path"; every throwing path is covered by
    // `onLifecycleHandleUpdated`, which has already given the owner the latest handle — including
    // on this one, where the throw happened after declaration. Attaching it here as well would buy
    // nothing and would rewrite a return statement that three committed tests pin verbatim
    // (opd-invalid-marking, pdqi9-fail-loud, vertex-primary-ladder), each of them asserting that
    // the non-eval fallback is byte-identical to what it has always been.
    return { keys, scorecard, completeness, findings: finalize(det), suggestions: [], sources: [], engineVersion: engineVersion, traceId, complexity: await complexityFor(), quietingGen: quietCfg.gen, llmLegFailed: true };
  }
}
