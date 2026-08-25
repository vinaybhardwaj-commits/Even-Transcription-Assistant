/**
 * tests/unit/bench-window.test.ts — K4a Part A, the pure half.
 *
 * The rules that decide whether a window may close are the ones worth testing hardest, because
 * a window that closes early is a window K4b will transcribe as if it were whole. A2 in one
 * line: the SPAN must be covered, not merely "the chunks present are verified".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { subjectLabel } from "@/lib/stt/subject";
import {
  WINDOW_MS,
  slotStartFor,
  gridSlotsFor,
  coverageOf,
  runIntervals,
  evaluateWindows,
  istDateOf,
  type WindowChunk,
} from "@/lib/bench-window";
import type { MicEventRow } from "@/lib/bench-source";

const T = (iso: string) => Date.parse(iso);
/** An IST wall-clock instant, as UTC ms. IST = UTC+05:30. */
const IST = (ymd: string, hhmm: string) => Date.parse(`${ymd}T${hhmm}:00.000+05:30`);

const chunk = (o: Partial<WindowChunk> & { started_at: string; ended_at: string }): WindowChunk => ({
  idx: 0,
  source: "primary",
  upload_state: "verified",
  ...o,
});

describe("the grid is aligned in IST, and lands on the clinic quarter hour", () => {
  it("slots start on the IST quarter hour: 00, 15, 30, 45", () => {
    for (const [at, want] of [
      ["10:07", "10:00"],
      ["10:15", "10:15"],
      ["10:29", "10:15"],
      ["10:44", "10:30"],
      ["10:45", "10:45"],
    ] as const) {
      expect(slotStartFor(IST("2026-08-22", at))).toBe(IST("2026-08-22", want));
    }
  });

  it("at 15 minutes the IST floor and the UTC floor AGREE — 05:30 is exactly 22 slots", () => {
    // Recording the no-op explicitly: +05:30 = 19 800 000 ms = 22 x WINDOW_MS, so the offset
    // cancels. The IST arithmetic in slotStartFor is intent, not correction, and this test
    // exists so nobody removes it believing it currently changes an answer.
    expect(5.5 * 3_600_000 % WINDOW_MS).toBe(0);
    const inside = IST("2026-08-22", "10:15") + 60_000;
    expect(Math.floor(inside / WINDOW_MS) * WINDOW_MS).toBe(slotStartFor(inside));
  });

  it("…but at a slot size that does NOT divide 05:30, the two diverge — which is the case the IST arithmetic is for", () => {
    const HOUR = 3_600_000;
    const at = IST("2026-08-22", "10:15");
    const istFloor = Math.floor((at + 5.5 * HOUR) / HOUR) * HOUR - 5.5 * HOUR;
    const utcFloor = Math.floor(at / HOUR) * HOUR;
    expect(istFloor).not.toBe(utcFloor);
    expect(new Date(istFloor).toISOString()).toBe("2026-08-22T04:30:00.000Z"); // 10:00 IST
    expect(new Date(utcFloor).toISOString()).toBe("2026-08-22T04:00:00.000Z"); // 09:30 IST
  });

  it("a span touching two slots yields both — overlap, not containment", () => {
    const slots = gridSlotsFor(IST("2026-08-22", "10:14"), IST("2026-08-22", "10:19"));
    expect(slots.map((s) => s.start_ms)).toEqual([IST("2026-08-22", "10:00"), IST("2026-08-22", "10:15")]);
  });

  it("a 5-minute chunk wholly inside one slot yields exactly one", () => {
    expect(gridSlotsFor(IST("2026-08-22", "10:16"), IST("2026-08-22", "10:21"))).toHaveLength(1);
  });

  it("degenerate spans yield nothing rather than throwing", () => {
    expect(gridSlotsFor(100, 100)).toEqual([]);
    expect(gridSlotsFor(200, 100)).toEqual([]);
    expect(gridSlotsFor(NaN, 100)).toEqual([]);
  });

  it("istDateOf uses the IST calendar day, so 23:00 UTC is already tomorrow", () => {
    expect(istDateOf(T("2026-08-22T18:29:59.000Z"))).toBe("2026-08-22");
    expect(istDateOf(T("2026-08-22T18:30:00.000Z"))).toBe("2026-08-23");
  });
});

