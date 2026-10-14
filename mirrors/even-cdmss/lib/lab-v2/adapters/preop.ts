/**
 * lib/lab-v2/adapters/preop.ts — the preop adapter
 * (LAB-MCP-V2-PRD-v1.0 §17.8 round D1, decision 104).
 *
 * ⚠️ IT RUNS THE WHOLE SWEEP, NARROWED TO ONE EPISODE, WITH EVERY WRITE OFF.
 *
 *   `dryRun: true`        — `lib/preop/store.ts`'s six writes are all behind it, so no
 *                            `preop_findings`, `preop_finding_versions`, `preop_sweeps` or
 *                            `preop_suggestion_decisions` row can be written. A test asserts the
 *                            flag is PASSED, rather than assuming the default.
 *   `onlyEpisodes: [key]` — the sweep discovers its own episodes; this narrows it to the one the
 *                            case froze, which is also the only one whose sources are present.
 *   `sources`             — the D1 seam (`run.ts`'s `PreopSources`), serving the frozen six.
 *                            Without it every source read goes to db13 and throws inside the fence.
 *   `suggestCall` / `narrativeCall` — the two model legs, bound to the gateway.
 *
 * ⚠️ BOTH MODEL FLAGS COME FROM THE ARM, NEVER FROM THE ENVIRONMENT. Decision 104 says so and the
 * reason is reproducibility: `PREOP_EXTRACT_MODE` and `PREOP_NARRATIVE_ENABLED` are deployment
 * switches, so an arm that inherited them would compute a different thing on Tuesday than on
 * Monday and neither run would say why. `rails` is passed explicitly on every run.
 *
 * ⚠️ THE PSEUDONYMS ARE MAPPED BACK HERE, IN MEMORY, AND NOWHERE ELSE. `sources/preop.ts` stores
 * `personRef`, `personAltRef` and `episodeRef` so that nothing on the denylist is written
 * (decision 99); the sweep joins on `individualUid`, `uhid` and `docId`. This function renames
 * them for the duration of one run. The values stay surrogates throughout — the engine never sees
 * a real identifier, it only sees a consistent one.
 */
import { LabError } from '../contracts';
import { runPreopSweep, type PreopSources } from '../../preop/run';
import { PREOP_ENGINE_VERSION } from '../../preop/store';
import { FACILITY_KEYS, PERSON_DOC_KEYS, PSEUDONYM_KEYS } from '../sources/preop';
import { PREOP_TIER_RULE_VERSION } from '../../preop-tier-core';
import type { Adapter, AdapterContext, AdapterOutcome } from './types';

/** §17.8 item 4 — `lib/preop/suggest.ts:78` and `lib/preop/narrative.ts:44`. */
export const PREOP_STAGES = ['preop_suggest', 'preop_narrative'] as const;

/** One extraction read plus one narrative, inside the tick's own bound. */
export const PREOP_PER_ATTEMPT_MS = 120_000;

/** The inverse of `PSEUDONYM_KEYS`, built once. `personRef` → `individualUid`, and so on. */
/**
 * ⚠️ DECISION 111 — THE INVERSE IS PER SOURCE, BECAUSE ONE ALIAS NOW STANDS FOR TWO REAL NAMES.
 * `facilityRef` is the episode's `hospitalUid` on one row set and the directory's `uid` on another;
 * `recordRef` is `PacRow.uid` on one and `ref` on two more. A single global map would have to pick
 * one, and the join at `run.ts:529` would then land on nothing. So the restore is applied with the
 * map that belongs to the source it is restoring.
 */
const RESTORE_FOR: Record<string, Record<string, string>> = {
  fetchUpcomingEpisodes: { personRef: 'individualUid', personAltRef: 'uhid', episodeRef: 'docId', facilityRef: 'hospitalUid' },
  fetchCreatinine: { personRef: 'individualUid', personAltRef: 'uhid', episodeRef: 'docId', label: 'name' },
  fetchOpdIcd: { personRef: 'individualUid', personAltRef: 'uhid', episodeRef: 'docId', recordRef: 'ref' },
  fetchOpdComorbidities: { personRef: 'individualUid', personAltRef: 'uhid', episodeRef: 'docId', recordRef: 'ref' },
  fetchPacReports: { personRef: 'individualUid', personAltRef: 'uhid', episodeRef: 'docId', recordRef: 'uid' },
  fetchHospitalNames: { facilityRef: 'uid', label: 'name' },
};

/** Every alias this adapter knows how to undo, for the shape assertions in the tests. */
export const ALL_ALIASES: readonly string[] = [
  ...Object.values(PSEUDONYM_KEYS), ...Object.values(PERSON_DOC_KEYS), ...Object.values(FACILITY_KEYS),
];

/** Rename the aliases back to what the engine reads. Values are untouched surrogates. */
export function restoreKeys(value: unknown, map: Record<string, string>, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => restoreKeys(v, map, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[map[k] ?? k] = restoreKeys(v, map, depth + 1);
  }
  return out;
}

