/**
 * lib/rubrics/registry.ts — S7-0: loads and validates EVERY rubric file at module load, so a bad file fails the build and the test run, never a request.
 *
 * The files are imported statically (not read from disk at run time): the bundler then ships them with the function and a typo in a path is a compile error. A test pins
 * that the list below equals the rubrics/ folder, so a new rubric cannot be forgotten here. Status changes only by repository commit: nothing in the MCP writes a file.
 *
 * WHO MAY RUN WHAT. Only `production` rubrics run on arbitrary live units. `draft` and `benched` run on their bench set (rubric_bench) or on an explicit unit list with lab:true.
 */
import roomMicQuality from "@/rubrics/room_mic_quality/rubric.json";
import talkTime from "@/rubrics/talk_time/rubric.json";
import consultChairAffect from "@/rubrics/consult_chair_affect/rubric.json";
import consultSurgicalPitch from "@/rubrics/consult_surgical_pitch/rubric.json";
import ehrcSurgicalOutcome from "@/rubrics/ehrc_surgical_outcome/rubric.json";
import careSentiment from "@/rubrics/care_sentiment/rubric.json";
import encounterVsRecord from "@/rubrics/encounter_vs_record/rubric.json";
import affectPrompt from "@/rubrics/consult_chair_affect/prompt.json";
import pitchPrompt from "@/rubrics/consult_surgical_pitch/prompt.json";
import evrPrompt from "@/rubrics/encounter_vs_record/prompt.json";
import { RubricFile, rubricProblems, type Rubric, type RubricUnit } from "./types";

const RAW: ReadonlyArray<unknown> = [roomMicQuality, talkTime, consultChairAffect, consultSurgicalPitch, ehrcSurgicalOutcome, careSentiment, encounterVsRecord];
/** The folders registered above, in order (pinned against the rubrics/ folder by a test). */
export const REGISTERED_IDS: readonly string[] = ["room_mic_quality", "talk_time", "consult_chair_affect", "consult_surgical_pitch", "ehrc_surgical_outcome", "care_sentiment", "encounter_vs_record"];

/** The prompt files beside the rubrics (statically imported, so the bundler ships them). */
export type PromptFile = { version: string; rubric_id: string; note: string; rules: string[]; user_header: string };
export const RUBRIC_PROMPTS: Readonly<Record<string, PromptFile>> = { consult_chair_affect: affectPrompt as PromptFile, consult_surgical_pitch: pitchPrompt as PromptFile, encounter_vs_record: evrPrompt as PromptFile };
/** Files that exist beside the rubrics, for the cross-field checks (prompt, bench). A build-time list; the test compares it with the disk. */
const KNOWN_FILES = new Set<string>(Object.keys(RUBRIC_PROMPTS).map((id) => `${id}/prompt.json`));
export const knownFile = (rel: string): boolean => KNOWN_FILES.has(rel);

function load(): Rubric[] {
  const out: Rubric[] = [];
  RAW.forEach((raw, i) => {
    const id = REGISTERED_IDS[i]!;
    const parsed = RubricFile.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`rubric ${id}: ${issue?.path.join(".") || "file"} ${issue?.message ?? "invalid"}`);
    }
    const problems = rubricProblems(parsed.data, id, knownFile);
    if (problems.length > 0) throw new Error(`rubric ${id}: ${problems.join("; ")}`);
    out.push(parsed.data);
  });
  const ids = out.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error("rubric registry: duplicate id");
  return out;
}

export const RUBRICS: readonly Rubric[] = load();
export const RUBRIC_BY_ID: ReadonlyMap<string, Rubric> = new Map(RUBRICS.map((r) => [r.id, r]));
export const getRubric = (id: string): Rubric | null => RUBRIC_BY_ID.get(id) ?? null;
export const unitsOf = (r: Rubric): RubricUnit[] => [...new Set<RubricUnit>([r.unit, ...(r.units ?? [])])];

/** The llm_zdr rubrics whose engine exists (S7-1). A new llm_zdr rubric is not runnable until it is listed here with its engine. */
export const LLM_WIRED: ReadonlySet<string> = new Set(["consult_chair_affect", "consult_surgical_pitch", "encounter_vs_record"]);

export type RunRefusal = { ok: false; error: "unknown_rubric" | "lab_required" | "engine_not_available" | "unit_not_supported"; detail?: string };
/** May this rubric run on these units? Pure. A non-production rubric needs lab:true (and explicit units); an llm_zdr / jev engine does not run in this slice. */
export function canRun(r: Rubric | null, opts: { lab: boolean; unit?: RubricUnit | null }): RunRefusal | null {
  if (!r) return { ok: false, error: "unknown_rubric" };
  if (r.status !== "production" && !opts.lab) return { ok: false, error: "lab_required", detail: `${r.id}@${r.version} is ${r.status}: pass lab:true with explicit units` };
  if (!(r.engine === "code" || (r.engine === "llm_zdr" && LLM_WIRED.has(r.id)))) return { ok: false, error: "engine_not_available", detail: `engine ${r.engine} is not wired for ${r.id}` };
  if (opts.unit && !unitsOf(r).includes(opts.unit)) return { ok: false, error: "unit_not_supported", detail: `${r.id} runs on ${unitsOf(r).join(", ")}` };
  return null;
}
