/**
 * lib/lab-v2/tools/drift.ts — `drift_report` (LAB-MCP-V2-PRD-v1.0 §17.6 item 4).
 *
 * ⚠️ WHAT A WEEK-OVER-WEEK DELTA IS NOT. It is not evidence that anything changed. Two consecutive
 * weeks of a clinical cohort differ because the admissions differed; IPD Episode §1.27 measured
 * that roughly two in five divergent findings do not survive a re-run of the SAME episode on the
 * SAME code, so a moving mean over a moving cohort is the sum of at least three effects and this
 * tool can separate none of them. Every response therefore carries `caveat` — the sentence is a
 * constant, not something a caller can drop, and it is in the schema so a client cannot render the
 * table without it.
 *
 * WHAT IT IS FOR. Noticing. A band histogram that empties, an off-topic retrieval rate that
 * doubles, a `n_findings` p90 that halves the week a prompt changed — those are worth a look, and
 * nobody looks at what nobody can see. The report answers "is this worth investigating", never
 * "did this get better".
 *
 * ⚠️ TWO STATEMENTS PER ENGINE, NOT ONE JOINED PAIR, and the reason is a bug this file was written
 * with. Joining `ipd_episode_checkpoints` to `ipd_episode_audits` to get the off-topic rate
 * multiplies every audit row by its checkpoint count, so `count(*)` becomes checkpoints and every
 * `avg()` becomes checkpoint-weighted: the first draft reported 82 episodes for a week that had 25.
 * The distributions and the retrieval rate are separate statements with separate, stated
 * denominators — `episodes` for one and `checkpoints` for the other.
 *
 * EVERY STATEMENT HERE IS INFERRED, listed verbatim in the build report, and validated live through
 * the v1 `audit_query` connector on 06 Sep 2026 (including the join bug above, which is how it was
 * found). All are SELECT and all go through `boundedRead`.
 */
import { z } from 'zod';
import { LabError } from '../contracts';
import { boundedRead } from '../sources/read';

/** Carried on every response. §17.6 item 4 requires it; the schema makes it non-optional. */
export const DRIFT_CAVEAT =
  'A week-over-week delta is not evidence of a change in the engine. The cohort moves every week, '
  + 'and IPD Episode §1.27 measured that about two in five divergent findings do not survive a re-run '
  + 'of the same episode on the same code, so a moving mean carries cohort mix, run-to-run variance '
  + 'and any real change together. Read a delta as a reason to look, never as a result.';

export const DRIFT_ENGINES = ['ipd_episode', 'opd_note_audit'] as const;

export const DRIFT_SCHEMAS = {
  drift_report: {
    input: z.object({
      engine: z.enum(DRIFT_ENGINES),
      weeks: z.number().int().min(2).max(26).default(8),
      engine_version: z.string().min(1).max(128).optional(),
    }),
    output: z.object({
      engine: z.enum(DRIFT_ENGINES),
      weeks: z.number().int(),
      /** Read this before the deltas. Not optional, by design. */
      caveat: z.string(),
      /** Which denominator each block counts, in words. */
      denominators: z.record(z.string()),
      by_week: z.array(z.object({
        week: z.string(),
        engine_version: z.string().nullable(),
        n: z.number().int(),
        n_findings: z.object({ avg: z.number().nullable(), p50: z.number().nullable(), p90: z.number().nullable() }),
        /** NQI for OPD, divergence_index for IPD — named in `score_field`. */
        score_field: z.string(),
        score: z.object({ n_scored: z.number().int(), avg: z.number().nullable(), p50: z.number().nullable() }),
        bands: z.record(z.number().int()),
        /** IPD only: checkpoints, and how many of them flagged retrieval_offtopic. */
        retrieval: z.object({ checkpoints: z.number().int(), offtopic: z.number().int(), offtopic_pct: z.number().nullable() }).nullable(),
        /** Against the PREVIOUS week of the same engine version. Null on the first week seen. */
        delta: z.object({
          n: z.number().int().nullable(),
          n_findings_avg: z.number().nullable(),
          score_avg: z.number().nullable(),
          offtopic_pct: z.number().nullable(),
        }),
      })),
    }),
  },
} as const;

