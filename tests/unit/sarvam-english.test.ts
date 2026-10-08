/**
 * S8A4 — the pure pieces: script detection, English alignment (nothing dropped), the drug-name check (proposes, never rewrites), the per-sentence translate plan.
 * No network, no database, no secret.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { detectScript, hasIndicScript } from "@/lib/script-detect";
import { drugCandidates, nameScore, phoneticKey, type Lexicon } from "@/lib/drug-match";
import { alignEnglish, settleUnpaired, tagNative, addMayura, finalizeEnglish } from "@/lib/jobs/kinds/sarvam-english";
import { planUnits } from "@/lib/jobs/kinds/sarvam-translate";
import type { ResultDoc } from "@/lib/jobs/kinds/sarvam-common";

const base = JSON.parse(readFileSync("data/drug-lexicon.json", "utf8")) as Lexicon;
const lex: Lexicon = { ...base, clinical_terms: (JSON.parse(readFileSync("data/clinical-terms.json", "utf8")) as { terms: string[] }).terms };

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
    const track = alignEnglish(n, pass);
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
    const track = alignEnglish(n, pass);
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
    const track = alignEnglish(n, [{ speaker_id: "0", start_s: 6, end_s: 6, text: "Hello" }]);
    expect(track[0]!.native_idx).toBe(1);
    expect(settleUnpaired(n, track)).toEqual([]);
    expect(n[0]!.english).toBe("");
  });

  it("Sarvam's per-entry language, when the response carries one, is kept", () => {
    expect(tagNative([{ speaker_id: "0", start_s: 0, end_s: 1, text: "ok", language_code: "kn-IN" }])[0]).toMatchObject({ language_code: "kn-IN", script: "Latin" });
  });
});

describe("drug-name check — proposes, never rewrites", () => {
  it("\"combat land\" -> Combiflam, with the entry index, the heard text, a score and the lexicon source", () => {
    const c = drugCandidates("Take combat land twice a day after food", 3, lex);
    expect(c).toEqual([{ entry_idx: 3, heard: "combat", suggested: "Combiflam", score: expect.any(Number), source: "hand-fixture", category: "drug" }]);
    expect(c[0]!.score).toBeGreaterThanOrEqual(0.55);
  });
  it("doses and numbers are never part of a candidate: a window touching a digit is skipped, and the function returns no text at all", () => {
    expect(drugCandidates("paracetamol 650 mg three times a day for 5 days", 0, lex)).toEqual([]);
    const c = drugCandidates("combat land 500 milligram", 0, lex);
    for (const x of c) expect(/\d/.test(x.heard)).toBe(false);
  });
  it("a correctly heard name proposes nothing; short tokens (Rx, PX, mg) propose nothing", () => {
    expect(drugCandidates("Crocin and Dolo and Combiflam", 0, lex)).toEqual([]);
    expect(drugCandidates("PX for fever, Rx given, mg", 0, lex)).toEqual([]);
  });
  it("deterministic and sorted; the matcher helpers behave", () => {
    const a = drugCandidates("combat land and pentopraz", 0, lex);
    expect(a).toEqual(drugCandidates("combat land and pentopraz", 0, lex));
    expect(a.map((x) => x.suggested)).toEqual(expect.arrayContaining(["Combiflam", "Pantoprazole"]));
    expect(phoneticKey("Combiflam")).toBe(phoneticKey("combiflam"));
    expect(nameScore("zzzz", "Combiflam")).toBe(0);
  });
  it("ADDENDUM 2 — the four garbled lab / clinical terms get candidates: \"IG\" -> IgE, \"Citrus Phthalate\" -> citrate / oxalate, \"nodrinal\" -> nocturia, \"Bilus M\" -> bilastine", () => {
    const one = (text: string, l: Lexicon = lex) => drugCandidates(text, 0, l);
    const ige = one("His IG level is high");
    expect(ige).toContainEqual(expect.objectContaining({ heard: "IG", suggested: "IgE", category: "investigation" })); // a tie with IgA / IgG is reported, not guessed
    expect(ige.length).toBeLessThanOrEqual(3);
    const cit = one("Send the Citrus Phthalate levels in urine");
    expect(cit.length).toBeGreaterThan(0);
    expect(cit.some((c) => /^citrate|^oxalate/i.test(c.suggested) && /citrus|phthalate/i.test(c.heard))).toBe(true);
    expect(one("complains of nodrinal since two weeks")).toEqual([expect.objectContaining({ heard: "nodrinal", suggested: "nocturia", category: "clinical_term" })]);
    const bil = one("started on Bilus M at night");
    expect(bil).toEqual([expect.objectContaining({ heard: "Bilus", category: "drug" })]);
    expect(bil[0]!.suggested).toMatch(/^Bila/); // a bilastine-type brand from the lexicon
  });
  it("an ordinary lowercase 'ig' or 'it' is not an acronym candidate; ordinary words around the garbles propose nothing", () => {
    expect(drugCandidates("it is fine and the ig of the thing", 0, lex)).toEqual([]);
    expect(drugCandidates("patient came with fever and cough for two days", 0, lex)).toEqual([]);
  });
  it("the committed lexicon is names only: strings, no digits-and-units, no patient columns", () => {
    expect(lex.names.length).toBeGreaterThan(20);
    for (const n of lex.names) {
      expect(typeof n).toBe("string");
      expect(n.length).toBeLessThanOrEqual(80);
      expect(/\b\d+\s?(mg|ml|mcg|g)\b/i.test(n)).toBe(false);
    }
    expect(Object.keys(base).sort()).toEqual(["investigations", "names", "note", "source", "version"]);
    for (const n of [...(base.investigations ?? []), ...(lex.clinical_terms ?? [])]) { expect(typeof n).toBe("string"); expect(n.length).toBeLessThanOrEqual(80); }
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
