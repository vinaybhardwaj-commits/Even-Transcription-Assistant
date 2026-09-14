/**
 * tests/support/container-name.ts — a Docker container name that is unique per worktree.
 *
 * WHY. Every Postgres harness starts with `docker rm -f <name>` and then `docker run --name <name>`. With a
 * FIXED name (`eta-c2-e2e`, `eta-s1-emotion`, …) a suite started in one worktree kills the database a suite in
 * another worktree is running against, mid-run — and the survivor's errors, or worse its passes, describe
 * nobody's schema (ETA-E16-NOT-MERGE-READY §4: Docker is shared across panes; two worktrees ran the same
 * suites at once on 14 Sep). The name is now `<base>-<worktree tag>`:
 *
 *   - the tag is a hash of the worktree's resolved git root (the working directory if git cannot answer), so
 *     two worktrees — or two clones — can never share a container;
 *   - it is STABLE within a worktree, so a harness's own `rm -f` still clears a container its previous run
 *     left behind in the same worktree, exactly as before.
 *
 * Two suites started concurrently IN THE SAME worktree still share a name. That is the old rule — one suite at
 * a time per worktree — and it is now the only place the rule is needed.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** The directory that identifies this worktree: git's top level, resolved; else the working directory. */
export function worktreeRoot(cwd: string = process.cwd()): string {
  let root = cwd;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || cwd;
  } catch { /* not a git checkout: the working directory is the identity */ }
  try { return realpathSync(root); } catch { return root; }
}

/** Ten hex characters of sha256(root). */
export function worktreeTag(root: string = worktreeRoot()): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 10);
}

/** `<base>-<tag>`. `base` must already be a valid, lower-case Docker name stem. */
export function containerName(base: string, root: string = worktreeRoot()): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(base)) throw new Error(`container name base must match [a-z0-9][a-z0-9-]*: ${JSON.stringify(base)}`);
  return `${base}-${worktreeTag(root)}`;
}
