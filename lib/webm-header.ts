/**
 * WebM header integrity — guards against saving a headerless/undecodable
 * recording. A valid WebM/Matroska stream MUST begin with the EBML magic
 * 0x1A 0x45 0xDF 0xA3. MediaRecorder emits that header only in the FIRST
 * chunk; if chunk 0 is dropped from the submit concatenation (e.g. an IDB
 * write/eviction), the blob starts mid-stream at a cluster and is undecodable
 * by ffmpeg/whisper/Sarvam/the router (the enc_hndp7k6d4u failure).
 */
export const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;

/** True if the bytes start with the EBML magic. Pure + unit-testable. */
export function bytesHaveEbml(u8: Uint8Array): boolean {
  return (
    u8.length >= 4 &&
    u8[0] === EBML_MAGIC[0] &&
    u8[1] === EBML_MAGIC[1] &&
    u8[2] === EBML_MAGIC[2] &&
    u8[3] === EBML_MAGIC[3]
  );
}

/** True if the Blob starts with the EBML magic (reads only the first 4 bytes). */
export async function blobStartsWithEbml(blob: Blob): Promise<boolean> {
  try {
    const ab = await blob.slice(0, 4).arrayBuffer();
    return bytesHaveEbml(new Uint8Array(ab));
  } catch {
    return false;
  }
}
