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
// Sarvam detects+locks the language and feeds it to IndicConformer — fully
// AUTOMATIC: the box appears by itself on a non-English encounter and stays
// hidden on English ones (no user/doctor action). Display-only: it never
// touches the note/audio/submit, so a failure is at worst a blank/odd box.
// ON by default; set NEXT_PUBLIC_ETA_INDIC_LIVE_BOX=0 in Vercel to kill-switch it.
export const INDIC_LIVE_BOX =
  process.env.NEXT_PUBLIC_ETA_INDIC_LIVE_BOX !== "0";

// Background CDS pipeline: process the encounter SERVER-SIDE after finalize
// (decoupled from the doctor's client), so the doctor can submit and move
// straight to the next encounter; results appear in the Library when ready.
// Default ON (per V) — kill-switch: set NEXT_PUBLIC_ETA_BACKGROUND_PROCESSING=0 + redeploy.
export const BACKGROUND_PROCESSING =
  process.env.NEXT_PUBLIC_ETA_BACKGROUND_PROCESSING !== "0";

// Continuous language router for the LIVE recording surface. Detects the spoken
// language on a rolling window (Whisper LID + Sarvam + script, English-biased,
// with hysteresis) and routes the PRIMARY on-screen transcript to the best
// engine for that language (English -> Deepgram; non-English -> Sarvam +
// IndicConformer native box). The engines already run in parallel, so this only
// changes WHICH stream is shown — it never restarts an engine. Display-only:
// the note is decided independently at submit (decideEncounterLanguage), so a
// router glitch can't corrupt the note. ON by default; kill-switch
// NEXT_PUBLIC_ETA_LANG_ROUTER=0 + redeploy.
export const LANG_ROUTER =
  process.env.NEXT_PUBLIC_ETA_LANG_ROUTER !== "0";

// Pre-flight MICROPHONE gate: before a recording can start, open the mic and
// require detected audio energy (the doctor sees their voice move a live meter).
// A dead/muted/silent mic blocks "Proceed" with troubleshooting + a "Record
// anyway" escape (so a clinician is never hard-locked out of documenting).
// PREVENTS the "recorded 5 minutes of silence" failure. ON by default;
// kill-switch NEXT_PUBLIC_ETA_MIC_PREFLIGHT=0 + redeploy.
export const MIC_PREFLIGHT =
  process.env.NEXT_PUBLIC_ETA_MIC_PREFLIGHT !== "0";

// Live audio WATCHDOG during recording: if no audio chunks arrive (or chunks
// stop) for ~8s, or the mic track mutes/ends mid-session, raise a loud banner
// so the doctor isn't talking into a dead mic for minutes. Chunk-count + track
// events only (no analyser on the recorder's stream — keeps the iOS capture
// path untouched). ON by default; kill-switch NEXT_PUBLIC_ETA_AUDIO_WATCHDOG=0.
export const AUDIO_WATCHDOG =
  process.env.NEXT_PUBLIC_ETA_AUDIO_WATCHDOG !== "0";

// LIVE English toggle powered by Gemini Flash. On a non-English encounter the
// primary live panel defaults to the native/as-spoken text (no mangling) and
// offers an "English (AI)" toggle that rolls the accumulated text through Gemini
// Flash for a coherent live translation — replacing the old per-window Sarvam
// translation that produced gibberish. ON by default; only acts when Gemini is
// configured. Kill-switch NEXT_PUBLIC_ETA_LIVE_FLASH=0 + redeploy.
export const LIVE_FLASH =
  process.env.NEXT_PUBLIC_ETA_LIVE_FLASH !== "0";

// Capture-integrity: verify a WebM recording carries its EBML header before
// upload; prepend the retained header chunk if the concatenation dropped it,
// and refuse to upload an unfixable headerless (undecodable) file. Prevents the
// silently-corrupt-recording class (enc_hndp7k6d4u). ON by default; kill-switch
// NEXT_PUBLIC_ETA_HEADER_GUARD=0 + redeploy.
export const HEADER_GUARD =
  process.env.NEXT_PUBLIC_ETA_HEADER_GUARD !== "0";

// NoteGen — typed-note (text) authoring surface: the MedNoteGen live editor
// ported into EvenScribe. When ON, the post-PIN home offers "Type" alongside
// "Record"; the typed text becomes the encounter transcript and runs the same
// generate -> CDMSS -> review -> email pipeline as audio. GO-LIVE 19 Jun 2026:
// default ON. Kill-switch: set NEXT_PUBLIC_ETA_NOTEGEN=0 in Vercel + redeploy.
export const NOTEGEN =
  process.env.NEXT_PUBLIC_ETA_NOTEGEN !== "0";
