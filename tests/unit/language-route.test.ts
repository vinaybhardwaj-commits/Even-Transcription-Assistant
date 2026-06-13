import { describe, it, expect } from "vitest";
import { decideEncounterLanguage, hasIndicScript, isKnownNonEnglish } from "../../lib/language-route";
import { advanceRouter, INITIAL_ROUTER } from "../../lib/use-language-router";

describe("decideEncounterLanguage — corroborated, English-biased fork", () => {
  it("THE BUG: accented English mislabelled Bengali by Sarvam stays English", () => {
    // Whisper says English, text is Latin, Sarvam wrongly says bn-IN.
    const d = decideEncounterLanguage({
      whisperLang: "en", sarvamLang: "bn-IN",
      whisperText: "patient presents with fever and cough for three days",
      sarvamText: "patient presents with fever and cough for three days",
    });
    expect(d.nonEnglish).toBe(false);
    expect(d.reason).toBe("whisper_en_no_script");
  });

  it("genuine Bengali (native script present) is non-English", () => {
    const d = decideEncounterLanguage({
      whisperLang: "bn", sarvamLang: "bn-IN",
      sarvamText: "রোগীর তিন দিন ধরে জ্বর", whisperText: "",
    });
    expect(d.nonEnglish).toBe(true);
    expect(["indic_script", "whisper_non_en"]).toContain(d.reason);
  });

  it("Indic script alone (even if Whisper is silent) triggers non-English", () => {
    const d = decideEncounterLanguage({ whisperLang: null, sarvamLang: "kn-IN", sarvamText: "ರೋಗಿಗೆ ಜ್ವರ" });
    expect(d.nonEnglish).toBe(true);
    expect(d.reason).toBe("indic_script");
  });

  it("Whisper LID non-English (Latin/romanized text) is trusted", () => {
    const d = decideEncounterLanguage({ whisperLang: "hi", sarvamLang: "hi-IN", whisperText: "rogi ko teen din se bukhar hai" });
    expect(d.nonEnglish).toBe(true);
  });

  it("ambiguous / no corroboration defaults to English", () => {
    const d = decideEncounterLanguage({ whisperLang: null, sarvamLang: "unknown", whisperText: "", sarvamText: "" });
    expect(d.nonEnglish).toBe(false);
    expect(d.reason).toBe("default_english");
  });

  it("Sarvam-silent + Whisper-silent → English", () => {
    expect(decideEncounterLanguage({}).nonEnglish).toBe(false);
  });

  it("helpers", () => {
    expect(hasIndicScript("ज्वर")).toBe(true);
    expect(hasIndicScript("fever")).toBe(false);
    expect(isKnownNonEnglish("en-IN")).toBe(false);
    expect(isKnownNonEnglish("bn-IN")).toBe(true);
    expect(isKnownNonEnglish("unknown")).toBe(false);
    expect(isKnownNonEnglish(null)).toBe(false);
  });
});

describe("advanceRouter — hysteresis (no single-window flips)", () => {
  it("starts English", () => {
    expect(INITIAL_ROUTER.current).toBe("en");
  });

  it("a single non-English window does NOT flip (needs flipAfter=2)", () => {
    const s1 = advanceRouter(INITIAL_ROUTER, { nonEnglish: true, language: "bn" }, 2);
    expect(s1.current).toBe("en");        // still English after one window
    expect(s1.candidate).toBe("non-en");
  });

  it("two consecutive non-English windows flip to non-English", () => {
    let s = advanceRouter(INITIAL_ROUTER, { nonEnglish: true, language: "bn" }, 2);
    s = advanceRouter(s, { nonEnglish: true, language: "bn" }, 2);
    expect(s.current).toBe("non-en");
    expect(s.lang).toBe("bn");
  });

  it("a confirming window resets a pending opposite candidate (no flap)", () => {
    let s = advanceRouter(INITIAL_ROUTER, { nonEnglish: true, language: "bn" }, 2); // candidate non-en
    s = advanceRouter(s, { nonEnglish: false, language: "en" }, 2);                  // back to English
    expect(s.current).toBe("en");
    expect(s.candidate).toBeNull();
  });

  it("flips back to English after two English windows", () => {
    let s = advanceRouter(INITIAL_ROUTER, { nonEnglish: true, language: "hi" }, 2);
    s = advanceRouter(s, { nonEnglish: true, language: "hi" }, 2); // now non-en
    expect(s.current).toBe("non-en");
    s = advanceRouter(s, { nonEnglish: false, language: "en" }, 2);
    s = advanceRouter(s, { nonEnglish: false, language: "en" }, 2);
    expect(s.current).toBe("en");
  });
});
