/**
 * lib/jev/worker/register.ts — the P2 uses: each draft question set paired with its state builder (PRD §3.2 "State builders").
 *
 * Importing this module registers them (jev-ask imports it). Registering a use does NOT make anything run: a set is `draft` after sync and ONLY runs in bench
 * mode; `shadow` needs a set whose status is shadow (ratified, which no P2 branch does) and the use's flag, `live` more. ELIGIBILITY (what the sweeper offers) exists for
 * the two consult-level sets (closed consults with a stored transcript); the others have no enumeration source yet and offer nothing:
 *   u10-timeline / encounter-end   subjects come from the room-day's anchors (P2.3, #30 shadow-v3 reading decisions): not wired here
 *   stt-quality / stt-pick         need the shadow hook after STT done (P3.2)
 *   pitch-uptake / doubt           need the agent's enumeration of pitches and doubts (P4)
 * so those are bench-by-explicit-list only. Nothing here is imported by any capture, upload, STT or note path.
 */
import { selectEvrWindows } from "@/lib/room-access/evr-select";
import { buildTimelineState, resolveTimelineAnswer } from "./builders/timeline";
import { buildSttPairState, buildSttRunState, resolveSttPick } from "./builders/stt";
import { buildConsultState, buildDoubtState, buildPitchState } from "./builders/locators";
import { registerUse, usesOf, type JevUseDef } from "./uses";

const istDaySeed = (): number => Number(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10).replace(/-/g, ""));
const noneEligible = async (): Promise<string[]> => [];
const consultEligible = (limit: number): Promise<string[]> => selectEvrWindows(Math.min(limit, 200), istDaySeed());

export const P2_USES: JevUseDef[] = [
  { use: "encounter_timeline", setId: "u10-timeline", subjectType: "encounter", eligible: noneEligible, build: (id) => buildTimelineState(id), resolve: resolveTimelineAnswer },
  { use: "encounter_timeline", setId: "encounter-end", subjectType: "encounter", eligible: noneEligible, build: (id) => buildTimelineState(id), resolve: resolveTimelineAnswer },
  { use: "stt_quality", setId: "stt-quality", subjectType: "stt_run", eligible: noneEligible, build: (id) => buildSttRunState(id) },
  { use: "stt_pick", setId: "stt-pick", subjectType: "stt_pair", eligible: noneEligible, build: (id) => buildSttPairState(id), resolve: resolveSttPick },
  { use: "consult_rubric", setId: "pitch-detect", subjectType: "consult", eligible: consultEligible, build: (id) => buildConsultState(id) },
  { use: "consult_rubric", setId: "pitch-uptake", subjectType: "pitch", eligible: noneEligible, build: (id) => buildPitchState(id) },
  { use: "consult_rubric", setId: "chair-affect", subjectType: "consult", eligible: consultEligible, build: (id) => buildConsultState(id) },
  { use: "consult_rubric", setId: "doubt", subjectType: "doubt", eligible: noneEligible, build: (id) => buildDoubtState(id) },
];

let done = false;
/** Idempotent: registering twice (module re-evaluation in a test) is a no-op for the sets already present. */
export function registerP2Uses(): void {
  for (const def of P2_USES) if (!usesOf(def.use).some((u) => u.setId === def.setId)) registerUse(def);
  done = true;
}
registerP2Uses();
export const p2UsesRegistered = (): boolean => done;
