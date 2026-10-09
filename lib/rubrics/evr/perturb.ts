/**
 * lib/rubrics/evr/perturb.ts — S7-2: the perturbation bench (evr_perturb). The bench is generated INSIDE the job from real records, so no record text ever leaves prod: a perturbation is applied to a
 * COPY of a real record, the copy and the original are both compared with the same tape, and only counts and codes are kept.
 *
 * Kinds: add_drug, dose_x2, dose_half, laterality_swap, add_procedure, add_diagnosis, remove_drug.
 * Expected: add_drug / add_procedure / add_diagnosis / laterality_swap = obvious; dose_x2 / dose_half = obvious when the tape states that drug's dose, else none; remove_drug = minor (said_not_in_record).
 * Originals are NOT negatives (a real record can hold a real discrepancy): they give baseline_flag_rate only. PURE and seeded (mulberry32), so a rerun repeats.
 */
import { compareRecord, nameOverlap, parseDose, parseSide, sameDrug, swapSide, tapeMention, type TapeLine } from "./compare";
import { findingCode, type Finding, type NormRecord, type SaidItems, type Tier } from "./types";

export const PERTURB_KINDS = ["add_drug", "dose_x2", "dose_half", "laterality_swap", "add_procedure", "add_diagnosis", "remove_drug"] as const;
export type PerturbKind = (typeof PERTURB_KINDS)[number];

/** Names used for injected items. Plain, common, and chosen to be unlikely to be said in an ordinary consult; a name that IS on the tape is skipped. */
export const INJECT_DRUGS = ["Warfarin", "Methotrexate", "Amiodarone", "Digoxin", "Lithium", "Tamoxifen", "Clopidogrel", "Spironolactone"];
export const INJECT_PROCEDURES = ["Total knee replacement", "Laparoscopic cholecystectomy", "Coronary angioplasty", "Hernia mesh repair", "Cataract extraction with lens implant", "Thyroidectomy"];
export const INJECT_DIAGNOSES = ["Chronic kidney disease stage 3", "Atrial fibrillation", "Rheumatoid arthritis", "Hypothyroidism", "Peptic ulcer disease", "Migraine with aura"];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(xs: readonly T[], r: () => number): T => xs[Math.floor(r() * xs.length)]!;
const clone = (r: NormRecord): NormRecord => JSON.parse(JSON.stringify(r)) as NormRecord;

export type Perturbation = {
  kind: PerturbKind;
  applicable: boolean;
  record?: NormRecord;
  /** the finding this perturbation should produce: kind of finding, record/said item, and the tier expected ("none" = no new finding for the target at material or above) */
  expect?: { target: string; field: Finding["field"]; kind: Finding["kind"]; tier: Tier; /** why "none" is expected */ none_reason?: "no_dose_on_tape" | "tape_dose_unparseable" | "no_side_on_tape" };
};

const num = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
function scaleDose(dose: string, factor: number): string {
  return dose.replace(/(\d+(?:\.\d+)?)(\s*(?:mg|mcg|µg|μg|ug|g|ml|iu|units?|%))/i, (_m, v: string, u: string) => `${num(Number(v) * factor)}${u}`);
}

