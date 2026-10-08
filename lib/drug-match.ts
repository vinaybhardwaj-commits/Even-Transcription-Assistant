/**
 * lib/drug-match.ts — S8A4: propose drug-name corrections for an English transcript. PURE. NEVER rewrites text.
 *
 * A speech model that hears "Combiflam" in an Indian-English sentence may write "combat land". The lexicon (data/drug-lexicon.json, drug / brand NAMES only, generated
 * from Pulse's medication catalog by scripts/gen-drug-lexicon.ts: no patient data, no strengths) is matched against every 1-3 word window of the text by two
 * measures — letter similarity and a consonant-skeleton ("phonetic") similarity — and a candidate {entry_idx, heard, suggested, score, source} is proposed when the
 * best of the two clears the threshold. Numbers, doses and units are never part of a window (a window touching a digit is skipped), so they cannot be altered.
 * A window that already IS a lexicon name proposes nothing. Callers report the candidates; a human or a later step decides.
 */
export type Category = "drug" | "investigation" | "clinical_term";
export type DrugCandidate = { entry_idx: number; heard: string; suggested: string; score: number; source: string; category: Category };
/** names = drug / brand names; investigations = test names; clinical_terms = a small curated symptom / condition list (data/clinical-terms.json). All are names only. */
export type Lexicon = { version: string; source: string; names: string[]; investigations?: string[]; clinical_terms?: string[] };

export const DRUG_MATCH_THRESHOLD = 0.55;
const MIN_HEARD_LEN = 5; // "Rx" / "PX" / "mg" are too short to say anything ...
const MAX_ACRONYM_LEN = 4; // ... except an ALL-CAPS token of 2-4 letters ("IG"), which may be an acronym test name ("IgE") garbled to its first letters
const MAX_WORDS = 3;

const squash = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");

/** Consonant skeleton: sound-alike letters folded, vowels and doubled letters dropped (k for c/k/q, f for ph/v, s for c-before-e/i/z, ...). */
export function phoneticKey(s: string): string {
  let t = squash(s);
  t = t.replace(/ph/g, "f").replace(/ck/g, "k").replace(/ch/g, "c").replace(/sh/g, "s").replace(/th/g, "t").replace(/kn/g, "n").replace(/wr/g, "r").replace(/x/g, "ks");
  t = t.replace(/c(?=[eiy])/g, "s").replace(/c/g, "k").replace(/q/g, "k").replace(/z/g, "s").replace(/v/g, "f").replace(/w/g, "f").replace(/[dt]/g, "t").replace(/[bp]/g, "b").replace(/[gj]/g, "g");
  t = t.replace(/[aeiouyh]/g, "");
  return t.replace(/(.)\1+/g, "$1");
}

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[n]!;
}
const sim = (a: string, b: string): number => (a.length === 0 && b.length === 0 ? 0 : 1 - lev(a, b) / Math.max(a.length, b.length));

function lcs(a: string, b: string): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur.push(a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!));
    prev = cur;
  }
  return prev[b.length]!;
}
const sharedPrefix = (a: string, b: string): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

/**
 * Similarity 0..1: the best of (1) letter similarity, (2) consonant-skeleton similarity, (3) order-preserving common-letters similarity (2*LCS / total length) — the
 * one that catches "nodrinal" for "nocturia" — each gated so it cannot fire on a stranger: the first sound must agree, and (2) / (3) also need a shared start.
 */
export function nameScore(heard: string, name: string, words = 1): number {
  const h = squash(heard), n = squash(name);
  if (!h || !n || phoneticKey(h)[0] !== phoneticKey(n)[0]) return 0;
  const letters = sim(h, n);
  const pre = sharedPrefix(h, n);
  const pk = sim(phoneticKey(h), phoneticKey(n));
  // the skeleton alone over-matches short names, so it counts only with a shared 2-letter start and a similar length
  const lenOk = Math.abs(h.length - n.length) <= 3 && Math.min(h.length, n.length) >= 4;
  const common = (2 * lcs(h, n)) / (h.length + n.length);
  // the common-letters measure is the loosest: it counts at 92% and only for windows of similar length
  const similarLen = Math.min(h.length, n.length) / Math.max(h.length, n.length) >= 0.6;
  const lcsScore = pre >= 2 && similarLen ? common * 0.92 : 0;
  // the skeleton measure is for ONE word (a multi-word window has too many consonants to compare)
  return Math.max(letters, words === 1 && lenOk && pre >= 2 ? pk : 0, Math.min(h.length, n.length) >= 3 ? lcsScore : 0);
}

