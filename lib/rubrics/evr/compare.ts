/**
 * lib/rubrics/evr/compare.ts — S7-2: the comparison, in CODE, field by field. PURE. Record (normalised) against what was said (items extracted from the tape) and the tape text itself.
 *
 * Findings: in_record_not_said, said_not_in_record, value_mismatch (dose, frequency, laterality). Tiers (thresholds below, all in code):
 *   obvious  a drug, procedure or non-differential diagnosis in the record with no support anywhere on the tape; or a clear laterality / dose contradiction (dose ratio >= 1.8 or <= 0.56)
 *   material a smaller dose difference, a frequency difference
 *   minor    a differential diagnosis, an investigation, anything said that the record lacks
 *   none     no finding
 * PROVENANCE: every finding carries field_ai_filled from the record's own ai_field_metadata. A finding on an AI-filled field says so in its text and is CAPPED at material.
 * Drug names are matched with the S7.1 drug-match scorer (nameScore) behind its common-English / clinical-vocabulary gate. Nothing here states a verdict on a person.
 * jevJudge is an UNWIRED hook for judgement items only: it is never called here (default undefined).
 */
import { isClinicalEnglishWord, isFrequentWord, matchForm, nameScore } from "@/lib/drug-match";
import { maxTier, type AiFilled, type Finding, type NormRecord, type SaidItems, type Tier } from "./types";

export const DOSE_CLEAR_HIGH = 1.8;
export const DOSE_CLEAR_LOW = 0.56;
export const DRUG_MATCH_MIN = 0.8;
export const COVERAGE_MIN = 0.6;

export type TapeLine = { t_ms: number; text: string };
export type JevJudge = (item: { field: string; record_value: string; tape_text: string }) => Promise<{ tier: Tier; note: string }>;

const words = (s: string): string[] => (s.toLowerCase().normalize("NFKD").match(/[a-z0-9]+/g) ?? []);
const STOP = new Set(["the", "and", "with", "for", "of", "to", "in", "on", "a", "an", "tablet", "tab", "capsule", "cap", "syrup", "injection", "cream", "gel", "ointment", "mg", "ml", "daily", "twice", "once", "left", "right", "both", "bilateral", "acute", "chronic"]);
const content = (s: string): string[] => words(s).filter((w) => w.length >= 4 && !STOP.has(w));

// ---- parsing ------------------------------------------------------------------------------------------------------------------------------
export type Dose = { value: number; unit: "mg" | "ml" | "iu" | "pct"; /** read from a bare number with no unit, in the record's unit */ bare?: true };
const SMALL: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** "five hundred" -> 500, "one thousand" -> 1000, "two fifty" -> 250, "half" -> 0.5, "one and a half" -> 1.5. Returns the text with each number-word run replaced by digits. PURE. */
export function numberWordsToDigits(s: string): string {
  const DIG = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  // "point five" -> 0.5, "one point five" -> 1.5 (a decimal point spoken as a word)
  const pre = s
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|zero)?\s*point\s+(zero|one|two|three|four|five|six|seven|eight|nine)\b/gi, (_m, w: string | undefined, d: string) => `${w ? DIG.indexOf(w.toLowerCase()) : 0}.${DIG.indexOf(d.toLowerCase())}`)
    .replace(/\bone and a half\b/gi, "1.5").replace(/\bhalf\b/gi, "0.5");
  const toks = pre.split(/(\s+)/);
  const out: string[] = [];
  const word = (t: string | undefined) => (t ?? "").toLowerCase().replace(/[^a-z]/g, "");
  for (let i = 0; i < toks.length; i++) {
    const w = word(toks[i]);
    if (w in SMALL || w === "hundred" || w === "thousand") {
      // collect the run of number words (skipping spaces and "and")
      const run: string[] = [];
      let last = i;
      for (let j = i; j < toks.length; j++) {
        const t = word(toks[j]);
        if (/^\s+$/.test(toks[j] ?? "") || t === "and") continue;
        if (t in SMALL || t === "hundred" || t === "thousand") { run.push(t); last = j; } else break;
      }
      // Q1: "<1-9> <tens>[ <1-9>]" is hundreds + tens (+ units): "six fifty" 650, "two fifty" 250, "one twenty five" 125 (a hundreds digit is spoken before the tens). No "hundred" in the run.
      let total = 0, cur = 0;
      const isUnit = (t: string | undefined) => t !== undefined && t in SMALL && SMALL[t]! >= 1 && SMALL[t]! <= 9;
      const isTens = (t: string | undefined) => t !== undefined && t in SMALL && SMALL[t]! >= 20 && SMALL[t]! % 10 === 0;
      let k = 0;
      if (isUnit(run[0]) && isTens(run[1]) && !run.includes("hundred") && !run.includes("thousand")) {
        cur = SMALL[run[0]!]! * 100 + SMALL[run[1]!]!;
        k = 2;
        if (isUnit(run[2])) { cur += SMALL[run[2]!]!; k = 3; }
      }
      for (; k < run.length; k++) {
        const t = run[k]!;
        if (t in SMALL) cur += SMALL[t]!;
        else if (t === "hundred") cur = (cur || 1) * 100;
        else { total += (cur || 1) * 1000; cur = 0; }
      }
      out.push(String(total + cur));
      i = last;
      continue;
    }
    out.push(toks[i] ?? "");
  }
  return out.join("");
}

