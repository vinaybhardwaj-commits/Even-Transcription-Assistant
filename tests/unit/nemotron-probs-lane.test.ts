/** NEMOTRON_PROBS_BACKFILL: unset = ON, falsy = OFF, anything else THROWS (parseFlag). Architecture #23 follow-up. */
import { describe, expect, it } from "vitest";
import { probsBackfillEnabled } from "@/lib/diarize-nemotron/probs-lane";

describe("probsBackfillEnabled", () => {
  it("is on by default and on for a truthy value", () => {
    expect(probsBackfillEnabled({})).toBe(true);
    expect(probsBackfillEnabled({ NEMOTRON_PROBS_BACKFILL: "1" })).toBe(true);
  });
  it("is off for a falsy value", () => {
    expect(probsBackfillEnabled({ NEMOTRON_PROBS_BACKFILL: "0" })).toBe(false);
    expect(probsBackfillEnabled({ NEMOTRON_PROBS_BACKFILL: "false" })).toBe(false);
  });
  it("refuses to guess on a typo", () => {
    expect(() => probsBackfillEnabled({ NEMOTRON_PROBS_BACKFILL: "maybe" })).toThrow();
  });
});