function lit(value: string, field: string): string {
  if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(value)) {
    throw new LabError('INVALID_INPUT', `${field} contains characters that are not allowed in a filter value`);
  }
  return `'${value}'`;
}

function weekDays(weeks: number): number {
  const w = Math.floor(weeks);
  if (!Number.isFinite(w) || w < 2 || w > 26) throw new LabError('INVALID_INPUT', 'weeks must be between 2 and 26');
  return w * 7;
}

export const IPD_DRIFT_SQL = (weeks: number, version: string | null) => `SELECT
  to_char(date_trunc('week', a.audited_at), 'IYYY-"W"IW') AS week,
  a.engine_version,
  count(*) AS n,
  round(avg(a.n_findings)::numeric, 2) AS avg_n_findings,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY a.n_findings) AS p50_n_findings,
  percentile_disc(0.9) WITHIN GROUP (ORDER BY a.n_findings) AS p90_n_findings,
  count(a.divergence_index) AS n_scored,
  round(avg(a.divergence_index)::numeric, 2) AS avg_score,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY a.divergence_index) AS p50_score,
  count(*) FILTER (WHERE a.divergence_band IS NULL) AS band_none,
  count(*) FILTER (WHERE a.divergence_band = 'no divergence found') AS band_no_divergence,
  count(*) FILTER (WHERE a.divergence_band IS NOT NULL AND a.divergence_band <> 'no divergence found') AS band_divergence_found
FROM ipd_episode_audits a
WHERE a.is_current
  AND a.audited_at >= (now() - make_interval(days => ${weekDays(weeks)}))
  ${version ? `AND a.engine_version = ${lit(version, 'engine_version')}` : ''}
GROUP BY 1, 2 ORDER BY 1 DESC, 2 LIMIT 500`;

export const IPD_RETRIEVAL_DRIFT_SQL = (weeks: number, version: string | null) => `SELECT
  to_char(date_trunc('week', a.audited_at), 'IYYY-"W"IW') AS week,
  a.engine_version,
  count(*) AS checkpoints,
  count(*) FILTER (WHERE cp.retrieval_offtopic) AS checkpoints_offtopic
FROM ipd_episode_checkpoints cp
JOIN ipd_episode_audits a ON a.id = cp.episode_audit_id
WHERE a.is_current
  AND a.audited_at >= (now() - make_interval(days => ${weekDays(weeks)}))
  ${version ? `AND a.engine_version = ${lit(version, 'engine_version')}` : ''}
GROUP BY 1, 2 ORDER BY 1 DESC, 2 LIMIT 500`;

export const OPD_DRIFT_SQL = (weeks: number, version: string | null) => `SELECT
  to_char(date_trunc('week', o.note_date), 'IYYY-"W"IW') AS week,
  o.engine_version,
  count(*) AS n,
  round(avg(o.n_findings)::numeric, 2) AS avg_n_findings,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY o.n_findings) AS p50_n_findings,
  percentile_disc(0.9) WITHIN GROUP (ORDER BY o.n_findings) AS p90_n_findings,
  count(o.note_quality_index) AS n_scored,
  round(avg(o.note_quality_index)::numeric, 2) AS avg_score,
  percentile_disc(0.5) WITHIN GROUP (ORDER BY o.note_quality_index) AS p50_score,
  count(*) FILTER (WHERE o.band = 'A') AS band_a,
  count(*) FILTER (WHERE o.band = 'B') AS band_b,
  count(*) FILTER (WHERE o.band = 'C') AS band_c,
  count(*) FILTER (WHERE o.band = 'D') AS band_d,
  count(*) FILTER (WHERE o.band = 'E') AS band_e
FROM opd_note_audits o
WHERE o.note_date >= (CURRENT_DATE - ${weekDays(weeks)})
  ${version ? `AND o.engine_version = ${lit(version, 'engine_version')}` : ''}
GROUP BY 1, 2 ORDER BY 1 DESC, 2 LIMIT 500`;

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const int = (v: unknown): number => Number(v ?? 0);

/** Rounded to two places so a delta of two averages does not print sixteen digits of float noise. */
export function delta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return Math.round((a - b) * 100) / 100;
}

export interface DriftDeps {
  read?: (source: string, statement: string) => Promise<Record<string, unknown>[]>;
}

