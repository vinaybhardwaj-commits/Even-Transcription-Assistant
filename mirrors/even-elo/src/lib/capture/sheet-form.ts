/** Client-safe field list. No Node imports — the review page bundles this file. */

export const ABX_ON_TIME_LABEL = "Abx ≤60m pre-incision";
export const ABX_LATE_LABEL = "Abx late / unclear";
export const CASE_LINK_LABEL = "Surgical case · not linked (Stage 3)";

export interface SheetFormField {
  key:
    | "uhid"
    | "ip_no"
    | "patient_name"
    | "surgery_date"
    | "ot_no"
    | "anesthesia"
    | "surgery_name"
    | "surgeon_name"
    | "asst_surgeon"
    | "anesthetist"
    | "antibiotic"
    | "antibiotic_at"
    | "scrub_nurse"
    | "technician"
    | "circulating_nurse"
    | "scheduled_at"
    | "wheel_in"
    | "sign_in"
    | "induction"
    | "time_out"
    | "incision"
    | "closure"
    | "sign_out"
    | "wheel_out"
    | "equipment_notes"
    | "notes";
  label: string;
  full?: boolean;
  wide?: boolean;
}

/** Detail form order matches the ratified review mock, then the remaining clocks. */
export const SHEET_FORM_FIELDS: readonly SheetFormField[] = [
  { key: "patient_name", label: "Patient name" },
  { key: "uhid", label: "UHID" },
  { key: "ip_no", label: "IP / admit no." },
  { key: "surgery_date", label: "Surgery date" },
  { key: "ot_no", label: "OT number" },
  { key: "anesthesia", label: "Anesthesia" },
  { key: "surgery_name", label: "Surgery / procedure", full: true },
  { key: "surgeon_name", label: "Surgeon" },
  { key: "asst_surgeon", label: "Asst. surgeon" },
  { key: "anesthetist", label: "Anesthetist" },
  { key: "antibiotic", label: "Antibiotic" },
  { key: "antibiotic_at", label: "Antibiotic at" },
  { key: "incision", label: "Incision" },
  { key: "closure", label: "Closure" },
  { key: "wheel_in", label: "Wheel in" },
  { key: "wheel_out", label: "Wheel out" },
  { key: "scrub_nurse", label: "Scrub nurse" },
  { key: "circulating_nurse", label: "Circulating nurse" },
  { key: "technician", label: "Technician" },
  { key: "scheduled_at", label: "Scheduled" },
  { key: "sign_in", label: "Sign in" },
  { key: "induction", label: "Induction" },
  { key: "time_out", label: "Time out" },
  { key: "sign_out", label: "Sign out" },
  { key: "equipment_notes", label: "Equipment notes", full: true, wide: true },
  { key: "notes", label: "Notes", full: true, wide: true },
];
