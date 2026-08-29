/**
 * Build 1 §C.1 — the language map, exhaustively, and the loud failure.
 *
 * THE DEFECT (grounding §A6). whisper.cpp's verbose_json returns the full language NAME, not an
 * ISO code. `"english"` reached `"en-IN"` by pure accident — `isEnglishCode` tests
 * `startsWith("eng")`. Nothing else did: `"hindi"`, `"kannada"`, `"tamil"` fell through to null,
 * which the drain reads as "do not force", so the arbitrator built specifically to stop Sarvam
 * choosing its own language was silently switched off for every Indic window. It never fired
 * only because all fifteen windows ever drained were English.
 *
 * These tests are the spec's normative table, one assertion per row, plus the guard that makes
 * an unmapped answer LOUD instead of null.
 */
import { describe, it, expect } from "vitest";
import {
  whisperLanguageToIso,
  isUnknownLanguageAnswer,
  isEnglishCode,
  WHISPER_LANGUAGE_NAMES,
} from "@/lib/language-route";
import { resolveSarvamLanguage, sarvamLanguageCode } from "@/lib/stt/room-drain";

/** The Build 1 spec's table, verbatim. This IS the spec. */
const SPEC_TABLE: Array<[string, string]> = [
  ["english", "en-IN"],
  ["hindi", "hi-IN"],
  ["kannada", "kn-IN"],
  ["tamil", "ta-IN"],
  ["telugu", "te-IN"],
  ["malayalam", "ml-IN"],
  ["marathi", "mr-IN"],
  ["bengali", "bn-IN"],
  ["gujarati", "gu-IN"],
  ["punjabi", "pa-IN"],
  ["urdu", "ur-IN"],
];

describe("the normative name → locale table (Build 1 §C.1)", () => {
  for (const [name, locale] of SPEC_TABLE) {
    it(`${name} → ${locale}`, () => {
      expect(resolveSarvamLanguage(name)).toEqual({ kind: "ok", code: locale });
      expect(sarvamLanguageCode(name)).toBe(locale);
    });
  }

  it("the table is EXHAUSTIVE — every name in the spec resolves, and none is missing", () => {
    const resolved = SPEC_TABLE.map(([n]) => n).filter((n) => resolveSarvamLanguage(n).kind === "ok");
    expect(resolved).toHaveLength(SPEC_TABLE.length);
    // Every name the spec lists is also known to the ISO normaliser.
    for (const [name] of SPEC_TABLE) {
      expect(Object.keys(WHISPER_LANGUAGE_NAMES)).toContain(name);
    }
  });

  it("case and whitespace do not defeat it — whisper.cpp's casing is not a contract", () => {
    expect(resolveSarvamLanguage("  HINDI ")).toEqual({ kind: "ok", code: "hi-IN" });
    expect(resolveSarvamLanguage("English")).toEqual({ kind: "ok", code: "en-IN" });
  });
});

describe("the ISO codes still work — this build is additive, not a replacement", () => {
  it("the codes the map has always carried still resolve", () => {
    expect(resolveSarvamLanguage("hi")).toEqual({ kind: "ok", code: "hi-IN" });
    expect(resolveSarvamLanguage("kn")).toEqual({ kind: "ok", code: "kn-IN" });
    expect(resolveSarvamLanguage("en")).toEqual({ kind: "ok", code: "en-IN" });
  });

  it('startsWith("eng") behaviour is KEPT, as the spec requires', () => {
    expect(isEnglishCode("eng")).toBe(true);
    expect(isEnglishCode("english")).toBe(true);
    expect(resolveSarvamLanguage("eng")).toEqual({ kind: "ok", code: "en-IN" });
    expect(resolveSarvamLanguage("en-IN")).toEqual({ kind: "ok", code: "en-IN" });
  });
});

describe("unknown is NOT unmapped — the distinction the whole fix turns on", () => {
  it('a shrug means "do not force", exactly as it always has', () => {
    for (const s of [null, undefined, "", "   ", "auto", "und", "unknown", "AUTO"]) {
      expect(isUnknownLanguageAnswer(s)).toBe(true);
      expect(resolveSarvamLanguage(s)).toEqual({ kind: "none" });
      expect(sarvamLanguageCode(s)).toBeNull();
    }
  });

  it("a shrug is never an error — a failed probe must stay harmless", () => {
    expect(resolveSarvamLanguage(null).kind).not.toBe("unmapped");
  });
});

describe("an unmapped name FAILS LOUDLY — it never silently passes the guard", () => {
  it("a language whisper.cpp names and this system cannot serve is unmapped", () => {
    expect(resolveSarvamLanguage("nepali")).toEqual({ kind: "unmapped", answer: "nepali" });
    expect(resolveSarvamLanguage("swahili")).toEqual({ kind: "unmapped", answer: "swahili" });
  });

  it("unmapped is DISTINGUISHABLE from unknown at the type level — the defect was that it was not", () => {
    const unmapped = resolveSarvamLanguage("nepali");
    const unknown = resolveSarvamLanguage("auto");
    expect(unmapped.kind).toBe("unmapped");
    expect(unknown.kind).toBe("none");
    expect(unmapped.kind).not.toBe(unknown.kind);
    // The legacy nullable accessor CANNOT tell them apart. That is precisely why the drain
    // stopped using it, and this assertion pins why the union had to exist.
    expect(sarvamLanguageCode("nepali")).toBeNull();
    expect(sarvamLanguageCode("auto")).toBeNull();
  });

  it("a confident ISO code with no locale behind it is also loud, not a quiet null", () => {
    // FLAGGED WIDENING: the spec names "an unmapped NAME"; a French code disables the arbitrator
    // in exactly the same way, so it takes the same path. Called out in the build report.
    expect(resolveSarvamLanguage("fr")).toEqual({ kind: "unmapped", answer: "fr" });
    expect(resolveSarvamLanguage("de-DE")).toEqual({ kind: "unmapped", answer: "de" });
  });

  it("whisperLanguageToIso reports the three cases and never collapses two into one", () => {
    expect(whisperLanguageToIso("hindi")).toEqual({ kind: "code", code: "hi" });
    expect(whisperLanguageToIso("auto")).toEqual({ kind: "unknown" });
    expect(whisperLanguageToIso("klingon")).toEqual({ kind: "unmapped", answer: "klingon" });
  });
});

describe("the drain wires the loud path to a named step", () => {
  it("`language_unmapped` is a real DrainStep and the guard returns it", async () => {
    const src = (await import("node:fs")).readFileSync("lib/stt/room-drain.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain('"language_unmapped"');
    expect(code).toContain('recordFailure(windowId, "language_unmapped"');
    // The drain must consult the UNION, never the nullable accessor that cannot see the fault.
    expect(code).toContain("resolveSarvamLanguage(decided)");
  });
});
