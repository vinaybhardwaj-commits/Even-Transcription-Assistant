/**
 * lib/sarvam-model.ts — the one place that names the Sarvam STT model the app WRITES with, and the engine/version labels its outputs carry.
 *
 * Writers send saaras:v4 and nothing else: there is no v3 fallback, no allowlist entry and no env value that selects v3. Readers keep matching BOTH
 * generations (SARVAM_STT_ENGINES_READ, v4 first) so a result already stored by v3 still counts as done and is never re-sent.
 */
export const SARVAM_STT_MODEL = "saaras:v4";
export const SARVAM_STT_ENGINE_LABEL = "sarvam-saaras-v4";
export const SARVAM_STT_VERSION_LABEL = "saaras-v4";

/** Engine names a READER accepts as "Sarvam already transcribed this", preference order: v4 first, then v3. */
export const SARVAM_STT_ENGINES_READ: readonly string[] = ["sarvam-saaras-v4", "sarvam-saaras-v3"];

const V3_RE = /saaras[:_\-.]?v?3/i;

/** An env override of the STT model. A v3 value is refused (treated as unset, one count-only log line); anything else unset or empty gives v4. */
export function resolveSarvamSttModel(override: string | undefined, log: (line: string) => void = (l) => console.warn(l)): string {
  const v = (override ?? "").trim();
  if (!v) return SARVAM_STT_MODEL;
  if (V3_RE.test(v)) {
    log("sarvam_stt_model_override_refused count=1 reason=v3_not_selectable using=saaras:v4");
    return SARVAM_STT_MODEL;
  }
  return v;
}
