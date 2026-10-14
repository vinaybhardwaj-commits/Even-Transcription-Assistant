/**
 * lib/lab-v2/tools/rules.ts — `rule_propose` and `rule_simulate`
 * (LAB-MCP-V2-PRD-v1.0 §17.7 C2, decisions 82 and 89).
 *
 * ⚠️ DECISION 82, SETTLED BY MEASUREMENT: LVC RULES NEVER REACH THE MODEL.
 *
 * `getLvcRules`' own comment says it (`lib/opd-note-audit.ts:106`): the LLM prompt does not load
 * them. `buildOpdAuditUser(caseText, citedContext)` takes two arguments and neither is a rule.
 * `stampLvcMetadata(out, lvcRules)` runs on the findings AFTER the reply and returns
 * `{...f, rule_ref, lvc_category}` — two fields, on findings already verdicted low-value.
 *
 * So a simulation is an EXACT REPLAY. Not "cheap enough": a rule cannot change the reply, so
 * replaying the stored reply is not an approximation of a fresh run — it is the same computation.
 * Zero model calls, and the live transport is wired to throw, so that is structural.
 *
 * ⚠️ THE MEASURABLE DELTA IS NARROW AND THE OUTPUT SAYS SO OUT LOUD. A rule can change `rule_ref`
 * and `lvc_category` and nothing else. It cannot add a finding, remove one, or move a verdict, a
 * confidence, the note-quality index or the band. A simulation that reported "3 audits changed"
 * without saying what changed would read as a score movement, which is exactly what it is not.
 *
 * ⚠️ NEITHER TOOL WRITES `lvc_*`. `rule_propose` reaches v1's own `lvc_propose` through v1's own
 * exported dispatcher `callLabTool` — no second export of a §14.3 function beyond decision 89's one
 * token, and no INSERT of our own. `rule_simulate` reads and replays. `c2-rules.test.ts` extends
 * decision 79's grep to `lvc_*` over this file and `releases/**` with exactly two exemptions.
 *
 * ⚠️⚠️ AND SEE `KEYWORDLESS_PROPOSAL` BELOW. A rule promoted end to end through v1's own path lands
 * with `keywords = '{}'` and can never match a finding. That is not a thing this round invented and
 * it is not a thing this round may fix; it is refused by name rather than reported as a zero.
 */
import { z } from 'zod';
import { LabError, hash } from '../contracts';
import { getObject, getRun, itemsOf, putObject, submitRun } from '../store';
import { replayTransport } from './replay';
import { tick } from '../worker';
import { activeRules, readProposal, type LvcRuleRow, type RulesDeps } from '../releases/rules-target';
import { callLabTool } from '../../mcp-tools';
import { PROPOSAL_CATEGORIES } from '../../lvc-proposal-core';
import type { Db } from '../db';

