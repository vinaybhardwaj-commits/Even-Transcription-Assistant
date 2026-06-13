/**
 * Client-side feature flags for the higher-risk live recording-path hardening
 * (backlog Tier 4). EACH DEFAULTS OFF, so production behaviour is byte-identical
 * until the flag is set to "1" in Vercel AND the change is device-tested
 * (iPhone + Android + desktop Safari). Flip back to unset to revert instantly.
 *
 * NEXT_PUBLIC_* vars are inlined at build time, so reading process.env at module
 * scope is safe in client components.
 */
export const TRIM_LIVE_BUFFERS =
  process.env.NEXT_PUBLIC_ETA_TRIM_LIVE_BUFFERS === "1";

export const DEEPGRAM_RECONNECT =
  process.env.NEXT_PUBLIC_ETA_DEEPGRAM_RECONNECT === "1";

export const SAFARI_STREAMING_GUARD =
  process.env.NEXT_PUBLIC_ETA_SAFARI_STREAMING_GUARD === "1";

// Show a SECOND live transcript box driven by AI4Bharat IndicConformer (pure
// native script) alongside the Sarvam code-mix box, for non-English encounters.
// Sarvam detects+locks the language and feeds it to IndicConformer. Default OFF.
export const INDIC_LIVE_BOX =
  process.env.NEXT_PUBLIC_ETA_INDIC_LIVE_BOX === "1";
