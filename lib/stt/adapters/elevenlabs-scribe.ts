/** ElevenLabs → Even Note — composite SCRIBE-tier engine (replaces EkaScribe
 *  as the showcased scribe competitor; EkaScribe code + row kept, just disabled).
 *
 *  Pipeline: ElevenLabs Scribe v2 ASR (the front end under test) → the SAME
 *  note-generation LLM the Even pipeline uses (qwen via OLLAMA_BASE_URL).
 *  So on the scribe leaderboard the ONLY variable vs even_pipeline is the ASR:
 *  ElevenLabs transcript vs the Even transcription stack.
 */
import type { SttAdapter, SttNoteResult } from "../types";
import { elevenlabsAdapter } from "./elevenlabs";
import { generateNote } from "@/lib/note-generation";
import { renderNoteText } from "../scoring";

export const elevenlabsScribeAdapter: SttAdapter = {
  key: "elevenlabs_scribe",
  capabilities: { tiers: ["scribe"], stages: ["note"], languages: ["multi"], streaming: false, translates: false, async: false },

  // ASR passthrough (scribe-only row, but the interface requires transcribe).
  transcribe(audio, opts) {
    return elevenlabsAdapter.transcribe(audio, opts);
  },

  async generateNote(audio, opts): Promise<SttNoteResult> {
    const t0 = Date.now();
    const asr = await elevenlabsAdapter.transcribe(audio, { contentType: opts.contentType, language: opts.language, longForm: true });
    if (asr.error || !(asr.english || asr.original)) {
      return { note: null, noteText: null, latencyMs: Date.now() - t0, costUsd: asr.costUsd, error: `asr: ${asr.error ?? "empty_transcript"}` };
    }
    // Non-English audio: ElevenLabs transcribes in the source language (no
    // translation); the Even note prompt's English backstop handles it.
    const transcript = (asr.english || asr.original || "").trim();
    const noteType = opts.template && opts.template.length > 0 ? opts.template : undefined;
    const gen = await generateNote(transcript, { noteType });
    if (!gen.ok) {
      return { note: null, noteText: null, latencyMs: Date.now() - t0, costUsd: asr.costUsd, error: `note: ${gen.error.slice(0, 120)}` };
    }
    return { note: gen.note, noteText: renderNoteText(gen.note), latencyMs: Date.now() - t0, costUsd: asr.costUsd, error: null };
  },

  health() {
    return elevenlabsAdapter.health();
  },
};
