import { formatFeedbackDate } from "../feedback-home";

export type ServerSummaryState = "flag_off" | "empty" | "ready" | "stale" | "no_feedback";

export type SummaryUiState = ServerSummaryState | "generating" | "error";

export type SummaryChipLabel = "Off" | "None yet" | "Generating" | "Ready" | "Stale" | "Error";

export interface StoredSummary {
  generated_at: string;
  feedback_count_at_gen: number;
}

export interface StaleDetail {
  newer: boolean;
  count_increased: boolean;
}

export function isVertexSummariesFlagOn(value: string | undefined): boolean {
  return (value ?? "").trim() === "true";
}

export function summaryChipLabel(state: SummaryUiState): SummaryChipLabel {
  switch (state) {
    case "flag_off":
      return "Off";
    case "empty":
    case "no_feedback":
      return "None yet";
    case "generating":
      return "Generating";
    case "ready":
      return "Ready";
    case "stale":
      return "Stale";
    case "error":
      return "Error";
  }
}

export function summaryChipClass(state: SummaryUiState): string {
  switch (state) {
    case "flag_off":
      return "bg-stone-100 text-stone-400";
    case "empty":
    case "no_feedback":
      return "bg-stone-100 text-stone-500";
    case "generating":
      return "bg-blue-50 text-blue-700";
    case "ready":
      return "bg-emerald-50 text-emerald-700";
    case "stale":
      return "bg-amber-50 text-amber-800 ring-1 ring-amber-200";
    case "error":
      return "bg-red-50 text-red-800";
  }
}

/** "12 Sep 2026, 16:40 IST" */
export function formatSummaryGeneratedIst(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = formatFeedbackDate(iso);
  if (date === "—") return "—";
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Kolkata",
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === "hour")?.value;
  const minute = parts.find((p) => p.type === "minute")?.value;
  if (!hour || !minute) return date;
  return `${date}, ${hour}:${minute} IST`;
}

/**
 * Stale when a non-retracted row is strictly newer than generated_at,
 * or the live non-retracted count is higher than the count stored at generation.
 */
export function staleDetail(input: {
  generatedAt: string;
  countAtGen: number;
  liveCount: number;
  newestFeedbackAt: string | null;
}): StaleDetail {
  const generatedMs = Date.parse(input.generatedAt);
  const newestMs = input.newestFeedbackAt ? Date.parse(input.newestFeedbackAt) : Number.NaN;
  const newer = !Number.isNaN(generatedMs) && !Number.isNaN(newestMs) && newestMs > generatedMs;
  const count_increased = input.liveCount > input.countAtGen;
  return { newer, count_increased };
}

export function deriveSummaryState(input: {
  featureEnabled: boolean;
  liveCount: number;
  summary: StoredSummary | null;
  newestFeedbackAt: string | null;
}): { state: ServerSummaryState; stale: StaleDetail | null } {
  if (!input.featureEnabled) return { state: "flag_off", stale: null };
  if (input.liveCount <= 0) return { state: "no_feedback", stale: null };
  if (!input.summary) return { state: "empty", stale: null };
  const stale = staleDetail({
    generatedAt: input.summary.generated_at,
    countAtGen: input.summary.feedback_count_at_gen,
    liveCount: input.liveCount,
    newestFeedbackAt: input.newestFeedbackAt,
  });
  if (stale.newer || stale.count_increased) return { state: "stale", stale };
  return { state: "ready", stale: null };
}
