import { describe, it, expect } from "vitest";
import { computeScore } from "../index";
import { Stream, CaseRow, Observation, Weights } from "../types";

/**
 * Realistic full-pipeline integration tests with the 18-stream catalogue
 * mirrored from the migration seed.
 */

const asOf = new Date("2026-04-30T00:00:00Z");

const STREAMS: Stream[] = [
  // Caseload
  { id: "cases_per_month", component: "caseload", label: "Cases", team_owner: "OT", data_type: "derived", default_rule: "derived", direction: "higher_better", floor_value: 1, target_value: 8 },
  // Outcomes (8)
  { id: "mortality_30d", component: "outcomes", label: "Mortality", team_owner: "MS", data_type: "binary", default_rule: "no_event", direction: "lower_better", floor_value: null, target_value: null },
  { id: "readmission_30d", component: "outcomes", label: "Readmission", team_owner: "MS", data_type: "binary", default_rule: "no_event", direction: "lower_better", floor_value: null, target_value: null },
  { id: "ssi", component: "outcomes", label: "SSI", team_owner: "ICN", data_type: "binary", default_rule: "no_event", direction: "lower_better", floor_value: null, target_value: null },
  { id: "unplanned_return_ot", component: "outcomes", label: "Return-to-OT", team_owner: "OT", data_type: "binary", default_rule: "no_event", direction: "lower_better", floor_value: null, target_value: null },
  { id: "nps_discharge", component: "outcomes", label: "NPS discharge", team_owner: "CC", data_type: "numeric", default_rule: "excluded", direction: "higher_better", floor_value: 6, target_value: 9 },
  { id: "nps_day7", component: "outcomes", label: "NPS Day-7", team_owner: "CC", data_type: "numeric", default_rule: "excluded", direction: "higher_better", floor_value: 6, target_value: 9 },
  { id: "complaint_raised", component: "outcomes", label: "Complaint", team_owner: "CC", data_type: "binary", default_rule: "no_event", direction: "lower_better", floor_value: null, target_value: null },
  { id: "family_comm_done", component: "outcomes", label: "Family comm", team_owner: "CC", data_type: "binary", default_rule: "unknown", direction: "higher_better", floor_value: null, target_value: null },
  // Adherence (9)
  { id: "pac_done", component: "adherence", label: "PAC", team_owner: "Anesthesia", data_type: "binary", default_rule: "unknown", direction: "higher_better", floor_value: null, target_value: null },
  { id: "ot_on_time", component: "adherence", label: "OT on-time", team_owner: "OT", data_type: "binary", default_rule: "unknown", direction: "higher_better", floor_value: null, target_value: null },
  { id: "ot_equipment_protocol", component: "adherence", label: "OT equipment", team_owner: "OT", data_type: "binary", default_rule: "unknown", direction: "higher_better", floor_value: null, target_value: null },
  { id: "ot_overrun_minutes", component: "adherence", label: "Overrun", team_owner: "OT", data_type: "numeric", default_rule: "excluded", direction: "lower_better", floor_value: 30, target_value: 0 },
  { id: "discharge_summary_24h", component: "adherence", label: "DC summary 24h", team_owner: "MS", data_type: "binary", default_rule: "unknown", direction: "higher_better", floor_value: null, target_value: null },
  { id: "round_attendance", component: "adherence", label: "Rounds", team_owner: "MS", data_type: "binary", default_rule: "unknown", direction: "higher_better", floor_value: null, target_value: null },
  { id: "abx_stewardship", component: "adherence", label: "ABX", team_owner: "Pharmacy", data_type: "binary", default_rule: "unknown", direction: "higher_better", floor_value: null, target_value: null },
  { id: "insurance_denial", component: "adherence", label: "Denial", team_owner: "Billing", data_type: "binary", default_rule: "no_event", direction: "lower_better", floor_value: null, target_value: null },
  { id: "unit_head_anomaly", component: "adherence", label: "Anomaly", team_owner: "UnitHead", data_type: "binary", default_rule: "no_event", direction: "lower_better", floor_value: null, target_value: null },
];

