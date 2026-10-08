/** S8A-FIX F2 — the duration is measured from the container. Synthetic headers only. */
import { describe, it, expect } from "vitest";
import { measureAudioMs } from "@/lib/audio-duration";
import { oggOpus, wav, webm } from "./helpers/audio-fixtures";

describe("measureAudioMs", () => {
  it("wav: data size / byte rate; a streamed header (size 0) uses the bytes present", () => {
    expect(measureAudioMs(wav(12.5))).toBe(12_500);
    expect(measureAudioMs(wav(3, { byteRate: 16_000 }))).toBe(3_000);
    expect(measureAudioMs(wav(7, { sizeField: "zero" }))).toBe(7_000);
  });

  it("ogg/opus: the last page's granule position minus the pre-skip, at 48 kHz", () => {
    expect(measureAudioMs(oggOpus(65.4))).toBe(65_400);
    expect(measureAudioMs(oggOpus(1800, 0))).toBe(1_800_000);
  });

  it("webm with a declared Duration (x TimecodeScale)", () => {
    expect(measureAudioMs(webm({ declaredMs: 93_250 }))).toBe(93_250);
    expect(measureAudioMs(webm({ declaredMs: 93_250, clusters: [{ tc: 0, blocksRel: [0, 20] }], unknownSizes: false }))).toBe(93_250);
  });

  it("webm WITHOUT Duration (MediaRecorder): the last block's timestamp, through clusters of unknown size", () => {
    const m = webm({ clusters: [{ tc: 0, blocksRel: [0, 5000] }, { tc: 10_000, blocksRel: [0, 2500] }] });
    expect(measureAudioMs(m)).toBe(12_500);
    expect(measureAudioMs(webm({ clusters: [{ tc: 0, blocksRel: [0, 5000] }, { tc: 10_000, blocksRel: [0, 2500] }], unknownSizes: false }))).toBe(12_500);
    // a long recording: clusters 5 s apart for 2 hours
    const clusters = Array.from({ length: 1440 }, (_, i) => ({ tc: i * 5_000, blocksRel: [0, 2_500] }));
    expect(measureAudioMs(webm({ clusters }))).toBe(1439 * 5_000 + 2_500);
  });

  it("nothing readable -> null (the caller refuses, it does not guess)", () => {
    expect(measureAudioMs(new Uint8Array(0))).toBeNull();
    expect(measureAudioMs(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]))).toBeNull();
    expect(measureAudioMs(webm({ clusters: [] }))).toBeNull(); // a header and no blocks: no duration
    expect(measureAudioMs(webm({ clusters: [{ tc: 0, blocksRel: [] }] }))).toBeNull();
    expect(measureAudioMs(new TextEncoder().encode("ID3 not audio at all, just some text bytes here"))).toBeNull();
    // truncated mid-element must not throw
    const m = webm({ clusters: [{ tc: 0, blocksRel: [0, 5000] }] });
    expect(() => measureAudioMs(m.slice(0, m.length - 3))).not.toThrow();
  });
});

import { fmp4, m4a } from "./helpers/audio-fixtures";

describe("G8 — a declared WebM Duration can never make a long file look short", () => {
  it("60 s declared over 40 minutes of blocks measures 40 minutes (so it is refused as too long, not charged 1 minute)", () => {
    const clusters = Array.from({ length: 480 }, (_, i) => ({ tc: i * 5_000, blocksRel: [0, 2_500] })); // 40 min of blocks
    expect(measureAudioMs(webm({ declaredMs: 60_000, clusters }))).toBe(479 * 5_000 + 2_500);
    expect(measureAudioMs(webm({ declaredMs: 60_000, clusters, unknownSizes: false }))).toBe(479 * 5_000 + 2_500);
  });
  it("the longer of the two wins both ways; a Duration alone, or blocks alone, still measure", () => {
    expect(measureAudioMs(webm({ declaredMs: 90_000, clusters: [{ tc: 0, blocksRel: [0, 5000] }] }))).toBe(90_000);
    expect(measureAudioMs(webm({ declaredMs: 93_250 }))).toBe(93_250);
    expect(measureAudioMs(webm({ clusters: [{ tc: 0, blocksRel: [0, 5000] }] }))).toBe(5_000);
  });
});