export function perturb(kind: PerturbKind, rec: NormRecord, said: SaidItems, lines: TapeLine[], seed: number): Perturbation {
  const r = rng(seed * 31 + PERTURB_KINDS.indexOf(kind) + 1);
  const tapeText = lines.map((l) => l.text).join(" ").toLowerCase();
  const out = clone(rec);
  if (kind === "add_drug") {
    const cands = INJECT_DRUGS.filter((d) => !tapeText.includes(d.toLowerCase()) && !rec.meds.some((m) => sameDrug([m.name, m.alt_name].filter(Boolean), [d])) && !tapeMention([d], lines));
    if (cands.length === 0) return { kind, applicable: false };
    const name = pick(cands, r);
    out.meds.push({ name, alt_name: "", dose: "500 mg", freq: "twice daily", route: "oral", duration: "5 days", side: "" });
    return { kind, applicable: true, record: out, expect: { target: name, field: "drug", kind: "in_record_not_said", tier: "obvious" } };
  }
  if (kind === "add_procedure") {
    const cands = INJECT_PROCEDURES.filter((p) => !rec.procedures.some((x) => x.name.toLowerCase() === p.toLowerCase()) && !p.toLowerCase().split(" ").filter((w) => w.length >= 5).some((w) => tapeText.includes(w.slice(0, 5))));
    if (cands.length === 0) return { kind, applicable: false };
    const name = pick(cands, r);
    out.procedures.push({ name });
    return { kind, applicable: true, record: out, expect: { target: name, field: "procedure", kind: "in_record_not_said", tier: rec.ai.procedures === true ? "material" : "obvious" } }; // R3: an AI-filled field is capped at material
  }
  if (kind === "add_diagnosis") {
    const cands = INJECT_DIAGNOSES.filter((d) => !rec.diagnoses.some((x) => x.name.toLowerCase() === d.toLowerCase()) && !d.toLowerCase().split(" ").filter((w) => w.length >= 5).some((w) => tapeText.includes(w.slice(0, 5))));
    if (cands.length === 0) return { kind, applicable: false };
    const name = pick(cands, r);
    out.diagnoses.push({ name, differential: false, location_notes: "" });
    return { kind, applicable: true, record: out, expect: { target: name, field: "diagnosis", kind: "in_record_not_said", tier: rec.ai.diagnoses === true ? "material" : "obvious" } }; // R3
  }
  if (kind === "dose_x2" || kind === "dose_half") {
    const idx = rec.meds.map((m, i) => ({ m, i })).filter(({ m }) => parseDose(m.dose));
    if (idx.length === 0) return { kind, applicable: false };
    const { m, i } = pick(idx, r);
    const unit = parseDose(m.dose)!.unit;
    const sm = said.meds.find((s) => sameDrug([m.name, m.alt_name].filter(Boolean), [s.name]));
    const stated = !!sm && !!parseDose(sm.dose, unit);
    // R5: a dose said on the tape that cannot be parsed is reported apart ("tape_dose_unparseable"), never counted as a correct none
    const none_reason = stated ? undefined : sm && sm.dose.trim() ? ("tape_dose_unparseable" as const) : ("no_dose_on_tape" as const);
    out.meds[i]!.dose = scaleDose(m.dose, kind === "dose_x2" ? 2 : 0.5);
    return { kind, applicable: true, record: out, expect: { target: m.name, field: "dose", kind: "value_mismatch", tier: stated ? "obvious" : "none", ...(none_reason ? { none_reason } : {}) } };
  }
  if (kind === "laterality_swap") {
    const cands: Array<{ type: "proc" | "diag"; i: number; text: string }> = [
      ...rec.procedures.map((p, i) => ({ type: "proc" as const, i, text: p.name })).filter((c) => { const s = parseSide(c.text); return s === "left" || s === "right"; }),
      ...rec.diagnoses.map((d, i) => ({ type: "diag" as const, i, text: `${d.name} ${d.location_notes}` })).filter((c) => { const s = parseSide(c.text); return s === "left" || s === "right"; }),
    ];
    if (cands.length === 0) return { kind, applicable: false };
    const c = pick(cands, r);
    // R4: obvious only when the tape states a side for that site (a said item that matches the site and carries one side); otherwise nothing can be compared: none
    const siteName = c.type === "proc" ? rec.procedures[c.i]!.name : rec.diagnoses[c.i]!.name;
    const pool = c.type === "proc" ? said.procedures : said.diagnoses;
    const tapeSide = pool.some((s) => (nameOverlap(siteName, s.name) || nameOverlap(s.name, siteName)) && (parseSide(`${s.side} ${s.name}`) === "left" || parseSide(`${s.side} ${s.name}`) === "right"));
    const latTier: Tier = tapeSide ? "obvious" : "none";
    const latReason = tapeSide ? undefined : ("no_side_on_tape" as const);
    if (c.type === "proc") { const orig = out.procedures[c.i]!.name; out.procedures[c.i]!.name = swapSide(orig); return { kind, applicable: true, record: out, expect: { target: swapSide(orig), field: "laterality", kind: "value_mismatch", tier: latTier, ...(latReason ? { none_reason: latReason } : {}) } }; }
    const d = out.diagnoses[c.i]!;
    d.name = swapSide(d.name); // both places that can carry the side are swapped, so the copy never reads as "both"
    d.location_notes = swapSide(d.location_notes);
    return { kind, applicable: true, record: out, expect: { target: d.name, field: "laterality", kind: "value_mismatch", tier: latTier, ...(latReason ? { none_reason: latReason } : {}) } };
  }
  // remove_drug: remove a record drug that the tape DID say
  const said2 = rec.meds.map((m, i) => ({ m, i })).filter(({ m }) => said.meds.some((s) => sameDrug([m.name, m.alt_name].filter(Boolean), [s.name])));
  if (said2.length === 0) return { kind, applicable: false };
  const { m, i } = pick(said2, r);
  const s = said.meds.find((x) => sameDrug([m.name, m.alt_name].filter(Boolean), [x.name]))!;
  out.meds.splice(i, 1);
  return { kind, applicable: true, record: out, expect: { target: s.name, field: "drug", kind: "said_not_in_record", tier: "minor" } };
}

