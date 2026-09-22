/**
 * lib/encounter-clock/probe.ts — E-1, the probe scheduler and its extract contract (PLAN v2.1 §3C).
 *
 * PURE except for the two functions it is handed: `fetchChunk` (the original chunk object's bytes)
 * and `decode` (those bytes to mono 16-bit PCM). No route, no DB, no R2 client lives here.
 *
 * ORIGINAL CHUNKS, NEVER THE JOINED CLIP (measured 22 Sep, ledger [speech]): the joined extract is a
 * re-encode — 12 ms long on a 180 s probe and ~10 ms offset, differing from the chunk audio on 99.7%
 * of samples — so its checksum depends on which path fetched it. The chunk objects are the recorded
 * bytes; their sha256 round-tripped 250/250 across two days, and they are not blocked while a room
 * records. A probe is therefore identified by the chunks it came from, each chunk's sha256, and the
 * exact sample range taken from each — which anyone can re-derive and re-check.
 */
import { createHash } from "node:crypto";
import type { BenchLevelSample } from "@/lib/bench-levels";
import { DEFAULT_ROOM_ENERGY_FLOOR } from "@/lib/stt/window-measure";
import { energyHalf, levelSamplesIn } from "@/lib/encounter-clock/gate";

export const PROBE_SECONDS = 180;
export const HOP_SECONDS = 60;
export const PROBE_SAMPLE_RATE = 16000;
export const EXTRACT_CONTRACT_VERSION = "encounter-clock-extract-v1";

// ── scheduling ───────────────────────────────────────────────────────────────────────────────────

/**
 * What the level log lets the scheduler decide before anything is fetched:
 *   extract        fetch and decode it (active in the level log, or no usable level evidence)
 *   skip_dead_mic  the level log says the input was lost: fetching it would decode nothing
 *   skip_quiet     the level log says the room was quiet at the floor: no audio needed to say so
 * A skip is a decision from EVIDENCE; a probe with no level coverage is always extracted.
 */
export type Preselect = "extract" | "skip_dead_mic" | "skip_quiet";

export type ProbeInstant = {
  index: number;
  start_ms: number;
  end_ms: number;
  preselect: Preselect;
  /** "levels" when the level log decided it; "none" when there was no usable level evidence. */
  preselect_source: "levels" | "none";
};

export function scheduleProbes(input: {
  day_start_ms: number;
  day_end_ms: number;
  level_samples?: BenchLevelSample[] | null;
  floor?: number;
  probe_s?: number;
  hop_s?: number;
}): ProbeInstant[] {
  const probe = (input.probe_s ?? PROBE_SECONDS) * 1000;
  const hop = (input.hop_s ?? HOP_SECONDS) * 1000;
  if (!(hop > 0) || !(probe > 0)) throw new Error("probe and hop must be positive");
  const out: ProbeInstant[] = [];
  for (let t = input.day_start_ms, i = 0; t + probe <= input.day_end_ms; t += hop, i++) {
    const inside = input.level_samples ? levelSamplesIn(input.level_samples, t, t + probe) : null;
    if (!inside) { out.push({ index: i, start_ms: t, end_ms: t + probe, preselect: "extract", preselect_source: "none" }); continue; }
    const e = energyHalf({ kind: "levels", samples: inside }, input.floor ?? DEFAULT_ROOM_ENERGY_FLOOR);
    const preselect: Preselect = e.state === "dead_mic" ? "skip_dead_mic" : e.state === "quiet" ? "skip_quiet" : "extract";
    out.push({ index: i, start_ms: t, end_ms: t + probe, preselect, preselect_source: e.state === "missing" ? "none" : "levels" });
  }
  return out;
}

// ── mapping a probe onto the original chunks ──────────────────────────────────────────────────────

export type ClockChunk = { idx: number; r2_key: string; start_ms: number; end_ms: number };

export type ChunkPiece = {
  chunk_idx: number;
  r2_key: string;
  /** First and one-past-last sample taken from the chunk's decoded PCM, at the contract's rate. */
  sample_start: number;
  sample_end: number;
};

const toSample = (ms: number, rate: number): number => Math.round((ms / 1000) * rate);

/**
 * The chunks a probe needs and the exact samples from each. Chunks are not grid-aligned (a chunk
 * can start at 13:57:12.558), so offsets are computed from each chunk's own start. A gap between
 * chunks shows up as coverage below 1; it is never papered over.
 */
