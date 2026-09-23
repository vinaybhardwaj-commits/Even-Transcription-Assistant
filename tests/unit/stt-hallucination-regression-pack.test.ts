/**
 * STT hallucination regression pack (Fable, 23 Sep 2026, ~/dev/_fable/orders/STT-HALLUCINATION-PACK.md item 3).
 *
 * The nine fixtures this order names, each asserting the SAME thing in two directions: the collapse rule
 * catches a genuine Whisper "triplicate" loop, AND it never touches text a clinician needs — a dose, a
 * regimen, a distinct instruction that merely resembles a duplicate. Round 1 of this fix (Jaccard on word
 * sets) failed exactly that second half (the swapped-dose finding, case 7); round 2 (identical-after-fold)
 * is what this file pins. SYNTHETIC TEXT ONLY — no real transcript ever appears in this file or is read by
 * it; every clinical-sounding line below is invented for the test.
 */
import { describe, it, expect } from "vitest";
import {
  foldText,
  identicalAfterFold,
  isNumberToken,
  collapsePhraseLoops,
  collapseSegments,
  repeatRatio,
  fourGramFrequency,
  identicalSentenceRuns,
  COLLAPSE_MIN_REPEATS,
  DEDUPE_MAX_GAP_S,
  type CollapseSegment,
} from "@/lib/stt/hallucination-collapse";

const seg = (text: string, start_s: number, end_s: number, over: Partial<CollapseSegment> = {}): CollapseSegment => ({
  text, start_s, end_s, ...over,
});

describe("1 — sticky/looping segment: a genuine Whisper triplicate collapses, and only the loop", () => {
  it("a phrase repeated well past the 3x floor collapses to one instance; the sentence around it survives untouched", () => {
    const looped = "The patient reports the pain is getting worse the pain is getting worse the pain is getting worse today.";
    const out = collapsePhraseLoops(looped);
    expect(out).toBe("The patient reports the pain is getting worse today.");
    // Idempotent: collapsing the already-collapsed text changes nothing (the round-2 Refuter's own fuzz check).
    expect(collapsePhraseLoops(out)).toBe(out);
  });

  it("exactly at the floor (3x) collapses; 2x — not yet a loop by this rule — does not", () => {
    expect(collapsePhraseLoops("take rest take rest take rest now")).toBe("take rest now");
    expect(collapsePhraseLoops("take rest take rest now")).toBe("take rest take rest now");
    expect(COLLAPSE_MIN_REPEATS).toBe(3);
  });
});

describe("2 — one second of silence: nothing to collapse, never mistaken for a loop", () => {
  it("empty text (a silent segment's decode) passes through unchanged, not as an error", () => {
    expect(collapsePhraseLoops("")).toBe("");
    expect(collapsePhraseLoops(null)).toBe("");
    expect(repeatRatio("")).toBe(0);
    expect(fourGramFrequency("").size).toBe(0);
  });

  it("a silent segment (no text) is KEPT by cross-segment dedupe, never compared or dropped as a duplicate", () => {
    const silent = seg("", 10, 11);
    const speech = seg("blood pressure is normal today", 11, 14);
    const { kept, dropped } = collapseSegments([speech, silent, speech]);
    // The silent row breaks adjacency: the two real segments are not NEIGHBOURS any more, so neither drops.
    expect(kept).toHaveLength(3);
    expect(dropped).toBe(0);
  });
});

describe("3 — repeat_ratio stays low on clean speech (the false-positive floor for item 1's live measurement)", () => {
  it("an ordinary multi-sentence clinical note: repeat_ratio <= ~0.11", () => {
    const clean =
      "The patient came in with a mild fever and a sore throat since Tuesday. " +
      "Blood pressure and pulse were both within the normal range at rest. " +
      "I have advised plenty of fluids, rest, and a follow-up visit if the fever persists past three days.";
    const r = repeatRatio(clean);
    expect(r).toBeLessThanOrEqual(0.11);
    expect(r).toBeGreaterThanOrEqual(0);
  });

  it("a genuine loop sits far above that floor — the measure actually separates the two classes it exists to separate", () => {
    const looped = "the pain is getting worse the pain is getting worse the pain is getting worse the pain is getting worse";
    expect(repeatRatio(looped)).toBeGreaterThan(0.5);
    expect(repeatRatio(looped)).toBeGreaterThan(repeatRatio("the patient reports the pain is worse than yesterday"));
  });
});

