/**
 * lib/architecture/manifests.ts — the central module-manifest registry (System Map Stage 1).
 * Seeded from docs/architecture/INVENTORY.md (the source of truth for planes/edges): the 6
 * governed modules, plus this directory itself as infra. STRUCTURAL-FIRST: `owner`,
 * `clinicianApprover` and `validationEvidence` are deliberately unassigned — the map renders
 * them as honest "unassigned" gaps rather than guessed names. `forbiddenImports` is also left
 * empty: the enforced edges live in scripts/architecture-check.mjs's RULES (the map projects
 * them from there), and duplicating them here would be a drift risk, not a fact.
 *
 * COVERAGE (enforced by `npm run architecture:check`): every top-level lib/ subsystem — see
 * listSubsystems() in scripts/lib/import-scan.mjs for the exact definition — must appear here
 * (via a manifest's `paths`) or in UNREGISTERED below. A new module cannot silently escape
 * the map.
 */

export type Plane =
  | 'pure-core'         // per-encounter clinical model — no app, no scores
  | 'spine'             // Plane-1 longitudinal patient projection
  | 'advisory'          // informational lane — never scores
  | 'score-arithmetic'  // the ONLY place score maths lives
  | 'audit-engine'      // extraction + finding assembly around the score core
  | 'ui'                // app/ and components/
  | 'infra';            // build/governance plumbing (this directory)

export type Lifecycle = 'implemented' | 'integrated' | 'validated' | 'released';

export interface ModuleManifest {
  id: string;                  // stable slug, e.g. 'member-state'
  title: string;               // the PLAIN name (v2 mockup card copy) — what /admin/architecture renders
  blurb: string;               // one-line plain description (v2 mockup card copy) — ditto
  plane: Plane;
  paths: string[];             // globs the module owns (matched by the coverage rule)
  owner?: string;              // engineering owner — unassigned in Stage 1
  clinicianApprover?: string;  // where a clinical sign-off applies — unassigned in Stage 1
  validationEvidence?: string; // link/ref to the validation — unassigned in Stage 1
  lifecycle: Lifecycle;
  versionConst?: string;       // the *_VERSION export name, if any
  forbiddenImports?: string[]; // reserved — the checker's RULES are authoritative today
  changelog?: string;          // id of a registered ChangeEntry[] source (none registered yet)
}