const WEIGHTS: Weights = { caseload_pct: 33, outcomes_pct: 34, adherence_pct: 33 };

function mkCase(id: string, daysAgo: number): CaseRow {
  const date = new Date(asOf.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    id,
    vc_id: "vc-1",
    surgery_date: date.toISOString().substring(0, 10),
    case_status: "completed",
  };
}

describe("computeScore — VC with no recent activity", () => {
  it("returns no_recent_activity tier when no cases in window", () => {
    const r = computeScore({
      cases: [],
      observations: [],
      streams: STREAMS,
      weights: WEIGHTS,
      asOfDate: asOf,
    });
    expect(r.tier).toBe("no_recent_activity");
    expect(r.case_count_window).toBe(0);
  });

  it("returns no_recent_activity even if case is voided", () => {
    const r = computeScore({
      cases: [{ id: "c1", vc_id: "vc-1", surgery_date: "2026-04-15", case_status: "voided" }],
      observations: [],
      streams: STREAMS,
      weights: WEIGHTS,
      asOfDate: asOf,
    });
    expect(r.tier).toBe("no_recent_activity");
  });
});

describe("computeScore — high-performing VC", () => {
  it("yields distinguished tier with strong signals", () => {
    // 8 cases this month → caseload 100
    // Every Outcomes stream defaults to no_event = 100
    // NPS streams: enter 9 for both → 100
    // Every Adherence binary compliance stream entered as 'yes' for all cases → 100
    // Overrun = 0 for each → 100
    const cases = Array.from({ length: 10 }, (_, i) => mkCase(`c${i}`, i * 3));
    const obs: Observation[] = [];
    for (const c of cases) {
      obs.push({ case_id: c.id, stream_id: "nps_discharge", value: { kind: "numeric", val: 9 } });
      obs.push({ case_id: c.id, stream_id: "nps_day7", value: { kind: "numeric", val: 9 } });
      obs.push({ case_id: c.id, stream_id: "family_comm_done", value: { kind: "binary", val: true } });
      obs.push({ case_id: c.id, stream_id: "pac_done", value: { kind: "binary", val: true } });
      obs.push({ case_id: c.id, stream_id: "ot_on_time", value: { kind: "binary", val: true } });
      obs.push({ case_id: c.id, stream_id: "ot_equipment_protocol", value: { kind: "binary", val: true } });
      obs.push({ case_id: c.id, stream_id: "ot_overrun_minutes", value: { kind: "numeric", val: 0 } });
      obs.push({ case_id: c.id, stream_id: "discharge_summary_24h", value: { kind: "binary", val: true } });
      obs.push({ case_id: c.id, stream_id: "round_attendance", value: { kind: "binary", val: true } });
      obs.push({ case_id: c.id, stream_id: "abx_stewardship", value: { kind: "binary", val: true } });
    }
    const r = computeScore({ cases, observations: obs, streams: STREAMS, weights: WEIGHTS, asOfDate: asOf });
    expect(r.composite).toBeCloseTo(100, 1);
    expect(r.tier).toBe("distinguished");
    expect(r.caseload.score).toBe(100);
    expect(r.outcomes.score).toBeCloseTo(100, 1);
    expect(r.adherence.score).toBeCloseTo(100, 1);
  });
});