/** A dose from text with digits or number words and a unit; `defaultUnit` reads a unitless number as that unit (used when the record drug has exactly one unit). */
export function parseDose(s: string, defaultUnit?: Dose["unit"]): Dose | null {
  const text = numberWordsToDigits(s).replace(/,/g, "");
  const m = /(\d+(?:\.\d+)?)\s*(mg|mcg|µg|μg|ug|g|ml|iu|units?|%)/i.exec(text);
  if (!m) {
    const bare = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(text.trim());
    return bare && defaultUnit ? { value: Number(bare[1]), unit: defaultUnit, bare: true } : null;
  }
  const v = Number(m[1]);
  const u = m[2]!.toLowerCase();
  if (u === "g") return { value: v * 1000, unit: "mg" };
  if (u === "mg") return { value: v, unit: "mg" };
  if (u === "mcg" || u === "µg" || u === "μg" || u === "ug") return { value: v / 1000, unit: "mg" };
  if (u === "ml") return { value: v, unit: "ml" };
  if (u === "%") return { value: v, unit: "pct" };
  return { value: v, unit: "iu" };
}
/**
 * Q6: the dose said on the tape, read against the record's dose. A figure with its own unit is read as it is. A BARE number (or "half" / "point five") carries no unit, so it is read in the record's
 * unit ONLY when that is plausible against the record dose (at least 10 % and at most 10 x of it); otherwise it is treated as unparseable (counted apart by the bench). "2 tablets"-style counts
 * have no bare-number form and are never read as mg.
 */
export function parseTapeDose(said: string, record: Dose | null): Dose | null {
  const d = parseDose(said, record?.unit);
  if (!d) return null;
  if (d.bare && record && !(d.value >= record.value * 0.1 && d.value <= record.value * 10)) return null;
  return d;
}
export function parseFreq(s: string): number | null {
  const t = s.toLowerCase();
  if (!t.trim()) return null;
  if (/\b(sos|prn|as needed)\b/.test(t)) return 0;
  const pat = /(\d)\s*-\s*(\d)\s*-\s*(\d)(?:\s*-\s*(\d))?/.exec(t);
  if (pat) return [pat[1], pat[2], pat[3], pat[4]].filter((x) => x !== undefined && Number(x) > 0).length;
  if (/\b(qid|qds|four times|4 times)\b/.test(t)) return 4;
  if (/\b(tds|tid|thrice|three times|3 times)\b/.test(t)) return 3;
  if (/\b(bd|bid|twice|two times|2 times)\b/.test(t)) return 2;
  if (/\b(od|once|daily|hs|at night|bedtime|morning|1 time)\b/.test(t)) return 1;
  return null;
}
export type Side = "left" | "right" | "both" | null;
export function parseSide(s: string): Side {
  const t = s.toLowerCase();
  const l = /\b(left|lt)\b/.test(t), r = /\b(right|rt)\b/.test(t), b = /\b(bilateral|both)\b/.test(t);
  if (b || (l && r)) return "both";
  return l ? "left" : r ? "right" : null;
}
const swapSide = (s: string): string => s.replace(/\b(left|right)\b/gi, (w) => (w.toLowerCase() === "left" ? (w[0] === "L" ? "Right" : "right") : w[0] === "R" ? "Left" : "left"));
export { swapSide };

