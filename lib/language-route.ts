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
  const indicWhisper = hasIndicScript(sig.whisperText); // Whisper's OWN script = reliable
  const indicSarvam = hasIndicScript(sig.sarvamText);   // Sarvam transliterates → UNRELIABLE
  const wNon = isKnownNonEnglish(sig.whisperLang);
  const wEn = isEnglishCode(sig.whisperLang);
  const sNon = isKnownNonEnglish(sig.sarvamLang);

  // Whisper LID is the trusted detector. If it says English, it's English — EVEN
  // IF Sarvam emitted native script. Once Sarvam (mis)picks an Indian language it
  // transliterates English dictation into that script (Dr. Chandrika's operative
  // note: Whisper=en, Sarvam wrote her English as Tamil). Sarvam's script is
  // downstream of Sarvam's own (wrong) call, so it must NOT override Whisper.
  // Whisper's own text is never Indic when it labels English, so this is safe.
  if (wEn) {
    return { nonEnglish: false, language: sig.whisperLang ?? "en", reason: "whisper_en" };
  }

  // Whisper says a known non-English language, or Whisper's OWN text is native script.
  if (wNon || indicWhisper) {
    const language = wNon ? sig.whisperLang! : (sNon ? sig.sarvamLang! : (sig.sarvamLang ?? null));
    return { nonEnglish: true, language, reason: wNon ? "whisper_non_en" : "whisper_script" };
  }

  // Whisper SILENT (no LID yet): fall back to Sarvam ONLY with real native SCRIPT
  // corroboration — a lone Sarvam label is too unreliable to flip on.
  if (!sig.whisperLang && indicSarvam) {
    return { nonEnglish: true, language: sig.sarvamLang ?? null, reason: "indic_script" };
  }

  // Ambiguous (incl. Sarvam label-only, no script) → English (default; ~93%).
  return { nonEnglish: false, language: sig.whisperLang ?? "en", reason: "default_english" };
}

/** Which live engine should be the PRIMARY on-screen transcript for a language. */
export function primaryLiveEngine(isEnglish: boolean): "deepgram" | "sarvam" {
  // English → Deepgram (real-time English specialist, pinned en-IN).
  // Non-English → Sarvam (code-mix), with the IndicConformer native box alongside.
  return isEnglish ? "deepgram" : "sarvam";
}
