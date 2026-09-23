/**
 * assembled-collapse.test.ts — the loop collapse on assembled text and on Indic engine output.
 *
 * The cases are the ones the production measurement and the ruling named: three short segments joined
 * into a loop (the residual this was built for), an Indic loop that must collapse now that it is in
 * scope, an Indic dose line repeated three times that must NOT, two different dose lines that must
 * never merge, and idempotence. All text here is synthetic.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NUMBER_WORDS,
  NUMBER_WORDS_SHA,
  collapseAssembled,
  collapseLine,
  foldText,
  isNumberToken,
  joinAndCollapse,
} from "@/lib/stt/assembled-collapse";

// Native-script fixtures by code point, so the file reads the same in every editor.
const HI_FIFTY = "पचास";                       // पचास (50)
const HI_TWO = "दो";                                      // दो (2)
const KN_QUARTER = "ಕಾಲು";                      // ಕಾಲು (quarter)
const KN_TABLET = "ಗುಳಿಗೆ";           // ಗುಳಿಗೆ (tablet)
const KN_COUGH = "ಕೆಮ್ಮು";            // ಕೆಮ್ಮು (cough)
const HI_FEVER = "बुखार";                  // बुखार (fever)

describe("the lexicon it is given", () => {
  it("carries the shared 772-word list, and its recorded hash is recomputable from the words", () => {
    const raw = JSON.parse(readFileSync("lib/stt/number-words.json", "utf8")) as { words: string[]; lexicon_sha256: string; count: number };
    expect(raw.count).toBe(raw.words.length);
    expect(NUMBER_WORDS.size).toBe(raw.count);
    const recomputed = createHash("sha256").update([...raw.words].sort().join("\n")).digest("hex").slice(0, 16);
    expect(recomputed).toBe(raw.lexicon_sha256);
    expect(NUMBER_WORDS_SHA).toBe(raw.lexicon_sha256);
  });

  it("knows numbers in both scripts, digits of any script, and vulgar fractions", () => {
    for (const w of ["one", "pachas", HI_FIFTY, "aivattu", KN_QUARTER, "dedh", "1-0-1", "½", "२५", "500"]) {
      expect(isNumberToken(w), w).toBe(true);
    }
    // A joined token whose PARTS are number words but whose whole is not: only the split finds it.
    expect(isNumberToken("ek-ek")).toBe(true);
    expect(isNumberToken("one/two")).toBe(true);
    for (const w of ["tablet", KN_TABLET, KN_COUGH, "follow-up", "and/or", ""]) {
      expect(isNumberToken(w), w).toBe(false);
    }
  });
});

describe("the residual this was built for: three short segments joined", () => {
  it("collapses a word repeated across three segments once they are one line", () => {
    const segments = ["accha", "accha", "accha"];
    // Each segment on its own is loop-free — which is why the per-segment collapse never saw it.
    for (const s of segments) expect(collapseLine(s)).toBe(s);
    const r = joinAndCollapse(segments);
    expect(r.text).toBe("accha");
    expect(r.changed).toBe(true);
    expect(r.units_collapsed).toBe(1);
  });

  it("leaves two of the same segment alone — two is not a loop", () => {
    expect(joinAndCollapse(["accha", "accha"]).text).toBe("accha accha");
    // Inside a longer line too, where the short-line early return cannot hide the rule.
    expect(collapseLine("accha accha theek hai")).toBe("accha accha theek hai");
    expect(collapseLine("take rest take rest and drink water")).toBe("take rest take rest and drink water");
  });

  it("does not collapse a number repeated across segments: that is a regimen", () => {
    expect(joinAndCollapse(["one", "one", "one"]).text).toBe("one one one");
    expect(joinAndCollapse([HI_TWO, HI_TWO, HI_TWO]).text).toBe(`${HI_TWO} ${HI_TWO} ${HI_TWO}`);
  });
});

describe("Indic engine output, in scope for the first time", () => {
  it("an Indic loop collapses", () => {
    const line = `${KN_COUGH} ${KN_COUGH} ${KN_COUGH} ${KN_TABLET}`;
    expect(collapseLine(line)).toBe(`${KN_COUGH} ${KN_TABLET}`);
    const hindi = `${HI_FEVER} ${HI_FEVER} ${HI_FEVER}`;
    expect(collapseLine(hindi)).toBe(HI_FEVER);
  });

  it("an Indic dose line repeated three times survives", () => {
    const dose = `${HI_FIFTY} milligram`;
    const r = collapseAssembled([dose, dose, dose].join("\n"));
    expect(r.text).toBe([dose, dose, dose].join("\n"));
    expect(r.changed).toBe(false);
    // and on one line, as the join would produce it
    expect(collapseLine([dose, dose, dose].join(" "))).toBe([dose, dose, dose].join(" "));
  });

  it("a Kannada quarter-tablet instruction repeated three times survives", () => {
    const line = `${KN_QUARTER} ${KN_TABLET}`;
    expect(collapseLine([line, line, line].join(" "))).toBe([line, line, line].join(" "));
  });

  it("two different dose lines never merge", () => {
    const a = `${HI_FIFTY} milligram subah`;
    const b = `${HI_TWO} tablet raat`;
    const r = collapseAssembled([a, b].join("\n"));
    expect(r.text).toBe([a, b].join("\n"));
    expect(r.lines_dropped).toBe(0);
    // English dose pair, the swapped-dose shape that a fuzzy rule merged once
    const c = "take 2 tablets in the morning and 1 tablet at night";
    const d = "take 1 tablet in the morning and 2 tablets at night";
    expect(collapseAssembled([c, d].join("\n")).text).toBe([c, d].join("\n"));
  });
});

describe("assembled text", () => {
  it("drops a line identical after folding to the line before it", () => {
    const r = collapseAssembled(["Please take rest.", "please take rest", "come back next week"].join("\n"));
    expect(r.text).toBe(["Please take rest.", "come back next week"].join("\n"));
    expect(r.lines_dropped).toBe(1);
  });

  it("keeps a repeated line that holds a number", () => {
    const line = "1-0-1 after food";
    expect(collapseAssembled([line, line].join("\n")).lines_dropped).toBe(0);
  });

  it("keeps a non-adjacent repeat: that is the same instruction said twice", () => {
    const lines = ["take rest", "drink water", "take rest"];
    expect(collapseAssembled(lines.join("\n")).text).toBe(lines.join("\n"));
  });

  it("counts what it did, and reports changed:false when it did nothing", () => {
    const clean = "how long have you had this cough\nabout two weeks";
    const r = collapseAssembled(clean);
    expect(r).toMatchObject({ text: clean, units_collapsed: 0, lines_dropped: 0, changed: false });
    expect(collapseAssembled("").changed).toBe(false);
    expect(collapseAssembled(null).text).toBe("");
  });

  it("folds case, punctuation and the danda, but not Indic vowel signs", () => {
    expect(foldText("Yes.")).toBe("yes");
    expect(foldText(`${HI_FEVER}।`)).toBe(HI_FEVER);
    // क and का differ by a vowel sign and must not fold together
    expect(foldText("क")).not.toBe(foldText("का"));
  });
});

describe("idempotence", () => {
  const bodies = [
    ["accha", "accha", "accha", "theek hai"].join(" "),
    `${KN_COUGH} ${KN_COUGH} ${KN_COUGH} ${KN_TABLET}`,
    ["Please take rest.", "please take rest", "one one one"].join("\n"),
    "okay okay okay sir okay okay okay sir okay okay okay sir",
    `${HI_FIFTY} milligram ${HI_FIFTY} milligram ${HI_FIFTY} milligram`,
    "",
  ];

  it("running it twice changes nothing", () => {
    for (const body of bodies) {
      const once = collapseAssembled(body);
      const twice = collapseAssembled(once.text);
      expect(twice.text, body.slice(0, 20)).toBe(once.text);
      expect(twice.changed, body.slice(0, 20)).toBe(false);
    }
  });

  it("a nested loop reaches its fixed point in one call", () => {
    // "okay sir" x3 only appears after "okay" x3 collapses, so one pass must keep going.
    expect(collapseLine("okay okay okay sir okay okay okay sir okay okay okay sir")).toBe("okay sir");
  });
});
