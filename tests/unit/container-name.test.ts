/**
 * Docker test containers are named per worktree (tests/support/container-name.ts).
 *
 * The defect: every Postgres harness runs `docker rm -f <name>` then `docker run --name <name>`, and the names
 * were fixed, so a suite in one worktree removed another worktree's database mid-run (ETA-E16 ruling §4).
 * These tests need no Docker: they prove the NAMES, which is where the collision was.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { containerName, worktreeTag, worktreeRoot } from "../support/container-name";
import { PG_NAME } from "../support/pg-harness";
import { pgContainer } from "../support/s1-pg";

describe("a container name is unique per worktree and stable within one", () => {
  it("two worktrees never share a name; the same worktree always gets the same one", () => {
    const a = containerName("eta-c2-e2e", "/Users/x/dev/Even-Transcription-Assistant");
    const b = containerName("eta-c2-e2e", "/Users/x/dev/Even-Transcription-Assistant-e20");
    expect(a).not.toBe(b);
    expect(containerName("eta-c2-e2e", "/Users/x/dev/Even-Transcription-Assistant")).toBe(a);
  });

  it("different suites in one worktree keep different names", () => {
    expect(containerName("eta-s1-emotion", "/w")).not.toBe(containerName("eta-s1-auto-drain", "/w"));
  });

  it("the name is a valid Docker name: the base, a dash, ten hex characters", () => {
    expect(containerName("eta-s1-emotion", "/w")).toMatch(/^eta-s1-emotion-[0-9a-f]{10}$/);
    expect(() => containerName("Eta C2", "/w")).toThrow(/container name base/);
  });

  it("the worktree is git's resolved top level — this checkout's, not the process's guess", () => {
    const top = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
    expect(worktreeRoot()).toBe(top);
    expect(worktreeTag()).toBe(worktreeTag(top));
  });
});

describe("both harnesses use it", () => {
  it("pg-harness: PG_NAME is the per-worktree name, not the old fixed eta-c2-e2e", () => {
    expect(PG_NAME).not.toBe("eta-c2-e2e");
    expect(PG_NAME).toBe(containerName("eta-c2-e2e"));
  });

  it("s1-pg: pgContainer(base) runs, execs and removes the per-worktree name", () => {
    const pg = pgContainer("eta-s1-emotion");
    expect(pg.name).not.toBe("eta-s1-emotion");
    expect(pg.name).toBe(containerName("eta-s1-emotion"));
  });

  it("SWEEP: every test file that runs a named container gets the name from containerName — no fixed name can come back", () => {
    const files = execFileSync("git", ["ls-files", "tests"], { encoding: "utf8" }).split("\n").filter((f) => /\.(ts|mts|js)$/.test(f));
    const runners = files.filter((f) => /["']--name["']/.test(readFileSync(f, "utf8")));
    expect(runners.sort(), "the two harnesses are the only docker run sites").toEqual(["tests/support/pg-harness.ts", "tests/support/s1-pg.ts"]);
    for (const f of runners) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} must derive its container name from containerName`).toMatch(/containerName\(/);
      expect(src, `${f} must not hold a fixed eta- container name`).not.toMatch(/=\s*["']eta-[a-z0-9-]+["']\s*;/);
    }
  });
});
