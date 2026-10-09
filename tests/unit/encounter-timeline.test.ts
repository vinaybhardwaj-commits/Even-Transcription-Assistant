/**
 * encounter-timeline.test.ts — the speaker-turn timeline (epic #23 e): segments, 30 s rows on the acoustic grid,
 * "no evidence is null, never 0", window-local speakers, the size budget, the row → probe/wall-clock map, and the
 * allowlist grammar. Every expected row below is written out by hand from the fixture times, not computed.
 * All ids are fake; times are IST wall clock converted by Date.parse.
 */
import { describe, expect, it } from "vitest";
import type { Anchor } from "@/lib/encounter-clock/anchors";
import type { EnergyState } from "@/lib/encounter-clock/gate";
import { scheduleProbes } from "@/lib/encounter-clock/probe";
import { slotsFromCentres } from "@/lib/encounter-clock/fusion-state";
import {
  MAX_CHARS,
  MAX_ROWS,
  SETTING,
  buildSegment,
  buildTimeline,
  checkTimelineGrammar,
  probeIndexOfRow,
  segmentsFor,
  type TimelineInput,
  type TimelineWindow,
} from "@/lib/encounter-clock/timeline";
import { makeFakeClinician } from "../support/fake-identity";

const EP = (hhmmss: string) => Date.parse(`2026-10-08T${hhmmss}+05:30`);
const MIN = 60_000;
/** Probe 0 starts here (scheduleProbes' day_start_ms). */
const T0 = EP("09:00:00");

const anchor = (o: Partial<Anchor> & { start_ms: number }): Anchor => ({
  consult_key: "c_fake01@m_fake", room_id: "room_fake_a", close_kind: "open", end_clicked: false,
  end_click_ms: null, end_weak_ms: null, end_weak_kind: null, next_start_ms: null,
  doctor_uid_warehouse: "wh_fake0001", doctor_uid_ext: null, doctor_source: "warehouse", quality: "clean", weak_start: false,
  ...o,
});

const energyAt = (m: Record<number, EnergyState>): Array<EnergyState | null> => {
  const out: Array<EnergyState | null> = Array(200).fill(null);
  for (const [k, v] of Object.entries(m)) out[Number(k)] = v;
  return out;
};

// W1: clip 09:45:00–10:00:30. W2: clip 10:01:00–10:16:00. Nothing covers 10:00:30–10:01:00.
const W1: TimelineWindow = {
  window_id: "bw_fake0001_a", origin_ms: EP("09:45:00"), window_end_ms: EP("10:00:30"),
  turns: [
    { start_ms: (14 * 60 + 5) * 1000, end_ms: (14 * 60 + 20) * 1000, speaker_idx: 0 }, // 09:59:05–09:59:20
    { start_ms: (14 * 60 + 35) * 1000, end_ms: (14 * 60 + 45) * 1000, speaker_idx: 0 }, // 09:59:35–09:59:45
    { start_ms: (14 * 60 + 40) * 1000, end_ms: (15 * 60 + 10) * 1000, speaker_idx: 1 }, // 09:59:40–10:00:10
  ],
};
const W2: TimelineWindow = {
  window_id: "bw_fake0002_a", origin_ms: EP("10:01:00"), window_end_ms: EP("10:16:00"),
  turns: [
    { start_ms: 0, end_ms: 20_000, speaker_idx: 0 }, // 10:01:00–10:01:20
    { start_ms: 25_000, end_ms: 25_300, speaker_idx: 1 }, // 0.3 s: counted as a turn and as speech, never as a speaker
  ],
};

const A1 = anchor({ start_ms: EP("10:00:10"), end_weak_ms: EP("10:01:40"), end_weak_kind: "url_clear", next_start_ms: EP("10:02:00") });

const base: TimelineInput = {
  grid_origin_ms: T0,
  energy: energyAt({ 58: "active", 59: "active", 60: "quiet" }),
  tape_off: [],
  windows: [W1, W2],
};

