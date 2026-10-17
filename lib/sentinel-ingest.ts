/**
 * lib/sentinel-ingest.ts — the INGEST contract for the room-sentinel event kind "sentinel" (Sentinel S6, G4).
 *
 * The sender is the Mini subscriber's forwarder (tools/room-guardian/mini/subscriber/sentinel_forward.py, flag sentinel_forward),
 * which posts the latest kiosk health line per room as ONE event per request, kind "sentinel", source "mini_sentinel_forwarder",
 * with the poller credential (sha256 of the token against KIOSK_HEALTH_POLLER_TOKEN_SHA256 — the same auth path the mic-guard
 * poller uses). Storage is the existing kiosk_health_events table (migration 0126) — no new table.
 *
 * The payload is validated STRICTLY, and a violation rejects the WHOLE request with 400 (not an item-level reject): the only
 * sender must never be able to smuggle an unknown code past the 400, and a 400 makes the forwarder retry next tick.
 * Payload shape (all keys required):
 *   code        one of SENTINEL_CODES
 *   mic_class   "webcam" | "tonor" | "unknown"
 *   zr          number in [0, 1] or null   (the kiosk's zero ratio of the last 2 s)
 *   peak        number in [0, 1] or null   (the kiosk's peak of the last 2 s, abs max / 32768)
 *   last_action string of 1..64 chars or null
 *   last_result string of 1..64 chars or null
 *   mode        "shadow" | "heal"
 * Pure: no I/O, no logging.
 */

export const SENTINEL_KIND = "sentinel";
/** the only source a sentinel event may carry (a poller-token post of any other source is rejected by name) */
export const SENTINEL_SOURCE = "mini_sentinel_forwarder";

export const SENTINEL_CODES = [
  "MIC_DEAD_WEBCAM",
  "MIC_MUTED_TONOR",
  "DEVICE_MISSING",
  "RECORDER_DOWN",
  "PRESENCE_DEAD",
  "TAILNET_DOWN",
  "MIC_PERM",
  "OK",
] as const;
export type SentinelCode = (typeof SENTINEL_CODES)[number];

export const SENTINEL_MIC_CLASSES = ["webcam", "tonor", "unknown"] as const;
export type SentinelMicClass = (typeof SENTINEL_MIC_CLASSES)[number];

export const SENTINEL_MODES = ["shadow", "heal"] as const;
export type SentinelMode = (typeof SENTINEL_MODES)[number];

export type SentinelPayload = {
  code: SentinelCode;
  mic_class: SentinelMicClass;
  zr: number | null;
  peak: number | null;
  last_action: string | null;
  last_result: string | null;
  mode: SentinelMode;
};

const inSet = (x: unknown, set: readonly string[]): x is string => typeof x === "string" && set.includes(x);
const ratioOrNull = (x: unknown): boolean =>
  x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1);
const wordOrNull = (x: unknown): boolean => x === null || (typeof x === "string" && x.length >= 1 && x.length <= 64);

/** True only for an exactly-shaped sentinel payload (see the header). Never throws on any input. */
export function validateSentinelPayload(p: unknown): p is SentinelPayload {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  if (!inSet(o.code, SENTINEL_CODES as readonly string[])) return false;
  if (!inSet(o.mic_class, SENTINEL_MIC_CLASSES as readonly string[])) return false;
  if (!inSet(o.mode, SENTINEL_MODES as readonly string[])) return false;
  if (!ratioOrNull(o.zr)) return false;
  if (!ratioOrNull(o.peak)) return false;
  if (!wordOrNull(o.last_action)) return false;
  if (!wordOrNull(o.last_result)) return false;
  return true;
}