describe("G9 — MP4 / M4A (what iPhones and Safari record)", () => {
  it("mvhd: the movie duration over its timescale (32- and 64-bit)", () => {
    expect(measureAudioMs(m4a({ mvhd: { timescale: 1000, duration: 123_456 } }))).toBe(123_456);
    expect(measureAudioMs(m4a({ mvhd: { timescale: 600, duration: 36_000 } }))).toBe(60_000);
    expect(measureAudioMs(m4a({ mvhd: { timescale: 44_100, duration: 44_100 * 90, v1: true } }))).toBe(90_000);
  });
  it("mdhd: used when the movie header is missing or zero (its own timescale)", () => {
    expect(measureAudioMs(m4a({ mdhd: { timescale: 44_100, duration: 44_100 * 75 } }))).toBe(75_000);
    expect(measureAudioMs(m4a({ mvhd: { timescale: 1000, duration: 0 }, mdhd: { timescale: 48_000, duration: 48_000 * 12 } }))).toBe(12_000);
  });
  it("the LONGEST claim wins: a lying movie header cannot hide what the sample table holds", () => {
    expect(measureAudioMs(m4a({ mvhd: { timescale: 1000, duration: 60_000 }, mdhd: { timescale: 44_100, duration: 44_100 * 60 }, stts: [[44_100 * 40 * 60 / 1024, 1024]] }))).toBeGreaterThan(30 * 60_000);
  });
  it("fragmented mp4 (a MediaRecorder file): the movie header says 0, so the fragment header and the fragment runs decide", () => {
    expect(measureAudioMs(fmp4({ mdhdScale: 44_100, mehd: 90_000 }))).toBe(90_000);
    expect(measureAudioMs(fmp4({ mdhdScale: 48_000, runs: [{ durations: [48_000, 48_000, 24_000] }, { durations: [48_000] }] }))).toBe(3_500);
    expect(measureAudioMs(fmp4({ mdhdScale: 44_100, runs: [{ count: 430, defaultDuration: 1024 }] }))).toBe(Math.round((430 * 1024 * 1000) / 44_100));
    // 40 minutes of fragments under a fragment header that says 10 s
    expect(measureAudioMs(fmp4({ mdhdScale: 48_000, mehd: 10_000, runs: Array.from({ length: 40 }, () => ({ durations: [48_000 * 60] })) }))).toBe(40 * 60_000);
  });
  it("bounded reads: truncated and mutated mp4s never throw", () => {
    const base = [m4a({ mvhd: { timescale: 1000, duration: 5000 }, mdhd: { timescale: 44_100, duration: 44_100 * 5 }, stts: [[100, 1024]] }), fmp4({ mdhdScale: 44_100, mehd: 5000, runs: [{ durations: [1024, 1024] }] })];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (const b of base) {
      for (let cut = 0; cut < b.length; cut++) expect(() => measureAudioMs(b.slice(0, cut))).not.toThrow();
      for (let i = 0; i < 800; i++) {
        const m = b.slice();
        for (let k = 0; k < 3; k++) m[Math.floor(rnd() * m.length)] = Math.floor(rnd() * 256);
        const t0 = Date.now();
        expect(() => measureAudioMs(m)).not.toThrow();
        expect(Date.now() - t0).toBeLessThan(200);
      }
    }
    // a box that claims a huge size, and a box whose size is smaller than its header, must not loop
    expect(measureAudioMs(new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0x6d, 0x6f, 0x6f, 0x76, 0, 0, 0, 4, 0x6d, 0x76, 0x68, 0x64]))).toBeNull();
    expect(measureAudioMs(new Uint8Array(8 * 1024 * 1024))).toBeNull();
  });
  it("non-audio / unknown stays null", () => {
    expect(measureAudioMs(new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });
});
