/**
 * nemotron-overflow.test.ts — the PURE HF overflow gate (lib/diarize-nemotron/overflow.ts): strict env parsing, the machine parameter,
 * and the cap / threshold decision. No database. Figures are typed by hand: $1 at the default $1/h = 60 audio min = 4 windows.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_BACKLOG_THRESHOLD, OverflowConfigError, overflowConfig, overflowDecision, parseMachine } from "@/lib/diarize-nemotron/overflow";

describe("overflowConfig", () => {
  it("defaults: cap 0 (OFF), threshold 40, $1/h", () => {
    expect(overflowConfig({})).toEqual({ capUsd: 0, backlogThreshold: 40, usdPerMin: 1 / 60 });
    expect(DEFAULT_BACKLOG_THRESHOLD).toBe(40);
  });
  it("reads set values, and an empty string is unset", () => {
    expect(overflowConfig({ NEMO_HF_DAILY_USD_CAP: "5", NEMO_HF_BACKLOG_THRESHOLD: "10", NEMO_HF_USD_PER_AUDIO_MIN: "0.05" })).toEqual({ capUsd: 5, backlogThreshold: 10, usdPerMin: 0.05 });
    expect(overflowConfig({ NEMO_HF_DAILY_USD_CAP: "  " }).capUsd).toBe(0);
  });
  it.each([["NEMO_HF_DAILY_USD_CAP", "five"], ["NEMO_HF_DAILY_USD_CAP", "-1"], ["NEMO_HF_DAILY_USD_CAP", "NaN"], ["NEMO_HF_DAILY_USD_CAP", "Infinity"],
          ["NEMO_HF_BACKLOG_THRESHOLD", "4.5"], ["NEMO_HF_BACKLOG_THRESHOLD", "x"], ["NEMO_HF_USD_PER_AUDIO_MIN", "0"], ["NEMO_HF_USD_PER_AUDIO_MIN", "abc"]])(
    "%s=%s THROWS and does not echo the value", (k, v) => {
      let msg = "";
      try { overflowConfig({ [k]: v }); } catch (e) { expect(e).toBeInstanceOf(OverflowConfigError); msg = (e as Error).message; }
      expect(msg).not.toBe("");
      expect(msg).not.toContain(`"${v}"`);
    });
});

describe("parseMachine", () => {
  it("absent or empty is box; box and hf pass; anything else is refused", () => {
    expect(parseMachine(null)).toBe("box");
    expect(parseMachine("")).toBe("box");
    expect(parseMachine("box")).toBe("box");
    expect(parseMachine("hf")).toBe("hf");
    expect(parseMachine("HF")).toBeNull();
    expect(parseMachine("gpu")).toBeNull();
  });
});

describe("overflowDecision", () => {
  const cfg = { capUsd: 1, backlogThreshold: 40, usdPerMin: 1 / 60 };
  it("cap 0 is OFF whatever the backlog", () => {
    expect(overflowDecision({ ...cfg, capUsd: 0 }, { usedMin: 0, backlog: 10_000, limit: 8 })).toEqual({ allow: false, reason: "overflow_off" });
  });
  it("backlog must EXCEED the threshold (equal is not enough)", () => {
    expect(overflowDecision(cfg, { usedMin: 0, backlog: 40, limit: 4 })).toEqual({ allow: false, reason: "below_threshold" });
    expect(overflowDecision(cfg, { usedMin: 0, backlog: 41, limit: 4 })).toEqual({ allow: true, limit: 1 });
  });
  it("limit is the lowest of requested, windows the cap still fits, and backlog above the threshold", () => {
    expect(overflowDecision(cfg, { usedMin: 0, backlog: 500, limit: 2 })).toEqual({ allow: true, limit: 2 });
    expect(overflowDecision(cfg, { usedMin: 0, backlog: 500, limit: 8 })).toEqual({ allow: true, limit: 4 });
    expect(overflowDecision(cfg, { usedMin: 31, backlog: 500, limit: 8 })).toEqual({ allow: true, limit: 1 });
  });
  it("less than one whole window of room is cap_reached; spent over the cap is cap_reached", () => {
    expect(overflowDecision(cfg, { usedMin: 46, backlog: 500, limit: 8 })).toEqual({ allow: false, reason: "cap_reached" });
    expect(overflowDecision(cfg, { usedMin: 9999, backlog: 500, limit: 8 })).toEqual({ allow: false, reason: "cap_reached" });
  });
  it("cap is reported before threshold when both close", () => {
    expect(overflowDecision(cfg, { usedMin: 60, backlog: 0, limit: 4 })).toEqual({ allow: false, reason: "cap_reached" });
  });
});
