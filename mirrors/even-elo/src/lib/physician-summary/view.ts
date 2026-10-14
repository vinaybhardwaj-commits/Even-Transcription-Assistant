import {
  summaryChipClass,
  summaryChipLabel,
  type ServerSummaryState,
  type StaleDetail,
  type SummaryChipLabel,
  type SummaryUiState,
} from "./state";
import { parseSummarySections, type SummarySection } from "./sections";

export interface SummaryRecord {
  body: string;
  generated_at: string;
  generated_ist: string;
  model_id: string;
  vertex_location: string;
  vertex_project: string | null;
  feedback_count_at_gen: number;
}

export interface SummaryServerPayload {
  ok: true;
  feature_enabled: boolean;
  state: ServerSummaryState;
  live_feedback_count: number;
  newest_feedback_at: string | null;
  stale_detail: StaleDetail | null;
  summary: SummaryRecord | null;
}

export type SummaryPhase = "idle" | "generating" | "error";

export interface SummaryAction {
  label: string;
  disabled: boolean;
  action: "generate" | "keep";
  variant: "primary" | "secondary" | "ghost";
}

export interface SummaryView {
  state: SummaryUiState;
  chip: SummaryChipLabel | "…";
  chipClass: string;
  hint: string;
  showSpinner: boolean;
  gatedTitle: string | null;
  gatedBody: string | null;
  gatedTone: "muted" | "brand" | null;
  showBody: boolean;
  body: string | null;
  /** Sprint 3.3 structured sections when the stored body has RCA/CAPA headings. */
  sections: SummarySection[] | null;
  showMeta: boolean;
  meta: {
    model: string;
    location: string;
    project: string | null;
    generatedIst: string;
    count: number;
  } | null;
  showStaleBanner: boolean;
  staleBannerTitle: string | null;
  staleBannerBody: string | null;
  showErrorBanner: boolean;
  errorTitle: string | null;
  errorBody: string | null;
  actions: SummaryAction[];
  footnote: string | null;
}

export const SUMMARY_ERROR_GENERIC = "Couldn't generate summary.";
export const SUMMARY_ERROR_UNCONFIGURED = "Summary generation is not configured in this environment.";
export const SUMMARY_ERROR_LOAD = "Couldn't load summary.";

const SAFE_ERRORS = new Set([
  SUMMARY_ERROR_GENERIC,
  SUMMARY_ERROR_UNCONFIGURED,
  SUMMARY_ERROR_LOAD,
]);

export function safeSummaryError(message: unknown): string {
  if (typeof message === "string" && SAFE_ERRORS.has(message)) return message;
  return SUMMARY_ERROR_GENERIC;
}

function metaFrom(record: SummaryRecord): SummaryView["meta"] {
  return {
    model: record.model_id,
    location: record.vertex_location,
    project: record.vertex_project,
    generatedIst: record.generated_ist,
    count: record.feedback_count_at_gen,
  };
}

export function staleBannerBody(input: {
  generatedIst: string;
  countAtGen: number;
  liveCount: number;
  newer: boolean;
  countIncreased: boolean;
}): string {
  const countBit = input.countIncreased
    ? `Feedback count ${input.countAtGen} → ${input.liveCount}.`
    : `Feedback count is still ${input.liveCount}.`;
  if (input.newer && input.countIncreased) {
    const delta = input.liveCount - input.countAtGen;
    const rows = delta === 1 ? "1 new row" : `${delta} new rows`;
    return `${rows} after ${input.generatedIst}. ${countBit} Regenerate to refresh.`;
  }
  if (input.newer) {
    return `New feedback after ${input.generatedIst}. ${countBit} Regenerate to refresh.`;
  }
  return `${countBit} Regenerate to refresh.`;
}

function base(state: SummaryUiState, hint: string): SummaryView {
  return {
    state,
    chip: summaryChipLabel(state),
    chipClass: summaryChipClass(state),
    hint,
    showSpinner: false,
    gatedTitle: null,
    gatedBody: null,
    gatedTone: null,
    showBody: false,
    body: null,
    sections: null,
    showMeta: false,
    meta: null,
    showStaleBanner: false,
    staleBannerTitle: null,
    staleBannerBody: null,
    showErrorBanner: false,
    errorTitle: null,
    errorBody: null,
    actions: [],
    footnote: null,
  };
}

