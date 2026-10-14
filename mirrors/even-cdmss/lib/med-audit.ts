// Medication Chart Audit — shared model (EHRC Clinical Pharmacist surface).
// Source of truth for the 35 audit parameters, NCC MERP severity, drug
// categories, and the payload shapes exchanged between the /audit client and
// the /api/audit routes. Pure data + types — safe to import on client or server.

export type Actor = 'doctor' | 'doctor_nurse' | 'pharmacist' | 'nurse';

export interface ParamDef { no: number; label: string }
export interface ParamGroup { actor: Actor; title: string; items: ParamDef[] }

// The 35 parameters, grouped by responsible actor — verbatim from the
// EHRC "Medication chart review checklist".
export const PARAM_GROUPS: ParamGroup[] = [
  {
    actor: 'doctor', title: 'DOCTOR ERRORS', items: [
      { no: 1, label: 'Incorrect drug selection' },
      { no: 2, label: 'Wrong dose' },
      { no: 3, label: 'Wrong unit of measurement' },
      { no: 4, label: 'Wrong frequency' },
      { no: 5, label: 'Wrong route' },
      { no: 6, label: 'Wrong concentration' },
      { no: 7, label: 'Wrong rate of administration' },
      { no: 8, label: 'Illegible handwriting' },
      { no: 9, label: 'Non-approved abbreviations used' },
      { no: 10, label: 'Non-usage of capital letters for drug names' },
      { no: 11, label: 'Non-usage of generic names' },
      { no: 12, label: 'Non-modification of drug dose for drug–drug interactions' },
      { no: 13, label: 'Non-modification of administration time for food–drug interactions' },
    ],
  },
  {
    actor: 'doctor_nurse', title: 'DOCTOR AND/OR NURSE ERRORS', items: [
      { no: 14, label: 'Wrong formulation transcribed/indented' },
      { no: 15, label: 'Wrong drug transcribed/indented' },
      { no: 16, label: 'Wrong strength transcribed/indented' },
    ],
  },
  {
    actor: 'pharmacist', title: 'PHARMACIST ERRORS', items: [
      { no: 17, label: 'Wrong drug dispensed' },
      { no: 18, label: 'Wrong dose dispensed' },
      { no: 19, label: 'Wrong formulation dispensed' },
      { no: 20, label: 'Expired/Near-expiry drugs dispensed' },
      { no: 21, label: 'Wrong labelling' },
      { no: 22, label: 'Delay in dispense beyond defined time' },
      { no: 23, label: 'Generic/class substitute without doctor consultation' },
    ],
  },
  {
    actor: 'nurse', title: 'NURSE ERRORS', items: [
      { no: 24, label: 'Wrong patient' },
      { no: 25, label: 'Dose omission' },
      { no: 26, label: 'Improper dose' },
      { no: 27, label: 'Wrong drug' },
      { no: 28, label: 'Wrong formulation administered' },
      { no: 29, label: 'Wrong route of administration' },
      { no: 30, label: 'Wrong rate' },
      { no: 31, label: 'Wrong duration' },
      { no: 32, label: 'Wrong time' },
      { no: 33, label: 'No documentation of drug administration' },
      { no: 34, label: 'Incomplete/improper documentation by nursing staff' },
      { no: 35, label: 'Documentation without administration' },
    ],
  },
];

export const ALL_PARAMS: ParamDef[] = PARAM_GROUPS.flatMap((g) => g.items);

export function actorOf(no: number): Actor {
  if (no <= 13) return 'doctor';
  if (no <= 16) return 'doctor_nurse';
  if (no <= 23) return 'pharmacist';
  return 'nurse';
}

// NCC MERP medication-error harm index (A–I). Confirmed with V (15 Jun 2026).
export const NCC_MERP: { code: string; label: string }[] = [
  { code: 'A', label: 'Circumstances capable of causing error' },
  { code: 'B', label: 'Error occurred, did not reach patient' },
  { code: 'C', label: 'Reached patient, no harm' },
  { code: 'D', label: 'Reached patient, needed monitoring' },
  { code: 'E', label: 'Temporary harm, needed intervention' },
  { code: 'F', label: 'Temporary harm, needed hospitalisation' },
  { code: 'G', label: 'Permanent harm' },
  { code: 'H', label: 'Intervention to sustain life' },
  { code: 'I', label: 'Contributed to death' },
];
export const SEV_CODES = NCC_MERP.map((s) => s.code);

// UI drug categories. Antibiotic line/prophylaxis/restricted all draw from the
// `antibiotic` formulary bucket; `restrictedOnly` filters to reserve agents.
export interface AuditCategory { label: string; bucket: string; restrictedOnly?: boolean }
export const AUDIT_CATEGORIES: AuditCategory[] = [
  { label: 'Prophylactic Antibiotic', bucket: 'antibiotic' },
  { label: 'GI Prophylaxis', bucket: 'gi' },
  { label: 'Antibiotic — 1st line', bucket: 'antibiotic' },
  { label: 'Antibiotic — 2nd line', bucket: 'antibiotic' },
  { label: 'Antibiotic — 3rd line', bucket: 'antibiotic' },
  { label: 'Restricted Antibiotic', bucket: 'antibiotic', restrictedOnly: true },
  { label: 'Pain', bucket: 'pain' },
  { label: 'DVT Prophylaxis', bucket: 'dvt' },
  { label: 'Anaesthetic Agent', bucket: 'anaesthetic' },
  { label: 'Other / search all', bucket: 'other' },
];

// ---- payload shapes (client <-> /api/audit) ----
export interface FindingInput {
  param: number;
  status: 'error' | 'na';
  ncc_merp: string | null; // A–I when status==='error'
  note: string;
}
export interface AuditDrugInput {
  name: string;
  category: string;
  dose: string;
  frequency: string;
  route: string;
  reserve: boolean;
  high_alert: boolean;
  formulary_id?: number | null;
  findings: FindingInput[];
}
export interface AuditPayload {
  meta: {
    auditor: string; audit_date: string; location: string;
    uhid: string; admission_date: string; consultant: string;
  };
  allergies_documented: 'yes' | 'no' | null;
  known_allergies: string[];
  drugs: AuditDrugInput[];
}

export interface FormularyOption {
  n: string; d: string; restricted: boolean; highRisk: boolean;
  lasa: string; ved: string; sch: string; bucket: string;
}
