/** scripts/blacklist-from-revocations.ts (R6): counts only on stdout, a 0600 file, never inside the repo (realpath), two sources unioned, --dry-count writes nothing. No database: sources are injected. */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { main } from "../../scripts/blacklist-from-revocations";

const root = mkdtempSync(`${tmpdir()}/bfr-`);
const repo = `${root}/repo`;
const outside = `${root}/outside`;
mkdirSync(repo);
mkdirSync(outside);
const src = (db: string[], env: string[]) => async () => ({ db, env });
const run = async (argv: string[], db: string[], env: string[]) => {
  const lines: string[] = [];
  const err = vi.spyOn(console, "error").mockImplementation((...a) => { lines.push(a.join(" ")); });
  try {
    const code = await main(argv, src(db, env), repo, (s) => lines.push(s));
    return { code, lines };
  } finally { err.mockRestore(); }
};
const A = "s6.a@example.test";
const B = "s6.b@example.test";
const C = "s6.c@example.test";

describe("blacklist-from-revocations script", () => {
  it("M16: prints counts only (db, env, union) and never an address; M17: the file is mode 0600 and holds the sorted union", async () => {
    const f = `${outside}/m16.json`;
    const r = await run([f], [B, A], [A, C]);
    expect(r.code).toBe(0);
    expect(r.lines).toEqual(["db=2 env=2 addresses=3"]);
    expect(r.lines.join("\n")).not.toContain("example.test");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual([A, B, C]);
  });
  it("each source alone works; the env source alone is enough", async () => {
    const f1 = `${outside}/db-only.json`;
    expect((await run([f1], [A], [])).lines).toEqual(["db=1 env=0 addresses=1"]);
    const f2 = `${outside}/env-only.json`;
    expect((await run([f2], [], [B])).lines).toEqual(["db=0 env=1 addresses=1"]);
    expect(JSON.parse(readFileSync(f2, "utf8"))).toEqual([B]);
  });
  it("--dry-count prints db=N env=M union=K rejected=R, writes nothing, needs no path", async () => {
    const r = await run(["--dry-count"], [A, B], [B, C]);
    expect(r).toEqual({ code: 0, lines: ["db=2 env=2 union=3 rejected=0"] });
    expect((await run(["--dry-count", `${outside}/x.json`], [A], [])).code).toBe(1);
    expect(existsSync(`${outside}/x.json`)).toBe(false);
  });
  it("Z5: --dry-count counts unusable rows as rejected=<n>, exits 1 like the real run, and prints no address", async () => {
    const dry = await run(["--dry-count"], [A], ["Mixed@example.test", "nonsense"]);
    expect(dry).toEqual({ code: 1, lines: ["db=1 env=0 union=1 rejected=2"] });
    expect((await run([`${outside}/z5.json`], [A], ["Mixed@example.test", "nonsense"])).code).toBe(1);
    expect(existsSync(`${outside}/z5.json`)).toBe(false);
  });
  it("M18: refuses a path inside the repo, including through a symlinked directory (realpath), and a path whose parent does not exist", async () => {
    const direct = await run([`${repo}/addr.json`], [A], []);
    expect(direct.code).toBe(1);
    expect(existsSync(`${repo}/addr.json`)).toBe(false);
    symlinkSync(repo, `${outside}/link`);
    const viaLink = await run([`${outside}/link/addr2.json`], [A], []);
    expect(viaLink.code).toBe(1);
    expect(existsSync(`${repo}/addr2.json`)).toBe(false);
    expect((await run([`${outside}/nodir/x.json`], [A], [])).code).toBe(1);
  });
  it("refuses an existing file (left untouched), no rows, an unusable (mixed-case) row, and over 50", async () => {
    const f = `${outside}/exists.json`;
    writeFileSync(f, "keep");
    expect((await run([f], [A], [])).code).toBe(1);
    expect(readFileSync(f, "utf8")).toBe("keep");
    const none = await run([`${outside}/none.json`], [], []);
    expect(none.code).toBe(1);
    expect(none.lines).toEqual(["refused: addresses=0, nothing written"]);
    expect((await run([`${outside}/mixed.json`], ["Mixed@example.test"], [])).code).toBe(1);
    const many = Array.from({ length: 51 }, (_, i) => `s6.m${i}@example.test`);
    expect((await run([`${outside}/many.json`], many, [])).code).toBe(1);
    expect(existsSync(`${outside}/none.json`)).toBe(false);
  });
});
