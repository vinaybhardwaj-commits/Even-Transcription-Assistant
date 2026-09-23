/**
 * lib/jev/clinical-route-heuristic.ts — the "V-free" baseline for U6's 50-window bench (order
 * JEV-U6-ROUTE, PLAN-v3 §A): a cheap, transparent, rule-based classifier that needs no human
 * labelling, so U6's Jev judgement can be calibrated against SOMETHING before V spends time
 * hand-labelling a set. It is NOT ground truth — a rule of thumb, honestly a rough one, and
 * lib/jev/bench.ts's scoreJevBench run against it measures AGREEMENT with a proxy, not accuracy.
 *
 * PURE. Uses the SAME six labels U6 answers with (lib/jev/prompts/encounter-v1.ts's U6_OPTIONS)
 * so its output and Jev's answer are directly comparable by scoreJevBench without a translation
 * step. "cannot_tell" is this heuristic's own honest fallback when none of its rules fire and the
 * text is not obviously garbled either — it does not guess "clinical" by default.
 */
import { U6_OPTIONS, type U6Option } from "./prompts/encounter-v1";

const PHONE_MARKERS = [/\bhello+[,.]?\s*(can you|hear me)/i, /\bnetwork\b/i, /\bcall\s*(you\s*)?(back|later)\b/i, /\bhold on\b/i, /\bare you there\b/i];
const STAFF_MARKERS = [/\btoken\s*(number)?\b/i, /\bnext patient\b/i, /\b(the\s+)?file\b/i, /\bregist(er|ration)\b/i, /\bschedule\b/i, /\bappointment\s+slot\b/i];
// "pain" needs its own trailing \b — unlike the deliberately prefix-permissive stems below (e.g.
// "diagnos" catching diagnosis/diagnosed/diagnostic), "pain" is a whole medical term that would
// otherwise substring-match ordinary words like "painting" (caught by the 50-window bench, w33).
const CLINICAL_MARKERS = [/\b(pain\b|fever|cough|tablet|mg|dose|dosage|injection|symptom|examine|examination|diagnos|prescri|medicine|blood pressure|allerg)/i];

/** A rough coherence check: very short, or mostly non-letter characters — the same intuition
 * U6's own "garbled_or_no_real_speech" criterion describes ("fragments... no coherent
 * information content"), applied heuristically rather than by a model. */
function looksGarbled(text: string): boolean {
  if (text.length < 8) return true;
  const letters = text.replace(/[^a-zA-Zऀ-ॿ]/g, "").length; // Latin + Devanagari
  return letters / text.length < 0.4;
}

export function heuristicClinicalRoute(text: string): U6Option {
  const trimmed = text.trim();
  if (looksGarbled(trimmed)) return "garbled_or_no_real_speech";
  if (PHONE_MARKERS.some((re) => re.test(trimmed))) return "phone_call";
  if (STAFF_MARKERS.some((re) => re.test(trimmed))) return "staff_or_admin_talk";
  if (CLINICAL_MARKERS.some((re) => re.test(trimmed))) return "clinical_consultation";
  return "cannot_tell";
}

/** Every label this heuristic can return is one of U6's own six options — asserted once here so
 * a future edit that returns a label outside the closed set fails loudly, not silently. */
export function isValidU6Option(label: string): label is U6Option {
  return (U6_OPTIONS as readonly string[]).includes(label);
}
