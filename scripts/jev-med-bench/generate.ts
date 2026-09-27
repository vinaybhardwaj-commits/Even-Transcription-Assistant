/**
 * scripts/jev-med-bench/generate.ts — the medication-note bench dataset (W27.7b, ruled W30.3).
 *
 * Deterministic from a seed. Every transcript is INVENTED; the formulary is vocabulary only. Labels
 * are by construction: a `supported` sentence renders the truth line; an `unsupported` sentence
 * renders the truth line with exactly ONE change (dose, number, or drug) against an unchanged
 * transcript. No labeller, no human, no model.
 *
 * Layout: N_LINES truth lines per split; each line yields one transcript excerpt and four note
 * sentences (2 supported, 2 perturbed). Splits are by DRUG, so a drug never spans dev and test.
 */
import { FORMULARY, FORMULARY_BY_KEY, type Drug } from "./formulary";

export type Split = "dev" | "test";
export type Perturbation = "dose" | "number" | "drug";
export type Label = "supported" | "unsupported";

export type Line = {
  drug: Drug;
  strength: string;
  qty: number; // tablets/capsules per dose; 0 for non-oral forms
  pattern: Pattern;
  duration: { n: number; unit: "day" | "month" } | null; // null for sos
};

export type Sentence = {
  case_id: string;
  text: string;
  label: Label;
  perturbation: Perturbation | null;
  detail: string; // e.g. "dose:alt_strength", "drug:lasa"; "" for supported
  tags: string[]; // codemixed, brand_generic, abbrev
};

export type Excerpt = {
  excerpt_id: string;
  split: Split;
  drug_key: string;
  style: "en" | "mixed";
  excerpt: string;
  sentences: Sentence[];
};

export type Pattern = "1-0-0" | "0-0-1" | "1-0-1" | "1-1-1" | "sos";
const PATTERNS: Pattern[] = ["1-0-0", "0-0-1", "1-0-1", "1-1-1", "sos"];
const DURATIONS: Array<{ n: number; unit: "day" | "month" }> = [
  { n: 3, unit: "day" }, { n: 5, unit: "day" }, { n: 7, unit: "day" }, { n: 10, unit: "day" }, { n: 14, unit: "day" },
  { n: 1, unit: "month" }, { n: 2, unit: "month" }, { n: 3, unit: "month" },
];

