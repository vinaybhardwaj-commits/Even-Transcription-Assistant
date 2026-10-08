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
