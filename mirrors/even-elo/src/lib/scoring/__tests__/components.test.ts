import { describe, it, expect } from "vitest";
import {
  computeCaseload,
  computeBehaviouralComponent,
  OUTCOMES_MIN_STREAMS,
  ADHERENCE_MIN_STREAMS,
} from "../components";
import { Stream, CaseRow, Observation } from "../types";

const caseloadStream: Stream = {
  id: "cases_per_month",
  component: "caseload",
  label: "Cases this month",
  team_owner: "OT",
  data_type: "derived",
  default_rule: "derived",
  direction: "higher_better",
  floor_value: 1,
  target_value: 8,
};

describe("computeCaseload", () => {
  it("returns 0 below or at the floor", () => {
    expect(computeCaseload(0, caseloadStream).score).toBe(0);
    expect(computeCaseload(1, caseloadStream).score).toBe(0);
  });

  it("returns 100 at or above target", () => {
    expect(computeCaseload(8, caseloadStream).score).toBe(100);
    expect(computeCaseload(20, caseloadStream).score).toBe(100);
  });

  it("scales linearly between floor and target", () => {
    // count=4 → (4-1)/(8-1) = 3/7 ≈ 42.857
    const r = computeCaseload(4, caseloadStream);
    expect(r.score).toBeCloseTo((100 * 3) / 7, 5);
  });

  it("provides a single-stream breakdown", () => {
    const r = computeCaseload(5, caseloadStream);
    expect(r.streams.length).toBe(1);
    expect(r.streams[0].stream_id).toBe("cases_per_month");
    expect(r.scoreable_stream_count).toBe(1);
  });
});

describe("computeBehaviouralComponent — insufficient data thresholds", () => {
  const asOf = new Date("2026-04-30T00:00:00Z");

  function mkBin(id: string, defaultRule: "no_event" | "unknown"): Stream {
    return {
      id,
      component: "outcomes",
      label: id,
      team_owner: "MS",
      data_type: "binary",
      default_rule: defaultRule,
      direction: "higher_better",
      floor_value: null,
      target_value: null,
    };
  }

  function mkCase(id: string, daysAgo: number): CaseRow {
    const date = new Date(asOf.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    return {
      id,
      vc_id: "vc-1",
      surgery_date: date.toISOString().substring(0, 10),
      case_status: "completed",
    };
  }

  it("Outcomes returns null score when fewer than 3 streams scoreable", () => {
    const streams = [
      mkBin("o1", "unknown"),
      mkBin("o2", "unknown"),
      mkBin("o3", "unknown"),
      mkBin("o4", "unknown"),
    ];
    const cases = [mkCase("c1", 5)];
    const obs: Observation[] = [
      { case_id: "c1", stream_id: "o1", value: { kind: "binary", val: true } },
      { case_id: "c1", stream_id: "o2", value: { kind: "binary", val: true } },
    ];
    const r = computeBehaviouralComponent(streams, cases, obs, asOf, OUTCOMES_MIN_STREAMS);
    expect(r.score).toBeNull();
    expect(r.scoreable_stream_count).toBe(2);
  });

  it("Outcomes is scoreable at exactly 3 streams", () => {
    const streams = [
      mkBin("o1", "unknown"),
      mkBin("o2", "unknown"),
      mkBin("o3", "unknown"),
    ];
    const cases = [mkCase("c1", 5)];
    const obs: Observation[] = [
      { case_id: "c1", stream_id: "o1", value: { kind: "binary", val: true } },
      { case_id: "c1", stream_id: "o2", value: { kind: "binary", val: true } },
      { case_id: "c1", stream_id: "o3", value: { kind: "binary", val: false } },
    ];
    const r = computeBehaviouralComponent(streams, cases, obs, asOf, OUTCOMES_MIN_STREAMS);
    expect(r.score).not.toBeNull();
    expect(r.scoreable_stream_count).toBe(3);
    // Two 100s + one 0, mean = 66.67
    expect(r.score).toBeCloseTo(200 / 3, 4);
  });

  it("no_event streams are auto-scoreable as long as cases exist", () => {
    // Every real no_event stream in PRD §5 is lower_better (mortality, SSI, etc.).
    // The synthetic `false` default maps to 100 only when direction is lower_better.
    const lowerBetterNoEvent = (id: string): Stream => ({
      ...mkBin(id, "no_event"),
      direction: "lower_better",
    });
    const streams = [
      lowerBetterNoEvent("e1"),
      lowerBetterNoEvent("e2"),
      lowerBetterNoEvent("e3"),
      lowerBetterNoEvent("e4"),
    ];
    const cases = [mkCase("c1", 5), mkCase("c2", 30)];
    const r = computeBehaviouralComponent(streams, cases, [], asOf, OUTCOMES_MIN_STREAMS);
    expect(r.score).toBeCloseTo(100, 5); // float precision: weighted-avg of 100s ≈ 100
    expect(r.scoreable_stream_count).toBe(4);
  });

  it("Adherence threshold is 4", () => {
    expect(ADHERENCE_MIN_STREAMS).toBe(4);
    const streams = [
      mkBin("a1", "unknown"),
      mkBin("a2", "unknown"),
      mkBin("a3", "unknown"),
      mkBin("a4", "unknown"),
    ];
    const cases = [mkCase("c1", 5)];
    const obs: Observation[] = [
      { case_id: "c1", stream_id: "a1", value: { kind: "binary", val: true } },
      { case_id: "c1", stream_id: "a2", value: { kind: "binary", val: true } },
      { case_id: "c1", stream_id: "a3", value: { kind: "binary", val: true } },
      { case_id: "c1", stream_id: "a4", value: { kind: "binary", val: true } },
    ];
    const r = computeBehaviouralComponent(streams, cases, obs, asOf, ADHERENCE_MIN_STREAMS);
    expect(r.score).toBe(100);
    expect(r.scoreable_stream_count).toBe(4);
  });
});
