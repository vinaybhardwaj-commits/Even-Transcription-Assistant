import { describe, it, expect } from "vitest";
import { aggregateStream } from "../aggregate";
import { CaseRow, Observation, Stream } from "../types";

const asOf = new Date("2026-04-30T00:00:00Z");

const pacDone: Stream = {
  id: "pac_done",
  component: "adherence",
  label: "PAC done",
  team_owner: "Anesthesia",
  data_type: "binary",
  default_rule: "unknown",
  direction: "higher_better",
  floor_value: null,
  target_value: null,
};

const mortality: Stream = {
  id: "mortality_30d",
  component: "outcomes",
  label: "30-day mortality",
  team_owner: "MS",
  data_type: "binary",
  default_rule: "no_event",
  direction: "lower_better",
  floor_value: null,
  target_value: null,
};

const nps: Stream = {
  id: "nps_discharge",
  component: "outcomes",
  label: "NPS discharge",
  team_owner: "CC",
  data_type: "numeric",
  default_rule: "excluded",
  direction: "higher_better",
  floor_value: 6,
  target_value: 9,
};

function mkCase(id: string, daysAgo: number): CaseRow {
  const date = new Date(asOf.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    id,
    vc_id: "vc-1",
    surgery_date: date.toISOString().substring(0, 10),
    case_status: "completed",
  };
}

describe("aggregateStream — default_rule unknown", () => {
  it("returns null score when no observations exist", () => {
    const cases = [mkCase("c1", 5), mkCase("c2", 30)];
    const r = aggregateStream(pacDone, cases, [], asOf);
    expect(r.score).toBeNull();
    expect(r.n).toBe(0);
  });

  it("only explicit observations contribute (others ignored)", () => {
    const cases = [mkCase("c1", 5), mkCase("c2", 30), mkCase("c3", 60)];
    const obs: Observation[] = [
      { case_id: "c1", stream_id: "pac_done", value: { kind: "binary", val: true } },
      { case_id: "c2", stream_id: "pac_done", value: { kind: "binary", val: false } },
    ];
    const r = aggregateStream(pacDone, cases, obs, asOf);
    expect(r.n).toBe(2);
    // c1 weight ~0.972, sub 100; c2 weight ~0.833, sub 0 → wAvg ~ 53.85
    expect(r.score).toBeGreaterThan(50);
    expect(r.score).toBeLessThan(60);
  });

  it("ignores observations from other streams", () => {
    const cases = [mkCase("c1", 5)];
    const obs: Observation[] = [
      { case_id: "c1", stream_id: "OTHER_STREAM", value: { kind: "binary", val: true } },
    ];
    expect(aggregateStream(pacDone, cases, obs, asOf).score).toBeNull();
  });
});

describe("aggregateStream — default_rule no_event", () => {
  it("synthesizes 'no event' default for every case → 100% if no exceptions", () => {
    const cases = [mkCase("c1", 5), mkCase("c2", 30), mkCase("c3", 90)];
    const r = aggregateStream(mortality, cases, [], asOf);
    expect(r.score).toBe(100);
    expect(r.n).toBe(3);
  });

  it("explicit 'event happened' overrides the default for that case", () => {
    const cases = [mkCase("c1", 5), mkCase("c2", 30), mkCase("c3", 60)];
    const obs: Observation[] = [
      { case_id: "c2", stream_id: "mortality_30d", value: { kind: "binary", val: true } },
    ];
    const r = aggregateStream(mortality, cases, obs, asOf);
    // 1 of 3 had an event; weighted average so not exactly 66.67
    expect(r.n).toBe(3);
    expect(r.score).toBeLessThan(100);
    expect(r.score).toBeGreaterThan(50);
  });
});

describe("aggregateStream — default_rule excluded (numeric NPS)", () => {
  it("returns null when no observations entered", () => {
    const cases = [mkCase("c1", 5), mkCase("c2", 30)];
    expect(aggregateStream(nps, cases, [], asOf).score).toBeNull();
  });

  it("averages explicit numeric values", () => {
    const cases = [mkCase("c1", 5), mkCase("c2", 30)];
    const obs: Observation[] = [
      { case_id: "c1", stream_id: "nps_discharge", value: { kind: "numeric", val: 9 } },
      { case_id: "c2", stream_id: "nps_discharge", value: { kind: "numeric", val: 7.5 } },
    ];
    const r = aggregateStream(nps, cases, obs, asOf);
    expect(r.n).toBe(2);
    // c1 NPS 9 → 100, c2 NPS 7.5 → 50, weighted by recency.
    expect(r.score).toBeGreaterThan(50);
    expect(r.score).toBeLessThan(100);
  });
});

describe("aggregateStream — decay window", () => {
  it("excludes cases older than the 180-day window", () => {
    const cases = [mkCase("c1", 200), mkCase("c2", 20)];
    const obs: Observation[] = [
      { case_id: "c1", stream_id: "pac_done", value: { kind: "binary", val: false } },
      { case_id: "c2", stream_id: "pac_done", value: { kind: "binary", val: true } },
    ];
    const r = aggregateStream(pacDone, cases, obs, asOf);
    // c1 is outside window so weight=0; only c2 counts
    expect(r.n).toBe(1);
    expect(r.score).toBe(100);
  });

  it("excludes cancelled / voided cases", () => {
    const cases: CaseRow[] = [
      mkCase("c1", 5),
      { ...mkCase("c2", 30), case_status: "voided" },
      { ...mkCase("c3", 30), case_status: "cancelled" },
    ];
    const obs: Observation[] = [
      { case_id: "c2", stream_id: "mortality_30d", value: { kind: "binary", val: true } },
    ];
    const r = aggregateStream(mortality, cases, obs, asOf);
    // Only c1 contributes (no_event default), c2 voided → ignored
    expect(r.n).toBe(1);
    expect(r.score).toBe(100);
  });
});
