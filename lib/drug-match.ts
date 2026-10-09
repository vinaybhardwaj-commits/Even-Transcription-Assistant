/**
 * lib/drug-match.ts — S8A4: propose drug-name corrections for an English transcript. PURE. NEVER rewrites text.
 *
 * A speech model that hears "Combiflam" in an Indian-English sentence may write "combat land". The lexicon (data/drug-lexicon.json, drug / brand NAMES only, generated
 * from Pulse's medication catalog by scripts/gen-drug-lexicon.ts: no patient data, no strengths) is matched against every 1-3 word window of the text by two
 * measures — letter similarity and a consonant-skeleton ("phonetic") similarity — and a candidate {entry_idx, heard, suggested, score, source} is proposed when the
 * best of the two clears the threshold. Numbers, doses and units are never part of a window (a window touching a digit is skipped), so they cannot be altered.
 * A window that already IS a lexicon name proposes nothing. Callers report the candidates; a human or a later step decides.
 */
import commonWords from "@/data/common-english-words.json";
import clinicalWords from "@/data/clinical-english-words.json";

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

function scoreForms(h: string, hp: string, n: string, np: string, words: number, letterOnly = false): number {
  if (!h || !n || hp[0] !== np[0]) return 0;
  const letters = sim(h, n);
  if (letterOnly) return letters;
  const pre = sharedPrefix(h, n);
  const pk = sim(hp, np);
  // the skeleton alone over-matches short names, so it counts only with a shared 2-letter start and a similar length
  const lenOk = Math.abs(h.length - n.length) <= 3 && Math.min(h.length, n.length) >= 4;
  const common = (2 * lcs(h, n)) / (h.length + n.length);
  // the common-letters measure is the loosest: it counts at 92% and only for windows of similar length
  const similarLen = Math.min(h.length, n.length) / Math.max(h.length, n.length) >= 0.6;
  const lcsScore = pre >= 2 && similarLen ? common * 0.92 : 0;
  // the skeleton measure is for ONE word (a multi-word window has too many consonants to compare)
  // (a skeleton of fewer than 4 consonants says too little: "reduce" and "retoz" are both r-t-s)
  const pkScore = words === 1 && lenOk && pre >= 2 && hp.length >= 4 && np.length >= 4 && letters >= 0.45 ? pk * 0.85 : 0;
  return Math.max(letters, pkScore, Math.min(h.length, n.length) >= 3 ? lcsScore : 0);
}

/**
 * Similarity 0..1: the best of (1) letter similarity, (2) consonant-skeleton similarity, (3) order-preserving common-letters similarity (2*LCS / total length) — the
 * one that catches "nodrinal" for "nocturia" — each gated so it cannot fire on a stranger: the first sound must agree, and (2) / (3) also need a shared start.
 */
export function nameScore(heard: string, name: string, words = 1): number {
  const h = squash(heard), n = squash(name);
  return scoreForms(h, phoneticKey(h), n, phoneticKey(n), words);
}

