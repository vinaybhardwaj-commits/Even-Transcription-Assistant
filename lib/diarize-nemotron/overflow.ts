/**
 * lib/diarize-nemotron/overflow.ts — PURE: the HF overflow gate for /api/diarize/nemotron/pending (epic #23, HF overflow).
 *
 * An overflow worker (NEMOTRON_MACHINE=hf) is offered windows only when BOTH hold:
 *   1. the daily cost cap is above zero (NEMO_HF_DAILY_USD_CAP, default 0 = overflow OFF) and not yet spent, and
 *   2. the production backlog (eligible, unclaimed windows) EXCEEDS NEMO_HF_BACKLOG_THRESHOLD (default 40 windows).
 * The box worker is never gated here. Every env value is parsed strictly: a typo THROWS (a 500 `bad_flag`), it is never read as 0.
 *
 * Cost is an ESTIMATE from recorded audio minutes: spent_usd = hf_minutes * NEMO_HF_USD_PER_AUDIO_MIN. The default rate is
 * deliberately high (a10g at ~$1.00/h billed as if real time) because HF measured ~12-16 s per audio-hour; the cap is a ceiling, not a bill.
 */
export const NEMO_HF_DAILY_USD_CAP_ENV = "NEMO_HF_DAILY_USD_CAP";
export const NEMO_HF_BACKLOG_THRESHOLD_ENV = "NEMO_HF_BACKLOG_THRESHOLD";
export const NEMO_HF_USD_PER_AUDIO_MIN_ENV = "NEMO_HF_USD_PER_AUDIO_MIN";

export const DEFAULT_BACKLOG_THRESHOLD = 40;
export const DEFAULT_USD_PER_AUDIO_MIN = 1 / 60;
/** A bench window is 15 min of audio; used to project what a claim would add before its rows exist. */
export const WINDOW_AUDIO_MIN = 15;

export class OverflowConfigError extends Error {}

export type OverflowConfig = { capUsd: number; backlogThreshold: number; usdPerMin: number };
export type Machine = "box" | "hf";

function num(env: Record<string, string | undefined>, name: string, dflt: number, integer: boolean): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const v = Number(raw.trim());
  if (!Number.isFinite(v) || v < 0 || (integer && !Number.isInteger(v))) {
    // length only: an env value is not echoed
    throw new OverflowConfigError(`${name} has an unrecognised value (length ${raw.length}); use a non-negative ${integer ? "integer" : "number"}.`);
  }
  return v;
}

export function overflowConfig(env: Record<string, string | undefined> = process.env): OverflowConfig {
  const usdPerMin = num(env, NEMO_HF_USD_PER_AUDIO_MIN_ENV, DEFAULT_USD_PER_AUDIO_MIN, false);
  if (usdPerMin <= 0) throw new OverflowConfigError(`${NEMO_HF_USD_PER_AUDIO_MIN_ENV} must be above zero.`);
  return {
    capUsd: num(env, NEMO_HF_DAILY_USD_CAP_ENV, 0, false),
    backlogThreshold: num(env, NEMO_HF_BACKLOG_THRESHOLD_ENV, DEFAULT_BACKLOG_THRESHOLD, true),
    usdPerMin,
  };
}

/** The machine class a /pending call names. Absent = box (every worker predating this change). Anything else is refused. */
export function parseMachine(raw: string | null): Machine | null {
  if (raw === null || raw === "") return "box";
  return raw === "box" || raw === "hf" ? raw : null;
}

export type OverflowReason = "overflow_off" | "cap_reached" | "below_threshold";
export type OverflowDecision = { allow: true; limit: number } | { allow: false; reason: OverflowReason };

/**
 * `usedMin` = recorded HF audio minutes today (ingested rows) + live unfinished HF claims at WINDOW_AUDIO_MIN each.
 * `backlog` = eligible, unclaimed windows. The returned limit is the requested one, shrunk so the claim cannot take the
 * day's projected spend past the cap (whole windows only; zero room is `cap_reached`) nor the backlog below the threshold.
 */
export function overflowDecision(cfg: OverflowConfig, input: { usedMin: number; backlog: number; limit: number }): OverflowDecision {
  if (cfg.capUsd <= 0) return { allow: false, reason: "overflow_off" };
  const capMin = cfg.capUsd / cfg.usdPerMin;
  const room = Math.floor((capMin - input.usedMin) / WINDOW_AUDIO_MIN);
  if (room < 1) return { allow: false, reason: "cap_reached" };
  if (input.backlog <= cfg.backlogThreshold) return { allow: false, reason: "below_threshold" };
  // never drain the backlog below the threshold: the box owns what is left
  return { allow: true, limit: Math.max(1, Math.min(input.limit, room, input.backlog - cfg.backlogThreshold)) };
}
