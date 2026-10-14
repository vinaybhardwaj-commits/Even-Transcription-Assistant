/**
 * lib/lab-v2/sources/cohort.ts — cohort resolution and freeze (§17.4 item 1, decisions 41 and 44).
 *
 * A cohort is a STUDY, not a sweep. Two hundred is the ceiling because freezing a case is not
 * cheap: each one is a db13 note read, a db13 member resolution, a production-Neon rule and
 * directory read, and a candidate-stage retrieval. Two hundred of those is a real amount of work
 * to do inside one tool call, and a study that needs more than two hundred cases needs a
 * different mechanism than a synchronous freeze.
 *
 * ⚠️ ONE CASE'S FAILURE IS AN EXCLUSION, NOT THE COHORT'S FAILURE. A note that has vanished from
 * db13, or one whose member cannot be resolved, is reported in `excluded` with its reason and the
 * rest are frozen. The alternative — failing the whole call — would make a 200-case cohort
 * hostage to any one bad row, and the caller could not even see which. An exclusion is data.
 *
 * SOURCE READS. The cohort filter reuses `audit_search`'s statement builder over `opd_note_audits`
 * (round A2, validated live), and each case reuses `freezeOpdCase`. This file adds no SQL of its
 * own; the one new statement in the round is the db13 member resolution in sources/opd.ts.
 */
import { LabError } from '../contracts';
import { auditFilterSchema, searchAudits, type AuditFilter } from './audits';
import { freezeOpdCase, memberSalt, type FrozenCase } from './opd';

/** §17.4 — the ceiling, and the reason it is not a soft limit. */
export const COHORT_MAX = 200;

export interface CohortSpec { case_keys?: string[]; filter?: Record<string, unknown> }

export interface CohortExclusion { case_key: string; reason: string }

export interface CohortResult {
  cases: FrozenCase[];
  excluded: CohortExclusion[];
  requested: number;
}

/**
 * Resolve the cohort's case keys, before any freezing.
 *
 * An explicit list is taken as given. A filter runs `audit_search`'s own statement — the same
 * schema, the same builder, the same read-only guard and 15 s deadline — so a cohort can never
 * select on something `audit_search` could not show you first.
 */
export async function resolveCohortKeys(spec: CohortSpec, exclusions: readonly string[]): Promise<string[]> {
  const excluded = new Set(exclusions);
  let keys: string[];
  if (spec.case_keys?.length) {
    keys = spec.case_keys;
  } else if (spec.filter) {
    const parsed = auditFilterSchema.safeParse(spec.filter);
    if (!parsed.success) {
      throw new LabError('INVALID_INPUT', `cohort filter: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    const rows = await searchAudits(parsed.data as AuditFilter, COHORT_MAX, 0);
    keys = rows.map((r) => r.uid);
  } else {
    throw new LabError('INVALID_INPUT', 'cohort requires either case_keys or filter');
  }
  const deduped = [...new Set(keys)].filter((k) => !excluded.has(k));
  if (!deduped.length) throw new LabError('INVALID_INPUT', 'the cohort resolved to no cases');
  if (deduped.length > COHORT_MAX) {
    throw new LabError('INVALID_INPUT', `cohort of ${deduped.length} exceeds the maximum of ${COHORT_MAX}`);
  }
  return deduped;
}

/**
 * Freeze every case in the cohort, with decision 41's sources and decision 44's member key.
 *
 * The salt is checked ONCE, before any work: a cohort that would fail on its last case for a
 * missing env var should fail on its first, having read nothing.
 */
export type CaseFreezer = (caseKey: string) => Promise<FrozenCase>;

/** Production's freezer: the real db13 read, decision 41's sources, decision 44's member key. */
export const freezeOpdCohortCase: CaseFreezer = (caseKey) =>
  freezeOpdCase(caseKey, { withSources: true, withMemberKey: true });

export async function freezeCohort(
  spec: CohortSpec, exclusions: readonly string[], freezeCase: CaseFreezer = freezeOpdCohortCase,
): Promise<CohortResult> {
  memberSalt();   // decision 44 — NOT_CONFIGURED here, before the first read
  const keys = await resolveCohortKeys(spec, exclusions);
  const cases: FrozenCase[] = [];
  const excluded: CohortExclusion[] = [];
  for (const key of keys) {
    try {
      cases.push(await freezeCase(key));
    } catch (e) {
      const err = e as LabError;
      // NOT_CONFIGURED is the salt, and it is the cohort's problem, not this case's — re-throw so
      // a misconfigured deployment cannot quietly produce a cohort of 200 exclusions.
      if (err.code === 'NOT_CONFIGURED') throw err;
      excluded.push({ case_key: key, reason: `${err.code ?? 'ERROR'}: ${String(err.message).slice(0, 200)}` });
    }
  }
  if (!cases.length) {
    throw new LabError('SOURCE_UNAVAILABLE', `no case in the cohort could be frozen (${excluded.length} excluded)`);
  }
  return { cases, excluded, requested: keys.length };
}