const COMMON = new Set(`a abdomen about above across advice advise after again against ago all along also always am an and another any anyone april are arm arms around ask asked asks august baby back bad be been before being belly below best better between big blood both bread breath breathing but came can capsule capsules cause causes check checked checking chest child children clear clinic coffee cold come comes coming continue continued cough could count crossing culture daily daughter day days december did different do doctor doctors does doing done dose doses down drinking during each ear early ears eating eight either even evening ever every everyone everything eye eyes family father february feel feeling feels feet felt fever few fine first five followup food foot for four friday friend from gave get gets getting give given gives giving go goes going gone good got had hair hand has have having he head heart height her here high him his history home hour hours house how husband i if into is issue issues it its january job july june just keep kept kidney kidneys last late later least leg legs less let lets level levels line little liver long look looked looks lot lots low lung lungs madam made make makes mam man many march may me meal meals might milk mine minute minutes moment monday month months more morning most mother mouth much must my neck need needed needs neither never new next night nights nine no normal nose not nothing november now nurse october off office often oil okay old once one only onto or other our out over own pain pains part parts passing patient patients people place places pressure problem problems pulse put puts report reports rest result results review rice right routine running said salt same sample saturday saw say says scan school second see seeing seen sees september seven shall she short should side sides since sir sister sitting six skin sleeping some someone something son soon standing start started starts still stomach stool stop stopped stops such sugar sunday symptom symptoms syrup tablet tablets take taken takes taking tea teeth tell tells temperature ten test tests than that the their them then there these they thing things third this those three thrice throat through thursday time times today told tomorrow too took tooth tuesday twice two under until up upon urine us usual very walking want wanted wants was water way ways we wednesday week weekly weeks weight well went were what when where which while who whom whose why wife will with within without woman work worse worst would wrong year years yes yesterday you young your`.split(" "));
/** articles, prepositions, pronouns, auxiliaries: a multi-word window never contains one ("the road", "she has") */
const FUNCTION_WORDS = new Set(`the a an and or but if then than that this these those there here when where what which who whom whose why how not no yes all any some each every both either neither more most less least much many few little very too also only just even still again always never often ever once twice since until while after before during about above below between into onto over under through across along around against without within upon from with for off out down up i me my mine we us our you your he him his she her it its they them their one two three is are was were be been being am do does did done doing have has had having can could shall should will would may might must to of in on at by as so`.split(" "));
/** very common English words: never proposed as a mis-hearing of a name, alone or as a whole multi-word window */
const isCommon = (w: string): boolean => inflectedIn(COMMON, w);

/**
 * S8A8 D2 — INFLECTED FORMS. The word lists hold base forms ("medicine"); "medicines", "tolerated", "stretching" are the same ordinary words and must not escape the gate on a plural or a tense.
 * True when the word, or the word with a plural / past / -ing / -ly ending taken off (and the e a dropped ending hid), is in the set. Short words (under 5 letters) are tested as they are.
 */
export function inflectedIn(set: ReadonlySet<string>, word: string): boolean {
  const w = word.toLowerCase();
  if (set.has(w)) return true;
  if (w.length < 5) return false;
  const cands: string[] = [];
  if (w.endsWith("ies")) cands.push(`${w.slice(0, -3)}y`);
  if (w.endsWith("es")) cands.push(w.slice(0, -2));
  if (w.endsWith("s")) cands.push(w.slice(0, -1));
  if (w.endsWith("ed")) cands.push(w.slice(0, -2), w.slice(0, -1), w.slice(0, -3));
  if (w.endsWith("ing")) cands.push(w.slice(0, -3), `${w.slice(0, -3)}e`, w.slice(0, -4));
  if (w.endsWith("ly")) cands.push(w.slice(0, -2));
  return cands.some((c) => c.length >= 4 && set.has(c));
}
/**
 * CONTEXT. A real catalog (~10 000 brand names) holds a near-sound-alike for almost any ordinary word, so a loose score alone is mostly noise. A window is therefore
 * compared at the loose threshold only when a word that talks about that kind of thing sits within a few words of it ("take X twice a day", "X level is high",
 * "complains of X since"); anywhere else it must clear OUT_OF_CONTEXT_THRESHOLD.
 */
export const OUT_OF_CONTEXT_THRESHOLD = 0.85;
/** a brand-name catalog holds a near-sound-alike for almost anything, so a DRUG needs a little more than the investigation / clinical-term lists */
const DRUG_THRESHOLD = 0.6; // and out of context only a CLOSE SPELLING counts (letter similarity, see below)
const CUE_RADIUS = 4;
const CUES: Record<Category, Set<string>> = {
   drug: new Set("tablet tablets tab tabs capsule capsules syrup injection inj cream gel ointment drops started prescribe prescribed prescription medicine medicines medication medications drug drugs dose doses mg ml mcg twice thrice rx dosage".split(" ")),
  investigation: new Set("level levels test tests report reports serum urine blood count profile panel scan xray x-ray ultrasound usg mri ct culture investigation investigations lab labs value values result results sample screening ratio titre titer".split(" ")),
  clinical_term: new Set("complains complaint complaints complained history since having suffering suffers symptom symptoms feels feeling feel has with diagnosed diagnosis noticed noticing episodes episode problem trouble reports reported developed develop".split(" ")),
};
/**
 * G48 — DOSING CUES for a drug. Strong ones (OD / BD / TDS / SOS, "after food", "before food", "at night") count within CUE_RADIUS words. The WEAK ones are everyday verbs and
 * frequency words ("take", "give", "gave", "start", "continue", "daily", "once", "night"): they say nothing about a word four places away ("take the old box to the desk"), so they
 * count only for the words immediately around the window (WEAK_CUE_RADIUS), which still covers "take X after food", "start X for pain", "I gave him X for the fever".
 */
