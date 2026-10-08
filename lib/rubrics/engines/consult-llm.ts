/**
 * lib/rubrics/engines/consult-llm.ts — S7-1: the two llm_zdr consult rubrics, consult_chair_affect and consult_surgical_pitch.
 *
 * ONE PATH. consult text (readConsultText: timestamped doctor / other / unknown lines) -> a system prompt RENDERED from the rubric's own `definition` (anchors, anti-defaults, codes, scales: the
 * prompt cannot drift from the rubric file) plus the fixed rules in prompt.json -> askJson (lib/rubrics/llm.ts: the existing ZDR OpenRouter client, temperature 0, JSON validated against the
 * rubric's `output` schema, one retry) -> a score of enums and numbers, findings of codes, and an evidence object for R2.
 * QUOTES. Every evidence quote is checked against the transcript; the timestamp on a stored quote is the TRANSCRIPT LINE's, not the model's; a quote that is not in the transcript is dropped and counted.
 * NO TEXT IN THE TABLE. `score` holds enums, booleans and numbers; `findings` holds closed codes. Quotes exist only in `evidence` (R2).
 * CASES-LITE is a structural overlay kept SEPARATE from the four affect axes: it never changes one. Its engagement flag is cross-checked against talk_time (a consult in which the patient hardly speaks
 * cannot show an engagement process).
 */
import type { Rubric } from "../types";
import { getRubric, RUBRIC_PROMPTS } from "../registry";
import { askJson } from "../llm";
import type { ConsultText } from "../readers/consult-text";
import { evaluateTalkTime } from "./talk-time";
import type { EngineResult } from "./types";

const fmt = (ms: number): string => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const norm = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** `[mm:ss] speaker: text` per line. */
export function renderTranscript(text: ConsultText): string {
  return text.lines.map((l) => `[${fmt(l.t_ms)}] ${l.speaker}: ${l.text}`).join("\n");
}

/** The definition object as indented text: key: value, nested keys indented, lists as "- item". */
export function renderDefinition(def: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(def)) return def.map((x) => (typeof x === "object" && x !== null ? `${pad}-\n${renderDefinition(x, indent + 1)}` : `${pad}- ${String(x)}`)).join("\n");
  if (def && typeof def === "object") {
    return Object.entries(def as Record<string, unknown>)
      .map(([k, v]) => (typeof v === "object" && v !== null ? `${pad}${k}:\n${renderDefinition(v, indent + 1)}` : `${pad}${k}: ${String(v)}`))
      .join("\n");
  }
  return `${pad}${String(def)}`;
}

/** The system prompt of a consult rubric: the fixed rules (prompt.json) + the rubric's definition rendered as is. Deterministic. */
export function systemPrompt(r: Rubric): string {
  const p = RUBRIC_PROMPTS[r.id];
  if (!p) throw new Error("no_prompt");
  const { engine_note: _e, bench_population: _b, ...def } = (r.definition ?? {}) as Record<string, unknown>;
  void _e; void _b;
  return [`${r.title} (${r.id} v${r.version}, prompt v${p.version})`, "", "RULES", ...p.rules.map((x) => `- ${x}`), "", "THE RUBRIC (authoritative; follow its anchors, codes and anti-defaults exactly)", renderDefinition(def), "", "OUTPUT: one JSON object that matches this schema.", JSON.stringify(r.output)].join("\n");
}

export const promptVersion = (r: Rubric): string => RUBRIC_PROMPTS[r.id]?.version ?? "none";

type Quote = { item: string; quote: string; t_s?: number | null };
/** Check each quote against the transcript lines; the stored timestamp is the line's. Returns verified quotes and the count dropped. */
export function verifyQuotes(text: ConsultText, quotes: Quote[]): { kept: Array<{ item: string; quote: string; t_ms: number }>; dropped: number } {
  const lines = text.lines.map((l) => ({ t_ms: l.t_ms, n: norm(l.text) }));
  const kept: Array<{ item: string; quote: string; t_ms: number }> = [];
  let dropped = 0;
  for (const q of quotes) {
    const n = norm(q.quote);
    const hit = n.length >= 3 ? lines.find((l) => l.n.includes(n)) : undefined;
    if (hit) kept.push({ item: q.item, quote: q.quote, t_ms: hit.t_ms });
    else dropped += 1;
  }
  return { kept, dropped };
}

