/**
 * src/lib/finding-labels.ts — plain-language copy for the doctor-facing finding card.
 *
 * PURE and client-safe: no env, no I/O. Everything a doctor reads that is not the clinical text
 * itself (titles, note-type names, the ask, the response in words, error sentences) is decided here
 * so the wording lives in one place and is table-tested.
 *
 * ⚠️ NOTHING HERE PRINTS A CODE. An unknown finding type, note class, verb or error falls back to a
 * generic sentence. A raw enum on a physician's screen reads as an engine talking to itself.
 */

/** The one-line advisory under the Findings list. Static: never taken from upstream. */
export const ADVISORY_FOOTER =
  "These are documentation and prescribing observations reviewed by the quality team. They are not a performance score.";

/** Shown when the signed-in physician has no linked profile yet. */
export const UNLINKED_TEXT =
  "Your findings will appear here once your profile is linked by the quality team.";

export const GENERIC_FINDING_TITLE = "Documentation finding";

/** Finding-type code → plain clinical title. Only types seen in the audit vocabulary are listed;
 *  anything else falls through to {@link findingTitle}'s fallback. */
export const FINDING_TYPE_TITLES: Readonly<Record<string, string>> = {
  dose_ceiling_exceeded: "Dose above the usual maximum",
  dose_ceiling_sos: "As-needed dose above the usual maximum",
  banned_fdc: "Combination medicine that is not permitted",
  drug_interaction: "Possible drug interaction",
  incomplete_dosing: "Incomplete dosing instructions",
  low_value_care: "Test or treatment of limited value",
  metadata_accuracy: "Record details to double-check",
  coding_completeness: "Diagnosis coding to complete",
  pretest_niche: "Test indication to confirm",
  screening_context: "Screening context to confirm",
  incomplete_assessment: "Incomplete assessment",
  documentation: "Documentation gap",
};

/** Words that mark text as pipeline vocabulary rather than something to show a physician. */
const INTERNAL_UPPER_RE = /\b(?:CDMSS|CAT|RMOs?)\b/;
const INTERNAL_LOWER_RE =
  /\b(?:triage\w*|engine|jev|chatbot|bot|governance|policy[ _-]?version|care manager)\b/i;

/** True when a string contains wording that must never reach a physician. */
export function hasInternalWording(text: string): boolean {
  return INTERNAL_UPPER_RE.test(text) || INTERNAL_LOWER_RE.test(text);
}

/** A label that reads as a person wrote it: has no underscore or code shape and no internal words. */
function looksHuman(label: string): boolean {
  const t = label.trim();
  if (t.length < 3 || t.length > 90) return false;
  if (/[_:]/.test(t)) return false;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(t)) return false;
  if (/\d{4,}/.test(t)) return false;
  if (hasInternalWording(t)) return false;
  return /^[A-Za-z]/.test(t);
}

/**
 * PURE. The card title. A known type wins; otherwise the upstream label if it already reads as plain
 * words; otherwise the generic title. The code itself is never printed.
 */
export function findingTitle(signalType: unknown, label: unknown): string {
  const code = typeof signalType === "string" ? signalType.trim().toLowerCase() : "";
  if (code && Object.prototype.hasOwnProperty.call(FINDING_TYPE_TITLES, code)) {
    return FINDING_TYPE_TITLES[code];
  }
  if (typeof label === "string" && looksHuman(label)) return label.trim();
  return GENERIC_FINDING_TITLE;
}

export type CardNoteClass = "opd" | "discharge" | "ot";

/** PURE. Any spelling upstream or local rows use → the three classes the card knows, else null. */
export function cardNoteClass(raw: unknown): CardNoteClass | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "opd" || v === "opd_note") return "opd";
  if (v === "discharge" || v === "discharge_summary" || v === "ds") return "discharge";
  if (v === "ot" || v === "ot_note") return "ot";
  return null;
}

export function noteTypeLabel(nc: CardNoteClass | null): string | null {
  if (nc === "opd") return "OPD note";
  if (nc === "discharge") return "Discharge summary";
  if (nc === "ot") return "OT note";
  return null;
}

/** Document-audit doc types (progress / ot / discharge) → a note-type label. */
export function docTypeNoteLabel(docType: unknown): string | null {
  if (docType === "progress") return "Progress note";
  const nc = cardNoteClass(docType);
  return noteTypeLabel(nc);
}

export type CardAsk = "acknowledge" | "explain";

