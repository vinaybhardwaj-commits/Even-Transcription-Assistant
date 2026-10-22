/**
 * spine-0176-pg.test.ts — migration 0176 (spine_encounter_status_chk gains confirmed_single_proxy) against a REAL postgres:16 (never on the Mini). Synthetic data only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-0176");
const U173 = readFileSync("db/migrations/0173_spine.sql", "utf8");
const UP = readFileSync("db/migrations/0176_spine_encounter_single_proxy.sql", "utf8");
const DOWN = readFileSync("db/rollbacks/0176_spine_encounter_single_proxy.down.sql", "utf8");

describe("REQUIRED PROOF — spine 0176 runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-0176-pg.test.ts needs Docker for postgres:16 (not on the Mini). Run it on c3 / the lab box, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

describe("run-migrations discovery", () => {
  it("finds exactly one 0176, with the runner's filename pattern", () => {
    const names = readdirSync("db/migrations").map((f) => /^(\d{4})_(.+)\.sql$/.exec(f)).filter((m): m is RegExpExecArray => !!m && parseInt(m[1]!, 10) === 176).map((m) => m[0]);
    expect(names).toEqual(["0176_spine_encounter_single_proxy.sql"]);
  });
});

const d = HAVE_DOCKER ? describe : describe.skip;
d("spine 0176 on postgres:16", () => {
  const q = async (text: string) => (await pg.sql(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray)) as Array<Record<string, unknown>>;
  const first = async (text: string) => (await q(text)).map((r) => Object.values(r)[0] as string);
  const ins = (id: string, status: string) => pg.exec(`INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, anchor_proxy, boundary_rev, merge_version, reason, flags) VALUES ('${id}', '2026-10-18', 'room_abcd2345', now(), now(), '${status}', 'timeline', 0, 't', 'x', '{}');`);
  const chk = () => first("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'spine_encounter_status_chk'");
  const accepts = async (status: string) => { try { ins("enc_testaaaaaaaaaaaa", status); pg.exec("DELETE FROM spine_encounter;"); return true; } catch { return false; } };

  beforeAll(() => {
    pg.start();
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(U173);
  });
  afterAll(() => { pg.stop(); });

  it("before: 0173's 4-value CHECK rejects confirmed_single_proxy", async () => {
    expect(await accepts("confirmed_single_proxy")).toBe(false);
    expect(await accepts("confirmed")).toBe(true);
  });

  it("up: the 5 values are accepted, anything else is not; registers itself; no data, seed or table change", async () => {
    pg.exec(UP);
    for (const s of ["candidate", "confirmed", "confirmed_single_proxy", "rejected", "merged"]) expect(await accepts(s)).toBe(true);
    expect(await accepts("single_proxy")).toBe(false);
    expect(await first("SELECT name FROM schema_migrations WHERE version = 176")).toEqual(["0176_spine_encounter_single_proxy"]);
    expect(await first("SELECT count(*)::text FROM spine_config")).toEqual(["0"]);
  });

  it("up twice is a no-op (one constraint, one migration row)", async () => {
    pg.exec(UP);
    expect(await first("SELECT count(*)::text FROM pg_constraint WHERE conname = 'spine_encounter_status_chk'")).toEqual(["1"]);
    expect(await first("SELECT count(*)::text FROM schema_migrations WHERE version = 176")).toEqual(["1"]);
  });

  it("down maps confirmed_single_proxy rows to candidate, leaves the rest, and restores the 4-value CHECK", async () => {
    ins("enc_testspaaaaaaaaaa", "confirmed_single_proxy"); ins("enc_testcfaaaaaaaaaa", "confirmed"); ins("enc_testmgaaaaaaaaaa", "merged");
    pg.exec(DOWN);
    const rows = await q("SELECT encounter_id, status FROM spine_encounter ORDER BY encounter_id");
    expect(rows.map((r) => `${r.encounter_id}:${r.status}`)).toEqual(["enc_testcfaaaaaaaaaa:confirmed", "enc_testmgaaaaaaaaaa:merged", "enc_testspaaaaaaaaaa:candidate"]);
    expect(await chk()).toEqual(["CHECK ((status = ANY (ARRAY['candidate'::text, 'confirmed'::text, 'rejected'::text, 'merged'::text])))"]);
    expect(await accepts("confirmed_single_proxy")).toBe(false);
    expect(await first("SELECT count(*)::text FROM schema_migrations WHERE version = 176")).toEqual(["0"]);
    expect(await first("SELECT count(*)::text FROM schema_migrations WHERE version = 173")).toEqual(["1"]);
  });

  it("up again after down works, and down twice is harmless", async () => {
    pg.exec(UP);
    expect(await accepts("confirmed_single_proxy")).toBe(true);
    pg.exec(DOWN); pg.exec(DOWN);
    expect(await accepts("confirmed_single_proxy")).toBe(false);
    pg.exec(UP);
    expect(await accepts("confirmed_single_proxy")).toBe(true);
  });
});
