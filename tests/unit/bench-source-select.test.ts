/**
 * U4 — use the backup microphone when the primary was lost (ETA-MCP-UPGRADE PRD §7, D1/D13).
 *
 * The recording's own microphone events decide. Nothing here — and nothing in the code under
 * test — listens to audio to judge silence, so every case below is a set of `bench_event` rows,
 * a tape end, and a window.
 *
 * The shapes are the live ones: `bs_wy5yjj7a` on 19 August ends on an UNPAIRED loss at
 * 13:44:51.917 IST with the tape running on to 13:46:03, and carries a pair 131 ms apart.
 */
import { describe, it, expect } from "vitest";
import {
  buildPrimaryLostIntervals,
  decideSource,
  findLostOverlaps,
  MIC_LOST_KIND,
  MIC_RESTORED_KIND,
  sourceAnswer,
  type MicEventRow,
} from "@/lib/bench-source";
import { resolveRange, type RangeChunk } from "@/lib/bench-range";

/** 19 Aug 2026, 13:00:00 IST = 07:30:00 UTC. */
const T0 = Date.parse("2026-08-19T07:30:00.000Z");
const min = (n: number) => n * 60_000;
const iso = (t: number) => new Date(t).toISOString();

const lost = (id: string, atMs: number, reason = "track_ended"): MicEventRow => ({
  id,
  kind: MIC_LOST_KIND,
  at: iso(atMs),
  payload: { reason, backup: "active", idx: 3 },
});
const restored = (id: string, atMs: number, reason = "device_back"): MicEventRow => ({
  id,
  kind: MIC_RESTORED_KIND,
  at: iso(atMs),
  payload: { reason },
});

const chunk = (idx: number, startMs: number, endMs: number, source: "primary" | "backup"): RangeChunk => ({
  idx,
  source,
  r2_key: `bench/${source}_chunk_${idx}.webm`,
  content_type: "audio/webm",
  started_at: iso(startMs),
  ended_at: iso(endMs),
  upload_state: "verified",
});

/** The tape: five-minute pieces on both mics, 13:00 → 13:20 IST. */
const TAPE_END = T0 + min(20);

const decide = (opts: { requested?: "primary" | "backup" | null; events: MicEventRow[]; startMs: number; endMs: number; tapeEndMs?: number | null }) =>
  decideSource({
    requested: opts.requested ?? null,
    events: opts.events,
    tapeEndMs: opts.tapeEndMs === undefined ? TAPE_END : opts.tapeEndMs,
    startMs: opts.startMs,
    endMs: opts.endMs,
  });

describe("1 — a window clear of any loss uses the primary", () => {
  it("no mic events at all: the primary, as now", () => {
    const d = decide({ events: [], startMs: T0 + min(2), endMs: T0 + min(6) });
    expect(d.source).toBe("primary");
    expect(d.auto_switched).toBe(false);
    expect(d.reason).toBeNull();
    expect(d.overlaps).toEqual([]);
    expect(sourceAnswer(d)).toEqual({ source_used: "primary", source_requested: "unspecified" });
  });

  it("a loss elsewhere on the tape does not reach this window", () => {
    const events = [lost("be_l1", T0 + min(10)), restored("be_r1", T0 + min(12))];
    const d = decide({ events, startMs: T0 + min(2), endMs: T0 + min(6) });
    expect(d.source).toBe("primary");
    expect(d.auto_switched).toBe(false);
    // The interval exists; this window simply does not meet it.
    expect(buildPrimaryLostIntervals(events, TAPE_END)).toHaveLength(1);
  });
});

describe("2 — a window overlapping a loss uses the backup and says why", () => {
  const events = [lost("be_l1", T0 + min(10), "track_ended"), restored("be_r1", T0 + min(12))];

  it("switches to the backup", () => {
    const d = decide({ events, startMs: T0 + min(9), endMs: T0 + min(14) });
    expect(d.source).toBe("backup");
    expect(d.auto_switched).toBe(true);
    expect(d.reason).toBe("primary_lost");
  });

  it("reports the reason, the interval it met, and by how much", () => {
    const d = decide({ events, startMs: T0 + min(9), endMs: T0 + min(14) });
    const a = sourceAnswer(d) as Record<string, any>;
    expect(a.source_used).toBe("backup");
    expect(a.source_requested).toBe("unspecified");
    expect(a.reason).toBe("primary_lost");
    // which lost interval the window met …
    expect(a.primary_lost.interval.from).toBe(iso(T0 + min(10)));
    expect(a.primary_lost.interval.to).toBe(iso(T0 + min(12)));
    expect(a.primary_lost.interval.open_to_tape_end).toBe(false);
    expect(a.primary_lost.interval.reason).toBe("track_ended");
    expect(a.primary_lost.interval.backup).toBe("active");
    expect(a.primary_lost.interval.lost_event_id).toBe("be_l1");
    expect(a.primary_lost.interval.restored_event_id).toBe("be_r1");
    // … and by how much: the whole two-minute loss falls inside the window.
    expect(a.primary_lost.overlap).toEqual({ from: iso(T0 + min(10)), to: iso(T0 + min(12)), ms: min(2), seconds: 120 });
    expect(a.primary_lost.intervals_met).toBe(1);
  });

  it("a window landing inside the loss overlaps by its own length", () => {
    const d = decide({ events, startMs: T0 + min(10) + 30_000, endMs: T0 + min(11) });
    const a = sourceAnswer(d) as Record<string, any>;
    expect(d.source).toBe("backup");
    expect(a.primary_lost.overlap.ms).toBe(30_000);
  });

  it("meeting two separate losses names the first and counts both", () => {
    const two = [lost("be_l1", T0 + min(4)), restored("be_r1", T0 + min(5)), lost("be_l2", T0 + min(8)), restored("be_r2", T0 + min(9))];
    const d = decide({ events: two, startMs: T0 + min(3), endMs: T0 + min(10) });
    const a = sourceAnswer(d) as Record<string, any>;
    expect(d.source).toBe("backup");
    expect(a.primary_lost.interval.lost_event_id).toBe("be_l1");
    expect(a.primary_lost.intervals_met).toBe(2);
  });
});

