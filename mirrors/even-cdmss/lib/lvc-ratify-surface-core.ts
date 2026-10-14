/**
 * lib/lvc-ratify-surface-core.ts — LVC RULEBOOK REPAIR PRD v1.1 §3.5 (D-17 to D-21), 25 Aug 2026.
 *
 * THE LOGIC BEHIND THE RATIFICATION SITTING. Record-set loading, progress derivation, the
 * previous-values payload the ledger carries, and the two write paths — accept and reject.
 *
 * ⚠️ THE ACCEPT WRITES PRODUCTION DATA AND THERE IS NO UNDO (D-20). No snapshot table exists and a
 * code revert will not restore a rule. Three things make that survivable and they are all here:
 *   · every UPDATE is guarded IS DISTINCT FROM, so a second press is inert (§6.8);
 *   · every accept records the survivor's PREVIOUS statement, precondition, keywords, category and
 *     citation as a JSON payload in the ledger ANCHOR ROW's `lvc_recommendation_proposals
 *     .evidence_note` — NOT on the `lvc_ratifications` row, which carries the ratifier, the
 *     rationale and the decision but none of the previous values. That payload is what makes a
 *     correction WRITABLE — a recovery path, not an undo button — and PRD A-1 is the reason
 *     `LEDGER_READ_SQL` now selects it and `parsePreviousValues` reads it back onto the screen.
 *     Before A-1 it was written and never read, so recovery meant hand-written SQL against
 *     production;
 *   · stored findings are never rewritten (D-4), so no audit already delivered to a doctor changes.
 *
 * NO SESSION STATE (D-21 / §6.13). Progress is a PURE function of the live rulebook plus the
 * ledger. There is no sitting object, no localStorage and no server-side cursor. Closing the
 * browser and reopening it resumes exactly, because there was never anywhere else for the state
 * to live.
 *
 * ⚠️ EVERY SQL STRING HERE IS INFERRED and is reproduced verbatim in the build report. The column
 * names and the ledger's constraints were confirmed read-only against the live schema; no statement
 * below was executed.
 *
 * ⚠️ FLAGGED DEVIATION — THE LEDGER ANCHOR. PRD §3.5 says an accept appends one `lvc_ratifications`
 * row. That table's `proposal_id` is `uuid NOT NULL REFERENCES lvc_recommendation_proposals(id)`
 * (migrations/0023, confirmed live), so a ledger row CANNOT exist without a proposal row to point
 * at — and the file contract forbids 0041 from carrying anything but the merged_into column, so the
 * constraint cannot be relaxed here. Each accept therefore writes ONE anchor row into
 * `lvc_recommendation_proposals` immediately before the ledger row, carrying the accepted values,
 * `supersedes_id = <survivor id>` and `status = 'ratified'`. This is not a staging table in the
 * D-18 sense: the rulebook is already written by the time the anchor exists, and no later step
 * promotes anything. It reuses lvc_ratify's own ledger shape rather than inventing a second
 * ratification convention, which is what the kickoff requires. See the build report.
 */

import {
  MERGE_RECORD_SET, MERGE_READBACK_SQL, RETIRED_STATUS,
  applyRuleMerge, keywordError, categoryError, ratifierError, validateRecords,
  readRuleRows, sameKeywords, recordSetIds,
  type MergedRule, type RuleRecordSet, type SqlRunner, type CurrentRuleRow, type MergeResult,
} from './lvc-rule-merge';

export { keywordError, categoryError, ratifierError, MERGE_RECORD_SET };

/** The record sets this one screen can load (D-21). Phase 2 and Phase 3 add entries here and
 *  change nothing else — the page reads whatever this map returns. */
const RECORD_SETS: Record<string, RuleRecordSet> = {
  [MERGE_RECORD_SET.key]: MERGE_RECORD_SET,
};

export function listRecordSets(): Array<{ key: string; title: string; count: number }> {
  return Object.values(RECORD_SETS).map((s) => ({ key: s.key, title: s.title, count: s.records.length }));
}

