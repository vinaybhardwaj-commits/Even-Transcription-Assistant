/**
 * Patient Feedback home (Sprint 1.1) — pure shaping for the grouped view.
 * Summaries stay an empty state. This module does not call a model.
 */

export const SUMMARY_STATE_NONE = "none" as const;
export const HEADLINE_SUMMARY_LABEL = "None yet";
export const ROW_SUMMARY_LABEL = "No summary yet";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type PolarityFilter = "all" | "positive" | "negative";
export type StatusFilter = "all" | "open" | "closed" | "retracted";

export const CATEGORY_LABEL: Record<string, string> = {
  clinical: "Clinical",
  patient_safety: "Patient safety",
  medical_error: "Medical error",
  professionalism: "Professionalism",
  documentation: "Documentation",
  etiquette: "Etiquette",
  vendor_compliance: "Vendor compliance",
  other: "Other",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface FeedbackPhysicianRow {
  physician_id: string;
  name: string;
  specialty: string;
  positive: number;
  negative: number;
  total: number;
  last_activity: string | null;
  severity_counts: SeverityCounts;
  summary_label: typeof ROW_SUMMARY_LABEL;
}

export interface NeedsAttentionItem {
  id: string;
  physician_id: string;
  physician_name: string;
  specialty: string;
  severity: string;
  category: string | null;
  submitted_at: string;
}

export interface FeedbackFeedItem {
  id: string;
  target_physician_id: string;
  target_physician_name: string;
  specialty: string;
  submitted_at: string;
  anonymous_flag: boolean;
  submitter_label: string;
  hospital_code: string | null;
  category: string | null;
  severity: string | null;
  polarity: string;
  source: string;
  commendation_category: string | null;
  patient_rating: number | null;
  narrative_preview: string;
  status: string;
  retracted_at: string | null;
  retraction_reason: string | null;
  reply_count: number;
}

export interface FeedbackHeadline {
  total: number;
  negative: number;
  positive: number;
  physicians_with_feedback: number;
  roster_size: number;
  summaries: typeof SUMMARY_STATE_NONE;
  summaries_label: typeof HEADLINE_SUMMARY_LABEL;
}

export interface FeedbackHomePayload {
  ok: true;
  headline: FeedbackHeadline;
  needs_attention: NeedsAttentionItem[];
  physicians: FeedbackPhysicianRow[];
  feed: FeedbackFeedItem[];
}

export function emptyHeadline(rosterSize = 0): FeedbackHeadline {
  return {
    total: 0,
    negative: 0,
    positive: 0,
    physicians_with_feedback: 0,
    roster_size: rosterSize,
    summaries: SUMMARY_STATE_NONE,
    summaries_label: HEADLINE_SUMMARY_LABEL,
  };
}

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return "—";
  return CATEGORY_LABEL[category] ?? category;
}

/** Staff-facing calendar date in India Standard Time, e.g. "3 Sep 2026". */
export function formatFeedbackDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "day")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const year = parts.find((p) => p.type === "year")?.value;
  if (!day || !month || !year) return "—";
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) return "—";
  return `${Number(day)} ${monthName} ${year}`;
}

export function matchesDoctorQuery(name: string, specialty: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q) || specialty.toLowerCase().includes(q);
}

export function filterPhysicianRows(
  rows: FeedbackPhysicianRow[],
  opts: { query: string; polarity: PolarityFilter; severity: "" | Severity },
): FeedbackPhysicianRow[] {
  return rows.filter((row) => {
    if (!matchesDoctorQuery(row.name, row.specialty, opts.query)) return false;
    if (opts.polarity === "positive" && row.positive <= 0) return false;
    if (opts.polarity === "negative" && row.negative <= 0) return false;
    if (opts.severity && (row.severity_counts[opts.severity] ?? 0) <= 0) return false;
    return true;
  });
}

export function filterFeedItems(
  rows: FeedbackFeedItem[],
  opts: { query: string; polarity: PolarityFilter; severity: "" | Severity; status: StatusFilter },
): FeedbackFeedItem[] {
  return rows.filter((row) => {
    if (!matchesDoctorQuery(row.target_physician_name, row.specialty, opts.query)) return false;
    if (opts.polarity !== "all" && row.polarity !== opts.polarity) return false;
    if (opts.severity && row.severity !== opts.severity) return false;
    if (opts.status !== "all" && row.status !== opts.status) return false;
    return true;
  });
}

export function lookupCandidates<T extends { name: string; specialty: string }>(
  rows: T[],
  query: string,
): T[] {
  return rows.filter((row) => matchesDoctorQuery(row.name, row.specialty, query));
}
