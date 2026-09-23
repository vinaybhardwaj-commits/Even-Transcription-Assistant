/**
 * lib/jev/clinical-route-heuristic.ts — the V-free baseline U6's 50-window bench scores Jev
 * against. Pure and rule-based, so every case here is a synthetic, non-PHI fixture string
 * chosen to trip (or deliberately not trip) one specific marker list.
 */
import { describe, it, expect } from "vitest";
import { heuristicClinicalRoute, isValidU6Option } from "@/lib/jev/clinical-route-heuristic";
import { U6_OPTIONS } from "@/lib/jev/prompts/encounter-v1";

describe("heuristicClinicalRoute — garbled takes priority over every other rule", () => {
  it("very short text is garbled regardless of content", () => {
    expect(heuristicClinicalRoute("fever")).toBe("garbled_or_no_real_speech");
  });

  it("mostly non-letter characters is garbled even at length", () => {
    expect(heuristicClinicalRoute("12345 678 90 12345 678 90 12345 678 90")).toBe("garbled_or_no_real_speech");
  });

  it("a clinical marker inside otherwise-garbled short text still reads as garbled — length wins first", () => {
    expect(heuristicClinicalRoute("mg mg")).toBe("garbled_or_no_real_speech");
  });

  it("empty and whitespace-only text is garbled", () => {
    expect(heuristicClinicalRoute("")).toBe("garbled_or_no_real_speech");
    expect(heuristicClinicalRoute("   ")).toBe("garbled_or_no_real_speech");
  });

  it("Devanagari text of reasonable length is NOT flagged garbled by the Latin-only letter check", () => {
    expect(heuristicClinicalRoute("मरीज को बुखार और खांसी है, कृपया जांच करें")).not.toBe("garbled_or_no_real_speech");
  });
});

describe("heuristicClinicalRoute — phone_call markers", () => {
  it("a 'hello, can you hear me' opening reads as a phone call", () => {
    expect(heuristicClinicalRoute("Hello, can you hear me? The line keeps cutting out.")).toBe("phone_call");
  });

  it("'network' issues read as a phone call", () => {
    expect(heuristicClinicalRoute("Sorry, the network here is very weak today, one moment please.")).toBe("phone_call");
  });

  it("'call you back later' reads as a phone call", () => {
    expect(heuristicClinicalRoute("I will call you back later once I am free to talk properly.")).toBe("phone_call");
  });
});

describe("heuristicClinicalRoute — staff_or_admin_talk markers", () => {
  it("a token number mention reads as staff/admin talk", () => {
    expect(heuristicClinicalRoute("Please check the token number before sending the next patient in.")).toBe("staff_or_admin_talk");
  });

  it("'next patient' reads as staff/admin talk", () => {
    expect(heuristicClinicalRoute("Send in the next patient once this room is free, thank you.")).toBe("staff_or_admin_talk");
  });

  it("scheduling an appointment slot reads as staff/admin talk", () => {
    expect(heuristicClinicalRoute("We need to schedule an appointment slot for next Tuesday morning.")).toBe("staff_or_admin_talk");
  });
});

describe("heuristicClinicalRoute — clinical_consultation markers", () => {
  it("a symptom + dosage discussion reads as clinical", () => {
    expect(heuristicClinicalRoute("The patient reports fever and cough, prescribe 500 mg twice daily.")).toBe("clinical_consultation");
  });

  it("an examination + diagnosis mention reads as clinical", () => {
    expect(heuristicClinicalRoute("On examination there is mild tenderness, the diagnosis is likely gastritis.")).toBe("clinical_consultation");
  });

  it("an allergy mention reads as clinical", () => {
    expect(heuristicClinicalRoute("Please note any known allergy before starting the injection today.")).toBe("clinical_consultation");
  });
});

describe("heuristicClinicalRoute — 'pain' is a whole-word marker, not a substring", () => {
  it("'painting' does NOT trip the clinical marker for 'pain' (caught by the 50-window bench, w33)", () => {
    expect(heuristicClinicalRoute("I finally finished painting the front room, took the whole weekend to do it.")).not.toBe("clinical_consultation");
  });

  it("'pain' as its own word still reads as clinical", () => {
    expect(heuristicClinicalRoute("There is some pain in the left shoulder since yesterday morning.")).toBe("clinical_consultation");
  });
});

describe("heuristicClinicalRoute — precedence when markers from different lists co-occur", () => {
  it("a phone marker beats a later clinical word — phone is checked before clinical", () => {
    expect(heuristicClinicalRoute("Hello, can you hear me, I wanted to ask about the fever medicine.")).toBe("phone_call");
  });

  it("a staff marker beats a later clinical word — staff is checked before clinical", () => {
    expect(heuristicClinicalRoute("Check the token number, then we can discuss the fever and dosage.")).toBe("staff_or_admin_talk");
  });
});

describe("heuristicClinicalRoute — the honest fallback", () => {
  it("ordinary chit-chat that trips none of the marker lists returns cannot_tell, never a guessed default", () => {
    expect(heuristicClinicalRoute("It has been raining a lot this week, quite unusual for this time of year.")).toBe("cannot_tell");
  });

  it("this heuristic never emits social_chatter — it has no marker list for it, by design", () => {
    const samples = [
      "It has been raining a lot this week, quite unusual for this time of year.",
      "Did you watch the cricket match last night, what a finish that was.",
    ];
    for (const s of samples) expect(heuristicClinicalRoute(s)).not.toBe("social_chatter");
  });
});

describe("heuristicClinicalRoute — every possible return value is one of U6's own six options", () => {
  it("a representative sample across all branches all satisfy isValidU6Option", () => {
    const samples = [
      "fever",
      "Hello, can you hear me, the call keeps dropping.",
      "Please check the token number for the next patient.",
      "The patient has a fever, prescribe medicine and monitor blood pressure.",
      "It has been raining a lot this week, quite unusual weather.",
    ];
    for (const s of samples) expect(isValidU6Option(heuristicClinicalRoute(s))).toBe(true);
  });

  it("isValidU6Option rejects a label outside the closed set", () => {
    expect(isValidU6Option("invented_category")).toBe(false);
    for (const opt of U6_OPTIONS) expect(isValidU6Option(opt)).toBe(true);
  });
});
