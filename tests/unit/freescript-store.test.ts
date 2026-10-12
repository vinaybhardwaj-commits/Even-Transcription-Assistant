/**
 * freescript-store.test.ts — migration 0157, the ingest validator and the HMAC. Ids are synthetic.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";

vi.mock("@/lib/db", () => ({ sql: () => { throw new Error("no db in unit tests"); } }));

import { validatePayload, PAYLOAD_VERSION } from "@/lib/freescript/store";
import { checkFreescriptHmac, signFreescript } from "@/lib/freescript/auth";
import { freescriptEnabled } from "@/lib/freescript/flag";
import { INGEST_SQL } from "@/lib/freescript/ingest-sql";

const MIG = "db/migrations/0157_freescript.sql";
const DOWN = "db/rollbacks/0157_freescript.down.sql";
const H64 = "ab".repeat(32);

const payload = (over: Record<string, unknown> = {}) => ({
  version: PAYLOAD_VERSION,
  consult_uid: "synth-fs-1",
  schema_version: "eta.freescript.v0.2",
  ist_date: "2026-10-05",
  room_slug: "synth-room",
  input_sha256: H64,
  generator: { code_sha256: "a".repeat(64), prompt_sha256: "b".repeat(64), model: "anthropic.claude" },
  validator: { ok: true, errors: [] as string[] },
  artifact: { schema_version: "eta.freescript.v0.2", gp_extraction: { medicines: [] }, note_text: "Medication:" },
  completion_required: [] as Record<string, unknown>[],
  ...over,
});

describe("migration 0157", () => {
  const up = readFileSync(MIG, "utf8");
  it("follows 0156 and the down-migration is not applied by the migrator", () => {
    const files = readdirSync("db/migrations").filter((f) => /^\d{4}_.*\.sql$/.test(f));
    expect(files.filter((f) => f.startsWith("0157_"))).toEqual(["0157_freescript.sql"]);
    expect(files.some((f) => f.startsWith("0156_"))).toBe(true);
    expect(existsSync(DOWN)).toBe(true);
    expect(readdirSync("db/migrations").some((f) => /down/i.test(f))).toBe(false);
    expect(readFileSync(DOWN, "utf8")).toMatch(/DELETE FROM schema_migrations WHERE version = 157/);
  });
  it("is additive and records itself", () => {
    const ddl = up.replace(/--.*$/gm, "").replace(/ON DELETE CASCADE/g, "");
    expect(ddl).not.toMatch(/\bALTER TABLE\b|\bDROP\b|\bTRUNCATE\b|\bDELETE\b|\bUPDATE\b/i);
    expect(up).toContain("CREATE TABLE IF NOT EXISTS freescript_run");
    expect(up).toContain("CREATE TABLE IF NOT EXISTS freescript_artifact");
    expect(up).toContain("CREATE OR REPLACE VIEW freescript_latest");
    expect(up).toMatch(/VALUES \(157, '0157_freescript'\)/);
    expect(up).not.toMatch(/\bGRANT\b/i);
  });
  it("has the asked columns and no transcript column", () => {
    for (const col of ["consult_uid", "prescription_uid", "schema_version", "artifact", "completion_required", "validator_ok", "generator_code_sha", "generator_prompt_sha", "cost_usd", "created_at"]) {
      expect(up).toContain(col);
    }
    const tables = up.slice(up.indexOf("CREATE TABLE IF NOT EXISTS freescript_run"), up.indexOf("CREATE INDEX"));
    expect(tables).not.toMatch(/\btranscript\b|\bsegments\b|\baudio\b/);
  });
});

describe("validatePayload", () => {
  it("accepts a synthetic artifact", () => expect(validatePayload(payload())).toMatchObject({ ok: true }));
  it("accepts an eta.freescript.v0.3 artifact", () => {
    expect(validatePayload(payload({
      schema_version: "eta.freescript.v0.3",
      artifact: { schema_version: "eta.freescript.v0.3", gp_extraction: { medicines: [] }, note_text: "Medication:" },
    }))).toMatchObject({ ok: true });
  });
  it("refuses transcript-shaped fields", () => {
    const art = { schema_version: "eta.freescript.v0.2", encounter: { transcript: { segments: [{ text: "x" }] } } };
    expect(validatePayload(payload({ artifact: art }))).toEqual({ ok: false, error: "transcript_field" });
  });
  it("refuses a bad sha and a negative cost", () => {
    expect(validatePayload(payload({ input_sha256: "nope" }))).toEqual({ ok: false, error: "bad_input_sha" });
    expect(validatePayload(payload({ cost_usd: -1 }))).toEqual({ ok: false, error: "bad_cost" });
  });
});

describe("flag and hmac", () => {
  it("is on when unset, off for the kill switch, and throws on junk", () => {
    expect(freescriptEnabled({})).toBe(true);
    expect(freescriptEnabled({ ETA_FREESCRIPT: "0" })).toBe(false);
    expect(freescriptEnabled({ ETA_FREESCRIPT: "" })).toBe(false);
    expect(freescriptEnabled({ ETA_FREESCRIPT: "off" })).toBe(false);
    expect(freescriptEnabled({ ETA_FREESCRIPT: "1" })).toBe(true);
    expect(() => freescriptEnabled({ ETA_FREESCRIPT: "maybe" })).toThrow(/unrecognised/);
  });
  it("fails closed and accepts the python signature", () => {
    const env = { FREESCRIPT_INGEST_SECRET: "s3cret" };
    const now = 1_759_000_000;
    const h = (ts: number, sig: string) => new Headers({ "x-freescript-ts": String(ts), "x-freescript-signature": sig });
    expect(checkFreescriptHmac(h(now, "aa"), "{}", {})).toEqual({ status: 503, error: "not_configured" });
    expect(checkFreescriptHmac(h(now, signFreescript("{}", "s3cret", now)), "{}", env, now)).toBeNull();
    expect(checkFreescriptHmac(h(now - 3600, signFreescript("{}", "s3cret", now - 3600)), "{}", env, now)).toEqual({ status: 401, error: "stale" });
  });
});

describe("migration 0158", () => {
  const up = readFileSync("db/migrations/0158_freescript_v03.sql", "utf8");
  it("lets v0.3 through the schema check and records itself", () => {
    expect(up).toContain("'eta.freescript.v0.3'");
    expect(up).toContain("'eta.freescript.v0.1'");
    expect(up).toContain("'eta.freescript.v0.2'");
    expect(up).toMatch(/VALUES \(158, '0158_freescript_v03'\)/);
    expect(up).not.toMatch(/\bGRANT\b/i);
    expect(readFileSync("db/rollbacks/0158_freescript_v03.down.sql", "utf8")).toMatch(/DELETE FROM schema_migrations WHERE version = 158/);
  });
});

describe("ingest SQL", () => {
  it("is one statement and names no transcript column", () => {
    expect(INGEST_SQL.startsWith("WITH p AS (SELECT $1::jsonb AS j)")).toBe(true);
    expect(INGEST_SQL).toContain("WHERE NOT EXISTS (SELECT 1 FROM prior)");
    expect(INGEST_SQL).not.toMatch(/transcript|segments|brain_svc/);
  });
});
