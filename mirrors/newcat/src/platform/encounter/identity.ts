import { isOpaqueId } from '../../audience/serialize.js'
import { sha256 } from '../../hash.js'

/**
 * Opaque newcat encounter id for a room-audio consult. The ETA cutter consult_uid itself when it passes
 * the F7.5 opaque-id rule (`isOpaqueId`, src/audience/serialize.ts: no run of 8+ digits, UUIDs exempt);
 * otherwise the surrogate `enc-` + first 16 hex of sha256(consult_uid). Deterministic, pure.
 */
export function encounterIdFor(consultUid: string): string {
  if (typeof consultUid !== 'string' || consultUid.length === 0) throw new Error('bad consult uid')
  return isOpaqueId(consultUid) ? consultUid : `enc-${sha256(consultUid).slice(0, 16)}`
}