export function mapProbeToChunks(probe: { start_ms: number; end_ms: number }, chunks: ClockChunk[], rate = PROBE_SAMPLE_RATE):
  { pieces: ChunkPiece[]; expected_samples: number; mapped_samples: number; coverage: number } {
  const expected = toSample(probe.end_ms - probe.start_ms, rate);
  const pieces: ChunkPiece[] = [];
  for (const c of [...chunks].sort((a, b) => a.start_ms - b.start_ms)) {
    const a = Math.max(probe.start_ms, c.start_ms), b = Math.min(probe.end_ms, c.end_ms);
    if (b <= a) continue;
    const s0 = toSample(a - c.start_ms, rate), s1 = toSample(b - c.start_ms, rate);
    if (s1 > s0) pieces.push({ chunk_idx: c.idx, r2_key: c.r2_key, sample_start: s0, sample_end: s1 });
  }
  const mapped = pieces.reduce((n, p) => n + (p.sample_end - p.sample_start), 0);
  return { pieces, expected_samples: expected, mapped_samples: mapped, coverage: expected ? Math.min(1, mapped / expected) : 0 };
}

// ── extraction and its contract ──────────────────────────────────────────────────────────────────

export type ChunkIO = {
  /** The ORIGINAL chunk object's bytes, exactly as stored. */
  fetchChunk: (chunk: ClockChunk) => Promise<Uint8Array>;
  /** Those bytes decoded to mono signed 16-bit PCM at `rate`. Must be deterministic for equal input. */
  decode: (bytes: Uint8Array, rate: number) => Promise<Int16Array>;
};

export type ExtractContract = {
  version: typeof EXTRACT_CONTRACT_VERSION;
  probe: { start_ms: number; end_ms: number };
  sample_rate: number;
  pieces: Array<ChunkPiece & { chunk_sha256: string; decoded_samples: number }>;
  expected_samples: number;
  total_samples: number;
  coverage: number;
  /** sha256 of the probe's PCM as little-endian int16 — fixed byte order, so it is platform-free. */
  pcm_sha256: string;
};

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Int16 samples as little-endian bytes, whatever the host's byte order. */
export function pcmToLeBytes(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2), dv = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(i * 2, pcm[i], true);
  return out;
}

/**
 * Extract one probe from the original chunks. Each chunk is fetched once and hashed as fetched; the
 * probe PCM is the concatenation of the exact sample ranges. A chunk that decodes shorter than the
 * range asked of it contributes what it has, and coverage says so.
 */
export async function extractProbe(probe: { start_ms: number; end_ms: number }, chunks: ClockChunk[], io: ChunkIO,
  rate = PROBE_SAMPLE_RATE): Promise<{ contract: ExtractContract; pcm: Int16Array }> {
  const map = mapProbeToChunks(probe, chunks, rate);
  const byIdx = new Map(chunks.map((c) => [c.idx, c]));
  const parts: Int16Array[] = [];
  const pieces: ExtractContract["pieces"] = [];
  for (const p of map.pieces) {
    const bytes = await io.fetchChunk(byIdx.get(p.chunk_idx)!);
    const pcm = await io.decode(bytes, rate);
    const end = Math.min(p.sample_end, pcm.length), start = Math.min(p.sample_start, end);
    parts.push(pcm.subarray(start, end));
    pieces.push({ ...p, chunk_sha256: sha256Hex(bytes), decoded_samples: pcm.length });
  }
  const total = parts.reduce((n, x) => n + x.length, 0);
  const pcm = new Int16Array(total);
  let off = 0;
  for (const x of parts) { pcm.set(x, off); off += x.length; }
  const contract: ExtractContract = {
    version: EXTRACT_CONTRACT_VERSION, probe: { start_ms: probe.start_ms, end_ms: probe.end_ms }, sample_rate: rate,
    pieces, expected_samples: map.expected_samples, total_samples: total,
    coverage: map.expected_samples ? Math.min(1, total / map.expected_samples) : 0,
    pcm_sha256: sha256Hex(pcmToLeBytes(pcm)),
  };
  return { contract, pcm };
}

/**
 * Re-derive a contract from scratch and say exactly what no longer matches: a chunk whose bytes
 * changed, a chunk that moved, or the probe audio itself. `ok` only when every hash agrees.
 */
export async function verifyContract(contract: ExtractContract, chunks: ClockChunk[], io: ChunkIO):
  Promise<{ ok: boolean; mismatches: string[] }> {
  const again = await extractProbe(contract.probe, chunks, io, contract.sample_rate);
  const mismatches: string[] = [];
  const now = new Map(again.contract.pieces.map((p) => [p.chunk_idx, p]));
  for (const p of contract.pieces) {
    const q = now.get(p.chunk_idx);
    if (!q) { mismatches.push(`chunk ${p.chunk_idx}: no longer maps to this probe`); continue; }
    if (q.chunk_sha256 !== p.chunk_sha256) mismatches.push(`chunk ${p.chunk_idx}: sha256 changed`);
    if (q.sample_start !== p.sample_start || q.sample_end !== p.sample_end) mismatches.push(`chunk ${p.chunk_idx}: sample range changed`);
  }
  if (again.contract.pieces.length !== contract.pieces.length) mismatches.push("piece count changed");
  if (again.contract.pcm_sha256 !== contract.pcm_sha256) mismatches.push("probe pcm sha256 changed");
  return { ok: mismatches.length === 0, mismatches };
}