describe("3 — touching a loss by one millisecond counts as overlapping", () => {
  const events = [lost("be_l1", T0 + min(10)), restored("be_r1", T0 + min(12))];

  it("one millisecond into the loss: backup", () => {
    const d = decide({ events, startMs: T0 + min(8), endMs: T0 + min(10) + 1 });
    expect(d.source).toBe("backup");
    expect(d.overlaps[0]!.ms).toBe(1);
  });

  it("one millisecond before the loss opens: primary, untouched", () => {
    const d = decide({ events, startMs: T0 + min(8), endMs: T0 + min(10) });
    expect(d.source).toBe("primary");
  });

  it("the trailing edge behaves the same way", () => {
    // A window starting one millisecond before the restore still meets the loss …
    expect(decide({ events, startMs: T0 + min(12) - 1, endMs: T0 + min(15) }).source).toBe("backup");
    // … and one starting exactly at the restore does not.
    expect(decide({ events, startMs: T0 + min(12), endMs: T0 + min(15) }).source).toBe("primary");
  });
});

describe("4 — an unpaired loss holds open to the end of the tape", () => {
  // The live shape: bs_wy5yjj7a ends on a loss at 13:44:51.917 with the tape running to 13:46:03.
  const LOSS = Date.parse("2026-08-19T08:14:51.917Z"); // 13:44:51.917 IST
  const TAPE = Date.parse("2026-08-19T08:16:03.000Z"); // 13:46:03 IST
  const events = [lost("be_open", LOSS, "track_ended")];

  it("the interval runs from the loss to the last piece recorded, not to the loss itself", () => {
    const [iv, ...rest] = buildPrimaryLostIntervals(events, TAPE);
    expect(rest).toEqual([]);
    expect(iv!.from).toBe(iso(LOSS));
    expect(iv!.to).toBe(iso(TAPE));
    expect(iv!.open_to_tape_end).toBe(true);
    expect(iv!.restored_event_id).toBeNull();
  });

  it("a window in the minutes after the loss uses the backup", () => {
    const d = decide({ events, startMs: LOSS + 1_000, endMs: TAPE, tapeEndMs: TAPE });
    expect(d.source).toBe("backup");
    const a = sourceAnswer(d) as Record<string, any>;
    expect(a.primary_lost.interval.open_to_tape_end).toBe(true);
    expect(a.primary_lost.overlap.ms).toBe(TAPE - LOSS - 1_000);
  });

  it("it is not tidied away when the tape end is unknown — it just cannot be met", () => {
    const [iv] = buildPrimaryLostIntervals(events, null);
    expect(iv!.open_to_tape_end).toBe(true);
    expect(iv!.from_ms).toBe(LOSS);
    expect(iv!.to_ms).toBe(LOSS);
    expect(decide({ events, startMs: LOSS + 1_000, endMs: TAPE, tapeEndMs: null }).source).toBe("primary");
  });

  it("a loss, a restore, then a second unpaired loss: two intervals, the last one open", () => {
    const mixed = [lost("be_l1", T0 + min(4)), restored("be_r1", T0 + min(5)), lost("be_l2", T0 + min(18))];
    const ivs = buildPrimaryLostIntervals(mixed, TAPE_END);
    expect(ivs.map((i) => i.open_to_tape_end)).toEqual([false, true]);
    expect(ivs[1]!.to).toBe(iso(TAPE_END));
  });
});

describe("5 — naming primary over a lost window returns the primary anyway", () => {
  const events = [lost("be_l1", T0 + min(10)), restored("be_r1", T0 + min(12))];

  it("a stated choice is never overridden", () => {
    const d = decide({ requested: "primary", events, startMs: T0 + min(9), endMs: T0 + min(14) });
    expect(d.source).toBe("primary");
    expect(d.auto_switched).toBe(false);
    expect(d.reason).toBeNull();
    expect(sourceAnswer(d)).toEqual({ source_used: "primary", source_requested: "primary" });
  });

  it("the events are not consulted at all when a microphone is named", () => {
    const withEvents = decide({ requested: "primary", events, startMs: T0 + min(9), endMs: T0 + min(14) });
    const without = decide({ requested: "primary", events: [], startMs: T0 + min(9), endMs: T0 + min(14) });
    expect(withEvents).toEqual(without);
  });
});