/** Fail-safe: an unknown key falls back to the Phase 1 set rather than rendering an empty screen. */
export function getRecordSet(key?: string | null): RuleRecordSet {
  const k = String(key ?? '').trim();
  return (k && RECORD_SETS[k]) || MERGE_RECORD_SET;
}

// ── progress (§3.5 "Resumability", §6.13) ──────────────────────────────────────────────────────

export type RuleProgress = 'pending' | 'accepted' | 'partially_applied' | 'rejected' | 'missing';

export interface AbsorbedView {
  id: string;
  /** the variant's VERBATIM statement — this is the evidence that N statements are one idea */
  statement: string | null;
  status: string | null;
  merged_into: string | null;
  /** lifetime findings that carry this rule_ref; null when the count could not be read */
  fires: number | null;
  applied: boolean;
}

/** The survivor's values as they stood BEFORE an accept overwrote them (D-20 / PRD A-1). */
export interface PreviousValues {
  statement: string | null;
  precondition: string | null;
  keywords: string[];
  category: string | null;
  citation_url: string | null;
}

export interface LedgerEntry {
  decision: string;
  ratified_by: string;
  rationale: string;
  reason: string | null;
  created_at: string;
  survivor_id: string;
  /**
   * The recovery payload, parsed out of the anchor row's `evidence_note`. NULL means "not
   * recorded" — the column was empty, the JSON did not parse, it was not a merge payload, or it
   * carried no `previous` object. It is never an exception and never a partial object presented
   * as complete: an unreadable payload must degrade, because the screen it feeds is the one a
   * clinician is mid-sitting on.
   */
  previous: PreviousValues | null;
}

export interface RuleView {
  section: string;
  id: string;
  /** the DRAFT values — what the screen shows before any edit */
  draft: MergedRule;
  /** the rule as it stands in the live rulebook right now */
  current: {
    statement: string | null;
    precondition: string | null;
    keywords: string[];
    category: string | null;
    citation_url: string | null;
    status: string | null;
    ratified_by: string | null;
    ratified_at: string | null;
    fires: number | null;
  } | null;
  absorbs: AbsorbedView[];
  progress: RuleProgress;
  /** the most recent ledger decision touching this survivor, if any */
  last_decision: LedgerEntry | null;
  /**
   * A-1 — what this rule WAS before the accept that is now in force, from the most recent
   * ratification's recovery payload. D-20 leaves this as the only recovery path in the system, so
   * it has to be reachable from the screen rather than from hand-written SQL.
   *
   * ONLY populated for a rule whose progress is `accepted`. A pending rule has not been overwritten
   * by anything, so there is nothing it "was"; showing a payload there would invite a reviewer to
   * read a previous sitting's row as this one's history.
   *
   * NULL means one of two different things, and `previous_recorded` separates them.
   */
  previous: PreviousValues | null;
  /**
   * `false` when the rule is accepted but its payload could not be read — the screen must then say
   * "not recorded" rather than rendering blank fields that look like empty previous values.
   * `null` when the question does not arise (the rule is not accepted).
   */
  previous_recorded: boolean | null;
}

export interface SurfaceState {
  record_set: { key: string; title: string; blurb: string };
  rules: RuleView[];
  counts: { total: number; accepted: number; partially_applied: number; rejected: number; pending: number; missing: number };
  /** false when the rulebook could not be read — the screen must then refuse to offer an accept */
  rulebook_available: boolean;
  /** false when lifetime finding counts could not be read; the screen shows "—", never a zero */
  fires_available: boolean;
  ledger_available: boolean;
  /** true once migration 0041 has been applied */
  merged_into_present: boolean;
  notes: string[];
}

/** Content equality between the live survivor row and the record — ratifier-independent, because
 *  progress must not depend on WHO is looking at the screen. */
export function survivorContentMatches(cur: CurrentRuleRow | undefined, r: MergedRule): boolean {
  if (!cur) return false;
  return cur.statement === r.statement
    && cur.precondition === r.precondition
    && sameKeywords(cur.keywords, r.keywords)
    && cur.category === r.category
    && cur.citationUrl === r.citation_url;
}

