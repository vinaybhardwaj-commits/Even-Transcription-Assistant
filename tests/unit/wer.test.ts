import { describe, it, expect } from "vitest";
import { normalizeForWer, wer, cer, termRecall } from "../../lib/stt/wer";

describe("normalizeForWer", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeForWer("  Hello,  WORLD!! ")).toBe("hello world");
  });
});

describe("wer", () => {
  it("is 0 for an exact match and null for an empty reference", () => {
    expect(wer("the cat sat", "the cat sat")).toBe(0);
    expect(wer("", "anything")).toBeNull();
  });
  it("counts one substitution out of three words as 0.333", () => {
    expect(wer("the cat sat", "the dog sat")).toBeCloseTo(0.333, 3);
  });
  it("can exceed 1 with many insertions", () => {
    expect(wer("hi", "hi there friend now")).toBeGreaterThan(1);
  });
});

describe("cer", () => {
  it("is 0 for identical normalized strings, null for empty ref", () => {
    expect(cer("abc", "abc")).toBe(0);
    expect(cer("", "x")).toBeNull();
  });
});

describe("termRecall", () => {
  it("returns the fraction of critical terms present (substring, normalized)", () => {
    const terms = [{ term: "Sodium" }, { term: "3% NaCl" }, { term: "ICU" }];
    expect(termRecall(terms, "sodium is low, give 3 nacl in the ward")).toBeCloseTo(0.667, 3); // ICU absent -> 2/3
    expect(termRecall([], "anything")).toBeNull();
  });
});