export const MODULE_MANIFESTS: ModuleManifest[] = [
  {
    id: 'clinical-state',
    title: 'Reading a single visit',
    blurb: 'Turns one consultation note into a structured picture — the complaint, the diagnosis, the medicines prescribed.',
    plane: 'pure-core',
    paths: ['lib/clinical-state/**'],
    lifecycle: 'integrated', // live consumers (DDx surface, care pages); audit-shadow adoption staged behind a default-off flag
    versionConst: 'CLINICAL_STATE_VERSION',
  },
  {
    id: 'member-state',
    title: 'The patient’s record over time',
    blurb: 'Pulls together everything known about a patient across their visits — problems, medicines, labs — as it stood on any given day.',
    plane: 'spine',
    paths: ['lib/member-state/**'],
    lifecycle: 'integrated', // live on care surfaces + CCB; frozen fidelity baseline exists (member-bank/1.0), staged rollout continues
    versionConst: 'MEMBER_STATE_VERSION',
  },
  {
    id: 'opd-note-score-core',
    title: 'The scoring engine',
    blurb: 'Turns the quality findings on a note into the 0–100 grade. This is the one and only place the score is worked out.',
    plane: 'score-arithmetic',
    paths: ['lib/opd-note-score-core.ts'],
    lifecycle: 'released', // in production at opd-note-audit/0.81.8, drives the live dashboards
    // the score arithmetic ships under the audit engine's version — its changes are the
    // `scoring: true` entries in OPD_AUDIT_CHANGELOG, stamped with OPD_ENGINE_VERSION
    versionConst: 'OPD_ENGINE_VERSION',
  },
  {
    id: 'opd-longitudinal',
    title: 'History-based observations',
    blurb: 'Looks across a patient’s past visits for things like a repeated test or a medicine that needs reconciling. Shown for information only — it never changes the score.',
    plane: 'advisory',
    paths: ['lib/opd-longitudinal*'],
    lifecycle: 'integrated', // wired post-INSERT + admin surfaces; 30-day backfill dark behind OPD_LONGITUDINAL_ENABLED
    versionConst: 'OPD_LONGITUDINAL_VERSION',
  },
  {
    id: 'opd-triage-core',
    title: 'The review-queue helper',
    blurb: 'Sorts and labels notes for the care-manager review queue — for example, surfacing patients with the most history first. Informational only.',
    plane: 'advisory',
    paths: ['lib/opd-triage-core.ts'],
    lifecycle: 'integrated', // consumed by the live triage queue/decide routes
  },
  {
    id: 'as-of-core',
    title: 'The “as of this date” helper',
    blurb: 'A small building block that reconstructs what was known about a patient on a particular day — so the record is always read as it stood at the time of the visit.',
    plane: 'pure-core',
    paths: ['lib/as-of-core.ts'],
    lifecycle: 'integrated', // relocated in Slice 1 Part A; in the live member-state path
  },
  {
    id: 'inquiry',
    title: 'What to ask next',
    blurb: 'Turns what is still unknown about a patient into the few questions most worth asking on the next call. Advisory only — it never scores, and any failure falls back to the plain deterministic ask-set.',
    plane: 'advisory',
    paths: ['lib/inquiry/**'],
    lifecycle: 'implemented', // K1: cores + bench + serving path, dark behind INQUIRY_ENABLED (bench gate D13)
    versionConst: 'INQUIRY_VERSION',
  },
  {
    id: 'ipd-audit',
    title: 'IPD discharge audit',
    blurb: 'Audits every inpatient discharge summary — completeness, low-value care, and the Care-Value scorecard — by calling the shipped record-audit engine; stores the result de-identified with link-back keys.',
    plane: 'audit-engine',
    paths: ['lib/ipd-audit/**'],
    lifecycle: 'implemented', // M1 foundation: table + store + registration; worker/surface land next slice
    versionConst: 'IPD_ENGINE_VERSION',
  },
  {
    id: 'episode-state',
    title: 'One admission, start to finish',
    blurb: 'Brackets a single hospital stay as documented facts — admission, the in-hospital course, discharge — with every fact traceable to its source. Facts only: no scores, no predictions.',
    plane: 'pure-core',
    paths: ['lib/episode-state/**'],
    lifecycle: 'implemented', // SL1: schema + intra-phase builder; pre/post + persistence + surface land later
    versionConst: 'EPISODE_STATE_VERSION',
  },
  {
    id: 'member-state-adapters',
    title: 'Feeding an admission into the record',
    blurb: 'Turns a discharge into one more encounter in the patient’s longitudinal record — composing the frozen spine from outside, never editing it. Behind a flag until proven.',
    plane: 'pure-core',
    paths: ['lib/member-state-adapters/**'],
    lifecycle: 'implemented', // SL1: compose-outside adapter + tripwire, behind a flag; no-regression proof (SL2) + surface (SL3) later
  },
  {
    id: 'adjudication-ledger',
    title: 'Every human call, in one place',
    blurb: 'Federates every human adjudication across the audit surfaces into one read-time stream — what the AI proposed and what a reviewer decided — for precision and fidelity rollups. Advisory only: never a per-reviewer scorecard.',
    plane: 'advisory',
    paths: ['lib/adjudication-ledger/**'],
    lifecycle: 'implemented', // federate-at-read + Observability surface + rollups; human stores only, no migration
    versionConst: 'ADJUDICATION_LEDGER_VERSION',
  },
  {
    id: 'corpus-eval',
    title: 'Does the corpus actually help?',
    blurb: 'Measurement-only baseline (Brainstem PR 0): scores whether a cited source truly supports the claim it backs, and where retrieval is too thin to cite. Read-only; never changes what users see.',
    plane: 'advisory',
    paths: ['lib/corpus-eval/**'],
    lifecycle: 'implemented', // PR 0 baseline: pure verifier core + governed Pro call; scripts assemble/score/report
    versionConst: 'CORPUS_EVAL_VERSION',
  },
  {
    id: 'lvp-core',
    title: 'Low-value patterns shelf',
    blurb: 'Groups last night’s stamped low-value findings into suggestion kinds for the care-manager shelf — a count, not a finding. Hide compiles a suppression of the kind; nothing here scores, routes, or reaches Triage.',
    plane: 'advisory',
    paths: ['lib/lvp-core.ts'],
    lifecycle: 'implemented', // LVP L1: stub operator computed on read, behind LVC_PATTERNS_ENABLED (ships OFF)
  },
  {
    id: 'rule-governance',
    title: 'The rule book',
    blurb: 'Keeps an unchangeable record of every version of a low-value-care rule and of when each version was switched on or off, so anyone can ask what a rule said on the day it fired. It also records which shelf pattern a proposed rule came from, with the evidence frozen as it stood.',
    plane: 'advisory',
    // O3: TOP-LEVEL FILES, not a lib/ subdirectory — a new directory auto-registers as a subsystem
    // and so does an exported *_VERSION constant, and this module deliberately has neither.
    // Both files are claimed by ONE manifest so the core↔store import is internal to the module.
    paths: ['lib/rule-governance-core.ts', 'lib/rule-governance-store.ts'],
    lifecycle: 'implemented',
    // DORMANT (R3-A, 20 Aug 2026). Nothing reads it, nothing scores off it, it writes no row and no
    // status value to lvc_recommendations, and its only inbound import edges are its own two admin
    // routes — behind LVC_RULE_GOVERNANCE_ENABLED === '1', which ships UNSET. Migration 0039 is
    // built and NOT run; the bootstrap snapshot is built and NOT executed. The four dormancy proofs
    // are lib/__tests__/rule-governance-dormancy.test.ts. R3-B is the live-writer rewiring and is
    // HELD (Saul Rep 41, S1).
  },
  {
    id: 'lvp-operator-core',
    title: 'The words on the low-value patterns shelf',
    blurb: 'Writes the two lines of copy on each card — a plain clinical name for the pattern and an argument for why it is worth a look. Copy only: every count, date and example on the card is still worked out from the findings themselves.',
    plane: 'advisory',
    paths: ['lib/lvp-operator-core.ts'],
    lifecycle: 'implemented', // LVP L2: Opus on Bedrock behind LVC_PATTERNS_ENABLED (ships OFF);
    // decoration-only by construction — no decoration leaves the L1 stub copy in place, and a
    // failed run (F11: an explicit Bedrock target never degrades to another provider) writes
    // nothing at all. Nothing here scores, routes, or reaches Triage.
  },
  {
    id: 'opd-audit-layers-core',
    title: 'Where each thing on the audit page came from',
    blurb: 'Names the three layers of an audit — the facts read from the record, the findings, and the model’s own ratings — and says of every finding whether code decided it, the model wrote it, or the row is too old to say. Labels only: it changes nothing about what the audit finds or how it scores.',
    plane: 'advisory',
    paths: ['lib/opd-audit-layers-core.ts'],
    lifecycle: 'integrated', // facts-then-rules PR 1: live on /admin/opd-audit/[id], score-neutral
  },
  {
    id: 'architecture',
    title: 'This map’s own tooling',
    blurb: 'The behind-the-scenes tooling that keeps this very page accurate and up to date on every change.',
    plane: 'infra',
    paths: ['lib/architecture/**'],
    lifecycle: 'integrated', // consumed by architecture:check and the CI staleness gate from day one
  },
  {
    id: 'scoring-policy',
    title: 'How much each NABH field counts',
    blurb: 'Lets the quality team say a missing discharge date matters more than a missing signature — and recalculates past audits under the new weighting, without re-running a single audit.',
    plane: 'pure-core',
    paths: ['lib/scoring-policy/**'],
    lifecycle: 'implemented', // Phase A; v1 seeds all-Standard, which reproduces legacy scoring exactly
    // No *_VERSION code constant BY DESIGN: weights carry their own DATA version line per note type
    // (`nabh-weights/<note_type>/<n>`, PRD §2.8) precisely so that a weighting change is not an
    // engine change. engine_version is untouched by this module.
  },
];

