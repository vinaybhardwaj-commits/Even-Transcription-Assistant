/**
 * lib/reasoning/manifest.ts — the hand-authored SIDECAR for the prompt registry (Reasoning
 * Observability Stage 0). The registry facts (id · hash · text · counts) are GENERATED from
 * code by scripts/reasoning-registry-gen.mjs; this file carries only the HUMAN metadata that
 * cannot be derived: owner, clinician approver, maturity, and the linked rubric/schema.
 *
 * STRUCTURAL-FIRST (mirrors lib/architecture/manifests.ts): `owner` and `clinicianApprover`
 * are deliberately unassigned today — the export renders them as honest blanks, never guessed
 * names. Every prompt starts at 'draft' at best; 'review'/'mature' are earned through the
 * maturity ladder.
 *
 * MATURITY GATE (Stage 3, CI-enforced): an entry may claim 'mature' ONLY if its prompt has a
 * committed gold outcome that clears the 0.90 floor ON THE LIVE PROMPT BYTES — see
 * maturityGateViolations() in ./outcome-core.ts and lib/__tests__/reasoning-outcome.test.ts.
 * Verticals without a gold stay ≤ 'review'.
 *
 * COVERAGE (enforced by lib/__tests__/reasoning-registry.test.ts): every generated prompt id
 * must appear here (PROMPT_MANIFESTS) or in UNREGISTERED_PROMPTS below. A new prompt const
 * cannot silently escape the registry — but an UNLISTED id at runtime merges as 'unregistered',
 * never a throw (the gate lives in the test, not in serving).
 */

export type Maturity = 'unregistered' | 'draft' | 'review' | 'mature';

export interface PromptManifest {
  id: string;                  // '<file-stem>/<CONST>' — must match a generated prompt id
  owner?: string;              // engineering owner — unassigned in Stage 0
  clinicianApprover?: string;  // clinical sign-off — unassigned in Stage 0
  maturity: Exclude<Maturity, 'unregistered'>;
  rubricId?: string;           // id of a rubric in the generated registry
  schemaId?: string;           // output-schema id — none registered yet (Stage 1+)
}

/**
 * Registered prompts: the six whose rubric linkage is an established fact (five embed their
 * rubric in the prompt text; doc-audit extraction reads the external NABH rubric's field
 * floors). All 'draft' — extracted + hashed, no recorded review yet.
 */
export const PROMPT_MANIFESTS: PromptManifest[] = [
  { id: 'ddx-hypothesis/HYPO_SYSTEM', maturity: 'draft', rubricId: 'cannot-miss discipline' },
  { id: 'doc-audit-core/EXTRACT_SYSTEM', maturity: 'draft', rubricId: 'nabh/6e' },
  { id: 'lvc-core/JUDGE_SYSTEM', maturity: 'draft', rubricId: 'applicability discipline' },
  { id: 'opd-note-audit-core/OPD_AUDIT_SYSTEM', maturity: 'draft', rubricId: 'PDQI-9 reasoning rubric' },
  { id: 'pathway-core/ENRICH_SYSTEM', maturity: 'draft', rubricId: 'evidence-hierarchy' },
  { id: 'rerank/JUDGE_SYSTEM', maturity: 'draft', rubricId: '0–10 scoring rubric' },
  // Brainstem PR 0 baseline verifier — the standalone citation-support judge, seeded from
  // AUDIT_REVISE's support discipline (embedded in the prompt, like the others). Measurement-only
  // (corpus-eval/1.0), Pro-tier. rubricId left blank — no separate rubric doc to link.
  { id: 'verify-core/VERIFY_SYSTEM', maturity: 'draft' },
];

/**
 * ENGINE registrations (additive, IPD Discharge Audit M1): engines that REUSE registered
 * prompts rather than defining new ones. The prompt registry above stays prompt-keyed and
 * generated-not-authored; this block records the engine-version → prompt linkage so a
 * composed engine (its version string is what lands in the audit table's engine_version)
 * is a declared fact, not tribal knowledge. Coverage tests do not scan this list — an
 * engine entry never satisfies (or breaks) prompt coverage.
 */
export interface EngineManifest {
  id: string;              // the engine_version string persisted on audit rows
  variants?: string[];     // e.g. the '-mini' Ollama/Qwen backfill twin
  owner?: string;
  prompts: string[];       // registered/generated prompt ids the engine invokes (reused, not new)
  note?: string;
}

export const ENGINE_MANIFESTS: EngineManifest[] = [
  {
    id: 'ipd-discharge-audit/0.1',
    variants: ['ipd-discharge-audit/0.1-mini'],
    owner: 'V',
    prompts: [
      'doc-audit-core/EXTRACT_SYSTEM',
      'doc-audit-core/ANALYZE_SYSTEM',
      'doc-audit-core/AUDIT_CRITIQUE_SYSTEM',
      'doc-audit-core/AUDIT_REVISE_SYSTEM',
    ],
    note: 'IPD discharge-summary audit — no new prompts; calls the shipped doc-audit engine + value-score-core.',
  },
];

/**
 * The honest gap list: generated prompt ids with NO manifest entry yet. Every one renders as
 * 'unregistered' in the export — never hidden. Registering one means writing its PromptManifest
 * above and deleting it from this list (the coverage test fails on stale entries either way).
 */
export const UNREGISTERED_PROMPTS: string[] = [
  'concordance-core/SYSTEM',
  'doc-audit-core/ANALYZE_SYSTEM',
  'doc-audit-core/AUDIT_CRITIQUE_SYSTEM',
  'doc-audit-core/AUDIT_REVISE_SYSTEM',
  'doc-audit/IDENTITY_SYSTEM',
  // Concept Coder Phase 1 (CDMSS-CONCEPT-CODER-PRD v1.0). No rubric linkage: it parses the GRAMMAR
  // of a finding string into four structural slots and makes no clinical judgement, so there is
  // nothing for a rubric to score. Stays unregistered until Phase 2 yields a coder-error gold from
  // lvc_concept_evidence — which is exactly the regression signal §5.1 was designed to produce.
  'even-concept/CONCEPT_EXTRACT_SYSTEM',
  'expand/SYSTEM',
  'extract/NORMALISE_SYSTEM',
  'extraction-eval-core/JUDGE_SYSTEM',
  'inquiry-core/INQUIRY_SELECT_SYSTEM',
  'investigations/PARSE_SYSTEM',
  'learning-core/CANONICALIZE_SYSTEM',
  'lvc-core/CANDIDATE_SYSTEM',
  'lvc-value-core/VALUE_CRITIQUE_SYSTEM',
  'lvc-value-core/VALUE_REVISE_SYSTEM',
  'lvc-value-core/VALUE_SYSTEM',
  'pathway-core/ENRICH_CRITIQUE_SYSTEM',
  'pathway-core/ENRICH_REVISE_SYSTEM',
  'pathway-core/SKELETON_SYSTEM',
  'prognosis-core/PX_CRITIQUE_SYSTEM',
  'prognosis-core/PX_REVISE_SYSTEM',
  'prognosis-core/PX_SYSTEM',
  'right-care-ground-eval-core/PAIR_JUDGE_SYSTEM',
];
