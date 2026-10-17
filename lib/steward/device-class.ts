/**
 * lib/steward/device-class.ts — the input-device name regexes (webcam first, TONOR backup), split out of input-failover.ts so client code (Rooms Live copy) can
 * use them without pulling in node:crypto. input-failover.ts re-exports both.
 */
export const WEBCAM_RE = /c270|webcam/i;
export const TONOR_RE = /tonor/i;

export type DeviceClass = "tonor" | "webcam" | "unknown";

/** the class of a device name: TONOR, webcam, or unknown (null/empty/other). TONOR is tested first so a name that matched both would get the mute-button text. */
export function deviceClass(name: string | null | undefined): DeviceClass {
  if (!name) return "unknown";
  if (TONOR_RE.test(name)) return "tonor";
  if (WEBCAM_RE.test(name)) return "webcam";
  return "unknown";
}