describe("coverage measures the SPAN, and merges overlaps", () => {
  it("full cover leaves no gap", () => {
    expect(coverageOf([{ from: 0, to: 100 }], 0, 100)).toEqual({ covered_ms: 100, gaps: [] });
  });
  it("a hole in the middle is reported", () => {
    const c = coverageOf([{ from: 0, to: 40 }, { from: 60, to: 100 }], 0, 100);
    expect(c.covered_ms).toBe(80);
    expect(c.gaps).toEqual([{ from: 40, to: 60 }]);
  });
  it("overlapping intervals count ONCE — a handover must not fake 100%", () => {
    const c = coverageOf([{ from: 0, to: 60 }, { from: 50, to: 100 }], 0, 100);
    expect(c.covered_ms).toBe(100);
    expect(c.gaps).toEqual([]);
  });
  it("a short tail is a gap at the END, which is how a live slot stays open", () => {
    const c = coverageOf([{ from: 0, to: 40 }], 0, 100);
    expect(c.gaps).toEqual([{ from: 40, to: 100 }]);
  });
});

describe("A2 — a window closes only when its whole span is verified", () => {
  const slotStart = IST("2026-08-22", "10:00");
  const iso = (n: number) => new Date(n).toISOString();
  /** three 5-minute chunks exactly covering the 10:00–10:15 IST slot */
  const full = [0, 1, 2].map((i) =>
    chunk({ idx: i, started_at: iso(slotStart + i * 300_000), ended_at: iso(slotStart + (i + 1) * 300_000) }),
  );

  it("fully covered and all verified → complete", () => {
    const [w] = evaluateWindows({ chunks: full, events: [], tapeEndMs: slotStart + WINDOW_MS });
    expect(w!.complete).toBe(true);
    expect(w!.covered_ms).toBe(WINDOW_MS);
    expect(w!.gaps).toEqual([]);
  });

  it("ONE chunk not yet verified → NOT complete, and the index is named", () => {
    const partial = full.map((c, i) => (i === 1 ? { ...c, upload_state: "pending" } : c));
    const [w] = evaluateWindows({ chunks: partial, events: [], tapeEndMs: slotStart + WINDOW_MS });
    expect(w!.complete).toBe(false);
    expect(w!.unverified_idx).toEqual([1]);
    expect(w!.gaps).toHaveLength(1);
  });

  it("a MISSING chunk leaves a hole → NOT complete. The window is never shortened to fit.", () => {
    const [w] = evaluateWindows({ chunks: [full[0]!, full[2]!], events: [], tapeEndMs: slotStart + WINDOW_MS });
    expect(w!.complete).toBe(false);
    // covered 10 of the 15 minutes — and it reports 15, not 10, as its span
    expect(w!.covered_ms).toBe(600_000);
    expect(w!.end_ms - w!.start_ms).toBe(WINDOW_MS);
  });

  it("a live tape that has not reached the slot end leaves it open", () => {
    const [w] = evaluateWindows({ chunks: [full[0]!], events: [], tapeEndMs: slotStart + 300_000 });
    expect(w!.complete).toBe(false);
  });

  it("the trailing slot of an ENDED session stays open for ever, deliberately", () => {
    // audio stops 4 minutes into the 10:15 slot and never resumes
    const tail = chunk({ idx: 3, started_at: iso(slotStart + WINDOW_MS), ended_at: iso(slotStart + WINDOW_MS + 240_000) });
    const ws = evaluateWindows({ chunks: [...full, tail], events: [], tapeEndMs: slotStart + WINDOW_MS + 240_000 });
    expect(ws).toHaveLength(2);
    expect(ws[0]!.complete).toBe(true);    // 10:00 slot is whole
    expect(ws[1]!.complete).toBe(false);   // 10:15 slot holds 4 minutes of 15 and says so
    expect(ws[1]!.covered_ms).toBe(240_000);
  });
});

