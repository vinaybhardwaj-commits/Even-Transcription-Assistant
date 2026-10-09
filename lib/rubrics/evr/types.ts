/**
 * lib/rubrics/evr/types.ts — S7-2: encounter_vs_record. The normalised shapes shared by the record reader, the said-items extractor, the comparison and the perturbation bench.
 * The rubric reports DISCREPANCIES between what was said in an encounter and the signed record. It states no verdict on a person. Times are ms from the consult's open.
 */
export type AiFilled = true | false | "unknown";
export type Tier = "none" | "minor" | "material" | "obvious";
export const TIER_ORDER: readonly Tier[] = ["none", "minor", "material", "obvious"];
export const maxTier = (a: Tier, b: Tier): Tier => (TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b);

export type RecMed = { name: string; alt_name: string; dose: string; freq: string; route: string; duration: string; side: string };
export type RecDiagnosis = { name: string; differential: boolean; location_notes: string };
export type RecProcedure = { name: string };
export type NormRecord = {
  complaints: string[];
  exam: string;
  diagnoses: RecDiagnosis[];
  meds: RecMed[];
  investigations: string[];
  procedures: RecProcedure[];
  advice: string;
  followup: string;
  refer_to: string[];
  /** per field: was it filled by the AI note-taker (from the record's own ai_field_metadata)? */
  ai: { exam: AiFilled; complaints: AiFilled; diagnoses: AiFilled; procedures: AiFilled; meds: AiFilled; investigations: AiFilled };
};

export type SaidBase = { t_ms: number; quote: string };
export type SaidItems = {
  complaints: Array<{ text: string } & SaidBase>;
  diagnoses: Array<{ name: string; side: string } & SaidBase>;
  meds: Array<{ name: string; dose: string; freq: string; route: string; duration: string; side: string } & SaidBase>;
  investigations: Array<{ name: string } & SaidBase>;
  procedures: Array<{ name: string; side: string } & SaidBase>;
  followup: Array<{ text: string } & SaidBase>;
};

export type FindingKind = "in_record_not_said" | "said_not_in_record" | "value_mismatch";
export type FindingField = "drug" | "procedure" | "diagnosis" | "investigation" | "followup" | "dose" | "frequency" | "laterality";
export type Finding = {
  kind: FindingKind;
  field: FindingField;
  tier: Tier;
  /** the record item the finding is about (or the said item, for said_not_in_record) */
  target: string;
  record_value: string | null;
  tape_t_ms: number[];
  quote: string | null;
  /** "no support found" when nothing on the tape backs a record item */
  support: "no support found" | "tape support";
  field_ai_filled: AiFilled;
  text: string;
};
export const findingCode = (f: Finding): string => `${f.tier}:${f.kind}:${f.field}`;
