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

// ---------------------------------------------------------------------------
// whisper.cpp's language NAMES (Build 1 §C.1)
// ---------------------------------------------------------------------------

/**
 * whisper.cpp answers with the full language NAME, not an ISO code — and the whole language
 * arbitration was built assuming a code.
 *
 * THE DEFECT THIS TABLE FIXES. `verbose_json` returns `"language": "english"`, not `"en"`. That
 * survived by pure accident: `isEnglishCode` tests `startsWith("eng")`, so `"english"` reached
 * `"en-IN"` anyway. Nothing else did. `"hindi"`, `"kannada"`, `"tamil"` are not ISO codes and
 * are not English, so the locale lookup returned null, which means "do not force" — and the
 * arbitrator that exists specifically to stop Sarvam picking its own language was silently
 * switched off for every Indic window. It has never fired only because all fifteen windows ever
 * drained happened to be English (grounding §A6). It would have fired on the first Indic one.
 *
 * This is the restated normative table from the Build 1 spec. It is the spec, not a convenience:
 * a name absent from it must reach the caller as an UNMAPPED answer that fails loudly, never as
 * a null that reads exactly like "Whisper was unsure" and passes the guard.
 */
export const WHISPER_LANGUAGE_NAMES: Record<string, string> = {
  english: "en",
  hindi: "hi",
  kannada: "kn",
  tamil: "ta",
  telugu: "te",
  malayalam: "ml",
  marathi: "mr",
  bengali: "bn",
  gujarati: "gu",
  punjabi: "pa",
  urdu: "ur",
};

/**
 * The sentinels that mean "I do not know", as distinct from a language this system cannot map.
 *
 * THE WHOLE FIX TURNS ON THIS DISTINCTION. "Whisper was unsure" is a legitimate answer and has
 * always meant "do not force a language on Sarvam" — that behaviour is correct and is kept. "I
 * am confident it was Hindi and you have no mapping for me" is a DIFFERENT answer that has been
 * wearing the first one's clothes. Collapsing them is the defect; keeping them apart is the fix.
 */
const UNKNOWN_SENTINELS = new Set(["", "auto", "und", "unknown", "nan", "null"]);

export function isUnknownLanguageAnswer(lang: string | null | undefined): boolean {
  if (lang === null || lang === undefined) return true;
  return UNKNOWN_SENTINELS.has(lang.trim().toLowerCase());
}

/**
 * PURE — whisper.cpp's answer → an ISO-639-1 code, or a verdict that says why not.
 *
 *   { kind: "unknown" }            Whisper had no opinion. Do not force. Not an error.
 *   { kind: "code", code }         A code this system can carry forward.
 *   { kind: "unmapped", answer }   Whisper named a language and there is no mapping for it.
 *                                  THE CALLER MUST FAIL LOUDLY. Returning null here is exactly
 *                                  the defect above.
 *
 * A value that is already an ISO-639-1 code passes through, because this function sits in front
 * of a map that has always been keyed on codes and older callers still supply them.
 */
export type WhisperLanguageAnswer =
  | { kind: "unknown" }
  | { kind: "code"; code: string }
  | { kind: "unmapped"; answer: string };

export function whisperLanguageToIso(raw: string | null | undefined): WhisperLanguageAnswer {
  if (isUnknownLanguageAnswer(raw)) return { kind: "unknown" };
  const l = (raw as string).trim().toLowerCase();

  const named = WHISPER_LANGUAGE_NAMES[l];
  if (named) return { kind: "code", code: named };

  // Keep the startsWith("eng") behaviour the spec preserves explicitly: "eng", "en", "en-IN" and
  // "english" all mean English, and "english" is already handled by the table above.
  if (isEnglishCode(l)) return { kind: "code", code: "en" };

  // A bare two-letter code is a code. Longer than that and not in the table is a NAME this
  // system does not know — and that is the loud case, never a quiet null.
  if (/^[a-z]{2}$/.test(l)) return { kind: "code", code: l };
  if (/^[a-z]{2}[-_][a-z]{2,4}$/i.test(l)) return { kind: "code", code: l.split(/[-_]/)[0]! };

  return { kind: "unmapped", answer: l };
}

/** Which live engine should be the PRIMARY on-screen transcript for a language. */
export function primaryLiveEngine(isEnglish: boolean): "deepgram" | "sarvam" {
  // English → Deepgram (real-time English specialist, pinned en-IN).
  // Non-English → Sarvam (code-mix), with the IndicConformer native box alongside.
  return isEnglish ? "deepgram" : "sarvam";
}