export function absorbedApplied(cur: CurrentRuleRow | undefined, survivorId: string): boolean {
  return !!cur && cur.status === RETIRED_STATUS && cur.mergedInto === survivorId;
}

/**
 * PURE (test 18): the same rulebook rows + the same ledger always give the same progress. Nothing
 * here reads a clock, a session or a cursor.
 *
 * A rule is `accepted` only when the survivor holds the record's content AND every absorbed variant
 * is retired pointing at it. Anything in between is `partially_applied` and says so — §6.10 is
 * explicit that a half-applied merge must never render as accepted.
 */
export function deriveProgress(
  record: MergedRule,
  rows: Map<string, CurrentRuleRow>,
  ledger: LedgerEntry[],
): RuleProgress {
  const cur = rows.get(record.id);
  if (!cur) return 'missing';
  const survivorDone = survivorContentMatches(cur, record);
  const absorbedDone = record.absorbs.map((id) => absorbedApplied(rows.get(id), record.id));
  const allDone = survivorDone && absorbedDone.every(Boolean);
  if (allDone) return 'accepted';
  const anyDone = survivorDone || absorbedDone.some(Boolean);
  if (anyDone) return 'partially_applied';
  const last = ledger.find((l) => l.survivor_id === record.id);
  if (last && last.decision === 'rejected') return 'rejected';
  return 'pending';
}

/** D-20 — what the ledger must carry so a mistake is CORRECTABLE: the values that were there
 *  before this accept overwrote them. Read off the live row, never off the draft. */
export function previousValues(cur: CurrentRuleRow | undefined): PreviousValues {
  return {
    statement: cur?.statement ?? null,
    precondition: cur?.precondition ?? null,
    keywords: cur?.keywords ?? [],
    category: cur?.category ?? null,
    citation_url: cur?.citationUrl ?? null,
  };
}

/** The discriminator on the payload. ONE constant, written by ledgerPayload and required by
 *  parsePreviousValues, so the writer and the reader cannot disagree about what they are looking at.
 *  The proposals table is shared with lvc_propose, whose rows carry a human evidence_note — the
 *  `kind` check is what stops one of those being read as a recovery payload. */
export const LEDGER_PAYLOAD_KIND = 'lvc-rule-merge';

/** The self-describing payload stored in the anchor row's `evidence_note`. */
export function ledgerPayload(record: MergedRule, cur: CurrentRuleRow | undefined, recordSetKey: string): string {
  return JSON.stringify({
    kind: LEDGER_PAYLOAD_KIND,
    record_set: recordSetKey,
    section: record.section,
    survivor_id: record.id,
    absorbs: record.absorbs,
    previous: previousValues(cur),
    accepted: {
      statement: record.statement,
      precondition: record.precondition,
      keywords: record.keywords,
      category: record.category,
      citation_url: record.citation_url,
    },
  });
}

/**
 * READ THE RECOVERY PAYLOAD BACK (PRD A-1). The exact inverse of `ledgerPayload`, and the only
 * reader of `evidence_note` in the product.
 *
 * ⚠️ TOTAL AND FAIL-SAFE BY CONTRACT. It returns `null` and NEVER throws for every way the column
 * can disappoint: NULL, empty or whitespace, malformed JSON, a JSON scalar or array rather than an
 * object, a `kind` that is not ours (another tool's proposal sharing the table), or a payload whose
 * `previous` object is missing or not an object. That matters more here than anywhere else in the
 * build — this feeds a screen a clinician is mid-sitting on, and a throw would blank it. "Not
 * recorded" is an honest answer; a crash, or a half-parsed object presented as the previous
 * wording, is not.
 *
 * Field-level tolerance is deliberate too: a `previous` object missing `citation_url` (written by
 * an older shape) yields null for that field rather than discarding the statement and precondition
 * that ARE there. Keywords that are not an array degrade to [], never to a string that would render
 * as one long phrase.
 */
