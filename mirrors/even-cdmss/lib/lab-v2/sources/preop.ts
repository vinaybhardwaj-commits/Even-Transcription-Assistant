/**
 * lib/lab-v2/sources/preop.ts — freeze ONE preop episode's six sources as a case
 * (LAB-MCP-V2-PRD-v1.0 §17.8 round D1, decisions 99, 101 and 104).
 *
 * ⚠️ WHAT IS FROZEN IS THE SIX DB13 READS, NOT A DERIVED CASE. `runPreopSweep` is the engine, and
 * the whole point of running it in the lab is that it computes the tier itself. So this file
 * captures exactly what the sweep would have READ for one episode and nothing it would have
 * concluded — the six `Fetched<T>` results, in the shape `run.ts:468-483` calls them, so that the
 * injected `PreopSources` can hand them straight back.
 *
 * ⚠️ AND `error` IS FROZEN ALONGSIDE `rows`, WHICH IS NOT A DETAIL. `run.ts:489` collects a
 * faulted source into `degradedSources`, and the engine's own comment records the 26 August lesson:
 * a source that 504'd reported "0" and every coverage number silently became a floor. A freeze
 * that kept only the rows would replay a faulted source as an EMPTY one, which is the same bug in
 * a different building.
 *
 * ⚠️ THE IDENTIFIERS ARE USED AND NEVER STORED (decision 99). `episodeKey`, `individualUid` and
 * `uhid` are how the six reads are made; the frozen rows are then walked and any key on §3.3's
 * denylist is a REFUSAL, not a scrub. The case key is a salted hash of the episode key.
 */
import { createHash } from 'crypto';
import { exitLabExecution } from '../../lab-execution-context';
import { LabError } from '../contracts';
import { memberKeyOf, memberSalt } from './opd';
import { refuseIdentifying } from './readmission';
import {
  DEFAULT_PREOP_SOURCES, type PreopSources,
} from '../../preop/run';

/**
 * ⚠️ THERE IS NO SQL IN THIS FILE, AND THAT IS THE HONEST OUTCOME OF THE GROUNDING.
 *
 * §17.8's SQL honesty clause asks for every `preop` table read listed verbatim. Measured on
 * `c0f59fd0`: the six sources are db13 reads through `metabaseQuery` (`lib/preop/db13.ts`, nine
 * sites), not Neon reads, and the four `preop_*` Neon tables are touched only by
 * `lib/preop/store.ts` — which this path never reaches, because the adapter runs `dryRun: true`
 * and `store.ts`'s writes are all behind that flag. So the freeze issues no statement of its own:
 * it calls production's six fetchers, outside the fence, and keeps what they returned.
 *
 * The alternative — restating db13's nine queries here — would have been a second copy of a query
 * that can drift from the one the engine actually runs, which is the decision 79 lesson.
 */
export const PREOP_STATEMENTS_NOTE =
  'lib/lab-v2/sources/preop.ts issues no SQL: the six sources are db13 reads through '
  + 'lib/preop/db13.ts (metabaseQuery), called by import outside the fence, and the four preop_* '
  + 'Neon tables are reached only by lib/preop/store.ts, which dryRun suppresses entirely.';

export interface FrozenPreopCase {
  case_key: string;
  member_key: string | null;
  frozen: {
    engine: 'preop';
    /** The six `Fetched<T>` results, keyed by the fetcher whose place they take. */
    sources: Record<string, { rows: unknown[]; error: string | null }>;
    horizon_days: number;
    /** Frozen so a replay computes the same `todayIst` and the same upcoming window. */
    now: string;
  };
  source_versions: Record<string, unknown>;
}

export interface PreopSourceDeps {
  sources?: Partial<PreopSources>;
  salt?: string;
  now?: Date;
  horizonDays?: number;
}

