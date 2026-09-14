/**
 * tests/support/repo-files.ts — the files a repo-content guard scans.
 *
 * Tracked files, plus untracked files that are not ignored — so a new file is caught before it is
 * committed, not after. Untracked files under docs/handoff/ are left out: that is the bus, where the
 * Orchestrator and Refuter drop working papers into this checkout that are never committed from here.
 * If one of them is ever committed it becomes tracked, and is scanned like everything else.
 *
 * ─── THE STAGED TREE IS SCANNED (S1 FIX3b C11) ─────────────────────────────────────────────
 * "Tracked" here is the INDEX — `git ls-files` lists what is staged, not only what is committed — so a bus
 * document staged before the gate runs is scanned. And a file's text is the working copy PLUS its staged
 * copy wherever the two differ: a guard that read only the working tree could pass a staged file whose
 * working copy had since been cleaned, and the commit would carry what the guard never saw. A match in
 * either copy counts.
 *
 * The rule this depends on, for whoever commits: STAGE the documents before the gate, then commit what was
 * staged. A document staged after the gate has not been scanned.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Files in the index whose staged copy differs from the working copy (or is missing from it). Per call of repoFiles. */
const diverged = new Map<string, Set<string>>();

export function repoFiles(cwd: string = process.cwd()): string[] {
  const list = (args: string[]) => git(cwd, ["ls-files", "-z", ...args]).split("\0").filter(Boolean);
  const staged = list([]);
  const untracked = list(["--others", "--exclude-standard"]).filter((f) => !f.startsWith("docs/handoff/"));
  diverged.set(cwd, new Set(git(cwd, ["diff", "--name-only", "-z"]).split("\0").filter(Boolean)));
  const onDisk = (f: string) => existsSync(join(cwd, f)) && statSync(join(cwd, f)).isFile();
  const stagedSet = new Set(staged);
  // A staged file deleted from the working tree is still what the commit would carry: keep it.
  return [...new Set([...staged, ...untracked])].filter((f) => onDisk(f) || stagedSet.has(f));
}

/** Text of a file — its working copy and, where it differs, its staged copy — or null for binary content (a NUL in the first 8 KB). */
export function textOf(f: string, cwd: string = process.cwd()): string | null {
  const copies: Buffer[] = [];
  const path = join(cwd, f);
  if (existsSync(path) && statSync(path).isFile()) copies.push(readFileSync(path));
  if (diverged.get(cwd)?.has(f) ?? false) {
    try {
      copies.push(execFileSync("git", ["show", `:${f}`], { cwd, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
    } catch { /* not in the index after all (e.g. deleted and unstaged): the working copy is all there is */ }
  }
  if (copies.length === 0) return null;
  if (copies.some((b) => b.subarray(0, 8192).includes(0))) return null;
  return copies.map((b) => b.toString("utf8")).join("\n");
}
