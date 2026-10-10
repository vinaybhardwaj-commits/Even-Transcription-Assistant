/** fusion-timeline (epic #23 f): every end rank, both vetoes, late click, late start, disjoint, with mutation controls. */
import { describe, it, expect } from "vitest";
import {
  fuseSegment, disjoint, acousticClose, END_CONTINUES, type RowFact, type JevReading, type SegmentFusionInput,
} from "@/lib/encounter-clock/fusion-timeline";
import { relLabel, type RowMeta } from "@/lib/encounter-clock/timeline";
import type { Anchor } from "@/lib/encounter-clock/anchors";

const S = 1_790_000_000_000; // anchor start
const MIN = 60_000;
const PRE = 60_000; // PRD: Start = Pulse t_open − 60 s (literal, not imported)
const anchor = (o: Partial<Anchor> = {}): Anchor => ({
  consult_key: "c1", room_id: "room_fake1", start_ms: S, close_kind: "open", end_clicked: false, end_click_ms: null, end_weak_ms: null,
  end_weak_kind: null, next_start_ms: null, doctor_uid_warehouse: "d1", doctor_uid_ext: null, doctor_source: "warehouse",
  quality: "ok" as never, weak_start: false, ...o,
});
/** 30 s rows from S-60s; `speechUntil` = minutes of active speech from S; after that quiet. */
function scenario(speechUntilMin: number, totalMin = 40, o: { docOnlyTailMin?: number } = {}) {
  const rows: RowFact[] = [], meta: RowMeta[] = [];
  for (let a = S - PRE; a < S + totalMin * MIN; a += 30_000) {
    const speaking = a >= S && a < S + speechUntilMin * MIN;
    const docTail = o.docOnlyTailMin != null && a >= S + speechUntilMin * MIN && a < S + (speechUntilMin + o.docOnlyTailMin) * MIN;
    rows.push({ start_ms: a, end_ms: a + 30_000, sound: speaking || docTail ? "active" : "quiet", speech_s: speaking ? 25 : docTail ? 20 : 0, doc_s: speaking ? 15 : docTail ? 20 : 0, other_s: speaking ? 10 : 0, voices: speaking ? ["DOC", "B"] : docTail ? ["DOC"] : [] });
    meta.push({ t: relLabel(a - S), start_ms: a, end_ms: a + 30_000, probe_first: null, probe_last: null });
  }
  const speech = [{ start_ms: S, end_ms: S + speechUntilMin * MIN + (o.docOnlyTailMin ?? 0) * MIN }];
  const doc = [{ start_ms: S, end_ms: S + (speechUntilMin + (o.docOnlyTailMin ?? 0)) * MIN }];
  return { rows, meta, speech, doc };
}
const run = (a: Anchor, jev: JevReading | null, sc = scenario(10), over: Partial<SegmentFusionInput> = {}) =>
  fuseSegment({ anchor: a, meta: sc.meta, rows: sc.rows, speech: sc.speech, doc_speech: sc.doc, jev, ...over });
const jev = (o: Partial<JevReading> = {}): JevReading => ({ end_row: null, end_conf: null, late_start_p: null, kind: null, kind_conf: null, ...o });

describe("start", () => {
  it("is the Pulse Start minus 60 s", () => expect(run(anchor(), null).start_ms).toBe(S - PRE));
  it("moves later only at late_start_p >= 0.9 with a doctor+other row", () => {
    const sc = scenario(10);
    // delay the conversation: nobody talks for the first 4 minutes
    sc.rows.forEach((r) => { if (r.start_ms < S + 4 * MIN) { r.speech_s = 0; r.doc_s = 0; r.other_s = 0; } });
    const late = run(anchor(), jev({ late_start_p: 0.95 }), sc);
    expect(late.start_ms).toBe(S + 4 * MIN);
    expect(late.counts.late_start_applied).toBe(1);
    expect(run(anchor(), jev({ late_start_p: 0.89 }), sc).start_ms).toBe(S - PRE);
  });
  it("is refused (and counted) when there is no doctor+other speech to move to", () => {
    const sc = scenario(10);
    sc.rows.forEach((r) => { r.other_s = 0; });
    const r = run(anchor(), jev({ late_start_p: 0.99 }), sc);
    expect(r.start_ms).toBe(S - PRE);
    expect(r.counts.late_start_refused).toBe(1);
  });
});