/**
 * ⚠️⚠️ THE ONE PLACE DECISIONS 99 AND 104 COULD NOT BOTH BE TAKEN AT FACE VALUE. FLAGGED.
 *
 * Decision 104: *"the frozen case is the six source fetches' rows for that episode"*.
 * Decision 99: *"no object written by any D tool carries a key on the denylist, checked by walking
 * the stored body"* — and after decision 101 the denylist matches `individualUid`, `uhid` and
 * `episodeKey`.
 *
 * Those two cannot both hold literally, because `runPreopSweep` JOINS on exactly those keys:
 * `run.ts:493` builds `creatByUid` from `r.individualUid`, `:500` does the same for ICD, and
 * `onlyEpisodes` matches `e.docId`. Strip them and the engine cannot run; keep them and the
 * stored body carries denylisted keys.
 *
 * RESOLVED BY SATISFYING BOTH, AND THE RESOLUTION IS PSEUDONYMISATION AT TWO LEVELS:
 *   · the VALUE of every identifier is replaced by a stable per-case surrogate, salted, so nothing
 *     stored resolves to a person even by lookup;
 *   · the KEY is renamed to a name that is not on the denylist, so decision 99's walk passes as
 *     written rather than by exemption.
 * `adapters/preop.ts` maps the three back IN MEMORY immediately before calling the sweep, so the
 * engine sees the shape it expects and the database never does.
 *
 * The surrogates are consistent within one case, which is all the joins need — the sweep never
 * compares an id across episodes. A test asserts every value carries its surrogate prefix and that
 * no real id survives.
 *
 * ⚠️ IF V PREFERS DECISION 104 READ LITERALLY (real ids in the frozen body, decision 99 exempted
 * for these three keys), this is the file to change and the tests name it. Reported at the top of
 * the round rather than decided quietly.
 */
export const PSEUDONYM_KEYS: Record<string, string> = {
  individualUid: 'personRef',
  uhid: 'personAltRef',
  docId: 'episodeRef',
};

/**
 * ⚠️ ONE MORE RENAME, AND IT IS NOT A PSEUDONYM. `fetchHospitalNames` returns `{uid, name}` — a
 * directory of HOSPITALS — and §3.3's denylist matches the key `name` on sight, because a bare
 * `name` on a clinical row is a patient's. Decision 100 rules that the denylist is about patients,
 * so the VALUE stays real: a facility is not a person and the sweep uses it to label one.
 *
 * The key is renamed anyway, so decision 99's walk passes as WRITTEN rather than by exemption. An
 * exemption list is a thing that grows; a rename is a fact the adapter undoes in memory.
 */
export const DIRECTORY_KEYS: Record<string, string> = { name: 'label' };

/**
 * ⚠️⚠️ DECISION 111 — WHAT THE SAME SWEEP THROUGH THE PREOP SHAPES FOUND. Three more families, all
 * of them reachable in the freeze this round shipped, none of them caught by decision 101's pattern:
 *
 *   · `PreopEpisodeRow.patientName` (`lib/preop/db13.ts:75`) — A PATIENT'S NAME. The old pattern
 *     needed an underscore or nothing before `name`, so `patientName` passed. DROPPED: the sweep
 *     uses it only for the snapshot, and this adapter does not pass `collectSnapshots`, so nothing
 *     in the output path reads it.
 *   · `PacRow.uid` and `PreopIcdRow.ref` / `PreopOpdComorbidityRow.ref` (`db13.ts:403`, `:449` —
 *     both are `_doc_id`) — Firestore document ids, the same family as `indexDocumentId`.
 *     PSEUDONYMISED rather than dropped: `run.ts:225`, `:245`, `:263`, `:266` and `:276` pass each
 *     one as an observation's SOURCE REFERENCE, so the value must stay a stable handle or the
 *     provenance of every observation is lost.
 *   · `PreopEpisodeRow.hospitalUid` and the directory's `uid` — matched by the new `…Uid` suffix
 *     rule, and NOT about a patient. Renamed with their values KEPT, exactly as `name` → `label`
 *     already was: a facility is not a person. Both become the SAME name so the join at
 *     `run.ts:529` still lands. `PacRow.templateName` and `PreopEpisodeRow.procedure` need nothing:
 *     the name family is deliberately restricted to person words, so a form template and a surgery
 *     are untouched — see the note on `IDENTIFYING_KEY`.
 *
 * ⚠️ ONE VALUE-LEVEL RISK IS FLAGGED AND NOT ACTED ON: `PacRow.componentJson` is the raw KareXpert
 * form payload and could carry a name in its VALUE. Decision 34 says do not guess at value-level
 * de-identification, so it is reported rather than scrubbed.
 */