export function parsePreviousValues(evidenceNote: unknown): PreviousValues | null {
  if (typeof evidenceNote !== 'string') return null;
  const raw = evidenceNote.trim();
  if (!raw) return null;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const payload = parsed as Record<string, unknown>;
  if (payload.kind !== LEDGER_PAYLOAD_KIND) return null;

  const prev = payload.previous;
  if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return null;
  const p = prev as Record<string, unknown>;

  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    statement: str(p.statement),
    precondition: str(p.precondition),
    keywords: Array.isArray(p.keywords) ? p.keywords.map((k) => String(k)) : [],
    category: str(p.category),
    citation_url: str(p.citation_url),
  };
}

// ── INFERRED SQL — reads ───────────────────────────────────────────────────────────────────────

/** Lifetime findings per rule id. Expensive-ish (a jsonb unnest over the audit table) and therefore
 *  fail-safe: an error yields no counts and the screen shows "—", never a misleading 0. */
export const FIRE_COUNTS_SQL = `WITH f AS (
    SELECT jsonb_array_elements(a.findings) AS fi
      FROM opd_note_audits a
     WHERE a.findings IS NOT NULL
  )
  SELECT fi->>'rule_ref' AS rule_ref, count(*)::int AS fires
    FROM f
   WHERE fi->>'rule_ref' = ANY($1)
   GROUP BY 1`;

/**
 * The ledger for these survivors, newest first. Joined through the anchor row's supersedes_id,
 * which is how a merge ratification is addressable at all (see the flagged deviation above).
 *
 * ⚠️ `p.evidence_note` IS THE RECOVERY PAYLOAD AND IT IS WHY THIS QUERY EXISTS AT ALL (PRD A-1).
 * D-20 removed the undo and the snapshot, so the previous values written at each accept carry the
 * entire recovery burden. Until A-1 this column was written and never read back: recovery meant
 * hand-written SQL against production plus a manual JSON.parse. Selecting it here is what makes it
 * reachable from the product. The join, the WHERE and the ORDER BY are unchanged from that version
 * — a test asserts each of them, because widening this query's reach is not what A-1 asked for.
 */
export const LEDGER_READ_SQL = `SELECT r.decision, r.ratified_by, r.rationale, r.reason,
       r.created_at, p.supersedes_id AS survivor_id, p.evidence_note
  FROM lvc_ratifications r
  JOIN lvc_recommendation_proposals p ON p.id = r.proposal_id
 WHERE p.supersedes_id = ANY($1)
 ORDER BY r.created_at DESC`;

/** Has migration 0041 been applied? Cheap, and it is what tells the screen whether an accept can
 *  complete — without merged_into, a retirement write would fail on every absorbed row. */
export const MERGED_INTO_PRESENT_SQL = `SELECT 1 AS ok
  FROM information_schema.columns
 WHERE table_name = 'lvc_recommendations' AND column_name = 'merged_into'`;

// ── INFERRED SQL — the ledger writes ───────────────────────────────────────────────────────────

/** ⚠️ THE ANCHOR (see the header). `keywords` here is JSONB — the proposals table's type — and is
 *  deliberately NOT the text[] the rulebook uses. Mixing the two is exactly the round-trip fault
 *  PRD §2.1 warns about. `status` is constrained to proposed|ratified|rejected by 0023. */
export const LEDGER_ANCHOR_INSERT_SQL = `INSERT INTO lvc_recommendation_proposals
    (statement, rationale, evidence_note, source, category, keywords, provenance,
     status, proposed_by, supersedes_id, rejected_reason, promoted_id)
  VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
  RETURNING id::text AS id`;

/** The append-only ledger row itself — lvc_ratify's exact INSERT shape, one convention not two. */
export const LEDGER_INSERT_SQL = `INSERT INTO lvc_ratifications
    (proposal_id, decision, ratified_by, rationale, reason, promoted_id)
  VALUES ($1::uuid,$2,$3,$4,$5,$6)
  RETURNING id::text AS id`;

/** Where an accept's writes are declared to have landed. Never a bare 500 (§6.10). */
export type LedgerOutcome = 'written' | 'skipped_unchanged' | 'failed' | 'not_attempted';

