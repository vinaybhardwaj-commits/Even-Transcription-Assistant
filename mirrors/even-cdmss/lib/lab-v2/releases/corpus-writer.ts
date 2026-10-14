/**
 * lib/lab-v2/releases/corpus-writer.ts — the ONLY place v2 writes to `mksap_chunks`
 * (LAB-MCP-V2-PRD-v1.0 §17.7, decisions 79, 79a and 80a).
 *
 * ⚠️ TWO DIRECTIONS, AND ONLY ONE OF THEM IS OURS.
 *
 * ACTIVATION is v1's, imported and called, never copied. `corpusActivate` in `lib/lab.ts:184` is
 * the same function `corpus_manage action=activate` calls; it runs
 * `UPDATE mksap_chunks SET source = $1, visible = true WHERE source = $2 RETURNING id` and flips
 * every row under `labq:<label>` to `lab:<label>`. Decision 79 is explicit that v2 adds the
 * hash-bound review, the compare-and-swap and the receipt AROUND that write and does not
 * reimplement it: a second activation path would be a second set of bugs, and the first time the
 * two disagreed nobody would know which rows were live.
 *
 * DEACTIVATION does not exist in v1, and that is why this file does. `corpusDelete` is a DELETE,
 * which destroys the rows rather than returning them to quarantine — useless as a rollback, and
 * dangerous as one. Decision 80a rules that the inverse lives HERE, as ONE statement, keyed by the
 * exact ids the activation returned:
 *
 *     UPDATE mksap_chunks SET source = $1, visible = false WHERE id = ANY($2) RETURNING id
 *
 * ⚠️ BY ID, NOT BY LABEL, AND THE DIFFERENCE MATTERS. v1's activation is keyed on the source
 * label, so it moves whatever is under that label at the moment it runs. A rollback keyed the same
 * way would move rows the release never touched — anything added to `lab:<label>` afterwards, or
 * rows a partial activation left behind. Decision 80 says a release records the exact set it
 * changed and rollback flips exactly that set; the id array IS that set, read off the activation's
 * own `RETURNING`.
 *
 * ⚠️ `visible = false` AS WELL AS THE PREFIX. v1's quarantine INSERT writes `visible = false`
 * (`CORPUS_QUARANTINE_INSERT_SQL`) and activation flips it true, so an inverse that moved only the
 * prefix would leave a row that is invisible-but-not-quarantined by one guard and
 * quarantined-but-visible by the other. The two flags travel together in both directions or the
 * servable predicate at `lib/retrieve.ts:167` means two different things depending on how a row
 * got where it is.
 *
 * ⚠️ THE GREP TEST ALLOWS THIS FILE AND THIS STATEMENT AND NOTHING ELSE. `c1-release.test.ts`
 * walks `lib/lab-v2/releases/**` and `lib/lab-v2/tools/corpus.ts` for any INSERT, UPDATE or DELETE
 * against `mksap_chunks` or `lvc_*`, and the single exemption is the constant below, matched
 * verbatim. Adding a second write here fails the gate.
 */
import { corpusActivate, labLabel } from '../../lab';
import { sql } from '../../db';
import { LabError } from '../contracts';

/**
 * DECISION 80a — the one statement. Exported so the grep test can match it verbatim and so it is
 * unit-testable without a database, exactly as `lib/lab.ts` exports its two.
 */
export const CORPUS_DEACTIVATE_SQL =
  `UPDATE mksap_chunks SET source = $1, visible = false WHERE id = ANY($2) RETURNING id`;

/** The two prefixes, in one place, so neither is spelled out twice. */
export const QUARANTINE_PREFIX = 'labq:';
export const ACTIVE_PREFIX = 'lab:';

export function quarantinedSourceFor(label: string): string { return `${QUARANTINE_PREFIX}${labLabel(label)}`; }
export function activeSourceFor(label: string): string { return `${ACTIVE_PREFIX}${labLabel(label)}`; }

/** Injection seam for unit tests (repo idiom). Production replaces neither. */
export interface CorpusWriterDeps {
  activate?: (label: string, targetSource?: string) => Promise<{ source: string; activated: number }>;
  run?: (statement: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
}

const liveRun = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * ACTIVATE — v1's function, called. Nothing is added to the write itself.
 *
 * ⚠️ v1's `corpusActivate` returns a COUNT, not the ids, so the ids the release must record are
 * read back here from the target source rather than invented. The caller (decision 79a) compares
 * them against the set recorded at prepare and refuses to proceed on a difference; this function
 * reports what happened and judges nothing.
 */
export async function activateLabel(
  label: string, deps: CorpusWriterDeps = {},
): Promise<{ source: string; activated: number; ids: number[] }> {
  const activate = deps.activate ?? corpusActivate;
  const run = deps.run ?? liveRun;
  const target = activeSourceFor(label);
  const out = await activate(label);
  const rows = await run(ACTIVATED_IDS_SQL, [target]);
  return { source: out.source, activated: out.activated, ids: rows.map((r) => Number(r.id)).filter(Number.isFinite) };
}

/**
 * The ids now under the active source. A READ — it is listed with the other inferred reads in the
 * build report and it goes nowhere near a write.
 */
export const ACTIVATED_IDS_SQL = `SELECT id FROM mksap_chunks WHERE source = $1 ORDER BY id LIMIT 500`;

/**
 * DEACTIVATE — decision 80a. The one v2 write, on the exact ids and no others.
 *
 * Returns the ids it actually moved, which is how a rollback receipt can say `flipped 12 of the 12
 * recorded` rather than asserting it. A row already back in quarantine matches nothing and is
 * simply absent from the result; the caller reports the shortfall instead of failing, because a
 * half-rolled-back release must be visible, not retried blindly.
 */
export async function deactivateIds(
  label: string, ids: readonly number[], deps: CorpusWriterDeps = {},
): Promise<{ source: string; ids: number[] }> {
  const run = deps.run ?? liveRun;
  const clean = [...new Set(ids.map((n) => Number(n)))].filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!clean.length) {
    throw new LabError('INVALID_INPUT', 'a rollback needs the chunk ids the activation returned; an empty set flips nothing');
  }
  if (clean.length !== ids.length) {
    throw new LabError('INVALID_INPUT', 'the recorded chunk id set contains a value that is not a positive integer id');
  }
  const source = quarantinedSourceFor(label);
  const rows = await run(CORPUS_DEACTIVATE_SQL, [source, clean]);
  return { source, ids: rows.map((r) => Number(r.id)).filter(Number.isFinite) };
}
