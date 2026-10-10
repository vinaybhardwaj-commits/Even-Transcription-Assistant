/**
 * lib/encounter-clock/gate-v2.ts — the gate's SPEECH half from Nemotron turns (epic #23, ticket d). PURE.
 *
 * Gate v1 (gate.ts) calls a probe `speech` only when energy is active AND transcript text reaches a rate; with no
 * STT every active probe is `unjudged`. v2 takes the speech half from DIARIZED speech instead, so the clock can run
 * before STT exists. v1 is unchanged and stays the default; v2 runs only behind ENCOUNTER_GATE_DIAR (flag.ts) and
 * stamps its own `gate_version`.
 *
 * NO EVIDENCE IS NOT NO SPEECH. `diar_coverage` says whether a stored Nemotron row spans the whole probe. A probe no
 * row covers has no diarized evidence at all (diarized_speech_ms is null), which is a different fact from a covered
 * probe where nobody spoke (0).
 *
 * TRUTH TABLE (PRD §6.3, constants PROVISIONAL and exported; rows in the order they are tested):
 *   dead mic                                              → unjudged   dead_mic          (unchanged)
 *   energy missing AND no diar coverage                   → unjudged   no_energy_evidence
 *   transcript text present AND energy active             → speech     speech            (the v1 rule still promotes)
 *   energy quiet AND (diarized speech ≥ MIN or text)      → unjudged   halves_disagree
 *   energy quiet                                          → non_speech quiet_room
 *   diarized speech ≥ DIAR_SPEECH_MIN_MS                  → speech     diarized_speech   (energy active, or missing but covered)
 *   diar covered AND diarized speech < DIAR_NONE_MAX_MS   → non_speech no_diarized_speech (energy active only;
 *                                                           with energy missing it stays unjudged no_energy_evidence)
 *   diar covered, speech between the two                  → unjudged   diar_speech_short (UNSPECIFIED in the PRD; the
 *                                                           conservative reading, flagged in the build report)
 *   otherwise (energy active, no diar coverage)           → the v1 transcript rule (missing → unjudged
 *                                                           no_transcript_evidence, text → speech, none → non_speech)
 */
import {
  energyHalf, transcriptHalf, covers, GATE_VERSION,
  type EnergyEvidence, type EnergyResult, type TranscriptEvidence, type TranscriptResult, type GateVerdict,
} from "@/lib/encounter-clock/gate";
import { DEFAULT_ROOM_ENERGY_FLOOR } from "@/lib/stt/window-measure";

export const GATE_V2_VERSION = "encounter-clock-gate-v2";
/** Diarized speech in a 180 s probe at or above which the speech half says yes. PROVISIONAL. */
export const DIAR_SPEECH_MIN_MS = 8_000;
/** Covered probe with less diarized speech than this: the speech half says no. PROVISIONAL. */
export const DIAR_NONE_MAX_MS = 2_000;

export type DiarTurn = { start_ms: number; end_ms: number };
export type DiarEvidence = {
  /** Spans of the day that a stored, successful Nemotron row covers (an `ok` or `empty` row's whole clip). */
  coverage: ReadonlyArray<{ start_ms: number; end_ms: number }>;
  /** Every turn of those rows in epoch ms, any speaker. Overlap between speakers is counted once. */
  turns: ReadonlyArray<DiarTurn>;
};

export type GateV2Reason =
  | "dead_mic" | "no_energy_evidence" | "halves_disagree" | "quiet_room" | "no_transcript_evidence" | "speech" | "no_text"
  | "diarized_speech" | "no_diarized_speech" | "diar_speech_short";

export type GateV2Result = {
  version: typeof GATE_V2_VERSION;
  v1_version: typeof GATE_VERSION;
  start_ms: number;
  end_ms: number;
  verdict: GateVerdict;
  reason: GateV2Reason;
  energy: EnergyResult;
  transcript: TranscriptResult;
  diar_coverage: boolean;
  /** Union of the turns clipped to the probe; null when no stored row covers the probe. */
  diarized_speech_ms: number | null;
};

/** PURE — length of the union of the turns clipped to [t0, t1). */
export function diarizedSpeechMs(turns: ReadonlyArray<DiarTurn>, t0: number, t1: number): number {
  const clipped = turns
    .map((t) => ({ a: Math.max(t.start_ms, t0), b: Math.min(t.end_ms, t1) }))
    .filter((x) => x.b > x.a)
    .sort((x, y) => x.a - y.a);
  let total = 0, curA = 0, curB = -Infinity;
  for (const c of clipped) {
    if (c.a > curB) { if (curB > curA) total += curB - curA; curA = c.a; curB = c.b; }
    else if (c.b > curB) curB = c.b;
  }
  if (curB > curA) total += curB - curA;
  return total;
}

export function gateProbeV2(input: {
  start_ms: number;
  end_ms: number;
  energy: EnergyEvidence | null | undefined;
  transcript?: TranscriptEvidence | null;
  diar: DiarEvidence | null | undefined;
  floor?: number;
}): GateV2Result {
  const { start_ms, end_ms } = input;
  const energy = energyHalf(input.energy, input.floor ?? DEFAULT_ROOM_ENERGY_FLOOR);
  const transcript = transcriptHalf(input.transcript, start_ms, end_ms);
  const diar_coverage = !!input.diar && covers([...input.diar.coverage], start_ms, end_ms);
  const diarized_speech_ms = diar_coverage ? diarizedSpeechMs(input.diar!.turns, start_ms, end_ms) : null;
  const out = (verdict: GateVerdict, reason: GateV2Reason): GateV2Result =>
    ({ version: GATE_V2_VERSION, v1_version: GATE_VERSION, start_ms, end_ms, verdict, reason, energy, transcript, diar_coverage, diarized_speech_ms });

  if (energy.state === "dead_mic") return out("unjudged", "dead_mic");
  if (energy.state === "missing" && !diar_coverage) return out("unjudged", "no_energy_evidence");
  const text = transcript.state === "text";
  if (energy.state === "active" && text) return out("speech", "speech");
  if (energy.state === "quiet") {
    return text || (diarized_speech_ms ?? 0) >= DIAR_SPEECH_MIN_MS ? out("unjudged", "halves_disagree") : out("non_speech", "quiet_room");
  }
  if (diar_coverage) {
    const d = diarized_speech_ms!;
    if (d >= DIAR_SPEECH_MIN_MS) return out("speech", "diarized_speech");
    if (d < DIAR_NONE_MAX_MS) return energy.state === "active" ? out("non_speech", "no_diarized_speech") : out("unjudged", "no_energy_evidence");
    return out("unjudged", "diar_speech_short");
  }
  // energy active, no diarized evidence: exactly the v1 transcript rule
  if (transcript.state === "missing") return out("unjudged", "no_transcript_evidence");
  return out("non_speech", "no_text");
}