describe("a rotation seam is not a missing chunk — the bs_g3dwud4p lesson", () => {
  const slotStart = IST("2026-08-22", "10:00");
  const iso = (n: number) => new Date(n).toISOString();

  /** Three chunks tiling the slot with a realistic 1–3 ms seam between rotations. */
  const seamed = [
    chunk({ idx: 0, started_at: iso(slotStart),               ended_at: iso(slotStart + 300_000) }),
    chunk({ idx: 1, started_at: iso(slotStart + 300_002),     ended_at: iso(slotStart + 600_001) }),
    chunk({ idx: 2, started_at: iso(slotStart + 600_004),     ended_at: iso(slotStart + 900_000) }),
  ];

  it("1–4 ms seams between CONSECUTIVE indices do not hold a window open", () => {
    const [w] = evaluateWindows({ chunks: seamed, events: [], tapeEndMs: slotStart + WINDOW_MS });
    expect(w!.complete).toBe(true);
    expect(w!.gaps).toEqual([]);
  });

  it("…and this is exactly what the first real run got wrong: 899 998 of 900 000 held it open", () => {
    // The raw-interval measurement the writer used first. Kept as the counter-example.
    const raw = coverageOf(seamed.map((c) => ({ from: Date.parse(String(c.started_at)), to: Date.parse(String(c.ended_at)) })), slotStart, slotStart + WINDOW_MS);
    expect(raw.gaps.length).toBeGreaterThan(0);
    expect(raw.covered_ms).toBeLessThan(WINDOW_MS);
    // …versus the run-merged measurement, which is whole.
    expect(coverageOf(runIntervals(seamed), slotStart, slotStart + WINDOW_MS).gaps).toEqual([]);
  });

  it("a MISSING INDEX is still caught — this is not a tolerance", () => {
    const missing = [seamed[0]!, seamed[2]!];   // idx 0 and 2; idx 1 never arrived
    const [w] = evaluateWindows({ chunks: missing, events: [], tapeEndMs: slotStart + WINDOW_MS });
    expect(w!.complete).toBe(false);
    // the hole is the whole of the absent chunk, not a millisecond
    expect(w!.gaps).toHaveLength(1);
    expect(w!.gaps[0]!.to - w!.gaps[0]!.from).toBeGreaterThan(290_000);
  });

  it("a tape that STARTS mid-slot leaves a real head gap, and that window stays open", () => {
    const late = [chunk({ idx: 0, started_at: iso(slotStart + 33_544), ended_at: iso(slotStart + 900_000) })];
    const [w] = evaluateWindows({ chunks: late, events: [], tapeEndMs: slotStart + WINDOW_MS });
    expect(w!.complete).toBe(false);
    expect(w!.gaps[0]).toEqual({ from: slotStart, to: slotStart + 33_544 });
  });

  it("runIntervals merges a consecutive run and splits on a break", () => {
    expect(runIntervals(seamed)).toEqual([{ from: slotStart, to: slotStart + 900_000 }]);
    expect(runIntervals([seamed[0]!, seamed[2]!])).toHaveLength(2);
  });
});

