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
  /**
   * The router's own account of WHETHER IT RAN — `status`, `segmentation`, `outcome`, verbatim.
   *
   * OPTIONAL for the same reason `languageTimeline` is: nine adapters have no such concept and must
   * not grow one to admit a tenth's. An engine that says nothing leaves this absent, and absent
   * reads as "unknown" downstream — never as "engines ran".
   */
  routerOutcome?: { status?: unknown; segmentation?: unknown; outcome?: unknown } | null;
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

/**
 * ─── THE ASYNC SEAM (Slice C2 Part A) ─────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS. `transcribe(Buffer) => result` cannot express submit-and-poll, so C1 shipped
 * with the room job reaching PAST the adapter to the router's own client while using the adapter
 * only for its `capabilities.async` flag. That is the shape this codebase keeps rediscovering it
 * regrets: the registry says which engine runs, and something else decides how. An engine's
 * transport is the engine's business, and it belongs behind the same interface as everything else.
 *
 * It is not a one-engine abstraction. `ekascribe` already declares `"async": true` in its
 * capabilities, and any job/poll provider added later needs exactly this.
 *
 * OPTIONAL, so the eight synchronous adapters compile and behave unchanged. The contract is:
 * `submit`/`poll` are present IF AND ONLY IF `capabilities.async` is true, and a caller that finds
 * `capabilities.async` without them has found a bug, not a fallback — there is no silent
 * degradation to the synchronous path, because a long clip on the sync path is the timeout this
 * whole seam exists to avoid.
 */

/** What a submit needs. An adapter uses the field its service speaks and ignores the other. */
export type SttAsyncInput = {
  /** A URL the SERVICE can fetch. The router pulls its own audio; presigned, short-lived. */
  audioUrl?: string;
  /** Bytes, for a provider that wants an upload instead. */
  audio?: Buffer;
  contentType?: string;
  language?: string;
  /** How much audio, so an adapter can size its own budgets. */
  durationMs?: number;
  /** English out as well as the source. Off by default: it is a per-span LLM call downstream. */
  translate?: boolean;
};

export type SttAsyncSubmit =
  | { ok: true; jobRef: string }
  | { ok: false; error: string };

/**
 * A poll answer. `state` is OURS, not the provider's vocabulary, so a second async engine cannot
 * force every caller to learn a new set of strings.
 *
 * `terminal` on a failure says whether retrying this jobRef could ever help: an expired or unknown
 * job is terminal, a transport blip is not. Callers that cannot tell the difference either give up
 * too early or poll a job that no longer exists until the lease runs out.
 */
export type SttAsyncPoll =
  | { ok: true; state: "queued" | "running"; progress?: { done: number; total: number } | null }
  | { ok: true; state: "done"; result: SttTranscribeResult }
  | { ok: false; error: string; terminal: boolean };

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
  /**
   * Start long-form work and return a reference to it. Present iff `capabilities.async`.
   * Must be IDEMPOTENT-FRIENDLY from the caller's side: it returns a ref the caller persists
   * before anything else can fail, and the caller polls that ref rather than submitting again.
   */
  submit?(input: SttAsyncInput): Promise<SttAsyncSubmit>;
  /** Ask after a ref from `submit`. Never starts work. Present iff `capabilities.async`. */
  poll?(jobRef: string): Promise<SttAsyncPoll>;
  health(): Promise<SttHealth>;
}
