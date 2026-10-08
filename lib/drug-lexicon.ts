/**
 * lib/drug-lexicon.ts — S8A4: the one place the name-check lexicon is assembled.
 *   data/drug-lexicon.json   drug / brand names and investigation names used in >= 3 signed Pulse prescriptions (scripts/gen-drug-lexicon.ts). NAMES ONLY.
 *   data/clinical-terms.json a small hand-curated symptom / condition list (`terms`) and lab analytes (`analytes`, matched as investigations).
 * ~0.35 MB of JSON, bundled with the one serverless function that imports this file (the sarvam_transcribe job kind, via lib/jobs/kinds); nothing else loads it.
 */
import lexicon from "@/data/drug-lexicon.json";
import clinical from "@/data/clinical-terms.json";
import type { Lexicon } from "./drug-match";

const base = lexicon as unknown as Lexicon;
export const DRUG_LEXICON: Lexicon = {
  ...base,
  investigations: [...(base.investigations ?? []), ...(clinical as { analytes: string[] }).analytes],
  clinical_terms: (clinical as { terms: string[] }).terms,
};
