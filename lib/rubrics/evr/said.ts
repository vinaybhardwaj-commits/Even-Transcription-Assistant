/**
 * lib/rubrics/evr/said.ts — S7-2: said_items(encounter). The clinically material items SAID in an encounter, with the line they were said on, extracted by the llm_zdr door (lib/rubrics/llm.ts:
 * the existing ZDR client, temperature 0, strict JSON, one retry). Invalid output is an ERROR result (no guess). Every item must carry a quote that is on the tape; the timestamp stored is the
 * transcript line's, not the model's; an item whose quote is not on the tape is dropped and counted (more than half dropped = the extraction is refused).
 */
import { askJson } from "../llm";
import type { ConsultText } from "../readers/consult-text";
import { renderTranscript, verifyQuotes } from "../engines/consult-llm";
import { RUBRIC_PROMPTS } from "../registry";
import type { SaidItems } from "./types";

const S = (max: number) => ({ type: "string", maxLength: max });
const arrOf = (props: Record<string, unknown>, required: string[]) => ({ type: "array", maxItems: 40, items: { type: "object", additionalProperties: false, required, properties: { ...props, quote: S(300) } } });
export const SAID_SCHEMA = {
  type: "object", additionalProperties: false, required: ["scorable"],
  properties: {
    scorable: { type: "boolean" },
    complaints: arrOf({ text: S(160) }, ["text", "quote"]),
    diagnoses: arrOf({ name: S(160), side: S(12) }, ["name", "quote"]),
    meds: arrOf({ name: S(120), dose: S(60), freq: S(60), route: S(40), duration: S(60), side: S(12) }, ["name", "quote"]),
    investigations: arrOf({ name: S(160) }, ["name", "quote"]),
    procedures: arrOf({ name: S(160), side: S(12) }, ["name", "quote"]),
    followup: arrOf({ text: S(160) }, ["text", "quote"]),
  },
} as const;

const PROMPT = RUBRIC_PROMPTS.encounter_vs_record!;
export const SAID_PROMPT_VERSION = PROMPT.version;
export const SAID_RULES = PROMPT.rules;

export function saidSystemPrompt(): string {
  return [`Encounter items said (said_items prompt v${SAID_PROMPT_VERSION})`, "", "RULES", ...SAID_RULES.map((x) => `- ${x}`), "", "OUTPUT: one JSON object that matches this schema.", JSON.stringify(SAID_SCHEMA)].join("\n");
}

export type SaidResult =
  | { ok: true; said: SaidItems; dropped: number; model: string; attempts: number }
  | { ok: false; reason: string; attempts: number }
  | { ok: false; reason: "unscorable"; attempts: number };

type Raw = Record<string, Array<Record<string, string>>>;

export async function extractSaid(text: ConsultText): Promise<SaidResult> {
  const out = await askJson({ system: saidSystemPrompt(), user: `CONSULTATION TRANSCRIPT. Times are mm:ss from the start. Speakers: doctor, other, unknown.\n\n${renderTranscript(text)}`, schema: SAID_SCHEMA as unknown as Record<string, unknown> });
  if (!out.ok) return { ok: false, reason: out.reason, attempts: out.attempts };
  const v = out.value as unknown as { scorable: boolean } & Raw;
  if (v.scorable !== true) return { ok: false, reason: "unscorable", attempts: out.attempts };
  let total = 0, dropped = 0;
  const keep = <T extends Record<string, string>>(items: T[] | undefined, key: string) => {
    const list = items ?? [];
    total += list.length;
    const vq = verifyQuotes(text, list.map((x) => ({ item: key, quote: x.quote ?? "" })));
    // verifyQuotes keeps order; align kept entries back to their items by quote
    const kept: Array<T & { t_ms: number }> = [];
    let k = 0;
    for (const it of list) {
      const hit = vq.kept[k];
      if (hit && hit.quote === (it.quote ?? "")) { kept.push({ ...it, t_ms: hit.t_ms }); k += 1; }
      else dropped += 1;
    }
    return kept;
  };
  const said: SaidItems = {
    complaints: keep(v.complaints, "complaints").map((x) => ({ text: x.text ?? "", t_ms: x.t_ms, quote: x.quote ?? "" })),
    diagnoses: keep(v.diagnoses, "diagnoses").map((x) => ({ name: x.name ?? "", side: x.side ?? "", t_ms: x.t_ms, quote: x.quote ?? "" })),
    meds: keep(v.meds, "meds").map((x) => ({ name: x.name ?? "", dose: x.dose ?? "", freq: x.freq ?? "", route: x.route ?? "", duration: x.duration ?? "", side: x.side ?? "", t_ms: x.t_ms, quote: x.quote ?? "" })),
    investigations: keep(v.investigations, "investigations").map((x) => ({ name: x.name ?? "", t_ms: x.t_ms, quote: x.quote ?? "" })),
    procedures: keep(v.procedures, "procedures").map((x) => ({ name: x.name ?? "", side: x.side ?? "", t_ms: x.t_ms, quote: x.quote ?? "" })),
    followup: keep(v.followup, "followup").map((x) => ({ text: x.text ?? "", t_ms: x.t_ms, quote: x.quote ?? "" })),
  };
  if (total > 0 && dropped * 2 > total) return { ok: false, reason: "said_items_unverified", attempts: out.attempts };
  return { ok: true, said, dropped, model: out.model, attempts: out.attempts };
}
