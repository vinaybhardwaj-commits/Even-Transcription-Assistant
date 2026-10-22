/**
 * spine-0174-pg.test.ts — migration 0174 (spine ingest = shadow seed) against a REAL postgres:16 (never on the Mini). Synthetic data only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { parseIngestMode } from "@/lib/spine/config";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-0174");
const U173 = readFileSync("db/migrations/0173_spine.sql", "utf8");
const UP = readFileSync("db/migrations/0174_spine_ingest_shadow.sql", "utf8");
const DOWN = readFileSync("db/rollbacks/0174_spine_ingest_shadow.down.sql", "utf8");

describe("REQUIRED PROOF — spine 0174 runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-0174-pg.test.ts needs Docker for postgres:16 (not on the Mini). Run it on c3 / the lab box, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

describe("run-migrations discovery", () => {
  it("finds 0174 right after 0173, using the runner's filename pattern", () => {
    const versions = readdirSync("db/migrations")
      .map((f) => /^(\d{4})_(.+)\.sql$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ v: parseInt(m[1]!, 10), name: m[0].replace(/\.sql$/, "") }))
      .sort((a, b) => a.v - b.v);
    const i = versions.findIndex((x) => x.v === 174);
    expect(versions[i]?.name).toBe("0174_spine_ingest_shadow");
    expect(versions[i - 1]?.v).toBe(173);
    expect(versions.filter((x) => x.v === 174)).toHaveLength(1);
  });
});

const d = HAVE_DOCKER ? describe : describe.skip;
d("spine 0174 on postgres:16", () => {
  const q = async (text: string) => (await pg.sql(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray)) as Array<Record<string, unknown>>;
  const first = async (text: string) => (await q(text)).map((r) => Object.values(r)[0] as string);
  const rows = async () => (await q("SELECT key, value FROM spine_config ORDER BY key")) as Array<{ key: string; value: unknown }>;

  beforeAll(() => {
    pg.start();
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(U173);
  });
  afterAll(() => { pg.stop(); });

  it("seeds ingest = shadow, registers itself, and parseIngestMode reads shadow", async () => {
    pg.exec(UP);
    const r = await rows();
    expect(r.map((x) => x.key)).toEqual(["ingest"]);
    expect(parseIngestMode(r)).toBe("shadow");
    expect(await first("SELECT name FROM schema_migrations WHERE version = 174")).toEqual(["0174_spine_ingest_shadow"]);
  });

  it("writes no kill_switch, jobs or mode.* row", async () => {
    expect(await first("SELECT count(*)::text FROM spine_config WHERE key <> 'ingest'")).toEqual(["0"]);
    expect(await first("SELECT count(*)::text FROM spine_config WHERE key IN ('kill_switch','jobs') OR key LIKE 'mode.%'")).toEqual(["0"]);
  });

  it("applying twice is a no-op", async () => {
    pg.exec(UP);
    expect((await rows()).length).toBe(1);
    expect(await first("SELECT count(*)::text FROM schema_migrations WHERE version = 174")).toEqual(["1"]);
  });

  it("does not overwrite an operator's existing ingest row", async () => {
    pg.exec(DOWN);
    pg.exec(`INSERT INTO spine_config (key, value) VALUES ('ingest', '"off"'::jsonb);`);
    pg.exec(UP);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(parseIngestMode(r)).toBe("off");
    // the rollback leaves the operator's value too
    pg.exec(DOWN);
    expect(parseIngestMode(await rows())).toBe("off");
    pg.exec("DELETE FROM spine_config;");
  });

  it("rollback removes only the ingest row it added and its own migration row", async () => {
    pg.exec(UP);
    pg.exec(`INSERT INTO spine_config (key, value) VALUES ('jobs', '"off"'::jsonb);`);
    pg.exec(DOWN);
    expect((await rows()).map((x) => x.key)).toEqual(["jobs"]);
    expect(await first("SELECT count(*)::text FROM schema_migrations WHERE version = 174")).toEqual(["0"]);
    expect(await first("SELECT count(*)::text FROM schema_migrations WHERE version = 173")).toEqual(["1"]);
    pg.exec(DOWN);
    pg.exec("DELETE FROM spine_config;");
  });

  it("rollback leaves a foreign schema_migrations row with version 174 and another name", async () => {
    pg.exec("INSERT INTO schema_migrations (version, name) VALUES (174, '0174_other');");
    pg.exec(DOWN);
    expect(await first("SELECT name FROM schema_migrations WHERE version = 174")).toEqual(["0174_other"]);
    pg.exec("DELETE FROM schema_migrations WHERE version = 174;");
  });
});
