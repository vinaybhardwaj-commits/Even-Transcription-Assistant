/**
 * tests/support/repo-files.ts — the files a repo-content guard scans.
 *
 * Tracked files, plus untracked files that are not ignored — so a new file is caught before it is
 * committed, not after. Untracked files under docs/handoff/ are left out: that is the bus, where the
 * Orchestrator and Refuter drop working papers into this checkout that are never committed from here.
 * If one of them is ever committed it becomes tracked, and is scanned like everything else.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

export function repoFiles(): string[] {
  const list = (args: string[]) =>
    execFileSync("git", ["ls-files", "-z", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  const tracked = list([]);
  const untracked = list(["--others", "--exclude-standard"]).filter((f) => !f.startsWith("docs/handoff/"));
  return [...new Set([...tracked, ...untracked])].filter((f) => existsSync(f) && statSync(f).isFile());
}

/** Text of a file, or null for binary content (a NUL in the first 8 KB). */
export function textOf(f: string): string | null {
  const buf = readFileSync(f);
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString("utf8");
}
