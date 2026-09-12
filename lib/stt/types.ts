/** STT Engine Lab — adapter interface (L0). A new engine = one adapter file
 *  implementing this + one stt_engine registry row. */
export type SttTier = "asr" | "scribe";
export type SttStage = "live" | "note" | "diarize" | "room";
export type SttLang = "english" | "indic" | "multi";

export interface SttCapabilities {
  tiers: SttTier[];
  stages: SttStage[];
  languages: SttLang[];
  streaming: boolean;
  translates: boolean;  // produces English from non-English
  async: boolean;       // job/poll protocol (e.g. Ekascribe)
}

export interface SttTranscribeResult {
  original: string | null;
  english: string | null;
  language: string | null;
  latencyMs: number;
  costUsd: number | null;
  /**
   * The engine version THE PROVIDER REPORTED on this call, copied verbatim, or null (PRD §5
   * amendment, added in Build 3).
   *
   * OPTIONAL so every existing adapter compiles unchanged and keeps returning nothing. NEVER the
   * model string we SENT: Build 2 established that `receipt_complete` stays false rather than
   * carry a label the provider did not confirm, because this system has shipped a typed provider
   * label twice and both times it hid a wrong provider for months. Gemini fills it from the
   * response's model field; Whisper fills it when whisper.cpp reports one; Sarvam stays null
   * until its API returns a model identifier.
   */
  engineVersion?: string | null;
  /**
   * Slice C1 — the router's PER-SPAN timeline, carried verbatim, or null/absent for every engine
   * that has no such thing.
   *
   * OPTIONAL for the same reason `engineVersion` is: nine adapters exist and none of them should
   * have to change to add a tenth. `SttTranscribeResult` is otherwise flat — one language, one
   * string — and that flatness is precisely what makes a code-mixed consultation unreadable from
   * a run row: "the language" of a Kannada/English OPD window is not a fact.
   *
   * VERBATIM, and that word is load-bearing. The router already emits per span
   * `{start_s, end_s, lang, engine, chars}`. Reconstructing that from our side would mean
   * reimplementing per-span language selection across five candidate languages and three engines,
   * and any reconstruction could disagree with what the router actually did — which is the one
   * thing this field exists to record. It is copied, never rebuilt.
   */
  languageTimeline?: unknown[] | null;
  error: string | null;
}

export interface SttNoteResult {
  note: unknown;
  noteText: string | null;
  latencyMs: number;
  costUsd: number | null;
  error: string | null;
}

export interface SttHealth { ok: boolean; latencyMs: number; error?: string }

export interface SttAdapter {
  key: string;
  capabilities: SttCapabilities;
  /**
   * `mode` (K4b) — 'transcribe' asks for the SOURCE language back, 'translate' asks for English.
   * OPTIONAL and absent by default, so every existing caller keeps the behaviour it had: only
   * the room drain passes it. An adapter with one product ignores it.
   */
  /**
   * `durationMs` (Slice C1) — how much AUDIO this buffer holds, when the caller knows. OPTIONAL and
   * absent by default. It exists because one engine's transport depends on it: the router answers
   * a short clip synchronously and needs a submit-and-poll job for a long one, and byte length is
   * not a duration for a compressed container. An adapter with one transport ignores it.
   */
  transcribe(audio: Buffer, opts: { contentType: string; language?: string; longForm?: boolean; mode?: "transcribe" | "translate"; durationMs?: number }): Promise<SttTranscribeResult>;
  generateNote?(audio: Buffer, opts: { contentType: string; language?: string; template?: string }): Promise<SttNoteResult>;
  health(): Promise<SttHealth>;
}
