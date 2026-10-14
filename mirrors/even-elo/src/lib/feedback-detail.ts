/**
 * Physician feedback detail (Sprint 1.2 + Sprint 3.2 summary aside).
 * Summary generation lives under /api/incidents/physician/[id]/summary.
 */

import { categoryLabel } from "./feedback-home";

export const SUMMARY_PANEL_TITLE = "Summary";
export const SUMMARY_PANEL_SUBTITLE = "Pattern · RCA · CAPA";
export const NO_FEEDBACK_COPY = "No feedback on file for this physician.";

export interface FeedbackTimelineItem {
  id: string;
  submitted_at: string;
  polarity: string;
  category: string | null;
  commendation_category: string | null;
  severity: string | null;
  status: string;
  source: string;
}

export interface FeedbackDetailPhysician {
  id: string;
  name: string;
  specialty: string;
  hospital_codes: string[];
}

export interface FeedbackDetailHeadline {
  total: number;
  negative: number;
  positive: number;
  last_activity: string | null;
  negative_hint: string;
  positive_hint: string;
}

export interface FeedbackDetailPayload {
  ok: true;
  physician: FeedbackDetailPhysician;
  headline: FeedbackDetailHeadline;
  timeline: FeedbackTimelineItem[];
}

type HintRow = {
  polarity: string;
  status: string;
  severity: string | null;
  source: string;
};

export function timelineCategory(item: Pick<FeedbackTimelineItem, "polarity" | "category" | "commendation_category">): string {
  if (item.polarity === "positive" && item.commendation_category) return item.commendation_category;
  return categoryLabel(item.category);
}

export function negativeActivityHint(rows: HintRow[]): string {
  const neg = rows.filter((row) => row.polarity === "negative" && row.status !== "retracted");
  if (neg.length === 0) return "None";
  const allOpen = neg.every((row) => row.status === "open");
  const severities = new Set(neg.map((row) => row.severity).filter((value): value is string => !!value));
  if (allOpen && severities.size === 1) return `All open · severity ${Array.from(severities)[0]}`;
  return "Open + closed";
}

export function positiveSourceHint(rows: HintRow[]): string {
  const pos = rows.filter((row) => row.polarity === "positive" && row.status !== "retracted");
  if (pos.length === 0) return "None";
  const sources = new Set(pos.map((row) => row.source));
  if (sources.size === 1 && sources.has("patient")) return "Patient source";
  return "All sources";
}

export function shortPhysicianId(id: string): string {
  const compact = id.replace(/-/g, "");
  if (compact.length < 12) return id;
  return `${id.slice(0, 8)}…`;
}
