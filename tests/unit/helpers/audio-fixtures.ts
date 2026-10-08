/** Synthetic audio containers for tests: just enough header to carry a duration. No real audio, no speech. */

const cat = (...parts: Array<Uint8Array | number[]>): Uint8Array => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const le16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
const ascii = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));

export function wav(seconds: number, opts: { byteRate?: number; sizeField?: "real" | "zero" } = {}): Uint8Array {
  const byteRate = opts.byteRate ?? 32_000;
  const dataLen = Math.round(seconds * byteRate);
  const header = cat(ascii("RIFF"), le32(36 + dataLen), ascii("WAVE"), ascii("fmt "), le32(16), le16(1), le16(1), le32(16_000), le32(byteRate), le16(2), le16(16), ascii("data"), le32(opts.sizeField === "zero" ? 0 : dataLen));
  return cat(header, new Uint8Array(dataLen));
}

function oggPage(headerType: number, granule: number, seq: number, payload: number[]): Uint8Array {
  const lo = granule % 4_294_967_296;
  const hi = Math.floor(granule / 4_294_967_296);
  return cat(ascii("OggS"), [0, headerType], le32(lo), le32(hi), le32(0x1234), le32(seq), le32(0), [1, payload.length], payload);
}
export function oggOpus(seconds: number, preSkip = 312): Uint8Array {
  const head = [...ascii("OpusHead"), 1, 1, ...le16(preSkip), ...le32(48_000), 0, 0, 0];
  return cat(oggPage(2, 0, 0, head), oggPage(0, 0, 1, [...ascii("OpusTags"), 0, 0, 0, 0, 0, 0, 0, 0]), oggPage(0, Math.round(seconds * 48_000) + preSkip, 2, [1, 2, 3]), oggPage(4, Math.round(seconds * 48_000) + preSkip, 3, [4]));
}

// --- Matroska / WebM -------------------------------------------------------------------------------------------------------------------------
const size = (n: number | "unknown"): number[] => (n === "unknown" ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] : n < 127 ? [0x80 | n] : [0x01, 0, 0, 0, ...[(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]]);
const el = (id: number[], payload: Uint8Array | number[], len: number | "unknown" = payload.length): Uint8Array => cat(id, size(len), payload);
const uint = (v: number): number[] => { const b: number[] = []; let x = v; do { b.unshift(x & 0xff); x = Math.floor(x / 256); } while (x > 0); return b; };
const f64 = (v: number): number[] => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return Array.from(b); };

const EBML = [0x1a, 0x45, 0xdf, 0xa3], SEGMENT = [0x18, 0x53, 0x80, 0x67], INFO = [0x15, 0x49, 0xa9, 0x66], CLUSTER = [0x1f, 0x43, 0xb6, 0x75];
const TIMECODE = [0xe7], SIMPLEBLOCK = [0xa3], SCALE = [0x2a, 0xd7, 0xb1], DURATION = [0x44, 0x89];

const block = (relMs: number): Uint8Array => el(SIMPLEBLOCK, [0x81, (relMs >> 8) & 0xff, relMs & 0xff, 0x80, 9, 9, 9]);

/** A WebM. `declaredMs`: write Info/Duration (a muxer that finalises); else only Clusters (MediaRecorder: no Duration), whose last block carries the end. */
export function webm(opts: { declaredMs?: number; clusters?: Array<{ tc: number; blocksRel: number[] }>; unknownSizes?: boolean }): Uint8Array {
  const unknown = opts.unknownSizes ?? true;
  const header = el(EBML, [0x42, 0x82, 0x84, ...ascii("webm")]);
  const info = el(INFO, cat(el(SCALE, uint(1_000_000)), opts.declaredMs !== undefined ? el(DURATION, f64(opts.declaredMs)) : new Uint8Array(0)));
  const clusters = (opts.clusters ?? []).map((c) => {
    const inner = cat(el(TIMECODE, uint(c.tc)), ...c.blocksRel.map(block));
    return el(CLUSTER, inner, unknown ? "unknown" : inner.length);
  });
  const body = cat(info, ...clusters);
  return cat(header, el(SEGMENT, body, unknown ? "unknown" : body.length));
}

// --- MP4 / M4A -------------------------------------------------------------------------------------------------------------------------------
const be32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const be64 = (v: number): number[] => [...be32(Math.floor(v / 4_294_967_296)), ...be32(v % 4_294_967_296)];
const box = (type: string, ...payload: Array<Uint8Array | number[]>): Uint8Array => {
  const body = cat(...payload);
  return cat(be32(8 + body.length), ascii(type), body);
};
const ftyp = (): Uint8Array => box("ftyp", ascii("M4A "), be32(0), ascii("M4A isom"));
/** mvhd / mdhd body: version 0 (32-bit) or 1 (64-bit duration), timescale, duration */
const hd = (timescale: number, duration: number, v1 = false): number[] =>
  v1 ? [1, 0, 0, 0, ...be64(0), ...be64(0), ...be32(timescale), ...be64(duration), ...new Array(80).fill(0)] : [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(timescale), ...be32(duration), ...new Array(80).fill(0)];

/** A classic (non-fragmented) m4a: moov/mvhd + trak/mdia/mdhd + stts. Any of the three can be left out or made to lie. */
export function m4a(opts: { mvhd?: { timescale: number; duration: number; v1?: boolean }; mdhd?: { timescale: number; duration: number; v1?: boolean }; stts?: Array<[count: number, delta: number]> }): Uint8Array {
  const stbl = opts.stts ? box("stbl", box("stts", [0, 0, 0, 0], be32(opts.stts.length), ...opts.stts.map(([c, d]) => [...be32(c), ...be32(d)]))) : new Uint8Array(0);
  const mdia = box("mdia", opts.mdhd ? box("mdhd", hd(opts.mdhd.timescale, opts.mdhd.duration, opts.mdhd.v1)) : new Uint8Array(0), opts.stts ? box("minf", stbl) : new Uint8Array(0));
  return cat(ftyp(), box("moov", opts.mvhd ? box("mvhd", hd(opts.mvhd.timescale, opts.mvhd.duration, opts.mvhd.v1)) : new Uint8Array(0), box("trak", mdia)), box("mdat", [1, 2, 3, 4]));
}

/** A fragmented m4a (what a browser MediaRecorder writes): mvhd with duration 0, mdhd, optional mehd, moof/traf/trun runs. */
export function fmp4(opts: { mdhdScale: number; mehd?: number; movieScale?: number; runs?: Array<{ durations?: number[]; count?: number; defaultDuration?: number }> }): Uint8Array {
  const moov = box("moov", box("mvhd", hd(opts.movieScale ?? 1000, 0)), box("trak", box("mdia", box("mdhd", hd(opts.mdhdScale, 0)))), opts.mehd !== undefined ? box("mvex", box("mehd", [0, 0, 0, 0], be32(opts.mehd))) : new Uint8Array(0));
  const moofs = (opts.runs ?? []).map((r) => {
    const tfhd = box("tfhd", [0, 0, 0, r.defaultDuration !== undefined ? 0x08 : 0], be32(1), r.defaultDuration !== undefined ? be32(r.defaultDuration) : []);
    const trun = r.durations
      ? box("trun", [0, 0, 0x01, 0x00], be32(r.durations.length), ...r.durations.map((d) => be32(d)))
      : box("trun", [0, 0, 0, 0], be32(r.count ?? 0));
    return box("moof", box("traf", tfhd, trun));
  });
  return cat(ftyp(), moov, ...moofs, box("mdat", [1, 2, 3]));
}
