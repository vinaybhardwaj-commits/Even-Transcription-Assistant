/**
 * OT Tracking Sheet vision prompts — version ot-tracking-sheet-v1.
 * Classifier first, then extract. Both demand one JSON object.
 * No sample patient names: those bias the model and do not belong in git.
 */

export const OT_TRACKING_SHEET_PROMPT_VERSION = "ot-tracking-sheet-v1" as const;

export const CLASSIFY_SYSTEM = [
  "You classify one photographed hospital document for Even Governance.",
  "Reply with a single JSON object and nothing else. No markdown, no prose.",
  "Schema:",
  '{"doc_type":"ot_tracking_sheet"|"unknown","confidence":0.0,"signals":["short visual cue"]}',
  "Use doc_type ot_tracking_sheet only when the page is an operating-theatre tracking sheet:",
  "it has theatre/OT identifiers and some of UHID or IP number, surgery, surgeon, antibiotic, and clock times",
  "(wheel-in, sign-in, induction, time-out, incision, closure, sign-out, wheel-out).",
  "Everything else is unknown, including consent forms, discharge notes, ID cards, and blank pages.",
  "confidence is a number from 0 to 1. signals are at most four short cues.",
  "Do not copy patient names, UHID values, or other identifiers into signals.",
].join("\n");

export const CLASSIFY_USER = "Classify the attached page.";

export const EXTRACT_SYSTEM = [
  "You extract one EHRC OT Tracking Sheet photograph into JSON for a human reviewer.",
  "Reply with a single JSON object and nothing else. No markdown, no prose.",
  "Use null for any field you cannot read. Do not guess, complete, or invent values.",
  "Copy handwriting as read. Do not translate clinical names.",
  "Times: HH:MM in 24-hour form when the clock is clear; otherwise the text you can actually read; otherwise null.",
  "surgery_date: YYYY-MM-DD when the date is clear; otherwise null.",
  "confidence is your overall confidence from 0 to 1, lower when handwriting is ambiguous.",
  "Schema:",
  "{",
  '  "confidence": 0.0,',
  '  "fields": {',
  '    "uhid": null,',
  '    "ip_no": null,',
  '    "patient_name": null,',
  '    "surgery_date": null,',
  '    "ot_no": null,',
  '    "anesthesia": null,',
  '    "surgery_name": null,',
  '    "surgeon_name": null,',
  '    "asst_surgeon": null,',
  '    "anesthetist": null,',
  '    "antibiotic": null,',
  '    "antibiotic_at": null,',
  '    "scrub_nurse": null,',
  '    "technician": null,',
  '    "circulating_nurse": null,',
  '    "scheduled_at": null,',
  '    "wheel_in": null,',
  '    "sign_in": null,',
  '    "induction": null,',
  '    "time_out": null,',
  '    "incision": null,',
  '    "closure": null,',
  '    "sign_out": null,',
  '    "wheel_out": null',
  "  },",
  '  "equipment_notes": null,',
  '  "notes": null',
  "}",
  "equipment_notes and notes are strings or null. Do not add keys.",
].join("\n");

export const EXTRACT_USER = "Extract the OT Tracking Sheet in the attached image.";

export function repairUser(kind: "classify" | "extract", previous: string): string {
  const schema = kind === "classify" ? "classifier schema (doc_type, confidence, signals)" : "extract schema (confidence, fields, equipment_notes, notes)";
  const clipped = previous.replace(/\s+/g, " ").trim().slice(0, 6000);
  return [
    "The previous reply was not valid JSON for the " + schema + ".",
    "Return only one JSON object. No markdown.",
    "Previous reply:",
    clipped || "(empty)",
  ].join("\n");
}
