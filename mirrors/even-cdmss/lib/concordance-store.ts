// Concordance — capture-and-wall store. Writes the de-identified run record; the ONLY
// read path is admin (registry aggregates for Track-2 calibration). No operational read.
import { sql } from './db';
import type { ConcordanceRunRecord } from './concordance-core';

export async function insertConcordanceRun(r: ConcordanceRunRecord): Promise<void> {
  await sql`
    INSERT INTO concordance_runs
      (analytes, verdict, branch, confidence, asked_count, unknown_count,
       who_report, who_you, who_lab, age_band, sex, mode, engine)
    VALUES
      (${r.analytes}, ${r.verdict}, ${r.branch}, ${r.confidence}, ${r.askedCount}, ${r.unknownCount},
       ${r.whoReport}, ${r.whoYou}, ${r.whoLab}, ${r.ageBand}, ${r.sex}, ${r.mode}, ${r.engine})
  `;
}

export interface RunListRow {
  id: string; analytes: string[]; verdict: string | null; branch: string | null;
  confidence: string | null; asked_count: number; unknown_count: number;
  age_band: string | null; sex: string | null; mode: string; engine: string; created_at: string;
}

/** ADMIN-ONLY registry list. Never exposed on the operational surface (the wall). */
export async function listConcordanceRuns(limit = 100, offset = 0): Promise<RunListRow[]> {
  const rows = await sql`
    SELECT id, analytes, verdict, branch, confidence, asked_count, unknown_count,
           age_band, sex, mode, engine, created_at
    FROM concordance_runs
    ORDER BY created_at DESC
    LIMIT ${Math.min(limit, 500)} OFFSET ${offset}
  `;
  return rows as RunListRow[];
}

export interface RunAggregates {
  total: number;
  byVerdict: Record<string, number>;
  meanQuestions: number;
  unknownRate: number;
  byAnalyte: Record<string, number>;
}

/** ADMIN-ONLY aggregates for Track-2 calibration (population base rates, interview economy). */
export async function runAggregates(): Promise<RunAggregates> {
  const [tot] = await sql`SELECT COUNT(*)::int AS n, AVG(asked_count)::float AS q,
      AVG(CASE WHEN unknown_count > 0 THEN 1 ELSE 0 END)::float AS ur FROM concordance_runs` as any[];
  const verds = await sql`SELECT verdict, COUNT(*)::int AS n FROM concordance_runs GROUP BY verdict` as any[];
  const anas = await sql`SELECT unnest(analytes) AS a, COUNT(*)::int AS n FROM concordance_runs GROUP BY a` as any[];
  const byVerdict: Record<string, number> = {};
  for (const v of verds) byVerdict[v.verdict ?? 'null'] = v.n;
  const byAnalyte: Record<string, number> = {};
  for (const a of anas) byAnalyte[a.a] = a.n;
  return {
    total: tot?.n ?? 0,
    byVerdict,
    meanQuestions: Math.round(((tot?.q ?? 0) as number) * 10) / 10,
    unknownRate: Math.round(((tot?.ur ?? 0) as number) * 100) / 100,
    byAnalyte,
  };
}
