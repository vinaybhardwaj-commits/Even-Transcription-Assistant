/**
 * lib/audio-duration.ts — S8A-FIX (F2): the duration of an audio object MEASURED FROM ITS OWN CONTAINER, with no ffprobe and no client-supplied
 * value. Returns milliseconds, or null when the container gives nothing. The caller refuses (`duration_unknown`) on null rather than guess.
 *
 *   WAV   data-chunk size / byte rate from the header.
 *   OGG   the last page's granule position (the end of the stream) minus the Opus pre-skip, at 48 kHz (Vorbis: its own sample rate).
 *   WebM  Matroska: Info/Duration x TimecodeScale when the muxer wrote it; else the timestamp of the LAST block (MediaRecorder streams carry no
 *         Duration). Clusters of unknown size (live muxing) are walked through, not skipped.
 *
 * PURE and bounded: it reads the bytes it is given, never more than MAX_ELEMENTS elements, and never throws.
 */

const MAX_ELEMENTS = 2_000_000;

const u32le = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const u16le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const tag = (b: Uint8Array, o: number, s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
};

function wavMs(b: Uint8Array): number | null {
  if (b.length < 44 || !tag(b, 0, "RIFF") || !tag(b, 8, "WAVE")) return null;
  let byteRate = 0;
  let o = 12;
  while (o + 8 <= b.length) {
    const size = u32le(b, o + 4);
    if (tag(b, o, "fmt ") && o + 20 <= b.length) byteRate = u32le(b, o + 16);
    if (tag(b, o, "data")) {
      // a streamed file can carry 0 or 0xFFFFFFFF here: then the bytes actually present are the data
      const present = b.length - (o + 8);
      const dataSize = size === 0 || size === 0xffffffff || size > present ? present : size;
      return byteRate > 0 ? Math.round((dataSize / byteRate) * 1000) : null;
    }
    o += 8 + size + (size % 2);
  }
  return null;
}

function oggMs(b: Uint8Array): number | null {
  if (b.length < 64 || !tag(b, 0, "OggS")) return null;
  // first page: the codec header
  let rate = 0;
  let preSkip = 0;
  const segs = b[26]!;
  const hdr = 27 + segs;
  if (tag(b, hdr, "OpusHead")) {
    preSkip = u16le(b, hdr + 10);
    rate = 48_000; // Opus granule positions are always at 48 kHz
  } else if (b[hdr] === 1 && tag(b, hdr + 1, "vorbis")) {
    rate = u32le(b, hdr + 12);
  } else return null;
  if (!rate) return null;
  // last page: scan backwards for the final "OggS"
  let granule = -1;
  for (let i = b.length - 27; i >= 0; i--) {
    if (b[i] === 0x4f && tag(b, i, "OggS")) {
      const lo = u32le(b, i + 6);
      const hi = u32le(b, i + 10);
      if (lo === 0xffffffff && hi === 0xffffffff) continue; // -1: no packet finished on this page
      granule = hi * 4_294_967_296 + lo;
      break;
    }
  }
  if (granule < 0) return null;
  const samples = granule - preSkip;
  return samples > 0 ? Math.round((samples / rate) * 1000) : null;
}

// --- Matroska / WebM -----------------------------------------------------------------------------------------------------------------------
const ID = { segment: 0x18538067, info: 0x1549a966, cluster: 0x1f43b675, blockGroup: 0xa0, timecode: 0xe7, simpleBlock: 0xa3, block: 0xa1, scale: 0x2ad7b1, duration: 0x4489, ebml: 0x1a45dfa3 };
const MASTERS = new Set([ID.segment, ID.info, ID.cluster, ID.blockGroup]);

/** EBML element id (kept with its marker bits) at `o`: [id, length] or null. */
function readId(b: Uint8Array, o: number): [number, number] | null {
  const first = b[o];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 4 || o + len > b.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[o + i]!;
  return [v, len];
}
/** EBML data size at `o`: [size, length] (size -1 = unknown), or null. */
function readSize(b: Uint8Array, o: number): [number, number] | null {
  const first = b[o];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || o + len > b.length) return null;
  let v = first & (0xff >> len);
  let allOnes = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[o + i]!;
    if (b[o + i] !== 0xff) allOnes = false;
  }
  return [allOnes ? -1 : v, len];
}
const uintAt = (b: Uint8Array, o: number, n: number): number => {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i]!;
  return v;
};
function floatAt(b: Uint8Array, o: number, n: number): number | null {
  const dv = new DataView(b.buffer, b.byteOffset + o, n);
  return n === 4 ? dv.getFloat32(0) : n === 8 ? dv.getFloat64(0) : null;
}

function webmMs(b: Uint8Array): number | null {
  if (b.length < 16 || readId(b, 0)?.[0] !== ID.ebml) return null;
  let o = 0;
  let scale = 1_000_000; // ns per timecode tick, the Matroska default
  let declared: number | null = null;
  let clusterTc = 0;
  let lastBlockTicks = -1;
  let n = 0;
  while (o < b.length && n++ < MAX_ELEMENTS) {
    const id = readId(b, o);
    if (!id) break;
    const sz = readSize(b, o + id[1]);
    if (!sz) break;
    const dataStart = o + id[1] + sz[1];
    const [idv] = id;
    if (MASTERS.has(idv)) {
      o = dataStart; // descend: children follow immediately (sizes may be unknown)
      continue;
    }
    if (sz[0] < 0) break; // unknown size on a non-master element: cannot walk further
    const end = dataStart + sz[0];
    if (end > b.length && idv !== ID.simpleBlock && idv !== ID.block) break;
    if (idv === ID.scale) scale = uintAt(b, dataStart, Math.min(sz[0], 8)) || scale;
    else if (idv === ID.duration) declared = floatAt(b, dataStart, sz[0]);
    else if (idv === ID.timecode) clusterTc = uintAt(b, dataStart, Math.min(sz[0], 8));
    else if (idv === ID.simpleBlock || idv === ID.block) {
      const track = readSize(b, dataStart);
      if (track && dataStart + track[1] + 2 <= b.length) {
        let rel = (b[dataStart + track[1]]! << 8) | b[dataStart + track[1] + 1]!;
        if (rel & 0x8000) rel -= 0x10000;
        lastBlockTicks = Math.max(lastBlockTicks, clusterTc + rel);
      }
    }
    o = end;
  }
  if (declared !== null && Number.isFinite(declared) && declared > 0) return Math.round((declared * scale) / 1_000_000);
  if (lastBlockTicks > 0) return Math.round((lastBlockTicks * scale) / 1_000_000);
  return null;
}

/** The measured duration in milliseconds, or null when the container says nothing (the caller refuses; it does not guess). */
export function measureAudioMs(bytes: Uint8Array): number | null {
  try {
    return wavMs(bytes) ?? oggMs(bytes) ?? webmMs(bytes);
  } catch {
    return null;
  }
}
