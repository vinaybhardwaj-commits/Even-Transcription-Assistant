/**
 * lib/fleet-attention.ts — behaviour tests for rules R1–R7, driven through the PURE `computeAttention` with fixtures that encode what was
 * measured on 5 Oct 2026: OPD 6's Mac fell into DarkWake at 01:36:50 IST while the extension kept sending heartbeats and logged a `locked` event;
 * its level meter froze to one identical reading from 01:36:52; the watchdog announced `recovered` at 04:36 while the Macs were still asleep;
 * OPD 4 had recorded nothing for four days; a remote start failed with "tapewriter exited with status 1".
 *
 * No database: the DB half of the file is read-only SELECTs and is not exercised here.
 */
import { describe, it, expect } from "vitest";
import {
  computeAttention,
  resolveLockState,
  classifyExtEvent,
  isClinicHours,
  isSilentChunk,
  chunkBytesPerSecond,
  legacyPollerKey,
  POLLER_LEGACY_KEYS,
  type RoomAttentionInputs,
  type PresenceEventLite,
  type LevelSample,
  type ChunkLite,
} from "@/lib/fleet-attention";
import { KIND_LABEL, fmtFor, fmtIst, type AttentionKind } from "@/lib/fleet-attention-format";
import { degradedMessage, offlineMessage } from "@/lib/room-watchdog";
import { makeFakeClinician } from "../support/fake-identity";

// Doctors come from the fake-identity helper (tests/unit/no-identity-literals.test.ts bans hard-coded people).
const DOC = makeFakeClinician(1);
const DOC2 = makeFakeClinician(2);

/** An IST wall-clock string ("2026-10-05 02:10:00") as epoch ms. */
const ist = (s: string): number => Date.parse(`${s.replace(" ", "T")}+05:30`);
const iso = (s: string): string => new Date(ist(s)).toISOString();

const room = (over: Partial<RoomAttentionInputs> = {}): RoomAttentionInputs => ({
  room_id: "room_opd6",
  room_name: "OPD 6",
  machine: "EHRC-OPD6s-Mac-mini",
  ext_events: [],
  poller: null,
  recent_activity: null,
  open_session: null,
  last_session_started_at: null,
  samples: [],
  frozen_since: null,
  last_sample_at: null,
  chunks: [],
  windows: [],
  outbox: null,
  failed_start: null,
  ...over,
});

const run = (now: string, ...rooms: RoomAttentionInputs[]) => computeAttention({ now_ms: ist(now), rooms });
const kinds = (items: ReturnType<typeof run>) => items.map((i) => `${i.room_id}:${i.kind}`);

const recordingSince = (at: string, id = "bs_1") => ({ id, status: "recording" as const, started_at: iso(at) });

// ---------------------------------------------------------------------------
// R1 asleep (kind id kept; "Mac not capturing") — a LOCKED SCREEN ALONE IS NOT A FAULT
// ---------------------------------------------------------------------------

/** The 5 Oct DarkWake: normal heartbeats, a `locked` at 01:36:50, then UNFOCUSED heartbeats every 30 s all night. */
function darkWakeEvents(untilHHMMSS: string): PresenceEventLite[] {
  const evs: PresenceEventLite[] = [{ event: "heartbeat", ts: iso("2026-10-05 01:36:20"), tab_focus: true }];
  evs.push({ event: "locked", ts: iso("2026-10-05 01:36:50") });
  const end = ist(`2026-10-05 ${untilHHMMSS}`);
  for (let t = ist("2026-10-05 01:37:20"); t <= end; t += 30_000) evs.push({ event: "heartbeat", ts: new Date(t).toISOString(), tab_focus: false });
  return evs;
}

