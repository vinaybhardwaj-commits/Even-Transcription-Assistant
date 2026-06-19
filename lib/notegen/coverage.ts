/**
 * Deterministic NABH coverage (R2). No LLM, runs client-side on every keystroke.
 * For each mandatory CLINICAL floor field, decide whether the doctor's text covers it
 * by matching curated keywords/abbreviations (word-boundary) or label tokens.
 *
 * Identifier / sign-off fields are excluded — those come from the patient/encounter
 * context (EvenScribe) at port, not from the free-text body. Conditional sub-fields are
 * not counted in the coverage denominator.
 */

export interface FloorField {
  field_key: string;
  label: string;
  section: string;
  mandatory: boolean;
  conditional_on?: string | null;
}

export interface CoverageItem {
  field_key: string;
  label: string;
  section: string;
  covered: boolean;
}

export interface Coverage {
  total: number;
  covered: number;
  items: CoverageItem[];
}

const EXCLUDE_SECTIONS = new Set(["identifiers", "signoff"]);

const KW: Record<string, string[]> = {
  // ---- OT / operative note ----
  primary_surgeon: ["surgeon", "operated by", "operating surgeon"],
  anaesthetist: ["anaesthetist", "anesthetist", "anaesthesiologist", "anesthesiologist"],
  preop_diagnosis: ["diagnosis", "dx", "hernia", "carcinoma", "appendic", "cholecyst", "gallbladder", "fracture", "preop", "pre-op"],
  procedure_performed: ["repair", "excision", "resection", "performed", "procedure", "laparoscop", "tep", "tapp", "cholecystectomy", "appendectomy", "herniorrhaph", "open"],
  anaesthesia_type: ["anaesthesia", "anesthesia", "general anaesth", "general anesth", "ga", "spinal", "epidural", "local", "sedation", "regional"],
  antibiotic_prophylaxis: ["antibiotic", "abx", "prophylax", "cefazolin", "cefuroxime", "ceftriaxone", "augmentin", "metronidazole"],
  consent_ref: ["consent"],
  ssc_signin: ["sign-in", "sign in", "who checklist", "surgical safety", "ssc", "checklist"],
  ssc_timeout: ["time-out", "time out", "who checklist", "surgical safety", "ssc", "checklist"],
  ssc_signout: ["sign-out", "sign out", "who checklist", "surgical safety", "ssc", "checklist"],
  operative_findings: ["finding", "identified", "noted", "sac", "intra-op", "intraop", "reduced", "adhes", "appearance"],
  operative_steps: ["incision", "dissect", "port", "mesh", "tack", "sutur", "closed", "ligat", "mobil", "anastomos", "desufflat"],
  implant_used: ["mesh", "implant", "prosthes", "graft", "plate", "screw", "stent"],
  specimen_sent: ["specimen", "hpe", "histopath", "biopsy", "sent for"],
  blood_loss_ml: ["blood loss", "ebl", "blood-loss"],
  blood_products: ["transfus", "prbc", "blood product", "packed cell", "no transfusion"],
  counts_correct: ["count", "sponge", "needle", "instrument count"],
  complications: ["complication", "uneventful", "no complication", "nil complication"],
  conversion_to_open: ["conversion", "converted", "no conversion"],
  postop_plan: ["plan", "post-op", "postop", "post operative", "monitor", "recovery", "analges"],
  postop_advice: ["advice", "ambulat", "lifting", "diet", "wound care", "follow up", "follow-up"],
  urgent_care_instructions: ["urgent", "return if", "seek", "red flag", "emergenc", "worsen"],
  // ---- discharge summary ----
  reason_admission: ["admitted", "admission", "presented", "complain", "reason"],
  significant_findings: ["finding", "examination", "investigation", "on exam"],
  diagnosis: ["diagnosis", "dx"],
  condition_at_discharge: ["condition", "stable", "improved", "discharge", "afebrile"],
  investigations: ["investigation", "lab", "cbc", "ct", "mri", "x-ray", "ultrasound", "usg", "report", "blood"],
  procedures_performed: ["procedure", "surgery", "performed", "operation"],
  medications_administered: ["medication", "drug", "inj", "administered", "iv ", "antibiotic"],
  treatment_given: ["treatment", "managed", "therapy", "given"],
  followup_advice: ["follow up", "follow-up", "review", "opd", "revisit"],
  discharge_medication: ["tab", "cap", "syrup", "mg", "prescrib", "rx", "continue"],
  patient_instructions: ["instruction", "advice", "avoid", "diet", "rest"],
  // ---- OPD prescription ----
  known_allergies: ["allerg", "nkda", "no known"],
  diagnosis_rx: ["diagnosis", "dx"],
  drugs: ["tab", "cap", "mg", "ml", "od", "bd", "tds", "syrup", "rx", "ointment"],
};

const STOP = new Set(["with", "done", "type", "name", "date", "time", "number", "patient", "details", "field", "note", "and", "the", "for", "obtained", "reference"]);

function labelTokens(label: string): string[] {
  return (label.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((t) => !STOP.has(t));
}

function matches(kw: string, lower: string): boolean {
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Short abbreviations need an exact word match (avoid "ga"→"gastric"); longer keywords
  // allow a trailing suffix so "count"→"counts", "complication"→"complications", "finding"→"findings".
  const re = kw.length <= 3 ? new RegExp("\\b" + esc + "\\b", "i") : new RegExp("\\b" + esc, "i");
  return re.test(lower);
}

export function computeCoverage(floor: FloorField[], text: string): Coverage {
  const lower = (text || "").toLowerCase();
  const items: CoverageItem[] = [];
  for (const f of floor) {
    if (!f.mandatory) continue;
    if (EXCLUDE_SECTIONS.has(f.section)) continue;
    if (f.conditional_on) continue;
    const kws = KW[f.field_key] ?? labelTokens(f.label);
    const covered = kws.length > 0 && kws.some((kw) => matches(kw, lower));
    items.push({ field_key: f.field_key, label: f.label, section: f.section, covered });
  }
  const covered = items.filter((i) => i.covered).length;
  return { total: items.length, covered, items };
}