describe("end ranks", () => {
  it("1: an End click within 2 min of the last speech → pulse_end", () => {
    const r = run(anchor({ end_click_ms: S + 11 * MIN, end_clicked: true }), null);
    expect(r).toMatchObject({ rank: 1, closed_by: "pulse_end", origin: "anchor", end_ms: S + 11 * MIN });
  });
  it("1 mutation: a click 3 min from the last speech is not rank 1", () => {
    expect(run(anchor({ end_click_ms: S + 13 * MIN + 1 }), null).rank).not.toBe(1);
  });
  it("a click after the next Start is late: counted, never rank 1", () => {
    const r = run(anchor({ end_click_ms: S + 11 * MIN, next_start_ms: S + 10.5 * MIN }), null);
    expect(r.rank).not.toBe(1);
    expect(r.counts.click_late).toBe(1);
  });
  it("a click more than 10 min past the last speech is late", () => {
    const r = run(anchor({ end_click_ms: S + 25 * MIN }), null);
    expect(r.counts.click_late).toBe(1);
    expect(r.rank).not.toBe(1);
  });
  it("2: Jev's end row at 0.9, snapped to the last diarized speech in the row", () => {
    const sc = scenario(10);
    const row = sc.meta.find((m) => m.start_ms === S + 9 * MIN + 30_000)!;
    // speech ends 10 min after S, i.e. in the NEXT row's start; pick the row that contains the end
    const endRow = sc.meta.find((m) => m.start_ms === S + 9 * MIN + 30_000)!;
    const r = run(anchor(), jev({ end_row: endRow.t, end_conf: 0.92 }), sc);
    expect(row).toBeTruthy();
    expect(r).toMatchObject({ rank: 2, closed_by: "jev_end", origin: "jev" });
    expect(r.end_ms).toBe(S + 10 * MIN);
  });
  it("2 mutation: confidence 0.89 does not act", () => {
    const sc = scenario(10);
    expect(run(anchor(), jev({ end_row: sc.meta[22]!.t, end_conf: 0.89 }), sc).rank).toBe(3);
  });
  it("continues_past_segment and cannot_tell never place an end", () => {
    expect(run(anchor(), jev({ end_row: END_CONTINUES, end_conf: 0.99 })).rank).toBe(3);
  });
  it("3: an acoustic close after the last speech", () => {
    const r = run(anchor(), null);
    expect(r).toMatchObject({ rank: 3, closed_by: "non_speech", origin: "acoustic" });
    expect(r.end_ms).toBe(S + 10 * MIN);
  });
  it("4: next Start − 15 s when the room never goes quiet", () => {
    const sc = scenario(40, 40);
    const r = run(anchor({ next_start_ms: S + 30 * MIN }), null, sc);
    expect(r).toMatchObject({ rank: 4, closed_by: "next_start", end_ms: S + 30 * MIN - 15_000 });
  });
  it("5: last DOC turn + 30 s", () => {
    const sc = scenario(40, 40);
    sc.doc.splice(0, 1, { start_ms: S, end_ms: S + 20 * MIN });
    const r = run(anchor(), null, sc);
    expect(r).toMatchObject({ rank: 5, closed_by: "last_doc_turn", end_ms: S + 20 * MIN + 30_000 });
  });
  it("6: the 90-minute cap", () => {
    const sc = scenario(40, 40);
    const r = run(anchor(), null, sc, { doc_speech: [] });
    expect(r).toMatchObject({ rank: 6, closed_by: "cap_90m", end_ms: S + 5_400_000 /* PRD: 90 min, literal */ });
  });
});

