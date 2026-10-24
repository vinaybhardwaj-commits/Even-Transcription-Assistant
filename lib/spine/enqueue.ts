/**
 * lib/spine/enqueue.ts — SPINE-P2 pure planning of which jobs an encounter gets. No clock (pass `now`), no randomness, no I/O.
 * FREE stages only. A paid stage (config.PAID_STAGES) is never planned: S7 is not built and D4/D5/D9 are V-pending.
 *  - D4: a candidate gets recut, acoustics, nemotron. A confirmed encounter also gets collector and freescript.
 *  - R1: an encounter flagged `ambiguous` never gets freescript.
 *  - RULING B: `confirmed_single_proxy` (timeline-only) gets the confirmed stage set, but ALWAYS as status `shadow` (hard cap, whatever jobs / mode.<stage> say) with input_key `sp:` + hash. Promotion to confirmed supersedes the sp: rows.
 *  - S7a: a `confirmed` encounter (not single_proxy, not candidate) also gets transcript_final, after the close grace; a boundary change is a new cut_version.
 *  - D6: nothing is planned until CLOSE_GRACE_MS after the encounter closed.
 *  - frozen / rejected / merged encounters get nothing.
 * Job key: (encounter_id, stage, cut_version = r<boundary_rev>, input_key = hash8(stage, stage config)).
 */
import { createHash } from "node:crypto";
import { PAID_STAGES, type Mode } from "./config";

export const CANDIDATE_STAGES = ["recut", "acoustics", "nemotron"] as const;
export const CONFIRMED_ONLY_STAGES = ["collector", "freescript"] as const;
/** S7a: the final transcript, FREE (the route engine through the existing drain; never Sarvam, O4). Status `confirmed` ONLY: not candidate, not confirmed_single_proxy. Run by the server cron, not the box. */
export const TRANSCRIPT_FINAL_STAGE = "transcript_final";
export const FREE_STAGES: readonly string[] = [...CANDIDATE_STAGES, ...CONFIRMED_ONLY_STAGES, TRANSCRIPT_FINAL_STAGE];
/** Upstream FREE stages that must be `done` (same cut) before a LIVE job is queued. Paid upstream stages are not required while none can be enqueued. Shadow rows are not gated. */
export const STAGE_NEEDS: Readonly<Record<string, readonly string[]>> = { recut: [], acoustics: ["recut"], nemotron: ["recut"], collector: ["recut"], freescript: ["collector"], transcript_final: [] };
export const CLOSE_GRACE_MS = 15 * 60_000;
/** Bump a stage's config string to re-key its jobs. */
const STAGE_CFG: Readonly<Record<string, string>> = { recut: "v1", acoustics: "v1", nemotron: "v1", collector: "v1", freescript: "v1", transcript_final: "v1" };

export type EncounterRow = { encounter_id: string; status: string; boundary_rev: number; flags: readonly string[]; t_close: number | null };
export type PlannedJob = { encounter_id: string; stage: string; cut_version: string; input_key: string; status: "shadow" | "queued" };

export const SP_PREFIX = "sp:";
export const cutVersion = (boundaryRev: number): string => `r${boundaryRev}`;
export const inputKey = (stage: string): string => createHash("sha256").update(`${stage}\u001f${STAGE_CFG[stage] ?? "v1"}`).digest("hex").slice(0, 8);

/** Stage modes as the enqueuer uses them: jobs=shadow caps every stage at shadow; a paid or unknown stage is off. */
export function effectiveModes(jobs: Mode, stages: Readonly<Record<string, Mode>>): Record<string, Mode> {
  const out: Record<string, Mode> = {};
  for (const s of FREE_STAGES) {
    const m = jobs === "off" || PAID_STAGES.includes(s) ? "off" : (stages[s] ?? "off");
    out[s] = jobs === "shadow" && m === "live" ? "shadow" : m;
  }
  return out;
}

export function stagesFor(e: EncounterRow, now: number): string[] {
  if (e.status !== "confirmed" && e.status !== "candidate" && e.status !== "confirmed_single_proxy") return [];
  if (e.flags.includes("frozen")) return [];
  if (e.t_close === null || now < e.t_close + CLOSE_GRACE_MS) return [];
  const out: string[] = [...CANDIDATE_STAGES];
  if (e.status === "confirmed" || e.status === "confirmed_single_proxy") {
    out.push("collector");
    if (!e.flags.includes("ambiguous")) out.push("freescript");
  }
  if (e.status === "confirmed") out.push(TRANSCRIPT_FINAL_STAGE);
  return out.filter((s) => FREE_STAGES.includes(s) && !PAID_STAGES.includes(s));
}

export function planJobs(encs: readonly EncounterRow[], modes: Readonly<Record<string, Mode>>, now: number): PlannedJob[] {
  const out: PlannedJob[] = [];
  for (const e of encs) {
    for (const stage of stagesFor(e, now)) {
      const m = modes[stage];
      if (m !== "shadow" && m !== "live") continue;
      const sp = e.status === "confirmed_single_proxy";
      out.push({ encounter_id: e.encounter_id, stage, cut_version: cutVersion(e.boundary_rev), input_key: sp ? SP_PREFIX + inputKey(stage) : inputKey(stage), status: m === "live" && !sp ? "queued" : "shadow" });
    }
  }
  return out;
}
