/**
 * lib/opd-note-audit-core.ts — OPD note-quality audit CORE (pure).
 *
 * Deterministic completeness + prescribing checks, the grounded LLM analyze prompt,
 * and the response parser. PURE: type-only cross-imports (so it loads under
 * `node --experimental-strip-types` for unit tests); the score assembly that needs
 * computeOpdScore lives in the server orchestrator (lib/opd-note-audit.ts).
 */

import type { DeidOpdCase, OpdMed } from './opd-ingest-core';
import type { NetValue, OpdFindingDomain, Pdqi9Attr } from './opd-note-score-core';
import type { FindingProvenance } from './provenance-tier-core';
// LAB-MCP Phase 1 (F1) — the ONE stable_ref implementation, shared with the backfill route.
// This is the file's only VALUE import; opd-finding-identity-core has ZERO imports of its own
// (its SHA-1 is pure), so this file stays `node --experimental-strip-types` loadable and client-safe.
import { computeStableRef } from './opd-finding-identity-core';

// 0.4 — formulary integration: brand→generic resolution + class/schedule/ISMP-high-alert/
//       LASA/VED enrichment + formulary-scoped DDI, so brand-only OPD lines (~36%) are recognised.
// 0.5 — corpus grounding made first-class: persisted CDMSS Sources, cite-or-label findings
//       (every clinical claim cites [n] or is marked reasoning), richer retrieval query. No extra LLM calls.
// 0.6 — encounter-context fix (bit a false Band-A on a teleconsult ortho REFERRAL note): the engine
//       now ingests the onward referral + teleconsult modality, separates AUTO-ATTACHED templated
//       patient-education leaflets from clinician documentation, and instructs the auditor not to (a)
//       praise a handoff's missing meds/imaging as high-value "avoidance", (b) grade a templated
//       leaflet as note thoroughness, or (c) expect a physical exam on a teleconsult.
// 0.7 — clinician-feedback fix batch (prevalence-mined 3 Jul). B4: specialty-aware (the treating
//       specialty is fed to the auditor; a specialist's focused note isn't held to GP breadth).
//       B3: a "fields present but content thin" reframe flag (advisory; scores unchanged).
//       B2: follow-up counts as documented ONLY for a real disposition or an explicit date — a bare
//       'UNKNOWN'/blank no longer earns continuity/documentation credit (the score-moving change
//       that makes 0.7 a distinct generation). Prompt-pass fixes (B1/B5/B6) land next, still 0.7.
// 0.81.8 — Dr Zaki 10-bug batch (first scoring change since 0.81.2). Unified 6/7/9: `unverified_brand`
//       → informational (non-scoring), `incomplete_dosing` exempt for off-formulary cosmetics/supplements/
//       unresolved-proprietary (a RESOLVED drug missing its dose still scores), consolidated so one
//       unresolved line never stacks both. Bug 2: institutional health-check screening no longer penalised.
//       Bug 4: the consult date (noteDate) is surfaced in opdCaseText with a historical-date guard. Bug 10:
//       niche pre-analytic omissions (biotin before a thyroid panel) → informational. Bugs 1/3/8 are
//       deterministic (orchestrator): xanthine/acebrophylline + antihistamine+montelukast for acute URTI,
//       nasal-decongestant >5-day cap, route/formulation-aware duplication. Bug 5: hyoscine/dicyclomine
//       reclassed Antispasmodic/anticholinergic in the formulary (DDI-invariant). LVC `other` sub-cat +
//       frequent-flier list surfacing + 30-day longitudinal backfill ride in the same build (non-scoring).
// 0.81.15 — S1: confidence quantization + displayed_band hysteresis (anchors reset at the bump).
// 0.81.17 — audit-integrity phase 3b: ratified vitamin-D bands + dose matrix (the engine held NO
// threshold; bug 8 scored 17 and 18 ng/mL at 100 and 60) and the generation-time citation-support
// check. Changes what the score MEANS, so it is nameable.
// 0.81.16 — audit-integrity phase 0: quantization REVERTED (28 Jul S0/S1 ruling — 17.0% of scoring
// findings sit exactly on the 0.80 boundary; +3.10 mean penalty). Hysteresis STAYS. The bump makes
// the scoring change nameable; hysteresis anchors reset again by construction.
// 0.81.18 — NO ENGINE CHANGE. A carrier version for outage-recovery re-audits (31 Jul 2026,
// addendum E §3). 301 notes stranded by the Vertex outage already hold a row at 0.81.17, and
// saveOpdAudit is ON CONFLICT (uid, engine_version) DO NOTHING, so a recovery at the same version
// is silently discarded. A plain numeric bump is the ONLY key that works: it wins the canonical
// rule (highest version), it is also newest by time so lib/learning.ts's audited_at ordering picks
// the same row, and — unlike a tag such as `0.81.17-r1` — it still casts through
// CANONICAL_RANK_SQL's int[]. No rule, weight, prompt, threshold or check differs from 0.81.17.
// OPD_ENGINE_VERSION deliberately never moved to 0.81.18: the carrier is written only via the
// explicit opts.engineVersion recovery path, never by the nightly worker.
// 0.81.19 — the contradicted-by-structure neutraliser REMOVED (V, 1 Aug 2026). All eight arms
// measured ZERO correct suppressions across 400 live findings; among the suppressed were metformin
// duplicated across two FDCs, domperidone in pregnancy and omitted antibiotics for a diagnosed UTI.
// Findings the arms marked informational (contradicted_* / incoherent_with_suggestion) now score.
// Scores and bands FALL on affected notes — the intended correction, not a regression. No backfill:
// stored rows keep their scores (D3); the correct behaviour applies to new audits only.
// 0.81.20 — formulary per-molecule class resolution (FORMULARY-CLASS-RESOLUTION PRD, V ruled §6
// option (b) on 2 Aug 2026). NO logic change in this file: the fix lives in lib/formulary.ts
// (fragment fallback when the whole-string match yields no class) + therapeuticClasses on OpdMed.
// The bump is here because what the engine SEES changes: 181/744 antibiotic lines a month carried
// no class, so noAntibioticClassOnNote misread the note, overuse direction was withheld,
// class-based DDI tags stayed silent and the class was absent from the prompt text. Scores fall
// again on purpose; interaction findings rise. No backfill.
// 0.81.21 — dose-aware aspirin class + banned-FDC near-miss counter (DETERMINISM-TRIO PRD v1.0,
// V ruled D-1…D-4 on 8 Aug 2026). UNIT A, the scoring half: tagsFor tagged aspirin `nsaid` BY NAME
// at any dose, and ddiFindings promoted any NSAID-molecule line to major 'NSAID', so aspirin 75 mg
// beside an ARB fired `nsaid × ace_arb` and docked the score for analgesic therapy nobody
// prescribed — metamorphic relation D-7, pinned as a known defect since 0.81.17. The total daily
// aspirin dose is now computed with the ONE dose machinery (aspirinMaxDailyMg, reusing
// moleculesOf/parseFrequency/unitsPerDose/isVolumetric) and a line at ≤ 100 mg/day — or one whose
// dose cannot be parsed (D-2: absence of data never accuses) — is antiplatelet only: no NSAID
// promotion, no `nsaid` tag (new optional DrugClass.suppressNsaid, honoured in tagInteractions).
// `antiplatelet` is NEVER removed, so DAPT and anticoagulant pairs still fire; 150 mg/day still
// classes NSAID (D-1's accepted consequence). Scores RISE on affected notes — the correction can
// only remove a penalty. UNIT B, non-scoring: bannedFdcNearMisses counts supersets and
// subset-missing-one against the 308-entry CDSCO rulebook as informational, confidence-0 findings
// (signal_type banned_fdc_near_miss, ratified tier 3 by D-3) to measure whether exact-match
// checking is too strict. No backfill, forward-only (D3 precedent, 0.81.19 header).
export const OPD_ENGINE_VERSION = 'opd-note-audit/0.81.21';
/** The recovery carrier (addendum E §3). Written ONLY via the explicit engineVersion path. */
export const OPD_RECOVERY_ENGINE_VERSION = 'opd-note-audit/0.81.18';

/**
 * Current-engine FAMILY for READ/aggregate surfaces. 0.81.3 → 0.81.4 → 0.81.5 are all score-identical
 * (metadata-only rule_ref stamping); older rows are NOT re-audited (rule_ref is backfilled in place,
 * engine_version unchanged — decision 14). So every user-facing READ filters `engine_version = ANY(
 * OPD_ENGINE_VERSIONS_CURRENT)` — a hard exact-match bump orphaned the validated corpus (0.81.4 emptied
 * the doctors index; decision 21). Newest-per-uid still wins via DISTINCT ON (uid) ORDER BY note_date
 * DESC, id DESC. WRITE-side targeting keeps exact OPD_ENGINE_VERSION (family there would stop history
 * re-scoring). See the patch report.
 */
export const OPD_ENGINE_VERSIONS_CURRENT = ['opd-note-audit/0.81.3', 'opd-note-audit/0.81.4', 'opd-note-audit/0.81.5', 'opd-note-audit/0.81.6', 'opd-note-audit/0.81.7', 'opd-note-audit/0.81.8', 'opd-note-audit/0.81.9', 'opd-note-audit/0.81.10', 'opd-note-audit/0.81.11', 'opd-note-audit/0.81.12', 'opd-note-audit/0.81.13', 'opd-note-audit/0.81.14', 'opd-note-audit/0.81.15', 'opd-note-audit/0.81.16', 'opd-note-audit/0.81.17', 'opd-note-audit/0.81.18', 'opd-note-audit/0.81.19', 'opd-note-audit/0.81.20', 'opd-note-audit/0.81.21'] as const;

// Local copy of the PDQI-9 keys (kept in sync with opd-note-score-core) so this core has
// no runtime cross-import and stays loadable under `node --experimental-strip-types`.
const PDQI9_KEYS: Pdqi9Attr[] = [
  'up_to_date', 'accurate', 'thorough', 'useful', 'organized',
  'comprehensible', 'succinct', 'synthesized', 'internally_consistent',
];

