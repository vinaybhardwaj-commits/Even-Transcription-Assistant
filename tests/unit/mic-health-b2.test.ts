/**
 * BUILD 2 — the room and the tape.
 *
 * THE RULE THAT GOVERNS ALL OF IT: the archive always wins. A monitor that lies is survivable; a
 * recording that did not happen is not. So most of these tests are about what the new rules
 * REFUSE to do — refuse to move audio off a working microphone, refuse to call a quiet room
 * broken, refuse to convict a microphone on a flag, and refuse to throw away the only copy of a
 * conversation to satisfy a word.
 *
 * Four alarms have fired on healthy behaviour so far. Every rule below is checked against an
 * ordinary day as well as a broken one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BASELINE_PIECES,
  DEVICE_GONE_REASONS,
  HEARD_SOUND_RMS,
  TINY_FRACTION,
  TINY_RUN_TO_DIE,
  decideBinding,
  deviceReportedGone,
  heardSound,
  learnBaseline,
  micHealth,
  rateOf,
  type MicPiece,
} from "@/lib/mic-health";
import {
  LevelAccumulator,
  SILENCE_TRIP_SAMPLES,
  SilenceWatchdog,
  uploadBodies,
} from "@/lib/bench-dual";
import { POLL_IDLE_MS, LISTENER_FRESH_MS, POLL_VISIBLE_MS } from "@/lib/bench-bus-constants";
import { cleanLevels } from "@/lib/bench-commands";
import { finiteNumberOrNull, parseMicLevelPair } from "@/lib/bench-levels";

const code = (...parts: string[]) =>
  readFileSync(join(process.cwd(), ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

// The rigs, measured on 24 August. Per five minutes: Home Office 4.83 MB, both clinic rigs
// 8.2 MB, and the Home Office spare 70 KB — 68 to 1 against a working microphone.
const FIVE_MIN = 300_000;
const HOME_OFFICE = 4_830_000;
const CLINIC = 8_200_000;
const DEAD_SPARE = 70_000;

const piece = (over: Partial<MicPiece> & { idx: number }): MicPiece => ({
  source: "primary",
  duration_ms: FIVE_MIN,
  size_bytes: HOME_OFFICE,
  peak_level: 0.08,
  avg_level: 0.03,
  ...over,
});

/** A run of ordinary pieces from one rig — what every healthy day looks like. */
const healthyRun = (n: number, bytes = HOME_OFFICE, over: Partial<MicPiece> = {}): MicPiece[] =>
  Array.from({ length: n }, (_, i) => piece({ idx: i, size_bytes: bytes, ...over }));

// ===========================================================================
// §2.3 — size, judged against the room's own recent work
// ===========================================================================

describe("§2.3 — a microphone is judged against ITS OWN recent pieces, never a fixed floor", () => {
  it("THE SPREAD BETWEEN TWO HEALTHY RIGS MUST NOT TRIP ANYTHING", () => {
    // 4.83 MB and 8.2 MB per five minutes are both healthy. An absolute floor is wrong on at
    // least one of them in each direction, which is the whole reason the baseline is learned.
    for (const bytes of [HOME_OFFICE, CLINIC]) {
      const h = micHealth(healthyRun(6, bytes));
      expect(h.newest).toBe("ok");
      expect(h.tiny_run).toBe(0);
      expect(h.proven_dead_by_size).toBe(false);
    }
    // and the ratio between them is nowhere near the tiny threshold
    expect(HOME_OFFICE / CLINIC).toBeGreaterThan(TINY_FRACTION * 3);
  });

  it("the 68-to-1 failure IS caught — that is the Home Office spare", () => {
    const pieces = [...healthyRun(6), piece({ idx: 6, size_bytes: DEAD_SPARE })];
    const h = micHealth(pieces);
    expect(h.newest).toBe("tiny");
    expect(h.tiny_run).toBe(1);
  });

  it("A RATE, not a size — a short piece is not a small one", () => {
    // Half the length at half the bytes is the same microphone working normally. Judged on size
    // alone, every rotation's last piece would look broken.
    const pieces = [...healthyRun(6), piece({ idx: 6, duration_ms: FIVE_MIN / 2, size_bytes: HOME_OFFICE / 2 })];
    // it is not full-length, so it is not judged at all — and even if it were, the rate matches
    expect(rateOf(pieces[6]!)).toBeCloseTo(rateOf(pieces[0]!)!, 6);
  });

  it("the flush piece is EXEMPT — 27 KB at the end of an ordinary day is not a fault", () => {
    const pieces = [...healthyRun(6), piece({ idx: 6, duration_ms: 4_000, size_bytes: 27_000 })];
    const h = micHealth(pieces, { lastIdxOfSession: 6 });
    expect(h.newest).toBe("ok");
    expect(h.tiny_run).toBe(0);
  });

  it("the baseline is a MEDIAN, so one bad piece cannot drag it down onto the next", () => {
    const pieces = [...healthyRun(10), piece({ idx: 10, size_bytes: DEAD_SPARE })];
    const { rate } = learnBaseline(pieces);
    expect(rate).toBeCloseTo(HOME_OFFICE / FIVE_MIN, 6);
    expect(BASELINE_PIECES).toBeGreaterThan(TINY_RUN_TO_DIE * 2);
  });

  it("too few pieces to learn from reads UNKNOWN, never ok and never tiny", () => {
    expect(micHealth([]).newest).toBe("unknown");
    expect(micHealth([]).baseline_bytes_per_ms).toBeNull();
    // pieces with no byte counts at all cannot be judged either
    expect(micHealth(healthyRun(6, HOME_OFFICE).map((p) => ({ ...p, size_bytes: null }))).newest).toBe("unknown");
  });
});