describe("segments", () => {
  it("anchored segments run from START − 60 s to the next Start or START + 45 min; gaps get 15-min segments every 10 min", () => {
    const a = anchor({ start_ms: EP("10:00:00"), next_start_ms: EP("10:20:00") });
    const b = anchor({ consult_key: "c_fake02@m_fake", start_ms: EP("10:20:00"), next_start_ms: null });
    const { segments, dropped } = segmentsFor([b, a], { start_ms: EP("09:00:00"), end_ms: EP("12:00:00") });
    expect(dropped).toBe(0);
    expect(segments.map((s) => [s.anchor?.consult_key ?? "none", s.start_ms, s.end_ms])).toEqual([
      ["none", EP("09:00:00"), EP("09:15:00")],
      ["none", EP("09:10:00"), EP("09:25:00")],
      ["none", EP("09:20:00"), EP("09:35:00")],
      ["none", EP("09:30:00"), EP("09:45:00")],
      ["none", EP("09:40:00"), EP("09:55:00")],
      ["none", EP("09:50:00"), EP("09:59:00")],
      ["c_fake01@m_fake", EP("09:59:00"), EP("10:20:00")],
      ["c_fake02@m_fake", EP("10:19:00"), EP("11:05:00")],
      ["none", EP("11:05:00"), EP("11:20:00")],
      ["none", EP("11:15:00"), EP("11:30:00")],
      ["none", EP("11:25:00"), EP("11:40:00")],
      ["none", EP("11:35:00"), EP("11:50:00")],
      ["none", EP("11:45:00"), EP("12:00:00")],
    ]);
  });

  it("drops (and counts) an anchor whose next Start is not after its own Start", () => {
    const a = anchor({ start_ms: EP("10:00:00"), next_start_ms: EP("10:00:00") });
    const { segments, dropped } = segmentsFor([a], { start_ms: EP("10:00:00"), end_ms: EP("10:00:00") });
    expect(dropped).toBe(1);
    expect(segments).toEqual([]);
  });
});

describe("one anchored segment, written out by hand", () => {
  const seg = { anchor: A1, start_ms: EP("09:59:10"), end_ms: EP("10:02:00") };

  it("with the identity pass naming W1's spk0 as the consult's doctor", () => {
    const built = buildSegment(seg, { ...base, role: (w, i) => (w === "bw_fake0001_a" && i === 0 ? "doc" : "other") });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.state).toEqual({
      setting: SETTING,
      anchor: { start: "t+00:00", end_click: "none", end_weak: "t+01:30", next_start: "t+02:00", cap: "t+45:00" },
      rows: [
        { t: "t-01:00", sound: "active", speech_s: 15, spk: { DOC: 15 }, turns: 1, overlap_s: 0, new_spk: ["DOC"] },
        { t: "t-00:30", sound: "active", speech_s: 25, spk: { DOC: 10, B: 20 }, turns: 2, overlap_s: 5, new_spk: ["B"] },
        { t: "t+00:00", sound: "active", speech_s: 10, spk: { B: 10 }, turns: 1, overlap_s: 0, new_spk: [] },
        { t: "t+00:30", sound: "active", speech_s: null, spk: null, turns: null, overlap_s: null, new_spk: [] },
        { t: "t+01:00", sound: "quiet", speech_s: 20, spk: { C: 20 }, turns: 2, overlap_s: 0, new_spk: ["C"] },
        { t: "t+01:30", sound: "quiet", speech_s: 0, spk: {}, turns: 0, overlap_s: 0, new_spk: [] },
      ],
    });
    expect(built.compressed).toBe(false);
  });

  it("without the identity pass nobody is DOC, and each window's speakers get their own letters", () => {
    const built = buildSegment(seg, base);
    if (!built.ok) throw new Error("refused");
    expect(built.state.rows.map((r) => ("spk" in r ? r.spk : "range"))).toEqual([
      { B: 15 }, { B: 10, C: 20 }, { C: 10 }, null, { D: 20 }, {},
    ]);
    expect(built.state.rows.map((r) => ("new_spk" in r ? r.new_spk : []))).toEqual([["B"], ["C"], [], [], ["D"], []]);
  });

  it("maps each row back to wall-clock ms and to the acoustic probe that owns it (server side only)", () => {
    const built = buildSegment(seg, base);
    if (!built.ok) throw new Error("refused");
    expect(built.meta).toEqual([
      { t: "t-01:00", start_ms: EP("09:59:00"), end_ms: EP("09:59:30"), probe_first: 58, probe_last: 58 },
      { t: "t-00:30", start_ms: EP("09:59:30"), end_ms: EP("10:00:00"), probe_first: 58, probe_last: 58 },
      { t: "t+00:00", start_ms: EP("10:00:00"), end_ms: EP("10:00:30"), probe_first: 59, probe_last: 59 },
      { t: "t+00:30", start_ms: EP("10:00:30"), end_ms: EP("10:01:00"), probe_first: 59, probe_last: 59 },
      { t: "t+01:00", start_ms: EP("10:01:00"), end_ms: EP("10:01:30"), probe_first: 60, probe_last: 60 },
      { t: "t+01:30", start_ms: EP("10:01:30"), end_ms: EP("10:02:00"), probe_first: 60, probe_last: 60 },
    ]);
  });
});

