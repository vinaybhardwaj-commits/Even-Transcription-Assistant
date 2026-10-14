/** WAV handling for Clef. Node built-ins only. Audio is held in memory and never written anywhere. */

export const TARGET_SR = 16000
export const MAX_CLIPS = 4
export const MAX_CLIP_S = 300
export const MAX_WAV_BYTES = 8 * 1024 * 1024

export class ClefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}
export class ClefDisabled extends ClefError {}
export class ClefConfigError extends ClefError {}
export class ClefLimitError extends ClefError {}
export class ClefParseError extends ClefError {}
export class ClefBudgetError extends ClefError {}
export class ClefHttpError extends ClefError {
  constructor(
    readonly status: number,
    detail: string,
    readonly attempts: number,
  ) {
    super(detail ? `clef http ${status}: ${detail}` : `clef http ${status}`)
  }
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || (this.status >= 500 && this.status <= 599)
  }
}

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  samples: number
  seconds: number
  bytes: number
}

/** Port of check_clip_bounds. `wavBytes` is the encoded size. */
export function checkClipBounds(samples: number, sampleRate: number, wavBytes: number): void {
  if (sampleRate !== TARGET_SR) throw new ClefLimitError('clef audio must be 16000 Hz mono wav')
  if (samples <= 0) throw new ClefLimitError('clef audio is empty')
  if (samples / sampleRate > MAX_CLIP_S) throw new ClefLimitError('clef clip exceeds 300s')
  if (wavBytes > MAX_WAV_BYTES) throw new ClefLimitError('clef clip exceeds 8 MiB')
}

/** Reads the RIFF header of PCM16 WAV bytes and enforces the Clef bounds. Throws ClefLimitError. */
export function inspectWav(wav: Uint8Array): WavInfo {
  if (wav.byteLength > MAX_WAV_BYTES) throw new ClefLimitError('clef clip exceeds 8 MiB')
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const tag = (at: number): string => String.fromCharCode(...wav.subarray(at, at + 4))
  if (wav.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new ClefLimitError('clef audio is not a wav')
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null
  let dataBytes: number | null = null
  let at = 12
  while (at + 8 <= wav.byteLength) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ' && body + 16 <= wav.byteLength) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      dataBytes = Math.min(size, wav.byteLength - body)
      break
    }
    at = body + size + (size % 2)
  }
  if (!fmt || dataBytes === null) throw new ClefLimitError('clef audio is not a wav')
  if (fmt.format !== 1 || fmt.bits !== 16) throw new ClefLimitError('clef audio must be 16-bit pcm wav')
  if (fmt.channels !== 1) throw new ClefLimitError('clef audio must be 16000 Hz mono wav')
  const samples = Math.floor(dataBytes / 2)
  checkClipBounds(samples, fmt.sampleRate, wav.byteLength)
  return { sampleRate: fmt.sampleRate, channels: 1, bitsPerSample: 16, samples, seconds: samples / fmt.sampleRate, bytes: wav.byteLength }
}

/** Port of encode_wav for float samples in -1..1. */
export function encodeWav(audio: ArrayLike<number>, sampleRate: number): Uint8Array {
  if (sampleRate !== TARGET_SR) throw new ClefLimitError('clef audio must be 16000 Hz mono wav')
  if (audio.length === 0) throw new ClefLimitError('clef audio is empty')
  checkClipBounds(audio.length, sampleRate, 0)
  const out = Buffer.alloc(44 + audio.length * 2)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + audio.length * 2, 4)
  out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(audio.length * 2, 40)
  for (let i = 0; i < audio.length; i += 1) {
    const x = audio[i] as number
    if (!Number.isFinite(x)) throw new ClefLimitError('clef audio has non-finite samples')
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * 32767))), 44 + i * 2)
  }
  checkClipBounds(audio.length, sampleRate, out.byteLength)
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

export function wavDataUri(wav: Uint8Array): string {
  return `data:audio/wav;base64,${Buffer.from(wav).toString('base64')}`
}