// ===========================================================================
// D36 — the meter is what stops the size rule crying wolf
// ===========================================================================

describe("D36 — a piece is faulty on size ONLY when the meter heard sound during it", () => {
  it("A QUIET AFTERNOON IS NOT A BROKEN MICROPHONE", () => {
    // Two consecutive tiny full-length pieces — the D37 shape exactly — but the meter says the
    // room was silent throughout. Without this guard, every quiet stretch in every room raises
    // the fifth false alarm of this project.
    const quiet = { peak_level: 0.0004, avg_level: 0.0001 };
    const pieces = [
      ...healthyRun(6),
      piece({ idx: 6, size_bytes: DEAD_SPARE, ...quiet }),
      piece({ idx: 7, size_bytes: DEAD_SPARE, ...quiet }),
    ];
    const h = micHealth(pieces);
    expect(h.tiny_run).toBe(2);          // the pieces ARE small
    expect(h.proven_dead_by_size).toBe(false); // and the microphone is NOT convicted
  });

  it("the same two pieces WITH sound in them do convict it", () => {
    const loud = { peak_level: 0.09, avg_level: 0.04 };
    const pieces = [
      ...healthyRun(6),
      piece({ idx: 6, size_bytes: DEAD_SPARE, ...loud }),
      piece({ idx: 7, size_bytes: DEAD_SPARE, ...loud }),
    ];
    expect(micHealth(pieces).proven_dead_by_size).toBe(true);
  });

  it("ONE tiny piece is never enough, however loud the room was", () => {
    const pieces = [...healthyRun(6), piece({ idx: 6, size_bytes: DEAD_SPARE, peak_level: 0.09 })];
    expect(micHealth(pieces).proven_dead_by_size).toBe(false);
    expect(TINY_RUN_TO_DIE).toBe(2);
  });

  it("A PIECE WITH NO LEVEL AT ALL CANNOT CONVICT — absence of evidence is not evidence", () => {
    // Every piece recorded before this build carries no level. A kiosk that never sends them can
    // therefore never trip the rule, which is the only safe default.
    const none = { peak_level: null, avg_level: null };
    const pieces = [
      ...healthyRun(6),
      piece({ idx: 6, size_bytes: DEAD_SPARE, ...none }),
      piece({ idx: 7, size_bytes: DEAD_SPARE, ...none }),
    ];
    expect(heardSound(pieces[6]!)).toBeNull();
    expect(micHealth(pieces).proven_dead_by_size).toBe(false);
  });

  it("heardSound is three-valued and its threshold is digital-zero territory", () => {
    expect(heardSound(piece({ idx: 0, peak_level: 0.5, avg_level: 0.2 }))).toBe(true);
    expect(heardSound(piece({ idx: 0, peak_level: 0, avg_level: 0 }))).toBe(false);
    expect(heardSound(piece({ idx: 0, peak_level: null, avg_level: null }))).toBeNull();
    expect(HEARD_SOUND_RMS).toBeLessThan(0.01); // room noise on a live mic is far above this
  });
});