// ---------------------------------------------------------------- rng
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}
export function makeRng(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
function shuffle<T>(rng: () => number, xs: T[]): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ---------------------------------------------------------------- spoken and written forms
const EN_NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen"];
const HI_NUM = ["shoonya", "ek", "do", "teen", "chaar", "paanch", "chhe", "saat", "aath", "nau", "das", "gyaarah", "baarah", "terah", "chaudah"];

function spokenNumber(n: number, style: "en" | "mixed", rng: () => number): string {
  if (n <= 14 && rng() < 0.7) return style === "mixed" ? HI_NUM[n]! : EN_NUM[n]!;
  return String(n);
}

const FORM_WORD: Record<Drug["form"], string> = { Tab: "tablet", Cap: "capsule", Syp: "syrup", Inj: "injection", Cream: "cream", Gel: "gel", Powder: "sachet" };
const ORAL: Drug["form"][] = ["Tab", "Cap"];
const isOral = (f: Drug["form"]) => ORAL.includes(f);

const FREQ_SPOKEN: Record<Pattern, { en: string; mixed: string }> = {
  "1-0-0": { en: "once a day in the morning", mixed: "subah ek baar" },
  "0-0-1": { en: "once a day at night", mixed: "raat ko sote waqt" },
  "1-0-1": { en: "twice a day, morning and night", mixed: "subah aur raat, din mein do baar" },
  "1-1-1": { en: "three times a day", mixed: "din mein teen baar" },
  sos: { en: "only when you need it", mixed: "sirf zaroorat padne par" },
};
const FREQ_NOTE: Record<Pattern, string[]> = {
  "1-0-0": ["once daily in the morning", "OD (morning)", "1-0-0"],
  "0-0-1": ["once daily at night", "HS", "0-0-1"],
  "1-0-1": ["twice daily", "BD", "1-0-1"],
  "1-1-1": ["three times daily", "TDS", "1-1-1"],
  sos: ["as needed", "SOS", "SOS"],
};

function spokenDuration(d: NonNullable<Line["duration"]>, style: "en" | "mixed", rng: () => number): string {
  const num = spokenNumber(d.n, style, rng);
  if (style === "mixed") return `${num} ${d.unit === "day" ? "din" : "mahine"}`;
  return `${num} ${d.unit}${d.n > 1 ? "s" : ""}`;
}
function noteDuration(d: NonNullable<Line["duration"]>): string {
  return `${d.n} ${d.unit}${d.n > 1 ? "s" : ""}`;
}

/** "500 mg" -> spoken "five hundred milligram" half the time is overkill; digits or "mg" spelled. */
function spokenStrength(s: string, rng: () => number): string {
  const spelled = s.replace(/\bmg\b/g, "milligram").replace(/\bmcg\b/g, "microgram").replace(/\bIU\b/g, "international units").replace(/\bg\b/g, "gram").replace("/", " and ");
  return rng() < 0.5 ? spelled : s.replace("/", " and ");
}

function spokenName(drug: Drug, useBrand: boolean): string {
  return useBrand ? drug.brands[0]! : drug.generic;
}

// ---------------------------------------------------------------- transcript
const CHATTER_EN = [
  "Any trouble with your stomach from the earlier medicines?",
  "Drink plenty of water and avoid oily food for now.",
  "Okay doctor, I understand.",
  "Come and see me again if it does not settle.",
  "Do you have any questions for me?",
  "Fine, let us do it that way then.",
];
const CHATTER_MIXED = [
  "Pet mein koi problem to nahi hui pehle wali dawai se?",
  "Paani khoob piyo aur tel wala khana abhi mat khao.",
  "Theek hai doctor, samajh gaya.",
  "Agar aaram na mile to phir dikhana.",
  "Koi sawaal hai aapka?",
  "Achha, phir aise hi karte hain.",
];

export function renderExcerpt(line: Line, style: "en" | "mixed", useBrand: boolean, distractor: Drug | null, rng: () => number): string {
  const name = spokenName(line.drug, useBrand);
  const form = FORM_WORD[line.drug.form];
  const strength = spokenStrength(line.strength, rng);
  const chatter = style === "mixed" ? CHATTER_MIXED : CHATTER_EN;
  const turns: string[] = [];
  turns.push(`Doctor: ${style === "mixed" ? "Toh iske liye main aapko" : "So for this I am giving you"} ${name}, ${strength}.`);
  const qtyWord = line.qty > 0 ? `${spokenNumber(line.qty, style, rng)} ${form}` : `the ${form}`;
  const freq = FREQ_SPOKEN[line.pattern][style];
  if (line.pattern === "sos") {
    turns.push(`Doctor: ${style === "mixed" ? "Lena hai" : "Take"} ${qtyWord} ${freq}.`);
  } else {
    const dur = spokenDuration(line.duration!, style, rng);
    turns.push(`Doctor: ${style === "mixed" ? "Lena hai" : "Take"} ${qtyWord} ${freq}, ${style === "mixed" ? "" : "for "}${dur}.`);
  }
  turns.push(`Patient: ${pick(rng, chatter)}`);
  if (distractor) {
    turns.push(`Doctor: ${style === "mixed" ? "Aur aapki" : "And keep taking your"} ${spokenName(distractor, rng() < 0.5)} ${style === "mixed" ? "pehle jaisi hi chalne dijiye." : "as before."}`);
  }
  turns.push(`Doctor: ${pick(rng, chatter)}`);
  return turns.join("\n");
}

// ---------------------------------------------------------------- note sentences
type Wording = 0 | 1 | 2;

export function renderSentence(line: Line, nameDrug: Drug, useBrand: boolean, w: Wording, rng: () => number): { text: string; abbrev: boolean } {
  const form = nameDrug.form;
  const name = useBrand ? nameDrug.brands[0]! : nameDrug.generic;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const qty = line.qty > 0 && isOral(form) ? `${line.qty} ${FORM_WORD[form]}${line.qty > 1 ? "s" : ""} ` : "";
  const freqOpts = FREQ_NOTE[line.pattern];
  const dur = line.duration ? noteDuration(line.duration) : "";
  if (w === 0) {
    const f = freqOpts[0]!;
    return { text: `${form} ${cap(name)} ${line.strength} ${qty}${f}${dur ? ` for ${dur}` : ""}.`, abbrev: false };
  }
  if (w === 1) {
    const f = freqOpts[1]!;
    const both = useBrand ? `${cap(name)} (${nameDrug.generic})` : cap(name);
    return { text: `${both} ${line.strength}, ${f}${dur ? `, ${dur}` : ""}.`, abbrev: true };
  }
  const f = freqOpts[2]!;
  return { text: `${cap(name)} ${line.strength} ${f}${dur ? ` x ${dur}` : ""}.`, abbrev: true };
}

// ---------------------------------------------------------------- perturbations
function shiftFirstNumber(s: string, rng: () => number): string {
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return s;
  const v = parseFloat(m[1]!);
  const nv = rng() < 0.5 ? v * 10 : v / 10;
  const txt = Number.isInteger(nv) ? String(nv) : String(nv);
  return s.replace(m[1]!, txt);
}

export function perturbLine(line: Line, kind: Perturbation, rng: () => number, exclude: Set<string>): { line: Line; nameDrug: Drug; detail: string } {
  if (kind === "dose") {
    const opts: Array<() => { s: string; d: string } | null> = [
      () => {
        const alts = line.drug.strengths.filter((x) => x !== line.strength);
        return alts.length ? { s: pick(rng, alts), d: "alt_strength" } : null;
      },
      () => ({ s: shiftFirstNumber(line.strength, rng), d: "decimal_shift" }),
      () => {
        if (/\bmg\b/.test(line.strength) && !line.strength.includes("/")) return { s: line.strength.replace("mg", "mcg"), d: "unit_swap" };
        if (/\bmcg\b/.test(line.strength)) return { s: line.strength.replace("mcg", "mg"), d: "unit_swap" };
        return null;
      },
    ];
    for (const i of shuffle(rng, [0, 0, 1, 1, 2])) {
      const r = opts[i]!();
      if (r && r.s !== line.strength) return { line: { ...line, strength: r.s }, nameDrug: line.drug, detail: `dose:${r.d}` };
    }
    return { line: { ...line, strength: shiftFirstNumber(line.strength, rng) }, nameDrug: line.drug, detail: "dose:decimal_shift" };
  }
  if (kind === "number") {
    const choices: Array<() => { l: Line; d: string } | null> = [
      () => {
        const p = pick(rng, PATTERNS.filter((x) => x !== line.pattern && (line.pattern !== "sos" || x !== "sos")));
        const duration = p === "sos" ? null : line.duration ?? pick(rng, DURATIONS);
        return { l: { ...line, pattern: p, duration }, d: "frequency" };
      },
      () => {
        if (!line.duration) return null;
        const alt = pick(rng, DURATIONS.filter((x) => !(x.n === line.duration!.n && x.unit === line.duration!.unit)));
        return { l: { ...line, duration: alt }, d: "duration" };
      },
      () => (line.qty > 0 ? { l: { ...line, qty: line.qty === 1 ? 2 : 1 }, d: "quantity" } : null),
    ];
    for (const i of shuffle(rng, [0, 1, 1, 2])) {
      const r = choices[i]!();
      if (r) return { line: r.l, nameDrug: line.drug, detail: `number:${r.d}` };
    }
    return { line: { ...line, pattern: line.pattern === "1-0-1" ? "1-1-1" : "1-0-1", duration: line.duration ?? DURATIONS[1]! }, nameDrug: line.drug, detail: "number:frequency" };
  }
  // drug swap — the strength text is kept, so this is exactly ONE change; the named drug differs.
  const kinds = shuffle(rng, ["lasa", "class", "random"] as const);
  for (const k of kinds) {
    let target: Drug | undefined;
    if (k === "lasa") {
      const p = line.drug.lasa ? FORMULARY_BY_KEY[line.drug.lasa] : undefined;
      target = p && !exclude.has(p.key) && p.key !== line.drug.key ? p : undefined;
    } else if (k === "class") {
      const same = FORMULARY.filter((x) => x.cls === line.drug.cls && x.key !== line.drug.key && !exclude.has(x.key));
      const sharing = same.filter((x) => x.strengths.includes(line.strength));
      target = same.length ? pick(rng, sharing.length ? sharing : same) : undefined;
    } else {
      const rest = FORMULARY.filter((x) => x.key !== line.drug.key && !exclude.has(x.key));
      const sharing = rest.filter((x) => x.strengths.includes(line.strength));
      target = pick(rng, sharing.length ? sharing : rest);
    }
    if (target) {
      return { line, nameDrug: target, detail: `drug:${k}` };
    }
  }
  throw new Error("unreachable: random drug swap always has a target");
}

// ---------------------------------------------------------------- truth lines and splits
export function splitDrugs(seed: string): { dev: Drug[]; test: Drug[] } {
  const rng = makeRng(`${seed}:split`);
  const cap1 = shuffle(rng, FORMULARY.filter((d) => d.fromCap1));
  const rest = shuffle(rng, FORMULARY.filter((d) => !d.fromCap1));
  const dev: Drug[] = [];
  const test: Drug[] = [];
  [...cap1, ...rest].forEach((d, i) => (i % 2 === 0 ? dev : test).push(d));
  return { dev, test };
}

function lineKey(l: Line): string {
  return `${l.drug.key}|${l.strength}|${l.qty}|${l.pattern}|${l.duration ? `${l.duration.n}${l.duration.unit}` : "-"}`;
}

export type GenOpts = { seed: string; linesPerSplit: number };

export function generate(opts: GenOpts): Excerpt[] {
  const { dev, test } = splitDrugs(opts.seed);
  const out: Excerpt[] = [];
  for (const [split, drugs] of [["dev", dev], ["test", test]] as const) {
    const rng = makeRng(`${opts.seed}:${split}`);
    // exactly 40% dose, 30% number, 30% drug across the split's perturbed sentences
    const nPert = opts.linesPerSplit * 2;
    const nDose = Math.round(nPert * 0.4);
    const nNum = Math.round(nPert * 0.3);
    const kinds: Perturbation[] = shuffle(rng, [
      ...Array<Perturbation>(nDose).fill("dose"),
      ...Array<Perturbation>(nNum).fill("number"),
      ...Array<Perturbation>(nPert - nDose - nNum).fill("drug"),
    ]);
    const seen = new Set<string>();
    for (let li = 0; li < opts.linesPerSplit; li++) {
      const drug = drugs[li % drugs.length]!;
      let line: Line;
      for (let tries = 0; ; tries++) {
        const oral = isOral(drug.form);
        const pattern = pick(rng, PATTERNS);
        line = {
          drug,
          strength: pick(rng, drug.strengths),
          qty: oral ? (rng() < 0.75 ? 1 : 2) : 0,
          pattern,
          duration: pattern === "sos" ? null : pick(rng, DURATIONS),
        };
        if (!seen.has(lineKey(line)) || tries > 50) break;
      }
      seen.add(lineKey(line));
      const style: "en" | "mixed" = rng() < 0.4 ? "mixed" : "en";
      const spokenBrand = rng() < 0.5;
      const distractor = rng() < 0.3 ? pick(rng, FORMULARY.filter((x) => x.key !== drug.key && (split === "dev" ? dev : test).includes(x))) : null;
      const excerpt = renderExcerpt(line, style, spokenBrand, distractor, rng);
      const exclude = new Set<string>(distractor ? [distractor.key] : []);
      exclude.add(drug.key);
      const excerpt_id = `${split}-${String(li).padStart(3, "0")}`;
      const sentences: Sentence[] = [];
      const tagsFor = (nameBrand: boolean, abbrev: boolean, nameDrug: Drug): string[] => {
        const t: string[] = [];
        if (style === "mixed") t.push("codemixed");
        if (nameBrand !== spokenBrand && nameDrug.key === line.drug.key) t.push("brand_generic");
        if (abbrev) t.push("abbrev");
        return t;
      };
      // two supported wordings, distinct; brand/generic mismatch happens by chance and is tagged
      const ws = shuffle(rng, [0, 1, 2] as Wording[]).slice(0, 2);
      ws.forEach((w, si) => {
        const useBrand = rng() < 0.5;
        const r = renderSentence(line, drug, useBrand, w, rng);
        sentences.push({ case_id: `${excerpt_id}-s${si}`, text: r.text, label: "supported", perturbation: null, detail: "", tags: tagsFor(useBrand, r.abbrev, drug) });
      });
      for (let pi = 0; pi < 2; pi++) {
        const kind = kinds[li * 2 + pi]!;
        let made: ReturnType<typeof perturbLine> | null = null;
        let text = "";
        let abbrev = false;
        let useBrand = false;
        for (let tries = 0; ; tries++) {
          made = perturbLine(line, kind, rng, exclude);
          useBrand = rng() < 0.5;
          // A quantity change is only VISIBLE in wording 0 (the others omit the count), so force it there.
          const w: Wording = made.detail === "number:quantity" ? 0 : pick(rng, [0, 1, 2] as Wording[]);
          const r = renderSentence(made.line, made.nameDrug, useBrand, w, rng);
          text = r.text;
          abbrev = r.abbrev;
          // INVARIANT: the change is visible in the sentence — it differs from the truth rendered the
          // same way — and it is not a duplicate of a sibling.
          const truthSame = renderSentence(line, line.drug, useBrand, w, rng).text;
          const visible = kind === "drug" ? made.nameDrug.key !== line.drug.key : text !== truthSame;
          if (visible && !sentences.some((x) => x.text === text)) break;
          if (tries > 200) throw new Error(`could not build a visible ${kind} perturbation for ${excerpt_id}`);
        }
        sentences.push({ case_id: `${excerpt_id}-p${pi}`, text, label: "unsupported", perturbation: kind, detail: made!.detail, tags: tagsFor(useBrand, abbrev, made!.nameDrug) });
      }
      out.push({ excerpt_id, split, drug_key: drug.key, style, excerpt, sentences: shuffle(rng, sentences) });
    }
  }
  return out;
}