export interface OpdFinding {
  subject: string;
  verdict: NetValue;
  confidence: number;
  domain: OpdFindingDomain;        // 'appropriateness' | 'prescribing_safety'
  rationale: string;
  evidence: string[];
  estimates: string[];
  citation_ids: number[];
  source: 'llm' | 'deterministic';
  informational?: boolean;         // surfaced for awareness (e.g. high-alert present); never penalises the score
  // Finding identity (governance spec v2.0 §2) — stamped at assembly time by stampFindingIdentity().
  // Optional in the type because stored history predates them; readers may re-derive with the same
  // pure functions (deterministic), so legacy rows need no migration or forced re-audit.
  signal_type?: string;            // coarse controlled-vocab category — the CM triage batch key
  finding_ref?: string;            // stable per-note content hash — the instance address
  // LAB-MCP Phase 1 (F1): note-scoped identity that survives a re-audit. Optional — absent on every
  // finding stamped without a uid, and on all stored history until the backfill runs.
  stable_ref?: string;
  // Right Care LVC identity (engine 0.81.3, metadata-only — never feeds scoring). Stamped on
  // low-value-verdict findings: rule_ref = lvc_recommendations id when a wired matcher knows it
  // (null in the OPD engine — no matcher wired; read-time/backfill can attach), lvc_category coarse bucket.
  rule_ref?: string | null;        // lvc_recommendations id, or null
  lvc_category?: string;           // 'antibiotic' | 'imaging' | 'supplement_polypharmacy' | 'other'
  // Phase 3a (ruling R-5, bug 5b): overuse vs underuse. MEASURED — all 1,771 findings whose
  // concept_id begins `underuse:` carry verdict low-value, because NetValue has no member meaning
  // underuse; 1,180 polluted the low-value-care count and 78 landed inside ANTIBIOTIC OVERUSE, so
  // a recommendation to prescribe MORE antibiotics was counted as overuse. This is a SEPARATE
  // field, deliberately NOT a NetValue member: NetValue feeds scoring and must stay a closed
  // four-member vocabulary. Absent = undetermined (the default, and what every stored row has).
  direction?: 'overuse' | 'underuse';
  // Deterministic-tier provenance (opd-note-audit/0.81.9, PRD CDMSS-DETERMINISTIC-CITATIONS §7).
  // A deterministic check (dose ceiling, DDI mechanism, ISMP high-alert) carries its resolved corpus
  // citation OR an explicit llm mark. Additive metadata — NEVER feeds scoring (citations do not enter
  // note_quality_index) and NOT part of finding_ref (the hash is signal_type|subject-detail only).
  provenance?: FindingProvenance | null;
}
// ── Finding identity — signal_type + finding_ref (governance spec v2.0 §2) ────
// Every finding gets (a) a coarse controlled-vocab `signal_type` (the unit the care manager
// batch-triages on: "drug interaction ×46") and (b) a `finding_ref` — a deterministic content
// hash stable across re-audits for the same specific finding on the same note. Triage rows key
// on (audit_id, finding_ref); CM batch decisions key on (doctor_uid, signal_type).
// Pure + dependency-free (own SHA-1) so this file stays strip-types testable and client-safe.

/** Controlled signal-type vocabulary → human label. Keep coarse: this is the CM batching unit. */
export const OPD_SIGNAL_TYPES: Record<string, string> = {
  drug_interaction: 'Drug interaction',
  incomplete_dosing: 'Incomplete dosing',
  duplicate_prescription: 'Duplicate prescription',
  unverified_brand: 'Unverified brand',
  lasa_pair: 'LASA pair co-prescribed',
  dose_ceiling_exceeded: 'Daily dose exceeds ceiling',
  dose_ceiling_sos: 'Dose may exceed ceiling if all SOS taken',
  // 0.81.10 (SIGNAL-TYPE-COLLAPSE S1): the muscle-relaxant "document the indication" prompt is a
  // documentation-completeness nudge, not a care-quality judgement — surfaced, non-scoring
  // (informational), and classified deterministic_completeness like incomplete_dosing.
  muscle_relaxant_indication: 'Muscle relaxant — document the indication',
  duplicate_molecule: 'Same molecule in multiple products',
  high_alert_medication: 'High-alert medication',
  // 0.81.14 (CLINICAL-RULINGS §2.5/§2.7) — two informational documentation prompts; routed to
  // deterministic_completeness (no external authority cites "retest the level" / "verify pregnancy status").
  vitamin_d_repletion_duration: 'Vitamin D repletion — document retest',
  pregnancy_risk_verify: 'Possible pregnancy — verify status',
  schedule_x: 'Schedule X drug',
  off_formulary: 'Off-formulary items',
  banned_fdc: 'Banned fixed-dose combination',
  // 0.81.21 (DETERMINISM-TRIO PRD §3, D-3): one molecule extra or one short of a prohibited
  // combination. Informational + confidence 0 — a measurement of whether exact-match is too
  // strict, never an accusation. Ratified tier 3 (log only).
  banned_fdc_near_miss: 'Near-match to a banned combination',
  antibiotic_stewardship: 'Antibiotic stewardship',
  // Coarse LLM buckets (by domain × verdict) — a free-text appropriateness/prescribing finding
  // that matches no precise rule batches here, so the CM sees "Low-value appropriateness ×12"
  // rather than 12 one-off drug-named cards. finding_ref stays per-instance for drill.
  appropriateness_low_value: 'Low-value / inappropriate care',
  appropriateness_review: 'Appropriateness — needs review',
  appropriateness_high_value: 'High-value care (positive)',
  prescribing_low_value: 'Low-value / unsafe prescribing',
  prescribing_review: 'Prescribing — needs review',
  prescribing_high_value: 'Sound prescribing (positive)',
  appropriateness_general: 'Appropriateness (other)',
  prescribing_general: 'Prescribing safety (other)',
  // Stage 3 longitudinal (opd-longitudinal/0.1) — informational, never-scored (D4). Label-only triage lane.
  longitudinal_repeat_test: 'Redundant repeat test',
  longitudinal_med_reconciliation: 'Medication reconciliation',
  longitudinal_missed_followup: 'Unaddressed follow-up',
  longitudinal_continuity: 'Continuity of care',
  longitudinal_contradiction: 'Note contradicts the record',
};

// Deterministic subjects match exactly by prefix; LLM subjects fall through to the keyword
// rules, then the slug fallback. Order matters — first match wins.
const SIGNAL_TYPE_RULES: { re: RegExp; type: string }[] = [
  { re: /^interaction\b/, type: 'drug_interaction' },
  { re: /^incomplete dosing\b/, type: 'incomplete_dosing' },
  { re: /^duplicate prescription\b/, type: 'duplicate_prescription' },
  { re: /^unverified brand\b/, type: 'unverified_brand' },
  { re: /^lasa pair\b/, type: 'lasa_pair' },
  { re: /^daily dose exceeds ceiling\b/, type: 'dose_ceiling_exceeded' },
  { re: /^daily dose may exceed ceiling\b/, type: 'dose_ceiling_sos' },
  { re: /^muscle relaxant prescribed\b/, type: 'muscle_relaxant_indication' },
  { re: /^same molecule in \d+ products?\b/, type: 'duplicate_molecule' },
  { re: /^high[\s-]?alert medication/, type: 'high_alert_medication' },
  { re: /^vitamin d 60,?000 iu weekly/i, type: 'vitamin_d_repletion_duration' },   // 0.81.14 §2.5
  { re: /^possible pregnancy\b/i, type: 'pregnancy_risk_verify' },                 // 0.81.14 §2.7
  { re: /^schedule x\b/, type: 'schedule_x' },
  { re: /^off[\s-]?formulary\b/, type: 'off_formulary' },
  { re: /^banned fixed-dose combination/i, type: 'banned_fdc' },
  // 0.81.21 — no collision with the rule above: the prefixes differ from their first character,
  // and this one is anchored on the full phrase the near-miss subject always opens with.
  { re: /^near-match to a banned combination/i, type: 'banned_fdc_near_miss' },
  { re: /\bantibiotic|antimicrobial\b/, type: 'antibiotic_stewardship' },
  { re: /\b(?:drug[\s–-]+drug\s+)?interaction\b/, type: 'drug_interaction' },
];

// Verdict → coarse class for the LLM buckets. High-value = positive (low triage priority).
const VERDICT_CLASS: Record<string, 'low_value' | 'high_value' | 'review'> = {
  'low-value': 'low_value', 'high-value': 'high_value',
  'context-dependent': 'review', 'uncertain': 'review',
};

/**
 * The controlled-vocab signal type for a finding (pure, derivable for legacy rows).
 * (1) precise rules (deterministic subjects + keyword LLM rules like antibiotics) win;
 * (2) otherwise a free-text LLM finding batches into a COARSE domain×verdict bucket — this is the
 *     fix for queue fragmentation (per-drug subjects were each becoming their own type);
 * (3) with no verdict to class on, the domain's general bucket.
 */
export function opdSignalType(subject: string, domain: OpdFindingDomain, opts?: { verdict?: string }): string {
  // Match on the category part (before ':'), parentheticals stripped, lowercased.
  const prefix = (subject.split(':')[0] || '').replace(/\(.*?\)/g, ' ').trim().toLowerCase();
  for (const r of SIGNAL_TYPE_RULES) if (r.re.test(prefix)) return r.type;
  const domainKey = domain === 'prescribing_safety' ? 'prescribing' : 'appropriateness';
  const cls = opts?.verdict ? VERDICT_CLASS[opts.verdict] : undefined;
  return cls ? `${domainKey}_${cls}` : `${domainKey}_general`;
}

// Compact pure SHA-1 (deterministic content hash; NOT security-sensitive). Verified against the
// standard test vector in the unit tests.
function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const ml = bytes.length;
  const padded = new Uint8Array(Math.ceil((ml + 9) / 64) * 64);
  padded.set(bytes);
  padded[ml] = 0x80;
  const dv = new DataView(padded.buffer);
  const bitLen = ml * 8;
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) { const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]; w[j] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = ((((a << 5) | (a >>> 27)) + f + e + k + w[j]) | 0) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('');
}

/** Stamp signal_type + finding_ref on every finding of one note (final assembly step).
 *  finding_ref = sha1(signal_type + '|' + normalized detail-after-colon), first 12 hex chars —
 *  stable across re-audits for the same specific finding; within-note collisions suffixed '#2'…
 *  Deterministic: re-stamping stored findings yields identical refs. */
