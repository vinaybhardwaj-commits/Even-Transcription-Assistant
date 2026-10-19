/** Spine S1 R2: the PHI screens (keys and values), driven by tests/fixtures/spine-phi-cases.json, which tools/eta-spine/tests/test_phi_screen.py reads too. Synthetic only. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ENUMS, ID_KEYS, FORMATS, SOURCE_KEY_FORMAT, refuseKeys, normKey } from "@/lib/spine/phi-screen";
import RULES from "../../tools/eta-spine/phi-rules.json";
import { validateSignals } from "@/lib/spine/signal-validate";
import type { Proxy } from "@/lib/spine/ingest";

const F = JSON.parse(readFileSync("tests/fixtures/spine-phi-cases.json", "utf8")) as {
  enums: Record<string, { close_reason: string[]; quality: string[] }>; id_keys: string[]; refuse_keys: string[]; ok_keys: string[];
  deep: Array<{ nest: number; leaf: unknown; expect: string | null }>; signals: Array<{ label: string; expect: string; signal: Record<string, unknown> }>;
  good_ids: Record<string, string>; good_source_key: Record<string, string>; formats_accept: Record<string, string[]>; formats_refuse: Record<string, string[]>; formats_refuse_common: string[];
  keys: Record<string, string>; key_verdicts: Record<string, string | null>; value_cases: Array<{ label: string; expect: string; signal: Record<string, unknown> }>;
};
/** Digit runs are built here, never written in the fixture. */
const FILL: Record<string, string> = { "{MS13}": "17" + "0".repeat(11), "{P16}": "1" + "0".repeat(15), "{PHONE10}": "9".repeat(10), "{PLUS_PHONE}": "+91" + "9".repeat(10), "{DIG7}": "1234567", "{DIG8}": "20260101" };
const fill = <T,>(v: T): T => JSON.parse(JSON.stringify(v).replace(/\{[A-Z0-9_]+\}/g, (m) => FILL[m] ?? m));
const nest = (n: number, leaf: unknown): unknown => (n === 0 ? leaf : [nest(n - 1, leaf)]);
const sig = (proxy: string, attrs: Record<string, unknown>) => ({ proxy, source_key: F.good_source_key[proxy] ?? "x", t_open: "2026-10-18T04:00:00Z", observed_at: "2026-10-18T04:20:00Z", attrs });

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

describe("per-key id formats (R3 F1)", () => {
  const allKeys = Object.keys(F.formats_accept);
  const keys = allKeys.filter((k) => k !== "room_id");     // room_id is a format, not an ids key
  it("the rules json, the fixture and the code agree on the key set", () => {
    expect([...ID_KEYS].sort()).toEqual([...keys].sort());
    expect(Object.keys(FORMATS).sort()).toEqual([...allKeys].sort());
    expect(Object.keys(F.formats_refuse).sort()).toEqual([...allKeys].sort());
    for (const k of allKeys) expect(FORMATS[k]!.source, k).toBe((RULES.formats as Record<string, string>)[k]);
    for (const [proxy, key] of Object.entries(SOURCE_KEY_FORMAT)) expect(allKeys, proxy).toContain(key);
  });
  it("every real producer format is accepted by its key, as ids.<key>", () => {
    for (const k of allKeys) for (const v of fill(F.formats_accept[k]!)) {
      expect(FORMATS[k]!.test(v), `${k} ${v}`).toBe(true);
      const body = k === "room_id" ? { ...sig("pqm", {}), room_id: v } : sig("pqm", { ids: { [k]: v } });
      expect(validateSignals([body]).ok, `${k} ${v}`).toBe(true);
    }
  });
  it("name+digits, phone-like and malformed values are refused by EVERY key, as ids.<key>", () => {
    for (const k of keys) for (const v of fill([...F.formats_refuse_common, ...F.formats_refuse[k]!])) {
      expect(FORMATS[k]!.test(v), `${k} ${JSON.stringify(v)}`).toBe(false);
      const r = validateSignals([sig("pqm", { ids: { [k]: v } })]);
      expect(r.ok ? "ok" : r.error, `ids.${k} ${JSON.stringify(v)}`).toBe("attrs_ids");
    }
  });
  it("anchored: a stray character before or after a good value is refused", () => {
    for (const k of allKeys) for (const v of fill(F.formats_accept[k]!)) for (const w of [`!${v}`, `${v}!`, `${v}\u0000`]) expect(FORMATS[k]!.test(w), `${k} ${JSON.stringify(w)}`).toBe(false);
  });
  it("a value valid for another key is refused (no cross-key use)", () => {
    for (const k of keys) for (const o of keys) if (o !== k) for (const v of fill(F.formats_accept[o]!)) {
      if (FORMATS[k]!.test(v)) continue;     // formats may legitimately overlap (a small integer window id is not a uid, but eg a hex run might be)
      expect(validateSignals([sig("pqm", { ids: { [k]: v } })]).ok, `${k} <- ${o}`).toBe(false);
    }
  });
  it("room_id and source_key use the same formats", () => {
    for (const v of fill(F.formats_refuse_common)) {
      expect(validateSignals([{ ...sig("pqm", {}), room_id: v }]).ok, `room ${JSON.stringify(v)}`).toBe(false);
      expect(validateSignals([{ ...sig("pqm", {}), source_key: v }]).ok, `sk ${JSON.stringify(v)}`).toBe(false);
    }
    for (const v of fill(F.formats_accept.room_id!)) expect(validateSignals([{ ...sig("pqm", {}), room_id: v }]).ok, v).toBe(true);
  });
});

describe("ported refute cases (R3 F5): key and value verdicts, identical in Python", () => {
  it("key verdicts", () => {
    for (const [n, k] of Object.entries(F.keys)) expect(refuseKeys({ [k]: 1 }), n).toBe(F.key_verdicts[n]);
  });
  it("value cases", () => {
    for (const c of F.value_cases) {
      const v = validateSignals([fill(c.signal)]);
      expect(v.ok ? "ok" : v.error, c.label).toBe(c.expect);
    }
  });
});
