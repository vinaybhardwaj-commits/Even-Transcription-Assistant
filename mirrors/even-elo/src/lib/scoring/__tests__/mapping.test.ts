import { describe, it, expect } from "vitest";
import { mapToZeroHundred, clamp } from "../mapping";
import { Stream } from "../types";

const binaryHigher: Stream = {
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

const binaryLower: Stream = {
  ...binaryHigher,
  id: "mortality_30d",
  direction: "lower_better",
  default_rule: "no_event",
};

const numericHigher: Stream = {
  id: "nps_discharge",
  component: "outcomes",
  label: "NPS",
  team_owner: "CC",
  data_type: "numeric",
  default_rule: "excluded",
  direction: "higher_better",
  floor_value: 6,
  target_value: 9,
};

const numericLower: Stream = {
  id: "ot_overrun_minutes",
  component: "adherence",
  label: "OT overrun",
  team_owner: "OT",
  data_type: "numeric",
  default_rule: "excluded",
  direction: "lower_better",
  floor_value: 30,
  target_value: 0,
};

describe("clamp", () => {
  it("clamps below lower bound", () => {
    expect(clamp(-5, 0, 100)).toBe(0);
  });
  it("clamps above upper bound", () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });
  it("passes through within bounds", () => {
    expect(clamp(42.5, 0, 100)).toBe(42.5);
  });
});

describe("mapToZeroHundred — binary higher_better", () => {
  it("yes → 100", () => {
    expect(mapToZeroHundred({ kind: "binary", val: true }, binaryHigher)).toBe(100);
  });
  it("no → 0", () => {
    expect(mapToZeroHundred({ kind: "binary", val: false }, binaryHigher)).toBe(0);
  });
});

describe("mapToZeroHundred — binary lower_better (exception streams)", () => {
  it("yes (event happened) → 0", () => {
    expect(mapToZeroHundred({ kind: "binary", val: true }, binaryLower)).toBe(0);
  });
  it("no (no event) → 100", () => {
    expect(mapToZeroHundred({ kind: "binary", val: false }, binaryLower)).toBe(100);
  });
});

describe("mapToZeroHundred — numeric higher_better", () => {
  it("at floor → 0", () => {
    expect(mapToZeroHundred({ kind: "numeric", val: 6 }, numericHigher)).toBe(0);
  });
  it("at target → 100", () => {
    expect(mapToZeroHundred({ kind: "numeric", val: 9 }, numericHigher)).toBe(100);
  });
  it("midpoint", () => {
    expect(mapToZeroHundred({ kind: "numeric", val: 7.5 }, numericHigher)).toBeCloseTo(50, 5);
  });
  it("below floor clamps to 0", () => {
    expect(mapToZeroHundred({ kind: "numeric", val: 2 }, numericHigher)).toBe(0);
  });
  it("above target clamps to 100", () => {
    expect(mapToZeroHundred({ kind: "numeric", val: 10 }, numericHigher)).toBe(100);
  });
});

describe("mapToZeroHundred — numeric lower_better", () => {
  it("at floor (worst) → 0", () => {
    expect(mapToZeroHundred({ kind: "numeric", val: 30 }, numericLower)).toBe(0);
  });
  it("at target (best) → 100", () => {
    expect(mapToZeroHundred({ kind: "numeric", val: 0 }, numericLower)).toBe(100);
  });
  it("midpoint", () => {
    expect(mapToZeroHundred({ kind: "numeric", val: 15 }, numericLower)).toBeCloseTo(50, 5);
  });
  it("worse than floor (40 min overrun) clamps to 0", () => {
    expect(mapToZeroHundred({ kind: "numeric", val: 40 }, numericLower)).toBe(0);
  });
  it("better than target (negative overrun) clamps to 100", () => {
    expect(mapToZeroHundred({ kind: "numeric", val: -5 }, numericLower)).toBe(100);
  });
});

describe("mapToZeroHundred — type/data mismatches", () => {
  it("binary stream + numeric value → null", () => {
    expect(mapToZeroHundred({ kind: "numeric", val: 5 }, binaryHigher)).toBeNull();
  });
  it("numeric stream + binary value → null", () => {
    expect(mapToZeroHundred({ kind: "binary", val: true }, numericHigher)).toBeNull();
  });
  it("numeric stream missing floor → null", () => {
    expect(
      mapToZeroHundred({ kind: "numeric", val: 5 }, { ...numericHigher, floor_value: null }),
    ).toBeNull();
  });
  it("numeric stream with floor === target → null (avoid div-by-zero)", () => {
    expect(
      mapToZeroHundred(
        { kind: "numeric", val: 5 },
        { ...numericHigher, floor_value: 5, target_value: 5 },
      ),
    ).toBeNull();
  });
});