export const RULES_SCHEMAS = {
  rule_propose: {
    input: z.object({
      statement: z.string().min(10).max(2000),
      rationale: z.string().max(4000).optional(),
      evidence_note: z.string().max(4000).optional(),
      /** v1's citation gate: (url OR doi OR pmid) AND year AND licence. Enforced by v1, not here. */
      citation_url: z.string().max(500).optional(),
      citation_doi: z.string().max(200).optional(),
      citation_pmid: z.string().max(50).optional(),
      source_release_year: z.number().int().min(1900).max(2100).optional(),
      license_status: z.string().max(120).optional(),
      provenance: z.string().max(500).optional(),
      supersedes_id: z.string().max(100).optional(),
      /**
       * DECISION 95 — the two fields decision 94 taught v1 to carry, forwarded.
       *
       * ⚠️ `PROPOSAL_CATEGORIES` IS IMPORTED, NOT RESTATED. `lvc-proposal-core.ts` already holds the
       * frozen copy of the engine's twelve, with a test pinning it equal to `LVC_CATEGORIES`. A
       * third copy here would be a third thing to keep in step.
       */
      keywords: z.array(z.string().min(1)).max(12).optional(),
      category: z.enum(PROPOSAL_CATEGORIES).optional(),
      idempotency_key: z.string().min(1),
    }),
    output: z.object({
      proposal_id: z.string(),
      proposal_hash: z.string(),
      /** The v2 object a release is prepared against. Content-addressed and immutable. */
      staged_set_id: z.string().uuid(),
      deduplicated: z.boolean(),
      status: z.string(),
      statement: z.string(),
      supersedes_id: z.string().nullable(),
      /** DECISION 95 — what was forwarded, echoed back, so a reader is not left inferring it. */
      keywords: z.array(z.string()),
      category: z.string().nullable(),
      /** v1's own note, passed through verbatim: staged only, the rulebook is untouched. */
      note: z.string(),
      /** ⚠️ Read this. See KEYWORDLESS_PROPOSAL. */
      matching: z.string(),
    }),
  },
  rule_simulate: {
    input: z.object({
      proposal_id: z.string().uuid(),
      /** The baseline `opd_note_audit` run whose stored replies the simulation replays. */
      run_id: z.string().uuid(),
      idempotency_key: z.string().min(1),
    }),
    output: z.object({
      proposal_id: z.string(),
      baseline_run_id: z.string().uuid(),
      simulation_run_id: z.string().uuid(),
      simulation_ref: z.string().uuid(),
      deduplicated: z.boolean(),
      /** Structurally zero: the live transport is wired to throw, so a call cannot happen. */
      model_calls: z.number().int(),
      /** How many stored stages were served from `lab_v2.steps` — the work a replay actually did. */
      replayed_stages: z.number().int(),
      rules: z.object({ active: z.number().int(), simulated: z.number().int() }),
      /** ⚠️ Read this before the counts. */
      measures: z.string(),
      denominator: z.object({
        name: z.literal('items replayed equal'),
        items: z.number().int(),
        replayed_equal: z.number().int(),
        diverged: z.number().int(),
        not_measured: z.number().int(),
      }),
      changed_audits: z.number().int(),
      positives: z.array(z.object({
        case_key: z.string(), finding_index: z.number().int(), subject: z.string(),
        rule_ref_before: z.string().nullable(), rule_ref_after: z.string().nullable(),
        lvc_category_before: z.string().nullable(), lvc_category_after: z.string().nullable(),
      })),
      negatives: z.array(z.object({ case_key: z.string(), reason: z.string() })),
      per_item: z.array(z.object({
        case_key: z.string(),
        state: z.string(),
        /** `true` means the replay reproduced the baseline's finding SET; stamps may still differ. */
        replayed_equal: z.boolean(),
        diverged: z.boolean(),
        changed_findings: z.number().int(),
        error: z.string().nullable(),
      })),
    }),
  },
} as const;

/**
 * ⚠️ ON EVERY SIMULATION. §17.7's phrase "audits whose finding set would change" has to be read as
 * "whose finding STAMPS would change": the finding set is fixed by the model reply, which a rule
 * cannot touch.
 */
export const SIMULATION_MEASURES =
  'A rule changes `rule_ref` and `lvc_category` on findings that are ALREADY verdicted low-value, '
  + 'and nothing else. It cannot add or remove a finding, and it cannot move a verdict, a '
  + 'confidence, the note-quality index or the band. `changed_audits` counts audits whose finding '
  + 'STAMPS differ, over the items that replayed equal — it is never a score movement.';

