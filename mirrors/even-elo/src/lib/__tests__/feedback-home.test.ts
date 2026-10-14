import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEADLINE_SUMMARY_LABEL,
  ROW_SUMMARY_LABEL,
  SUMMARY_STATE_NONE,
  categoryLabel,
  emptyHeadline,
  filterFeedItems,
  filterPhysicianRows,
  formatFeedbackDate,
  lookupCandidates,
  type FeedbackFeedItem,
  type FeedbackPhysicianRow,
} from "../feedback-home";

function physician(partial: Partial<FeedbackPhysicianRow> & Pick<FeedbackPhysicianRow, "physician_id" | "name">): FeedbackPhysicianRow {
  return {
    specialty: "ENT",
    positive: 1,
    negative: 1,
    total: 2,
    last_activity: "2026-05-20T07:21:35.766Z",
    severity_counts: { critical: 0, high: 0, medium: 0, low: 1 },
    summary_label: ROW_SUMMARY_LABEL,
    ...partial,
  };
}

function feed(partial: Partial<FeedbackFeedItem> & Pick<FeedbackFeedItem, "id" | "target_physician_name">): FeedbackFeedItem {
  return {
    target_physician_id: "p1",
    specialty: "ENT",
    submitted_at: "2026-09-03T07:30:13.363Z",
    anonymous_flag: false,
    submitter_label: "Staff",
    hospital_code: "EHRC",
    category: "patient_safety",
    severity: "low",
    polarity: "negative",
    source: "patient",
    commendation_category: null,
    patient_rating: null,
    narrative_preview: "preview",
    status: "open",
    retracted_at: null,
    retraction_reason: null,
    reply_count: 0,
    ...partial,
  };
}

describe("feedback home shaping", () => {
  it("formats activity dates in IST without a leading zero", () => {
    expect(formatFeedbackDate("2026-09-03T07:30:13.363Z")).toBe("3 Sep 2026");
    expect(formatFeedbackDate("2026-05-20T07:21:35.766Z")).toBe("20 May 2026");
    expect(formatFeedbackDate("2026-09-02T20:00:00.000Z")).toBe("3 Sep 2026");
    expect(formatFeedbackDate(null)).toBe("—");
    expect(formatFeedbackDate("not-a-date")).toBe("—");
  });

  it("keeps the summary state empty", () => {
    const headline = emptyHeadline(265);
    expect(headline.summaries).toBe(SUMMARY_STATE_NONE);
    expect(headline.summaries_label).toBe(HEADLINE_SUMMARY_LABEL);
    expect(headline.roster_size).toBe(265);
    expect(physician({ physician_id: "a", name: "Dr A" }).summary_label).toBe(ROW_SUMMARY_LABEL);
  });

  it("filters physicians by lookup, polarity, and severity", () => {
    const rows = [
      physician({
        physician_id: "a",
        name: "Dr. Animesh Banerjee",
        specialty: "ENT",
        positive: 33,
        negative: 9,
        total: 42,
        severity_counts: { critical: 0, high: 0, medium: 0, low: 9 },
      }),
      physician({
        physician_id: "b",
        name: "Dr. Vishal Naik",
        specialty: "General Surgery",
        positive: 8,
        negative: 0,
        total: 8,
        severity_counts: { critical: 0, high: 0, medium: 0, low: 0 },
      }),
      physician({
        physician_id: "c",
        name: "Dr. Uday Ravi",
        specialty: "General Surgery",
        positive: 1,
        negative: 1,
        total: 2,
        severity_counts: { critical: 1, high: 0, medium: 0, low: 0 },
      }),
    ];

    expect(filterPhysicianRows(rows, { query: "ent", polarity: "all", severity: "" }).map((r) => r.physician_id)).toEqual(["a"]);
    expect(filterPhysicianRows(rows, { query: "ravi", polarity: "all", severity: "" }).map((r) => r.physician_id)).toEqual(["c"]);
    expect(filterPhysicianRows(rows, { query: "", polarity: "negative", severity: "" }).map((r) => r.physician_id)).toEqual(["a", "c"]);
    expect(filterPhysicianRows(rows, { query: "", polarity: "positive", severity: "" }).map((r) => r.physician_id)).toEqual(["a", "b", "c"]);
    expect(filterPhysicianRows(rows, { query: "", polarity: "all", severity: "critical" }).map((r) => r.physician_id)).toEqual(["c"]);
    expect(lookupCandidates(rows, "surgery").map((r) => r.physician_id)).toEqual(["b", "c"]);
  });

  it("filters the chronological feed without dropping the physician match", () => {
    const rows = [
      feed({ id: "1", target_physician_name: "Dr. Uday Ravi", specialty: "General Surgery", severity: "critical", polarity: "negative", status: "open" }),
      feed({ id: "2", target_physician_name: "Dr. Vishal Naik", specialty: "General Surgery", severity: null, polarity: "positive", status: "closed", category: null }),
      feed({ id: "3", target_physician_name: "Dr. Animesh Banerjee", specialty: "ENT", severity: "low", polarity: "negative", status: "retracted" }),
    ];
    expect(filterFeedItems(rows, { query: "uday", polarity: "all", severity: "", status: "all" }).map((r) => r.id)).toEqual(["1"]);
    expect(filterFeedItems(rows, { query: "", polarity: "positive", severity: "", status: "all" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterFeedItems(rows, { query: "", polarity: "all", severity: "critical", status: "all" }).map((r) => r.id)).toEqual(["1"]);
    expect(filterFeedItems(rows, { query: "", polarity: "all", severity: "", status: "retracted" }).map((r) => r.id)).toEqual(["3"]);
  });

  it("labels known categories", () => {
    expect(categoryLabel("patient_safety")).toBe("Patient safety");
    expect(categoryLabel(null)).toBe("—");
  });

  it("does not reference a model client from the feedback home surfaces", () => {
    const root = join(__dirname, "..", "..");
    const files = [
      "lib/feedback-home.ts",
      "app/api/incidents/home/route.ts",
      "components/feedback/FeedbackHome.tsx",
      "components/shell/HeadlineStrip.tsx",
      "components/shell/DoctorLookup.tsx",
    ];
    const banned = /\b(gemini|vertex|generative)\b/i;
    for (const file of files) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src, file).not.toMatch(banned);
      expect(src, file).not.toMatch(/summary_text|generated_summary/);
    }
    const detail = readFileSync(join(root, "components/feedback/PhysicianFeedbackDetail.tsx"), "utf8");
    expect(detail).not.toMatch(/\b(generateContent|@google-cloud\/vertexai)\b/);
    expect(detail).not.toMatch(/narrative_preview/);
  });
});