export type KindOutcome = { kind: PerturbKind; applicable: boolean; expected_tier: Tier | null; found: boolean | null; correct_none: boolean | null; extra: number; none_reason?: string };
export type WindowOutcome = { baseline_findings: number; baseline_material_plus: number; baseline_obvious: number; kinds: KindOutcome[] };

const key = (f: Finding): string => `${findingCode(f)}|${f.target.toLowerCase()}`;
const sameTarget = (f: Finding, t: string): boolean => f.target.toLowerCase().replace(/\s+/g, " ") === t.toLowerCase().replace(/\s+/g, " ");

/** Score ONE window: the original, then each perturbed copy against the same tape. */
export function scoreWindow(rec: NormRecord, said: SaidItems, lines: TapeLine[], seed: number, kinds: readonly PerturbKind[] = PERTURB_KINDS): WindowOutcome {
  const base = compareRecord(rec, said, lines);
  const baseKeys = new Set(base.map(key));
  const res: KindOutcome[] = [];
  for (const kind of kinds) {
    const p = perturb(kind, rec, said, lines, seed);
    if (!p.applicable || !p.record || !p.expect) { res.push({ kind, applicable: false, expected_tier: null, found: null, correct_none: null, extra: 0 }); continue; }
    const fs = compareRecord(p.record, said, lines);
    const fresh = fs.filter((f) => !baseKeys.has(key(f)));
    const e = p.expect;
    const hit = fresh.filter((f) => f.field === e.field && f.kind === e.kind && sameTarget(f, e.target));
    if (e.tier === "none") {
      const bad = hit.filter((f) => f.tier === "material" || f.tier === "obvious");
      res.push({ kind, applicable: true, expected_tier: "none", found: null, correct_none: bad.length === 0, extra: fresh.length - hit.length, ...(e.none_reason ? { none_reason: e.none_reason } : {}) });
    } else {
      const ok = hit.some((f) => f.tier === e.tier);
      res.push({ kind, applicable: true, expected_tier: e.tier, found: ok, correct_none: null, extra: fresh.length - hit.length });
    }
  }
  return { baseline_findings: base.length, baseline_material_plus: base.filter((f) => f.tier === "material" || f.tier === "obvious").length > 0 ? 1 : 0, baseline_obvious: base.some((f) => f.tier === "obvious") ? 1 : 0, kinds: res };
}

export type PerturbReport = {
  /** dose kinds scored "none" only because the dose said on the tape could not be parsed (R5): reported, not silently counted correct */
  dose_none_unparseable: number;
  windows: number; baseline_flag_rate: { any: number; material_or_obvious: number; obvious: number };
  per_kind: Record<string, { n_none_tape_dose_unparseable: number; n_applicable: number; n_expected_detect: number; recall: number | null; n_expected_none: number; none_correct: number | null; mean_extra_findings: number | null }>;
};
export function aggregatePerturb(outs: WindowOutcome[]): PerturbReport {
  const n = outs.length;
  const per_kind: PerturbReport["per_kind"] = {};
  for (const kind of PERTURB_KINDS) {
    const rows = outs.flatMap((o) => o.kinds.filter((k) => k.kind === kind && k.applicable));
    const det = rows.filter((k) => k.expected_tier !== "none");
    const none = rows.filter((k) => k.expected_tier === "none");
    per_kind[kind] = {
      n_applicable: rows.length, n_expected_detect: det.length, recall: det.length ? Math.round((det.filter((k) => k.found).length / det.length) * 1000) / 1000 : null,
      n_expected_none: none.length, none_correct: none.length ? Math.round((none.filter((k) => k.correct_none).length / none.length) * 1000) / 1000 : null,
      n_none_tape_dose_unparseable: none.filter((k) => k.none_reason === "tape_dose_unparseable").length,
      mean_extra_findings: rows.length ? Math.round((rows.reduce((s, k) => s + k.extra, 0) / rows.length) * 100) / 100 : null,
    };
  }
  const rate = (f: (o: WindowOutcome) => boolean): number => (n ? Math.round((outs.filter(f).length / n) * 1000) / 1000 : 0);
  const unparse = outs.reduce((s, o) => s + o.kinds.filter((k) => k.none_reason === "tape_dose_unparseable").length, 0);
  return { dose_none_unparseable: unparse, windows: n, baseline_flag_rate: { any: rate((o) => o.baseline_findings > 0), material_or_obvious: rate((o) => o.baseline_material_plus > 0), obvious: rate((o) => o.baseline_obvious > 0) }, per_kind };
}
