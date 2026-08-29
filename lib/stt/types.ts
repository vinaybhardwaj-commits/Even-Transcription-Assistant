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
  transcribe(audio: Buffer, opts: { contentType: string; language?: string; longForm?: boolean; mode?: "transcribe" | "translate" }): Promise<SttTranscribeResult>;
  generateNote?(audio: Buffer, opts: { contentType: string; language?: string; template?: string }): Promise<SttNoteResult>;
  health(): Promise<SttHealth>;
}
