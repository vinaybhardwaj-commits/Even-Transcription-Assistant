/**
 * lib/jev/worker/builders/stt.ts — `stt-span-v1` / `stt-pair-v1` (PRD P3.1): the state for the STT quality gate and the engine pick.
 *
 * O4 (V, 8 Oct): ROOM AUDIO NEVER GOES TO SARVAM and the gate is for consult clips and doctor-app encounter audio only. A run whose subject is a bench window or
 * session is REFUSED with `scope_consult_only` (an abstain row, no call, no state built). Engine names are HIDDEN from Jev (`version_A` / `version_B`); the
 * assignment is a deterministic function of the pair id, recorded server-side in `evidence.ab`. (The PRD's 2x2 label-swap balancing is not built: one assignment per pair.)
 * Code computes the feature buckets; Jev judges the words. Numbers, doses and dates are compared in code.
 */
import { createHash } from "node:crypto";
import { readSttRunForJev, type SttRunRow } from "@/lib/room-access/jev-reads";
import { STATE_TOKEN_BUDGET, estimateTokens } from "./tokens";
import type { StateBuild } from "../uses";

export const STT_SPAN_VERSION = "stt-span-v1";
export const STT_PAIR_VERSION = "stt-pair-v1";
export const MAX_SPAN_CHARS = 12_000;

export type RunRow = SttRunRow;

/** PURE. none / some / loop: the share of word 3-grams that repeat an earlier one. */
export function repeatBucket(text: string): "none" | "some" | "loop" {
  const w = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (w.length < 6) return "none";
  const seen = new Set<string>();
  let rep = 0, total = 0;
  for (let i = 0; i + 2 < w.length; i += 1) {
    const g = `${w[i]} ${w[i + 1]} ${w[i + 2]}`;
    total += 1;
    if (seen.has(g)) rep += 1; else seen.add(g);
  }
  const r = total ? rep / total : 0;
  return r > 0.4 ? "loop" : r > 0.1 ? "some" : "none";
}

const body = (r: RunRow): string => {
  const o = (r.transcript_original ?? "").trim().slice(0, MAX_SPAN_CHARS);
  const e = (r.transcript_english ?? "").trim().slice(0, MAX_SPAN_CHARS);
  return e && e !== o ? `${o}\n[EN: ${e}]` : o;
};

export type SttDeps = { run: (id: string) => Promise<RunRow | null> };
export const defaultSttDeps: SttDeps = { run: readSttRunForJev };
const SCOPE = "scope_consult_only";
const consultScope = (r: RunRow): boolean => r.subject_type === "encounter";

export async function buildSttRunState(runId: string, deps: SttDeps = defaultSttDeps): Promise<StateBuild | null> {
  const r = await deps.run(runId);
  if (!r) return null;
  if (!consultScope(r)) return { abstain: SCOPE };
  const text = body(r);
  if (!text) return { abstain: "no_transcript_text" };
  const state = { features: { repeat_ratio: repeatBucket(r.transcript_original ?? ""), language: r.detected_language ?? "unknown" }, transcript: text };
  if (estimateTokens(JSON.stringify(state)) > STATE_TOKEN_BUDGET) return { tooLarge: true, bytes: JSON.stringify(state).length };
  return { state, lane: "text", evidence: { stt_run_ids: [r.id], state_version: STT_SPAN_VERSION } };
}

/** The pair id is `<run id>+<run id>`. */
export async function buildSttPairState(pairId: string, deps: SttDeps = defaultSttDeps): Promise<StateBuild | null> {
  const parts = pairId.split("+");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [a, b] = await Promise.all([deps.run(parts[0]), deps.run(parts[1])]);
  if (!a || !b) return null;
  if (!consultScope(a) || !consultScope(b)) return { abstain: SCOPE };
  if (a.subject_id !== b.subject_id) return { abstain: "runs_of_different_subjects" };
  const swap = createHash("sha256").update(pairId).digest()[0]! % 2 === 1;
  const [A, B] = swap ? [b, a] : [a, b];
  const state = {
    features: { language: a.detected_language ?? b.detected_language ?? "unknown", repeat_ratio_version_A: repeatBucket(A.transcript_original ?? ""), repeat_ratio_version_B: repeatBucket(B.transcript_original ?? "") },
    version_A: body(A), version_B: body(B),
  };
  if (!state.version_A || !state.version_B) return { abstain: "no_transcript_text" };
  if (estimateTokens(JSON.stringify(state)) > STATE_TOKEN_BUDGET) return { tooLarge: true, bytes: JSON.stringify(state).length };
  return { state, lane: "text", evidence: { stt_run_ids: [a.id, b.id], ab: { version_A: A.id, version_B: B.id }, state_version: STT_PAIR_VERSION } };
}

/** A bench answer `version_A` back to the run id behind it (so a label can be an engine's run). */
export function resolveSttPick(_q: string, value: string, evidence: Record<string, unknown>): string {
  const ab = evidence.ab as Record<string, string> | undefined;
  return ab && ab[value] ? ab[value] : value;
}