/**
 * ⚠️⚠️ THE ONE THING IN THIS ROUND THAT IS NOT SETTLED, STATED WHERE IT BITES.
 *
 * A rule matches a finding through its KEYWORDS and through nothing else. `matchRule`
 * (`lib/opd-lvc-classify-core.ts`) is explicit: *"zero-keyword / empty-token rules never match"*,
 * and `getLvcRules` selects `id, keywords, category`.
 *
 * Neither v1 write supplies keywords:
 *   · `parseProposeArgs` (`lib/lvc-proposal-core.ts:143`) has no `keywords` and no `category` field
 *     — a caller cannot even express them;
 *   · `lvcPropose`'s INSERT names twelve columns of `lvc_recommendation_proposals` and neither is
 *     among them, though the table HAS both (`category text, keywords jsonb`);
 *   · `lvcRatify`'s promotion INSERT names fourteen columns of `lvc_recommendations` and neither is
 *     among them, though the table HAS both (`keywords TEXT[] DEFAULT '{}'`, migration 0005).
 *
 * So a rule proposed and promoted end to end through the ratified path lands active with an empty
 * keyword array and stamps nothing, for ever. Its simulation would be a guaranteed zero and its
 * release would put a no-op row into the governed rulebook.
 *
 * Closing it means editing `lib/mcp-tools.ts` past decision 89's single `export` token and editing
 * `lib/lvc-proposal-core.ts`, and the C2 file contract permits neither. So it is REFUSED BY NAME,
 * here and at `release_prepare`, and reported at the top of the round.
 */
export const KEYWORDLESS_PROPOSAL =
  'this proposal carries no keywords, and a rule matches through its keywords alone '
  + '(lib/opd-lvc-classify-core.ts matchRule: "zero-keyword / empty-token rules never match"). '
  + 'v1 cannot supply them: parseProposeArgs accepts no keywords field, lvc_propose’s INSERT '
  + 'does not name lvc_recommendation_proposals.keywords, and lvc_ratify’s promotion INSERT does '
  + 'not name lvc_recommendations.keywords, which defaults to \'{}\'. Promoting this row would add '
  + 'an active recommendation that can never stamp a finding, and simulating it would report a '
  + 'guaranteed zero as though it were a measurement. Refused rather than reported.';

export interface RulesToolDeps extends RulesDeps {
  /** Injection seam: v1's own dispatcher. Production replaces nothing. */
  call?: typeof callLabTool;
}

