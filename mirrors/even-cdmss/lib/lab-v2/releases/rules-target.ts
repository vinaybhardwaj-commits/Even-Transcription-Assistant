/**
 * lib/lab-v2/releases/rules-target.ts — the `rules` release target
 * (LAB-MCP-V2-PRD-v1.0 §17.7 C2, decisions 79, 89 and 90).
 *
 * ⚠️ THE SYMMETRY WITH THE CORPUS, AND THE ONE PLACE IT INVERTS.
 *
 * The corpus needed a NEW statement for its INVERSE (decision 80a) because v1 has no deactivate,
 * and none for the forward write because `corpusActivate` is exported. **Rules are the exact
 * opposite.** The inverse exists, exported, id-keyed and guarded — `RETIREMENT_UPDATE_SQL` in
 * `lib/lvc-ratified-wording.ts:115` — and it is the FORWARD write that could not be reached, because
 * `lvcRatify` was module-private in a file §14.3 freezes. Decision 89 adds the word `export` to that
 * function and nothing else, so both directions are now v1's own code, imported.
 *
 * ⚠️ NEITHER DIRECTION HAS A STATEMENT OF ITS OWN IN THIS FILE. `c2-rules.test.ts` extends decision
 * 79's grep to `lvc_*` with exactly two exemptions — `lvcRatify` and `RETIREMENT_UPDATE_SQL`, both
 * reached by import — and fails on any `INSERT`, `UPDATE` or `DELETE` written here.
 *
 * ⚠️ `lvcRatify` RETURNS AN MCP ENVELOPE, NOT A VALUE, and that is worth stating rather than
 * hiding. It is a v1 TOOL: `{ content: [{ type: 'text', text: '<json>' }], isError? }`. Decision 89
 * exported it as it is; changing its signature would have been a second edit to a frozen file. So
 * the promoted id is parsed back out of that text here, in one place, with the parse failure
 * reported as itself rather than as a missing id.
 */
import { LabError } from '../contracts';
import { boundedRead } from '../sources/read';
import { lvcRatify } from '../../mcp-tools';
import { RETIREMENT_UPDATE_SQL } from '../../lvc-ratified-wording';
import { sql } from '../../db';

const SOURCE = 'lvc_recommendations';

/** §17.7 C2 — what a rules rollback writes. See the header note on decision 90. */
export const RETIRED_STATUS = 'retired';

/** A uuid, refused rather than escaped — the shape a proposal id always has. */
function uuidLit(value: string, field: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(String(value))) throw new LabError('INVALID_INPUT', `${field} must be a uuid`);
  return `'${value}'`;
}

/** An `ehrc-<uuid>` recommendation id, or any id v1's own convention produces. */
function recIdLit(value: string, field: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(value))) {
    throw new LabError('INVALID_INPUT', `${field} contains characters that are not allowed in a recommendation id`);
  }
  return `'${value}'`;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The inferred reads. Every one is a SELECT through `boundedRead` — the v1 read-only
// guard and decision 31's 15 s deadline. Listed verbatim in the build report.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * THE ACTIVE RULEBOOK, exactly as the engine selects it.
 *
 * ⚠️ `WHERE status = 'active'` IS THE WHOLE SELECTION. `getLvcRules` (`lib/opd-note-audit.ts:121`)
 * reads `SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'` and nothing
 * else, so a rules release is a flip of `status` and the predecessor of a release is the set of ids
 * that predicate returns. This statement adds `statement` and `society` for the report and keeps the
 * predicate identical; a second predicate here would describe a rulebook the engine does not use.
 */
export const ACTIVE_RULES_SQL = `SELECT id, statement, society, category, keywords, status
FROM lvc_recommendations
WHERE status = 'active'
ORDER BY id
LIMIT 500`;

/** Just the ids, for the predecessor hash and the prepare/apply comparison. */
export const ACTIVE_RULE_IDS_SQL = `SELECT id FROM lvc_recommendations WHERE status = 'active' ORDER BY id LIMIT 500`;