export type Engagement = "present" | "absent" | "lecture_only";
/** CASES-lite engagement cross-checked against talk_time: a patient who never speaks cannot show an engagement process; a doctor who talks > 85 % with <= 2 patient turns is a lecture. */
export function reconcileEngagement(model: Engagement, talk: EngineResult): { value: Engagement; overridden: boolean } {
  if (talk.status !== "ok" || !talk.score) return { value: model, overridden: false };
  const s = talk.score as { other_turns: number; unattributed_turns: number; doctor_share: number | null };
  const patientTurns = s.other_turns + s.unattributed_turns;
  if (model === "present" && patientTurns === 0) return { value: "absent", overridden: true };
  if (model === "present" && s.doctor_share !== null && s.doctor_share > 0.85 && patientTurns <= 2) return { value: "lecture_only", overridden: true };
  return { value: model, overridden: false };
}

const UPTAKE = ["accept", "hedge", "refuse", "question", "defer", "cost", "unheard"];
const bool = (v: unknown): boolean => v === true;

function userMessage(text: ConsultText, talk: EngineResult): string {
  const t = talk.status === "ok" ? talk.score! : null;
  const facts = t ? `TALK FEATURES (facts measured from the audio's turns, not opinions): doctor_share=${t.doctor_share ?? "unknown"}, doctor_turns=${t.doctor_turns}, patient_and_other_turns=${Number(t.other_turns) + Number(t.unattributed_turns)}, interruptions=${t.interruptions}, silence_share=${t.silence_share}.` : "TALK FEATURES: not available.";
  return `${RUBRIC_HEADER}\n${facts}${text.truncated ? "\nNOTE: the transcript was cut at the length limit." : ""}\n\n${renderTranscript(text)}`;
}
const RUBRIC_HEADER = "CONSULTATION TRANSCRIPT. Times are mm:ss from the start of the consultation. Speakers: doctor, other (the patient and anyone with them), unknown.";

function failed(reason: string, extra: Record<string, unknown> = {}): EngineResult {
  return { status: "failed", findings: [], reason, evidence: { ...extra } };
}

// ---- consult_chair_affect ----------------------------------------------------------------------------------------------------------------------
function affectProblems(v: Record<string, unknown>): string[] {
  if (v.scorable !== true) return [];
  const p: string[] = [];
  for (const k of ["distress", "confusion", "frustration", "reassurance", "teach_back", "recommendations", "cases_lite"]) if (!(k in v)) p.push(`$.${k}: missing when scorable`);
  return p;
}

export async function evaluateConsultAffect(r: Rubric, text: ConsultText): Promise<EngineResult> {
  const talk = evaluateTalkTime(text.turns, { start_ms: 0, end_ms: Math.max(1, text.span_ms) });
  const out = await askJson({ system: systemPrompt(r), user: userMessage(text, talk), schema: r.output as Record<string, unknown>, extraValidate: affectProblems });
  if (!out.ok) return failed(out.reason, { prompt_version: promptVersion(r), model: out.model, attempts: out.attempts });
  const v = out.value;
  if (v.scorable !== true) return { status: "skipped", score: { scorable: false }, findings: [], reason: "unscorable", evidence: { prompt_version: promptVersion(r), model: out.model, attempts: out.attempts } };
  const recs = (v.recommendations as Array<{ uptake: string[]; resolution_type: string; quote?: string }>) ?? [];
  const cases = v.cases_lite as { engagement_process: Engagement; information_present: boolean; doctor_effect_proxy: string; dominant_mix: string };
  const eng = reconcileEngagement(cases.engagement_process, talk);
  const quotes = [...((v.evidence as Quote[] | undefined) ?? []), ...recs.filter((x) => x.quote).map((x, i) => ({ item: `recommendation_${i + 1}`, quote: x.quote! }))];
  const vq = verifyQuotes(text, quotes);
  const uptake = [...new Set(recs.flatMap((x) => x.uptake))].sort();
  const resolutions = [...new Set(recs.map((x) => x.resolution_type))].sort();
  const findings = [`distress:${v.distress}`, `confusion:${v.confusion}`, `frustration:${v.frustration}`, `reassurance:${v.reassurance}`, `teach_back:${v.teach_back}`, ...uptake.map((u) => `uptake:${u}`), `engagement:${eng.value}`, `doctor_effect:${cases.doctor_effect_proxy}`];
  if (eng.overridden) findings.push("engagement_overridden_by_talk_time");
  if (quotes.length > 0 && vq.dropped * 2 > quotes.length) findings.push("evidence_weak");
  if (text.truncated) findings.push("truncated_text");
  return {
    status: "ok",
    score: {
      distress: v.distress, confusion: v.confusion, frustration: v.frustration, reassurance: v.reassurance, teach_back: v.teach_back, uptake_codes: uptake, n_recommendations: recs.length,
      cases_lite: { engagement_process: eng.value, information_present: cases.information_present, doctor_effect_proxy: cases.doctor_effect_proxy, dominant_mix: cases.dominant_mix, resolution_types: resolutions },
      prompt_version: promptVersion(r), attempts: out.attempts,
    },
    findings,
    evidence: { model: out.model, prompt_version: promptVersion(r), attempts: out.attempts, transcript_chars: text.chars, transcript_source: text.source, truncated: text.truncated, talk_time: talk.score ?? null, engagement_model_said: cases.engagement_process,
      quotes: vq.kept.map((q) => ({ item: q.item, quote: q.quote, t: fmt(q.t_ms), t_ms: q.t_ms })), quotes_dropped_not_in_transcript: vq.dropped },
  };
}

