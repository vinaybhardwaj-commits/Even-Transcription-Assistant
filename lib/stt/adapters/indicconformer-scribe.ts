/** IndicConformer → Even Note — composite SCRIBE-tier engine for the Indic slice.
 *  IndicConformer native-script transcript → the SAME Even note-gen LLM (which
 *  has an English backstop) → note, rubric-scored vs even_pipeline. Lets the
 *  leaderboard compare IndicConformer's note quality on Indic audio. Indic-only.
 */
import type { SttAdapter, SttNoteResult } from "../types";
import { indicconformerAdapter } from "./indicconformer";
import { generateNote } from "@/lib/note-generation";
import { renderNoteText } from "../scoring";

export const indicconformerScribeAdapter: SttAdapter = {
  key: "indicconformer_scribe",
  capabilities: { tiers: ["scribe"], stages: ["note"], languages: ["indic"], streaming: false, translates: false, async: false },

  transcribe(audio, opts) {
    return indicconformerAdapter.transcribe(audio, opts);
  },

  async generateNote(audio, opts): Promise<SttNoteResult> {
    const t0 = Date.now();
    const asr = await indicconformerAdapter.transcribe(audio, { contentType: opts.contentType, language: opts.language, longForm: true });
    if (asr.error || !asr.original) {
      return { note: null, noteText: null, latencyMs: Date.now() - t0, costUsd: asr.costUsd, error: `asr: ${asr.error ?? "empty_transcript"}` };
    }
    const noteType = opts.template && opts.template.length > 0 ? opts.template : undefined;
    const gen = await generateNote(asr.original, { noteType });
    if (!gen.ok) return { note: null, noteText: null, latencyMs: Date.now() - t0, costUsd: asr.costUsd, error: `note: ${gen.error.slice(0, 120)}` };
    return { note: gen.note, noteText: renderNoteText(gen.note), latencyMs: Date.now() - t0, costUsd: asr.costUsd, error: null };
  },

  health() { return indicconformerAdapter.health(); },
};