/** One staged proposal, with everything a reviewer must read before approving it. */
export const PROPOSAL_SQL = (proposalId: string) => `SELECT
  id::text AS id, statement, rationale, evidence_note, category, keywords,
  citation_url, citation_doi, citation_pmid, source_release_year, license_status, provenance,
  status, proposed_by, proposed_at, supersedes_id, promoted_id
FROM lvc_recommendation_proposals
WHERE id = ${uuidLit(proposalId, 'proposal_id')}
LIMIT 1`;

/** One recommendation, by id — how a receipt's claim is checked after the fact. */
export const RECOMMENDATION_SQL = (id: string) => `SELECT
  id, statement, society, category, keywords, status, ratified_by, ratified_at
FROM lvc_recommendations
WHERE id = ${recIdLit(id, 'recommendation_id')}
LIMIT 1`;

/** The ratification ledger for one proposal — v1's own append-only trail. */
export const RATIFICATIONS_SQL = (proposalId: string) => `SELECT
  id, proposal_id::text AS proposal_id, decision, ratified_by, rationale, reason, promoted_id, created_at
FROM lvc_ratifications
WHERE proposal_id = ${uuidLit(proposalId, 'proposal_id')}
ORDER BY created_at DESC
LIMIT 50`;

export interface RulesDeps {
  read?: <T>(source: string, statement: string, params?: unknown[]) => Promise<T[]>;
  /** Injection seams for tests. Production replaces neither: both are v1's own code. */
  ratify?: typeof lvcRatify;
  run?: (statement: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
}

const liveRead = <T>(source: string, statement: string, params: unknown[] = []) => boundedRead<T>(source, statement, params, 500);
const liveRun = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface LvcRuleRow { id: string; statement: string | null; society: string | null; category: string | null; keywords: unknown; status: string }

/** v1 stores `keywords` as jsonb or as a comma string; `getLvcRules` parses both, and so does this. */
export function parseKeywords(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string') {
    try { const j = JSON.parse(v); if (Array.isArray(j)) return j.map((x) => String(x)); } catch { /* not json */ }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export async function activeRules(deps: RulesDeps = {}): Promise<LvcRuleRow[]> {
  const read = deps.read ?? liveRead;
  const rows = await read<Record<string, unknown>>(SOURCE, ACTIVE_RULES_SQL);
  return rows.map((r) => ({
    id: String(r.id),
    statement: r.statement == null ? null : String(r.statement),
    society: r.society == null ? null : String(r.society),
    category: r.category == null ? null : String(r.category),
    keywords: parseKeywords(r.keywords),
    status: String(r.status ?? ''),
  }));
}

export async function activeRuleIds(deps: RulesDeps = {}): Promise<string[]> {
  const read = deps.read ?? liveRead;
  return (await read<Record<string, unknown>>(SOURCE, ACTIVE_RULE_IDS_SQL)).map((r) => String(r.id));
}

export interface ProposalRow {
  id: string; statement: string; rationale: string | null; category: string | null;
  keywords: string[]; status: string; proposed_by: string | null; supersedes_id: string | null;
  promoted_id: string | null;
}

export async function readProposal(proposalId: string, deps: RulesDeps = {}): Promise<ProposalRow> {
  const read = deps.read ?? liveRead;
  const rows = await read<Record<string, unknown>>('lvc_recommendation_proposals', PROPOSAL_SQL(proposalId));
  const r = rows[0];
  if (!r) throw new LabError('CASE_NOT_FOUND', `no lvc_recommendation_proposals row ${proposalId}`);
  return {
    id: String(r.id),
    statement: String(r.statement ?? ''),
    rationale: r.rationale == null ? null : String(r.rationale),
    category: r.category == null ? null : String(r.category),
    keywords: parseKeywords(r.keywords),
    status: String(r.status ?? ''),
    proposed_by: r.proposed_by == null ? null : String(r.proposed_by),
    supersedes_id: r.supersedes_id == null ? null : String(r.supersedes_id),
    promoted_id: r.promoted_id == null ? null : String(r.promoted_id),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The two writers — both v1's, both imported
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * DECISION 89 — promotion, through v1's own `lvcRatify`.
 *
 * ⚠️ THE ENVELOPE IS PARSED HERE AND NOWHERE ELSE. `lvcRatify` is a v1 MCP tool and answers with
 * `{content:[{type:'text',text}], isError?}`. An `isError` envelope carries `Error: <message>` as
 * prose, and a success envelope carries JSON. Both are handled explicitly: a promotion that
 * "succeeded" with no `promoted_id` is reported as a failure, not as a release with a null id,
 * because a receipt naming no row is a receipt nothing can roll back.
 */
export async function promoteProposal(
  a: { proposal_id: string; ratified_by: string; rationale: string }, deps: RulesDeps = {},
): Promise<{ promoted_id: string; raw: unknown }> {
  const ratify = deps.ratify ?? lvcRatify;
  const res = await ratify({
    proposal_id: a.proposal_id,
    // v1 requires it and says why: "ratification writes to the governed rulebook path".
    confirm: true,
    ratified_by: a.ratified_by,
    rationale: a.rationale,
    decision: 'ratified',
  });
  const text = String(res?.content?.[0]?.text ?? '');
  if (res?.isError) {
    throw new LabError('SOURCE_UNAVAILABLE', `lvc_ratify refused: ${text.replace(/^Error:\s*/, '').slice(0, 300)}`);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new LabError('SOURCE_UNAVAILABLE', `lvc_ratify returned a body this release cannot read: ${text.slice(0, 200)}`);
  }
  const promoted = body.promoted_id == null ? '' : String(body.promoted_id);
  if (!promoted) {
    throw new LabError('SOURCE_UNAVAILABLE',
      `lvc_ratify reported status '${String(body.status ?? 'unknown')}' with no promoted_id; a receipt naming no row could never be rolled back`);
  }
  return { promoted_id: promoted, raw: body };
}

/**
 * DECISION 90 — the inverse, through v1's own `RETIREMENT_UPDATE_SQL`.
 *
 * ⚠️ IT RETIRES, IT DOES NOT DELETE. The row keeps its statement, its citation and its ratifier for
 * the record; `status` is what removes it from `getLvcRules`'s `WHERE status = 'active'`. §11's
 * caveat is literally true here: nothing about the audits written while the rule was live changes.
 *
 * ⚠️ ITS `IS DISTINCT FROM` GUARD DOES NOT GIVE IDEMPOTENCE HERE, AND SAYING SO MATTERS. The guard
 * is `status IS DISTINCT FROM $2 OR ratified_by IS DISTINCT FROM $3 OR ratified_at IS DISTINCT FROM
 * $4`, and `$4` is the retirement instant — a fresh timestamp on every call. So the third disjunct
 * is always true and a repeat DOES match and DOES return the id, even on a row that was already
 * retired. `RETURNING id` therefore means "this row exists", not "this row changed". Idempotence
 * comes from the receipts table's `UNIQUE (release_id, kind)`, exactly as it does for the corpus,
 * and whether the status actually reads `retired` afterwards is read back rather than inferred
 * (decision 87). The fresh timestamp is kept deliberately: a retirement instant that lied about
 * when the row was retired would be worse than a guard that cannot double as an idempotence check.
 */
export async function retireRecommendation(
  a: { recommendation_id: string; retired_by: string; status?: string }, deps: RulesDeps = {},
): Promise<{ ids: string[]; status: string }> {
  const run = deps.run ?? liveRun;
  const id = String(a.recommendation_id ?? '').trim();
  if (!id) throw new LabError('INVALID_INPUT', 'a rules rollback needs the recommendation id the apply receipt recorded');
  recIdLit(id, 'recommendation_id');
  const status = a.status ?? RETIRED_STATUS;
  const rows = await run(RETIREMENT_UPDATE_SQL, [id, status, a.retired_by, new Date().toISOString()]);
  return { ids: rows.map((r) => String(r.id)), status };
}