describe("vetoes are counted", () => {
  it("Jev end in a row with >= 20 s speech where speech continues is rejected", () => {
    const sc = scenario(10);
    const mid = sc.meta.find((m) => m.start_ms === S + 5 * MIN)!;
    const r = run(anchor(), jev({ end_row: mid.t, end_conf: 0.99 }), sc);
    expect(r.counts.veto_end_speech_continues).toBe(1);
    expect(r.rank).toBe(3);
  });
  it("Jev consultation over zero diarized speech is counted", () => {
    const r = run(anchor(), jev({ kind: "consultation", kind_conf: 0.95 }), scenario(10), { speech: [] });
    expect(r.counts.veto_kind_no_speech).toBe(1);
  });
  it("Jev end contradicting the click by more than 2 min is counted, and the click does not lose to it", () => {
    const sc = scenario(10);
    const early = sc.meta.find((m) => m.start_ms === S + 9 * MIN + 30_000)!;
    const r = run(anchor({ end_click_ms: S + 11 * MIN }), jev({ end_row: early.t, end_conf: 0.95 }), sc);
    expect(r.rank).toBe(1);
    expect(r.counts.contradiction_end_vs_click).toBe(0); // within 2 min of each other
    const far = run(anchor({ end_click_ms: S + 12 * MIN }), jev({ end_row: sc.meta.find((m) => m.start_ms === S + 15 * MIN)!.t, end_conf: 0.95 }), sc);
    expect(far.counts.contradiction_end_vs_click).toBe(1);
  });
});

describe("acousticClose and disjoint", () => {
  it("needs ACOUSTIC_QUIET_ROWS consecutive closing rows; tape_off outranks dead_mic outranks quiet", () => {
    const mk = (sounds: string[]): RowFact[] => sounds.map((s, i) => ({ start_ms: i * 30_000, end_ms: i * 30_000 + 30_000, sound: s, speech_s: 0, doc_s: 0, other_s: 0, voices: [] }));
    expect(acousticClose(mk(["active", "quiet", "quiet", "active", "quiet"]), 0)).toBeNull();
    expect(acousticClose(mk(["active", "quiet", "dead_mic", "tape_off"]), 0)).toMatchObject({ ms: 30_000, by: "tape_off" });
    expect(acousticClose(mk(["quiet", "quiet", "quiet"]), 0)).toMatchObject({ by: "non_speech" });
  });
  it("makes consults disjoint and drops one with no length left", () => {
    const { kept, dropped } = disjoint([{ start_ms: 0, end_ms: 100 }, { start_ms: 50, end_ms: 200 }, { start_ms: 60, end_ms: 90 }]);
    expect(kept).toEqual([{ start_ms: 0, end_ms: 100 }, { start_ms: 100, end_ms: 200 }]);
    expect(dropped).toBe(1);
  });
});

// ── Refuter round 1 probes, ported as named tests (expected values are literals, not imported constants) ────────
const talkRow = { sound: "active", speech_s: 25, doc_s: 12, other_s: 12, voices: ["DOC", "B"] };
function grid(fill: (a: number) => Partial<RowFact>, totalMin = 30) {
  const rows: RowFact[] = [], meta: RowMeta[] = [];
  for (let a = S - PRE; a < S + totalMin * MIN; a += 30_000) {
    rows.push({ start_ms: a, end_ms: a + 30_000, sound: "quiet", speech_s: 0, doc_s: 0, other_s: 0, voices: [], ...fill(a) });
    meta.push({ t: relLabel(a - S), start_ms: a, end_ms: a + 30_000, probe_first: null, probe_last: null });
  }
  return { rows, meta };
}

