/**
 * lib/rubrics/types.ts — S7-0: what a rubric file may say. A rubric is a versioned repo file (rubrics/<id>/rubric.json); this is its schema.
 * No patient identifier, transcript text, example, quote or gold row belongs in a rubric file: definitions, scales, anchors, codes and formulas only.
 */
import { z } from "zod";

export const RUBRIC_UNITS = ["window", "consult", "room_hour", "stay"] as const;
export type RubricUnit = (typeof RUBRIC_UNITS)[number];
/** Reader names a rubric may declare as inputs. pulse_record is S7.2 (a stub that answers not_implemented); consult_text is real since S7-1; `external` = the data comes from outside the MCP. */
export const READER_NAMES = ["window_english", "turns", "emotion", "audio_state", "consult_span", "consult_text", "pulse_record", "external"] as const;
export type ReaderName = (typeof READER_NAMES)[number];
export const RUBRIC_ENGINES = ["code", "jev", "llm_zdr"] as const;
export type RubricEngine = (typeof RUBRIC_ENGINES)[number];
export const RUBRIC_STATUSES = ["draft", "benched", "production"] as const;
export type RubricStatus = (typeof RUBRIC_STATUSES)[number];
/** field_accuracy and accuracy score a code engine against its labelled units; weighted_kappa is for the ordinal-scale LLM rubrics (not wired in S7-0: rubric_bench refuses it) */
export const BENCH_METRICS = ["field_accuracy", "accuracy", "weighted_kappa"] as const;

const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver (x.y.z)");
const idRe = /^[a-z][a-z0-9_]{1,63}$/;

export const RubricFile = z
  .object({
    id: z.string().regex(idRe),
    version: semver,
    title: z.string().min(3).max(120),
    unit: z.enum(RUBRIC_UNITS),
    /** the other units this rubric also runs on (talk_time: window and consult) */
    units: z.array(z.enum(RUBRIC_UNITS)).min(1).max(4).optional(),
    inputs: z.array(z.enum(READER_NAMES)).min(1).max(8),
    engine: z.enum(RUBRIC_ENGINES),
    /** Jev typed questions (engine jev) */
    questions: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{1,48}$/), text: z.string().min(5).max(600), choices: z.array(z.string().min(1).max(40)).min(2).max(12) }).strict()).max(40).optional(),
    /** the prompt file beside rubric.json (engine llm_zdr), relative, no path separators above the folder */
    prompt: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
    /** JSON schema (an object schema) of one result's `score` */
    output: z.object({ type: z.literal("object") }).passthrough(),
    bench: z.object({ location: z.string().min(3).max(200), metric: z.enum(BENCH_METRICS), threshold: z.number().min(0).max(1) }).strict(),
    status: z.enum(RUBRIC_STATUSES),
    /** an imported rubric: original id@version */
    source: z.string().regex(/^[A-Za-z0-9_.-]{1,80}@[A-Za-z0-9_.-]{1,40}$/).optional(),
    /** definitions, scales, anchors, codes, formulas (free-form JSON; scanned for identifiers by a test) */
    definition: z.record(z.unknown()).optional(),
  })
  .strict();
export type Rubric = z.infer<typeof RubricFile>;

/** Cross-field rules a schema cannot say; returns the problems (empty = fine). */
export function rubricProblems(r: Rubric, dirName: string, hasFile: (rel: string) => boolean): string[] {
  const p: string[] = [];
  if (r.id !== dirName) p.push(`id "${r.id}" must equal its folder name "${dirName}"`);
  const units = new Set<RubricUnit>([r.unit, ...(r.units ?? [])]);
  if (r.units && !r.units.includes(r.unit)) p.push("units must include unit");
  if (r.engine === "jev" && !(r.questions && r.questions.length > 0) && r.status !== "draft") p.push("engine jev needs questions");
  if (r.engine === "llm_zdr" && !r.prompt && r.status !== "draft") p.push("engine llm_zdr needs a prompt file beside rubric.json");
  if (r.engine === "code" && (r.questions || r.prompt)) p.push("engine code takes no questions or prompt");
  if (r.prompt && !hasFile(`${dirName}/${r.prompt}`)) p.push(`prompt file ${r.prompt} is missing`);
  if (r.status !== "draft") {
    const stub = r.inputs.filter((i) => i === "pulse_record");
    if (stub.length > 0) p.push(`inputs ${stub.join(", ")} are not implemented (S7.2): a ${r.status} rubric cannot use them`);
    if (!r.bench.location.startsWith("rubrics/") && !r.bench.location.startsWith("rubric/")) p.push("bench.location must be rubrics/<...> (repo) or rubric/<...> (lab store)");
    if (r.bench.location.startsWith("rubrics/") && !hasFile(r.bench.location.slice("rubrics/".length))) p.push(`bench file ${r.bench.location} is missing`);
  }
  if (r.unit === "consult" && !r.inputs.some((i) => i === "consult_span" || i === "consult_text" || i === "external")) p.push("a consult rubric needs consult_span, consult_text or external as an input");
  if (units.has("room_hour") && !r.inputs.includes("audio_state")) p.push("a room_hour rubric needs the audio_state input");
  return p;
}

/** A rubric file must carry no identifier of a person, a visit, a tape or a placeholder of one. Returns the offending tokens. */
// built from parts so this file itself carries none of the placeholder tokens it forbids (a grep of the diff for them must come back empty)
const PLACEHOLDER_PREFIXES = ["CONSUL" + "T", "MEE" + "T", "VISI" + "T", "CHAR" + "T", "MEMBE" + "R", "R" + "X", "INDIVIDUA" + "L"];
export const FORBIDDEN_TOKENS = new RegExp(`\\b(P[0-4][0-9]|UHI` + `D[- ]?\\d*|(${PLACEHOLDER_PREFIXES.join("|")})-\\d+)\\b`);
export function identifierTokens(text: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(FORBIDDEN_TOKENS.source, "g");
  for (const m of text.matchAll(re)) out.add(m[0]);
  return [...out];
}
