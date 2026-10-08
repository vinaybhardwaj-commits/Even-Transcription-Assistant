/**
 * S8A4 — the pure pieces: script detection, English alignment (nothing dropped), the drug-name check (proposes, never rewrites), the per-sentence translate plan.
 * No network, no database, no secret.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { detectScript, hasIndicScript } from "@/lib/script-detect";
import { drugCandidates, nameScore, phoneticKey, matchForm, type Lexicon } from "@/lib/drug-match";
import { DRUG_LEXICON } from "@/lib/drug-lexicon";
import { alignEnglish, settleUnpaired, tagNative, addMayura, finalizeEnglish } from "@/lib/jobs/kinds/sarvam-english";
import { planUnits } from "@/lib/jobs/kinds/sarvam-translate";
import type { ResultDoc } from "@/lib/jobs/kinds/sarvam-common";

const base = JSON.parse(readFileSync("data/drug-lexicon.json", "utf8")) as Lexicon;
const lex: Lexicon = DRUG_LEXICON; // the real list (names used in >= 3 Pulse prescriptions) + the curated terms and analytes
const fixtures = JSON.parse(readFileSync("tests/fixtures/name-check-english.json", "utf8")) as { ordinary: string[]; holdout: string[]; final: string[]; consult: string[] };

describe("detectScript", () => {
  it.each([
    ["How are you feeling today", "Latin"], ["ನನಗೆ ತಲೆನೋವು ಇದೆ", "Kannada"], ["मुझे बुखार है", "Devanagari"], ["எனக்கு காய்ச்சல்", "Tamil"], ["నాకు జ్వరం", "Telugu"],
    ["എനിക്ക് പനി", "Malayalam"], ["আমার জ্বর", "Bengali"], ["મને તાવ છે", "Gujarati"], ["ਮੈਨੂੰ ਬੁਖਾਰ ਹੈ", "Gurmukhi"], ["ମୋର ଜ୍ୱର", "Odia"], ["650 mg, 3x", "Latin"], ["123 ,.", "None"],
  ])("%s -> %s", (t, s) => expect(detectScript(t)).toBe(s));
  it("the dominant script wins in a mixed sentence; Latin romanised Kannada is Latin (it proves nothing)", () => {
    expect(detectScript("take paracetamol ತಲೆನೋವು ಇದೆ ಮತ್ತು ಜ್ವರ")).toBe("Kannada");
    expect(detectScript("naanu tale novu ide")).toBe("Latin");
    expect(hasIndicScript("naanu tale novu ide")).toBe(false);
  });
});

describe("alignEnglish / settleUnpaired — a mixed en / kn / hi consult loses no entry from the English track", () => {
  const native = tagNative([
    { speaker_id: "0", start_s: 0, end_s: 5, text: "How are you feeling today" },
    { speaker_id: "1", start_s: 5, end_s: 9, text: "ನನಗೆ ತಲೆನೋವು ಇದೆ" },
    { speaker_id: "1", start_s: 9, end_s: 12, text: "मुझे बुखार है" },
    { speaker_id: "0", start_s: 20, end_s: 22, text: "Take Combiflam" },
    { speaker_id: "0", start_s: 30, end_s: 32, text: "ಮತ್ತೆ ಬನ್ನಿ" },
  ]);
  const pass = [
    { speaker_id: "0", start_s: 0.2, end_s: 4.8, text: "How are you feeling today" },
    { speaker_id: "1", start_s: 5.1, end_s: 8.4, text: "I have a headache" },
    { speaker_id: "1", start_s: 8.6, end_s: 9.4, text: "and" },
    { speaker_id: "1", start_s: 9.5, end_s: 12, text: "I have a fever" },
    { speaker_id: "0", start_s: 14, end_s: 16, text: "Okay, let me check" }, // no native partner at all
  ];

  it("each English entry goes to the native entry it overlaps most; unmatched ones are kept; unpaired natives are settled by script", () => {
    const n = structuredClone(native);
    const { track } = alignEnglish(n, pass);
    expect(track).toHaveLength(5); // nothing dropped
    expect(track.map((t) => t.native_idx)).toEqual([0, 1, 1, 2, null]);
    expect(n[1]!.english).toBe("I have a headache and"); // two English entries on one native entry are joined, in time order
    expect(n[2]!.english).toBe("I have a fever");
    expect(track[4]).toMatchObject({ text: "Okay, let me check", source: "translate_pass", native_idx: null });
    const need = settleUnpaired(n, track);
    expect(n[3]).toMatchObject({ english: "Take Combiflam", english_source: "native_latin" }); // Latin, no partner: kept as English
    expect(need).toEqual([4]); // Kannada, no partner: mayura
    expect(track.filter((t) => t.native_idx === 3)).toHaveLength(1);
    // the native entries themselves are untouched
    expect(n.map((e) => e.text)).toEqual(native.map((e) => e.text));
    expect(n.map((e) => e.script)).toEqual(["Latin", "Kannada", "Devanagari", "Latin", "Kannada"]);
  });

  it("mayura results join the track, and finalize orders it by time, builds the English text and the drug candidates", () => {
    const n = structuredClone(native);
    const { track } = alignEnglish(n, pass);
    const need = settleUnpaired(n, track);
    n[4]!.english = "Come again"; n[4]!.english_source = "mayura";
    addMayura(n, track, need);
    const doc: ResultDoc = { language_code: "en-IN", duration_s: 40, speakers: ["0", "1"], entries: n, transcript: "", english_entries: track };
    finalizeEnglish(doc, lex);
    expect(doc.english_entries!.map((t) => t.start_s)).toEqual([...doc.english_entries!.map((t) => t.start_s)].sort((a, b) => a - b));
    expect(doc.english_entries).toHaveLength(7);
    expect(doc.english).toBe(doc.english_entries!.map((t) => t.text).join(" "));
    expect(doc.english).toContain("Come again");
  });

  it("a native entry with an empty text gets an empty English and needs nothing; a point-like English entry is paired by its midpoint", () => {
    const n = tagNative([{ speaker_id: "0", start_s: 0, end_s: 4, text: "" }, { speaker_id: "0", start_s: 4, end_s: 8, text: "ನಮಸ್ಕಾರ" }]);
    const { track } = alignEnglish(n, [{ speaker_id: "0", start_s: 6, end_s: 6, text: "Hello" }]);
    expect(track[0]!.native_idx).toBe(1);
    expect(settleUnpaired(n, track)).toEqual([]);
    expect(n[0]!.english).toBe("");
  });

  it("Sarvam's per-entry language, when the response carries one, is kept", () => {
    expect(tagNative([{ speaker_id: "0", start_s: 0, end_s: 1, text: "ok", language_code: "kn-IN" }])[0]).toMatchObject({ language_code: "kn-IN", script: "Latin" });
  });
});

describe("drug-name check — proposes, never rewrites", () => {
  const sug = (c: Array<{ suggested: string }>) => c.map((x) => x.suggested.toLowerCase());
  it("\"combat land\" -> Combiflam (matched on \"combat\"), with the entry index, the heard text, a score, the lexicon source and the category", () => {
    const c = drugCandidates("Take combat land twice a day after food", 3, lex);
    expect(c[0]).toEqual({ entry_idx: 3, heard: "combat", suggested: expect.stringMatching(/^combiflam/i), score: expect.any(Number), source: lex.source, category: "drug" });
    expect(c[0]!.score).toBeGreaterThanOrEqual(0.6);
  });
  it("doses and numbers are never part of a candidate: a window touching a digit is skipped, and the function returns no text at all", () => {
    expect(drugCandidates("paracetamol 650 mg three times a day for 5 days", 0, lex)).toEqual([]);
    for (const x of drugCandidates("combat land 500 milligram", 0, lex)) expect(/\d/.test(x.heard)).toBe(false);
  });
  it("a correctly heard name proposes nothing; short tokens (Rx, PX, mg) propose nothing; a name that merely extends a catalog name is not a mis-hearing", () => {
    expect(drugCandidates("Crocin and Dolo and Combiflam", 0, lex)).toEqual([]);
    expect(drugCandidates("PX for fever, Rx given, mg", 0, lex)).toEqual([]);
    expect(drugCandidates("send an ultrasound of the abdomen", 0, lex)).toEqual([]);
  });
  it("deterministic; the matcher helpers behave; pack words and numbers are dropped from a catalog name before matching", () => {
    const a = drugCandidates("started on Bilus M and take combat land", 0, lex);
    expect(a).toEqual(drugCandidates("started on Bilus M and take combat land", 0, lex));
    expect(matchForm("Niftas 100 Mg Tablet")).toBe("niftas");
    expect(matchForm("COMBIFLAM 325mg 400mg TAB")).toBe("combiflam");
    expect(phoneticKey("Combiflam")).toBe(phoneticKey("combiflam"));
    expect(nameScore("zzzz", "Combiflam")).toBe(0);
  });
  it("ADDENDUM 2 against the REAL list — \"IG\" -> IgE, \"Citrus Phthalate\" -> citrate, \"nodrinal\" -> nocturia, \"Bilus M\" -> a Bila* brand", () => {
    const ige = drugCandidates("His IG level is high", 0, lex);
    expect(ige).toContainEqual(expect.objectContaining({ heard: "IG", suggested: "IgE", category: "investigation" })); // a near-tie with IgA / IgM is reported, not guessed
    expect(ige.length).toBeLessThanOrEqual(3);
    expect(sug(drugCandidates("Send the Citrus Phthalate levels in urine", 0, lex))).toContain("citrate");
    expect(drugCandidates("complains of nodrinal since two weeks", 0, lex)).toContainEqual(expect.objectContaining({ heard: "nodrinal", suggested: "nocturia", category: "clinical_term" }));
    const bil = drugCandidates("started on Bilus M at night", 0, lex);
    expect(bil.length).toBeGreaterThan(0);
    expect(bil.every((x) => x.heard === "Bilus" && x.category === "drug" && /^bil/i.test(x.suggested))).toBe(true);
  });
  it("false positives stay rare against the 9,903-name list: 130 ordinary English sentences (3 sets) and an enc_hy24855a22-shaped consult — the numbers", () => {
    const count = (xs: string[]) => xs.filter((t) => drugCandidates(t, 0, lex).length > 0).length;
    const a = count(fixtures.ordinary), b = count(fixtures.holdout), c = count(fixtures.final);
    // measured 09 Oct: 3 / 50, 3 / 50, 0 / 30 (the first set was used to design the context rules; the second was looked at once; the third was written last and never tuned on)
    expect(fixtures.ordinary.length + fixtures.holdout.length + fixtures.final.length).toBe(130);
    expect(a).toBeLessThanOrEqual(4);
    expect(b).toBeLessThanOrEqual(4);
    expect(c).toBeLessThanOrEqual(1);
    expect(a + b + c).toBeLessThanOrEqual(8); // <= ~6 %
    expect(fixtures.consult.filter((t) => drugCandidates(t, 0, lex).some((x) => !/combiflam/i.test(x.suggested))).length).toBe(0); // the consult's own garble-free names: no noise
  });
  it("speed: the real list (~10,000 entries) is bucketed by first sound, 130 sentences take well under a few seconds", () => {
    const t0 = Date.now();
    for (const t of [...fixtures.ordinary, ...fixtures.holdout, ...fixtures.final]) drugCandidates(t, 0, lex);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it("the committed lexicon is names only and sized for a serverless bundle", () => {
    expect(base.names.length).toBeGreaterThan(9000);
    expect(base.investigations!.length).toBeGreaterThan(1000);
    expect(base.source).toMatch(/>= 3 prescriptions/);
    expect(Object.keys(base).sort()).toEqual(["investigations", "names", "source", "version"]);
    for (const n of [...base.names, ...base.investigations!]) { expect(n.length).toBeLessThanOrEqual(260); expect(/^[A-Za-z0-9 -]+$/.test(n)).toBe(true); }
    expect(statSync("data/drug-lexicon.json").size).toBeLessThan(700_000);
    expect(statSync("data/clinical-terms.json").size).toBeLessThan(10_000);
  });
});

describe("sarvam_translate planUnits — the file label is not trusted to say all-English", () => {
  const kn = "ನನಗೆ ತಲೆನೋವು ಇದೆ.";
  it("an en-IN-labelled text with a Kannada sentence: only the Kannada sentence is a translate unit, the English around it is verbatim", () => {
    const u = planUnits(`How are you? ${kn} Take rest.`, "en-IN");
    expect(u.map((x) => x.translate)).toEqual([false, true, false]);
    expect(u[1]!.text).toBe(kn);
  });
  it("an English-only text under an English label has nothing to translate", () => {
    expect(planUnits("How are you? Take rest.", "en-IN").some((x) => x.translate)).toBe(false);
  });
  it("a non-English label (or no label) is one unit, as before", () => {
    expect(planUnits("bukhar hai", null)).toEqual([{ text: "bukhar hai", translate: true }]);
    expect(planUnits("naanu tale novu ide", "kn-IN")).toEqual([{ text: "naanu tale novu ide", translate: true }]);
  });
});

describe("G43 — romanised Indic and checkEnglish (thresholds pinned)", () => {
  it("function words of the five languages score; English does not; ambiguous words do not name a language", async () => {
    const { scoreRomanized, verdictOf, ROMANIZED_RATIO, ROMANIZED_SHORT_RATIO, MIXED_RATIO } = await import("@/lib/romanized-indic");
    expect([ROMANIZED_RATIO, ROMANIZED_SHORT_RATIO, MIXED_RATIO]).toEqual([0.2, 0.3, 0.07]);
    expect(scoreRomanized("mujhe bukhar hai doctor sahab")).toMatchObject({ hits: 3, lang: "hi" });
    expect(scoreRomanized("naanu tumba novu ide illa")).toMatchObject({ lang: "kn" });
    expect(scoreRomanized("mala taap aahe aani khokla pan ahe")).toMatchObject({ lang: "mr" });
    expect(scoreRomanized("enakku romba kaichal irukku")).toMatchObject({ lang: "ta" });
    expect(scoreRomanized("naaku jwaram undi baaga ledu")).toMatchObject({ lang: "te" });
    expect(scoreRomanized("nahi").lang).toBeNull(); // hi and mr both have it
    expect(verdictOf(scoreRomanized("Take the tablet twice a day after food and come back on Friday"))).toBe("english");
    expect(verdictOf(scoreRomanized("mujhe bukhar hai doctor sahab"))).toBe("romanized");
    expect(verdictOf(scoreRomanized("nahi"))).toBe("romanized"); // a 1-word entry that IS an Indic word
    expect(verdictOf(scoreRomanized("The patient says bukhar hai since yesterday and also has a mild cough"))).toBe("mixed");
    expect(verdictOf(scoreRomanized("The patient has a fever and a cough since yesterday and says hai once in the whole long sentence about it"))).toBe("english"); // 1 hit in 20 words (5 %) is below MIXED_RATIO: not flagged
  });
  it("no ordinary English sentence of the three false-positive sets is read as romanised or mixed Indic", async () => {
    const { checkEnglish } = await import("@/lib/jobs/kinds/sarvam-english");
    for (const t of [...fixtures.ordinary, ...fixtures.holdout, ...fixtures.final, ...fixtures.consult]) expect(checkEnglish(t).verdict, t).toBe("english");
  });
  it("checkEnglish: Indic-script letters above 15 % are not English; a little Indic inside English is mixed only through romanised words", async () => {
    const { checkEnglish } = await import("@/lib/jobs/kinds/sarvam-english");
    expect(checkEnglish("ನನಗೆ ತಲೆನೋವು ಇದೆ").verdict).toBe("indic_script");
    expect(checkEnglish("I have a headache ನನಗೆ ತಲೆನೋವು ಇದೆ").verdict).toBe("indic_script");
    expect(checkEnglish("I have a headache since three days").verdict).toBe("english");
    expect(checkEnglish("").verdict).toBe("english");
  });
});