/** Formulary-INDEPENDENT molecule class sets (Q/R). Ingredient-level, so a molecule inside an
 *  FDC/topical is recognised even when the parsed "primary" generic is something else. */
export const NSAID_MOLECULES = ['diclofenac','aceclofenac','ibuprofen','naproxen','etoricoxib','etodolac','ketoprofen','dexketoprofen','piroxicam','meloxicam','lornoxicam','aspirin','acetylsalicylic','indomethacin','ketorolac','flurbiprofen','mefenamic','nimesulide','celecoxib','paracoxib','tolfenamic','nabumetone'];
export const MUSCLE_RELAXANT_MOLECULES = ['chlorzoxazone','thiocolchicoside','tizanidine','cyclobenzaprine','baclofen','methocarbamol','carisoprodol','tolperisone','eperisone'];
/** the molecules on a med line, from the full composition (resolvedGeneric || generic), lowercased. */
export function medMolecules(m: { resolvedGeneric?: string; generic?: string }): string[] {
  return (m.resolvedGeneric || m.generic || '').toLowerCase().split(/[+/,]/).map((t) => t.trim()).filter(Boolean);
}
export function medHasMoleculeFrom(m: { resolvedGeneric?: string; generic?: string }, set: string[]): boolean {
  const mols = medMolecules(m);
  return set.some((n) => mols.some((tok) => tok.includes(n)));
}

/** BUG-0.8-16: the bracketed drug-class tags are CDMSS's own formulary enrichment, not the
 *  clinician's chart. When they are wrong (0.8-15) the LLM sometimes flags "the record has an
 *  inaccurate drug class" and scores it against the DOCTOR — penalising the clinician for OUR
 *  metadata bug. A class-label error is chart metadata, not a care decision (Part 1 rule), and
 *  doubly so when it is our metadata. Neutralise such findings: keep them VISIBLE but make them
 *  non-scoring (informational) and tag them `metadata_accuracy`. */
const META_ACCURACY_RE = /(?:inaccurate|incorrect|erroneous|wrong|misclassif|misleading|data quality|error)[^.]*\bdrug class\b|\bdrug class\b[^.]*(?:inaccurate|incorrect|erroneous|wrong|misclassif|misleading|error)/i;
const CODING_GAP_RE = /(?:missing|absent|no|add|assign|map|include)[^.]*\bicd(?:[- ]?10)?\b|\bicd(?:[- ]?10)?\b[^.]*(?:code|mapping|missing|absent)|coding (?:gap|completeness|error|omission)|\bcode (?:is )?(?:not )?(?:documented|assigned|mapped|present)|should be coded|uncoded diagnosis/i;
// BUG-0.81.8-10 (Decision 3): a niche PRE-ANALYTIC interference omission (biotin before a thyroid/troponin
// immunoassay, etc.) is not a note-quality gap — reserve appropriateness penalties for a documented risk
// lacking a safeguard. Surface it for awareness, never dock the score.
const PRETEST_NICHE_RE = /biotin[^.]*(?:thyroid|tsh|troponin|assay|immunoassay|interfere)|(?:thyroid|tsh|troponin)[^.]*biotin[^.]*(?:interfere|hold|stop|cease)|biotin interference|hold biotin|(?:fasting|water deprivation) (?:not|un)(?:documented|mentioned|specified)/i;
export function neutralizeMetadataFindings(findings: OpdFinding[]): OpdFinding[] {
  return findings.map((f) => {
    if (f.source !== 'llm') return f;
    const hay = `${f.subject} ${f.rationale || ''}`;
    // BUG-0.8-16: our own drug-class metadata errors are never a clinician penalty.
    if (META_ACCURACY_RE.test(hay)) return { ...f, informational: true, signal_type: 'metadata_accuracy' };
    // Part 1: a pure ICD/coding-completeness gap is chart metadata, not a care decision → non-scoring.
    if (CODING_GAP_RE.test(hay)) return { ...f, informational: true, signal_type: 'coding_completeness' };
    // BUG-0.81.8-10: niche pre-analytic keyword omission → informational (only for an appropriateness
    // over-flag; a genuine prescribing-safety issue that happens to mention these words is untouched).
    if (f.domain === 'appropriateness' && PRETEST_NICHE_RE.test(hay)) return { ...f, informational: true, signal_type: 'pretest_niche' };
    return f;
  });
}

// BUG-0.81.8-2 (Decision 4): an institutional health-check / screening PACKAGE prescribes a fixed protocol
// panel — flagging its included investigations as "unindicated / low-value" penalises the clinician for the
// package design, not a care decision. When the encounter is a health-check package, neutralise appropriateness
// low-value/context findings that critique the screening tests. Context-gated (the allow-list), so a normal
// consult's genuine over-investigation finding is untouched. Pure: the boolean is computed by the caller.
const SCREENING_FINDING_RE = /\b(screen(?:ing)?|health\s?check|preventive|routine|wellness|check[\s-]?up|panel|profile|package)\b/i;
export function neutralizeScreeningContext(findings: OpdFinding[], isHealthCheckEncounter: boolean): OpdFinding[] {
  if (!isHealthCheckEncounter) return findings;
  return findings.map((f) => {
    if (f.source !== 'llm' || f.informational) return f;
    if (f.domain === 'appropriateness' && (f.verdict === 'low-value' || f.verdict === 'context-dependent')
        && SCREENING_FINDING_RE.test(`${f.subject} ${f.rationale || ''}`)) {
      return { ...f, informational: true, signal_type: 'screening_context' };
    }
    return f;
  });
}

/** BUG-0.81.8-2: is this encounter an institutional health-check / preventive-screening package? Reads the
 *  reason/consult-type/complaints allow-list. Pure (no side effects). */
const HEALTHCHECK_CTX_RE = /\b(health\s?check|master health|preventive health|preventive (?:screen|checkup)|wellness (?:package|checkup|profile)|annual health|executive (?:health|checkup)|screening package|whole body checkup|full body checkup|health package)\b/i;
export function isHealthCheckEncounter(c: DeidOpdCase): boolean {
  const hay = [c.reasonForConsult || '', c.consultType || '', ...(c.consultTypes || []), ...c.presentingComplaints, ...c.impressions].join(' ');
  return HEALTHCHECK_CTX_RE.test(hay);
}

// Antibiotic vocabulary — read by noAntibioticClassOnNote and stampDirection check 1 (§1.2).
// ANTIBIOTIC_TEXT_RE matches a finding's prose; ANTIBIOTIC_CLASS_RE matches the formulary's
// therapeuticClass/subClass strings (which additionally say "anti-infective").
// The contradicted-by-structure neutraliser that once shared these was REMOVED in 0.81.19 —
// all eight of its arms measured zero correct suppressions on 400 live findings (V, 1 Aug 2026).
const ANTIBIOTIC_TEXT_RE = /\banti[- ]?(?:biotic|microbial|bacterial)\b/i;
const ANTIBIOTIC_CLASS_RE = /anti[- ]?(?:biotic|microbial|bacterial|infective)/i;

// ── direction derivation (phase 3a, ruling R-5 / bugs 5b + 7c) ────────────────────────────────
//
// ⚠️ THE concept_id PREFIX IS NOT TRUSTWORTHY ON ITS OWN. MEASURED: bug 7c carries
// `concept_id: overuse:antibiotic therapy:antibiotic` on content that recommends STARTING an
// antibiotic — the prefix is model-generated free text and there it is the opposite of the
// content. A direction derived from it alone would confidently mislabel that finding as overuse
// and leave the antimicrobial statistics corrupted while APPEARING fixed.
//
// Two ORDERED checks (§1.2; the former check 2, coherence, died with the contradicted-by-structure
// neutraliser in 0.81.19 — nothing sets `incoherent_with_suggestion` any more):
//   1 class-absence — a finding asserting overuse of a class no medication carries is not overuse;
//   2 prefix — only when class-absence raises no objection may the concept_id prefix set direction.
const UNDERUSE_PREFIX_RE = /^\s*underuse\s*:/i;
const OVERUSE_PREFIX_RE = /^\s*overuse\s*:/i;

/** ONE implementation of "no antibiotic class on this note" (stampDirection check 1). */
export function noAntibioticClassOnNote(c: DeidOpdCase): boolean {
  return !c.medications.some((m) => ANTIBIOTIC_CLASS_RE.test(`${m.therapeuticClass || ''} ${m.subClass || ''}`));
}

/**
 * Stamp `direction` on LLM findings. Pure; runs BEFORE stampLvcMetadata (which gates on the
 * result). Never touches verdict/domain/confidence/text, and never sets a direction it cannot
 * justify — absent is the honest default.
 */
export function stampDirection(findings: OpdFinding[], c: DeidOpdCase): OpdFinding[] {
  const classAbsent = noAntibioticClassOnNote(c);
  return findings.map((f) => {
    if (f.source !== 'llm') return f;
    const conceptId = String((f as { concept_id?: unknown }).concept_id ?? '');
    // 1 · class-absence — an "overuse" claim about a class the note does not carry is not overuse.
    //     Such findings now SCORE (the neutraliser that marked them informational is gone, 0.81.19);
    //     this check only withholds the overuse LABEL, so they stay out of the stewardship counts.
    if (OVERUSE_PREFIX_RE.test(conceptId) && classAbsent && ANTIBIOTIC_TEXT_RE.test(`${f.subject} ${f.rationale || ''}`)) {
      return f;
    }
    // 2 · prefix — now, and only now, trustworthy enough to label.
    if (UNDERUSE_PREFIX_RE.test(conceptId)) return { ...f, direction: 'underuse' };
    if (OVERUSE_PREFIX_RE.test(conceptId)) return { ...f, direction: 'overuse' };
    return f;
  });
}

/** BUG-0.8-12: one clinical decision → one SCORED finding, ACROSS sources. Fix N ("one issue, one
 *  finding") was prompt-only, so it never merged a DETERMINISTIC DDI finding with the LLM's own
 *  therapeutic-duplication finding for the same drug pair — both fired and the decision was
 *  penalised twice. This consolidates them deterministically. v1 = concurrent-NSAID overlap
 *  (oral+topical or oral+oral): keep the rule-based interaction finding (defensible, cited),
 *  drop the LLM duplication that restates it. Extensible to other decision concepts. */
