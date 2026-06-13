/**
 * Language routing — corroborated, English-biased language decision + the
 * engine→language map. Pure & unit-tested (tests/unit/language-route.test.ts).
 *
 * WHY: Sarvam's per-response language code is unreliable — it has mislabelled
 * accented ENGLISH as Bengali, which used to drag a whole encounter down the
 * Indic path (native-script box, batch translate, native analysis). Whisper's
 * language ID is robust, and the produced text's SCRIPT is ground truth. So we
 * never let Sarvam's lone label decide: we corroborate, and default to English.
 */

const INDIC_SCRIPT = /[\u0900-\u0DFF]/; // Devanagari … Sinhala (Hindi/Bengali/Tamil/Telugu/Kannada/Malayalam/…)

export function hasIndicScript(s: string | null | undefined): boolean {
  return !!s && INDIC_SCRIPT.test(s);
}

/** A language code that clearly means English (en, en-IN, eng…). */
export function isEnglishCode(lang: string | null | undefined): boolean {
  if (!lang) return false;
  const l = lang.toLowerCase();
  return l === "en" || l.startsWith("en-") || l.startsWith("eng");
}

/** A language code that is a KNOWN, non-English language (not null/unknown/en). */
export function isKnownNonEnglish(lang: string | null | undefined): boolean {
  if (!lang) return false;
  const l = lang.toLowerCase().trim();
  if (l === "" || l === "unknown" || l === "und" || l === "auto") return false;
  return !isEnglishCode(l);
}

export type LangSignals = {
  whisperLang?: string | null;   // Whisper LID — the trusted detector
  sarvamLang?: string | null;    // Sarvam code — corroboration only (unreliable)
  whisperText?: string | null;
  sarvamText?: string | null;    // code-mix; may carry native script
  deepgramText?: string | null;  // English path (Latin)
};

export type LangDecision = {
  nonEnglish: boolean;
  language: string | null;       // best-guess language code for the encounter
  reason: string;                // why (telemetry/debug)
};

/**
 * Decide an encounter's language from all available signals, biased to English.
 * Treat as non-English ONLY with corroboration:
 *   - real Indic SCRIPT in the produced text, OR
 *   - Whisper LID says a known non-English language, OR
 *   - Whisper is silent AND Sarvam confidently says non-English.
 * A Sarvam label alone, when Whisper says English (or text is Latin), is IGNORED.
 */
export function decideEncounterLanguage(sig: LangSignals): LangDecision {
  const indic = hasIndicScript(sig.sarvamText) || hasIndicScript(sig.whisperText);
  const wNon = isKnownNonEnglish(sig.whisperLang);
  const wEn = isEnglishCode(sig.whisperLang);
  const sNon = isKnownNonEnglish(sig.sarvamLang);

  // The accented-English-as-Bengali fix: Whisper says English and there is no
  // Indic script → English, no matter what Sarvam claims.
  if (wEn && !indic) {
    return { nonEnglish: false, language: sig.whisperLang ?? "en", reason: "whisper_en_no_script" };
  }

  const nonEnglish = indic || wNon || (!sig.whisperLang && sNon);
  if (nonEnglish) {
    const language = wNon
      ? sig.whisperLang!
      : (sNon ? sig.sarvamLang! : (sig.whisperLang ?? sig.sarvamLang ?? null));
    return { nonEnglish: true, language, reason: indic ? "indic_script" : (wNon ? "whisper_non_en" : "sarvam_non_en_whisper_silent") };
  }

  // Ambiguous → English (default; ~93% of consults).
  return { nonEnglish: false, language: sig.whisperLang ?? "en", reason: "default_english" };
}

/** Which live engine should be the PRIMARY on-screen transcript for a language. */
export function primaryLiveEngine(isEnglish: boolean): "deepgram" | "sarvam" {
  // English → Deepgram (real-time English specialist, pinned en-IN).
  // Non-English → Sarvam (code-mix), with the IndicConformer native box alongside.
  return isEnglish ? "deepgram" : "sarvam";
}
