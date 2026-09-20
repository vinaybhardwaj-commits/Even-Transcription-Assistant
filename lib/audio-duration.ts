/**
 * lib/audio-duration.ts — how long is this clip, from its own bytes.
 *
 * WHY THIS EXISTS. The enrolment gate counts clips (`ok.length < 3`) and has never measured one, so
 * three one-second clips enrol exactly as readily as three good ones. To put a floor under that we
 * need a duration, and nothing upstream supplies one: the Mini's `/enroll` returns an embedding and
 * nothing else (lib/enroll.ts), the browser sends only the blob, and the server has no ffmpeg. So
 * the duration is read out of the container.
 *
 * TWO SOURCES, IN ORDER OF TRUST:
 *   1. Segment > Info > Duration (0x4489), scaled by TimecodeScale. A FINALISED WebM has it.
 *   2. The last Cluster's Timecode (0xE7) plus its last SimpleBlock's relative offset. A STREAMED
 *      WebM — which is what MediaRecorder produces, verified: ffmpeg's `-live 1` output has no
 *      0x4489 at all — has only this.
 *
 * FAIL SAFE, NOT FAIL OPEN. Source 2 can only UNDER-report (it cannot see past the last block it
 * can parse), and an unparseable clip returns null. A caller enforcing a minimum therefore rejects
 * what it cannot prove is long enough, which is the safe direction for a gate whose whole purpose
 * is to stop short clips being enrolled.
 */

export type DurationBasis = "duration_element" | "cluster_timecode";
export type ClipDuration = { ms: number; basis: DurationBasis };

/** EBML variable-size integer. Returns the value, its byte length, and whether it was "unknown". */
function readVint(buf: Buffer, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | null {
  if (at >= buf.length) return null;
  const first = buf[at]!;
  if (first === 0) return null; // 8+ byte lengths are not produced by any audio muxer we accept
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || at + length > buf.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    const b = buf[at + i]!;
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

const ID = {
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
} as const;

/** Master elements we descend into rather than skip over. */
const MASTERS = new Set<number>([ID.SEGMENT, ID.INFO, ID.CLUSTER]);

function readUint(buf: Buffer, at: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[at + i]!;
  return v;
}

/**
 * A streamed WebM gives every Cluster an UNKNOWN size, so a structural walk cannot tell where one
 * ends and the next begins. This scans for Cluster ids directly and reads the Timecode that opens
 * each one — the only field of a live stream that states elapsed time.
 */
function lastClusterTimecodeMs(buf: Buffer, timecodeScaleNs: number): number | null {
  let best: number | null = null;
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] !== 0x1f || buf[i + 1] !== 0x43 || buf[i + 2] !== 0xb6 || buf[i + 3] !== 0x75) continue;
    const size = readVint(buf, i + 4, false);
    if (!size) continue;
    let at = i + 4 + size.length;
    const id = readVint(buf, at, true);
    if (!id || id.value !== ID.TIMECODE) continue;
    const tcSize = readVint(buf, at + id.length, false);
    if (!tcSize) continue;
    at += id.length + tcSize.length;
    if (at + tcSize.value > buf.length) continue;
    const ms = (readUint(buf, at, tcSize.value) * timecodeScaleNs) / 1_000_000;
    if (best === null || ms > best) best = ms;
  }
  return best;
}

/**
 * The clip's duration in milliseconds, or null when the bytes do not say.
 *
 * Only WebM/Matroska is parsed. Any other container (or a truncated one) returns null, and the
 * caller treats "we do not know" as "not proven long enough" rather than as "fine".
 */
export function webmDurationMs(input: Buffer | Uint8Array): ClipDuration | null {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  // EBML header magic. Anything else is not a WebM and we do not guess.
  if (buf.length < 4 || buf.readUInt32BE(0) !== 0x1a45dfa3) return null;

  let timecodeScaleNs = 1_000_000; // Matroska default: 1 ms per tick
  let durationTicks: number | null = null;
  let lastClusterEndMs: number | null = null;

  const walk = (start: number, end: number, depth: number): void => {
    let at = start;
    while (at < end && depth < 6) {
      const id = readVint(buf, at, true);
      if (!id) return;
      const size = readVint(buf, at + id.length, false);
      if (!size) return;
      const contentAt = at + id.length + size.length;
      const contentEnd = size.unknown ? end : Math.min(end, contentAt + size.value);
      if (contentAt > end) return;

      switch (id.value) {
        case ID.TIMECODE_SCALE:
          timecodeScaleNs = readUint(buf, contentAt, size.value) || timecodeScaleNs;
          break;
        case ID.DURATION: {
          // Matroska stores Duration as a float, 4 or 8 bytes.
          if (size.value === 4) durationTicks = buf.readFloatBE(contentAt);
          else if (size.value === 8) durationTicks = buf.readDoubleBE(contentAt);
          break;
        }
        case ID.TIMECODE: {
          const clusterMs = (readUint(buf, contentAt, size.value) * timecodeScaleNs) / 1_000_000;
          if (lastClusterEndMs === null || clusterMs > lastClusterEndMs) lastClusterEndMs = clusterMs;
          break;
        }
        default:
          break;
      }

      if (MASTERS.has(id.value)) walk(contentAt, contentEnd, depth + 1);
      if (size.unknown) {
        // An unknown-size master runs to the end of its parent; we have already descended.
        return;
      }
      at = contentAt + size.value;
    }
  };

  walk(0, buf.length, 0);

  if (durationTicks !== null && durationTicks > 0) {
    return { ms: Math.round((durationTicks * timecodeScaleNs) / 1_000_000), basis: "duration_element" };
  }
  const scanned = lastClusterTimecodeMs(buf, timecodeScaleNs);
  const clusterMs = Math.max(lastClusterEndMs ?? 0, scanned ?? 0);
  if (clusterMs > 0) return { ms: Math.round(clusterMs), basis: "cluster_timecode" };
  return null;
}