const NSAID_RE = /nsaid|non[- ]?steroidal/i;
const NSAID_DUP_RE = /duplicat|concurrent|both (?:an? )?(?:oral|nsaid)|oral and topical|two nsaid|overlap/i;
export function consolidateDecisions(findings: OpdFinding[]): OpdFinding[] {
  const txt = (f: OpdFinding) => `${f.subject} ${f.rationale || ''}`;
  const dropped = new Set<OpdFinding>();
  // 0.8-12: concurrent-NSAID overlap — keep the deterministic interaction, drop the LLM duplication.
  const detInteraction = findings.find(
    (f) => f.source === 'deterministic' && f.domain === 'prescribing_safety'
      && /^interaction \(/i.test(f.subject) && NSAID_RE.test(txt(f)));
  if (detInteraction) {
    let merged = false;
    for (const f of findings) {
      if (f === detInteraction) continue;
      if (f.source === 'llm' && f.domain === 'prescribing_safety'
          && NSAID_RE.test(txt(f)) && NSAID_DUP_RE.test(txt(f))) { dropped.add(f); merged = true; }
    }
    if (merged) detInteraction.rationale = `${detInteraction.rationale} Concurrent-NSAID therapeutic duplication is the same clinical decision — consolidated into this finding.`.trim();
  }
  // 0.8-11 (R): a deterministic muscle-relaxant finding supersedes the LLM volatile objection.
  const detMR = findings.find(
    (f) => f.source === 'deterministic' && f.domain === 'appropriateness' && /muscle relaxant/i.test(f.subject));
  if (detMR) {
    for (const f of findings) {
      if (f === detMR) continue;
      if (f.source === 'llm' && /muscle[- ]?relaxant/i.test(txt(f))) dropped.add(f);
    }
  }
  return dropped.size ? findings.filter((f) => !dropped.has(f)) : findings;
}

// Engine 0.81.10 (SIGNAL-TYPE-COLLAPSE §5.1): the low-value collapse now flattens ONLY the generic
// domain×verdict LVC buckets — a specific deterministic/keyword type is RETAINED. The banned_fdc
// special case (C4) is absorbed into this general rule: 'banned_fdc' is not a generic bucket, so it is
// kept without a named exception. These are exactly the two signal types opdSignalType produces for a
// low-value finding that matched NO precise SIGNAL_TYPE_RULES (see VERDICT_CLASS → `${domain}_low_value`).
const GENERIC_LVC_BUCKETS = new Set(['appropriateness_low_value', 'prescribing_low_value']);

/**
 * LAB-MCP Phase 1 (F1): additionally stamps `stable_ref` — a content-addressed FINDING-KIND token
 * that SURVIVES a re-audit, unlike finding_ref (positional, collision-suffixed, re-derived per audit).
 *
 * SIGNATURE UNCHANGED (addendum A1): no uid parameter. stable_ref = sha1(signal_type ␁ norm(subject)),
 * so it is unique WITHIN a note, not globally — the same finding kind on two notes shares a ref by
 * design. Note scoping happens at resolution, where resolveLabel takes uid as a REQUIRED parameter.
 * All 9 existing call sites are unchanged and now stamp stable_ref automatically.
 *
 * computeStableRef is imported from lib/opd-finding-identity-core — ONE implementation, shared with
 * the backfill route, so engine-stamped and backfilled refs are byte-identical by construction.
 *
 * EXISTING finding_ref BEHAVIOUR IS UNCHANGED — same signal_type collapse, same 12-char hash, same
 * within-note "#2" collision suffixing, same ordering. stable_ref is purely additive metadata and
 * feeds no score: computeOpdScore reads only (verdict, confidence, domain).
 */
export function stampFindingIdentity(findings: OpdFinding[]): OpdFinding[] {
  const used = new Set<string>();
  return findings.map((f) => {
    // Engine 0.81.3 (RIGHT-CARE §5) batched all low-value care under one signal_type for CM triage.
    // 0.81.10 (SIGNAL-TYPE-COLLAPSE) GENERALISES the exception: compute the finding's specific type
    // first, and collapse to the unified low_value_care bucket ONLY when that type is itself a generic
    // domain×verdict LVC bucket (a free-text LLM low-value finding). A precise deterministic/keyword type
    // — drug_interaction, dose_ceiling_exceeded, duplicate_prescription, banned_fdc, … — is RETAINED so it
    // keeps its identity, provenance tier and (0.81.9) citation instead of being flattened. This fixes the
    // mechanism (three checks' worth of findings were silently losing their type) rather than adding a
    // second special case beside the banned_fdc patch. Score-invariant: signal_type never feeds scoring.
    const specific = opdSignalType(f.subject, f.domain, { verdict: f.verdict });
    const signal_type = (f.verdict === 'low-value' && GENERIC_LVC_BUCKETS.has(specific))
      ? 'low_value_care'
      : specific;
    const colon = f.subject.indexOf(':');
    const detail = (colon >= 0 ? f.subject.slice(colon + 1) : f.subject).trim().toLowerCase().replace(/\s+/g, ' ');
    const base = sha1Hex(`${signal_type}|${detail}`).slice(0, 12);
    let ref = base;
    for (let n = 2; used.has(ref); n++) ref = `${base}#${n}`;
    used.add(ref);
    // F1: ALWAYS stamped (addendum A1) — no uid parameter, no conditional. An earlier draft made
    // uid optional and stamped only when supplied; since all 9 call sites pass findings alone, that
    // would have shipped F1 as a silent no-op (addendum A4). computeStableRef returns null only when
    // signal_type or the normalised subject is empty, and the key is then omitted rather than nulled.
    const stable = computeStableRef(signal_type, f.subject);
    return stable
      ? { ...f, signal_type, finding_ref: ref, stable_ref: stable }
      : { ...f, signal_type, finding_ref: ref };
  });
}

/**
 * Structured NABH status vocabulary, matching the IPD side (lib/doc-audit-core.ts `FieldStatus`).
 *
 * ⚠️ THE OPD ENGINE PRODUCES ONLY `present` AND `missing`. Its checks are deterministic booleans
 * over structured EMR fields — there is no partial credit and no not-applicable to express, because
 * a field that does not apply (a physical examination on a teleconsult, the obstetric fields on a
 * GP note) is simply NOT EMITTED rather than emitted as `na`. `partial` and `na` are in the type so
 * the shape matches IPD's exactly and so the weighted-completeness core needs no OPD special case;
 * they are not reachable from this engine today. Do NOT synthesise them.
 */
export type OpdFieldStatus = 'present' | 'partial' | 'missing' | 'na';

/**
 * ADDITIVE (Scoring policy PRD §2.10). `status`, `section` and `note` are NEW; `present` and
 * `mandatory` are UNCHANGED and every existing reader keeps working. `status` is derived from
 * `present`, so the two can never disagree.
 *
 * `section` groups the field on the weightage screen: 'documentation' | 'obstetric' | 'continuity'.
 * The three continuity fields (advice_given, advice_instructions, follow_up) are scored in the
 * Continuity domain and are EXCLUDED from the completeness weight vector — that exclusion lives in
 * lib/scoring-policy/weights.ts, and `section` is what makes it legible here.
 */
export interface OpdCompletenessItem {
  key: string;
  label: string;
  present: boolean;
  mandatory: boolean;
  status?: OpdFieldStatus;
  section?: 'documentation' | 'obstetric' | 'continuity';
  note?: string;
}
export interface OpdCompleteness {
  items: OpdCompletenessItem[];
  coverage: number;                          // 0..1 over applicable items
  missing: string[];
  patientCentred: { present: number; total: number };
}

/** Which section each emitted key belongs to. Keys are the engine's own (see below). */
const OPD_ITEM_SECTION: Record<string, 'documentation' | 'obstetric' | 'continuity'> = {
  presenting_complaint: 'documentation', diagnosis: 'documentation', medication_dosing: 'documentation',
  examination: 'documentation', vitals: 'documentation', investigations: 'documentation',
  ga_pog: 'obstetric', lmp_edd: 'obstetric', gravidity_parity: 'obstetric', obstetric_vitals: 'obstetric',
  advice_given: 'continuity', follow_up: 'continuity', advice_instructions: 'continuity',
};

/**
 * Stamp the structured fields onto an item list. PURE and total: it only ADDS `status`/`section`,
 * so calling it twice is a no-op and an unknown key still gets a status (defaulting its section to
 * 'documentation', the conservative choice — a mis-sectioned field is visible on the screen, a
 * dropped one is not).
 */
export function withOpdFieldStatus(items: OpdCompletenessItem[]): OpdCompletenessItem[] {
  return items.map((i) => ({
    ...i,
    status: (i.status ?? (i.present ? 'present' : 'missing')) as OpdFieldStatus,
    section: i.section ?? OPD_ITEM_SECTION[i.key] ?? 'documentation',
  }));
}
export interface OpdSuggestion { priority: number; text: string }

// ── Dose / route resolution (0.5 calibration) ─────────────────────────────────
// The EMR's medication fields are entered inconsistently: the strength is frequently embedded in
// the drug NAME ("Cefix 200mg Tab", `strength` field empty ~36%) and `route_of_administration` is
// blank ~17% but is obvious from the dosage form. Reading the fields literally false-flagged ~1/3
// of otherwise-complete notes as "incomplete dosing". These pure helpers read what the note ACTUALLY
// documents (field OR name OR inferred form); only a route that can be neither read nor inferred,
// and an amount that appears nowhere, are treated as real gaps.
const STRENGTH_RE = /\b\d+(?:\.\d+)?\s?(?:mg|mcg|µg|ug|g|ml|iu|units?|meq|lac|lakh|k)\b/i;

/** Dose/amount is documented if it's in the `dosage` field, the `strength` field, or embedded in
 *  the drug name (e.g. "Cefix 200mg Tab"). */
export function medDoseDocumented(m: OpdMed): boolean {
  // v0.81 (BUG-0.8-01): for a parenteral/injectable med a concentration (mg/ml) in `strength` is
  // NOT a documented dose — require an explicit dose amount. For oral/other forms, strength counts.
  if (m.dose && m.dose.trim()) return true;                 // an explicit dose always counts
  if (resolveMedRoute(m) === 'parenteral') return false;    // injectable w/ no dose → incomplete
  if (m.strength && m.strength.trim()) return true;         // non-injectable: strength counts
  return STRENGTH_RE.test(`${m.brand || ''} ${m.generic || ''}`);
}

const ROUTE_RULES: { re: RegExp; route: string }[] = [
  { re: /\b(inj|injection|vial|amp(?:oule)?|iv|im|s\/?c|subcut|parenteral)\b/i, route: 'parenteral' },
  { re: /\b(inhaler|rotacap|rotahaler|respule|neb(?:uli[sz]er?|ule)?|mdi|puff|inhalation)\b/i, route: 'inhaled' },
  { re: /\b(eye|ophthalmic|ocular)\b/i, route: 'ophthalmic' },
  { re: /\b(ear|otic)\b/i, route: 'otic' },
  { re: /\b(nasal|nostril|intranasal)\b/i, route: 'nasal' },
  { re: /\b(supp(?:ository)?|rectal|per\s?rectum|pr)\b/i, route: 'rectal' },
  { re: /\b(pessary|vaginal|per\s?vagina|pv)\b/i, route: 'vaginal' },
  { re: /\b(cream|ointment|gel|lotion|topical|patch|transderm|ung|apply|local(?:ly)?)\b/i, route: 'topical' },
  { re: /\b(tab(?:let)?s?|cap(?:sule)?s?|syr(?:up)?|susp(?:ension)?|solution|oral|po|sachet|powder|granule|lozenge|chewable|drops?)\b/i, route: 'oral' },
];

/** The documented route, else one inferred from the dosage form in the name/dose/instruction.
 *  Null ONLY when the route is truly ambiguous (no field + no inferable form) — that is a real gap. */
export function resolveMedRoute(m: OpdMed): string | null {
  if (m.route && m.route.trim()) return m.route.trim();
  const hay = `${m.brand || ''} ${m.generic || ''} ${m.dose || ''} ${m.instruction || ''}`;
  for (const r of ROUTE_RULES) if (r.re.test(hay)) return r.route;
  return null;
}

// ── Follow-up documentation (bug B2) ──────────────────────────────────────────
// The EMR stamps a followUpType enum on nearly every note, but 'UNKNOWN' (and blank) means the
// clinician left follow-up UNSPECIFIED — it must NOT count as a documented follow-up. Real
// dispositions (IF_REQUIRED, MANDATORY_FOLLOW_UP, FOLLOW_UP_WITH_REPORTS, …) DO count even without a
// date; an explicit date always counts. This is what stops Continuity = 100 on a blank follow-up.
export function followUpDocumented(c: DeidOpdCase): boolean {
  if (c.followUpDateSet) return true;                       // an explicit date is a documented plan
  // v0.81 (BUG-0.8-03): a formal onward referral is a documented care transition — it satisfies
  // continuity even without a calendar date (previously scored as "UNKNOWN · no date" → false).
  if ((c.referrals?.length ?? 0) > 0) return true;
  const t = (c.followUpType || '').trim().toUpperCase();
  if (!t || t === 'UNKNOWN' || t === 'NONE') return false;  // blank / UNKNOWN = not specified
  return true;                                              // any real disposition counts
}

// ── Deterministic NABH-OPD completeness (from the structured row) ─────────────
// v0.81.1 FIX K (BUG-0.8-06a): presentation-aware vitals. A febrile presentation needs objective
// vitals (at least a temperature); an in-person note that documents none is a real gap (previously
// scored 100). Conservative: any documented vital (temp/BP/pulse/'afebrile'/'vitals') counts as present,
// and the requirement only applies IN-PERSON (a teleconsult can't take vitals).
const NEEDS_VITALS_RE = /\b(fever|febrile|feverish|pyrexia|temperature)\b/i;
const VITALS_DOCUMENTED_RE = /(\b\d{2,3}(?:\.\d)?\s*°?\s*[fc]\b|afebrile|\btemp\b|\bvitals?\b|\bB\.?P\b|\bpulse\b|\bSpO2\b|\bHR\b)/i;
export function presentationNeedsVitals(c: DeidOpdCase): boolean {
  return [...c.presentingComplaints, ...c.history, c.reasonForConsult || ''].some((t) => NEEDS_VITALS_RE.test(t || ''));
}
export function vitalsDocumented(c: DeidOpdCase): boolean {
  return [...c.examination, ...c.history].some((t) => VITALS_DOCUMENTED_RE.test(t || ''));
}

// ── Obstetric-template completeness (CDMSS-OBGYN-TEMPLATE-EXTRACTION-FIX §8 decision 3) ─────────────
// db13's obstetric visit_notes has NO structured BP field (§9), so blood pressure is detected from the
// symptoms/examination narrative (best-effort; flagged for a live-confirmed BP column). Matches "BP",
// "blood pressure", or a "120/80" reading.
const BP_DOCUMENTED_RE = /\bB\.?\s?P\.?\b|blood\s*pressure|\b\d{2,3}\s*\/\s*\d{2,3}\b/i;
export function bpDocumented(c: DeidOpdCase): boolean {
  return [...c.examination, ...c.presentingComplaints, ...c.history].some((t) => BP_DOCUMENTED_RE.test(t || ''));
}
// An Indian "1-0-1 / 0-0-1 / 1-1-1" dosing schedule encodes frequency even when the `frequency` field
// is blank (§9). Used ONLY on the obstetric dosing check — GP behaviour is untouched.
const DOSE_SCHEDULE_RE = /(?:^|[^\d])[0-9½x]\s*[-–]\s*[0-9½x]\s*[-–]\s*[0-9½x](?:[^\d]|$)/i;
/** Obstetric dosing complete: amount documented + (a frequency field OR a schedule) + a resolvable route. */
export function obstetricDosingComplete(m: OpdMed): boolean {
  const hasFreq = !!(m.frequency && m.frequency.trim()) || DOSE_SCHEDULE_RE.test(`${m.dose || ''} ${m.frequency || ''} ${m.instruction || ''}`);
  return medDoseDocumented(m) && hasFreq && resolveMedRoute(m) !== null;
}

/** Obstetric-aware mandatory-field set (§8 decision 3). 8 fields; SFH/FHR/presentation folded into the
 *  exam/vitals field and required only in the 2nd/3rd trimester. Same OpdCompleteness shape; follow-up is
 *  the Continuity (patient-centred) subset, mirroring the GP path. Pure. */
function opdCompletenessObstetric(c: DeidOpdCase): OpdCompleteness {
  const o = c.obstetric!;
  const hasMeds = c.medications.length > 0;
  const dosingComplete = hasMeds && c.medications.every((m) => obstetricDosingComplete(m));
  const secondOrThird = o.trimester === 2 || o.trimester === 3;
  const fetalOk = secondOrThird ? (o.sfhDocumented || o.fhrDocumented || o.presentationDocumented) : true;
  // §11 / decision 3-bis: db13 obstetric rows carry NO structured BP (0/45 live), so BP is credited when
  // it appears in the narrative but is NEVER mandatory/failing. Maternal weight is the always-required
  // obstetric vital; fetal params stay trimester-conditional (T2/3 ⇒ ≥1 of SFH/FHR/presentation).
  const bp = bpDocumented(c);
  const vitalsOk = o.weightDocumented && fetalOk;
  const items: OpdCompletenessItem[] = [
    { key: 'ga_pog', label: 'Gestational age / POG', present: o.gaDocumented, mandatory: true },
    { key: 'lmp_edd', label: 'LMP and/or EDD', present: o.lmpOrEddDocumented, mandatory: true },
    { key: 'gravidity_parity', label: 'Gravidity & parity', present: o.gravidityParityDocumented, mandatory: true },
    { key: 'presenting_complaint', label: 'Presenting complaint / symptoms', present: c.presentingComplaints.length > 0 || !!c.reasonForConsult, mandatory: true },
    { key: 'obstetric_vitals', label: `Obstetric exam / vitals (weight${secondOrThird ? ' + fetal SFH/FHR/presentation' : ''}${bp ? ' · BP recorded' : ''})`, present: vitalsOk, mandatory: true },
    { key: 'medication_dosing', label: 'Complete medication dosing', present: hasMeds ? dosingComplete : true, mandatory: true },
    { key: 'investigations', label: 'Investigations ordered/reviewed or nil', present: c.investigations.length > 0, mandatory: true },
    { key: 'follow_up', label: 'Follow-up specified', present: followUpDocumented(c), mandatory: true },
  ];
  // Follow-up is scored in the Continuity domain, not Documentation coverage — mirror the GP path.
  const pc = ['follow_up'];
  const docItems = items.filter((i) => !pc.includes(i.key));
  const coverage = docItems.length ? docItems.filter((i) => i.present).length / docItems.length : 1;
  const missing = items.filter((i) => !i.present).map((i) => i.label);
  const pcItems = items.filter((i) => pc.includes(i.key));
  // ADDITIVE: structured status/section alongside the existing shape (Scoring policy PRD §2.10).
  return { items: withOpdFieldStatus(items), coverage, missing, patientCentred: { present: pcItems.filter((i) => i.present).length, total: pcItems.length } };
}

export function opdCompleteness(c: DeidOpdCase): OpdCompleteness {
  // Obstetric-template notes use the obstetric-aware mandatory set (§8 decision 3). `isObstetric` is set
  // by rowToOpdCase ONLY when the OBSTETRIC_EXTRACTION_ENABLED flag is on, so with the flag off this
  // branch is never taken and every GP/other note is byte-identical to today.
  if (c.isObstetric && c.obstetric) return opdCompletenessObstetric(c);
  const hasMeds = c.medications.length > 0;
  // Complete dosing = an amount is documented (field or in the name) + a frequency + a route that is
  // documented OR inferable from the form. Route that can't be inferred at all remains a real gap.
  const dosingComplete = hasMeds && c.medications.every((m) => medDoseDocumented(m) && !!m.frequency && resolveMedRoute(m) !== null);
  // NABH-OPD items we can actually observe in this EMR's structured data. Allergy is never
  // stored at the prescription level (always empty) and history is folded into the presenting
  // complaint / HPI, so both were removed (they were false-flagging ~100% of notes).
  // 0.6 — the "plan" is satisfied by a clinician plan OR an onward referral (a referral handoff's
  // plan IS the referral). Examination is only expected for IN-PERSON encounters; for a teleconsult
  // a physical exam is not applicable, so it is not scored (rather than silently counting as met).
  const hasPlan = c.advice.length > 0 || (c.referrals?.length ?? 0) > 0;
  const isTele = c.isTeleconsult === true;
  const items: OpdCompletenessItem[] = [
    { key: 'presenting_complaint', label: 'Presenting complaint', present: c.presentingComplaints.length > 0 || !!c.reasonForConsult, mandatory: true },
    { key: 'diagnosis', label: 'Diagnosis / impression', present: c.diagnosisCodes.length > 0 || c.impressionCodes.length > 0 || c.impressions.length > 0, mandatory: true },
    { key: 'medication_dosing', label: 'Complete medication dosing', present: hasMeds ? dosingComplete : true, mandatory: true },
    { key: 'advice_given', label: 'Advice / plan', present: hasPlan, mandatory: true },
    { key: 'follow_up', label: 'Follow-up specified', present: followUpDocumented(c), mandatory: true },
  ];
  // Physical examination — applicable only to in-person encounters (a teleconsult can't examine).
  if (!isTele) items.push({ key: 'examination', label: 'Examination recorded', present: c.examination.length > 0, mandatory: true });
  // v0.81.1 FIX K: presentation-required vitals (in-person febrile note must record vitals).
  if (!isTele && presentationNeedsVitals(c)) items.push({ key: 'vitals', label: 'Vitals for the presentation (e.g. temperature for fever)', present: vitalsDocumented(c), mandatory: true });
  // 0.8 — score each field ONCE. Advice + follow-up stay on the checklist (display, missing-fields,
  // mandatory tracking) but are EXCLUDED from the Documentation coverage denominator: they are scored
  // in the Continuity domain. Before 0.8 they counted in BOTH domains (2 of 5–6 completeness items
  // ×0.25 weight + the whole patient_centred domain ×0.10) — a hidden double-weighting.
  const pc = ['advice_given', 'follow_up'];
  const docItems = items.filter((i) => !pc.includes(i.key));
  const present = docItems.filter((i) => i.present).length;
  const coverage = docItems.length ? present / docItems.length : 1;
  const missing = items.filter((i) => !i.present).map((i) => i.label);
  // Continuity / patient-centred subset (advice + follow-up).
  const pcItems = items.filter((i) => pc.includes(i.key));
  return {
    // ADDITIVE: structured status/section alongside the existing shape (Scoring policy PRD §2.10).
    items: withOpdFieldStatus(items),
    coverage,
    missing,
    patientCentred: { present: pcItems.filter((i) => i.present).length, total: pcItems.length },
  };
}

const dedupCI = (a: string[]): string[] => {
  const seen = new Set<string>(); const out: string[] = [];
  for (const x of a) { const k = x.toLowerCase(); if (x && !seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
};
function det(subject: string, verdict: NetValue, confidence: number, rationale: string, informational = false): OpdFinding {
  return { subject, verdict, confidence, domain: 'prescribing_safety', rationale, evidence: [], estimates: [], citation_ids: [], source: 'deterministic', ...(informational ? { informational: true } : {}) };
}

// Deterministic-Citations (PRD §5.3/§11.1, V-signed-off 22 Jul): ISMP high-alert provenance for the
// combined high-alert roll-up. The OPD population is dominated by oral hypoglycemics + insulin +
// oral methotrexate — all named classes on the ISMP Community/Ambulatory list. Mifepristone/
// Misoprostol are local additions (llm). Everything else (Tacrolimus, oral MgSO4, theophylline,
// colchicine, the glucosamine/multivitamin defects) carries NO provenance and stays uncited pending
// pharmacy or the separate defect build. NO corpus retrieval — a direct reference to the named list.
const ISMP_COMMUNITY_LIST = 'ISMP High-Alert Medications in Community/Ambulatory Care Settings (2021)';
const ISMP_COMMUNITY_RE = /glimepiride|gliclazide|glipizide|glibenclamide|glyburide|\binsulin\b|methotrexate/i;
const ISMP_LOCAL_ADDITION_RE = /mifepristone|misoprostol/i;
function highAlertProvenance(genericNames: string[]): FindingProvenance | undefined {
  const joined = genericNames.join(' ').toLowerCase();
  if (ISMP_COMMUNITY_RE.test(joined)) {
    return { citation: { source: 'ismp', book: ISMP_COMMUNITY_LIST, chapter: 'Specific medications', section: 'Insulin / oral hypoglycemics / oral methotrexate', page_start: null, page_end: null }, derivation: 'external' };
  }
  if (ISMP_LOCAL_ADDITION_RE.test(joined)) return { citation: null, derivation: 'llm' };
  return undefined;   // pending pharmacy / defect → stays uncited_deterministic
}

// ── 0.81.14 Ruling 2 (CLINICAL-RULINGS §2.2) — molecule-level high-alert exclusions ───────────────────
// `high_risk` is a formulary CLASS flag (register A-1), so a joint supplement (glucosamine "…potassium
// chloride"), a multivitamin/multimineral/amino-acid blend, and ORAL magnesium sulphate all inherit the
// high-alert flag by ACCIDENT — none carries a single high-alert molecule (ISMP's high-alert magnesium is
// the INJECTABLE). This is a MOLECULE/COMPOSITION + route predicate (NOT a 3-name suppression list), so
// the next name-collision does not recur. Consulted before a med contributes a high_alert_medication
// finding. INJECTABLE magnesium sulphate still fires. Fail-safe: only excludes what the predicate matches.
const HIGH_ALERT_SUPPLEMENT_RE = /glucosamine|chondroitin|multivitamin|multi[\s-]?mineral|amino[\s-]?acid|isoflavon|grape[\s-]?seed/i;
const MAGNESIUM_SULPHATE_RE = /magnesium\s+(?:sulphate|sulfate)/i;
export function isHighAlertExcluded(m: OpdMed): boolean {
  const comp = `${m.resolvedGeneric || ''} ${m.generic || ''} ${m.brand || ''}`.toLowerCase();
  // (a) glucosamine salts + multivitamin/multimineral/amino-acid blends — no single high-alert molecule.
  if (HIGH_ALERT_SUPPLEMENT_RE.test(comp)) return true;
  // (b) ORAL magnesium sulphate (a laxative); the INJECTABLE stays high-alert (route not resolving oral).
  if (MAGNESIUM_SULPHATE_RE.test(comp)) {
    const route = (resolveMedRoute(m) || '').toLowerCase();
    if (route === 'oral' || /\b(oral|po|mouth)\b/.test(route)) return true;
  }
  return false;
}

// ── Deterministic rational-prescribing checks (from the medications array) ─────
// Uses the formulary-RESOLVED generic where the note gave only a brand, so brand-only lines
// finally dedupe and stop false-flagging. Formulary safety facts (ISMP high-alert, Schedule X,
// LASA pairs, off-formulary items) surface as findings; the purely-informational ones carry
// `informational` + confidence 0 so they inform without ever penalising the score.
// BUG-0.81.8-7: off-formulary cosmetics carry no clinically meaningful "dose", so an incomplete-dosing
// gap on them is a false positive. Name heuristic for cosmetic/derm OTC lines (Decision 1 list).
const COSMETIC_NAME_RE = /\b(moisturi[sz]er|sunscreen|sun\s?block|face\s?wash|cleansing bar|cleanser|emollient|serum|shampoo|soap|lotion base|lip balm|body wash|scrub|toner)\b/i;

export function prescribingChecks(c: DeidOpdCase): OpdFinding[] {
  const out: OpdFinding[] = [];
  const seen = new Map<string, { n: number; label: string }>();
  const highAlerts: string[] = [];
  const scheduleX: string[] = [];
  let nNonFormularyDrug = 0;
  let nNutraceutical = 0;

  for (const m of c.medications) {
    const gen = m.resolvedGeneric || m.generic;
    const name = gen || m.brand || 'medication';

    // brand-only AND unresolved: the note named a proprietary product the formulary couldn't
    // map. Flag only genuine drugs (nutraceuticals/cosmetics are rolled up informationally).
    if (!gen) {
      if (m.nonFormulary === 'nutraceutical-cosmetic') nNutraceutical++;
      else {
        nNonFormularyDrug++;
        // BUG-0.81.8-9 (unified 6/7/9): "unverified brand" is a formulary-coverage limitation on OUR side,
        // not a clinician prescribing error — the LLM routinely resolves the molecule the formulary couldn't.
        // Keep it VISIBLE for awareness but non-scoring (informational), so it stops penalising ~172 notes.
        out.push(det(`Unverified brand: ${m.brand || 'medication'}`, 'context-dependent', 0,
          'Prescribed by a brand not in the hospital formulary and not resolvable to a generic by our matcher — molecule, class and interactions could not be auto-verified (a coverage limitation, not necessarily a prescribing error). NABH expects generic naming.', true));
      }
    }

    // BUG-0.8-14 + 0.81.8 unified 6/7/9: exempt "incomplete dosing" for off-formulary cosmetics/
    // supplements/unresolved-proprietary lines — a nutraceutical/cosmetic has no clinically meaningful
    // "dose", and an UNRESOLVED brand (no `gen`) can't be assessed for dosing at all AND is already
    // surfaced as an unverified/off-formulary item, so faulting its dose double-stacks the same one line
    // (Decision 1 consolidation). A RESOLVED real drug missing its dose STILL scores (the check below).
    const isDoseExempt = !gen                                                  // unresolved proprietary → can't assess; already surfaced
      || m.nonFormulary === 'nutraceutical-cosmetic'
      || /nutraceutical|supplement|multivitamin|vitamin|probiotic|cosmetic/i.test(m.therapeuticClass || '')
      || /\bsupplement\b/i.test(gen || '')
      || COSMETIC_NAME_RE.test(`${m.brand || ''} ${gen || ''}`);               // off-formulary cosmetic by name (Bug 7)
    // ── GAP-LEVEL exemptions (INCOMPLETE-DOSING-PRECISION PRD, V ruled DEC-1/2/3, 2 Aug 2026) ────
    // WHY: incomplete_dosing is the worst-performing signal doctors actually see — precision 0.22 at
    // 0.81.8, and doctors CONTESTED 14 of the 23 findings ever triaged. TWELVE OF THOSE FOURTEEN are
    // a combination product or a topical. V wrote the diagnosis himself on 13 Jul: "These are fixed
    // dose combinations and dosage is not a prerequisite if the drugs are in our formulary."
    // For a combination the PRODUCT fixes each component's strength; for a cream the strength and
    // the route ARE the dosage form. Asking the clinician to restate either is not a documentation
    // gap, so the GAP is dropped — not the finding (DEC-1). A combination or topical that also lacks
    // frequency or duration still fires on those, and isDoseExempt's wholesale suppression for
    // nutraceuticals / cosmetics / unresolved proprietary lines is untouched below.
    //
    // ⚠️ THIS IS THE FIRST MATCHER TO READ `dosageForm`. The field was plumbed in 0.81.11 and left
    // deliberately unread (changelog: score-invariant, max_nqi_delta 0); reading it here is the
    // source of this build's score change. It comes from the FORMULARY ROW's own `form` column
    // (lib/formulary.ts:139 → normalizeDosageForm), NEVER parsed from the clinician's free text —
    // so a doctor cannot widen or dodge this exemption by how they write the line.
    //
    // NOT extended to inhaler, injection, tablet, capsule, syrup or other: those carry real,
    // variable strengths and no contested row supports widening it (DEC-3).
    const isFormularyCombination = (gen || '').includes('+') && m.nonFormulary === undefined;
    const isTopicalOrDrops = m.dosageForm === 'topical' || m.dosageForm === 'drops';
    // DEC-2, deliberate: a combination the formulary does NOT know still gets the strength gap —
    // we cannot confirm what is in a product we cannot resolve.
    const strengthGapExempt = isFormularyCombination || isTopicalOrDrops;
    const routeGapExempt = isTopicalOrDrops;
    const gaps: string[] = [];
    if (!strengthGapExempt && !medDoseDocumented(m)) gaps.push('dose/strength');
    if (!m.frequency) gaps.push('frequency');
    if (!routeGapExempt && resolveMedRoute(m) === null) gaps.push('route');
    if (!m.duration) gaps.push('duration');
    if (gaps.length && !isDoseExempt) out.push(det(`Incomplete dosing: ${name}`, 'context-dependent', 0.5, `Missing ${gaps.join(', ')} — incomplete prescription (strength read from the drug name and route inferred from the dosage form where possible).`));

    if (gen) { const k = gen.toLowerCase(); const p = seen.get(k); seen.set(k, { n: (p?.n || 0) + 1, label: gen }); }
    if (gen && m.highAlert && !isHighAlertExcluded(m)) highAlerts.push(gen);   // 0.81.14 Ruling 2 — molecule-level exclusion of name-collision artifacts
    if (gen && m.schedule === 'X') scheduleX.push(gen);
  }

  for (const { n, label } of seen.values()) {
    if (n > 1) out.push(det(`Duplicate prescription: ${label}`, 'low-value', 0.7, `The same generic appears ${n} times on the prescription.`));
  }

  // NOTE: the lasa_pair check was DELETED here (0.81.12, Matcher-Scoping Audit Stage 2a, §6c). 0/88 live
  // findings were genuine look-alike/sound-alike name confusables — the formulary `lasa` column encodes
  // same-class therapeutic ALTERNATIVES, and LASA is a *dispensing* risk not observable in a prescribing
  // note. Do NOT reinstate it. The ~5 real duplications it accidentally caught (mono + FDC containing that
  // mono) remain visible via the dose-aggregation "same molecule in N products" roll-up (informational).
  // A SCORING molecule-subset duplicate check was trialled and REJECTED at dry run (Stage 2, 23 Jul): it
  // fired 82× (paracetamol-dominated common combinations), collided with dose-aggregation's deliberate
  // informational-within-ceiling policy, and moved 70 notes down. Any replacement is Stage 2b (dose-gated)
  // and must clear its own dry run — see CDMSS-MATCHER-STAGE2-DRYRUN-REPORT.

  // Informational formulary roll-ups (confidence 0 → never penalise the score).
  if (highAlerts.length) { const haProv = highAlertProvenance(highAlerts); out.push({ ...det(`High-alert medication${highAlerts.length > 1 ? 's' : ''}: ${dedupCI(highAlerts).join(', ')}`, 'uncertain', 0,
    'ISMP high-alert medication present — heightened harm potential if mis-prescribed/administered; confirm dose, monitoring and indication.', true), ...(haProv ? { provenance: haProv } : {}) }); }
  if (scheduleX.length) out.push(det(`Schedule X drug: ${dedupCI(scheduleX).join(', ')}`, 'uncertain', 0,
    'Schedule X (narcotic/psychotropic) present — requires the prescribed format and record-keeping controls under the D&C Rules.', true));
  if (nNonFormularyDrug || nNutraceutical) {
    const parts: string[] = [];
    if (nNonFormularyDrug) parts.push(`${nNonFormularyDrug} not in formulary`);
    if (nNutraceutical) parts.push(`${nNutraceutical} nutraceutical/cosmetic`);
    out.push(det(`Off-formulary items: ${parts.join('; ')}`, 'uncertain', 0,
      'Items prescribed outside the hospital drug formulary (retail brands / nutraceuticals / cosmetics) — informational; not assessed as formulary drugs.', true));
  }

  return out;
}

// ── LLM analyze pass (grounded) — findings + PDQI-9 + suggestions ─────────────
export const OPD_AUDIT_SYSTEM = `You are a clinical quality auditor reviewing a SINGLE outpatient (OPD) consultation note, given a DE-IDENTIFIED structured record of the encounter and NUMBERED EVIDENCE EXCERPTS [1], [2], … from a medical corpus. Produce an advisory, NON-DIRECTIVE note-quality audit. Do THREE things.

ENCOUNTER CONTEXT — read the header fields FIRST and let them frame everything:
   - TREATING SPECIALTY: if a treating clinician specialty is stated, judge appropriateness and prescribing against THAT specialty's standards where relevant — a specialist's note is expected to be focused and to use specialty-appropriate choices/adjuncts, and is NOT held to general-practice documentation breadth. Do not fault a specialist for a targeted, specialty-scoped note.
   - TELECONSULT: if the modality is teleconsult, a physical examination is not possible — never treat a missing examination as a gap and never lower "thorough" for it.
   - REFERRAL / HANDOFF: if the encounter refers the patient onward (e.g. to an in-person specialist) or the disposition/follow-up is a referral, it is a TRIAGE/HANDOFF, not a definitive-management episode. The plan IS the referral. Do NOT credit the absence of medications, investigations or imaging as a deliberate "high-value" choice, "avoidance", or "prudent restraint" — that framing is a category error for a handoff and must not appear as a high-value finding. Judge only what a good handoff needs: a clear reason for referral, a working diagnosis, and safety-netting.
   - PATIENT-EDUCATION MATERIAL: any attached templated self-care leaflet (generic exercises, video/YouTube links) is AUTO-GENERATED, not clinician-authored. Do NOT reward it in PDQI-9 thoroughness/useful/synthesized, and do not treat it as evidence of a rich plan. Grade only the clinician's own documentation.

1) FINDINGS — appropriateness and prescribing-safety issues for THIS encounter:
   - appropriateness: low-value / inappropriate tests, treatments or referrals for the presentation. DIAGNOSIS–COMPLAINT CONCORDANCE: check the documented diagnosis actually corresponds to the presenting complaint and to what was treated; if the coded diagnosis is unrelated to why the patient came (e.g. a chronic comorbidity is coded while an acute complaint drives the visit and the medications treat that acute problem), flag the mismatch as an appropriateness/documentation finding. UNINDICATED / CONTRADICTED DRUG: check EVERY prescribed drug has a plausible indication in THIS note; a drug whose indication is absent AND is positively contradicted by the documented history (e.g. a 2nd-gen antihistamine when the history records 'No cold' / no allergic symptom) is a low-value / unindicated prescription — raise it as an APPROPRIATENESS finding (domain 'appropriateness', verdict low-value), applied CONSISTENTLY to all drugs, not just the obvious ones. RATIFIED DETERMINISTIC RULES: where the engine already judges a class of decision deterministically and consistently, do NOT raise a separate finding about — and never contradict — that judgement; put your appropriateness attention elsewhere. Current members: muscle relaxants (e.g. a chlorzoxazone/thiocolchicoside FDC), VITAMIN D DOSE ADEQUACY (the engine holds ratified 25(OH)D bands and a dose-concordance matrix — never judge whether a vitamin D level is 'deficiency' or 'insufficiency', never overrule the clinician's documented diagnosis with a threshold of your own, and never call a repletion course over- or under-dosed), vitamin D repletion duration, pregnancy-risk advisories, banned fixed-dose combinations, high-alert medications, and dose ceilings. DIAGNOSIS DOCUMENTED WITHOUT A CODE: a clinical diagnosis/impression stated in words (e.g. 'Cervical Spondylosis') but shown without an ICD-10 code is a code AUTO-MAPPING gap, not a missing diagnosis — the diagnosis IS documented; do NOT raise 'missing coded diagnosis' or dock appropriateness for it. DOCUMENTED-RISK-WITHOUT-SAFEGUARD ONLY: reserve an appropriateness penalty for a risk THIS note actually documents that lacks its safeguard — do NOT dock for a niche pre-analytic / preparatory keyword the note simply doesn't mention (e.g. holding biotin before a thyroid/troponin immunoassay, a fasting/water-deprivation instruction before a test): that is an over-flag, not a note-quality gap — at most note it for awareness. INSTITUTIONAL HEALTH-CHECK PACKAGE: if the encounter is a preventive health-check / screening PACKAGE, its protocol panel of investigations is by design — do NOT flag the package's included tests as individually "unindicated / low-value".
   - prescribing_safety: irrational or unsafe prescribing — wrong/unnecessary drug, an antibiotic for a likely-viral illness, drug–drug or drug–allergy interactions, duplications, dosing problems. Each medication carries the molecule plus [drug class · D&C schedule · ISMP high-alert] resolved from the hospital formulary (the note often gives only a brand); use these to judge class duplication, interactions and high-alert handling. These bracketed tags are SYSTEM-DERIVED formulary metadata, NOT the clinician's documentation — NEVER raise a finding about their accuracy and NEVER penalise the clinician for a drug-class label that looks wrong (e.g. a PPI shown as "Antibiotic"): a wrong tag is a system data issue, out of scope for this clinical audit. Items tagged "nutraceutical/cosmetic" or "not in hospital formulary" are NOT formulary drugs — do not invent drug interactions for them, but you may note non-evidence-based / cosmetic prescribing.
     · SCOPE (critical): a prescribing-safety finding may ONLY concern a drug that appears in the MEDICATIONS list of THIS prescription. Drugs the patient reports in the HISTORY (e.g. "was taking X", "advised medication elsewhere") are context for detecting an interaction or duplication WITH a currently-prescribed drug — they are NEVER by themselves a prescribing fault, and you must not fault THIS clinician for a drug they did not prescribe. If the MEDICATIONS list is empty (none prescribed this encounter), there is NO prescription to assess — emit NO prescribing-safety finding at all.
     · INDICATION: if a medication's usual indication does not match the documented diagnosis, it is most likely a continuation of chronic/long-term therapy (e.g. a statin or antihypertensive on a note for an acute complaint). Report this as "indication for <drug> not documented" (a documentation gap; verdict context-dependent) — do NOT assert it is the wrong drug FOR the acute diagnosis — UNLESS the drug is genuinely harmful or contraindicated for this patient.
     · MEDICATION CHANGE: when the note stops, switches or replaces a prior medication, or a history drug overlaps/duplicates a newly-prescribed one, check that a clear stop/switch instruction is documented; a missing "stop the previous drug" instruction in that situation is a safety-relevant gap worth flagging.
   Each finding: "subject", "verdict" (high-value | context-dependent | low-value | uncertain), "confidence" 0–1, "domain" ("appropriateness" | "prescribing_safety"), "rationale", "evidence" (points SUPPORTED by the excerpts), "estimates" (your own/general-knowledge points), "citation_ids" (the [n] that actually support the evidence).
   CITE OR LABEL — this is critical, the audit is shown to clinical reviewers who must see what is sourced: when a numbered excerpt supports a point, put it in "evidence" and list every supporting [n] in citation_ids; if no excerpt supports the point, it MUST go in "estimates" with citation_ids empty — NEVER present an uncited claim as cited evidence. Prefer findings you can ground in the excerpts; an uncited finding is still allowed but will be shown to the reviewer as "general clinical reasoning", so reserve it for points genuinely worth raising.
   GUARD AGAINST ANCHORING: weigh PRE-TEST PROBABILITY and the dominant clinical syndrome; treat outside low-utility tests (e.g. Widal) with skepticism; do not reward a low-yield confirmatory test. Do NOT invent a diagnosis the note doesn't support.
   Do NOT penalise the mere absence of a field as a clinical error (documentation gaps are scored separately) — focus findings on the actual clinical decisions taken. VERIFY BEFORE FLAGGING AN ABSENCE: before raising any finding premised on something being missing (a diagnosis, an indication, a follow-up, a safety-net, an examination), confirm it is absent from EVERY section provided (history, examination, impression, plan, follow-up, referrals) — a fact present in ANY field is documented; a documented physical examination means the encounter was in-person and must NEVER be called an impossible-teleconsult contradiction. ONE ISSUE, ONE FINDING: do not raise multiple findings for the SAME clinical decision or drug pair (e.g. an oral+topical NSAID overlap, or 'treat without confirmation' plus 'intensive regimen' for the same unconfirmed diagnosis) — consolidate into a single finding so one decision is not penalised twice.

2) PDQI9 — rate the QUALITY OF THE DOCUMENTATION THAT IS PRESENT on the validated 9 attributes, each 1 (poor) to 5 (excellent). ANCHOR: 3 = acceptable/adequate, 5 = excellent, 1 = unacceptable. CRITICAL — completeness is scored SEPARATELY, so do NOT re-penalise missing sections here. A terse but internally-correct note (correct drug names + dosing, a coded diagnosis, a coherent plan) is ACCEPTABLE: rate accurate, comprehensible, succinct and internally_consistent ≈ 3–5 unless what IS written is actually wrong, confusing/unreadable, padded, or self-contradictory — reserve 1–2 for those genuine defects, not for brevity. For thorough, useful and synthesized, judge against what THIS presentation's acuity and risk actually require — NOT against maximal documentation. A self-limiting complaint that is fully and correctly addressed (with appropriate safety-netting) is fully thorough/useful/synthesized — rate 4–5; never lower these for appropriate brevity. Reserve low thorough/synthesized (1–2) for a genuine reasoning gap RELATIVE TO THE PRESENTATION — e.g. a higher-risk presentation left un-screened (no red-flag check or differential where one is clearly needed), or an assessment that fails to connect the findings the note itself records. Length is never a virtue or a fault. Rate each attribute for what it measures:
   - up_to_date: consistent with current standards · accurate: factually correct, no errors in what is stated · thorough: covers what THIS presentation's risk requires (low ONLY if a needed workup/red-flag screen is absent — never for brevity on a low-risk complaint) · useful: gives a downstream reader what they need FOR THIS PROBLEM incl. a safety-net (low only if a genuinely needed element is missing) · organized: logically structured · comprehensible: clear and readable · succinct: concise without padding (terse is NOT a defect) · synthesized: ties findings into an assessment appropriate to the stakes (a short correct assessment for a simple problem IS synthesized; low only when the assessment is absent or ignores documented findings) · internally_consistent: no contradictions among the documented items.

3) SUGGESTIONS — prioritised, concrete improvements (priority 1 = highest). Do NOT suggest adding something the note already records: in particular, if a follow-up disposition is already documented (the header shows a follow-up type other than "none"/"unknown", or a date), do not suggest "add follow-up instructions" — only suggest that when follow-up is genuinely unspecified.

Advisory only; never blame the clinician. Separate cited EVIDENCE from ESTIMATES; never present an estimate as cited.

Return ONLY JSON, no prose:
{"findings":[{"subject":"…","verdict":"…","confidence":0.0,"domain":"appropriateness|prescribing_safety","rationale":"…","evidence":["…"],"estimates":["…"],"citation_ids":[1]}],"pdqi9":{"up_to_date":3,"accurate":3,"thorough":3,"useful":3,"organized":3,"comprehensible":3,"succinct":3,"synthesized":3,"internally_consistent":3},"suggestions":[{"priority":1,"text":"…"}]}`;

export function buildOpdAuditUser(caseText: string, citedContext: string): string {
  const ev = citedContext.trim() ? citedContext.trim() : '(no excerpts retrieved — leave citation_ids empty; put clinical reasoning in estimates, not evidence)';
  return `DE-IDENTIFIED OPD ENCOUNTER:\n${caseText}\n\nNUMBERED EVIDENCE EXCERPTS:\n${ev}`;
}

// ── parse ────────────────────────────────────────────────────────────────────
function extractJsonObject(text: string): unknown {
  if (!text) return null;
  // Reasoning models (e.g. DeepSeek-R1) prepend a <think>…</think> block whose prose
  // can contain braces that would derail the brace-walker. Parse only what follows the
  // final </think>. No-op for qwen/Gemini (their content carries no </think>).
  const body = text.includes('</think>') ? text.slice(text.lastIndexOf('</think>') + 8) : text;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
function s(v: unknown): string { return v == null ? '' : String(v).trim(); }
function num(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
function strArr(v: unknown, cap = 12): string[] {
  return Array.isArray(v) ? v.map(s).filter(Boolean).slice(0, cap) : [];
}
const VERDICTS: NetValue[] = ['high-value', 'context-dependent', 'low-value', 'uncertain'];
function normVerdict(v: unknown): NetValue { const x = s(v).toLowerCase().replace(/\s+/g, '-'); return (VERDICTS as string[]).includes(x) ? (x as NetValue) : 'uncertain'; }
function normDomain(v: unknown): OpdFindingDomain { return s(v).toLowerCase().includes('prescrib') ? 'prescribing_safety' : 'appropriateness'; }

export interface OpdAnalysis {
  findings: OpdFinding[];
  pdqi9: Partial<Record<Pdqi9Attr, number>> | null;
  suggestions: OpdSuggestion[];
}

export function parseOpdAnalysis(text: string, sourceCount = 0): OpdAnalysis | null {
  const o = extractJsonObject(text) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;

  const rawF = Array.isArray(o.findings) ? o.findings : [];
  const findings: OpdFinding[] = rawF.map((r) => {
    const f = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const ids = Array.isArray(f.citation_ids)
      ? f.citation_ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= sourceCount)
      : [];
    return {
      subject: s(f.subject) || '(unnamed finding)',
      verdict: normVerdict(f.verdict),
      confidence: num(f.confidence, 0, 1, 0.5),
      domain: normDomain(f.domain),
      rationale: s(f.rationale),
      evidence: strArr(f.evidence),
      estimates: strArr(f.estimates),
      citation_ids: ids,
      source: 'llm' as const,
    };
  }).filter((f) => f.subject !== '(unnamed finding)' || f.rationale);

  let pdqi9: Partial<Record<Pdqi9Attr, number>> | null = null;
  const rawP = (o.pdqi9 && typeof o.pdqi9 === 'object') ? o.pdqi9 as Record<string, unknown> : null;
  if (rawP) {
    pdqi9 = {};
    for (const a of PDQI9_KEYS) { const v = rawP[a]; if (v != null && Number.isFinite(Number(v))) pdqi9[a] = num(v, 1, 5, 3); }
    if (Object.keys(pdqi9).length === 0) pdqi9 = null;
  }

  const rawS = Array.isArray(o.suggestions) ? o.suggestions : [];
  const suggestions: OpdSuggestion[] = rawS.map((r, i) => {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    return { priority: num(x.priority, 1, 99, i + 1), text: s(x.text) };
  }).filter((x) => x.text).sort((a, b) => a.priority - b.priority);

  return { findings, pdqi9, suggestions };
}