const STRONG_DRUG_CUES = new Set("od bd tds qid sos stat".split(" "));
/** everyday verbs: a cue only when they come BEFORE the window, at most WEAK_CUE_RADIUS words back ("take X", "gave him X", "start X"); after the window they are just speech ("sit straight, take a breath") */
const WEAK_DRUG_VERBS = new Set("take takes taking took give gives gave given giving start starts continue continues continued".split(" "));
/** "daily" counts on either side, at most WEAK_CUE_RADIUS words away; "once" and "night" count only inside the phrases below ("at once", "once he arrives" are not dosing) */
const WEAK_DRUG_FREQ = new Set(["daily", "nightly"]);
const DRUG_PHRASES = ["after food", "before food", "at night", "at bedtime", "with food", "once a day", "once daily", "once at night", "once in the morning", "once a week", "once weekly"];
export const WEAK_CUE_RADIUS = 2;
const lowerWords = (words: string[]): string[] => words.map((w) => w.toLowerCase());

type Cue = "none" | "weak" | "strong";
/** What kind of cue surrounds the window: "strong" (a cue word of its kind within CUE_RADIUS, a dosing abbreviation or phrase), "weak" (an everyday dosing verb / frequency word right beside it), or "none". */
/** Test hook (GATING-G66): how many times cueOf has run. One drugCandidates run may call it at most once per (window, category), never once per lexicon entry. */
export const cueStats = { calls: 0 };
const cueOf = (words: string[], lw: string[], start: number, size: number, c: Category): Cue => {
  cueStats.calls += 1;
  for (let i = Math.max(0, start - CUE_RADIUS); i < Math.min(words.length, start + size + CUE_RADIUS); i++) if (i < start || i >= start + size) if (CUES[c].has(words[i]!.toLowerCase())) return "strong";
  if (c !== "drug") return "none";
  let weak = false;
  for (let i = Math.max(0, start - CUE_RADIUS); i < Math.min(lw.length, start + size + CUE_RADIUS); i++) {
    if ((i >= start && i < start + size)) continue;
    if (STRONG_DRUG_CUES.has(lw[i]!)) return "strong";
    if (i < start && WEAK_DRUG_VERBS.has(lw[i]!) && start - i <= WEAK_CUE_RADIUS) weak = true;
    if (WEAK_DRUG_FREQ.has(lw[i]!) && (i < start ? start - i : i - (start + size) + 1) <= WEAK_CUE_RADIUS) weak = true;
  }
  for (const ph of DRUG_PHRASES) {
    const n = ph.split(" ").length;
    for (let i = Math.max(0, start - CUE_RADIUS - n + 1); i + n <= Math.min(lw.length, start + size + CUE_RADIUS + n - 1); i++) {
      if (lw.slice(i, i + n).join(" ") !== ph) continue;
      if (i + n <= start ? start - (i + n) < CUE_RADIUS : i >= start + size ? i - (start + size) < CUE_RADIUS : false) return "strong";
    }
  }
  return weak ? "weak" : "none";
};

/**
 * G60 — AN ORDINARY ENGLISH WORD IS NOT A DRUG ON A WEAK CUE. data/common-english-words.json is a fixed list of the 8,000 most frequent English words (plain lowercase words, no names). A
 * window of ONE word that is on it ("stairs", "birth", "sugar", "reduce") becomes a candidate only if its score is at least COMMON_WORD_MIN_SCORE AND a STRONG cue is present; with a weak
 * cue ("take the stairs", "gave birth"), with no cue, or with a loose score it yields none. Windows of several words are not subject to it (a garbled drug name is often two ordinary words:
 * "combat land"), nor are unknown words ("nodrinal", "bilus"): those keep the context gate. A word on the list that IS in the lexicon is "known" and never a candidate at all.
 */
