/**
 * lib/jev/worker/coverage.ts — JEV-EVERY-CONSULT S1: today's (IST) consult coverage, counts only, no ids. Read-only; nothing here acts on a decision.
 * cut = distinct consult_uid with a closed window today; transcribed = of those, passes the SAME transcript test as allTranscribedConsults (Addendum 1+2);
 * jev_done[set] = of the transcribed consults, those with a SHADOW decision under that set's current sha (live set else newest shadow, as the sweeper picks it);
 * clef_done = distinct consult_uid in affect_consult_latest (migration 0155) with ist_date today.
 */
import { sql } from "@/lib/db";
import { coverageCutAndTranscribed, coverageJevDone } from "@/lib/room-access/consult-select";
import { CONSULT_SUBJECT_TYPE } from "./consult-eligible";

export const COVERAGE_SETS = ["pitch-detect", "chair-affect"] as const;
export type Coverage = { ist_date: string; cut: number; transcribed: number; jev_done: Record<(typeof COVERAGE_SETS)[number], number>; clef_done: number };
const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

export async function consultCoverage(): Promise<Coverage> {
  const istDate = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const { cut, transcribed } = await coverageCutAndTranscribed(istDate);
  const clef = (await sql`SELECT count(DISTINCT consult_uid)::int AS c FROM affect_consult_latest WHERE ist_date = ${istDate}::date`) as Array<{ c: unknown }>;
  const jev_done = { "pitch-detect": 0, "chair-affect": 0 } as Coverage["jev_done"];
  for (const setId of COVERAGE_SETS) {
    const cur = (await sql`SELECT content_sha256 AS sha FROM jev_question_set WHERE id = ${setId} AND status IN ('live', 'shadow') ORDER BY (status = 'live') DESC, created_at DESC LIMIT 1`) as Array<{ sha: string }>;
    jev_done[setId] = cur[0] ? await coverageJevDone(cur[0].sha, CONSULT_SUBJECT_TYPE, istDate) : 0;
  }
  return { ist_date: istDate, cut, transcribed, jev_done, clef_done: n(clef[0]?.c) };
}