/** PURE. `response_required` → what we ask of the doctor. "none", unknown and missing → no ask. */
export function askOf(responseRequired: unknown): CardAsk | null {
  if (responseRequired === "acknowledgment") return "acknowledge";
  if (responseRequired === "explanation") return "explain";
  return null;
}

export function askText(ask: CardAsk | null): string | null {
  if (ask === "acknowledge") return "Please acknowledge";
  if (ask === "explain") return "Please explain or confirm";
  return null;
}

export type CardVerb = "agree" | "disagree" | "needs_clarification" | "other";

/** PURE. A verb or legacy verdict string → one of the three response verbs, or "other". */
export function cardVerb(raw: unknown): CardVerb {
  if (typeof raw !== "string") return "other";
  const v = raw.trim().toLowerCase();
  if (["agree", "agreed", "acknowledged", "acknowledge", "confirmed", "confirm", "accepted"].includes(v)) {
    return "agree";
  }
  if (["disagree", "disagreed", "disputed", "dispute", "contested", "rejected"].includes(v)) {
    return "disagree";
  }
  if (["needs_clarification", "clarification", "clarify", "needs clarification"].includes(v)) {
    return "needs_clarification";
  }
  return "other";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Day, month and year as written, from a date-only string or a timestamp read in IST. */
function dateParts(iso: unknown): { d: number; m: number; y: number } | null {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const s = iso.trim();
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return { y: Number(dateOnly[1]), m: Number(dateOnly[2]) - 1, d: Number(dateOnly[3]) };
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  // IST has no DST: a fixed +05:30 shift gives the doctor's calendar day deterministically.
  const ist = new Date(t + 5.5 * 3600 * 1000);
  return { y: ist.getUTCFullYear(), m: ist.getUTCMonth(), d: ist.getUTCDate() };
}

/** "3 Oct". Empty string when the input is not a date. */
export function fmtShortDate(iso: unknown): string {
  const p = dateParts(iso);
  return p && p.m >= 0 && p.m < 12 ? `${p.d} ${MONTHS[p.m]}` : "";
}

/** "3 Oct 2026". Empty string when the input is not a date. */
export function fmtLongDate(iso: unknown): string {
  const p = dateParts(iso);
  return p && p.m >= 0 && p.m < 12 ? `${p.d} ${MONTHS[p.m]} ${p.y}` : "";
}

export interface CardResponseLike {
  verb: CardVerb;
  comment: string | null;
  at: string | null;
}

/**
 * PURE. The doctor's recorded response in words.
 *   agree, no comment    → "You acknowledged on 3 Oct"   ("You confirmed" when the ask was an explanation)
 *   disagree + comment   → "You disagreed: <comment> (3 Oct)"
 */
export function responseInWords(r: CardResponseLike, ask: CardAsk | null = null): string {
  const past =
    r.verb === "agree"
      ? ask === "explain"
        ? "confirmed"
        : "acknowledged"
      : r.verb === "disagree"
        ? "disagreed"
        : r.verb === "needs_clarification"
          ? "asked for clarification"
          : "responded";
  const date = fmtShortDate(r.at);
  if (r.comment) return `You ${past}: ${r.comment}${date ? ` (${date})` : ""}`;
  return `You ${past}${date ? ` on ${date}` : ""}`;
}

/** The three private reactions and their labels (order is fixed). */
export const REACTION_LABELS: Readonly<Record<string, string>> = {
  already_knew: "I already knew this",
  surprised: "This surprised me",
  dismiss: "Dismiss",
};

/**
 * PURE. A machine error code from a portal route → a sentence a doctor can act on. Unknown codes get
 * the generic sentence; the code is never shown.
 */
export function friendlyError(code: unknown): string {
  switch (code) {
    case "disabled":
      return "This is not available right now.";
    case "already_recorded":
      return "You have already recorded a reaction for this finding.";
    case "already_responded":
      return "You have already responded to this finding.";
    case "closed":
      return "This finding is now closed, so no response is needed.";
    case "on_live_list":
      return "This finding is on your main Findings list. Please respond to it there.";
    case "invalid":
    case "invalid_body":
    case "invalid_json":
      return "Please check what you entered and try again.";
    case "unmapped":
      return UNLINKED_TEXT;
    case "not_found":
      return "We could not find that finding. Please refresh the page.";
    case "Unauthorized":
      return "Please sign in again.";
    case "unavailable":
    case "upstream_unavailable":
    case "db_error":
      return "That could not be saved just now. Please try again in a moment.";
    default:
      return "Something went wrong. Please try again.";
  }
}