export interface AcceptResult {
  ok: boolean;
  section: string;
  survivor_id: string;
  /** exactly which rows landed — the §6.10 requirement */
  merge: MergeResult;
  ledger: LedgerOutcome;
  ledger_detail?: string;
  /** what the screen must now show for this rule */
  progress: RuleProgress;
  error?: string;
}

/**
 * ACCEPT ONE RULE. This is the write (D-18). There is no bulk path and none is exported.
 *
 * ORDER, exactly:
 *   1. validate the ratifier and the edited record — refuses before touching the database;
 *   2. applyRuleMerge for THIS ONE RECORD, which is itself readback-first:
 *        readback(survivor + absorbed) → survivor UPDATE → one UPDATE per absorbed id → readback;
 *   3. if step 2 changed nothing, the ledger is SKIPPED — a second press must be genuinely inert,
 *      and an append-only ledger filling with identical rows is not inert;
 *   4. INSERT the anchor proposal row — the FK the ledger requires, AND the row that carries the
 *      recovery payload: the survivor's PREVIOUS statement, precondition, keywords, category and
 *      citation, as JSON in `evidence_note` (D-20);
 *   5. INSERT the lvc_ratifications row carrying the ratifier, the rationale and the decision. It
 *      does NOT carry the previous values — step 4's anchor does. Read them back with
 *      `LEDGER_READ_SQL` + `parsePreviousValues` (PRD A-1).
 *
 * A failure at 4 or 5 does NOT roll back 2 — there are no transactions. It is reported as
 * `ledger: 'failed'` with ok:false, so the row that landed and the row that did not are both
 * visible. A success never hides a half-applied merge.
 */
export async function acceptRuleMerge(
  run: SqlRunner,
  opts: { record: MergedRule; ratifiedBy: string; rationale: string; recordSetKey?: string; dryRun?: boolean },
): Promise<AcceptResult> {
  const { record } = opts;
  const ratifiedBy = String(opts.ratifiedBy ?? '').trim();
  const rationale = String(opts.rationale ?? '').trim();
  const dryRun = opts.dryRun === true;
  const empty: MergeResult = {
    ok: false, dryRun, ratifiedBy, sections: [record?.section ?? '?'],
    changed: 0, unchanged: 0, missing: 0, verified: false, rows: [],
  };
  const fail = (error: string): AcceptResult => ({
    ok: false, section: record?.section ?? '?', survivor_id: record?.id ?? '',
    merge: { ...empty, error }, ledger: 'not_attempted', progress: 'pending', error,
  });

  // 1) Refuse before any write.
  const whoErr = ratifierError(ratifiedBy);
  if (whoErr) return fail(whoErr);
  if (!rationale) return fail('a rationale is required — the ledger row records why this was accepted');
  const recErrors = validateRecords([record]);
  if (recErrors.length) return fail(`rule rejected, nothing written: ${recErrors.join(' | ').slice(0, 600)}`);

  // Read the PREVIOUS values before the merge overwrites them (D-20). A failure here is fatal on
  // purpose: without the previous values the accept has no recovery path, so it must not proceed.
  let before: Map<string, CurrentRuleRow>;
  try {
    before = readRuleRows(await run(MERGE_READBACK_SQL, [recordSetIds([record])]));
  } catch (e) {
    return fail(`readback failed, nothing written: ${String((e as Error).message).slice(0, 300)}`);
  }
  const cur = before.get(record.id);
  if (!cur) return fail(`survivor ${record.id} does not exist in lvc_recommendations — nothing written`);

  // 2) The rulebook writes.
  const merge = await applyRuleMerge(run, { records: [record], ratifiedBy, dryRun });

  if (dryRun) {
    return { ok: merge.ok, section: record.section, survivor_id: record.id, merge, ledger: 'not_attempted', progress: deriveProgress(record, before, []) };
  }

  // 3) Nothing changed ⇒ this is a repeat press. Inert, and the ledger stays clean.
  if (merge.ok && merge.changed === 0) {
    return { ok: true, section: record.section, survivor_id: record.id, merge, ledger: 'skipped_unchanged', progress: 'accepted' };
  }

  // 4 + 5) The ledger. Attempted even when the merge partially failed, so the attempt is on record.
  let ledger: LedgerOutcome = 'failed';
  let ledgerDetail: string | undefined;
  try {
    const anchor = await run(LEDGER_ANCHOR_INSERT_SQL, [
      record.statement,
      rationale,
      ledgerPayload(record, cur, opts.recordSetKey ?? MERGE_RECORD_SET.key),
      'lvc-ratify-surface',
      record.category,
      JSON.stringify(record.keywords),
      'EHRC-mined',
      'ratified',
      ratifiedBy,
      record.id,
      null,
      record.id,
    ]);
    const anchorId = anchor[0]?.id == null ? null : String(anchor[0].id);
    if (!anchorId) throw new Error('anchor proposal row returned no id');
    await run(LEDGER_INSERT_SQL, [anchorId, 'ratified', ratifiedBy, rationale, null, record.id]);
    ledger = 'written';
  } catch (e) {
    ledgerDetail = String((e as Error).message).slice(0, 300);
  }

  // What the screen must show now — recomputed from the post-write readback the merge already did.
  const after = new Map<string, CurrentRuleRow>();
  for (const row of merge.rows) {
    const src = row.action === 'survivor'
      ? { statement: record.statement, precondition: record.precondition, keywords: record.keywords, category: record.category, citationUrl: record.citation_url, status: cur.status, mergedInto: null }
      : { statement: null, precondition: null, keywords: [], category: null, citationUrl: null, status: RETIRED_STATUS, mergedInto: record.id };
    if (row.verified) after.set(row.id, { id: row.id, ratifiedBy, ratifiedAt: null, ...src });
    else { const prev = before.get(row.id); if (prev) after.set(row.id, prev); }
  }
  const progress = deriveProgress(record, after, []);

  const ok = merge.ok && ledger === 'written';
  return {
    ok, section: record.section, survivor_id: record.id, merge, ledger,
    ...(ledgerDetail ? { ledger_detail: ledgerDetail } : {}),
    progress,
    ...(ok ? {} : {
      error: merge.ok
        ? `the rulebook writes landed but the ledger row did not (${ledgerDetail ?? 'unknown'}) — the merge is applied and UNRECORDED; re-press accept to append the ledger row`
        : (merge.error ?? 'the merge did not complete; see merge.rows for exactly which rows landed'),
    }),
  };
}