describe("computeScore — Manoj Kumar fixture (suspension review)", () => {
  it("scores in the suspension_review tier with truly bad signals", () => {
    // Stylized Manoj Kumar (mockup shows 28.4): 5 cases in the 6mo window,
    // ALL 35+ days ago (so caseload-this-month = 0), with hammered outcomes
    // AND adherence — multiple events fired across no_event streams.
    const cases = Array.from({ length: 5 }, (_, i) => mkCase(`c${i}`, 35 + i * 15));
    const obs: Observation[] = [];

    // Outcomes — multiple events fired across no_event streams.
    obs.push({ case_id: "c0", stream_id: "mortality_30d", value: { kind: "binary", val: true } });
    obs.push({ case_id: "c1", stream_id: "ssi", value: { kind: "binary", val: true } });
    obs.push({ case_id: "c2", stream_id: "unplanned_return_ot", value: { kind: "binary", val: true } });
    obs.push({ case_id: "c0", stream_id: "readmission_30d", value: { kind: "binary", val: true } });
    obs.push({ case_id: "c1", stream_id: "readmission_30d", value: { kind: "binary", val: true } });
    obs.push({ case_id: "c0", stream_id: "complaint_raised", value: { kind: "binary", val: true } });
    obs.push({ case_id: "c1", stream_id: "complaint_raised", value: { kind: "binary", val: true } });
    obs.push({ case_id: "c2", stream_id: "complaint_raised", value: { kind: "binary", val: true } });
    obs.push({ case_id: "c3", stream_id: "complaint_raised", value: { kind: "binary", val: true } });
    for (const c of cases) {
      obs.push({ case_id: c.id, stream_id: "nps_discharge", value: { kind: "numeric", val: 4 } });
      obs.push({ case_id: c.id, stream_id: "nps_day7", value: { kind: "numeric", val: 3 } });
      obs.push({ case_id: c.id, stream_id: "family_comm_done", value: { kind: "binary", val: false } });
    }

    // Adherence — uniformly bad
    for (const c of cases) {
      obs.push({ case_id: c.id, stream_id: "pac_done", value: { kind: "binary", val: false } });
      obs.push({ case_id: c.id, stream_id: "ot_on_time", value: { kind: "binary", val: false } });
      obs.push({ case_id: c.id, stream_id: "ot_equipment_protocol", value: { kind: "binary", val: false } });
      obs.push({ case_id: c.id, stream_id: "ot_overrun_minutes", value: { kind: "numeric", val: 30 } });
      obs.push({ case_id: c.id, stream_id: "discharge_summary_24h", value: { kind: "binary", val: false } });
      obs.push({ case_id: c.id, stream_id: "round_attendance", value: { kind: "binary", val: false } });
      obs.push({ case_id: c.id, stream_id: "abx_stewardship", value: { kind: "binary", val: false } });
      obs.push({ case_id: c.id, stream_id: "insurance_denial", value: { kind: "binary", val: true } });
      obs.push({ case_id: c.id, stream_id: "unit_head_anomaly", value: { kind: "binary", val: true } });
    }

    const r = computeScore({ cases, observations: obs, streams: STREAMS, weights: WEIGHTS, asOfDate: asOf });
    expect(r.composite).toBeLessThan(30);
    expect(r.tier).toBe("suspension_review");
    expect(r.caseload.score).toBe(0); // all cases >30d ago — none this month
    expect(r.adherence.score).toBe(0); // every adherence stream hammered
  });
});

describe("computeScore — performance budget", () => {
  it("100-observation pipeline completes in <50ms", () => {
    const cases = Array.from({ length: 30 }, (_, i) => mkCase(`c${i}`, i * 4));
    const obs: Observation[] = [];
    for (const c of cases) {
      for (const s of STREAMS) {
        if (s.data_type === "binary") {
          obs.push({ case_id: c.id, stream_id: s.id, value: { kind: "binary", val: Math.random() > 0.3 } });
        } else if (s.data_type === "numeric") {
          obs.push({ case_id: c.id, stream_id: s.id, value: { kind: "numeric", val: Math.random() * 10 } });
        }
      }
    }
    const start = Date.now();
    const r = computeScore({ cases, observations: obs, streams: STREAMS, weights: WEIGHTS, asOfDate: asOf });
    const elapsed = Date.now() - start;
    expect(r).toBeDefined();
    expect(elapsed).toBeLessThan(50);
  });
});

describe("computeScore — low-confidence flag", () => {
  it("flagged when total observations <30 in window", () => {
    const cases = [mkCase("c1", 5), mkCase("c2", 30)];
    const obs: Observation[] = [
      { case_id: "c1", stream_id: "pac_done", value: { kind: "binary", val: true } },
      { case_id: "c2", stream_id: "pac_done", value: { kind: "binary", val: false } },
    ];
    const r = computeScore({ cases, observations: obs, streams: STREAMS, weights: WEIGHTS, asOfDate: asOf });
    expect(r.low_confidence).toBe(true);
  });
});
