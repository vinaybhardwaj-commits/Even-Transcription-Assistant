/**
 * lib/jev/clinical-route.ts — U6 clinical-or-not routing, SHADOW (order JEV-U6-ROUTE, PLAN-v3 §A).
 *
 * REUSES the already-trialled U6 question (lib/jev/prompts/encounter-v1.ts, prompt_version
 * "u6-kind-v2") and its exact state shape (windowState, lib/encounter-clock/fusion-state.ts) —
 * this is the SAME question E-6's shadow-v2 already asks, just at a DIFFERENT granularity and for
 * a different subject_type. E-6 asks it per 60 s PROBE (subject_type='probe', its own encounter-
 * boundary purpose); this asks it per bench_window (subject_type='window', arm-d's J0 granularity,
 * PLAN-v3 §A's transcript-hygiene/backlog-drain purpose — "once a window has any transcript,
 * clinical windows drain first"). Same question, same wording, two independent shadow uses; no
 * code here duplicates E-6's fusion logic and no code there is touched.
 *
 * NOTHING EXCLUDED FROM NOTES YET (order, verbatim): this is a read + classify + log module. It
 * never drops, reorders, or hides a window from anything that currently reads bench_window or
 * jev_window_text. Behind JEV_CLINICAL_ROUTE (parseFlag, default off), checked before any DB read.
 */
import { parseFlag } from "@/lib/flags";
import { sql } from "@/lib/db";
import { askJev } from "./ask";
import { registerEncounterQuestions, U6_OPTIONS, U6_PROMPT_VERSION, U6_QUESTION_ID, type U6Option } from "./prompts/encounter-v1";
import { windowState } from "@/lib/encounter-clock/fusion-state";

export const CLINICAL_ROUTE_FLAG = "JEV_CLINICAL_ROUTE";

type WindowTextRow = { id: string; english: string | null };

export type ClinicalRouteOutcome = {
  ran: boolean;
  windowsTotal: number;
  windowsAsked: number;
  /** Counts only — never which window said what, never any text. */
  byCategory: Record<U6Option, number>;
};

function emptyCategoryCounts(): Record<U6Option, number> {
  return Object.fromEntries(U6_OPTIONS.map((o) => [o, 0])) as Record<U6Option, number>;
}

/**
 * The awaited half. Every window in the room-day with English text (jev_window_text, J0) gets its
 * OWN systemOne call — one call per window, not batched, matching shadow-v2's own per-probe
 * pattern for this exact question (U6 needs no cross-window context, unlike U2's boundary state).
 * Sequential by design for v1: this is a shadow feature behind a default-off flag, not a
 * throughput-critical path; a concurrency pool can be added later without changing the contract.
 */
export async function runClinicalRouteAsync(roomDayId: string): Promise<ClinicalRouteOutcome> {
  if (!parseFlag(CLINICAL_ROUTE_FLAG)) return { ran: false, windowsTotal: 0, windowsAsked: 0, byCategory: emptyCategoryCounts() };

  registerEncounterQuestions();

  const rows = (await sql`
    SELECT w.id, t.english
    FROM bench_window w
    LEFT JOIN jev_window_text t ON t.window_id = w.id
    WHERE w.room_day_id = ${roomDayId}
    ORDER BY w.start_ms
  `) as WindowTextRow[];

  const byCategory = emptyCategoryCounts();
  let windowsAsked = 0;
  for (const row of rows) {
    if (!row.english) continue; // no English text yet (J0 not_ready/empty/failed) — nothing to classify
    const outcome = await askJev(windowState(row.english), [
      { answerKey: "kind", subjectType: "window", subjectId: row.id, questionId: U6_QUESTION_ID, promptVersion: U6_PROMPT_VERSION },
    ]);
    windowsAsked += 1;
    const kind = outcome.results.kind;
    if (kind && kind.answer.type === "choice" && (U6_OPTIONS as readonly string[]).includes(kind.answer.choice)) {
      byCategory[kind.answer.choice as U6Option] += 1;
    }
  }

  return { ran: true, windowsTotal: rows.length, windowsAsked, byCategory };
}
