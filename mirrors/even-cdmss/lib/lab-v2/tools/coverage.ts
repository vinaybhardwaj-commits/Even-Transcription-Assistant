/**
 * lib/lab-v2/tools/coverage.ts — `coverage_report` (LAB-MCP-V2-PRD-v1.0 §17.6 item 3).
 *
 * ⚠️ THE DENOMINATOR IS THE WHOLE POINT, AND IT IS STATED IN THE OUTPUT.
 *
 * "Coverage" is a fraction, and a fraction is a lie unless the reader knows what is underneath it.
 * The honest denominator this platform can see is NOT "every admission that happened" — that lives
 * in db13, which no research tool reads. It is "every episode the nightly worker LOOKED AT", which
 * is exactly `ipd_episode_audits` plus `ipd_episode_skips` for the day. An episode the selection
 * query never returned is in neither table and is therefore invisible here, and the output says so
 * in words rather than leaving it to be discovered.
 *
 * So each row carries its own arithmetic: `examined`, `audited`, `skipped`, the skip breakdown by
 * reason, and `qualifying` = examined minus the three SELECTION skips (`no_discharge_summary`,
 * `no_notes`, `no_extraction`), which are the conditions that mean "this episode was never
 * auditable", not "this episode failed". A `diff_failed` episode IS in the denominator: it
 * qualified and the engine could not finish it, which is precisely the thing coverage should show.
 *
 * OPD's shape is different and is reported as it is rather than forced into IPD's. There is no
 * skips table: a note that could not be audited is a ROW with an `excluded_reason`, so `examined`
 * is rows present, `audited` is rows with no reason, and the breakdown is by reason.
 *
 * EVERY STATEMENT HERE IS INFERRED, listed verbatim in the build report, and validated live
 * through the v1 `audit_query` connector on 06 Sep 2026 before this file was written. All four are
 * SELECT, all go through `boundedRead` — the v1 read-only guard and decision 31's 15 s deadline.
 */
import { z } from 'zod';
import { LabError } from '../contracts';
import { boundedRead } from '../sources/read';

/** The three §3.1 conditions that mean an episode was never auditable — see the header. */
export const IPD_SELECTION_SKIPS = ['no_discharge_summary', 'no_notes', 'no_extraction'] as const;

export const COVERAGE_ENGINES = ['ipd_episode', 'opd_note_audit'] as const;

/**
 * The definition, in the words the output carries. It is a constant so the report and the code
 * cannot drift: a change to what `qualifying` means is a change to this string.
 */
export const QUALIFYING_DEFINITION: Record<(typeof COVERAGE_ENGINES)[number], string> = {
  ipd_episode:
    'examined = episodes the nightly worker reached on that discharge day, i.e. rows in ipd_episode_audits plus rows in ipd_episode_skips. '
    + 'qualifying = examined minus the three SELECTION skips (no_discharge_summary, no_notes, no_extraction), which mean the episode was never auditable. '
    + 'audited = current audit rows. An episode the selection query never returned is in NEITHER table and is invisible to this report; '
    + 'this is a coverage report over what the worker looked at, not over what the hospital admitted.',
  opd_note_audit:
    'examined = rows in opd_note_audits for that note date. audited = rows with excluded_reason IS NULL. '
    + 'qualifying = examined, because an OPD note that could not be audited is still a stored row carrying its reason - there is no skips table. '
    + 'A note db13 holds that the worker never selected is invisible to this report.',
};