describe("4 — identical-sentence runs: the longest back-to-back repeat, distinct sentences never counted", () => {
  it("three identical sentences in a row is a run of 3; a fourth, different, sentence ends the run", () => {
    const text = "Follow up in two weeks. Follow up in two weeks. Follow up in two weeks. Continue the same dose.";
    expect(identicalSentenceRuns(text)).toBe(3);
  });

  it("no repeat at all is a run of 1 (or 0 for no sentences) — never mistaken for a loop", () => {
    expect(identicalSentenceRuns("Blood pressure is normal. Pulse is regular.")).toBe(1);
    expect(identicalSentenceRuns("")).toBe(0);
  });
});

describe("5 — 4-gram frequency: names the exact phrase that is looping, for a human to read", () => {
  it("the repeated 4-word span is the highest-count gram; a clean sentence has no gram above count 1", () => {
    const looped = "the pain is getting worse the pain is getting worse the pain is getting worse today please advise";
    const freq = fourGramFrequency(looped);
    const [topGram, topCount] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]!;
    expect(topGram).toBe("the pain is getting");
    expect(topCount).toBeGreaterThanOrEqual(3);

    const clean = fourGramFrequency("the patient reports mild pain today and asks for a follow up next week");
    expect(Math.max(...clean.values())).toBe(1);
  });
});

describe("6 — a loop that transitions into new content: only the loop collapses, the new content is kept whole", () => {
  it("repeated preamble collapses; the distinct clinical content after it is untouched, word for word", () => {
    const text =
      "okay okay okay okay so the patient the patient the patient reports two episodes of dizziness " +
      "this week and asks whether the current dose of the blood pressure medication should be reviewed.";
    const out = collapsePhraseLoops(text);
    expect(out).toBe(
      "okay so the patient reports two episodes of dizziness " +
      "this week and asks whether the current dose of the blood pressure medication should be reviewed."
    );
    expect(out).toContain("two episodes of dizziness");
    expect(out).toContain("blood pressure medication should be reviewed");
  });
});

describe("7 — the swapped-dose pair: THE regression round 1 shipped (never merge distinct dosing lines)", () => {
  const a = seg("Take 2 tablets in the morning and 1 tablet at night.", 0, 4);
  const b = seg("Take 1 tablet in the morning and 2 tablets at night.", 4, 8);

  it("the two lines are NOT identical after folding — the only test that matters", () => {
    expect(identicalAfterFold(a.text, b.text)).toBe(false);
  });

  it("cross-segment dedupe KEEPS both, even directly adjacent with no gap — this is the finding, pinned", () => {
    const { kept, dropped } = collapseSegments([a, b]);
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(0);
    expect(kept[0]!.text).toBe(a.text);
    expect(kept[1]!.text).toBe(b.text);
  });

  it("a genuinely identical pair (a true loop, not a swap) still collapses — the rule is not disabled, just narrowed", () => {
    const c = seg("Take 2 tablets in the morning and 1 tablet at night.", 4.5, 8.5); // within DEDUPE_MAX_GAP_S of a's end
    const { kept, dropped } = collapseSegments([a, c]);
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(1);
  });
});

describe("8 — the 1-1-1 regimen: a spoken number repeated 3x is a DOSE, never a loop", () => {
  it("\"one one one\" survives collapsePhraseLoops untouched — this is FINDING 2 from the round-2 Refuter, pinned", () => {
    expect(collapsePhraseLoops("take one one one after food")).toBe("take one one one after food");
    expect(collapsePhraseLoops("take two two two tablets")).toBe("take two two two tablets");
  });

  it("digits get the same exemption as spelled-out numbers", () => {
    expect(collapsePhraseLoops("take 1 1 1 after food")).toBe("take 1 1 1 after food");
  });

  it("the SAME word repeated 3x is still collapsed when it is NOT a number — the exemption is number-specific", () => {
    expect(collapsePhraseLoops("okay okay okay please continue")).toBe("okay please continue");
  });

  it("isNumberToken recognises the regimen word directly, case-insensitively", () => {
    expect(isNumberToken("one")).toBe(true);
    expect(isNumberToken("ONE")).toBe(true);
    expect(isNumberToken("1")).toBe(true);
    expect(isNumberToken("today")).toBe(false);
  });
});

