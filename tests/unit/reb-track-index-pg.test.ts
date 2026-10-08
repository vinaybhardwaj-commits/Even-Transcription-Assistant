/**
 * tests/unit/reb-track-index-pg.test.ts — REQUIRED PROOF: migration 0135 (reb_track_index) and /api/reb/index against a real postgres:16
 * (tests/support/s1-pg.ts, same harness as room-audio-0129-pg.test.ts: every value is a bound parameter sent as an untyped string).
 *   1. The migration survives the app's splitSql, applies twice (and as raw psql), registers itself, creates the three indexes and no role/grant.
 *   2. Unique key (window_id, layer, engine, version, config_hash, shadow): a duplicate is rejected; shadow=true is a different key; shadow defaults false.
 *   3. CHECK on status; NOT NULL on the required columns.
 *   4. ON CONFLICT DO NOTHING keeps the first row untouched.
 *   5. The real route SQL: POST inserted / existing / 409 conflict (inserted rows stand), GET filters, shadow exclusion, keyset paging.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

import { GET, POST } from "@/app/api/reb/index/route";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-reb-index-0135");
const MIG = "0135_reb_track_index.sql";
const mig = () => readFileSync(`db/migrations/${MIG}`, "utf8");

function loadSplitSql(): (body: string) => string[] {
  const src = readFileSync("app/api/run-migrations/route.ts", "utf8");
  const start = src.indexOf("function splitSql(");
  const end = src.indexOf("export async function POST");
  expect(start).toBeGreaterThan(0);
  const js = ts.transpileModule(src.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return new Function(`${js}\nreturn splitSql;`)() as (body: string) => string[];
}
function psql(text: string): string {
  try {
    return execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
      { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new Error(String((e as { stderr?: unknown }).stderr ?? e));
  }
}
const fails = (text: string) => { try { psql(text); return ""; } catch (e) { return (e as Error).message; } };

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const row = (o: Record<string, unknown> = {}) => ({
  window_id: "w1", ist_date: "2026-10-06", room_id: "room_a", layer: "stt", engine: "whisper-auto", version: "v1", config_hash: "c0ffee00",
  status: "ok", r2_key: "reb/2026-10-06/room_a/w1/tracks/stt.whisper-auto__v1__c0ffee00.json", sha256: SHA_A, ...o,
});
const SAVED = { w: process.env.REB_INDEX_TOKEN, r: process.env.REB_INDEX_READ_TOKEN };
const post = (body: unknown) => POST(new NextRequest("http://x/api/reb/index", { method: "POST", headers: { authorization: "Bearer wtok" }, body: JSON.stringify(body) }));
const get = (qs: string, tok = "rtok") => GET(new NextRequest(`http://x/api/reb/index?${qs}`, { headers: { authorization: `Bearer ${tok}` } }));

beforeEach(() => {
  process.env.REB_INDEX_TOKEN = "wtok";
  process.env.REB_INDEX_READ_TOKEN = "rtok";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (SAVED.w === undefined) delete process.env.REB_INDEX_TOKEN; else process.env.REB_INDEX_TOKEN = SAVED.w;
  if (SAVED.r === undefined) delete process.env.REB_INDEX_READ_TOKEN; else process.env.REB_INDEX_READ_TOKEN = SAVED.r;
  vi.restoreAllMocks();
});

describe("REQUIRED PROOF — 0135 against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/reb-track-index-pg.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.skipIf(!HAVE_DOCKER)("0135 reb_track_index over real postgres", () => {
  it("applies through splitSql twice and as raw psql; registers itself; indexes present; no grant, no role", () => {
    pg.start();
    H.sql = pg.sql as never;
    pg.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const stmts = loadSplitSql()(mig());
    expect(stmts.length).toBeGreaterThanOrEqual(5);
    for (let pass = 0; pass < 2; pass += 1) psql(`BEGIN;\n${stmts.map((s) => `${s};`).join("\n")}\nCOMMIT;`);
    pg.exec(mig());
    expect(psql(`SELECT version || ':' || name FROM schema_migrations WHERE version = 135;`)).toBe("135:0135_reb_track_index");
    expect(psql(`SELECT count(*) FROM schema_migrations WHERE version = 135;`)).toBe("1");
    expect(psql(`SELECT indexname FROM pg_indexes WHERE tablename = 'reb_track_index' AND indexname NOT LIKE '%pkey' ORDER BY indexname;`).split("\n")).toEqual([
      "reb_track_index_ist_date_idx", "reb_track_index_key", "reb_track_index_layer_engine_idx", "reb_track_index_window_idx",
    ]);
    expect(mig()).not.toMatch(/^\s*(GRANT|CREATE ROLE)\b|PASSWORD\s+'/im);
  }, 240_000);

  it("unique key, shadow default, CHECK and NOT NULL", () => {
    const ins = (extra = "", status = "ok", win = "u1") =>
      `INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, ${extra ? "shadow, " : ""}status, r2_key, sha256)
       VALUES ('${win}', '2026-10-06', 'room_a', 'stt', 'e', 'v', 'c', ${extra ? `${extra}, ` : ""}'${status}', 'k', '${SHA_A}');`;
    psql(ins());
    expect(psql(`SELECT shadow FROM reb_track_index WHERE window_id = 'u1';`)).toBe("f");
    expect(fails(ins())).toMatch(/reb_track_index_key/);
    psql(ins("true")); // same key but shadow = true is a different row
    expect(psql(`SELECT count(*) FROM reb_track_index WHERE window_id = 'u1';`)).toBe("2");
    expect(fails(ins("", "bogus", "u2"))).toMatch(/violates check constraint/);
    expect(fails(`INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key) VALUES ('u3','2026-10-06','r','l','e','v','c','ok','k');`)).toMatch(/null value in column "sha256"/);
    // ON CONFLICT DO NOTHING keeps the first row untouched
    psql(`INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256)
          VALUES ('u1','2026-10-06','room_a','stt','e','v','c','failed','other','${SHA_B}') ON CONFLICT ON CONSTRAINT reb_track_index_key DO NOTHING;`);
    expect(psql(`SELECT status || '/' || r2_key || '/' || (sha256 = '${SHA_A}') FROM reb_track_index WHERE window_id = 'u1' AND shadow = false;`)).toBe("ok/k/true");
  });

  it("route over real SQL: inserted, existing, 409 conflict with inserted rows standing, mixed batch", async () => {
    const r1 = await post([row(), row({ window_id: "w2", r2_key: "k2" })]);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, inserted: 2, existing: 0, conflicts: [] });
    const r2 = await post(row()); // identical re-post
    expect(await r2.json()).toMatchObject({ inserted: 0, existing: 1, conflicts: [] });
    const r3 = await post([row({ window_id: "w3", r2_key: "k3" }), row({ sha256: SHA_B }), row({ window_id: "w2", r2_key: "k2" })]);
    expect(r3.status).toBe(409);
    const b3 = await r3.json();
    expect(b3).toMatchObject({ ok: false, inserted: 1, existing: 1 });
    expect(b3.conflicts).toEqual([{ key: "w1/stt.whisper-auto__v1__c0ffee00", stored_sha: SHA_A, sent_sha: SHA_B }]);
    expect(psql(`SELECT count(*) FROM reb_track_index WHERE window_id IN ('w1','w2','w3');`)).toBe("3");
    expect(psql(`SELECT sha256 = '${SHA_A}' FROM reb_track_index WHERE window_id = 'w1';`)).toBe("t");
    // duplicates inside one request: one inserted, the second is existing (same sha) or a conflict (different sha)
    const r4 = await post([row({ window_id: "d1", r2_key: "d" }), row({ window_id: "d1", r2_key: "d" })]);
    expect(await r4.json()).toMatchObject({ inserted: 1, existing: 1, conflicts: [] });
    const r5 = await post([row({ window_id: "d2", r2_key: "d" }), row({ window_id: "d2", r2_key: "d", sha256: SHA_B })]);
    expect(r5.status).toBe(409);
    expect(await r5.json()).toMatchObject({ inserted: 1, existing: 0 });
  });

  it("route over real SQL: GET filters, shadow exclusion, keyset paging, string-safe output", async () => {
    await post([
      row({ window_id: "g1", layer: "acoustics", engine: "e1", r2_key: "g1a", started_at: "2026-10-06T04:00:00Z", t0_ms: 5, bytes: 10 }),
      row({ window_id: "g1", layer: "stt", engine: "e2", r2_key: "g1b" }),
      row({ window_id: "g1", layer: "stt", engine: "e2", shadow: true, r2_key: "g1c" }),
      row({ window_id: "g2", ist_date: "2026-10-07", room_id: "room_b", r2_key: "g2a" }),
    ]);
    expect((await get("")).status).toBe(400);
    const byWin = await (await get("window_id=g1")).json();
    expect(byWin.rows.map((r: { r2_key: string }) => r.r2_key)).toEqual(["g1a", "g1b"]); // shadow excluded
    expect(byWin.rows[0]).toMatchObject({ ist_date: "2026-10-06", t0_ms: 5, bytes: 10, shadow: false, started_at: expect.any(String), indexed_at: expect.any(String) });
    expect(byWin.rows[0].id).toEqual(expect.any(Number));
    expect((await (await get("window_id=g1&shadow=1")).json()).count).toBe(3);
    expect((await (await get("ist_date=2026-10-07")).json()).rows.map((r: { window_id: string }) => r.window_id)).toEqual(["g2"]);
    expect((await (await get("window_id=g1&layer=stt&engine=e2&shadow=1")).json()).count).toBe(2);
    expect((await (await get("ist_date=2026-10-07&room_id=room_a")).json()).count).toBe(0);
    // keyset paging over all non-shadow rows of the two days
    const seen: number[] = [];
    let cursor: number | null = null;
    for (let i = 0; i < 10; i += 1) {
      const page = await (await get(`ist_date=2026-10-06&limit=2${cursor ? `&cursor=${cursor}` : ""}`)).json();
      seen.push(...page.rows.map((r: { id: number }) => r.id));
      cursor = page.next_cursor;
      if (cursor === null) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); // ascending by id
    const all = await (await get("ist_date=2026-10-06&limit=5000")).json();
    expect(seen).toEqual(all.rows.map((r: { id: number }) => r.id)); // the pages add up to the unpaged read
    expect(cursor).toBeNull();
  });

  it("teardown", () => { pg.stop(); });
});
