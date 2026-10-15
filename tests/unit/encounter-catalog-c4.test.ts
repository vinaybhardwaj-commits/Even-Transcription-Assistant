/**
 * encounter-catalog-c4.test.ts — migration 0169 (jev, clef_affect, presence): validator shapes, text-key refusal inside them, the ingest column list and the search select. Database mocked; ids and tokens are synthetic.
 * The real-Postgres half is tests/unit/encounter-catalog-c4-pg.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { validateBatch, validJev, validClef, validPresence } from "@/lib/encounter-catalog/store";
import { buildSearch } from "@/lib/encounter-catalog/search";
import { INGEST_SQL, COLUMNS } from "@/lib/encounter-catalog/ingest-sql";

const AT = "2026-10-15T09:00:00Z";
const jev = (over: Record<string, unknown> = {}) => ({ sets: [{ set_id: "consult_rubric", set_sha: "ab12cd34ef56", band: "high", label: "complete", model: "jev-model-1", at: AT, ...over }] });
const clef = (over: Record<string, unknown> = {}) => ({ lanes: [{ lane: "affect", scores: { calm: 0.8, tension: 0.1 }, model_rev: "rev3", at: AT, ...over }] });
const presence = { encounter_open: 1_760_243_000_000, encounter_close: 1_760_243_600_000, boundary_source: "pqm", close_reason: "idle_timeout" };
const one = (over: Record<string, unknown>) => validateBatch({ rows: [{ consult_uid: "synth-c4-1", ...over }] });

describe("migration 0169", () => {
  const up = readFileSync("db/migrations/0169_encounter_catalog_c4.sql", "utf8");
  const down = readFileSync("db/rollbacks/0169_encounter_catalog_c4.down.sql", "utf8");
  it("is the only 0169, follows 0168, and the rollback is not in the migrations dir", () => {
    const files = readdirSync("db/migrations").filter((f) => /^\d{4}_.*\.sql$/.test(f));
    expect(files.filter((f) => f.startsWith("0169_"))).toEqual(["0169_encounter_catalog_c4.sql"]);
    expect(files.some((f) => f.startsWith("0168_"))).toBe(true);
    expect(existsSync("db/rollbacks/0169_encounter_catalog_c4.down.sql")).toBe(true);
    expect(readdirSync("db/migrations").some((f) => /down/i.test(f))).toBe(false);
    expect(down).toMatch(/DELETE FROM schema_migrations WHERE version = 169/);
  });
  it("is additive: three nullable jsonb columns, IF NOT EXISTS, no drop / update / delete, records itself", () => {
    const ddl = up.replace(/--.*$/gm, "");
    expect(ddl).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\b|\bUPDATE\b|\bNOT NULL\b/i);
    for (const c of ["jev", "clef_affect", "presence"]) expect(ddl).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\s+jsonb`));
    expect((ddl.match(/ADD COLUMN/g) ?? []).length).toBe(3);
    expect(ddl).toMatch(/INSERT INTO schema_migrations \(version, name\)\s+VALUES \(169, '0169_encounter_catalog_c4'\)/);
  });
  it("the rollback drops only those three columns", () => {
    const ddl = down.replace(/--.*$/gm, "");
    expect(ddl).toMatch(/DROP COLUMN IF EXISTS jev, DROP COLUMN IF EXISTS clef_affect, DROP COLUMN IF EXISTS presence/);
    expect(ddl).not.toMatch(/DROP TABLE/i);
  });
});

describe("jev", () => {
  it("accepts the sets shape, an empty sets list, null (clears) and several sets", () => {
    expect(one({ jev: jev() }).ok).toBe(true);
    expect(one({ jev: { sets: [] } }).ok).toBe(true);
    expect(one({ jev: null }).ok).toBe(true);
    expect(one({ jev: { sets: [jev().sets[0], jev({ set_id: "encounter_timeline" }).sets[0]] } }).ok).toBe(true);
    expect(one({ jev: jev({ band: null, label: null }) }).ok).toBe(true);
  });
  it("refuses a text-like key at any depth inside it (text_key), and any other extra key (bad_jev)", () => {
    expect(one({ jev: jev({ text: "x" }) })).toEqual({ ok: false, error: "text_key" });
    expect(one({ jev: jev({ note: "x" }) })).toEqual({ ok: false, error: "text_key" });
    expect(one({ jev: { sets: [], deep: { content: "x" } } })).toEqual({ ok: false, error: "text_key" });
    expect(one({ jev: jev({ reason: "x" }) })).toEqual({ ok: false, error: "bad_jev" });
    expect(one({ jev: { sets: [], counts: { a: 1 } } })).toEqual({ ok: false, error: "bad_jev" });
  });
  it("refuses a free-text value, a bad instant, a bad sha, a non-array sets and too many sets", () => {
    for (const bad of [{ band: "has spaces and words" }, { label: "x".repeat(61) }, { model: "m m" }, { at: "yesterday" }, { at: "2026-02-30T00:00:00Z" }, { set_sha: "no sha!" }, { set_id: "" }, { set_id: 5 }]) {
      expect(one({ jev: jev(bad) }), JSON.stringify(bad)).toEqual({ ok: false, error: "bad_jev" });
    }
    expect(one({ jev: { sets: "x" } })).toEqual({ ok: false, error: "bad_jev" });
    expect(one({ jev: [] })).toEqual({ ok: false, error: "bad_jev" });
    expect(validJev({ sets: Array.from({ length: 51 }, () => jev().sets[0]) })).toBe(false);
  });
});

describe("clef_affect", () => {
  it("accepts lanes with numeric scores", () => {
    expect(one({ clef_affect: clef() }).ok).toBe(true);
    expect(one({ clef_affect: { lanes: [] } }).ok).toBe(true);
    expect(one({ clef_affect: null }).ok).toBe(true);
  });
  it("refuses text keys inside, non-numeric or non-finite scores, free-text tokens, extra keys", () => {
    expect(one({ clef_affect: clef({ scores: { text: 1 } }) })).toEqual({ ok: false, error: "text_key" });
    expect(one({ clef_affect: clef({ transcript: "x" }) })).toEqual({ ok: false, error: "text_key" });
    for (const bad of [{ scores: { calm: "high" } }, { scores: { "bad key": 1 } }, { scores: [1, 2] }, { lane: "two words" }, { model_rev: "" }, { at: "x" }, { extra: 1 }]) {
      expect(one({ clef_affect: clef(bad) }), JSON.stringify(bad)).toEqual({ ok: false, error: "bad_clef_affect" });
    }
    expect(validClef({ lanes: [{ lane: "affect", scores: { a: Infinity }, model_rev: "r", at: AT }] })).toBe(false);
    expect(validClef({ lanes: Array.from({ length: 21 }, () => clef().lanes[0]) })).toBe(false);
    expect(validClef({ lanes: [{ lane: "affect", scores: Object.fromEntries(Array.from({ length: 65 }, (_, i) => ["k" + i, 1])), model_rev: "r", at: AT }] })).toBe(false);
  });
});

describe("presence", () => {
  it("accepts the four keys, nulls, a partial block", () => {
    expect(one({ presence }).ok).toBe(true);
    expect(one({ presence: { ...presence, close_reason: null, encounter_close: null } }).ok).toBe(true);
    expect(one({ presence: { boundary_source: "pqm" } }).ok).toBe(true);
    expect(one({ presence: null }).ok).toBe(true);
  });
  it("refuses names, free text, bad times and extra keys", () => {
    expect(one({ presence: { ...presence, close_reason: "Dr Somebody left" } })).toEqual({ ok: false, error: "bad_presence" });
    expect(one({ presence: { ...presence, encounter_open: "2026-10-15" } })).toEqual({ ok: false, error: "bad_presence" });
    expect(one({ presence: { ...presence, encounter_open: -1 } })).toEqual({ ok: false, error: "bad_presence" });
    expect(one({ presence: { ...presence, doctor_name: "x" } })).toEqual({ ok: false, error: "bad_presence" });
    expect(one({ presence: { ...presence, note: "x" } })).toEqual({ ok: false, error: "text_key" });
    expect(validPresence({ ...presence, encounter_open: 1.5 })).toBe(false);
  });
});

describe("ingest and search carry the new columns", () => {
  it("COLUMNS and the ingest SQL are field-level for jev, clef_affect and presence", () => {
    for (const c of ["jev", "clef_affect", "presence"]) {
      expect(COLUMNS.map((x) => x.name)).toContain(c);
      expect(INGEST_SQL).toContain(`CASE WHEN jsonb_exists(p.j, '${c}') THEN NULLIF(p.j->'${c}', 'null'::jsonb) ELSE e.${c} END`);
    }
  });
  it("the search select returns them", () => {
    const [text] = buildSearch({ limit: 5 });
    for (const c of ["jev", "clef_affect", "presence"]) expect(text).toMatch(new RegExp(`\\b${c}\\b`));
  });
  it("a C4-only row (no other field) is a valid partial row", () => {
    expect(one({ jev: jev(), clef_affect: clef(), presence }).ok).toBe(true);
  });
});