export interface RejectResult {
  ok: boolean;
  section: string;
  survivor_id: string;
  ledger: LedgerOutcome;
  error?: string;
}

/**
 * REJECT ONE RULE. Writes NOTHING to `lvc_recommendations` — the cluster stays exactly as it is —
 * and appends a rejection to the ledger with a required reason (§3.5). Rejection is first-class,
 * the same way lvc_ratify treats it: it is evidence about the rulebook, never a delete.
 */
export async function rejectRule(
  run: SqlRunner,
  opts: { record: MergedRule; ratifiedBy: string; rationale: string; reason: string; recordSetKey?: string },
): Promise<RejectResult> {
  const { record } = opts;
  const ratifiedBy = String(opts.ratifiedBy ?? '').trim();
  const rationale = String(opts.rationale ?? '').trim();
  const reason = String(opts.reason ?? '').trim();
  const fail = (error: string): RejectResult => ({ ok: false, section: record?.section ?? '?', survivor_id: record?.id ?? '', ledger: 'not_attempted', error });

  const whoErr = ratifierError(ratifiedBy);
  if (whoErr) return fail(whoErr);
  if (!reason) return fail('a reason is required when a rule is rejected');

  // Best-effort read of the current row so the ledger records what was left standing. A failure
  // here is NOT fatal: a rejection writes no rulebook row, so there is nothing to recover.
  let cur: CurrentRuleRow | undefined;
  try { cur = readRuleRows(await run(MERGE_READBACK_SQL, [[record.id]])).get(record.id); } catch { cur = undefined; }

  try {
    const anchor = await run(LEDGER_ANCHOR_INSERT_SQL, [
      record.statement,
      rationale || reason,
      ledgerPayload(record, cur, opts.recordSetKey ?? MERGE_RECORD_SET.key),
      'lvc-ratify-surface',
      record.category,
      JSON.stringify(record.keywords),
      'EHRC-mined',
      'rejected',
      ratifiedBy,
      record.id,
      reason,
      null,
    ]);
    const anchorId = anchor[0]?.id == null ? null : String(anchor[0].id);
    if (!anchorId) throw new Error('anchor proposal row returned no id');
    await run(LEDGER_INSERT_SQL, [anchorId, 'rejected', ratifiedBy, rationale || reason, reason, null]);
    return { ok: true, section: record.section, survivor_id: record.id, ledger: 'written' };
  } catch (e) {
    return { ...fail(`rejection not recorded: ${String((e as Error).message).slice(0, 300)}`), ledger: 'failed' };
  }
}