describe("A3 — the source is decided, never hard-coded", () => {
  const slotStart = IST("2026-08-22", "10:00");
  const iso = (n: number) => new Date(n).toISOString();
  const both = (state = "verified"): WindowChunk[] => [
    ...[0, 1, 2].map((i) => chunk({ idx: i, source: "primary", upload_state: state, started_at: iso(slotStart + i * 300_000), ended_at: iso(slotStart + (i + 1) * 300_000) })),
    ...[0, 1, 2].map((i) => chunk({ idx: i, source: "backup", started_at: iso(slotStart + i * 300_000), ended_at: iso(slotStart + (i + 1) * 300_000) })),
  ];

  it("with no mic events it picks primary, and writes ONE row for the slot, not one per mic", () => {
    const ws = evaluateWindows({ chunks: both(), events: [], tapeEndMs: slotStart + WINDOW_MS });
    expect(ws).toHaveLength(1);
    expect(ws[0]!.source_mic).toBe("primary");
  });

  /**
   * BUILD 2 §2.4 — THE INVERSE OF THE TEST THIS REPLACES, and the reason the whole rule changed.
   *
   * It used to assert that a `mic_primary_lost` / `mic_primary_restored` pair over a slot moved
   * that slot to the BACKUP microphone. That is the bug, exactly as it happened: Cardiology's
   * false silence trip at 12:25 opened an interval nothing ever closed, so every remaining window
   * of the day — sixteen of twenty — bound to the spare while the main microphone was recording
   * perfectly. On a rig with no spare, or one writing near-silence, the same fault would have
   * handed four hours of consultation to an empty microphone and returned nothing.
   *
   * A FLAG NOW MOVES NOTHING (D33). Only the device being reported gone, or two consecutive
   * full-length pieces coming back tiny while the meter heard sound (D37), can move a window —
   * and even then only onto a spare proven healthy on its own pieces.
   */
  it("§2.4 — a primary-lost FLAG alone does NOT move the slot to the spare", () => {
    const events: MicEventRow[] = [
      { id: "e1", kind: "mic_primary_lost", at: iso(slotStart - 60_000) },
      { id: "e2", kind: "mic_primary_restored", at: iso(slotStart + WINDOW_MS + 60_000) },
    ];
    const ws = evaluateWindows({ chunks: both(), events, tapeEndMs: slotStart + WINDOW_MS });
    expect(ws).toHaveLength(1);
    expect(ws[0]!.source_mic).toBe("primary");
    expect(ws[0]!.bind_reason).toBe("default_main");
  });

  it("§2.4 — an UNCLOSED loss (the Cardiology shape) still does not move it", () => {
    // No restore at all: the old rule held the interval open to the end of the tape, which is
    // what bound sixteen of twenty windows.
    const events: MicEventRow[] = [{ id: "e1", kind: "mic_primary_lost", at: iso(slotStart - 60_000), payload: { reason: "silence" } }];
    const ws = evaluateWindows({ chunks: both(), events, tapeEndMs: slotStart + WINDOW_MS });
    expect(ws[0]!.source_mic).toBe("primary");
  });

  it("§2.4 — the DEVICE reported gone moves it, but only onto a spare with real pieces", () => {
    const events: MicEventRow[] = [{ id: "e1", kind: "mic_primary_lost", at: iso(slotStart - 60_000), payload: { reason: "track_ended" } }];
    const ws = evaluateWindows({ chunks: both(), events, tapeEndMs: slotStart + WINDOW_MS });
    expect(ws[0]!.source_mic).toBe("backup");
    // These fixture pieces carry no size or level, so the spare's health is UNPROVEN rather than
    // established — and once the main is proven dead the spare is the only tape there is, so it
    // is used and the reason says so. Refusing an unmeasurable spare here would discard the only
    // recording of those minutes to satisfy a word.
    expect(ws[0]!.bind_reason).toBe("main_dead_spare_unmeasured");
    // and completeness is then judged against the BACKUP lane
    expect(ws[0]!.complete).toBe(true);
  });

  it("§2.4 — a dead device with NO spare lane keeps the audio on the main, and says so", () => {
    // D32: most rooms have one microphone. There is nothing to move to, and inventing a spare
    // lane would hand the room a window that resolves to no audio at all.
    const mainOnly = [0, 1, 2].map((i) =>
      chunk({ idx: i, source: "primary", upload_state: "verified", started_at: iso(slotStart + i * 300_000), ended_at: iso(slotStart + (i + 1) * 300_000) }),
    );
    const events: MicEventRow[] = [{ id: "e1", kind: "mic_primary_lost", at: iso(slotStart - 60_000), payload: { reason: "track_ended" } }];
    const ws = evaluateWindows({ chunks: mainOnly, events, tapeEndMs: slotStart + WINDOW_MS });
    expect(ws[0]!.source_mic).toBe("primary");
    expect(ws[0]!.bind_reason).toBe("main_dead_no_healthy_spare");
  });

  it("when the slot IS a backup window, an unverified PRIMARY chunk is irrelevant to it", () => {
    const events: MicEventRow[] = [{ id: "e1", kind: "mic_primary_lost", at: iso(slotStart - 60_000), payload: { reason: "track_ended" } }];
    const ws = evaluateWindows({ chunks: both("pending"), events, tapeEndMs: slotStart + WINDOW_MS });
    expect(ws[0]!.source_mic).toBe("backup");
    expect(ws[0]!.complete).toBe(true);
    expect(ws[0]!.unverified_idx).toEqual([]);
  });
});

