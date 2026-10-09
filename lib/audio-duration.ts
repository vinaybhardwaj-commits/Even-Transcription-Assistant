/**
 * lib/audio-duration.ts — S8A-FIX (F2): the duration of an audio object MEASURED FROM ITS OWN CONTAINER, with no ffprobe and no client-supplied
 * value. Returns milliseconds, or null when the container gives nothing. The caller refuses (`duration_unknown`) on null rather than guess.
 *
 *   WAV   data-chunk size / byte rate from the header.
 *   OGG   the last page's granule position (the end of the stream) minus the Opus pre-skip, at 48 kHz (Vorbis: its own sample rate).
 *   WebM  Matroska: the LONGER of Info/Duration x TimecodeScale (when the muxer wrote it) and the timestamp of the LAST block (MediaRecorder streams
 *         carry no Duration). A declared Duration can therefore never make a long file look short. Clusters of unknown size (live muxing) are walked through.
 *   MP4   ISO base media (m4a / audio/mp4, what Safari and iPhones record): the LONGEST of mvhd, mdhd, the fragment header (mehd), the sample table
 *         (stts) and the fragment runs (trun), so a lying movie header cannot hide the samples.
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
  // G8: the LONGER of the two. A header that declares 60 s over 40 minutes of blocks measures 40 minutes.
  const fromDeclared = declared !== null && Number.isFinite(declared) && declared > 0 ? Math.round((declared * scale) / 1_000_000) : 0;
  const fromBlocks = lastBlockTicks > 0 ? Math.round((lastBlockTicks * scale) / 1_000_000) : 0;
  const best = Math.max(fromDeclared, fromBlocks);
  return best > 0 ? best : null;
}

// --- MP4 / M4A -----------------------------------------------------------------------------------------------------------------------------
const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf"]);
const u32be = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u64be = (b: Uint8Array, o: number): number => u32be(b, o) * 4_294_967_296 + u32be(b, o + 4);
const fourcc = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

function mp4Ms(b: Uint8Array): number | null {
  if (b.length < 16 || fourcc(b, 4) !== "ftyp") return null;
  let movieScale = 0, movieDur = 0, mehdDur = 0;
  let mediaScale = 0, mediaDur = 0; // first mdhd
  let pendingSamples = 0, sttsTicks = 0, trunTicks = 0, tfhdDefault = 0, trexDefault = 0;
  let boxes = 0;
  const walk = (start: number, end: number, depth: number): void => {
    let o = start;
    while (o + 8 <= end && boxes++ < MAX_ELEMENTS) {
      let size = u32be(b, o);
      const type = fourcc(b, o + 4);
      let head = 8;
      if (size === 1) { if (o + 16 > end) return; size = u64be(b, o + 8); head = 16; }
      else if (size === 0) size = end - o; // to the end of the enclosing box / file
      if (size < head || o + size > end) size = Math.min(Math.max(size, head), end - o); // truncated: read what is there
      const body = o + head;
      const bodyEnd = o + size;
      if (type === "mvhd" && bodyEnd - body >= 20) {
        if (b[body] === 1 && bodyEnd - body >= 32) { movieScale = u32be(b, body + 20); movieDur = u64be(b, body + 24); }
        else { movieScale = u32be(b, body + 12); movieDur = u32be(b, body + 16); }
      } else if (type === "mdhd" && mediaScale === 0 && bodyEnd - body >= 20) {
        if (b[body] === 1 && bodyEnd - body >= 32) { mediaScale = u32be(b, body + 20); mediaDur = u64be(b, body + 24); }
        else { mediaScale = u32be(b, body + 12); mediaDur = u32be(b, body + 16); }
      } else if (type === "mehd" && bodyEnd - body >= 8) {
        mehdDur = b[body] === 1 && bodyEnd - body >= 12 ? u64be(b, body + 4) : u32be(b, body + 4);
      } else if (type === "stts" && bodyEnd - body >= 8) {
        const n = Math.min(u32be(b, body + 4), Math.floor((bodyEnd - body - 8) / 8));
        for (let i = 0; i < n; i++) sttsTicks += u32be(b, body + 8 + i * 8) * u32be(b, body + 12 + i * 8);
      } else if (type === "trex" && bodyEnd - body >= 24) {
        // moov/mvex/trex: the default_sample_duration every fragment falls back on when its own tfhd / trun say nothing (a Safari MediaRecorder layout)
        trexDefault = u32be(b, body + 12);
      } else if (type === "tfhd" && bodyEnd - body >= 8) {
        const flags = u32be(b, body) & 0xffffff;
        let p = body + 8; // version/flags + track id
        if (flags & 0x1) p += 8;
        if (flags & 0x2) p += 4;
        tfhdDefault = flags & 0x8 && p + 4 <= bodyEnd ? u32be(b, p) : 0;
      } else if (type === "trun" && bodyEnd - body >= 8) {
        const flags = u32be(b, body) & 0xffffff;
        const count = u32be(b, body + 4);
        let p = body + 8;
        if (flags & 0x1) p += 4;
        if (flags & 0x4) p += 4;
        const per = 4 * ((flags & 0x100 ? 1 : 0) + (flags & 0x200 ? 1 : 0) + (flags & 0x400 ? 1 : 0) + (flags & 0x800 ? 1 : 0));
        if (flags & 0x100 && per > 0) for (let i = 0; i < count && p + (i + 1) * per <= bodyEnd; i++) trunTicks += u32be(b, p + i * per);
        else if (tfhdDefault > 0) trunTicks += tfhdDefault * Math.min(count, 100_000_000);
        else pendingSamples += Math.min(count, 100_000_000); // G14/G20: no per-sample durations and no tfhd default: priced at the trex default AFTER the walk, so a moov that comes LAST still counts
      } else if (MP4_CONTAINERS.has(type) && depth < 8) {
        if (type === "moof") tfhdDefault = 0;
        walk(body, bodyEnd, depth + 1);
      }
      if (bodyEnd <= o) return;
      o = bodyEnd;
    }
  };
  walk(0, b.length, 0);
  if (trexDefault > 0) trunTicks += trexDefault * pendingSamples; // G20: the moov/mvex/trex default, wherever the moov sat
  const ms = (ticks: number, scale: number): number => (ticks > 0 && scale > 0 ? Math.round((ticks * 1000) / scale) : 0);
  // G9/G8: the LONGEST of every claim the file makes, so a header cannot understate what the samples hold
  const best = Math.max(ms(movieDur, movieScale), ms(mediaDur, mediaScale), ms(mehdDur, movieScale), ms(sttsTicks, mediaScale), ms(trunTicks, mediaScale));
  return best > 0 ? best : null;
}

/**
 * S8C: FLAC (the CONSULT clips). STREAMINFO is the first metadata block: sample rate (20 bits), channels (3), bits per sample (5), total samples (36). The header is a CLAIM, so the duration is the LONGER of it and a floor
 * from the file size (a FLAC file never holds more than about 1.05x its raw PCM size per second of audio at its own rate), exactly as the other containers take the longest claim. total samples 0 = unknown = null.
 */
