/**
 * useLanguageRouter — CONTINUOUS, hysteretic language detection for the live
 * recording surface. The live engines (Deepgram/Sarvam/Whisper) already run in
 * PARALLEL, so this never starts/stops an engine — it decides, on a rolling
 * window, WHICH stream to trust and display, and the IndicConformer native box
 * appears only when the language is genuinely non-English.
 *
 * Detection: Whisper LID (trusted) + Sarvam code + live script, fed through the
 * same corroborated, English-biased rule as submit (decideEncounterLanguage),
 * then smoothed with HYSTERESIS so a single noisy window can't flip the UI.
 *
 * The hysteresis core (advanceRouter) is pure and unit-tested
 * (tests/unit/language-route.test.ts). Default state = English.
 */
import * as React from "react";
import { decideEncounterLanguage, isKnownNonEnglish, hasIndicScript } from "./language-route";

export type RouterState = {
  current: "en" | "non-en";   // the committed language class (default English)
  lang: string | null;        // committed language code
  candidate: "en" | "non-en" | null;
  candidateLang: string | null;
  candidateCount: number;
};

export const INITIAL_ROUTER: RouterState = {
  current: "en",
  lang: "en",
  candidate: null,
  candidateLang: null,
  candidateCount: 0,
};

/**
 * Advance the router with ONE window observation. Flip the committed class only
 * after `flipAfter` consecutive windows agree on a different class — otherwise
 * stay put. English is the default and the tiebreak.
 */
export function advanceRouter(
  prev: RouterState,
  obs: { nonEnglish: boolean; language: string | null },
  flipAfter = 2,
): RouterState {
  const obsClass: "en" | "non-en" = obs.nonEnglish ? "non-en" : "en";

  if (obsClass === prev.current) {
    // confirms the status quo — refresh the committed code, clear any candidate
    return { ...prev, lang: obs.language ?? prev.lang, candidate: null, candidateLang: null, candidateCount: 0 };
  }
  // disagrees with the committed class — build/extend a candidate
  const count = prev.candidate === obsClass ? prev.candidateCount + 1 : 1;
  if (count >= flipAfter) {
    return { current: obsClass, lang: obs.language ?? prev.lang, candidate: null, candidateLang: null, candidateCount: 0 };
  }
  return { ...prev, candidate: obsClass, candidateLang: obs.language ?? null, candidateCount: count };
}

export type LanguageRouter = {
  isEnglish: boolean;
  lang: string | null;
  /** sampled window history (telemetry / submit aggregate) */
  windows: Array<{ t: number; lang: string | null; nonEnglish: boolean }>;
};

/**
 * Live hook: samples the current window's language every `intervalMs` from the
 * Whisper/Sarvam signals and smooths it. Returns the committed isEnglish + code.
 */
export function useLanguageRouter(opts: {
  enabled: boolean;
  whisperLang: string | null | undefined;
  sarvamLang: string | null | undefined;
  whisperText: string | null | undefined;
  sarvamText: string | null | undefined;
  intervalMs?: number;
  flipAfter?: number;
  /** Dictation note types (operative/dietetic/physio) are ~always an English
   *  monologue. When set, only flip to non-English if WHISPER itself says so —
   *  never on Sarvam's transliterated script. */
  englishPrior?: boolean;
}): LanguageRouter {
  const { enabled, intervalMs = 3000, flipAfter = 2 } = opts;
  const [state, setState] = React.useState<RouterState>(INITIAL_ROUTER);
  const [windows, setWindows] = React.useState<LanguageRouter["windows"]>([]);

  // keep the latest signals in a ref so the interval reads fresh values
  const sigRef = React.useRef(opts);
  sigRef.current = opts;

  React.useEffect(() => {
    if (!enabled) return;
    const iv = window.setInterval(() => {
      const s = sigRef.current;
      let obs = decideEncounterLanguage({
        whisperLang: s.whisperLang,
        sarvamLang: s.sarvamLang,
        whisperText: s.whisperText,
        sarvamText: s.sarvamText,
      });
      // Dictation English prior: a non-English flip on a dictation note requires
      // Whisper's OWN evidence (a non-English label or native script). Sarvam's
      // transliteration alone (the Dr. Chandrika operative-note case) can't flip it.
      if (s.englishPrior && obs.nonEnglish) {
        const wOwnNonEn = isKnownNonEnglish(s.whisperLang) || hasIndicScript(s.whisperText);
        if (!wOwnNonEn) obs = { nonEnglish: false, language: "en", reason: "english_prior" };
      }
      setState((prev) => advanceRouter(prev, obs, flipAfter));
      setWindows((w) => (w.length > 600 ? w : [...w, { t: Date.now(), lang: obs.language, nonEnglish: obs.nonEnglish }]));
    }, intervalMs);
    return () => window.clearInterval(iv);
  }, [enabled, intervalMs, flipAfter]);

  return { isEnglish: state.current === "en", lang: state.lang, windows };
}