describe("6 — naming backup returns the backup anyway", () => {
  it("even on a window with no loss anywhere near it", () => {
    const d = decide({ requested: "backup", events: [], startMs: T0 + min(2), endMs: T0 + min(6) });
    expect(d.source).toBe("backup");
    expect(d.auto_switched).toBe(false);
    expect(sourceAnswer(d)).toEqual({ source_used: "backup", source_requested: "backup" });
  });
});

describe("7 — with no backup pieces, a lost window fails cleanly rather than falling back to silence", () => {
  // bs_8temrdqh, labelled "mic stopped working": a primary stream and nothing else.
  const primaryOnly = [chunk(0, T0, T0 + min(5), "primary"), chunk(1, T0 + min(5), T0 + min(10), "primary"), chunk(2, T0 + min(10), T0 + min(15), "primary")];
  const events = [lost("be_l1", T0 + min(10))];

  it("the decision still reaches for the backup — the events decide, not the pieces", () => {
    const d = decide({ events, startMs: T0 + min(11), endMs: T0 + min(13), tapeEndMs: T0 + min(15) });
    expect(d.source).toBe("backup");
    expect(d.reason).toBe("primary_lost");
  });

  it("and the range resolver finds none, which is no_audio_in_range — not the primary's silence", () => {
    const d = decide({ events, startMs: T0 + min(11), endMs: T0 + min(13), tapeEndMs: T0 + min(15) });
    expect(resolveRange(primaryOnly, T0 + min(11), T0 + min(13), d.source).kind).toBe("none");
    // The same window on the primary would have answered with silence. Naming it is the only
    // way to get that, and the answer still says which microphone it used.
    const named = decide({ requested: "primary", events, startMs: T0 + min(11), endMs: T0 + min(13) });
    expect(resolveRange(primaryOnly, T0 + min(11), T0 + min(13), named.source).kind).toBe("single");
  });

  it("with a backup stream present the same window resolves against it", () => {
    const both = [...primaryOnly, chunk(0, T0 + min(10), T0 + min(15), "backup")];
    const d = decide({ events, startMs: T0 + min(11), endMs: T0 + min(13), tapeEndMs: T0 + min(15) });
    const res = resolveRange(both, T0 + min(11), T0 + min(13), d.source);
    expect(res.kind).toBe("single");
    if (res.kind === "single") expect(res.covering.chunk.source).toBe("backup");
  });
});

describe("8 — two events 131 ms apart order correctly and produce one interval, not two", () => {
  const LOSS = Date.parse("2026-08-19T08:10:00.000Z");
  const RESTORE = LOSS + 131;

  it("one interval of 131 ms, however the rows arrive", () => {
    for (const events of [
      [lost("be_l1", LOSS), restored("be_r1", RESTORE)],
      [restored("be_r1", RESTORE), lost("be_l1", LOSS)], // out of order off the wire
    ]) {
      const ivs = buildPrimaryLostIntervals(events, TAPE_END);
      expect(ivs).toHaveLength(1);
      expect(ivs[0]!.from_ms).toBe(LOSS);
      expect(ivs[0]!.to_ms).toBe(RESTORE);
      expect(ivs[0]!.open_to_tape_end).toBe(false);
      expect(ivs[0]!.to_ms - ivs[0]!.from_ms).toBe(131);
    }
  });

  it("a window over those 131 ms uses the backup", () => {
    const d = decide({ events: [lost("be_l1", LOSS), restored("be_r1", RESTORE)], startMs: LOSS - min(1), endMs: RESTORE + min(1) });
    expect(d.source).toBe("backup");
    expect(d.overlaps[0]!.ms).toBe(131);
  });

  it("a lost and a restore in the SAME millisecond still pair — kind breaks the tie, not the random id", () => {
    // Event ids are nanoid, so id order is arbitrary; ordering on time alone is not total.
    const ivs = buildPrimaryLostIntervals([restored("be_aaa", LOSS), lost("be_zzz", LOSS)], TAPE_END);
    expect(ivs).toHaveLength(1);
    expect(ivs[0]!.open_to_tape_end).toBe(false);
    expect(ivs[0]!.lost_event_id).toBe("be_zzz");
  });

  it("a second loss while already down does not open a second interval", () => {
    const ivs = buildPrimaryLostIntervals(
      [lost("be_l1", T0 + min(4)), lost("be_l2", T0 + min(5)), restored("be_r1", T0 + min(7))],
      TAPE_END,
    );
    expect(ivs).toHaveLength(1);
    expect(ivs[0]!.from_ms).toBe(T0 + min(4));
    expect(ivs[0]!.to_ms).toBe(T0 + min(7));
  });

  it("a restore that closes nothing is ignored", () => {
    expect(buildPrimaryLostIntervals([restored("be_r1", T0 + min(3))], TAPE_END)).toEqual([]);
    expect(findLostOverlaps([], T0, T0 + min(20))).toEqual([]);
  });
});