// ===========================================================================
// §2.4 — the binding rule. The worst thing found on 24 August.
// ===========================================================================

describe("§2.4 — every window binds to the main microphone unless the main is PROVEN dead", () => {
  const spare = (n: number, bytes = HOME_OFFICE) =>
    Array.from({ length: n }, (_, i) => piece({ idx: i, source: "backup", size_bytes: bytes }));

  it("THE CARDIOLOGY CASE: a false silence flag moves nothing", () => {
    // 12:25, a false "main microphone lost". The old rule bound every remaining window of the day
    // to the spare — sixteen of twenty — while the main microphone recorded perfectly throughout.
    const d = decideBinding({
      mainPieces: healthyRun(20),
      sparePieces: spare(20),
      deviceReportedGone: false, // a SILENCE trip is not a device report, and D37 excludes it
    });
    expect(d.source).toBe("primary");
    expect(d.reason).toBe("default_main");
    expect(d.main_proven_dead).toBe(false);
  });

  it("THE SILENCE WATCHDOG IS NOT AN INPUT AT ALL (D37)", () => {
    // The reason recorded on the loss event is what decides, and `silence` is deliberately not in
    // the set. Two false trips in one morning is what earned it that exclusion.
    expect(DEVICE_GONE_REASONS.has("silence")).toBe(false);
    expect(deviceReportedGone([{ kind: "mic_primary_lost", payload: { reason: "silence" } }])).toBe(false);
    expect(deviceReportedGone([{ kind: "mic_primary_lost", payload: { reason: "track_ended" } }])).toBe(true);
    expect(deviceReportedGone([{ kind: "mic_primary_lost", payload: { reason: "silence_device_missing" } }])).toBe(true);
    // an event with no reason at all convicts nothing
    expect(deviceReportedGone([{ kind: "mic_primary_lost" }])).toBe(false);
  });

  it("a device REPORTED GONE plus a healthy spare is the only way audio moves", () => {
    const d = decideBinding({ mainPieces: healthyRun(6), sparePieces: spare(6), deviceReportedGone: true });
    expect(d.source).toBe("backup");
    expect(d.reason).toBe("main_dead_spare_healthy");
    expect(d.spare_proven_healthy).toBe(true);
  });

  it("A DEAD SPARE IS REFUSED: the audio stays on the main and the reason says why", () => {
    // The Home Office spare wrote 70 KB against 4.8 MB for the same five minutes. Handing four
    // hours of consultation to that is the failure this rule exists to prevent.
    const d = decideBinding({
      mainPieces: healthyRun(6),
      sparePieces: spare(6, DEAD_SPARE),
      deviceReportedGone: true,
    });
    expect(d.source).toBe("primary");
    expect(d.reason).toBe("main_dead_no_healthy_spare");
    expect(d.spare_proven_healthy).toBe(false);
  });

  it("D32 — A ONE-MICROPHONE RIG HAS NO SPARE LANE, and that is not a fault", () => {
    const d = decideBinding({ mainPieces: healthyRun(6), sparePieces: [], deviceReportedGone: false });
    expect(d.source).toBe("primary");
    expect(d.reason).toBe("no_spare_lane");
    expect(d.spare_exists).toBe(false);
    // and with the main dead there is still nothing to move to — it says so rather than inventing one
    const dead = decideBinding({ mainPieces: healthyRun(6), sparePieces: [], deviceReportedGone: true });
    expect(dead.source).toBe("primary");
    expect(dead.reason).toBe("main_dead_no_healthy_spare");
    expect(dead.spare_exists).toBe(false);
  });

  it("size can convict the main on its own — two tiny pieces the meter heard through", () => {
    const loud = { peak_level: 0.09, avg_level: 0.04 };
    const dying = [...healthyRun(6), piece({ idx: 6, size_bytes: DEAD_SPARE, ...loud }), piece({ idx: 7, size_bytes: DEAD_SPARE, ...loud })];
    const d = decideBinding({ mainPieces: dying, sparePieces: spare(8), deviceReportedGone: false });
    expect(d.main_proven_dead).toBe(true);
    expect(d.source).toBe("backup");
  });

  it("…but not when the room was merely quiet", () => {
    const quiet = { peak_level: 0.0004, avg_level: 0.0001 };
    const small = [...healthyRun(6), piece({ idx: 6, size_bytes: DEAD_SPARE, ...quiet }), piece({ idx: 7, size_bytes: DEAD_SPARE, ...quiet })];
    const d = decideBinding({ mainPieces: small, sparePieces: spare(8), deviceReportedGone: false });
    expect(d.main_proven_dead).toBe(false);
    expect(d.source).toBe("primary");
  });

  it("an UNMEASURABLE spare is used once the main is dead, and the reason says it is unproven", () => {
    // The archive wins. Refusing a spare we merely cannot measure would leave the audio on a
    // microphone already proven dead and discard the only recording of those minutes.
    const legacy = spare(6).map((p) => ({ ...p, size_bytes: null, peak_level: null, avg_level: null }));
    const d = decideBinding({ mainPieces: healthyRun(6), sparePieces: legacy, deviceReportedGone: true });
    expect(d.source).toBe("backup");
    expect(d.reason).toBe("main_dead_spare_unmeasured");
    expect(d.spare_proven_healthy).toBe(false);
  });
});

