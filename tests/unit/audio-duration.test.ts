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

  it("flac (the CONSULT clips): STREAMINFO total samples / rate; the longer of that and a size floor (a header cannot understate); total samples 0 = unknown = null", () => {
    // 44.1 kHz stereo 16-bit, 90 s claimed, a small file
    const flac = (opts: { rate: number; channels: number; bits: number; samples: number; extra?: number }): Uint8Array => {
      const b = new Uint8Array(42 + (opts.extra ?? 0));
      b.set([0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]); // "fLaC", STREAMINFO (last-flag 0, type 0), length 34
      b[8] = 0x10; b[9] = 0x00; b[10] = 0x10; b[11] = 0x00; // block sizes
      b[18] = (opts.rate >> 12) & 0xff; b[19] = (opts.rate >> 4) & 0xff;
      b[20] = ((opts.rate & 0x0f) << 4) | (((opts.channels - 1) & 0x07) << 1) | (((opts.bits - 1) >> 4) & 0x01);
      b[21] = (((opts.bits - 1) & 0x0f) << 4) | (Math.floor(opts.samples / 2 ** 32) & 0x0f);
      const lo = opts.samples >>> 0;
      b[22] = (lo >>> 24) & 0xff; b[23] = (lo >>> 16) & 0xff; b[24] = (lo >>> 8) & 0xff; b[25] = lo & 0xff;
      return b;
    };
    expect(measureAudioMs(flac({ rate: 44_100, channels: 2, bits: 16, samples: 44_100 * 90 }))).toBe(90_000);
    expect(measureAudioMs(flac({ rate: 16_000, channels: 1, bits: 16, samples: 16_000 * 30 * 60 }))).toBe(1_800_000);
    expect(measureAudioMs(flac({ rate: 48_000, channels: 1, bits: 24, samples: 48_000 * 5 * 3600 }))).toBe(18_000_000); // a sample count above 2^32 (36 bits)
    // the header claims 10 s but the file holds 1.6 MB of 16 kHz mono 16-bit (>= 50 s at the raw ceiling): the size floor wins
    expect(measureAudioMs(flac({ rate: 16_000, channels: 1, bits: 16, samples: 16_000 * 10, extra: 1_600_000 }))).toBe(10_000); // the header claim wins over a smaller byte floor
    expect(measureAudioMs(flac({ rate: 16_000, channels: 1, bits: 16, samples: 0 }))).toBeNull();
    // S8C-2: the byte floor is a TRUE lower bound (576000 B/s = raw 96 kHz x 24-bit x 2 ch): a crafted 15 MB file claiming ONE sample reads at least 26 s whatever params it names, and a real clip is never overstated
    const big = (o: { rate: number; channels: number; bits: number; samples: number }) => flac({ ...o, extra: 15_000_000 - 42 });
    expect(measureAudioMs(big({ rate: 16_000, channels: 1, bits: 16, samples: 1 }))).toBeGreaterThanOrEqual(26_000);
    expect(measureAudioMs(big({ rate: 48_000, channels: 2, bits: 24, samples: 1 }))).toBeGreaterThanOrEqual(26_000);
    // a real-shaped clip: 10 minutes of 16 kHz mono in about 4 MB reads as exactly its 10 minutes (header claim), not longer
    expect(measureAudioMs(flac({ rate: 16_000, channels: 1, bits: 16, samples: 16_000 * 600, extra: 4_000_000 - 42 }))).toBe(600_000);
    // only the cutter's format: rate 8k-96k, 1-2 channels, 16 or 24 bits; anything else is unknown (null), never guessed
    for (const bad of [{ rate: 655_350, channels: 8, bits: 32 }, { rate: 7_999, channels: 1, bits: 16 }, { rate: 96_001, channels: 1, bits: 16 }, { rate: 16_000, channels: 3, bits: 16 }, { rate: 16_000, channels: 1, bits: 8 }, { rate: 16_000, channels: 1, bits: 32 }, { rate: 16_000, channels: 1, bits: 20 }]) expect(measureAudioMs(big({ ...bad, samples: 1 })), JSON.stringify(bad)).toBeNull();
    for (const ok of [{ rate: 8_000, channels: 1, bits: 16 }, { rate: 96_000, channels: 2, bits: 24 }, { rate: 44_100, channels: 2, bits: 16 }]) expect(measureAudioMs(flac({ ...ok, samples: ok.rate * 60 }))).toBe(60_000);
    expect(measureAudioMs(new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x01, 0, 0, 0x22, ...new Array(40).fill(0)]))).toBeNull(); // first block is not STREAMINFO
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

import { fmp4, m4a, safariFmp4 } from "./helpers/audio-fixtures";

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

describe("G14 — a Safari-style fragmented audio/mp4: the only duration is moov/mvex/trex default_sample_duration", () => {
  it("G20: a moov that comes AFTER the moofs measures the same duration (the trex default is applied once the whole file has been walked)", () => {
    const first = safariFmp4({ timescale: 48_000, trexDefault: 1024, fragments: [100, 100, 100] });
    const last = safariFmp4({ timescale: 48_000, trexDefault: 1024, fragments: [100, 100, 100], moovLast: true });
    const a = measureAudioMs(first), b = measureAudioMs(last);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(b).toBe(Math.round((300 * 1024 / 48_000) * 1000));
  });
  it("50 fragments x 2,812 samples x 1024 ticks at 48 kHz (about 50 minutes) measures 50 minutes, not null", () => {
    const m = safariFmp4({ timescale: 48_000, trexDefault: 1024, fragments: Array.from({ length: 50 }, () => 2_812) });
    const ms = measureAudioMs(m);
    expect(ms).toBe(Math.round((50 * 2_812 * 1024 * 1000) / 48_000));
    expect(ms!).toBeGreaterThan(30 * 60_000); // so the 30-minute rule sees it
  });
  it("a short one: 430 samples of 1024 at 44.1 kHz", () => {
    expect(measureAudioMs(safariFmp4({ timescale: 44_100, trexDefault: 1024, fragments: [215, 215] }))).toBe(Math.round((430 * 1024 * 1000) / 44_100));
  });
  it("a tfhd default beats the trex default; a header-only file with no samples stays null", () => {
    expect(measureAudioMs(safariFmp4({ timescale: 48_000, trexDefault: 1024, trexDefaultInTfhd: 2048, fragments: [100] }))).toBe(Math.round((100 * 2048 * 1000) / 48_000));
    expect(measureAudioMs(safariFmp4({ timescale: 48_000, trexDefault: 1024, fragments: [] }))).toBeNull();
    expect(measureAudioMs(safariFmp4({ timescale: 48_000, trexDefault: 0, fragments: [100] }))).toBeNull(); // nothing says how long a sample is
  });
  it("fuzz: every truncation point and 1,200 mutated Safari-style files never throw, each fast", () => {
    const base = safariFmp4({ timescale: 48_000, trexDefault: 1024, fragments: [300, 300, 300] });
    let seed = 777;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let cut = 0; cut < base.length; cut++) expect(() => measureAudioMs(base.slice(0, cut))).not.toThrow();
    for (let i = 0; i < 1200; i++) {
      const m = base.slice();
      for (let k = 0; k < 4; k++) m[Math.floor(rnd() * m.length)] = Math.floor(rnd() * 256);
      const t0 = Date.now();
      expect(() => measureAudioMs(m)).not.toThrow();
      expect(Date.now() - t0).toBeLessThan(200);
    }
  });
});