describe("refuter probes P1-P3 (round 2 fixes D1-D3)", () => {
  it("P1 late start is refused when doctor+other speech lies in [START-60 s, START)", () => {
    const g = grid((a) => (a === S - 30_000 || (a >= S + 5 * MIN && a < S + 12 * MIN) ? talkRow : {}));
    const speech = [{ start_ms: S - 30_000, end_ms: S }, { start_ms: S + 5 * MIN, end_ms: S + 12 * MIN }];
    const r = fuseSegment({ anchor: anchor(), meta: g.meta, rows: g.rows, speech, doc_speech: speech, jev: jev({ late_start_p: 0.95 }) });
    expect(r.start_ms).toBe(S - 60_000);
    expect(r.counts.late_start_refused).toBe(1);
    expect(r.counts.late_start_applied).toBe(0);
  });
  it("P1 control: the same late start with NO pre-anchor speech does move", () => {
    const g = grid((a) => (a >= S + 5 * MIN && a < S + 12 * MIN ? talkRow : {}));
    const speech = [{ start_ms: S + 5 * MIN, end_ms: S + 12 * MIN }];
    const r = fuseSegment({ anchor: anchor(), meta: g.meta, rows: g.rows, speech, doc_speech: speech, jev: jev({ late_start_p: 0.95 }) });
    expect(r.start_ms).toBe(S + 5 * MIN);
  });
  it("P2 a NEW voice arriving after the consult does not veto a correct Jev end", () => {
    const g = grid((a) => (a >= S && a < S + 10 * MIN ? { sound: "active", speech_s: 25, doc_s: 12, other_s: 13, voices: ["DOC", "B"] }
      : a >= S + 10 * MIN && a < S + 14 * MIN ? { sound: "active", speech_s: 20, doc_s: 0, other_s: 20, voices: ["C"] } : {}));
    const speech = [{ start_ms: S, end_ms: S + 14 * MIN }];
    const r = fuseSegment({ anchor: anchor(), meta: g.meta, rows: g.rows, speech, doc_speech: [{ start_ms: S, end_ms: S + 10 * MIN }],
      jev: jev({ end_row: "t+09:30", end_conf: 0.95 }) });
    expect(r.counts.veto_end_speech_continues).toBe(0);
    expect(r.closed_by).toBe("jev_end");
    expect(r.end_ms).toBe(S + 10 * MIN);
  });
  it("P2 control: the SAME voices going on into the next row still veto", () => {
    const g = grid((a) => (a >= S && a < S + 14 * MIN ? { sound: "active", speech_s: 25, doc_s: 12, other_s: 13, voices: ["DOC", "B"] } : {}));
    const speech = [{ start_ms: S, end_ms: S + 14 * MIN }];
    const r = fuseSegment({ anchor: anchor(), meta: g.meta, rows: g.rows, speech, doc_speech: speech, jev: jev({ end_row: "t+09:30", end_conf: 0.95 }) });
    expect(r.counts.veto_end_speech_continues).toBe(1);
    expect(r.closed_by).not.toBe("jev_end");
  });
  it("P3 a Jev end over zero diarized speech is DROPPED, not chosen at rank 2", () => {
    const g = grid(() => ({ sound: "active" }));
    const r = fuseSegment({ anchor: anchor(), meta: g.meta, rows: g.rows, speech: [], doc_speech: [],
      jev: jev({ end_row: "t+05:00", end_conf: 0.95, kind: "consultation", kind_conf: 0.95 }) });
    expect(r.closed_by).not.toBe("jev_end");
    expect(r.rank).not.toBe(2);
    expect(r.counts.veto_end_no_speech).toBe(1);
    expect(r.counts.veto_kind_no_speech).toBe(1);
  });
});

describe("PRD values pinned as literals (kills M3 cap, M7 snap)", () => {
  it("M7: the Jev end snaps to the last diarized turn inside its row, not the row edge", () => {
    // speech ends 10 s into the row t+09:30 (row = S+9:30 .. S+10:00)
    const end = S + 9 * MIN + 40_000;
    const g = grid((a) => (a >= S && a < S + 9 * MIN + 30_000 ? { sound: "active", speech_s: 25, doc_s: 12, other_s: 13, voices: ["DOC", "B"] }
      : a === S + 9 * MIN + 30_000 ? { sound: "active", speech_s: 10, doc_s: 5, other_s: 5, voices: ["DOC", "B"] } : {}));
    const speech = [{ start_ms: S, end_ms: end }];
    const r = fuseSegment({ anchor: anchor(), meta: g.meta, rows: g.rows, speech, doc_speech: speech, jev: jev({ end_row: "t+09:30", end_conf: 0.95 }) });
    expect(r.closed_by).toBe("jev_end");
    expect(r.end_ms).toBe(end);
  });
  it("M3: with nothing else to go on, the ceiling is exactly 90 minutes", () => {
    const g = grid(() => ({ sound: "active", speech_s: 25, doc_s: 0, other_s: 25, voices: ["B"] }), 40);
    const r = fuseSegment({ anchor: anchor(), meta: g.meta, rows: g.rows, speech: [{ start_ms: S, end_ms: S + 40 * MIN }], doc_speech: [], jev: null });
    expect(r).toMatchObject({ closed_by: "cap_90m", end_ms: S + 90 * 60_000 });
  });
});
