/** Spine S1 R2: the PHI screens (keys and values), driven by tests/fixtures/spine-phi-cases.json, which tools/eta-spine/tests/test_phi_screen.py reads too. Synthetic only. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENUMS, ID_KEYS, refuseKeys, normKey } from "@/lib/spine/phi-screen";
import { validateSignals } from "@/lib/spine/signal-validate";
import type { Proxy } from "@/lib/spine/ingest";

const F = JSON.parse(readFileSync("tests/fixtures/spine-phi-cases.json", "utf8")) as {
  enums: Record<string, { close_reason: string[]; quality: string[] }>; id_keys: string[]; refuse_keys: string[]; ok_keys: string[];
  deep: Array<{ nest: number; leaf: unknown; expect: string | null }>; signals: Array<{ label: string; expect: string; signal: Record<string, unknown> }>;
};
const nest = (n: number, leaf: unknown): unknown => (n === 0 ? leaf : [nest(n - 1, leaf)]);
const sig = (proxy: string, attrs: Record<string, unknown>) => ({ proxy, source_key: "k_test_01", t_open: "2026-10-18T04:00:00Z", observed_at: "2026-10-18T04:20:00Z", attrs });

describe("key screen", () => {
  it("refuses every fixture key, as a top-level key, nested in ids and inside an array", () => {
    for (const k of F.refuse_keys) {
      expect(refuseKeys({ [k]: 1 }), k).toBe("text_key");
      expect(refuseKeys([sig("pqm", { ids: { [k]: "x" } })]), k).toBe("text_key");
      expect(refuseKeys({ a: [{ b: { [k]: 1 } }] }), k).toBe("text_key");
    }
  });
  it("normalises: fullwidth, zero-width split, soft hyphen, Cyrillic a, dotless i all fold to the ASCII word", () => {
    expect(normKey("ｎａｍｅ")).toBe("name");
    expect(normKey("na​me")).toBe("name");
    expect(normKey("pa­tient")).toBe("patient");
    expect(normKey("nаme")).toBe("name");
    expect(normKey("patıent")).toBe("patient");
  });
  it("lets the legitimate keys through", () => { for (const k of F.ok_keys) expect(refuseKeys({ [k]: 1 }), k).toBeNull(); });
  it("depth cases", () => {
    for (const c of F.deep) expect(refuseKeys(nest(c.nest, c.leaf)), JSON.stringify(c)).toBe(c.expect);
  });
});

describe("value screen", () => {
  it("the enums and the ids allowlist equal the fixture", () => {
    for (const [p, e] of Object.entries(F.enums)) {
      expect([...ENUMS[p as Proxy].close_reason].sort(), p).toEqual([...e.close_reason].sort());
      expect([...ENUMS[p as Proxy].quality].sort(), p).toEqual([...e.quality].sort());
    }
    expect([...ID_KEYS].sort()).toEqual([...F.id_keys].sort());
  });
  it("every enum value is accepted for its proxy, and the same value is refused for a proxy that lacks it", () => {
    for (const [p, e] of Object.entries(F.enums)) {
      for (const v of e.close_reason) expect(validateSignals([sig(p, { close_reason: v })]).ok, `${p} ${v}`).toBe(true);
      for (const v of e.quality) expect(validateSignals([sig(p, { quality: v })]).ok, `${p} ${v}`).toBe(true);
    }
    expect(validateSignals([sig("acoustic", { close_reason: "endConsult" })])).toMatchObject({ ok: false, status: 422 });
  });
  it("fixture signals", () => {
    for (const c of F.signals) {
      const v = validateSignals([c.signal]);
      if (c.expect === "ok") expect(v.ok, c.label).toBe(true);
      else expect(v.ok ? "ok" : String(v.status), c.label).toBe(c.expect);
    }
  });
  it("a refusal carries a code, never the value", () => {
    const v = validateSignals([sig("pqm", { ids: { consult_uid: "Patient Ravi Kumar said it" } })]);
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v)).not.toContain("Ravi");
  });
});
