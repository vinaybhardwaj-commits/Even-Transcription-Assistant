/**
 * lib/jev/worker/sets.ts — a question set as a repo file, its validation and its hash (PRD §4).
 *
 * Source of truth: `jev/question-sets/<id>/<version>.json`, reviewed in PRs like rubrics. The DB mirror (sync.ts) is for
 * joins and status. A set's STATUS is not in the file: it starts `draft` and only moves by ratified events (sync.ts).
 *
 * THE HASH covers every question's kind, body (instructions, options IN ORDER), option order, gate and escapes, plus the
 * set's id, version, use, subject type, state schema and model pin. Bands, calibration and authorship are runtime tuning
 * and are NOT in it. A one-character wording change is a new hash, and has to be a new version.
 */
import type { JevQuestion } from "../types";
import { JEV_SUBJECT_TYPES } from "../types";
import { hashOf } from "./canonical";

export const JEV_MODEL_PIN = "jev-1.13.0";
export const QUESTION_SET_USES = ["encounter_timeline", "stt_quality", "stt_pick", "consult_rubric", "legacy"] as const;
export type QuestionSetUse = (typeof QUESTION_SET_USES)[number];
export const SET_STATUSES = ["draft", "bench", "shadow", "live", "retired"] as const;
export type SetStatus = (typeof SET_STATUSES)[number];
export const OPTION_ORDERS = ["forward", "reversed", "both"] as const;

export type QuestionDef = {
  question_id: string;
  kind: "choice" | "score" | "noul";
  body: JevQuestion;
  option_order?: (typeof OPTION_ORDERS)[number];
  gate_question_id?: string | null;
  escape_options?: string[];
  bands?: { act: number; caution: number } | null;
  calibration?: { method: "temperature" | "isotonic" | "none"; params_sha?: string } | null;
};

export type QuestionSetFile = {
  id: string;
  version: string;
  use: QuestionSetUse;
  subject_type: (typeof JEV_SUBJECT_TYPES)[number];
  state_schema: string;
  model_pin: string;
  bands?: { act: number; caution: number } | null;
  calibration_ref?: string | null;
  created_by: string;
  questions: QuestionDef[];
};

export class QuestionSetError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

const ID_RE = /^[a-z][a-z0-9_-]{1,48}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const QID_RE = /^[a-z][a-z0-9_]{1,48}$/;

/** Throws QuestionSetError naming the first problem. Returns the file typed. */
export function validateSetFile(raw: unknown): QuestionSetFile {
  const f = raw as Partial<QuestionSetFile> | null;
  const bad = (m: string): never => { throw new QuestionSetError(m); };
  if (!f || typeof f !== "object") return bad("set file is not an object");
  if (typeof f.id !== "string" || !ID_RE.test(f.id)) bad("id must match ^[a-z][a-z0-9_-]{1,48}$");
  if (typeof f.version !== "string" || !VERSION_RE.test(f.version)) bad("version is malformed");
  if (!(QUESTION_SET_USES as readonly string[]).includes(f.use as string) || f.use === "legacy") bad("use must be one of the four real uses");
  if (!(JEV_SUBJECT_TYPES as readonly string[]).includes(f.subject_type as string)) bad("subject_type is not a Jev subject type");
  if (typeof f.state_schema !== "string" || !f.state_schema) bad("state_schema is required");
  if (f.model_pin !== JEV_MODEL_PIN) bad(`model_pin must be ${JEV_MODEL_PIN} (a model bump is a new version and a re-bench)`);
  if (typeof f.created_by !== "string" || !f.created_by) bad("created_by is required");
  if (!Array.isArray(f.questions) || f.questions.length === 0) bad("a set needs at least one question");
  const seen = new Set<string>();
  for (const q of f.questions as QuestionDef[]) {
    if (typeof q.question_id !== "string" || !QID_RE.test(q.question_id)) bad("question_id must match ^[a-z][a-z0-9_]{1,48}$");
    if (seen.has(q.question_id)) bad(`duplicate question_id ${q.question_id}`);
    seen.add(q.question_id);
    if (!q.body || q.body.type !== q.kind) bad(`${q.question_id}: body.type must equal kind`);
    if (typeof q.body.instructions !== "string" || !q.body.instructions) bad(`${q.question_id}: instructions are required`);
    if (q.option_order !== undefined && !(OPTION_ORDERS as readonly string[]).includes(q.option_order)) bad(`${q.question_id}: option_order is invalid`);
    if (q.kind === "choice") {
      const keys = Object.keys((q.body as { criteria: Record<string, unknown> }).criteria ?? {});
      if (keys.length < 2) bad(`${q.question_id}: a choice needs at least two options`);
      if (!q.escape_options || q.escape_options.length === 0) bad(`${q.question_id}: a choice must declare escape_options`);
      for (const e of q.escape_options ?? []) if (!keys.includes(e)) bad(`${q.question_id}: escape option ${e} is not one of its options`);
    } else if ((q.option_order ?? "forward") !== "forward") bad(`${q.question_id}: only a choice has an option order`);
  }
  for (const q of f.questions as QuestionDef[]) if (q.gate_question_id && !seen.has(q.gate_question_id)) bad(`${q.question_id}: gate_question_id names no question of this set`);
  return f as QuestionSetFile;
}

/** What a question looks like to the hash: a Choice's options as an ORDERED array of pairs. */
export function hashableBody(body: JevQuestion): unknown {
  if (body.type === "choice") return { ...body, criteria: Object.entries(body.criteria) };
  return body;
}

export function questionSha(q: QuestionDef): string {
  return hashOf({
    question_id: q.question_id, kind: q.kind, body: hashableBody(q.body), option_order: q.option_order ?? "forward",
    gate_question_id: q.gate_question_id ?? null, escape_options: q.escape_options ?? [],
  });
}

export function setSha(f: QuestionSetFile): string {
  return hashOf({
    id: f.id, version: f.version, use: f.use, subject_type: f.subject_type, state_schema: f.state_schema, model_pin: f.model_pin,
    questions: f.questions.map((q) => ({ question_id: q.question_id, sha: questionSha(q) })),
  });
}

/** The prompt_version stored on every answer of this set: `<id>@<version>` plus the option order sent. */
export const promptVersionOf = (f: { id: string; version: string }, order?: "fwd" | "rev" | "derived"): string =>
  `${f.id}@${f.version}${order ? `+${order}` : ""}`;