describe("the writer is pure and total", () => {
  it("no chunks → no windows, no throw", () => {
    expect(evaluateWindows({ chunks: [], events: [], tapeEndMs: null })).toEqual([]);
  });
  it("same input, same output", () => {
    const slotStart = IST("2026-08-22", "09:00");
    const iso = (n: number) => new Date(n).toISOString();
    const cs = [0, 1].map((i) => chunk({ idx: i, started_at: iso(slotStart + i * 300_000), ended_at: iso(slotStart + (i + 1) * 300_000) }));
    const a = evaluateWindows({ chunks: cs, events: [], tapeEndMs: slotStart + 600_000 });
    const b = evaluateWindows({ chunks: cs, events: [], tapeEndMs: slotStart + 600_000 });
    expect(a).toEqual(b);
  });
  it("slots come back in ascending time order regardless of chunk order", () => {
    const s0 = IST("2026-08-22", "10:00"), s1 = IST("2026-08-22", "10:15");
    const iso = (n: number) => new Date(n).toISOString();
    const cs = [
      chunk({ idx: 3, started_at: iso(s1), ended_at: iso(s1 + 300_000) }),
      chunk({ idx: 0, started_at: iso(s0), ended_at: iso(s0 + 300_000) }),
    ];
    const ws = evaluateWindows({ chunks: cs, events: [], tapeEndMs: s1 + 300_000 });
    expect(ws.map((w) => w.start_ms)).toEqual([s0, s1]);
  });
});

describe("the span comes from the chunks, never from session.ended_at", () => {
  it("bs_g3dwud4p's shape: audio continues long past a wrongly-stamped end", () => {
    // The real row: reaper stamped ended_at 19:00:36Z; chunks ran to 00:58:46Z. The evaluator
    // is given only chunks, so a nine-hour tape produces nine hours of windows.
    const start = T("2026-08-22T16:00:33.000Z");
    const iso = (n: number) => new Date(n).toISOString();
    const chunks = Array.from({ length: 108 }, (_, i) =>
      chunk({ idx: i, started_at: iso(start + i * 300_000), ended_at: iso(start + (i + 1) * 300_000) }),
    );
    const ws = evaluateWindows({ chunks, events: [], tapeEndMs: start + 108 * 300_000 });
    const spanMs = ws[ws.length - 1]!.end_ms - ws[0]!.start_ms;
    expect(spanMs).toBeGreaterThan(8.5 * 3_600_000);   // nine hours of grid, not three
    // and the source file must not even mention reading that column
    // (asserted in the reader test below rather than by grepping here)
    expect(ws.length).toBeGreaterThanOrEqual(36);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// K4a C3 — the subject label must not become a back door onto the patient label.
// ─────────────────────────────────────────────────────────────────────────────────────────
describe("C3 — subjectLabel is identity-gated by its CALLER, and says so", () => {
  it("given a patient label it uses it — which is why an un-identified caller must not pass one", () => {
    expect(subjectLabel({ subject_type: "encounter", subject_id: "enc_1", patient_label_raw: "Mrs A" })).toBe("Mrs A");
    // …and with it withheld it falls back to the id, never to "undefined"
    expect(subjectLabel({ subject_type: "encounter", subject_id: "enc_1" })).toBe("enc_1");
    expect(subjectLabel({ subject_type: "encounter", subject_id: "enc_1", patient_label_raw: undefined })).toBe("enc_1");
  });

  it("a blank or whitespace label is treated as absent, not rendered", () => {
    expect(subjectLabel({ subject_type: "encounter", subject_id: "enc_1", patient_label_raw: "   " })).toBe("enc_1");
  });

  it("a room window names its clock and mic, and has no patient label to leak", () => {
    const s = 1787414400000; // an IST quarter hour
    const label = subjectLabel({ subject_type: "bench_window", subject_id: "bw_x", window_start_ms: s, window_end_ms: s + 900_000 });
    expect(label).toMatch(/^\d\d:\d\d–\d\d:\d\d IST$/);
    expect(subjectLabel({ subject_type: "bench_window", subject_id: "bw_x", window_start_ms: s, window_end_ms: s + 900_000, window_source_mic: "backup" })).toContain("backup mic");
  });

  it("the MCP tools build the label WITHOUT the patient label unless include_identity", () => {
    const src = readFileSync("lib/mcp/tools/stt.ts", "utf8");
    expect(src).toContain("patient_label_raw: includeIdentity ? patient_label_raw : undefined");
    expect((src.match(/includeIdentity \? patient_label_raw : undefined/g) ?? []).length).toBe(2);
  });
});
