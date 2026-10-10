/**
 * lib/jev/worker/flags.ts — every switch of the Jev worker, in one place (PRD §7). ALL default OFF.
 *
 * No Jev call is made from the worker unless:  JEV_WORKER_ENABLED  AND  (the mode's own gate)  AND  ETA_JEV_ENABLED (the client's
 * own master switch, checked again there before any fetch).
 *   bench  — JEV_WORKER_ENABLED, plus ETA_JEV_TEXT_LANE for a set that sends text
 *   shadow — the above + the use's flag (JEV_USE_*)
 *   live   — the above + the use's JEV_*_LIVE, and a set whose status is `live`
 * `parseFlag` THROWS on an unrecognised value, so a typo is a refusal and never "off".
 */
import { parseFlag } from "@/lib/flags";
import type { QuestionSetUse } from "./sets";

export type RealUse = Exclude<QuestionSetUse, "legacy">;
export const REAL_USES: readonly RealUse[] = ["encounter_timeline", "stt_quality", "stt_pick", "consult_rubric"];
export type JevMode = "bench" | "shadow" | "live";

export const USE_FLAG: Record<RealUse, string> = {
  encounter_timeline: "JEV_USE_ENCOUNTER_TIMELINE",
  stt_quality: "JEV_USE_STT_QUALITY",
  stt_pick: "JEV_USE_STT_QUALITY",
  consult_rubric: "JEV_USE_CONSULT_RUBRIC",
};
export const USE_LIVE_FLAG: Record<RealUse, string> = {
  encounter_timeline: "JEV_ENCOUNTER_TIMELINE_LIVE",
  stt_quality: "JEV_STT_QUALITY_LIVE",
  stt_pick: "JEV_STT_PICK_LIVE",
  consult_rubric: "JEV_CONSULT_RUBRIC_LIVE",
};
/** The pre-STT timeline lane sends no text by design; the others send transcript text, behind the lane switch. */
export const USE_SENDS_TEXT: Record<RealUse, boolean> = { encounter_timeline: false, stt_quality: true, stt_pick: true, consult_rubric: true };

export const workerEnabled = (): boolean => parseFlag("JEV_WORKER_ENABLED");
export const useFlagOn = (use: RealUse): boolean => parseFlag(USE_FLAG[use]);
export const liveFlagOn = (use: RealUse): boolean => parseFlag(USE_LIVE_FLAG[use]);
export const textLaneOn = (): boolean => parseFlag("ETA_JEV_TEXT_LANE");

export type GateVerdict = { ok: true } | { ok: false; reason: "worker_disabled" | "use_flag_off" | "text_lane_off" | "live_flag_off" };

/** May this use run in this mode at all, by flags alone? (Set status is checked separately, in the plan step.) */
export function modeGate(use: RealUse, mode: JevMode): GateVerdict {
  if (!workerEnabled()) return { ok: false, reason: "worker_disabled" };
  if (USE_SENDS_TEXT[use] && !textLaneOn()) return { ok: false, reason: "text_lane_off" };
  if (mode === "bench") return { ok: true };
  if (!useFlagOn(use)) return { ok: false, reason: "use_flag_off" };
  if (mode === "live" && !liveFlagOn(use)) return { ok: false, reason: "live_flag_off" };
  return { ok: true };
}

export function anyLiveFlagOn(): boolean {
  return (Object.values(USE_LIVE_FLAG) as string[]).some((f) => parseFlag(f));
}

/** JEV_MOCK_FALLBACK is for bench and dev only: forbidden when any JEV_*_LIVE is on (asserted wherever the worker starts a step). */
export function assertMockFallbackSane(): void {
  if (parseFlag("JEV_MOCK_FALLBACK") && anyLiveFlagOn()) throw new Error("JEV_MOCK_FALLBACK is forbidden while any JEV_*_LIVE flag is on");
}

export const dailyCapUsd = (): number => numEnv("JEV_DAILY_USD_CAP", 5);
export const dailySoftUsd = (): number => numEnv("JEV_DAILY_USD_SOFT", 2);
export const askBatch = (): number => Math.max(1, Math.min(200, Math.trunc(numEnv("JEV_ASK_BATCH", 50))));
function numEnv(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}
