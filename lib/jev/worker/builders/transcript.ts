/**
 * lib/jev/worker/builders/transcript.ts — `transcript-v1` (PRD §2): `[mm:ss] ROLE: native text` for the text sets (pitch, affect, doubt).
 *
 * Questions are always English; the transcript stays as stored. The reader returns whatever ETA holds for the consult (the English track when there is one, else
 * the window cues); the `[EN: gloss]` suffix is added where the reader supplies a gloss line. NAME-MASKING IS OPTIONAL (V, 10 Oct), so none is done.
 * PRE-GATES, deterministic, before any call: patient-side speech under 3 turns -> `abstain`; over the token budget -> `tooLarge`. The state NEVER carries
 * a clock time, room, date or id: only the relative [mm:ss] label.
 */
import type { ConsultLine, ConsultText } from "@/lib/rubrics/readers/consult-text";
import { STATE_TOKEN_BUDGET, estimateTokens } from "./tokens";
import type { StateBuild } from "../uses";

export const MIN_PATIENT_TURNS = 3;
export const TRANSCRIPT_VERSION = "transcript-v1";

const mmss = (ms: number): string => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
const ROLE: Record<ConsultLine["speaker"], string> = { doctor: "DOCTOR", other: "PATIENT-SIDE", unknown: "UNKNOWN" };

export function formatLines(lines: ReadonlyArray<ConsultLine>): string {
  return lines.map((l) => `[${mmss(l.t_ms)}] ${ROLE[l.speaker]}: ${l.text}`).join("\n");
}

/** `hint` is a SCORING label only (bench): it is not read by any builder. */
export type Focus = { at_ms: number; hint?: string; text?: string };

/** PURE. The state for one consult (whole clip), optionally with a FOCUS marker (a pitch's or doubt's time and, for a doubt, its extracted text). */
export function transcriptState(
  consultKey: string, ct: Pick<ConsultText, "lines" | "source">,
  opts: { focus?: Focus; excerpt?: { before_ms: number; after_ms: number } } = {},
): StateBuild {
  let lines = ct.lines;
  if (opts.excerpt && opts.focus) {
    const from = opts.focus.at_ms - opts.excerpt.before_ms, to = opts.focus.at_ms + opts.excerpt.after_ms;
    lines = lines.filter((l) => l.t_ms >= from && l.t_ms <= to);
  }
  const patientTurns = lines.filter((l) => l.speaker === "other").length;
  if (patientTurns < MIN_PATIENT_TURNS) return { abstain: "patient_side_speech_lt_3_turns" };
  const transcript = formatLines(lines);
  const state: Record<string, unknown> = { transcript };
  // The FOCUS names a time (and, for a doubt, the extracted doubt text). It NEVER names the suggestion's type: `hint` is the operator's label for scoring and must not reach
  // Jev, or pitch_type's accuracy is circular (V's refuter, F2).
  if (opts.focus) state.focus = { near: mmss(opts.focus.at_ms), ...(opts.focus.text ? { doubt_text: opts.focus.text } : {}) };
  const tokens = estimateTokens(JSON.stringify(state));
  if (tokens > STATE_TOKEN_BUDGET) return { tooLarge: true, bytes: JSON.stringify(state).length };
  return {
    state, lane: "text",
    evidence: { consult_key: consultKey, transcript_source: ct.source, lines: lines.length, patient_turns: patientTurns, est_tokens: tokens, transcript_version: TRANSCRIPT_VERSION, ...(opts.focus ? { focus_at_s: Math.round(opts.focus.at_ms / 1000) } : {}) },
  };
}