interface FrozenPreop {
  engine?: string;
  sources?: Record<string, { rows: unknown[]; error: string | null }>;
  horizon_days?: number;
  now?: string;
}

export function makePreopAdapter(): Adapter {
  return {
    engine: 'preop',
    stages: PREOP_STAGES,
    engineVersion: () => PREOP_ENGINE_VERSION,
    frozenInputs: ['sources', 'horizon_days', 'now'],
    perAttemptTimeoutMs: PREOP_PER_ATTEMPT_MS,

    async run(ctx: AdapterContext): Promise<AdapterOutcome> {
      const frozen = (ctx.frozen ?? {}) as FrozenPreop;
      const stored = frozen.sources;
      if (!stored || !stored.fetchUpcomingEpisodes) {
        return {
          result: { error: 'frozen inputs did not match the preop shape', keys: Object.keys(frozen) },
          summary: { engine: 'preop', error: 'bad_frozen_inputs' },
          execution_status: 'failed', assessment_status: 'not_reached',
        };
      }

      // The six, served from the frozen bytes with the three keys renamed back.
      const served = (name: string) => {
        const s = stored[name] ?? { rows: [], error: null };
        return { rows: restoreKeys(s.rows, RESTORE_FOR[name] ?? {}) as never[], error: s.error };
      };
      const sources: PreopSources = {
        fetchUpcomingEpisodes: async () => served('fetchUpcomingEpisodes'),
        fetchCreatinine: async () => served('fetchCreatinine'),
        fetchOpdIcd: async () => served('fetchOpdIcd'),
        fetchPacReports: async () => served('fetchPacReports'),
        fetchHospitalNames: async () => served('fetchHospitalNames'),
        fetchOpdComorbidities: async () => served('fetchOpdComorbidities'),
      };

      // The one episode this case froze, by the surrogate the sweep will match on.
      const episodeRow = (served('fetchUpcomingEpisodes').rows[0] ?? {}) as { docId?: string };
      const onlyEpisodes = episodeRow.docId ? [String(episodeRow.docId)] : [];

      // §17.8 item 8 — both flags FROM THE ARM. Absent ⇒ off, which is a tick that makes no model
      // call at all and still tiers the episode: the deterministic score is the engine.
      const arm = (ctx.arm ?? {}) as { rails?: { extraction?: boolean; narrative?: boolean } };
      const rails = { extraction: arm.rails?.extraction === true, narrative: arm.rails?.narrative === true };

      let suggestLegs = 0;
      let narrativeLegs = 0;
      const text = (staged: { completion?: unknown; text?: string }) => {
        const c = staged.completion as { choices?: { message?: { content?: string } }[] } | null;
        return c?.choices?.[0]?.message?.content ?? staged.text ?? '';
      };

      try {
        const sweep = await runPreopSweep({
          now: frozen.now ? new Date(frozen.now) : undefined,
          horizonDays: frozen.horizon_days ?? 60,
          // ⚠️ ASSERTED BY A TEST, NOT ASSUMED. This is the flag every preop write hides behind.
          dryRun: true,
          rails,
          onlyEpisodes,
          collect: true,
          sources,
          suggestCall: async (prompt) => {
            suggestLegs += 1;
            return String(text(await ctx.gateway.call('preop_suggest', {
              messages: [
                { role: 'system', content: prompt.system },
                { role: 'user', content: prompt.user },
              ],
              temperature: 0,
            })));
          },
          narrativeCall: async (prompt) => {
            narrativeLegs += 1;
            return String(text(await ctx.gateway.call('preop_narrative', {
              messages: [
                { role: 'system', content: prompt.system },
                { role: 'user', content: prompt.user },
              ],
              temperature: 0.2,
            })));
          },
        });

        // §17.8 item 8 — the assessable key, against `preop-tier/0`'s vocabulary.
        const tier = sweep.cases?.[0]?.tier ?? null;
        const assessed = tier != null && String(tier).length > 0 && sweep.episodes > 0;
        return {
          result: sweep,
          summary: {
            engine: 'preop',
            engine_version: PREOP_ENGINE_VERSION,
            tier_rule_version: PREOP_TIER_RULE_VERSION,
            tier: tier == null ? null : String(tier),
            episodes: sweep.episodes,
            by_tier: sweep.byTier,
            // ⚠️ THE PROOF THAT NOTHING WAS WRITTEN, carried on every item rather than asserted
            // once in a test: `written` is store.ts's own outcome tally, and under dryRun it is
            // empty. A reader of a run never has to take the flag on trust.
            written: sweep.written,
            degraded_sources: sweep.degradedSources,
            rails,
            suggest_legs: suggestLegs,
            narrative_legs: narrativeLegs,
          },
          execution_status: 'succeeded',
          assessment_status: assessed ? 'assessed' : 'unassessable',
        };
      } catch (e) {
        if (e instanceof LabError) throw e;
        return {
          result: { error: String((e as Error).message).slice(0, 500) },
          summary: { engine: 'preop', engine_version: PREOP_ENGINE_VERSION, error: 'sweep_failed' },
          execution_status: 'failed', assessment_status: 'not_reached',
        };
      }
    },
  };
}
