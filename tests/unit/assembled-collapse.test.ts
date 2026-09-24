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
  MAX_PHRASE_WORDS,
  NUMBER_EXEMPT_FRACTION,
  NUMBER_WORDS,
  NUMBER_WORDS_SHA,
  collapseAcrossLines,
  collapseAssembled,
  collapseLine,
  foldText,
  isNumberExemptUnit,
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

describe("Y4 — matching is EXACT after folding, never fuzzy", () => {
  // A word-set or similarity rule merged "2 in the morning and 1 at night" with its dose swap once
  // (refuted 22 Sep). These cases all have high overlap and are NOT identical after folding, so a
  // looser matcher would collapse them and fail here — which is the point of the test.
  it("lines differing by one token are both kept", () => {
    const pairs: Array<[string, string]> = [
      ["blood pressure is 140 over 90 today", "blood pressure is 140 over 80 today"],
      ["continue the same tablet every morning", "continue the same tablet every night"],
      ["no pain today yes", "yes pain today no"],                      // same word set, different order
      ["review after two weeks", "review after two weeks if worse"],   // one is a prefix of the other
    ];
    for (const [a, b] of pairs) {
      const r = collapseAssembled([a, b].join("\n"));
      expect(r.text, `${a} / ${b}`).toBe([a, b].join("\n"));
      expect(r.lines_dropped, `${a} / ${b}`).toBe(0);
    }
  });

  it("three near-identical units in a row are kept — only identical ones collapse", () => {
    // Number-free phrases, so this isolates exactness: the number exemption is tested elsewhere and
    // would otherwise protect these for the wrong reason.
    const near = "swelling in the left ankle swelling in the right ankle swelling in the upper ankle";
    expect(collapseLine(near)).toBe(near);
    const exact = "swelling in the left ankle swelling in the left ankle swelling in the left ankle";
    expect(collapseLine(exact)).toBe("swelling in the left ankle");
  });

  it("but folding-equal IS a match: case, punctuation, danda and spacing do not save a duplicate", () => {
    const r = collapseAssembled(["Please take rest.", "  PLEASE   take rest  ", "next week"].join("\n"));
    expect(r.lines_dropped).toBe(1);
    expect(collapseLine("theek hai Theek hai. theek  hai")).toBe("theek hai");
  });
});