// ---- consult_surgical_pitch --------------------------------------------------------------------------------------------------------------------
function pitchProblems(v: Record<string, unknown>): string[] {
  if (v.surgery_recommended !== true) return [];
  const p: string[] = [];
  for (const k of ["recommendation_kind", "pitch_source", "pitch_balance", "uptake_of_surgery"]) if (!(k in v)) p.push(`$.${k}: missing when a surgery is recommended`);
  return p;
}

export async function evaluateSurgicalPitch(r: Rubric, text: ConsultText): Promise<EngineResult> {
  const talk = evaluateTalkTime(text.turns, { start_ms: 0, end_ms: Math.max(1, text.span_ms) });
  const out = await askJson({ system: systemPrompt(r), user: userMessage(text, talk), schema: r.output as Record<string, unknown>, extraValidate: pitchProblems });
  if (!out.ok) return failed(out.reason, { prompt_version: promptVersion(r), model: out.model, attempts: out.attempts });
  const v = out.value;
  if (v.surgery_recommended !== true) return { status: "skipped", score: { surgery_recommended: false }, findings: [], reason: "no_surgery_recommendation", evidence: { prompt_version: promptVersion(r), model: out.model, attempts: out.attempts } };
  const bal = v.pitch_balance as Record<string, unknown>;
  const doubts = (v.doubts as Array<{ kind: string; code: string; quote?: string }> | undefined) ?? [];
  const vq = verifyQuotes(text, [...((v.evidence as Quote[] | undefined) ?? []), ...doubts.filter((d) => d.quote).map((d, i) => ({ item: `doubt_${i + 1}`, quote: d.quote! }))]);
  const findings = [`kind:${v.recommendation_kind}`, `source:${v.pitch_source}`, ...["benefits_named", "risks_named", "alternatives_named", "timing_named"].map((k) => (bool(bal[k]) ? k : `${k.replace("_named", "")}_not_named`)), ...doubts.map((d) => `doubt:${d.kind}:${d.code}`), `uptake:${v.uptake_of_surgery}`];
  if (bool(v.prompted_yes)) findings.push("prompted_yes");
  if (text.truncated) findings.push("truncated_text");
  return {
    status: "ok",
    score: {
      surgery_recommended: true, recommendation_kind: v.recommendation_kind, pitch_source: v.pitch_source,
      benefits_named: bool(bal.benefits_named), risks_named: bool(bal.risks_named), alternatives_named: bool(bal.alternatives_named), timing_named: bool(bal.timing_named),
      n_doubts: doubts.length, doubts_unheard: doubts.filter((d) => d.code === "unheard").length, uptake_of_surgery: v.uptake_of_surgery, prompted_yes: bool(v.prompted_yes),
      prompt_version: promptVersion(r), attempts: out.attempts,
    },
    findings,
    evidence: { model: out.model, prompt_version: promptVersion(r), attempts: out.attempts, transcript_chars: text.chars, transcript_source: text.source, truncated: text.truncated, doubts: doubts.map((d) => ({ kind: d.kind, code: d.code })),
      quotes: vq.kept.map((q) => ({ item: q.item, quote: q.quote, t: fmt(q.t_ms), t_ms: q.t_ms })), quotes_dropped_not_in_transcript: vq.dropped },
  };
}

export const CONSULT_UPTAKE_CODES = UPTAKE;
export const consultRubric = (id: string): Rubric | null => getRubric(id);