export const COMMON_WORD_MIN_SCORE = 0.85;
const COMMON_FREQ: ReadonlySet<string> = new Set((commonWords as { words: string[] }).words);
export const isFrequentWord = (w: string): boolean => inflectedIn(COMMON_FREQ, w);

/**
 * G61 (S8A6) — CLINICAL ENGLISH IS NOT A DRUG, WHATEVER THE CUE. The 8,000-word list is everyday English; a consult is full of words just outside it ("physiotherapy", "tolerated", "elevate",
 * "stretching") and a STRONG cue ("twice", "after food") used to let them through to Physiogel, Tolever-D, Halovate. data/clinical-english-words.json is a small list of plain clinical
 * and rehabilitation vocabulary (no drug or person names; a test pins that none of its words is a lexicon name). A window that contains one of its words is skipped, at every size
 * and whatever the cue; a garbled drug name ("combat land", "nodrinal", "metphormin") has none.
 */
const CLINICAL_ENGLISH: ReadonlySet<string> = new Set((clinicalWords as { words: string[] }).words);
export const isClinicalEnglishWord = (w: string): boolean => inflectedIn(CLINICAL_ENGLISH, w);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;

/** Words that only describe the pack, not the product: dropped from a catalog name before matching ("Niftas 100 Mg Tablet" is matched as "Niftas"). */
const PACK_WORDS = new Set("tablet tablets tab tabs capsule capsules cap caps syrup suspension injection inj cream gel ointment lotion drops drop mouth wash shampoo soap powder sachet spray solution mg gm gms g ml mcg iu sr xr er cr bp ip each with".split(" "));

type Entry = { name: string; category: Category; form: string; pk: string; first: string };
const indexCache = new WeakMap<Lexicon, { buckets: Map<string, Entry[]>; known: Set<string> }>();

/** The matching form of a catalog name: letters only, pack words and numbers removed. "" when nothing is left. */
export function matchForm(name: string): string {
  return squash(name.split(/[\s/,()+-]+/).filter((t) => t && !/\d/.test(t) && !PACK_WORDS.has(t.toLowerCase())).join(" "));
}

/** Built once per lexicon object: entries bucketed by the first sound, so a window is compared with ~1/10 of the names, not all of them. */
function indexOf(lex: Lexicon): { buckets: Map<string, Entry[]>; known: Set<string> } {
  const hit = indexCache.get(lex);
  if (hit) return hit;
  const buckets = new Map<string, Entry[]>();
  const known = new Set<string>();
  const seen = new Set<string>();
  const add = (name: string, category: Category) => {
    const form = matchForm(name);
    if (form.length < 3) return;
    known.add(form);
    if (seen.has(`${category}:${form}`)) return; // many pack sizes of one product are one entry (the first, in file order, is suggested)
    seen.add(`${category}:${form}`);
    const pk = phoneticKey(form);
    const first = pk[0] ?? "";
    const e: Entry = { name, category, form, pk, first };
    const list = buckets.get(first);
    if (list) list.push(e);
    else buckets.set(first, [e]);
  };
  for (const n of lex.names) add(n, "drug");
  for (const n of lex.investigations ?? []) {
    add(n, "investigation");
    // an acronym test name inside a long catalog name ("Chikungunya IgG IgM", "Prostatic Specific Antigen PSA Total") is also an entry of its own: IgG, IgM, PSA
    for (const t of n.split(/[\s/,()+-]+/)) if (/^[A-Za-z]{2,5}$/.test(t) && (t.match(/[A-Z]/g) ?? []).length >= 2) add(t, "investigation");
  }
  for (const n of lex.clinical_terms ?? []) add(n, "clinical_term");
  const built = { buckets, known };
  indexCache.set(lex, built);
  return built;
}