/** v1 answers with an MCP envelope; the body is parsed back out here and nowhere else. */
function bodyOf(res: { content?: { text?: string }[]; isError?: boolean } | null, tool: string, refusal: 'INVALID_INPUT' | 'SOURCE_UNAVAILABLE') {
  const text = String(res?.content?.[0]?.text ?? '');
  if (res?.isError) {
    throw new LabError(refusal, `${tool} refused: ${text.replace(/^Error:\s*/, '').slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new LabError('SOURCE_UNAVAILABLE', `${tool} returned a body this tool cannot read: ${text.slice(0, 200)}`);
  }
}

export async function rulePropose(
  db: Db, principal: string, args: Record<string, unknown>, deps: RulesToolDeps = {},
) {
  const call = deps.call ?? callLabTool;
  /**
   * ⚠️ v1's OWN PATH, INCLUDING ITS REFUSALS, AND WITHOUT A NEW EXPORT. `callLabTool` is already
   * exported (`lib/mcp-tools.ts:404`) and dispatches `lvc_propose` to `lvcPropose`, so decision 89's
   * "the word export and nothing else" stays literally true — the diff is one token.
   *
   * v1 runs the mandatory duplicate gate against the live rulebook AND the pending proposals and
   * refuses outright when that comparison set cannot be read ("proceeding would recreate the exact
   * duplication problem F14 exists for"), and it enforces the citation gate. None of that is
   * re-implemented here; a refusal is passed through with v1's own words.
   */
  const res = await call('lvc_propose', {
    statement: args.statement,
    rationale: args.rationale,
    evidence_note: args.evidence_note,
    citation_url: args.citation_url,
    citation_doi: args.citation_doi,
    citation_pmid: args.citation_pmid,
    source_release_year: args.source_release_year,
    license_status: args.license_status,
    provenance: args.provenance,
    // Decision 5 — the PRINCIPAL, so the staging row names the key that proposed it. v1 defaults
    // this to `cowork-orchestrator`, which its own ratifier check then refuses; naming the
    // principal is the honest value and it is what the ledger has.
    proposed_by: principal,
    supersedes_id: args.supersedes_id,
    /**
     * DECISION 95 — FORWARDED UNCHANGED, AND THAT IS THE POINT.
     *
     * ⚠️ v2 MUST NOT NORMALISE THESE A SECOND TIME. Decision 94 put the trim, the case-insensitive
     * de-dup, the twelve-phrase ceiling and every refusal in `parseProposeArgs`, which is what the
     * row is actually written from. A second normalisation here would silently diverge from it the
     * first time either changed, and the artifact a reviewer approved would then describe keywords
     * that are not the keywords in the table. Whatever v1 decides is what happened.
     */
    keywords: args.keywords,
    category: args.category,
  });
  const body = bodyOf(res, 'lvc_propose', 'INVALID_INPUT');
  const proposalId = body.proposal_id == null ? '' : String(body.proposal_id);
  if (!proposalId) {
    throw new LabError('SOURCE_UNAVAILABLE', 'lvc_propose reported success with no proposal id; a release could never name this row');
  }
  // v1's own answer about what it stored, never our copy of what we sent — decision 94 may have
  // trimmed or de-duplicated it. Falls back to what was forwarded only if v1 says nothing.
  const forwarded: string[] = Array.isArray(body.keywords)
    ? (body.keywords as unknown[]).map((k) => String(k))
    : (Array.isArray(args.keywords) ? (args.keywords as unknown[]).map((k) => String(k)) : []);

  /**
   * The hash a release binds to. Over the STATEMENT and its citation, never over the row: the row
   * carries a `status` and a `proposed_at` that move on their own, and an artifact hash that moved
   * on its own would expire approvals for no reason.
   *
   * DECISION 95 — AND OVER THE KEYWORDS AND THE CATEGORY, because they are half of what a rule DOES.
   * A review that bound only the text would approve a sentence and let the trigger phrases change
   * underneath it, which is the same class of hole `APPROVAL_HASH_MISMATCH` exists to close.
   *
   * ⚠️ ABSENT HASHES AS ABSENT, NOT AS `[]` OR `null`. `canonicalJson` drops `undefined` keys, so an
   * old-shape propose produces byte-identically the hash it produced before decision 95 and every
   * approval already on record still binds. `?? null` here would have expired all of them.
   */
  const proposal_hash = hash({
    statement: String(args.statement),
    citation_url: args.citation_url ?? null,
    citation_doi: args.citation_doi ?? null,
    citation_pmid: args.citation_pmid ?? null,
    source_release_year: args.source_release_year ?? null,
    supersedes_id: args.supersedes_id ?? null,
    keywords: args.keywords,
    category: args.category,
  });
  // The staged set for the rules target: the same object kind `release_prepare` already takes, so
  // the release core needs no new input field for a second target. Same absent-is-absent rule.
  const { object, deduplicated } = await putObject(db, principal, 'staged_set', {
    kind: 'staged_set',
    target: 'rules',
    proposal_id: proposalId,
    proposal_hash,
    statement: String(args.statement),
    keywords: args.keywords,
    category: args.category,
    proposed_by: principal,
  }, 'deidentified', String(args.idempotency_key));

  return {
    proposal_id: proposalId,
    proposal_hash,
    staged_set_id: object.id,
    deduplicated,
    status: String(body.status ?? 'proposed'),
    statement: String(args.statement),
    supersedes_id: args.supersedes_id == null ? null : String(args.supersedes_id),
    keywords: forwarded,
    category: args.category == null ? null : String(args.category),
    note: String(body.note ?? 'STAGED only — lvc_recommendations is untouched.'),
    /**
     * ⚠️ CONDITIONAL NOW, AND IT HAD TO BECOME SO. Before decision 95 this always read
     * `KEYWORDLESS_PROPOSAL`, which was true of every proposal v2 could make. It is a statement of
     * fact about THIS proposal, so leaving it unconditional would have made the tool assert
     * "carries no keywords" on a proposal that carries them.
     *
     * The keyword-free branch is `KEYWORDLESS_PROPOSAL` verbatim — the same constant `rule_simulate`
     * and `release_prepare` refuse with — so the warning and the later refusal are the same words.
     */
    matching: forwarded.length
      ? `${forwarded.length} keyword phrase(s) staged as written. v1 trims, de-duplicates and refuses `
        + '(decision 94); what the table holds is what a release will promote and what the engine will match on.'
      : KEYWORDLESS_PROPOSAL,
  };
}

/** The engine's own rule shape (`LvcRuleLite`): id, keywords, category. Nothing else is read. */
function asLvcRuleLite(r: LvcRuleRow) {
  return { id: r.id, keywords: r.keywords as string[], category: r.category };
}

interface Stamp { subject: string; finding_ref: string | null; rule_ref: string | null; lvc_category: string | null }

/**
 * The findings of one audit artifact, IN ORDER. Order is the key deliberately: `stampLvcMetadata`
 * is a 1:1 `map` and the engine's own comment says finding order is preserved exactly, so on a
 * replay of the same reply position i on one side IS position i on the other. `finding_ref` is
 * carried for the report but not used as the key — it is positional and collision-suffixed, so it
 * would agree with the index and add a second way to be wrong.
 */
function stampsOf(audit: unknown): Stamp[] {
  const findings = ((audit as { findings?: unknown[] } | null)?.findings ?? []) as Record<string, unknown>[];
  return findings.map((f) => ({
    subject: f.subject == null ? '' : String(f.subject),
    finding_ref: f.finding_ref == null ? null : String(f.finding_ref),
    rule_ref: f.rule_ref == null ? null : String(f.rule_ref),
    lvc_category: f.lvc_category == null ? null : String(f.lvc_category),
  }));
}

export interface SimulateDeps extends RulesToolDeps {
  /** Injection seam: the tick loop that drives the replayed items. Production passes nothing. */
  drive?: (db: Db, onCall: () => void) => Promise<void>;
}

/**
 * ⚠️ STRUCTURAL, NOT OBSERVED. This is the transport `tick` is handed for a simulation. A stage
 * whose request does not match a stored step fails its item on contact with THIS rather than
 * reaching a provider, so `model_calls: 0` is a property of the wiring and not a hopeful count.
 * Exported so a test can call it and see it throw.
 */
export const LIVE_TRANSPORT_FORBIDDEN = async (): Promise<never> => {
  throw new LabError('REPLAY_DIVERGED', 'the live transport must never be reached on a simulation');
};

async function driveReplay(db: Db, onCall: () => void): Promise<void> {
  for (let pass = 0; pass < 60; pass += 1) {
    const report = await tick({
      db,
      transport: LIVE_TRANSPORT_FORBIDDEN as never,
      maxItems: 10,
      replayTransportFor: (_itemId: string, sourceId: string) => replayTransport(db, sourceId, onCall),
    });
    if (report.claimed === 0) break;
  }
}

export async function ruleSimulate(
  db: Db, principal: string, args: { proposal_id: string; run_id: string; idempotency_key: string },
  deps: SimulateDeps = {},
) {
  const proposal = await readProposal(args.proposal_id, deps);
  if (!proposal.keywords.length) {
    // ⚠️ See KEYWORDLESS_PROPOSAL. A zero that is guaranteed by construction is not a measurement.
    throw new LabError('INVALID_INPUT', `proposal ${proposal.id}: ${KEYWORDLESS_PROPOSAL}`);
  }
  const current = await activeRules(deps);

  const baseline = await getRun(db, args.run_id);
  if (!baseline) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
  if (baseline.owner !== principal) {
    throw new LabError('OWNER_ONLY', 'a run may only be simulated against by its owner');
  }
  const baselineItems = await itemsOf(db, baseline.id, 1000, 0);
  if (!baselineItems.length) throw new LabError('INVALID_INPUT', `run ${baseline.id} has no items to replay`);
  const engines = new Set(baselineItems.map((i) => String((i.payload as { engine?: string })?.engine ?? '')));
  if (engines.size !== 1 || !engines.has('opd_note_audit')) {
    throw new LabError('INVALID_INPUT',
      `rule_simulate replays an opd_note_audit run; run ${baseline.id} carries ${[...engines].join(', ') || 'no engine'}`);
  }

  /**
   * ⚠️ THE PROPOSED RULE GOES INTO THE FROZEN CASE, NOT INTO THE ENGINE. `adapters/opd.ts` builds
   * `labDependencies.lvcRules` from `frozen.lvc_rules` (decision 10), so a simulation changes the
   * frozen inputs and the engine is untouched.
   *
   * ⚠️ AND THE BASELINE'S OWN FROZEN RULEBOOK IS REPLACED BY THE LIVE ACTIVE SET, DELIBERATELY. The
   * question a reviewer is asking is "what would this rule do to these notes TODAY", not "what
   * would it have done beside a rulebook that has since moved". The output names both counts so the
   * substitution is visible rather than assumed.
   */
  const simulated = [...current.map(asLvcRuleLite), {
    id: `proposal:${proposal.id}`,
    keywords: proposal.keywords,
    category: proposal.category,
  }];
  const frozenRules = simulated.map((r) => ({
    id: r.id, hash: hash({ id: r.id, keywords: r.keywords, category: r.category }),
    keywords: r.keywords, category: r.category,
  }));

  const items = baselineItems.map((i) => {
    const payload = { ...(i.payload as Record<string, unknown>) };
    payload.frozen = { ...((payload.frozen ?? {}) as Record<string, unknown>), lvc_rules: frozenRules };
    payload.replay_from = i.id;
    return { case_key: i.case_key, arm_hash: i.arm_hash, repetition: i.repetition, payload };
  });

  // The baseline's own budget, exactly as `run_replay` does: a replay reports zero usage, so
  // nothing moves against the cap and no second budget row is invented to hold a zero.
  const { run, deduplicated } = await submitRun(
    db, principal, 'rule_simulate', baseline.experiment_id, baseline.budget_id,
    args.idempotency_key, hash({ proposal: proposal.id, run: baseline.id }), 24 * 60 * 60 * 1000, items,
  );

  let stages = 0;
  if (!deduplicated) {
    await (deps.drive ?? driveReplay)(db, () => { stages += 1; });
  }

  // ── the diff ────────────────────────────────────────────────────────────────────────
  const simItems = await itemsOf(db, run.id, 1000, 0);
  const bySource = new Map(baselineItems.map((i) => [i.id, i]));
  const positives: {
    case_key: string; finding_index: number; subject: string;
    rule_ref_before: string | null; rule_ref_after: string | null;
    lvc_category_before: string | null; lvc_category_after: string | null;
  }[] = [];
  const negatives: { case_key: string; reason: string }[] = [];
  const per_item: {
    case_key: string; state: string; replayed_equal: boolean; diverged: boolean;
    changed_findings: number; error: string | null;
  }[] = [];

  const artifactId = (v: unknown) => String((v as { artifact_id?: string } | null)?.artifact_id ?? '');

  for (const s of simItems) {
    const src = bySource.get(String((s.payload as { replay_from?: string })?.replay_from ?? ''));
    const errText = s.error
      ? String((s.error as { message?: string }).message ?? JSON.stringify(s.error)).slice(0, 300)
      : null;
    const diverged = (errText ?? '').includes('REPLAY_DIVERGED')
      || (s.error as { code?: string } | null)?.code === 'REPLAY_DIVERGED';
    if (s.state !== 'succeeded' || !src) {
      // ⚠️ PER ITEM, NEVER FATAL. One case whose stored steps no longer answer its request must not
      // take a cohort's measurement down with it: it leaves the denominator and says why.
      per_item.push({ case_key: s.case_key, state: s.state, replayed_equal: false, diverged, changed_findings: 0, error: errText });
      negatives.push({
        case_key: s.case_key,
        reason: diverged
          ? 'REPLAY_DIVERGED: the stored reply no longer answers this request, so this case is not evidence either way'
          : `not replayed: ${errText ?? s.state}`,
      });
      continue;
    }
    const [before, after] = await Promise.all([
      getObject(db, artifactId(src.result)).catch(() => null),
      getObject(db, artifactId(s.result)).catch(() => null),
    ]);
    if (!before || !after) {
      per_item.push({ case_key: s.case_key, state: s.state, replayed_equal: false, diverged: false, changed_findings: 0, error: 'artifact missing' });
      negatives.push({ case_key: s.case_key, reason: 'the baseline or the simulated artifact could not be read' });
      continue;
    }
    const b = stampsOf(before.body);
    const a = stampsOf(after.body);
    /**
     * ⚠️ "REPLAYED EQUAL" IS ABOUT THE FINDING SET, NOT THE STAMPS. The rule is EXPECTED to change
     * the stamps; what must not change is which findings exist and in what order. If the two sides
     * disagree on that, something other than the rule moved and the item is not a measurement.
     */
    const sameSet = b.length === a.length && b.every((x, i) => x.subject === a[i].subject);
    let changed = 0;
    if (sameSet) {
      for (const [i, bv] of b.entries()) {
        const av = a[i];
        if (bv.rule_ref === av.rule_ref && bv.lvc_category === av.lvc_category) continue;
        changed += 1;
        if (positives.length < 50) {
          positives.push({
            case_key: s.case_key, finding_index: i, subject: av.subject || bv.subject,
            rule_ref_before: bv.rule_ref, rule_ref_after: av.rule_ref,
            lvc_category_before: bv.lvc_category, lvc_category_after: av.lvc_category,
          });
        }
      }
      if (!changed) {
        negatives.push({ case_key: s.case_key, reason: 'replayed equal and no stamp moved: this rule changes nothing on this case' });
      }
    } else {
      negatives.push({
        case_key: s.case_key,
        reason: `the finding set differs (${b.length} → ${a.length} finding(s), or a subject moved); a rule cannot do that, so this item is not a measurement`,
      });
    }
    per_item.push({ case_key: s.case_key, state: s.state, replayed_equal: sameSet, diverged: false, changed_findings: changed, error: null });
  }

  const out = {
    proposal_id: proposal.id,
    baseline_run_id: baseline.id,
    simulation_run_id: run.id,
    deduplicated,
    model_calls: 0,
    replayed_stages: stages,
    rules: { active: current.length, simulated: simulated.length },
    measures: SIMULATION_MEASURES,
    denominator: {
      name: 'items replayed equal' as const,
      items: per_item.length,
      replayed_equal: per_item.filter((p) => p.replayed_equal).length,
      diverged: per_item.filter((p) => p.diverged).length,
      not_measured: per_item.filter((p) => !p.replayed_equal && !p.diverged).length,
    },
    changed_audits: per_item.filter((p) => p.replayed_equal && p.changed_findings > 0).length,
    positives,
    negatives,
    per_item,
  };

  // The artifact a release binds as its `simulation_ref`, so a reviewer reads the measurement that
  // was actually made rather than a number retyped into a release note.
  const { object } = await putObject(db, principal, 'report', { kind: 'rule_simulation', ...out }, 'deidentified', `sim:${args.idempotency_key}`);
  return { ...out, simulation_ref: object.id };
}