describe("R1 asleep — Mac not capturing", () => {
  const N = "2026-10-05 04:40:00";
  const open = recordingSince("2026-10-04 08:40:00");
  const asleepOf = (items: ReturnType<typeof run>) => items.filter((i) => i.kind === "asleep");
  /** OPD 6 as it was at 04:40 on 5 Oct: screen locked since 01:36:50, meter frozen since 01:36:52, no chunk since 01:35. */
  const frozenLocked = (over: Partial<RoomAttentionInputs> = {}) =>
    room({ ext_events: darkWakeEvents("04:39:50"), open_session: open, samples: frozenSamples("2026-10-05 04:39:58"), frozen_since: iso("2026-10-05 01:36:52"), last_chunk_at: iso("2026-10-05 01:35:00"), ...over });

  it("raises RED when the screen is locked, a session is open and there is no audio: 'Screen locked and no audio since 01:36 IST'", () => {
    const items = asleepOf(run(N, frozenLocked()));
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe("red");
    expect(items[0]!.detail).toBe("Screen locked and no audio since 01:36 IST.");
    expect(items[0]!.since).toBe(iso("2026-10-05 01:36:50"));
    expect(items[0]!.machine).toBe("EHRC-OPD6s-Mac-mini");
    expect(items[0]!.detail).not.toMatch(/asleep/i);
  });

  it("since is when the audio stopped when that is later than the lock (meter frozen at 01:36:52, chunks still arriving at 04:35)", () => {
    const items = asleepOf(run(N, frozenLocked({ chunks: [chunk("2026-10-05 04:35:00", 3_400_000)] })));
    expect(items[0]!.since).toBe(iso("2026-10-05 01:36:52"));
  });

  it("raises when the meter moves but NO chunk landed in 10 minutes (the half of the audio test the meter cannot see)", () => {
    const items = asleepOf(run(N, room({ ext_events: darkWakeEvents("04:39:50"), open_session: open, samples: movingSamples("2026-10-05 04:39:58"), chunks: [], last_chunk_at: iso("2026-10-05 04:20:00") })));
    expect(items).toHaveLength(1);
    expect(items[0]!.detail).toBe("Screen locked and no audio since 04:20 IST.");
  });

  it("OPD 5 under a locked screen, recording all morning, idle for hours: NOTHING (any audio evidence clears R1)", () => {
    const opd5 = room({
      room_id: "room_opd5",
      room_name: "OPD 5",
      ext_events: [{ event: "locked", ts: iso("2026-10-05 01:00:00") }],
      poller: { ts: iso("2026-10-05 10:09:30"), state: "ok", locked: true, asleep_since: iso("2026-10-05 01:00:00") },
      open_session: recordingSince("2026-10-05 09:13:00"),
      samples: movingSamples("2026-10-05 10:09:58"),
      chunks: [chunk("2026-10-05 10:08:00", 3_400_000)],
    });
    expect(run("2026-10-05 10:10:00", opd5)).toEqual([]);
  });

  it("a locked screen with NO session open produces NO item — even after hours of unfocused heartbeats (DarkWake looks the same as a locked idle Mac)", () => {
    expect(run("2026-10-05 04:40:00", room({ ext_events: darkWakeEvents("04:39:50") }))).toEqual([]);
    expect(run("2026-10-05 04:40:00", room({ poller: { ts: iso("2026-10-05 04:39:30"), state: "ok", locked: true, asleep_since: iso("2026-10-05 01:37:30") } }))).toEqual([]);
  });

  it("needs a RECORDING session: a paused one raises nothing", () => {
    expect(asleepOf(run(N, frozenLocked({ open_session: { ...open, status: "paused" } })))).toEqual([]);
  });

  it("gives a session that opened under 2 minutes ago (and under 10 for the chunk half) the benefit of the doubt", () => {
    const young = room({ ext_events: [{ event: "locked", ts: iso("2026-10-05 09:00:00") }], open_session: recordingSince("2026-10-05 09:59:00") });
    expect(run("2026-10-05 10:00:00", young)).toEqual([]);
  });

  it("clears at once on any audio evidence: add a moving meter and a fresh chunk to the frozen, locked room", () => {
    expect(asleepOf(run(N, frozenLocked()))).toHaveLength(1);
    expect(asleepOf(run(N, frozenLocked({ samples: movingSamples("2026-10-05 04:39:58"), chunks: [chunk("2026-10-05 04:35:00", 3_400_000)] })))).toEqual([]);
  });

  it("a person at the Mac (focused heartbeat, active, login) after the lock clears the lock half", () => {
    for (const wake of [
      { event: "heartbeat", ts: iso("2026-10-05 04:39:55"), tab_focus: true },
      { event: "heartbeat", ts: iso("2026-10-05 04:39:55"), tab_focus: "true" },
      { event: "active", ts: iso("2026-10-05 04:39:55") },
      { event: "login", ts: iso("2026-10-05 04:39:55") },
    ] as PresenceEventLite[]) {
      const items = run(N, frozenLocked({ ext_events: [...darkWakeEvents("04:39:50"), wake] }));
      expect(asleepOf(items)).toEqual([]);
      expect(kinds(items)).toContain("room_opd6:capture_frozen"); // R2 is independent of the lock and still says it
    }
  });

  it("does not let idle, logout or an unfocused heartbeat decide anything", () => {
    expect(classifyExtEvent({ event: "idle", ts: "x" })).toBeNull();
    expect(classifyExtEvent({ event: "logout", ts: "x" })).toBeNull();
    expect(classifyExtEvent({ event: "heartbeat", ts: "x", tab_focus: false })).toBeNull();
    expect(classifyExtEvent({ event: "heartbeat", ts: "x", tab_focus: null })).toBeNull();
    expect(classifyExtEvent({ event: "locked", ts: "x" })).toBe("locked");
  });

  it("the poller alone can say locked or unreachable, with the run's start as `since`", () => {
    const locked = asleepOf(run(N, room({ open_session: open, samples: frozenSamples("2026-10-05 04:39:58"), frozen_since: iso("2026-10-05 01:36:52"), last_chunk_at: iso("2026-10-05 01:35:00"), poller: { ts: iso("2026-10-05 04:39:30"), state: "ok", locked: true, asleep_since: iso("2026-10-05 01:37:30") } })));
    expect(locked[0]!.detail).toBe("Screen locked and no audio since 01:37 IST.");
    const unreachable = asleepOf(run(N, room({ open_session: open, samples: frozenSamples("2026-10-05 04:39:58"), frozen_since: iso("2026-10-05 01:36:52"), last_chunk_at: iso("2026-10-05 01:35:00"), poller: { ts: iso("2026-10-05 04:39:30"), state: "unreachable", locked: false, asleep_since: iso("2026-10-05 04:38:00") } })));
    expect(unreachable[0]!.detail).toBe("Mac unreachable on the network and no audio since 04:38 IST.");
  });

  describe("(b) the poller's newest row is `unreachable` for 3 minutes or more", () => {
    const unreach = (ts: string, since: string) => ({ ts: iso(ts), state: "unreachable", locked: false, unreachable_since: iso(since) });

    it("raises RED with no session at all", () => {
      const items = run(N, room({ poller: unreach("2026-10-05 04:39:30", "2026-10-05 04:35:00") }));
      expect(kinds(items)).toEqual(["room_opd6:asleep"]);
      expect(items[0]!.severity).toBe("red");
      expect(items[0]!.since).toBe(iso("2026-10-05 04:35:00"));
      expect(items[0]!.detail).toBe("The Mac in OPD 6 has been unreachable on the network since 04:35 IST.");
    });
    it("not before 3 minutes (the boundary is inclusive)", () => {
      expect(run(N, room({ poller: unreach("2026-10-05 04:39:30", "2026-10-05 04:38:00") }))).toEqual([]);
      expect(kinds(run(N, room({ poller: unreach("2026-10-05 04:39:30", "2026-10-05 04:37:00") })))).toEqual(["room_opd6:asleep"]);
    });
    it("a poller row older than 10 minutes says nothing about now (the poller may be down)", () => {
      expect(run(N, room({ poller: unreach("2026-10-05 04:25:00", "2026-10-05 03:00:00") }))).toEqual([]);
    });
    it("a Mac the poller cannot reach but whose recording is demonstrably delivering audio is a network fact, not a capture fact", () => {
      const delivering = room({ open_session: open, samples: movingSamples("2026-10-05 04:39:58"), chunks: [chunk("2026-10-05 04:35:00", 3_400_000)], poller: unreach("2026-10-05 04:39:30", "2026-10-05 04:30:00") });
      expect(run(N, delivering)).toEqual([]);
    });
    it("an ok poller row that is merely locked is not (b)", () => {
      expect(run(N, room({ poller: { ts: iso("2026-10-05 04:39:30"), state: "ok", locked: true } }))).toEqual([]);
    });
  });

  it("resolveLockState: the newer source wins; when both say down, since is the earlier; unknown evidence is not down", () => {
    const lockedAt0136 = darkWakeEvents("01:40:00");
    expect(resolveLockState(lockedAt0136, { ts: iso("2026-10-05 02:09:30"), state: "ok", locked: false }).down).toBe(false);
    expect(resolveLockState(lockedAt0136, { ts: iso("2026-10-05 01:30:00"), state: "ok", locked: false }).down).toBe(true);
    expect(resolveLockState(lockedAt0136, { ts: iso("2026-10-05 02:00:00"), state: "unreachable", locked: false, asleep_since: iso("2026-10-05 01:38:00") })).toEqual({ down: true, since: iso("2026-10-05 01:36:50"), by: "locked" });
    expect(resolveLockState([], { ts: iso("2026-10-05 02:00:00"), state: "unreachable", locked: false })).toEqual({ down: true, since: iso("2026-10-05 02:00:00"), by: "unreachable" });
    expect(resolveLockState([], null)).toEqual({ down: false, since: null, by: null });
  });

  it("POLLER_LEGACY_KEYS maps the seven pre-5-Oct short names; the -2 Macs and unknown keys have none", () => {
    expect(POLLER_LEGACY_KEYS).toEqual({
      consul4: "EHRC-CONSUL4s-Mac-mini",
      consul5: "EHRC-CONSUL5s-Mac-mini",
      consul6: "EHRC-CONSUL6s-Mac-mini",
      consul7: "EHRC-CONSUL7s-Mac-mini",
      echo: "EHRC-ECHOs-Mac-mini",
      discussion: "EHRC-DISCUSSIONs-Mac-mini",
      audiometry: "EHRC-AUDIOMETRYs-Mac-mini",
    });
    expect(legacyPollerKey("EHRC-CONSUL4s-Mac-mini")).toBe("consul4");
    expect(legacyPollerKey("EHRC-AUDIOMETRYs-Mac-mini")).toBe("audiometry");
    expect(legacyPollerKey("EHRC-CONSUL4s-Mac-mini-2")).toBeNull();
    expect(legacyPollerKey("EHRC-CONSUL2s-Mac-mini-2")).toBeNull();
    expect(legacyPollerKey("nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R2 capture_frozen
// ---------------------------------------------------------------------------

/** `n` samples 2.5 s apart ending at `endIST`, all carrying one (peak, zero_ratio). */
function frozenSamples(endIST: string, n = 48, peak = 0.0123, zero = 0.31): LevelSample[] {
  const end = ist(endIST);
  return Array.from({ length: n }, (_, i) => ({ sampled_at: new Date(end - (n - 1 - i) * 2500).toISOString(), peak, zero_ratio: zero }));
}
function movingSamples(endIST: string, n = 48): LevelSample[] {
  const end = ist(endIST);
  return Array.from({ length: n }, (_, i) => ({ sampled_at: new Date(end - (n - 1 - i) * 2500).toISOString(), peak: 0.01 + (i % 7) * 0.003, zero_ratio: 0.2 + (i % 5) * 0.01 }));
}

describe("R2 capture_frozen", () => {
  const open = recordingSince("2026-10-04 08:40:00");

  it("raises RED when the last 120 s are one identical value, and says since when (the 4,220-sample freeze from 01:36:52)", () => {
    const items = run("2026-10-05 04:40:00", room({ open_session: open, samples: frozenSamples("2026-10-05 04:39:58"), frozen_since: iso("2026-10-05 01:36:52") }));
    expect(kinds(items)).toEqual(["room_opd6:capture_frozen"]);
    expect(items[0]!.severity).toBe("red");
    expect(items[0]!.since).toBe(iso("2026-10-05 01:36:52"));
    expect(items[0]!.detail).toContain("01:36 IST");
  });

  it("falls back to the oldest sample in the window when the loader did not look further back", () => {
    const s = frozenSamples("2026-10-05 04:39:58");
    const items = run("2026-10-05 04:40:00", room({ open_session: open, samples: s }));
    expect(items[0]!.since).toBe(s[0]!.sampled_at);
  });

  it("stays quiet while the meter moves", () => {
    expect(run("2026-10-05 10:00:00", room({ open_session: recordingSince("2026-10-05 08:40:00"), samples: movingSamples("2026-10-05 09:59:58") }))).toEqual([]);
  });

  it("two values are enough to be alive (the cheapest honest signal)", () => {
    const s = frozenSamples("2026-10-05 09:59:58");
    s[47] = { ...s[47]!, peak: 0.5 };
    expect(run("2026-10-05 10:00:00", room({ open_session: recordingSince("2026-10-05 08:40:00"), samples: s }))).toEqual([]);
  });

  it("raises RED when NO sample arrived in 120 s although a session is open", () => {
    const items = run("2026-10-05 04:40:00", room({ open_session: open, samples: [], last_sample_at: iso("2026-10-05 01:36:52") }));
    expect(kinds(items)).toEqual(["room_opd6:capture_frozen"]);
    expect(items[0]!.detail).toContain("No microphone level readings");
    expect(items[0]!.since).toBe(iso("2026-10-05 01:36:52"));
  });

  it("ignores samples older than the window", () => {
    const old = frozenSamples("2026-10-05 04:30:00");
    const items = run("2026-10-05 04:40:00", room({ open_session: open, samples: old }));
    expect(items[0]!.detail).toContain("No microphone level readings");
  });

  it("needs a RECORDING session: none, or paused, raises nothing", () => {
    expect(run("2026-10-05 04:40:00", room({ samples: frozenSamples("2026-10-05 04:39:58") }))).toEqual([]);
    expect(run("2026-10-05 04:40:00", room({ open_session: { ...open, status: "paused" }, samples: frozenSamples("2026-10-05 04:39:58") }))).toEqual([]);
  });

  it("gives a session that opened under two minutes ago the benefit of the doubt", () => {
    expect(run("2026-10-05 09:00:00", room({ open_session: recordingSince("2026-10-05 08:59:00"), samples: [] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R3 silent_tape
// ---------------------------------------------------------------------------

/** A 5-minute (300,000 ms) chunk by default. */
const chunk = (createdIST: string, size: number | null, over: Partial<ChunkLite> = {}): ChunkLite => ({
  session_id: "bs_1",
  source: "primary",
  created_at: iso(createdIST),
  started_at: new Date(ist(createdIST) - 300_000).toISOString(),
  size_bytes: size,
  duration_ms: 300_000,
  ...over,
});

describe("R3 silent_tape — silent BY RATE: <= 800 bytes/s over a chunk of >= 150 s", () => {
  const open = recordingSince("2026-10-05 08:40:00");
  const NOW = "2026-10-05 10:07:00";
  const silent = [chunk("2026-10-05 10:05:00", 212_378), chunk("2026-10-05 10:00:00", 212_378)];
  const withMeter = (chunks: ChunkLite[], over: Partial<RoomAttentionInputs> = {}) =>
    room({ open_session: open, samples: movingSamples("2026-10-05 10:06:58"), chunks, ...over });

  it("raises RED on two consecutive newest chunks of 212,378 bytes over 300 s (708 B/s)", () => {
    const items = run(NOW, withMeter([...silent, chunk("2026-10-05 09:55:00", 3_400_000)]));
    expect(kinds(items)).toEqual(["room_opd6:silent_tape"]);
    expect(items[0]!.severity).toBe("red");
    expect(items[0]!.detail).toContain("about 708 bytes per second");
    expect(items[0]!.since).toBe(chunk("2026-10-05 10:00:00", 1).started_at);
  });

  it("counts the whole silent run, newest backwards", () => {
    const items = run(NOW, withMeter([...silent, chunk("2026-10-05 09:55:00", 212_378)]));
    expect(items[0]!.detail).toContain("last 3 recording pieces");
  });

  it("one silent chunk is not enough", () => {
    expect(run(NOW, withMeter([chunk("2026-10-05 10:05:00", 212_378), chunk("2026-10-05 10:00:00", 3_400_000)]))).toEqual([]);
  });

  it("silence that is NOT consecutive with the newest chunk is not raised", () => {
    expect(run(NOW, withMeter([chunk("2026-10-05 10:05:00", 3_400_000), chunk("2026-10-05 10:00:00", 212_378), chunk("2026-10-05 09:55:00", 212_378)]))).toEqual([]);
    expect(run(NOW, withMeter([chunk("2026-10-05 10:05:00", 212_378), chunk("2026-10-05 10:00:00", 3_400_000), chunk("2026-10-05 09:55:00", 212_378)]))).toEqual([]);
  });

  it("the rate is 800 B/s inclusive: 240,000 bytes over 300 s is silent, 240,300 (801 B/s) is audio", () => {
    expect(kinds(run(NOW, withMeter([chunk("2026-10-05 10:05:00", 240_000), chunk("2026-10-05 10:00:00", 240_000)])))).toEqual(["room_opd6:silent_tape"]);
    expect(run(NOW, withMeter([chunk("2026-10-05 10:05:00", 240_300), chunk("2026-10-05 10:00:00", 240_300)]))).toEqual([]);
  });

  it("it is a RATE, not a size: a long chunk of a given size is the same as a short one at the same rate", () => {
    // 10-minute chunks: 400,000 bytes is 667 B/s — silent although larger than the old 230,000-byte rule.
    const long = (c: string) => chunk(c, 400_000, { duration_ms: 600_000 });
    expect(kinds(run(NOW, withMeter([long("2026-10-05 10:05:00"), long("2026-10-05 09:55:00")])))).toEqual(["room_opd6:silent_tape"]);
    // 150-second chunks: 120,000 bytes is exactly 800 B/s.
    const mid = (c: string) => chunk(c, 120_000, { duration_ms: 150_000 });
    expect(kinds(run(NOW, withMeter([mid("2026-10-05 10:05:00"), mid("2026-10-05 10:00:00")])))).toEqual(["room_opd6:silent_tape"]);
  });

  it("a chunk shorter than 150 s is never called silent, however small (a tail chunk, a pause or a restart)", () => {
    const short = (c: string) => chunk(c, 1_000, { duration_ms: 149_999 });
    expect(run(NOW, withMeter([short("2026-10-05 10:05:00"), short("2026-10-05 10:00:00")]))).toEqual([]);
  });

  it("an unknown size or an unknown/zero duration is never silent", () => {
    expect(run(NOW, withMeter([chunk("2026-10-05 10:05:00", null), chunk("2026-10-05 10:00:00", null)]))).toEqual([]);
    expect(run(NOW, withMeter([chunk("2026-10-05 10:05:00", 100, { duration_ms: null }), chunk("2026-10-05 10:00:00", 100, { duration_ms: 0 })]))).toEqual([]);
  });

  it("isSilentChunk / chunkBytesPerSecond at the boundaries", () => {
    expect(chunkBytesPerSecond({ size_bytes: 212_378, duration_ms: 300_000 })).toBeCloseTo(707.93, 1);
    expect(isSilentChunk({ size_bytes: 240_000, duration_ms: 300_000 })).toBe(true);
    expect(isSilentChunk({ size_bytes: 240_001, duration_ms: 300_000 })).toBe(false);
    expect(isSilentChunk({ size_bytes: 1, duration_ms: 150_000 })).toBe(true);
    expect(isSilentChunk({ size_bytes: 1, duration_ms: 149_999 })).toBe(false);
    expect(chunkBytesPerSecond({ size_bytes: null, duration_ms: 300_000 })).toBeNull();
  });

  it("ignores the backup mic, chunks of other sessions, and a session that is not recording", () => {
    const silentBackup = silent.map((c) => ({ ...c, source: "backup" }));
    const otherSession = silent.map((c) => ({ ...c, session_id: "bs_old" }));
    for (const chunks of [silentBackup, otherSession]) {
      expect(run(NOW, withMeter(chunks))).toEqual([]);
    }
    expect(run(NOW, room({ open_session: { ...open, status: "paused" }, chunks: silent }))).toEqual([]);
    expect(run(NOW, room({ chunks: silent }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R4 consult_without_tape
// ---------------------------------------------------------------------------

describe("R4 consult_without_tape", () => {
  const NOW = "2026-10-05 14:30:00";
  const open = recordingSince("2026-10-05 08:40:00");
  const win = (openIST: string, closeIST: string | null, name: string | null = DOC.full_name) => ({ display_name: name, t_open: iso(openIST), t_close: closeIST ? iso(closeIST) : null });
  const moving = movingSamples("2026-10-05 14:29:58");

  it("raises RED naming the doctor when a consult is open and no chunk has arrived for 10 minutes", () => {
    const items = run(NOW, room({ open_session: open, samples: moving, windows: [win("2026-10-05 14:05:00", null)], chunks: [chunk("2026-10-05 14:10:00", 3_400_000)] }));
    expect(kinds(items)).toEqual(["room_opd6:consult_without_tape"]);
    expect(items[0]!.severity).toBe("red");
    expect(items[0]!.detail).toContain(`${DOC.label} is consulting but nothing is being recorded`);
    expect(items[0]!.since).toBe(iso("2026-10-05 14:05:00"));
  });

  it("does not double a Dr prefix, and copes with an unknown doctor", () => {
    const a = run(NOW, room({ open_session: open, samples: moving, windows: [win("2026-10-05 14:05:00", null, `Dr. ${DOC.full_name}`)] }));
    expect(a[0]!.detail.startsWith(`Dr. ${DOC.full_name} is consulting`)).toBe(true);
    const b = run(NOW, room({ open_session: open, samples: moving, windows: [win("2026-10-05 14:05:00", null, null)] }));
    expect(b[0]!.detail.startsWith("A doctor is consulting")).toBe(true);
  });

  it("stays quiet when a chunk arrived inside 10 minutes", () => {
    expect(run(NOW, room({ open_session: open, samples: moving, windows: [win("2026-10-05 14:05:00", null)], chunks: [chunk("2026-10-05 14:21:00", 3_400_000)] }))).toEqual([]);
  });

  it("any source counts as a chunk", () => {
    expect(run(NOW, room({ open_session: open, samples: moving, windows: [win("2026-10-05 14:05:00", null)], chunks: [chunk("2026-10-05 14:25:00", 3_400_000, { source: "backup" })] }))).toEqual([]);
  });

  it("counts a window that opened in the last 15 minutes even if it has already closed", () => {
    expect(kinds(run(NOW, room({ open_session: open, samples: moving, windows: [win("2026-10-05 14:20:00", "2026-10-05 14:24:00")] })))).toEqual(["room_opd6:consult_without_tape"]);
  });

  it("a window that closed earlier and opened more than 15 minutes ago is history", () => {
    expect(run(NOW, room({ open_session: open, samples: moving, windows: [win("2026-10-05 14:00:00", "2026-10-05 14:15:00")] }))).toEqual([]);
  });

  it("a window still open with a close time in the future counts", () => {
    expect(kinds(run(NOW, room({ open_session: open, samples: moving, windows: [win("2026-10-05 13:50:00", "2026-10-05 14:45:00")] })))).toEqual(["room_opd6:consult_without_tape"]);
  });

  it("an unclosed window older than the resolver's own cap is a leftover, not a live consult", () => {
    expect(run(NOW, room({ open_session: open, samples: moving, windows: [win("2026-10-05 09:00:00", null)] }))).toEqual([]);
  });

  it("raises with NO session at all — the OPD 4 shape: Pulse sees consults, the tape never started", () => {
    const items = run(NOW, room({ room_id: "room_opd4", room_name: "OPD 4", windows: [win("2026-10-05 14:05:00", null)], last_session_started_at: iso("2026-10-01 08:40:00") }));
    expect(kinds(items)).toEqual(["room_opd4:consult_without_tape"]);
  });

  it("is not raised while the tape is under 10 minutes old (its first 5-minute piece may not have landed)", () => {
    expect(run(NOW, room({ open_session: recordingSince("2026-10-05 14:25:00"), samples: moving, windows: [win("2026-10-05 14:05:00", null)] }))).toEqual([]);
  });

  it("collapses several qualifying windows into one item, the earliest", () => {
    const items = run(NOW, room({ windows: [win("2026-10-05 14:20:00", null, DOC.full_name), win("2026-10-05 14:05:00", "2026-10-05 14:40:00", DOC2.full_name)] }));
    expect(items).toHaveLength(1);
    expect(items[0]!.detail).toContain(DOC2.label);
  });
});

// ---------------------------------------------------------------------------
// R5 no_session_in_clinic
// ---------------------------------------------------------------------------

describe("R5 no_session_in_clinic", () => {
  const active = (first: string, last: string) => ({ first_at: iso(first), last_at: iso(last) });
  const opd4 = (over: Partial<RoomAttentionInputs>) => room({ room_id: "room_opd4", room_name: "OPD 4", machine: "EHRC-OPD4s-Mac-mini", last_session_started_at: iso("2026-10-01 08:40:00"), ...over });

  it("raises AMBER in clinic hours when the Mac is in use and no session is open — OPD 4, four days without a recording", () => {
    const items = run("2026-10-05 14:30:00", opd4({ recent_activity: active("2026-10-05 14:05:00", "2026-10-05 14:29:30") }));
    expect(kinds(items)).toEqual(["room_opd4:no_session_in_clinic"]);
    expect(items[0]!.severity).toBe("amber");
    expect(items[0]!.since).toBe(iso("2026-10-05 14:05:00"));
  });

  it("since never precedes the clinic day's opening at 08:30", () => {
    const items = run("2026-10-05 09:00:00", opd4({ recent_activity: active("2026-10-05 08:31:00", "2026-10-05 08:59:00") }));
    expect(items[0]!.since).toBe(iso("2026-10-05 08:31:00"));
    const early = run("2026-10-05 08:40:00", opd4({ recent_activity: active("2026-10-05 08:30:00", "2026-10-05 08:39:00") }));
    expect(early[0]!.since).toBe(iso("2026-10-05 08:30:00"));
  });

  it("is silent outside clinic hours: before 08:30, from 20:30, and all Sunday", () => {
    const a = active("2026-10-05 08:00:00", "2026-10-05 08:20:00");
    expect(run("2026-10-05 08:29:00", opd4({ recent_activity: a }))).toEqual([]);
    expect(run("2026-10-05 20:30:00", opd4({ recent_activity: a }))).toEqual([]);
    expect(run("2026-10-04 14:30:00", opd4({ recent_activity: active("2026-10-04 14:05:00", "2026-10-04 14:29:00") }))).toEqual([]);
    expect(isClinicHours(ist("2026-10-04 14:30:00"))).toBe(false);
    expect(isClinicHours(ist("2026-10-03 14:30:00"))).toBe(true); // Saturday
    expect(isClinicHours(ist("2026-10-05 20:29:59"))).toBe(true);
  });

  it("is silent with an open session (a paused one counts as open) or with no recent activity", () => {
    const a = active("2026-10-05 14:05:00", "2026-10-05 14:29:30");
    expect(run("2026-10-05 14:30:00", opd4({ recent_activity: a, open_session: recordingSince("2026-10-05 08:40:00"), samples: movingSamples("2026-10-05 14:29:58") }))).toEqual([]);
    expect(run("2026-10-05 14:30:00", opd4({ recent_activity: a, open_session: { id: "bs_1", status: "paused", started_at: iso("2026-10-05 08:40:00") } }))).toEqual([]);
    expect(run("2026-10-05 14:30:00", opd4({ recent_activity: null }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R6 open_outbox
// ---------------------------------------------------------------------------

describe("R6 open_outbox", () => {
  const alertAt = "2026-10-05 01:37:00";
  const degraded = (reasons: Parameters<typeof degradedMessage>[1], over: Partial<NonNullable<RoomAttentionInputs["outbox"]>> = {}) => ({
    id: 41,
    kind: "degraded" as const,
    created_at: iso(alertAt),
    body: degradedMessage("OPD 3", reasons, iso(alertAt)).text,
    chunk_after_alert: false,
    distinct_levels_since_alert: 0,
    ...over,
  });
  const opd3 = (outbox: RoomAttentionInputs["outbox"]) => room({ room_id: "room_opd3", room_name: "OPD 3", outbox });

  it("keeps the alert OPEN at 04:40 — after the watchdog's false `recovered` at 04:36 — because no chunk has landed since it", () => {
    const items = run("2026-10-05 04:40:00", opd3(degraded(["device_missing"])));
    expect(kinds(items)).toEqual(["room_opd3:open_outbox"]);
    expect(items[0]!.severity).toBe("red");
    expect(items[0]!.since).toBe(iso(alertAt));
    expect(items[0]!.detail).toContain("a missing input device");
    expect(items[0]!.detail).toContain("no new recording has arrived since");
  });

  it("stays open when a chunk landed but the levels have only ever been one value (a frozen mic that closed a session)", () => {
    const items = run("2026-10-05 04:40:00", opd3(degraded(["device_missing"], { chunk_after_alert: true, distinct_levels_since_alert: 1 })));
    expect(kinds(items)).toEqual(["room_opd3:open_outbox"]);
    expect(items[0]!.detail).toContain("audio levels have not moved");
  });

  it("closes only on a GENUINE recovery: a chunk after the alert AND two distinct level values since", () => {
    expect(run("2026-10-05 09:00:00", opd3(degraded(["device_missing"], { chunk_after_alert: true, distinct_levels_since_alert: 2 })))).toEqual([]);
    // two distinct values but no chunk is not a recovery either
    expect(kinds(run("2026-10-05 09:00:00", opd3(degraded(["device_missing"], { chunk_after_alert: false, distinct_levels_since_alert: 2 }))))).toEqual(["room_opd3:open_outbox"]);
  });

  it("offline is red", () => {
    const items = run("2026-10-05 04:40:00", opd3({ id: 40, kind: "offline", created_at: iso(alertAt), body: offlineMessage("OPD 3", iso(alertAt)).text, chunk_after_alert: false, distinct_levels_since_alert: 0 }));
    expect(items[0]!.severity).toBe("red");
    expect(items[0]!.detail).toContain("offline");
  });

  it("degraded severity follows the reason: device_missing and tape_stalled are red; silence, clipping, encoder and disk are amber", () => {
    const sev = (r: Parameters<typeof degradedMessage>[1]) => run("2026-10-05 04:40:00", opd3(degraded(r)))[0]!.severity;
    expect(sev(["device_missing"])).toBe("red");
    expect(sev(["tape_stalled"])).toBe("red");
    expect(sev(["clipping"])).toBe("amber");
    expect(sev(["silent_while_recording"])).toBe("amber");
    expect(sev(["encoder_stalled"])).toBe("amber");
    expect(sev(["disk_critical"])).toBe("amber");
    expect(sev(["clipping", "tape_stalled"])).toBe("red");
  });

  it("names every reason the alert carried", () => {
    const d = run("2026-10-05 04:40:00", opd3(degraded(["clipping", "disk_critical"])))[0]!.detail;
    expect(d).toContain("clipping");
    expect(d).toContain("critically low disk");
  });
});

// ---------------------------------------------------------------------------
// R7 stale_start
// ---------------------------------------------------------------------------

describe("R7 stale_start", () => {
  const NOW = "2026-10-05 08:45:00";
  const failed = (at: string, error: string | null = "tapewriter exited with status 1") => ({ acked_at: iso(at), error });
  const opd5 = (over: Partial<RoomAttentionInputs>) => room({ room_id: "room_opd5", room_name: "OPD 5", ...over });

  it("raises RED quoting the ack reason when a start failed in the last hour and no session has opened", () => {
    const items = run(NOW, opd5({ failed_start: failed("2026-10-05 08:31:00") }));
    expect(kinds(items)).toEqual(["room_opd5:stale_start"]);
    expect(items[0]!.severity).toBe("red");
    expect(items[0]!.detail).toContain('"tapewriter exited with status 1"');
    expect(items[0]!.since).toBe(iso("2026-10-05 08:31:00"));
  });

  it("clears when a session opened after the failure (a later start succeeded, or somebody started it by hand)", () => {
    expect(run(NOW, opd5({ failed_start: failed("2026-10-05 08:31:00"), last_session_started_at: iso("2026-10-05 08:36:00") }))).toEqual([]);
    expect(run(NOW, opd5({ failed_start: failed("2026-10-05 08:31:00"), open_session: recordingSince("2026-10-05 08:36:00"), samples: movingSamples("2026-10-05 08:44:58"), last_session_started_at: iso("2026-10-05 08:36:00") }))).toEqual([]);
  });

  it("a session from BEFORE the failure does not hide it", () => {
    expect(kinds(run(NOW, opd5({ failed_start: failed("2026-10-05 08:31:00"), last_session_started_at: iso("2026-10-04 08:40:00") })))).toEqual(["room_opd5:stale_start"]);
  });

  it("expires after 60 minutes", () => {
    expect(run("2026-10-05 09:40:00", opd5({ failed_start: failed("2026-10-05 08:31:00") }))).toEqual([]);
    expect(kinds(run("2026-10-05 09:30:00", opd5({ failed_start: failed("2026-10-05 08:31:00") })))).toEqual(["room_opd5:stale_start"]);
  });

  it("copes with a missing reason and strips quote characters and control characters from a hostile one", () => {
    expect(run(NOW, opd5({ failed_start: failed("2026-10-05 08:31:00", null) }))[0]!.detail).toContain("no reason given");
    const d = run(NOW, opd5({ failed_start: failed("2026-10-05 08:31:00", 'bad "quote"\nnewline') }))[0]!.detail;
    expect(d).toContain('("bad quote newline")');
  });
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

describe("computeAttention as a whole", () => {
  it("is state-based: the same evidence gives the same answer every call, and an empty fleet is empty", () => {
    const r = room({ poller: { ts: iso("2026-10-05 02:09:30"), state: "unreachable", locked: false, unreachable_since: iso("2026-10-05 01:50:00") } });
    expect(run("2026-10-05 02:10:00", r)).toEqual(run("2026-10-05 02:10:00", r));
    expect(run("2026-10-05 02:10:00", r)).toHaveLength(1);
    expect(computeAttention({ now_ms: ist("2026-10-05 02:10:00"), rooms: [] })).toEqual([]);
    expect(run("2026-10-05 02:10:00", room())).toEqual([]);
  });

  it("sorts red before amber, then oldest first; one item per kind per room", () => {
    const amberOld = room({ room_id: "room_a", room_name: "OPD 4", recent_activity: { first_at: iso("2026-10-05 14:00:00"), last_at: iso("2026-10-05 14:29:00") }, last_session_started_at: iso("2026-10-01 08:40:00") });
    const redNew = room({ room_id: "room_b", room_name: "OPD 5", failed_start: { acked_at: iso("2026-10-05 14:20:00"), error: "tapewriter exited with status 1" } });
    const redOld = room({ room_id: "room_c", room_name: "OPD 6", poller: { ts: iso("2026-10-05 14:29:30"), state: "unreachable", locked: false, unreachable_since: iso("2026-10-05 13:00:00") } });
    const items = run("2026-10-05 14:30:00", amberOld, redNew, redOld);
    expect(items.map((i) => `${i.room_id}:${i.kind}:${i.severity}`)).toEqual(["room_c:asleep:red", "room_b:stale_start:red", "room_a:no_session_in_clinic:amber"]);
  });

  it("one room can carry several kinds at once, never two of the same", () => {
    const r = room({
      poller: { ts: iso("2026-10-05 14:29:30"), state: "unreachable", locked: false, unreachable_since: iso("2026-10-05 14:00:00") },
      windows: [{ display_name: DOC.full_name, t_open: iso("2026-10-05 14:10:00"), t_close: null }],
      recent_activity: { first_at: iso("2026-10-05 13:50:00"), last_at: iso("2026-10-05 13:59:00") },
    });
    const items = run("2026-10-05 14:30:00", r);
    expect(items.map((i) => i.kind).sort()).toEqual(["asleep", "consult_without_tape", "no_session_in_clinic"]);
  });

  it("every item carries one-sentence detail and action, a valid ISO since, and a plain-words label exists for every kind", () => {
    const r = room({
      poller: { ts: iso("2026-10-05 14:29:30"), state: "unreachable", locked: false, unreachable_since: iso("2026-10-05 14:00:00") },
      windows: [{ display_name: DOC.full_name, t_open: iso("2026-10-05 14:10:00"), t_close: null }],
    });
    for (const it of run("2026-10-05 14:30:00", r)) {
      expect(it.detail.trim().endsWith(".")).toBe(true);
      expect(it.action.trim().endsWith(".")).toBe(true);
      expect(Number.isFinite(Date.parse(it.since))).toBe(true);
    }
    const all: AttentionKind[] = ["asleep", "capture_frozen", "silent_tape", "consult_without_tape", "no_session_in_clinic", "open_outbox", "stale_start"];
    for (const k of all) expect(KIND_LABEL[k].length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// Wording helpers
// ---------------------------------------------------------------------------

describe("fmtFor / fmtIst", () => {
  const now = ist("2026-10-05 12:00:00");
  it("renders elapsed time the way staff read it", () => {
    expect(fmtFor(iso("2026-10-05 11:59:40"), now)).toBe("for under a minute");
    expect(fmtFor(iso("2026-10-05 11:15:00"), now)).toBe("for 45 m");
    expect(fmtFor(iso("2026-10-05 08:48:00"), now)).toBe("for 3 h 12 m");
    expect(fmtFor(iso("2026-10-01 08:00:00"), now)).toBe("for 4 d 4 h");
    expect(fmtFor(iso("2026-10-05 12:30:00"), now)).toBe("for under a minute");
    expect(fmtFor("not a date", now)).toBe("");
  });
  it("renders IST clock times, with the date when it is not today", () => {
    expect(fmtIst(iso("2026-10-05 01:36:50"), now)).toBe("01:36 IST");
    expect(fmtIst(iso("2026-10-04 23:59:00"), now)).toBe("4 Oct 23:59 IST");
    expect(fmtIst("nope", now)).toBe("an unknown time");
  });
});
