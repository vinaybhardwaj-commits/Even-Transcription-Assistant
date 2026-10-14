/**
 * vitest globalSetup — FAILS the suite if a test postgres container this worktree started is still alive after the run.
 *
 * WHY. steward-config-history-pg never stopped its container and 65 piled up (+97 anonymous volumes, 4 GB) on
 * eta-lab-t4. Every harness names its container `<base>-<worktree tag>` (container-name.ts) and the harnesses reap
 * on exit, so anything with THIS worktree's tag after the run is a leak. Other worktrees' containers are not this
 * run's business (they may be mid-run) and are only listed as a note.
 */
import { execFileSync } from "node:child_process";
import { dockerCli } from "./docker";
import { worktreeTag } from "./container-name";

const names = (): string[] | null => {
  try {
    return (dockerCli(["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }) as string)
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { return null; } // no docker: nothing could have been started
};

export default function setup() {
  const tag = worktreeTag();
  return () => {
    const all = names();
    if (!all) return;
    const mine = all.filter((n) => n.startsWith("eta-") && n.endsWith(`-${tag}`));
    const foreign = all.filter((n) => /^eta-steward-history-/.test(n) && !n.endsWith(`-${tag}`));
    if (foreign.length) console.warn(`[no-leaked-containers] note: ${foreign.length} eta-steward-history-* container(s) from other worktrees exist (not this run's).`);
    if (mine.length) {
      for (const n of mine) { try { dockerCli(["rm", "-fv", n], { stdio: "ignore", timeout: 60_000 }); } catch { /* best effort */ } }
      throw new Error(`LEAKED TEST CONTAINERS (${mine.length}) survived the run, now removed: ${mine.join(", ")}`);
    }
  };
}