const COMMON = new Set(`a abdomen about above across advice advise after again against ago all along also always am an and another any anyone anything are arm arms around ask asked asks baby back bad be been before being belly below best better between big both bread breath breathing but came can capsule capsules cause causes check checked checking chest child children clear clinic coffee cold come comes coming continue continued cough could crossing daily daughter day days did different do doctor doctors does doing done dose doses down drinking during each ear early ears eating eight either even evening ever every everyone everything eye eyes family father feel feeling feels feet felt fever few fine first five follow followup food foot for four friend from gave get gets getting give given gives giving go goes going gone good got had hair hand hands has have having he head heart her here high him his history home hospital hour hours house how husband i if into is issue issues it its job just keep kept kidney kidneys last late later least leg legs less let lets level levels line little liver long look looked looks lot lots low lung lungs madam made make makes mam man many may me meal meals might milk mine minute minutes moment month months more morning most mother mouth much must my neck need needed needs neither never new next night nights nine no normal nose not nothing now nurse off office often oil okay old once one only onto or other our out over own pain pains part parts passing patient patients people place places problem problems put puts report reports rest result results review rice right room running said salt same saw say says school second see seeing seen sees seven shall she short should side sides since sir sister sitting six skin sleep sleeping small some someone something son soon standing start started starts still stomach stop stopped stops such sugar symptom symptoms syrup tablet tablets take taken takes taking tea teeth tell tells ten test tests than that the their them then there these they thing things third this those three thrice throat through time times today told tomorrow too took tooth twice two under until up upon us usual very walking want wanted wants was water way ways we week weekly weeks well went were what when where which while who whom whose why wife will with within without woman work worse worst would wrong year years yes yesterday you young your`.split(" "));
/** very common English words: never proposed as a mis-hearing of a name, alone or as a whole multi-word window */
const isCommon = (w: string): boolean => COMMON.has(w.toLowerCase());
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;

const allNames = (lex: Lexicon): Array<{ name: string; category: Category }> => [
  ...lex.names.map((name) => ({ name, category: "drug" as const })),
  ...(lex.investigations ?? []).map((name) => ({ name, category: "investigation" as const })),
  ...(lex.clinical_terms ?? []).map((name) => ({ name, category: "clinical_term" as const })),
];

/** Candidates for one English text. `entryIdx` is carried through. A window containing a digit is skipped, so doses and numbers are never touched. */
export function drugCandidates(text: string, entryIdx: number, lex: Lexicon, threshold: number = DRUG_MATCH_THRESHOLD): DrugCandidate[] {
  const words = [...text.matchAll(WORD)].map((m) => m[0]);
  const entries = allNames(lex);
  const known = new Set(entries.map((e) => squash(e.name)));
  const out: DrugCandidate[] = [];
  const taken = new Set<number>();
  // smallest windows first: "Bilus" is proposed before "Bilus M at", and a word already inside a candidate is not used again
  for (let size = 1; size <= MAX_WORDS; size++) {
    for (let i = 0; i + size <= words.length; i++) {
      if ([...Array(size).keys()].some((k) => taken.has(i + k))) continue;
      const win = words.slice(i, i + size);
      if (win.some((w) => /\d/.test(w))) continue;
      if (win.every((w) => isCommon(w))) continue; // plain English ("she has", "since two") is never a mis-hearing of a name
      if (win.some((w) => known.has(squash(w)))) continue; // a window that already contains a real lexicon name is not a mis-hearing of one
      if (size > 1 && win.some((w) => squash(w).length < 3)) continue; // a multi-word window is made of real words, not of "a", "of", "M"
      const heard = win.join(" ");
      const h = squash(heard);
      // a 2-4 letter ALL-CAPS single token is an acronym candidate; anything else under 5 letters says nothing
      const acronym = size === 1 && /^[A-Z]{2,4}$/.test(heard);
      if (h.length < MIN_HEARD_LEN && !acronym) continue;
      if (known.has(h)) continue;
      const scored = entries.map((e) => ({ ...e, score: nameScore(heard, e.name, size) })).filter((x) => x.score >= threshold && !(acronym && squash(x.name).length > MAX_ACRONYM_LEN + 1));
      if (scored.length > 0) {
        scored.sort((x, y) => y.score - x.score || (x.name < y.name ? -1 : 1));
        // the best, and any name scoring within 0.03 of it (up to 3): a tie ("IG" -> IgA or IgE) is reported, not guessed
        for (const x of scored.filter((y) => y.score >= scored[0]!.score - 0.03).slice(0, 3)) {
          out.push({ entry_idx: entryIdx, heard, suggested: x.name, score: Math.round(x.score * 100) / 100, source: lex.source, category: x.category });
        }
        for (let k = 0; k < size; k++) taken.add(i + k);
      }
    }
  }
  return out.sort((a, b) => b.score - a.score || (a.heard < b.heard ? -1 : 1));
}