export const COVERAGE_SCHEMAS = {
  coverage_report: {
    input: z.object({
      engine: z.enum(COVERAGE_ENGINES),
      days: z.number().int().min(1).max(90).default(30),
      engine_version: z.string().min(1).max(128).optional(),
    }),
    output: z.object({
      engine: z.enum(COVERAGE_ENGINES),
      days: z.number().int(),
      /** Read this before the numbers. */
      qualifying_definition: z.string(),
      totals: z.object({
        examined: z.number().int(),
        qualifying: z.number().int(),
        audited: z.number().int(),
        skipped: z.number().int(),
        coverage_pct: z.number().nullable(),
      }),
      by_day: z.array(z.object({
        day: z.string(),
        engine_version: z.string().nullable(),
        examined: z.number().int(),
        qualifying: z.number().int(),
        audited: z.number().int(),
        skipped: z.number().int(),
        /** audited over qualifying, or null when nothing qualified — never 100 on a zero denominator. */
        coverage_pct: z.number().nullable(),
        skips_by_reason: z.record(z.number().int()),
      })),
    }),
  },
} as const;

/** A version string, refused rather than escaped — the charset sources/audits.ts uses for ids. */
function lit(value: string, field: string): string {
  if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(value)) {
    throw new LabError('INVALID_INPUT', `${field} contains characters that are not allowed in a filter value`);
  }
  return `'${value}'`;
}

function days(n: number): number {
  const d = Math.floor(n);
  if (!Number.isFinite(d) || d < 1 || d > 90) throw new LabError('INVALID_INPUT', 'days must be between 1 and 90');
  return d;
}

export const IPD_AUDITED_SQL = (n: number, version: string | null) => `SELECT
  to_char(a.discharged_at, 'YYYY-MM-DD') AS day,
  a.engine_version,
  count(*) AS audited
FROM ipd_episode_audits a
WHERE a.is_current
  AND a.discharged_at >= (now() - make_interval(days => ${days(n)}))
  ${version ? `AND a.engine_version = ${lit(version, 'engine_version')}` : ''}
GROUP BY 1, 2 ORDER BY 1 DESC, 2 LIMIT 500`;

export const IPD_SKIPS_SQL = (n: number, version: string | null) => `SELECT
  to_char(s.discharged_at, 'YYYY-MM-DD') AS day,
  s.engine_version,
  s.reason,
  count(*) AS n
FROM ipd_episode_skips s
WHERE s.discharged_at >= (now() - make_interval(days => ${days(n)}))
  ${version ? `AND s.engine_version = ${lit(version, 'engine_version')}` : ''}
GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2, 3 LIMIT 500`;

export const OPD_COVERAGE_SQL = (n: number, version: string | null) => `SELECT
  to_char(o.note_date, 'YYYY-MM-DD') AS day,
  o.engine_version,
  count(*) AS examined,
  count(*) FILTER (WHERE o.excluded_reason IS NULL) AS audited,
  count(*) FILTER (WHERE o.excluded_reason IS NOT NULL) AS excluded
FROM opd_note_audits o
WHERE o.note_date >= (CURRENT_DATE - ${days(n)})
  ${version ? `AND o.engine_version = ${lit(version, 'engine_version')}` : ''}
GROUP BY 1, 2 ORDER BY 1 DESC, 2 LIMIT 500`;

export const OPD_EXCLUSIONS_SQL = (n: number, version: string | null) => `SELECT
  to_char(o.note_date, 'YYYY-MM-DD') AS day,
  o.engine_version,
  o.excluded_reason AS reason,
  count(*) AS n
FROM opd_note_audits o
WHERE o.note_date >= (CURRENT_DATE - ${days(n)})
  AND o.excluded_reason IS NOT NULL
  ${version ? `AND o.engine_version = ${lit(version, 'engine_version')}` : ''}
GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2, 3 LIMIT 500`;

interface DayRow {
  day: string; engine_version: string | null;
  examined: number; qualifying: number; audited: number; skipped: number;
  coverage_pct: number | null; skips_by_reason: Record<string, number>;
}

/** audited over qualifying as a percentage — null on a zero denominator, never 0 and never 100. */
export function coveragePct(audited: number, qualifying: number): number | null {
  return qualifying > 0 ? Math.round((100 * audited) / qualifying) : null;
}

export interface CoverageDeps {
  read?: (source: string, statement: string) => Promise<Record<string, unknown>[]>;
}