/**
 * The honest gap list: top-level lib/ subsystems (per listSubsystems) that have NO manifest yet.
 * Every entry here is a visible "unregistered" row on the map — never hidden. Registering one
 * means writing its ModuleManifest above and deleting it from this list (the coverage rule
 * fails on stale entries in either direction).
 */
export const UNREGISTERED: string[] = [
  'calculators',            // clinical calculators (ABG, eGFR, hyponatremia, …)
  'care-call-core',         // care-call engine (ask-set/0.1, care-call/0.1)
  'cdsco-banned-fdc',       // CDSCO banned-FDC seed check (cdsco-banned-fdc/0.0, dormant stage 1)
  'ccb-brief-core',         // care-brief engine (care-brief/0.1)
  'ccb-dossier-cache-core', // dossier snapshot cache (schema v2)
  'ddx-eval-core',          // DDx frozen evaluator (ddx-eval/3, ddx-case-bank/1.0)
  'discharge-extract-store',// shared de-identified extracted-case store (doc-extract/1) — pure IO,
                            // written by the IPD audit and read by the readmission agent
  'doc-audit-core',         // Right Care record-audit engine (named by rule 5's scored-core globs)
  'dose-limits',            // dose-limits reference table
  'formulary-match-core',   // formulary matcher (named by rule 5's scored-core globs)
  'mcp-server',             // MCP protocol surface
  'ml-label-trial',         // ML Phase 1 retrospective validation (ml-label-trial/1.0 — measures only, writes lab_analyses)
  'opd-audit',              // OPD read-side db13 joins (investigations-ordered lookup, Phase C §7.1)
  'opd-note-audit',         // audit engine wrapper (mini engine)
  'opd-feedback-rollup-core', // pure feedback rollup core (surfaced as a subsystem by the LAB-MCP Phase 1 import edge)
  'opd-note-audit-core',    // the OPD audit engine (opd-note-audit/0.81.8)
  'patient-summary-core',   // Patient Summary API contract for Pulse (patient-summary/1.0) — the
                            // namespaced package shape + degraded/provenance rules over the
                            // preserved (retired-surface) CCB mechanics
  'prognosis-core',         // prognosis engine (prognosis/0.1)
  'proms',                  // PROMs catalog/scheduling/scoring
  'readmission',            // readmission analysis agent Phase 1 (readmission/0.1 — detect + reconcile + Vertex worker)
  'readmission-reconcile-core', // pure Stage-2 reconciliation + R1 advisory judgements (readmit-judgement/1) —
                            // surfaced as its own versioned subsystem the day JUDGEMENT_RULE_VERSION was exported
  'readmission-narrative-core', // R4 pure cores (narrative/1, ledger/1, related-lvc/1): citation validator,
                            // relatedLvc reducer, three-hop join helpers — versioned by its exported *_VERSION consts
  'readmission-rates-core', // R7 pure rates definitions (rates/1): denominators, Wilson CI, monthly cohorts,
                            // EHBR gate, staged-return matcher — the 19-Aug rate report's method, codified once
  'readmission-versions-core', // R8.1 pure finding-versions logic (readmit-versions/1): capture reasons,
                            // snapshot shapes, replay validation, the overwrite-snapshot decision
  'reasoning',              // prompt-registry sidecar + export core (Reasoning Observability Stage 0)
  'right-care-ground-eval-core', // Slice-2 grounding A/B referee (right-care-eval/1.0)
];