export function resolveSummaryView(input: {
  server: SummaryServerPayload | null;
  phase: SummaryPhase;
  errorMessage?: string;
  loading?: boolean;
}): SummaryView {
  if (!input.server && input.loading) {
    const view = base("empty", "Loading summary");
    view.chip = "…";
    view.chipClass = "bg-stone-100 text-stone-400";
    view.showSpinner = true;
    view.gatedTitle = "Loading summary";
    view.gatedBody = "Checking whether a summary is stored.";
    view.gatedTone = "muted";
    return view;
  }

  const server = input.server;
  if (!server) {
    const view = base("error", "Generation failed");
    view.showErrorBanner = true;
    view.errorTitle = "Couldn't generate summary.";
    view.errorBody = "The summary could not be loaded. Try again.";
    view.gatedBody = "Previous stored summary (if any) remains unchanged on a failed regenerate.";
    view.gatedTone = "muted";
    view.actions = [
      { label: "Retry", disabled: false, action: "generate", variant: "primary" },
      { label: "Regenerate summary", disabled: false, action: "generate", variant: "secondary" },
    ];
    return view;
  }

  if (server.state === "flag_off" || server.feature_enabled !== true) {
    const view = base("flag_off", "FEATURE_VERTEX_SUMMARIES");
    view.gatedTitle = "Summary generation is off";
    view.gatedBody = 'Feature flag FEATURE_VERTEX_SUMMARIES is not exactly "true". Generate and regenerate stay off.';
    view.gatedTone = "muted";
    view.actions = [
      { label: "Regenerate summary", disabled: true, action: "generate", variant: "secondary" },
    ];
    view.footnote = "Available when summaries are enabled.";
    return view;
  }

  if (server.state === "no_feedback") {
    const view = base("no_feedback", "No feedback to summarise");
    view.gatedTitle = "Nothing to summarise";
    view.gatedBody = "This physician has no feedback rows. Generate stays disabled until at least one non-retracted feedback exists.";
    view.gatedTone = "muted";
    view.actions = [
      { label: "Generate summary", disabled: true, action: "generate", variant: "primary" },
    ];
    return view;
  }

  if (input.phase === "generating") {
    const view = base("generating", "Request in flight");
    view.showSpinner = true;
    view.actions = [
      { label: "Generate summary", disabled: true, action: "generate", variant: "primary" },
      { label: "Regenerate summary", disabled: true, action: "generate", variant: "secondary" },
    ];
    return view;
  }

  if (input.phase === "error") {
    const view = base("error", "Generation failed");
    view.showErrorBanner = true;
    view.errorTitle = "Couldn't generate summary.";
    view.errorBody = safeSummaryError(input.errorMessage) === SUMMARY_ERROR_LOAD
      ? "The summary could not be loaded. Try again."
      : "Temporary problem. No secrets or provider payloads are shown. A failed regenerate leaves any stored summary unchanged.";
    view.gatedTitle = null;
    view.gatedBody = "Previous stored summary (if any) remains unchanged on a failed regenerate.";
    view.gatedTone = "muted";
    view.actions = [
      { label: "Retry", disabled: false, action: "generate", variant: "primary" },
      { label: "Regenerate summary", disabled: false, action: "generate", variant: "secondary" },
    ];
    return view;
  }

  if (server.state === "empty" || !server.summary) {
    const view = base("empty", "No stored summary");
    const n = server.live_feedback_count;
    view.gatedTitle = "No summary yet";
    view.gatedBody = `${n} feedback ${n === 1 ? "row is" : "rows are"} ready. Generate a provisional RCA and CAPA from negative narratives (positives: recognition only).`;
    view.gatedTone = "brand";
    view.actions = [
      { label: "Generate summary", disabled: false, action: "generate", variant: "primary" },
    ];
    return view;
  }

  if (server.state === "stale") {
    const detail = server.stale_detail ?? {
      newer: true,
      count_increased: server.live_feedback_count > server.summary.feedback_count_at_gen,
    };
    const view = base("stale", "New feedback since summary");
    view.showStaleBanner = true;
    view.staleBannerTitle = "Stale — new feedback since summary.";
    view.staleBannerBody = staleBannerBody({
      generatedIst: server.summary.generated_ist,
      countAtGen: server.summary.feedback_count_at_gen,
      liveCount: server.live_feedback_count,
      newer: detail.newer,
      countIncreased: detail.count_increased,
    });
    view.showBody = true;
    view.body = server.summary.body;
    view.sections = parseSummarySections(server.summary.body);
    view.showMeta = true;
    view.meta = metaFrom(server.summary);
    view.actions = [
      { label: "Regenerate summary", disabled: false, action: "generate", variant: "primary" },
      { label: "Keep current", disabled: false, action: "keep", variant: "ghost" },
    ];
    view.footnote = "Provisional RCA/CAPA. The prior summary stays until a successful regenerate overwrites it.";
    return view;
  }

  const view = base("ready", `${server.summary.feedback_count_at_gen} feedback used`);
  view.showBody = true;
  view.body = server.summary.body;
  view.sections = parseSummarySections(server.summary.body);
  view.showMeta = true;
  view.meta = metaFrom(server.summary);
  view.actions = [
    { label: "Regenerate summary", disabled: false, action: "generate", variant: "secondary" },
  ];
  view.footnote = "Provisional RCA and CAPA for negatives; positives are recognition only.";
  return view;
}