const liveRead = (source: string, statement: string) => boundedRead<Record<string, unknown>>(source, statement, [], 500);

export async function driftReport(
  args: { engine: (typeof DRIFT_ENGINES)[number]; weeks?: number; engine_version?: string },
  deps: DriftDeps = {},
) {
  const read = deps.read ?? liveRead;
  const weeks = Math.floor(args.weeks ?? 8);
  weekDays(weeks);
  const version = args.engine_version ?? null;
  const isIpd = args.engine === 'ipd_episode';

  const rows = await read(isIpd ? 'ipd_episode_audits' : 'opd_note_audits',
    isIpd ? IPD_DRIFT_SQL(weeks, version) : OPD_DRIFT_SQL(weeks, version));

  const retrievalByKey = new Map<string, { checkpoints: number; offtopic: number }>();
  if (isIpd) {
    const r = await read('ipd_episode_checkpoints', IPD_RETRIEVAL_DRIFT_SQL(weeks, version));
    for (const x of r) {
      retrievalByKey.set(`${x.week} ${x.engine_version ?? ''}`, {
        checkpoints: int(x.checkpoints), offtopic: int(x.checkpoints_offtopic),
      });
    }
  }

  const shaped = rows.map((r) => {
    const key = `${r.week} ${r.engine_version ?? ''}`;
    const ret = retrievalByKey.get(key) ?? null;
    const bands: Record<string, number> = isIpd
      ? {
        none: int(r.band_none),
        'no divergence found': int(r.band_no_divergence),
        'divergence found': int(r.band_divergence_found),
      }
      : { A: int(r.band_a), B: int(r.band_b), C: int(r.band_c), D: int(r.band_d), E: int(r.band_e) };
    return {
      week: String(r.week),
      engine_version: r.engine_version == null ? null : String(r.engine_version),
      n: int(r.n),
      n_findings: { avg: num(r.avg_n_findings), p50: num(r.p50_n_findings), p90: num(r.p90_n_findings) },
      score_field: isIpd ? 'divergence_index' : 'note_quality_index',
      score: { n_scored: int(r.n_scored), avg: num(r.avg_score), p50: num(r.p50_score) },
      bands,
      retrieval: ret
        ? {
          checkpoints: ret.checkpoints,
          offtopic: ret.offtopic,
          // Never 100 on a zero denominator: a week with no checkpoints has no rate.
          offtopic_pct: ret.checkpoints > 0 ? Math.round((100 * ret.offtopic) / ret.checkpoints) : null,
        }
        : null,
      delta: { n: null as number | null, n_findings_avg: null as number | null, score_avg: null as number | null, offtopic_pct: null as number | null },
    };
  });

  // The delta is against the PREVIOUS week OF THE SAME ENGINE VERSION. Comparing across versions
  // would be comparing two engines and calling it drift.
  const byVersion = new Map<string, typeof shaped>();
  for (const s of shaped) {
    const k = s.engine_version ?? '';
    const arr = byVersion.get(k);
    if (arr) arr.push(s); else byVersion.set(k, [s]);
  }
  for (const arr of byVersion.values()) {
    // rows arrive newest-first, so the previous week is the NEXT element
    for (let i = 0; i < arr.length - 1; i += 1) {
      const cur = arr[i];
      const prev = arr[i + 1];
      cur.delta = {
        n: cur.n - prev.n,
        n_findings_avg: delta(cur.n_findings.avg, prev.n_findings.avg),
        score_avg: delta(cur.score.avg, prev.score.avg),
        offtopic_pct: delta(cur.retrieval?.offtopic_pct ?? null, prev.retrieval?.offtopic_pct ?? null),
      };
    }
  }

  return {
    engine: args.engine,
    weeks,
    caveat: DRIFT_CAVEAT,
    denominators: {
      n: isIpd ? 'current ipd_episode_audits rows in the week, by audited_at' : 'opd_note_audits rows in the week, by note_date',
      score: isIpd ? 'rows with a non-null divergence_index (an unscorable episode has none)' : 'rows with a non-null note_quality_index',
      retrieval: isIpd ? 'ipd_episode_checkpoints of those episodes — checkpoints, NOT episodes' : 'not reported for this engine',
    },
    by_week: shaped,
  };
}