// ===========================================================================
// §2.3 — the watchdog counts samples, not wall clock
// ===========================================================================

describe("§2.3 — the watchdog requires consecutive evidence", () => {
  it("sixty seconds of NOT LOOKING is not sixty seconds of silence", () => {
    const wd = new SilenceWatchdog();
    expect(wd.feed(0, 0)).toBeNull();
    expect(wd.feed(0, 60_000)).toBeNull(); // one sample, a minute later — a skipped run
    expect(wd.run).toBe(0);
  });

  it("sixty consecutive real samples still trip it — the threshold did not move", () => {
    const wd = new SilenceWatchdog();
    let ev = null;
    for (let i = 0; i < SILENCE_TRIP_SAMPLES; i++) ev = wd.feed(0, i * 1_000);
    expect(ev).toBe("trip");
  });
});

// ===========================================================================
// §2.2 — the levels, and the poll that carries them
// ===========================================================================

describe("§2.2 — peak and average over an interval, never one instantaneous sample", () => {
  it("an eleven-millisecond sample reads zero between two words; the interval does not", () => {
    const acc = new LevelAccumulator();
    // speech with gaps in it, as every real interval has
    for (const v of [0.12, 0, 0, 0.09, 0, 0.15, 0]) acc.add(v);
    const out = acc.take()!;
    expect(out.peak).toBeCloseTo(0.15, 6);
    expect(out.avg).toBeGreaterThan(0);
    expect(out.avg).toBeLessThan(out.peak);
    expect(out.zero_ratio).toBeCloseTo(4 / 7, 6);
  });

  it("TAKE RESETS, so consecutive polls describe consecutive spans and never overlap", () => {
    const acc = new LevelAccumulator();
    acc.add(0.5);
    expect(acc.take()!.peak).toBeCloseTo(0.5, 6);
    expect(acc.take()).toBeNull();
  });

  it("AN UNMEASURED INTERVAL IS NULL, NEVER ZERO — a rig with one microphone stays silent about a spare", () => {
    expect(new LevelAccumulator().take()).toBeNull();
    // and a zero is a real measurement, which is a different fact
    const acc = new LevelAccumulator();
    acc.add(0);
    expect(acc.take()).toEqual({ peak: 0, avg: 0, zero_ratio: 1 });
  });

  it("nonsense readings are ignored rather than counted as silence", () => {
    const acc = new LevelAccumulator();
    acc.add(Number.NaN);
    acc.add(-1);
    expect(acc.take()).toBeNull();
  });

  it("cleanLevels DROPS out-of-range values rather than clamping them", () => {
    // A clamped value is indistinguishable from a real one and would put a number on a clinical
    // screen that no microphone produced. Dropping it leaves the column NULL, which reads as
    // "not measured".
    expect(cleanLevels({ peak: 0.4, avg: 0.1 })).toEqual({ peak: 0.4, avg: 0.1 });
    expect(cleanLevels({ peak: 4, avg: 0.1 })).toBeNull();
    expect(cleanLevels({ peak: -1, avg: 0.1 })).toBeNull();
    expect(cleanLevels({ peak: Number.NaN, avg: 0.1 })).toBeNull();
    expect(cleanLevels(null)).toBeNull();
    expect(cleanLevels({})).toBeNull();
  });

  it("preserves genuine zero but never coerces absence or an empty value into silence", () => {
    expect(parseMicLevelPair(0, 0)).toEqual({ peak: 0, avg: 0 });
    expect(parseMicLevelPair("0", "0.0000")).toEqual({ peak: 0, avg: 0 });
    for (const absent of [null, undefined, "", "   ", false]) {
      expect(parseMicLevelPair(absent, 0)).toBeNull();
      expect(parseMicLevelPair(0, absent)).toBeNull();
      expect(finiteNumberOrNull(absent)).toBeNull();
    }
  });

  it("accepts a complete numeric-string pair and rejects partial, non-finite and out-of-range pairs", () => {
    expect(parseMicLevelPair("0.4", "0.1")).toEqual({ peak: 0.4, avg: 0.1 });
    expect(parseMicLevelPair("0.4", null)).toBeNull();
    expect(parseMicLevelPair(Number.NaN, 0.1)).toBeNull();
    expect(parseMicLevelPair(Number.POSITIVE_INFINITY, 0.1)).toBeNull();
    expect(parseMicLevelPair(1.01, 0.1)).toBeNull();
    expect(parseMicLevelPair(0.4, -0.01)).toBeNull();
    expect(parseMicLevelPair(0.1, 0.4)).toBeNull();
  });

  it("a piece with no level OMITS the fields from the wire rather than sending zero", () => {
    const withNone = uploadBodies({
      session_id: "bs_1", idx: 0, source: "primary", content_type: "audio/webm",
      started_at: 0, ended_at: FIVE_MIN, duration_ms: FIVE_MIN, gap_before_ms: 0, size_bytes: 1,
    });
    expect(withNone.row).not.toHaveProperty("peak_level");
    const withSome = uploadBodies({
      session_id: "bs_1", idx: 0, source: "primary", content_type: "audio/webm",
      started_at: 0, ended_at: FIVE_MIN, duration_ms: FIVE_MIN, gap_before_ms: 0, size_bytes: 1,
      peak_level: 0.2, avg_level: 0.05,
    });
    expect(withSome.row.peak_level).toBe(0.2);
  });

  it("THE POLL CANNOT FAIL BECAUSE OF A METER — the level read is wrapped", () => {
    // That poll is the operator command bus and it fails open for the doctor by design.
    const poll = code("lib", "use-command-poll.ts");
    const i = poll.indexOf("getLevels?.()");
    expect(i).toBeGreaterThan(-1);
    const around = poll.slice(Math.max(0, i - 400), i + 800);
    expect(around).toMatch(/try\s*\{/);
    expect(around).toMatch(/catch/);
  });

  it("a poll carrying NO levels must not erase the ones already stored", () => {
    // A momentary inability to measure would otherwise blank the bars on a room that is
    // recording perfectly, and a bar dropping to nothing reads as a dead microphone.
    const bus = code("lib", "bench-commands.ts");
    expect(bus).toMatch(/mic_peak\s*=\s*COALESCE\(EXCLUDED\.mic_peak,\s*bench_listener\.mic_peak\)/);
    expect(bus).toMatch(/spare_avg\s*=\s*CASE[\s\S]*?ELSE COALESCE\(EXCLUDED\.spare_avg,\s*bench_listener\.spare_avg\) END/);
  });
});

// ===========================================================================
// §2.1 / D38 — the page reports itself whenever it is open
// ===========================================================================

describe("§2.1 D38 — an idle room reports itself, and the freshness window is unchanged", () => {
  it("three seconds idle is THREE CHANCES to be heard inside the ten-second window", () => {
    expect(POLL_IDLE_MS).toBe(3_000);
    expect(LISTENER_FRESH_MS).toBe(10_000);
    expect(POLL_IDLE_MS * 3).toBeLessThan(LISTENER_FRESH_MS);
  });

  it("the RECORDING cadence is unchanged — this adds a beat, it does not slow one", () => {
    expect(POLL_VISIBLE_MS).toBe(1_500);
  });

  it("the cadence is chosen by what the room is DOING, not by whether a session row exists", () => {
    const poll = code("lib", "use-command-poll.ts");
    expect(poll).toMatch(/POLL_IDLE_MS/);
    expect(poll).toMatch(/snap\.state === "recording" \|\| snap\.state === "paused"/);
  });
});

// ===========================================================================
// §2.5 — the end time is the end of the audio
// ===========================================================================

describe("§2.5 — a session's end time comes from its last VERIFIED piece", () => {
  const endRoute = code("app", "api", "bench", "sessions", "[id]", "route.ts");
  const orphan = code("lib", "bench-orphan.ts");

  it("the normal end path takes it from the tape, not from a clock reading", () => {
    expect(endRoute).toMatch(/MAX\(c\.ended_at\)/);
    expect(endRoute).toMatch(/upload_state = 'verified'/);
    expect(endRoute).not.toMatch(/SET status = 'ended', ended_at = NOW\(\)/);
  });

  it("the repair path — where the gap is hours, not seconds — uses the same rule", () => {
    expect(orphan).toMatch(/MAX\(c\.ended_at\)/);
    expect(orphan).toMatch(/upload_state = 'verified'/);
  });

  it("NOW() survives only as the fallback for a session that recorded nothing", () => {
    // Leaving ended_at NULL would make an ended session read as still running for ever.
    expect(endRoute).toMatch(/COALESCE\([\s\S]{0,400}NOW\(\)\s*\)/);
  });

  it("VERIFIED ONLY — an end time may not rest on a piece that never landed", () => {
    expect(endRoute).not.toMatch(/MAX\(c\.ended_at\) FROM bench_chunk c\s+WHERE c\.session_id = s\.id\s*\)/);
  });
});