// ---- matching -----------------------------------------------------------------------------------------------------------------------------
/** Same drug? equal match forms, or a close spelling by the drug-match scorer. A common-English / clinical word only matches on an (almost) exact spelling. */
export function sameDrug(a: string[], b: string[]): boolean {
  for (const x of a) for (const y of b) {
    if (!x.trim() || !y.trim()) continue;
    const fx = matchForm(x), fy = matchForm(y);
    if (fx && fx === fy) return true;
    const strict = isFrequentWord(x) || isClinicalEnglishWord(x) || isFrequentWord(y) || isClinicalEnglishWord(y);
    if (nameScore(x, y) >= (strict ? 0.97 : DRUG_MATCH_MIN)) return true;
  }
  return false;
}

/** Is a drug mentioned on the tape at all (windows of 1-2 words per line)? Returns the first line. */
export function tapeMention(names: string[], lines: TapeLine[]): TapeLine | null {
  for (const l of lines) {
    const w = l.text.split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
    for (let i = 0; i < w.length; i++) for (const size of [1, 2]) {
      if (i + size > w.length) continue;
      const win = w.slice(i, i + size).join(" ");
      if (win.replace(/[^\p{L}]/gu, "").length < 4) continue;
      for (const n of names) if (n.trim() && nameScore(win, n, size) >= (isFrequentWord(win) || isClinicalEnglishWord(win) ? 0.97 : DRUG_MATCH_MIN)) return l;
    }
  }
  return null;
}

/** Do the content words of a procedure / diagnosis name appear on the tape (or in a said item)? Coverage by stem (first 5 letters). */
function coverage(name: string, tapeWords: Set<string>): number {
  const cw = content(name);
  if (cw.length === 0) return 0;
  const stems = new Set([...tapeWords].map((w) => w.slice(0, 5)));
  return cw.filter((w) => stems.has(w.slice(0, 5))).length / cw.length;
}
export const nameOverlap = (a: string, b: string): boolean => {
  const x = content(a), y = new Set(content(b).map((w) => w.slice(0, 5)));
  return x.length > 0 && x.filter((w) => y.has(w.slice(0, 5))).length / x.length >= 0.5;
};

// ---- the comparison -----------------------------------------------------------------------------------------------------------------------
const capFor = (tier: Tier, ai: AiFilled): Tier => (ai === true && tier === "obvious" ? "material" : tier);
const aiNote = (ai: AiFilled): string => (ai === true ? " (AI-filled field)" : "");