describe("the English translation gets the same treatment", () => {
  it("a looped translation collapses", () => {
    const looped = "take rest and drink water take rest and drink water take rest and drink water";
    expect(collapseLine(looped)).toBe("take rest and drink water");
    const lines = ["Patient has fever.", "patient has fever", "Advised paracetamol."];
    expect(collapseAssembled(lines.join("\n")).text).toBe(["Patient has fever.", "Advised paracetamol."].join("\n"));
  });

  it("a translated dose repeated three times survives", () => {
    const dose = "fifty milligram twice daily";
    expect(collapseLine([dose, dose, dose].join(" "))).toBe([dose, dose, dose].join(" "));
    expect(collapseAssembled([dose, dose].join("\n")).lines_dropped).toBe(0);
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


// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// 24 Sep (Fable rulings 116 and 141): three gaps that together let 13 of 168 production loops through.
// All text below is synthetic. Clinical content beats dedupe: repeated numbers and dosing are NEVER removed.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Letters only, on purpose: a token with a digit in it is number-exempt (ruling 141), which would hide the rule under test.
const letters = (i: number): string => { let s = ""; let x = i; do { s = String.fromCharCode(97 + (x % 26)) + s; x = Math.floor(x / 26); } while (x > 0); return s; };
const words = (n: number, tag = "w") => Array.from({ length: n }, (_, i) => `${tag}${letters(i)}`);
const rep = (unit: string[], times: number) => Array.from({ length: times }, () => unit.join(" ")).join(" ");

describe("gap 1 — units of 9-12 words", () => {
  it("the longest unit considered is 12 words", () => {
    expect(MAX_PHRASE_WORDS).toBe(12);
  });
  it("a 9-word and a 12-word phrase repeated 3 times collapse to one copy", () => {
    for (const n of [9, 12]) {
      const unit = words(n);
      expect(collapseLine(rep(unit, 3)), `n=${n}`).toBe(unit.join(" "));
    }
  });
  it("a 13-word phrase repeated 3 times is left alone: past the limit", () => {
    const line = rep(words(13), 3);
    expect(collapseLine(line)).toBe(line);
  });
});

describe("gap 2 — a loop whose repeats strain across a line break", () => {
  it("collapses a 6-word phrase said 10 times over three lines, keeping ONE copy", () => {
    const unit = words(6);
    const all = Array.from({ length: 10 }, () => unit).flat();
    const lines = [all.slice(0, 14).join(" "), all.slice(14, 41).join(" "), all.slice(41).join(" ")];
    const r = collapseAssembled(lines.join("\n"));
    expect(r.text.split(/\s+/).filter(Boolean)).toEqual(unit);
    expect(r.changed).toBe(true);
  });
  it("keeps the layout: an untouched line comes back byte-identical, blank lines stay, an emptied line goes", () => {
    const unit = words(5);
    const stream = Array.from({ length: 4 }, () => unit).flat(); // 20 words: the unit four times
    const odd = "  spaced   oddly\tline  ";
    // the loop is cut at arbitrary points: 7 + 7 + 6 words over three lines
    const lines = [odd, "", stream.slice(0, 7).join(" "), stream.slice(7, 14).join(" "), stream.slice(14).join(" "), "tail line stays"];
    const r = collapseAcrossLines(lines);
    expect(r.lines).toEqual([odd, "", unit.join(" "), "tail line stays"]);
    expect(r.lines[0]).toBe(odd); // byte-identical, odd spacing and all
    expect(r.touched).toBe(3); // the line that kept the first copy, and the two that lost every word
  });
  it("a cross-line collapse is COUNTED in units_collapsed (it is stored on the run row), and reported as changed", () => {
    const unit = words(5);
    const stream = Array.from({ length: 4 }, () => unit).flat();
    // no single line holds 3 repeats, so only stage 3 can see it
    const lines = [stream.slice(0, 7).join(" "), stream.slice(7, 14).join(" "), stream.slice(14).join(" ")];
    const r = collapseAssembled(lines.join("\n"));
    expect(r.text).toBe(unit.join(" "));
    expect(r).toMatchObject({ units_collapsed: 3, lines_dropped: 0, changed: true });
  });
  it("returns the lines untouched when there is no loop", () => {
    const lines = ["how long have you had this", "", "about two weeks now"];
    expect(collapseAcrossLines(lines)).toEqual({ lines, touched: 0 });
  });
  it("a loop in one line only is still handled by the per-line stage, and counted once", () => {
    const unit = words(4);
    const r = collapseAssembled(["before", rep(unit, 3), "after"].join("\n"));
    expect(r.text).toBe(["before", unit.join(" "), "after"].join("\n"));
    expect(r.units_collapsed).toBe(1);
  });
});

describe("gap 3 — the number exemption: digits are NEVER removed; number words protect only when they are a third of the unit", () => {
  it("the fraction is one third", () => {
    expect(NUMBER_EXEMPT_FRACTION).toBe(1 / 3);
  });
  it("a long phrase that merely holds an everyday number word (do, one, half) now collapses", () => {
    for (const nw of ["do", "one", "half"]) {
      const unit = ["please", "wait", nw, "moment", "before", "you", "leave"]; // 1 number word in 7
      expect(collapseLine(rep(unit, 3)), nw).toBe(unit.join(" "));
    }
  });
  it("a unit containing a DIGIT is never collapsed, however small a share of it, in one line or across lines", () => {
    const unit = ["take", "2", "tablets", "in", "the", "morning", "and", "rest", "well", "today"]; // 1 digit in 10
    const line = rep(unit, 3);
    expect(collapseLine(line)).toBe(line);
    const lines = [unit.join(" "), unit.join(" "), unit.join(" ")];
    expect(collapseAssembled(lines.join("\n")).text).toBe(lines.join("\n"));
    // the loop that strains across a break, with the digit inside it
    const split = [line.split(" ").slice(0, 13).join(" "), line.split(" ").slice(13).join(" ")];
    expect(collapseAssembled(split.join("\n")).text).toBe(split.join("\n"));
    // and Indic digits
    const hi = ["गोली", "२", "सुबह", "आराम", "करें"];
    expect(collapseLine(rep(hi, 3))).toBe(rep(hi, 3));
  });
  it("a digit dose is never collapsed in ANY script: a table over the scripts this app serves (ETA-Refuter F1)", () => {
    // Code points, so the file reads the same in every editor. Each is the digit five, from a different Unicode Nd block.
    const FIVES: Array<[string, string]> = [
      ["ASCII", "5"], ["Devanagari", "\u096B"], ["Kannada", "\u0CEB"], ["Tamil", "\u0BEB"], ["Telugu", "\u0C6B"],
      ["Gujarati", "\u0AEB"], ["Bengali", "\u09EB"], ["Malayalam", "\u0D6B"], ["Gurmukhi", "\u0A6B"], ["Arabic-Indic", "\u0665"],
      ["fullwidth", "\uFF15"],
    ];
    for (const [script, five] of FIVES) {
      // a dose phrase, and a long phrase in which the digit is a tiny share (so only the DIGIT rule can protect it)
      const dose = ["take", five, "mg", "daily"];
      const long = ["please", "take", five, "drops", "in", "the", "affected", "eye", "twice", "today"];
      for (const unit of [dose, long]) {
        const line = rep(unit, 3);
        expect(collapseLine(line), `${script}: ${unit.join(" ")}`).toBe(line);
        expect(isNumberExemptUnit(unit), script).toBe(true);
        // and across a line break
        const split = [line.split(" ").slice(0, Math.ceil(line.split(" ").length / 2)).join(" "), line.split(" ").slice(Math.ceil(line.split(" ").length / 2)).join(" ")];
        expect(collapseAssembled(split.join("\n")).text, `${script} across lines`).toBe(split.join("\n"));
      }
    }
    // letter-numbers and vulgar fractions carry protection too (\p{Nl}, \p{No})
    for (const glyph of ["\u00BD", "\u00BC", "\u2167"]) {
      const line = rep(["take", glyph, "tablet", "after", "food"], 3);
      expect(collapseLine(line), glyph).toBe(line);
    }
  });
  it("1.5 and 15 are different doses: the punctuation-deleting fold must never let them merge", () => {
    const a = rep(["take", "1.5", "mg", "daily"], 3);
    expect(collapseLine(a)).toBe(a);
    const mixed = "take 1.5 mg daily take 15 mg daily take 1.5 mg daily";
    expect(collapseLine(mixed)).toBe(mixed);
    const across = ["take 1.5 mg daily take 1.5 mg", "daily take 1.5 mg daily"].join("\n");
    expect(collapseAssembled(across).text).toBe(across);
  });
  it("short dose phrases stay: number words are at least a third of the unit", () => {
    for (const unit of [["ek", "goli", "subah"], [HI_FIFTY, "milligram"], [KN_QUARTER, KN_TABLET], ["do", "goli"], ["half", "tablet", "daily", "after", "food", "please"]]) {
      // (the last unit is 1 in 6: NOT exempt — see below; the first four are)
      if (unit.length === 6) continue;
      expect(collapseLine(rep(unit, 3)), unit.join(" ")).toBe(rep(unit, 3));
    }
  });
  it("the boundary is exact: 1 in 3 is exempt, 1 in 4 collapses; 2 in 6 is exempt, 1 in 6 collapses", () => {
    expect(isNumberExemptUnit(["ek", "goli", "subah"])).toBe(true);
    expect(isNumberExemptUnit(["do", "not", "worry", "please"])).toBe(false);
    expect(isNumberExemptUnit(["ek", "goli", "aur", "do", "goli", "raat"])).toBe(true);
    expect(isNumberExemptUnit(["please", "do", "come", "back", "next", "week"])).toBe(false);
    expect(isNumberExemptUnit([])).toBe(false);
    // digits protect at any share
    expect(isNumberExemptUnit([..."abcdefghij"].map((c, i) => (i === 4 ? "5" : c)))).toBe(true);
  });
  it("a single number word repeated is still a regimen (unchanged)", () => {
    expect(collapseLine("one one one")).toBe("one one one");
    expect(collapseLine(`${HI_TWO} ${HI_TWO} ${HI_TWO} ${HI_TWO}`)).toBe(`${HI_TWO} ${HI_TWO} ${HI_TWO} ${HI_TWO}`);
    expect(collapseLine("1 1 1 1")).toBe("1 1 1 1");
  });
});

// A small seeded generator, so a failure names its seed and is reproducible.
function rng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const VOCAB = ["take", "rest", "water", "please", "wait", "again", "fever", "cough", "night", "morning", "do", "one", "half", "ek", "goli", "2", "500", "1-0-1", "mg"];
function synth(seed: number): string {
  const r = rng(seed);
  const lines: string[] = [];
  for (let l = 0, nl = 2 + Math.floor(r() * 6); l < nl; l++) {
    const line: string[] = [];
    for (let k = 0, n = 1 + Math.floor(r() * 14); k < n; k++) {
      const unit = Array.from({ length: 1 + Math.floor(r() * 6) }, () => VOCAB[Math.floor(r() * VOCAB.length)]);
      const times = r() < 0.4 ? 3 + Math.floor(r() * 3) : 1;
      for (let t = 0; t < times; t++) line.push(...unit);
    }
    lines.push(r() < 0.1 ? "" : line.join(" "));
  }
  return lines.join("\n");
}
const digitTokens = (t: string) => t.split(/\s+/).filter((w) => /\p{N}/u.test(w)).sort();

describe("properties over 400 seeded texts (a failure prints its seed)", () => {
  it("never removes a token that carries a digit; only ever removes words; is idempotent", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const text = synth(seed);
      const out = collapseAssembled(text).text;
      // digits: the multiset of digit-bearing tokens is unchanged (Fable ruling 141)
      expect(digitTokens(out), `digit tokens, seed ${seed}`).toEqual(digitTokens(text));
      // only removal: every output word is an input word
      const bag = new Map<string, number>();
      for (const w of text.split(/\s+/).filter(Boolean)) bag.set(w, (bag.get(w) ?? 0) + 1);
      for (const w of out.split(/\s+/).filter(Boolean)) {
        const c = (bag.get(w) ?? 0) - 1;
        expect(c, `added word ${w}, seed ${seed}`).toBeGreaterThanOrEqual(0);
        bag.set(w, c);
      }
      // idempotent
      expect(collapseAssembled(out).text, `idempotent, seed ${seed}`).toBe(out);
    }
  });
  it("text with no repeated unit at all comes back byte-identical, odd spacing and blank lines included", () => {
    const text = "  first   line here\n\nsecond\tline different words\n third line  entirely new ";
    expect(collapseAssembled(text)).toMatchObject({ text, changed: false, units_collapsed: 0, lines_dropped: 0 });
  });
});

describe("skipping a protected run must not change any RESULT (only the time)", () => {
  it("a collapsible run that starts inside the LAST word of a protected run is still collapsed", () => {
    // The digit-protected run is "1.5 wait" x4. The waits that follow begin a run of their own, overlapping its last word.
    // Skipping the whole protected run would have missed it. Expected value = what the version before the skip produced.
    const line = "1.5 wait 1.5 wait 1.5 wait 1.5 wait wait wait wait wait wait wait wait a night cough";
    expect(collapseLine(line)).toBe("1.5 wait 1.5 wait 1.5 wait 1.5 wait wait a night cough");
  });

  it("copies that differ only in RAW form (a joiner, trailing punctuation) are protected one window and not the next: no skip across them (ETA-Refuter #550)", () => {
    // "one-more" counts as a number word (isNumberToken splits on - and / first), "onemore" does not; both fold to the same token.
    expect(collapseLine("wait one-more wait one-more wait onemore wait onemore wait onemore")).toBe("wait one-more wait one-more wait onemore");
    // the length test counts punctuation: "abc de" is 6 characters (too short to trust), "abc!!! de" is 9
    expect(collapseLine("abc de abc de abc!!! de abc!!! de abc!!! de")).toBe("abc de abc de abc!!! de");
  });

  // The plain algorithm, stepping ONE word at a time, as the guard did before the skip. Same rules and constants.
  const PUNCT_RE = /[!-/:-@[-`{-~\u0964\u0965]/gu;
  const fold = (w: string) => w.toLowerCase().replace(PUNCT_RE, "");
  function referenceCollapseLine(line: string): string {
    let cur = line.split(/\s+/u).filter(Boolean);
    const original = cur;
    for (let guard = 0; guard < 16; guard++) {
      if (cur.length < 3) break;
      let changed = false;
      for (let plen = Math.min(Math.floor(cur.length / 3), MAX_PHRASE_WORDS); plen >= 1 && !changed; plen--) {
        const out: string[] = [];
        let i = 0;
        while (i < cur.length) {
          const unit = cur.slice(i, i + plen);
          if (unit.length < plen) { out.push(...cur.slice(i)); break; }
          let count = 1, j = i + plen;
          while (j + plen <= cur.length && cur.slice(j, j + plen).every((w, k) => fold(w) === fold(unit[k]!))) { count++; j += plen; }
          const longEnough = plen === 1 ? unit[0]!.replace(PUNCT_RE, "").length >= 3 : unit.join(" ").length >= 8;
          if (count >= 3 && longEnough && !isNumberExemptUnit(unit)) { out.push(...unit); i = j; changed = true; continue; }
          out.push(cur[i]!); i++;
        }
        if (changed) cur = out;
      }
      if (!changed) break;
    }
    return cur === original ? line : cur.join(" ");
  }
  const RV = ["take", "rest", "water", "please", "wait", "again", "fever", "cough", "night", "do", "one", "ek", "goli", "2", "500", "mg", "hello", "1.5", "15", "ok", "a", "five", "half"];
  // A copy of a word in a different RAW form that folds to the same token: trailing punctuation, a joiner inside it, or case.
  const variant = (w: string, r: () => number): string => {
    const k = r();
    if (k < 0.55 || w.length < 2) return w; // most copies stay byte-identical
    if (k < 0.7) return w + ",";
    if (k < 0.8) return w + "!!!";
    if (k < 0.9) return w[0] + "-" + w.slice(1);
    if (k < 0.95) return w[0] + "/" + w.slice(1);
    return w.toUpperCase();
  };
  it("matches the one-word-at-a-time reference on 6,000 seeded lines rich in protected runs AND in copies that vary in raw form", () => {
    for (let seed = 1; seed <= 6000; seed++) {
      const r = rng(seed * 7919);
      const varied = seed > 3000; // the second half varies the copies; the first half is byte-identical loops
      const line: string[] = [];
      for (let k = 0, n = 1 + Math.floor(r() * 12); k < n; k++) {
        const unit = Array.from({ length: 1 + Math.floor(r() * 5) }, () => RV[Math.floor(r() * RV.length)]);
        const times = r() < 0.5 ? 3 + Math.floor(r() * 6) : r() < 0.3 ? 2 : 1;
        for (let x = 0; x < times; x++) line.push(...unit.map((w) => (varied ? variant(w, r) : w)));
      }
      const text = line.join(" ");
      expect(collapseLine(text), `seed ${seed}`).toBe(referenceCollapseLine(text));
    }
  });
});

describe("cost — the LOOP shapes, which are what a hallucination looks like (ETA-Refuter F2)", () => {
  // Measured 24 Sep on the box: a digit-protected 8,000-word loop took ~8.9 s before a protected run was skipped whole
  // (quadratic: each step re-scanned the rest of the run) and ~0.1 s after. The bound is 10x the fixed time, far under the old.
  const loopLine = (period: number, n: number, digit: boolean) => {
    const unit = words(period);
    if (digit) unit[2] = "5";
    return Array.from({ length: Math.ceil(n / period) }, () => unit.join(" ")).join(" ");
  };
  it("a PROTECTED loop (a digit in the unit) of 8,000 words is linear, not quadratic", () => {
    const t0 = Date.now();
    const r = collapseAssembled(loopLine(8, 8000, true));
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.changed).toBe(false); // protected: the digit dose is never removed
  });
  it("a plain loop of 8,000 words collapses to one copy quickly", () => {
    const t0 = Date.now();
    const r = collapseAssembled(loopLine(8, 8000, false));
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.text.split(/\s+/)).toHaveLength(8);
  });
  it("a protected loop that strains across many lines is also linear", () => {
    const ws = loopLine(9, 6000, true).split(" ");
    const lines: string[] = [];
    for (let k = 0; k < ws.length; k += 13) lines.push(ws.slice(k, k + 13).join(" "));
    const t0 = Date.now();
    collapseAssembled(lines.join("\n"));
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it("a 20,000-word text with scattered loops still collapses fast", () => {
    const unit = words(7);
    const body = Array.from({ length: 2000 }, (_, i) => (i % 97 === 0 ? rep(unit, 4) : words(9, `t${letters(i)}z`).join(" "))).join("\n");
    const t0 = Date.now();
    const r = collapseAssembled(body);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.changed).toBe(true);
  });
});