// ===========================================================================
// §5 / §0 — the archive always wins
// ===========================================================================

describe("§0 — nothing added in this build can cost a piece of audio", () => {
  it("lib/mic-health.ts is PURE — it decides, it never writes", () => {
    const src = code("lib", "mic-health.ts");
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/);
    const imports = [...readFileSync(join(process.cwd(), "lib", "mic-health.ts"), "utf8").matchAll(/^import .*$/gm)];
    expect(imports).toHaveLength(0); // safe in every bundle, including the kiosk's
  });

  it("the spare's meter has its OWN AudioContext, so a spare fault cannot take the failsafe down", () => {
    const rec = code("lib", "use-room-recorder.ts");
    expect(rec).toMatch(/spareMeterRef/);
    // the watchdog's context is separate and still one-per-day
    expect(rec).toMatch(/watchdogCtxRef/);
  });

  it("the iPhone guard is untouched — a recorder and an analyser cannot share one track there", () => {
    // Two wrong diagnoses established this. The room Macs are unaffected; the guard stays.
    const rec = readFileSync(join(process.cwd(), "lib", "use-room-recorder.ts"), "utf8");
    expect(rec).toMatch(/getUserMedia/);
    expect(rec).toMatch(/meterStream|watchdogCtxRef/);
  });

  it("migration 0066 is ADDITIVE and IDEMPOTENT and carries its grant decision", () => {
    const m = readFileSync(join(process.cwd(), "db", "migrations", "0066_mic_levels.sql"), "utf8");
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(m).not.toMatch(/DROP COLUMN|ALTER COLUMN|NOT NULL/);
    expect(m).toMatch(/pg_roles/);          // the grant block is guarded on the role existing
    expect(m).toMatch(/schema_migrations/); // and it records itself
  });

  it("migration 0067 repairs end times WITHOUT touching audio or status", () => {
    const m = readFileSync(join(process.cwd(), "db", "migrations", "0067_repair_end_times.sql"), "utf8");
    expect(m).toMatch(/UPDATE bench_session/);
    expect(m).toMatch(/INTERVAL '10 minutes'/);
    // it moves a timestamp and nothing else: no status change, no chunk write, no delete
    expect(m).not.toMatch(/SET status/);
    expect(m).not.toMatch(/DELETE|DROP|TRUNCATE/);
    expect(m).not.toMatch(/UPDATE bench_chunk/);
  });
});