describe("evidence", () => {
  const seg = { anchor: A1, start_ms: EP("09:59:10"), end_ms: EP("10:02:00") };

  it("a row no Nemotron window covers is null in every evidence field, never 0", () => {
    const built = buildSegment(seg, { ...base, windows: [] });
    if (!built.ok) throw new Error("refused");
    for (const r of built.state.rows) expect(r).toMatchObject({ speech_s: null, spk: null, turns: null, overlap_s: null, new_spk: [] });
  });

  it("a row only partly covered is null too", () => {
    const half: TimelineWindow = { window_id: "bw_fake0003_a", origin_ms: EP("09:59:15"), window_end_ms: EP("10:30:00"), turns: [] };
    const built = buildSegment(seg, { ...base, windows: [half] });
    if (!built.ok) throw new Error("refused");
    expect(built.state.rows.map((r) => r.speech_s)).toEqual([null, 0, 0, 0, 0, 0]);
  });

  it("tape-off wins over energy; a probe with no energy, or energy 'missing', is unjudged", () => {
    const built = buildSegment(seg, {
      ...base,
      energy: energyAt({ 58: "active", 59: "missing" }),
      tape_off: [{ start_ms: EP("09:59:20"), end_ms: EP("09:59:50") }],
    });
    if (!built.ok) throw new Error("refused");
    expect(built.state.rows.map((r) => r.sound)).toEqual(["active", "tape_off", "unjudged", "unjudged", "unjudged", "unjudged"]);
  });

  it("the probe map agrees with scheduleProbes and the fusion slots", () => {
    const probes = scheduleProbes({ day_start_ms: T0, day_end_ms: EP("12:00:00") });
    const slots = slotsFromCentres(probes.map((p) => (p.start_ms + p.end_ms) / 2));
    for (const row of [EP("09:01:00"), EP("09:01:30"), EP("09:59:30"), EP("11:56:30")]) {
      const owner = slots.find((s) => row >= s.start_ms && row < s.end_ms)!;
      expect(probeIndexOfRow(row, T0)).toBe(owner.index);
    }
    expect(probeIndexOfRow(EP("09:00:30"), T0)).toBeNull();
  });

  it("is deterministic and ignores input order", () => {
    const seg2 = { anchor: A1, start_ms: EP("09:59:10"), end_ms: EP("10:02:00") };
    const a = buildSegment(seg2, base);
    const b = buildSegment(seg2, { ...base, windows: [W2, { ...W1, turns: [...W1.turns].reverse() }] });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("size", () => {
  // START unaligned at 10:00:10 with no next Start: 09:59:00 … 10:45:00 is 93 rows of 30 s
  const lone = anchor({ start_ms: EP("10:00:10") });
  const seg = { anchor: lone, start_ms: lone.start_ms - MIN, end_ms: lone.start_ms + 45 * MIN };
  const silentWindow: TimelineWindow = { window_id: "bw_fake0004_a", origin_ms: EP("09:45:00"), window_end_ms: EP("11:00:00"), turns: [] };

  it("an over-budget segment compresses runs of identical silent rows into one range row", () => {
    const busy: TimelineWindow = { ...silentWindow, turns: [{ start_ms: 15 * MIN, end_ms: 15 * MIN + 20_000, speaker_idx: 0 }] }; // 10:00:00–10:00:20
    const built = buildSegment(seg, { ...base, energy: energyAt({}), windows: [busy] });
    if (!built.ok) throw new Error("refused");
    expect(built.compressed).toBe(true);
    expect(built.state.rows).toEqual([
      // a run of two is under COMPRESS_MIN_RUN, so it stays as two rows
      { t: "t-01:00", sound: "unjudged", speech_s: 0, spk: {}, turns: 0, overlap_s: 0, new_spk: [] },
      { t: "t-00:30", sound: "unjudged", speech_s: 0, spk: {}, turns: 0, overlap_s: 0, new_spk: [] },
      { t: "t+00:00", sound: "unjudged", speech_s: 20, spk: { B: 20 }, turns: 1, overlap_s: 0, new_spk: ["B"] },
      { t: "t+00:30..t+45:00", sound: "unjudged", speech_s: 0 },
    ]);
    expect(built.meta[3]).toMatchObject({ start_ms: EP("10:00:30"), end_ms: EP("10:45:30") });
  });

  it("a segment still over MAX_ROWS after compression is refused, never truncated", () => {
    // speech in every row: nothing to compress
    const turns = Array.from({ length: 93 }, (_, k) => ({ start_ms: 14 * MIN + k * 30_000, end_ms: 14 * MIN + k * 30_000 + 10_000, speaker_idx: 0 }));
    const built = buildSegment(seg, { ...base, windows: [{ ...silentWindow, turns }] });
    expect(built).toMatchObject({ ok: false, reason: "too_large", rows: 93 });
  });

  it("the budget constants are the PRD's", () => {
    expect([MAX_ROWS, MAX_CHARS]).toEqual([90, 20_000]);
  });
});

describe("privacy: the allowlist grammar", () => {
  const good = () => {
    const built = buildSegment({ anchor: A1, start_ms: EP("09:59:10"), end_ms: EP("10:02:00") }, base);
    if (!built.ok) throw new Error("refused");
    return built.state;
  };
  const doc = makeFakeClinician(7);

  it("accepts a built state", () => {
    expect(checkTimelineGrammar(JSON.stringify(good()))).toEqual([]);
  });

  it.each([
    ["a clinician name as a speaker", (s: any) => { s.rows[0].spk = { [doc.full_name]: 3 }; }],
    ["a clinician name in the setting", (s: any) => { s.setting = `${SETTING}; ${doc.label}`; }],
    ["a clinician id in new_spk", (s: any) => { s.rows[0].new_spk = [doc.id]; }],
    ["an ISO time as t", (s: any) => { s.rows[0].t = "2026-10-08T10:00:00+05:30"; }],
    ["a clock time as t", (s: any) => { s.rows[0].t = "10:00"; }],
    ["an epoch-ms id as a number", (s: any) => { s.rows[0].turns = 1790236800000; }],
    ["a long digit run in t", (s: any) => { s.rows[0].t = "t+1790236:00"; }],
    ["an extra key carrying a window id", (s: any) => { s.rows[0].window = "bw_fake0001_a"; }],
    ["a room in the anchor header", (s: any) => { s.anchor.room = "room_fake_a"; }],
    ["text in a row", (s: any) => { s.rows[0].sound = "doctor asks about fever"; }],
    ["a date in the anchor", (s: any) => { s.anchor.end_click = "2026-10-08"; }],
  ])("rejects %s", (_name, mutate) => {
    const s = good();
    mutate(s);
    expect(checkTimelineGrammar(JSON.stringify(s)).length).toBeGreaterThan(0);
  });

  it("property: no built state, over many random room-days, carries an id, a clock time or a fixture name", () => {
    let seed = 0x5eed;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const names = [1, 2, 3].map((n) => makeFakeClinician(n));
    for (let day = 0; day < 40; day++) {
      const anchors: Anchor[] = [];
      let at = EP("09:30:00") + Math.floor(rnd() * 600_000);
      for (let k = 0; k < 1 + Math.floor(rnd() * 5); k++) {
        const start = at;
        at += Math.floor((5 + rnd() * 50) * MIN);
        anchors.push(anchor({
          consult_key: `c_fake${day}${k}@m_fake`, room_id: "room_fake_b", start_ms: start,
          next_start_ms: rnd() < 0.8 ? at : null, end_click_ms: rnd() < 0.3 ? start + 7 * MIN : null,
          end_weak_ms: rnd() < 0.5 ? start + 9 * MIN : null, doctor_uid_warehouse: names[k % 3].id,
        }));
      }
      const windows: TimelineWindow[] = [];
      for (let w = 0; w < 16; w++) {
        if (rnd() < 0.2) continue; // a window the worker has not done: no evidence
        const origin = EP("09:30:00") + w * 15 * MIN;
        const turns = Array.from({ length: Math.floor(rnd() * 40) }, () => {
          const s = Math.floor(rnd() * 880_000);
          return { start_ms: s, end_ms: s + 200 + Math.floor(rnd() * 20_000), speaker_idx: Math.floor(rnd() * 6) };
        });
        windows.push({ window_id: `bw_fake${String(w).padStart(4, "0")}_${day}`, origin_ms: origin, window_end_ms: origin + 15 * MIN, turns });
      }
      const energy = Array.from({ length: 300 }, () => (["active", "quiet", "dead_mic", "missing", null] as const)[Math.floor(rnd() * 5)]);
      const { built } = buildTimeline(anchors, { start_ms: EP("09:30:00"), end_ms: EP("13:30:00") }, {
        grid_origin_ms: T0, energy, tape_off: [{ start_ms: EP("11:00:00"), end_ms: EP("11:04:00") }], windows,
        role: (_w, i, a) => (a && i === 0 ? "doc" : "other"),
      });
      for (const b of built) {
        if (!b.ok) continue;
        const text = JSON.stringify(b.state);
        expect(checkTimelineGrammar(text)).toEqual([]);
        expect(text).not.toMatch(/\d{5,}/); // no id-like digit run
        expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/); // no ISO date or time
        expect(text.replace(SETTING, "")).not.toMatch(/fake|room|bw_|doc_|@/i);
        for (const n of names) expect(text).not.toContain(n.full_name);
        expect(text.length).toBeLessThanOrEqual(MAX_CHARS);
        expect(b.state.rows.length).toBeLessThanOrEqual(MAX_ROWS);
      }
    }
  });
});
