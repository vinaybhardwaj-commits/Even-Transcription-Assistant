/**
 * lib/diarize-level-gate.ts — the PRE-CALL cost guard: don't pay to diarize a silent window.
 *
 * INDEPENDENT OF `DIARIZE_SPEECH_GATE`, as ruled on 23 Sep. It can be, because it asks a table and
 * not a service: `bench_level_sample` already holds a level reading every few seconds for every
 * room, so deciding whether a window held any sound costs one query, no audio, no VAD, and no
 * second flag to be left in the wrong position.
 *
 * ─── THE ORDER'S PREMISE WAS WRONG, AND THIS IS THE HONEST VERSION ─────────────────────────────
 * The switch order asked for "the same test the local path uses". There is no such test: the local
 * path has no pre-call silence check at all. Its only silence signals are the diarizer's own
 * post-hoc `no_speakers`, and the VAD speech gate, which runs AFTER diarization and only when its
 * flag is on. So this is a new rule, and it is written to be the narrowest one that can be
 * defended rather than the one that saves the most money.
 *
 * ─── THREE RULES, ALL OF WHICH EXIST TO AVOID CONVICTING AN INNOCENT WINDOW ────────────────────
 *
 *  1. NO COVERAGE, NO VERDICT. A window the level log does not cover is `unknown`, never `silent`.
 *     The log began mid-evening on 22 Sep and a room can go unlogged for any number of reasons;
 *     "we have no readings" and "we have readings and they are flat" are different claims and only
 *     the second one may stop a paid call. This is the same rule the encounter clock's gate makes
 *     about missing evidence, and the same one the VAD gate makes about an empty answer.
 *
 *  2. THE BASIS IS RECORDED, BECAUSE IT VARIES. `peak` is present on every row; `avg` is not — it
 *     was on 81.2% of 23 Sep's rows and 0% of 22 Sep's. A gate that silently used whichever it
 *     found would produce two different tests under one name, which is how `avg` came to replace
 *     `peak` unnoticed in the first place. This one reads PEAK ONLY — the column that is always
 *     there — and says so in its verdict.
 *
 *  3. THE FLOOR IS REUSED, NOT INVENTED. `DEFAULT_ROOM_ENERGY_FLOOR` is the room recorder's own
 *     -48 dBFS VAD floor converted to amplitude, already used by the window measurement and the
 *     encounter clock. A third threshold with its own opinion is how two parts of this system come
 *     to disagree about what silence is.
 */
import { readRoomLevelDay, type BenchLevelSample } from "@/lib/bench-levels";
import { DEFAULT_ROOM_ENERGY_FLOOR } from "@/lib/stt/window-measure";

/** The fraction of a window the level log must cover before it is allowed to convict. */
export const LEVEL_GATE_MIN_COVERAGE = 0.8;

/** How much of a window may sit above the floor and still count as silence: none of it. */
export const LEVEL_GATE_ACTIVE_MAX = 0;

export type LevelGateVerdict = {
  /** `silent` is the only verdict that may stop a paid call. */
  verdict: "silent" | "has_sound" | "unknown";
  /** Why, as a code. */
  reason: "no_samples" | "thin_coverage" | "peak_above_floor" | "peak_below_floor";
  /** Always "peak" in this build — recorded so a stored row never has to assume. */
  basis: "peak";
  samples: number;
  /** Samples whose peak cleared the floor. */
  active: number;
  coverage: number;
  floor: number;
};

/**
 * PURE — judge one window from level samples already in hand.
 *
 * `samples` are the 15-second buckets `readRoomLevelDay` returns; `expected` is how many such
 * buckets the window SHOULD have if the log covered it fully. Coverage is measured against that,
 * not against the number of rows found, because "we found three rows and all three were quiet" is
 * exactly the shape this must refuse to convict on.
 */
export function judgeLevels(
  samples: readonly BenchLevelSample[],
  window: { start_ms: number; end_ms: number },
  opts: { floor?: number; bucketSeconds?: number; minCoverage?: number } = {},
): LevelGateVerdict {
  const floor = opts.floor ?? DEFAULT_ROOM_ENERGY_FLOOR;
  const bucketMs = (opts.bucketSeconds ?? 15) * 1000;
  const minCoverage = opts.minCoverage ?? LEVEL_GATE_MIN_COVERAGE;
  const inside = samples.filter((s) => s.t_ms >= window.start_ms && s.t_ms < window.end_ms);
  const expected = Math.max(1, Math.floor((window.end_ms - window.start_ms) / bucketMs));
  const coverage = Math.min(1, inside.length / expected);
  const base = { basis: "peak" as const, samples: inside.length, coverage, floor };

  if (inside.length === 0) {
    return { verdict: "unknown", reason: "no_samples", active: 0, ...base };
  }
  // Counted before the coverage test so the verdict always reports what was actually seen.
  const active = inside.filter((s) => Number.isFinite(s.peak) && s.peak >= floor).length;
  if (active > LEVEL_GATE_ACTIVE_MAX) {
    // Sound anywhere in the window settles it, whatever the coverage: one loud bucket is positive
    // evidence, and positive evidence needs no quorum.
    return { verdict: "has_sound", reason: "peak_above_floor", active, ...base };
  }
  if (coverage < minCoverage) {
    return { verdict: "unknown", reason: "thin_coverage", active, ...base };
  }
  return { verdict: "silent", reason: "peak_below_floor", active, ...base };
}

/**
 * Read the level log for a window's room-day and judge it.
 *
 * Reuses `readRoomLevelDay`, the one aggregator over `bench_level_sample`, rather than adding a
 * second query with its own bucketing — two aggregators over one table is how two callers come to
 * disagree about what the table says.
 */
export async function levelGateForWindow(input: {
  roomId: string;
  istDate: string;
  window: { start_ms: number; end_ms: number };
  floor?: number;
}): Promise<LevelGateVerdict> {
  const { samples } = await readRoomLevelDay(input.roomId, input.istDate);
  return judgeLevels(samples, input.window, { floor: input.floor });
}
