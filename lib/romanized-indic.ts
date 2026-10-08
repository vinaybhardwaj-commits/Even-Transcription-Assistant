/**
 * lib/romanized-indic.ts — S8A4-R3 (G43/G45): is a text ROMANISED Hindi / Marathi / Kannada / Tamil / Telugu rather than English? PURE.
 *
 * The English track must never be trusted to be English: if "translate" pass is ignored by API, or Sarvam writes Kannada in Latin letters (saaras transcribe mode
 * does), text looks like plain ASCII. A small list of very common function words of each language, that are not English words, gives a ratio: hits / words.
 * It is a screen, not a classifier: a high ratio sends entry to mayura, a low non-zero one only flags it (mixed_language), and lists are deliberately short and
 * free of words that are also English ("me", "to", "do", "he", "so", "ka" ...).
 */
export type IndicLang = "hi" | "mr" | "kn" | "ta" | "te";
export const BCP47: Record<IndicLang, string> = { hi: "hi-IN", mr: "mr-IN", kn: "kn-IN", ta: "ta-IN", te: "te-IN" };

const LISTS: Record<IndicLang, string> = {
 hi: "hai hain nahi nahin kya mein mujhe mera meri mere aap aapko aapka humko tha thi hoon hun raha rahi rahe kuch bahut abhi theek thik accha acha haan lekin aur kyun kyu kaise kaisa kab kahan yeh woh ye wo isko usko unko iska uska karo kijiye kijie dijiye lijiye lena dena jaana aana bukhar dard dawai dawa khana pani ghar raat subah shaam",
 mr: "aahe ahe ahet aahet nahi mala tumhi tumhala tumhi kay kasa kashi zala zhala zali aani hota hoti hote kharach thoda thodi majha majhi tuza tula amhi aamhi",
 kn: "ide illa alla aadre adre nange nanage naanu nanu neevu nimge nimage enu yaake yake hege aagide aagi maadi maadidri maadi beku bekagide bekagilla howdu haudu gottilla gottagilla banni hogi nodi tumba swalpa jwara novu hotte kaalu kai",
 ta: "illai illa irukku irukkum irukku enna naan enakku enaku unga ungalukku neenga romba konjam vandhu vanthu pannunga pannu sollunga solla seri aama aamam inga anga eppadi yen ean sappadu thanni kaichal thalai vali",
 te: "ledu ledhu undi unnaru nenu naaku naku meeru meeku enti ela cheppandi cheppu rendu baaga bagundi chala kaadu kadu vachindi vachi tisukondi tinnanu ayindi avunu ledandi jwaram thala noppi",
};
const SETS = Object.fromEntries(Object.entries(LISTS).map(([k, v]) => [k, new Set(v.split(" "))])) as Record<IndicLang, Set<string>>;
/** "nu" is a suffix of Tamil / Telugu / Kannada speech in running text ("ledu-nu"); it counts as one weak hit for each, never alone */
const WEAK = new Set(["nu"]);

export type RomanizedScore = { words: number; hits: number; ratio: number; lang: IndicLang | null; byLang: Record<IndicLang, number> };

export function scoreRomanized(text: string): RomanizedScore {
 const words = (text.toLowerCase().match(/[a-z]+/g) ?? []).filter(Boolean);
 const byLang: Record<IndicLang, number> = { hi: 0, mr: 0, kn: 0, ta: 0, te: 0 };
 let hits = 0;
 for (const w of words) {
 let any = false;
 for (const k of Object.keys(SETS) as IndicLang[]) if (SETS[k].has(w)) { byLang[k] += 1; any = true; }
 if (any) hits += 1;
 }
 const weak = words.filter((w) => WEAK.has(w)).length;
 if (hits > 0 && weak > 0) hits += weak;
 const ranked = (Object.entries(byLang) as Array<[IndicLang, number]>).sort((a, b) => b[1] - a[1]);
 // language is known only when one list clearly leads (hi / mr share nahi, ...): a tie is "unknown"
 const lang = ranked[0] && ranked[0][1] > 0 && (ranked[1] === undefined || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
 return { words: words.length, hits, ratio: words.length ? hits / words.length : 0, lang, byLang };
}

/** Thresholds (tests pin them): a whole entry is romanised Indic above these; a lower non-zero score is only "mixed". */
export const ROMANIZED_RATIO = 0.2;
export const ROMANIZED_SHORT_RATIO = 0.3; // entries of up to 4 words
export const MIXED_RATIO = 0.07;

export type Verdict = "english" | "romanized" | "mixed";
export function verdictOf(s: RomanizedScore): Verdict {
 if (s.hits === 0) return "english";
 const whole = s.words <= 4 ? s.ratio >= ROMANIZED_SHORT_RATIO : s.ratio >= ROMANIZED_RATIO && s.hits >= 2;
 if (whole) return "romanized";
 return s.ratio >= MIXED_RATIO ? "mixed" : "english";
}