export const DROPPED_KEYS: readonly string[] = ['patientName'];

/** Person-scoped document ids: the value must survive as a stable handle, so it is a surrogate. */
export const PERSON_DOC_KEYS: Record<string, string> = { uid: 'recordRef', ref: 'recordRef' };

/** Not about a patient: the key is renamed and the VALUE is kept (decision 100's reasoning). */
export const FACILITY_KEYS: Record<string, string> = {
  hospitalUid: 'facilityRef', uid: 'facilityRef', name: 'label',
};

/** The prefix each surrogate carries, so a test can assert a value is one. */
export const PSEUDONYM_PREFIX = 'px:';

/** A stable, salted surrogate. Not reversible, and not comparable across cases. */
export function pseudonym(value: unknown, salt: string): string {
  return `${PSEUDONYM_PREFIX}${createHash('sha256').update(`${salt}|${String(value)}`).digest('hex').slice(0, 24)}`;
}

/** Remove keys outright — decision 111's `patientName`, and nothing the engine reads. */
export function dropKeys(rows: unknown[], drop: readonly string[]): unknown[] {
  return rows.map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
    return Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([k]) => !drop.includes(k)));
  });
}

/** Rename a key AND replace its value with a surrogate — decision 111's document ids. */
export function pxKeys(rows: unknown[], map: Record<string, string>, salt: string): unknown[] {
  return rows.map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
    return Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, v]) => (
      map[k] ? [map[k], v == null ? null : pseudonym(v, salt)] : [k, v]
    )));
  });
}

/** Rename keys without touching values — a facility is not a person (decision 100). */
export function renameKeys(rows: unknown[], map: Record<string, string>): unknown[] {
  return rows.map((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
    return Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, v]) => [map[k] ?? k, v]));
  });
}

/**
 * Walk a row set, renaming the three keys and replacing their values with surrogates.
 * Every other field is carried through untouched — the clinical values ARE the case.
 */
export function pseudonymiseRows(rows: unknown[], salt: string): unknown[] {
  const walk = (v: unknown, depth = 0): unknown => {
    if (depth > 12 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const renamed = PSEUDONYM_KEYS[k];
      if (renamed) out[renamed] = val == null ? null : pseudonym(val, salt);
      else out[k] = walk(val, depth + 1);
    }
    return out;
  };
  return rows.map((r) => walk(r));
}

/** The six, in the order `run.ts` calls them. Named so a missing one is a type error. */
export const PREOP_SOURCE_NAMES = [
  'fetchUpcomingEpisodes', 'fetchCreatinine', 'fetchOpdIcd',
  'fetchPacReports', 'fetchHospitalNames', 'fetchOpdComorbidities',
] as const;