/** Candidates for one English text. `entryIdx` is carried through. A window containing a digit is skipped, so doses and numbers are never touched. */
export function drugCandidates(text: string, entryIdx: number, lex: Lexicon, threshold: number = DRUG_MATCH_THRESHOLD): DrugCandidate[] {
  const words = [...text.matchAll(WORD)].map((m) => m[0]);
  const lwords = lowerWords(words);
  const { buckets, known } = indexOf(lex);
  const out: DrugCandidate[] = [];
  const taken = new Set<number>();
  // smallest windows first: "Bilus" is proposed before "Bilus M at", and a word already inside a candidate is not used again
  for (let size = 1; size <= MAX_WORDS; size++) {
    for (let i = 0; i + size <= words.length; i++) {
      if ([...Array(size).keys()].some((k) => taken.has(i + k))) continue;
      const win = words.slice(i, i + size);
      if (win.some((w) => /\d/.test(w))) continue;
      if (win.every((w) => isCommon(w))) continue; // plain English ("she has", "since two") is never a mis-hearing of a name
      if (win.some((w) => isClinicalEnglishWord(w))) continue; // G61: clinical English, whatever the cue
      if (win.some((w) => known.has(squash(w)))) continue; // a window that already contains a real lexicon name is not a mis-hearing of one
      if (size > 1 && win.some((w) => FUNCTION_WORDS.has(w.toLowerCase()))) continue;
      if (size > 1 && win.some((w) => squash(w).length < 3)) continue; // a multi-word window is made of real words, not of "a", "of", "M"
      const heard = win.join(" ");
      const h = squash(heard);
      // a 2-4 letter ALL-CAPS single token is an acronym candidate; anything else under 5 letters says nothing
      const acronym = size === 1 && /^[A-Z]{2,4}$/.test(heard);
      if (h.length < MIN_HEARD_LEN && !acronym) continue;
      if (known.has(h)) continue;
      const hp = phoneticKey(h);
      // GATING-G67: the cue depends on the window and the category only, so it is computed at most once per (window, category), not once per lexicon entry
      const cueByCat = new Map<Category, Cue>();
      const cueFor = (c: Category): Cue => { let v = cueByCat.get(c); if (v === undefined) { v = cueOf(words, lwords, i, size, c); cueByCat.set(c, v); } return v; };
      const scored: Array<Entry & { score: number }> = [];
      for (const e of buckets.get(hp[0] ?? "") ?? []) {
        if (e.form.length > h.length * 2 + 2 || e.form.length * 2 + 2 < h.length) continue; // far-off lengths cannot clear the threshold
        if (acronym && e.form.length > MAX_ACRONYM_LEN + 1) continue;
        if (!acronym && e.form.length < 5) continue; // a 3-4 letter catalog name matches half the dictionary
        if (Math.min(h.length, e.form.length) >= 6 && (e.form.startsWith(h) || h.startsWith(e.form))) continue; // the same word, or a name that merely extends it ("ultrasound" / "Ultrasound Neck")
        // in context: the full score at the threshold; out of context: only a close spelling (letter similarity) at OUT_OF_CONTEXT_THRESHOLD
        const cue = cueFor(e.category);
        const inCtx = cue !== "none";
        const sc = inCtx ? scoreForms(h, hp, e.form, e.pk, size) : scoreForms(h, hp, e.form, e.pk, size, true);
        const need = inCtx ? Math.max(threshold, e.category === "drug" ? DRUG_THRESHOLD : 0) : Math.max(threshold, OUT_OF_CONTEXT_THRESHOLD);
        if (!inCtx && (h.length < 6 || e.form.length < 6)) continue; // out of context, short words are never enough
        // G60: an ordinary English word needs a close score AND a STRONG cue; a weak cue ("take the stairs", "gave birth"), no cue or a loose score yields nothing
        if (size === 1 && isFrequentWord(heard) && !(cue === "strong" && sc >= COMMON_WORD_MIN_SCORE)) continue;
        if (sc >= need) scored.push({ ...e, score: sc });
      }
      if (scored.length > 0) {
        scored.sort((x, y) => y.score - x.score || (x.name < y.name ? -1 : 1));
        // the best, and any name scoring within 0.1 of it (up to 3): a near-tie ("IG" -> IgA or IgE) is reported, not guessed
        for (const x of scored.filter((y) => y.score >= scored[0]!.score - 0.11).slice(0, 3)) {
          out.push({ entry_idx: entryIdx, heard, suggested: x.name, score: Math.round(x.score * 100) / 100, source: lex.source, category: x.category });
        }
        for (let k = 0; k < size; k++) taken.add(i + k);
      }
    }
  }
  return out.sort((a, b) => b.score - a.score || (a.heard < b.heard ? -1 : 1));
}
