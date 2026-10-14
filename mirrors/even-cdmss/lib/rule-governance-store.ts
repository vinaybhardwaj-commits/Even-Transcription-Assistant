/**
 * lib/rule-governance-store.ts — R3-A: the Even rule book, IO layer (Neon). DORMANT.
 *
 * NOTHING IMPORTS THIS except its own two admin routes (kickoff §4 proof 1). It is gated on
 * LVC_RULE_GOVERNANCE_ENABLED === '1' (S3), which ships UNSET. No cron, no build hook, no deploy
 * step, no worker reaches it. IT DOES NOT RUN ITSELF (the refusal sentence from
 * app/api/admin/migrate-lvc-wording/route.ts:15, copied deliberately).
 *
 * NO LLM. No prompt is issued or registered here (kickoff §6 trap 7).
 *
 * ⚠️ EVERY SQL STRING IN THIS FILE IS INFERRED — the builder's sandbox has no live DB. Each one is
 * reproduced verbatim in the build report, and the orchestrator validates it against live Neon
 * before this module is merged, let alone enabled.
 *
 * WHAT IT NEVER TOUCHES (kickoff §5, and the four dormancy proofs pin it):
 *   · `lvc_recommendations` is NEVER written — no INSERT, no UPDATE, no DELETE, no ALTER, no new
 *     status value, no new row. Six of its eleven readers do not filter `status`, so a new value
 *     or row silently changes the note page, both provenance-tier reads, the MCP dedup gate,
 *     lvc_gaps and the wording readback (kickoff §6 trap 1). Governance state lives ENTIRELY in
 *     the new tables — the boundary migration 0023 already drew for proposals. The ONE statement
 *     here that names the table at all is the bootstrap SELECT, which reads and returns nothing.
 *   · no audit-suppression table, no `approved_by='admin'` row (S5 — that removal is its own patch)
 *   · no lvp_* table, no score column, no engine version.
 *
 * ATOMICITY (O2). Neon's HTTP driver has no interactive BEGIN/COMMIT: one statement IS one
 * transaction. Every governance write is therefore ONE data-modifying-CTE statement — the
 * lib/readmission/store.ts:203-210 pattern — so proposal state, the immutable version row and the
 * pattern mapping all land together or none of them do. There is no ordered-degradation path and
 * no second `await run(...)` inside any write function; a test asserts that.
 */

import { randomUUID } from 'node:crypto';
import { sql } from './db';
import {
  asEvidence, DEFINITION_HASH_FIELDS, EVALUATOR_DISPOSITION, isRuleGovernanceEnabled,
  validateActivationRequest,
  type ActivationEvent, type ActivationOutcome, type ActivationRefusal, type ActivationRequest,
  type GovernanceEvidence, type PatternEvidenceSnapshot, type ValidityWindow,
} from './rule-governance-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** The flag, read from the live process env. The pure predicate lives in the core so the
 *  flag-off proof can sweep it with an env object instead of mutating process.env. */
export function ruleGovernanceEnabled(): boolean {
  return isRuleGovernanceEnabled(process.env as Record<string, string | undefined>);
}