describe("9 — a Hindi and a Kannada dose number, repeated 3x, survive — the exemption is not English-only", () => {
  it("Hindi \"ek ek ek\" (one one one), romanised and in Devanagari, is exempt", () => {
    expect(collapsePhraseLoops("khana ke baad ek ek ek goli lein")).toBe("khana ke baad ek ek ek goli lein");
    expect(collapsePhraseLoops("khana ke baad एक एक एक गोली लें")).toBe("khana ke baad एक एक एक गोली लें");
  });

  it("Kannada \"ondu ondu ondu\" (one one one), romanised and in Kannada script, is exempt", () => {
    expect(collapsePhraseLoops("oota aada mele ondu ondu ondu mathre thegodi")).toBe(
      "oota aada mele ondu ondu ondu mathre thegodi"
    );
    expect(collapsePhraseLoops("oota aada mele ಒಂದು ಒಂದು ಒಂದು mathre thegodi")).toBe(
      "oota aada mele ಒಂದು ಒಂದು ಒಂದು mathre thegodi"
    );
  });

  it("a non-number Kannada word repeated 3x in the same sentence still collapses — again, the exemption is specific", () => {
    expect(collapsePhraseLoops("thegodi thegodi thegodi eradu mathre")).toBe("thegodi eradu mathre");
  });
});

describe("cross-cutting: DEDUPE_MAX_GAP_S and folding, pinned once so the fixtures above rest on a fixed floor", () => {
  it("adjacent, same speaker, gap exactly at the floor still merges; one tick over does not", () => {
    const p = seg("please repeat that", 0, 1);
    const atFloor = seg("please repeat that", 1 + DEDUPE_MAX_GAP_S, 3);
    const overFloor = seg("please repeat that", 1 + DEDUPE_MAX_GAP_S + 0.01, 3);
    expect(collapseSegments([p, atFloor]).dropped).toBe(1);
    expect(collapseSegments([p, overFloor]).dropped).toBe(0);
  });

  it("a different NAMED speaker blocks the merge even when the text is identical and adjacent", () => {
    const doctor = seg("please repeat that", 0, 1, { speaker: "doctor" });
    const patient = seg("please repeat that", 1, 2, { speaker: "patient" });
    expect(collapseSegments([doctor, patient]).dropped).toBe(0);
  });

  it("folding is case/punctuation/whitespace only — it never merges two different words", () => {
    expect(foldText("  Take   2 tablets, twice-daily!  ")).toBe("take 2 tablets twice daily"); // the hyphen folds to a space, same as the router's PUNCT_FOLD range
    expect(identicalAfterFold("one tablet", "two tablets")).toBe(false);
  });

  it("fold DOES equate case and trailing punctuation — the positive half of the fold test, not just the negative", () => {
    expect(identicalAfterFold("Take rest.", "take rest")).toBe(true);
    expect(identicalAfterFold("BLOOD PRESSURE IS NORMAL", "blood pressure is normal!")).toBe(true);
  });

  it("a gap strictly between the floor and a loose one (5s) does NOT merge — the floor is 1.5s, not merely 'eventually'", () => {
    const p = seg("please repeat that", 0, 1);
    const midGap = seg("please repeat that", 1 + 5, 3 + 5);
    expect(collapseSegments([p, midGap]).dropped).toBe(0);
  });

  it("one side missing a speaker never blocks the merge — only two DIFFERENT named speakers do", () => {
    const named = seg("please repeat that", 0, 1, { speaker: "doctor" });
    const unnamed = seg("please repeat that", 1, 2); // no speaker field at all
    expect(collapseSegments([named, unnamed]).dropped).toBe(1);
    expect(collapseSegments([unnamed, named]).dropped).toBe(1);
  });

  it("a multi-word number phrase repeated 3x is exempt too — the exemption is not single-word-only", () => {
    expect(collapsePhraseLoops("take twenty five twenty five twenty five tablets")).toBe(
      "take twenty five twenty five twenty five tablets"
    );
  });
});
