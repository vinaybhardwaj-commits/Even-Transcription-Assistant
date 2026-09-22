/**
 * E-1 — the probe scheduler and the extract contract (lib/encounter-clock/probe.ts).
 *
 * The contract these tests protect: a probe is re-derivable from the ORIGINAL chunks. Extract it,
 * store it, re-read it, extract it again — every hash must agree, and a changed chunk must be named,
 * even a change in bytes the probe never uses. Fixture audio is real WAV built in the test
 * (a tone plus seeded noise), with chunk starts deliberately off the grid, as production's are.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scheduleProbes, mapProbeToChunks, extractProbe, verifyContract, pcmToLeBytes, sha256Hex,
  PROBE_SECONDS, HOP_SECONDS, PROBE_SAMPLE_RATE, EXTRACT_CONTRACT_VERSION, type ClockChunk, type ChunkIO,
} from "@/lib/encounter-clock/probe";
import { ENCOUNTER_CLOCK, encounterClockEnabled } from "@/lib/encounter-clock/flag";
import { FlagValueError } from "@/lib/flags";
import type { BenchLevelSample } from "@/lib/bench-levels";

const SR = PROBE_SAMPLE_RATE;

// ── fixture audio: real WAV bytes ────────────────────────────────────────────────────────────────
function wav(samples: Int16Array, rate = SR): Uint8Array {
  const b = new Uint8Array(44 + samples.length * 2), dv = new DataView(b.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  w(0, "RIFF"); dv.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data");
  dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);
  return b;
}
function decodeWav(bytes: Uint8Array, rate: number): Int16Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(24, true) !== rate) throw new Error("fixture rate mismatch");
  const n = dv.getUint32(40, true) / 2, out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(44 + i * 2, true);
  return out;
}
function tone(seconds: number, seed: number): Int16Array {
  const n = Math.round(seconds * SR), out = new Int16Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;                         // seeded, so every run is identical
    out[i] = Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / SR) + ((s >>> 16) % 400) - 200);
  }
  return out;
}

// Three 300 s chunks, the first starting 12.558 s past a round second — not grid-aligned.
const T0 = 1_790_000_012_558;
function makeChunks(): { chunks: ClockChunk[]; store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>(), chunks: ClockChunk[] = [];
  for (let i = 0; i < 3; i++) {
    const key = `bench/room/2026-09-22/bs_test/chunk_${String(i).padStart(5, "0")}.wav`;
    store.set(key, wav(tone(300, 7 + i)));
    chunks.push({ idx: i, r2_key: key, start_ms: T0 + i * 300_000, end_ms: T0 + (i + 1) * 300_000 });
  }
  return { chunks, store };
}
const ioFor = (store: Map<string, Uint8Array>): ChunkIO => ({
  fetchChunk: async (c) => store.get(c.r2_key)!.slice(),
  decode: async (b, rate) => decodeWav(b, rate),
});
const lvl = (t: number, avg: number | null, zero: number | null = 0): BenchLevelSample =>
  ({ t_ms: t, peak: Math.max(avg ?? 0, 0.01), avg, zero_ratio: zero, session_open: true, tape_advancing: true, samples: 1 });

// ── scheduling ───────────────────────────────────────────────────────────────────────────────────
describe("E-1 scheduleProbes — a 180 s probe every 60 s", () => {
  it("lays the grid from the day start and never runs a probe past the day end", () => {
    const p = scheduleProbes({ day_start_ms: 0, day_end_ms: 600_000 });
    expect(p.map((x) => x.start_ms)).toEqual([0, 60_000, 120_000, 180_000, 240_000, 300_000, 360_000, 420_000]);
    expect(p.every((x) => x.end_ms - x.start_ms === PROBE_SECONDS * 1000 && x.end_ms <= 600_000)).toBe(true);
    expect(HOP_SECONDS).toBe(60);
  });
  it("with no level log every probe is extracted — no evidence is never a reason to skip", () => {
    expect(scheduleProbes({ day_start_ms: 0, day_end_ms: 400_000 }).every((x) => x.preselect === "extract" && x.preselect_source === "none")).toBe(true);
  });
  it("the level log pre-selects: dead mic and a quiet room are decided without fetching; an active room is fetched", () => {
    const samples = (avg: number | null, zero: number | null) => Array.from({ length: 91 }, (_, i) => lvl(i * 2000, avg, zero));
    const one = (s: BenchLevelSample[]) => scheduleProbes({ day_start_ms: 0, day_end_ms: 180_000, level_samples: s })[0];
    expect(one(samples(0.02, 0))).toMatchObject({ preselect: "extract", preselect_source: "levels" });
    expect(one(samples(0.0005, 0))).toMatchObject({ preselect: "skip_quiet", preselect_source: "levels" });
    expect(one(samples(0.0005, 0.99))).toMatchObject({ preselect: "skip_dead_mic", preselect_source: "levels" });
  });
  it("level samples covering only part of a probe are not evidence: the probe is extracted", () => {
    const partial = Array.from({ length: 30 }, (_, i) => lvl(i * 2000, 0.0005, 0.99));   // first 58 s only
    expect(scheduleProbes({ day_start_ms: 0, day_end_ms: 180_000, level_samples: partial })[0])
      .toMatchObject({ preselect: "extract", preselect_source: "none" });
  });
  it("refuses a non-positive hop rather than looping forever", () => {
    expect(() => scheduleProbes({ day_start_ms: 0, day_end_ms: 600_000, hop_s: 0 })).toThrow();
  });
});

// ── mapping ──────────────────────────────────────────────────────────────────────────────────────
describe("E-1 mapProbeToChunks — exact sample offsets from each chunk's own start", () => {
  it("a probe straddling a boundary takes the exact tail of one chunk and head of the next", () => {
    const { chunks } = makeChunks();
    const start = T0 + 250_000;                                          // 50 s before chunk 0 ends
    const m = mapProbeToChunks({ start_ms: start, end_ms: start + 180_000 }, chunks);
    expect(m.pieces).toEqual([
      { chunk_idx: 0, r2_key: chunks[0].r2_key, sample_start: 250 * SR, sample_end: 300 * SR },
      { chunk_idx: 1, r2_key: chunks[1].r2_key, sample_start: 0, sample_end: 130 * SR },
    ]);
    expect(m.mapped_samples).toBe(180 * SR);
    expect(m.expected_samples).toBe(180 * SR);
    expect(m.coverage).toBe(1);
  });
  it("a gap between chunks shows as coverage below 1, never papered over", () => {
    const { chunks } = makeChunks();
    const gapped = [chunks[0], { ...chunks[1], start_ms: chunks[1].start_ms + 30_000 }];   // 30 s hole
    const start = T0 + 250_000;
    const m = mapProbeToChunks({ start_ms: start, end_ms: start + 180_000 }, gapped);
    expect(m.mapped_samples).toBe(150 * SR);
    expect(m.coverage).toBeCloseTo(150 / 180, 6);
  });
});

// ── extraction and the contract ──────────────────────────────────────────────────────────────────
describe("E-1 extract contract — checksum round-trip on fixture audio", () => {
  const probe = { start_ms: T0 + 250_000, end_ms: T0 + 430_000 };

  it("extract -> store -> re-read -> the same sha256, and exactly 180 s of samples", async () => {
    const { chunks, store } = makeChunks();
    const { contract, pcm } = await extractProbe(probe, chunks, ioFor(store));
    expect(contract.version).toBe(EXTRACT_CONTRACT_VERSION);
    expect(contract.total_samples).toBe(180 * SR);
    expect(contract.coverage).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), "ec-"));
    try {
      const p = join(dir, "probe.pcm");
      writeFileSync(p, pcmToLeBytes(pcm));
      expect(sha256Hex(readFileSync(p))).toBe(contract.pcm_sha256);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("each piece carries its chunk's sha256 as fetched — the recorded object, not a re-encode", async () => {
    const { chunks, store } = makeChunks();
    const { contract } = await extractProbe(probe, chunks, ioFor(store));
    expect(contract.pieces.map((p) => p.chunk_sha256)).toEqual([sha256Hex(store.get(chunks[0].r2_key)!), sha256Hex(store.get(chunks[1].r2_key)!)]);
  });
  it("a second, independent extraction reproduces the contract exactly", async () => {
    const { chunks, store } = makeChunks();
    const a = await extractProbe(probe, chunks, ioFor(store)), b = await extractProbe(probe, chunks, ioFor(store));
    expect(b.contract).toEqual(a.contract);
    expect(await verifyContract(a.contract, chunks, ioFor(store))).toEqual({ ok: true, mismatches: [] });
  });
  it("a changed byte inside the probe's range fails both the chunk hash and the probe hash", async () => {
    const { chunks, store } = makeChunks();
    const { contract } = await extractProbe(probe, chunks, ioFor(store));
    const b = store.get(chunks[1].r2_key)!; b[44 + 1000] ^= 0xff;                   // inside chunk 1's first 130 s
    const v = await verifyContract(contract, chunks, ioFor(store));
    expect(v.ok).toBe(false);
    expect(v.mismatches).toEqual(expect.arrayContaining(["chunk 1: sha256 changed", "probe pcm sha256 changed"]));
  });
  it("a changed byte the probe never uses still fails — the chunk hash is checked, not only the audio", async () => {
    const { chunks, store } = makeChunks();
    const { contract } = await extractProbe(probe, chunks, ioFor(store));
    const b = store.get(chunks[1].r2_key)!; b[b.length - 2] ^= 0xff;               // chunk 1's last sample, outside the probe
    const v = await verifyContract(contract, chunks, ioFor(store));
    expect(v.ok).toBe(false);
    expect(v.mismatches).toEqual(["chunk 1: sha256 changed"]);
  });
  it("a chunk that decodes short contributes what it has, and coverage says so", async () => {
    const { chunks, store } = makeChunks();
    const short: ChunkIO = { ...ioFor(store), decode: async (b, r) => decodeWav(b, r).subarray(0, 100 * SR) };
    const { contract } = await extractProbe(probe, chunks, short);
    expect(contract.total_samples).toBe(100 * SR);                                 // chunk 0 range 250-300 s is past 100 s
    expect(contract.coverage).toBeCloseTo(100 / 180, 6);
  });
  it("the probe hash is taken over little-endian int16, whatever the host", () => {
    expect([...pcmToLeBytes(Int16Array.from([1, -2, 256]))]).toEqual([1, 0, 254, 255, 0, 1]);
  });
});

// ── the flag ─────────────────────────────────────────────────────────────────────────────────────
describe("ENCOUNTER_CLOCK — default off, through the one flag parser", () => {
  it("is off when unset and on only for a truthy value", () => {
    expect(ENCOUNTER_CLOCK).toBe("ENCOUNTER_CLOCK");
    expect(encounterClockEnabled({})).toBe(false);
    expect(encounterClockEnabled({ ENCOUNTER_CLOCK: "0" })).toBe(false);
    expect(encounterClockEnabled({ ENCOUNTER_CLOCK: "1" })).toBe(true);
  });
  it("an unrecognised value throws; it never reads as off", () => {
    expect(() => encounterClockEnabled({ ENCOUNTER_CLOCK: "enabled-ish" })).toThrow(FlagValueError);
  });
});
