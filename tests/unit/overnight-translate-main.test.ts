/**
 * Overnight translate — argument parsing, the start-up refusals, a dry run end to end, and source-level
 * guards. Every refusal here happens BEFORE a secret or the database is touched, and the driver is never started:
 * `--mode run` is only ever exercised on its refusal paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbCalls: string[] = [];
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray) => { dbCalls.push(strings.raw.join("?").replace(/\s+/g, " ").trim()); return []; },
}));

import { parseArgs, originProblem, main, DEFAULT_APP_URL } from "@/lib/overnight-translate/main";

let errors: string[];
let logs: string[];
beforeEach(() => {
  errors = []; logs = []; dbCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
});
afterEach(() => vi.restoreAllMocks());

describe("parseArgs", () => {
  it("defaults to run mode, no limit, no fixtures", () => {
    expect(parseArgs([], {})).toEqual({ ok: true, mode: "run", limit: 0, fixtures: [] });
  });
  it("reads fixtures from the flag, or from OVERNIGHT_FIXTURE_ROOM_DAYS — never from source", () => {
    expect(parseArgs(["--fixtures", "rd_a, rd_b"], {})).toMatchObject({ ok: true, fixtures: ["rd_a", "rd_b"] });
    expect(parseArgs([], { OVERNIGHT_FIXTURE_ROOM_DAYS: "rd_x,rd_y,rd_z" })).toMatchObject({ ok: true, fixtures: ["rd_x", "rd_y", "rd_z"] });
    expect(parseArgs(["--fixtures", "rd_flag"], { OVERNIGHT_FIXTURE_ROOM_DAYS: "rd_env" })).toMatchObject({ fixtures: ["rd_flag"] });
  });
  it("refuses a fixture id that is not shaped like a room-day id", () => {
    for (const bad of ["bw_1", "rd_", "rd_a;DROP", "room_x", "rd_" + "a".repeat(80), "'"]) {
      expect(parseArgs(["--fixtures", bad], {}), bad).toEqual({ ok: false, code: "bad_fixture_id" });
    }
  });
  it("mode must be run or dry-run", () => {
    expect(parseArgs(["--mode", "bulk"], {})).toEqual({ ok: false, code: "bad_mode" });
    expect(parseArgs(["--mode", "dry-run", "--limit", "5"], {})).toMatchObject({ ok: true, mode: "dry-run", limit: 5 });
  });
  it("a dry run needs --limit 1..500 (it lists windows; an unbounded list is not a look)", () => {
    for (const bad of [[], ["--limit", "0"], ["--limit", "501"], ["--limit", "-3"], ["--limit", "abc"]]) {
      expect(parseArgs(["--mode", "dry-run", ...bad], {}), bad.join(" ")).toMatchObject({ ok: false });
    }
    expect(parseArgs(["--mode", "dry-run", "--limit", "500"], {})).toMatchObject({ ok: true });
  });
  it("a run's --limit must be a non-negative integer", () => {
    expect(parseArgs(["--limit", "1.5"], {})).toEqual({ ok: false, code: "bad_limit" });
    expect(parseArgs(["--limit", "-1"], {})).toEqual({ ok: false, code: "bad_limit" });
    expect(parseArgs(["--limit", "10"], {})).toMatchObject({ ok: true, limit: 10 });
  });
});

describe("originProblem — the apex redirects and drops the bearer", () => {
  it("the canonical host is fine; the default is the canonical host", () => {
    expect(originProblem("https://www.evenscribe.app")).toBeNull();
    expect(originProblem(DEFAULT_APP_URL)).toBeNull();
  });
  it("the APEX is refused BY NAME (evenscribe.app 307-redirects to www and a cross-origin redirect drops Authorization)", () => {
    expect(originProblem("https://evenscribe.app")).toBe("apex_origin_redirects_and_drops_the_bearer");
    expect(originProblem("https://evenscribe.app/")).toBe("apex_origin_redirects_and_drops_the_bearer");
  });
  it("plain http and non-URLs are refused; localhost is allowed for a local run", () => {
    expect(originProblem("http://www.evenscribe.app")).toBe("app_url_not_https");
    expect(originProblem("not a url")).toBe("bad_app_url");
    expect(originProblem("http://localhost:3000")).toBeNull();
  });
});

describe("start-up refusals — all before a secret or the database is touched", () => {
  const DB = { APP_DATABASE_URL: "postgres://fake" };
  const codes = () => errors.map((e) => e.replace("[overnight-translate] refused: ", ""));

  it("a bad flag is refused with its code, exit 2", async () => {
    expect(await main(["--mode", "bulk"], DB)).toBe(2);
    expect(codes()).toEqual(["bad_mode"]);
  });
  it("an apex APP_URL is refused", async () => {
    expect(await main(["--mode", "run"], { ...DB, APP_URL: "https://evenscribe.app", OVERNIGHT_TRANSLATE_TOKEN: "t" })).toBe(2);
    expect(codes()).toEqual(["apex_origin_redirects_and_drops_the_bearer"]);
  });
  it("no database string is refused", async () => {
    expect(await main(["--mode", "dry-run", "--limit", "3"], {})).toBe(2);
    expect(codes()).toEqual(["db_not_configured"]);
  });
  it("a RUN with no token is refused — the driver cannot start today, and nothing is contacted", async () => {
    const f = vi.fn(() => { throw new Error("no network in this test"); });
    vi.stubGlobal("fetch", f);
    expect(await main(["--mode", "run"], DB)).toBe(2);
    expect(codes()).toEqual(["token_not_configured"]);
    expect(f).not.toHaveBeenCalled();
    expect(dbCalls, "not one query was sent").toHaveLength(0);
    vi.unstubAllGlobals();
  });
  it("the refusal messages are closed codes — never the token, the URL or a path", async () => {
    await main(["--mode", "run"], { ...DB, OVERNIGHT_TRANSLATE_TOKEN: "" });
    await main(["--mode", "run"], { ...DB, APP_URL: "https://evenscribe.app", OVERNIGHT_TRANSLATE_TOKEN: "TOKEN-SECRET-xyz" });
    for (const e of errors) {
      expect(e).toMatch(/^\[overnight-translate\] refused: [a-z0-9_]+$/);
      expect(e).not.toContain("TOKEN-SECRET");
    }
  });
});

describe("a DRY RUN end to end — no token, no door, no submit", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ot-main-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts, reads the (fake) database, logs start / night_start / night_end, writes its log file, and exits 0", async () => {
    const f = vi.fn(() => { throw new Error("a dry run must never touch the network"); });
    vi.stubGlobal("fetch", f);
    const code = await main(["--mode", "dry-run", "--limit", "5", "--fixtures", "rd_a,rd_b"], { APP_DATABASE_URL: "postgres://fake", OVERNIGHT_TRANSLATE_LOG_DIR: dir });
    vi.unstubAllGlobals();
    expect(code).toBe(0);
    expect(f).not.toHaveBeenCalled();
    const events = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e.event)).toEqual(["start", "night_start", "night_end"]);
    expect(events[0]).toMatchObject({ mode: "dry-run", fixtures: 2, limit: 5 });
    expect(events[2]).toMatchObject({ mode: "dry-run", stop: "dry_run_done", started: 0 });
    expect(existsSync(join(dir, "overnight-translate.log"))).toBe(true);
    expect(readFileSync(join(dir, "overnight-translate.log"), "utf8").trim().split("\n")).toHaveLength(3);
    for (const q of dbCalls) expect(q).toMatch(/^(SELECT|WITH)\b/i);
    expect(dbCalls.length, "the store did read").toBeGreaterThan(0);
  });
});

describe("source guards — the properties that make it safe to have built without a token", () => {
  const dir = join(process.cwd(), "lib/overnight-translate");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => ({ name: f, src: readFileSync(join(dir, f), "utf8") }));
  const launcher = readFileSync(join(process.cwd(), "scripts/overnight-translate.ts"), "utf8");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("only door.ts can reach the network", () => {
    for (const f of files.filter((x) => x.name !== "door.ts")) expect(code(f.src), f.name).not.toMatch(/\bfetch\s*\(/);
  });
  it("only select.ts talks to the database, and only main.ts hands it `sql`", () => {
    for (const f of files.filter((x) => x.name !== "select.ts")) expect(code(f.src), f.name).not.toMatch(/\bsql\s*`/);
    const users = files.filter((x) => /from "@\/lib\/db"/.test(x.src)).map((x) => x.name);
    expect(users).toEqual(["main.ts"]);
  });
  it("no write SQL anywhere in the module", () => {
    for (const f of files) expect(code(f.src).replace(/`[^`]*`/g, (m) => m), f.name).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
  });
  it("uses its OWN token name — it never borrows the night-drain's SCRIBE_MCP_TOKEN", () => {
    for (const f of [...files, { name: "launcher", src: launcher }]) expect(code(f.src), f.name).not.toMatch(/SCRIBE_MCP_TOKEN\b(?!S)/);
  });
  it("only main.ts reads the token from the environment, and only the launcher reads a secret file", () => {
    for (const f of files.filter((x) => x.name !== "main.ts")) expect(code(f.src), f.name).not.toContain("OVERNIGHT_TRANSLATE_TOKEN");
    for (const f of files) expect(code(f.src), f.name).not.toMatch(/readFileSync/);
    expect(launcher).toContain("readFileSync");
  });
  it("never prints an environment value or the token", () => {
    for (const f of [...files, { name: "launcher", src: launcher }]) {
      // No console call may pass or interpolate an environment value (HOME excepted) or a variable named token.
      expect(code(f.src), f.name).not.toMatch(/console\.(log|error|warn)\([^)]*process\.env\.(?!HOME)/);
      expect(code(f.src), f.name).not.toMatch(/console\.(log|error|warn)\(\s*(cfg\.)?token\b/);
      expect(code(f.src), f.name).not.toMatch(/console\.(log|error|warn)\([^)]*\$\{[^}]*\btoken\b[^}]*\}/i);
    }
  });
  it("contains no home-directory path (the pressure file default is built from HOME)", () => {
    for (const f of [...files, { name: "launcher", src: launcher }]) expect(f.src, f.name).not.toMatch(/\/Users\//);
  });
  it("contains no doctor name, room label or room-day id", () => {
    for (const f of [...files, { name: "launcher", src: launcher }]) {
      expect(f.src, f.name).not.toMatch(/\brd_[a-z0-9]{6,}\b/);
      expect(f.src, f.name).not.toMatch(/\bDr\.?\s+[A-Z][a-z]+/);
      expect(f.src, f.name).not.toMatch(/opd-\d/i);
    }
  });
});