// ── assembling what the screen renders ─────────────────────────────────────────────────────────

/**
 * A-1 — the "what this rule was before" fields for one rule. PURE.
 *
 * Gated on `accepted` deliberately (see RuleView.previous). The three outcomes are distinct and the
 * screen renders each one differently:
 *   · not accepted        → { previous: null, previous_recorded: null }  — the question does not arise
 *   · accepted, readable  → { previous: {...}, previous_recorded: true }
 *   · accepted, unreadable→ { previous: null, previous_recorded: false } — say "not recorded"
 */
export function previousForRule(
  survivorId: string,
  progress: RuleProgress,
  ledger: LedgerEntry[],
): { previous: PreviousValues | null; previous_recorded: boolean | null } {
  if (progress !== 'accepted') return { previous: null, previous_recorded: null };
  const accept = ledger.find((l) => l.survivor_id === survivorId && l.decision === 'ratified');
  if (!accept) return { previous: null, previous_recorded: false };
  return { previous: accept.previous, previous_recorded: accept.previous !== null };
}

/**
 * PURE. Given the rulebook rows, the fire counts and the ledger, produce the whole screen state.
 * Separated from the reads so that progress derivation is testable without a database and so the
 * fail-safe behaviour lives in exactly one place — the loader below.
 */
export function assembleSurfaceState(
  set: RuleRecordSet,
  rows: Map<string, CurrentRuleRow>,
  fires: Map<string, number>,
  ledger: LedgerEntry[],
  flags: { rulebookAvailable: boolean; firesAvailable: boolean; ledgerAvailable: boolean; mergedIntoPresent: boolean },
): SurfaceState {
  const rules: RuleView[] = set.records.map((record) => {
    const cur = rows.get(record.id);
    const progress = flags.rulebookAvailable ? deriveProgress(record, rows, ledger) : 'pending';
    return {
      section: record.section,
      id: record.id,
      draft: record,
      current: cur
        ? {
            statement: cur.statement, precondition: cur.precondition, keywords: cur.keywords,
            category: cur.category, citation_url: cur.citationUrl, status: cur.status,
            ratified_by: cur.ratifiedBy, ratified_at: cur.ratifiedAt,
            fires: flags.firesAvailable ? (fires.get(record.id) ?? 0) : null,
          }
        : null,
      absorbs: record.absorbs.map((id) => {
        const a = rows.get(id);
        return {
          id,
          statement: a?.statement ?? null,
          status: a?.status ?? null,
          merged_into: a?.mergedInto ?? null,
          fires: flags.firesAvailable ? (fires.get(id) ?? 0) : null,
          applied: absorbedApplied(a, record.id),
        };
      }),
      progress,
      last_decision: ledger.find((l) => l.survivor_id === record.id) ?? null,
      // A-1. `ledger` arrives newest-first (ORDER BY created_at DESC), so the first RATIFIED row
      // for this survivor is the accept currently in force — and its payload is what the rule was
      // immediately before that accept. Rejections are skipped: a rejection overwrote nothing.
      ...previousForRule(record.id, progress, ledger),
    };
  });

  const tally = (p: RuleProgress) => rules.filter((r) => r.progress === p).length;
  const notes: string[] = [];
  if (!flags.rulebookAvailable) notes.push('The rulebook could not be read. Progress is not derivable and accepting is disabled until it can be.');
  if (!flags.mergedIntoPresent) notes.push('Migration 0041 has not been applied: lvc_recommendations.merged_into is absent, so retiring an absorbed variant would fail. Run POST /api/admin/migrate-lvc-merge first.');
  if (!flags.firesAvailable) notes.push('Lifetime finding counts are unavailable, shown as "—". This does not affect the accept.');
  if (!flags.ledgerAvailable) notes.push('The ratification ledger could not be read, so a previously rejected rule shows as pending.');

  return {
    record_set: { key: set.key, title: set.title, blurb: set.blurb },
    rules,
    counts: {
      total: rules.length,
      accepted: tally('accepted'),
      partially_applied: tally('partially_applied'),
      rejected: tally('rejected'),
      pending: tally('pending'),
      missing: tally('missing'),
    },
    rulebook_available: flags.rulebookAvailable,
    fires_available: flags.firesAvailable,
    ledger_available: flags.ledgerAvailable,
    merged_into_present: flags.mergedIntoPresent,
    notes,
  };
}