export async function freezePreopEpisode(
  episodeKey: string, deps: PreopSourceDeps = {},
): Promise<FrozenPreopCase> {
  const key = String(episodeKey ?? '').trim();
  if (!key) throw new LabError('INVALID_INPUT', 'a preop case is one episode, named by its episodeKey');
  const src: PreopSources = { ...DEFAULT_PREOP_SOURCES, ...(deps.sources ?? {}) };
  const horizonDays = deps.horizonDays ?? 60;
  const now = deps.now ?? new Date();

  // ⚠️ OUTSIDE THE FENCE — every one of the six goes through `metabaseQuery`, which throws inside
  // a lab execution context by design (`lib/metabase.ts:115`).
  return exitLabExecution(async () => {
    const episodeFetch = await src.fetchUpcomingEpisodes(horizonDays);
    const episode = episodeFetch.rows.find((e) => e.docId === key);
    if (!episode) {
      throw new LabError('CASE_NOT_FOUND',
        `no upcoming surgery episode with that key inside a ${horizonDays}-day horizon; `
        + 'the sweep discovers its own episodes and can only freeze one it can see');
    }
    const individualUids = [episode.individualUid];
    const uhids = episode.uhid ? [episode.uhid] : [];

    const [creat, icd, pacs, hospitals, comorb] = await Promise.all([
      src.fetchCreatinine(individualUids),
      src.fetchOpdIcd(individualUids),
      src.fetchPacReports(uhids),
      src.fetchHospitalNames(),
      src.fetchOpdComorbidities(individualUids),
    ]);

    /**
     * ⚠️ THE EPISODE ROW IS NARROWED TO THE ONE EPISODE, ON PURPOSE. `fetchUpcomingEpisodes`
     * returns the whole horizon — every person with surgery booked in the next sixty days. Storing
     * that to replay ONE of them would put dozens of people's rows in a research object to
     * reproduce one case, which decision 99 forbids and which nothing needs: the adapter passes
     * `onlyEpisodes: [key]`, so the sweep would have filtered the rest away anyway.
     */
    const salt = deps.salt ?? memberSalt();
    const px = (rows: unknown[]) => pseudonymiseRows(rows, salt);
    const sources: Record<string, { rows: unknown[]; error: string | null }> = {
      // Decision 111: `patientName` dropped, `hospitalUid` renamed with its value kept.
      fetchUpcomingEpisodes: { rows: renameKeys(dropKeys(px([episode]), DROPPED_KEYS), { hospitalUid: 'facilityRef' }), error: episodeFetch.error },
      // ⚠️ `PreopLabRow.name` is the ANALYTE ('Creatinine'), not a person — but a bare `name` on a
      // clinical row usually is one, so the pattern matches it and this renames rather than
      // exempts. `run.ts:495` reads only value, unit and at, so nothing downstream notices.
      fetchCreatinine: { rows: renameKeys(px(creat.rows), { name: 'label' }), error: creat.error },
      // Decision 111: `ref` is a Firestore `_doc_id` — a surrogate, so the observation keeps a handle.
      fetchOpdIcd: { rows: pxKeys(px(icd.rows), { ref: 'recordRef' }, salt), error: icd.error },
      fetchPacReports: { rows: pxKeys(px(pacs.rows), { uid: 'recordRef' }, salt), error: pacs.error },
      // ⚠️ NOT PSEUDONYMISED, AND THE REASON IS THAT IT IS NOT ABOUT A PERSON. This is a
      // uid → name table of HOSPITALS, which the sweep uses to label a facility. Decision 100's
      // reasoning applies with room to spare: §3.3's denylist is about patients.
      fetchHospitalNames: { rows: renameKeys(hospitals.rows, { ...DIRECTORY_KEYS, uid: 'facilityRef' }), error: hospitals.error },
      fetchOpdComorbidities: { rows: pxKeys(px(comorb.rows), { ref: 'recordRef' }, salt), error: comorb.error },
    };

    const frozen = { engine: 'preop' as const, sources, horizon_days: horizonDays, now: now.toISOString() };
    // ⚠️ DECISION 99, ENFORCED BEFORE ANYTHING IS RETURNED. db13's rows carry `individualUid`,
    // `uhid` and `docId`; every one of them is on the denylist after decision 101, and a hit here
    // is a REFUSAL. That is the point: this is where the platform finds out that a source shape
    // changed, rather than finding out from the stored object months later.
    refuseIdentifying(frozen, 'the frozen preop case');

    return {
      case_key: `preop:${createHash('sha256').update(`${salt}|${key}`).digest('hex').slice(0, 32)}`,
      // From the REAL uhid, read above and never stored — the salted member hash is the one
      // durable link decision 99 permits, and it is the same construction B2's IPD cases use.
      member_key: episode.uhid ? memberKeyOf(String(episode.uhid), salt) : null,
      frozen,
      source_versions: {
        origin: 'db13 via lib/preop/db13.ts',
        note: PREOP_STATEMENTS_NOTE,
        horizon_days: horizonDays,
        degraded: Object.entries(sources).filter(([, v]) => v.error).map(([k]) => k),
        frozen_at: new Date().toISOString(),
      },
    };
  });
}
