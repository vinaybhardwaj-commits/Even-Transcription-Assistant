/**
 * lib/jev/note-sentences.ts — U4/U8: turning a generated note into atomic units, and picking each
 * one's "nearest window" of the transcript. Pure, fixture-driven.
 */
import { describe, it, expect } from "vitest";
import { excerptForIndex, flattenNoteText, groupNoteItemsByExcerpt, splitNoteSentences } from "@/lib/jev/note-sentences";

describe("splitNoteSentences — sentence splitting", () => {
  it("splits on Latin terminators, keeping them attached", () => {
    expect(splitNoteSentences("Patient has fever. No rash noted. Advised rest.")).toEqual([
      "Patient has fever.",
      "No rash noted.",
      "Advised rest.",
    ]);
  });

  it("splits on ! and ? too", () => {
    expect(splitNoteSentences("Stop the medication! Any allergies? None reported.")).toEqual([
      "Stop the medication!",
      "Any allergies?",
      "None reported.",
    ]);
  });

  it("splits on the Devanagari danda", () => {
    expect(splitNoteSentences("बुखार है। आराम की सलाह दी।")).toEqual(["बुखार है।", "आराम की सलाह दी।"]);
  });

  it("splits on bare newlines even without terminal punctuation", () => {
    expect(splitNoteSentences("Fever\nCough\nFatigue")).toEqual(["Fever", "Cough", "Fatigue"]);
  });

  it("drops empty segments and trims whitespace", () => {
    expect(splitNoteSentences("  Fever.   \n\n  Cough.  ")).toEqual(["Fever.", "Cough."]);
  });

  it("empty input is an empty array, not [\"\"]", () => {
    expect(splitNoteSentences("")).toEqual([]);
    expect(splitNoteSentences("   ")).toEqual([]);
  });
});

describe("flattenNoteText — walking a note's shape without hardcoding field names", () => {
  it("splits a multi-sentence string field into one item per sentence, path-tagged", () => {
    const items = flattenNoteText({ history_present_illness: "Fever for 3 days. No cough." });
    expect(items).toEqual([
      { path: "history_present_illness", text: "Fever for 3 days." },
      { path: "history_present_illness", text: "No cough." },
    ]);
  });

  it("keeps each string-array item WHOLE, not re-split — a medication line is one atomic fact", () => {
    const items = flattenNoteText({ current_medications: ["Paracetamol 500mg bid.", "Cetirizine 10mg od."] });
    expect(items).toEqual([
      { path: "current_medications[0]", text: "Paracetamol 500mg bid." },
      { path: "current_medications[1]", text: "Cetirizine 10mg od." },
    ]);
  });

  it("recurses into nested objects (e.g. plan.treatment), building a dot/bracket path", () => {
    const items = flattenNoteText({ plan: { treatment: ["Ibuprofen 400mg tds x3d."], follow_up: "In one week." } });
    expect(items).toEqual(
      expect.arrayContaining([
        { path: "plan.treatment[0]", text: "Ibuprofen 400mg tds x3d." },
        { path: "plan.follow_up", text: "In one week." },
      ]),
    );
  });

  it("skips empty strings, empty arrays, numbers, booleans and nulls — nothing to check", () => {
    const items = flattenNoteText({
      chief_complaint: "",
      past_medical_history: [],
      estimated_blood_loss_ml: 250,
      counts_correct: true,
      surgeon: null,
    });
    expect(items).toEqual([]);
  });

  it("works uniformly across a DIFFERENT note_type's field names (OperativeProcedureNote-shaped), never hardcoding EncounterNote's fields", () => {
    const items = flattenNoteText({ procedure_narrative: "Incision made. Hemostasis achieved.", specimens: [{ description: "appendix", sent_to: "histopath" }] });
    expect(items).toEqual(
      expect.arrayContaining([
        { path: "procedure_narrative", text: "Incision made." },
        { path: "procedure_narrative", text: "Hemostasis achieved." },
        { path: "specimens[0].description", text: "appendix" },
        { path: "specimens[0].sent_to", text: "histopath" },
      ]),
    );
  });

  it("is pure — two calls over the same note are byte-identical", () => {
    const note = { chief_complaint: "Fever.", plan: { treatment: ["Rest."] } };
    expect(JSON.stringify(flattenNoteText(note))).toBe(JSON.stringify(flattenNoteText(note)));
  });
});

describe("excerptForIndex — the 'nearest window' fallback", () => {
  it("returns the WHOLE transcript when it fits maxChars, for every index — the degenerate one-window case", () => {
    const transcript = "short transcript";
    expect(excerptForIndex(transcript, 0, 3, 1_000)).toBe(transcript);
    expect(excerptForIndex(transcript, 2, 3, 1_000)).toBe(transcript);
  });

  it("splits into windows and maps a sentence's position proportionally when the transcript is too large", () => {
    // 100 chars, maxChars 40 -> 3 windows of ~34 chars each (ceil(100/3)).
    const transcript = "0123456789".repeat(10); // 100 chars, index == char value mod 10 pattern
    const total = 9;
    const first = excerptForIndex(transcript, 0, total, 40); // index 0 of 9 -> window 0
    const middle = excerptForIndex(transcript, 4, total, 40); // index 4 of 9 -> window floor(4/9*3)=1
    const last = excerptForIndex(transcript, 8, total, 40); // index 8 of 9 -> window floor(8/9*3)=2
    expect(first).toBe(transcript.slice(0, 34));
    expect(middle).toBe(transcript.slice(34, 68));
    expect(last).toBe(transcript.slice(68, 100));
  });

  it("never returns a window index past the last real window, even at the highest index", () => {
    const transcript = "x".repeat(100);
    const r = excerptForIndex(transcript, 99, 100, 40); // would compute windowIndex 2 (last valid) at most
    expect(r.length).toBeGreaterThan(0);
    expect(transcript.includes(r)).toBe(true);
  });

  it("total<=0 returns the whole transcript rather than dividing by zero", () => {
    expect(excerptForIndex("x".repeat(100), 0, 0, 10)).toBe("x".repeat(100));
  });
});

describe("groupNoteItemsByExcerpt — fan-out grouping", () => {
  it("a short transcript groups every item into ONE group sharing the whole transcript", () => {
    const items = [{ path: "a", text: "one" }, { path: "b", text: "two" }, { path: "c", text: "three" }];
    const groups = groupNoteItemsByExcerpt(items, "short transcript", 1_000);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(3);
    expect(groups[0]!.excerpt).toBe("short transcript");
  });

  it("a long transcript groups items by their resolved window, not one group per item", () => {
    const transcript = "0123456789".repeat(10); // 100 chars
    const items = Array.from({ length: 9 }, (_, i) => ({ path: `p${i}`, text: `sentence ${i}` }));
    const groups = groupNoteItemsByExcerpt(items, transcript, 40); // 3 windows
    expect(groups.length).toBeLessThanOrEqual(3);
    const totalItems = groups.reduce((sum, g) => sum + g.items.length, 0);
    expect(totalItems).toBe(9); // every item is accounted for exactly once
  });

  it("an empty item list is an empty group list", () => {
    expect(groupNoteItemsByExcerpt([], "transcript", 100)).toEqual([]);
  });
});