/**
 * Read everything the screen needs. EVERY read degrades independently: an unreadable ledger or an
 * unreadable fire count leaves the rest of the screen working and says so in `notes`. Only the
 * rulebook read is load-bearing, and even that returns a rendered screen with accepting disabled
 * rather than a 500 (§6.1's discipline, applied to the surface).
 */
export async function loadSurfaceState(run: SqlRunner, key?: string | null): Promise<SurfaceState> {
  const set = getRecordSet(key);
  const ids = recordSetIds(set.records);

  let rows = new Map<string, CurrentRuleRow>();
  let rulebookAvailable = true;
  try { rows = readRuleRows(await run(MERGE_READBACK_SQL, [ids])); }
  catch { rulebookAvailable = false; }

  // Before 0041 is applied the readback naming merged_into fails whole, which would report the
  // rulebook as unreadable. Retry without that column so the screen still renders and can TELL the
  // reviewer to run the migration — the far more useful failure.
  let mergedIntoPresent = true;
  if (!rulebookAvailable) {
    mergedIntoPresent = false;
    try {
      rows = readRuleRows(await run(MERGE_READBACK_SQL.replace('merged_into,', 'NULL AS merged_into,'), [ids]));
      rulebookAvailable = true;
    } catch { /* genuinely unreadable */ }
  } else {
    try { mergedIntoPresent = (await run(MERGED_INTO_PRESENT_SQL, [])).length > 0; } catch { mergedIntoPresent = true; }
  }

  let fires = new Map<string, number>();
  let firesAvailable = true;
  try {
    for (const r of await run(FIRE_COUNTS_SQL, [ids])) {
      const id = String(r.rule_ref ?? '');
      if (id) fires.set(id, Number(r.fires ?? 0));
    }
  } catch { firesAvailable = false; fires = new Map(); }

  let ledger: LedgerEntry[] = [];
  let ledgerAvailable = true;
  try {
    ledger = (await run(LEDGER_READ_SQL, [set.records.map((r) => r.id)])).map((r) => ({
      decision: String(r.decision ?? ''),
      ratified_by: String(r.ratified_by ?? ''),
      rationale: String(r.rationale ?? ''),
      reason: r.reason == null ? null : String(r.reason),
      created_at: String(r.created_at ?? ''),
      survivor_id: String(r.survivor_id ?? ''),
      // A-1: the recovery payload, parsed here so every consumer of a LedgerEntry gets it already
      // safe. A row whose payload is unreadable still returns — the decision, the ratifier and the
      // timestamp are real facts and must not be lost because the JSON beside them was not.
      previous: parsePreviousValues(r.evidence_note),
    }));
  } catch { ledgerAvailable = false; ledger = []; }

  return assembleSurfaceState(set, rows, fires, ledger, { rulebookAvailable, firesAvailable, ledgerAvailable, mergedIntoPresent });
}