const liveRead = (source: string, statement: string) => boundedRead<Record<string, unknown>>(source, statement, [], 500);

export async function coverageReport(
  args: { engine: (typeof COVERAGE_ENGINES)[number]; days?: number; engine_version?: string },
  deps: CoverageDeps = {},
) {
  const read = deps.read ?? liveRead;
  const n = days(args.days ?? 30);
  const version = args.engine_version ?? null;
  const byKey = new Map<string, DayRow>();
  const row = (day: string, ev: string | null): DayRow => {
    const k = `${day} ${ev ?? ''}`;
    let r = byKey.get(k);
    if (!r) {
      r = { day, engine_version: ev, examined: 0, qualifying: 0, audited: 0, skipped: 0, coverage_pct: null, skips_by_reason: {} };
      byKey.set(k, r);
    }
    return r;
  };

  if (args.engine === 'ipd_episode') {
    const [audited, skips] = await Promise.all([
      read('ipd_episode_audits', IPD_AUDITED_SQL(n, version)),
      read('ipd_episode_skips', IPD_SKIPS_SQL(n, version)),
    ]);
    for (const a of audited) {
      const r = row(String(a.day), a.engine_version == null ? null : String(a.engine_version));
      r.audited += Number(a.audited ?? 0);
    }
    for (const s of skips) {
      const r = row(String(s.day), s.engine_version == null ? null : String(s.engine_version));
      const reason = String(s.reason ?? 'unknown');
      const c = Number(s.n ?? 0);
      r.skipped += c;
      r.skips_by_reason[reason] = (r.skips_by_reason[reason] ?? 0) + c;
    }
    for (const r of byKey.values()) {
      r.examined = r.audited + r.skipped;
      // Only the three SELECTION skips leave the denominator. A diff_failed or fidelity_failed
      // episode qualified and was not delivered, which is exactly what coverage must show.
      const neverAuditable = (IPD_SELECTION_SKIPS as readonly string[])
        .reduce((sum, reason) => sum + (r.skips_by_reason[reason] ?? 0), 0);
      r.qualifying = r.examined - neverAuditable;
      r.coverage_pct = coveragePct(r.audited, r.qualifying);
    }
  } else {
    const [cov, exc] = await Promise.all([
      read('opd_note_audits', OPD_COVERAGE_SQL(n, version)),
      read('opd_note_audits', OPD_EXCLUSIONS_SQL(n, version)),
    ]);
    for (const c of cov) {
      const r = row(String(c.day), c.engine_version == null ? null : String(c.engine_version));
      r.examined += Number(c.examined ?? 0);
      r.audited += Number(c.audited ?? 0);
      r.skipped += Number(c.excluded ?? 0);
    }
    for (const e of exc) {
      const r = row(String(e.day), e.engine_version == null ? null : String(e.engine_version));
      const reason = String(e.reason ?? 'unknown');
      r.skips_by_reason[reason] = (r.skips_by_reason[reason] ?? 0) + Number(e.n ?? 0);
    }
    for (const r of byKey.values()) {
      r.qualifying = r.examined;
      r.coverage_pct = coveragePct(r.audited, r.qualifying);
    }
  }

  const by_day = [...byKey.values()].sort((a, b) => (a.day === b.day
    ? String(a.engine_version).localeCompare(String(b.engine_version))
    : b.day.localeCompare(a.day)));
  const sum = (f: (r: DayRow) => number) => by_day.reduce((t, r) => t + f(r), 0);
  const examined = sum((r) => r.examined);
  const qualifying = sum((r) => r.qualifying);
  const audited = sum((r) => r.audited);

  return {
    engine: args.engine,
    days: n,
    qualifying_definition: QUALIFYING_DEFINITION[args.engine],
    totals: { examined, qualifying, audited, skipped: sum((r) => r.skipped), coverage_pct: coveragePct(audited, qualifying) },
    by_day,
  };
}