function assertEnabled(): void {
  if (!ruleGovernanceEnabled()) {
    throw new Error('rule governance is disabled (LVC_RULE_GOVERNANCE_ENABLED is not "1")');
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// DDL — migration 0039. Reference copy: migrations/0039_rule_governance.sql.
//
// The .sql file is DOCUMENTATION: `migrations/` is not bundled into the Vercel serverless
// function, so only code reachable through an import ships. These constants are the executable
// path; lib/__tests__/rule-governance-migration.test.ts asserts the two agree statement-for-
// statement, so they cannot fork silently (kickoff §6 trap 6).
//
// ADDITIVE AND SINGLE-TARGET: four new objects, nothing altered, nothing dropped, nothing updated.
//
// ⚠️ WHY THESE CONSTANTS ARE NOT NAMED `RULE_VERSIONS_*`. The version registry's inclusion rule is
// a TEXT SCAN for an exported const whose UPPER_SNAKE name carries the `_VERSION` token
// (VERSION_EXPORT_RE, scripts/lib/import-scan.mjs) — so `RULE_VERSIONS_INDEX_DDL` registered this
// dormant module as a versioned subsystem and appeared in VERSION_REGISTRY with a CREATE INDEX
// statement as its "version value". That is kickoff §6 trap 2 firing exactly as written. A name
// whose VERSION token is not preceded by an underscore does not match; hence `VERSIONS_TABLE_DDL`.
// The dormancy test asserts no constant here matches the rule.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** §3.1 — IMMUTABLE. Written once, never updated, never deleted. NO `valid_to` column (S2):
 *  the window is derived from the event stream by v_lvc_rule_validity. NO foreign key to
 *  lvc_recommendations, following the 0023:49-51 precedent which deliberately omits one on
 *  supersedes_id — a version row must survive a registry row it snapshots. */
export const VERSIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS lvc_rule_versions (
  rule_ref              text NOT NULL,
  version               int  NOT NULL,
  statement             text NOT NULL,
  precondition          text,
  action_type           text,
  keywords              jsonb,
  category              text,
  definition_hash       text NOT NULL,
  origin                text NOT NULL CHECK (origin IN ('bootstrap_snapshot','proposal')),
  evaluator_disposition text NOT NULL DEFAULT 'informational' CHECK (evaluator_disposition = 'informational'),
  proposal_id           uuid,
  ratified_by           text NOT NULL,
  rationale             text NOT NULL,
  sample_size           int  NOT NULL,
  reviewed_n            int  NOT NULL,
  sample_seed           text NOT NULL,
  n_not_belonging       int,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_ref, version),
  CONSTRAINT lvc_rule_versions_version_positive CHECK (version > 0),
  CONSTRAINT lvc_rule_versions_ref_nonblank     CHECK (btrim(rule_ref) <> ''),
  CONSTRAINT lvc_rule_versions_statement_nonblank CHECK (btrim(statement) <> ''),
  CONSTRAINT lvc_rule_versions_ratifier_named CHECK (
    btrim(ratified_by) <> ''
    AND lower(btrim(ratified_by)) NOT IN ('admin','system','cron','worker','care-manager')),
  CONSTRAINT lvc_rule_versions_rationale_nonblank CHECK (btrim(rationale) <> ''),
  CONSTRAINT lvc_rule_versions_seed_nonblank      CHECK (btrim(sample_seed) <> ''),
  CONSTRAINT lvc_rule_versions_counts_nonneg      CHECK (sample_size >= 0 AND reviewed_n >= 0),
  CONSTRAINT lvc_rule_versions_reviewed_le_sample CHECK (reviewed_n <= sample_size),
  CONSTRAINT lvc_rule_versions_nnb_bounds         CHECK (n_not_belonging IS NULL
                                           OR (n_not_belonging >= 0 AND n_not_belonging <= reviewed_n))
)`;

export const VERSIONS_INDEX_DDL =
  `CREATE INDEX IF NOT EXISTS lvc_rule_versions_ref_idx ON lvc_rule_versions (rule_ref, version DESC)`;

/** §3.2 — APPEND ONLY. One row per activation or retirement; no UPDATE or DELETE anywhere in the
 *  module. Bootstrap and proposal creation write NO row here (S4). */
export const ACTIVATION_EVENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS lvc_rule_activation_events (
  id              bigserial PRIMARY KEY,
  event_ref       uuid NOT NULL UNIQUE,
  rule_ref        text NOT NULL,
  version         int  NOT NULL,
  event           text NOT NULL CHECK (event IN ('activate','retire')),
  effective_at    timestamptz NOT NULL DEFAULT now(),
  ratified_by     text NOT NULL,
  rationale       text NOT NULL,
  sample_size     int  NOT NULL,
  reviewed_n      int  NOT NULL,
  sample_seed     text NOT NULL,
  n_not_belonging int,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lvc_rule_activation_events_version_positive CHECK (version > 0),
  CONSTRAINT lvc_rule_activation_events_version_fk
    FOREIGN KEY (rule_ref, version) REFERENCES lvc_rule_versions (rule_ref, version),
  CONSTRAINT lvc_rule_activation_events_ratifier_named CHECK (
    btrim(ratified_by) <> ''
    AND lower(btrim(ratified_by)) NOT IN ('admin','system','cron','worker','care-manager')),
  CONSTRAINT lvc_rule_activation_events_rationale_nonblank CHECK (btrim(rationale) <> ''),
  CONSTRAINT lvc_rule_activation_events_seed_nonblank      CHECK (btrim(sample_seed) <> ''),
  CONSTRAINT lvc_rule_activation_events_counts_nonneg      CHECK (sample_size >= 0 AND reviewed_n >= 0),
  CONSTRAINT lvc_rule_activation_events_reviewed_le_sample CHECK (reviewed_n <= sample_size),
  CONSTRAINT lvc_rule_activation_events_nnb_bounds         CHECK (n_not_belonging IS NULL
                                           OR (n_not_belonging >= 0 AND n_not_belonging <= reviewed_n))
)`;

export const ACTIVATION_EVENTS_INDEX_DDL =
  `CREATE INDEX IF NOT EXISTS lvc_rule_activation_events_stream_idx ON lvc_rule_activation_events (rule_ref, effective_at, id)`;

/** §3.5 — the ONLY join between the shelf's evidence identity and the rule book's governance
 *  identity. The column is `lvp_pattern_id` (O1) and its value is exactly what
 *  lib/lvp-core.ts patternIdFor() returns. Hide remains cosmetic; an lvp_pattern_id NEVER
 *  becomes a rule_ref. `evidence_snapshot` is the frozen §3.7 shelf reading. */
export const PATTERN_MAP_TABLE_DDL = `CREATE TABLE IF NOT EXISTS rule_pattern_map (
  id                bigserial PRIMARY KEY,
  lvp_pattern_id    text NOT NULL,
  rule_ref          text NOT NULL,
  evidence_snapshot jsonb NOT NULL,
  ratified_by       text NOT NULL,
  rationale         text NOT NULL,
  sample_size       int  NOT NULL,
  reviewed_n        int  NOT NULL,
  sample_seed       text NOT NULL,
  n_not_belonging   int,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rule_pattern_map_pattern_nonblank CHECK (btrim(lvp_pattern_id) <> ''),
  CONSTRAINT rule_pattern_map_ref_nonblank     CHECK (btrim(rule_ref) <> ''),
  CONSTRAINT rule_pattern_map_ratifier_named CHECK (
    btrim(ratified_by) <> ''
    AND lower(btrim(ratified_by)) NOT IN ('admin','system','cron','worker','care-manager')),
  CONSTRAINT rule_pattern_map_rationale_nonblank CHECK (btrim(rationale) <> ''),
  CONSTRAINT rule_pattern_map_seed_nonblank      CHECK (btrim(sample_seed) <> ''),
  CONSTRAINT rule_pattern_map_counts_nonneg      CHECK (sample_size >= 0 AND reviewed_n >= 0),
  CONSTRAINT rule_pattern_map_reviewed_le_sample CHECK (reviewed_n <= sample_size),
  CONSTRAINT rule_pattern_map_nnb_bounds         CHECK (n_not_belonging IS NULL
                                           OR (n_not_belonging >= 0 AND n_not_belonging <= reviewed_n))
)`;

export const PATTERN_MAP_INDEX_DDL =
  `CREATE INDEX IF NOT EXISTS rule_pattern_map_pattern_idx ON rule_pattern_map (lvp_pattern_id, created_at DESC)`;

/** §3.3 — the DERIVED window. `valid_from` is an activate event's effective_at; `valid_to` is the
 *  NEXT event on that rule, whatever it is, or null while the version is the active one. The
 *  stream is partitioned by rule_ref and not by version, because a retire of v1 and an activate
 *  of v2 both close v1. Reactivation appends a second activate and yields a second row here (S2).
 *  This is the SQL twin of deriveValidityWindows() in the core; a test pins both to one fixture. */
export const VALIDITY_VIEW_DDL = `CREATE OR REPLACE VIEW v_lvc_rule_validity AS
SELECT w.rule_ref, w.version, w.valid_from, w.valid_to
  FROM (
    SELECT e.rule_ref, e.version, e.event,
           e.effective_at AS valid_from,
           lead(e.effective_at) OVER (PARTITION BY e.rule_ref ORDER BY e.effective_at, e.id) AS valid_to
      FROM lvc_rule_activation_events e
  ) w
 WHERE w.event = 'activate'`;

export const RULE_GOVERNANCE_DDL: readonly string[] = [
  VERSIONS_TABLE_DDL,
  VERSIONS_INDEX_DDL,
  ACTIVATION_EVENTS_TABLE_DDL,
  ACTIVATION_EVENTS_INDEX_DDL,
  PATTERN_MAP_TABLE_DDL,
  PATTERN_MAP_INDEX_DDL,
  VALIDITY_VIEW_DDL,
];

/**
 * Idempotent DDL for migration 0039.
 *
 * CALLED FROM EXACTLY ONE PLACE: GET /api/admin/migrate-rule-governance, itself behind the flag
 * AND the admin gate. Deliberately NOT the ensureLvcProposalTables() idiom, which runs on every
 * MCP propose or ratify call — that is how a runtime DDL and a migration file once disagreed on
 * a column with nobody noticing (kickoff §6 trap 3). The bridge route does not call this.
 */
export async function ensureRuleGovernanceTables(): Promise<void> {
  assertEnabled();
  for (const ddl of RULE_GOVERNANCE_DDL) await run(ddl, []);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The definition hash — ONE expression, both write paths.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * md5 over the five executable-definition fields (DEFINITION_HASH_FIELDS) in their canonical
 * order, joined by chr(31) — the ASCII unit separator, which cannot occur in a rule's text.
 * coalesce, not concat_ws: concat_ws SKIPS a NULL argument, which would let ('x', null) and
 * (null, 'x') hash identically.
 *
 * Built from a caller-supplied list of SQL expressions so the bootstrap path (column references)
 * and the proposal path (typed placeholders) hash the same definition IDENTICALLY. That is why
 * both callers hand `keywords` in as jsonb: the registry column is TEXT[] (migrate-choosing-wisely
 * route:23) and the proposal parameter is a JSON string, so only a common jsonb::text rendering
 * makes the two comparable. A test asserts both call sites pass exactly
 * DEFINITION_HASH_FIELDS.length expressions.
 */
export function definitionHashSql(exprs: readonly string[]): string {
  if (exprs.length !== DEFINITION_HASH_FIELDS.length) {
    throw new Error(`definitionHashSql expects ${DEFINITION_HASH_FIELDS.length} expressions (${DEFINITION_HASH_FIELDS.join(', ')})`);
  }
  return `md5(${exprs.map((e) => `coalesce(${e}::text, '')`).join(` || chr(31) || `)})`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §3.7 — the pattern → proposal bridge write. ONE STATEMENT (O2).
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Proposal state + the immutable version row + the pattern mapping, in a single data-modifying-CTE
 * statement. All three land or none do.
 *
 * IT WRITES NO ACTIVATION EVENT (S4) and NO lvc_recommendations ROW (§3.7, kickoff §6 trap 1).
 *
 * `rule_ref` is MINTED here as `ehrc-<uuid>` — the house convention the MCP promotion path already
 * uses (lib/mcp-tools.ts:1295) — and names no registry row today. That is deliberate and is why
 * §3.1 forbids a foreign key: R3-B is the unit that would create the registry row under exactly
 * this id. Nothing reads a rule_ref that names no row, because nothing reads these tables at all.
 *
 * IDEMPOTENCY / DEDUP: the proposal INSERT carries a NOT EXISTS guard on an identical pending
 * statement. When it fires, the CTE chain has no proposal row to feed, so the version and map
 * INSERTs select from an empty set and the whole statement writes nothing and returns no row —
 * a re-POST of the same pattern is a no-op rather than a duplicate rule book entry. NOTE: this is
 * an EXACT-statement guard, not F14's near-duplicate gate (lvc_propose's loadExistingStatements);
 * running that gate needs a second read and is therefore R3-B's, not this statement's.
 */
export const PROPOSE_PATTERN_SQL = `WITH prop AS (
  INSERT INTO lvc_recommendation_proposals
    (statement, rationale, evidence_note, source, category, action_type, keywords, provenance,
     status, proposed_by)
  SELECT $1::text, $2::text, $3::text, 'lvp-pattern', $4::text, $5::text, $6::jsonb, 'lvp-pattern',
         'proposed', $7::text
   WHERE NOT EXISTS (
     SELECT 1 FROM lvc_recommendation_proposals p
      WHERE p.status = 'proposed' AND lower(p.statement) = lower($1::text)
   )
  RETURNING id
), ver AS (
  INSERT INTO lvc_rule_versions
    (rule_ref, version, statement, precondition, action_type, keywords, category, definition_hash,
     origin, evaluator_disposition, proposal_id,
     ratified_by, rationale, sample_size, reviewed_n, sample_seed, n_not_belonging)
  SELECT $8::text, 1, $1::text, $9::text, $5::text, $6::jsonb, $4::text,
         ${definitionHashSql(['$1', '$9', '$5', '$6::jsonb', '$4'])},
         'proposal', '${EVALUATOR_DISPOSITION}', prop.id,
         $10::text, $11::text, $12::int, $13::int, $14::text, $15::int
    FROM prop
  RETURNING rule_ref, version, definition_hash
), map AS (
  INSERT INTO rule_pattern_map
    (lvp_pattern_id, rule_ref, evidence_snapshot,
     ratified_by, rationale, sample_size, reviewed_n, sample_seed, n_not_belonging)
  SELECT $16::text, ver.rule_ref, $17::jsonb,
         $10::text, $11::text, $12::int, $13::int, $14::text, $15::int
    FROM ver
  RETURNING id
)
SELECT (SELECT id::text FROM prop)          AS proposal_id,
       (SELECT rule_ref FROM ver)           AS rule_ref,
       (SELECT definition_hash FROM ver)    AS definition_hash,
       (SELECT id::text FROM map)           AS map_id`;

export interface ProposePatternInput {
  ruleRef: string;                       // minted by the caller (mintRuleRef)
  statement: string;
  precondition: string | null;
  rationale_text: string | null;         // the proposal's own rationale field (not the evidence one)
  evidence_note: string | null;
  category: string | null;
  action_type: string | null;
  keywords: unknown[];
  lvpPatternId: string;
  snapshot: PatternEvidenceSnapshot;
  evidence: GovernanceEvidence;
}

export interface ProposePatternResult {
  proposal_id: string | null;
  rule_ref: string | null;
  definition_hash: string | null;
  map_id: string | null;
  written: boolean;                      // false ⇒ the dedup guard fired; nothing was written
}

/** ONE await. ONE statement. No second write path exists in this function by construction. */
export async function proposePatternAsRule(input: ProposePatternInput): Promise<ProposePatternResult> {
  assertEnabled();
  const ev = asEvidence(input.evidence);
  const rows = await run(PROPOSE_PATTERN_SQL, [
    input.statement,                       // $1
    input.rationale_text,                  // $2
    input.evidence_note,                   // $3
    input.category,                        // $4
    input.action_type,                     // $5
    JSON.stringify(input.keywords ?? []),  // $6
    ev.ratified_by,                        // $7  proposed_by — the named human, never 'admin'
    input.ruleRef,                         // $8
    input.precondition,                    // $9
    ev.ratified_by,                        // $10
    ev.rationale,                          // $11
    ev.sample_size,                        // $12
    ev.reviewed_n,                         // $13
    ev.sample_seed,                        // $14
    ev.n_not_belonging,                    // $15
    input.lvpPatternId,                    // $16
    JSON.stringify(input.snapshot),        // $17
  ]);
  const r = rows[0] ?? {};
  const proposalId = r.proposal_id == null ? null : String(r.proposal_id);
  return {
    proposal_id: proposalId,
    rule_ref: r.rule_ref == null ? null : String(r.rule_ref),
    definition_hash: r.definition_hash == null ? null : String(r.definition_hash),
    map_id: r.map_id == null ? null : String(r.map_id),
    written: proposalId != null,
  };
}

// ── the slots-provenance probe (S8) ──────────────────────────────────────────────────────────────

/**
 * Which source supplied direction/action/target for this concept (S8). loadShelf() decides this at
 * lib/lvp-store.ts:163-166 with `meta.get(concept_id) ?? parsed` and discards which arm won; the
 * shelf module is on the untouched list, so the bridge re-asks the SAME question with the SAME
 * predicate — does lvc_concepts hold this concept_id — rather than editing the shelf to return it.
 * Read-only. A read failure degrades to 'prefix_parse', the weaker of the two claims.
 */
export const SLOTS_PROVENANCE_SQL = `SELECT concept_id FROM lvc_concepts WHERE concept_id = $1`;

export async function slotsProvenanceFor(conceptId: string): Promise<'dictionary' | 'prefix_parse'> {
  const rows = await run(SLOTS_PROVENANCE_SQL, [conceptId]).catch(() => []);
  return rows.length ? 'dictionary' : 'prefix_parse';
}

/** `ehrc-<uuid>` — the house rule-id convention (lib/mcp-tools.ts:1295). Minted in JS rather than
 *  in SQL so the caller can return it without a second read. */
export function mintRuleRef(): string {
  return `ehrc-${randomUUID()}`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// §3.8 — BOOTSTRAP. BUILT, NOT EXECUTED.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Snapshot every existing registry rule's CURRENT definition into lvc_rule_versions as
 * `bootstrap_snapshot`, version 1.
 *
 * THIS IS NEVER A RETROACTIVE RATIFICATION (§3.8). A bootstrap row records what a rule's
 * executable definition WAS at snapshot time and nothing else; the evidence tuple on it names the
 * operator who ran the snapshot and says so in the rationale. It writes ZERO activation events —
 * so no bootstrap row is ever `active` in the derived window view, which is the whole point.
 *
 * IT IS NOT EXECUTED BY ANYTHING IN THIS BUILD. No route calls it, no cron calls it, no test calls
 * it against a database. Execution requires separate operator authorization (§3.8) and a caller
 * that does not exist yet.
 *
 * The ONE statement in this module that names lvc_recommendations, and it only SELECTs from it:
 * no INSERT, no UPDATE, no DELETE, no ALTER, no status value, no new row (kickoff §6 trap 1).
 * The NOT EXISTS guard makes a second run a no-op rather than a duplicate-key failure.
 */
export const BOOTSTRAP_SNAPSHOT_SQL = `INSERT INTO lvc_rule_versions
  (rule_ref, version, statement, precondition, action_type, keywords, category, definition_hash,
   origin, evaluator_disposition,
   ratified_by, rationale, sample_size, reviewed_n, sample_seed, n_not_belonging)
SELECT r.id::text, 1, r.statement, r.precondition, r.action_type, to_jsonb(r.keywords), r.category,
       ${definitionHashSql(['r.statement', 'r.precondition', 'r.action_type', 'to_jsonb(r.keywords)', 'r.category'])},
       'bootstrap_snapshot', '${EVALUATOR_DISPOSITION}',
       $1::text, $2::text, $3::int, $4::int, $5::text, $6::int
  FROM lvc_recommendations r
 WHERE NOT EXISTS (
   SELECT 1 FROM lvc_rule_versions v WHERE v.rule_ref = r.id::text AND v.version = 1
 )
RETURNING rule_ref`;

/** Built, not executed (§3.8). Requires the flag AND separate operator authorization. */
export async function bootstrapRuleVersions(evidence: GovernanceEvidence): Promise<string[]> {
  assertEnabled();
  const ev = asEvidence(evidence);
  const rows = await run(BOOTSTRAP_SNAPSHOT_SQL, [
    ev.ratified_by, ev.rationale, ev.sample_size, ev.reviewed_n, ev.sample_seed, ev.n_not_belonging,
  ]);
  return rows.map((r) => String(r.rule_ref));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Reads — none of these is called by anything in this build either.
// ════════════════════════════════════════════════════════════════════════════════════════════════

export const READ_ACTIVATION_EVENTS_SQL = `SELECT id, rule_ref, version, event,
       to_char(effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS effective_at
FROM lvc_rule_activation_events WHERE rule_ref = ANY($1) ORDER BY rule_ref, effective_at, id`;

export const READ_VALIDITY_WINDOWS_SQL = `SELECT rule_ref, version,
       to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_from,
       to_char(valid_to   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valid_to
FROM v_lvc_rule_validity WHERE rule_ref = ANY($1) ORDER BY rule_ref, valid_from, version`;

export async function loadActivationEvents(ruleRefs: string[]): Promise<ActivationEvent[]> {
  assertEnabled();
  const rows = await run(READ_ACTIVATION_EVENTS_SQL, [ruleRefs]);
  return rows.map((r) => ({
    id: Number(r.id),
    rule_ref: String(r.rule_ref),
    version: Number(r.version),
    event: String(r.event) as ActivationEvent['event'],
    effective_at: String(r.effective_at),
  }));
}

export async function loadValidityWindows(ruleRefs: string[]): Promise<ValidityWindow[]> {
  assertEnabled();
  const rows = await run(READ_VALIDITY_WINDOWS_SQL, [ruleRefs]);
  return rows.map((r) => ({
    rule_ref: String(r.rule_ref),
    version: Number(r.version),
    valid_from: String(r.valid_from),
    valid_to: r.valid_to == null ? null : String(r.valid_to),
  }));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// R3-A2 — THE ACTIVATION-EVENT WRITER. Dormant.
//
// ⚠️ THE RESIDUAL CONSTRAINT, AT THE CALL SITE RATHER THAN ONLY IN A REPORT (Rep 46 point 8):
//
//   THE ONE-STATEMENT EVENT-ONLY WRITER CANNOT GUARANTEE SERIALIZATION BETWEEN CONCURRENT
//   TRANSITIONS USING DIFFERENT IDEMPOTENCY UUIDS. Two activations racing under different
//   `event_ref`s are not ordered by this design. IT MUST RETAIN ZERO PRODUCTION CALLERS UNTIL
//   R3-B PROVIDES THE ATOMIC LIVE WORKFLOW.
//
// Why it is here at all: the shape of the write, the preconditions and the refusals are settled
// now, under review, rather than being invented later inside the live workflow. What is NOT
// settled is ordering between racing writers, and that is R3-B's problem to solve — not something
// to paper over with an advisory lock this module has no transaction to hold.
//
// The race, concretely: two callers each activate a different version of the same rule, with
// different `event_ref`s, at the same instant. Both statements independently observe the same
// "currently active" version, both pass their preconditions, and both append. The stream then
// contains two activates in an order the database chose, and `v_lvc_rule_validity` will derive a
// window from it — a window nobody intended. The unique `event_ref` prevents a DUPLICATE; it
// cannot order two DISTINCT intentions.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ONE data-modifying CTE. One statement is one transaction on Neon's HTTP driver, so every
 * precondition below is evaluated INSIDE the same statement that inserts — never read first and
 * checked in TypeScript, which would be a read and a write with a gap between them.
 *
 * ⚠️ `effective_at` IS NOT IN THE INSERT COLUMN LIST. The column's `DEFAULT now()` stamps it. No
 * parameter carries an instant and none is accepted (see `validateActivationRequest`), because the
 * validity window is DERIVED from event order: a caller-supplied timestamp would not merely
 * mislabel a row, it would silently rewrite which version was live and when.
 *
 * ⚠️ THE ONLY TABLE THIS STATEMENT WRITES IS `lvc_rule_activation_events`. `lvc_recommendations`,
 * `lvc_rule_versions`, `lvc_recommendation_proposals` and `rule_pattern_map` appear ONLY inside
 * read-only subqueries. Events only (§3).
 */
export const RECORD_ACTIVATION_EVENT_SQL = `WITH req AS (
  SELECT $1::uuid AS event_ref, $2::text AS rule_ref, $3::int AS version, $4::text AS event,
         $5::text AS ratified_by, $6::text AS rationale, $7::int AS sample_size,
         $8::int AS reviewed_n, $9::text AS sample_seed, $10::int AS n_not_belonging
), prior AS (
  -- The idempotency key, already used or not. same_payload is what separates a REPLAY from a
  -- caller who reused a key for a different intention.
  SELECT e.id, e.rule_ref, e.version, e.event,
         (e.rule_ref = r.rule_ref AND e.version = r.version AND e.event = r.event) AS same_payload
    FROM lvc_rule_activation_events e, req r
   WHERE e.event_ref = r.event_ref
), ver AS (
  SELECT v.* FROM lvc_rule_versions v, req r
   WHERE v.rule_ref = r.rule_ref AND v.version = r.version
), led AS (
  -- The append-only ratification ledger entry for the proposal on this version, if any. The
  -- promoted_id column is the rule identity the ratification promoted TO.
  SELECT lr.promoted_id
    FROM lvc_ratifications lr, ver v
   WHERE lr.proposal_id = v.proposal_id AND lr.decision = 'ratified'
   ORDER BY lr.created_at DESC, lr.id DESC
   LIMIT 1
), cur AS (
  -- The version currently active for this rule, DERIVED from the stream by the same view the rest
  -- of the module reads. An open window (valid_to IS NULL) is the live one.
  SELECT w.version
    FROM v_lvc_rule_validity w, req r
   WHERE w.rule_ref = r.rule_ref AND w.valid_to IS NULL
   ORDER BY w.valid_from DESC
   LIMIT 1
), decision AS (
  SELECT r.*,
         (SELECT count(*) FROM prior) > 0                       AS replayed,
         coalesce((SELECT same_payload FROM prior), false)       AS same_payload,
         (SELECT id::text FROM prior)                            AS prior_id,
         CASE
           -- ── an exact replay, and a conflicting reuse ──────────────────────────────────────
           WHEN (SELECT count(*) FROM prior) > 0
                AND NOT coalesce((SELECT same_payload FROM prior), false)
             THEN 'idempotency_conflict'
           WHEN (SELECT count(*) FROM prior) > 0 THEN NULL      -- already applied; not a refusal
           WHEN (SELECT count(*) FROM ver) = 0 THEN 'unknown_version'
           -- ── RETIREMENT: that exact version must be currently active ───────────────────────
           WHEN r.event = 'retire' THEN
             CASE WHEN (SELECT version FROM cur) IS DISTINCT FROM r.version
                  THEN 'version_not_active' ELSE NULL END
           -- ── ACTIVATION: all six preconditions, in order ───────────────────────────────────
           -- 1. a COMPLETE EXECUTABLE DEFINITION. A shelf-origin promotion has no matcher
           --    keywords, so it stops here — intended, and there is no bypass.
           WHEN NOT (
             btrim(coalesce((SELECT statement FROM ver), '')) <> ''
             AND (SELECT keywords FROM ver) IS NOT NULL
             AND jsonb_typeof((SELECT keywords FROM ver)) = 'array'
             AND jsonb_array_length((SELECT keywords FROM ver)) > 0
             AND btrim(coalesce((SELECT action_type FROM ver), '')) <> ''
             AND btrim(coalesce((SELECT category FROM ver), '')) <> ''
           ) THEN 'incomplete_definition'
           -- 2. a MATCHING HASH — recomputed here from the columns on the row itself, never trusted.
           WHEN (SELECT definition_hash FROM ver) IS DISTINCT FROM (
             SELECT ${definitionHashSql([
               'v.statement', 'v.precondition', 'v.action_type', 'v.keywords', 'v.category',
             ])} FROM ver v
           ) THEN 'definition_hash_mismatch'
           -- 3. INFORMATIONAL DISPOSITION (S4).
           WHEN (SELECT evaluator_disposition FROM ver) IS DISTINCT FROM '${EVALUATOR_DISPOSITION}'
             THEN 'not_informational'
           -- 4. PROPOSAL RATIFICATION. A bootstrap snapshot has no proposal at all, so it stops
           --    here — bootstrap is not ratification (§3.8), and that is a separate word.
           WHEN (SELECT origin FROM ver) = 'bootstrap_snapshot'
             THEN 'bootstrap_origin_not_ratification'
           WHEN (SELECT proposal_id FROM ver) IS NULL
                OR NOT EXISTS (SELECT 1 FROM lvc_recommendation_proposals p, ver v
                                WHERE p.id = v.proposal_id AND p.status = 'ratified')
             THEN 'not_ratified_proposal'
           -- 5. a MATCHING RATIFICATION-LEDGER ENTRY.
           WHEN (SELECT count(*) FROM led) = 0 THEN 'no_ratification_ledger_entry'
           -- 6. promoted_id === rule_ref.
           WHEN (SELECT promoted_id FROM led) IS DISTINCT FROM r.rule_ref
             THEN 'promoted_id_mismatch'
           ELSE NULL
         END AS refusal
    FROM req r
), ins AS (
  INSERT INTO lvc_rule_activation_events
    (event_ref, rule_ref, version, event,
     ratified_by, rationale, sample_size, reviewed_n, sample_seed, n_not_belonging)
  SELECT d.event_ref, d.rule_ref, d.version, d.event,
         d.ratified_by, d.rationale, d.sample_size, d.reviewed_n, d.sample_seed, d.n_not_belonging
    FROM decision d
   WHERE d.refusal IS NULL AND NOT d.replayed
  RETURNING id
)
SELECT CASE WHEN d.refusal IS NOT NULL THEN 'refused'
            WHEN d.replayed THEN 'already_applied'
            ELSE 'inserted' END                                  AS status,
       d.refusal                                                 AS refusal,
       d.event_ref::text                                         AS event_ref,
       coalesce((SELECT id::text FROM ins), d.prior_id)           AS id
  FROM decision d`;

/**
 * Append ONE activation or retirement event. Dormant — see the module block above.
 *
 * ⚠️ ZERO PRODUCTION CALLERS, AND THAT IS A REQUIREMENT UNTIL R3-B (Rep 46 point 8), not an
 * accident of it being new. `lib/__tests__/rule-governance-dormancy.test.ts` proves it.
 *
 * ⚠️ THE FLAG IS CHECKED FIRST, BEFORE VALIDATION AND BEFORE ANY SQL IS BUILT. Flag off ⇒ this
 * throws and NOTHING is executed — proven behaviourally by an injected runner that counts calls,
 * not by reading the source.
 *
 * ⚠️ IT NEVER CALLS `ensureRuleGovernanceTables()`. That is how a dormant module accidentally
 * creates tables in production: one convenience call on a path somebody later made live.
 */
export async function recordActivationEvent(
  input: ActivationRequest,
  runner: typeof run = run,
): Promise<ActivationOutcome> {
  assertEnabled();                                  // FIRST. Before anything else.
  const problems = validateActivationRequest(input);
  if (problems.length) throw new Error(`invalid activation request: ${problems.join('; ')}`);
  const ev = asEvidence(input.evidence);
  const rows = await runner(RECORD_ACTIVATION_EVENT_SQL, [
    input.event_ref,          // $1
    input.rule_ref,           // $2
    input.version,            // $3
    input.event,              // $4
    ev.ratified_by,           // $5
    ev.rationale,             // $6
    ev.sample_size,           // $7
    ev.reviewed_n,            // $8
    ev.sample_seed,           // $9
    ev.n_not_belonging,       // $10
  ]);
  const r = (rows[0] ?? {}) as Record<string, unknown>;
  const status = String(r.status ?? 'refused');
  const eventRef = String(r.event_ref ?? input.event_ref);
  if (status === 'refused') {
    return { status: 'refused', event_ref: eventRef, reason: String(r.refusal) as ActivationRefusal };
  }
  return {
    status: status === 'already_applied' ? 'already_applied' : 'inserted',
    event_ref: eventRef,
    id: String(r.id ?? ''),
  };
}