/** 16 kbit/s: the lowest bitrate a speech FLAC is assumed to have, so bytes / this is a LONG (conservative) duration. The duration also meets the mirror row\'s minutes x 60 in the job (max of all three). */
export const FLAC_FLOOR_BYTES_PER_S = 2_000;
function flacMs(b: Uint8Array): number | null {
  if (b.length < 42 || b[0] !== 0x66 || b[1] !== 0x4c || b[2] !== 0x61 || b[3] !== 0x43) return null; // "fLaC"
  if ((b[4]! & 0x7f) !== 0) return null; // the first block must be STREAMINFO
  const rate = (b[18]! << 12) | (b[19]! << 4) | (b[20]! >> 4);
  const channels = ((b[20]! >> 1) & 0x07) + 1;
  const bits = (((b[20]! & 0x01) << 4) | (b[21]! >> 4)) + 1;
  const total = (b[21]! & 0x0f) * 2 ** 32 + (b[22]! * 2 ** 24 + (b[23]! << 16) + (b[24]! << 8) + b[25]!);
  // S8C-2: only the cutter's format is accepted (a crafted STREAMINFO of any other shape is unknown, not guessed at)
  if (rate < 8_000 || rate > 96_000 || channels > 2 || (bits !== 16 && bits !== 24) || total <= 0) return null;
  const claim = (total * 1000) / rate;
  // the floor does NOT come from the header (it controls rate, channels and bits): a FIXED conservative bitrate, FLAC_FLOOR_BYTES_PER_S, whatever the header says
  const floor = (b.length * 1000) / FLAC_FLOOR_BYTES_PER_S;
  return Math.round(Math.max(claim, floor));
}

/** The measured duration in milliseconds, or null when the container says nothing (the caller refuses; it does not guess). */
export function measureAudioMs(bytes: Uint8Array): number | null {
  try {
    return flacMs(bytes) ?? wavMs(bytes) ?? oggMs(bytes) ?? webmMs(bytes) ?? mp4Ms(bytes);
  } catch {
    return null;
  }
}
