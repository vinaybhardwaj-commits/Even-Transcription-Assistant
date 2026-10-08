/**
 * Engine room_mic_quality — S7-0. PURE: one room-hour's audio state -> minutes recorded vs expected, muted / off / dead minutes, speech minutes, zero ratio, peak headroom, flags.
 * The definitions are the ones in rubrics/room_mic_quality/rubric.json (`definition`); a test keeps the flag thresholds in step with them.
 */
import type { AudioHour } from "../readers/audio-state";
import type { EngineResult } from "./types";

const RECORDED = new Set(["audio_present", "audio_gated", "room_quiet", "speech", "consult"]);
const OFF = new Set(["recorder_off", "device_missing"]);
const DEAD = new Set(["device_dead", "zero_all_day"]);
export const MIC_FLAGS = { low_recording_ratio: 0.8, muted_min: 5, dead_min: 5, off_min: 5, no_speech_recorded_min: 30, clipping_headroom: 0.05, zero_heavy_ratio: 0.98 } as const;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export function evaluateRoomMicQuality(h: AudioHour): EngineResult {
  const expected = 60;
  const minutes: Record<string, number> = {};
  let covered = 0;
  for (const iv of h.intervals) {
    const ms = Math.min(iv.end_ms, h.window_end_ms) - Math.max(iv.start_ms, h.window_start_ms);
    if (ms <= 0) continue;
    minutes[iv.state] = (minutes[iv.state] ?? 0) + ms / 60_000;
    covered += ms / 60_000;
  }
  const sum = (set: Set<string>): number => Math.min(expected, [...set].reduce((n, k) => n + (minutes[k] ?? 0), 0));
  const recorded = sum(RECORDED);
  const muted = Math.min(expected, minutes["muted"] ?? 0);
  const off = sum(OFF);
  const dead = sum(DEAD);
  const withheld = Math.min(expected, minutes["withheld"] ?? 0);
  const speech = Math.min(expected, (minutes["speech"] ?? 0) + (minutes["consult"] ?? 0));
  const zero = h.samples.zero_ratio_mean;
  const headroom = h.samples.peak_max === null ? null : r3(Math.max(0, 1 - h.samples.peak_max));
  const ratio = recorded / expected;
  const flags: string[] = [];
  if (ratio < MIC_FLAGS.low_recording_ratio) flags.push("low_recording");
  if (muted >= MIC_FLAGS.muted_min) flags.push("muted");
  if (dead >= MIC_FLAGS.dead_min) flags.push("dead");
  if (off >= MIC_FLAGS.off_min) flags.push("off");
  if (recorded >= MIC_FLAGS.no_speech_recorded_min && speech === 0) flags.push("no_speech");
  if (headroom !== null && headroom < MIC_FLAGS.clipping_headroom) flags.push("clipping");
  if (zero !== null && zero >= MIC_FLAGS.zero_heavy_ratio) flags.push("zero_heavy");
  return {
    status: "ok",
    score: {
      expected_min: expected, recorded_min: r3(recorded), recorded_ratio: r3(ratio), muted_min: r3(muted), off_min: r3(off), dead_min: r3(dead), withheld_min: r3(withheld), speech_min: r3(speech),
      zero_ratio: zero === null ? null : r3(zero), peak_headroom: headroom, samples: h.samples.n, flags,
    },
    findings: flags,
    evidence: { covered_min: r3(covered), minutes_by_state: Object.fromEntries(Object.entries(minutes).map(([k, v]) => [k, r3(v)])), day_rollup: h.day },
  };
}
