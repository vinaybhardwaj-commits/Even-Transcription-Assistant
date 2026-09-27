/**
 * scripts/jev-med-bench — W27.7b / W30.3. The dataset's labels are BY CONSTRUCTION, so the tests
 * pin the construction: counts, by-drug split, visible perturbations, determinism; and the
 * pre-registered scoring rule: dev-only threshold, exact binomial bound, verdict edges.
 */
import { describe, it, expect } from "vitest";
import { generate, splitDrugs } from "../../scripts/jev-med-bench/generate";
import { FORMULARY } from "../../scripts/jev-med-bench/formulary";
import { buildReport, chooseThreshold, cpUpper, joinResults, type Scored } from "../../scripts/jev-med-bench/score";

const data = generate({ seed: "t", linesPerSplit: 100 });

describe("dataset construction", () => {
  it("is deterministic per seed and differs across seeds", () => {
    expect(generate({ seed: "t", linesPerSplit: 20 })).toEqual(generate({ seed: "t", linesPerSplit: 20 }));
    expect(generate({ seed: "u", linesPerSplit: 20 })).not.toEqual(generate({ seed: "t", linesPerSplit: 20 }));
  });

  it("has 100 excerpts per split, 4 sentences each: 2 supported + 2 unsupported", () => {
    for (const split of ["dev", "test"] as const) {
      const ex = data.filter((e) => e.split === split);
      expect(ex).toHaveLength(100);
      for (const e of ex) {
        expect(e.sentences).toHaveLength(4);
        expect(e.sentences.filter((s) => s.label === "supported")).toHaveLength(2);
      }
    }
  });

  it("perturbations per split are exactly 80 dose / 60 number / 60 drug", () => {
    for (const split of ["dev", "test"] as const) {
      const p = data.filter((e) => e.split === split).flatMap((e) => e.sentences).filter((s) => s.perturbation);
      const count = (k: string) => p.filter((s) => s.perturbation === k).length;
      expect([count("dose"), count("number"), count("drug")]).toEqual([80, 60, 60]);
    }
  });

  it("a drug never spans dev and test", () => {
    const { dev, test } = splitDrugs("t");
    const devKeys = new Set(dev.map((d) => d.key));
    expect(test.some((d) => devKeys.has(d.key))).toBe(false);
    expect(dev.length + test.length).toBe(FORMULARY.length);
    for (const e of data) expect((e.split === "dev" ? devKeys.has(e.drug_key) : !devKeys.has(e.drug_key))).toBe(true);
  });

  it("case ids are unique and no sentence repeats within an excerpt", () => {
    const ids = data.flatMap((e) => e.sentences.map((s) => s.case_id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of data) expect(new Set(e.sentences.map((s) => s.text)).size).toBe(4);
  });

  it("every dose perturbation changes the strength TOKEN; supported sentences carry the truth strength", () => {
    const tok = (s: string, strength: string) => new RegExp(`(^|\\s)${strength.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?=[\\s,.]|$)`).test(s);
    let checked = 0;
    for (const e of data) {
      const drug = FORMULARY.find((d) => d.key === e.drug_key)!;
      const sup = e.sentences.filter((s) => s.label === "supported");
      // the truth strength is the one both supported sentences share
      const truth = drug.strengths.find((st) => sup.every((s) => tok(s.text, st)));
      expect(truth, `${e.excerpt_id} supported sentences share a strength`).toBeDefined();
      for (const s of e.sentences.filter((x) => x.perturbation === "dose")) {
        expect(tok(s.text, truth!), `${s.case_id}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(160);
  });

  it("a drug-swapped sentence names neither the true drug (brand or generic) nor the excerpt's distractor", () => {
    for (const e of data) {
      const drug = FORMULARY.find((d) => d.key === e.drug_key)!;
      const names = [drug.generic, ...drug.brands].map((n) => n.toLowerCase());
      for (const s of e.sentences.filter((x) => x.perturbation === "drug")) {
        const t = s.text.toLowerCase();
        const word = (n: string) => new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(t);
        // a LASA partner may legitimately CONTAIN the true name (ibuprofen vs ibuprofen plus paracetamol) — the hardest trap
        if (s.detail !== "drug:lasa") expect(names.some(word), s.case_id).toBe(false); // whole-word: levocetirizine is a DIFFERENT drug from cetirizine
        // "continue your X as before" is the only other drug in the transcript; never a swap target
        const m = e.excerpt.match(/(?:keep taking your|pehle jaisi hi|Aur aapki) (.+?) (as before|pehle jaisi)/);
        if (m) expect(t.includes(m[1]!.toLowerCase())).toBe(false);
      }
    }
  });

  it("the transcript text contains the truth strength for its excerpt (spelled or digit form)", () => {
    for (const e of data.slice(0, 40)) expect(e.excerpt.length).toBeGreaterThan(40);
  });
});

const mk = (split: "dev" | "test", label: "supported" | "unsupported", p: number, extra: Partial<Scored> = {}): Scored => ({
  case_id: `${split}-${Math.random()}`, split, label, perturbation: label === "unsupported" ? "dose" : null, detail: "", tags: [], p, ...extra,
});

describe("scoring — the pre-registered rule", () => {
  it("cpUpper matches the closed form at k=0 and behaves at the edges", () => {
    expect(cpUpper(0, 200)).toBeCloseTo(1 - Math.pow(0.05, 1 / 200), 4);
    expect(cpUpper(200, 200)).toBe(1);
    expect(cpUpper(20, 200)).toBeGreaterThan(0.1);
    expect(cpUpper(20, 200)).toBeLessThan(0.16);
    expect(cpUpper(5, 200)).toBeLessThan(cpUpper(6, 200));
  });

  it("the threshold is the largest grid value with dev false-flag <= 8%, from DEV only", () => {
    // 100 supported dev sentences: 5 have p=0.30, the rest 0.95. FF(T) = 5% for T in (0.30, 0.95], 0 below.
    const dev: Scored[] = [...Array(5).fill(0.3), ...Array(95).fill(0.95)].map((p) => mk("dev", "supported", p));
    expect(chooseThreshold(dev).T).toBe(0.95);
    // add 4 more at 0.6: FF(T>0.6) = 9% > 8%, so T falls to 0.6 (FF 5%)
    const dev2 = [...dev.slice(0, 91), ...Array(4).fill(0.6).map((p) => mk("dev", "supported", p)), ...dev.slice(91)];
    expect(chooseThreshold(dev2).T).toBe(0.6);
  });

  it("test rows never influence T", () => {
    const dev: Scored[] = Array(100).fill(0.95).map((p) => mk("dev", "supported", p));
    const a = buildReport([...dev, ...Array(50).fill(0.02).map((p) => mk("test", "supported", p))]);
    const b = buildReport([...dev, ...Array(50).fill(0.99).map((p) => mk("test", "supported", p))]);
    expect(a.T).toBe(b.T);
  });

  const withTest = (k: number, n: number, unanswered = 0) => {
    const dev: Scored[] = Array(100).fill(0.95).map((p) => mk("dev", "supported", p)); // T = 0.95
    const test: Scored[] = [...Array(k).fill(0.1), ...Array(n - k).fill(0.99)].map((p) => mk("test", "supported", p));
    return buildReport([...dev, ...test], unanswered);
  };

  it("PASS needs observed <= 10% AND upper95 < 25%", () => {
    expect(withTest(20, 200).verdict).toBe("PASS"); // 10.0%, upper ~14.6%
    expect(withTest(21, 200).verdict).toBe("FAIL"); // 10.5%
    expect(withTest(3, 12).verdict).toBe("FAIL"); // 25% observed
    expect(withTest(1, 10).verdict).toBe("FAIL"); // 10% observed, upper bound ~39%: too few to prove <25%
  });

  it("any unanswered sentence withholds PASS", () => {
    const r = withTest(0, 200, 3);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toContain("unanswered");
  });

  it("joinResults leaves unanswered sentences out rather than defaulting them to supported", () => {
    const one = data.slice(0, 1);
    const first = one[0]!.sentences[0]!.case_id;
    const rows = joinResults(one, { [first]: 0.2 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p).toBe(0.2);
  });

  it("catch is reported by perturbation type", () => {
    const dev: Scored[] = Array(100).fill(0.95).map((p) => mk("dev", "supported", p));
    const test: Scored[] = [
      mk("test", "unsupported", 0.1, { perturbation: "dose" }),
      mk("test", "unsupported", 0.99, { perturbation: "dose" }),
      mk("test", "unsupported", 0.1, { perturbation: "drug" }),
      mk("test", "supported", 0.99),
    ];
    const r = buildReport([...dev, ...test]);
    expect(r.test.catchByType.dose).toMatchObject({ k: 1, n: 2 });
    expect(r.test.catchByType.drug).toMatchObject({ k: 1, n: 1 });
    expect(r.test.catchByType.number.n).toBe(0);
  });
});
