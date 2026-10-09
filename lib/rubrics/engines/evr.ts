/**
 * lib/rubrics/engines/evr.ts — S7-2: encounter_vs_record. One consult window: the signed record (reader pulse_record) against what was said on the tape (llm_zdr, strict JSON), compared in CODE
 * (lib/rubrics/evr/compare.ts). The output is a DISCREPANCY REPORT: findings with a record field, the tape time(s) or "no support found", and an evidence quote. It states no verdict on anyone.
 * Codes go to the table (score / findings); the record values and quotes go only to the R2 evidence. A tape quote is the tape's own words; every sentence this module writes is fixed text.
 */
import type { Rubric } from "../types";
import { promptVersion } from "./consult-llm";
import type { ConsultText } from "../readers/consult-text";
import { readPulseRecord } from "../readers/pulse-record";
import { extractSaid } from "../evr/said";
import { compareRecord, overallTier, type JevJudge, type TapeLine } from "../evr/compare";
import { findingCode, TIER_ORDER, type Finding } from "../evr/types";
import { scoreWindow, type WindowOutcome } from "../evr/perturb";
import type { EngineResult } from "./types";

export const REPORT_LABEL = "discrepancy report";
const fmt = (ms: number): string => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
export const tapeLines = (t: ConsultText): TapeLine[] => t.lines.map((l) => ({ t_ms: l.t_ms, text: l.text }));

/** Product wording that must never appear in any string this rubric writes (a test checks every output string). */
export const BANNED_WORDS = ["fraud", "fraudulent", "guilty", "dishonest", "dishonesty", "lying", "liar", "deceit", "deceive", "deceptive", "falsif", "forged", "forgery", "cheat", "misconduct", "malpractice", "corrupt"];

/** The banned words found in a string (case-insensitive). PURE; used by the tests over every file and string this rubric can write. */
export const findBanned = (s: string): string[] => BANNED_WORDS.filter((b) => s.toLowerCase().includes(b));

/** The unwired judgement hook: reserved for judgement items only; it is NEVER called in this slice. */
export const jevJudge: JevJudge | undefined = undefined;

export async function evaluateEncounterVsRecord(r: Rubric, text: ConsultText, consultKey: string): Promise<EngineResult> {
  const rec = await readPulseRecord(consultKey);
  if (!rec.ok) return { status: "skipped", findings: [], reason: rec.reason === "no_data" ? "no_record" : rec.reason };
  const said = await extractSaid(text);
  if (!said.ok) return said.reason === "unscorable" ? { status: "skipped", findings: [], reason: "unscorable" } : { status: "failed", findings: [], reason: said.reason, evidence: { prompt_version: promptVersion(r), attempts: said.attempts } };
  const fs: Finding[] = compareRecord(rec.data.record, said.said, tapeLines(text));
  const tier = overallTier(fs);
  const byTier = Object.fromEntries(TIER_ORDER.map((t) => [t, fs.filter((f) => f.tier === t).length]));
  const codes = [...new Set(fs.map(findingCode))].sort();
  return {
    status: "ok",
    score: {
      label: REPORT_LABEL, severity: tier, n_findings: fs.length, counts_by_tier: byTier, n_records: rec.data.n_records, record_choice: rec.data.chosen,
      ai_filled_findings: fs.filter((f) => f.field_ai_filled === true).length, said_dropped_unverified: said.dropped, prompt_version: promptVersion(r), attempts: said.attempts,
    },
    findings: codes,
    evidence: {
      label: REPORT_LABEL, model: said.model, prompt_version: promptVersion(r), transcript_source: text.source, truncated: text.truncated,
      findings: fs.map((f) => ({ code: findingCode(f), field: f.field, tier: f.tier, target: f.target, record_value: f.record_value, support: f.support, tape: f.tape_t_ms.map(fmt), tape_t_ms: f.tape_t_ms, quote: f.quote, field_ai_filled: f.field_ai_filled, text: f.text })),
    },
  };
}

/** One window of the perturbation bench: the real record and the stored transcript, one perturbation per kind applied to copies, counts only. Never returns record text. */
export async function evaluateEvrWindow(r: Rubric, text: ConsultText, consultKey: string, seed: number, kinds?: readonly import("../evr/perturb").PerturbKind[]): Promise<{ ok: true; outcome: WindowOutcome; calls: number } | { ok: false; reason: string; calls: number }> {
  const rec = await readPulseRecord(consultKey);
  if (!rec.ok) return { ok: false, reason: rec.reason === "no_data" ? "no_record" : rec.reason, calls: 0 };
  const said = await extractSaid(text);
  if (!said.ok) return { ok: false, reason: said.reason, calls: said.attempts };
  void r;
  return { ok: true, outcome: scoreWindow(rec.data.record, said.said, tapeLines(text), seed, kinds), calls: said.attempts };
}
