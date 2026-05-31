/** STT Engine Lab — adapter interface (L0). A new engine = one adapter file
 *  implementing this + one stt_engine registry row. */
export type SttTier = "asr" | "scribe";
export type SttStage = "live" | "note" | "diarize";
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
  transcribe(audio: Buffer, opts: { contentType: string; language?: string; longForm?: boolean }): Promise<SttTranscribeResult>;
  generateNote?(audio: Buffer, opts: { contentType: string; language?: string; template?: string }): Promise<SttNoteResult>;
  health(): Promise<SttHealth>;
}