export function compareRecord(rec: NormRecord, said: SaidItems, lines: TapeLine[]): Finding[] {
  const out: Finding[] = [];
  const tapeWords = new Set(lines.flatMap((l) => words(l.text)));
  const push = (f: Omit<Finding, "text" | "tier"> & { tier: Tier; what: string }) => {
    const tier = capFor(f.tier, f.field_ai_filled);
    const { what, ...rest } = f;
    out.push({ ...rest, tier, text: `${what}${aiNote(f.field_ai_filled)}${tier !== f.tier ? " [capped at material]" : ""}` });
  };

  // drugs in the record
  // R1 (S7-2-R2): a drug that is said on the tape but matches NO record drug may simply be the brand of a record drug that was written by its generic name (Pulse carries no brand<->generic
  // pairs in the S8A4 name list). While any said drug is unmatched, a record drug with no support is capped at material: a correctly recorded drug is never tiered obvious on a naming difference.
  const unmatchedSaid = said.meds.filter((s) => !rec.meds.some((m) => sameDrug([m.name, m.alt_name].filter(Boolean), [s.name]))).length;
  const matchedSaid = new Set<number>();
  for (const m of rec.meds) {
    const names = [m.name, m.alt_name].filter(Boolean);
    const idx = said.meds.findIndex((s, i) => !matchedSaid.has(i) && sameDrug(names, [s.name]));
    if (idx < 0) {
      const mention = tapeMention(names, lines);
      if (!mention) push({ kind: "in_record_not_said", field: "drug", tier: unmatchedSaid > 0 ? "material" : "obvious", target: m.name, record_value: [m.name, m.dose, m.freq].filter(Boolean).join(" "), tape_t_ms: [], quote: null, support: "no support found", field_ai_filled: rec.ai.meds, what: unmatchedSaid > 0 ? "A drug in the record has no support on the tape (a different drug name was said: it may be the same drug by another name)" : "A drug in the record has no support on the tape" });
      continue;
    }
    matchedSaid.add(idx);
    const s = said.meds[idx]!;
    const rd = parseDose(m.dose), sd = parseTapeDose(s.dose, rd);
    if (rd && sd && rd.unit === sd.unit && rd.value > 0 && sd.value > 0 && Math.abs(rd.value - sd.value) > 1e-9) {
      const ratio = rd.value / sd.value;
      const clear = ratio >= DOSE_CLEAR_HIGH || ratio <= DOSE_CLEAR_LOW;
      push({ kind: "value_mismatch", field: "dose", tier: clear ? "obvious" : "material", target: m.name, record_value: m.dose, tape_t_ms: [s.t_ms], quote: s.quote, support: "tape support", field_ai_filled: rec.ai.meds, what: `The dose in the record (${m.dose}) differs from the dose on the tape (${s.dose})` });
    }
    const rf = parseFreq(m.freq), sf = parseFreq(s.freq);
    if (rf !== null && sf !== null && rf !== sf) push({ kind: "value_mismatch", field: "frequency", tier: "material", target: m.name, record_value: m.freq, tape_t_ms: [s.t_ms], quote: s.quote, support: "tape support", field_ai_filled: rec.ai.meds, what: `The frequency in the record (${m.freq}) differs from the tape (${s.freq})` });
  }
  said.meds.forEach((s, i) => {
    if (matchedSaid.has(i)) return;
    if (!rec.meds.some((m) => sameDrug([m.name, m.alt_name].filter(Boolean), [s.name])))
      push({ kind: "said_not_in_record", field: "drug", tier: "minor", target: s.name, record_value: null, tape_t_ms: [s.t_ms], quote: s.quote, support: "tape support", field_ai_filled: rec.ai.meds, what: "A drug said on the tape is not in the record" });
  });

  // procedures
  for (const p of rec.procedures) {
    const sp = said.procedures.find((s) => nameOverlap(p.name, s.name) || nameOverlap(s.name, p.name));
    if (!sp) {
      if (coverage(p.name, tapeWords) < COVERAGE_MIN) push({ kind: "in_record_not_said", field: "procedure", tier: "obvious", target: p.name, record_value: p.name, tape_t_ms: [], quote: null, support: "no support found", field_ai_filled: rec.ai.procedures, what: "A procedure in the record has no support on the tape" });
      continue;
    }
    const rs = parseSide(p.name) ?? parseSide(rec.exam), ss = parseSide(`${sp.side} ${sp.name}`); // R7: the examination text is read for a side too
    if (rs && ss && rs !== "both" && ss !== "both" && rs !== ss) push({ kind: "value_mismatch", field: "laterality", tier: "obvious", target: p.name, record_value: p.name, tape_t_ms: [sp.t_ms], quote: sp.quote, support: "tape support", field_ai_filled: rec.ai.procedures, what: `The side in the record (${rs}) differs from the side on the tape (${ss})` });
  }
  for (const s of said.procedures) {
    if (!rec.procedures.some((p) => nameOverlap(p.name, s.name) || nameOverlap(s.name, p.name)))
      push({ kind: "said_not_in_record", field: "procedure", tier: "minor", target: s.name, record_value: null, tape_t_ms: [s.t_ms], quote: s.quote, support: "tape support", field_ai_filled: rec.ai.procedures, what: "A procedure said on the tape is not in the record" });
  }

  // diagnoses
  for (const d of rec.diagnoses) {
    const sd = said.diagnoses.find((s) => nameOverlap(d.name, s.name) || nameOverlap(s.name, d.name));
    if (!sd) {
      if (coverage(d.name, tapeWords) < COVERAGE_MIN) push({ kind: "in_record_not_said", field: "diagnosis", tier: d.differential ? "minor" : "obvious", target: d.name, record_value: d.name, tape_t_ms: [], quote: null, support: "no support found", field_ai_filled: rec.ai.diagnoses, what: d.differential ? "A differential diagnosis in the record has no support on the tape" : "A diagnosis in the record has no support on the tape" });
      continue;
    }
    const rs = parseSide(`${d.name} ${d.location_notes}`) ?? parseSide(rec.exam), ss = parseSide(`${sd.side} ${sd.name}`); // R7
    if (!d.differential && rs && ss && rs !== "both" && ss !== "both" && rs !== ss) push({ kind: "value_mismatch", field: "laterality", tier: "obvious", target: d.name, record_value: `${d.name} ${d.location_notes}`.trim(), tape_t_ms: [sd.t_ms], quote: sd.quote, support: "tape support", field_ai_filled: rec.ai.diagnoses, what: `The side in the record (${rs}) differs from the side on the tape (${ss})` });
  }

  // investigations (minor only)
  for (const i of rec.investigations) {
    if (!said.investigations.some((s) => nameOverlap(i, s.name) || nameOverlap(s.name, i)) && coverage(i, tapeWords) < COVERAGE_MIN)
      push({ kind: "in_record_not_said", field: "investigation", tier: "minor", target: i, record_value: i, tape_t_ms: [], quote: null, support: "no support found", field_ai_filled: rec.ai.investigations, what: "An investigation in the record has no support on the tape" });
  }
  for (const s of said.investigations) {
    if (!rec.investigations.some((i) => nameOverlap(i, s.name) || nameOverlap(s.name, i)))
      push({ kind: "said_not_in_record", field: "investigation", tier: "minor", target: s.name, record_value: null, tape_t_ms: [s.t_ms], quote: s.quote, support: "tape support", field_ai_filled: rec.ai.investigations, what: "An investigation said on the tape is not in the record" });
  }
  // follow-up: a minor finding at most, in either direction
  const fuWords = content(rec.followup.replace(/\d[\w/-]*/g, " "));
  if (fuWords.length > 0 && !said.followup.some((s) => nameOverlap(rec.followup, s.text) || nameOverlap(s.text, rec.followup)) && coverage(rec.followup.replace(/\d[\w/-]*/g, " "), tapeWords) < COVERAGE_MIN)
    push({ kind: "in_record_not_said", field: "followup", tier: "minor", target: rec.followup, record_value: rec.followup, tape_t_ms: [], quote: null, support: "no support found", field_ai_filled: "unknown", what: "A follow-up in the record has no support on the tape" });
  if (rec.followup.trim() === "") for (const s of said.followup) push({ kind: "said_not_in_record", field: "followup", tier: "minor", target: s.text, record_value: null, tape_t_ms: [s.t_ms], quote: s.quote, support: "tape support", field_ai_filled: "unknown", what: "A follow-up said on the tape is not in the record" });
  return out;
}

export const overallTier = (fs: Finding[]): Tier => fs.reduce<Tier>((t, f) => maxTier(t, f.tier), "none");
